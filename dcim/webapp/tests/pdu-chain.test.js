const test = require('node:test');
const assert = require('node:assert');
const eo = require('../lib/pdu-routes')._effectiveOid;
const APC = '1.3.6.1.4.1.318.1.1.26.4.3.1.5';

test('APC: a saved ".0" is read as table row 1, a chain unit selects its own row', () => {
  assert.strictEqual(eo({ power_oid: APC + '.0', chain_unit: 0 }), APC + '.1');
  assert.strictEqual(eo({ power_oid: APC + '.1', chain_unit: 0 }), APC + '.1');
  assert.strictEqual(eo({ power_oid: APC + '.0', chain_unit: 3 }), APC + '.3');
  assert.strictEqual(eo({ power_oid: APC + '.1', chain_unit: 32 }), APC + '.32');
});
test('other vendors: {unit} marks where the chained PDU number goes; plain OIDs are untouched', () => {
  assert.strictEqual(eo({ power_oid: '1.3.6.1.4.1.9999.1.{unit}.5', chain_unit: 7 }), '1.3.6.1.4.1.9999.1.7.5');
  assert.strictEqual(eo({ power_oid: '1.3.6.1.4.1.9999.1.{unit}.5', chain_unit: 0 }), '1.3.6.1.4.1.9999.1.1.5');
  assert.strictEqual(eo({ power_oid: '1.3.6.1.4.1.534.6.6.4.1.1.2.3.0', chain_unit: 2 }), '1.3.6.1.4.1.534.6.6.4.1.1.2.3.0');
  assert.strictEqual(eo({ power_oid: null, chain_unit: 2 }), null);
});
