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
    for (const r of rl) { const z = zones[r.zone] || (zones[r.zone] = { used: 0, total: 0 }); z.used += r.used; z.total += r.cap; }
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
    };
  }
  return out;
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
  const [rows] = await pool.query(`SELECT site, month, data FROM ${SNAP_TABLE} WHERE site IN (${qs(sites)}) AND month IN (${qs(keys)})`, [...sites, ...keys]);
  const m = {};
  for (const r of rows) { try { (m[r.month] || (m[r.month] = {}))[r.site] = JSON.parse(r.data); } catch (e) { /* ignore */ } }
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
  const o = { devices: 0, racks: 0, usedU: 0, totalU: 0, inStore: 0, make: {}, zones: {}, racksHot: [], servers: { total: 0, known: 0, online: 0, unreachable: 0 }, fw: { checked: 0, ok: 0 }, pendingTransfers: 0, perSite: {} };
  sites.forEach((s, idx) => {
    const p = parts[idx]; o.perSite[s] = p;
    o.devices += p.devices; o.racks += p.racks; o.usedU += p.usedU; o.totalU += p.totalU; o.inStore += p.inStore; o.pendingTransfers += p.pendingTransfers || 0;
    for (const [k, v] of Object.entries(p.make || {})) o.make[k] = (o.make[k] || 0) + v;
    for (const [z, v] of Object.entries(p.zones || {})) { const key = sites.length > 1 ? `${s} · ${z}` : z; o.zones[key] = { used: v.used, total: v.total }; }
    for (const r of p.racksHot || []) o.racksHot.push({ ...r, site: s });
    for (const k of Object.keys(o.servers)) o.servers[k] += (p.servers || {})[k] || 0;
    o.fw.checked += (p.fw || {}).checked || 0; o.fw.ok += (p.fw || {}).ok || 0;
  });
  return o;
}

const pctOf = (a, b) => (b ? Math.round(a / b * 100) : null);
const chg = (cur, prev) => (cur == null || prev == null ? null : +(cur - prev).toFixed(1));

// ------------------------------------------------------------------ main builder ------------------------------------------------------------------
async function buildReport(pool, { sites, month, scopeLabel, now = new Date() }) {
  if (!isMonthKey(month)) throw Object.assign(new Error('month must look like 2026-10'), { statusCode: 400 });
  if (!Array.isArray(sites) || !sites.length) throw Object.assign(new Error('No location available for this report'), { statusCode: 403 });
  const curKey = monthKeyOf(now);
  if (month > curKey) throw Object.assign(new Error('That month has not started yet'), { statusCode: 400 });
  const isCurrent = month === curKey;
  const prevKey = addMonths(month, -1);
  const keys = []; for (let i = MONTHS_BACK - 1; i >= 0; i--) keys.push(addMonths(month, -i));

  // The current month is always captured live, so a report for it (and the next month's "opening" figures) is exact.
  if (isCurrent) await takeSnapshot(pool, sites, now);
  const snaps = await loadSnapshots(pool, sites, keys);
  const ev = await loadEvents(pool, sites, keys[0], month);
  const E = {}; for (const k of keys) E[k] = monthEvents(ev, sites, k);
  const S = {}; for (const k of keys) S[k] = mergeState(snaps[k], sites);
  const cur = E[month], prv = E[prevKey], sCur = S[month], sPrv = S[prevKey];
  const multi = sites.length > 1;

  const series = (fn) => keys.map((k) => { try { const v = fn(E[k], S[k]); return v == null || Number.isNaN(v) ? null : v; } catch (e) { return null; } });
  const rows = [];
  const add = (group, label, fn, o = {}) => { const s = series(fn); rows.push({ group, label, series: s, prev: s[s.length - 2], cur: s[s.length - 1], good: o.good == null ? null : o.good, unit: o.unit || '', dec: o.dec || 0 }); };
  add('Assets and space', 'Installed devices', (e, s) => s && s.devices, { good: null });
  add('Assets and space', 'Total racks', (e, s) => s && s.racks);
  add('Assets and space', 'Rack U utilization', (e, s) => s && pctOf(s.usedU, s.totalU), { unit: '%' });
  add('Assets and space', 'Assets in store', (e, s) => s && s.inStore);
  add('Power and servers', 'Peak power load (kW)', (e) => e.peakKw, { dec: 1 });
  add('Power and servers', 'Servers online', (e, s) => s && s.servers.known ? pctOf(s.servers.online, s.servers.known) : null, { unit: '%', good: true });
  add('Power and servers', 'Firmware compliant', (e, s) => s && s.fw.checked ? pctOf(s.fw.ok, s.fw.checked) : null, { unit: '%', good: true });
  add('Issues', 'Reported', (e) => e.reported);
  add('Issues', 'Resolved / closed', (e) => e.resolved, { good: true });
  add('Issues', 'Open at month end', (e) => e.openEnd, { good: false });
  add('Issues', 'Critical open', (e) => e.criticalEnd, { good: false });
  add('Material movements', 'Received (inward) - entries', (e) => e.inwardCount);
  add('Material movements', 'Sent out (outward) - entries', (e) => e.outwardCount);
  add('Activities and visitors', 'DC activities', (e) => e.actTotal);
  add('Activities and visitors', 'Visits', (e) => e.visits);
  const row = (label) => rows.find((r) => r.label === label);

  // headline tiles
  const tile = (label, r, note) => ({ label, prev: r.prev, cur: r.cur, unit: r.unit, good: r.good, delta: chg(r.cur, r.prev), note: note || '' });
  const tiles = [
    tile('Installed devices', row('Installed devices'), sCur && sPrv ? `${cur.added} added · ${cur.removed} moved out` : `${cur.added} added · ${cur.removed} moved out`),
    tile('Rack U utilization', row('Rack U utilization'), sCur ? `${sCur.usedU} of ${sCur.totalU} U used` : ''),
    tile('Peak power load', { ...row('Peak power load (kW)'), unit: ' kW' }, ''),
    tile('Open issues', row('Open at month end'), `${cur.reported} raised · ${cur.resolved} closed`),
    tile('Firmware compliant', row('Firmware compliant'), sCur && sCur.fw.checked ? `${sCur.fw.ok} of ${sCur.fw.checked} servers` : 'No firmware targets set'),
    tile('Servers online', row('Servers online'), sCur && sCur.servers.known ? `${sCur.servers.online} of ${sCur.servers.known} reporting` : 'Needs Redfish sync'),
  ];
  tiles[0].good = null; tiles[1].good = null; tiles[2].good = null; tiles[3].good = false;

  // ranked "biggest changes" (relative size; only measures with both months known)
  const rank = [];
  const push = (what, a, b, good, why, unit = '') => { if (a == null || b == null || a === b) return; rank.push({ what, prev: a, cur: b, unit, good, delta: +(b - a).toFixed(1), score: a ? Math.abs(b - a) / Math.abs(a) : Math.abs(b - a), why }); };
  push('Material sent out (outward) - entries', prv.outwardCount, cur.outwardCount, null, 'Check what left the site and why');
  push('Material received (inward) - entries', prv.inwardCount, cur.inwardCount, null, 'Goods that came in this month');
  push('Installed devices', sPrv && sPrv.devices, sCur && sCur.devices, null, `${cur.added} added, ${cur.removed} moved out`);
  push('Peak power load (kW)', prv.peakKw, cur.peakKw, null, 'Highest combined daily feed peak', ' kW');
  push('Open issues', prv.openEnd, cur.openEnd, false, `${cur.reported} raised, ${cur.resolved} closed`);
  push('Critical issues open', prv.criticalEnd, cur.criticalEnd, false, cur.oldestCritical ? `Oldest: ${cur.oldestCritical.ticket}` : 'No critical issue open');
  push('Rack U utilization', sPrv && pctOf(sPrv.usedU, sPrv.totalU), sCur && pctOf(sCur.usedU, sCur.totalU), null, sCur ? `${sCur.usedU} U used of ${sCur.totalU} U` : '', '%');
  push('DC activities', prv.actTotal, cur.actTotal, null, 'Work recorded in DC Activity Record');
  push('Visits', prv.visits, cur.visits, null, 'Approved / completed visitor requests');
  rank.sort((a, b) => b.score - a.score);

  // flows
  const flows = [
    { title: 'Devices: how the closing count came about', open: sPrv ? sPrv.devices : null, close: sCur ? sCur.devices : null,
      steps: [{ label: 'Added (installed)', n: cur.added }, { label: 'Removed / moved out', n: -cur.removed }] },
    { title: 'Issues: how the open count moved', open: prv.openEnd, close: cur.openEnd, steps: [{ label: 'Raised', n: cur.reported }, { label: 'Closed', n: -cur.resolved }] },
  ];

  // hardware mix by make
  const makes = new Set([...Object.keys((sCur || {}).make || {}), ...Object.keys((sPrv || {}).make || {})]);
  const hardwareMix = [...makes].map((m) => ({ make: m, cur: sCur ? (sCur.make[m] || 0) : null, prev: sPrv ? (sPrv.make[m] || 0) : null }))
    .sort((a, b) => (b.cur || 0) - (a.cur || 0));

  // material lines
  const itemList = (type) => {
    const names = new Set([...cur[type].keys(), ...prv[type].keys()]);
    return [...names].map((n) => ({ item: n, cur: cur[type].get(n) || 0, prev: prv[type].get(n) || 0 })).sort((a, b) => b.cur - a.cur || b.prev - a.prev || a.item.localeCompare(b.item));
  };
  const activities = (() => {
    const names = new Set([...cur.acts.keys(), ...prv.acts.keys()]);
    return [...names].map((n) => ({ type: n, cur: cur.acts.get(n) || 0, prev: prv.acts.get(n) || 0 })).sort((a, b) => b.cur - a.cur || a.type.localeCompare(b.type));
  })();

  // watch list
  const watch = [];
  const w = (item, prev, curV, good, detail) => watch.push({ item, prev, cur: curV, delta: chg(curV, prev), good, detail });
  w('Racks 85% full or more', sPrv ? sPrv.racksHot.length : null, sCur ? sCur.racksHot.length : null, false,
    sCur ? (sCur.racksHot.slice(0, 4).map((r) => `${multi ? r.site + ' ' : ''}${r.rack} ${r.pct}%`).join(', ') || 'None') : 'Needs a month-end snapshot');
  w('Power feeds at 80% of rating or more', prv.feedsHot.length, cur.feedsHot.length, false, cur.feedsHot.slice(0, 3).map((f) => `${f.name} ${f.pct}%`).join(', ') || 'None');
  w('Servers with firmware off target', sPrv && sPrv.fw.checked ? sPrv.fw.checked - sPrv.fw.ok : null, sCur && sCur.fw.checked ? sCur.fw.checked - sCur.fw.ok : null, false,
    sCur && sCur.fw.checked ? `${sCur.fw.ok} of ${sCur.fw.checked} on target` : 'Set targets in Firmware Compliance');
  w('Critical issues open', prv.criticalEnd, cur.criticalEnd, false, cur.oldestCritical ? `Oldest ${cur.oldestCritical.ticket} since ${cur.oldestCritical.since}` : 'None');
  w('Transfers waiting for approval', sPrv ? sPrv.pendingTransfers : null, sCur ? sCur.pendingTransfers : null, false, 'Material movements in Pending Approval');
  w('Servers unreachable (monitoring)', sPrv ? sPrv.servers.unreachable : null, sCur ? sCur.servers.unreachable : null, false, 'Redfish sync reports an error');

  const zoneNames = new Set([...Object.keys((sCur || {}).zones || {}), ...Object.keys((sPrv || {}).zones || {})]);
  const zones = [...zoneNames].sort().map((z) => ({ zone: z,
    cur: sCur && sCur.zones[z] ? pctOf(sCur.zones[z].used, sCur.zones[z].total) : null, prev: sPrv && sPrv.zones[z] ? pctOf(sPrv.zones[z].used, sPrv.zones[z].total) : null,
    usedU: sCur && sCur.zones[z] ? sCur.zones[z].used : null }));

  // location-wise table (multi-location reports)
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

  const haveOpening = !!sPrv, haveClosing = !!sCur;
  return {
    meta: {
      month, prevMonth: prevKey, label: monthLabel(month), prevLabel: monthLabel(prevKey), shortLabel: monthShort(month), prevShort: monthShort(prevKey),
      scope: scopeLabel || (multi ? 'All locations' : sites[0]), sites, multi, isCurrent,
      asOf: isCurrent ? `Month to date, up to ${dstr(now)}` : `Full month, ${monthLabel(month)}`,
      generatedAt: now.toISOString(), monthsShown: keys.map(monthShort),
      stateNote: haveOpening && haveClosing ? '' : !haveClosing
        ? 'Stock figures (devices, racks, hardware mix, firmware) were not recorded for this month. Event figures below are complete.'
        : 'Stock figures for the previous month were not recorded yet - changes in devices, racks and hardware mix start from next month.',
    },
    tiles, ranked: rank.slice(0, 8), flows, hardwareMix, rows, inward: itemList('inward'), outward: itemList('outward'),
    inwardTotals: { cur: cur.inwardCount, prev: prv.inwardCount }, outwardTotals: { cur: cur.outwardCount, prev: prv.outwardCount },
    activities, watch, zones, locations,
    notes: ['Not captured by DCIM today: cooling temperature and humidity, energy cost, uptime / SLA, change-request counts, project budgets.'],
  };
}

module.exports = { buildReport, takeSnapshot, computeState, isMonthKey, monthKeyOf, addMonths, monthLabel, monthShort, ensureTable, SNAP_TABLE, makeLabel, parseU, parseHeight };
