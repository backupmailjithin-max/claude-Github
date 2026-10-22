#!/usr/bin/env node
'use strict';
// Build-time: writes <webapp>/integrity.manifest.json - SHA-256 of the licensing code, signed with a
// throw-away Ed25519 key that exists only in this process's memory (no signing material is written to disk,
// so there is nothing to leak into a package). Run it AFTER the package tree is final (vendor tools stripped).
//   node make-integrity-manifest.js --webapp <dir> [--version X.Y.Z]
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
const m = buildManifest(root, { version });
fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(m, null, 2));
console.log(`integrity manifest written: ${path.join(root, MANIFEST_NAME)} (${PROTECTED_FILES.length} files, build ${version || 'n/a'})`);
