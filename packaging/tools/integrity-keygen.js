#!/usr/bin/env node
'use strict';
// VENDOR-SIDE, run once on the vendor's own machine (never in CI, never on a customer machine).
//   node integrity-keygen.js --out <private-key-file> [--install [<webapp dir>]]
// Creates the vendor INTEGRITY keypair (not the licence key). The private key is written to <private-key-file> (mode 600);
// it must live OUTSIDE the repository and outside every package tree - the build gate fails if it is found in one.
// --install pins the public key: it writes lib/integrity-public-key.js and the key fingerprint into lib/integrity.js and
// lib/license.js. Commit those three files; keep the private key offline/backed up (losing it means a new key + a new release).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true; }
if (!args.out) { console.error('usage: integrity-keygen.js --out <private-key-file> [--install [<webapp dir>]]'); process.exit(2); }
const out = path.resolve(args.out);
const webapp = path.resolve(typeof args.install === 'string' ? args.install : path.join(__dirname, '..', '..', 'dcim', 'webapp'));
const inside = (child, parent) => { const r = path.relative(parent, child); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const repoRoot = path.resolve(__dirname, '..', '..');
if (inside(out, repoRoot) || inside(out, webapp)) { console.error('ERROR: the private key file must be outside the repository / webapp folder.'); process.exit(1); }
if (fs.existsSync(out)) { console.error(`ERROR: ${out} already exists - refusing to overwrite a signing key.`); process.exit(1); }
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const fpr = crypto.createHash('sha256').update(pubPem).digest('hex');
console.log(`private integrity key written (mode 600): ${out}`);
console.log(`public key id: ${fpr.slice(0, 12)}`);
if (args.install) {
  const keyFile = path.join(webapp, 'lib', 'integrity-public-key.js');
  fs.writeFileSync(keyFile, `'use strict';\n// Vendor INTEGRITY public key (verify-only). The matching private key signs integrity.manifest.json at package-build\n// time and never leaves the vendor; it is not the licence key and not shipped.\nmodule.exports = {\n  INTEGRITY_PUBLIC_KEY_PEM: \`${pubPem}\`,\n};\n`);
  for (const [rel, tag] of [['lib/integrity.js', 'PIN_FPR = null; // @INTEGRITY_PIN_FPR@'], ['lib/license.js', 'INTEGRITY_PIN_FPR = null; // @LICENSE_PIN_FPR@']]) {
    const f = path.join(webapp, rel); let s = fs.readFileSync(f, 'utf8');
    const re = /(PIN_FPR = )(null|'[0-9a-f]{64}')(; \/\/ @(INTEGRITY_PIN_FPR|LICENSE_PIN_FPR)@)/;
    if (!re.test(s)) { console.error(`ERROR: pin marker not found in ${rel}`); process.exit(1); }
    s = s.replace(re, `$1'${fpr}'$3`); fs.writeFileSync(f, s);
  }
  console.log(`pinned in: lib/integrity-public-key.js, lib/integrity.js, lib/license.js (${webapp})`);
}
