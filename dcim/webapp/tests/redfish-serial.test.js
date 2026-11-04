const test = require('node:test');
const assert = require('node:assert');
const { pickSerial } = require('../lib/redfish-routes');

test('Dell: Service Tag (SKU) is used, never the board serial', () => {
  assert.strictEqual(pickSerial('Dell Inc.', { SerialNumber: 'INFLN0051234567', SKU: 'ABC1234' }), 'ABC1234');
});
test('Dell: older iDRAC exposes the tag under Oem.Dell.DellSystem', () => {
  assert.strictEqual(pickSerial('Dell Inc.', { SerialNumber: 'INFLN0051234567', Oem: { Dell: { DellSystem: { ServiceTag: 'XYZ9876' } } } }), 'XYZ9876');
});
test('Dell: no Service Tag reported -> null (board serial is never stored)', () => {
  assert.strictEqual(pickSerial('Dell Inc.', { SerialNumber: 'INFLN0051234567' }), null);
});
test('HPE and others keep SerialNumber', () => {
  assert.strictEqual(pickSerial('HPE', { SerialNumber: 'CZ1234AB5C', SKU: '868703-B21' }), 'CZ1234AB5C');
  assert.strictEqual(pickSerial('Lenovo', { SerialNumber: 'J1234567' }), 'J1234567');
});
test('vendor taken from Manufacturer when not passed', () => {
  assert.strictEqual(pickSerial(null, { Manufacturer: 'Dell Inc.', SerialNumber: 'INFLN1', SKU: 'TAG0001' }), 'TAG0001');
});
