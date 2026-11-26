// Guards the PDU feed card / daisy-chain view build and the horizontal list scrollers.
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app-compiled.js'), 'utf8');
test('feed card uses the tank design with no leftover preview switch', () => {
  assert.ok(src.includes('function PduCapsule'));
  assert.ok(!src.includes('__feedVariant') && !src.includes('PDU_FEED_THEMES'));
});
test('group view draws the chain panels without any power-connection box', () => {
  assert.ok(src.includes('function PduChainView'));
  assert.ok(src.includes('Network cable') && src.includes('Management'));
  assert.ok(!/Power connection|circuit<\/|Feed . circuit/i.test(src.slice(src.indexOf('function PduChainView'), src.indexOf('function PduEditModal'))));
});
test('issue tracker, DC activity and material movement lists have the slide scrollbar', () => {
  ['issueTableRef', 'actTableRef', 'movTableRef'].forEach((r) => assert.ok(src.includes('wrapRef: ' + r), r));
});
test('minified bundle is in step with the source', () => {
  const min = fs.readFileSync(path.join(__dirname, '..', 'app-compiled.min.js'), 'utf8');
  assert.ok(min.includes('pduFlow') && min.includes('Scroll the display'));
});

test('PDU details window is the dark control panel and keeps its warnings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-compiled.js'), 'utf8');
  const a = src.indexOf('function PduDetailsModal');
  assert.ok(src.includes('function PduArcGauge') && src.includes('function PduPhaseRings') && src.includes('function PduBreaker') && src.includes('function PduCircuitDeck'));
  const body = src.slice(a, a + 14000);
  for (const t of ['Reading the PDU', 'Check the Display ID on the PDU', 'Use Edit PDU to correct the Feed Label', 'has no A / B marker', 'does not label its circuits with its own unit number', 'Circuit-level details are available for APC Rack PDU 2G units']) assert.ok(body.includes(t), t);
});
