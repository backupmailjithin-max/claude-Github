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
