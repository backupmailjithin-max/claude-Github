'use strict';
// =====================================================================================================
// Picture preparation for the OCR engine (pure JavaScript, no native libraries).
//   * JPEG / PNG only (jpeg-js, pngjs). Any other format, or any problem, returns null and the original file is used unchanged.
//   * Phone photos: the EXIF "orientation" is applied, so a picture taken holding the phone sideways is read upright.
//   * Very large pictures are shrunk (the OCR gets slow and runs out of time above ~8 megapixels); small print is enlarged.
//   * The result is a plain grey PNG held in memory. Nothing is written to disk.
// =====================================================================================================
const zlib = require('zlib');
const path = require('path');
let jpeg = null, PNGLib = null;
try { jpeg = require(path.join(__dirname, 'vendor', 'node_modules', 'jpeg-js')); } catch (e) { jpeg = null; }
try { PNGLib = require(path.join(__dirname, 'vendor', 'node_modules', 'pngjs')).PNG; } catch (e) { PNGLib = null; }
const MAX_PIXELS = Number(process.env.OCR_MAX_PIXELS) || 40e6;   // refuse to decode anything bigger (memory guard)
const MAX_SIDE = 3400;

function exifOrientation(b) {
  try {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let p = 2;
    while (p + 4 < b.length && b[p] === 0xff) {
      const mk = b[p + 1]; const len = b.readUInt16BE(p + 2);
      if (mk === 0xe1 && b.slice(p + 4, p + 10).toString('latin1') === 'Exif\0\0') {
        const t = p + 10; const le = b.slice(t, t + 2).toString('latin1') === 'II';
        const r16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)); const r32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = t + r32(t + 4); const n = r16(ifd);
        for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; } }
        return 1;
      }
      if (mk === 0xda) break;
      p += 2 + len;
    }
  } catch (e) { /* no usable EXIF */ }
  return 1;
}
function decode(buf, ext) {
  if ((ext === '.jpg' || ext === '.jpeg') && jpeg) { const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024, formatAsRGBA: false }); return { w: img.width, h: img.height, rgb: img.data, ch: 3, orient: exifOrientation(buf) }; }
  if (ext === '.png' && PNGLib) { const img = PNGLib.sync.read(buf); return { w: img.width, h: img.height, rgb: img.data, ch: 4, orient: 1 }; }
  return null;
}
function toGray(d) {
  const n = d.w * d.h; const g = new Uint8Array(n); const s = d.rgb, ch = d.ch;
  for (let i = 0, j = 0; i < n; i++, j += ch) {
    let r = s[j], gg = s[j + 1], b = s[j + 2];
    if (ch === 4) { const a = s[j + 3] / 255; r = r * a + 255 * (1 - a); gg = gg * a + 255 * (1 - a); b = b * a + 255 * (1 - a); }
    g[i] = (r * 299 + gg * 587 + b * 114) / 1000;
  }
  return g;
}
function orient(g, w, h, o) { // returns { g, w, h } upright
  if (o === 1) return { g, w, h };
  const swap = o >= 5; const nw = swap ? h : w, nh = swap ? w : h; const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    switch (o) {
      case 2: nx = w - 1 - x; ny = y; break;
      case 3: nx = w - 1 - x; ny = h - 1 - y; break;
      case 4: nx = x; ny = h - 1 - y; break;
      case 5: nx = y; ny = x; break;
      case 6: nx = h - 1 - y; ny = x; break;
      case 7: nx = h - 1 - y; ny = w - 1 - x; break;
      case 8: nx = y; ny = w - 1 - x; break;
      default: nx = x; ny = y;
    }
    out[ny * nw + nx] = g[y * w + x];
  }
  return { g: out, w: nw, h: nh };
}
function resize(g, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh); const sx = w / nw, sy = h / nh;
  if (sx > 1 || sy > 1) { // shrink: average the covered pixels
    for (let y = 0; y < nh; y++) { const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
      for (let x = 0; x < nw; x++) { const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.max(x0 + 1, Math.ceil((x + 1) * sx))); let sum = 0, c = 0;
        for (let yy = y0; yy < y1; yy++) { const row = yy * w; for (let xx = x0; xx < x1; xx++) { sum += g[row + xx]; c++; } }
        out[y * nw + x] = sum / c; } }
  } else { // enlarge: bilinear
    for (let y = 0; y < nh; y++) { const fy = Math.max(0, (y + 0.5) * sy - 0.5); const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < nw; x++) { const fx = Math.max(0, (x + 0.5) * sx - 0.5); const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
        const a = g[y0 * w + x0], b = g[y0 * w + x1], c = g[y1 * w + x0], d = g[y1 * w + x1];
        out[y * nw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy; } }
  }
  return out;
}
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (~crc) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function encodeGrayPng(g, w, h) {
  const out = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { out[y * (w + 1)] = 0; Buffer.from(g.buffer, g.byteOffset + y * w, w).copy(out, y * (w + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
function dims(buf, ext) { // cheap size check without decoding
  try {
    if (ext === '.png') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (ext === '.jpg' || ext === '.jpeg') { let p = 2; while (p + 9 < buf.length) { if (buf[p] !== 0xff) { p++; continue; } const mk = buf[p + 1]; if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [buf.readUInt16BE(p + 7), buf.readUInt16BE(p + 5)]; p += 2 + buf.readUInt16BE(p + 2); } }
  } catch (e) { /* unknown */ }
  return null;
}
// prepare(buf, ext, { scale }) -> { buf, w, h, scale, rotated } | null (use the original file)
function prepare(buf, ext, opts = {}) {
  try {
    if (!(((ext === '.jpg' || ext === '.jpeg') && jpeg) || (ext === '.png' && PNGLib))) return null;
    const dm = dims(buf, ext); if (dm && dm[0] * dm[1] > MAX_PIXELS) return null;
    const d = decode(buf, ext); if (!d) return null;
    let { g, w, h } = (() => { const o = orient(toGray(d), d.w, d.h, d.orient); return o; })();
    const rotated = d.orient !== 1;
    let scale = opts.scale || 1; const side = Math.max(w, h);
    if (!opts.scale && side > MAX_SIDE) scale = MAX_SIDE / side;
    if (scale > 1) scale = Math.min(scale, 3, MAX_SIDE / side); // enlarge, but never past the size limit
    if (Math.abs(scale - 1) > 0.02) { const nw = Math.max(16, Math.round(w * scale)), nh = Math.max(16, Math.round(h * scale)); g = resize(g, w, h, nw, nh); w = nw; h = nh; } else scale = 1;
    return { buf: encodeGrayPng(g, w, h), w, h, scale, rotated, srcW: d.w, srcH: d.h };
  } catch (e) { return null; }
}
module.exports = { prepare, exifOrientation };
