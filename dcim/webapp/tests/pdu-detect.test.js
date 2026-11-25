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
