'use strict';
// PDU (Power Distribution Unit) power monitoring - registered the same way as
// lib/setup-routes.js: a self-contained module wired into server.js, reusing
// the app's existing location-scoped auth (getAllowedSitesForUser /
// applySiteScope / assertSiteAccess) rather than inventing a new access model.
//
// Schema: one row per PHYSICAL FEED (so a rack with A+B redundant power is two
// rows sharing site/zone/rackType/rackNo), matching the assets table's own
// site/zone/rack_type/rack_no naming and types for consistency. The frontend
// groups feeds into "one row per rack" the same way the approved design does.
//
// Live polling uses SNMP (net-snmp, pure-JS dependency, no native build step -
// safe to ship in an offline bundle) to confirm reachability and read
// sysDescr/sysName for auto-detect. IMPORTANT, read before relying on this in
// production: there is no universal SNMP OID for "current power draw" across
// PDU vendors/models - it is vendor- and sometimes firmware-specific. Rather
// than guess an OID and silently report a number that might be wrong, a PDU
// only gets live wattage once an admin sets its optional "Power OID" (from
// that model's vendor MIB/datasheet) in Edit PDU. Without one, polling still
// confirms online/offline reachability (and surfaces a clear last_error
// explaining why wattage is blank) but never fabricates a reading.
const snmp = require('net-snmp');

const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0';
const SNMP_TIMEOUT_MS = 2500;
const DISCOVERY_TIMEOUT_MS = 1500; // shorter than SNMP_TIMEOUT_MS: a range scan hits mostly-empty IPs, so a slow per-host timeout multiplies into a very slow scan
const DISCOVERY_CONCURRENCY = 20;
const DISCOVERY_MAX_HOSTS = 1024; // hard cap across all configured ranges combined, so a misconfigured range (e.g. a /16 by mistake) can't turn one click into a multi-hour scan

// IPv4 range auto-discovery, configured in .env (not the database - same pattern as the
// OME_*/ONEVIEW_* monitoring config in .env.example). SNMP alone cannot tell you which
// physical Site/Zone/Rack a responding IP belongs to, so the operator maps each IP range
// to a Site+Zone up front; Rack No still has to be assigned by a human per device (see
// PduDiscoveryModal on the frontend). Format, one or more ranges separated by ';':
//   PDU_DISCOVERY_RANGES=10.20.4.100-10.20.4.160:Sample Site A:AZ-1;10.20.5.1-10.20.5.50:Sample Site B:AZ-1
// PDU_DISCOVERY_COMMUNITY is the one SNMP v2c community string used for every scanned
// host - the closest equivalent SNMP v2c has to a shared "username and password" across
// a batch-deployed PDU fleet. There is no SNMPv3 (per-device auth/priv credentials) support.
function ipToInt(ip) {
  const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function intToIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
function parseDiscoveryRanges(log) {
  const raw = String(process.env.PDU_DISCOVERY_RANGES || '').trim();
  if (!raw) return [];
  const out = [];
  raw.split(';').map((s) => s.trim()).filter(Boolean).forEach((entry) => {
    const parts = entry.split(':');
    if (parts.length !== 3) { (log || console).warn(`[pdu-discovery] ignoring malformed PDU_DISCOVERY_RANGES entry (expected startIP-endIP:Site:Zone): "${entry}"`); return; }
    const [ipRange, site, zone] = parts.map((s) => s.trim());
    const [startIp, endIp] = ipRange.split('-').map((s) => s.trim());
    const startInt = ipToInt(startIp), endInt = ipToInt(endIp || startIp);
    if (startInt === null || endInt === null || !site) { (log || console).warn(`[pdu-discovery] ignoring malformed PDU_DISCOVERY_RANGES entry: "${entry}"`); return; }
    if (endInt < startInt) { (log || console).warn(`[pdu-discovery] ignoring PDU_DISCOVERY_RANGES entry with end before start: "${entry}"`); return; }
    out.push({ startIp, endIp: endIp || startIp, startInt, endInt, site, zone: zone || 'AZ-1' });
  });
  return out;
}
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const VENDOR_HINTS = [
  ['vertiv', 'Vertiv'], ['geist', 'Vertiv'], ['liebert', 'Vertiv'],
  ['apc', 'APC'], ['schneider', 'APC'],
  ['raritan', 'Raritan'], ['server technology', 'Server Technology'], ['servertech', 'Server Technology'],
  ['eaton', 'Eaton'],
];

// Preset "Power OID" catalog for the top worldwide rack-PDU brands (these are
// also the dominant brands in Indian data centers - APC/Schneider, Vertiv,
// Legrand/Raritan and Eaton are the same global players there; there isn't a
// distinct "India-only" rack-PDU brand worth a separate list). Sourced from
// each vendor's own published MIB / support documentation (links in
// docs/PDU-SNMP-OIDS.md) - NOT guessed. Confidence varies by vendor/model
// generation, which is why every entry carries an explicit caveat and the
// Power OID field always stays manually editable in the UI, and "Other /
// Not Listed" (no oid) is always available for anything not covered here.
// `scale`: raw SNMP value x scale = Watts (vendors report in different
// units - W, 0.01 kW, etc; getting this wrong silently corrupts every
// reading, so it travels with the OID, not guessed per-poll).
const VENDOR_OID_PRESETS = [
  {
    id: 'apc-rpdu2', vendor: 'APC / Schneider Electric', model: 'Rack PDU 2G (AP84xx/86xx/88xx/89xx)',
    oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.5.1', scale: 10, confidence: 'high',
    note: 'rPDU2DeviceStatusPower, from APC\'s own PowerNet-MIB FAQ. Reports in hundredths of a kW, so this preset\'s x10 scale converts it to Watts automatically. The last number is the row of the PDU table: 1 for a single PDU or the host of a daisy chain; for chained PDUs set "Chain unit" (1-4) and the app picks the matching row.',
  },
  {
    id: 'apc-rpdu1', vendor: 'APC / Schneider Electric', model: 'Rack PDU 1G / Metered (older AP79xx/AP89xx)',
    oid: '1.3.6.1.4.1.318.1.1.12.1.16.0', scale: 1, confidence: 'medium',
    note: 'rPDUIdentDevicePowerWatts, in Watts directly. On non-metered ("Switched") units this is calculated from current x assumed voltage/power-factor, not truly measured - verify against a metered model if accuracy matters.',
  },
  {
    id: 'eaton-epdu', vendor: 'Eaton', model: 'ePDU (all current families)',
    oid: '1.3.6.1.4.1.534.6.6.4.1.1.2.3.0', scale: 1, confidence: 'high',
    note: 'pduInputPower from EATON-PDU-MIB - present input power demand of the whole unit, in Watts, no index needed.',
  },
  {
    id: 'servertech-sentry3', vendor: 'Server Technology (Legrand)', model: 'Sentry3 PDUs',
    oid: '1.3.6.1.4.1.1718.3.2.2.1.12.1.1', scale: 1, confidence: 'medium',
    note: 'infeedPower from Server Technology\'s own Sentry3 MIB, Watts. The trailing .1.1 selects infeed #1 - if your unit has more than one power infeed, you will need the correct infeed index from an snmpwalk.',
  },
  {
    id: 'raritan-px', vendor: 'Raritan / Legrand', model: 'PX2 / PX3 / PX4',
    oid: null, scale: 1, confidence: 'none',
    note: 'No single confirmed OID across PX firmware versions - Raritan\'s PDU2-MIB exposes inletActivePower (and inletPoleActivePower per phase), but the usable object/index varies by model. Download the PDU2-MIB for your exact unit and confirm with snmpwalk, then enter the OID manually below.',
  },
  {
    id: 'vertiv-geist', vendor: 'Vertiv / Geist', model: 'rPDU (all families)',
    oid: null, scale: 1, confidence: 'none',
    note: 'No confirmed public OID - Vertiv ships a model-specific MIB with every rPDU family (download from vertiv.com support for your exact model). Use snmptranslate/snmpwalk against it to find the active-power object, then enter the OID manually below.',
  },
  {
    id: 'cyberpower', vendor: 'CyberPower', model: 'PDU (all families)',
    oid: null, scale: 1, confidence: 'none',
    note: 'No confirmed total-power OID - download the MIB from CyberPower\'s product support page for your exact model and confirm with snmpwalk, then enter the OID manually below.',
  },
  { id: 'other', vendor: '', model: 'Other / Not Listed', oid: null, scale: 1, confidence: 'none', note: 'Enter everything manually, or leave Power OID blank to monitor reachability only.' },
];
function guessVendor(descr) {
  const d = String(descr || '').toLowerCase();
  for (const [needle, label] of VENDOR_HINTS) if (d.includes(needle)) return label;
  return null;
}
function guessFirmware(descr) {
  const m = String(descr || '').match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  return m ? m[1] : null;
}


// What a PDU's generic SNMP sysDescr/sysName really contain differs by vendor. sysDescr is often a long text
// (APC: "APC Web/SNMP Management Card (MB:v4.2.9 ... MN:AP8886 HR:03 SN: ZA2420011905 MD:05/16/2024)"), and sysName is
// the name an admin gave the unit (e.g. "Rack-K20-PDU-A"), NOT a serial number. So: the model and serial number are read
// from the MN:/SN: tags when present; otherwise the model is the (shortened) description and the serial stays blank.
// The name is returned separately as a hint for the rack and the feed.
function describeDevice(descr, name) {
  const d = String(descr || '').trim(), n = String(name || '').trim();
  const mn = d.match(/\bMN:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/), sn = d.match(/\bSN:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/);
  const model = mn ? mn[1] : (d.length > 150 ? d.slice(0, 147) + '...' : (d || null));
  const rk = n.match(/rack[\s_-]*([A-Za-z]*\d+[A-Za-z0-9]*)/i), fd = n.match(/(?:pdu|feed)[\s_-]*([AB])\b/i);
  return { model, serialNumber: sn ? sn[1] : null, firmware: guessFirmware(d), pduName: n || null,
    rackHint: rk ? rk[1].toUpperCase() : null, feedHint: fd ? 'Feed ' + fd[1].toUpperCase() : null };
}
function pickDevice(descr, name) { const x = describeDevice(descr, name); return { model: x.model, serialNumber: x.serialNumber, firmware: x.firmware }; }
// Single or 3-phase, read from the device itself where the vendor publishes it (never guessed from the model name).
// APC Rack PDU 2G: rPDU2DevicePropertiesNumPhases (row = the PDU's row, 1 for a single PDU or the host of a chain);
// older APC Rack PDUs: rPDULoadDevNumPhases. Other vendors: not read (the form keeps what is selected).
const APC_NUM_PHASES_OID = '1.3.6.1.4.1.318.1.1.26.4.2.1.7';
const APC_NUM_PHASES_OID_OLD = '1.3.6.1.4.1.318.1.1.12.2.1.2.0';
function phaseFromCount(n) { const v = Number(n); return v === 1 ? 'Single-Phase' : (v === 3 ? '3-Phase' : null); }
async function detectPhase(vendor, ip, community, unit) {
  if (!vendor || !/apc/i.test(vendor)) return null;
  const row = Number.isInteger(Number(unit)) && Number(unit) > 0 ? Number(unit) : 1;
  for (const oid of [APC_NUM_PHASES_OID + '.' + row, APC_NUM_PHASES_OID_OLD]) {
    try { const out = await snmpGet(ip, community, [oid], DISCOVERY_TIMEOUT_MS); const ph = phaseFromCount(out[oid]); if (ph) return ph; } catch (e) { /* try the next source */ }
  }
  return null;
}
// ---- Daisy chain discovery (APC Rack PDU 2G "Network Port Sharing") -------------------------------------------------
// The host PDU answers for every PDU in its chain: the identification table (.26.2.1) and the properties table (.26.4.2.1)
// have one row per PDU, row number = the PDU's Display ID. One walk of both tables lists the whole chain.
const APC_IDENT_TABLE = '1.3.6.1.4.1.318.1.1.26.2.1';
const APC_PROPS_TABLE = '1.3.6.1.4.1.318.1.1.26.4.2.1';
const snmpStr = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v == null ? '' : v)).replace(/\0/g, '').trim();
function snmpSubtree(ip, community, oid, timeout) {
  return new Promise((resolve, reject) => {
    let session;
    try { session = snmp.createSession(ip, community || 'public', { timeout: timeout || SNMP_TIMEOUT_MS, retries: 0 }); }
    catch (e) { return reject(e); }
    const out = {};
    const done = (err) => { try { session.close(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(out); };
    session.on('error', (err) => done(err));
    session.subtree(oid, 20, (vbs) => { vbs.forEach((vb) => { if (!snmp.isVarbindError(vb)) out[vb.oid] = vb.value; }); }, (err) => done(err));
  });
}
// Pure: turn the two walked tables into one entry per PDU (exported for tests).
function parseChainTables(ident, props) {
  const rows = {};
  const take = (map, prefix, key) => Object.keys(map || {}).forEach((oid) => {
    if (oid.indexOf(prefix + '.') !== 0) return;
    const m = /^(\d+)\.(\d+)$/.exec(oid.slice(prefix.length + 1));
    if (!m) return;
    const row = Number(m[2]); if (!(row >= 1 && row <= CHAIN_MAX)) return;
    ((rows[row] = rows[row] || { unit: row })[key] = (rows[row][key] || {}))[Number(m[1])] = map[oid];
  });
  take(ident, APC_IDENT_TABLE, 'i'); take(props, APC_PROPS_TABLE, 'p');
  return Object.keys(rows).map(Number).sort((a, b) => a - b).map((n) => {
    const i = rows[n].i || {}, p = rows[n].p || {};
    const name = snmpStr(p[3] != null ? p[3] : i[3]);
    const dd = describeDevice('', name);
    const rating = Number(p[13]);
    return { unit: n, name: name || null, model: snmpStr(i[8]) || null, serialNumber: snmpStr(i[9]) || null, firmware: snmpStr(i[6]) || null,
      phase: phaseFromCount(p[7]), maxLoadKw: rating > 0 ? Math.round(rating) / 10 : null, rackHint: dd.rackHint, feedHint: dd.feedHint };
  });
}
async function discoverChain(ip, community) {
  const [ident, props] = await Promise.all([snmpSubtree(ip, community, APC_IDENT_TABLE, 5000), snmpSubtree(ip, community, APC_PROPS_TABLE, 5000)]);
  return parseChainTables(ident, props);
}

// ---- Circuit details (APC Rack PDU 2G): per-phase and per-bank (breaker circuit) load, read live from the PDU ----------
const APC_PHASE_STATUS = '1.3.6.1.4.1.318.1.1.26.6.3.1', APC_PHASE_CONFIG = '1.3.6.1.4.1.318.1.1.26.6.1.1';
const APC_BANK_STATUS = '1.3.6.1.4.1.318.1.1.26.8.3.1', APC_BANK_CONFIG = '1.3.6.1.4.1.318.1.1.26.8.1.1';
const LOAD_STATES = { 1: 'Low load', 2: 'Normal', 3: 'Near overload', 4: 'Overload', 5: 'Not supported' };
function flatTable(map, prefix) { // { 'prefix.col.row': v } -> { row: { col: v } }
  const rows = {};
  Object.keys(map || {}).forEach((oid) => {
    if (oid.indexOf(prefix + '.') !== 0) return;
    const m = /^(\d+)\.(\d+)$/.exec(oid.slice(prefix.length + 1)); if (!m) return;
    (rows[m[2]] = rows[m[2]] || {})[Number(m[1])] = map[oid];
  });
  return rows;
}
// Pure: status + config rows of one table -> the circuits that belong to one PDU of the chain (Module column = the PDU's number).
// Returns { items, moduleMatched }. If no row carries this PDU's number (some firmware leaves Module at 0), every row is shown and moduleMatched is false.
function buildCircuits(statusMap, statusPrefix, configMap, configPrefix, unit) {
  const st = flatTable(statusMap, statusPrefix), cf = flatTable(configMap, configPrefix);
  const all = Object.keys(st).map((k) => ({ idx: Number(k), c: st[k] })).sort((a, b) => a.idx - b.idx);
  const mine = all.filter((r) => Number(r.c[2]) === unit);
  const rows = mine.length ? mine : all;
  const cfgFor = (c) => { const k = Object.keys(cf).find((x) => Number(cf[x][2]) === Number(c[2]) && Number(cf[x][3]) === Number(c[3])); return k ? cf[k] : {}; };
  const amps = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) / 10 : null);
  const hundredth = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) / 100 : null);
  const items = rows.map((r) => {
    const g = cfgFor(r.c);
    const currentA = amps(r.c[5]), overloadA = Number.isFinite(Number(g[7])) && Number(g[7]) > 0 ? Number(g[7]) : null;
    const nearA = Number.isFinite(Number(g[6])) && Number(g[6]) > 0 ? Number(g[6]) : null;
    return { number: Number(r.c[3]) || r.idx, loadState: LOAD_STATES[Number(r.c[4])] || null, currentA,
      voltage: Number.isFinite(Number(r.c[6])) && Number(r.c[6]) >= 0 ? Number(r.c[6]) : (Number.isFinite(Number(r.c[9])) && Number(r.c[9]) >= 0 ? Number(r.c[9]) : null),
      powerKw: hundredth(r.c[7] != null ? r.c[7] : r.c[10]), nearOverloadA: nearA, overloadA,
      usedPct: currentA != null && overloadA ? Math.round((currentA / overloadA) * 100) : null };
  });
  return { items, moduleMatched: mine.length > 0 || all.length === 0 };
}
// ---- Health (bank / phase load against the PDU's OWN limits) ---------------------------------------------------------
// Warning = the PDU itself reports "Near overload" for a bank or phase (or the current passed its near-overload threshold);
// Critical = "Overload" (or the current reached the overload threshold). The limits are the ones configured on the PDU.
function healthFromCircuits(banks, phases) {
  const items = [].concat((banks || []).map((c) => ({ kind: 'Bank', c })), (phases || []).map((c) => ({ kind: 'Phase', c })));
  if (!items.length) return null;
  const sev = (c) => {
    if (c.loadState === 'Overload') return 2;
    if (c.loadState === 'Near overload') return 1;
    if (c.currentA != null && c.overloadA && c.currentA >= c.overloadA) return 2;
    if (c.currentA != null && c.nearOverloadA && c.currentA >= c.nearOverloadA) return 1;
    return 0;
  };
  let worst = null;
  items.forEach((it) => { const v = sev(it.c), pct = it.c.usedPct != null ? it.c.usedPct : -1; if (!worst || v > worst.v || (v === worst.v && pct > worst.pct)) worst = { ...it, v, pct }; });
  const w = worst, c = w.c;
  const level = w.v === 2 ? 'critical' : w.v === 1 ? 'warning' : 'ok';
  const loadTxt = (c.currentA != null ? c.currentA + ' A' : '') + (c.overloadA ? ' of ' + c.overloadA + ' A limit' : '');
  const detail = level === 'ok'
    ? `All ${(banks || []).length} bank(s) and ${(phases || []).length} phase(s) normal` + (w.pct >= 0 ? ` (highest: ${w.kind} ${c.number} at ${w.pct}%)` : '')
    : `${w.kind} ${c.number}` + (w.pct >= 0 ? ` at ${w.pct}%` : '') + (loadTxt ? ` (${loadTxt})` : '') + ` - ${c.loadState || (level === 'critical' ? 'Overload' : 'Near overload')}`;
  return { level, detail: detail.slice(0, 250) };
}
// Reads only the columns needed, for a whole table, with the same flat 'prefix.col.row' shape that buildCircuits expects.
function snmpTableCols(ip, community, tableOid, cols, timeout) {
  return new Promise((resolve, reject) => {
    let session;
    try { session = snmp.createSession(ip, community || 'public', { timeout: timeout || 5000, retries: 0 }); }
    catch (e) { return reject(e); }
    const done = (err, out) => { try { session.close(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(out); };
    session.on('error', (err) => done(err));
    session.tableColumns(tableOid, cols, 20, (err, table) => {
      if (err) return done(err);
      const flat = {};
      Object.keys(table || {}).forEach((row) => Object.keys(table[row]).forEach((col) => { const v = table[row][col]; if (!snmp.isVarbindError(v)) flat[tableOid + '.1.' + col + '.' + row] = v; }));
      done(null, flat);
    });
  });
}
async function readCircuitTables(ip, community) {
  const [phSt, phCf, bkSt, bkCf] = await Promise.all([
    snmpTableCols(ip, community, '1.3.6.1.4.1.318.1.1.26.6.3', [2, 3, 4, 5, 6]),
    snmpTableCols(ip, community, '1.3.6.1.4.1.318.1.1.26.6.1', [2, 3, 6, 7]),
    snmpTableCols(ip, community, '1.3.6.1.4.1.318.1.1.26.8.3', [2, 3, 4, 5, 9]),
    snmpTableCols(ip, community, '1.3.6.1.4.1.318.1.1.26.8.1', [2, 3, 6, 7]),
  ]);
  return { phSt, phCf, bkSt, bkCf };
}
// A PDU of a chain is judged only by circuits that carry its own number; a single PDU may fall back to all circuits reported
// (some firmware leaves that number unset). Never judge one PDU by another PDU's circuits.
function unitHealth(tables, unit, allowFallback) {
  const ph = buildCircuits(tables.phSt, APC_PHASE_STATUS, tables.phCf, APC_PHASE_CONFIG, unit);
  const bk = buildCircuits(tables.bkSt, APC_BANK_STATUS, tables.bkCf, APC_BANK_CONFIG, unit);
  return healthFromCircuits(bk.moduleMatched || allowFallback ? bk.items : [], ph.moduleMatched || allowFallback ? ph.items : []);
}
const clip = (v, n) => (v == null ? v : String(v).slice(0, n));

// Rated/Max Load capacity. Unlike power_oid (polled every cycle, since the live
// reading changes), this is a fixed, nameplate-style value - fetched once to seed
// max_load_kw, with the same never-overwrite rule as every other auto-fill in this
// module (only fills the column when it is currently blank). Sourced with the same
// discipline as VENDOR_OID_PRESETS: only wired up where a MIB reference could be
// found and reasonably corroborated; a vendor with nothing confirmed is left out
// entirely here, same as "none" in the preset catalog - Max Load stays manual-entry
// for those (Raritan, Vertiv/Geist, CyberPower, and APC's older rPDU1/Metered family).
const MAX_LOAD_BY_VENDOR = {
  Eaton: {
    confidence: 'high',
    note: 'pduRatingVA (EATON-PDU-MIB) - the full VA rating of the whole PDU across all phases. Treated as kW (VA and Watts are numerically close for typical IT power factors near 1.0) - verify if your fleet runs a notably lower power factor.',
    fetch: async (ip, community) => {
      const out = await snmpGet(ip, community, ['1.3.6.1.4.1.534.6.6.4.1.1.1.1'], DISCOVERY_TIMEOUT_MS);
      const va = parseFloat(out['1.3.6.1.4.1.534.6.6.4.1.1.1.1']);
      return Number.isFinite(va) && va > 0 ? va / 1000 : null;
    },
  },
  'Server Technology': {
    confidence: 'high',
    note: "infeedCapacity (Amps) x infeedVoltage (tenths of Volts) from Server Technology's own Sentry3 MIB, same infeed #1 index as the Power OID preset - if your unit has more than one power infeed, this may need the correct infeed index from an snmpwalk.",
    fetch: async (ip, community) => {
      const out = await snmpGet(ip, community, ['1.3.6.1.4.1.1718.3.2.2.1.10.1.1', '1.3.6.1.4.1.1718.3.2.2.1.11.1.1'], DISCOVERY_TIMEOUT_MS);
      const amps = parseFloat(out['1.3.6.1.4.1.1718.3.2.2.1.10.1.1']);
      const deciVolts = parseFloat(out['1.3.6.1.4.1.1718.3.2.2.1.11.1.1']);
      if (!Number.isFinite(amps) || amps < 0 || !Number.isFinite(deciVolts) || deciVolts <= 0) return null;
      return (amps * (deciVolts / 10)) / 1000;
    },
  },
  APC: {
    confidence: 'medium',
    note: "rPDU2DeviceConfigOverloadPowerThreshold (PowerNet-MIB, tenths of kW) - the overload alarm threshold the unit was configured with. A reasonable proxy for rated capacity, not a guaranteed nameplate value: it is admin-configurable, may differ from the datasheet rating, isn't available on older rPDU1/Metered-only units, and this exact OID could not be independently confirmed against APC's own MIB file. Verify with snmpwalk against your unit and correct if needed.",
    fetch: async (ip, community, unit) => {
      const oid = '1.3.6.1.4.1.318.1.1.26.4.1.1.9.' + (Number(unit) > 0 ? Number(unit) : 1);
      const out = await snmpGet(ip, community, [oid], DISCOVERY_TIMEOUT_MS);
      const tenthsKw = parseFloat(out[oid]);
      return Number.isFinite(tenthsKw) && tenthsKw > 0 ? tenthsKw / 10 : null;
    },
  },
};
async function detectMaxLoadKw(vendor, ip, community, unit) {
  const cfg = MAX_LOAD_BY_VENDOR[vendor];
  if (!cfg) return null;
  try { return await cfg.fetch(ip, community, unit); } catch (e) { return null; }
}

// APC Rack PDU 2G tables are indexed by the PDU's position in a Network Port Sharing group (host = 1, guests 2-4).
// ".0" is not a table row, so a saved ".0" is read as row 1, and a chain unit (1-4) selects its own row.
const APC_RPDU2_PREFIX = '1.3.6.1.4.1.318.1.1.26.';
// Largest chain number the app accepts. Models differ (APC AP8xxx groups hold 4, some others 32 or 50-60), so this is a loose upper bound, not a vendor rule.
const CHAIN_MAX = 100;
function effectiveOid(pdu) {
  const oid = pdu && pdu.power_oid;
  if (!oid) return null;
  // Any vendor: write {unit} in the Power OID where the chained PDU's number goes (e.g. ...5.{unit}).
  if (oid.indexOf('{unit}') >= 0) return oid.split('{unit}').join(String(Number(pdu.chain_unit) > 0 ? Number(pdu.chain_unit) : 1));
  const m = /^(.*)\.(\d+)$/.exec(oid);
  if (!m || oid.indexOf(APC_RPDU2_PREFIX) !== 0) return oid;
  const unit = Number(pdu.chain_unit) || 0;
  return m[1] + '.' + (unit > 0 ? unit : (m[2] === '0' ? 1 : m[2]));
}
// One request for several OIDs where a missing one (e.g. an empty chain slot) does not fail the others.
function snmpGetEach(ip, community, oids, timeout) {
  return new Promise((resolve, reject) => {
    let session;
    try { session = snmp.createSession(ip, community || 'public', { timeout: timeout || SNMP_TIMEOUT_MS, retries: 0 }); }
    catch (e) { return reject(e); }
    const done = (err, out) => { try { session.close(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(out); };
    session.on('error', (err) => done(err));
    session.get(oids, (err, varbinds) => {
      if (err) return done(err);
      const out = {};
      oids.forEach((oid, i) => { if (!snmp.isVarbindError(varbinds[i])) out[oid] = varbinds[i].value; });
      done(null, out);
    });
  });
}
function snmpGet(ip, community, oids, timeout) {
  return new Promise((resolve, reject) => {
    let session;
    try { session = snmp.createSession(ip, community || 'public', { timeout: timeout || SNMP_TIMEOUT_MS, retries: 0 }); }
    catch (e) { return reject(e); }
    const done = (err, out) => { try { session.close(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(out); };
    session.on('error', (err) => done(err));
    session.get(oids, (err, varbinds) => {
      if (err) return done(err);
      const bad = varbinds.find((vb) => snmp.isVarbindError(vb));
      if (bad) return done(new Error(snmp.varbindError(bad)));
      const out = {};
      oids.forEach((oid, i) => { out[oid] = varbinds[i].value; });
      done(null, out);
    });
  });
}

module.exports = function registerPduRoutes(app, deps) {
  const { pool, authenticateToken, requireRole, getAllowedSitesForUser, applySiteScope, assertSiteAccess, genId, auditLog, sendErr, httpErr, log } = deps;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pdus (
        id VARCHAR(50) PRIMARY KEY,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) DEFAULT 'AZ-1',
        rack_type VARCHAR(50),
        rack_no VARCHAR(20) NOT NULL,
        feed_label VARCHAR(20) NOT NULL DEFAULT 'Feed A',
        ip_address VARCHAR(100) NOT NULL,
        vendor VARCHAR(50),
        model VARCHAR(150),
        serial_number VARCHAR(150),
        firmware VARCHAR(100),
        phase ENUM('Single-Phase','3-Phase') NOT NULL DEFAULT 'Single-Phase',
        max_load_kw DECIMAL(6,2) DEFAULT NULL,
        snmp_community VARCHAR(100) DEFAULT 'public',
        power_oid VARCHAR(100) DEFAULT NULL,
        power_scale DECIMAL(10,4) NOT NULL DEFAULT 1,
        poll_interval_sec INT NOT NULL DEFAULT 900,
        status ENUM('online','offline','warning','unknown') NOT NULL DEFAULT 'unknown',
        last_power_kw DECIMAL(7,3) DEFAULT NULL,
        last_reading_at DATETIME NULL,
        last_error VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pdu_ip (ip_address),
        KEY idx_site_zone_rack (site, zone, rack_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS power_readings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        pdu_id VARCHAR(50) NOT NULL,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) NOT NULL,
        reading_date DATE NOT NULL,
        avg_kw DECIMAL(7,3) DEFAULT NULL,
        peak_kw DECIMAL(7,3) DEFAULT NULL,
        energy_kwh DECIMAL(9,2) DEFAULT NULL,
        sample_count INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pdu_date (pdu_id, reading_date),
        KEY idx_site_zone_date (site, zone, reading_date),
        CONSTRAINT fk_power_readings_pdu FOREIGN KEY (pdu_id) REFERENCES pdus(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Idempotent migration for a pdus table created before power_scale existed.
    // Daisy-chained PDUs (APC Network Port Sharing: up to 4 PDUs behind one IP): chain_unit 0 = single PDU, 1-4 = position in the chain.
    try { await pool.query('ALTER TABLE pdus ADD COLUMN chain_unit TINYINT NOT NULL DEFAULT 0 AFTER ip_address'); } catch (e) { /* column already exists */ }
    try { await pool.query('ALTER TABLE pdus ADD UNIQUE KEY uniq_pdu_ip_unit (ip_address, chain_unit)'); } catch (e) { /* already exists */ }
    try { await pool.query('ALTER TABLE pdus DROP INDEX uniq_pdu_ip'); } catch (e) { /* already replaced */ }
    try { await pool.query('ALTER TABLE pdus ADD COLUMN power_scale DECIMAL(10,4) NOT NULL DEFAULT 1 AFTER power_oid'); } catch (e) { /* column already exists */ }
    for (const ddl of ['ADD COLUMN health VARCHAR(12) NULL', 'ADD COLUMN health_detail VARCHAR(255) NULL', 'ADD COLUMN health_at DATETIME NULL']) { try { await pool.query('ALTER TABLE pdus ' + ddl); } catch (e) { /* column already exists */ } }
  }

  function mapPdu(r) {
    return {
      id: r.id, site: r.site, zone: r.zone, rackType: r.rack_type, rackNo: r.rack_no, feedLabel: r.feed_label,
      ipAddress: r.ip_address, chainUnit: Number(r.chain_unit) || 0, vendor: r.vendor, model: r.model, serialNumber: r.serial_number, firmware: r.firmware,
      phase: r.phase, maxLoadKw: r.max_load_kw != null ? Number(r.max_load_kw) : null,
      powerOid: r.power_oid, powerScale: r.power_scale != null ? Number(r.power_scale) : 1, pollIntervalSec: r.poll_interval_sec, status: r.status,
      lastPowerKw: r.last_power_kw != null ? Number(r.last_power_kw) : null,
      lastReadingAt: r.last_reading_at, lastError: r.last_error,
      health: r.health || null, healthDetail: r.health_detail || null, healthAt: r.health_at || null,
    };
  }

  // ---- vendor OID preset catalog (static reference data, served so the frontend never has to duplicate it) ----
  app.get('/api/pdus/vendor-presets', authenticateToken, (req, res) => {
    res.json(VENDOR_OID_PRESETS);
  });

  // ---- list (grouped into racks client-side friendly shape) + create + edit + delete ----
  app.get('/api/pdus', authenticateToken, async (req, res) => {
    try {
      const { site } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      let sql = 'SELECT * FROM pdus';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY site, zone, rack_no, feed_label';
      const [rows] = await pool.query(sql, params);
      res.json(rows.map(mapPdu));
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/pdus', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const b = req.body || {};
      for (const k of ['site', 'zone', 'rackNo', 'feedLabel', 'ipAddress']) if (typeof b[k] === 'string') b[k] = b[k].replace(/\s+/g, ' ').trim(); // same hygiene as assets: ' R01 ' must match rack R01
      for (const f of ['site', 'rackNo', 'feedLabel', 'ipAddress']) {
        if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `"${f}" is required.` });
      }
      await assertSiteAccess(req.user, b.site);
      const unit = b.chainUnit === '' || b.chainUnit == null ? 0 : Number(b.chainUnit);
      if (!Number.isInteger(unit) || unit < 0 || unit > CHAIN_MAX) return res.status(400).json({ error: `"Chain unit" must be 1 to ${CHAIN_MAX} (or empty for a single PDU).` });
      const id = genId('PDU');
      await pool.query(
        `INSERT INTO pdus (id, site, zone, rack_type, rack_no, feed_label, ip_address, chain_unit, vendor, model, serial_number, firmware, phase, max_load_kw, snmp_community, power_oid, power_scale)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, b.site, clip(b.zone || 'AZ-1', 20), clip(b.rackType || null, 50), clip(b.rackNo, 20), clip(b.feedLabel, 20), b.ipAddress, unit, clip(b.vendor || null, 50), clip(b.model || null, 150),
          clip(b.serialNumber || null, 150), clip(b.firmware || null, 100), b.phase === '3-Phase' ? '3-Phase' : 'Single-Phase',
          b.maxLoadKw != null && b.maxLoadKw !== '' ? Number(b.maxLoadKw) : null, clip(b.snmpCommunity || 'public', 100), clip(b.powerOid || null, 100),
          b.powerScale != null && b.powerScale !== '' ? Number(b.powerScale) : 1]
      );
      auditLog(req, 'PDU_CREATE', { entity: 'pdu', entityId: id, site: b.site });
      const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [id]);
      res.status(201).json(mapPdu(rows[0]));
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A PDU with this IP address and chain unit already exists.' });
      sendErr(res, e);
    }
  });

  app.put('/api/pdus/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT * FROM pdus WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'PDU not found' });
      await assertSiteAccess(req.user, existing[0].site);
      const b = req.body || {};
      for (const k of ['site', 'zone', 'rackNo', 'feedLabel', 'ipAddress']) if (typeof b[k] === 'string') b[k] = b[k].replace(/\s+/g, ' ').trim();
      if (b.site) await assertSiteAccess(req.user, b.site);
      const unitPut = b.chainUnit === undefined ? Number(existing[0].chain_unit) || 0 : (b.chainUnit === '' || b.chainUnit == null ? 0 : Number(b.chainUnit));
      if (!Number.isInteger(unitPut) || unitPut < 0 || unitPut > CHAIN_MAX) return res.status(400).json({ error: `"Chain unit" must be 1 to ${CHAIN_MAX} (or empty for a single PDU).` });
      await pool.query(
        `UPDATE pdus SET site=?, zone=?, rack_type=?, rack_no=?, feed_label=?, ip_address=?, chain_unit=?, vendor=?, model=?, serial_number=?,
           firmware=?, phase=?, max_load_kw=?, snmp_community=?, power_oid=?, power_scale=? WHERE id = ?`,
        [b.site || existing[0].site, clip(b.zone, 20) || existing[0].zone, b.rackType != null ? clip(b.rackType, 50) : existing[0].rack_type,
          clip(b.rackNo, 20) || existing[0].rack_no, clip(b.feedLabel, 20) || existing[0].feed_label, b.ipAddress || existing[0].ip_address, unitPut,
          b.vendor != null ? clip(b.vendor, 50) : existing[0].vendor, b.model != null ? clip(b.model, 150) : existing[0].model,
          b.serialNumber != null ? clip(b.serialNumber, 150) : existing[0].serial_number, b.firmware != null ? clip(b.firmware, 100) : existing[0].firmware,
          b.phase === '3-Phase' ? '3-Phase' : (b.phase === 'Single-Phase' ? 'Single-Phase' : existing[0].phase),
          b.maxLoadKw != null && b.maxLoadKw !== '' ? Number(b.maxLoadKw) : (b.maxLoadKw === '' ? null : existing[0].max_load_kw),
          b.snmpCommunity != null ? clip(b.snmpCommunity, 100) : existing[0].snmp_community,
          b.powerOid != null ? clip(b.powerOid, 100) : existing[0].power_oid,
          b.powerScale != null && b.powerScale !== '' ? Number(b.powerScale) : existing[0].power_scale, req.params.id]
      );
      auditLog(req, 'PDU_UPDATE', { entity: 'pdu', entityId: req.params.id, site: b.site || existing[0].site });
      const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [req.params.id]);
      res.json(mapPdu(rows[0]));
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A PDU with this IP address and chain unit already exists.' });
      sendErr(res, e);
    }
  });

  app.delete('/api/pdus/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT site FROM pdus WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'PDU not found' });
      await assertSiteAccess(req.user, existing[0].site);
      await pool.query('DELETE FROM pdus WHERE id = ?', [req.params.id]);
      auditLog(req, 'PDU_DELETE', { entity: 'pdu', entityId: req.params.id, site: existing[0].site });
      res.json({ ok: true });
    } catch (e) { sendErr(res, e); }
  });

  // ---- bulk import: same dry-run-then-commit shape as /api/connectivity/import ----
  // Matched by IP address (the pdus table's one unique key): a row whose IP already
  // exists is treated as an update to that PDU, not a duplicate to reject - this lets
  // the same sheet be used both to add new PDUs and to bulk-correct existing ones.
  app.post('/api/pdus/import', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const dryRun = req.body.dryRun !== false;
      const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'rows[] is required' });
      if (rows.length > 2000) return res.status(400).json({ error: 'Too many rows (max 2000 per import)' });
      const allowed = await getAllowedSitesForUser(req.user);
      const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 255);
      const counts = { total: rows.length, ready: 0, invalid: 0, deniedSite: 0, duplicateInFile: 0, created: 0, updated: 0 };
      const issues = [];
      const seenIp = new Set();
      const toSave = [];
      rows.forEach((r, idx) => {
        const rowNo = (r && Number(r.rowNo)) || idx + 2;
        const site = clean(r && r.site, 50), rackNo = clean(r && r.rackNo, 20), ip = clean(r && r.ipAddress, 100);
        const feedLabel = clean(r && r.feedLabel, 20) || 'Feed A';
        if (!site || !rackNo || !ip) { counts.invalid++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'invalid', message: 'Site, Rack No and IP Address are required - row skipped' }); return; }
        if (!allowed.includes(site)) { counts.deniedSite++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'denied', message: `Access denied for site "${site}" - row skipped` }); return; }
        const unitRaw = r && (r.chainUnit != null ? r.chainUnit : '');
        const unit = String(unitRaw).trim() === '' ? 0 : Number(unitRaw);
        if (!Number.isInteger(unit) || unit < 0 || unit > CHAIN_MAX) { counts.invalid++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'invalid', message: `Chain Unit must be 1 to ${CHAIN_MAX} (or empty for a single PDU) - row skipped` }); return; }
        const ipKey = ip.toLowerCase() + '|' + unit;
        if (seenIp.has(ipKey)) { counts.duplicateInFile++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'duplicate_in_file', message: unit ? `Unit ${unit} of this IP appears again in the sheet - only the first row is used` : 'Same IP appears again in the sheet - only the first row is used (give each chained PDU its own Chain Unit number)' }); return; }
        seenIp.add(ipKey);
        counts.ready++;
        toSave.push({
          site, zone: clean(r.zone, 20) || 'AZ-1', rackType: clean(r.rackType, 50) || null, rackNo, feedLabel, ipAddress: ip, chainUnit: unit,
          vendor: clean(r.vendor, 50) || null, model: clean(r.model, 150) || null, serialNumber: clean(r.serialNumber, 150) || null,
          firmware: clean(r.firmware, 100) || null, phase: String(r.phase || '').trim() === '3-Phase' ? '3-Phase' : 'Single-Phase',
          maxLoadKw: r.maxLoadKw != null && r.maxLoadKw !== '' && !isNaN(Number(r.maxLoadKw)) ? Number(r.maxLoadKw) : null,
          snmpCommunity: clean(r.snmpCommunity, 100) || 'public', powerOid: clean(r.powerOid, 100) || null,
          powerScale: r.powerScale !== undefined && r.powerScale !== '' && !isNaN(Number(r.powerScale)) ? Number(r.powerScale) : 1,
        });
      });
      if (dryRun) return res.json({ dryRun: true, counts, issues });
      if (!toSave.length) return res.json({ dryRun: false, counts, issues });
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const row of toSave) {
          const [existing] = await conn.query('SELECT id FROM pdus WHERE ip_address = ? AND chain_unit = ?', [row.ipAddress, row.chainUnit]);
          if (existing.length) {
            await conn.query(
              `UPDATE pdus SET site=?, zone=?, rack_type=?, rack_no=?, feed_label=?, vendor=?, model=?, serial_number=?,
                 firmware=?, phase=?, max_load_kw=?, snmp_community=?, power_oid=?, power_scale=? WHERE ip_address=? AND chain_unit=?`,
              [row.site, row.zone, row.rackType, row.rackNo, row.feedLabel, row.vendor, row.model, row.serialNumber,
                row.firmware, row.phase, row.maxLoadKw, row.snmpCommunity, row.powerOid, row.powerScale, row.ipAddress, row.chainUnit]
            );
            counts.updated++;
          } else {
            await conn.query(
              `INSERT INTO pdus (id, site, zone, rack_type, rack_no, feed_label, ip_address, chain_unit, vendor, model, serial_number, firmware, phase, max_load_kw, snmp_community, power_oid, power_scale)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [genId('PDU'), row.site, row.zone, row.rackType, row.rackNo, row.feedLabel, row.ipAddress, row.chainUnit, row.vendor, row.model,
                row.serialNumber, row.firmware, row.phase, row.maxLoadKw, row.snmpCommunity, row.powerOid, row.powerScale]
            );
            counts.created++;
          }
        }
        await conn.commit();
      } catch (e) { try { await conn.rollback(); } catch (e2) { /* ignore */ } throw e; }
      finally { conn.release(); }
      auditLog(req, 'PDU_IMPORT', { entity: 'pdu', created: counts.created, updated: counts.updated });
      res.json({ dryRun: false, counts, issues });
    } catch (e) { sendErr(res, e); }
  });

  // ---- auto-detect: probe a not-yet-saved IP via SNMP, return best-effort identity fields ----
  // One step for a whole daisy chain: the person gives the HOST's IP and the host's Display ID; every PDU behind that IP is read
  // from the host and added (grouped by the shared IP). PDUs already present for this IP are left alone.
  // Live circuit details for one PDU: name, feed (from the name), load and every phase / bank (breaker circuit).
  app.get('/api/pdus/:id/details', authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'PDU not found' });
      const pdu = rows[0];
      await assertSiteAccess(req.user, pdu.site);
      const ip = pdu.ip_address, community = pdu.snmp_community || 'public', unit = Number(pdu.chain_unit) > 0 ? Number(pdu.chain_unit) : 1;
      const out = { id: pdu.id, ipAddress: ip, chainUnit: Number(pdu.chain_unit) || 0, storedFeed: pdu.feed_label, storedRack: pdu.rack_no, vendor: pdu.vendor, model: pdu.model,
        phase: pdu.phase, maxLoadKw: pdu.max_load_kw != null ? Number(pdu.max_load_kw) : null, readAt: new Date().toISOString(), reachable: false, supported: false };
      const base = ['1.3.6.1.2.1.1.5.0', APC_PROPS_TABLE + '.3.' + unit, '1.3.6.1.4.1.318.1.1.26.4.3.1.4.' + unit, '1.3.6.1.4.1.318.1.1.26.4.3.1.5.' + unit, '1.3.6.1.4.1.318.1.1.26.4.3.1.6.' + unit,
        '1.3.6.1.4.1.318.1.1.26.4.3.1.16.' + unit, '1.3.6.1.4.1.318.1.1.26.4.3.1.17.' + unit, '1.3.6.1.4.1.318.1.1.26.4.3.1.20.' + unit, '1.3.6.1.4.1.318.1.1.26.4.3.1.2.' + unit];
      let g;
      try { g = await snmpGetEach(ip, community, base, 6000); }
      catch (e) { out.error = 'Could not read the PDU: ' + e.message; return res.json(out); }
      out.reachable = true;
      const name = snmpStr(g[base[1]]) || snmpStr(g[base[0]]);
      const dd = describeDevice('', name);
      out.displayId = Number.isFinite(Number(g[base[8]])) && Number(g[base[8]]) > 0 ? Number(g[base[8]]) : null; out.name = name || null; out.feedFromName = dd.feedHint; out.rackFromName = dd.rackHint;
      const num = (v, div) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) / div : null);
      const apc = !!pdu.vendor && /apc|schneider/i.test(pdu.vendor) || g[base[2]] !== undefined;
      if (apc) {
        out.supported = true;
        out.loadState = LOAD_STATES[Number(g[base[2]])] || null; out.powerKw = num(g[base[3]], 100); out.peakKw = num(g[base[4]], 100);
        out.apparentKva = num(g[base[5]], 100); out.powerFactor = num(g[base[6]], 100); out.frequencyHz = num(g[base[7]], 10);
        const [phSt, phCf, bkSt, bkCf] = await Promise.all([APC_PHASE_STATUS, APC_PHASE_CONFIG, APC_BANK_STATUS, APC_BANK_CONFIG].map((o) => snmpSubtree(ip, community, o, 5000).catch(() => ({}))));
        const ph = buildCircuits(phSt, APC_PHASE_STATUS, phCf, APC_PHASE_CONFIG, unit), bk = buildCircuits(bkSt, APC_BANK_STATUS, bkCf, APC_BANK_CONFIG, unit);
        out.phases = ph.items; out.banks = bk.items; out.moduleMatched = ph.moduleMatched && bk.moduleMatched;
      }
      res.json(out);
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/pdus/chain', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const b = req.body || {};
      for (const k of ['site', 'zone', 'rackNo', 'feedLabel', 'ipAddress']) if (typeof b[k] === 'string') b[k] = b[k].replace(/\s+/g, ' ').trim();
      for (const f of ['site', 'rackNo', 'feedLabel', 'ipAddress']) if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `"${f}" is required.` });
      await assertSiteAccess(req.user, b.site);
      const hostUnit = b.hostUnit === '' || b.hostUnit == null ? 1 : Number(b.hostUnit);
      if (!Number.isInteger(hostUnit) || hostUnit < 1 || hostUnit > CHAIN_MAX) return res.status(400).json({ error: `"Host Display ID" must be 1 to ${CHAIN_MAX}.` });
      let units;
      try { units = await discoverChain(b.ipAddress, b.snmpCommunity || 'public'); }
      catch (e) { return res.status(400).json({ error: `Could not read the chain from ${b.ipAddress} (${e.message}). Check the IP and the SNMP community.` }); }
      if (!units.length) return res.status(400).json({ error: 'This device did not list any chained PDUs (only APC Rack PDU 2G units publish a chain list). Add it as a single PDU instead.' });
      if (!units.some((u) => u.unit === hostUnit)) return res.status(400).json({ error: `Display ID ${hostUnit} is not in this chain. The chain has PDUs numbered: ${units.map((u) => u.unit).join(', ')}.` });
      const num = (v) => (v != null && v !== '' ? Number(v) : null);
      const created = [], skipped = [];
      for (const u of units) {
        const host = u.unit === hostUnit;
        const [dup] = await pool.query('SELECT id FROM pdus WHERE ip_address = ? AND chain_unit = ?', [b.ipAddress, u.unit]);
        if (dup.length) { skipped.push(u.unit); continue; }
        if (host) { // a host saved earlier as a single PDU (empty chain unit) becomes this chain's host instead of being duplicated
          const [single] = await pool.query('SELECT id FROM pdus WHERE ip_address = ? AND chain_unit = 0 LIMIT 1', [b.ipAddress]);
          if (single.length) { await pool.query('UPDATE pdus SET chain_unit = ? WHERE id = ?', [u.unit, single[0].id]); skipped.push(u.unit); continue; }
        }
        const id = genId('PDU');
        const rackNo = host ? b.rackNo : (u.rackHint || b.rackNo);
        const feed = host ? b.feedLabel : (u.feedHint || b.feedLabel);
        await pool.query(
          `INSERT INTO pdus (id, site, zone, rack_type, rack_no, feed_label, ip_address, chain_unit, vendor, model, serial_number, firmware, phase, max_load_kw, snmp_community, power_oid, power_scale)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, b.site, clip(b.zone || 'AZ-1', 20), clip(b.rackType || null, 50), clip(rackNo, 20), clip(feed, 20), b.ipAddress, u.unit, clip(b.vendor || 'APC / Schneider Electric', 50),
            clip((host && b.model) || u.model || b.model || null, 150), clip((host && b.serialNumber) || u.serialNumber || null, 150), clip((host && b.firmware) || u.firmware || b.firmware || null, 100),
            (host && b.phase) ? (b.phase === '3-Phase' ? '3-Phase' : 'Single-Phase') : (u.phase || (b.phase === '3-Phase' ? '3-Phase' : 'Single-Phase')),
            host ? (num(b.maxLoadKw) != null ? num(b.maxLoadKw) : u.maxLoadKw) : (u.maxLoadKw != null ? u.maxLoadKw : num(b.maxLoadKw)),
            clip(b.snmpCommunity || 'public', 100), clip(b.powerOid || null, 100), b.powerScale != null && b.powerScale !== '' ? Number(b.powerScale) : 1]);
        created.push({ unit: u.unit, name: u.name, rackNo, serialNumber: u.serialNumber });
      }
      auditLog(req, 'PDU_CHAIN_CREATE', { entity: 'pdu', site: b.site, details: { ip: b.ipAddress, found: units.length, created: created.length } });
      res.status(201).json({ ok: true, found: units.length, created: created.length, skipped: skipped.length, units: created });
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/pdus/detect', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    const { ipAddress, snmpCommunity, chainUnit } = req.body || {};
    if (!ipAddress) return res.status(400).json({ error: '"ipAddress" is required.' });
    try {
      const out = await snmpGet(ipAddress, snmpCommunity || 'public', [OID_SYS_DESCR, OID_SYS_NAME]);
      const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
      const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
      const vendor = guessVendor(descr);
      const dd = describeDevice(descr, name);
      const phase = await detectPhase(vendor, ipAddress, snmpCommunity || 'public', chainUnit);
      let chain = null;
      if (req.body && req.body.scanChain && vendor && /apc/i.test(vendor)) { try { chain = await discoverChain(ipAddress, snmpCommunity || 'public'); } catch (e) { chain = null; } }
      const maxLoadCfg = vendor && MAX_LOAD_BY_VENDOR[vendor];
      const maxLoadKw = maxLoadCfg ? await detectMaxLoadKw(vendor, ipAddress, snmpCommunity || 'public') : null;
      res.json({
        reachable: true,
        vendor, model: dd.model, serialNumber: dd.serialNumber, firmware: dd.firmware, pduName: dd.pduName, rackHint: dd.rackHint, feedHint: dd.feedHint, phase, chain,
        maxLoadKw,
        maxLoadNote: maxLoadCfg ? (maxLoadKw != null ? `Max Load detected via ${maxLoadCfg.confidence} confidence source: ${maxLoadCfg.note}` : `Could not read a rated-capacity value from this device right now - ${maxLoadCfg.note}`) : null,
        note: 'Vendor/Model/Firmware are parsed from the device\'s generic SNMP sysDescr/sysName, which varies by vendor and is not always reliable - review and correct every field before saving. Max Load is only auto-filled for a handful of vendors with a confirmed SNMP capacity value (see maxLoadNote); for everything else it stays manual. Live wattage polling additionally needs a Power OID from this model\'s vendor MIB/datasheet (set it in the Power OID field); without one, this PDU is still monitored for online/offline reachability only.',
      });
    } catch (e) {
      res.json({ reachable: false, error: 'Could not reach ' + ipAddress + ' via SNMP (' + (e && e.message || 'timeout') + '). Check the IP, that SNMP is enabled on the device, and the community string.' });
    }
  });

  // ---- IP-range discovery: read-only scan + report, nothing is saved here (see /discover/apply and /import) ----
  app.post('/api/pdus/discover', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const allowed = await getAllowedSitesForUser(req.user);
      const ranges = parseDiscoveryRanges(log).filter((r) => allowed.includes(r.site));
      if (!ranges.length) return res.status(400).json({ error: 'No PDU_DISCOVERY_RANGES configured in .env for your site(s). Ask an admin to set it (see .env.example).' });
      const community = process.env.PDU_DISCOVERY_COMMUNITY || 'public';
      const hosts = []; // { ip, site, zone }
      const seenIp = new Set();
      for (const r of ranges) {
        for (let n = r.startInt; n <= r.endInt && hosts.length < DISCOVERY_MAX_HOSTS; n++) {
          const ip = intToIp(n);
          if (seenIp.has(ip)) continue;
          seenIp.add(ip);
          hosts.push({ ip, site: r.site, zone: r.zone });
        }
        if (hosts.length >= DISCOVERY_MAX_HOSTS) { log.warn(`[pdu-discovery] stopped at DISCOVERY_MAX_HOSTS=${DISCOVERY_MAX_HOSTS} - narrow PDU_DISCOVERY_RANGES if you need to scan more`); break; }
      }
      const [existingRows] = await pool.query('SELECT * FROM pdus WHERE site IN (?)', [ranges.map((r) => r.site)]);
      const byIp = new Map(existingRows.map((r) => [r.ip_address, r]));

      const results = await mapWithConcurrency(hosts, DISCOVERY_CONCURRENCY, async (h) => {
        try {
          const out = await snmpGet(h.ip, community, [OID_SYS_DESCR, OID_SYS_NAME], DISCOVERY_TIMEOUT_MS);
          const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
          const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
          const vendor = guessVendor(descr);
          const maxLoadKw = vendor && MAX_LOAD_BY_VENDOR[vendor] ? await detectMaxLoadKw(vendor, h.ip, community) : null;
          return { ...h, reachable: true, detected: { vendor, ...pickDevice(descr, name), maxLoadKw } };
        } catch (e) { return { ...h, reachable: false }; }
      });

      const enrichable = [], unreachable = [], newFound = [];
      let alreadyComplete = 0, scanned = results.length;
      for (const r of results) {
        const existing = byIp.get(r.ip);
        if (existing) {
          if (!r.reachable) { unreachable.push({ id: existing.id, ipAddress: r.ip, site: existing.site, zone: existing.zone, rackNo: existing.rack_no, feedLabel: existing.feed_label }); continue; }
          const missing = !existing.vendor || !existing.model || !existing.serial_number || !existing.firmware || (!existing.max_load_kw && r.detected.maxLoadKw != null);
          if (missing) enrichable.push({ id: existing.id, ipAddress: r.ip, site: existing.site, zone: existing.zone, rackNo: existing.rack_no, feedLabel: existing.feed_label, current: { vendor: existing.vendor, model: existing.model, serialNumber: existing.serial_number, firmware: existing.firmware, maxLoadKw: existing.max_load_kw }, detected: r.detected });
          else alreadyComplete++;
        } else if (r.reachable) {
          newFound.push({ ipAddress: r.ip, site: r.site, zone: r.zone, detected: r.detected });
        }
      }
      res.json({ scanned, ranges: ranges.map((r) => ({ startIp: r.startIp, endIp: r.endIp, site: r.site, zone: r.zone })), enrichable, unreachable, newFound, alreadyComplete });
    } catch (e) { sendErr(res, e); }
  });

  // ---- apply discovered identity to existing PDUs: only fills fields that are currently blank, never overwrites admin-entered data ----
  app.post('/api/pdus/discover/apply', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 200) : [];
      if (!ids.length) return res.status(400).json({ error: '"ids" (array) is required.' });
      const community = process.env.PDU_DISCOVERY_COMMUNITY || 'public';
      const results = await mapWithConcurrency(ids, DISCOVERY_CONCURRENCY, async (id) => {
        try {
          const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [id]);
          if (!rows.length) return { id, applied: false, error: 'PDU not found' };
          const pdu = rows[0];
          await assertSiteAccess(req.user, pdu.site);
          const out = await snmpGet(pdu.ip_address, pdu.snmp_community || community, [OID_SYS_DESCR, OID_SYS_NAME], DISCOVERY_TIMEOUT_MS);
          const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
          const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
          const vendor = guessVendor(descr);
          const detected = { vendor, ...pickDevice(descr, name) };
          const vendorForCapacity = pdu.vendor || vendor;
          const maxLoadKw = !pdu.max_load_kw && vendorForCapacity && MAX_LOAD_BY_VENDOR[vendorForCapacity]
            ? await detectMaxLoadKw(vendorForCapacity, pdu.ip_address, pdu.snmp_community || community) : null;
          await pool.query(
            `UPDATE pdus SET vendor = COALESCE(NULLIF(vendor,''), ?), model = COALESCE(NULLIF(model,''), ?),
               serial_number = COALESCE(NULLIF(serial_number,''), ?), firmware = COALESCE(NULLIF(firmware,''), ?),
               max_load_kw = COALESCE(max_load_kw, ?) WHERE id = ?`,
            [detected.vendor, detected.model, detected.serialNumber, detected.firmware, maxLoadKw, id]
          );
          auditLog(req, 'PDU_DISCOVER_APPLY', { entity: 'pdu', entityId: id, site: pdu.site });
          return { id, applied: true };
        } catch (e) { return { id, applied: false, error: e.message || 'Could not reach device' }; }
      });
      res.json({ results });
    } catch (e) { sendErr(res, e); }
  });

  // ---- poll one PDU (reachability always; wattage only if power_oid is configured) ----
  // Also opportunistically fills in vendor/model/serial/firmware if any are still blank,
  // from the same sysDescr/sysName this poll already fetches for reachability - so a PDU
  // added via bulk import or Add PDU with only Site/Rack/IP filled in gets its identity
  // captured automatically on the next sync, no separate "Discover" step required. Same
  // never-overwrite rule as /api/pdus/discover/apply: only fields that are currently blank
  // are touched.
  async function pollOne(pdu, shared) {
    const eOid = effectiveOid(pdu);
    const unit = Number(pdu.chain_unit) || 0;
    const oids = [OID_SYS_DESCR, OID_SYS_NAME];
    if (eOid) oids.push(eOid);
    let status = 'offline', lastError = null, powerKw = null, detected = null, detectedMaxLoadKw = null;
    try {
      let out;
      if (shared) { if (shared.error) throw shared.error; out = shared.out; }
      else out = await snmpGet(pdu.ip_address, pdu.snmp_community || 'public', oids);
      status = 'online';
      const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
      const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
      detected = { vendor: guessVendor(descr), ...pickDevice(descr, name) };
      // Max Load is a fixed, nameplate-style value, so only worth the extra SNMP round
      // trip while it's still blank - once filled (by this, Edit PDU, or Discover) it's
      // never re-fetched. Uses the DB's own vendor if already known, falling back to
      // what sysDescr just identified for a brand-new PDU on its very first poll.
      if (!pdu.max_load_kw) {
        const vendorForCapacity = pdu.vendor || detected.vendor;
        if (vendorForCapacity && MAX_LOAD_BY_VENDOR[vendorForCapacity]) {
          detectedMaxLoadKw = await detectMaxLoadKw(vendorForCapacity, pdu.ip_address, pdu.snmp_community || 'public', unit);
        }
      }
      if (eOid) {
        const raw = out[eOid];
        const n = typeof raw === 'number' ? raw : parseFloat(raw);
        if (raw === undefined && unit > 0) {
          status = 'warning'; lastError = `Unit ${unit} of this chain did not answer - check that PDU number ${unit} (its Display ID on APC units) is connected to the host.`;
        } else if (Number.isFinite(n) && n < 0) {
          lastError = 'This PDU reports power as not supported (-1) - it has no load metering.';
        } else if (Number.isFinite(n)) {
          // raw SNMP value x power_scale = Watts (set from the vendor preset, or
          // manually) - never guessed per-poll, since vendors report in different
          // units (W, hundredths of kW, etc) and a wrong guess silently corrupts
          // every reading. power_scale defaults to 1 (raw value already in Watts).
          const watts = n * Number(pdu.power_scale || 1);
          powerKw = watts / 1000;
          if (pdu.max_load_kw && powerKw > Number(pdu.max_load_kw) * 1.5) {
            status = 'warning'; lastError = 'Reading far exceeds Max Load - verify the Power OID is correct for this model.';
          }
        } else { lastError = 'Power OID returned a non-numeric value - verify it is correct for this model.'; }
      } else {
        lastError = 'No Power OID configured - reachable, but live wattage is not available until one is set in Edit PDU.';
      }
    } catch (e) {
      if (unit > 0 && e && /NoSuch/i.test(e.message || '')) { status = 'warning'; lastError = `Unit ${unit} of this chain did not answer - check that PDU number ${unit} (its Display ID on APC units) is connected to the host.`; }
      else { status = 'offline'; lastError = 'Unreachable: ' + (e && e.message || 'timeout'); }
    }
    if (detected) {
      await pool.query(
        `UPDATE pdus SET status=?, last_power_kw=?, last_reading_at=NOW(), last_error=?,
           vendor = COALESCE(NULLIF(vendor,''), ?), model = COALESCE(NULLIF(model,''), ?),
           serial_number = COALESCE(NULLIF(serial_number,''), ?), firmware = COALESCE(NULLIF(firmware,''), ?),
           max_load_kw = COALESCE(max_load_kw, ?)
         WHERE id=?`,
        [status, powerKw, lastError, detected.vendor, detected.model, detected.serialNumber, detected.firmware, detectedMaxLoadKw, pdu.id]
      );
    } else {
      await pool.query(
        'UPDATE pdus SET status=?, last_power_kw=?, last_reading_at=NOW(), last_error=? WHERE id=?',
        [status, powerKw, lastError, pdu.id]
      );
    }
    if (powerKw != null) {
      const today = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO power_readings (pdu_id, site, zone, reading_date, avg_kw, peak_kw, energy_kwh, sample_count)
         VALUES (?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE
           avg_kw = (avg_kw * sample_count + VALUES(avg_kw)) / (sample_count + 1),
           peak_kw = GREATEST(peak_kw, VALUES(peak_kw)),
           energy_kwh = energy_kwh + (VALUES(avg_kw) * (? / 3600.0)),
           sample_count = sample_count + 1`,
        [pdu.id, pdu.site, pdu.zone, today, powerKw, powerKw, powerKw, pdu.poll_interval_sec || 900, pdu.poll_interval_sec || 900]
      );
    }
    return { id: pdu.id, status, powerKw, lastError };
  }

  async function pollAllPdus(siteFilter) {
    const conditions = [], params = [];
    if (siteFilter && siteFilter.length) { conditions.push('site IN (' + siteFilter.map(() => '?').join(',') + ')'); params.push(...siteFilter); }
    let sql = 'SELECT * FROM pdus';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    const [rows] = await pool.query(sql, params);
    // PDUs behind one IP (daisy chain) are read with ONE request to that IP, then split per unit.
    const groups = new Map();
    for (const r of rows) { const k = r.ip_address + '|' + (r.snmp_community || 'public'); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    const results = (await Promise.all([...groups.values()].map(async (grp) => {
      let shared = null;
      if (grp.length > 1) {
        const oids = [OID_SYS_DESCR, OID_SYS_NAME, ...new Set(grp.map(effectiveOid).filter(Boolean))];
        try { shared = { out: await snmpGetEach(grp[0].ip_address, grp[0].snmp_community || 'public', oids) }; } catch (e) { shared = null; /* e.g. SNMP v1 refuses the whole request when one unit is absent: read each PDU on its own */ }
      }
      const polled = await Promise.all(grp.map((r) => pollOne(r, shared).catch((e) => ({ id: r.id, status: 'offline', lastError: e.message }))));
      // Health: bank / phase load against the PDU's own limits (APC Rack PDU 2G). One read of the host covers every PDU of its chain.
      try {
        const live = grp.filter((r) => { const pr = polled.find((x) => x && x.id === r.id); return pr && pr.status !== 'offline' && /apc|schneider/i.test(r.vendor || ''); });
        if (live.length) {
          const tables = await readCircuitTables(live[0].ip_address, live[0].snmp_community || 'public');
          for (const r of live) {
            const h = unitHealth(tables, Number(r.chain_unit) > 0 ? Number(r.chain_unit) : 1, !(Number(r.chain_unit) > 0));
            if (h) await pool.query('UPDATE pdus SET health=?, health_detail=?, health_at=NOW() WHERE id=?', [h.level, h.detail, r.id]);
            else await pool.query('UPDATE pdus SET health=NULL, health_detail=NULL, health_at=NULL WHERE id=?', [r.id]);
          }
        }
      } catch (e) { /* health is best-effort: a PDU that cannot list its circuits keeps its last health */ }
      return polled;
    }))).flat();
    log.info(`[pdu] polled ${results.length} PDU(s): ${results.filter((r) => r.status === 'online').length} online`);
    return results;
  }

  app.post('/api/pdus/sync-all', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const allowed = await getAllowedSitesForUser(req.user);
      const all = allowed; // empty array (no access) correctly polls nothing, never everything
      const results = await pollAllPdus(all.length ? all : ['__none__']);
      auditLog(req, 'PDU_SYNC_ALL', { entity: 'pdu', details: { count: results.length } });
      res.json({ ok: true, synced: results.length, online: results.filter((r) => r.status === 'online').length });
    } catch (e) { sendErr(res, e); }
  });

  // ---- Dashboard summary: total load per site (+ overall), site-scoped ----
  app.get('/api/pdus/summary', authenticateToken, async (req, res) => {
    try {
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      await applySiteScope(allowed, conditions, params);
      let sql = 'SELECT site, COUNT(*) AS pdu_count, SUM(last_power_kw) AS total_kw, SUM(max_load_kw) AS rated_kw, SUM(CASE WHEN status="online" THEN 1 ELSE 0 END) AS online_count FROM pdus';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' GROUP BY site';
      const [rows] = await pool.query(sql, params);
      const bySite = rows.map((r) => ({
        site: r.site, pduCount: Number(r.pdu_count) || 0, onlineCount: Number(r.online_count) || 0,
        totalKw: r.total_kw != null ? Number(r.total_kw) : 0, ratedKw: r.rated_kw != null ? Number(r.rated_kw) : 0,
      }));
      const overall = bySite.reduce((a, s) => ({ totalKw: a.totalKw + s.totalKw, ratedKw: a.ratedKw + s.ratedKw, pduCount: a.pduCount + s.pduCount, onlineCount: a.onlineCount + s.onlineCount }), { totalKw: 0, ratedKw: 0, pduCount: 0, onlineCount: 0 });
      res.json({ bySite, overall });
    } catch (e) { sendErr(res, e); }
  });

  // ---- date-wise trend for a site/zone scope ----
  app.get('/api/pdus/trend', authenticateToken, async (req, res) => {
    try {
      const { site, zone, from, to } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      if (zone && zone !== 'all') { conditions.push('zone = ?'); params.push(zone); }
      if (from) { conditions.push('reading_date >= ?'); params.push(from); }
      if (to) { conditions.push('reading_date <= ?'); params.push(to); }
      let sql = 'SELECT reading_date, SUM(avg_kw) AS avg_kw, SUM(peak_kw) AS peak_kw, SUM(energy_kwh) AS energy_kwh FROM power_readings';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' GROUP BY reading_date ORDER BY reading_date';
      const [rows] = await pool.query(sql, params);
      res.json(rows.map((r) => ({
        date: r.reading_date instanceof Date ? r.reading_date.toISOString().slice(0, 10) : String(r.reading_date),
        avgKw: r.avg_kw != null ? Number(r.avg_kw) : 0, peakKw: r.peak_kw != null ? Number(r.peak_kw) : 0,
        energyKwh: r.energy_kwh != null ? Number(r.energy_kwh) : 0,
      })));
    } catch (e) { sendErr(res, e); }
  });

  return { ensureSchema, pollAllPdus };
};
module.exports._effectiveOid = effectiveOid; // exposed for tests only
module.exports._describeDevice = describeDevice; // exposed for tests only
module.exports._phaseFromCount = phaseFromCount; // exposed for tests only
module.exports._parseChainTables = parseChainTables; // exposed for tests only
module.exports._buildCircuits = buildCircuits; // exposed for tests only
module.exports._healthFromCircuits = healthFromCircuits; // exposed for tests only
