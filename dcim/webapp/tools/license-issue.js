#!/usr/bin/env node
// Run this by you (the license issuer), using the private key from
// tools/license-keygen.js, once per customer, to mint their signed license
// file. Never run this on a customer's machine - it needs your private key.
//
// Usage:
//   node tools/license-issue.js \
//     --private-key /path/to/license-private-key.pem \
//     --customer "Acme Corp" \
//     --max-users 25 \
//     --expires 2027-10-17 \
//     [--machine-id ABCD1234...]      (from the customer's Settings -> License page,
//                                      or `node tools/license-fingerprint.js` run on
//                                      their machine; omit for a non-machine-bound
//                                      license, e.g. for evaluation copies)
//     [--out acme-corp.lic]            (default: <customer-slug>.lic)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function usageError(msg) {
  console.error('Error:', msg);
  console.error('');
  console.error('Usage: node tools/license-issue.js --private-key <path> --customer "<name>" [--max-users N] [--expires YYYY-MM-DD] [--machine-id <id>] [--out <file>.lic]');
  process.exit(1);
}

if (!args['private-key']) usageError('--private-key is required (from tools/license-keygen.js).');
if (!args.customer) usageError('--customer "<name>" is required.');

let privateKey;
try {
  privateKey = crypto.createPrivateKey(fs.readFileSync(args['private-key'], 'utf8'));
} catch (e) {
  usageError(`could not read/parse private key at ${args['private-key']}: ${e.message}`);
}

const payload = {
  licenseId: 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
  product: 'DCIM Dashboard',
  customer: String(args.customer),
  maxUsers: args['max-users'] ? Number(args['max-users']) : null,
  // Accept the machine ID exactly as shown/copied from the app (grouped with
  // dashes, uppercase) or the raw form - normalize to raw lowercase hex so it
  // matches what computeMachineFingerprint() produces at verify time either way.
  machineId: args['machine-id'] ? String(args['machine-id']).toLowerCase().replace(/[^0-9a-f]/g, '') : null,
  issuedAt: new Date().toISOString(),
  expiresAt: args.expires ? new Date(args.expires).toISOString() : null,
};

if (payload.expiresAt && Number.isNaN(new Date(payload.expiresAt).getTime())) usageError('--expires is not a valid date (use YYYY-MM-DD).');
if (payload.maxUsers !== null && (!Number.isFinite(payload.maxUsers) || payload.maxUsers <= 0)) usageError('--max-users must be a positive number.');

const payloadJson = JSON.stringify(payload);
const signature = crypto.sign(null, Buffer.from(payloadJson), privateKey).toString('base64');
const licenseFile = { alg: 'Ed25519', payloadJson, signature };

const outPath = args.out || `${String(args.customer).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'customer'}.lic`;
fs.writeFileSync(outPath, JSON.stringify(licenseFile, null, 2));

console.log('License issued:', outPath);
console.log(payload);
if (!payload.machineId) console.log('\nNote: this license is NOT bound to a specific machine (no --machine-id given) - it will validate on any machine. Only use this for evaluation copies or if you are intentionally not machine-locking this customer.');
if (!payload.expiresAt) console.log('Note: this license never expires (no --expires given).');
