'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rs = require('../lib/redfish-secret');
const S = 'unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaa';

test('seal/open round trip; stored text is not the password', () => {
  const sealed = rs.seal(S, 'P@ss w0rd!');
  assert.ok(sealed.startsWith(rs.PREFIX));
  assert.ok(!sealed.includes('P@ss'));
  assert.strictEqual(rs.open(S, sealed), 'P@ss w0rd!');
  assert.notStrictEqual(rs.seal(S, 'P@ss w0rd!'), sealed, 'random IV: same password seals differently each time');
});

test('legacy plain values still open as they are (existing credentials keep working)', () => {
  assert.strictEqual(rs.open(S, 'plain-old'), 'plain-old');
  assert.strictEqual(rs.open(S, ''), '');
  assert.strictEqual(rs.open(S, null), '');
  assert.strictEqual(rs.seal(S, ''), '');
  assert.strictEqual(rs.seal(S, null), '');
});

test('another server secret cannot read it (restored backup elsewhere): empty, not an error and not the ciphertext', () => {
  const sealed = rs.seal(S, 'secret');
  assert.strictEqual(rs.open('different-secret-bbbbbbbbbbbbbbbbbbbbbbbb', sealed), '');
});

test('very long passwords are refused with a clear 400 and the sealed text always fits VARCHAR(255)', () => {
  assert.throws(() => rs.seal(S, 'x'.repeat(rs.MAX_PLAIN_LENGTH + 1)), (e) => e.statusCode === 400);
  assert.ok(rs.seal(S, 'x'.repeat(rs.MAX_PLAIN_LENGTH)).length <= 255);
  assert.ok(rs.seal(S, 'é'.repeat(40)).length <= 255);
});

test('migration encrypts only legacy rows, is idempotent, and unseal reverses it', async () => {
  const rows = [{ id: 'A', redfish_password: 'one' }, { id: 'B', redfish_password: rs.seal(S, 'two') }, { id: 'C', redfish_password: 'x'.repeat(200) }];
  const pool = {
    async query(sql, p) {
      if (/NOT LIKE 'enc:v1:%'/.test(sql)) return [rows.filter((r) => r.redfish_password && !rs.isSealed(r.redfish_password)).map((r) => ({ ...r }))];
      if (/LIKE 'enc:v1:%'/.test(sql)) return [rows.filter((r) => rs.isSealed(r.redfish_password)).map((r) => ({ ...r }))];
      if (/^UPDATE assets SET redfish_password = \? WHERE id = \? AND redfish_password = \?$/.test(sql)) { const r = rows.find((x) => x.id === p[1] && x.redfish_password === p[2]); if (r) r.redfish_password = p[0]; return [{}]; }
      if (/^UPDATE assets SET redfish_password = \? WHERE id = \?$/.test(sql)) { rows.find((x) => x.id === p[1]).redfish_password = p[0]; return [{}]; }
      throw new Error('unexpected ' + sql);
    },
  };
  const r1 = await rs.sealLegacyPasswords(pool, S);
  assert.deepStrictEqual(r1, { sealed: 1, skipped: 1 });
  assert.ok(rs.isSealed(rows[0].redfish_password) && rs.open(S, rows[0].redfish_password) === 'one');
  assert.strictEqual(rows[2].redfish_password.length, 200, 'too-long legacy value is left as it was and keeps working');
  const again = await rs.sealLegacyPasswords(pool, S);
  assert.strictEqual(again.sealed, 0);
  const u = await rs.unsealAll(pool, S);
  assert.strictEqual(u.unsealed, 2);
  assert.deepStrictEqual(rows.map((r) => r.redfish_password).slice(0, 2), ['one', 'two']);
});
