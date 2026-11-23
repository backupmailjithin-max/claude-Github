'use strict';
// Material Movement Gate Pass reader (position based).
// Gate passes (e.g. Nxtra / HappyVisitor style) put people in two columns under headings such as
// "Sender Details:" and "Receiver Details:" with "Label : value" rows underneath. The generic label parser cannot
// tell which column a value belongs to, so this reads each block by word position.
// Returns only what it is sure of; everything is shown to the user for checking before it reaches the form.
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const hasGeo = (w) => w && typeof w.x0 === 'number' && typeof w.y0 === 'number';
const meanConf = (ws) => (ws.length ? ws.reduce((a, w) => a + (typeof w.conf === 'number' ? w.conf : 0), 0) / ws.length : 0);

// "Receiver" + "Details" (or any heading pair) found as neighbouring words of one line
function findHeading(lines, first, second) {
  for (const l of lines) {
    const ws = (l.words || []).filter(hasGeo);
    for (let i = 0; i < ws.length - 1; i++) {
      if (first.test(ws[i].text) && second.test(ws[i + 1].text)) return { x0: ws[i].x0, y0: ws[i].y0, y1: Math.max(ws[i].y1, ws[i + 1].y1), x1: ws[i + 1].x1 };
    }
  }
  return null;
}

// Text rows of one block: Tesseract lines (they follow a slightly tilted baseline) cut down to the block's x range.
function blockRows(lines, box) {
  const rows = [];
  for (const l of lines) {
    const ws = (l.words || []).filter((w) => hasGeo(w) && clean(w.text) && w.x0 >= box.x0 && w.x0 < box.x1 && (w.y0 + w.y1) / 2 >= box.y0 && (w.y0 + w.y1) / 2 <= box.y1);
    if (!ws.length) continue;
    ws.sort((a, b) => a.x0 - b.x0);
    rows.push({ ws, y: ws.reduce((a, w) => a + (w.y0 + w.y1) / 2, 0) / ws.length, x0: ws[0].x0 });
  }
  // words of one visual row can be split over two Tesseract lines (tilted photo): merge rows whose centres are close
  rows.sort((a, b) => a.y - b.y);
  const out = [];
  for (const r of rows) {
    const p = out[out.length - 1];
    const h = Math.max(...r.ws.map((w) => w.y1 - w.y0));
    if (p && Math.abs(p.y - r.y) < h * 0.45 && r.ws.every((w) => p.ws.every((q) => w.x0 >= q.x1 - 2 || w.x1 <= q.x0 + 2))) { p.ws = p.ws.concat(r.ws).sort((a, b) => a.x0 - b.x0); p.y = (p.y + r.y) / 2; }
    else out.push({ ...r });
  }
  return out;
}

const LABELS = [
  ['company', /^(?:company|comapany|compnay|firm|organi[sz]ation)\b/i],
  ['contact', /^(?:contact(?:\s*person)?|person)\b/i],
  ['name', /^name\b/i],
  ['phone', /^(?:phone|mobile|mob|contact\s*no|tel)\b/i],
  ['email', /^e-?mail\b/i],
  ['dept', /^dept\b/i],
  ['address', /^address\b/i],
  ['vehicle', /^vehicle\b/i],
  ['stop', /^(?:others?|transport|material|dispatch|nature|scheduled|comments?)\b/i],
];
function labelOf(txt) { for (const [k, re] of LABELS) if (re.test(txt)) return k; return null; }

// Parse one block ("Receiver Details:" / "Sender Details:") into { company, contact, name, phone, email, address }.
function readBlock(lines, box) {
  const rows = blockRows(lines, box);
  const res = {}; let valueX = null; let addrRows = null; let lastY = 0;
  const conf = {};
  // where the value column starts: the first ":" glyph after a label
  for (const r of rows) { const c = r.ws.find((w, i) => i > 0 && /^[:;]+$/.test(clean(w.text))); if (c) { valueX = valueX == null ? c.x0 : Math.min(valueX, c.x0); } }
  for (const r of rows) {
    const first = clean(r.ws.filter((w) => (!valueX || w.x0 < valueX - 12) && (w.conf == null || w.conf >= 60)).map((w) => w.text).join(' ')).replace(/[:;]+$/, '').trim();
    const lab = first ? labelOf(first) : null;
    const vws = r.ws.filter((w) => (valueX == null || w.x0 >= valueX - 12) && !/^[:;|.]+$/.test(clean(w.text)) && (w.conf == null || w.conf >= 55));
    if (lab === 'stop' || (lab == null && first && /details?\s*:?$/i.test(first))) { addrRows = addrRows ? addrRows : null; if (lab === 'stop') break; }
    if (lab && lab !== 'stop') {
      addrRows = lab === 'address' ? [] : null;
      const v = clean(vws.map((w) => w.text).join(' ').replace(/^[:;\s]+/, ''));
      if (v && !res[lab]) { res[lab] = v; conf[lab] = meanConf(vws); }
      if (lab === 'address' && addrRows) { addrRows.push(...vws); }
      lastY = r.y; continue;
    }
    // unlabelled row: continuation of an address (only confident words in the value column)
    if (addrRows && vws.length && !lab) { const good = vws.filter((w) => w.conf == null || w.conf >= 75); if (good.length >= Math.max(1, vws.length * 0.6)) addrRows.push(...good); }
  }
  if (addrRows && addrRows.length) {
    const t = clean(addrRows.map((w) => w.text).join(' ')); if (t) { res.address = t; conf.address = meanConf(addrRows); }
  }
  res._conf = conf; res._valueX = valueX;
  return res;
}

function parseGatePass(lines) {
  const out = { fields: {}, passType: null };
  const recv = findHeading(lines, /^receiver/i, /^detail/i);
  const send = findHeading(lines, /^sender/i, /^detail/i);
  const full = lines.map((l) => l.text).join('\n');
  const pt = /pass\s*type\s*[:;]?\s*([A-Z][A-Za-z ]{3,40})/i.exec(full);
  if (pt) { const t = pt[1]; out.passType = /outward/i.test(t) ? 'Outward' : /inward/i.test(t) ? 'Inward' : null; out.passTypeText = clean(t).split(/\s{2,}|\bTracking\b/i)[0]; }
  else if (/\boutward\b/i.test(full) && !/\binward\b/i.test(full)) out.passType = 'Outward';
  else if (/\binward\b/i.test(full) && !/\boutward\b/i.test(full)) out.passType = 'Inward';
  const tr = /Tracking\s*ID\s*[:;]\s*([A-Z0-9][A-Z0-9\-\/]{5,24})/.exec(full) || /\bID\s*[:;]\s*([A-Z]{2,6}\d{6,14})\b/.exec(full);
  if (tr) out.trackingId = tr[1];
  const widthMax = Math.max(0, ...lines.flatMap((l) => (l.words || []).filter(hasGeo).map((w) => w.x1)));
  const heightMax = Math.max(0, ...lines.flatMap((l) => (l.words || []).filter(hasGeo).map((w) => w.y1)));
  // stop each block at the next heading below it (Others Details / Material Details / Transport Details)
  const below = (hd, re) => { let best = null; for (const l of lines) { const ws = (l.words || []).filter(hasGeo); for (let i = 0; i < ws.length; i++) { if (re.test(ws[i].text) && ws[i].y0 > hd.y1 + 20 && Math.abs(ws[i].x0 - hd.x0) < 90 && (!best || ws[i].y0 < best)) best = ws[i].y0; } } return best; };
  if (recv) {
    const y1 = below(recv, /^(?:others?|material)$/i) || heightMax;
    const box = { x0: recv.x0 - 25, x1: widthMax + 5, y0: recv.y1, y1: y1 + 6 };
    const r = readBlock(lines, box);
    // a pin code can sit on the row of the next heading ("Others Details:"): pick up a lone 6-digit number in the value column
    if (r.address && !/\b\d{6}\b/.test(r.address) && r._valueX != null) {
      for (const l of lines) for (const w of (l.words || [])) if (hasGeo(w) && w.x0 >= r._valueX - 12 && w.x0 < widthMax + 5 && w.y0 > recv.y1 && w.y0 <= y1 + 30 && /^\d{6}$/.test(clean(w.text))) { r.address = clean(r.address + ' ' + clean(w.text)); r._pin = w; break; }
    }
    out.receiver = r;
  }
  if (send) {
    const y1 = below(send, /^transport$/i) || (recv ? recv.y1 + 400 : heightMax);
    const box = { x0: send.x0 - 25, x1: recv ? recv.x0 - 12 : widthMax + 5, y0: send.y1, y1: y1 - 4 };
    out.sender = readBlock(lines, box);
  }
  return out;
}
module.exports = { parseGatePass };
