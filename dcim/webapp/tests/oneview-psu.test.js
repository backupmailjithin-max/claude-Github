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
  assert.strictEqual(await psu.fetchPsuRating(c, URI), 800);
  assert.strictEqual(psu.diagnostics()[0].workingSuffix, '');
});
test('finds it under a sub-resource when the record has none', async () => {
  psu.resetForTests();
  const c = ctx({ [URI]: { powerState: 'On' }, [URI + '/powerSupplies']: { members: [{ powerSupplyBay: 1, powerCapacityWatts: 800 }, { powerSupplyBay: 2, powerCapacityWatts: 800 }] } });
  assert.strictEqual(await psu.fetchPsuRating(c, URI), 800);
  assert.strictEqual(psu.diagnostics()[0].workingSuffix, '/powerSupplies');
});
test('discovers the path from the appliance web UI scripts when no known path answers', async () => {
  psu.resetForTests();
  const c = ctx({ '/': '<script src="/ui/app.js"></script>', '/ui/app.js': 'var u="/rest/server-hardware/{id}/powerSupplyDetails";', [URI]: {}, [URI + '/powerSupplyDetails']: { items: [{ powerSupplies: [{ powerCapacityWatts: 800 }] }] } });
  assert.strictEqual(await psu.fetchPsuRating(c, URI), 800);
  assert.ok(psu.diagnostics()[0].uiPathsMentioningPowerSupplies.some((p) => /powerSupplyDetails/.test(p)));
});
test('nothing found anywhere -> null (no number invented) and the attempts are recorded', async () => {
  psu.resetForTests();
  const c = ctx({ [URI]: { powerState: 'On' } });
  assert.strictEqual(await psu.fetchPsuRating(c, URI), null);
  const d = psu.diagnostics()[0];
  assert.strictEqual(d.workingSuffix, null);
  assert.ok(d.recentAttempts.length >= 5);
});
test('unsafe server uri is refused', async () => {
  psu.resetForTests();
  assert.strictEqual(await psu.fetchPsuRating(ctx({}), '/rest/../etc/passwd?x'), null);
});
