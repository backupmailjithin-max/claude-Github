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
// Default mode is "warn": nothing is blocked, so legitimate hot-fix copies of a
// file only produce a warning until the manifest is regenerated.
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
  try { S.emit(type, details || {}); } catch (e) { /* auditing must never break the app */ }
}
const mode = () => (String(process.env.INTEGRITY_MODE || '').toLowerCase() === 'restricted' ? 'restricted' : 'warn');

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
  return r;
}

// Idempotent. First caller wins (license.js and server.js both call it).
function init({ root, emit, log } = {}) {
  if (S) { if (log && !S.log) S.log = log; if (emit && !S.emit) S.emit = emit; return S.result; }
  S = { root: root || path.join(__dirname, '..'), emit: emit || null, log: log || null, result: null, env: [], snapshot: {}, licenseFile: null, licenseBase: null, timer: null };
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
function getStatus() {
  if (!S || !S.result) return { state: 'unknown', mode: mode(), restricted: false, warnings: [] };
  const warnings = [];
  if (S.result.state === 'modified' || S.result.state === 'invalid-manifest') warnings.push('Application files that enforce licensing were modified after this build was packaged.');
  if (S.result.state === 'unsigned' && process.env.NODE_ENV === 'production') warnings.push('This install has no signed integrity manifest.');
  if (S.env.length) warnings.push('The service environment contains overrides that can change application behaviour.');
  return { state: S.result.state, mode: mode(), restricted: isRestricted(), warnings };
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
function startMonitor({ licenseFile, onLicenseChanged, intervalMs } = {}) {
  if (!S) return;
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
  getStatus,
  tick,
  _resetForTests,
};
