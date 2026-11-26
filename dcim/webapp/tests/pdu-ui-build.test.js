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

test('PDU PDF reports exist and list each PDU and circuit once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-compiled.js'), 'utf8');
  for (const t of ['function buildPduRackPdf', 'function buildPduZonePdf', 'Rack circuit report', 'Location power report', 'Circuit PDF for this rack', 'Export PDF']) assert.ok(src.includes(t), t);
  const cut = (name, next) => { const a = src.indexOf('function ' + name); const b = src.indexOf(next, a); return src.slice(a, b); };
  const fn = new Function(cut('pduPdfRacks', 'function pduPdfPage') + '\nreturn pduPdfRacks;')();
  const circ = (a) => ({ banks: [{ number: 1, currentA: a }, { number: 1, currentA: a }, { number: 2, currentA: a }], phases: [{ number: 1, currentA: a }] });
  const f = (id, unit, rack, a) => ({ id, ipAddress: '10.0.0.1', chainUnit: unit, feedLabel: 'Feed A', rackNo: rack, circuits: circ(a) });
  const out = fn([{ rackNo: 'R1', feeds: [f(1, 1, 'R1', 5), f(1, 1, 'R1', 5)] }, { rackNo: 'R2', feeds: [f(2, 2, 'R2', 5)] }, { rackNo: 'R3', feeds: [f(3, 3, 'R3', 9)] }]);
  assert.strictEqual(out[0].feeds.length, 1, 'same PDU twice -> once');
  assert.strictEqual(out[0].feeds[0].banks.length, 2, 'bank numbers unique');
  assert.ok(out[1].feeds[0].sameAs && out[1].feeds[0].banks.length === 0, 'identical host circuits printed once');
  assert.strictEqual(out[2].feeds[0].banks.length, 2, 'different readings kept');
});
