'use strict';
// Draws a PDF page that is made of vector shapes (no text layer, no scanned picture) into a black-and-white bitmap,
// so it can be read by the offline OCR engine. This is what "Microsoft Print to PDF" and some invoice/ERP exporters
// produce: every letter is a small filled outline. Pure JavaScript - no native image library or canvas needed.
// Supports what such pages use: save/restore, transform, filled and stroked paths (lines + curves), fill colours.
// Not supported (ignored): clipping, shading/pattern fills, embedded pictures (logos / QR codes are not needed to read the text).

const CURVE_STEPS = 8;
const MAX_PIXELS = 24e6;

function mul(m, n) { // point goes through m first, then n
  return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Scanline fill of several closed polygons (device pixels) into a gray buffer. rule: 'nz' or 'eo'.
function fillPolys(buf, W, H, polys, value, rule) {
  let ymin = Infinity, ymax = -Infinity;
  const edges = [];
  for (const poly of polys) {
    const n = poly.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if (a[1] === b[1]) continue;
      const dir = a[1] < b[1] ? 1 : -1;
      const top = dir === 1 ? a : b, bot = dir === 1 ? b : a;
      edges.push({ x0: top[0], y0: top[1], y1: bot[1], slope: (bot[0] - top[0]) / (bot[1] - top[1]), dir });
      if (top[1] < ymin) ymin = top[1];
      if (bot[1] > ymax) ymax = bot[1];
    }
  }
  if (!edges.length) return;
  const ys = Math.max(0, Math.ceil(ymin - 0.5)), ye = Math.min(H - 1, Math.floor(ymax - 0.5));
  for (let y = ys; y <= ye; y++) {
    const cy = y + 0.5; const xs = [];
    for (const e of edges) if (cy >= e.y0 && cy < e.y1) xs.push([e.x0 + (cy - e.y0) * e.slope, e.dir]);
    if (xs.length < 2) continue;
    xs.sort((p, q) => p[0] - q[0]);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind = rule === 'eo' ? (wind ^ 1) : wind + xs[i][1];
      if (wind !== 0) {
        const xa = Math.max(0, Math.ceil(xs[i][0] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[i + 1][0] - 0.5));
        if (xb >= xa) buf.fill(value, y * W + xa, y * W + xb + 1);
      }
    }
  }
}

// pdf.js 4.x operator list -> bitmap. Returns { width, height, bits } where bits is a 1-bit-per-pixel buffer (1 = white).
function rasterize(pdfjs, page, opsList, scale) {
  const O = pdfjs.OPS;
  let sc = scale;
  let vp = page.getViewport({ scale: sc });
  if (vp.width * vp.height > MAX_PIXELS) { sc = sc * Math.sqrt(MAX_PIXELS / (vp.width * vp.height)); vp = page.getViewport({ scale: sc }); }
  const W = Math.max(1, Math.ceil(vp.width)), H = Math.max(1, Math.ceil(vp.height));
  const buf = new Uint8Array(W * H).fill(255);
  let st = { ctm: vp.transform.slice(), fill: 0, stroke: 0, lw: 1 };
  const stack = [];
  let path = []; // closed/open sub-paths in device space
  let cur = null;
  const flat = (st0) => st0;
  void flat;

  const startSub = (x, y) => { cur = [apply(st.ctm, x, y)]; path.push({ pts: cur, closed: false }); };
  const addCurve = (x1, y1, x2, y2, x3, y3) => {
    const p0 = cur[cur.length - 1];
    const p1 = apply(st.ctm, x1, y1), p2 = apply(st.ctm, x2, y2), p3 = apply(st.ctm, x3, y3);
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS, u = 1 - t;
      cur.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
  };
  const addPath = (subOps, c) => {
    let k = 0, lastX = 0, lastY = 0;
    for (const op of subOps) {
      if (op === O.moveTo) { lastX = c[k++]; lastY = c[k++]; startSub(lastX, lastY); }
      else if (op === O.lineTo) { if (!cur) startSub(lastX, lastY); lastX = c[k++]; lastY = c[k++]; cur.push(apply(st.ctm, lastX, lastY)); }
      else if (op === O.curveTo) { if (!cur) startSub(lastX, lastY); const x1 = c[k++], y1 = c[k++], x2 = c[k++], y2 = c[k++], x3 = c[k++], y3 = c[k++]; addCurve(x1, y1, x2, y2, x3, y3); lastX = x3; lastY = y3; }
      else if (op === O.curveTo2) { if (!cur) startSub(lastX, lastY); const x2 = c[k++], y2 = c[k++], x3 = c[k++], y3 = c[k++]; addCurve(lastX, lastY, x2, y2, x3, y3); lastX = x3; lastY = y3; }
      else if (op === O.curveTo3) { if (!cur) startSub(lastX, lastY); const x1 = c[k++], y1 = c[k++], x3 = c[k++], y3 = c[k++]; addCurve(x1, y1, x3, y3, x3, y3); lastX = x3; lastY = y3; }
      else if (op === O.rectangle) {
        const x = c[k++], y = c[k++], w = c[k++], h = c[k++];
        startSub(x, y); cur.push(apply(st.ctm, x + w, y), apply(st.ctm, x + w, y + h), apply(st.ctm, x, y + h)); path[path.length - 1].closed = true; lastX = x; lastY = y; cur = null;
      }
      else if (op === O.closePath) { if (cur) { path[path.length - 1].closed = true; const f = cur[0]; lastX = lastX; cur = null; void f; } }
    }
  };
  const doFill = (rule) => { const polys = path.map((p) => p.pts).filter((p) => p.length >= 3); if (polys.length) fillPolys(buf, W, H, polys, st.fill, rule); };
  const doStroke = () => {
    const scl = Math.sqrt(Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2])) || 1;
    const half = Math.max(0.6, (st.lw * scl) / 2);
    for (const p of path) {
      const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1]; const dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * half, ny = (dx / len) * half;
        fillPolys(buf, W, H, [[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]], st.stroke, 'nz');
      }
    }
  };
  const reset = () => { path = []; cur = null; };

  for (let i = 0; i < opsList.fnArray.length; i++) {
    const fn = opsList.fnArray[i], a = opsList.argsArray[i];
    switch (fn) {
      case O.save: stack.push({ ctm: st.ctm.slice(), fill: st.fill, stroke: st.stroke, lw: st.lw }); break;
      case O.restore: if (stack.length) st = stack.pop(); break;
      case O.transform: st.ctm = mul(a, st.ctm); break;
      case O.paintFormXObjectBegin: stack.push({ ctm: st.ctm.slice(), fill: st.fill, stroke: st.stroke, lw: st.lw }); if (a && a[0]) st.ctm = mul(a[0], st.ctm); break;
      case O.paintFormXObjectEnd: if (stack.length) st = stack.pop(); break;
      case O.setLineWidth: st.lw = a[0]; break;
      case O.setFillRGBColor: st.fill = Math.round(luma(a[0], a[1], a[2])); break;
      case O.setStrokeRGBColor: st.stroke = Math.round(luma(a[0], a[1], a[2])); break;
      case O.constructPath: addPath(a[0], a[1]); break;
      case O.fill: case O.closeFillStroke: case O.fillStroke: doFill('nz'); if (fn !== O.fill) doStroke(); reset(); break;
      case O.eoFill: case O.eoFillStroke: case O.closeEOFillStroke: doFill('eo'); if (fn !== O.eoFill) doStroke(); reset(); break;
      case O.stroke: case O.closeStroke: doStroke(); reset(); break;
      case O.endPath: case O.clip: case O.eoClip: reset(); break;
      default: break;
    }
  }
  // 1-bit output (1 = white), the same layout the PNG writer expects for black-and-white pictures
  const rb = Math.ceil(W / 8); const bits = Buffer.alloc(rb * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[y * W + x] >= 160) bits[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  return { width: W, height: H, bits };
}

module.exports = { rasterize };
