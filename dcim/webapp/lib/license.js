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

function getLicenseStatus(licenseFilePath) {
  const fingerprint = formatFingerprint(computeMachineFingerprint());
  if (!isLicensingConfigured()) {
    return { enforced: false, valid: true, reason: null, fingerprint, license: null };
  }
  const result = verifyLicenseFile(licenseFilePath);
  return {
    enforced: true,
    valid: result.valid,
    reason: result.valid ? null : result.reason,
    fingerprint,
    license: result.payload
      ? {
          licenseId: result.payload.licenseId || null,
          customer: result.payload.customer || null,
          maxUsers: result.payload.maxUsers || null,
          issuedAt: result.payload.issuedAt || null,
          expiresAt: result.payload.expiresAt || null,
          machineBound: !!result.payload.machineId,
        }
      : null,
  };
}

module.exports = {
  isLicensingConfigured,
  computeMachineFingerprint,
  formatFingerprint,
  verifyLicenseFile,
  getLicenseStatus,
};
