#!/usr/bin/env node
// Support tool for the encrypted Redfish BMC passwords.
//   node lib/redfish-password-tool.js status    shows how many BMC passwords are stored encrypted / as plain text (changes nothing)
//   node lib/redfish-password-tool.js unseal    writes the passwords back as plain text - ONLY before going back to a version
//                                                  that stores plain passwords (any build before the 2026-11-24 remediation update) (needs the same JWT_SECRET)
// Reads DB_HOST / DB_USER / DB_PASSWORD / DB_NAME / JWT_SECRET from the .env next to the application, like the application itself.
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) { /* dotenv not available: use the environment */ }
const mysql = require('mysql2/promise');
const secretBox = require('./redfish-secret');

(async () => {
  const cmd = process.argv[2] || 'status';
  if (!['status', 'unseal'].includes(cmd)) { console.error('Usage: redfish-password-tool.js status|unseal'); process.exit(2); }
  const jwt = process.env.JWT_SECRET || 'dc-dashboard-secret-key-change-in-production';
  const pool = mysql.createPool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  try {
    const [[c]] = await pool.query("SELECT SUM(redfish_password LIKE 'enc:v1:%') AS encrypted, SUM(redfish_password IS NOT NULL AND redfish_password <> '' AND redfish_password NOT LIKE 'enc:v1:%') AS plain FROM assets");
    console.log(`Encrypted: ${Number(c.encrypted) || 0}   Plain text: ${Number(c.plain) || 0}`);
    if (cmd === 'unseal') {
      const r = await secretBox.unsealAll(pool, jwt);
      console.log(`Written back as plain text: ${r.unsealed}   Could not be decrypted (JWT_SECRET differs): ${r.failed}`);
      if (r.failed) console.log('Those assets need their BMC credentials entered again after the rollback.');
    }
  } finally { await pool.end(); }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
