'use strict';
// Renders the monthly management report (see report-data.js) as a PDF in the dark "Overall Summary" look.
const { Doc, textWidth } = require('./pdf-writer');

const C = {
  bg: '#0B1220', card: '#162033', card2: '#0F172A', line: '#334155', row: '#243247', head: '#64748B', text: '#E2E8F0', white: '#FFFFFF', mute: '#94A3B8',
  dim: '#64748B', ind: '#6366F1', indL: '#818CF8', good: '#10B981', bad: '#EF4444', warn: '#F59E0B', cyan: '#38BDF8', band: '#0A101C',
};
const MAKE_COL = { Dell: '#2F6DF6', HP: '#12A594', Unknown: '#94A3B8' };
const EXTRA = ['#F59E0B', '#A78BFA', '#EF4444', '#0EA5E9', '#84CC16', '#EC4899', '#14B8A6', '#F97316'];
function makeColor(l) { if (MAKE_COL[l]) return MAKE_COL[l]; let h = 0; for (let i = 0; i < l.length; i++) h = (h * 31 + l.charCodeAt(i)) >>> 0; return EXTRA[h % EXTRA.length]; }

const ML = 11, W = 188, PAGE_H = 297, BOTTOM = 280;
const MINUS = '−';

function fmtNum(v, unit = '', dec = 0) {
  if (v == null) return '-';
  const n = dec ? Number(v).toFixed(dec) : Math.round(Number(v)).toLocaleString('en-US');
  return n + (unit || '');
}
function fmtDelta(d, unit = '', dec = 0) {
  if (d == null) return '-';
  if (d === 0) return '0' + (unit === '%' ? ' pts' : '');
  const a = dec ? Math.abs(d).toFixed(dec) : Math.round(Math.abs(d)).toLocaleString('en-US');
  return (d > 0 ? '+' : MINUS) + a + (unit === '%' ? ' pts' : unit === ' kW' ? '' : '');
}
function deltaColor(d, good) {
  if (d == null || d === 0 || good === null || good === undefined) return C.mute;
  return (d > 0) === !!good ? C.good : C.bad;
}
function pctChange(prev, cur) { if (prev == null || cur == null || !prev) return ''; const p = Math.round((cur - prev) / Math.abs(prev) * 100); return (p > 0 ? '+' : p < 0 ? MINUS : '') + Math.abs(p) + '%'; }

class Layout {
  constructor(rep, opts) {
    this.rep = rep; this.opts = opts || {}; this.doc = new Doc({ title: `DCIM Monthly Report - ${rep.meta.scope} - ${rep.meta.label}`, subject: 'Monthly management report', author: 'DCIM Dashboard' });
    this.page = null; this.y = 0; this.pageNo = 0;
  }
  newPage(title, sub) {
    this.page = this.doc.addPage(C.bg); this.pageNo++;
    const m = this.rep.meta, p = this.page;
    p.text(`DCIM  ·  MONTHLY REPORT  ·  ${m.label.toUpperCase()} VS ${m.prevLabel.toUpperCase()}  ·  ${String(m.scope).toUpperCase()}${m.isCurrent ? '  ·  MONTH TO DATE' : ''}`, ML, 15, { size: 6.5, font: 'HB', color: C.ind, spacing: 1.1, maxW: W });
    p.text(title, ML, 24, { size: 17, font: 'TB', color: C.white, maxW: W });
    p.text(sub || '', ML, 29, { size: 6.8, color: C.dim, maxW: W });
    this.y = 34;
    return p;
  }
  ensure(h, title) { if (this.y + h > BOTTOM) this.newPage(title || 'Report (continued)', ''); }
  card(h, title, sub, o = {}) {
    const p = this.page, x = o.x == null ? ML : o.x, w = o.w == null ? W : o.w, y = o.y == null ? this.y : o.y;
    p.rect(x, y, w, h, { fill: C.card, stroke: C.line, lw: 0.25, r: 2.8 });
    if (title) p.text(title, x + 4, y + 6.2, { size: 9.2, font: 'TB', color: C.white, maxW: w - 8 });
    if (sub) p.text(sub, x + 4, y + 10.2, { size: 6.2, color: C.dim, maxW: w - 8 });
    return { x: x + 4, y: y + (sub ? 14.5 : title ? 11.5 : 9), w: w - 8 };
  }
  arrow(x, y, up, col, s = 1.5) {
    this.page.poly(up ? [[x, y + s], [x + s * 2, y + s], [x + s, y - s * 0.4]] : [[x, y - s * 0.4], [x + s * 2, y - s * 0.4], [x + s, y + s]], { fill: col });
  }
  // delta marker (triangle + text) right-aligned to xr; returns width used
  deltaAt(xr, y, d, good, unit, dec, size = 7.2) {
    const col = deltaColor(d, good), t = fmtDelta(d, unit, dec);
    const w = this.page.text(t, xr, y, { size, font: 'HB', color: col, align: 'right' });
    if (d) this.arrow(xr - w - 3.6, y - 1.6, d > 0, col, 1.35);
    return w + (d ? 4.2 : 0);
  }
  tableHead(x, y, cols, w) {
    this.page.line(x, y + 1.6, x + w, y + 1.6, { stroke: C.line, lw: 0.2 });
    for (const c of cols) this.page.text(c.label, c.align === 'right' ? x + c.x + c.w : c.align === 'center' ? x + c.x + c.w / 2 : x + c.x, y, { size: 5.6, font: 'HB', color: C.dim, spacing: 0.7, align: c.align || 'left' });
  }
  cx(c, x) { return c.align === 'right' ? x + c.x + c.w : c.align === 'center' ? x + c.x + c.w / 2 : x + c.x; }
}

function spark(p, x, y, w, h, vals, col) {
  const pts = vals.map((v, i) => ({ v, i })).filter((o) => o.v != null);
  if (pts.length < 2) { p.text('-', x + w / 2, y + h / 2 + 1, { size: 7, color: C.dim, align: 'center' }); return; }
  const mn = Math.min(...pts.map((o) => o.v)), mx = Math.max(...pts.map((o) => o.v)), r = (mx - mn) || 1, n = vals.length - 1;
  const xy = pts.map((o) => [x + (o.i / n) * w, y + h - ((o.v - mn) / r) * h]);
  p.poly(xy, { stroke: col, lw: 0.35 });
  const last = xy[xy.length - 1]; p.circle(last[0], last[1], 0.7, { fill: col });
}

// ---------------------------------------------------------------- sections ----------------------------------------------------------------
function tiles(L) {
  const { rep } = L, p = L.page, cw = (W - 8) / 3, th = 21;
  rep.tiles.forEach((t, i) => {
    const x = ML + (i % 3) * (cw + 4), y = L.y + Math.floor(i / 3) * (th + 4);
    p.rect(x, y, cw, th, { fill: C.card, stroke: C.line, lw: 0.25, r: 2.4 });
    p.text(t.label.toUpperCase(), x + 3.6, y + 5.2, { size: 5.6, font: 'HB', color: C.dim, spacing: 0.7, maxW: cw - 6 });
    const vtxt = t.cur == null ? '-' : fmtNum(t.cur, t.unit);
    const vw = p.text(vtxt, x + 3.6, y + 12.6, { size: 15, font: 'TB', color: C.white });
    if (t.delta != null) { if (t.delta) L.arrow(x + 3.6 + vw + 2.6, y + 10.6, t.delta > 0, deltaColor(t.delta, t.good), 1.5); if (t.delta) p.text(fmtDelta(t.delta, t.unit.trim() === '%' ? '%' : ''), x + 3.6 + vw + 7.4, y + 12.2, { size: 7.4, font: 'HB', color: deltaColor(t.delta, t.good) }); else p.text('no change', x + 3.6 + vw + 3, y + 12.2, { size: 6.4, color: C.mute }); }
    const prevTxt = t.prev == null ? 'No earlier figure yet' : `${rep.meta.prevShort} ${fmtNum(t.prev, t.unit)}${t.prev && t.cur != null && t.prev !== t.cur ? ' · ' + pctChange(t.prev, t.cur) : ''}`;
    p.text(prevTxt + (t.note ? '  ·  ' + t.note : ''), x + 3.6, y + 17.6, { size: 5.9, color: C.dim, maxW: cw - 6 });
  });
  L.y += 2 * th + 4 + 5;
}

function ranked(L) {
  const { rep } = L; let p = L.page; const rows = rep.ranked;
  const h = 18 + Math.max(rows.length, 1) * 7;
  L.ensure(h); p = L.page;
  const b = L.card(h, 'Biggest changes this month', `Ranked by size of change versus ${rep.meta.prevLabel}`);
  const cols = [{ label: '#', x: 0, w: 5 }, { label: 'WHAT', x: 6, w: 60 }, { label: rep.meta.prevShort.toUpperCase(), x: 66, w: 14, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 82, w: 14, align: 'right' },
    { label: 'CHANGE', x: 100, w: 22, align: 'right' }, { label: 'WHY IT MATTERS', x: 128, w: 52 }];
  L.tableHead(b.x, b.y, cols, b.w);
  if (!rows.length) { p.text('Not enough data in both months to rank changes yet.', b.x, b.y + 8, { size: 7, color: C.mute }); }
  rows.forEach((r, i) => {
    const y = b.y + 7 + i * 7;
    if (i) p.line(b.x, y - 4.6, b.x + b.w, y - 4.6, { stroke: C.row, lw: 0.15 });
    p.text(String(i + 1), b.x, y, { size: 7, color: C.dim });
    p.text(r.what, b.x + 6, y, { size: 7.2, font: 'HB', color: C.white, maxW: 58 });
    p.text(fmtNum(r.prev, r.unit), b.x + 80, y, { size: 7.2, color: C.dim, align: 'right' });
    p.text(fmtNum(r.cur, r.unit), b.x + 96, y, { size: 7.2, font: 'HB', color: C.white, align: 'right' });
    L.deltaAt(b.x + 122, y, r.delta, r.good, r.unit === '%' ? '%' : '', 0, 7);
    p.text(r.why, b.x + 128, y, { size: 6.3, color: C.mute, maxW: 52 });
  });
  L.y += h + 5;
}

function flows(L) {
  const { rep } = L;
  for (const f of rep.flows) {
    const h = 30; L.ensure(h); const p = L.page;
    const b = L.card(h, f.title);
    const boxes = [{ v: f.open, label: `${rep.meta.prevShort.toUpperCase()} END`, col: C.line, vc: C.white }];
    f.steps.forEach((s) => boxes.push({ v: s.n, label: s.label.toUpperCase(), col: s.n < 0 ? '#7F1D1D' : '#065F46', vc: s.n < 0 ? C.bad : C.good, signed: true }));
    boxes.push({ v: f.close, label: `${rep.meta.shortLabel.toUpperCase()} ${rep.meta.isCurrent ? 'SO FAR' : 'END'}`, col: C.ind, vc: C.white });
    const n = boxes.length, gap = 6, bw = (b.w - gap * (n - 1)) / n;
    boxes.forEach((bx, i) => {
      const x = b.x + i * (bw + gap), y = b.y - 1;
      p.rect(x, y, bw, 14, { fill: C.card2, stroke: bx.col, lw: 0.3, r: 2.4 });
      const t = bx.v == null ? '-' : bx.signed ? (bx.v > 0 ? '+' : bx.v < 0 ? MINUS : '') + Math.abs(bx.v) : String(bx.v);
      p.text(t, x + bw / 2, y + 7, { size: 11.5, font: 'TB', color: bx.vc, align: 'center' });
      p.text(bx.label, x + bw / 2, y + 11.6, { size: 4.9, font: 'HB', color: C.dim, spacing: 0.4, align: 'center', maxW: bw - 2 });
      if (i < n - 1) p.text(i === n - 2 ? '=' : '+', x + bw + gap / 2, y + 8, { size: 8, color: C.dim, align: 'center' });
    });
    L.y += h + 4;
  }
  L.y += 1;
}

function mix(L) {
  const { rep } = L, rows = rep.hardwareMix.slice(0, 10);
  const h = 18 + Math.max(rows.length, 1) * 7;
  L.ensure(h); const p = L.page;
  const b = L.card(h, 'Hardware Mix - change by make', `${rep.meta.shortLabel} count with the change since ${rep.meta.prevShort}`);
  if (!rows.length) { p.text('No installed hardware recorded.', b.x, b.y + 4, { size: 7, color: C.mute }); L.y += h + 5; return; }
  const max = Math.max(...rows.map((r) => r.cur || 0), 1), lw = 22, bx = b.x + lw + 3, bwMax = b.w - lw - 3 - 22;
  rows.forEach((r, i) => {
    const y = b.y + 2 + i * 7;
    p.text(r.make, b.x + lw, y + 2.6, { size: 7.2, font: 'HB', color: C.text, align: 'right', maxW: lw });
    p.rect(bx, y - 1.2, bwMax, 5, { fill: C.card2, r: 2.5 });
    const w = Math.max(r.cur ? (r.cur / max) * bwMax : 0, r.cur ? 3 : 0);
    if (w) { p.rect(bx, y - 1.2, w, 5, { fill: makeColor(r.make), r: 2.5 }); if (w > 12) p.text(String(r.cur), bx + w - 2, y + 2.4, { size: 6.4, font: 'HB', color: '#0B1220', align: 'right' }); }
    const d = r.cur != null && r.prev != null ? r.cur - r.prev : null;
    if (d == null) p.text(r.cur == null ? '-' : 'new', b.x + b.w, y + 2.8, { size: 6.6, color: C.mute, align: 'right' });
    else L.deltaAt(b.x + b.w, y + 2.8, d, null, '', 0, 7);
  });
  L.y += h + 5;
}

function locations(L) {
  const { rep } = L; let p = L.page; if (!rep.locations || !rep.locations.length) return;
  const rows = rep.locations.slice(0, 14), h = 18 + rows.length * 7;
  L.ensure(h); p = L.page;
  const b = L.card(h, 'Location-wise change', `${rep.meta.shortLabel} figure with the change since ${rep.meta.prevShort}`);
  const cols = [{ label: 'LOCATION', x: 0, w: 38 }, { label: 'DEVICES', x: 40, w: 24, align: 'right' }, { label: 'RACK U %', x: 68, w: 24, align: 'right' }, { label: 'OPEN ISSUES', x: 96, w: 26, align: 'right' },
    { label: 'PEAK kW', x: 126, w: 20, align: 'right' }, { label: 'RECEIVED', x: 150, w: 14, align: 'right' }, { label: 'SENT OUT', x: 166, w: 14, align: 'right' }];
  L.tableHead(b.x, b.y, cols, b.w);
  const cell = (pair, xr, y, good, unit = '') => {
    const cur = pair[1], d = pair[0] == null || pair[1] == null ? null : +(pair[1] - pair[0]).toFixed(1);
    p.text(cur == null ? '-' : fmtNum(cur, unit, unit === '' && !Number.isInteger(cur) ? 1 : 0), xr - 9.5, y, { size: 7, font: 'HB', color: C.white, align: 'right' });
    if (d != null) L.deltaAt(xr, y, d, good, unit === '%' ? '%' : '', 0, 6.2); else p.text('', xr, y);
  };
  rows.forEach((r, i) => {
    const y = b.y + 7 + i * 7;
    if (i) p.line(b.x, y - 4.6, b.x + b.w, y - 4.6, { stroke: C.row, lw: 0.15 });
    p.text(r.site, b.x, y, { size: 7.2, font: 'HB', color: C.white, maxW: 38 });
    cell(r.devices, b.x + 64, y, null); cell(r.util, b.x + 92, y, null, '%'); cell(r.openIssues, b.x + 122, y, false);
    cell(r.peak, b.x + 146, y, null);
    p.text(String(r.inward[1]), b.x + 164, y, { size: 7, font: 'HB', color: C.white, align: 'right' }); p.text(String(r.outward[1]), b.x + 180, y, { size: 7, font: 'HB', color: C.white, align: 'right' });
  });
  L.y += h + 5;
}

function detail(L) {
  const { rep } = L; let p;
  const groups = []; for (const r of rep.rows) { let g = groups.find((x) => x.name === r.group); if (!g) groups.push(g = { name: r.group, rows: [] }); g.rows.push(r); }
  const nRows = rep.rows.length, h = 18 + nRows * 6.9 + groups.length * 6.4;
  L.newPage('Month-on-month detail', `Every measure: ${rep.meta.prevLabel}, ${rep.meta.label}, change and 6-month trend`);
  p = L.page;
  const b = L.card(h);
  const cols = [{ label: 'MEASURE', x: 0, w: 54 }, { label: rep.meta.prevShort.toUpperCase(), x: 58, w: 18, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 80, w: 18, align: 'right' },
    { label: 'CHANGE', x: 104, w: 24, align: 'right' }, { label: '%', x: 132, w: 12, align: 'right' }, { label: '6-MONTH TREND', x: 150, w: 30, align: 'center' }];
  L.tableHead(b.x, b.y - 4, cols, b.w);
  let y = b.y + 3;
  const colors = { 'Assets and space': C.ind, 'Power and servers': C.warn, Issues: C.bad, 'Material movements': C.good, 'Activities and visitors': C.cyan };
  groups.forEach((g) => {
    p.rect(b.x - 1, y - 3.6, b.w + 2, 5.4, { fill: C.band, r: 1 });
    p.text(g.name.toUpperCase(), b.x + 1, y, { size: 5.8, font: 'HB', color: C.indL, spacing: 0.8 });
    y += 6;
    g.rows.forEach((r) => {
      const d = r.prev == null || r.cur == null ? null : +(r.cur - r.prev).toFixed(r.dec || 0);
      p.text(r.label, b.x + 1, y, { size: 7.1, font: 'HB', color: C.white, maxW: 54 });
      p.text(fmtNum(r.prev, r.unit, r.dec), b.x + 76, y, { size: 7.1, color: C.dim, align: 'right' });
      p.text(fmtNum(r.cur, r.unit, r.dec), b.x + 98, y, { size: 7.1, font: 'HB', color: C.white, align: 'right' });
      L.deltaAt(b.x + 128, y, d, r.good, r.unit === '%' ? '%' : '', r.dec || 0, 6.8);
      p.text(d == null ? '-' : pctChange(r.prev, r.cur) || '', b.x + 144, y, { size: 6.4, color: C.dim, align: 'right' });
      spark(p, b.x + 153, y - 3.6, 24, 4.6, r.series, colors[g.name] || C.ind);
      y += 6.9;
    });
  });
  L.y += h + 5;
}

function itemCard(L, x, w, title, list, totals, color, label) {
  const { rep } = L, p = L.page, shown = list.slice(0, 7), extra = list.length - shown.length;
  const h = 22 + Math.max(shown.length, 1) * 6.6 + (extra > 0 ? 5 : 0);
  const b = L.card(h, title, `Quantity - change vs ${rep.meta.prevShort}`, { x, w, y: L.y });
  if (!shown.length) p.text('Nothing recorded this month.', b.x, b.y + 4, { size: 6.8, color: C.mute });
  const max = Math.max(...shown.map((s) => s.cur), 1), lw = 28, bw = b.w - lw - 20;
  shown.forEach((s, i) => {
    const y = b.y + 1 + i * 6.6;
    p.text(s.item, b.x, y + 2.6, { size: 6.3, color: C.text, maxW: lw - 1 });
    p.rect(b.x + lw, y - 0.9, bw, 4.2, { fill: C.card2, r: 2 });
    const bwid = Math.max(s.cur ? (s.cur / max) * bw : 0, s.cur ? 2.5 : 0);
    if (bwid) { p.rect(b.x + lw, y - 0.9, bwid, 4.2, { fill: color, r: 2 }); if (bwid > 8) p.text(String(s.cur), b.x + lw + bwid - 1.5, y + 2.2, { size: 5.6, font: 'HB', color: '#0B1220', align: 'right' }); }
    L.deltaAt(b.x + b.w, y + 2.6, s.cur - s.prev, null, '', 0, 6.4);
  });
  if (extra > 0) p.text(`+ ${extra} more item${extra === 1 ? '' : 's'} not shown`, b.x, b.y + 3 + shown.length * 6.6, { size: 5.8, color: C.dim });
  p.text(`${label}: ${totals.cur} this month (${totals.prev} in ${rep.meta.prevShort})`, b.x, y2(L, h) - 2.2, { size: 5.9, color: C.mute });
  return h;
}
function y2(L, h) { return L.y + h; }

function materials(L) {
  const { rep } = L, half = (W - 4) / 2;
  const hIn = 22 + Math.max(Math.min(rep.inward.length, 7), 1) * 6.6 + (rep.inward.length > 7 ? 5 : 0);
  const hOut = 22 + Math.max(Math.min(rep.outward.length, 7), 1) * 6.6 + (rep.outward.length > 7 ? 5 : 0);
  const h = Math.max(hIn, hOut);
  L.ensure(h);
  const a = itemCard(L, ML, half, 'Material Received (Inward)', rep.inward, rep.inwardTotals, C.good, 'Entries');
  const b = itemCard(L, ML + half + 4, half, 'Material Sent Out (Outward)', rep.outward, rep.outwardTotals, C.bad, 'Entries');
  L.y += Math.max(a, b) + 5;
}

function activities(L) {
  const { rep } = L, rows = rep.activities.slice(0, 10), h = 18 + Math.max(rows.length, 1) * 6.6;
  L.ensure(h); const p = L.page;
  const b = L.card(h, 'DC Activity Record - change by type');
  const cols = [{ label: 'TYPE', x: 0, w: 70 }, { label: rep.meta.prevShort.toUpperCase(), x: 100, w: 18, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 122, w: 18, align: 'right' }, { label: 'CHANGE', x: 150, w: 30, align: 'right' }];
  L.tableHead(b.x, b.y - 2, cols, b.w);
  if (!rows.length) p.text('No DC activity recorded in these two months.', b.x, b.y + 5, { size: 6.8, color: C.mute });
  rows.forEach((r, i) => {
    const y = b.y + 5 + i * 6.6;
    if (i) p.line(b.x, y - 4.4, b.x + b.w, y - 4.4, { stroke: C.row, lw: 0.15 });
    p.text(r.type, b.x, y, { size: 7, color: C.text, maxW: 90 });
    p.text(String(r.prev), b.x + 118, y, { size: 7, color: C.dim, align: 'right' });
    p.text(String(r.cur), b.x + 140, y, { size: 7, font: 'HB', color: C.white, align: 'right' });
    L.deltaAt(b.x + b.w, y, r.cur - r.prev, null, '', 0, 6.8);
  });
  L.y += h + 5;
}

function watch(L) {
  const { rep } = L, rows = rep.watch, h = 18 + rows.length * 7.4;
  if (L.pageNo < 3 || L.y > 120) L.newPage('Watch list for next month', 'Things that changed for the worse or need a decision, with this month’s movement');
  else L.ensure(h);
  let p = L.page;
  const b = L.card(h, 'Needs attention');
  const cols = [{ label: 'ITEM', x: 0, w: 56 }, { label: rep.meta.prevShort.toUpperCase(), x: 58, w: 12, align: 'right' }, { label: rep.meta.shortLabel.toUpperCase(), x: 74, w: 12, align: 'right' },
    { label: 'CHANGE', x: 88, w: 22, align: 'right' }, { label: 'DETAIL', x: 116, w: 64 }];
  L.tableHead(b.x, b.y - 2, cols, b.w);
  rows.forEach((r, i) => {
    const y = b.y + 5 + i * 7.4;
    if (i) p.line(b.x, y - 4.8, b.x + b.w, y - 4.8, { stroke: C.row, lw: 0.15 });
    p.text(r.item, b.x, y, { size: 7.1, font: 'HB', color: C.white, maxW: 56 });
    p.text(r.prev == null ? '-' : String(r.prev), b.x + 70, y, { size: 7.1, color: C.dim, align: 'right' });
    const cc = r.cur == null ? C.mute : r.delta > 0 ? C.bad : r.cur > 0 ? C.warn : C.good;
    p.text(r.cur == null ? '-' : String(r.cur), b.x + 86, y, { size: 7.4, font: 'HB', color: cc, align: 'right' });
    L.deltaAt(b.x + 110, y, r.delta, false, '', 0, 6.8);
    p.paragraph(r.detail || '', b.x + 116, y - 0.3, 64, { size: 5.9, color: C.mute, maxLines: 2, lineH: 2.6 });
  });
  L.y += h + 5;
  // zones
  const zs = rep.zones.slice(0, 12);
  if (zs.length) {
    const rowsN = Math.ceil(zs.length / 2), zh = 18 + rowsN * 16;
    L.ensure(zh); p = L.page;
    const zb = L.card(zh, 'Zone-wise Rack Overview - change', `U-space utilization with the change since ${rep.meta.prevLabel}`);
    const cw = (zb.w - 4) / 2;
    zs.forEach((z, i) => {
      const x = zb.x + (i % 2) * (cw + 4), y = zb.y - 1 + Math.floor(i / 2) * 16;
      p.rect(x, y, cw, 13, { fill: C.card2, stroke: C.line, lw: 0.2, r: 2 });
      p.text(z.zone, x + 3, y + 5, { size: 7.2, font: 'HB', color: C.white, maxW: cw / 2 });
      const dv = z.cur != null && z.prev != null ? z.cur - z.prev : null;
      if (z.cur != null) { if (dv != null) L.deltaAt(x + cw - 3, y + 5, dv, null, '%', 0, 6.6); p.text(`${z.cur}%`, x + cw - 3 - (dv != null && dv ? 17 : dv === 0 ? 11 : 0), y + 5, { size: 8, font: 'HB', color: C.warn, align: 'right' }); }
      else p.text('-', x + cw - 3, y + 5, { size: 8, color: C.mute, align: 'right' });
      p.text(`${z.usedU == null ? '-' : z.usedU + ' U used'}${z.prev != null ? '  ·  ' + rep.meta.prevShort + ' ' + z.prev + '%' : ''}`, x + 3, y + 8.4, { size: 5.8, color: C.dim });
      p.rect(x + 3, y + 9.8, cw - 6, 1.6, { fill: '#1E293B', r: 0.8 });
      if (z.cur) p.rect(x + 3, y + 9.8, Math.max(0.8, (cw - 6) * Math.min(z.cur, 100) / 100), 1.6, { fill: C.warn, r: 0.8 });
    });
    L.y += zh + 5;
  }
  // management notes
  const notes = String(L.opts.notes || '').trim();
  if (notes) {
    const lines = Math.min(10, Math.ceil(notes.length / 120) + (notes.split('\n').length - 1));
    const nh = 17 + lines * 3.4; L.ensure(nh); p = L.page;
    const nb = L.card(nh, 'Management notes', 'Written by the operations team for this report');
    let yy = nb.y + 1.5; for (const ln of notes.split('\n').slice(0, 10)) { const c = p.paragraph(ln, nb.x, yy, nb.w, { size: 7, color: C.text, lineH: 3.4, maxLines: 4 }); yy += Math.max(c, 1) * 3.4; }
    L.y += nh + 5;
  }
  // not captured
  const txt = [rep.meta.stateNote, ...(rep.notes || [])].filter(Boolean).join(' ');
  const nl = Math.ceil(textWidth(txt, 'H', 6.4) / (W - 8)) + 1, ch = 14 + nl * 3;
  L.ensure(ch); p = L.page;
  const cb = L.card(ch, 'Data coverage');
  p.paragraph(txt, cb.x, cb.y + 1, cb.w, { size: 6.4, color: C.mute, lineH: 3, maxLines: 8 });
  L.y += ch + 5;
}

function render(rep, opts = {}) {
  const L = new Layout(rep, opts);
  const m = rep.meta;
  L.newPage(m.isCurrent ? `What changed so far in ${m.label.split(' ')[0]}` : `What changed in ${m.label.split(' ')[0]}`,
    `${m.scope} · opening position (end of ${m.prevLabel.split(' ')[0]}) to closing position (${m.isCurrent ? 'today' : 'end of ' + m.label.split(' ')[0]}) · biggest movements first`);
  tiles(L); ranked(L); locations(L); flows(L); mix(L);
  detail(L); materials(L); activities(L);
  watch(L);
  const n = L.doc.pages.length;
  L.doc.pages.forEach((pg, i) => {
    pg.text(`DCIM Dashboard · Monthly report · ${m.scope} · ${m.label} compared with ${m.prevLabel} · generated ${String(m.generatedAt).slice(0, 10)}`, ML, 291, { size: 6, color: '#475569', maxW: 150 });
    pg.text(`Page ${i + 1} of ${n}`, ML + W, 291, { size: 6, color: '#475569', align: 'right' });
    if (opts.sample) pg.text('SAMPLE DATA', ML + W, 15, { size: 6.5, font: 'HB', color: C.warn, align: 'right', spacing: 1 });
  });
  return L.doc.toBuffer();
}

module.exports = { render };
