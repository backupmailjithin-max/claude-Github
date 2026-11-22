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
