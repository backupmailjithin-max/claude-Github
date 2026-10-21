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
const { execFileSync } = require('child_process');
const { LICENSE_PUBLIC_KEY_PEM } = require('./license-public-key');

function isLicensingConfigured() {
  return !!LICENSE_PUBLIC_KEY_PEM;
}

// Combines a few stable, OS-level identifiers into one fingerprint so a
// license tied to a machine keeps working across reboots/IP changes but
// stops working if the license file is just copied to a different host.
// No single signal is trusted alone (e.g. a MAC address can be spoofed) -
// a real attacker with full OS access can still defeat this, the same
// limitation every offline node-locking scheme has; the goal is to stop
// casual copying/sharing, not a determined, technical adversary.
function computeMachineFingerprint() {
  const parts = [];
  try {
    if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(p)) { parts.push(fs.readFileSync(p, 'utf8').trim()); break; }
      }
    } else if (process.platform === 'win32') {
      try {
        const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' });
        const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
        if (m) parts.push(m[1]);
      } catch (e) { /* fall through to the generic signals below */ }
    }
  } catch (e) { /* fall through */ }
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
  // unwieldy to copy/paste by hand - this only needs to differentiate real
  // machines, not resist a deliberate cryptographic collision attack.
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 32);
}

// Readable grouped form for display/copy-paste, e.g. "A1B2-C3D4-...".
function formatFingerprint(fp) {
  return (fp.match(/.{1,4}/g) || [fp]).join('-').toUpperCase();
}

function verifyLicenseFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: false, reason: 'No license file found.' };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { valid: false, reason: 'License file is not valid JSON.' };
  }
  if (!data || data.alg !== 'Ed25519' || typeof data.payloadJson !== 'string' || typeof data.signature !== 'string') {
    return { valid: false, reason: 'License file is malformed or not a recognized license.' };
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM);
  } catch (e) {
    return { valid: false, reason: 'No license public key is configured on this build.' };
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, Buffer.from(data.payloadJson), publicKey, Buffer.from(data.signature, 'base64'));
  } catch (e) {
    sigOk = false;
  }
  if (!sigOk) {
    return { valid: false, reason: 'License signature is invalid (the file was altered, or was not issued for this product).' };
  }
  let payload;
  try {
    payload = JSON.parse(data.payloadJson);
  } catch (e) {
    return { valid: false, reason: 'License payload is corrupt.' };
  }
  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: `License expired on ${payload.expiresAt}.`, payload };
  }
  if (payload.machineId) {
    const here = computeMachineFingerprint();
    if (payload.machineId !== here) {
      return { valid: false, reason: 'This license was issued for a different machine.', payload };
    }
  }
  return { valid: true, payload };
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

function trialSig(startedAt) {
  const key = crypto.createHash('sha256').update('dcim-trial-v1|' + computeMachineFingerprint()).digest();
  return crypto.createHmac('sha256', key).update(String(startedAt)).digest('hex');
}
function sigOk(startedAt, sig) {
  if (!startedAt || typeof sig !== 'string') return false;
  const a = Buffer.from(trialSig(startedAt)); const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Call once at startup, after the database is ready. dbGet(key)/dbSet(key, value) are the app_settings helpers.
async function initTrial({ filePath, dbGet, dbSet, log }) {
  trialState = { startedAt: null, tampered: false, filePath, lastSeen: 0, lastPersist: 0, dbSet };
  const valid = [];
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
  if (tampered) { startedAt = 1; if (log) log.warn('[license] trial record was altered or copied from another machine - trial treated as ended.'); }
  else if (valid.length) startedAt = Math.min(...valid);
  else { startedAt = Date.now(); if (log) log.info(`[license] ${TRIAL_DAYS}-day free trial started now.`); }
  trialState.startedAt = startedAt; trialState.tampered = tampered; trialState.lastSeen = Math.max(seen, Date.now());
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
  const real = Date.now();
  if (real > trialState.lastSeen) trialState.lastSeen = real;
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
  if (result.valid) return { enforced: true, valid: true, mode: 'licensed', reason: null, fingerprint, license, trial: null };
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
  formatFingerprint,
  verifyLicenseFile,
  getLicenseStatus,
  initTrial,
  getTrialInfo,
  TRIAL_DAYS,
};
