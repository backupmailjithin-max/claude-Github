#!/usr/bin/env node
'use strict';
// Build gate: FAILS (exit 1) when a package tree contains vendor licence tooling, signing material or a private key.
//   node validate-package.js --root <dir> [--iss <file.iss> ...] [--require-manifest]
// --root         the tree that will be packaged (the webapp dir, or a whole payload dir).
// --iss          an Inno Setup script: its "Excludes:" list is applied to --root first, so a source tree that the
//                installer filters (Windows) is validated as the installer will ship it.
// --require-manifest  the signed integrity manifest must exist, verify and match the files.
// --require-vendor    (with --require-manifest) the manifest must be signed with the pinned VENDOR integrity key.
// Third-party runtime bundles (runtime/) are checked by file name only: they contain upstream test fixtures
// (e.g. MariaDB's mariadb-test certificates) that are not our key material and are not content-scanned.
const fs = require('fs');
const path = require('path');
const args = { iss: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  if (k === 'iss') args.iss.push(v); else args[k] = v;
}
if (!args.root) { console.error('usage: validate-package.js --root <dir> [--iss f.iss] [--require-manifest] [--require-vendor]'); process.exit(2); }
const root = path.resolve(args.root);

const FORBIDDEN_NAMES = [
  [/^license-(keygen|issue|generator|fingerprint)/i, 'vendor licence tool'],
  [/^Run-License-Generator/i, 'vendor licence tool'],
  [/^LICENSE-ISSUE-TEMPLATE/i, 'vendor licence template'],
  [/^license\.lic$/i, 'an installed licence'],
  [/^\.trial-state$/, 'per-install trial state'],
  [/^\.license-clock$/, 'per-install clock state'],
  [/^\.env$/, 'environment secrets'],
  [/(^|[-_.])(private|signing)[-_.]?(key)?\.(pem|key|der|p8|p12|pfx)$/i, 'private/signing key file'],
  [/^id_(rsa|dsa|ecdsa|ed25519)$/, 'ssh private key'],
  [/\.(p12|pfx|jks|keystore)$/i, 'key store'],
];
const KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
// A real key has a long base64 body after the header; documentation that merely shows the BEGIN/END lines
// (e.g. dotenv's README) has none. Body = text up to the END line (max 8 KB), minus whitespace / literal "\n" / "...".
function hasPrivateKey(text) {
  let m; KEY_BEGIN.lastIndex = 0;
  while ((m = KEY_BEGIN.exec(text))) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 8192);
    const end = rest.indexOf('-----END');
    const body = (end >= 0 ? rest.slice(0, end) : rest).replace(/\\n/g, '').replace(/\.{2,}/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
    if (body.length >= 60) return true;
  }
  return false;
}
const THIRD_PARTY = new Set(['runtime']);

// ---- Inno Setup "Excludes:" (comma separated; patterns with a backslash are relative to the source root, others match any name)
function globToRe(g) { return new RegExp('^' + g.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]') + '$', 'i'); }
function issExcludes(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = t.match(/Source:\s*"\.\.\\\.\.\\dcim\\webapp\\\*"[^\r\n]*?Excludes:\s*"([^"]*)"/);
  if (!m) throw new Error(`no webapp Source line with Excludes in ${file}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((p) => ({ rel: p.includes('\\'), re: globToRe(p.replace(/\\/g, '/').replace(/\//g, p.includes('\\') ? '\\\\' : '/')), raw: p }));
}
function excludedBy(rules, relPosix, name) {
  const relWin = relPosix.replace(/\//g, '\\');
  return rules.some((r) => (r.rel ? r.re.test(relWin) : r.re.test(name)));
}

const problems = [];
const info = [];
let scanned = 0, contentScanned = 0;
function walk(dir, rel, rules, thirdParty) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const d of ents) {
    const relp = rel ? rel + '/' + d.name : d.name;
    if (rules && excludedBy(rules, relp, d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { walk(full, relp, rules, thirdParty || (!rel && THIRD_PARTY.has(d.name))); continue; }
    if (!d.isFile()) continue;
    scanned++;
    for (const [re, why] of FORBIDDEN_NAMES) if (re.test(d.name)) { problems.push(`${relp}: ${why}`); break; }
    if (thirdParty) continue;
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    let buf; try { buf = fs.readFileSync(full); } catch (e) { continue; }
    if (buf.includes(0)) continue;   // binary
    contentScanned++;
    if (hasPrivateKey(buf.toString('latin1'))) problems.push(`${relp}: contains a PRIVATE KEY block`);
  }
}

if (args.iss.length) {
  for (const f of args.iss) {
    const rules = issExcludes(path.resolve(f));
    const before = problems.length;
    walk(root, '', rules, false);
    info.push(`${path.basename(f)}: ${rules.length} exclude rules applied`);
    if (problems.length > before) problems.push(`^ as shipped by ${path.basename(f)}`);
  }
} else {
  walk(root, '', null, false);
}

if (args['require-manifest']) {
  const wa = fs.existsSync(path.join(root, 'lib', 'integrity.js')) ? root : path.join(root, 'webapp');
  try {
    const integ = require(path.join(wa, 'lib', 'integrity.js'));
    const mp = path.join(wa, integ.MANIFEST_NAME);
    if (!fs.existsSync(mp)) problems.push(`${integ.MANIFEST_NAME}: missing (run make-integrity-manifest.js)`);
    else {
      const raw = fs.readFileSync(mp, 'utf8');
      if (/private/i.test(Object.keys(JSON.parse(raw)).join(' '))) problems.push(`${integ.MANIFEST_NAME}: contains a private-key field`);
      let peer; try { const m = /INTEGRITY_PIN_FPR = (null|'([0-9a-f]{64})')/.exec(fs.readFileSync(path.join(wa, 'lib', 'license.js'), 'utf8')); peer = m ? (m[2] || null) : undefined; } catch (e) { peer = undefined; }
      const r = integ.checkIntegrity(wa, { peerPinFpr: peer });
      if (r.trustRootMismatch) problems.push('integrity trust root inconsistent (lib/integrity-public-key.js, lib/integrity.js and lib/license.js must carry the same vendor key)');
      if (args['require-vendor'] && r.signer !== 'vendor') problems.push('release build requires a VENDOR-signed manifest (pin the key with integrity-keygen.js --install and sign with --sign-key / DCIM_INTEGRITY_SIGN_KEY_FILE)');
      if (r.state !== 'ok') problems.push(`${integ.MANIFEST_NAME}: integrity state "${r.state}" (${[...r.modified, ...r.missing].join(', ') || 'signature/key mismatch'})`);
      else info.push(`manifest ${r.keyId} (${r.signer}-signed) verified, ${integ.PROTECTED_FILES.length} files match`);
    }
  } catch (e) { problems.push(`manifest check failed: ${e.message}`); }
}

console.log(`validate-package: ${root} - ${scanned} files checked, ${contentScanned} content-scanned. ${info.join('; ')}`);
if (problems.length) {
  console.error('PACKAGE VALIDATION FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('validate-package: OK (no licence tools, signing material or private keys).');
