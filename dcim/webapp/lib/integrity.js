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
const PROTECTED_FILES = ['server.js', 'lib/license.js', 'lib/license-public-key.js', 'lib/integrity.js', 'lib/integrity-public-key.js'];
// SHA-256 of the vendor integrity public key. Written by packaging/tools/integrity-keygen.js --install, and mirrored in
// lib/license.js, so replacing or removing the key file alone is detected (all three places must agree).
const PIN_FPR = 'd45272f48b97371e496c2753bd0c7f3746809512270180c2fb3832d27b2f1fd2'; // @INTEGRITY_PIN_FPR@
const TICK_MS = 60 * 1000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha12 = (s) => String(s).slice(0, 12);

// ---------------------------------------------------------------------------
// Manifest creation (build time only - the private key lives in memory for the
// duration of the call and is never written anywhere).
// ---------------------------------------------------------------------------
function loadPin(root) {
  try {
    const f = require.resolve(path.join(root, 'lib', 'integrity-public-key.js'));
    delete require.cache[f];
    const pem = require(f).INTEGRITY_PUBLIC_KEY_PEM;
    return pem ? String(pem) : null;
  } catch (e) { return null; }
}
const pinFingerprint = (root) => { const p = loadPin(root || path.join(__dirname, '..')); return p ? sha256(p) : null; };

// signKeyPem: the vendor integrity PRIVATE key (PEM text read by the build tool from a file outside the package tree).
// With a pinned vendor key the key is mandatory and must match the pin; without a pin the manifest is self-signed.
// A protected lib/<name>.js file may have been replaced by a compiled-loader stub (bytenode-compile.js),
// with the real logic in lib/<name>.jsc next to it. Both are hashed - the stub (so swapping back to a
// patched plain-JS file is caught) and the bytecode (so swapping just the .jsc behind an untouched
// stub is caught too). See docs/LICENSING-ANTI-CRACK-REVIEW-2026-10-22.md section 4 for its limits.
function jscSibling(root, rel) {
  if (!rel.endsWith('.js')) return null;
  const jsc = rel.slice(0, -3) + '.jsc';
  return fs.existsSync(path.join(root, jsc)) ? jsc : null;
}
function buildManifest(root, opts = {}) {
  const files = {};
  for (const rel of PROTECTED_FILES) {
    files[rel] = sha256(fs.readFileSync(path.join(root, rel)));
    const jsc = jscSibling(root, rel);
    if (jsc) files[jsc] = sha256(fs.readFileSync(path.join(root, jsc)));
  }
  const keyModule = path.join(root, 'lib', 'license-public-key.js');
  delete require.cache[require.resolve(keyModule)];
  const pem = String(require(keyModule).LICENSE_PUBLIC_KEY_PEM || '');
  const pin = loadPin(root);
  let privateKey; let publicKey; let signer;
  if (pin) {
    if (!opts.signKeyPem) throw new Error('a vendor integrity key is pinned in lib/integrity-public-key.js: the manifest must be signed with the matching private key (--sign-key <file>)');
    privateKey = crypto.createPrivateKey(opts.signKeyPem);
    const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    if (sha256(derived) !== sha256(crypto.createPublicKey(pin).export({ type: 'spki', format: 'pem' }))) throw new Error('the signing key does not match the pinned vendor integrity public key');
    signer = 'vendor';
  } else {
    if (opts.signKeyPem) throw new Error('a signing key was supplied but no vendor integrity public key is pinned - run integrity-keygen.js --install first');
    ({ publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'));
    signer = 'build';
  }
  const payload = {
    v: 2,
    product: 'DCIM Dashboard',
    version: opts.version || null,
    createdAt: new Date().toISOString(),
    signer,
    files,
    licenseKeySha256: sha256(pem),
    integrityKeySha256: pin ? sha256(pin) : null,
  };
  const payloadJson = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(payloadJson), privateKey).toString('base64');
  const out = { alg: 'Ed25519', payloadJson, signature };
  if (!pin) out.publicKey = publicKey.export({ type: 'spki', format: 'pem' });   // vendor-signed manifests carry NO key: the verifier uses only the pinned one
  return out;
}

// Known-answer test for the signature primitive: a hook that makes crypto.verify always say "valid" (or always "invalid")
// is caught here before the licence or manifest result is trusted.
const KAT_PUB = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAuzsfS8iCNaM7WXiQRTufYPQspvodFU6efQlQxGwj8CY=\n-----END PUBLIC KEY-----\n';
const KAT_SIG = 'lqqh1qKK03NjKHqTWYfxvJ0e0b9rnKRHTmYPd/09UyxRnKCTeFiLVRTmeMHWFeaCPOhIi9HWz+STkWKmWANODg==';
function cryptoSelfTest() {
  try {
    const k = crypto.createPublicKey(KAT_PUB);
    const good = crypto.verify(null, Buffer.from('dcim-kat-v1|The quick brown fox'), k, Buffer.from(KAT_SIG, 'base64'));
    const bad = crypto.verify(null, Buffer.from('dcim-kat-v1|The quick brown fox!'), k, Buffer.from(KAT_SIG, 'base64'));
    return good === true && bad === false;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
const LOADER_FLAG = /(^|\s)(-r|--require|--import|--loader|--experimental-loader|--inspect(-brk|-port|-wait)?|--debug(-brk|-port)?|-e|--eval|--experimental-vm-modules)(=|\s|$)/;
let rawEnvHook = null;   // tests only: 'mirror' = trust process.env (unit tests mutate it in-process)
function readProcEnv() {
  if (rawEnvHook === 'mirror') return Object.assign({}, process.env);
  // The kernel's copy of the start-up environment: unlike process.env it cannot be rewritten by JavaScript.
  if (process.platform !== 'linux') return null;
  try {
    const out = {};
    for (const kv of fs.readFileSync('/proc/self/environ', 'latin1').split('\0')) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
    return out;
  } catch (e) { return null; }
}
function envRisks(env, execArgv, rawEnv) {
  const risks = [];
  const add = (m) => { if (!risks.includes(m)) risks.push(m); };
  for (const e of rawEnv ? [env, rawEnv] : [env]) {
    if (e.NODE_OPTIONS && LOADER_FLAG.test(e.NODE_OPTIONS)) add('NODE_OPTIONS loads code or opens a debugger');
    if (e.NODE_PATH) add('NODE_PATH is set (module search path override)');
    if (e.LD_PRELOAD) add('LD_PRELOAD is set');
  }
  if (rawEnv) for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']) if ((rawEnv[k] || '') !== (env[k] || '')) add('process environment was altered after start-up (' + k + ')');
  if ((execArgv || []).some((a) => LOADER_FLAG.test(String(a)))) add('node was started with a code-loading / debug flag');
  return risks;
}
// Things that can only be seen at run time: an open inspector (SIGUSR1 or --inspect), a broken signature primitive,
// application modules loaded from outside the install folder (a --require preload).
function runtimeRisks(root) {
  const risks = envRisks(process.env, process.execArgv, readProcEnv());
  try { if (require('inspector').url()) risks.push('the Node.js inspector/debugger is open'); } catch (e) { /* inspector unavailable */ }
  if (!cryptoSelfTest()) risks.push('the signature primitive failed its known-answer self-test (patched crypto)');
  try {
    const norm = (p) => { let r = p; try { r = fs.realpathSync(p); } catch (e) { /* keep */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
    const base = norm(root) + path.sep;
    const outside = Object.keys(require.cache).filter((f) => !norm(f).startsWith(base));
    if (outside.length) risks.push('module(s) loaded from outside the application folder: ' + outside.slice(0, 3).map((f) => path.basename(f)).join(', '));
  } catch (e) { /* ignore */ }
  return risks;
}

function checkIntegrity(root, opts = {}) {
  const res = { state: 'ok', modified: [], missing: [], memoryKeyMismatch: false, trustRootMismatch: false, signer: null, keyId: null, version: null };
  const mpath = path.join(root, MANIFEST_NAME);
  const pin = loadPin(root);
  const pinFpr = pin ? sha256(pin) : null;
  // Trust root: the pinned key, the constant in this file and (when supplied) the constant in lib/license.js must agree.
  // Removing the pin (downgrade to a self-signed manifest) or swapping it is therefore a detected change.
  if (pinFpr !== PIN_FPR || (opts.peerPinFpr !== undefined && opts.peerPinFpr !== pinFpr)) res.trustRootMismatch = true;
  if (!fs.existsSync(mpath)) { res.state = 'unsigned'; return res; }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    let verifyKey = null;
    if (pin) verifyKey = crypto.createPublicKey(pin);                       // vendor mode: ONLY the pinned key counts
    else if (m && typeof m.publicKey === 'string') verifyKey = crypto.createPublicKey(m.publicKey);   // legacy self-signed
    const ok = m && m.alg === 'Ed25519' && typeof m.payloadJson === 'string' && typeof m.signature === 'string' && verifyKey
      && crypto.verify(null, Buffer.from(m.payloadJson), verifyKey, Buffer.from(m.signature, 'base64'));
    if (!ok) { res.state = 'invalid-manifest'; return res; }
    res.keyId = sha12(sha256(pin || m.publicKey));
    res.signer = pin ? 'vendor' : 'build';
  } catch (e) { res.state = 'invalid-manifest'; return res; }
  let payload;
  try { payload = JSON.parse(m.payloadJson); } catch (e) { res.state = 'invalid-manifest'; return res; }
  res.version = payload.version || null;
  if (pin && payload.signer !== 'vendor') { res.state = 'invalid-manifest'; return res; }
  for (const [rel, want] of Object.entries(payload.files || {})) {
    let got = null;
    try { got = sha256(fs.readFileSync(path.join(root, rel))); } catch (e) { res.missing.push(rel); continue; }
    if (got !== want) res.modified.push(rel);
  }
  // A manifest that does not cover the protected set is itself suspicious.
  for (const rel of PROTECTED_FILES) if (!(payload.files || {})[rel]) res.missing.push(rel);
  // A .jsc now present on disk next to a protected stub, but never covered by the signed manifest, is
  // exactly the "swap the bytecode behind an untouched stub" attack - treat it as a missing/tampered file.
  for (const rel of PROTECTED_FILES) { const jsc = jscSibling(root, rel); if (jsc && !(payload.files || {})[jsc]) res.missing.push(jsc); }
  try {
    const mem = String(require('./license-public-key').LICENSE_PUBLIC_KEY_PEM || '');
    if (sha256(mem) !== payload.licenseKeySha256) res.memoryKeyMismatch = true;
  } catch (e) { res.memoryKeyMismatch = true; }
  if (payload.integrityKeySha256 !== undefined && payload.integrityKeySha256 !== pinFpr) res.trustRootMismatch = true;
  if (res.modified.length || res.missing.length || res.memoryKeyMismatch || res.trustRootMismatch) res.state = 'modified';
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
  const r = checkIntegrity(S.root, { peerPinFpr: S.peerPinFpr });
  S.result = r;
  S.snapshot = snapshotStats(S.root);
  if (r.state === 'modified') {
    const files = [...r.modified, ...r.missing.map((f) => f + ' (missing)'), ...(r.trustRootMismatch ? ['integrity trust root'] : [])];
    emitOnce('INTEGRITY_VIOLATION', { files, memoryKeyMismatch: r.memoryKeyMismatch, mode: mode() }, files.join(',') + '|' + r.memoryKeyMismatch);
    if (r.modified.includes('lib/license-public-key.js') || r.memoryKeyMismatch) {
      emitOnce('LICENSE_PUBLIC_KEY_REPLACED', { where: r.memoryKeyMismatch ? 'loaded key differs from the signed manifest' : 'lib/license-public-key.js differs from the signed manifest' }, String(r.memoryKeyMismatch));
    }
    if (r.trustRootMismatch) emitOnce('INTEGRITY_TRUST_ROOT_MISMATCH', { note: 'the vendor integrity key is missing, replaced or inconsistent across the protected files' }, 'trustroot');
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
  'If a "runtime:" item is listed (NODE_OPTIONS, NODE_PATH, LD_PRELOAD, an open debugger/inspector): remove it from the service definition / environment and restart the service - it is never needed for normal operation.',
  'Only if the change was deliberate and trusted: set INTEGRITY_MODE=warn in the .env file next to server.js and restart the service.',
  'License activation stays available: sign in as a Global Admin and use /api/license/* (status, fingerprint, activate). No license, trial or database data is changed by this protection.',
];
function newReference(files) {
  const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return 'INT-' + d + '-' + sha256(d + '|' + files.join(',') + '|' + crypto.randomBytes(8).toString('hex')).slice(0, 8).toUpperCase();
}
function hijackViolation() { return !!(S && S.env && S.env.length); }
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
  if (S.enforced || !(fileViolation() || hijackViolation())) return;
  const r = S.result;
  const files = [];
  if (fileViolation()) files.push(...(r.state === 'unsigned' ? [MANIFEST_NAME + ' (missing)'] : r.state === 'invalid-manifest' ? [MANIFEST_NAME + ' (invalid)'] : [...r.modified, ...r.missing.map((f) => f + ' (missing)'), ...(r.memoryKeyMismatch ? ['loaded licence public key'] : []), ...(r.trustRootMismatch ? ['integrity trust root'] : [])]));
  for (const x of S.env) files.push('runtime: ' + x);
  S.enforced = true; S.refId = newReference(files); S.enforcedAt = new Date().toISOString(); S.enforcedFiles = files;
  const state = fileViolation() ? r.state : 'runtime-hijack';
  emitOnce('INTEGRITY_ENFORCED', { referenceId: S.refId, files, state, action: 'normal startup refused; only /api/health and /api/license/* (plus sign-in) are served', recovery: 'run the repair utility / restore packaged files, or set INTEGRITY_MODE=warn if the change was deliberate' }, S.refId);
  if (S.log) S.log.error(`[integrity] ENFORCED - protected files failed verification (${files.join(', ')}). Reference ${S.refId}. Normal startup refused; serving only /api/health and /api/license/*. Recovery: ${RECOVERY_STEPS.slice(2, 5).join(' ')}`);
}

// Idempotent. First caller wins (license.js and server.js both call it).
function init({ root, emit, log, defer, peerPinFpr } = {}) {
  if (S) { if (log && !S.log) S.log = log; if (emit && !S.emit) S.emit = emit; return S.result; }
  S = { root: root || path.join(__dirname, '..'), emit: emit || null, log: log || null, result: null, env: [], snapshot: {}, licenseFile: null, licenseBase: null, timer: null, defer: !!defer, queue: [], enforced: false, refId: null, peerPinFpr, sigHandler: false };
  S.env = runtimeRisks(S.root);
  evaluate(true);
  reportEnv();
  armInspectorGuard();
  return S.result;
}
function reportEnv() {
  if (!S.env.length) return;
  emitOnce('INTEGRITY_ENV_OVERRIDE', { risks: S.env, mode: mode() }, S.env.join('|'));
  if (S.log) S.log.warn(`[integrity] WARNING: risky runtime condition(s): ${S.env.join('; ')}. Mode: ${mode()}.`);
}
// Node starts the inspector on SIGUSR1 unless the process handles the signal. Under enforce we handle it: the attempt is
// audited and treated as a hijack, and no inspector is opened.
let usr1 = null;
function armInspectorGuard() {
  if (mode() !== 'enforce' || S.sigHandler || process.platform === 'win32') return;
  S.sigHandler = true;
  usr1 = () => { try { recheckRuntime('SIGUSR1 (inspector request)'); } catch (e) { /* ignore */ } };
  try { process.on('SIGUSR1', usr1); } catch (e) { /* ignore */ }
}
function recheckRuntime(why) {
  if (!S) return;
  const now = runtimeRisks(S.root);
  if (why) now.push('debugger request received: ' + why);
  const fresh = now.filter((x) => !S.env.includes(x));
  if (fresh.length) { S.env = S.env.concat(fresh); reportEnv(); }
  updateEnforcement();
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
  recheckRuntime();
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
function _setRawEnvForTests(v) { rawEnvHook = v || null; }
function _resetForTests() { stopMonitor(); if (usr1) { try { process.removeListener('SIGUSR1', usr1); } catch (e) { /* ignore */ } usr1 = null; } S = null; seen.clear(); }

module.exports = {
  MANIFEST_NAME,
  PROTECTED_FILES,
  buildManifest,
  checkIntegrity,
  pinFingerprint,
  cryptoSelfTest,
  runtimeRisks,
  PIN_FPR,
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
  _setRawEnvForTests,
};

// Operator check:  node lib/integrity.js        (exit 0 = ok, 1 = failed)
if (require.main === module) {
  const r = checkIntegrity(path.join(__dirname, '..'));
  console.log(JSON.stringify({ state: r.state, modified: r.modified, missing: r.missing, memoryKeyMismatch: r.memoryKeyMismatch, manifest: r.keyId, signer: r.signer, trustRootMismatch: r.trustRootMismatch, build: r.version }, null, 2));
  process.exit(r.state === 'ok' ? 0 : 1);
}
