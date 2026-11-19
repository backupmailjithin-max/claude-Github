#!/usr/bin/env node
'use strict';
// Customer-style functional smoke test against a running DCIM instance.
//   node smoke-test.js <baseUrl> <adminUser> <adminPassword>
// Exit code 0 = all checks passed. Runs under the bundled Node (no dependencies).
const [base = 'http://127.0.0.1:8974', user = 'admin', pass = 'admin'] = process.argv.slice(2);
const B = base.replace(/\/$/, '') + '/api';
let T, fails = 0;
async function call(m, p, b) {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const buf = Buffer.from(await r.arrayBuffer()); let j = {}; try { j = JSON.parse(buf.toString()); } catch (e) {}
  return { s: r.status, j, buf };
}
const ck = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' -> ' + JSON.stringify(x).slice(0, 300))); if (!ok) fails++; };
(async () => {
  let r = await call('GET', '/health'); ck('health', r.s === 200 && r.j.status === 'ok' && r.j.database === 'connected', r.j);
  r = await call('POST', '/auth/login', { username: user, password: pass }); T = r.j.token; ck('admin login', !!T, r);
  if (!T) process.exit(1);
  r = await call('POST', '/auth/login', { username: user, password: 'definitely-wrong' }); ck('wrong password rejected', r.s === 401, r);
  const tag = Date.now().toString(36);
  const site = 'Smoke DC ' + tag;
  r = await call('POST', '/locations', { name: site, zoneName: 'SZ-1' }); ck('create location', r.s < 300, r);
  r = await call('POST', '/racks', { site, zone: 'SZ-1', rackNo: 'S01', rackType: '42U Standard', uSize: 42 }); ck('create rack', r.s < 300, r); const rk = r.j.id;
  r = await call('POST', '/racks', { site, zone: 'SZ-1', rackNo: 'S01', rackType: '42U Standard' }); ck('duplicate rack rejected', r.s === 409, r);
  const a = { site, zone: 'SZ-1', rackType: '42U Standard', rackNo: 'S01', position: '10U', hardwareType: 'DellServer', height: '1U', manufacturer: 'Dell', model: 'PowerEdge R660', serialNumber: 'SMK-' + tag, assetTag: 'SMK-' + tag, installationDate: '2026-11-01' };
  r = await call('POST', '/assets', a); ck('create asset', r.s < 300, r); const aid = r.j.id;
  r = await call('POST', '/assets', { ...a, serialNumber: 'SMK2-' + tag, assetTag: 'SMK2-' + tag }); ck('U-position overlap rejected', r.s >= 400, r);
  r = await call('PATCH', '/assets/' + aid, { ...a, position: '20U', remarks: 'moved' }); ck('edit asset', r.s < 300, r);
  r = await call('GET', '/assets'); const got = Array.isArray(r.j) && r.j.find(x => x.id === aid); ck('edit persisted', got && String(got.position).startsWith('20') && got.remarks === 'moved', got);
  r = await call('GET', '/assets/recent'); ck('Recently Modified lists the edit', JSON.stringify(r.j).includes(aid), r.s);
  r = await call('POST', '/material-movements', { site, movementType: 'Inward', itemName: 'Smoke box', quantity: 1 }); ck('material movement ticket', r.s < 300 && /^INW/.test(r.j.ticketNo || ''), r);
  r = await call('POST', '/issues', { site, title: 'Smoke issue', description: 'x', severity: 'info', zone: 'SZ-1' }); ck('create issue', r.s < 300, r);
  r = await call('GET', '/monitoring/server-power-consumption'); ck('power dashboard', r.s === 200, r);
  const month = new Date().toISOString().slice(0, 7);
  r = await call('POST', '/reports/monthly/pdf', { month }); ck('monthly report PDF', r.s === 200 && r.buf.slice(0, 4).toString() === '%PDF', [r.s, r.buf.length]);
  r = await call('POST', '/backup/run', {}); ck('backup', r.s < 300 && r.j.file, r); const file = r.j.file;
  r = await call('POST', '/backup/restore', { name: file, dryRun: true }); ck('restore dry-run validates backup', r.s === 200 && r.j.dryRun === true, r);
  r = await call('GET', '/audit-logs'); ck('audit log', r.s === 200, r.s);
  r = await call('GET', '/license/status'); ck('licence status (trial or licensed)', r.s === 200 && r.j.valid === true, r.j);
  // read-only sweep of the main lists
  for (const p of ['/locations', '/racks', '/assets', '/issues', '/activities', '/material-movements', '/hardware-types', '/rack-types', '/setup/status', '/ops/security', '/reports/monthly/options']) { r = await call('GET', p); ck('GET ' + p, r.s === 200, [r.s, r.j]); }
  r = await call('DELETE', '/assets/' + aid); ck('delete asset', r.s < 300, r);
  r = await call('DELETE', '/racks/' + rk); ck('delete rack', r.s < 300, r);
  console.log(fails ? 'SMOKE FAILURES: ' + fails : 'SMOKE ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH', e); process.exit(2); });
