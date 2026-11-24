'use strict';
const test = require('node:test');
const assert = require('node:assert');
const links = require('../lib/asset-links');

// Tiny in-memory stand-in for the three tables the helpers touch (matches the exact statements they send).
function fakeDb(seed) {
  const t = { asset_connectivity: [...(seed.conn || [])], asset_hw_details: [...(seed.hw || [])], assets: [...(seed.assets || [])] };
  const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); // case-insensitive collation like MySQL
  const calls = [];
  return {
    t, calls,
    async query(sql, p = []) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      let m;
      if ((m = /^SELECT serial_number FROM `(\w+)` WHERE serial_number = \? LIMIT 1$/.exec(sql))) return [t[m[1]].filter((r) => eq(r.serial_number, p[0])).slice(0, 1).map((r) => ({ serial_number: r.serial_number }))];
      if ((m = /^DELETE FROM `?(\w+)`? WHERE serial_number = \?$/.exec(sql))) { const before = t[m[1]].length; t[m[1]] = t[m[1]].filter((r) => !eq(r.serial_number, p[0])); return [{ affectedRows: before - t[m[1]].length }]; }
      if ((m = /^UPDATE `(\w+)` SET serial_number = \? WHERE serial_number = \?$/.exec(sql))) { let n = 0; t[m[1]].forEach((r) => { if (r.serial_number === p[1]) { r.serial_number = p[0]; n++; } }); return [{ affectedRows: n }]; }
      if (/^SELECT \* FROM asset_connectivity WHERE serial_number = \? LIMIT 1$/.test(sql)) return [t.asset_connectivity.filter((r) => eq(r.serial_number, p[0])).slice(0, 1)];
      if (/^SELECT \* FROM asset_hw_details WHERE serial_number = \? LIMIT 1$/.test(sql)) return [t.asset_hw_details.filter((r) => eq(r.serial_number, p[0])).slice(0, 1)];
      if (/^SELECT id FROM assets WHERE serial_number = \? AND id != \? LIMIT 1$/.test(sql)) return [t.assets.filter((r) => eq(r.serial_number, p[0]) && r.id !== p[1]).slice(0, 1)];
      if ((m = /^INSERT IGNORE INTO `(\w+)` \((.*)\) VALUES/.exec(sql))) {
        const cols = m[2].split(',').map((c) => c.replace(/`/g, '')); const row = Object.fromEntries(cols.map((c, i) => [c, p[i]]));
        if (t[m[1]].some((r) => eq(r.serial_number, row.serial_number))) return [{ affectedRows: 0 }];
        t[m[1]].push(row); return [{ affectedRows: 1 }];
      }
      throw new Error('unexpected SQL in test: ' + sql);
    },
  };
}

test('serial change moves connectivity and hardware details, no duplicates, nothing lost', async () => {
  const db = fakeDb({ conn: [{ id: 1, serial_number: 'OLD-1', category: 'Server' }], hw: [{ serial_number: 'OLD-1', vendor: 'dell', data: '{"x":1}' }] });
  const r = await links.moveSerialLinks(db, 'OLD-1', 'NEW-1');
  assert.deepStrictEqual(r, { connectivity: 1, hwDetails: 1, replacedStale: 0 });
  assert.strictEqual(db.t.asset_connectivity.length, 1);
  assert.strictEqual(db.t.asset_connectivity[0].serial_number, 'NEW-1');
  assert.strictEqual(db.t.asset_connectivity[0].category, 'Server');
  assert.strictEqual(db.t.asset_hw_details.length, 1);
  assert.strictEqual(db.t.asset_hw_details[0].data, '{"x":1}');
});

test('a leftover row under the new serial is replaced by the asset\'s own row (no duplicate)', async () => {
  const db = fakeDb({ conn: [{ id: 1, serial_number: 'OLD-1', category: 'mine' }, { id: 2, serial_number: 'NEW-1', category: 'stale' }] });
  const r = await links.moveSerialLinks(db, 'OLD-1', 'NEW-1');
  assert.strictEqual(r.replacedStale, 1);
  assert.deepStrictEqual(db.t.asset_connectivity.map((x) => [x.serial_number, x.category]), [['NEW-1', 'mine']]);
});

test('an asset without connectivity leaves a row under the new serial alone', async () => {
  const db = fakeDb({ conn: [{ id: 2, serial_number: 'NEW-1', category: 'keep' }] });
  const r = await links.moveSerialLinks(db, 'OLD-1', 'NEW-1');
  assert.deepStrictEqual(r, { connectivity: 0, hwDetails: 0, replacedStale: 0 });
  assert.strictEqual(db.t.asset_connectivity[0].category, 'keep');
});

test('a case-only serial correction re-keys the same row and never deletes it', async () => {
  const db = fakeDb({ conn: [{ id: 1, serial_number: 'abc123', category: 'Server' }], hw: [{ serial_number: 'abc123', vendor: 'hpe', data: '{}' }] });
  await links.moveSerialLinks(db, 'abc123', 'ABC123');
  assert.deepStrictEqual(db.t.asset_connectivity.map((x) => x.serial_number), ['ABC123']);
  assert.deepStrictEqual(db.t.asset_hw_details.map((x) => x.serial_number), ['ABC123']);
});

test('no-op inputs touch nothing', async () => {
  const db = fakeDb({ conn: [{ id: 1, serial_number: 'A' }] });
  for (const [o, n] of [['', 'B'], ['A', ''], ['A', 'A'], [null, 'B'], ['A', null]]) await links.moveSerialLinks(db, o, n);
  assert.strictEqual(db.calls.length, 0);
});

test('delete cleanup removes the serial-keyed rows but not when another asset still carries the serial', async () => {
  const db = fakeDb({ conn: [{ id: 1, serial_number: 'S1' }], hw: [{ serial_number: 'S1' }], assets: [{ id: 'A1', serial_number: 'S1' }] });
  const r = await links.removeSerialLinks(db, 'S1', 'A1');
  assert.deepStrictEqual(r, { connectivity: 1, hwDetails: 1 });
  assert.strictEqual(db.t.asset_connectivity.length + db.t.asset_hw_details.length, 0);
  const db2 = fakeDb({ conn: [{ id: 1, serial_number: 'S1' }], assets: [{ id: 'A1', serial_number: 'S1' }, { id: 'A2', serial_number: 'S1' }] });
  assert.deepStrictEqual(await links.removeSerialLinks(db2, 'S1', 'A1'), { connectivity: 0, hwDetails: 0 });
  assert.strictEqual(db2.t.asset_connectivity.length, 1);
});

test('captured rows can be restored, and an existing row is never overwritten', async () => {
  const db = fakeDb({ conn: [{ id: 7, serial_number: 'S1', category: 'Server', remarks: 'r' }], hw: [{ serial_number: 'S1', vendor: 'dell', data: '{"a":1}' }] });
  const cap = await links.captureSerialLinks(db, 'S1');
  assert.strictEqual(cap.connectivity.category, 'Server');
  await links.removeSerialLinks(db, 'S1', 'A1');
  assert.strictEqual(db.t.asset_connectivity.length, 0);
  const r = await links.restoreSerialLinks(db, JSON.parse(JSON.stringify(cap)));
  assert.deepStrictEqual(r, { connectivity: 1, hwDetails: 1 });
  assert.strictEqual(db.t.asset_connectivity[0].category, 'Server');
  assert.strictEqual('id' in db.t.asset_connectivity[0], false, 'auto-increment id is not restored');
  const again = await links.restoreSerialLinks(db, JSON.parse(JSON.stringify(cap)));
  assert.deepStrictEqual(again, { connectivity: 0, hwDetails: 0 });
  assert.strictEqual(db.t.asset_connectivity.length, 1);
});

test('restore ignores garbage and unsafe column names', async () => {
  const db = fakeDb({});
  assert.deepStrictEqual(await links.restoreSerialLinks(db, null), { connectivity: 0, hwDetails: 0 });
  assert.deepStrictEqual(await links.restoreSerialLinks(db, { connectivity: { serial_number: '' }, hwDetails: 'x' }), { connectivity: 0, hwDetails: 0 });
  await links.restoreSerialLinks(db, { hwDetails: { serial_number: 'Z', 'vendor`; DROP TABLE x; --': 'bad', vendor: 'ok' } });
  assert.ok(db.calls.every((c) => !/DROP/i.test(c)));
});
