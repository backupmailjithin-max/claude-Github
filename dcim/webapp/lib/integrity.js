'use strict';
// Startup / runtime integrity verification for the licensing code path.
//
// A signed manifest (integrity.manifest.json, produced at package-build time by
// packaging/tools/make-integrity-manifest.js) records the SHA-256 of
//   server.js, lib/license.js, lib/license-public-key.js, lib/integrity.js
// plus a hash of the licence public key that must be loaded in memory. This
// module verifies the manifest signature and those hashes at startup and again
// whenever a protected file changes on disk (cheap stat check once a minute).
//
// What it is: tamper EVIDENCE. Modifying the licensing code, replacing the
// licence public key, or loading a patching hook now produces an audit event, a
// log warning and a licensing warning - and, when INTEGRITY_MODE=restricted,
// locks the app (activation + sign-out stay reachable).
// What it is not: protection against someone who can rewrite every file AND the
// manifest AND this verifier. No offline Node.js scheme can promise that; the
// systemd hardening in the packaged service unit (code mounted read-only for the
// service) is what stops a compromised application process from doing it.
//
// INTEGRITY_MODE (in .env):
//   warn      (default) audit + warning only; nothing is blocked, so a hot-fix copy of one file only
//             produces a warning until a matching manifest is installed.
//   restricted  a failed check locks the app through the licence layer (402 everywhere except the
//             licence/sign-out routes).
//   enforce   strict: if server.js, lib/license.js, lib/license-public-key.js or lib/integrity.js differ from the
//             manifest, or the manifest is invalid/missing, the app REFUSES normal startup (no migrations, no
//             background jobs) and an HTTP gate answers 503 to everything except /api/health, /api/license/* and
//             the three sign-in routes needed to reach them. Every refusal carries a reference ID + recovery steps.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = 'integrity.manifest.json';
const PROTECTED_FILES = ['server.js', 'lib/license.js', 'lib/license-public-key.js', 'lib/integrity.js'];
const TICK_MS = 60 * 1000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha12 = (s) => String(s).slice(0, 12);

// ---------------------------------------------------------------------------
// Manifest creation (build time only - the private key lives in memory for the
// duration of the call and is never written anywhere).
// ---------------------------------------------------------------------------
function buildManifest(root, opts = {}) {
  const files = {};
  for (const rel of PROTECTED_FILES) files[rel] = sha256(fs.readFileSync(path.join(root, rel)));
  // The licence public key that the app will actually load.
  const keyModule = path.join(root, 'lib', 'license-public-key.js');
  delete require.cache[require.resolve(keyModule)];
  const pem = String(require(keyModule).LICENSE_PUBLIC_KEY_PEM || '');
  const payload = {
    v: 1,
    product: 'DCIM Dashboard',
    version: opts.version || null,
    createdAt: new Date().toISOString(),
    files,
    licenseKeySha256: sha256(pem),
  };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payloadJson = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(payloadJson), privateKey).toString('base64');
  return {
    alg: 'Ed25519',
    payloadJson,
    signature,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
function envRisks(env, execArgv) {
  const risks = [];
  const loaderFlag = /(^|\s)(-r|--require|--import|--loader|--experimental-loader|--inspect(-brk|-port)?|-e|--eval|--experimental-vm-modules)(=|\s|$)/;
  if (env.NODE_OPTIONS && loaderFlag.test(env.NODE_OPTIONS)) risks.push('NODE_OPTIONS loads code or opens a debugger');
  if ((execArgv || []).some((a) => loaderFlag.test(String(a)))) risks.push('node was started with a code-loading / debug flag');
  if (env.NODE_PATH) risks.push('NODE_PATH is set (module search path override)');
  if (env.LD_PRELOAD) risks.push('LD_PRELOAD is set');
  return risks;
}

function checkIntegrity(root) {
  const res = { state: 'ok', modified: [], missing: [], memoryKeyMismatch: false, keyId: null, version: null };
  const mpath = path.join(root, MANIFEST_NAME);
  let m;
  if (!fs.existsSync(mpath)) { res.state = 'unsigned'; return res; }
  try {
    m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    const ok = m && m.alg === 'Ed25519' && typeof m.payloadJson === 'string' && typeof m.signature === 'string' && typeof m.publicKey === 'string'
      && crypto.verify(null, Buffer.from(m.payloadJson), crypto.createPublicKey(m.publicKey), Buffer.from(m.signature, 'base64'));
    if (!ok) { res.state = 'invalid-manifest'; return res; }
  } catch (e) { res.state = 'invalid-manifest'; return res; }
  let payload;
  try { payload = JSON.parse(m.payloadJson); } catch (e) { res.state = 'invalid-manifest'; return res; }
  res.keyId = sha12(sha256(m.publicKey));
  res.version = payload.version || null;
  for (const [rel, want] of Object.entries(payload.files || {})) {
    let got = null;
    try { got = sha256(fs.readFileSync(path.join(root, rel))); } catch (e) { res.missing.push(rel); continue; }
    if (got !== want) res.modified.push(rel);
  }
  // A manifest that does not cover the protected set is itself suspicious.
  for (const rel of PROTECTED_FILES) if (!(payload.files || {})[rel]) res.missing.push(rel);
  try {
    const mem = String(require('./license-public-key').LICENSE_PUBLIC_KEY_PEM || '');
    if (sha256(mem) !== payload.licenseKeySha256) res.memoryKeyMismatch = true;
  } catch (e) { res.memoryKeyMismatch = true; }
  if (res.modified.length || res.missing.length || res.memoryKeyMismatch) res.state = 'modified';
  return res;
}

// ---------------------------------------------------------------------------
// Runtime singleton
// ---------------------------------------------------------------------------
let S = null;   // { root, emit, log, result, env, snapshot, licenseFile, licenseBase, timer }
const seen = new Set();
function emitOnce(type, details, key) {
  if (!S || !S.emit) return;
  const k = type + '|' + (key || '');
  if (seen.has(k)) return;
  if (seen.size > 200) seen.clear();
  seen.add(k);
  if (S.defer) { S.queue.push([type, details || {}]); return; }
  try { S.emit(type, details || {}); } catch (e) { /* auditing must never break the app */ }
}
const mode = () => {
  const m = String(process.env.INTEGRITY_MODE || '').toLowerCase();
  return m === 'enforce' || m === 'restricted' ? m : 'warn';
};

function snapshotStats(root) {
  const out = {};
  for (const rel of [...PROTECTED_FILES, MANIFEST_NAME]) {
    try { const st = fs.statSync(path.join(root, rel)); out[rel] = `${st.mtimeMs}:${st.size}`; } catch (e) { out[rel] = 'missing'; }
  }
  return out;
}

function evaluate(first) {
  const r = checkIntegrity(S.root);
  S.result = r;
  S.snapshot = snapshotStats(S.root);
  if (r.state === 'modified') {
    const files = [...r.modified, ...r.missing.map((f) => f + ' (missing)')];
    emitOnce('INTEGRITY_VIOLATION', { files, memoryKeyMismatch: r.memoryKeyMismatch, mode: mode() }, files.join(',') + '|' + r.memoryKeyMismatch);
    if (r.modified.includes('lib/license-public-key.js') || r.memoryKeyMismatch) {
      emitOnce('LICENSE_PUBLIC_KEY_REPLACED', { where: r.memoryKeyMismatch ? 'loaded key differs from the signed manifest' : 'lib/license-public-key.js differs from the signed manifest' }, String(r.memoryKeyMismatch));
    }
    if (S.log) S.log.warn(`[integrity] WARNING: protected licensing files differ from the signed manifest (${files.join(', ')})${r.memoryKeyMismatch ? '; the loaded licence public key does not match' : ''}. Mode: ${mode()}.`);
  } else if (r.state === 'invalid-manifest') {
    emitOnce('INTEGRITY_VIOLATION', { files: [MANIFEST_NAME], note: 'manifest signature invalid or manifest unreadable', mode: mode() }, 'manifest');
    if (S.log) S.log.warn('[integrity] WARNING: the integrity manifest is unreadable or its signature is invalid.');
  } else if (r.state === 'unsigned') {
    if (first && S.log) (process.env.NODE_ENV === 'production' ? S.log.warn : S.log.info)('[integrity] no integrity manifest present (development tree or a hand-assembled install).');
    if (process.env.NODE_ENV === 'production') emitOnce('INTEGRITY_MANIFEST_MISSING', { mode: mode() }, 'missing');
  } else if (first && S.log) {
    S.log.info(`[integrity] ok (${PROTECTED_FILES.length} protected files match manifest ${r.keyId}${r.version ? ', build ' + r.version : ''}).`);
  }
  updateEnforcement();
  return r;
}

// ---------------------------------------------------------------------------
// Strict mode (INTEGRITY_MODE=enforce)
// ---------------------------------------------------------------------------
const GATE_ALLOW_ANY = [/^\/api\/health$/, /^\/api\/license(\/.*)?$/];   // any method
const GATE_ALLOW_METHOD = [['POST', /^\/api\/auth\/login$/], ['POST', /^\/api\/auth\/logout$/], ['GET', /^\/api\/auth\/me$/]];   // needed to reach the auth-protected licence routes
const RECOVERY_STEPS = [
  'Protected licensing files no longer match the signed manifest of this build (or the manifest is missing/invalid).',
  'Find the affected files with the reference ID: audit log entry INTEGRITY_ENFORCED, or the service log (Linux: journalctl -u dcim | grep <reference>; Windows: <install folder>\\webapp\\logs).',
  'Restore the packaged files: run the repair utility (Linux: sudo dcim-repair; Windows: DCIM-Repair-<version>.exe), or roll back with dcim-rollback / the pre-upgrade snapshot.',
  'Only if the change was deliberate and trusted: set INTEGRITY_MODE=warn in the .env file next to server.js and restart the service.',
  'License activation stays available: sign in as a Global Admin and use /api/license/* (status, fingerprint, activate). No license, trial or database data is changed by this protection.',
];
function newReference(files) {
  const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return 'INT-' + d + '-' + sha256(d + '|' + files.join(',') + '|' + crypto.randomBytes(8).toString('hex')).slice(0, 8).toUpperCase();
}
function fileViolation() {
  if (!S || !S.result) return false;
  return S.result.state === 'modified' || S.result.state === 'invalid-manifest' || S.result.state === 'unsigned';
}
function gateAllows(req) {
  const raw = String(req.url || '').split('?')[0];
  if (/[%\\]|\.\./.test(raw) || raw.includes('//')) return false;       // no encoded / traversal tricks on the allow-list
  const p = raw.toLowerCase().replace(/\/+$/, '') || '/';
  if (GATE_ALLOW_ANY.some((re) => re.test(p))) return true;
  return GATE_ALLOW_METHOD.some(([m, re]) => req.method === m && re.test(p));
}
function escapeHtml(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function refuse(req, res) {
  S.refused = (S.refused || 0) + 1;
  const body = { error: 'integrity_enforced', message: 'This server refused to start normally because its protected licensing files failed the integrity check.', referenceId: S.refId, recovery: RECOVERY_STEPS };
  try {
    const wantsHtml = !/^\/api\//i.test(String(req.url || '')) && /text\/html/.test(String(req.headers && req.headers.accept || ''));
    const headers = { 'Cache-Control': 'no-store', 'X-Integrity-Reference': S.refId };
    if (wantsHtml) {
      const html = `<!doctype html><meta charset="utf-8"><title>Integrity check failed</title><body style="font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>Integrity check failed</h1><p>${escapeHtml(body.message)}</p><p><b>Reference ID:</b> <code>${escapeHtml(S.refId)}</code></p><h2>Recovery</h2><ol>${RECOVERY_STEPS.map((x) => '<li>' + escapeHtml(x) + '</li>').join('')}</ol></body>`;
      res.writeHead(503, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers)); res.end(html);
    } else {
      res.writeHead(503, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)); res.end(JSON.stringify(body));
    }
  } catch (e) { try { res.destroy(); } catch (e2) { /* ignore */ } }
}
function installGate() {
  if (S.gate) return;
  S.gate = true;
  for (const mod of ['http', 'https']) {
    const Srv = require(mod).Server;
    const orig = Srv.prototype.emit;
    Srv.prototype.emit = function (ev, req, res) {
      if (ev === 'request' && S && S.enforced && !gateAllows(req)) { refuse(req, res); return true; }
      return orig.apply(this, arguments);
    };
  }
}
// Sticky: once enforcement starts it lasts until restart (the code already loaded in memory is what is suspect, so
// restoring files on disk must be followed by a restart).
function updateEnforcement() {
  if (mode() !== 'enforce') return;
  installGate();
  if (S.enforced || !fileViolation()) return;
  const r = S.result;
  const files = r.state === 'unsigned' ? [MANIFEST_NAME + ' (missing)'] : r.state === 'invalid-manifest' ? [MANIFEST_NAME + ' (invalid)'] : [...r.modified, ...r.missing.map((f) => f + ' (missing)'), ...(r.memoryKeyMismatch ? ['loaded licence public key'] : [])];
  S.enforced = true; S.refId = newReference(files); S.enforcedAt = new Date().toISOString(); S.enforcedFiles = files;
  emitOnce('INTEGRITY_ENFORCED', { referenceId: S.refId, files, state: r.state, action: 'normal startup refused; only /api/health and /api/license/* (plus sign-in) are served', recovery: 'run the repair utility / restore packaged files, or set INTEGRITY_MODE=warn if the change was deliberate' }, S.refId);
  if (S.log) S.log.error(`[integrity] ENFORCED - protected files failed verification (${files.join(', ')}). Reference ${S.refId}. Normal startup refused; serving only /api/health and /api/license/*. Recovery: ${RECOVERY_STEPS.slice(2, 4).join(' ')}`);
}

// Idempotent. First caller wins (license.js and server.js both call it).
function init({ root, emit, log, defer } = {}) {
  if (S) { if (log && !S.log) S.log = log; if (emit && !S.emit) S.emit = emit; return S.result; }
  S = { root: root || path.join(__dirname, '..'), emit: emit || null, log: log || null, result: null, env: [], snapshot: {}, licenseFile: null, licenseBase: null, timer: null, defer: !!defer, queue: [], enforced: false, refId: null };
  evaluate(true);
  S.env = envRisks(process.env, process.execArgv);
  if (S.env.length) {
    emitOnce('INTEGRITY_ENV_OVERRIDE', { risks: S.env, mode: mode() }, S.env.join('|'));
    if (S.log) S.log.warn(`[integrity] WARNING: risky environment override(s): ${S.env.join('; ')}. Mode: ${mode()}.`);
  }
  return S.result;
}

function compromised() {
  if (!S || !S.result) return false;
  return S.result.state === 'modified' || S.result.state === 'invalid-manifest' || S.env.length > 0;
}
// Restricted mode is opt-in (INTEGRITY_MODE=restricted). A missing manifest also counts there,
// otherwise deleting the manifest would switch the check off.
function isRestricted() {
  if (!S || mode() !== 'restricted') return false;
  return compromised() || (S.result && S.result.state === 'unsigned');
}
function isEnforced() { return !!(S && S.enforced); }
function getStatus() {
  if (!S || !S.result) return { state: 'unknown', mode: mode(), restricted: false, warnings: [] };
  const warnings = [];
  if (S.result.state === 'modified' || S.result.state === 'invalid-manifest') warnings.push('Application files that enforce licensing were modified after this build was packaged.');
  if (S.result.state === 'unsigned' && process.env.NODE_ENV === 'production') warnings.push('This install has no signed integrity manifest.');
  if (S.env.length) warnings.push('The service environment contains overrides that can change application behaviour.');
  const out = { state: S.result.state, mode: mode(), restricted: isRestricted() || S.enforced, warnings };
  if (S.enforced) { out.enforced = true; out.referenceId = S.refId; out.recovery = RECOVERY_STEPS; warnings.unshift(`Strict integrity mode is active (reference ${S.refId}): normal operation is refused until the packaged files are restored.`); }
  return out;
}

// ---------------------------------------------------------------------------
// Licence-file monitoring + periodic re-check (one unref'd timer, stat-only unless something changed)
// ---------------------------------------------------------------------------
function fileBase(p) {
  try { const st = fs.statSync(p); return { sig: `${st.mtimeMs}:${st.size}:${st.ino}`, hash: sha256(fs.readFileSync(p)) }; } catch (e) { return null; }
}
function monitorLicenseFile(licenseFile) {
  S.licenseFile = licenseFile;
  S.licenseBase = fileBase(licenseFile);
}
// Called by the app itself right after it installs a new licence, so that change is not reported as "unexpected".
function acknowledge(licenseFile) {
  if (S && (!S.licenseFile || S.licenseFile === licenseFile)) { S.licenseFile = licenseFile; S.licenseBase = fileBase(licenseFile); }
}
function tick(onLicenseChanged) {
  if (!S) return;
  const now = snapshotStats(S.root);
  if (Object.keys(now).some((k) => now[k] !== S.snapshot[k])) evaluate(false);
  if (S.licenseFile) {
    let st = null; try { st = fs.statSync(S.licenseFile); } catch (e) { st = null; }
    const sig = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : null;
    const prev = S.licenseBase;
    if (!st && prev) {
      S.licenseBase = null;
      emitOnce('LICENSE_FILE_REMOVED', { note: 'license.lic was removed outside the application' }, 'removed:' + sha12(prev.hash));
      if (onLicenseChanged) onLicenseChanged();
    } else if (st && (!prev || sig !== prev.sig)) {
      const cur = fileBase(S.licenseFile);
      if (cur && (!prev || cur.hash !== prev.hash)) {
        emitOnce('LICENSE_FILE_MODIFIED', { note: 'license.lic changed outside the application', before: prev ? sha12(prev.hash) : null, after: sha12(cur.hash) }, sha12(cur.hash));
        if (onLicenseChanged) onLicenseChanged();
      }
      S.licenseBase = cur;
    }
  }
}
// Events raised before the database was ready (early init) are delivered now.
function flushEvents() {
  if (!S) return;
  S.defer = false;
  const q = S.queue.splice(0);
  for (const [t, d] of q) { try { if (S.emit) S.emit(t, d); } catch (e) { /* ignore */ } }
}
function startMonitor({ licenseFile, onLicenseChanged, intervalMs } = {}) {
  if (!S) return;
  flushEvents();
  if (licenseFile) monitorLicenseFile(licenseFile);
  if (S.timer) return;
  S.timer = setInterval(() => { try { tick(onLicenseChanged); } catch (e) { /* never throw from a timer */ } }, intervalMs || TICK_MS);
  if (S.timer.unref) S.timer.unref();
}
function stopMonitor() { if (S && S.timer) { clearInterval(S.timer); S.timer = null; } }
function _resetForTests() { stopMonitor(); S = null; seen.clear(); }

module.exports = {
  MANIFEST_NAME,
  PROTECTED_FILES,
  buildManifest,
  checkIntegrity,
  envRisks,
  init,
  startMonitor,
  stopMonitor,
  acknowledge,
  isRestricted,
  isEnforced,
  flushEvents,
  gateAllows,
  getStatus,
  tick,
  _resetForTests,
};

// Operator check:  node lib/integrity.js        (exit 0 = ok, 1 = failed)
if (require.main === module) {
  const r = checkIntegrity(path.join(__dirname, '..'));
  console.log(JSON.stringify({ state: r.state, modified: r.modified, missing: r.missing, memoryKeyMismatch: r.memoryKeyMismatch, manifest: r.keyId, build: r.version }, null, 2));
  process.exit(r.state === 'ok' ? 0 : 1);
}
