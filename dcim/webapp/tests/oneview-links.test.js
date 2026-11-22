'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectOneviewLinks, macKey } = require('../lib/oneview-links');

test('reads link state and speed next to a MAC, in several naming styles', () => {
  const doc = { adapters: [
    { name: 'Slot 1', ports: [{ portNumber: 0, address: 'c4:70:bd:99:ac:08', linkStatus: 'LinkUp', currentSpeed: '25 Gbps' }, { portNumber: 1, address: 'C4-70-BD-99-AC-09', linkStatus: 'LinkDown' }] },
    { name: 'LOM', physicalPorts: [{ mac: '3c:fd:fe:00:00:01', portStatus: 'Up', currentLinkSpeedMbps: 10000 }] },
  ] };
  const r = collectOneviewLinks(doc, []);
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r[0], { keys: [macKey('c4:70:bd:99:ac:08')], link: 'Up', mbps: 25000 });
  assert.strictEqual(r[1].link, 'Down');
  assert.strictEqual(r[2].mbps, 10000);
});
test('ignores objects without both a MAC and a link field', () => {
  assert.strictEqual(collectOneviewLinks({ mac: 'c4:70:bd:99:ac:08' }, []).length, 0);
  assert.strictEqual(collectOneviewLinks({ linkStatus: 'LinkUp' }, []).length, 0);
  assert.strictEqual(collectOneviewLinks(null, []).length, 0);
});
test('follows-links helpers and layout report never expose values', () => {
  const { childUris, shapeOf } = require('../lib/oneview-links');
  const doc = { members: [{ uri: '/rest/server-hardware/ABC/networkAdapters/1', secret: 'topsecret' }, { uri: '/rest/other/2' }] };
  assert.deepStrictEqual(childUris(doc, '/rest/server-hardware/ABC', []), ['/rest/server-hardware/ABC/networkAdapters/1']);
  assert.ok(!shapeOf(doc).includes('topsecret'));
  assert.ok(shapeOf(doc).includes('members[]'));
});
test('MAC without separators is accepted', () => {
  assert.strictEqual(collectOneviewLinks({ macAddress: 'C470BD99AC08', linkStatus: 'LinkUp' }, []).length, 1);
});
test('Redfish-style port: MAC nested under Ethernet, speed in Gbps', () => {
  const doc = { data: [{ Id: 'DE080000', Model: 'Mellanox MCX631102AS', Controllers: [{ FirmwarePackageVersion: '26.43', Location: { PartLocation: { LocationOrdinalValue: 1 } }, Links: { Ports: [
    { Id: '1', LinkStatus: 'LinkUp', CurrentSpeedGbps: 25, Ethernet: { AssociatedMACAddresses: ['C4:70:BD:99:AC:08'] } },
    { Id: '2', LinkStatus: 'LinkDown', Ethernet: { AssociatedMACAddresses: ['C4:70:BD:99:AC:09'] } } ] } }] }] };
  const r = collectOneviewLinks(doc, []);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].link, 'Up'); assert.strictEqual(r[0].mbps, 25000);
  const { nicsFromAdapters } = require('../lib/oneview-links');
  const nics = nicsFromAdapters(doc);
  assert.strictEqual(nics.length, 1);
  assert.strictEqual(nics[0].ports.length, 2);
  assert.strictEqual(nics[0].ports[1].link, 'Down');
  assert.strictEqual(nics[0].firmware, '26.43');
});
test('Up/Down is filled by adapter model + position when MACs do not match', () => {
  const { mergeAdapterLinks, nicsFromAdapters } = require('../lib/oneview-links');
  const alt = nicsFromAdapters({ data: [{ Id: 'A', Model: 'Mellanox MCX631102AS-ADAT 2-port', Controllers: [{ Links: { Ports: [{ Id: '1', LinkStatus: 'LinkUp', CurrentSpeedGbps: 25 }, { Id: '2', LinkStatus: 'LinkDown' }] } }] }] });
  const nics = [{ name: 'P42046-001 / Mellanox MCX631102AS-ADAT Ethernet 10/25Gb 2-port SFP28 Adapter', id: 'PCI-E Slot 1', ports: [{ id: '0', mac: 'B8:E9:24:15:A7:CA', link: 'Enabled', speed: '25 Gbps' }, { id: '1', mac: 'B8:E9:24:15:A7:CB', link: 'Enabled', speed: '25 Gbps' }] }];
  assert.strictEqual(mergeAdapterLinks(nics, alt), 2);
  assert.strictEqual(nics[0].ports[0].link, 'Up');
  assert.strictEqual(nics[0].ports[1].link, 'Down');
});
test('real DL380 Gen10 Plus OneView answer: every port gets Up/Down by PCI slot, LinkStatus beats LinkState', () => {
  const { mergeAdapterLinks, nicsFromAdapters } = require('../lib/oneview-links');
  const diag = require('./fixtures/oneview-dl380g10plus-diag.json');
  const nics = diag.serverRecordPortMap.deviceSlots.map((d) => ({ name: d.deviceName, id: d.location, slot: String(d.slotNumber), partNumber: '', ports: d.physicalPorts.map((p) => ({ id: String(p.portNumber), mac: p.mac || p.wwn || '', link: '', speed: '' })) }));
  const filled = mergeAdapterLinks(nics, nicsFromAdapters(diag.networkAdapters.body));
  const by = {}; nics.forEach((n) => { by[n.slot] = n.ports.map((p) => p.link + (p.speed ? ' ' + p.speed : '')); });
  assert.strictEqual(filled, 14);
  assert.deepStrictEqual(by['10'], ['Down', 'Down', 'Down', 'Down']);
  assert.deepStrictEqual(by['6'], ['Up 32 Gbps', 'Up 32 Gbps']);
  assert.deepStrictEqual(by['1'], ['Up 25 Gbps', 'Up 25 Gbps']);
  assert.deepStrictEqual(by['3'], ['Up 25 Gbps', 'Up 25 Gbps']);
  assert.deepStrictEqual(by['7'], ['Up 25 Gbps', 'Down']);
  assert.deepStrictEqual(by['4'], ['Down', 'Down']);
});
test('other adapter makes: Intel-style (LinkStatus only), older iLO layout (OEM physical ports, no LinkStatus), FC OEM ports', () => {
  const { mergeAdapterLinks, nicsFromAdapters } = require('../lib/oneview-links');
  const doc = { data: [
    { Id: 'A', Model: 'Intel E810-XXVDA2 10/25Gb 2-port SFP28', Controllers: [{ Location: { PartLocation: { LocationOrdinalValue: 2 } } }], Ports: [{ Id: '1', LinkStatus: 'LinkUp', CurrentSpeedGbps: 10, LinkState: 'Enabled' }, { Id: '2', LinkStatus: 'LinkDown', LinkState: 'Disabled' }] },
    { Id: 'B', Model: 'HPE Ethernet 1Gb 4-port 331i Adapter', Controllers: [{ Location: { PartLocation: { LocationOrdinalValue: 9 } }, Links: { Ports: [{ '@odata.id': '/x/1' }, { '@odata.id': '/x/2' }] } }],
      Ports: [{ Id: '1', LinkStatus: null }, { Id: '2', LinkStatus: null }],
      Oem: { Hpe: { PhysicalPorts: [{ LinkStatus: null, SpeedMbps: 1000, Oem: { Hpe: { PortNumber: 1 } } }, { LinkStatus: null, SpeedMbps: 0, Oem: { Hpe: { PortNumber: 2 } } }] } } },
  ] };
  const nics = [
    { name: 'Intel E810-XXVDA2 10/25Gb 2-port SFP28', id: 'Pci', slot: '2', partNumber: '', ports: [{ id: '1', mac: '', link: 'Enabled', speed: '' }, { id: '2', mac: '', link: 'Disabled', speed: '' }] },
    { name: 'HPE Ethernet 1Gb 4-port 331i Adapter', id: 'Lom', slot: '9', partNumber: '', ports: [{ id: '1', mac: '', link: '', speed: '' }, { id: '2', mac: '', link: '', speed: '' }] },
  ];
  nics[0].ports.forEach((p) => { p.link = ''; });
  mergeAdapterLinks(nics, nicsFromAdapters(doc));
  assert.deepStrictEqual(nics[0].ports.map((p) => p.link), ['Up', 'Down']);
  assert.deepStrictEqual(nics[1].ports.map((p) => p.link), ['Up', 'Down']);
});
