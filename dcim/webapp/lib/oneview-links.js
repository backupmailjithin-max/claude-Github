'use strict';
// Finds per-port link information in whatever HPE OneView returns for a server (server-hardware record or its sub-resources).
// OneView versions / server generations name these fields differently (linkStatus, linkState, portStatus ... "LinkUp"/"LinkDown"),
// so this reads any object that carries a MAC-like address together with a link-like field.

const MAC_RE = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
const macKey = (v) => String(v || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
const LINK_KEY = /^(link[_ ]?(status|state|up)|port[_ ]?(status|state)|operational[_ ]?status)$/i;
const MAC_KEY = /(^|[a-z])(mac|address)/i;

function normLink(v) {
  if (typeof v === 'boolean') return v ? 'Up' : 'Down';
  const s = String(v || '').trim();
  if (!s) return '';
  if (/no ?link|down|disconnect|unplug|absent/i.test(s)) return 'Down';
  if (/^(link ?up|up|connected|linked)$/i.test(s)) return 'Up';
  return s;
}
function mbpsOf(v, key) {
  if (v == null || v === '' || typeof v === 'object') return 0;
  const inMbps = /mbps/i.test(key || '');
  if (typeof v === 'number') return inMbps || v > 400 ? v : v * 1000; // a bare small number is read as Gbps
  const m = String(v).match(/([\d.]+)\s*([gm])?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (/g/i.test(m[2] || '')) return n * 1000;
  if (/m/i.test(m[2] || '')) return n;
  return inMbps || n > 400 ? n : n * 1000;
}

function collectOneviewLinks(obj, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => collectOneviewLinks(x, out, depth + 1)); return out; }
  let link = '';
  let mbps = 0;
  const macs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && MAC_KEY.test(k) && MAC_RE.test(v.trim())) macs.push(v.trim());
    else if (Array.isArray(v) && /mac|address/i.test(k)) v.forEach((x) => { if (typeof x === 'string' && MAC_RE.test(x.trim())) macs.push(x.trim()); });
    if (!link && LINK_KEY.test(k) && (typeof v === 'string' || typeof v === 'boolean')) link = normLink(v);
    if (!mbps && /^(current[_ ]?(link[_ ]?)?speed(mbps)?|speed(mbps)?|link[_ ]?speed(mbps)?)$/i.test(k) && v != null && typeof v !== 'object') mbps = mbpsOf(v, k);
  }
  if (link && macs.length) out.push({ keys: macs.map(macKey), link, mbps });
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') collectOneviewLinks(v, out, depth + 1); });
  return out;
}

// Extra sub-resources some OneView versions use for the "Network Adapters" view; each is tried and reported.
function oneviewAdapterPaths(serverUri) {
  return ['networkAdapters', 'adapters', 'networkInterfaces', 'ethernetInterfaces', 'physicalPorts', 'ports'].map((p) => `${serverUri}/${p}`);
}

module.exports = { collectOneviewLinks, oneviewAdapterPaths, normLink, macKey };
