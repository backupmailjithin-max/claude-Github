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

const { buildHwSummary } = require('../lib/redfish-routes');
test('hardware summary from the real R750 / DL380 Gen10 Plus payloads', () => {
  assert.strictEqual(buildHwSummary({ ProcessorSummary: { Count: 2, Model: 'Intel(R) Xeon(R) Gold 6330 CPU @ 2.00GHz' }, MemorySummary: { TotalSystemMemoryGiB: 1024 } }), '2 x Intel Xeon Gold 6330 @ 2.00GHz - 1024 GB RAM');
  assert.strictEqual(buildHwSummary({}), null);
});

test('hardware summaries: CPU, memory, disks and NICs read like a person would write them', () => {
  const rf = require('../lib/redfish-routes');
  assert.strictEqual(rf.summariseCpu([{ model: 'Intel(R) Xeon(R) Gold 6330 CPU @ 2.00GHz', cores: 28 }, { model: 'Intel(R) Xeon(R) Gold 6330 CPU @ 2.00GHz', cores: 28 }]), '2 x Intel Xeon Gold 6330 (28C)');
  assert.strictEqual(rf.summariseMemory([{ sizeGiB: 64, type: 'DDR4' }, { sizeGiB: 64, type: 'DDR4' }], 128), '128 GB (2 x 64GB DDR4)');
  assert.strictEqual(rf.summariseDisks([{ capacityGB: 1920, media: 'SSD', protocol: 'SAS' }, { capacityGB: 1920, media: 'SSD', protocol: 'SAS' }, { capacityGB: 8001, media: 'HDD', protocol: 'SATA' }]), '2 x 1.92 TB SSD SAS, 1 x 8 TB HDD SATA');
  assert.strictEqual(rf.summariseNics([{ speedMbps: 1000, link: true }, { speedMbps: 25000, link: false }]), '2 ports (1 x 1G, 1 x 25G) - 1 up');
  assert.strictEqual(rf.summariseDisks([]), null);
});
