'use strict';
// One canonical spelling for Dell PowerEdge and HPE ProLiant server models, so
// "Dell PowerEdge R750", "Dell Power EdgeR750", "PowerEdge R750", "Dell PER750",
// "PER750" and "R750" are all the same model everywhere (firmware targets,
// compliance grouping, reconciliation, Multi-Vendor modules).
// Anything that is not clearly a Dell/HPE server model is returned unchanged
// (only whitespace tidied), so storage, network and other models are never altered.
//
// NOTE: app-compiled.js carries a copy of this function (canonModel) for the
// browser; keep both in step and covered by tests/model-names.test.js.

const DELL_RE = /^(?:DELLEMC|DELL|EMC)?(?:POWEREDGE|PE)?(XE|MX|FC|R|T|M|C)(\d{3,4})([A-Z]{0,3})$/;
// Explicit "PowerEdge" + a 3-digit number and no series letter ("Dell PowerEdge750") is a missing "R": Dell rack servers.
const DELL_NOLETTER_RE = /^(?:DELLEMC|DELL|EMC)?POWEREDGE([2-9]\d{2})([A-Z]{0,3})$/;
const HPE_RE = /^(?:HEWLETTPACKARDENTERPRISE|HEWLETTPACKARD|HPE|HP)?(?:PROLIANT)?(DL|ML|BL|SL|XL|RL)(\d{2,4})(P|S|E)?(?:GEN|G)?(\d{1,2})?(PLUS)?$/;

function canonicalModel(raw) {
  const tidy = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!tidy) return tidy;
  // a trailing description such as "server" / "rack server" is not part of the model ("PowerEdgeR750 server")
  const n = tidy.toUpperCase().replace(/\b(?:RACK|TOWER|BLADE|MODULAR)?\s*SERVER\b/g, '').replace(/[^A-Z0-9]/g, '');
  // A bare series letter+digits ("R750") is only treated as Dell when it is the whole text;
  // anything else must also look like a Dell/PowerEdge spelling, which the regex enforces.
  let m = DELL_RE.exec(n);
  if (m) return 'PowerEdge ' + m[1] + m[2] + m[3].toLowerCase();
  m = DELL_NOLETTER_RE.exec(n);
  if (m) return 'PowerEdge R' + m[1] + m[2].toLowerCase();
  m = HPE_RE.exec(n);
  if (m) {
    // "DL380" alone is ProLiant; a trailing "G"/"Gen" with no number is not a model, so it falls through.
    return 'ProLiant ' + m[1] + m[2] + (m[3] ? m[3].toLowerCase() : '') + (m[4] ? ' Gen' + m[4] : '') + (m[5] ? ' Plus' : '');
  }
  return tidy;
}

function canonicalModelKey(raw) {
  return canonicalModel(raw).toLowerCase();
}

// For STORED data: only rewrite when the make agrees (Dell -> PowerEdge, HPE -> ProLiant), so a
// bare "C240" on a Cisco box is never turned into a PowerEdge.
function canonicalModelFor(manufacturer, raw) {
  const tidy = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  const c = canonicalModel(tidy);
  if (c === tidy) return tidy;
  // The make (or the text itself, when it spells out Dell/PowerEdge or HPE/ProLiant) must agree.
  const mk = String(manufacturer || '');
  if (/^PowerEdge /.test(c)) return (/dell/i.test(mk) || /dell|power\s*edge|^per\d/i.test(tidy)) ? c : tidy;
  if (/^ProLiant /.test(c)) return (/\bhp\b|\bhpe\b|hewlett|\bhp/i.test(mk) || /\bhpe?\b|hewlett|pro\s*liant/i.test(tidy)) ? c : tidy;
  return tidy;
}

module.exports = { canonicalModel, canonicalModelKey, canonicalModelFor };
