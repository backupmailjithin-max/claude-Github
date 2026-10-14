'use strict';
// =====================================================================================================
// Document understanding for the Material Movement OCR assistant.
//   * Input : an array of text lines  [{ text, conf, words:[{text,conf}] }]  (conf 0-100, text-layer PDFs use 100)
//   * Output: extracted values with a confidence score each. Nothing is stored; the caller only receives these values.
//   * New document types (Vendor Packing List, RMA Document, Warranty Document, Internal Asset Movement Form ...)
//     are added by registering one entry in DOC_TYPES below (detect words + optional label overrides).
//     No other file and no existing workflow has to change.
// =====================================================================================================

// ---------- helpers ----------
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const stripPunct = (s) => clean(s).replace(/^[\s:;,.\-_|#]+/, '').replace(/[\s:;,|]+$/, '');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// OCR often reads the letter O as 0, l as 1, S as 5 inside a month name (11-0ct-2026, 5ep, N0v)
function fixMonth(tok) { const t = String(tok).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/8/g, 'b'); if (!/^[a-z]{3,9}$/.test(t)) return 0; return MONTHS[t.slice(0, 3)] || 0; }
// Dates: dd/mm/yyyy (day first, as used in India), dd-Mon-yyyy, Mon dd, yyyy, yyyy-mm-dd. Returns { iso, ambiguous } or null.
function parseDate(raw) {
  const s = clean(raw).replace(/[,]/g, ' ').replace(/\s+/g, ' ');
  let m = /\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3], false);
  m = /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})\b/.exec(s);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const a = +m[1], b = +m[2]; const amb = a <= 12 && b <= 12 && a !== b; return mk(y, b, a, amb); }
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-\/.]*([A-Za-z0-9]{3,9})[\s\-\/.,]*(\d{2}|\d{4})\b/.exec(s);
  if (m) { const mon = fixMonth(m[2]); if (mon) { let y = +m[3]; if (y < 100) y += 2000; return mk(y, mon, +m[1], false); } }
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return mk(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2], false);
  return null;
  function mk(y, mo, d, amb) {
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCMonth() !== mo - 1) return null;
    return { iso: `${y}-${pad(mo)}-${pad(d)}`, ambiguous: amb };
  }
}

// ---------- label dictionaries (shared by every document type) ----------
// Each label list is tried in order; the first line that carries a label + value wins.
const L = {
  dc: /\b(?:D\.?\s?C\.?\s*(?:No|Number|Num|#)|Delivery\s+Challan\s*(?:No|Number|Num|#)?|Challan\s*(?:No|Number|Num|#))\b\.?\s*[:#\-]?\s*/i,
  invoice: /\b(?:Invoice\s*(?:No|Number|Num|#)|Inv\.?\s*(?:No|Number|#)|Bill\s*(?:No|Number)|Tax\s+Invoice\s*(?:No|Number))\b\.?\s*[:#\-]?\s*/i,
  grn: /\b(?:GRN\s*(?:No|Number|#)?|Goods\s+Receipt(?:\s+Note)?\s*(?:No|Number|#)?)\b\.?\s*[:#\-]?\s*/i,
  pod: /\b(?:POD\s*(?:No|Number|#)?|Proof\s+of\s+Delivery\s*(?:No|Number|#)?)\b\.?\s*[:#\-]?\s*/i,
  date: /\b(?:(?:Invoice|DC|Challan|Delivery|Document|Shipment|Dispatch|GRN|POD|Doc)\s*Date|Dated|Date)\b\.?\s*[:\-]?\s*/i,
  vendor: /\b(?:Vendor(?:\s+Name)?|Supplier(?:\s+Name)?|Sold\s+By|Seller|Manufacturer)\b\.?\s*[:\-]?\s*/i,
  sender: /\b(?:Sender|Consignor|Shipper|Dispatched\s+From|Despatched\s+From|From)\b\.?\s*[:\-]\s*/i,
  receiver: /\b(?:Received\s+By|Receiver(?:'s)?(?:\s+Name)?|Receiver\s+Sign(?:ature)?|Delivered\s+To|Consignee|Ship\s*To|Deliver\s*To|Bill\s*To|Buyer|To)\b\.?\s*[:\-]\s*/i,
  desc: /\b(?:Item\s+Description|Description\s+of\s+(?:Goods|Items?|Material)|Material\s+Description|Particulars|Description|Item\s+Name|Item|Material|Product)\b\.?\s*[:\-]\s*/i,
  qty: /\b(?:Quantity|Qty\.?|Total\s+Qty\.?|No\.?\s+of\s+(?:Items|Units|Pcs))\b\.?\s*[:\-]?\s*/i,
  serial: /\b(?:Serial\s*(?:No\.?s?|Numbers?|Nos?\.?|#)?|S\s?\/\s?N\.?s?|SN\.?|Sr\.?\s*No\.?s?|Service\s+Tags?|Serial)\b\s*[:#\-]?\s*/i,
  tag: /\b(?:Asset\s*(?:Tag|ID|No\.?|Number|Code)s?|Tag\s*(?:No|Number|ID)|Inventory\s*(?:No|ID))\b\.?\s*[:#\-]?\s*/i,
  track: /\b(?:Courier(?:\s*(?:Tracking|Track|Docket|AWB))?(?:\s*(?:No|Number|ID|#))?|Tracking(?:\s*(?:No|Number|ID|#))?|AWB(?:\s*(?:No|Number|#))?|Air\s*Way\s*Bill(?:\s*(?:No|Number))?|Docket(?:\s*(?:No|Number))?|Consignment\s*(?:No|Number)|LR\s*(?:No|Number)|Waybill(?:\s*(?:No|Number))?)\b\.?\s*[:#\-]?\s*/i,
  remarks: /\b(?:Remarks?|Notes?|Comments?)\b\.?\s*[:\-]\s*/i,
};
const UNIT_WORDS = { nos: 'Nos', no: 'Nos', pcs: 'Nos', pc: 'Nos', piece: 'Nos', pieces: 'Nos', unit: 'Nos', units: 'Nos', box: 'Box', boxes: 'Box', set: 'Set', sets: 'Set', kg: 'Kg', kgs: 'Kg', roll: 'Roll', rolls: 'Roll', meter: 'Meter', meters: 'Meter', mtr: 'Meter', litre: 'Litre', liter: 'Litre', pallet: 'Pallet', pallets: 'Pallet' };
// Words that look like identifiers but are not serial numbers / tags.
const NOT_ID = /^(?:serial|number|numbers|asset|tag|tags|date|quantity|invoice|challan|delivery|courier|tracking|received|description|vendor|remarks|total|amount|nos|pcs|units|model|part|item|none|nil|n\/a|na)$/i;

// ---------- document-type registry (extend here) ----------
// detect: any regex matching the page text raises that type's score. labels: optional per-type field label overrides.
const DOC_TYPES = [
  { id: 'delivery-challan', label: 'Delivery Challan / DC Copy', detect: [/delivery\s+challan/i, /\bchallan\b/i, /\bD\.?C\.?\s*(?:copy|no)\b/i, /\bDC\s+copy\b/i], primary: ['dc'] },
  { id: 'invoice', label: 'Invoice', detect: [/tax\s+invoice/i, /\binvoice\b/i, /\bbill\s+of\s+supply\b/i], primary: ['invoice'] },
  { id: 'pod', label: 'Proof of Delivery (POD)', detect: [/proof\s+of\s+delivery/i, /\bPOD\b/], primary: ['pod'] },
  { id: 'grn', label: 'Goods Receipt Note (GRN)', detect: [/goods\s+receipt/i, /\bGRN\b/], primary: ['grn'] },
  { id: 'shipment', label: 'Shipment Document', detect: [/\bshipment\b/i, /air\s*way\s*bill/i, /\bwaybill\b/i, /\bpacking\s+list\b/i, /\bconsignment\s+note\b/i, /\blorry\s+receipt\b/i], primary: [] },
  // Future types: add an entry such as
  //   { id: 'rma', label: 'RMA Document', detect: [/\bRMA\b/i], primary: [] }
  // and (optionally) extra labels in EXTRA_LABELS. Existing types and workflows are not touched.
];
const EXTRA_LABELS = {}; // e.g. { rma: { rma: /RMA\s*(?:No|Number)/i } } - picked up by extractExtra() when present

// ---------- scoring ----------
// score = 0.5 * label strength + 0.5 * OCR confidence, reduced when the value fails a format check.
//   label strength: 1.0 explicit label, 0.8 loose label, 0.55 pattern only, 0.4 heuristic guess
//   OCR confidence: mean engine confidence of the words in the value (text-layer PDFs = 100)
//   format factor : 1.0 valid, 0.8 odd-looking, 0.65 implausible
const levelOf = (score) => (score >= 85 ? 'High' : score >= 65 ? 'Medium' : 'Low');
function scoreOf(labelStrength, ocrConf, fmt) { const s = (0.5 * labelStrength + 0.5 * Math.max(0, Math.min(1, ocrConf / 100))) * (fmt == null ? 1 : fmt); return Math.round(Math.max(0, Math.min(1, s)) * 100); }
function mkVal(value, labelStrength, ocrConf, fmt, source) { const score = scoreOf(labelStrength, ocrConf, fmt); return { value, score, level: levelOf(score), source }; }

// Mean OCR confidence of the words that make up a value (falls back to the line confidence).
function valueConf(line, value) {
  if (!line) return 0;
  if (line.textLayer) return 100;
  const toks = clean(value).split(/[\s,;]+/).filter(Boolean); const ws = line.words || [];
  const hits = [];
  for (const t of toks) { const w = ws.find((x) => clean(x.text).replace(/[,;:]+$/, '') === t || clean(x.text).includes(t)); if (w && typeof w.conf === 'number') hits.push(w.conf); }
  if (hits.length) return hits.reduce((a, b) => a + b, 0) / hits.length;
  return typeof line.conf === 'number' ? line.conf : 0;
}


// ---------- layout (position) helpers ----------
// Many documents print the label as a table heading and the value underneath it ("Invoice No" above "INV-001"; a "Serial No" column).
// Words carry their position (x0,x1,y0,y1) when the engine provides it; these helpers read the cell/column under a heading.
const hasGeo = (w) => w && typeof w.x0 === 'number' && typeof w.x1 === 'number' && typeof w.y0 === 'number' && typeof w.y1 === 'number';
const ALL_LABELS = () => Object.values(L);
function startsWithLabel(rest) { const t = clean(rest); if (!t) return false; for (const re of ALL_LABELS()) { const m = re.exec(t); if (m && m.index === 0) return true; } return false; }
// Words of `line` that make up the regex match, found by matching on the words re-joined with single spaces.
function labelSpan(line, re) {
  const ws = (line.words || []).filter((w) => w && w.text && String(w.text).trim());
  if (!ws.length || !ws.every(hasGeo)) return null;
  let joined = '', pos = []; ws.forEach((w, i) => { const t = String(w.text).trim(); pos.push([joined.length, joined.length + t.length, i]); joined += (joined ? ' ' : '') + t; if (i < ws.length - 1) pos[pos.length - 1][1] += 0; });
  const m = re.exec(joined); if (!m) return null;
  const end = m.index + m[0].trimEnd().length; const inSpan = pos.filter(([a, b]) => b > m.index && a < end).map(([, , i]) => ws[i]);
  if (!inSpan.length) return null;
  const last = ws.indexOf(inSpan[inSpan.length - 1]);
  return { words: inSpan, next: ws[last + 1] || null, all: ws };
}
// Rows of words lying under a heading, inside its column band. mode 'one' = nearest row only, 'col' = the whole column.
function belowRows(lines, lineIdx, span, mode) {
  const ws = span.words; const x0 = Math.min(...ws.map((w) => w.x0)); const x1 = Math.max(...ws.map((w) => w.x1));
  const y1 = Math.max(...ws.map((w) => w.y1)); const h = Math.max(6, y1 - Math.min(...ws.map((w) => w.y0)));
  const left = x0 - h * 0.8; const right = span.next ? span.next.x0 - Math.max(3, h * 0.25) : Infinity;
  const cand = [];
  lines.forEach((l, i) => { if (i === lineIdx) return; (l.words || []).forEach((w) => { if (!hasGeo(w) || !String(w.text).trim()) return; const cx = (w.x0 + w.x1) / 2; if (cx < left || w.x0 > right || cx > right) return; if (w.y0 < y1 - h * 0.2) return; cand.push(w); }); });
  cand.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows = []; for (const w of cand) { const r = rows[rows.length - 1]; if (r && Math.abs((w.y0 + w.y1) / 2 - r.cy) < h * 0.6) { r.ws.push(w); } else rows.push({ ws: [w], cy: (w.y0 + w.y1) / 2, top: w.y0 }); }
  const out = []; let prev = y1;
  for (const r of rows) {
    if (r.top - prev > h * (out.length ? 2.6 : 3.5)) break;
    r.ws.sort((a, b) => a.x0 - b.x0);
    const text = clean(r.ws.map((w) => w.text).join(' ').replace(/[|\[\]_]+/g, ' '));
    if (!text) { prev = Math.max(...r.ws.map((w) => w.y1)); continue; }
    if (/^(?:sub\s*total|total|grand\s*total|received|remarks?|notes?|signature|authori[sz]ed|for\s|terms|declaration|e\.?\s?&\s?o\.?e)/i.test(text)) break;
    out.push({ text, words: r.ws, conf: r.ws.reduce((a, w) => a + (typeof w.conf === 'number' ? w.conf : 0), 0) / r.ws.length });
    prev = Math.max(...r.ws.map((w) => w.y1));
    if (mode === 'one') break;
  }
  return out;
}
const cellLine = (row) => ({ text: row.text, conf: row.conf, words: row.words });

// Find "<label> <value>" on a line, or "<label>:" at line end with the value on the next line.
function findLabeled(lines, labelRe, opts = {}) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text; const m = labelRe.exec(t); if (!m) continue;
    let rest = stripPunct(t.slice(m.index + m[0].length)); let src = lines[i]; let strength = /[:#]/.test(m[0]) ? 1.0 : 0.8;
    const headerRow = !rest || startsWithLabel(rest);
    const titleOnly = opts.needMarker && !/(?:\bNo\b|\bNumber\b|\bNum\b|#)/i.test(m[0]);
    if (headerRow && !titleOnly) {
      // heading with the value underneath it (same column)
      const span = labelSpan(lines[i], labelRe); let got = false;
      if (span) { const rows = belowRows(lines, i, span, 'one'); if (rows.length) { rest = rows[0].text; src = cellLine(rows[0]); strength = 0.85; got = true; } }
      if (!got) { rest = startsWithLabel(rest) ? '' : rest; if (!rest && lines[i + 1] && !opts.noNext) { rest = stripPunct(lines[i + 1].text); src = lines[i + 1]; strength = Math.min(strength, 0.8); } }
    }
    if (rest) out.push({ value: rest, line: src, strength, index: i, header: headerRow });
    // a second occurrence of the label later on the same line ("Courier: BlueDart  AWB No: 765...")
    if (!headerRow && rest) { const re2 = new RegExp(labelRe.source, labelRe.flags.replace('g', '')); const m2 = re2.exec(rest); if (m2) { const r2 = stripPunct(rest.slice(m2.index + m2[0].length)); if (r2) out.push({ value: r2, line: lines[i], strength: /[:#]/.test(m2[0]) ? 1.0 : 0.8, index: i, header: false }); } }
  }
  return out;
}
const firstWord = (v, re) => { const m = re.exec(v); return m ? m[0] : ''; };
function cutAtNextLabel(v) { // "DC-88512 Date: 10/10/2026" -> "DC-88512"; "Chennai DC" stays whole
  return stripPunct(v
    .replace(/\s+(?:Date|Dated|Invoice|Challan|Vendor|Supplier|Qty|Quantity|Serial|S\/N|Asset|Courier|Tracking|AWB|Remarks?)\b.*$/i, '')
    .replace(/\s+(?:DC|Received|From|To|Ship|Bill|GST|GSTIN|PO|P\.O\.|Vehicle|Consignee|Despatched|Dispatched)\b[^:]{0,20}:.*$/i, ''));
}
const ID_RE = /[A-Za-z0-9][A-Za-z0-9\/\-_.]{2,29}/;
function cleanId(v) { const w = firstWord(cutAtNextLabel(v), ID_RE); return w.replace(/[.\-_\/]+$/, ''); }
function idFormat(v) { if (!/\d/.test(v)) return 0.65; if (v.length < 3 || v.length > 28) return 0.8; return 1; }

// Serial / tag token lists: "ABC123456, ABC123457 and XYZ98765"
function splitTokens(v) {
  return clean(v).split(/[\s,;|\/]+(?:and\s+)?|\band\b/i).map((t) => t.replace(/^[\[\](){}<>"'`.:#\-]+|[\[\](){}<>"'`.:,;\-]+$/g, '')).filter(Boolean);
}
const isIdToken = (t) => /^[A-Za-z0-9][A-Za-z0-9\-_.\/]{4,29}$/.test(t) && /\d/.test(t) && !NOT_ID.test(t) && !/^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}$/.test(t) && !/^\+?\d{10,13}$/.test(t.replace(/[\s-]/g, '')) ;

// ---------- main entry ----------
function parseDocument(lines, meta = {}) {
  lines = (lines || []).map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
  const full = lines.map((l) => l.text).join('\n');
  const warnings = [];
  // 1. document type
  const dets = DOC_TYPES.map((t) => ({ t, hits: t.detect.filter((re) => re.test(full)).length })).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);
  const top = dets[0];
  const documentType = top ? { id: top.t.id, label: top.t.label, score: Math.min(95, 60 + top.hits * 15), level: levelOf(Math.min(95, 60 + top.hits * 15)) } : { id: 'generic', label: 'Unrecognised document type', score: 30, level: 'Low' };
  const fields = {};

  const pick = (key, labelRe, opts = {}) => {
    const cands = findLabeled(lines, opts.re || labelRe, opts);
    for (const c of cands) {
      const v = opts.clean ? opts.clean(c.value) : stripPunct(c.value); if (!v) continue;
      if (opts.valid && !opts.valid(v)) continue;
      const conf = valueConf(c.line, v); const fmt = opts.fmt ? opts.fmt(v) : 1;
      fields[key] = mkVal(v, c.strength, conf, fmt, 'label'); return true;
    }
    return false;
  };
  const idOpts = { clean: cleanId, valid: (v) => v.length >= 3, fmt: idFormat };
  pick('dcNumber', L.dc, { ...idOpts, needMarker: true });
  pick('invoiceNumber', L.invoice, idOpts);
  pick('grnNumber', L.grn, { ...idOpts, valid: (v) => v.length >= 3 && /\d/.test(v) });
  pick('podNumber', L.pod, { ...idOpts, valid: (v) => v.length >= 3 && /\d/.test(v) });
  // Pattern-only fallback: a "DC-12345" / "INV-2026-001" token somewhere on the page.
  if (!fields.dcNumber) { const m = /\b(DC[-\/ ]?\d[\w\-\/]{2,20})\b/.exec(full); if (m) { const ln = lines.find((l) => l.text.includes(m[1])); fields.dcNumber = mkVal(m[1].replace(/\s+/, '-'), 0.55, valueConf(ln, m[1]), 1, 'pattern'); } }
  if (!fields.invoiceNumber) { const m = /\b(INV[-\/ ]?[\w\-\/]{3,24})\b/.exec(full); if (m) { const ln = lines.find((l) => l.text.includes(m[1])); fields.invoiceNumber = mkVal(m[1], 0.55, valueConf(ln, m[1]), 1, 'pattern'); } }

  // date (labelled first; any date on the page as a fallback)
  {
    let done = false;
    for (const c of findLabeled(lines, L.date)) { const d = parseDate(c.value); if (d) { fields.documentDate = mkVal(d.iso, c.strength, valueConf(c.line, c.value.slice(0, 24)), d.ambiguous ? 0.9 : 1, 'label'); if (d.ambiguous) warnings.push('The document date could be read day-first or month-first - it was read as day/month/year. Please check it.'); done = true; break; } }
    if (!done) for (const l of lines) { const d = parseDate(l.text); if (d && /\d/.test(l.text)) { fields.documentDate = mkVal(d.iso, 0.55, valueConf(l, l.text), d.ambiguous ? 0.9 : 1, 'pattern'); break; } }
  }
  // parties
  const company = (v) => { const c = cutAtNextLabel(v).replace(/\s{2,}.*$/, ''); return stripPunct(c); };
  pick('vendor', L.vendor, { clean: company, valid: (v) => v.length >= 3, fmt: (v) => (/[A-Za-z]{3}/.test(v) ? 1 : 0.65) });
  pick('sender', L.sender, { clean: company, valid: (v) => v.length >= 3 && !/^(?:the|date)\b/i.test(v), fmt: (v) => (/[A-Za-z]{3}/.test(v) ? 1 : 0.65) });
  if (!fields.vendor && !fields.sender) { // heuristic: a company-looking line near the top
    const idx = lines.slice(0, 8).findIndex((l) => /\b(?:Pvt\.?|Private|Ltd\.?|Limited|Inc\.?|LLP|Corp(?:oration)?|Technologies|Systems|Solutions|Enterprises)\b/i.test(l.text) && !/(?:ship\s*to|bill\s*to|consignee)/i.test(l.text));
    if (idx >= 0) fields.vendor = mkVal(stripPunct(lines[idx].text), 0.4, valueConf(lines[idx], lines[idx].text), 1, 'heuristic');
  }
  {
    // person who received it (label "Received by") beats the consignee company ("To / Ship To")
    const rb = findLabeled(lines, /\b(?:Received\s+By|Receiver(?:'s)?(?:\s+Name)?)\b\.?\s*[:\-]\s*/i);
    if (rb.length) { const v = company(rb[0].value); if (v) fields.receiver = mkVal(v, rb[0].strength, valueConf(rb[0].line, v), /[A-Za-z]{2}/.test(v) ? 1 : 0.65, 'label'); }
    else pick('receiver', L.receiver, { clean: company, valid: (v) => v.length >= 3, fmt: (v) => (/[A-Za-z]{3}/.test(v) ? 1 : 0.65) });
  }
  // item description + quantity + unit
  pick('itemDescription', L.desc, { clean: (v) => stripPunct(v.replace(/\s+(?:Qty|Quantity|Serial|S\/N|Asset|Courier|Tracking|AWB)\b.*$/i, '')), valid: (v) => v.length >= 3 && /[A-Za-z]{3}/.test(v), fmt: (v) => (v.length > 160 ? 0.8 : 1) });
  for (const c of findLabeled(lines, L.qty, { noNext: true })) {
    const m = /^(\d{1,5})(?:\.0+)?\s*([A-Za-z]{2,8})?/.exec(c.value);
    if (m && +m[1] >= 1) {
      fields.quantity = mkVal(String(+m[1]), c.strength, valueConf(c.line, m[1]), 1, 'label');
      const u = m[2] && UNIT_WORDS[m[2].toLowerCase()]; if (u) fields.unit = mkVal(u, 0.8, valueConf(c.line, m[2]), 1, 'label');
      break;
    }
  }
  // table headings: item description and quantity listed in columns (all rows, not just the first)
  {
    const colRows = (re) => { const out = []; for (let i = 0; i < lines.length; i++) { const m = re.exec(lines[i].text); if (!m) continue; const rt = stripPunct(lines[i].text.slice(m.index + m[0].length)); if (rt && !startsWithLabel(rt)) continue; const sp = labelSpan(lines[i], re); if (sp) { const rows = belowRows(lines, i, sp, 'col'); if (rows.length) return rows; } } return null; };
    const dr = colRows(L.desc);
    if (dr) { const seen = new Set(); const parts = []; dr.forEach((r) => { const t = stripPunct(r.text); const k = t.toLowerCase(); if (t.length >= 3 && /[A-Za-z]{3}/.test(t) && !seen.has(k)) { seen.add(k); parts.push(t); } }); if (parts.length) { const v = parts.join('; ').slice(0, 300); const conf = dr.reduce((a, r) => a + r.conf, 0) / dr.length; fields.itemDescription = mkVal(v, 0.85, conf, v.length > 160 ? 0.8 : 1, 'label'); } }
    const qr = colRows(L.qty);
    if (qr) { let sum = 0, n = 0, unit = null, conf = 0; qr.forEach((r) => { const m = /^(\d{1,5})(?:\.0+)?\s*([A-Za-z]{2,8})?/.exec(r.text); if (m && +m[1] >= 1) { sum += +m[1]; n++; conf += r.conf; if (!unit && m[2] && UNIT_WORDS[m[2].toLowerCase()]) unit = UNIT_WORDS[m[2].toLowerCase()]; } }); if (n) { fields.quantity = mkVal(String(sum), 0.85, conf / n, 1, 'label'); if (unit) fields.unit = mkVal(unit, 0.8, conf / n, 1, 'label'); } }
  }
  if (!fields.quantity) { for (const l of lines) { const m = /^\s*Total\b[^0-9A-Za-z]{0,3}\s*(\d{1,5})\s+(Nos|Pcs|Units?|Sets?|Boxes|Pieces)\b/i.exec(l.text); if (m && +m[1] >= 1) { fields.quantity = mkVal(String(+m[1]), 0.55, valueConf(l, m[1]), 1, 'pattern'); fields.unit = mkVal(UNIT_WORDS[m[2].toLowerCase()] || 'Nos', 0.55, valueConf(l, m[2]), 1, 'pattern'); break; } } }
  // courier / tracking
  pick('courierTracking', L.track, { clean: (v) => firstWord(cutAtNextLabel(v), /[A-Za-z0-9][A-Za-z0-9\-]{5,24}/), valid: (v) => v.length >= 6 && /\d{4}/.test(v), fmt: (v) => (/^\d{8,}$|^[A-Za-z]{1,4}\d{6,}$/.test(v) ? 1 : 0.8) });
  pick('remarks', L.remarks, { clean: (v) => stripPunct(v).slice(0, 300), valid: (v) => v.length >= 2, fmt: () => 1 });

  // serial numbers and asset tags
  const collect = (labelRe, kind) => {
    const found = new Map();
    for (let i = 0; i < lines.length; i++) {
      const m = labelRe.exec(lines[i].text); if (!m) continue;
      const strength = /[:#]/.test(m[0]) ? 1.0 : 0.8;
      let chunks = [{ text: lines[i].text.slice(m.index + m[0].length), line: lines[i] }];
      // table column: the label is a heading and the identifiers are listed underneath it
      { const restTxt = stripPunct(lines[i].text.slice(m.index + m[0].length));
        if (!restTxt || startsWithLabel(restTxt)) { const sp = labelSpan(lines[i], labelRe); if (sp) belowRows(lines, i, sp, 'col').forEach((r) => chunks.push({ text: r.text, line: cellLine(r) })); chunks[0] = { text: '', line: lines[i] }; } }
      // continuation lines: a wrapped list of identifiers directly underneath (no new label)
      for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) { const nt = lines[k].text; if (/[:]/.test(nt) && /[A-Za-z]{3,}\s*:/.test(nt)) break; const toks = splitTokens(nt); if (toks.length && toks.every(isIdToken)) chunks.push({ text: nt, line: lines[k] }); else break; }
      for (const ch of chunks) for (const t of splitTokens(cutAtNextLabel(ch.text))) {
        if (!isIdToken(t)) continue; const key = t.toUpperCase(); if (found.has(key)) continue;
        const fmt = /^[A-Za-z]+$/.test(t) ? 0.65 : (t.length >= 6 ? 1 : 0.8);
        found.set(key, { ...mkVal(t, strength, valueConf(ch.line, t), fmt, 'label'), kind });
      }
    }
    return [...found.values()];
  };
  const serialNumbers = collect(L.serial, 'serial');
  // Repair look-alike letters inside a serial when at least two same-length siblings agree on a digit at that position.
  const repaired = [];
  { const CONF = { O: '0', D: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };
    for (const sn of serialNumbers) { const v = String(sn.value); let out = v;
      for (let i = 0; i < v.length; i++) { const ch = v[i].toUpperCase(); const dg = CONF[ch]; if (!dg) continue;
        const sib = serialNumbers.filter((o) => o !== sn && String(o.value).length === v.length && String(o.value)[i] === dg);
        const other = serialNumbers.filter((o) => o !== sn && String(o.value).length === v.length && String(o.value)[i].toUpperCase() === ch);
        if (sib.length >= 2 && other.length === 0) out = out.slice(0, i) + dg + out.slice(i + 1); }
      if (out !== v) { repaired.push(v + ' -> ' + out); sn.value = out; } } }
  const assetTags = collect(L.tag, 'tag').filter((t) => !serialNumbers.some((s) => s.value.toUpperCase() === t.value.toUpperCase()));
  // Unlabelled identifier-looking tokens (kept only as low-confidence candidates; the browser checks them against inventory).
  const used = new Set([...serialNumbers, ...assetTags].map((x) => x.value.toUpperCase()));
  Object.values(fields).forEach((f) => f && used.add(String(f.value).toUpperCase()));
  const candidateTokens = []; const seen = new Set();
  for (const l of lines) for (const t of splitTokens(l.text)) {
    const k = t.toUpperCase(); if (used.has(k) || seen.has(k)) continue; seen.add(k);
    if (t.length >= 7 && isIdToken(t) && /[A-Za-z]/.test(t) && /\d{3}/.test(t) && !parseDate(t)) { candidateTokens.push({ ...mkVal(t, 0.4, valueConf(l, t), 1, 'heuristic'), kind: 'candidate' }); if (candidateTokens.length >= 40) break; }
  }
  // optional per-type extras
  const extra = EXTRA_LABELS[documentType.id]; if (extra) for (const [k, re] of Object.entries(extra)) pick(k, re, idOpts);

  // quantity cross-check
  if (fields.quantity && serialNumbers.length && Number(fields.quantity.value) !== serialNumbers.length) warnings.push(`Quantity is ${fields.quantity.value} but ${serialNumbers.length} serial number(s) were read - please check both.`);
  if (repaired.length) warnings.push('Corrected look-alike characters in serial number(s): ' + repaired.join(', ') + '. Please verify.');
  return { documentType, fields, serialNumbers, assetTags, candidateTokens, warnings };
}

module.exports = { parseDocument, parseDate, DOC_TYPES, EXTRA_LABELS, levelOf, scoreOf, clean };
