'use strict';
// Minimal dependency-free PDF writer: A4 pages, standard fonts, filled / stroked shapes and text. Coordinates are in millimetres
// measured from the TOP-LEFT of the page. Used for the monthly management report (the update kit ships without node_modules).
const zlib = require('zlib');
const WIDTHS = require('./pdf-font-widths');

const MM = 72 / 25.4;
const FONTS = { H: { res: 'F1', base: 'Helvetica' }, HB: { res: 'F2', base: 'Helvetica-Bold' }, TB: { res: 'F3', base: 'Times-Bold' } };
const SUBST = { '−': '-', '≥': '>=', '≤': '<=', '→': '->', '•': '•', '▲': '^', '▼': 'v', ' ': ' ', ' ': ' ', '​': '' };

function toWin(str) {
  const s = String(str == null ? '' : str).replace(/[−≥≤→▲▼  ​]/g, (c) => SUBST[c]);
  const buf = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) buf.push(c);
    else if (c >= 160 && c <= 255) buf.push(c);
    else {
      const map = { 0x2013: 150, 0x2014: 151, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149, 0x2026: 133, 0x20AC: 128 };
      buf.push(map[c] || 63);
    }
  }
  return Buffer.from(buf);
}
function textWidth(str, font, size) {
  const w = WIDTHS[font] || WIDTHS.H; let t = 0;
  for (const b of toWin(str)) t += w[b] || 0;
  return (t / 1000) * size / MM; // millimetres
}
function esc(buf) {
  let o = '';
  for (const b of buf) { const ch = String.fromCharCode(b); o += (ch === '(' || ch === ')' || ch === '\\') ? '\\' + ch : (b < 32 || b > 126) ? '\\' + b.toString(8).padStart(3, '0') : ch; }
  return o;
}
function rgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [0, 2, 4].map((i) => (parseInt(f.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
}
const n2 = (v) => (Math.round(v * 100) / 100).toString();

class Page {
  constructor(doc, wMm, hMm) { this.doc = doc; this.w = wMm; this.h = hMm; this.ops = []; this.gs = new Set(); }
  X(x) { return n2(x * MM); }
  Y(y) { return n2((this.h - y) * MM); }
  alpha(a) {
    if (a == null || a >= 1) return null;
    const id = 'G' + Math.round(a * 100); this.gs.add(id); return id;
  }
  // rounded rectangle path
  _rr(x, y, w, h, r) {
    const k = 0.5523, rr = Math.min(r, w / 2, h / 2);
    if (!rr) return `${this.X(x)} ${this.Y(y + h)} ${n2(w * MM)} ${n2(h * MM)} re`;
    const X = (v) => this.X(v), Y = (v) => this.Y(v);
    const x2 = x + w, y2 = y + h;
    return [`${X(x + rr)} ${Y(y)} m`, `${X(x2 - rr)} ${Y(y)} l`, `${X(x2 - rr + rr * k)} ${Y(y)} ${X(x2)} ${Y(y + rr - rr * k)} ${X(x2)} ${Y(y + rr)} c`,
      `${X(x2)} ${Y(y2 - rr)} l`, `${X(x2)} ${Y(y2 - rr + rr * k)} ${X(x2 - rr + rr * k)} ${Y(y2)} ${X(x2 - rr)} ${Y(y2)} c`,
      `${X(x + rr)} ${Y(y2)} l`, `${X(x + rr - rr * k)} ${Y(y2)} ${X(x)} ${Y(y2 - rr + rr * k)} ${X(x)} ${Y(y2 - rr)} c`,
      `${X(x)} ${Y(y + rr)} l`, `${X(x)} ${Y(y + rr - rr * k)} ${X(x + rr - rr * k)} ${Y(y)} ${X(x + rr)} ${Y(y)} c`, 'h'].join('\n');
  }
  rect(x, y, w, h, o = {}) {
    if (w <= 0 || h <= 0) return this;
    const { fill, stroke, lw = 0.2, r = 0, alpha } = o;
    const g = this.alpha(alpha);
    this.ops.push('q');
    if (g) this.ops.push(`/${g} gs`);
    if (fill) this.ops.push(`${rgb(fill)} rg`);
    if (stroke) this.ops.push(`${rgb(stroke)} RG ${n2(lw * MM)} w`);
    this.ops.push(this._rr(x, y, w, h, r));
    this.ops.push(fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n');
    this.ops.push('Q');
    return this;
  }
  line(x1, y1, x2, y2, o = {}) {
    const { stroke = '#334155', lw = 0.2, alpha } = o; const g = this.alpha(alpha);
    this.ops.push(`q${g ? ` /${g} gs` : ''} ${rgb(stroke)} RG ${n2(lw * MM)} w ${this.X(x1)} ${this.Y(y1)} m ${this.X(x2)} ${this.Y(y2)} l S Q`);
    return this;
  }
  poly(points, o = {}) {
    if (!points || points.length < 2) return this;
    const { fill, stroke, lw = 0.3, close = false } = o;
    let d = `${this.X(points[0][0])} ${this.Y(points[0][1])} m `;
    for (let i = 1; i < points.length; i++) d += `${this.X(points[i][0])} ${this.Y(points[i][1])} l `;
    if (close || fill) d += 'h ';
    this.ops.push(`q ${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' + n2(lw * MM) + ' w 1 j 1 J ' : ''}${d}${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`);
    return this;
  }
  circle(cx, cy, r, o = {}) {
    const k = 0.5523 * r, X = (v) => this.X(v), Y = (v) => this.Y(v);
    const p = `${X(cx + r)} ${Y(cy)} m ${X(cx + r)} ${Y(cy + k)} ${X(cx + k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ${X(cx - k)} ${Y(cy + r)} ${X(cx - r)} ${Y(cy + k)} ${X(cx - r)} ${Y(cy)} c ${X(cx - r)} ${Y(cy - k)} ${X(cx - k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ${X(cx + k)} ${Y(cy - r)} ${X(cx + r)} ${Y(cy - k)} ${X(cx + r)} ${Y(cy)} c h`;
    this.ops.push(`q ${o.fill ? rgb(o.fill) + ' rg ' : ''}${o.stroke ? rgb(o.stroke) + ' RG ' + n2((o.lw || 0.2) * MM) + ' w ' : ''}${p} ${o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S'} Q`);
    return this;
  }
  // text with baseline at y. align: left | right | center. Returns the width in mm.
  text(str, x, y, o = {}) {
    const { size = 9, font = 'H', color = '#E2E8F0', align = 'left', spacing = 0, maxW } = o;
    let s = String(str == null ? '' : str);
    let w = textWidth(s, font, size) + spacing * s.length / MM;
    if (maxW && w > maxW) {
      while (s.length > 1 && textWidth(s + '...', font, size) + spacing * (s.length + 3) / MM > maxW) s = s.slice(0, -1);
      s = s.replace(/\s+$/, '') + '...'; w = textWidth(s, font, size) + spacing * s.length / MM;
    }
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${FONTS[font].res} ${n2(size)} Tf ${n2(spacing)} Tc ${rgb(color)} rg ${this.X(x0)} ${this.Y(y)} Td (${esc(toWin(s))}) Tj ET`);
    return w;
  }
  // wraps text to maxW; returns number of lines drawn (stops at maxLines, adding an ellipsis)
  paragraph(str, x, y, maxW, o = {}) {
    const { size = 9, font = 'H', lineH = size * 0.42, maxLines = 99 } = o;
    const words = String(str || '').split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (const wd of words) {
      const t = cur ? cur + ' ' + wd : wd;
      if (textWidth(t, font, size) <= maxW || !cur) cur = t; else { lines.push(cur); cur = wd; }
    }
    if (cur) lines.push(cur);
    const shown = lines.slice(0, maxLines);
    if (lines.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1].replace(/\s+\S*$/, '') + '...';
    shown.forEach((l, i) => this.text(l, x, y + i * lineH, { ...o, maxW }));
    return shown.length;
  }
}

class Doc {
  constructor(opts = {}) { this.pages = []; this.info = opts; this.w = opts.w || 210; this.h = opts.h || 297; }
  addPage(bg) { const p = new Page(this, this.w, this.h); if (bg) p.rect(0, 0, this.w, this.h, { fill: bg }); this.pages.push(p); return p; }
  toBuffer() {
    const objs = []; // index = object number - 1
    const reserve = () => { objs.push(null); return objs.length; };
    const set = (id, body) => { objs[id - 1] = body; };
    const catalog = reserve(), pagesId = reserve();
    const fontIds = {};
    for (const k of Object.keys(FONTS)) { const id = reserve(); fontIds[k] = id; set(id, Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[k].base} /Encoding /WinAnsiEncoding >>`)); }
    const gsIds = {};
    const allGs = new Set(); this.pages.forEach((p) => p.gs.forEach((g) => allGs.add(g)));
    for (const g of allGs) { const id = reserve(); gsIds[g] = id; const a = (parseInt(g.slice(1), 10) / 100).toFixed(2); set(id, Buffer.from(`<< /Type /ExtGState /ca ${a} /CA ${a} >>`)); }
    const resDict = `<< /Font << ${Object.keys(FONTS).map((k) => `/${FONTS[k].res} ${fontIds[k]} 0 R`).join(' ')} >>${allGs.size ? ` /ExtGState << ${[...allGs].map((g) => `/${g} ${gsIds[g]} 0 R`).join(' ')} >>` : ''} >>`;
    const pageIds = [];
    for (const p of this.pages) {
      const cId = reserve(), pId = reserve();
      const raw = Buffer.from(p.ops.join('\n'), 'latin1');
      const z = zlib.deflateSync(raw);
      set(cId, Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from('\nendstream')]));
      set(pId, Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n2(p.w * MM)} ${n2(p.h * MM)}] /Resources ${resDict} /Contents ${cId} 0 R >>`));
      pageIds.push(pId);
    }
    set(pagesId, Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`));
    set(catalog, Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
    const infoId = reserve();
    const pdfStr = (s) => '(' + esc(toWin(s)) + ')';
    const d = new Date(); const pd = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
    set(infoId, Buffer.from(`<< /Title ${pdfStr(this.info.title || '')} /Author ${pdfStr(this.info.author || 'DCIM')} /Subject ${pdfStr(this.info.subject || '')} /Creator (DCIM Dashboard) /Producer (DCIM Dashboard) /CreationDate (${pd}) >>`));
    const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offsets = []; let pos = chunks[0].length;
    objs.forEach((body, i) => {
      offsets.push(pos);
      const head = Buffer.from(`${i + 1} 0 obj\n`); const tail = Buffer.from('\nendobj\n');
      chunks.push(head, body, tail); pos += head.length + body.length + tail.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`].concat(offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)).join('');
    chunks.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
    return Buffer.concat(chunks);
  }
}

module.exports = { Doc, textWidth };
