'use strict';
// Per-power-supply capacity for HPE OneView servers.
//
// OneView's /utilization gives the capacity of the WHOLE server (both supplies added, e.g. 1600 W), but the OneView screen
// "Server Hardware > Power Supplies" lists every supply with its own "Power Capacity" (e.g. 800 W). A server's capacity in
// DCIM is ONE supply's rating (the second supply is redundancy), so that per-supply list is what we need.
// The public OneView documentation does not name the REST call behind that screen, so this module does not hard-code one:
// it looks for the supply list in the server-hardware record itself, then in the sub-resources OneView is known to expose,
// then in any path the appliance's own web UI mentions, remembers what worked for the appliance, and records everything it
// tried (see diagnostics()) so the real answer is visible instead of guessed.

const CAP_KEY = /^(power)?capacity(_?watts)?$|capacity.*watt|^rated(max)?(output)?(power|watts)?$|^max(imum)?(output)?(power|watts)$|^output_?watts$|^watts$|^wattage$/i;
const LIST_KEY = /power.?suppl|^psus?$|psu.?bays?|powersupplybays/i;
const ABSENT = /absent|empty|notpresent|not present|unpopulated|disabled|unavailable/i;

function toWatts(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n) : null;
}

// Largest single-supply rating found in a supply list entry (or null).
function entryWatts(e) {
  if (!e || typeof e !== 'object') return null;
  const state = [e.state, e.status, e.devicePresence, e.presence, e.Status && e.Status.State].filter((x) => typeof x === 'string').join(' ');
  if (state && ABSENT.test(state)) return null;
  let best = null;
  for (const k of Object.keys(e)) {
    if (!CAP_KEY.test(k)) continue;
    const w = toWatts(e[k]);
    if (w && (best === null || w > best)) best = w;
  }
  return best;
}

// Walks any JSON and returns the largest single-supply rating found under a key that looks like a supply list.
function psuWattsFromObject(root, loose) {
  let best = null; let nodes = 0;
  const take = (w) => { if (w && (best === null || w > best)) best = w; };
  const walk = (node, depth, inList) => {
    if (node == null || depth > 7 || ++nodes > 20000) return;
    if (Array.isArray(node)) { for (const it of node) { if (inList && it && typeof it === 'object') take(entryWatts(it)); walk(it, depth + 1, inList); } return; }
    if (typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      const isList = LIST_KEY.test(k);
      if (isList && v && typeof v === 'object' && !Array.isArray(v)) { for (const kk of Object.keys(v)) { if (v[kk] && typeof v[kk] === 'object') take(entryWatts(v[kk])); } }
      walk(v, depth + 1, inList || isList);
    }
  };
  walk(root, 0, !!loose); // loose = the whole response IS a supply list (a power-supply sub-resource)
  return best;
}

// Paths worth trying under /rest/server-hardware/<id>. '' = the record itself.
const CANDIDATE_SUFFIXES = ['', '/powerSupplies', '/power-supplies', '/physicalServerHardware', '/environmentalConfiguration', '/hardware', '/powerSupplyBays'];
const isSupplyPath = (s) => /suppl|psu/i.test(s);

// Server-hardware related REST paths mentioned by the appliance's web UI scripts that look power-supply related.
function powerPathsFromUiText(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\/rest\/[A-Za-z0-9_\/{}$.:-]*(?:power-?suppl|powersuppl|psu)[A-Za-z0-9_\/{}$.:-]*/gi)) { out.add(m[0].slice(0, 120)); if (out.size >= 40) break; }
  return [...out];
}

const state = new Map(); // host -> { working, tried, uiPaths, uiAt, failed:Set, byModel:Map, outcomes:Map }
const perServer = new Map(); // host+uri -> { res, at }
const DAY = 24 * 3600 * 1000;
function hostState(host) {
  let s = state.get(host);
  if (!s) { s = { working: null, everWorked: false, noneAt: 0, tried: [], uiPaths: [], uiAt: 0, lastValue: null, failed: new Set(), byModel: new Map(), outcomes: new Map() }; state.set(host, s); }
  return s;
}
function note(s, rec) { s.tried.unshift(rec); if (s.tried.length > 40) s.tried.length = 40; }

async function getJson(fetchFn, url, headers) {
  try {
    const res = await fetchFn(url, { headers });
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch (e) { return { status: 'error: ' + String(e.message || e).slice(0, 60), data: null }; }
}

// Scans the appliance web UI (once a day per appliance, only while no working path is known) for supply-related REST paths.
async function discoverFromUi(fetchFn, host, s) {
  if (Date.now() - s.uiAt < DAY) return;
  s.uiAt = Date.now();
  try {
    const rootRes = await fetchFn(`${host}/`, {});
    const html = rootRes.ok ? await rootRes.text() : '';
    const srcs = [...html.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/g)].map((m) => m[1]).slice(0, 12);
    const base = new URL(rootRes.url || `${host}/`);
    const found = new Set();
    for (const src of srcs) {
      let u; try { u = new URL(src, base); } catch (e) { continue; }
      if (u.host !== base.host) continue;
      try { const jr = await fetchFn(u.href, {}); if (!jr.ok) continue; for (const p of powerPathsFromUiText((await jr.text()).slice(0, 12000000))) found.add(p); } catch (e) { /* skip script */ }
    }
    s.uiPaths = [...found].slice(0, 40);
  } catch (e) { /* UI not readable - not fatal */ }
}

function noteModel(s, modelKey, watts) {
  if (!modelKey || !watts) return;
  const m = s.byModel.get(modelKey) || new Map();
  m.set(watts, (m.get(watts) || 0) + 1); s.byModel.set(modelKey, m);
}
// Rating for a server whose own supply list could not be read: only when the appliance has PROVEN the supply path on other servers
// and every server of the SAME make+model that reported one agrees on a single rating. Mixed ratings -> no guess (null).
function peerRating(s, modelKey) {
  if (!s.everWorked || !modelKey) return null;
  const m = s.byModel.get(modelKey);
  return m && m.size === 1 ? [...m.keys()][0] : null;
}

// Returns { watts, source: 'supply'|'model-peer'|null, proven } for the server at `uri`.
//   watts  = ONE supply's rating (largest present supply), e.g. 800 for two 800 W supplies
//   proven = the appliance has returned supply lists for other servers, so whole-server totals must NOT be used as capacity
// `ctx` = { fetch, host, headers }; `modelKey` = make + model text (used only for the same-model peer rule).
async function fetchPsuRating(ctx, uri, modelKey) {
  const { fetch: fetchFn, host, headers } = ctx;
  const s = hostState(host);
  const answer = (watts, source) => ({ watts: watts || null, source: watts ? source : null, proven: s.everWorked });
  if (!uri || !/^\/rest\/[A-Za-z0-9_\/-]+$/.test(uri)) return answer(null);
  const key = host + uri;
  const hit = perServer.get(key);
  if (hit && Date.now() - hit.at < (hit.res.source === 'supply' ? DAY : 3 * 3600 * 1000)) {
    if (hit.res.source === 'supply') return answer(hit.res.watts, 'supply');
    const peer = peerRating(s, modelKey); return answer(peer, 'model-peer');
  }
  const success = (w, via) => { s.working = via; s.everWorked = true; s.noneAt = 0; s.lastValue = w; noteModel(s, modelKey, w); s.outcomes.set(uri, { watts: w, source: 'supply', at: Date.now() }); perServer.set(key, { res: { watts: w, source: 'supply' }, at: Date.now() }); return answer(w, 'supply'); };
  const failure = () => { s.failed.add(uri); s.outcomes.set(uri, { watts: null, source: null, at: Date.now() }); perServer.set(key, { res: { watts: null, source: null }, at: Date.now() }); const peer = peerRating(s, modelKey); if (peer) s.outcomes.set(uri, { watts: peer, source: 'model-peer', at: Date.now() }); return answer(peer, 'model-peer'); };

  if (s.working !== null) {
    const r = await getJson(fetchFn, `${host}${uri}${s.working}`, headers);
    const w = r.data ? psuWattsFromObject(r.data, isSupplyPath(s.working)) : null;
    if (w) return success(w, s.working);
    if (s.everWorked) return failure(); // the path is proven on other servers; this one simply has no supply data
  }
  // One server failing must not switch the reader off for the whole appliance: only after 3 DIFFERENT servers failed and none ever worked.
  if (!s.everWorked && s.noneAt && Date.now() - s.noneAt < 6 * 3600 * 1000) return failure();

  for (const suf of CANDIDATE_SUFFIXES) {
    if (suf === s.working) continue;
    const r = await getJson(fetchFn, `${host}${uri}${suf}`, headers);
    const w = r.data ? psuWattsFromObject(r.data, isSupplyPath(suf)) : null;
    note(s, { path: `${uri.replace(/[^/]+$/, '<id>')}${suf}`, status: r.status, psuWatts: w });
    if (w) return success(w, suf);
  }
  // Nothing in the known places: look at what the appliance UI itself calls (once a day) and try those paths.
  await discoverFromUi(fetchFn, host, s);
  for (const p of s.uiPaths) {
    const path = p.replace(/\{[^}]*\}/g, uri.split('/').pop()).replace(/\/rest\/server-hardware\/[A-Za-z0-9_-]+/, uri);
    if (!path.startsWith('/rest/') || /[{}$:]/.test(path)) continue;
    const r = await getJson(fetchFn, `${host}${path}`, headers);
    const w = r.data ? psuWattsFromObject(r.data, true) : null;
    note(s, { path: path.replace(/[^/]+$/, (m) => (m === uri.split('/').pop() ? '<id>' : m)), status: r.status, psuWatts: w, via: 'web-ui-scan' });
    if (w && path.startsWith(uri)) return success(w, path.slice(uri.length));
  }
  s.failed.add(uri);
  if (!s.everWorked && s.failed.size >= 3) s.noneAt = Date.now();
  return failure();
}

function diagnostics() {
  return [...state.entries()].map(([host, s]) => ({ appliance: host.replace(/^https?:\/\//, ''), workingSuffix: s.working, noSourceFoundAt: s.noneAt ? new Date(s.noneAt).toISOString() : null, lastValueWatts: s.lastValue, uiPathsMentioningPowerSupplies: s.uiPaths, recentAttempts: s.tried.slice(0, 20), pathProven: s.everWorked, serversWithSupplyRating: [...s.outcomes.values()].filter((o) => o.source === 'supply').length, serversUsingSameModelPeer: [...s.outcomes.values()].filter((o) => o.source === 'model-peer').length, serversWithNoRating: [...s.outcomes.values()].filter((o) => !o.source).length, ratingsSeenPerModel: Object.fromEntries([...s.byModel.entries()].map(([k, v]) => [k, Object.fromEntries(v)])), serversWithoutRating: [...s.outcomes.entries()].filter(([, o]) => !o.source).slice(0, 30).map(([u]) => u.split('/').pop()) }));
}
function resetForTests() { state.clear(); perServer.clear(); }

module.exports = { psuWattsFromObject, powerPathsFromUiText, fetchPsuRating, diagnostics, resetForTests, entryWatts };
