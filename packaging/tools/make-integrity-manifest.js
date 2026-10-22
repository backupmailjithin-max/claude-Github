#!/usr/bin/env node
'use strict';
// Build-time: writes <webapp>/integrity.manifest.json - SHA-256 of the licensing code.
//  * vendor key pinned in lib/integrity-public-key.js (production): signed with the VENDOR integrity private key, read from
//    --sign-key <file> or $DCIM_INTEGRITY_SIGN_KEY_FILE. The file must be outside the package tree; the key is only held in
//    memory and the manifest carries no key at all (the app verifies with the pinned public key only).
//  * no key pinned (development): self-signed with a throw-away key (tamper evidence only, as before).
// Run it AFTER the package tree is final (vendor tools stripped).
//   node make-integrity-manifest.js --webapp <dir> [--version X.Y.Z] [--sign-key <file>]
const fs = require('fs');
const path = require('path');
const args = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true; }
if (!args.webapp) { console.error('usage: make-integrity-manifest.js --webapp <dir> [--version X]'); process.exit(2); }
const root = path.resolve(args.webapp);
const { buildManifest, MANIFEST_NAME, PROTECTED_FILES } = require(path.join(root, 'lib', 'integrity.js'));
for (const f of PROTECTED_FILES) if (!fs.existsSync(path.join(root, f))) { console.error(`ERROR: ${f} is missing from ${root}`); process.exit(1); }
let version = args.version;
if (!version) { try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch (e) { version = null; } }
const keyFile = args['sign-key'] || process.env.DCIM_INTEGRITY_SIGN_KEY_FILE;
let signKeyPem = null;
if (keyFile) {
  const kp = path.resolve(String(keyFile));
  const rel = path.relative(root, kp);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { console.error('ERROR: the signing key file is inside the package tree - move it outside.'); process.exit(1); }
  try { signKeyPem = fs.readFileSync(kp, 'utf8'); } catch (e) { console.error(`ERROR: cannot read the signing key file: ${e.message}`); process.exit(1); }
}
let m;
try { m = buildManifest(root, { version, signKeyPem }); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(m, null, 2));
console.log(`integrity manifest written: ${path.join(root, MANIFEST_NAME)} (${PROTECTED_FILES.length} files, build ${version || 'n/a'}, ${signKeyPem ? 'vendor-signed' : 'self-signed (no vendor key pinned)'})`);
