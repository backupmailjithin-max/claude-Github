#!/usr/bin/env node
// Run this ONCE, by you, on a machine you control - never on a customer's
// machine and never as part of the installer. It creates the Ed25519
// keypair that tools/license-issue.js uses to sign license files.
//
// The PRIVATE key output file can mint valid licenses for your product -
// treat it like a password. Move it out of this repo immediately (a
// password manager or an offline encrypted drive is reasonable) and never
// commit it. The PUBLIC key is safe to share/commit - it can only verify
// signatures, never create them - and must be pasted into
// lib/license-public-key.js before you rebuild/ship the app, or every
// license file issued with the matching private key will fail to verify.
//
// Usage: node tools/license-keygen.js [output-directory]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const privatePath = path.join(outDir, 'license-private-key.pem');
const publicPath = path.join(outDir, 'license-public-key.pem');
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicPath, publicPem);

console.log('Keypair written:');
console.log('  private (keep secret, move off this machine/repo):', privatePath);
console.log('  public  (safe to share):', publicPath);
console.log('');
console.log('Next steps:');
console.log('1. Move', privatePath, 'somewhere safe, outside this repo. Back it up - if you');
console.log('   lose it, you can never issue another valid license for licenses already');
console.log('   issued with it (you would have to re-keygen and re-issue to everyone).');
console.log('2. Open dcim/webapp/lib/license-public-key.js and set LICENSE_PUBLIC_KEY_PEM');
console.log('   to the contents below, then rebuild/redeploy the app:');
console.log('');
console.log(publicPem);
