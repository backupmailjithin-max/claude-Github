#!/usr/bin/env node
'use strict';
// Simple step-by-step license generator for non-technical use - no flags to
// remember. Run it, answer the prompts, done. Produces the exact same
// signed .lic file / activation code as license-issue.js (same payload
// shape, same Ed25519 signing), just with a guided flow instead of CLI
// flags, and a native "Browse..." file picker on Windows.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

// One shared interface + its async line iterator for the whole session.
// rl.question() in a loop is unreliable once stdin is piped/batched (the
// stream's 'close' can fire before every question has been asked, silently
// dropping later answers) - pulling lines one at a time from the async
// iterator is the pattern Node's own docs recommend and works the same way
// whether a human is typing live or input is piped/redirected.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? '' : String(value || '').trim();
}

// Native Windows "Open File" dialog via a throwaway PowerShell process - no
// extra packages needed. Returns null (never throws) on any failure, or on
// non-Windows, so the caller always has a typed-path fallback.
function browseForFile(title) {
  if (process.platform !== 'win32') return null;
  try {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.OpenFileDialog',
      `$f.Title = "${title.replace(/"/g, "'")}"`,
      '$f.Filter = "Private Key Files (*.pem)|*.pem|All Files (*.*)|*.*"',
      'if ($f.ShowDialog() -eq "OK") { Write-Output $f.FileName }',
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' }).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('=================================================');
  console.log('  DCIM License Generator');
  console.log('=================================================\n');

  // Step 1: private key (browse dialog on Windows, typed path otherwise/fallback)
  console.log('Step 1 of 2: Select your license-private-key.pem file...');
  let keyPath = browseForFile('Select your license-private-key.pem file');
  if (keyPath) {
    console.log('Selected: ' + keyPath);
  } else {
    keyPath = await ask('Enter the full path to license-private-key.pem: ');
  }
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error('\nERROR: File not found: ' + keyPath);
    await ask('\nPress Enter to exit...');
    process.exit(1);
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    console.error('\nERROR: That file is not a valid private key (' + e.message + ')');
    await ask('\nPress Enter to exit...');
    process.exit(1);
  }
  console.log('Private key loaded OK.\n');

  // Step 2: customer + license details
  console.log('Step 2 of 2: Enter license details (press Enter to skip optional ones)\n');
  const customer = await ask('Customer / Site name (required): ');
  if (!customer) {
    console.error('\nERROR: Customer name is required.');
    await ask('\nPress Enter to exit...');
    process.exit(1);
  }
  const maxUsersRaw = await ask('Max users allowed [blank = unlimited]: ');
  const expiresRaw = await ask('Expiry date YYYY-MM-DD [blank = never expires]: ');
  const machineIdRaw = await ask('Customer Machine ID [blank = not locked to one machine]: ');

  if (maxUsersRaw && (!Number.isFinite(Number(maxUsersRaw)) || Number(maxUsersRaw) <= 0)) {
    console.error('\nERROR: Max users must be a positive number.');
    await ask('\nPress Enter to exit...');
    process.exit(1);
  }
  if (expiresRaw && Number.isNaN(new Date(expiresRaw).getTime())) {
    console.error('\nERROR: Expiry date is not valid - use YYYY-MM-DD.');
    await ask('\nPress Enter to exit...');
    process.exit(1);
  }

  const payload = {
    licenseId: 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    product: 'DCIM Dashboard',
    customer: String(customer),
    maxUsers: maxUsersRaw ? Number(maxUsersRaw) : null,
    // Accept the ID exactly as pasted (grouped with dashes, uppercase) or raw -
    // normalize to raw lowercase hex, same as license-issue.js.
    machineId: machineIdRaw ? String(machineIdRaw).toLowerCase().replace(/[^0-9a-f]/g, '') : null,
    issuedAt: new Date().toISOString(),
    expiresAt: expiresRaw ? new Date(expiresRaw).toISOString() : null,
  };

  const payloadJson = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(payloadJson), privateKey).toString('base64');
  const licenseFile = { alg: 'Ed25519', payloadJson, signature };

  const outDir = path.join(process.cwd(), 'generated-licenses');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = String(customer).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'customer';
  const outPath = path.join(outDir, `${slug}.lic`);
  fs.writeFileSync(outPath, JSON.stringify(licenseFile, null, 2));

  const code = Buffer.from(JSON.stringify(licenseFile)).toString('base64url');
  const codeGrouped = (code.match(/.{1,8}/g) || [code]).join('-');

  console.log('\n=================================================');
  console.log('  LICENSE GENERATED');
  console.log('=================================================');
  console.log('Customer      : ' + payload.customer);
  console.log('Max Users     : ' + (payload.maxUsers || 'Unlimited'));
  console.log('Expires       : ' + (payload.expiresAt || 'Never'));
  console.log('Machine Lock  : ' + (payload.machineId ? 'YES - ' + payload.machineId : 'No - works on any machine'));
  console.log('File saved to : ' + outPath);
  console.log('\nActivation code (give this to the customer, or send them the .lic file above):\n');
  console.log(codeGrouped);
  console.log('\n=================================================');
  await ask('\nPress Enter to exit...');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nUnexpected error: ' + e.message);
  process.exit(1);
});
