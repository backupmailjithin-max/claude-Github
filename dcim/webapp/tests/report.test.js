'use strict';
const test = require('node:test');
const assert = require('node:assert');
const data = require('../lib/report-data');
const { Doc, textWidth } = require('../lib/pdf-writer');
const { render } = require('../lib/report-pdf');

const D = (s) => new Date(s + 'T10:00:00');

function fakePool(over = {}) {
  const snaps = over.snaps || [];
  const t = {
    issues: [
      // reported in Sep, still open at end of Oct (critical)
      { id: 'I1', ticket_no: 'T-1', title: 'PSU fail', site: 'Chennai', severity: 'critical', part_required: 0, reported_date: D('2026-09-10'), completed_date: null, cancelled_date: null },
      // reported Sep, completed in Oct
      { id: 'I2', ticket_no: 'T-2', title: 'Fan', site: 'Chennai', severity: 'warning', part_required: 0, reported_date: D('2026-09-20'), completed_date: D('2026-10-05'), cancelled_date: null },
      // reported and cancelled in Oct
      { id: 'I3', ticket_no: 'T-3', title: 'Cable', site: 'Chennai', severity: 'info', part_required: 0, reported_date: D('2026-10-02'), completed_date: null, cancelled_date: D('2026-10-03') },
      // reported in Oct, part in store (closed by that date), but completed_date null
      { id: 'I4', ticket_no: 'T-4', title: 'Disk', site: 'Chennai', severity: 'warning', part_required: 1, reported_date: D('2026-10-04'), completed_date: null, cancelled_date: null, moved_to_store_date: D('2026-10-20') },
      // reported Oct, open
      { id: 'I5', ticket_no: 'T-5', title: 'NIC', site: 'Chennai', severity: 'warning', part_required: 0, reported_date: D('2026-10-25'), completed_date: null, cancelled_date: null },
      // other site
      { id: 'I6', ticket_no: 'T-6', title: 'X', site: 'Pune', severity: 'critical', part_required: 0, reported_date: D('2026-10-25'), completed_date: null, cancelled_date: null },
    ],
    mm: [
      { site: 'Chennai', movement_type: 'Inward', item_name: 'SSD', quantity: 5, movement_date: D('2026-10-02'), status: 'Received at Site' },
      { site: 'Chennai', movement_type: 'Inward', item_name: 'SSD', quantity: 3, movement_date: D('2026-10-12'), status: 'Received at Site' },
      { site: 'Chennai', movement_type: 'Inward', item_name: 'SSD', quantity: 4, movement_date: D('2026-09-12'), status: 'Received at Site' },
      { site: 'Chennai', movement_type: 'Outward', item_name: 'Fan', quantity: 2, movement_date: D('2026-10-30'), status: 'Ticket Issued' },
      { site: 'Pune', movement_type: 'Outward', item_name: 'Fan', quantity: 9, movement_date: D('2026-10-30'), status: 'Ticket Issued' },
    ],
    acts: [
      { site: 'Chennai', activity_type: 'Cabling', start_date: D('2026-10-03'), completion_date: null },
      { site: 'Chennai', activity_type: 'Cabling', start_date: D('2026-09-03'), completion_date: null },
    ],
    visits: [{ site: 'Chennai', status: 'Approved', visit_date: D('2026-10-09') }],
    added: [{ site: 'Chennai', d: D('2026-10-04') }, { site: 'Chennai', d: D('2026-10-14') }],
    removed: [{ site: 'Chennai', to_site: 'Pune', d: D('2026-10-20') }],
    pdus: [{ id: 'P1', site: 'Chennai', zone: 'AZ-1', feed_label: 'Feed-A', rack_no: 'R1', max_load_kw: 10 }],
    readings: [
      { pdu_id: 'P1', site: 'Chennai', reading_date: D('2026-10-18'), peak_kw: 8.4 },
      { pdu_id: 'P1', site: 'Chennai', reading_date: D('2026-10-19'), peak_kw: 6 },
    ],
    ...over,
  };
  const stored = [...snaps];
  return {
    stored,
    async query(sql, params = []) {
      if (/^\s*CREATE TABLE/i.test(sql)) return [[]];
      if (/INSERT INTO report_snapshots/.test(sql)) { const i = stored.findIndex((s) => s.site === params[0] && s.month === params[1]); const row = { site: params[0], month: params[1], data: params[2] }; if (i >= 0) stored[i] = row; else stored.push(row); return [{}]; }
      if (/FROM report_snapshots/.test(sql)) { const months = params.filter((p) => /^\d{4}-\d{2}$/.test(p)); return [stored.filter((s) => months.includes(s.month))]; }
      if (/FROM issues/.test(sql)) return [t.issues];
      if (/FROM material_movements WHERE status/.test(sql)) return [[{ site: 'Chennai', c: 1 }]];
      if (/FROM material_movements/.test(sql)) return [t.mm];
      if (/FROM dc_activities/.test(sql)) return [t.acts];
      if (/FROM visitor_requests/.test(sql)) return [t.visits];
      if (/COALESCE\(installation_date/.test(sql)) return [t.added];
      if (/FROM asset_movements/.test(sql)) return [t.removed];
      if (/FROM pdus/.test(sql)) return [t.pdus];
      if (/FROM power_readings/.test(sql)) return [t.readings];
      if (/FROM racks/.test(sql)) return [[{ site: 'Chennai', zone: 'AZ-1', rack_no: 'R1', u_size: 42 }, { site: 'Pune', zone: 'AZ-1', rack_no: 'R9', u_size: 42 }]];
      if (/FROM rack_components/.test(sql)) return [[]];
      if (/FROM firmware_model_targets/.test(sql)) return [[{ vendor: 'ome', model_key: 'poweredge r750', target_version: '1.2.3' }]];
      if (/FROM assets/.test(sql)) return [[
        { site: 'Chennai', zone: 'AZ-1', rack_no: 'R1', position: 'U1', height: '2U', manufacturer: 'Dell Inc.', model: 'PowerEdge R750', hardware_type: 'DellServer', lifecycle_status: 'Active', power_state: 'On', mgmt_ip: '1.1.1.1', last_redfish_error: null, bios_version: '1.2.3', redfish_monitor_ignored: 0 },
        { site: 'Chennai', zone: 'AZ-1', rack_no: 'R1', position: 'U10', height: '38U', manufacturer: 'Dell', model: 'PER750', hardware_type: 'DellServer', lifecycle_status: 'Active', power_state: 'Off', mgmt_ip: '1.1.1.2', last_redfish_error: 'timeout', bios_version: '1.0', redfish_monitor_ignored: 0 },
        { site: 'Chennai', zone: 'AZ-1', rack_no: '', position: '', height: '1U', manufacturer: 'Cisco', model: 'N9K', hardware_type: 'Switch', lifecycle_status: 'In Store', power_state: null, mgmt_ip: null, last_redfish_error: null, bios_version: null, redfish_monitor_ignored: 0 },
        { site: 'Pune', zone: 'AZ-1', rack_no: 'R9', position: 'U5', height: '1U', manufacturer: 'HPE', model: 'DL380', hardware_type: 'HPServer', lifecycle_status: 'Active', power_state: 'On', mgmt_ip: '2.2.2.2', last_redfish_error: null, bios_version: null, redfish_monitor_ignored: 0 },
      ]];
      throw new Error('unexpected query: ' + sql.slice(0, 80));
    },
  };
}

test('month helpers', () => {
  assert.strictEqual(data.addMonths('2026-01', -1), '2025-12');
  assert.strictEqual(data.addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(data.monthLabel('2026-10'), 'October 2026');
  assert.ok(data.isMonthKey('2026-10')); assert.ok(!data.isMonthKey('2026-13')); assert.ok(!data.isMonthKey('x'));
});
test('rack U parsing matches the Overall Summary rules', () => {
  assert.strictEqual(data.parseU('U12'), 12); assert.strictEqual(data.parseU('12U'), 12); assert.strictEqual(data.parseU('U3-4'), 3); assert.strictEqual(data.parseU('7'), 7); assert.strictEqual(data.parseU('Floor'), null);
  assert.strictEqual(data.parseHeight('2U'), 2); assert.strictEqual(data.parseHeight('n/a'), 0);
  assert.strictEqual(data.makeLabel('Dell Inc.'), 'Dell'); assert.strictEqual(data.makeLabel('Hewlett Packard Enterprise'), 'HP'); assert.strictEqual(data.makeLabel(''), 'Unknown');
});
test('rejects a future month and an empty scope', async () => {
  const now = new Date(2026, 10, 5);
  await assert.rejects(() => data.buildReport(fakePool(), { sites: ['Chennai'], month: '2026-12', now }), /not started/);
  await assert.rejects(() => data.buildReport(fakePool(), { sites: [], month: '2026-10', now }), /No location/);
  await assert.rejects(() => data.buildReport(fakePool(), { sites: ['Chennai'], month: 'bad', now }), /month/);
});

test('event figures for a past month are rebuilt from dated records', async () => {
  const now = new Date(2026, 10, 5);
  const rep = await data.buildReport(fakePool(), { sites: ['Chennai'], month: '2026-10', now });
  const row = (l) => rep.rows.find((r) => r.label === l);
  assert.strictEqual(row('Reported').cur, 3);           // I3, I4, I5 reported in Oct
  assert.strictEqual(row('Resolved / closed').cur, 3);  // I2 completed, I3 cancelled, I4 part moved to store
  assert.strictEqual(row('Open at month end').prev, 2); // I1, I2 open at end of Sep
  assert.strictEqual(row('Open at month end').cur, 2);  // I1 + I5 open at end of Oct
  assert.strictEqual(row('Critical open').cur, 1);
  assert.strictEqual(rep.meta.isCurrent, false);
  assert.deepStrictEqual(rep.inward.find((i) => i.item === 'SSD'), { item: 'SSD', cur: 8, prev: 4 });
  assert.deepStrictEqual(rep.outward.find((i) => i.item === 'Fan'), { item: 'Fan', cur: 2, prev: 0 }); // Pune's 9 not counted
  assert.deepStrictEqual(rep.inwardTotals, { cur: 2, prev: 1 });
  assert.deepStrictEqual(rep.activities, [{ type: 'Cabling', cur: 1, prev: 1 }]);
  assert.strictEqual(row('Visits').cur, 1);
  assert.strictEqual(row('Peak power load (kW)').cur, 8.4);
  const feed = rep.watch.find((w) => /Power feeds/.test(w.item));
  assert.strictEqual(feed.cur, 1); assert.match(feed.detail, /84%/);
  const crit = rep.watch.find((w) => /Critical/.test(w.item));
  assert.match(crit.detail, /T-1/);
  // stock figures were never captured for these months -> shown as unknown, not invented
  assert.strictEqual(row('Installed devices').cur, null);
  assert.match(rep.meta.stateNote, /not recorded/);
});

test('stock figures come from snapshots and changes are computed against last month', async () => {
  const mk = (devices, usedU) => JSON.stringify({ devices, racks: 1, usedU, totalU: 42, inStore: 0, make: { Dell: devices }, zones: { 'AZ-1': { used: usedU, total: 42 } }, racksHot: [], servers: { total: 2, known: 2, online: 2, unreachable: 0 }, fw: { checked: 2, ok: 1 }, pendingTransfers: 0 });
  const pool = fakePool({ snaps: [{ site: 'Chennai', month: '2026-09', data: mk(10, 20) }, { site: 'Chennai', month: '2026-10', data: mk(12, 30) }] });
  const rep = await data.buildReport(pool, { sites: ['Chennai'], month: '2026-10', now: new Date(2026, 10, 5) });
  const t = (l) => rep.tiles.find((x) => x.label === l);
  assert.strictEqual(t('Installed devices').cur, 12); assert.strictEqual(t('Installed devices').delta, 2);
  assert.strictEqual(t('Rack U utilization').cur, 71); assert.strictEqual(t('Rack U utilization').prev, 48);
  assert.strictEqual(t('Firmware compliant').cur, 50);
  assert.strictEqual(rep.meta.stateNote, '');
  assert.deepStrictEqual(rep.hardwareMix, [{ make: 'Dell', cur: 12, prev: 10 }]);
  assert.strictEqual(rep.ranked[0].what.length > 0, true);
  assert.deepStrictEqual(rep.zones, [{ zone: 'AZ-1', cur: 71, prev: 48, usedU: 30 }]);
});

test('current month is captured live into a snapshot (rack U, make, firmware, servers) with the app definitions', async () => {
  const pool = fakePool();
  const rep = await data.buildReport(pool, { sites: ['Chennai'], month: '2026-11', now: new Date(2026, 10, 5) });
  assert.strictEqual(rep.meta.isCurrent, true);
  const snap = JSON.parse(pool.stored.find((s) => s.month === '2026-11').data);
  assert.strictEqual(snap.devices, 2);               // In Store item is not "installed"
  assert.strictEqual(snap.inStore, 1);
  assert.strictEqual(snap.usedU, 40);                // 2U + 38U
  assert.deepStrictEqual(snap.make, { Dell: 2 });    // "Dell Inc." and "Dell" are one make
  assert.deepStrictEqual(snap.fw, { checked: 2, ok: 1 }); // PER750 canonicalises to R750 target
  assert.deepStrictEqual(snap.servers, { total: 2, known: 2, online: 1, unreachable: 1 });
  assert.strictEqual(snap.racksHot.length, 1); assert.strictEqual(snap.racksHot[0].pct, 95);
  assert.strictEqual(snap.pendingTransfers, 1);
});

test('multi-location totals and a location table; one missing snapshot hides the combined stock total', async () => {
  const mk = (d) => JSON.stringify({ devices: d, racks: 1, usedU: 10, totalU: 42, inStore: 0, make: { Dell: d }, zones: { 'AZ-1': { used: 10, total: 42 } }, racksHot: [], servers: { total: 0, known: 0, online: 0, unreachable: 0 }, fw: { checked: 0, ok: 0 }, pendingTransfers: 0 });
  const both = fakePool({ snaps: [{ site: 'Chennai', month: '2026-10', data: mk(5) }, { site: 'Pune', month: '2026-10', data: mk(7) }] });
  let rep = await data.buildReport(both, { sites: ['Chennai', 'Pune'], month: '2026-10', now: new Date(2026, 10, 5) });
  assert.strictEqual(rep.meta.multi, true); assert.strictEqual(rep.meta.scope, 'All locations');
  assert.strictEqual(rep.tiles[0].cur, 12);
  assert.strictEqual(rep.locations.length, 2);
  assert.deepStrictEqual(Object.keys(rep.zones.reduce((o, z) => ({ ...o, [z.zone]: 1 }), {})), ['Chennai · AZ-1', 'Pune · AZ-1']);
  const half = fakePool({ snaps: [{ site: 'Chennai', month: '2026-10', data: mk(5) }] });
  rep = await data.buildReport(half, { sites: ['Chennai', 'Pune'], month: '2026-10', now: new Date(2026, 10, 5) });
  assert.strictEqual(rep.tiles[0].cur, null);
});

test('PDF writer produces a structurally valid file with correct xref offsets', () => {
  const doc = new Doc({ title: 'T (x) \\ y' }); const p = doc.addPage('#000000');
  p.rect(10, 10, 50, 20, { fill: '#112233', stroke: '#ffffff', r: 3, alpha: 0.5 }); p.text('Hello (world) – · ≥ • €', 12, 20, { size: 10, font: 'HB' });
  p.poly([[1, 1], [5, 5], [9, 1]], { fill: '#fff' }); p.circle(30, 30, 2, { fill: '#fff' }); p.line(0, 0, 10, 10); doc.addPage();
  const buf = doc.toBuffer(); const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4')); assert.ok(s.trimEnd().endsWith('%%EOF'));
  const sx = Number(/startxref\n(\d+)/.exec(s)[1]); assert.strictEqual(s.slice(sx, sx + 4), 'xref');
  const entries = [...s.slice(sx).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.ok(new RegExp(`^${i + 1} 0 obj`).test(s.slice(off, off + 12)), `object ${i + 1} offset`));
  assert.strictEqual((s.match(/\/Type \/Page /g) || []).length, 2);
  assert.ok(textWidth('Hello', 'H', 10) > 0 && textWidth('Hello', 'HB', 10) > textWidth('Hello', 'H', 10));
});

test('report PDF renders for single location, many locations and long lists without throwing', async () => {
  const now = new Date(2026, 10, 5);
  const one = await data.buildReport(fakePool(), { sites: ['Chennai'], month: '2026-10', now });
  const many = await data.buildReport(fakePool(), { sites: ['Chennai', 'Pune'], month: '2026-10', now });
  for (const rep of [one, many]) {
    const buf = render(rep, { notes: 'Line one\nLine two with <tags> & ünïcode — dash' });
    assert.ok(buf.length > 4000); assert.ok(buf.slice(0, 5).toString() === '%PDF-');
    const pages = (buf.toString('latin1').match(/\/Type \/Page /g) || []).length; assert.ok(pages >= 3 && pages <= 5, `pages ${pages}`);
  }
  // 40 distinct items and 30 zones must not blow up or run off the page
  const big = JSON.parse(JSON.stringify(one));
  big.inward = Array.from({ length: 40 }, (_, i) => ({ item: 'Item with a rather long descriptive name number ' + i, cur: i, prev: 1 }));
  big.zones = Array.from({ length: 30 }, (_, i) => ({ zone: 'Zone ' + i, cur: i * 3, prev: 1, usedU: i }));
  big.hardwareMix = Array.from({ length: 25 }, (_, i) => ({ make: 'Make' + i, cur: i, prev: 2 }));
  assert.ok(render(big, {}).length > 4000);
});
