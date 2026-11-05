'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canonicalModel, canonicalModelKey } = require('../lib/model-names');

test('Dell PowerEdge R750 spellings all collapse to one model', () => {
  ['Dell PowerEdge R750', 'Dell Power EdgeR750', 'Dell PER750', 'PER750', 'PowerEdge R750', 'poweredge r750', 'Dell EMC PowerEdge R750', 'R750', 'Dell PowerEdge-R750']
    .forEach((s) => assert.strictEqual(canonicalModel(s), 'PowerEdge R750', s));
});
test('Dell suffixes and other lines keep their identity', () => {
  assert.strictEqual(canonicalModel('Dell PowerEdge R750XS'), 'PowerEdge R750xs');
  assert.strictEqual(canonicalModel('PER660'), 'PowerEdge R660');
  assert.strictEqual(canonicalModel('PowerEdge MX750c'), 'PowerEdge MX750c');
  assert.strictEqual(canonicalModel('PowerEdge R750') !== canonicalModel('PowerEdge R760'), true);
});
test('HPE ProLiant spellings collapse to one model', () => {
  ['HPE ProLiant DL380 Gen10', 'ProLiant DL380 G10', 'HP DL380 Gen10', 'DL380Gen10', 'hpe proliant dl380 g10']
    .forEach((s) => assert.strictEqual(canonicalModel(s), 'ProLiant DL380 Gen10', s));
  assert.strictEqual(canonicalModel('ProLiant DL360p Gen8'), 'ProLiant DL360p Gen8');
  assert.strictEqual(canonicalModel('DL380 Gen10 Plus'), 'ProLiant DL380 Gen10 Plus');
  assert.notStrictEqual(canonicalModel('DL380 Gen10'), canonicalModel('DL380 Gen11'));
});
test('anything else is left alone', () => {
  assert.strictEqual(canonicalModel('Cisco Nexus 93180YC-EX'), 'Cisco Nexus 93180YC-EX');
  assert.strictEqual(canonicalModel('Veritas 5250'), 'Veritas 5250');
  assert.strictEqual(canonicalModel('  Some   Box '), 'Some Box');
  assert.strictEqual(canonicalModel(''), '');
  assert.strictEqual(canonicalModel(null), '');
  assert.strictEqual(canonicalModelKey('Dell PER750'), 'poweredge r750');
});

test('stored-data helper only rewrites when the make agrees', () => {
  const { canonicalModelFor } = require('../lib/model-names');
  assert.strictEqual(canonicalModelFor('Dell Inc.', 'Dell PER750'), 'PowerEdge R750');
  assert.strictEqual(canonicalModelFor('HPE', 'DL380 G10'), 'ProLiant DL380 Gen10');
  assert.strictEqual(canonicalModelFor('Hewlett Packard Enterprise', 'DL380 G10'), 'ProLiant DL380 Gen10');
  assert.strictEqual(canonicalModelFor('Cisco', 'C240'), 'C240');
  assert.strictEqual(canonicalModelFor('', 'R750'), 'R750');
});
