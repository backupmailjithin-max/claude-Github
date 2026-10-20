# Multi-Vendor Server Hardware Monitoring (Redfish) — Design Notes

This is the sourcing/design record behind `lib/redfish-routes.js` and the
Monitoring page's "Multi-Vendor (Redfish)" tab. It exists so the reasoning
behind each design choice is traceable, the same discipline already used for
`docs/PDU-SNMP-OIDS.md`.

## What this is, and what it isn't

Dell OME and HPE OneView are appliance-based: one appliance manages a whole
site/zone of devices, and this app already integrates with both. Redfish
(DSP0266, a DMTF standard) is the opposite model — it talks directly to each
server's own management port (BMC): Dell iDRAC, HPE iLO, Lenovo XClarity
Controller (XCC), Cisco standalone IMC, NVIDIA DGX, and most other modern
server hardware all expose it.

**This is additive, not a replacement.** OME/OneView stay the system of
record for the vendors/fleets they already cover, especially firmware job
orchestration. The Redfish layer exists to cover hardware those appliances
don't reach (e.g. a brand with no appliance at all), and to give every brand
a single, consistent code path for inventory/health/power/thermal reads.

## The capability-discovery pattern

A BMC's resource tree is **not uniform** across vendors or even firmware
generations of the same vendor — `detectRedfish()` in `lib/redfish-routes.js`
reads `GET /redfish/v1/` (ServiceRoot) first and only follows a collection
link (`Systems`, `Chassis`, `Managers`, `UpdateService`) if it's actually
present, rather than assuming every BMC exposes the same set. A collection
that's missing or errors is treated as "not available on this device", never
as a fatal failure of the whole detect call.

## What's reliably uniform vs. what isn't

Read operations are solid across every vendor checked: `Systems/{id}` for
identity/health (`Manufacturer`, `Model`, `SerialNumber`, `BiosVersion`,
`Status.Health`, `PowerState`), `Chassis/{id}/Thermal` and `.../Power` for
sensors, `Managers/{id}` for the BMC's own firmware version. These four are
what `detectRedfish()` and the "Test & Detect" preview are built on.

**Firmware PUSH (not read) is the one genuinely inconsistent piece.** Even
Dell's own OME doesn't do pure-Redfish bulk firmware push for iDRAC — it
SMB-mounts a share. This app implements firmware update via the standard
`UpdateService` → `#UpdateService.SimpleUpdate` action (the BMC fetches the
image itself from a URL you provide) + `TaskService` polling, which is
real and documented for Dell/HPE/Lenovo, but a BMC that doesn't support it
returns a clear "not supported" error rather than a silent failure — never
assume every brand can be updated this way.

## Credential storage

Redfish credentials are saved per-asset (`assets.redfish_username` /
`redfish_password`), the same way PDU `snmp_community` already is in this
app — plain storage, a local out-of-band-management credential, not a user
account password. `redfish_password` is never returned by any GET endpoint.

## COALESCE discipline

Same never-overwrite-a-set-value rule as every other auto-fill in this app
(PDU identity fields, asset connectivity, etc.): `manufacturer`, `model`,
`serial_number`, and `firmware` (host BIOS) are only filled when currently
blank. `bmc_firmware`, `health_status`, `power_state`, and
`last_redfish_sync_at` are **always** overwritten on every sync, because
they represent live state, not something an admin manually set.

## Firmware job integration

A Redfish firmware update writes a row into the same `firmware_jobs` table
OME/OneView jobs already use, with `vendor = 'redfish'`. The existing
background poller (`fwJobsTick` in `server.js`) already selects `DISTINCT
vendor, ...` with no vendor filter, so a `redfish` row is picked up
automatically — the only change needed there was adding one more branch to
the status-fetch ternary (`getRedfishTaskStatus`) and including `device_id`
in that query's SELECT list, since Redfish jobs resolve "which BMC to poll"
from the device's own saved credentials, not a site+zone appliance config
the way OME/OneView jobs do. The existing `/api/monitoring/firmware/jobs/
active` endpoint (which the Firmware Jobs tab already polls) needed **no
changes** — it was already vendor-agnostic.

## Validated against

A local mock Redfish BMC (plain Node `https` server, self-signed cert, Basic
auth, simulating `ServiceRoot` → `Systems` → `Chassis/Thermal+Power` →
`Managers` → `UpdateService` → `TaskService`) — not just read over. Covered:
detect with correct/wrong credentials and an unreachable host, save
credentials + sync (confirmed COALESCE protection kept existing manual
values and only filled blanks), bulk discover + apply, firmware inventory
read, and a full firmware update job lifecycle (trigger → background poller
polls the Task → job transitions to Completed in the existing Firmware Jobs
UI with the correct "Redfish" vendor label). Also re-verified the existing
OME/OneView tabs (Device Status, Firmware Jobs, Firmware Comparison,
Inventory Reconciliation) all still load with zero console/page errors.
