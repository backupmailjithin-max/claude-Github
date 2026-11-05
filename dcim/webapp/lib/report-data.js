'use strict';
// Monthly management report - data layer.
//
// The report answers "what changed this month compared with last month". Two kinds of figures are used:
//   * EVENT figures (issues raised/closed, material in/out, DC activities, visits, peak power, devices added) can be rebuilt for any
//     past month straight from dated records, so they are always available.
//   * STATE figures (devices installed, rack U used, hardware mix, firmware compliance, servers online ...) describe "how things stood at
//     month end". The database only knows how things stand NOW, so a small snapshot is saved per location per month
//     (table report_snapshots). A month without a snapshot shows "-" instead of an invented number.
// Nothing here writes to any existing table.

const SNAP_TABLE = 'report_snapshots';
const MONTHS_BACK = 6;

const pad = (n) => String(n).padStart(2, '0');
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isMonthKey(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')); }
function monthKeyOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return monthKeyOf(d);
}
function monthLabel(key) { const [y, m] = key.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; }
function monthShort(key) { const [, m] = key.split('-').map(Number); return SHORT[m - 1]; }
function monthStart(key) { return `${key}-01`; }
function monthEndExcl(key) { return `${addMonths(key, 1)}-01`; }
function dstr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const inMonth = (v, key) => { const s = dstr(v); return !!s && s >= monthStart(key) && s < monthEndExcl(key); };
const before = (v, dateExcl) => { const s = dstr(v); return !!s && s < dateExcl; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---- same rules the Overall Summary uses in the browser ----
function parseU(pos) {
  const s = String(pos || '').trim();
  let m = s.match(/^U?\s*(\d+)\s*U?\s*-\s*U?\s*(\d+)\s*U?$/i); if (m) return parseInt(m[1], 10);
  m = s.match(/^U\s?(\d+)$/i); if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)\s?U$/i); if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)$/); if (m) return parseInt(m[1], 10);
  return null;
}
function parseHeight(h) {
  const s = String(h || '').trim();
  let m = s.match(/^(\d+)\s?U$/i); if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)$/); if (m) return parseInt(m[1], 10);
  return 0;
}
function makeLabel(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'Unknown';
  if (/^dell|\bome\b/i.test(t)) return 'Dell';
  if (/^hp\b|^hpe\b|hewlett|oneview/i.test(t)) return 'HP';
  const c = t.replace(/[,.]/g, ' ').replace(/\b(inc|corp|corporation|ltd|limited|llc|co|company|technologies|technology|systems)\b/ig, ' ').replace(/\s+/g, ' ').trim();
  return c || t;
}
function issueClosedAt(i) {
  // The date an issue stopped being "open" (same labels the Issue Tracker treats as closed).
  const c = [i.cancelled_date, i.partRequiredStore ? i.moved_to_store_date : null, i.partRequiredStore ? i.returned_to_oem_date : null, i.completed_date]
    .map(dstr).filter(Boolean).sort();
  return c.length ? c[0] : '';
}

function qs(sites) { return sites.map(() => '?').join(','); }

// ------------------------------------------------------------------ state (snapshot) ------------------------------------------------------------------
async function computeState(pool, sites) {
  const out = {};
  for (const s of sites) out[s] = null;
  if (!sites.length) return out;
  const [racks] = await pool.query(`SELECT site, zone, rack_no, u_size FROM racks WHERE site IN (${qs(sites)})`, sites);
  const [assets] = await pool.query(
    `SELECT site, zone, rack_no, position, height, manufacturer, model, hardware_type, lifecycle_status, power_state, mgmt_ip, last_redfish_error, bios_version, redfish_monitor_ignored
       FROM assets WHERE site IN (${qs(sites)})`, sites);
  const [comps] = await pool.query(`SELECT site, zone, rack_no, position, height FROM rack_components WHERE site IN (${qs(sites)})`, sites).catch(() => [[]]);
  const [targets] = await pool.query('SELECT vendor, model_key, target_version FROM firmware_model_targets').catch(() => [[]]);
  const [pduRows] = await pool.query(`SELECT site, zone, rack_no, status, last_power_kw, max_load_kw FROM pdus WHERE site IN (${qs(sites)})`, sites).catch(() => [[]]);
  const [pend] = await pool.query(`SELECT site, COUNT(*) c FROM material_movements WHERE status = 'Pending Approval' AND site IN (${qs(sites)}) GROUP BY site`, sites).catch(() => [[]]);
  let canonKey = (x) => String(x || '').toLowerCase();
  try { canonKey = require('./model-names').canonicalModelKey; } catch (e) { /* keep fallback */ }
  const tmap = new Map();
  for (const t of targets) tmap.set(`${t.vendor}|${t.model_key}`, String(t.target_version || '').trim().toLowerCase());

  for (const site of sites) {
    const rackMap = {};
    for (const r of racks.filter((x) => x.site === site)) {
      if (!r.rack_no) continue;
      rackMap[`${r.zone || 'AZ-1'}|${String(r.rack_no).trim().toUpperCase()}`] = { zone: r.zone || 'AZ-1', rack: String(r.rack_no).trim(), cap: num(r.u_size) || 42, used: 0 };
    }
    const act = assets.filter((a) => a.site === site && (a.lifecycle_status || 'Active') === 'Active');
    const feed = [...act, ...comps.filter((c) => c.site === site)];
    for (const a of feed) {
      if (!a.rack_no) continue;
      const key = `${a.zone || 'AZ-1'}|${String(a.rack_no).trim().toUpperCase()}`;
      if (!rackMap[key]) rackMap[key] = { zone: a.zone || 'AZ-1', rack: String(a.rack_no).trim(), cap: 42, used: 0 };
      if (parseU(a.position) != null) rackMap[key].used += parseHeight(a.height) || 1;
    }
    const rl = Object.values(rackMap);
    rl.forEach((r) => { r.used = Math.min(r.used, r.cap); });
    const zones = {};
    for (const r of rl) { const z = zones[r.zone] || (zones[r.zone] = { used: 0, total: 0, racks: 0 }); z.used += r.used; z.total += r.cap; z.racks += 1; }
    const make = {};
    for (const a of act) { const m = makeLabel(a.manufacturer); make[m] = (make[m] || 0) + 1; }
    const servers = act.filter((a) => /server/i.test(a.hardware_type || '') && a.mgmt_ip && !num(a.redfish_monitor_ignored));
    const known = servers.filter((a) => a.power_state);
    const fwChecked = []; let fwOk = 0;
    for (const a of act) {
      const vendor = /dell/i.test(a.manufacturer || '') ? 'ome' : /hp/i.test(a.manufacturer || '') ? 'oneview' : '';
      if (!vendor || !a.bios_version) continue;
      const tv = tmap.get(`${vendor}|${canonKey(a.model)}`);
      if (!tv) continue;
      fwChecked.push(a);
      if (String(a.bios_version).trim().toLowerCase() === tv) fwOk++;
    }
    out[site] = {
      devices: act.length,
      racks: rl.length,
      usedU: rl.reduce((n, r) => n + r.used, 0),
      totalU: rl.reduce((n, r) => n + r.cap, 0),
      inStore: assets.filter((a) => a.site === site && a.lifecycle_status === 'In Store').length,
      make,
      zones,
      racksHot: rl.filter((r) => r.cap && r.used / r.cap >= 0.85).map((r) => ({ zone: r.zone, rack: r.rack, pct: Math.round(r.used / r.cap * 100) })),
      servers: { total: servers.length, known: known.length, online: known.filter((a) => /^on$/i.test(a.power_state)).length,
        unreachable: servers.filter((a) => a.last_redfish_error).length },
      fw: { checked: fwChecked.length, ok: fwOk },
      pendingTransfers: num((pend.find((p) => p.site === site) || {}).c),
      power: powerState(pduRows.filter((p) => p.site === site)),
    };
  }
  return out;
}


// Same definitions as the PDU Capacity page: a rack is the group of PDU feeds with the same site/zone/rack; "fully redundant" = more than
// one feed and none offline; rack load % = load of its feeds / rated load of its feeds.
function powerState(rows) {
  if (!rows.length) return null;
  const racks = new Map();
  for (const p of rows) { const k = `${p.zone}|${p.rack_no}`; (racks.get(k) || racks.set(k, { rack: p.rack_no, feeds: [] }).get(k)).feeds.push(p); }
  let highest = null, redundant = 0;
  for (const r of racks.values()) {
    const kw = r.feeds.reduce((n, f) => n + num(f.last_power_kw), 0), rated = r.feeds.reduce((n, f) => n + num(f.max_load_kw), 0);
    const pct = rated > 0 ? Math.round(kw / rated * 100) : 0;
    if (!highest || pct > highest.pct) highest = { rack: r.rack, pct, kw: +kw.toFixed(1), rated: +rated.toFixed(1) };
    if (r.feeds.length > 1 && !r.feeds.some((f) => f.status === 'offline')) redundant++;
  }
  return { pdus: rows.length, online: rows.filter((p) => p.status === 'online').length, totalKw: +rows.reduce((n, p) => n + num(p.last_power_kw), 0).toFixed(2),
    ratedKw: +rows.reduce((n, p) => n + num(p.max_load_kw), 0).toFixed(2), racks: racks.size, redundant, highest };
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SNAP_TABLE} (
    site VARCHAR(50) NOT NULL, month CHAR(7) NOT NULL, data LONGTEXT, taken_at DATETIME NOT NULL,
    PRIMARY KEY (site, month)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Saves how every location stands today under the CURRENT month. Called daily by the scheduler and whenever a report is generated,
// so the last capture of a month is its month-end position. Past months are never overwritten once the month is over.
async function takeSnapshot(pool, sites, now = new Date()) {
  await ensureTable(pool);
  const key = monthKeyOf(now);
  const state = await computeState(pool, sites);
  for (const s of sites) {
    if (!state[s]) continue;
    await pool.query(`INSERT INTO ${SNAP_TABLE} (site, month, data, taken_at) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE data = VALUES(data), taken_at = VALUES(taken_at)`,
      [s, key, JSON.stringify(state[s])]);
  }
  return { month: key, sites: sites.length };
}

async function loadSnapshots(pool, sites, keys) {
  await ensureTable(pool);
  if (!sites.length) return {};
  const [rows] = await pool.query(`SELECT site, month, data, taken_at FROM ${SNAP_TABLE} WHERE site IN (${qs(sites)}) AND month IN (${qs(keys)})`, [...sites, ...keys]);
  const m = {};
  for (const r of rows) { try { const d = JSON.parse(r.data); d._takenAt = dstr(r.taken_at); (m[r.month] || (m[r.month] = {}))[r.site] = d; } catch (e) { /* ignore */ } }
  return m;
}

// ------------------------------------------------------------------ events ------------------------------------------------------------------
async function loadEvents(pool, sites, firstKey, lastKey) {
  const from = monthStart(firstKey), toExcl = monthEndExcl(lastKey);
  const P = qs(sites);
  const [issues] = await pool.query(
    `SELECT id, ticket_no, title, site, severity, part_required, reported_date, completed_date, cancelled_date, moved_to_store_date, returned_to_oem_date
       FROM issues WHERE site IN (${P})`, sites);
  const [mm] = await pool.query(
    `SELECT site, movement_type, item_name, quantity, movement_date, status FROM material_movements WHERE site IN (${P}) AND movement_date >= ? AND movement_date < ?`,
    [...sites, from, toExcl]);
  const [acts] = await pool.query(
    `SELECT site, activity_type, start_date, completion_date FROM dc_activities WHERE site IN (${P}) AND COALESCE(start_date, completion_date) >= ? AND COALESCE(start_date, completion_date) < ?`,
    [...sites, from, toExcl]);
  const [visits] = await pool.query(
    `SELECT site, status, visit_date FROM visitor_requests WHERE site IN (${P}) AND visit_date >= ? AND visit_date < ? AND status <> 'Rejected'`, [...sites, from, toExcl]);
  const [added] = await pool.query(
    `SELECT site, COALESCE(installation_date, DATE(created_at)) AS d FROM assets WHERE site IN (${P}) AND lifecycle_status = 'Active'
       AND COALESCE(installation_date, DATE(created_at)) >= ? AND COALESCE(installation_date, DATE(created_at)) < ?`, [...sites, from, toExcl]);
  const [removed] = await pool.query(
    `SELECT from_site AS site, to_site, DATE(movement_date) AS d FROM asset_movements WHERE from_site IN (${P}) AND (to_site IS NULL OR to_site = '' OR to_site <> from_site)
       AND movement_date >= ? AND movement_date < ?`, [...sites, from, toExcl]).catch(() => [[]]);
  const [pdus] = await pool.query(`SELECT id, site, zone, feed_label, rack_no, max_load_kw FROM pdus WHERE site IN (${P})`, sites).catch(() => [[]]);
  const [readings] = await pool.query(
    `SELECT pdu_id, site, reading_date, peak_kw FROM power_readings WHERE site IN (${P}) AND reading_date >= ? AND reading_date < ?`, [...sites, from, toExcl]).catch(() => [[]]);
  for (const i of issues) i.partRequiredStore = !!num(i.part_required);
  return { issues, mm, acts, visits, added, removed, pdus, readings };
}

function sumBySite(arr, sites, pick) {
  const o = {}; for (const s of sites) o[s] = 0;
  for (const a of arr) if (o[a.site] !== undefined) o[a.site] += pick ? pick(a) : 1;
  return o;
}

function monthEvents(ev, sites, key) {
  const start = monthStart(key), endExcl = monthEndExcl(key);
  const siteSet = new Set(sites);
  const iss = ev.issues.filter((i) => siteSet.has(i.site));
  const reported = iss.filter((i) => inMonth(i.reported_date, key));
  const closedInMonth = iss.filter((i) => { const c = issueClosedAt(i); return c && c >= start && c < endExcl; });
  const openAt = (dateExcl, sev) => iss.filter((i) => before(i.reported_date, dateExcl) && (!issueClosedAt(i) || issueClosedAt(i) >= dateExcl) && (!sev || i.severity === sev));
  const openEnd = openAt(endExcl), openStart = openAt(start);
  const mmSite = ev.mm.filter((m) => siteSet.has(m.site) && inMonth(m.movement_date, key));
  const items = (type) => {
    const o = new Map();
    for (const m of mmSite.filter((x) => x.movement_type === type)) {
      const k = String(m.item_name || '').trim() || '(unnamed)';
      o.set(k, (o.get(k) || 0) + (num(m.quantity) || 1));
    }
    return o;
  };
  const acts = new Map();
  for (const a of ev.acts.filter((x) => siteSet.has(x.site) && inMonth(x.start_date || x.completion_date, key))) {
    const t = String(a.activity_type || 'Other').trim() || 'Other'; acts.set(t, (acts.get(t) || 0) + 1);
  }
  // Power: highest total of daily feed peaks across the location(s) in the month; feeds at/above 80% of their rating.
  const pduById = new Map(ev.pdus.map((p) => [p.id, p]));
  const dayTot = new Map(); const feedPeak = new Map();
  for (const r of ev.readings.filter((x) => siteSet.has(x.site) && inMonth(x.reading_date, key))) {
    const d = dstr(r.reading_date); dayTot.set(d, (dayTot.get(d) || 0) + num(r.peak_kw));
    feedPeak.set(r.pdu_id, Math.max(feedPeak.get(r.pdu_id) || 0, num(r.peak_kw)));
  }
  const feedsHot = [];
  for (const [id, pk] of feedPeak) {
    const p = pduById.get(id); if (!p || !num(p.max_load_kw)) continue;
    const pct = pk / num(p.max_load_kw) * 100;
    if (pct >= 80) feedsHot.push({ site: p.site, name: `${p.site} ${p.zone || ''} ${p.feed_label || p.rack_no || p.id}`.replace(/\s+/g, ' ').trim(), pct: Math.round(pct), kw: +pk.toFixed(1) });
  }
  const oldestCritical = openEnd.filter((i) => i.severity === 'critical').sort((a, b) => dstr(a.reported_date).localeCompare(dstr(b.reported_date)))[0];
  return {
    reported: reported.length,
    resolved: closedInMonth.length,
    openEnd: openEnd.length,
    openStart: openStart.length,
    criticalEnd: openEnd.filter((i) => i.severity === 'critical').length,
    criticalStart: openStart.filter((i) => i.severity === 'critical').length,
    oldestCritical: oldestCritical ? { ticket: oldestCritical.ticket_no || oldestCritical.id, title: oldestCritical.title, since: dstr(oldestCritical.reported_date) } : null,
    inward: items('Inward'), outward: items('Outward'),
    inwardCount: mmSite.filter((x) => x.movement_type === 'Inward').length,
    outwardCount: mmSite.filter((x) => x.movement_type === 'Outward').length,
    acts,
    actTotal: [...acts.values()].reduce((a, b) => a + b, 0),
    visits: ev.visits.filter((v) => siteSet.has(v.site) && inMonth(v.visit_date, key)).length,
    added: ev.added.filter((a) => siteSet.has(a.site) && inMonth(a.d, key)).length,
    removed: ev.removed.filter((a) => siteSet.has(a.site) && inMonth(a.d, key)).length,
    peakKw: dayTot.size ? +Math.max(...dayTot.values()).toFixed(1) : null,
    feedsHot,
  };
}

// Combines per-location snapshots into one state object (or null when any requested location is missing - a half-total would mislead).
function mergeState(snapByLoc, sites) {
  if (!snapByLoc) return null;
  const parts = sites.map((s) => snapByLoc[s]);
  if (!parts.length || parts.some((p) => !p)) return null;
  const o = { devices: 0, racks: 0, usedU: 0, totalU: 0, inStore: 0, make: {}, zones: {}, racksHot: [], servers: { total: 0, known: 0, online: 0, unreachable: 0 }, fw: { checked: 0, ok: 0 }, pendingTransfers: 0, power: { pdus: 0, online: 0, totalKw: 0, ratedKw: 0, racks: 0, redundant: 0, highest: null }, hasPower: false, perSite: {} };
  sites.forEach((s, idx) => {
    const p = parts[idx]; o.perSite[s] = p;
    o.devices += p.devices; o.racks += p.racks; o.usedU += p.usedU; o.totalU += p.totalU; o.inStore += p.inStore; o.pendingTransfers += p.pendingTransfers || 0;
    for (const [k, v] of Object.entries(p.make || {})) o.make[k] = (o.make[k] || 0) + v;
    for (const [z, v] of Object.entries(p.zones || {})) { const key = sites.length > 1 ? `${s} · ${z}` : z; o.zones[key] = { used: v.used, total: v.total, racks: v.racks || 0 }; }
    for (const r of p.racksHot || []) o.racksHot.push({ ...r, site: s });
    for (const k of Object.keys(o.servers)) o.servers[k] += (p.servers || {})[k] || 0;
    o.fw.checked += (p.fw || {}).checked || 0; o.fw.ok += (p.fw || {}).ok || 0;
    if (p.power) {
      o.hasPower = true;
      for (const k of ['pdus', 'online', 'racks', 'redundant']) o.power[k] += p.power[k] || 0;
      o.power.totalKw = +(o.power.totalKw + p.power.totalKw).toFixed(2); o.power.ratedKw = +(o.power.ratedKw + p.power.ratedKw).toFixed(2);
      if (p.power.highest && (!o.power.highest || p.power.highest.pct > o.power.highest.pct)) o.power.highest = { ...p.power.highest, site: s };
    }
    o.takenAt = o.takenAt && o.takenAt > (p._takenAt || '') ? o.takenAt : (p._takenAt || o.takenAt);
  });
  return o;
}


const pctOf = (a, b) => (b ? Math.round(a / b * 100) : null);
const chg = (cur, prev, dec = 0) => (cur == null || prev == null ? null : +(cur - prev).toFixed(dec));
const FALLBACK_DAYS = 15; // a month-end position may be taken from the first snapshot saved within this many days after the month

// ------------------------------------------------------------------ main builder ------------------------------------------------------------------
async function buildReport(pool, { sites, month, scopeLabel, now = new Date() }) {
  if (!isMonthKey(month)) throw Object.assign(new Error('month must look like 2026-10'), { statusCode: 400 });
  if (!Array.isArray(sites) || !sites.length) throw Object.assign(new Error('No location available for this report'), { statusCode: 403 });
  const curKey = monthKeyOf(now);
  if (month > curKey) throw Object.assign(new Error('That month has not started yet'), { statusCode: 400 });
  const isCurrent = month === curKey;
  const prevKey = addMonths(month, -1), nextKey = addMonths(month, 1);
  const keys = []; for (let i = MONTHS_BACK - 1; i >= 0; i--) keys.push(addMonths(month, -i));

  // Every report captures today's position first, so the following month always has a starting point.
  await takeSnapshot(pool, sites, now);
  const snaps = await loadSnapshots(pool, sites, [...keys, nextKey]);
  const ev = await loadEvents(pool, sites, keys[0], month);
  const E = {}; for (const k of keys) E[k] = monthEvents(ev, sites, k);
  const S = {}; for (const k of keys) S[k] = mergeState(snaps[k], sites);
  const cur = E[month], prv = E[prevKey];
  let sCur = S[month], approx = false;
  // First report: no month-end snapshot exists yet. Use the first position recorded just after the month and say so.
  if (!sCur && !isCurrent) {
    const nx = mergeState(snaps[nextKey], sites);
    if (nx && nx.takenAt && Number(nx.takenAt.slice(8, 10)) <= FALLBACK_DAYS) { sCur = nx; approx = true; S[month] = null; }
  }
  const sPrv = S[prevKey];
  const multi = sites.length > 1;

  const rows = {};
  const add = (mod, label, fn, o = {}) => {
    const series = keys.map((k, i) => { try { const v = fn(E[k], i === keys.length - 1 ? sCur : S[k], k); return v == null || Number.isNaN(v) ? null : v; } catch (e) { return null; } });
    const exactSeries = series.slice(0, -1).concat([o.kind === 'stock' && approx ? null : series[series.length - 1]]);
    const prev = series[series.length - 2], curV = series[series.length - 1];
    const delta = chg(curV, prev, o.dec || 0);
    const good = o.good == null ? null : o.good;
    const watch = !!o.watch && curV != null && curV > 0 && (prev == null || curV > prev);
    (rows[mod] || (rows[mod] = [])).push({ label: typeof label === 'function' ? label(sCur) : label, prev, cur: curV, delta, unit: o.unit || '', dec: o.dec || 0, good, kind: o.kind || 'event',
      series: exactSeries, first: o.kind === 'stock' && prev == null && curV != null, approx: o.kind === 'stock' && approx && curV != null, watch });
  };
  const st = (fn) => (e, s) => (s ? fn(s) : null);

  add('assets', 'Installed devices', st((s) => s.devices), { kind: 'stock' });
  add('assets', 'Total racks', st((s) => s.racks), { kind: 'stock' });
  add('assets', 'DC utilization (rack U used)', st((s) => pctOf(s.usedU, s.totalU)), { kind: 'stock', unit: '%' });
  add('assets', 'Assets in store', st((s) => s.inStore), { kind: 'stock' });

  const pw = sCur && sCur.hasPower ? sCur.power : null;
  add('power', pw ? `Total load (kW) of ${pw.ratedKw} kW rated` : 'Total load (kW)', st((s) => (s.hasPower ? s.power.totalKw : null)), { kind: 'stock', dec: 1 });
  add('power', 'Capacity used', st((s) => (s.hasPower && s.power.ratedKw ? pctOf(s.power.totalKw, s.power.ratedKw) : null)), { kind: 'stock', unit: '%' });
  add('power', pw ? `Online PDUs (of ${pw.pdus})` : 'Online PDUs', st((s) => (s.hasPower ? s.power.online : null)), { kind: 'stock', good: true });
  add('power', 'Racks monitored', st((s) => (s.hasPower ? s.power.racks : null)), { kind: 'stock' });
  add('power', 'Highest rack load', st((s) => (s.hasPower && s.power.highest ? s.power.highest.pct : null)), { kind: 'stock', unit: '%', good: false });
  add('power', 'Racks fully redundant (A+B)', st((s) => (s.hasPower ? s.power.redundant : null)), { kind: 'stock', good: true });
  add('power', 'Peak daily load in the month (kW)', (e) => e.peakKw, { dec: 1 });
  add('power', 'Power feeds at 80% of rating or more', (e) => (e.peakKw == null ? null : e.feedsHot.length), { good: false, watch: true });

  add('ops', 'Servers online', st((s) => (s.servers.known ? pctOf(s.servers.online, s.servers.known) : null)), { kind: 'stock', unit: '%', good: true });
  add('ops', 'Servers unreachable', st((s) => (s.servers.total ? s.servers.unreachable : null)), { kind: 'stock', good: false, watch: true });
  add('ops', 'Firmware compliant', st((s) => (s.fw.checked ? pctOf(s.fw.ok, s.fw.checked) : null)), { kind: 'stock', unit: '%', good: true });
  add('ops', 'Visits approved', (e) => e.visits);
  add('ops', 'Transfers waiting for approval', st((s) => s.pendingTransfers), { kind: 'stock', good: false });

  add('issues', 'Reported', (e) => e.reported);
  add('issues', 'Resolved / closed', (e) => e.resolved, { good: true });
  add('issues', 'Open at month end', (e) => e.openEnd, { good: false });
  add('issues', 'Critical open', (e) => e.criticalEnd, { good: false, watch: true });

  const makes = new Set([...Object.keys((sCur || {}).make || {}), ...Object.keys((sPrv || {}).make || {})]);
  const hardwareMix = [...makes].map((m) => ({ make: m, cur: sCur ? (sCur.make[m] || 0) : null, prev: sPrv ? (sPrv.make[m] || 0) : null }))
    .sort((a, b) => (b.cur || 0) - (a.cur || 0));

  const itemList = (type) => {
    const names = new Set([...cur[type].keys(), ...prv[type].keys()]);
    return [...names].map((n) => ({ item: n, cur: cur[type].get(n) || 0, prev: prv[type].get(n) || 0 })).sort((a, b) => b.cur - a.cur || b.prev - a.prev || a.item.localeCompare(b.item));
  };
  const actNames = new Set([...cur.acts.keys(), ...prv.acts.keys()]);
  const activities = [...actNames].map((n) => ({ type: n, cur: cur.acts.get(n) || 0, prev: prv.acts.get(n) || 0 })).sort((a, b) => b.cur - a.cur || a.type.localeCompare(b.type));

  const zoneNames = new Set([...Object.keys((sCur || {}).zones || {}), ...Object.keys((sPrv || {}).zones || {})]);
  const zones = [...zoneNames].sort().map((z) => {
    const c = sCur && sCur.zones[z], p = sPrv && sPrv.zones[z];
    const hot = sCur ? sCur.racksHot.filter((r) => (multi ? `${r.site} · ${r.zone}` : r.zone) === z).map((r) => `${r.rack} (${r.pct}%)`) : [];
    return { zone: z, racks: c ? c.racks : (p ? p.racks : null), cur: c ? pctOf(c.used, c.total) : null, prev: p ? pctOf(p.used, p.total) : null, usedU: c ? c.used : null, hot, approx };
  });

  let locations = null;
  if (multi) {
    locations = [];
    for (const s of sites) {
      const e1 = monthEvents(ev, [s], month), e0 = monthEvents(ev, [s], prevKey);
      const c1 = sCur && sCur.perSite[s], c0 = sPrv && sPrv.perSite[s];
      locations.push({ site: s, devices: [c0 && c0.devices, c1 && c1.devices], util: [c0 && pctOf(c0.usedU, c0.totalU), c1 && pctOf(c1.usedU, c1.totalU)],
        openIssues: [e0.openEnd, e1.openEnd], peak: [e0.peakKw, e1.peakKw], inward: [e0.inwardCount, e1.inwardCount], outward: [e0.outwardCount, e1.outwardCount] });
    }
  }

  const stockKnown = !!sCur;
  return {
    meta: {
      month, prevMonth: prevKey, label: monthLabel(month), prevLabel: monthLabel(prevKey), shortLabel: monthShort(month), prevShort: monthShort(prevKey),
      scope: scopeLabel || (multi ? 'All locations' : sites[0]), sites, multi, isCurrent, generatedAt: now.toISOString(), monthsShown: keys.map(monthShort),
      firstRecord: stockKnown && !sPrv ? { asOf: approx ? sCur.takenAt : (isCurrent ? dstr(now) : (sCur.takenAt || '')), approx } : null,
      stockMissing: !stockKnown,
    },
    assets: { rows: rows.assets, note: `${cur.added} installed and ${cur.removed} moved out during ${monthLabel(month).split(' ')[0]}` },
    hardwareMix,
    zones,
    materials: { inward: itemList('inward'), outward: itemList('outward'), inwardTotals: { cur: cur.inwardCount, prev: prv.inwardCount }, outwardTotals: { cur: cur.outwardCount, prev: prv.outwardCount } },
    activities: { rows: activities, total: { cur: cur.actTotal, prev: prv.actTotal } },
    issues: { rows: rows.issues, oldestCritical: cur.oldestCritical },
    power: { rows: rows.power, configured: !!pw || rows.power.some((r) => r.cur != null), feedsHot: cur.feedsHot, highest: pw && pw.highest },
    ops: { rows: rows.ops },
    locations,
  };
}

module.exports = { buildReport, takeSnapshot, computeState, isMonthKey, monthKeyOf, addMonths, monthLabel, monthShort, ensureTable, SNAP_TABLE, makeLabel, parseU, parseHeight };
