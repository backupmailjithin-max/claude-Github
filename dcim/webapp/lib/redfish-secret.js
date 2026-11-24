'use strict';
// Redfish BMC passwords are stored encrypted with the same AES-256-GCM scheme (key derived from JWT_SECRET) that protects the
// OME, OneView and SMTP passwords. A stored value that starts with PREFIX is encrypted; anything else is a legacy plain value
// and is still accepted (and re-saved encrypted by sealLegacyPasswords), so existing credentials keep working.
const { encryptSecret, decryptSecret } = require('./setup-routes');

const PREFIX = 'enc:v1:';
const MAX_PLAIN_LENGTH = 150; // keeps the encrypted text inside the existing VARCHAR(255) column

function isSealed(stored) { return typeof stored === 'string' && stored.startsWith(PREFIX); }

function seal(secret, plain) {
  const p = plain === null || plain === undefined ? '' : String(plain);
  if (!p) return '';
  if (p.length > MAX_PLAIN_LENGTH) { const e = new Error(`The BMC password is too long (maximum ${MAX_PLAIN_LENGTH} characters)`); e.statusCode = 400; throw e; }
  return PREFIX + encryptSecret(secret, p);
}

// Returns the usable password. A sealed value that cannot be decrypted (database restored on a server with another JWT_SECRET)
// gives '' - the same behaviour as the other integration passwords: the credential has to be entered again.
function open(secret, stored) {
  if (stored === null || stored === undefined || stored === '') return '';
  if (!isSealed(stored)) return String(stored);
  return decryptSecret(secret, stored.slice(PREFIX.length));
}

// One-time / repeatable migration: encrypts every legacy plain password. Idempotent; rows already sealed are never touched.
async function sealLegacyPasswords(pool, secret, log) {
  const [rows] = await pool.query("SELECT id, redfish_password FROM assets WHERE redfish_password IS NOT NULL AND redfish_password <> '' AND redfish_password NOT LIKE 'enc:v1:%'");
  let sealed = 0, skipped = 0;
  for (const r of rows) {
    let v;
    try { v = seal(secret, r.redfish_password); } catch (e) { skipped++; continue; } // too long to fit: stays as it was, still works
    await pool.query('UPDATE assets SET redfish_password = ? WHERE id = ? AND redfish_password = ?', [v, r.id, r.redfish_password]);
    sealed++;
  }
  if (log && (sealed || skipped)) log.info(`[redfish] BMC passwords encrypted: ${sealed}${skipped ? `, ${skipped} left as before (too long)` : ''}`);
  return { sealed, skipped };
}

// Reverse of sealLegacyPasswords - for a planned rollback to a version that stores plain passwords (tools/redfish-password-tool.js).
async function unsealAll(pool, secret) {
  const [rows] = await pool.query("SELECT id, redfish_password FROM assets WHERE redfish_password LIKE 'enc:v1:%'");
  let unsealed = 0, failed = 0;
  for (const r of rows) {
    const plain = open(secret, r.redfish_password);
    if (!plain) { failed++; continue; }
    await pool.query('UPDATE assets SET redfish_password = ? WHERE id = ?', [plain, r.id]);
    unsealed++;
  }
  return { unsealed, failed };
}

module.exports = { PREFIX, MAX_PLAIN_LENGTH, isSealed, seal, open, sealLegacyPasswords, unsealAll };
