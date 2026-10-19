# PDU SNMP OID Reference

This is the sourcing record behind two things defined in `lib/pdu-routes.js`:
the vendor preset list returned by `GET /api/pdus/vendor-presets`
(`VENDOR_OID_PRESETS` — live power draw, polled every cycle) and the
Max Load auto-detect table (`MAX_LOAD_BY_VENDOR` — a fixed, nameplate-style
value, fetched once to seed `max_load_kw`). It exists so nobody has to
re-research where each OID came from, and so a wrong value is a change you
can trace back to a source rather than something re-derived from memory.

**Why this matters**: the PDU feature polls each unit's configured Power OID
over SNMP and reports the result as live kW on the Dashboard and PDU Power
page. A wrong OID or a wrong scale factor silently corrupts real monitoring
numbers, so every entry below is either sourced from the vendor's own MIB /
published documentation, or explicitly marked `none` and left for the admin
to fill in manually after confirming with `snmpwalk` against their own unit.

`power_scale` is the multiplier applied to the raw SNMP integer to get Watts
(`raw_value * power_scale = watts`; the app then divides by 1000 for kW).
Vendors differ in what unit they report in — this is the whole reason the
column exists instead of guessing from the magnitude of the number.

## Preset entries

| id | Vendor | Model(s) | OID | Scale | Confidence | Source |
|---|---|---|---|---|---|---|
| `apc-rpdu2` | APC / Schneider Electric | Rack PDU 2G (AP84xx/86xx/88xx/89xx) | `1.3.6.1.4.1.318.1.1.26.4.3.1.5.0` (`rPDU2DeviceStatusPower`) | ×10 | High | APC's own PowerNet-MIB FAQ/support documentation. Reports in **hundredths of a kW**, hence ×10 to reach Watts. |
| `apc-rpdu1` | APC / Schneider Electric | Rack PDU 1G / Metered (older AP79xx/AP89xx) | `1.3.6.1.4.1.318.1.1.12.1.16.0` (`rPDUIdentDevicePowerWatts`) | ×1 | Medium | Reports Watts directly on metered units. On non-metered ("Switched") units this value is calculated from current × an assumed voltage/power-factor rather than truly measured — verify against a metered unit if accuracy matters. |
| `eaton-epdu` | Eaton | ePDU (all current families) | `1.3.6.1.4.1.534.6.6.4.1.1.2.3.0` (`pduInputPower`, EATON-PDU-MIB) | ×1 | High | Present input power demand for the whole unit, in Watts, scalar (no infeed index needed). |
| `servertech-sentry3` | Server Technology (Legrand) | Sentry3 PDUs | `1.3.6.1.4.1.1718.3.2.2.1.12.1.1` (`infeedPower`) | ×1 | Medium | From Server Technology's own published OID tree download for the Sentry3 MIB, in Watts. The trailing `.1.1` selects infeed #1 — units with more than one power infeed need the correct infeed index, found via `snmpwalk`. |
| `raritan-px` | Raritan / Legrand | PX2 / PX3 / PX4 | — (none) | — | None | No single OID is confirmed stable across PX firmware versions. Raritan's PDU2-MIB exposes `inletActivePower` (and `inletPoleActivePower` per phase), but the usable object/index varies by model and firmware. Download the PDU2-MIB for the exact unit and confirm with `snmpwalk`, then enter the OID manually. |
| `vertiv-geist` | Vertiv / Geist | rPDU (all families) | — (none) | — | None | Vertiv ships a model-specific MIB per rPDU family (available from vertiv.com support for the exact model). No single OID is correct across the range — use `snmptranslate`/`snmpwalk` against the right MIB to find the active-power object, then enter it manually. |
| `cyberpower` | CyberPower | PDU (all families) | — (none) | — | None | No confirmed total-power OID across the CyberPower PDU range. Download the MIB from CyberPower's product support page for the exact model and confirm with `snmpwalk`, then enter it manually. |
| `other` | — | Other / Not Listed | — (none) | ×1 | None | Catch-all for any brand/model not listed above. Enter everything manually, or leave Power OID blank to monitor reachability only (no wattage). |

## Max Load / Rated Capacity entries (`MAX_LOAD_BY_VENDOR`)

Unlike the Power OID above (polled every cycle, since the live reading
changes continuously), Max Load is a fixed, nameplate-style value — fetched
**once** to seed `max_load_kw` when it's blank, never re-fetched once set,
and never overwritten by anything the admin already entered.

| Vendor | OID(s) | How it's computed | Confidence | Source |
|---|---|---|---|---|
| Eaton | `1.3.6.1.4.1.534.6.6.4.1.1.1.1` (`pduRatingVA`, EATON-PDU-MIB) | `raw VA ÷ 1000 = kW` (VA and Watts are numerically close for typical IT power factors near 1.0 — not exact if your fleet runs a notably lower power factor) | High | The whole PDU's VA rating across all phases, scalar, no index needed. |
| Server Technology (Sentry3) | `1.3.6.1.4.1.1718.3.2.2.1.10.1.1` (`infeedCapacity`, Amps) **and** `1.3.6.1.4.1.1718.3.2.2.1.11.1.1` (`infeedVoltage`, tenths of Volts) | `Amps × (deciVolts ÷ 10) ÷ 1000 = kW` | High | Both values come from the device itself (same infeed `.1.1` index as the Power OID preset), so no voltage assumption is needed — confirmed computation, not a guess. Units with more than one power infeed may need the correct infeed index from an `snmpwalk`. |
| APC / Schneider (rPDU2) | `1.3.6.1.4.1.318.1.1.26.4.1.1.9.0` (`rPDU2DeviceConfigOverloadPowerThreshold`, tenths of kW) | `raw ÷ 10 = kW` | Medium | This is the overload-alarm threshold the unit was *configured* with — a reasonable proxy for rated capacity, but admin-configurable and not guaranteed to match the datasheet nameplate rating. This exact OID could not be independently verified against APC's own MIB file (fetching it was blocked by this environment's network policy); corroborated instead via two independent third-party searches landing on the same table/column. Confirm with `snmpwalk` against your own unit before trusting it at scale, and not available on older rPDU1/Metered-only units. |
| Raritan / Legrand, Vertiv / Geist, CyberPower, APC rPDU1/Metered | — (none) | — | None | No confirmed rated-capacity OID found — same as their Power OID preset entries. Max Load stays manual-entry for these; enter it from the nameplate. |

## Market note: India vs. worldwide

There is no distinct set of India-specific or India-only rack-PDU brands —
the data center PDU market in India is served by the same global vendors
listed above (APC/Schneider Electric, Vertiv, Legrand/Raritan, Eaton,
Server Technology). No separate "India" preset list was created for that
reason; the single list above covers both.

## Adding or correcting an entry

1. Get the OID from the vendor's own MIB file or published support
   documentation — never guess a numeric OID from memory or from a similar
   vendor's tree.
2. Confirm it with `snmpwalk -v2c -c <community> <ip> <oid>` against a real
   unit of that model before trusting it.
3. Determine the real-world unit the value is reported in (Watts, deciwatts,
   hundredths of a kW, etc.) and set `scale` so that `raw * scale = Watts`.
4. Add the entry to `VENDOR_OID_PRESETS` in `lib/pdu-routes.js` with an
   honest `confidence` level and a `note` explaining the source and any
   caveats (index position, metered vs. switched behavior, etc.), and add a
   matching row to the table above.
5. If no OID can be confirmed for a vendor/model, set `oid: null`,
   `confidence: 'none'`, and write a `note` telling the admin how to find it
   themselves (download the model-specific MIB, use `snmpwalk`) rather than
   leaving the field silently empty.
