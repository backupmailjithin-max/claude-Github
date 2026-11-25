'use strict';
// Integration tests for the Asset Lifecycle page: movement date, Movement IN/OUT, Remarks and the validation on lifecycle actions.
// Run together with other integration files ONLY with --test-concurrency=1 (one Admin login at a time; a second login ends the first session).
// Runs against a SCRATCH copy of the application (same DCIM_IT_* variables as remediation.itest.js); it creates assets.
const test = require('node:test');
const assert = require('node:assert');
const E = process.env;
const BASE = (E.DCIM_IT_URL || '').replace(/\/$/, '');
const SKIP = BASE ? false : 'set DCIM_IT_URL (and the other DCIM_IT_* variables) to run the integration tests against a scratch copy';
const tag = 'LC' + Date.now().toString(36).toUpperCase();
let admin, site, site2;
async function call(token, method, url, body) {
  const r = await fetch(BASE + '/api' + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) { /* not json */ }
  return { status: r.status, body: json };
}
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const row = async (id) => (await call(admin, 'GET', '/asset-lifecycle')).body.find((r) => r.id === id);
const mk = async (n) => {
  const r = await call(admin, 'POST', '/assets', { site, zone: 'AZ-1', rackType: 'Compute', rackNo: 'R-' + tag, position: '', hardwareType: 'Dell Server', height: '1U', manufacturer: 'Dell', model: 'R650', serialNumber: `${tag}-${n}`, assetTag: `${tag}-T${n}`, deviceName: 'it-lc-' + n, installationDate: day(-30) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return r.body.id;
};
test.before(async () => {
  if (SKIP) return;
  const l = await call(null, 'POST', '/auth/login', { username: E.DCIM_IT_ADMIN_USER || 'admin', password: E.DCIM_IT_ADMIN_PASS });
  assert.strictEqual(l.status, 200); admin = l.body.token;
  const locs = (await call(admin, 'GET', '/locations')).body; const names = locs.map((x) => x.name || x);
  site = E.DCIM_IT_SITE || names[0]; site2 = names.find((s) => s !== site);
});

test('lifecycle action: unreadable, future, too old dates and over-long text are refused and nothing changes', { skip: SKIP }, async () => {
  const id = await mk(1);
  for (const [label, body, msg] of [
    ['unreadable date', { movementDate: 'not-a-date' }, /valid date/i],
    ['future date', { movementDate: day(1) }, /future/i],
    ['too old', { movementDate: '1999-12-31' }, /too old/i],
    ['remarks > 1000', { remarks: 'x'.repeat(1001) }, /Remarks are too long/],
    ['reason > 255', { reason: 'y'.repeat(256) }, /Reason is too long/],
    ['reference > 100', { referenceNo: 'z'.repeat(101) }, /Reference number is too long/],
  ]) {
    const r = await call(admin, 'POST', `/assets/${id}/lifecycle`, { action: 'Store', custodyLocation: 'Store A', reason: 'test', ...body });
    assert.strictEqual(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.error), msg, label);
  }
  const a = await row(id);
  assert.ok(!a || (a.lifecycleStatus === 'Active' && !a.latestMovementType), 'refused actions must not create history or change status');
});

test('lifecycle action: proper date, IN/OUT and remarks are saved and shown; an empty date still means today', { skip: SKIP }, async () => {
  const id = await mk(2);
  const r1 = await call(admin, 'POST', `/assets/${id}/lifecycle`, { action: 'Store', custodyLocation: 'Store A', reason: 'moved to store', movementDate: day(-2), remarks: 'Rack decommissioned, moved to store' });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  let a = await row(id);
  assert.strictEqual(a.latestMovementDay, day(-2));
  assert.strictEqual(a.latestDirection, 'IN');
  assert.strictEqual(a.latestRemarks, 'Rack decommissioned, moved to store');
  assert.ok(a.latestMovementDate, 'the old latestMovementDate field is still returned');
  // no date given -> today (unchanged behaviour)
  const r2 = await call(admin, 'POST', `/assets/${id}/lifecycle`, { action: 'Decommission', reason: 'end of life' });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  a = await row(id);
  assert.strictEqual(a.latestMovementDay, day(0));
  assert.strictEqual(a.latestDirection, 'OUT');   // it was in the store, so leaving is OUT
  assert.strictEqual(a.latestRemarks, null);
});

test('lifecycle: a transfer straight from a rack has no IN/OUT; movement edit refuses a future date, saves remarks, and shows them', { skip: SKIP || undefined }, async (t) => {
  if (!site2) return t.skip('needs two sites');
  const id = await mk(3);
  const r = await call(admin, 'POST', `/assets/${id}/lifecycle`, { action: 'Transfer / Reuse', destinationSite: site2, reason: 'transfer', movementDate: day(-1), remarks: 'Sent to ' + site2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let a = await row(id);
  assert.strictEqual(a.latestDirection, null, 'a rack asset sent straight to another DC never touched the store: no IN/OUT');
  assert.strictEqual(a.latestMovementDay, day(-1));
  const hist = (await call(admin, 'GET', `/assets/${id}/lifecycle-history`)).body;
  const mid = hist[0].id;
  const bad = await call(admin, 'PATCH', `/asset-movements/${mid}`, { movementDate: day(3), reason: 'x', remarks: 'x' });
  assert.strictEqual(bad.status, 400); assert.match(String(bad.body.error), /future/i);
  const ok = await call(admin, 'PATCH', `/asset-movements/${mid}`, { movementDate: day(-1), reason: 'transfer', remarks: 'Corrected remark' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  a = await row(id);
  assert.strictEqual(a.latestRemarks, 'Corrected remark'); assert.strictEqual(a.latestMovementDay, day(-1));
});

test('Movement IN/OUT follows the store: store entry is IN, leaving the store (install, transfer, RMA) is OUT, opening stock leaving is OUT', { skip: SKIP }, async (t) => {
  const id = await mk(4);
  assert.strictEqual((await call(admin, 'POST', `/assets/${id}/lifecycle`, { action: 'Store', custodyLocation: 'Store A', reason: 'to store', movementDate: day(-3) })).status, 200);
  assert.strictEqual((await row(id)).latestDirection, 'IN');
  const inst = await call(admin, 'POST', `/assets/${id}/lifecycle`, { action: 'Install from Store', reason: 'install', movementDate: day(-2), destinationZone: 'AZ-1', destinationRackNo: 'R-' + tag, destinationPosition: '20U', createDestinationRack: true, destinationRackType: 'Compute' });
  assert.strictEqual(inst.status, 200, JSON.stringify(inst.body));
  assert.strictEqual((await row(id)).latestDirection, 'OUT', 'store -> rack is OUT');
  const id2 = await mk(5);
  await call(admin, 'POST', `/assets/${id2}/lifecycle`, { action: 'Store', custodyLocation: 'Store A', reason: 'to store', movementDate: day(-3) });
  const rma = await call(admin, 'POST', `/assets/${id2}/lifecycle`, { action: 'RMA / OEM', reason: 'faulty', movementDate: day(-1) });
  assert.strictEqual(rma.status, 200, JSON.stringify(rma.body));
  assert.strictEqual((await row(id2)).latestDirection, 'OUT', 'store -> vendor is OUT');
  if (site2) {
    const id3 = await mk(6);
    await call(admin, 'POST', `/assets/${id3}/lifecycle`, { action: 'Store', custodyLocation: 'Store A', reason: 'to store', movementDate: day(-3) });
    const tr = await call(admin, 'POST', `/assets/${id3}/lifecycle`, { action: 'Transfer / Reuse', destinationSite: site2, reason: 'transfer', movementDate: day(-1) });
    assert.strictEqual(tr.status, 200, JSON.stringify(tr.body));
    assert.strictEqual((await row(id3)).latestDirection, 'OUT', 'store -> other DC is OUT');
  }
  // opening stock (no history yet) that leaves the store is OUT
  const sn = `${tag}-OS`;
  const imp = await call(admin, 'POST', '/asset-lifecycle/store-import', { dryRun: false, rows: [{ row: 2, serialNumber: sn, site, hardwareType: 'Dell Server', manufacturer: 'Dell', model: 'R650' }] });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
  const os = (await call(admin, 'GET', '/asset-lifecycle')).body.find((r) => r.serialNumber === sn);
  assert.ok(os && os.openingStock, 'opening stock row exists');
  assert.strictEqual(os.latestDirection, null, 'no movement yet: dash');
  const out = await call(admin, 'POST', `/assets/${os.id}/lifecycle`, { action: 'Decommission', reason: 'scrap', movementDate: day(-1) });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual((await row(os.id)).latestDirection, 'OUT');
});
