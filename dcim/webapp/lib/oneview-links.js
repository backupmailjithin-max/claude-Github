'use strict';
// Finds per-port link information in whatever HPE OneView returns for a server (server-hardware record or its sub-resources).
// OneView versions / server generations name these fields differently (linkStatus, linkState, portStatus ... "LinkUp"/"LinkDown"),
// so this reads any object that carries a MAC-like address together with a link-like field.

const MAC_RE = /^(([0-9A-F]{2}[:-]){5}[0-9A-F]{2}|[0-9A-F]{12})$/i;
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
  if (/gbps/i.test(key || '') && !isNaN(Number(v))) return Number(v) * 1000;
  if (typeof v === 'number') return inMbps || v > 400 ? v : v * 1000; // a bare small number is read as Gbps
  const m = String(v).match(/([\d.]+)\s*([gm])?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (/g/i.test(m[2] || '')) return n * 1000;
  if (/m/i.test(m[2] || '')) return n;
  return inMbps || n > 400 ? n : n * 1000;
}

// MAC-like values on an object and (a few levels) below it, e.g. Redfish Port { LinkStatus, Ethernet: { AssociatedMACAddresses: [...] } }.
function macsUnder(obj, depth, out) {
  out = out || [];
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => { if (typeof x === 'string' && MAC_RE.test(x.trim())) out.push(x.trim()); else macsUnder(x, depth + 1, out); }); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && MAC_KEY.test(k) && MAC_RE.test(v.trim())) out.push(v.trim());
    else if (v && typeof v === 'object' && !/^links$/i.test(k)) macsUnder(v, depth + 1, out);
  }
  return out;
}
const SPEED_KEY = /^(current[_ ]?(link[_ ]?)?speed(mbps|gbps)?|speed(mbps|gbps)?|link[_ ]?speed(mbps|gbps)?)$/i;

function collectOneviewLinks(obj, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 10) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => collectOneviewLinks(x, out, depth + 1)); return out; }
  let link = '';
  let mbps = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!link && LINK_KEY.test(k) && (typeof v === 'string' || typeof v === 'boolean')) link = normLink(v);
    if (!mbps && SPEED_KEY.test(k) && v != null && typeof v !== 'object') mbps = mbpsOf(v, k);
  }
  if (link) {
    const macs = macsUnder(obj, 0, []);
    if (macs.length) out.push({ keys: [...new Set(macs.map(macKey))], link, mbps });
  }
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') collectOneviewLinks(v, out, depth + 1); });
  return out;
}

// Extra sub-resources some OneView versions use for the "Network Adapters" view; each is tried and reported.
function oneviewAdapterPaths(serverUri) {
  return ['networkAdapters', 'adapters', 'networkInterfaces', 'ethernetInterfaces', 'physicalPorts', 'ports'].map((p) => `${serverUri}/${p}`);
}

// Sub-resource links inside an answer (uri / @odata.id strings under the server), so adapter lists that only give links can be followed.
function childUris(obj, base, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => childUris(x, base, out, depth + 1)); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^(uri|@odata\.id|href|selfLink)$/i.test(k) && v.startsWith(base + '/') && /^[\/A-Za-z0-9_.-]+$/.test(v)) out.push(v);
    else if (v && typeof v === 'object') childUris(v, base, out, depth + 1);
  }
  return out;
}
// Key names only (never values) of an answer, so an unexpected layout can be reported and then supported.
function shapeOf(obj, maxItems) {
  const seen = new Set();
  (function walk(o, path, d) {
    if (seen.size >= (maxItems || 90) || !o || typeof o !== 'object' || d > 5) return;
    if (Array.isArray(o)) { if (o.length) walk(o[0], path + '[]', d + 1); return; }
    const keys = Object.keys(o).slice(0, 14);
    seen.add((path || '$') + '{' + keys.join(',') + '}');
    keys.forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], (path ? path + '.' : '') + k, d + 1); });
  })(obj, '', 0);
  const all = [...seen];
  all.sort((x, y) => (/port|link|speed|mac|address/i.test(y) ? 1 : 0) - (/port|link|speed|mac|address/i.test(x) ? 1 : 0));
  return all.join(' | ').slice(0, 2600);
}

// Adapter list built from OneView's networkAdapters answer (Redfish-style: data[] adapters with Controllers[] and Ports),
// used when the server record has no port map so the Network table is never silently empty.
function nicsFromAdapters(doc) {
  const list = Array.isArray(doc) ? doc : (doc && (Array.isArray(doc.data) ? doc.data : Array.isArray(doc.members) ? doc.members : Array.isArray(doc.adapters) ? doc.adapters : [])) || [];
  const nics = [];
  list.forEach((ad, i) => {
    if (!ad || typeof ad !== 'object') return;
    const ctl = Array.isArray(ad.Controllers) && ad.Controllers[0] ? ad.Controllers[0] : {};
    const portsRaw = [];
    [ctl.Links && ctl.Links.Ports, ad.Ports, ad.PhysicalPorts, ctl.Ports].forEach((x) => { if (Array.isArray(x)) x.forEach((p) => { if (p && typeof p === 'object' && Object.keys(p).some((k) => !/^@odata\.id$/.test(k))) portsRaw.push(p); }); });
    const ports = portsRaw.map((p, pi) => {
      const lk = collectOneviewLinks(p, []);
      const macs = macsUnder(p, 0, []);
      return { id: String(p.PortId != null ? p.PortId : (p.Id != null ? p.Id : pi + 1)), mac: macs[0] || '', speed: lk[0] && lk[0].mbps ? `${Math.round(lk[0].mbps / 10) / 100} Gbps` : '', link: lk[0] ? lk[0].link : '', type: String(p.ActiveLinkTechnology || p.LinkTechnology || p.PortType || 'Ethernet') };
    });
    const loc = ctl.Location && ctl.Location.PartLocation ? ctl.Location.PartLocation : {};
    nics.push({ name: String(ad.Model || ad.Name || `Adapter ${i + 1}`).trim(), id: String(loc.ServiceLabel || (loc.LocationOrdinalValue != null ? `Slot ${loc.LocationOrdinalValue}` : ad.Id || '')).trim(), partNumber: String(ad.PartNumber || ''), firmware: String(ctl.FirmwarePackageVersion || ''), ports });
  });
  return nics;
}

module.exports = { nicsFromAdapters, childUris, shapeOf, collectOneviewLinks, oneviewAdapterPaths, normLink, macKey };
