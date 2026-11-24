'use strict';
// Integration tests for the 2026-11-24 remediation (asset serial / delete links, report e-mail, BMC password storage,
// visitor documents in backups, Redfish job access, branding uploads, site security).
// They talk to a RUNNING copy of the application and its database, so they are not part of `npm test`.
//
//   DCIM_IT_URL=http://127.0.0.1:18501  DCIM_IT_ADMIN_USER=admin DCIM_IT_ADMIN_PASS=...  \
//   DCIM_IT_DB_HOST=127.0.0.1 DCIM_IT_DB_USER=... DCIM_IT_DB_PASS=... DCIM_IT_DB_NAME=...  \
//   DCIM_IT_APPDIR=/path/to/webapp   (folder of the running copy - used to look at uploads/ and backups/)
//   optional: DCIM_IT_OPA_USER/PASS (Operator of the first site), DCIM_IT_OPB_USER/PASS (Operator of another site)
//   node --test tests/integration/remediation.itest.js
//
// ONLY run this against a scratch copy: it creates and deletes assets, turns Visitor Access on and uploads a logo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const mysql = require('mysql2/promise');

const E = process.env;
const BASE = (E.DCIM_IT_URL || '').replace(/\/$/, '');
const SKIP = BASE ? false : 'set DCIM_IT_URL (and the other DCIM_IT_* variables) to run the integration tests against a scratch copy';
const tag = 'IT' + Date.now().toString(36).toUpperCase();

let db, admin, opA, opB, site, site2;
async function call(token, method, url, body) {
  const r = await fetch(BASE + '/api' + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) { /* not json */ }
  return { status: r.status, body: json };
}
async function login(u, p) { const r = await call(null, 'POST', '/auth/login', { username: u, password: p }); assert.strictEqual(r.status, 200, `login ${u}: ${JSON.stringify(r.body)}`); return r.body.token; }
const assetBody = (o = {}) => ({ site, zone: 'AZ-1', rackType: 'Compute', rackNo: 'R-' + tag, position: '', hardwareType: 'Dell Server', height: '1U', manufacturer: 'Dell', model: 'PowerEdge R650', ...o });
const one = async (sql, p) => (await db.query(sql, p))[0];

test.before(async () => {
  if (SKIP) return;
  db = await mysql.createConnection({ host: E.DCIM_IT_DB_HOST || '127.0.0.1', user: E.DCIM_IT_DB_USER, password: E.DCIM_IT_DB_PASS, database: E.DCIM_IT_DB_NAME });
  admin = await login(E.DCIM_IT_ADMIN_USER || 'admin', E.DCIM_IT_ADMIN_PASS);
  if (E.DCIM_IT_OPA_USER) opA = await login(E.DCIM_IT_OPA_USER, E.DCIM_IT_OPA_PASS);
  if (E.DCIM_IT_OPB_USER) opB = await login(E.DCIM_IT_OPB_USER, E.DCIM_IT_OPB_PASS);
  const sites = (await one('SELECT name FROM locations ORDER BY name')).map((r) => r.name);
  site = E.DCIM_IT_SITE || sites[0]; site2 = sites.find((s) => s !== site);
});
test.after(async () => { if (db) await db.end(); });

// ------------------------------------------------------------------ H1: serial correction ----------------------------------------------------------------
test('H1 asset create -> connectivity + hardware details + issue -> serial change keeps all of them', { skip: SKIP }, async () => {
  const oldS = `${tag}-OLD`, newS = `${tag}-NEW`;
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: oldS, assetTag: `${tag}-T1`, deviceName: 'it-h1' }));
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const id = c.body.id;
  const conn = await call(admin, 'PUT', `/assets/${id}/connectivity`, { iloIp: '10.250.0.1', dataCable: 'SW9 P9', category: 'Server' });
  assert.strictEqual(conn.status, 200, JSON.stringify(conn.body));
  await db.query('INSERT INTO asset_hw_details (serial_number, vendor, site, zone, data, fetched_by) VALUES (?,?,?,?,?,?)', [oldS, 'dell', site, 'AZ-1', '{"cpu":2}', 'it']);
  const iss = await call(admin, 'POST', '/issues', { site, title: 'it issue ' + tag, assetId: oldS, severity: 'warning' });
  assert.strictEqual(iss.status, 200, JSON.stringify(iss.body));

  // an unrelated edit must not disturb anything
  const e1 = await call(admin, 'PATCH', `/assets/${id}`, { ...c.body, remarks: 'edited' });
  assert.strictEqual(e1.status, 200);
  assert.strictEqual((await one('SELECT COUNT(*) n FROM asset_connectivity WHERE serial_number = ?', [oldS]))[0].n, 1);

  // the serial correction
  const e2 = await call(admin, 'PATCH', `/assets/${id}`, { ...c.body, serialNumber: newS });
  assert.strictEqual(e2.status, 200, JSON.stringify(e2.body));
  const g = await call(admin, 'GET', `/assets/${id}/connectivity`);
  assert.ok(g.body.connectivity, 'connectivity must still be shown after the serial correction');
  assert.strictEqual(g.body.connectivity.iloIp, '10.250.0.1');
  for (const t of ['asset_connectivity', 'asset_hw_details']) {
    assert.strictEqual((await one(`SELECT COUNT(*) n FROM ${t} WHERE serial_number = ?`, [oldS]))[0].n, 0, `${t}: nothing may stay under the old serial`);
    assert.strictEqual((await one(`SELECT COUNT(*) n FROM ${t} WHERE serial_number = ?`, [newS]))[0].n, 1, `${t}: exactly one row under the new serial`);
  }
  assert.strictEqual((await one('SELECT COUNT(*) n FROM issues WHERE asset_id = ?', [newS]))[0].n, 1, 'issue follows the serial');
  assert.strictEqual((await one('SELECT COUNT(*) n FROM issues WHERE asset_id = ?', [oldS]))[0].n, 0);
  const hw = await call(admin, 'GET', `/assets/${id}/hardware`);
  if (hw.status === 200 && hw.body && hw.body.hardware !== undefined) assert.ok(hw.body.hardware, 'hardware details still shown');
});

test('H1 a stale row under the new serial never produces a duplicate; asset keeps its own data', { skip: SKIP }, async () => {
  const oldS = `${tag}-S1`, newS = `${tag}-S2`;
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: oldS, assetTag: `${tag}-T2` }));
  await call(admin, 'PUT', `/assets/${c.body.id}/connectivity`, { iloIp: '10.250.0.2', category: 'mine' });
  await db.query('INSERT INTO asset_connectivity (serial_number, site, zone, category) VALUES (?,?,?,?)', [newS, site, 'AZ-1', 'stale']);
  const e = await call(admin, 'PATCH', `/assets/${c.body.id}`, { ...c.body, serialNumber: newS });
  assert.strictEqual(e.status, 200);
  const rows = await one('SELECT category FROM asset_connectivity WHERE serial_number IN (?, ?)', [oldS, newS]);
  assert.deepStrictEqual(rows.map((r) => r.category), ['mine']);
});

test('H1 serial that belongs to another asset is still refused and nothing moves', { skip: SKIP }, async () => {
  const a = await call(admin, 'POST', '/assets', assetBody({ serialNumber: `${tag}-D1`, assetTag: `${tag}-T3`, rackNo: 'R-' + tag + 'D' }));
  const b = await call(admin, 'POST', '/assets', assetBody({ serialNumber: `${tag}-D2`, assetTag: `${tag}-T4`, rackNo: 'R-' + tag + 'D' }));
  await call(admin, 'PUT', `/assets/${a.body.id}/connectivity`, { iloIp: '10.250.0.3' });
  const r = await call(admin, 'PATCH', `/assets/${a.body.id}`, { ...a.body, serialNumber: `${tag}-D2` });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await one('SELECT COUNT(*) n FROM asset_connectivity WHERE serial_number = ?', [`${tag}-D1`]))[0].n, 1);
  assert.ok(b.body.id);
});

test('H1 bulk import that re-keys a serial (letter case) keeps connectivity, hardware details and issues, no duplicates', { skip: SKIP }, async () => {
  const low = `${tag.toLowerCase()}-bk`, up = low.toUpperCase();
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: low, assetTag: `${tag}-TBK`, rackNo: 'R-' + tag + 'K' }));
  assert.strictEqual(c.status, 200);
  await call(admin, 'PUT', `/assets/${c.body.id}/connectivity`, { iloIp: '10.250.0.6', category: 'bulk' });
  await db.query('INSERT INTO asset_hw_details (serial_number, vendor, site, zone, data) VALUES (?,?,?,?,?)', [low, 'dell', site, 'AZ-1', '{}']);
  const r = await call(admin, 'POST', '/assets/bulk-upsert', [{ ...assetBody({ serialNumber: up, assetTag: `${tag}-TBK`, rackNo: 'R-' + tag + 'K', model: 'PowerEdge R660' }) }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await one('SELECT serial_number FROM assets WHERE id = ?', [c.body.id]))[0].serial_number, up);
  for (const t of ['asset_connectivity', 'asset_hw_details']) {
    const rows = await one(`SELECT serial_number FROM ${t} WHERE serial_number = ?`, [up]);
    assert.strictEqual(rows.length, 1, `${t}: exactly one row`);
    assert.strictEqual(rows[0].serial_number, up, `${t}: re-keyed to the asset's serial`);
  }
});

// ------------------------------------------------------------------ M1: delete ----------------------------------------------------------------
test('M1 delete removes connectivity + hardware details; closed issues stay; Restore brings the asset back complete', { skip: SKIP }, async () => {
  const s = `${tag}-DEL`;
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: s, assetTag: `${tag}-T5`, rackNo: 'R-' + tag + 'X' }));
  await call(admin, 'PUT', `/assets/${c.body.id}/connectivity`, { iloIp: '10.250.0.5', category: 'restore-me' });
  await db.query('INSERT INTO asset_hw_details (serial_number, vendor, site, zone, data) VALUES (?,?,?,?,?)', [s, 'hpe', site, 'AZ-1', '{"mem":64}']);
  const iss = await call(admin, 'POST', '/issues', { site, title: 'closed ' + tag, assetId: s, severity: 'info' });
  assert.strictEqual(iss.status, 200);
  // open issue blocks deletion (existing behaviour kept)
  const blocked = await call(admin, 'DELETE', `/assets/${c.body.id}`);
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual((await one('SELECT COUNT(*) n FROM asset_connectivity WHERE serial_number = ?', [s]))[0].n, 1, 'a refused delete changes nothing');
  await db.query('UPDATE issues SET completed_date = NOW() WHERE id = ?', [iss.body.id]);

  const del = await call(admin, 'DELETE', `/assets/${c.body.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  for (const t of ['assets']) assert.strictEqual((await one(`SELECT COUNT(*) n FROM ${t} WHERE id = ?`, [c.body.id]))[0].n, 0);
  for (const t of ['asset_connectivity', 'asset_hw_details']) assert.strictEqual((await one(`SELECT COUNT(*) n FROM ${t} WHERE serial_number = ?`, [s]))[0].n, 0, `${t}: no orphan row`);
  assert.strictEqual((await one('SELECT COUNT(*) n FROM issues WHERE asset_id = ?', [s]))[0].n, 1, 'closed ticket history is kept');

  const log = (await one("SELECT id FROM audit_logs WHERE action = 'ASSET_DELETE' AND entity_id = ? ORDER BY id DESC LIMIT 1", [c.body.id]))[0];
  assert.ok(log, 'one delete audit row with snapshot');
  const rest = await call(admin, 'POST', `/audit-logs/${log.id}/restore`);
  assert.strictEqual(rest.status, 200, JSON.stringify(rest.body));
  assert.strictEqual((await one('SELECT COUNT(*) n FROM assets WHERE id = ?', [c.body.id]))[0].n, 1);
  assert.strictEqual((await one('SELECT category FROM asset_connectivity WHERE serial_number = ?', [s]))[0].category, 'restore-me');
  assert.strictEqual((await one('SELECT data FROM asset_hw_details WHERE serial_number = ?', [s]))[0].data, '{"mem":64}');
  const again = await call(admin, 'POST', `/audit-logs/${log.id}/restore`);
  assert.strictEqual(again.status, 409, 'second restore is refused, nothing duplicated');
  assert.strictEqual((await one('SELECT COUNT(*) n FROM asset_connectivity WHERE serial_number = ?', [s]))[0].n, 1);
});

test('M1 an asset without any linked rows still deletes cleanly', { skip: SKIP }, async () => {
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: `${tag}-PL`, assetTag: `${tag}-T6`, rackNo: 'R-' + tag + 'Y' }));
  assert.strictEqual((await call(admin, 'DELETE', `/assets/${c.body.id}`)).status, 200);
  assert.strictEqual((await call(admin, 'DELETE', `/assets/${c.body.id}`)).status, 404);
});

// ------------------------------------------------------------------ H2: report e-mail ----------------------------------------------------------------
function fakeSmtp() {
  const got = [];
  const srv = net.createServer((s) => {
    s.write('220 fake ESMTP\r\n'); let data = false, buf = '', msg = '';
    s.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (l === '.') { data = false; got.push(msg); msg = ''; s.write('250 queued\r\n'); } else msg += l + '\n'; continue; }
        const u = l.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) s.write('250 fake\r\n');
        else if (u === 'DATA') { data = true; s.write('354 go\r\n'); }
        else if (u === 'QUIT') { s.write('221 bye\r\n'); s.end(); } else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, got, port: srv.address().port })));
}

test('H2 /api/reports/email: exists, protected, validated, delivers sanitised report, reports SMTP trouble', { skip: SKIP }, async () => {
  const html = '<html><body><h1>Data Center Report</h1><script>alert(1)</script><p onclick="x()">Total 5</p></body></html>';
  assert.strictEqual((await call(null, 'POST', '/reports/email', { to: 'a@b.co', html })).status, 401, 'needs sign-in');
  assert.strictEqual((await call(admin, 'POST', '/reports/email', { to: '', html })).status, 400);
  assert.strictEqual((await call(admin, 'POST', '/reports/email', { to: 'not-an-address', html })).status, 400);
  assert.strictEqual((await call(admin, 'POST', '/reports/email', { to: 'a@b.co' })).status, 400, 'content required');
  assert.strictEqual((await call(admin, 'POST', '/reports/email', { to: Array.from({ length: 11 }, (_, i) => `u${i}@b.co`).join(','), html })).status, 400);
  const viewer = await one("SELECT username FROM users WHERE role = 'Viewer' AND status = 'Active' LIMIT 1");
  if (E.DCIM_IT_VIEWER_USER) { const v = await login(E.DCIM_IT_VIEWER_USER, E.DCIM_IT_VIEWER_PASS); assert.strictEqual((await call(v, 'POST', '/reports/email', { to: 'a@b.co', html })).status, 403); }
  void viewer;

  await call(admin, 'PUT', '/settings/integrations', { smtp: null });
  const noSmtp = await call(admin, 'POST', '/reports/email', { to: 'a@b.co', html });
  assert.strictEqual(noSmtp.status, 409, JSON.stringify(noSmtp.body));

  const f = await fakeSmtp();
  try {
    const cfg = await call(admin, 'PUT', '/settings/integrations', { smtp: { host: '127.0.0.1', port: f.port, secure: false, user: '', fromAddress: 'dcim@example.test' } });
    assert.strictEqual(cfg.status, 200, JSON.stringify(cfg.body));
    const ok = await call(admin, 'POST', '/reports/email', { to: 'a@b.co; c@d.org', subject: 'Data Center Report - 2026-11-24\r\nBcc: evil@x.co', html });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.sentTo, ['a@b.co', 'c@d.org']);
    assert.strictEqual(f.got.length, 1);
    const wire = f.got[0];
    const headerPart = wire.split('\n\n')[0];
    const body = Buffer.from(wire.split('\n\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
    assert.ok(/Total 5/.test(body), 'report text delivered');
    assert.ok(/sent by/i.test(body), 'sender line added');
    assert.ok(!/<script/i.test(body) && !/onclick/i.test(body), 'scripts / handlers stripped');
    assert.ok(!/^Bcc:/mi.test(headerPart), 'no injected header');
    const a = await one("SELECT COUNT(*) n FROM audit_logs WHERE action = 'REPORT_EMAIL' AND entity_type = 'dc_report' AND status = 'success'");
    assert.ok(a[0].n >= 1, 'audited');
  } finally { f.srv.close(); }
  // SMTP down -> a readable 424 message, not a crash
  const down = await call(admin, 'POST', '/reports/email', { to: 'a@b.co', html });
  assert.strictEqual(down.status, 424, JSON.stringify(down.body));
  assert.match(down.body.error, /could not be sent/);
  await call(admin, 'PUT', '/settings/integrations', { smtp: null });
});

// ------------------------------------------------------------------ M2: BMC password storage ----------------------------------------------------------------
test('M2 BMC password is stored encrypted, never returned, included encrypted in backups, legacy plain value still readable', { skip: SKIP }, async () => {
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: `${tag}-BMC`, assetTag: `${tag}-T7`, rackNo: 'R-' + tag + 'B', mgmtIp: '10.250.9.9' }));
  const id = c.body.id;
  const set = await call(admin, 'PUT', `/monitoring/redfish/${id}/credentials`, { username: 'root', password: 'Pl@in-Secret-1', port: 443 });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  const stored = (await one('SELECT redfish_password FROM assets WHERE id = ?', [id]))[0].redfish_password;
  assert.ok(stored.startsWith('enc:v1:') && !stored.includes('Pl@in'), 'stored encrypted');
  const list = await call(admin, 'GET', '/assets');
  assert.ok(!JSON.stringify(list.body).includes('Pl@in-Secret-1') && !JSON.stringify(list.body).includes('enc:v1:'), 'never returned by the asset list');
  const run = await call(admin, 'POST', '/backup/run', {});
  assert.strictEqual(run.status, 200, JSON.stringify(run.body));
  const zlib = require('zlib');
  const m = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(run.body.dir, run.body.file))).toString('utf8'));
  const row = m.tables.assets.find((a) => a.id === id);
  assert.ok(row.redfish_password.startsWith('enc:v1:'), 'backup holds the encrypted value');
  assert.ok(!JSON.stringify(m.tables.assets).includes('Pl@in-Secret-1'), 'plain password nowhere in the backup');
  // legacy plain value: still usable (sync gets as far as trying to reach the BMC) and never an internal error
  await db.query('UPDATE assets SET redfish_password = ? WHERE id = ?', ['LegacyPlain-1', id]);
  const sync = await call(admin, 'POST', `/monitoring/redfish/${id}/sync`);
  assert.ok(sync.status < 500, `legacy sync status ${sync.status}`);
  // empty password is allowed (some BMCs) and stays empty
  await call(admin, 'PUT', `/monitoring/redfish/${id}/credentials`, { username: 'root', password: '', port: 443 });
  assert.strictEqual((await one('SELECT redfish_password FROM assets WHERE id = ?', [id]))[0].redfish_password, '');
  const long = await call(admin, 'PUT', `/monitoring/redfish/${id}/credentials`, { username: 'root', password: 'x'.repeat(200), port: 443 });
  assert.strictEqual(long.status, 400);
});

// ------------------------------------------------------------------ M3: visitor documents in the backup ----------------------------------------------------------------
test('M3 visitor documents are in the backup, restored from it, and an old-format backup still restores', { skip: SKIP || !E.DCIM_IT_APPDIR }, async () => {
  await call(admin, 'PUT', '/setup/features', { approvalAccessEnabled: true });
  const v = await call(admin, 'POST', '/visitor-requests', { site, visitorName: 'IT Visitor ' + tag, visitDate: '2026-12-01', purpose: 'it' });
  assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const fd = new FormData(); fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'visit-' + tag + '.pdf');
  const up = await fetch(`${BASE}/api/visitor-requests/${v.body.id}/document`, { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: fd });
  assert.strictEqual(up.status, 200, await up.text());
  const [doc] = await one('SELECT file_name FROM visitor_access_documents WHERE request_id = ?', [v.body.id]);
  const onDisk = path.join(E.DCIM_IT_APPDIR, 'uploads', 'visitors', doc.file_name);
  assert.ok(fs.existsSync(onDisk));

  const run = await call(admin, 'POST', '/backup/run', {});
  assert.strictEqual(run.status, 200);
  const zlib = require('zlib'); const crypto = require('crypto');
  const m = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(run.body.dir, run.body.file))).toString('utf8'));
  assert.ok(m.visitorFiles && m.visitorFiles[doc.file_name], 'visitor file is inside the backup');
  assert.strictEqual(m.visitorFileCount, Object.keys(m.visitorFiles).length);
  assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify({ tables: m.tables, files: m.files })).digest('hex'), m.sha256, 'old checksum rule unchanged (older versions can still read the file)');

  fs.unlinkSync(onDisk);
  const dry = await call(admin, 'POST', '/backup/restore', { name: run.body.file, dryRun: true });
  assert.strictEqual(dry.status, 200, JSON.stringify(dry.body));
  assert.ok(!fs.existsSync(onDisk), 'a dry run writes nothing');
  const rs = await call(admin, 'POST', '/backup/restore', { name: run.body.file, confirm: 'RESTORE' });
  assert.strictEqual(rs.status, 200, JSON.stringify(rs.body));
  assert.ok(fs.existsSync(onDisk), 'visitor file is back after restore');
  assert.ok(fs.readFileSync(onDisk).equals(pdf));
  assert.ok(rs.body.visitorFilesRestored >= 1);

  // tampered visitor section is refused, nothing changes
  const bad = JSON.parse(JSON.stringify(m)); bad.visitorFiles[doc.file_name] = Buffer.from('tampered').toString('base64');
  const badName = run.body.file.replace('-manual', '-auto').replace(/\d{6}-auto/, '000001-auto');
  fs.writeFileSync(path.join(run.body.dir, badName), zlib.gzipSync(Buffer.from(JSON.stringify(bad))));
  const t = await call(admin, 'POST', '/backup/restore', { name: badName, dryRun: true });
  assert.strictEqual(t.status, 400); assert.match(t.body.error, /visitor/i);
  fs.unlinkSync(path.join(run.body.dir, badName));

  // a backup in the old format (no visitor section) restores exactly as before
  const old = JSON.parse(JSON.stringify(m)); delete old.visitorFiles; delete old.visitorFileCount; delete old.visitorSha256; delete old.skippedVisitorFiles;
  const oldName = badName.replace('000001-auto', '000002-auto');
  fs.writeFileSync(path.join(run.body.dir, oldName), zlib.gzipSync(Buffer.from(JSON.stringify(old))));
  const o = await call(admin, 'POST', '/backup/restore', { name: oldName, dryRun: true });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  fs.unlinkSync(path.join(run.body.dir, oldName));
  await call(admin, 'PUT', '/setup/features', { approvalAccessEnabled: false });
});

// ------------------------------------------------------------------ L5: Redfish job visibility ----------------------------------------------------------------
test('L5 a Redfish job can only be read by whoever started it (or an Admin covering its sites)', { skip: SKIP || !(E.DCIM_IT_OPA_USER && E.DCIM_IT_OPB_USER) }, async () => {
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: `${tag}-RJ`, assetTag: `${tag}-T8`, rackNo: 'R-' + tag + 'J', mgmtIp: '10.250.8.8' }));
  await db.query("UPDATE assets SET redfish_username = 'root', redfish_password = '' WHERE id = ?", [c.body.id]);
  const start = await call(opA, 'POST', '/monitoring/redfish/sync', { site });
  assert.strictEqual(start.status, 200, JSON.stringify(start.body));
  const jobId = start.body.jobId;
  const mine = await call(opA, 'GET', `/monitoring/redfish/sync/${jobId}`);
  assert.strictEqual(mine.status, 200); assert.strictEqual(mine.body.jobId, jobId);
  assert.ok(!('_acl' in mine.body), 'access info is not sent to the browser');
  const other = await call(opB, 'GET', `/monitoring/redfish/sync/${jobId}`);
  assert.strictEqual(other.status, 404, 'Operator of another site gets "not found"');
  const adm = await call(admin, 'GET', `/monitoring/redfish/sync/${jobId}`);
  assert.strictEqual(adm.status, 200, 'Admin covering the site can still follow it');
  assert.strictEqual((await call(null, 'GET', `/monitoring/redfish/sync/${jobId}`)).status, 401);
});

// ------------------------------------------------------------------ site security ----------------------------------------------------------------
test('Site security: an Operator cannot read, edit, delete or attach connectivity to another site\'s asset', { skip: SKIP || !(E.DCIM_IT_OPA_USER && E.DCIM_IT_OPB_USER) }, async () => {
  const c = await call(admin, 'POST', '/assets', assetBody({ serialNumber: `${tag}-SEC`, assetTag: `${tag}-T9`, rackNo: 'R-' + tag + 'S' }));
  const id = c.body.id;
  const list = await call(opB, 'GET', '/assets');
  assert.ok(!list.body.some((a) => a.id === id), 'other site\'s asset not listed');
  assert.ok([403, 404].includes((await call(opB, 'PATCH', `/assets/${id}`, { ...c.body, serialNumber: `${tag}-HACK` })).status));
  assert.ok([403, 404].includes((await call(opB, 'DELETE', `/assets/${id}`)).status));
  assert.ok([403, 404].includes((await call(opB, 'PUT', `/assets/${id}/connectivity`, { iloIp: '1.1.1.1' })).status));
  assert.strictEqual((await one('SELECT serial_number FROM assets WHERE id = ?', [id]))[0].serial_number, `${tag}-SEC`);
  assert.strictEqual((await call(opB, 'POST', '/reports/email', { to: 'a@b.co', html: '<p>x</p>' })).status === 401, false);
});

// ------------------------------------------------------------------ L9: branding uploads ----------------------------------------------------------------
test('L9 logo upload: real images only, SVG with script refused, Admin only, served with locked-down headers', { skip: SKIP }, async () => {
  const send = async (token, buf, type, name) => { const fd = new FormData(); fd.append('logo', new Blob([buf], { type }), name); const r = await fetch(`${BASE}/api/setup/logo`, { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: fd }); let j = null; try { j = await r.json(); } catch (e) { /* */ } return { status: r.status, body: j }; };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const okSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="#123"/></svg>');
  const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.strictEqual((await send(null, png, 'image/png', 'l.png')).status, 401);
  if (opA) assert.ok([401, 403].includes((await send(opA, png, 'image/png', 'l.png')).status), 'Operator cannot change the logo');
  assert.strictEqual((await send(admin, Buffer.from('<html>not an image</html>'), 'image/png', 'l.png')).status, 400);
  const e = await send(admin, evilSvg, 'image/svg+xml', 'l.svg'); assert.strictEqual(e.status, 400); assert.match(e.body.error, /script/);
  assert.strictEqual((await send(admin, png, 'image/jpeg', 'l.jpg')).status, 400, 'declared type must match the bytes');
  const good = await send(admin, okSvg, 'image/svg+xml', 'l.svg'); assert.strictEqual(good.status, 200, JSON.stringify(good.body));
  const served = await fetch(BASE + good.body.logoUrl);
  assert.strictEqual(served.status, 200);
  assert.strictEqual(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy') || '', /sandbox/);
  assert.strictEqual((await send(admin, png, 'image/png', 'l.png')).status, 200);
});
