'use strict';
// A power supply rating belongs to the server MODEL, not to one machine: every server of the same model carries the same
// supply rating whether it is on or off. The rating of a model is the largest ONE-supply rating any server of that model
// reported (from OneView / OME supply data or the iLO/BMC), and every server of that model shows that value.

const MAKE_PREFIX = /^(hewlett[\s-]*packard[\s-]*enterprise|hewlett[\s-]*packard|hpe|hp|dell[\s-]*emc|dell[\s-]*inc\.?|dell|lenovo|cisco|supermicro|fujitsu)\s+/i;

function modelKey(make, model) {
  let m = String(model || '').trim();
  if (!m) return '';
  m = m.replace(MAKE_PREFIX, '').replace(/\s+/g, ' ').toLowerCase();
  return m;
}

// rows: [{ manufacturer, model, ratings: [number|null, ...] }] -> Map(modelKey -> max watts)
function buildModelRatings(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = modelKey(r.manufacturer, r.model);
    if (!k) continue;
    for (const v of r.ratings || []) {
      const w = Number(v);
      if (Number.isFinite(w) && w > 0 && (!map.has(k) || w > map.get(k))) map.set(k, w);
    }
  }
  return map;
}

// Rating shown for one server: its model's rating, else its own reading, else null.
function ratingFor(map, manufacturer, model, own) {
  const k = modelKey(manufacturer, model);
  if (k && map.has(k)) return map.get(k);
  const w = Number(own);
  return Number.isFinite(w) && w > 0 ? w : null;
}

module.exports = { modelKey, buildModelRatings, ratingFor };
