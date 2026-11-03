#!/usr/bin/env node
'use strict';
// DCIM pre-migration / post-migration health checker (P3.9).
// READ-ONLY: it never writes, restarts or changes anything. Safe to run on the live server.
//
//   node tools/migration-check.js                         (checks the app folder this file lives in)
//   node tools/migration-check.js --app /home/webapp --service webapp --nginx /etc/nginx/conf.d/mywebsite.conf
//   node tools/migration-check.js --json                  (machine readable)
//
// Exit code: 0 = all PASS, 1 = WARNING(s) only, 2 = at least one FAIL.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const http = require('http');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const APP = path.resolve(opt('app', path.join(__dirname, '..')));
const SERVICE = opt('service', '');
const NGINX = opt('nginx', '');
const JSON_OUT = args.includes('--json');
const results = [];
const add = (area, name, status, detail, fix) => results.push({ area, name, status, detail, ...(fix ? { fix } : {}) });
const run = (cmd, a, ms = 8000) => new Promise((resolve) => execFile(cmd, a, { timeout: ms }, (err, stdout, stderr) => resolve({ err, out: String(stdout || ''), errText: String(stderr || '') })));

function parseEnvFile(file) {
  const out = {}; let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  for (const line of text.split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) continue; let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); out[m[1]] = v; }
  return out;
}

(async () => {
  // ---- Folders ----
  if (!fs.existsSync(APP)) { add('Folders', 'App folder', 'FAIL', `${APP} does not exist`); return finish(); }
  add('Folders', 'App folder', 'PASS', APP);
  for (const f of ['server.js', 'index.html', 'app-compiled.js', 'package.json', 'schema.sql', 'lib', 'node_modules']) {
    add('Folders', f, fs.existsSync(path.join(APP, f)) ? 'PASS' : 'FAIL', fs.existsSync(path.join(APP, f)) ? 'present' : 'missing from the app folder');
  }
  for (const f of ['uploads', 'backups', 'logs']) {
    const p = path.join(APP, f);
    if (!fs.existsSync(p)) { add('Folders', f + '/', 'WARNING', 'not found (created on first start if the service can write here)'); continue; }
    try { const probe = path.join(p, `.chk-${process.pid}`); fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); add('Folders', f + '/', 'PASS', 'writable by the account running this check'); }
    catch (e) { add('Folders', f + '/', 'WARNING', `not writable by ${process.env.USER || 'this account'}: ${e.code}`); }
  }
  try { const nv = Number(process.versions.node.split('.')[0]); add('Folders', 'Node.js', nv >= 18 ? 'PASS' : 'FAIL', `v${process.versions.node}${nv >= 18 ? '' : ' (18 or newer required)'}`); } catch (e) { /* ignore */ }
  try { if (fs.statfsSync) { const s = fs.statfsSync(APP); const pct = Math.round((1 - s.bavail / s.blocks) * 100); const free = Math.round(s.bavail * s.bsize / 1e9); add('Folders', 'Disk space', pct >= 90 ? 'FAIL' : pct >= 80 ? 'WARNING' : 'PASS', `${pct}% used, ${free} GB free`); } } catch (e) { /* ignore */ }

  // ---- Permissions & service account ----
  let svcUser = '', svcEnv = {};
  if (SERVICE) {
    const r = await run('systemctl', ['show', SERVICE, '-p', 'User', '-p', 'WorkingDirectory', '-p', 'Environment', '-p', 'EnvironmentFiles', '-p', 'ActiveState']);
    if (r.err && !r.out) add('Permissions', 'systemd service', 'WARNING', `could not query "${SERVICE}" (${(r.err.code || r.err.message)})`);
    else {
      const kv = {}; r.out.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); });
      svcUser = kv.User || '';
      (kv.Environment || '').split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/).forEach((e) => { const i = e.indexOf('='); if (i > 0) svcEnv[e.slice(0, i)] = e.slice(i + 1).replace(/^"|"$/g, ''); });
      add('Permissions', 'systemd service', kv.ActiveState === 'active' ? 'PASS' : 'WARNING', `${SERVICE}: ${kv.ActiveState || 'unknown'}${svcUser ? ', runs as ' + svcUser : ''}`);
      if (kv.WorkingDirectory && path.resolve(kv.WorkingDirectory) !== APP) add('Permissions', 'Working directory', 'WARNING', `service WorkingDirectory is ${kv.WorkingDirectory}, checking ${APP}`);
    }
  }
  try {
    const st = fs.statSync(APP);
    if (svcUser && process.platform !== 'win32') {
      const r = await run('id', ['-u', svcUser]);
      if (!r.err && Number(r.out.trim()) !== st.uid) add('Permissions', 'Folder owner', 'FAIL', `${APP} is owned by uid ${st.uid}, but the service runs as ${svcUser} (uid ${r.out.trim()}). The service cannot create uploads/movements.`, `chown -R ${svcUser}: ${APP}`);
      else if (!r.err) add('Permissions', 'Folder owner', 'PASS', `owned by the service account (${svcUser})`);
    } else add('Permissions', 'Folder owner', 'PASS', `uid ${st.uid} (no service account given - use --service to compare)`);
  } catch (e) { /* ignore */ }

  // ---- Config (.env) + JWT ----
  const envPath = path.join(APP, '.env');
  const env = parseEnvFile(envPath);
  if (!env) add('Config', '.env file', 'WARNING', 'no .env next to the app (fine if everything is set in the service definition)');
  else {
    add('Config', '.env file', 'PASS', `${Object.keys(env).length} setting(s) read`);
    try { const mode = fs.statSync(envPath).mode & 0o777; if (process.platform !== 'win32') add('Permissions', '.env permissions', (mode & 0o077) ? 'WARNING' : 'PASS', (mode & 0o077) ? `mode ${mode.toString(8)} - other users can read the passwords` : `restricted (mode ${mode.toString(8)})`, (mode & 0o077) ? `chmod 600 ${envPath}` : undefined); } catch (e) { /* ignore */ }
  }
  const all = { ...(env || {}), ...svcEnv };
  const jwt = all.JWT_SECRET || process.env.JWT_SECRET || '';
  if (!jwt) add('JWT Secret', 'JWT_SECRET', (all.NODE_ENV || 'production') === 'production' ? 'FAIL' : 'WARNING', 'not found in .env or the service definition - the server refuses to start in production without it', 'set JWT_SECRET (48+ random characters) in the service drop-in');
  else if (jwt.length < 32) add('JWT Secret', 'JWT_SECRET', 'WARNING', `only ${jwt.length} characters`); else add('JWT Secret', 'JWT_SECRET', 'PASS', `set (${jwt.length} characters)`);
  for (const k of ['DB_HOST', 'DB_USER', 'DB_NAME']) add('Config', k, all[k] ? 'PASS' : 'WARNING', all[k] ? (k === 'DB_USER' || k === 'DB_HOST' || k === 'DB_NAME' ? all[k] : 'set') : 'not set (default will be used)');
  const port = Number(all.PORT) || 3001;
  add('Config', 'PORT', 'PASS', String(port));
  add('Config', 'TLS verification', all.ENABLE_STRICT_TLS && /^(1|true|yes|on)$/i.test(all.ENABLE_STRICT_TLS) ? 'PASS' : 'WARNING', all.ENABLE_STRICT_TLS && /^(1|true|yes|on)$/i.test(all.ENABLE_STRICT_TLS) ? 'strict TLS enabled' : 'relaxed (current default) - optional hardening available');
  if (all.INTERNAL_CA_FILE) add('Config', 'INTERNAL_CA_FILE', fs.existsSync(all.INTERNAL_CA_FILE) ? 'PASS' : 'FAIL', all.INTERNAL_CA_FILE + (fs.existsSync(all.INTERNAL_CA_FILE) ? '' : ' not found'));

  // ---- DNS ----
  const hosts = new Set();
  for (const [k, v] of Object.entries(all)) if (/^(OME|ONEVIEW)_.+_HOST$/.test(k) && v) { try { hosts.add(new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname); } catch (e) { /* ignore */ } }
  if (all.SMTP_HOST) hosts.add(all.SMTP_HOST);
  if (!hosts.size) add('DNS', 'Appliance hosts', 'WARNING', 'no OME / OneView hosts found in .env (they may be saved in the database instead)');
  for (const h of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) { add('DNS', h, 'PASS', 'IP address (no lookup needed)'); continue; }
    try { const a = await dns.lookup(h); add('DNS', h, 'PASS', `resolves to ${a.address}`); } catch (e) { add('DNS', h, 'FAIL', `does not resolve (${e.code})`); }
  }

  // ---- SMTP / OME / OneView reachability (TCP connect only - nothing is sent or signed in) ----
  const net = require('net');
  const tcp = (host, prt) => new Promise((resolve) => { const sk = net.connect({ host, port: prt, timeout: 4000 }, () => { sk.destroy(); resolve(''); }); sk.on('error', (e) => resolve(e.code || e.message)); sk.on('timeout', () => { sk.destroy(); resolve('timeout'); }); });
  const targets = [];
  for (const [k, v] of Object.entries(all)) { const mm = /^(OME|ONEVIEW)_.+_HOST$/.exec(k); if (mm && v) { try { const u = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`); targets.push([mm[1] === 'OME' ? 'OME' : 'OneView', u.hostname, Number(u.port) || 443]); } catch (e) { /* ignore */ } } }
  if (all.SMTP_HOST) targets.push(['SMTP', all.SMTP_HOST, Number(all.SMTP_PORT) || 25]);
  if (!targets.length) add('SMTP', 'SMTP / OME / OneView', 'WARNING', 'none found in .env (they may be saved in the database - the app health page checks those)');
  for (const [lab, host, prt] of targets) { const er = await tcp(host, prt); add(lab, `${host}:${prt}`, er ? 'FAIL' : 'PASS', er ? `cannot connect (${er})` : 'port reachable'); }

  // ---- Nginx ----
  if (NGINX) {
    let txt = ''; try { txt = fs.readFileSync(NGINX, 'utf8'); } catch (e) { add('Nginx', 'config file', 'FAIL', `${NGINX} cannot be read (${e.code})`); }
    if (txt) {
      add('Nginx', 'config file', 'PASS', NGINX);
      const t = await run('nginx', ['-t']);
      if (t.err && t.err.code === 'ENOENT') add('Nginx', 'nginx -t', 'WARNING', 'the nginx command was not found for this account (run as root, or test with: nginx -t)');
      else if (t.err && /Permission denied|permission/i.test(t.errText)) add('Nginx', 'nginx -t', 'WARNING', 'needs root to test the configuration - run this check with sudo, or run: nginx -t');
      else add('Nginx', 'nginx -t', t.err ? 'FAIL' : 'PASS', t.err ? (t.errText.split('\n').find((l) => /emerg|error/i.test(l)) || t.err.message) : 'syntax ok');
      const pp = /proxy_pass\s+https?:\/\/[^:;\s]+:(\d+)/.exec(txt);
      if (pp) add('Proxy', 'proxy_pass port', Number(pp[1]) === port ? 'PASS' : 'FAIL', `nginx forwards to ${pp[1]}, the app listens on ${port}`);
      else add('Proxy', 'proxy_pass', 'WARNING', 'no proxy_pass found in this file');
      const loc = /location\s+~\s+\^\/\(([^)]*)\)/.exec(txt);
      if (loc) { const parts = loc[1].split('|'); add('Nginx', 'proxied paths', ['api', 'uploads'].every((p) => parts.includes(p)) ? (parts.includes('branding') ? 'PASS' : 'WARNING') : 'FAIL', `proxies: ${parts.join(', ')}${parts.includes('branding') ? '' : ' - "branding" is missing, the logo will not load'}`, parts.includes('branding') ? undefined : 'add |branding to the location regex, then nginx -t and reload'); }
    }
  } else add('Nginx', 'config', 'WARNING', 'not checked (pass --nginx /etc/nginx/conf.d/<file>.conf)');

  // ---- Proxy / app answering ----
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 4000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { const j = JSON.parse(b); add('Proxy', 'App health', j.status === 'ok' ? 'PASS' : 'WARNING', `port ${port}: ${j.status}, database ${j.database}, version ${j.version}`); } catch (e) { add('Proxy', 'App health', 'WARNING', `port ${port} answered HTTP ${res.statusCode}`); } resolve(); }); });
    req.on('error', () => { add('Proxy', 'App health', 'WARNING', `nothing is answering on port ${port} (expected before the new version is started)`); resolve(); });
    req.on('timeout', () => { req.destroy(); });
  });

  // ---- Database ----
  try {
    let mysql; try { mysql = require(path.join(APP, 'node_modules', 'mysql2', 'promise')); } catch (e) { mysql = require('mysql2/promise'); }
    const conn = await mysql.createConnection({ host: all.DB_HOST || '127.0.0.1', port: Number(all.DB_PORT) || 3306, user: all.DB_USER || 'root', password: all.DB_PASSWORD || '', database: all.DB_NAME || undefined, connectTimeout: 5000 });
    const [[v]] = await conn.query('SELECT VERSION() v'); add('Database', 'connection', 'PASS', `connected, server ${v.v}`);
    const [t] = await conn.query('SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema = DATABASE()'); add('Database', 'tables', t[0].c > 10 ? 'PASS' : 'WARNING', `${t[0].c} table(s) in ${all.DB_NAME || '(default)'}`);
    try { const [[a]] = await conn.query('SELECT COUNT(*) c FROM assets'); add('Database', 'assets', 'PASS', `${a.c} asset(s)`); } catch (e) { add('Database', 'assets', 'WARNING', 'assets table not found (fresh database)'); }
    await conn.end();
  } catch (e) { add('Database', 'connection', 'FAIL', `${e.code || ''} ${e.message}`.trim(), 'check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME and that MySQL/MariaDB is running'); }

  finish();
})().catch((e) => { add('Checker', 'unexpected error', 'FAIL', e.message); finish(); });

function finish() {
  const overall = results.some((r) => r.status === 'FAIL') ? 'FAIL' : results.some((r) => r.status === 'WARNING') ? 'WARNING' : 'PASS';
  if (JSON_OUT) console.log(JSON.stringify({ overall, app: APP, checkedAt: new Date().toISOString(), results }, null, 2));
  else {
    const icon = { PASS: 'PASS   ', WARNING: 'WARNING', FAIL: 'FAIL   ' }; let area = '';
    const order = [...new Set(results.map((r) => r.area))]; results.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area));
    console.log(`\nDCIM migration check - ${APP}\n`);
    for (const r of results) { if (r.area !== area) { area = r.area; console.log(`\n[${area}]`); } console.log(`  ${icon[r.status]}  ${r.name}: ${r.detail}`); if (r.fix && r.status !== 'PASS') console.log(`           fix: ${r.fix}`); }
    const n = (s) => results.filter((r) => r.status === s).length;
    console.log(`\nResult: ${overall}   (${n('PASS')} pass, ${n('WARNING')} warning, ${n('FAIL')} fail)\n`);
  }
  process.exit(overall === 'FAIL' ? 2 : overall === 'WARNING' ? 1 : 0);
}
