'use strict';
const test = require('node:test');
const assert = require('node:assert');
const psu = require('../lib/oneview-psu');

const OV = 'https://ov.test';
const URI = '/rest/server-hardware/ABC123';
const H = { Auth: 'x' };
const json = (d, status = 200) => ({ ok: status < 400, status, json: async () => d, text: async () => JSON.stringify(d), url: OV + '/' });
const mk = (routes) => async (url) => {
  const p = url.replace(OV, '');
  const r = routes[p];
  if (r === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '', url };
  if (typeof r === 'string') return { ok: true, status: 200, json: async () => ({}), text: async () => r, url: OV + '/' };
  return json(r);
};
const ctx = (routes) => ({ fetch: mk(routes), host: OV, headers: H });

test('parser: OneView-style list of supplies, each 800 W (screen shows Power Capacity / Average Power Output)', () => {
  assert.strictEqual(psu.psuWattsFromObject({ powerSupplies: [
    { bay: 1, state: 'Enabled', model: 'P38995-B21', powerCapacityWatts: 800, averagePowerOutputWatts: 241 },
    { bay: 2, state: 'Enabled', model: 'P38995-B21', powerCapacityWatts: 800, averagePowerOutputWatts: 277 }] }), 800);
});
test('parser: supply bays object, absent supply ignored, largest present wins', () => {
  assert.strictEqual(psu.psuWattsFromObject({ powerSupplyBays: [{ bayNumber: 1, devicePresence: 'Absent', powerCapacityWatts: 1600 }, { bayNumber: 2, devicePresence: 'Present', powerCapacityWatts: 800 }] }), 800);
});
test('parser: whole-server totals are NOT mistaken for a supply', () => {
  assert.strictEqual(psu.psuWattsFromObject({ powerCapacityWatts: 1600, calibratedMaxPower: 1181, metricList: [{ metricName: 'AveragePower', metricCapacity: 1600 }] }), null);
  assert.strictEqual(psu.psuWattsFromObject(null), null);
});
test('parser: nested under another object and Redfish-like names', () => {
  assert.strictEqual(psu.psuWattsFromObject({ hardware: { PowerSupplies: [{ PowerCapacityWatts: 800, Status: { State: 'Enabled' } }] } }), 800);
});

test('finds the supply list in the server-hardware record itself and remembers it', async () => {
  psu.resetForTests();
  const c = ctx({ [URI]: { powerSupplies: [{ state: 'Enabled', powerCapacityWatts: 800 }, { state: 'Enabled', powerCapacityWatts: 800 }] } });
  assert.strictEqual((await psu.fetchPsuRating(c, URI)).watts, 800);
  assert.strictEqual(psu.diagnostics()[0].workingSuffix, '');
});
test('finds it under a sub-resource when the record has none', async () => {
  psu.resetForTests();
  const c = ctx({ [URI]: { powerState: 'On' }, [URI + '/powerSupplies']: { members: [{ powerSupplyBay: 1, powerCapacityWatts: 800 }, { powerSupplyBay: 2, powerCapacityWatts: 800 }] } });
  assert.strictEqual((await psu.fetchPsuRating(c, URI)).watts, 800);
  assert.strictEqual(psu.diagnostics()[0].workingSuffix, '/powerSupplies');
});
test('discovers the path from the appliance web UI scripts when no known path answers', async () => {
  psu.resetForTests();
  const c = ctx({ '/': '<script src="/ui/app.js"></script>', '/ui/app.js': 'var u="/rest/server-hardware/{id}/powerSupplyDetails";', [URI]: {}, [URI + '/powerSupplyDetails']: { items: [{ powerSupplies: [{ powerCapacityWatts: 800 }] }] } });
  assert.strictEqual((await psu.fetchPsuRating(c, URI)).watts, 800);
  assert.ok(psu.diagnostics()[0].uiPathsMentioningPowerSupplies.some((p) => /powerSupplyDetails/.test(p)));
});
test('nothing found anywhere -> null (no number invented) and the attempts are recorded', async () => {
  psu.resetForTests();
  const c = ctx({ [URI]: { powerState: 'On' } });
  assert.strictEqual((await psu.fetchPsuRating(c, URI)).watts, null);
  const d = psu.diagnostics()[0];
  assert.strictEqual(d.workingSuffix, null);
  assert.ok(d.recentAttempts.length >= 5);
});
test('unsafe server uri is refused', async () => {
  psu.resetForTests();
  assert.strictEqual((await psu.fetchPsuRating(ctx({}), '/rest/../etc/passwd?x')).watts, null);
});

// ---- mixed fleet: what the Monitoring page showed (some servers answer, some do not, models differ) ----
const fleet = () => {
  const routes = {};
  const withList = (id, w) => { routes['/rest/server-hardware/' + id] = { powerSupplies: [{ state: 'Enabled', powerCapacityWatts: w }, { state: 'Enabled', powerCapacityWatts: w }], calibratedMaxPower: 697 }; };
  const noList = (id) => { routes['/rest/server-hardware/' + id] = { powerState: 'On' }; };
  noList('S0'); // the FIRST server has no supply data: it must not switch the reader off for the others
  for (const id of ['S1', 'S2', 'S3']) withList(id, 800);
  for (const id of ['S4', 'S5']) noList(id);       // same model as S1-S3 -> 800 W by same-model rule
  withList('G1', 1600); withList('G2', 500);       // another model with MIXED ratings
  noList('G3');                                    // ambiguous -> no guess
  noList('X1');                                    // model never seen with a supply list -> no guess
  return routes;
};
const U = (id) => '/rest/server-hardware/' + id;
test('mixed fleet: one early failure does not poison the appliance; peers fill the gaps; ambiguity stays empty', async () => {
  psu.resetForTests();
  const c = ctx(fleet());
  const M = 'hpe proliant dl380 gen10 plus', M2 = 'hpe proliant dl360 gen10', M3 = 'hpe proliant dl325';
  const r = {};
  for (const [id, m] of [['S0', M], ['S1', M], ['S2', M], ['S3', M], ['G1', M2], ['G2', M2], ['S4', M], ['S5', M], ['G3', M2], ['X1', M3]]) r[id] = await psu.fetchPsuRating(c, U(id), m);
  for (const id of ['S1', 'S2', 'S3']) { assert.strictEqual(r[id].watts, 800); assert.strictEqual(r[id].source, 'supply'); }
  assert.strictEqual(r.G1.watts, 1600); assert.strictEqual(r.G2.watts, 500);
  for (const id of ['S4', 'S5']) { assert.strictEqual(r[id].watts, 800); assert.strictEqual(r[id].source, 'model-peer'); }
  assert.strictEqual(r.G3.watts, null); assert.strictEqual(r.G3.proven, true);   // mixed 1600/500 -> not guessed, but proven => no whole-server total either
  assert.strictEqual(r.X1.watts, null); assert.strictEqual(r.X1.proven, true);
  // S0 was read before any server had proven the path: it has no number now, and picks up the peer value on the next look
  assert.strictEqual(r.S0.watts, null);
  const again = await psu.fetchPsuRating(c, U('S0'), M);
  assert.strictEqual(again.watts, 800); assert.strictEqual(again.source, 'model-peer');
  const d = psu.diagnostics()[0];
  assert.strictEqual(d.pathProven, true);
  assert.strictEqual(d.serversWithSupplyRating, 5); assert.ok(d.serversUsingSameModelPeer >= 2); assert.ok(d.serversWithoutRating.includes('G3') && d.serversWithoutRating.includes('X1'));
});
test('appliance that never returns supply lists: not proven, after 3 failures it stops probing (whole-server fallback stays available to the caller)', async () => {
  psu.resetForTests();
  const routes = {}; for (const id of ['A', 'B', 'C', 'D']) routes[U(id)] = { powerState: 'On' };
  const c = ctx(routes);
  for (const id of ['A', 'B', 'C']) { const r = await psu.fetchPsuRating(c, U(id), 'm'); assert.strictEqual(r.watts, null); assert.strictEqual(r.proven, false); }
  const before = psu.diagnostics()[0].recentAttempts.length;
  const r = await psu.fetchPsuRating(c, U('D'), 'm');
  assert.strictEqual(r.proven, false);
  assert.strictEqual(psu.diagnostics()[0].recentAttempts.length, before); // D was not probed again
});

test('real OneView /powerSupplies response (2 x 800 W, nested Oem figures ignored) -> 800, first call made', async () => {
  const psu = (n, last, max) => ({ FirmwareVersion: '2.01', LastPowerOutputWatts: last, LineInputVoltage: 226, MemberId: String(n), Model: 'P38995-B21', Name: 'HpeServerPowerSupply',
    Oem: { Hpe: { AveragePowerOutputWatts: last, BayNumber: n + 1, MaxPowerOutputWatts: max } }, PowerCapacityWatts: 800, PowerSupplyType: 'AC', Status: { Health: 'OK', State: 'Enabled' } });
  const body = { uri: '/rest/server-hardware/ABC/powerSupplies', collectionState: 'Collected', data: [psu(0, 241, 247), psu(1, 277, 283)], count: 2, name: 'PowerSupplies' };
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => body, text: async () => '' }; };
  const ov = require('../lib/oneview-psu'); ov.resetForTests();
  const r = await ov.fetchPsuRating({ fetch: fetchFn, host: 'https://ov', headers: {} }, '/rest/server-hardware/ABC', 'hpe proliant dl380 gen10 plus');
  assert.strictEqual(r.watts, 800); assert.strictEqual(r.source, 'supply');
  assert.deepStrictEqual(urls, ['https://ov/rest/server-hardware/ABC/powerSupplies']);
});
