const test = require('node:test');
const assert = require('node:assert');
const dd = require('../lib/pdu-routes')._describeDevice;

const APC = 'APC Web/SNMP Management Card (MB:v4.2.9 PF:v1.5.1.1 PN:apc_hw21_aos_1.5.1.1.bin AF1:v1.2.0.4 AN1:apc_hw21_rpdu2g_1.2.0.4.bin MN:AP8886 HR:03 SN: ZA2420011905 MD:05/16/2024)';

test('APC card: short model, real serial number, firmware, and rack / feed hints from the PDU name', () => {
  const r = dd(APC, 'Rack-K20-PDU-A');
  assert.strictEqual(r.model, 'AP8886');
  assert.strictEqual(r.serialNumber, 'ZA2420011905');
  assert.strictEqual(r.firmware, '4.2.9');
  assert.strictEqual(r.pduName, 'Rack-K20-PDU-A');
  assert.strictEqual(r.rackHint, 'K20');
  assert.strictEqual(r.feedHint, 'Feed A');
});
test('the PDU name is never used as the serial number', () => {
  assert.strictEqual(dd('Some PDU v1.2', 'my-pdu-name').serialNumber, null);
});
test('a long description without a model tag is shortened to fit the 150-character Model column', () => {
  const r = dd('X'.repeat(400), '');
  assert.ok(r.model.length <= 150);
});
test('names without a rack or feed give no hint', () => {
  const r = dd('Any', 'lab-pdu');
  assert.strictEqual(r.rackHint, null);
  assert.strictEqual(r.feedHint, null);
});

test('phase count from the device: 1 = Single-Phase, 3 = 3-Phase, anything else is not guessed', () => {
  const f = require('../lib/pdu-routes')._phaseFromCount;
  assert.strictEqual(f(1), 'Single-Phase');
  assert.strictEqual(f('3'), '3-Phase');
  assert.strictEqual(f(2), null);
  assert.strictEqual(f(undefined), null);
});

test('daisy chain: one entry per PDU row from the host\'s ident + properties tables', () => {
  const I = '1.3.6.1.4.1.318.1.1.26.2.1', P = '1.3.6.1.4.1.318.1.1.26.4.2.1';
  const ident = { [I + '.8.1']: Buffer.from('AP8886'), [I + '.9.1']: Buffer.from('ZA1'), [I + '.6.1']: Buffer.from('v1.2.0.4'), [I + '.8.2']: Buffer.from('AP8886'), [I + '.9.2']: Buffer.from('ZA2'), [I + '.3.2']: Buffer.from('ident-name-2') };
  const props = { [P + '.3.1']: Buffer.from('Rack-K20-PDU-A'), [P + '.7.1']: 3, [P + '.13.1']: 220, [P + '.3.2']: Buffer.from('Rack-K21-PDU-B'), [P + '.7.2']: 1 };
  const units = require('../lib/pdu-routes')._parseChainTables(ident, props);
  assert.strictEqual(units.length, 2);
  assert.deepStrictEqual([units[0].unit, units[0].name, units[0].serialNumber, units[0].phase, units[0].maxLoadKw, units[0].rackHint], [1, 'Rack-K20-PDU-A', 'ZA1', '3-Phase', 22, 'K20']);
  assert.deepStrictEqual([units[1].unit, units[1].name, units[1].phase, units[1].rackHint, units[1].feedHint], [2, 'Rack-K21-PDU-B', 'Single-Phase', 'K21', 'Feed B']);
  assert.deepStrictEqual(require('../lib/pdu-routes')._parseChainTables({}, {}), []);
});

test('circuit details: phases / banks of one PDU of a chain, with breaker limit and % used', () => {
  const S = '1.3.6.1.4.1.318.1.1.26.8.3.1', C = '1.3.6.1.4.1.318.1.1.26.8.1.1';
  const st = { [S + '.2.1']: 1, [S + '.3.1']: 1, [S + '.4.1']: 2, [S + '.5.1']: 85, [S + '.2.2']: 2, [S + '.3.2']: 1, [S + '.4.2']: 4, [S + '.5.2']: 200 };
  const cf = { [C + '.2.1']: 1, [C + '.3.1']: 1, [C + '.6.1']: 24, [C + '.7.1']: 30, [C + '.2.2']: 2, [C + '.3.2']: 1, [C + '.7.2']: 20 };
  const f = require('../lib/pdu-routes')._buildCircuits;
  const one = f(st, S, cf, C, 1);
  assert.strictEqual(one.items.length, 1);
  assert.deepStrictEqual([one.items[0].currentA, one.items[0].overloadA, one.items[0].usedPct, one.items[0].loadState], [8.5, 30, 28, 'Normal']);
  const two = f(st, S, cf, C, 2);
  assert.deepStrictEqual([two.items[0].currentA, two.items[0].usedPct, two.items[0].loadState], [20, 100, 'Overload']);
  const none = f(st, S, cf, C, 7); // no row carries unit 7: show all, flagged
  assert.strictEqual(none.items.length, 2); assert.strictEqual(none.moduleMatched, false);
  assert.deepStrictEqual(f({}, S, {}, C, 1), { items: [], moduleMatched: true });
});
