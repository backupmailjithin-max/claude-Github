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
// Link key of one object. OneView/Redfish ports carry both LinkState ("Enabled" = admin state) and LinkStatus ("LinkUp"):
// LinkStatus wins; any other key only counts when its value really says up/down.
function pickLink(obj) {
  let best = '';
  for (const [k, v] of Object.entries(obj)) {
    if (!LINK_KEY.test(k) || !(typeof v === 'string' || typeof v === 'boolean')) continue;
    const n = normLink(v);
    if (/^link[_ ]?status$/i.test(k) && /^(up|down)$/i.test(n)) return n;
    if (!best && /^(up|down)$/i.test(n)) best = n;
  }
  return best;
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
  let link = pickLink(obj);
  let mbps = 0;
  for (const [k, v] of Object.entries(obj)) {
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
    const keys = Object.keys(o).slice(0, 30);
    seen.add((path || '$') + '{' + keys.join(',') + '}');
    keys.forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], (path ? path + '.' : '') + k, d + 1); });
  })(obj, '', 0);
  const all = [...seen];
  all.sort((x, y) => (/port|link|speed|mac|address/i.test(y) ? 1 : 0) - (/port|link|speed|mac|address/i.test(x) ? 1 : 0));
  return all.join(' | ').slice(0, 2600);
}

// Adapter list built from OneView's networkAdapters answer (Redfish-style: data[] adapters with Controllers[] and Ports),
// used when the server record has no port map so the Network table is never silently empty.
// Link state / speed of a single port object even when it carries no MAC of its own.
function linkOnly(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return null;
  let link = pickLink(obj);
  let mbps = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!mbps && SPEED_KEY.test(k) && v != null && typeof v !== 'object') mbps = mbpsOf(v, k);
  }
  if (link) return { link, mbps };
  for (const v of Object.values(obj)) { const r = linkOnly(v, depth + 1); if (r) return r; }
  return null;
}
function lastSeg(u) { return String(u || '').split('/').filter(Boolean).pop() || ''; }
function nicsFromAdapters(doc) {
  const list = Array.isArray(doc) ? doc : (doc && (Array.isArray(doc.data) ? doc.data : Array.isArray(doc.members) ? doc.members : Array.isArray(doc.adapters) ? doc.adapters : [])) || [];
  const nics = [];
  list.forEach((ad, i) => {
    if (!ad || typeof ad !== 'object') return;
    const ctl = Array.isArray(ad.Controllers) && ad.Controllers[0] ? ad.Controllers[0] : {};
    // MAC per physical port, taken from the adapter's network device functions (Redfish keeps MACs there for add-in cards).
    const macByPort = {};
    (Array.isArray(ad.NetworkDeviceFunctions) ? ad.NetworkDeviceFunctions : []).forEach((fn) => {
      if (!fn || typeof fn !== 'object') return;
      const mac = (fn.Ethernet && (fn.Ethernet.MACAddress || fn.Ethernet.PermanentMACAddress)) || (fn.FibreChannel && (fn.FibreChannel.PermanentWWPN || fn.FibreChannel.WWPN)) || '';
      const lk = fn.Links || {};
      const ph = lk.PhysicalPortAssignment || lk.PhysicalNetworkPortAssignment;
      const pid = ph && ph['@odata.id'] ? lastSeg(ph['@odata.id']) : '';
      if (mac && pid) macByPort[pid] = mac;
    });
    const portsRaw = [];
    // Embedded port objects (ad.Ports) carry the link data; Controllers[].Links.Ports are only @odata.id stubs.
    const src = [ad.Ports, ad.PhysicalPorts, ctl.Ports].find((x) => Array.isArray(x) && x.length) || (ctl.Links && ctl.Links.Ports) || [];
    if (Array.isArray(src)) src.forEach((p) => { if (p && typeof p === 'object') portsRaw.push(p); });
    const ports = portsRaw.map((p, pi) => {
      const lk = [linkOnly(p, 0)].filter(Boolean);
      const pid = String(p.PortId != null ? p.PortId : (p.Id != null ? p.Id : (p['@odata.id'] ? lastSeg(p['@odata.id']) : pi + 1)));
      const macs = macsUnder(p, 0, []);
      return { id: String(p.Id != null ? p.Id : pid), portId: pid, mac: macs[0] || macByPort[pid] || '', speed: lk[0] && lk[0].mbps ? `${Math.round(lk[0].mbps / 10) / 100} Gbps` : '', link: lk[0] ? lk[0].link : '', type: String(p.ActiveLinkTechnology || p.LinkTechnology || p.PortType || 'Ethernet') };
    });
    const loc = ctl.Location && ctl.Location.PartLocation ? ctl.Location.PartLocation : {};
    nics.push({ slot: loc.LocationOrdinalValue != null ? String(loc.LocationOrdinalValue) : '', name: String(ad.Model || ad.Name || `Adapter ${i + 1}`).trim(), id: String(loc.ServiceLabel || (loc.LocationOrdinalValue != null ? `Slot ${loc.LocationOrdinalValue}` : ad.Id || '')).trim(), partNumber: String(ad.PartNumber || ''), firmware: String(ctl.FirmwarePackageVersion || ''), ports });
  });
  return nics;
}

const modelTokens = (t) => new Set((String(t || '').toUpperCase().match(/[A-Z0-9]{5,}/g) || []).filter((x) => /\d/.test(x)));
const isUpDown = (v) => /^(up|down)$/i.test(String(v || ''));
// Fill Up/Down for ports still missing it, by matching each port-map adapter to an unused adapter of the same model
// (and slot when both say so) and then port by position. MAC matching has already been applied before this.
function mergeAdapterLinks(nicList, altNics) {
  const used = new Set();
  let filled = 0;
  nicList.forEach((n) => {
    if (!n.ports.length || n.ports.every((p) => isUpDown(p.link))) return;
    const nt = modelTokens(`${n.name} ${n.partNumber}`);
    const slot = n.slot != null && n.slot !== '' ? String(n.slot) : '';
    const hasLink = (a, i) => !used.has(i) && a.ports.some((p) => isUpDown(p.link));
    const sameModel = (a) => [...modelTokens(`${a.name} ${a.partNumber}`)].some((t) => nt.has(t));
    const all = altNics.map((a, i) => ({ a, i })).filter(({ a, i }) => hasLink(a, i));
    // 1) same PCI slot (the port map and OneView both give the slot number); 2) same model, not yet used
    let pick = slot ? all.find(({ a }) => String(a.slot || '') === slot && (sameModel(a) || !nt.size)) : null;
    if (!pick && slot) pick = all.find(({ a }) => String(a.slot || '') === slot && a.ports.length === n.ports.length);
    if (!pick) pick = all.find(({ a }) => sameModel(a) && !(slot && a.slot && String(a.slot) !== slot)) || all.find(({ a }) => sameModel(a));
    if (!pick) return;
    used.add(pick.i);
    const ap = pick.a.ports;
    const usedPorts = new Set();
    n.ports.forEach((p, idx) => {
      if (isUpDown(p.link)) return;
      let hit = ap.findIndex((x, xi) => !usedPorts.has(xi) && String(x.id) === String(p.id) && isUpDown(x.link));
      if (hit < 0) hit = ap.findIndex((x, xi) => !usedPorts.has(xi) && x.mac && p.mac && macKey(x.mac) === macKey(p.mac) && isUpDown(x.link));
      if (hit < 0 && isUpDown((ap[idx] || {}).link) && !usedPorts.has(idx)) hit = idx;
      if (hit >= 0) { usedPorts.add(hit); p.link = ap[hit].link; if (ap[hit].speed && !/rated/i.test(ap[hit].speed)) p.speed = ap[hit].speed; filled++; }
    });
  });
  return filled;
}

module.exports = { mergeAdapterLinks, nicsFromAdapters, childUris, shapeOf, collectOneviewLinks, oneviewAdapterPaths, normLink, macKey };
