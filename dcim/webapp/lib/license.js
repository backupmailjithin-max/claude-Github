'use strict';
// Offline license verification. Pairs with tools/license-keygen.js (run once,
// by whoever owns the product, to create a signing keypair) and
// tools/license-issue.js (run per customer to mint a signed .lic file).
// See docs/LICENSING.md for the full setup walkthrough.
//
// Design: Ed25519 signature over the license's exact JSON bytes (not a
// re-serialization of the parsed object - that would be ambiguous), plus an
// optional machine fingerprint so a copied license file fails on any
// machine other than the one it was issued for. The private key never
// ships with the app; only the public key (lib/license-public-key.js) does,
// which is safe to distribute since it can verify but never create a
// signature.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LICENSE_PUBLIC_KEY_PEM } = require('./license-public-key');

function isLicensingConfigured() {
  return !!LICENSE_PUBLIC_KEY_PEM;
}

// Machine binding.
//   PRIMARY   : the OS machine-id (Linux /etc/machine-id, Windows MachineGuid), hashed.
//               It survives hostname and network-card changes.
//   SECONDARY : the original composite (machine-id + first MAC + hostname). It is still
//               ACCEPTED, so every license issued before this hardening keeps working
//               unchanged, but it is no longer what new licenses are bound to.
// No single signal is a defence against a determined attacker with full OS
// access (true of every offline node-locking scheme); the goal is to stop
// casual copying/sharing while not locking out honest customers who rename a
// host or swap a NIC.
let cachedMachineId;
function readMachineId() {
  if (cachedMachineId !== undefined) return cachedMachineId;
  let id = '';
  try {
    if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(p)) { id = fs.readFileSync(p, 'utf8').trim(); break; }
      }
    } else if (process.platform === 'win32') {
      try {
        const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' });
        const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
        if (m) id = m[1];
      } catch (e) { /* fall through to the generic signals below */ }
    }
  } catch (e) { /* fall through */ }
  cachedMachineId = id;
  return id;
}

// The ORIGINAL algorithm, byte-for-byte: used to keep existing machine-bound
// licenses and trial records valid.
function computeLegacyFingerprint() {
  const parts = [];
  parts.push(readMachineId());
  try {
    const nets = os.networkInterfaces();
    const macs = Object.values(nets)
      .flat()
      .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
      .map((n) => n.mac);
    if (macs.length) parts.push(macs.sort()[0]);
  } catch (e) { /* fall through */ }
  parts.push(os.hostname());
  const combined = parts.filter(Boolean).join('|') || 'unknown-machine';
  // 32 hex chars (128 bits) is ample to distinguish machines without being
  // unwieldy to copy/paste by hand.
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 32);
}

// The fingerprint shown to the customer / used for NEW licenses: machine-id based
// when an OS machine-id exists, otherwise the composite (containers, odd hosts).
function computeMachineFingerprint() {
  const mid = readMachineId();
  if (!mid) return computeLegacyFingerprint();
  return crypto.createHash('sha256').update('dcim-mid-v1|' + mid).digest('hex').slice(0, 32);
}

// Every fingerprint this machine answers to, primary first.
function acceptedFingerprints() {
  const primary = computeMachineFingerprint();
  const legacy = computeLegacyFingerprint();
  return primary === legacy ? [primary] : [primary, legacy];
}

// Readable grouped form for display/copy-paste, e.g. "A1B2-C3D4-...".
function formatFingerprint(fp) {
  return (fp.match(/.{1,4}/g) || [fp]).join('-').toUpperCase();
}

// ---------------------------------------------------------------------------
// Security events (tampered license, clock rollback, ...). license.js stays free
// of any database code: the host app registers a listener that writes the audit
// log. Each distinct event is reported once per process (status is polled on
// every request, so un-deduplicated events would flood the log).
// ---------------------------------------------------------------------------
let securityListener = null;
const securitySeen = new Set();
function setSecurityListener(fn) { securityListener = typeof fn === 'function' ? fn : null; }
function securityEvent(type, details, dedupeKey) {
  if (!securityListener) return;
  const k = type + '|' + (dedupeKey || '');
  if (securitySeen.has(k)) return;
  if (securitySeen.size > 200) securitySeen.clear();
  securitySeen.add(k);
  try { const r = securityListener(type, details || {}); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { /* never let auditing break licensing */ }
}
const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const TAMPER_CODES = new Set(['NOT_JSON', 'MALFORMED', 'BAD_SIGNATURE', 'CORRUPT_PAYLOAD']);

// ---------------------------------------------------------------------------
// Clock high-water mark. The latest time this install has ever seen is kept
// (HMAC-signed) in a state file AND in app_settings; "now" for expiry purposes is
// never earlier than it, so winding the system clock back no longer revives an
// expired license or trial. app_settings keys under "license." are excluded from
// backup/restore, so a restore cannot reset it.
// ---------------------------------------------------------------------------
const CLOCK_DB_KEY = 'license.clockSeen';
const CLOCK_DB_SIG_KEY = 'license.clockSeenSig';
const CLOCK_PERSIST_MS = 60 * 60 * 1000;      // persist at most hourly
const CLOCK_ROLLBACK_TOLERANCE_MS = 10 * 60 * 1000;   // ignore small NTP corrections when reporting
let clock = { ready: false, lastSeen: 0, lastPersist: 0, filePath: null, dbSet: null, rolledBack: false };

function keyedSig(keyFp, text) {
  const key = crypto.createHash('sha256').update('dcim-trial-v1|' + keyFp).digest();
  return crypto.createHmac('sha256', key).update(String(text)).digest('hex');
}
function sigMatches(text, sig) {
  if (typeof sig !== 'string') return false;
  const b = Buffer.from(sig);
  return acceptedFingerprints().some((fp) => { const a = Buffer.from(keyedSig(fp, text)); return a.length === b.length && crypto.timingSafeEqual(a, b); });
}
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } throw e; }
}

async function initClock({ filePath, dbGet, dbSet, seenHint, log }) {
  clock = { ready: true, lastSeen: 0, lastPersist: 0, filePath: filePath || null, dbSet: dbSet || null, rolledBack: false };
  let seen = Number(seenHint) || 0;
  try {
    if (filePath && fs.existsSync(filePath)) {
      const f = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (sigMatches('clock:' + Number(f.seen), f.sig)) seen = Math.max(seen, Number(f.seen));
      else securityEvent('LICENSE_CLOCK_STATE_TAMPERED', { store: 'file' }, 'file');
    }
  } catch (e) { /* unreadable file: the database copy still counts */ }
  try {
    const d = await dbGet(CLOCK_DB_KEY, '');
    if (d) {
      if (sigMatches('clock:' + Number(d), await dbGet(CLOCK_DB_SIG_KEY, ''))) seen = Math.max(seen, Number(d));
      else securityEvent('LICENSE_CLOCK_STATE_TAMPERED', { store: 'database' }, 'db');
    }
  } catch (e) { /* database unavailable: the file alone decides */ }
  clock.lastSeen = Math.max(seen, Date.now());
  if (seen - Date.now() > CLOCK_ROLLBACK_TOLERANCE_MS) {
    clock.rolledBack = true;
    securityEvent('LICENSE_CLOCK_ROLLBACK', { lastSeen: new Date(seen).toISOString(), systemClock: new Date().toISOString() }, 'init');
    if (log) log.warn(`[license] system clock (${new Date().toISOString()}) is earlier than the latest time this install has seen (${new Date(seen).toISOString()}); using the later time for expiry checks.`);
  }
  persistClock(true);
}

function persistClock(force) {
  if (!clock.ready) return;
  if (!force && clock.lastSeen - clock.lastPersist < CLOCK_PERSIST_MS) return;
  const seen = clock.lastSeen; clock.lastPersist = seen;
  const sig = keyedSig(computeMachineFingerprint(), 'clock:' + seen);
  try { if (clock.filePath) atomicWrite(clock.filePath, JSON.stringify({ seen, sig })); } catch (e) { /* best effort */ }
  try { if (clock.dbSet) Promise.resolve(clock.dbSet(CLOCK_DB_KEY, String(seen))).then(() => clock.dbSet(CLOCK_DB_SIG_KEY, sig)).catch(() => {}); } catch (e) { /* best effort */ }
}

// "Now" for every expiry decision: never earlier than the latest time seen.
function effectiveNow() {
  const real = Date.now();
  if (!clock.ready) return real;
  if (real > clock.lastSeen) clock.lastSeen = real;
  else if (clock.lastSeen - real > CLOCK_ROLLBACK_TOLERANCE_MS && !clock.rolledBack) {
    clock.rolledBack = true;
    securityEvent('LICENSE_CLOCK_ROLLBACK', { lastSeen: new Date(clock.lastSeen).toISOString(), systemClock: new Date(real).toISOString() }, 'runtime');
  }
  persistClock(false);
  return clock.lastSeen;
}

// ---------------------------------------------------------------------------
// Verification. verifyLicenseData() is pure (no events, no file access) so an
// upload can be fully checked BEFORE anything on disk is touched.
// ---------------------------------------------------------------------------
function verifyLicenseData(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return { valid: false, code: 'NOT_JSON', reason: 'License file is not valid JSON.' };
  }
  if (!data || data.alg !== 'Ed25519' || typeof data.payloadJson !== 'string' || typeof data.signature !== 'string') {
    return { valid: false, code: 'MALFORMED', reason: 'License file is malformed or not a recognized license.' };
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM);
  } catch (e) {
    return { valid: false, code: 'NO_KEY', reason: 'No license public key is configured on this build.' };
  }
  let sigGood = false;
  try {
    sigGood = crypto.verify(null, Buffer.from(data.payloadJson), publicKey, Buffer.from(data.signature, 'base64'));
  } catch (e) {
    sigGood = false;
  }
  if (!sigGood) {
    return { valid: false, code: 'BAD_SIGNATURE', reason: 'License signature is invalid (the file was altered, or was not issued for this product).' };
  }
  let payload;
  try {
    payload = JSON.parse(data.payloadJson);
  } catch (e) {
    return { valid: false, code: 'CORRUPT_PAYLOAD', reason: 'License payload is corrupt.' };
  }
  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < effectiveNow()) {
    return { valid: false, code: 'EXPIRED', reason: `License expired on ${payload.expiresAt}.`, payload };
  }
  let binding = null;
  if (payload.machineId) {
    const accepted = acceptedFingerprints();
    const idx = accepted.indexOf(payload.machineId);
    if (idx < 0) return { valid: false, code: 'WRONG_MACHINE', reason: 'This license was issued for a different machine.', payload };
    binding = idx === 0 ? 'machine-id' : 'legacy-composite';
  }
  return { valid: true, payload, binding };
}

function verifyLicenseFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: false, code: 'NO_FILE', reason: 'No license file found.' };
  }
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (e) { return { valid: false, code: 'NO_FILE', reason: 'No license file found.' }; }
  const r = verifyLicenseData(buf);
  if (!r.valid && TAMPER_CODES.has(r.code)) {
    securityEvent('LICENSE_TAMPERED', { reason: r.reason, code: r.code, fileSha256: sha12(buf), bytes: buf.length }, r.code + '|' + sha12(buf));
  }
  return r;
}

// Validate FIRST, then write a private temp file next to the target (mode 600),
// re-verify what was actually written, and only then atomically rename it over
// the current license. A bad upload can never overwrite a working license.
function installLicense(buffer, targetPath) {
  const pre = verifyLicenseData(buffer);
  if (!pre.valid) return { ok: false, result: pre };
  const tmp = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const post = verifyLicenseData(fs.readFileSync(tmp));
    if (!post.valid) { fs.unlinkSync(tmp); return { ok: false, result: post }; }
    fs.renameSync(tmp, targetPath);
    try { fs.chmodSync(targetPath, 0o600); } catch (e) { /* e.g. Windows */ }
    return { ok: true, result: post };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

// Tighten an existing license file (older versions wrote it world-readable).
// Content is never touched.
function secureLicenseFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath) && (fs.statSync(filePath).mode & 0o077)) { fs.chmodSync(filePath, 0o600); return true; }
  } catch (e) { /* not owner / Windows: leave as is */ }
  return false;
}

// ---------------------------------------------------------------------------
// 10-day free trial + auto-lock.
// The trial starts the first time the server runs with licensing enforced and
// no valid license. Its start time is stored in TWO places (a signed state
// file next to server.js and the app_settings table) and the EARLIEST valid
// copy wins, so deleting one of them does not restart the clock. The file is
// signed with a key derived from this machine's fingerprint, so editing it or
// copying it to another machine is detected and the trial counts as ended.
// When the trial runs out the app locks itself (every API call except the
// license / sign-out routes returns 402) until a valid license is activated.
// Limitation (same as any offline scheme): wiping BOTH stores restarts it.
// ---------------------------------------------------------------------------
const TRIAL_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DB_KEY = 'license.trialStartedAt';
const TRIAL_DB_SIG_KEY = 'license.trialSig';
const TRIAL_DB_SEEN_KEY = 'license.trialSeen';   // high-water mark of the clock, so rolling the system clock back cannot extend the trial
const TRIAL_DB_SEEN_SIG_KEY = 'license.trialSeenSig';
let trialState = { startedAt: null, tampered: false, filePath: null, lastSeen: 0, lastPersist: 0, dbSet: null };

// Records are signed with the primary (machine-id) key; records written by earlier
// versions (composite key) still verify and are re-signed on the next start.
function trialSig(startedAt) { return keyedSig(computeMachineFingerprint(), startedAt); }
function sigOk(startedAt, sig) {
  if (!startedAt) return false;
  return sigMatches(startedAt, sig);
}

// Call once at startup, after the database is ready. dbGet(key)/dbSet(key, value) are the app_settings helpers.
async function initTrial({ filePath, dbGet, dbSet, log }) {
  trialState = { startedAt: null, tampered: false, filePath, lastSeen: 0, lastPersist: 0, dbSet };
  const valid = [];
  let trialSeenHint = 0;
  let tampered = false;
  let seen = 0;
  try {
    if (filePath && fs.existsSync(filePath)) {
      const f = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (sigOk(Number(f.startedAt), f.sig)) valid.push(Number(f.startedAt)); else tampered = true;
      if (f.seen && sigOk('seen:' + Number(f.seen), f.seenSig)) seen = Math.max(seen, Number(f.seen));
    }
  } catch (e) { tampered = true; }
  try {
    const d = await dbGet(TRIAL_DB_KEY, '');
    if (d) {
      const sig = await dbGet(TRIAL_DB_SIG_KEY, '');
      if (sigOk(Number(d), sig)) valid.push(Number(d)); else tampered = true;
    }
    const dSeen = await dbGet(TRIAL_DB_SEEN_KEY, '');
    if (dSeen) { const sSig = await dbGet(TRIAL_DB_SEEN_SIG_KEY, ''); if (sigOk('seen:' + Number(dSeen), sSig)) seen = Math.max(seen, Number(dSeen)); }
  } catch (e) { /* database unavailable: the file alone decides */ }
  let startedAt;
  trialSeenHint = seen;
  if (tampered) securityEvent('LICENSE_TRIAL_TAMPERED', { note: 'trial record altered or copied from another machine' }, 'trial');
  // The clock high-water mark covers licenses AND the trial; it also inherits the trial's older "seen" value.
  try {
    await initClock({ filePath: filePath ? path.join(path.dirname(filePath), '.license-clock') : null, dbGet, dbSet, seenHint: trialSeenHint, log });
  } catch (e) { if (log) log.warn('[license] clock state initialisation failed: ' + e.message); }
  if (tampered) { startedAt = 1; if (log) log.warn('[license] trial record was altered or copied from another machine - trial treated as ended.'); }
  else if (valid.length) startedAt = Math.min(...valid);
  else { startedAt = Date.now(); if (log) log.info(`[license] ${TRIAL_DAYS}-day free trial started now.`); }
  trialState.startedAt = startedAt; trialState.tampered = tampered; trialState.lastSeen = Math.max(seen, clock.lastSeen, Date.now());
  if (!tampered) {
    const sig = trialSig(startedAt);
    try { if (filePath) fs.writeFileSync(filePath, JSON.stringify({ startedAt, sig })); } catch (e) { if (log) log.warn('[license] could not write trial state file: ' + e.message); }
    try { await dbSet(TRIAL_DB_KEY, String(startedAt)); await dbSet(TRIAL_DB_SIG_KEY, sig); } catch (e) { /* ignore */ }
  }
  return getTrialInfo();
}

// Effective "now": never earlier than the latest time this install has seen, so winding the clock back does not give the trial more days.
// The high-water mark is saved (signed) at most once an hour, to both the state file and the database.
function trialNow() {
  const eff = effectiveNow();
  if (eff > trialState.lastSeen) trialState.lastSeen = eff;
  if (!trialState.tampered && trialState.startedAt && trialState.lastSeen - trialState.lastPersist >= 60 * 60 * 1000) persistSeen();
  return trialState.lastSeen;
}
function persistSeen() {
  const seen = trialState.lastSeen; trialState.lastPersist = seen;
  const seenSig = trialSig('seen:' + seen);
  try {
    if (trialState.filePath) {
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(trialState.filePath, 'utf8')); } catch (e) { cur = {}; }
      fs.writeFileSync(trialState.filePath, JSON.stringify({ startedAt: cur.startedAt || trialState.startedAt, sig: cur.sig || trialSig(trialState.startedAt), seen, seenSig }));
    }
  } catch (e) { /* best effort */ }
  try { if (trialState.dbSet) Promise.resolve(trialState.dbSet(TRIAL_DB_SEEN_KEY, String(seen))).then(() => trialState.dbSet(TRIAL_DB_SEEN_SIG_KEY, seenSig)).catch(() => {}); } catch (e) { /* best effort */ }
}

function getTrialInfo() {
  if (!trialState.startedAt) return null;
  const endsAt = trialState.startedAt + TRIAL_DAYS * DAY_MS;
  const msLeft = endsAt - trialNow();
  return {
    days: TRIAL_DAYS,
    startedAt: new Date(trialState.startedAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
    active: msLeft > 0 && !trialState.tampered,
    tampered: trialState.tampered,
  };
}

function getLicenseStatus(licenseFilePath) {
  const fingerprint = formatFingerprint(computeMachineFingerprint());
  if (!isLicensingConfigured()) {
    return { enforced: false, valid: true, mode: 'off', reason: null, fingerprint, license: null, trial: null };
  }
  const result = verifyLicenseFile(licenseFilePath);
  const license = result.payload
    ? {
        licenseId: result.payload.licenseId || null,
        customer: result.payload.customer || null,
        maxUsers: result.payload.maxUsers || null,
        issuedAt: result.payload.issuedAt || null,
        expiresAt: result.payload.expiresAt || null,
        machineBound: !!result.payload.machineId,
      }
    : null;
  if (result.valid) return { enforced: true, valid: true, mode: 'licensed', reason: null, fingerprint, license, trial: null, binding: result.binding || null };
  const trial = getTrialInfo();
  if (trial && trial.active) return { enforced: true, valid: true, mode: 'trial', reason: null, fingerprint, license, trial };
  const why = trial
    ? (trial.tampered ? 'The free-trial record is invalid, so the trial is treated as ended.' : `The ${TRIAL_DAYS}-day free trial ended on ${trial.endsAt.slice(0, 10)}.`)
    : result.reason;
  return { enforced: true, valid: false, mode: 'locked', reason: `${why} Activate a license to continue.${result.payload ? ' (' + result.reason + ')' : ''}`, fingerprint, license, trial };
}

module.exports = {
  isLicensingConfigured,
  computeMachineFingerprint,
  computeLegacyFingerprint,
  acceptedFingerprints,
  formatFingerprint,
  verifyLicenseFile,
  verifyLicenseData,
  installLicense,
  secureLicenseFile,
  setSecurityListener,
  getLicenseStatus,
  initTrial,
  getTrialInfo,
  TRIAL_DAYS,
};
