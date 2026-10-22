#!/usr/bin/env node
'use strict';
// OPTIONAL, build-time only: compiles lib/license.js and lib/integrity.js to V8 bytecode (.jsc) so a
// customer's package ships no readable source for those two files. This is a speed bump, not
// cryptographic protection - see docs/LICENSING-ANTI-CRACK-REVIEW-2026-10-22.md section 4 for the
// documented limits (same-length constant edits inside a .jsc are not caught by this step alone;
// combine with the vendor-signed integrity manifest, which DOES hash the .jsc output - see below).
//
// The compiled bytecode is tied to the EXACT Node/V8 build that compiles it, so this must run with
// the SAME node binary the package will ship and run with (never the build machine's own `node`
// unless that is also what gets shipped). Usage:
//   node bytenode-compile.js --webapp <dir> --node <path-to-target-node-binary>
//
// Effect per file (lib/license.js, lib/integrity.js):
//   lib/<name>.js   -> becomes a 2-line loader stub (require('./vendor/bytenode'); module.exports = require('./<name>.jsc'))
//   lib/<name>.jsc  -> the compiled bytecode (what actually runs)
// Nothing else changes: every other file still does require('./license') / require('./integrity')
// exactly as before, because the require PATH is unchanged - only what's behind it is.
// Idempotent: safe to run on an already-compiled tree (recompiles from the stub's own .jsc... no -
// it refuses, since the source is gone; run against a clean/checked-out tree only).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true; }
if (!args.webapp || !args.node) { console.error('usage: bytenode-compile.js --webapp <dir> --node <path-to-target-node-binary>'); process.exit(2); }
const root = path.resolve(args.webapp);
const targetNode = path.resolve(args.node);
if (!fs.existsSync(targetNode)) { console.error(`ERROR: target node binary not found: ${targetNode}`); process.exit(1); }
const FILES = ['license', 'integrity'];
const vendorDir = path.join(root, 'lib', 'vendor', 'bytenode');
if (!fs.existsSync(path.join(vendorDir, 'index.js'))) { console.error(`ERROR: ${vendorDir}/index.js missing (vendored bytenode loader) - nothing to run the .jsc with.`); process.exit(1); }

const ver = cp.execFileSync(targetNode, ['--version']).toString().trim();
console.log(`bytenode-compile: target node ${ver} (${targetNode})`);

for (const name of FILES) {
  const jsPath = path.join(root, 'lib', `${name}.js`);
  const jscPath = path.join(root, 'lib', `${name}.jsc`);
  const src = fs.readFileSync(jsPath, 'utf8');
  if (/^'use strict';require\('\.\/vendor\/bytenode'\)/.test(src)) { console.error(`ERROR: lib/${name}.js is already a compiled-loader stub - run against a clean checkout (the real source is gone from this tree).`); process.exit(1); }
  const tmpSrc = jsPath + '.compile-src.tmp';
  fs.copyFileSync(jsPath, tmpSrc);
  const compiler = `
    const { compileFile } = require(${JSON.stringify(path.join(vendorDir, 'index.js'))});
    compileFile({ filename: ${JSON.stringify(tmpSrc)}, output: ${JSON.stringify(jscPath)}, compileAsModule: true })
      .then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
  `;
  const res = cp.spawnSync(targetNode, ['-e', compiler], { encoding: 'utf8' });
  fs.unlinkSync(tmpSrc);
  if (res.status !== 0) { console.error(`ERROR: compiling lib/${name}.js failed:\n${res.stdout}${res.stderr}`); process.exit(1); }
  if (!fs.existsSync(jscPath)) { console.error(`ERROR: expected output ${jscPath} was not created.`); process.exit(1); }
  // Sanity: the target node (and only the target node) must be able to load what it just produced.
  const check = cp.spawnSync(targetNode, ['-e', `require(${JSON.stringify(path.join(vendorDir, 'index.js'))});require(${JSON.stringify(jscPath)})`], { encoding: 'utf8' });
  if (check.status !== 0) { console.error(`ERROR: self-check load of the freshly compiled ${name}.jsc failed:\n${check.stdout}${check.stderr}`); process.exit(1); }
  fs.writeFileSync(jsPath, `'use strict';require('./vendor/bytenode');module.exports = require('./${name}.jsc');\n`);
  console.log(`compiled: lib/${name}.js -> lib/${name}.jsc (${fs.statSync(jscPath).size} bytes); lib/${name}.js replaced with a loader stub.`);
}
console.log('bytenode-compile: done. Re-run make-integrity-manifest.js AFTER this step so the manifest covers the .jsc files and the new stubs.');
