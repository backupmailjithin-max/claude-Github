# DCIM internal (licence-free) edition - overlay

**Single source of truth:** all application code lives in `dcim/webapp`.
The internal edition is the same code with licensing switched off.

## Build the internal edition
1. Copy `dcim/webapp` to the target folder (as for any deployment).
2. Copy `dcim/internal-no-license/lib/license-public-key.js` over `lib/license-public-key.js`.
3. Restart the service. No trial, lock screen or activation prompt appears.

## Rules
- Never ship this overlay to a customer.
- Never edit application code here. Fix it once in `dcim/webapp`.
- `tools/probe-ome-power.js` is a vendor/support diagnostic and is not part of any customer package.
