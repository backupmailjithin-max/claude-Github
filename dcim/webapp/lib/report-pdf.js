'use strict';
// Renders the monthly management report (see report-data.js) as a PDF in the dark Overall Summary look.
// One card per module, titled like the module in the app; every figure appears once.
const { Doc, textWidth } = require('./pdf-writer');

const C = {
  bg: '#0B1220', card: '#162033', card2: '#0F172A', line: '#334155', row: '#243247', head: '#7C8BA3', text: '#E2E8F0', white: '#FFFFFF', mute: '#94A3B8',
  dim: '#7C8BA3', ind: '#6366F1', indL: '#818CF8', good: '#10B981', bad: '#EF4444', warn: '#F59E0B', cyan: '#38BDF8', amber: '#FBBF24',
};
const MAKE_COL = { Dell: '#2F6DF6', HP: '#12A594', Unknown: '#94A3B8' };
const EXTRA = ['#F59E0B', '#A78BFA', '#EF4444', '#0EA5E9', '#84CC16', '#EC4899', '#14B8A6', '#F97316'];
function makeColor(l) { if (MAKE_COL[l]) return MAKE_COL[l]; let h = 0; for (let i = 0; i < l.length; i++) h = (h * 31 + l.charCodeAt(i)) >>> 0; return EXTRA[h % EXTRA.length]; }
const SPARK = { assets: C.ind, power: C.warn, ops: C.cyan, issues: C.bad };

const ML = 11, W = 188, BOTTOM = 281;
const MINUS = '−';
const RH = 7.6; // table row height (mm)

function fmtNum(v, unit = '', dec = 0) {
  if (v == null) return '—';
  const n = dec ? Number(v).toFixed(dec) : Math.round(Number(v)).toLocaleString('en-US');
  return n + (unit || '');
}
function fmtDelta(d, unit = '', dec = 0) {
  if (d == null) return '—';
  if (d === 0) return unit === '%' ? '0 pts' : '0';
  const a = dec ? Math.abs(d).toFixed(dec) : Math.round(Math.abs(d)).toLocaleString('en-US');
  return (d > 0 ? '+' : MINUS) + a + (unit === '%' ? ' pts' : '');
}
function deltaColor(d, good) {
  if (d == null || d === 0 || good === null || good === undefined) return C.mute;
  return (d > 0) === !!good ? C.good : C.bad;
}
function pctChange(prev, cur) { if (prev == null || cur == null || !prev) return ''; const p = Math.round((cur - prev) / Math.abs(prev) * 100); return (p > 0 ? '+' : p < 0 ? MINUS : '') + Math.abs(p) + '%'; }

class Layout {
  constructor(rep, opts) {
    this.rep = rep; this.opts = opts || {};
    this.doc = new Doc({ title: `DCIM Monthly Report - ${rep.meta.scope} - ${rep.meta.label}`, subject: 'Monthly management report', author: 'DCIM Dashboard' });
    this.page = null; this.y = 0; this.pageNo = 0;
  }
  newPage(sub) {
    this.page = this.doc.addPage(C.bg); this.pageNo++;
    const m = this.rep.meta, p = this.page;
    p.text(`DCIM · MONTHLY REPORT · ${m.label.toUpperCase()} VS ${m.prevLabel.toUpperCase()} · ${String(m.scope).toUpperCase()}${m.isCurrent ? ' · MONTH TO DATE' : ''}`, ML, 15, { size: 6.8, font: 'HB', color: C.ind, spacing: 1.1, maxW: W });
    p.text(`Monthly Report — ${m.label}`, ML, 24.5, { size: 18, font: 'HB', color: C.white, maxW: W });
    p.text(sub, ML, 30, { size: 7.6, color: C.mute, maxW: W });
    this.y = 36;
    return p;
  }
  ensure(h) { if (this.y + h > BOTTOM) this.newPage(`${this.rep.meta.scope} · continued`); this.p = this.page; }
  card(h, title, sub, o = {}) {
    const p = this.page, x = o.x == null ? ML : o.x, w = o.w == null ? W : o.w, y = o.y == null ? this.y : o.y;
    p.rect(x, y, w, h, { fill: C.card, stroke: C.line, lw: 0.25, r: 2.8 });
    if (title) p.text(title, x + 4.5, y + 7, { size: 11, font: 'HB', color: C.white, maxW: w - 9 });
    if (sub) p.text(sub, x + 4.5, y + 11.6, { size: 7.2, color: C.mute, maxW: w - 9 });
    return { x: x + 4.5, y: y + (sub ? 18.5 : 13), w: w - 9 };
  }
  arrow(x, y, up, col, s = 1.5) {
    this.page.poly(up ? [[x, y + s], [x + s * 2, y + s], [x + s, y - s * 0.4]] : [[x, y - s * 0.4], [x + s * 2, y - s * 0.4], [x + s, y + s]], { fill: col });
  }
  deltaAt(xr, y, d, good, unit, dec, size = 8) {
    const col = deltaColor(d, good), t = fmtDelta(d, unit, dec);
    const w = this.page.text(t, xr, y, { size, font: 'HB', color: col, align: 'right' });
    if (d) this.arrow(xr - w - 3.8, y - 1.8, d > 0, col, 1.45);
    return w + (d ? 4.4 : 0);
  }
  head(x, y, cols, w) {
    this.page.line(x, y + 2, x + w, y + 2, { stroke: C.line, lw: 0.2 });
    for (const c of cols) this.page.text(c.label, c.align === 'right' ? x + c.x + c.w : c.align === 'center' ? x + c.x + c.w / 2 : x + c.x, y, { size: 6.2, font: 'HB', color: C.dim, spacing: 0.7, align: c.align || 'left' });
  }
}

function spark(p, x, y, w, h, vals, col) {
  const pts = vals.map((v, i) => ({ v, i })).filter((o) => o.v != null);
  if (pts.length < 2) return false;
  const mn = Math.min(...pts.map((o) => o.v)), mx = Math.max(...pts.map((o) => o.v)), r = (mx - mn) || 1, n = vals.length - 1;
  const xy = pts.map((o) => [x + (o.i / n) * w, y + h - ((o.v - mn) / r) * h]);
  p.poly(xy, { stroke: col, lw: 0.35 });
  const last = xy[xy.length - 1]; p.circle(last[0], last[1], 0.75, { fill: col });
  return true;
}

// A module made of measure rows: MEASURE | prev | cur | CHANGE | % | 6-MONTH TREND
function measureCard(L, title, sub, rows, color, extraLine) {
  const rep = L.rep, h = 20.5 + rows.length * RH + (extraLine ? 7 : 3);
  L.ensure(h);
  const p = L.page, b = L.card(h, title, sub);
  const cols = [{ label: 'MEASURE', x: 0, w: 66 }, { label: rep.meta.prevShort.toUpperCase(), x: 66, w: 18, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 88, w: 18, align: 'right' },
    { label: 'CHANGE', x: 110, w: 24, align: 'right' }, { label: '%', x: 138, w: 12, align: 'right' }, { label: '6-MONTH TREND', x: 154, w: 26, align: 'center' }];
  L.head(b.x, b.y - 2.4, cols, b.w);
  rows.forEach((r, i) => {
    const y = b.y + 5.6 + i * RH;
    if (i) p.line(b.x, y - 5, b.x + b.w, y - 5, { stroke: C.row, lw: 0.15 });
    const lw = p.text(r.label, b.x, y, { size: 8.4, font: 'HB', color: C.white, maxW: 64 });
    if (r.watch) { const x0 = b.x + Math.min(lw, 64) + 2; p.rect(x0, y - 3, 10.5, 4.1, { fill: '#3B1318', stroke: '#7F1D1D', lw: 0.15, r: 1 }); p.text('WATCH', x0 + 5.25, y - 0.1, { size: 4.8, font: 'HB', color: '#FCA5A5', align: 'center', spacing: 0.3 }); }
    p.text(fmtNum(r.prev, r.unit, r.dec), b.x + 84, y, { size: 8.4, color: C.dim, align: 'right' });
    const cw = p.text(fmtNum(r.cur, r.unit, r.dec), b.x + 106 - (r.approx ? 1.6 : 0), y, { size: 8.6, font: 'HB', color: C.white, align: 'right' });
    if (r.approx) p.text('*', b.x + 106 + 0.2, y - 0.8, { size: 8, font: 'HB', color: C.amber });
    if (r.first || r.prev == null || r.cur == null) {
      p.text('—', b.x + 134, y, { size: 8.4, color: C.dim, align: 'right' });
      if (r.first) p.text('first record', b.x + 167, y, { size: 6.8, color: C.dim, align: 'center' });
      else if (r.cur == null) p.text('not recorded', b.x + 167, y, { size: 6.8, color: C.dim, align: 'center' });
    } else {
      L.deltaAt(b.x + 134, y, r.delta, r.good, r.unit === '%' ? '%' : '', r.dec || 0, 8);
      p.text(r.unit === '%' ? '' : pctChange(r.prev, r.cur), b.x + 150, y, { size: 7.4, color: C.dim, align: 'right' });
      if (!spark(p, b.x + 155, y - 4.2, 24, 5, r.series, color)) p.text('—', b.x + 167, y, { size: 7, color: C.dim, align: 'center' });
    }
  });
  if (extraLine) p.text(extraLine, b.x, b.y + 5.6 + rows.length * RH - 1, { size: 7.2, color: C.mute, maxW: b.w });
  L.y += h + 5;
}

function assets(L) { const a = L.rep.assets; measureCard(L, 'Assets', `Installed devices and rack space · ${a.note}`, a.rows, SPARK.assets); }

function mix(L) {
  const { rep } = L, rows = rep.hardwareMix.slice(0, 10);
  const h = 22.5 + Math.max(rows.length, 1) * 7.2;
  L.ensure(h);
  const p = L.page, b = L.card(h, 'Hardware Mix', `Installed devices by make · ${rep.meta.shortLabel} count${rows.some((r) => r.prev != null) ? ', change since ' + rep.meta.prevShort : ', change is shown from the next report'}`);
  if (!rows.length) { p.text('No installed hardware recorded.', b.x, b.y + 4, { size: 8, color: C.mute }); L.y += h + 5; return; }
  const max = Math.max(...rows.map((r) => r.cur || 0), 1), lw = 24, bx = b.x + lw + 3, bwMax = b.w - lw - 3 - 24;
  rows.forEach((r, i) => {
    const y = b.y + 1 + i * 7.2;
    p.text(r.make, b.x + lw, y + 2.8, { size: 8.2, font: 'HB', color: C.text, align: 'right', maxW: lw });
    p.rect(bx, y - 1.4, bwMax, 5.4, { fill: C.card2, r: 2.7 });
    const w = Math.max(r.cur ? (r.cur / max) * bwMax : 0, r.cur ? 3 : 0);
    if (w) p.rect(bx, y - 1.4, w, 5.4, { fill: makeColor(r.make), r: 2.7 });
    p.text(r.cur == null ? '—' : String(r.cur), bx + bwMax + 9, y + 2.8, { size: 8.4, font: 'HB', color: C.white, align: 'right' });
    const d = r.cur != null && r.prev != null ? r.cur - r.prev : null;
    if (d != null) L.deltaAt(b.x + b.w, y + 2.8, d, null, '', 0, 7.6);
  });
  L.y += h + 5;
}

function zones(L) {
  const { rep } = L, rows = rep.zones.slice(0, 14);
  if (!rows.length) return;
  const h = 20.5 + rows.length * RH + 3;
  L.ensure(h);
  const p = L.page, b = L.card(h, 'Zone-wise Rack Overview', 'U-space utilization per zone · racks at 85% or more are flagged');
  const cols = [{ label: 'ZONE', x: 0, w: 40 }, { label: 'RACKS', x: 42, w: 14, align: 'right' }, { label: rep.meta.prevShort.toUpperCase(), x: 60, w: 16, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 80, w: 18, align: 'right' },
    { label: 'CHANGE', x: 102, w: 22, align: 'right' }, { label: 'RACKS ≥ 85% FULL', x: 132, w: 48 }];
  cols[5].label = 'RACKS >= 85% FULL';
  L.head(b.x, b.y - 2.4, cols, b.w);
  rows.forEach((z, i) => {
    const y = b.y + 5.6 + i * RH;
    if (i) p.line(b.x, y - 5, b.x + b.w, y - 5, { stroke: C.row, lw: 0.15 });
    p.text(z.zone, b.x, y, { size: 8.4, font: 'HB', color: C.white, maxW: 40 });
    p.text(z.racks == null ? '—' : String(z.racks), b.x + 56, y, { size: 8.2, color: C.dim, align: 'right' });
    p.text(z.prev == null ? '—' : z.prev + '%', b.x + 76, y, { size: 8.2, color: C.dim, align: 'right' });
    p.text(z.cur == null ? '—' : z.cur + '%', b.x + 96, y, { size: 8.6, font: 'HB', color: C.white, align: 'right' });
    if (z.approx && z.cur != null) p.text('*', b.x + 96.4, y - 0.8, { size: 8, font: 'HB', color: C.amber });
    if (z.cur != null && z.prev != null) L.deltaAt(b.x + 124, y, z.cur - z.prev, null, '%', 0, 8); else p.text('—', b.x + 124, y, { size: 8.2, color: C.dim, align: 'right' });
    if (z.hot.length) {
      const w = p.text(z.hot.slice(0, 3).join(', ') + (z.hot.length > 3 ? ` +${z.hot.length - 3}` : ''), b.x + 132, y, { size: 7.4, color: '#FCA5A5', maxW: 34 });
      const x0 = b.x + 132 + Math.min(w, 34) + 1.5; p.rect(x0, y - 3, 10.5, 4.1, { fill: '#3B1318', stroke: '#7F1D1D', lw: 0.15, r: 1 }); p.text('WATCH', x0 + 5.25, y - 0.1, { size: 4.8, font: 'HB', color: '#FCA5A5', align: 'center', spacing: 0.3 });
    } else p.text('None', b.x + 132, y, { size: 7.8, color: C.dim });
  });
  L.y += h + 5;
}

function itemCard(L, x, w, title, list, totals, color) {
  const { rep } = L, p = L.page, shown = list.slice(0, 6), extra = list.length - shown.length;
  const h = 24 + Math.max(shown.length, 1) * 7 + (extra > 0 ? 5 : 0);
  const b = L.card(h, null, null, { x, w, y: L.y });
  p.text(title, b.x, L.y + 7.4, { size: 9.6, font: 'HB', color: C.white, maxW: w - 40 });
  const d = totals.cur - totals.prev;
  const tw = L.deltaAt(x + w - 4.5, L.y + 7.4, d, null, '', 0, 7.6);
  p.text(`${totals.cur} ${totals.cur === 1 ? 'entry' : 'entries'}`, x + w - 4.5 - tw - 2, L.y + 7.4, { size: 7.4, font: 'HB', color, align: 'right' });
  p.text(`${rep.meta.prevShort} ${totals.prev} ${totals.prev === 1 ? 'entry' : 'entries'}`, b.x, L.y + 12, { size: 7, color: C.mute });
  const by = L.y + 17;
  if (!shown.length) p.text('Nothing recorded this month.', b.x, by + 4, { size: 7.6, color: C.mute });
  const max = Math.max(...shown.map((s) => s.cur), 1), lw = 31, bw = b.w - lw - 20;
  shown.forEach((s, i) => {
    const y = by + i * 7;
    p.text(s.item, b.x + lw - 1.5, y + 2.7, { size: 7.4, color: C.text, align: 'right', maxW: lw - 1 });
    p.rect(b.x + lw + 1.5, y - 1, bw, 4.6, { fill: C.card2, r: 2.3 });
    const bwid = Math.max(s.cur ? (s.cur / max) * bw : 0, s.cur ? 2.5 : 0);
    if (bwid) p.rect(b.x + lw + 1.5, y - 1, bwid, 4.6, { fill: color, r: 2.3 });
    p.text(String(s.cur), b.x + lw + 1.5 + bw + 6, y + 2.6, { size: 7.8, font: 'HB', color: C.white, align: 'right' });
    L.deltaAt(b.x + b.w, y + 2.6, s.cur - s.prev, null, '', 0, 7);
  });
  if (extra > 0) p.text(`+ ${extra} more item${extra === 1 ? '' : 's'} not shown`, b.x, by + shown.length * 7 + 1, { size: 6.6, color: C.dim });
  return h;
}
function materials(L) {
  const { rep } = L, m = rep.materials, half = (W - 4) / 2;
  const hh = (l) => 24 + Math.max(Math.min(l.length, 6), 1) * 7 + (l.length > 6 ? 5 : 0);
  const h = Math.max(hh(m.inward), hh(m.outward)) + 17;
  L.ensure(h);
  const p = L.page;
  p.rect(ML, L.y, W, h, { fill: C.card, stroke: C.line, lw: 0.25, r: 2.8 });
  p.text('Material Movements Summary', ML + 4.5, L.y + 7, { size: 11, font: 'HB', color: C.white });
  p.text(`Items moved in ${rep.meta.label.split(' ')[0]}, quantity with change since ${rep.meta.prevShort}`, ML + 4.5, L.y + 11.6, { size: 7.2, color: C.mute });
  const top = L.y; L.y = top + 15;
  const a = itemCard(L, ML + 3, half - 3.5, 'Material Received (Inward)', m.inward, m.inwardTotals, C.good);
  const b = itemCard(L, ML + half + 1.5, half - 3.5, 'Material Sent Out (Outward)', m.outward, m.outwardTotals, C.bad);
  L.y = top + h + 5; void a; void b;
}

function activities(L) {
  const { rep } = L, a = rep.activities, rows = a.rows.slice(0, 12), extra = a.rows.length - rows.length;
  const h = 20.5 + (Math.max(rows.length, 1) + 1) * RH + (extra > 0 ? 5 : 0);
  L.ensure(h);
  const p = L.page, b = L.card(h, 'DC Activity Record Summary', `Activities started in ${rep.meta.label.split(' ')[0]}, by type`);
  const cols = [{ label: 'ACTIVITY TYPE', x: 0, w: 80 }, { label: rep.meta.prevShort.toUpperCase(), x: 98, w: 20, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 122, w: 20, align: 'right' }, { label: 'CHANGE', x: 150, w: 30, align: 'right' }];
  L.head(b.x, b.y - 2.4, cols, b.w);
  if (!rows.length) p.text('No DC activity recorded in these two months.', b.x, b.y + 5.6, { size: 8, color: C.mute });
  rows.forEach((r, i) => {
    const y = b.y + 5.6 + i * RH;
    if (i) p.line(b.x, y - 5, b.x + b.w, y - 5, { stroke: C.row, lw: 0.15 });
    p.text(r.type, b.x, y, { size: 8.4, font: 'HB', color: C.white, maxW: 90 });
    p.text(String(r.prev), b.x + 118, y, { size: 8.4, color: C.dim, align: 'right' });
    p.text(String(r.cur), b.x + 142, y, { size: 8.6, font: 'HB', color: C.white, align: 'right' });
    L.deltaAt(b.x + b.w, y, r.cur - r.prev, null, '', 0, 8);
  });
  const ty = b.y + 5.6 + Math.max(rows.length, 1) * RH;
  p.rect(b.x - 1.5, ty - 5, b.w + 3, RH - 0.4, { fill: '#0A101C', r: 1 });
  p.text('Total activities', b.x, ty, { size: 8.4, font: 'HB', color: C.white });
  p.text(String(a.total.prev), b.x + 118, ty, { size: 8.4, font: 'HB', color: C.mute, align: 'right' });
  p.text(String(a.total.cur), b.x + 142, ty, { size: 8.6, font: 'HB', color: C.white, align: 'right' });
  L.deltaAt(b.x + b.w, ty, a.total.cur - a.total.prev, null, '', 0, 8);
  if (extra > 0) p.text(`+ ${extra} more activity type${extra === 1 ? '' : 's'} not shown`, b.x, ty + 5.4, { size: 6.8, color: C.dim });
  L.y += h + 5;
}

function issues(L) {
  const oc = L.rep.issues.oldestCritical;
  measureCard(L, 'Issue Tracker', `Issues reported and closed in ${L.rep.meta.label.split(' ')[0]}, open count at month end`, L.rep.issues.rows, SPARK.issues,
    oc ? `Oldest open critical issue: ${oc.ticket}${oc.title ? ' ' + oc.title : ''}, open since ${oc.since}` : 'No critical issue is open');
}

function power(L) {
  const { rep } = L, pw = rep.power;
  if (!pw.configured) {
    const h = 30; L.ensure(h);
    const b = L.card(h, 'Power Capacity Monitoring', 'PDU load and redundancy');
    L.page.text('No PDU is configured yet. Power figures appear here once PDUs are added on the PDU Capacity page.', b.x, b.y + 1, { size: 8, color: C.mute, maxW: b.w });
    L.y += h + 5; return;
  }
  const hi = pw.highest, hot = pw.feedsHot[0];
  const note = [hi ? `Highest rack load: ${hi.rack} at ${hi.kw} kW (${hi.pct}% of its ${hi.rated} kW)` : '', hot ? `${hot.name} peaked at ${hot.pct}%` : ''].filter(Boolean).join('  ·  ');
  measureCard(L, 'Power Capacity Monitoring', `From the PDU Capacity page · ${rep.meta.shortLabel} compared with ${rep.meta.prevShort}`, pw.rows, SPARK.power, note);
}

function ops(L) { measureCard(L, 'Operations Snapshot', 'Server monitoring, access and approvals', L.rep.ops.rows, SPARK.ops); }

function locations(L) {
  const { rep } = L; if (!rep.locations || !rep.locations.length) return;
  const rows = rep.locations.slice(0, 14), h = 20.5 + rows.length * RH + 3;
  L.ensure(h);
  const p = L.page, b = L.card(h, 'Location-wise Change', `${rep.meta.shortLabel} figure with the change since ${rep.meta.prevShort}`);
  const cols = [{ label: 'LOCATION', x: 0, w: 38 }, { label: 'DEVICES', x: 40, w: 24, align: 'right' }, { label: 'RACK U %', x: 68, w: 24, align: 'right' }, { label: 'OPEN ISSUES', x: 96, w: 26, align: 'right' },
    { label: 'PEAK kW', x: 126, w: 20, align: 'right' }, { label: 'RECEIVED', x: 150, w: 14, align: 'right' }, { label: 'SENT OUT', x: 166, w: 14, align: 'right' }];
  L.head(b.x, b.y - 2.4, cols, b.w);
  const cell = (pair, xr, y, good, unit = '') => {
    const c = pair[1], d = pair[0] == null || pair[1] == null ? null : +(pair[1] - pair[0]).toFixed(1);
    p.text(c == null ? '—' : fmtNum(c, unit, !Number.isInteger(c) ? 1 : 0), xr - 10, y, { size: 8, font: 'HB', color: C.white, align: 'right' });
    if (d != null) L.deltaAt(xr, y, d, good, unit === '%' ? '%' : '', 0, 6.8);
  };
  rows.forEach((r, i) => {
    const y = b.y + 5.6 + i * RH;
    if (i) p.line(b.x, y - 5, b.x + b.w, y - 5, { stroke: C.row, lw: 0.15 });
    p.text(r.site, b.x, y, { size: 8.4, font: 'HB', color: C.white, maxW: 38 });
    cell(r.devices, b.x + 64, y, null); cell(r.util, b.x + 92, y, null, '%'); cell(r.openIssues, b.x + 122, y, false); cell(r.peak, b.x + 146, y, null);
    p.text(String(r.inward[1]), b.x + 164, y, { size: 8, font: 'HB', color: C.white, align: 'right' }); p.text(String(r.outward[1]), b.x + 180, y, { size: 8, font: 'HB', color: C.white, align: 'right' });
  });
  L.y += h + 5;
}

function notes(L) {
  const txt = String(L.opts.notes || '').trim(); if (!txt) return;
  const lines = txt.split('\n').slice(0, 10), est = lines.reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l, 'H', 8.2) / (W - 9))), 0);
  const h = 20.5 + est * 4.2; L.ensure(h);
  const p = L.page, b = L.card(h, 'Management notes', 'Written by the operations team for this report');
  let y = b.y + 1;
  for (const l of lines) { const c = p.paragraph(l, b.x, y, b.w, { size: 8.2, color: C.text, lineH: 4.2, maxLines: 4 }); y += Math.max(c, 1) * 4.2; }
  L.y += h + 5;
}

function render(rep, opts = {}) {
  const L = new Layout(rep, opts), m = rep.meta;
  L.newPage(`${m.scope} · every module compared with ${m.prevLabel}${m.isCurrent ? ' · month to date' : ''}`);
  if (m.firstRecord || m.stockMissing) {
    const t = m.stockMissing
      ? 'Device, rack, hardware, power and server totals were not recorded for this month, so they show a dash. Activity, material, issue and visit figures are complete.'
      : `First report: ${m.firstRecord.approx ? '* marks the position first recorded on ' + m.firstRecord.asOf + '. ' : 'Stock figures start with this month. '}DCIM now saves a snapshot every day, so the next report shows the change for these figures. Material, activity, issue and visit figures are compared in full.`;
    const n = L.page.paragraph(t, ML, L.y + 1, W, { size: 7.6, color: C.amber, lineH: 3.8, maxLines: 3 });
    L.y += n * 3.8 + 3.5;
  }
  locations(L); assets(L); mix(L); zones(L); materials(L); activities(L); issues(L); power(L); ops(L); notes(L);
  const n = L.doc.pages.length;
  L.doc.pages.forEach((pg, i) => {
    pg.text(`DCIM Dashboard · Monthly report · ${m.scope} · ${m.label} compared with ${m.prevLabel} · generated ${String(m.generatedAt).slice(0, 10)}`, ML, 291, { size: 6.4, color: '#64748B', maxW: 150 });
    pg.text(`Page ${i + 1} of ${n}`, ML + W, 291, { size: 6.4, color: '#64748B', align: 'right' });
    if (opts.sample) pg.text('SAMPLE DATA', ML + W, 15, { size: 6.8, font: 'HB', color: C.warn, align: 'right', spacing: 1 });
  });
  return L.doc.toBuffer();
}

module.exports = { render };
