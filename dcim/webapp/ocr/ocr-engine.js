'use strict';
// =====================================================================================================
// Offline OCR engine for the Material Movement assistant.
//   * Image files (JPG / JPEG / PNG / WEBP): Tesseract (WebAssembly) running inside this Node process.
//   * PDF files: the text layer is read directly (exact); pages that are only a scanned picture are OCR'd.
//   * Everything is processed in memory. The file and the recognised text are never written to disk or the database;
//     only the parsed values are returned to the caller.
//   * One recognition at a time (queue of 3). The engine starts on first use and shuts itself down after
//     OCR_IDLE_MS of no use, so it costs nothing while nobody scans a document.
//   * Never throws: problems come back as { ok:false, message } so the Material Movement form stays usable.
// =====================================================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { parseDocument, DOC_TYPES } = require('./doc-types');

const VENDOR = path.join(__dirname, 'vendor', 'node_modules');
const LANG_DIR = path.join(VENDOR, '@tesseract.js-data', 'eng', '4.0.0_best_int');
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 90000;
const OCR_IDLE_MS = Number(process.env.OCR_IDLE_MS) || 120000;
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES) || 5;      // scanned pages recognised per document
const OCR_MAX_QUEUE = Number(process.env.OCR_MAX_QUEUE) || 3;
const FAIL_MESSAGE = 'Unable to extract information from document. Please continue with manual entry.';

function isAvailable() {
  try { return String(process.env.OCR_ENABLED || 'on').toLowerCase() !== 'off' && fs.existsSync(path.join(VENDOR, 'tesseract.js', 'package.json')) && fs.existsSync(path.join(LANG_DIR, 'eng.traineddata.gz')) && fs.existsSync(path.join(VENDOR, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')); }
  catch (e) { return false; }
}
const stats = { requests: 0, ok: 0, failed: 0, busy: 0, lastMs: 0, avgMs: 0, workerStarts: 0 };

// ---------- Tesseract worker (lazy, serialised, auto-stopping) ----------
let workerP = null, idleTimer = null, chain = Promise.resolve(), pending = 0;
function getWorker() {
  if (!workerP) {
    const { createWorker } = require(path.join(VENDOR, 'tesseract.js'));
    stats.workerStarts++;
    workerP = createWorker('eng', 1, { langPath: LANG_DIR, gzip: true, corePath: path.join(VENDOR, 'tesseract.js-core'), cacheMethod: 'none', logger: () => {}, errorHandler: () => {} });
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}
async function dropWorker() { const p = workerP; workerP = null; if (p) { try { const w = await p; await w.terminate(); } catch (e) { /* already gone */ } } }
function touchIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!pending) dropWorker(); }, OCR_IDLE_MS); if (idleTimer.unref) idleTimer.unref(); }
function withTimeout(promise, ms, onTimeout) { let t; return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => { try { onTimeout && onTimeout(); } catch (e) { /* ignore */ } rej(new Error('OCR timed out')); }, ms); })]).finally(() => clearTimeout(t)); }
function enqueue(fn) {
  if (pending >= OCR_MAX_QUEUE) { stats.busy++; const e = new Error('busy'); e.busy = true; throw e; }
  pending++;
  const run = chain.then(fn, fn);
  chain = run.catch(() => {}).then(() => { pending--; touchIdle(); });
  return run;
}

// ---------- OCR of one image buffer -> lines with confidences ----------
// Two reading passes are combined, because no single setting suits every document:
//   pass 1  automatic page layout, normal thresholding            (clean scans, plain text)
//   pass 2  sparse-text layout + adaptive (Sauvola) thresholding  (bordered tables, uneven lighting, phone photos, shadows)
// Words from pass 2 are added where pass 1 read nothing usable; weak pass 1 words are replaced by better pass 2 words.
// Every word keeps its position, so the parser can read table columns and "label above value" layouts.
const PASSES = [
  { tessedit_pageseg_mode: '3', thresholding_method: '0' },
  { tessedit_pageseg_mode: '11', thresholding_method: '2' },
];
// pass 3 runs only when the first two left unreliable words (blurred photos, grid lines through the text): Leptonica Otsu + sparse layout
const PASS_RESCUE = { tessedit_pageseg_mode: '11', thresholding_method: '1' };
function linesFromData(data) {
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const ln of p.lines || []) {
    const words = (ln.words || []).map((w) => ({ text: w.text, conf: w.confidence, x0: w.bbox && w.bbox.x0, x1: w.bbox && w.bbox.x1, y0: w.bbox && w.bbox.y0, y1: w.bbox && w.bbox.y1 })).filter((w) => w.text && String(w.text).trim());
    const text = (ln.text || words.map((w) => w.text).join(' ')).replace(/\s+/g, ' ').trim();
    if (text) lines.push({ text, conf: typeof ln.confidence === 'number' ? ln.confidence : (words.length ? words.reduce((a, w) => a + w.conf, 0) / words.length : 0), words, base: ln.baseline && ln.baseline.has_baseline ? ln.baseline : null });
  }
  if (!lines.length && data.text) String(data.text).split(/\r?\n/).forEach((t) => { if (t.trim()) lines.push({ text: t.trim(), conf: data.confidence || 0, words: [] }); });
  return lines;
}
// Photographed pages are often slightly tilted. The text itself reads fine, but row/column positions do not line up, so
// the tilt (median baseline slope) is removed from the word positions.
function deskew(lines) {
  const sl = []; for (const l of lines) { const b = l.base; if (b && b.x1 - b.x0 >= 150) sl.push((b.y1 - b.y0) / (b.x1 - b.x0)); }
  if (sl.length < 3) return lines; sl.sort((a, b) => a - b); const t = sl[sl.length >> 1]; const ang = Math.atan(t);
  if (Math.abs(ang) < 0.006 || Math.abs(ang) > 0.35) return lines;
  const c = Math.cos(ang), s = Math.sin(ang);
  const rot = (x, y) => [x * c + y * s, -x * s + y * c];
  for (const l of lines) for (const w of l.words) {
    if (typeof w.x0 !== 'number') continue;
    const pts = [rot(w.x0, w.y0), rot(w.x1, w.y0), rot(w.x0, w.y1), rot(w.x1, w.y1)];
    w.x0 = Math.min(...pts.map((p) => p[0])); w.x1 = Math.max(...pts.map((p) => p[0])); w.y0 = Math.min(...pts.map((p) => p[1])); w.y1 = Math.max(...pts.map((p) => p[1]));
  }
  return lines;
}
const normTxt = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function overlapFrac(a, b) { // share of a's area that lies inside b
  const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (ix <= 0 || iy <= 0) return 0; const ar = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0)); return (ix * iy) / ar;
}
function mergePasses(A, B) {
  const geo = (w) => typeof w.x0 === 'number' && typeof w.y0 === 'number';
  const aw = A.flatMap((l) => l.words).filter(geo), bw = B.flatMap((l) => l.words).filter(geo);
  if (!aw.length || !bw.length) { const all = A.length >= B.length ? A : B; return all; }
  // a word of pass 1 is dropped when pass 2 read the same place clearly better
  const dropA = new Set(); for (const w of aw) { if (w.conf >= 80) continue; for (const v of bw) { if (v.conf > w.conf + 15 && overlapFrac(w, v) > 0.35 && normTxt(v.text) !== normTxt(w.text)) { dropA.add(w); break; } } }
  // a word of pass 2 is added when pass 1 has nothing (or only a dropped / very weak word) there
  const keepB = new Set(); for (const v of bw) { let covered = false; for (const w of aw) { if (dropA.has(w) || w.conf < 40) continue; if (overlapFrac(v, w) > 0.4 || overlapFrac(w, v) > 0.5) { covered = true; break; } } if (!covered && (v.conf >= 30 || (v.conf >= 15 && /\d/.test(v.text) && String(v.text).length >= 6))) keepB.add(v); }
  const out = [];
  for (const l of A) { const ws = l.words.filter((w) => !dropA.has(w)); if (!ws.length) continue; out.push({ ...l, words: ws, text: ws.length === l.words.length ? l.text : ws.map((w) => w.text).join(' '), conf: ws.reduce((a, w) => a + w.conf, 0) / ws.length }); }
  for (const l of B) { const ws = l.words.filter((w) => keepB.has(w)); if (!ws.length) continue; out.push({ text: ws.map((w) => w.text).join(' '), conf: ws.reduce((a, w) => a + w.conf, 0) / ws.length, words: ws, base: l.base }); }
  // reading order: top to bottom, then left to right
  const key = (l) => { const g = l.words.filter(geo); return g.length ? [Math.min(...g.map((w) => w.y0)), Math.min(...g.map((w) => w.x0))] : [1e9, 0]; };
  out.sort((x, y) => { const a = key(x), b = key(y); const h = 10; return Math.abs(a[0] - b[0]) > h ? a[0] - b[0] : a[1] - b[1]; });
  return out;
}
const weakLines = (L) => L.filter((l) => l.words.length && l.conf < 50).length;
let prep = null; try { prep = require('./prep'); } catch (e) { prep = null; }   // optional picture preparation (JPEG / PNG); absent = original file is used
const wordHeights = (L) => L.flatMap((l) => l.words).filter((w) => typeof w.y0 === 'number' && w.conf >= 60 && /[A-Za-z0-9]{3}/.test(w.text)).map((w) => w.y1 - w.y0).sort((a, b) => a - b);
const quality = (L) => L.flatMap((l) => l.words).filter((w) => w.conf >= 70 && String(w.text).length >= 2).length;
async function readPasses(worker, buf, t0) {
  const passes = [];
  for (const params of PASSES) {
    if (passes.length && Date.now() - t0 > OCR_TIMEOUT_MS * 0.35) break; // very large pictures: one pass is already slow, keep inside the time limit
    try { await worker.setParameters(params); const res = await worker.recognize(buf, {}, { blocks: true }); passes.push(deskew(linesFromData(res.data || {}))); }
    catch (e) { if (!passes.length) throw e; /* a failed second pass must not lose the first */ }
  }
  let out = passes.length > 1 ? mergePasses(passes[0], passes[1]) : passes[0];
  if (weakLines(out) >= 3 && Date.now() - t0 < OCR_TIMEOUT_MS * 0.5) {
    try { await worker.setParameters(PASS_RESCUE); const res = await worker.recognize(buf, {}, { blocks: true }); out = mergePasses(out, deskew(linesFromData(res.data || {}))); }
    catch (e) { /* keep what the first passes read */ }
  }
  try { await worker.setParameters(PASSES[0]); } catch (e) { /* worker will be reset by the idle timer */ }
  return out;
}
async function recognizeImage(buf, ext) {
  const worker = await getWorker(); const t0 = Date.now();
  const base = prep && ext ? prep.prepare(buf, ext, {}) : null;          // upright (EXIF), grey, never huge
  let out = await readPasses(worker, base ? base.buf : buf, t0);
  let hs = wordHeights(out); const med0 = hs.length >= 8 ? hs[hs.length >> 1] : 0;
  // small print (screenshots, low-resolution scans): read again enlarged and keep the better reading
  if (prep && ext && med0 && med0 < 17 && Date.now() - t0 < OCR_TIMEOUT_MS * 0.3) {
    const up = prep.prepare(buf, ext, { scale: (base ? base.scale : 1) * Math.min(3, 26 / med0) });
    if (up && up.scale > 1.2) { try { const out2 = await readPasses(worker, up.buf, t0); if (quality(out2) > quality(out)) out = out2; } catch (e) { /* keep the first reading */ } }
  }
  if (med0 && med0 < 12) out.meta = { lowRes: true, textHeight: Math.round(med0) };
  return out;
}

// ---------- PDF ----------
// Minimal PNG writer (zlib is built in) so a scanned page picture can be handed to Tesseract without any native image library.
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (~crc) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function encodePng(w, h, kind, data) { // kind: 1 = 1-bit gray, 2 = RGB, 3 = RGBA (pdf.js ImageKind)
  let ch, color, raw;
  if (kind === 2) { ch = 3; color = 2; raw = data; }
  else if (kind === 3) { ch = 4; color = 6; raw = data; }
  else { ch = 1; color = 0; raw = Buffer.alloc(w * h); const rb = Math.ceil(w / 8); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = (data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; }
  const stride = w * ch; const out = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { out[y * (stride + 1)] = 0; Buffer.from(raw.buffer, raw.byteOffset + y * stride, stride).copy(out, y * (stride + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = color;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}
let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) {
    // pdf.js prints harmless "optional canvas" notices when it is loaded without a canvas library (text reading does not need one) - keep them out of the server log
    const w = console.warn; console.warn = () => {};
    pdfjsP = import(pathToFileURL(path.join(VENDOR, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href).finally(() => { console.warn = w; });
  }
  return pdfjsP;
}
async function pdfLines(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0, standardFontDataUrl: pathToFileURL(path.join(VENDOR, 'pdfjs-dist', 'standard_fonts') + path.sep).href, cMapUrl: pathToFileURL(path.join(VENDOR, 'pdfjs-dist', 'cmaps') + path.sep).href, cMapPacked: true }).promise;
  const lines = []; let ocrPages = 0, textPages = 0; const pages = Math.min(doc.numPages, 6);
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p); const tc = await page.getTextContent(); const rows = new Map();
      for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const y = Math.round(it.transform[5] / 3); const r = rows.get(y) || []; r.push({ x: it.transform[4], s: it.str, w: it.width || 0, h: it.height || Math.abs(it.transform[3]) || 10, ty: -it.transform[5] + p * 100000 }); rows.set(y, r); }
      const rowItems = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r.sort((a, b) => a.x - b.x)).filter((r) => r.length);
      const pageLines = rowItems.map((r) => r.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim());
      if (pageLines.join('').length >= 25) { textPages++; pageLines.forEach((t, li) => { const ws = rowItems[li].map((i) => ({ text: i.s.trim(), conf: 100, x0: i.x, x1: i.x + i.w, y0: i.ty - i.h, y1: i.ty })); if (t) lines.push({ text: t, conf: 100, words: ws, textLayer: true }); }); continue; }
      // image-only page -> OCR the largest picture on it
      if (ocrPages >= OCR_MAX_PAGES) continue;
      const ops = await page.getOperatorList(); const OPS = pdfjs.OPS; let best = null;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i]; let img = null;
        if (fn === OPS.paintImageXObject) img = await new Promise((res) => { try { page.objs.get(ops.argsArray[i][0], res); } catch (e) { res(null); } });
        else if (fn === OPS.paintInlineImageXObject) img = ops.argsArray[i][0];
        if (img && img.data && img.width * img.height > 40000 && img.width * img.height <= 40e6 && (!best || img.width * img.height > best.width * best.height)) best = img;
      }
      if (!best) continue;
      const kind = best.kind || (best.data.length === best.width * best.height * 3 ? 2 : best.data.length === best.width * best.height * 4 ? 3 : 1);
      ocrPages++;
      (await recognizeImage(encodePng(best.width, best.height, kind, Buffer.from(best.data.buffer, best.data.byteOffset, best.data.length)), '.png')).forEach((l) => lines.push(l));
    }
  } finally { try { await doc.destroy(); } catch (e) { /* ignore */ } }
  return { lines, textPages, ocrPages, pages: doc.numPages };
}

// ---------- public API ----------
// extract({ buffer, ext }) -> { ok:true, ...parsed values } | { ok:false, message, busy? }
async function extract({ buffer, ext }) {
  const t0 = Date.now(); stats.requests++;
  if (!isAvailable()) return { ok: false, disabled: true, message: FAIL_MESSAGE };
  try {
    const out = await enqueue(() => withTimeout((async () => {
      if (ext === '.pdf') { const r = await pdfLines(buffer); return { lines: r.lines, info: { kind: 'pdf', pages: r.pages, textLayerPages: r.textPages, ocrPages: r.ocrPages } }; }
      return { lines: await recognizeImage(buffer, ext), info: { kind: 'image', pages: 1, textLayerPages: 0, ocrPages: 1 } };
    })(), OCR_TIMEOUT_MS, dropWorker));
    const parsed = parseDocument(out.lines, out.info);
    if (out.lines.meta && out.lines.meta.lowRes) parsed.warnings.push('The picture is small or low resolution, so characters such as 0/O, 1/I and 5/S may be misread. Check every value, or upload a sharper scan or photo.');
    const hasAny = Object.keys(parsed.fields).length || parsed.serialNumbers.length || parsed.assetTags.length;
    const ms = Date.now() - t0; stats.lastMs = ms; stats.avgMs = stats.ok ? Math.round((stats.avgMs * stats.ok + ms) / (stats.ok + 1)) : ms;
    if (!hasAny) { stats.failed++; return { ok: false, message: FAIL_MESSAGE, ms }; }
    stats.ok++;
    return { ok: true, engine: { name: 'tesseract.js (offline)', ...out.info }, ...parsed, ms };
  } catch (e) {
    if (e && e.busy) return { ok: false, busy: true, message: 'The document reader is busy. Please try again in a moment, or continue with manual entry.' };
    stats.failed++; return { ok: false, message: FAIL_MESSAGE, detail: String(e && e.message || e).slice(0, 120), ms: Date.now() - t0 };
  }
}
function status() { return { enabled: isAvailable(), engineRunning: !!workerP, documentTypes: DOC_TYPES.map((t) => ({ id: t.id, label: t.label })), stats: { ...stats } }; }
async function shutdown() { clearTimeout(idleTimer); await dropWorker(); }
module.exports = { extract, status, isAvailable, shutdown, FAIL_MESSAGE, _recognizeImage: recognizeImage };
