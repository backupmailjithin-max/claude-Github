#!/usr/bin/env node
// Run on the machine DCIM is (or will be) installed on, to get the machine
// ID needed for a machine-bound license. Send the printed ID to whoever
// issues your license; it is not secret and does not need to be hidden.
// (An Admin can also get this from Settings -> License in the app itself.)
const { computeMachineFingerprint, formatFingerprint } = require('../lib/license');

console.log('Machine ID for this license:');
console.log(formatFingerprint(computeMachineFingerprint()));
