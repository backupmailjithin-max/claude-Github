'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { modelKey, buildModelRatings, ratingFor } = require('../lib/psu-model');

test('same model, different make spelling -> same key', () => {
  assert.strictEqual(modelKey('HPE', 'ProLiant DL380 Gen10 Plus'), modelKey('Hewlett Packard Enterprise', 'HPE ProLiant DL380 Gen10 Plus'));
  assert.notStrictEqual(modelKey('HPE', 'ProLiant DL380 Gen10 Plus'), modelKey('HPE', 'ProLiant DL380 Gen10'));
});
test('model rating = largest one-supply rating seen; applied to every server of that model, on or off', () => {
  const rows = [
    { manufacturer: 'HPE', model: 'ProLiant DL380 Gen10 Plus', ratings: [800, null] },
    { manufacturer: 'HPE', model: 'ProLiant DL380 Gen10 Plus', ratings: [null, null] },
    { manufacturer: 'Hewlett Packard Enterprise', model: 'ProLiant DL380 Gen10 Plus', ratings: [800] },
    { manufacturer: 'Dell', model: 'PowerEdge R650', ratings: [1100] },
  ];
  const m = buildModelRatings(rows);
  assert.strictEqual(ratingFor(m, 'HPE', 'ProLiant DL380 Gen10 Plus', null), 800);
  assert.strictEqual(ratingFor(m, 'HPE', 'ProLiant DL380 Gen10 Plus', 697), 800);
  assert.strictEqual(ratingFor(m, 'Dell', 'PowerEdge R650', null), 1100);
});
test('unknown model: own reading or nothing, never a guess', () => {
  const m = buildModelRatings([]);
  assert.strictEqual(ratingFor(m, 'HPE', 'X', 500), 500);
  assert.strictEqual(ratingFor(m, 'HPE', 'X', null), null);
});
