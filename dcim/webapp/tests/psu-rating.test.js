'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { psuRatingFromPower } = require('../lib/redfish-routes');

test('two 800 W supplies (iLO 5, DL380 Gen10 Plus) -> 800 W, not 1600 W', () => {
  const power = { PowerControl: [{ PowerConsumedWatts: 548, PowerCapacityWatts: 1600 }], PowerSupplies: [
    { Name: 'HpeServerPowerSupply', PowerCapacityWatts: 800, LastPowerOutputWatts: 264, Status: { State: 'Enabled', Health: 'OK' } },
    { Name: 'HpeServerPowerSupply', PowerCapacityWatts: 800, LastPowerOutputWatts: 284, Status: { State: 'Enabled', Health: 'OK' } }] };
  assert.strictEqual(psuRatingFromPower(power), 800);
});
test('mixed or absent supplies: largest present one', () => {
  assert.strictEqual(psuRatingFromPower({ PowerSupplies: [{ PowerCapacityWatts: 1600, Status: { State: 'Absent' } }, { PowerCapacityWatts: 800, Status: { State: 'Enabled' } }] }), 800);
  assert.strictEqual(psuRatingFromPower({ PowerSupplies: [{ PowerCapacityWatts: 500 }, { PowerCapacityWatts: 1000 }] }), 1000);
});
test('no supplies listed -> null (nothing invented)', () => {
  assert.strictEqual(psuRatingFromPower({}), null);
  assert.strictEqual(psuRatingFromPower(null), null);
  assert.strictEqual(psuRatingFromPower({ PowerSupplies: [{ Name: 'x' }] }), null);
});
