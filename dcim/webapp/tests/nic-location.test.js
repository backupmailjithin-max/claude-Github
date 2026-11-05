'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nicLocation } = require('../lib/redfish-routes');

test('Dell iDRAC ports: position comes from the Id / Description, not the generic name', () => {
  const g = 'System Ethernet Interface';
  assert.strictEqual(nicLocation({ Id: 'NIC.Slot.2-1-1', Name: g, Description: 'NIC in Slot 2 Port 1 Partition 1' }), 'Slot 2 · Port 1');
  assert.strictEqual(nicLocation({ Id: 'NIC.Integrated.1-2-1', Name: g }), 'Integrated 1 · Port 2');
  assert.strictEqual(nicLocation({ Id: 'NIC.Embedded.1-1-1', Name: g }), 'Embedded 1 · Port 1');
  assert.strictEqual(nicLocation({ Id: 'NIC.Slot.2-1-2', Name: g }), 'Slot 2 · Port 1 (partition 2)');
  assert.strictEqual(nicLocation({ Name: g, Description: 'NIC in Slot 4 Port 2 Partition 1' }), 'Slot 4 · Port 2');
});
test('HPE / other BMCs: structured name, sentence name, then the raw id', () => {
  assert.strictEqual(nicLocation({ Id: '1', Name: '', Oem: { Hpe: { StructuredName: 'NIC.LOM.1.1' } } }), 'LOM 1 · Port 1');
  assert.strictEqual(nicLocation({ Id: '2', Name: 'Embedded LOM 1 Port 2' }), 'Embedded 1 · Port 2');
  assert.strictEqual(nicLocation({ Id: '3', Name: 'System Ethernet Interface' }), '3');
  assert.strictEqual(nicLocation({ Id: 'eth0', Name: 'Management NIC' }), 'Management NIC');
});
