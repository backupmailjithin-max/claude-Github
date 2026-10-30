'use strict';
// Vendor-agnostic hardware monitoring via DMTF Redfish - talks directly to
// any server's BMC (Dell iDRAC, HPE iLO, Lenovo XCC, Cisco standalone IMC,
// NVIDIA DGX BMC, or any other Redfish-conformant management controller),
// instead of requiring a per-vendor management appliance like Dell OME or
// HPE OneView. This is additive: it does not replace or touch the existing
// OME/OneView integration, which stays the system of record for firmware
// job orchestration on the vendors it already covers.
//
// Design, following the same discipline used throughout this app's other
// out-of-band integrations (PDU SNMP, OME/OneView):
//  - Never fabricate a field. If a BMC doesn't expose something (its resource
//    tree is walked dynamically from ServiceRoot, not hardcoded - different
//    vendors/generations expose different optional collections), that field
//    comes back null/omitted, not guessed.
//  - COALESCE-safe identity fields (vendor/model/serial/firmware/bmcFirmware):
//    same never-overwrite-a-set-value rule as every other auto-fill in this
//    app. Live state fields (health/power) always reflect the latest poll,
//    since those represent current reality, not something an admin sets.
//  - Firmware PUSH (not just read) is the one area where Redfish is
//    genuinely less uniform across vendors (see docs/REDFISH-NOTES.md) - it
//    is implemented generically against the standard UpdateService
//    SimpleUpdate action + TaskService polling, with a clear per-vendor
//    "not supported here" result rather than a silent failure, and reuses
//    the SAME firmware_jobs table/"Firmware Update Jobs" panel OME/OneView
//    jobs already show up in.

// Bumped from 10: with the rootReachable fast-fail fix, an unreachable device now costs one
// ~30s timeout instead of up to 4, so a higher fan-out is safe and keeps a bulk Discover/Apply
// over a large site (1000s of assets) finishing within the client's request timeout instead of
// crawling through everything 10-at-a-time.
const DISCOVERY_CONCURRENCY = 20;

function redfishBaseUrl(ip, port) {
  const p = port && Number(port) !== 443 ? `:${port}` : '';
  return `https://${ip}${p}`;
}
function authHeader(username, password) {
  if (!username) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64') };
}

// A thin wrapper around the app's existing monitorFetch (same TLS-relaxed-
// for-known-appliance-style-self-signed-certs dispatcher already used for
// OME/OneView) - BMCs are the same story: almost universally self-signed.
async function redfishGet(monitorFetch, ip, port, username, password, path) {
  const url = `${redfishBaseUrl(ip, port)}${path}`;
  const res = await monitorFetch(url, { headers: { Accept: 'application/json', ...authHeader(username, password) } });
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch (e) { /* some BMCs send no body on a 401/403 */ }
    const err = new Error(`Redfish ${path} returned ${res.status}`);
    err.statusCode = res.status;
    err.bodyText = bodyText; // used to tell a real bad-password rejection apart from an account lockout - see looksLikeLockout()
    throw err;
  }
  return res.json();
}
// Dell iDRAC and HPE iLO (and most other BMCs) lock an account out for several minutes after a
// handful of failed logins in a row - a VERY real risk here, since Discover deliberately tries
// several candidate passwords against devices whose vendor isn't known yet. A lockout rejection
// looks identical to a plain wrong password (401/403) unless the body text is actually read, so
// without this a locked-out account reports as "all 4 credentials failed" even when the correct
// one is in the list and would have worked if it weren't asked while the account was locked.
function looksLikeLockout(bodyText) {
  return /locked|lockout|too many (failed )?(login|attempt)|exceeded.*(attempt|login)|retry later|try again later|temporarily (disabled|unavailable|blocked)/i.test(String(bodyText || ''));
}
// Reads the unauthenticated ServiceRoot (no credentials sent at all, so this never counts toward
// a BMC's failed-login lockout counter) to get a vendor hint BEFORE any password is tried, so
// Dell credentials can be tried first against a Dell box and HPE credentials first against an
// HPE box - instead of blind-guessing through every candidate in a fixed order regardless of
// vendor, which wastes attempts (and risks a lockout) with credentials that could never apply to
// that device. Returns null (not a guess) when the ServiceRoot gives no usable clue.
async function probeVendorHint(monitorFetch, ip, port) {
  try {
    const res = await monitorFetch(`${redfishBaseUrl(ip, port)}/redfish/v1/`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const root = await res.json();
    const oemKeys = Object.keys(root.Oem || {}).map((k) => k.toLowerCase());
    if (oemKeys.includes('dell')) return 'dell';
    if (oemKeys.includes('hpe') || oemKeys.includes('hp')) return 'hpe';
    if (oemKeys.includes('lenovo')) return 'lenovo';
    if (oemKeys.includes('cisco')) return 'cisco';
    if (oemKeys.includes('nvidia')) return 'nvidia';
    if (oemKeys.includes('supermicro') || oemKeys.includes('smc')) return 'supermicro';
    const vendorField = String(root.Vendor || '').toLowerCase();
    if (vendorField.includes('dell')) return 'dell';
    if (vendorField.includes('hp')) return 'hpe';
    return null;
  } catch (e) { return null; } // any failure here just means "no hint" - falls back to the original order, no regression
}
// Node's fetch() wraps every network-level failure in the same generic "TypeError: fetch
// failed", throwing away the actual reason (connection refused, timed out, TLS handshake
// failure, host unreachable, DNS failure...) in `error.cause`. That genericness is exactly what
// made this impossible to diagnose from the UI/logs - "fetch failed" tells you nothing about
// WHY a device that connects fine via a single Test & Detect call is failing here. This surfaces
// the real cause (its error code plus message) when one is available, falling back to the bare
// message only if there's truly nothing more specific to show.
function describeNetworkError(e) {
  const cause = e && e.cause;
  if (cause && (cause.code || cause.message)) {
    return cause.code ? `${cause.code}${cause.message ? ' - ' + cause.message : ''}` : cause.message;
  }
  return e && e.message;
}
// A single flaky TCP/TLS failure (ECONNRESET, ETIMEDOUT, EHOSTUNREACH) against a device that is
// otherwise perfectly reachable is common when scanning many devices at once (DISCOVERY_CONCURRENCY),
// and is exactly the kind of transient blip that makes one asset wrongly look "unreachable" in a
// bulk Discover while a single, unhurried Test & Detect call against the same IP succeeds. One
// retry after a short pause, for network-level failures only (never for a 401/403 - that's a
// real answer from the device, not a transient failure), cheaply rules that out before reporting
// the device unreachable.
async function redfishGetWithRetry(monitorFetch, ip, port, username, password, path) {
  try {
    return await redfishGet(monitorFetch, ip, port, username, password, path);
  } catch (e) {
    if (e.statusCode === 401 || e.statusCode === 403) throw e; // a real answer, not a transient network blip - don't retry
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 300)));
    return redfishGet(monitorFetch, ip, port, username, password, path);
  }
}
async function redfishPost(monitorFetch, ip, port, username, password, path, body) {
  const url = `${redfishBaseUrl(ip, port)}${path}`;
  const res = await monitorFetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeader(username, password) },
    body: JSON.stringify(body || {}),
  });
  const location = res.headers.get('location');
  let json = null; try { json = await res.json(); } catch (e) { /* some BMCs return an empty 202 body */ }
  if (!res.ok && res.status !== 202) { const err = new Error(`Redfish ${path} POST returned ${res.status}${json && json.error ? ': ' + JSON.stringify(json.error) : ''}`); err.statusCode = res.status; throw err; }
  return { status: res.status, location, body: json };
}

// Pulls a readable vendor name out of whatever the BMC actually reports -
// System.Manufacturer is the standard field, but we also check the Oem key
// present on ServiceRoot/System as a fallback for BMCs that leave
// Manufacturer blank (seen on some minimal/early OpenBMC-based implementations).
function normalizeVendor(manufacturer, oemKeys) {
  const m = String(manufacturer || '').trim();
  if (m) return m;
  const keys = (oemKeys || []).map((k) => String(k).toLowerCase());
  if (keys.includes('dell')) return 'Dell';
  if (keys.includes('hpe') || keys.includes('hp')) return 'HPE';
  if (keys.includes('lenovo')) return 'Lenovo';
  if (keys.includes('cisco')) return 'Cisco';
  if (keys.includes('nvidia')) return 'NVIDIA';
  if (keys.includes('supermicro') || keys.includes('smc')) return 'Supermicro';
  return null;
}

// The capability-discovery pattern: read ServiceRoot, only follow the
// collection links that are actually present (DSP0266 behavior - the
// resource tree is NOT uniform across vendors/generations), then pull the
// four fields confirmed reliable across every vendor researched: Systems
// (identity/health), Chassis/Thermal+Power (sensors), Managers (BMC itself).
// retryOnNetworkError: a transient TCP/TLS blip is realistically only worth absorbing on the
// bulk, backgrounded Discover path (detectRedfishAnyCredential below always passes true) - there
// a user is watching a progress bar, not the clock, so a doubled worst-case wait per device is
// invisible. For the ad-hoc, synchronous "Test & Detect" call and Apply's single targeted
// confirmation (both default to false), a human is staring at the screen waiting on THIS one
// call, and doubling the worst case from ~30s to ~60s is a worse outcome than occasionally
// reporting a genuinely-transient blip as "unreachable" - the user can just click Test & Detect
// again in a couple seconds, which is faster than waiting out a built-in retry would ever be.
async function detectRedfish(monitorFetch, ip, port, username, password, retryOnNetworkError = false) {
  const out = {
    reachable: false, rootReachable: false, redfishVersion: null, vendor: null, model: null, serialNumber: null,
    biosVersion: null, bmcFirmware: null, healthStatus: null, powerState: null,
    powerWatts: null, temperatures: [], fans: [], systemPath: null, chassisPath: null,
    managerPath: null, updateServicePath: null, error: null, alertCount: null, lockoutSuspected: false,
  };
  let root;
  try {
    root = retryOnNetworkError
      ? await redfishGetWithRetry(monitorFetch, ip, port, username, password, '/redfish/v1/')
      : await redfishGet(monitorFetch, ip, port, username, password, '/redfish/v1/');
  }
  catch (e) {
    if (e.statusCode === 401 || e.statusCode === 403) {
      // A small minority of BMCs require auth even on the ServiceRoot - unlike a real network
      // failure, the device clearly DID answer, it just rejected THIS credential, so other
      // candidates can still legitimately work. rootReachable=true here (not false) is what
      // keeps detectRedfishAnyCredential() trying the rest of the list instead of giving up on
      // this device after just one wrong password.
      out.rootReachable = true;
      const lockout = looksLikeLockout(e.bodyText);
      out.lockoutSuspected = lockout;
      out.error = lockout
        ? 'This BMC account appears to be temporarily locked after repeated failed login attempts - wait a few minutes, then retry with the correct credential directly (Test & Detect).'
        : 'Authentication failed - check the BMC username/password.';
      return out;
    }
    out.error = `Could not reach Redfish service: ${describeNetworkError(e)}`;
    return out;
  }
  // Reaching the service root (unauthenticated on this and most real BMCs - see the note below)
  // proves the IP/port answers at all. detectRedfishAnyCredential() uses this flag to stop
  // trying further candidate credentials the moment this fails: every candidate would hit the
  // exact same network-level failure (and the same ~30s fetch timeout) since none of them even
  // got far enough to have their password checked, so retrying three more times is pure waste -
  // this is what was making /discover time out across 1000s of unreachable/misconfigured IPs.
  out.rootReachable = true;
  out.redfishVersion = root.RedfishVersion || null;
  out.updateServicePath = (root.UpdateService && root.UpdateService['@odata.id']) || null;

  // NOTE: the service root above is unauthenticated on most real BMCs (and on this one), so it
  // responding proves nothing about the credentials - a wrong password looks identical to a right
  // one until an actually-protected resource is fetched. Systems is that check: it's present on
  // every server BMC this function targets, so a 401/403 here is a genuine bad-credentials result
  // (returned immediately, not "reachable"), distinct from the collection merely being absent or
  // slow, which the rest of this function already treats as non-fatal. This matters most for
  // detectRedfishAnyCredential() below, which relies on `reachable` to mean "these credentials work".
  let authConfirmed = false;

  // Systems collection -> first member's detail
  try {
    const sysLink = root.Systems && root.Systems['@odata.id'];
    if (sysLink) {
      const sysColl = await redfishGet(monitorFetch, ip, port, username, password, sysLink);
      authConfirmed = true;
      const firstSys = sysColl.Members && sysColl.Members[0] && sysColl.Members[0]['@odata.id'];
      if (firstSys) {
        out.systemPath = firstSys;
        const sys = await redfishGet(monitorFetch, ip, port, username, password, firstSys);
        out.vendor = normalizeVendor(sys.Manufacturer, Object.keys(sys.Oem || {}));
        out.model = sys.Model || null;
        out.serialNumber = sys.SerialNumber || null;
        out.biosVersion = sys.BiosVersion || null;
        out.healthStatus = (sys.Status && sys.Status.Health) || null;
        out.powerState = sys.PowerState || null;
      }
    }
  } catch (e) {
    if (e.statusCode === 401 || e.statusCode === 403) {
      const lockout = looksLikeLockout(e.bodyText);
      out.lockoutSuspected = lockout;
      out.error = lockout
        ? 'This BMC account appears to be temporarily locked after repeated failed login attempts - wait a few minutes, then retry with the correct credential directly (Test & Detect).'
        : 'Authentication failed - check the BMC username/password.';
      return out;
    }
    /* Systems collection missing/unreachable for some other reason - leave identity fields null, not fatal */
  }

  // NOTE: `reachable` is NOT set here anymore - see the fix below, after the Managers block,
  // which is where authConfirmed gets its real second (and last) chance to become true.

  // Chassis collection -> first member's Thermal + Power subresources
  try {
    const chLink = root.Chassis && root.Chassis['@odata.id'];
    if (chLink) {
      const chColl = await redfishGet(monitorFetch, ip, port, username, password, chLink);
      const firstCh = chColl.Members && chColl.Members[0] && chColl.Members[0]['@odata.id'];
      if (firstCh) {
        out.chassisPath = firstCh;
        try {
          const thermal = await redfishGet(monitorFetch, ip, port, username, password, `${firstCh}/Thermal`);
          out.temperatures = (thermal.Temperatures || []).map((t) => ({ name: t.Name, readingCelsius: t.ReadingCelsius != null ? t.ReadingCelsius : null, status: (t.Status && t.Status.Health) || null }));
          out.fans = (thermal.Fans || []).map((f) => ({ name: f.Name, readingRpm: f.Reading != null ? f.Reading : null, status: (f.Status && f.Status.Health) || null }));
        } catch (e) { /* not every BMC exposes Thermal (older/minimal implementations) */ }
        try {
          const power = await redfishGet(monitorFetch, ip, port, username, password, `${firstCh}/Power`);
          const pc = power.PowerControl && power.PowerControl[0];
          if (pc && pc.PowerConsumedWatts != null) out.powerWatts = pc.PowerConsumedWatts;
        } catch (e) { /* not every BMC exposes Power */ }
      }
    }
  } catch (e) { /* Chassis collection missing - leave sensor fields empty, not fatal */ }

  // Managers collection -> first member's firmware version (the BMC's own version, distinct from host BIOS)
  try {
    const mgrLink = root.Managers && root.Managers['@odata.id'];
    if (mgrLink) {
      const mgrColl = await redfishGet(monitorFetch, ip, port, username, password, mgrLink);
      authConfirmed = true;
      const firstMgr = mgrColl.Members && mgrColl.Members[0] && mgrColl.Members[0]['@odata.id'];
      if (firstMgr) {
        out.managerPath = firstMgr;
        const mgr = await redfishGet(monitorFetch, ip, port, username, password, firstMgr);
        out.bmcFirmware = mgr.FirmwareVersion || null;
        if (!out.vendor) out.vendor = normalizeVendor(mgr.Manufacturer, Object.keys(mgr.Oem || {}));
      }
    }
  } catch (e) {
    // Belt-and-braces: if Systems was absent so the check above never ran, still don't let a bad
    // password through just because a protected-but-optional collection responded 401.
    if (e.statusCode === 401 || e.statusCode === 403) {
      const lockout = looksLikeLockout(e.bodyText);
      out.lockoutSuspected = lockout;
      out.error = lockout
        ? 'This BMC account appears to be temporarily locked after repeated failed login attempts - wait a few minutes, then retry with the correct credential directly (Test & Detect).'
        : 'Authentication failed - check the BMC username/password.';
      out.reachable = false;
      return out;
    }
    /* Managers collection missing - leave bmcFirmware null, not fatal */
  }

  // BUG FIX: `reachable` used to be set unconditionally right after the Systems try/catch above,
  // which meant a device whose Systems link was missing or in an unexpected shape (no throw, no
  // 401/403 - just nothing to actually check the password against) had its credential silently
  // accepted as "working" without ever being validated. That let Discover stop after a WRONG
  // first-guess password on such a device and never try the remaining candidates - a real Dell
  // server's genuinely correct second/third password was never reached. Now `reachable` only
  // becomes true once Systems or Managers has genuinely confirmed the credential (authConfirmed)
  // via a protected resource that actually required and accepted it.
  if (!authConfirmed) {
    out.reachable = false;
    out.error = out.error || 'Could not confirm credentials: this device exposed neither a Systems nor a Managers collection to authenticate against.';
    return out;
  }
  out.reachable = true;

  // Alert count: every sensor reporting Health != OK, plus the overall
  // system health itself if it's not OK - the Redfish-side equivalent of
  // the critical/warning counts already shown for OME/OneView devices.
  // null (not 0) when the device wasn't reachable, so the UI can tell
  // "no alerts" apart from "never checked".
  if (out.reachable) {
    const abnormal = (s) => s && String(s).toUpperCase() !== 'OK';
    let count = out.temperatures.filter((t) => abnormal(t.status)).length + out.fans.filter((f) => abnormal(f.status)).length;
    if (abnormal(out.healthStatus)) count += 1;
    out.alertCount = count;
  } else {
    out.alertCount = null;
  }

  return out;
}

async function getFirmwareInventory(monitorFetch, ip, port, username, password, updateServicePath) {
  const base = updateServicePath || '/redfish/v1/UpdateService';
  const svc = await redfishGet(monitorFetch, ip, port, username, password, base);
  const invLink = svc.FirmwareInventory && svc.FirmwareInventory['@odata.id'];
  if (!invLink) return { supported: false, components: [] };
  const coll = await redfishGet(monitorFetch, ip, port, username, password, invLink);
  const members = coll.Members || [];
  const components = [];
  for (const m of members.slice(0, 50)) { // bounded - some BMCs enumerate 100+ sub-components
    try {
      const c = await redfishGet(monitorFetch, ip, port, username, password, m['@odata.id']);
      components.push({ name: c.Name || c.Id, version: c.Version || null, updateable: c.Updateable !== false, status: (c.Status && c.Status.Health) || null });
    } catch (e) { /* skip a component that fails to read rather than aborting the whole inventory */ }
  }
  return { supported: true, simpleUpdateSupported: !!(svc.Actions && svc.Actions['#UpdateService.SimpleUpdate']), components };
}

function mapTaskStateToJobStatus(taskState, percent) {
  // DSP0266 TaskState values, mapped onto the same {status, percent} shape
  // persistFirmwareJobStatus() already uses for OME/OneView jobs, so this
  // plugs into the existing "Firmware Update Jobs" panel without UI changes.
  const s = String(taskState || '').toLowerCase();
  if (['completed'].includes(s)) return 'Completed';
  if (['exception', 'killed', 'cancelled', 'interrupted'].includes(s)) return 'Failed';
  return 'Running'; // New, Starting, Running, Pending, Service, Stopping - all still in-flight
}
async function getRedfishTaskStatus(monitorFetch, ip, port, username, password, taskPath) {
  try {
    const task = await redfishGet(monitorFetch, ip, port, username, password, taskPath);
    const percent = typeof task.PercentComplete === 'number' ? task.PercentComplete : null;
    return { status: mapTaskStateToJobStatus(task.TaskState, percent), percent, step: task.Messages && task.Messages[0] && task.Messages[0].Message || null, error: null };
  } catch (e) { return { status: 'Failed', percent: null, step: null, error: e.message }; }
}

// A site may have several hundred/thousand BMCs sharing one of a handful of common credential
// pairs (e.g. Dell's default root/calvin plus a couple of site-specific passwords, HPE's
// hpadmin/hpinvent), with no record of which device uses which. REDFISH_CREDENTIALS in .env lists
// every candidate pair, tried in order until one authenticates - so Discover configures all of
// them in one pass instead of the admin testing each IP by hand. Format: "user:pass,user:pass,...";
// a literal ":" or "," inside a password is not supported (use REDFISH_DEFAULT_USERNAME/_PASSWORD
// for that one pair instead). Falls back to the single legacy pair when REDFISH_CREDENTIALS is unset.
//
// Optionally, a candidate can be tagged with which vendor it belongs to by prefixing it with
// "vendor:" - e.g. "dell:root:calvin,dell:root:calvin@123,hpe:hpadmin:hpinvent". Tagged
// candidates are tried FIRST against a device whose vendor hint matches (see probeVendorHint),
// before any untagged/generic ones, instead of blindly trying every candidate in a fixed order
// regardless of vendor - real Dell iDRAC and HPE iLO BMCs commonly lock an account out after a
// handful of failed logins in a row, so wasting attempts with an obviously-wrong vendor's
// password first is a real risk, not just wasted time. Tagging is entirely optional: an untagged
// list (the original format) behaves exactly as before.
function redfishCredentialCandidates() {
  const list = String(process.env.REDFISH_CREDENTIALS || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
      const parts = pair.split(':');
      if (parts.length >= 3) return { vendor: parts[0].toLowerCase(), username: parts[1], password: parts.slice(2).join(':') };
      const i = pair.indexOf(':');
      return i === -1 ? null : { vendor: null, username: pair.slice(0, i), password: pair.slice(i + 1) };
    })
    .filter(Boolean);
  const out = list.length ? list : (() => {
    const u = process.env.REDFISH_DEFAULT_USERNAME, p = process.env.REDFISH_DEFAULT_PASSWORD;
    return u ? [{ vendor: null, username: u, password: p || '' }] : [];
  })();
  // Stable per-candidate id (its position in this list). Several candidates can share the same
  // username (e.g. Dell's three "root" passwords), so username alone can't identify WHICH one
  // Discover actually proved - Apply below needs this id to reuse the exact right credential
  // instead of silently re-grabbing the first "root" entry (which may be the wrong password).
  return out.map((c, i) => ({ ...c, id: i }));
}
// A short, randomized pause between credential attempts against the SAME device - several wrong
// passwords fired at a real BMC back-to-back is exactly the pattern that trips its failed-login
// lockout counter; most BMCs count attempts within a short window, so even this little room
// measurably reduces the chance of a lockout without meaningfully slowing down a bulk scan
// (concurrency across DIFFERENT devices is unaffected).
function credentialAttemptBackoff() { return new Promise((resolve) => setTimeout(resolve, 200 + Math.floor(Math.random() * 250))); }
// Tries each candidate credential in turn against one IP; returns the first that authenticates
// (reachable:true), tagged with which credential worked, or the last attempt's result if none did.
// First reads the vendor hint (no credentials sent, so this never counts toward a lockout) and
// tries vendor-matching candidates before generic/other-vendor ones - see the comment on
// redfishCredentialCandidates above.
async function detectRedfishAnyCredential(monitorFetch, ip, port, candidates) {
  const hint = await probeVendorHint(monitorFetch, ip, port);
  const ordered = hint
    ? [...candidates.filter((c) => c.vendor === hint), ...candidates.filter((c) => !c.vendor), ...candidates.filter((c) => c.vendor && c.vendor !== hint)]
    : candidates;
  let last = null;
  for (let i = 0; i < ordered.length; i++) {
    const cred = ordered[i];
    if (i > 0) await credentialAttemptBackoff();
    // retryOnNetworkError=true here: this path is only ever called from the backgrounded,
    // polled bulk Discover job (never synchronously while a user waits), so absorbing a
    // transient connect blip is pure upside.
    const r = await detectRedfish(monitorFetch, ip, port, cred.username, cred.password, true);
    if (r.reachable) return { ...r, credential: cred, vendorHint: hint };
    last = r;
    // Stop at the first candidate whenever the IP/port itself didn't answer at all - every
    // remaining candidate would fail the exact same way (see the comment on out.rootReachable
    // in detectRedfish). Only keep trying when the device IS reachable but this particular
    // credential was rejected (rootReachable true, reachable false) - that's the only case
    // where a different password can actually make a difference.
    if (!r.rootReachable) break;
    // A suspected account lockout means every remaining candidate - even the genuinely correct
    // one, if it hasn't been tried yet - will also be rejected right now, and trying anyway only
    // extends the lockout further. Stop here and report it honestly as a lockout rather than
    // "wrong password" (see the per-candidate fastfail comment on out.lockoutSuspected).
    if (r.lockoutSuspected) break;
  }
  return last || { reachable: false, error: 'No candidate credentials configured' };
}

module.exports = function registerRedfishRoutes(app, deps) {
  const { pool, log, httpErr, sendErr, authenticateToken, requireRole, getAllowedSitesForUser, applySiteScope, assertSiteAccess, genId, auditLog, monitorFetch } = deps;

  // Asset ids currently mid-sync (via either a manual "Sync Now" click or the background
  // auto-sync sweep). Shared between both paths so the same device's BMC is never hit by two
  // concurrent sync requests at once - see syncOneAsset()/the /sync route, and pollAllRedfish()
  // below, which both check it.
  const syncInFlight = new Set();

  async function loadAssetForUser(req, res, assetId) {
    const [rows] = await pool.query('SELECT * FROM assets WHERE id = ?', [assetId]);
    if (!rows.length) { res.status(404).json({ error: 'Asset not found' }); return null; }
    const asset = rows[0];
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(asset.site)) { res.status(403).json({ error: 'Access denied for this site' }); return null; }
    return asset;
  }

  const assetPreview = (a) => ({
    id: a.id, site: a.site, zone: a.zone, rackNo: a.rack_no, deviceName: a.device_name, assetTag: a.asset_tag,
    mgmtIp: a.mgmt_ip, vendor: a.manufacturer, model: a.model, serialNumber: a.serial_number, firmware: a.firmware,
    // redfishSerialNumber is the serial the BMC itself just reported - kept separate from
    // serialNumber (Asset Inventory's own field) above. See the redfish_serial_number column
    // comment in initDB() for why: Asset Inventory's Serial Number is often a site's own
    // asset-tag-style value, not the vendor's real hardware serial, and is COALESCE-protected
    // so it's never silently overwritten. This field always reflects the latest Redfish poll.
    redfishSerialNumber: a.redfish_serial_number,
    redfishConfigured: !!a.redfish_username, redfishVersion: a.redfish_version, bmcFirmware: a.bmc_firmware,
    healthStatus: a.health_status, powerState: a.power_state, alertCount: a.redfish_alert_count,
    powerWatts: a.redfish_power_watts, hardwareType: a.hardware_type, monitorIgnored: !!a.redfish_monitor_ignored,
    lastSyncAt: a.last_redfish_sync_at, lastError: a.last_redfish_error,
  });

  // Live, read-only test against any IP/credentials - does NOT save anything.
  // Used for the "Test & Detect" preview before an admin commits to saving
  // credentials against an asset.
  app.post('/api/monitoring/redfish/detect', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const { ip, port, username, password } = req.body;
      if (!ip) return res.status(400).json({ error: 'IP address is required' });
      const result = await detectRedfish(monitorFetch, ip, port, username, password);
      res.json(result);
    } catch (e) { sendErr(res, e); }
  });

  // List assets with a management IP (candidates for Redfish), with their
  // last-known Redfish state - this powers the Monitoring page's preview list.
  app.get('/api/monitoring/redfish/assets', authenticateToken, async (req, res) => {
    try {
      const { site, includeIgnored } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = ["mgmt_ip IS NOT NULL", "mgmt_ip <> ''"];
      const params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      // Devices manually marked "Ignore from Monitor" are hidden from the default list -
      // pass includeIgnored=1 ("Show ignored") to see them too.
      if (includeIgnored !== '1') conditions.push('redfish_monitor_ignored = 0');
      const [rows] = await pool.query(`SELECT * FROM assets WHERE ${conditions.join(' AND ')} ORDER BY site, rack_no`, params);
      res.json(rows.map(assetPreview));
    } catch (e) { sendErr(res, e); }
  });

  // Exclude/include a device in the Multi-Vendor (Redfish) monitoring list without
  // touching its Asset Inventory record or its saved credentials - polling and sync
  // for an ignored device just stop running until it's un-ignored.
  app.put('/api/monitoring/redfish/:assetId/ignore', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const asset = await loadAssetForUser(req, res, req.params.assetId);
      if (!asset) return;
      const ignored = req.body && typeof req.body.ignored !== 'undefined' ? (req.body.ignored ? 1 : 0) : (asset.redfish_monitor_ignored ? 0 : 1);
      await pool.query('UPDATE assets SET redfish_monitor_ignored = ? WHERE id = ?', [ignored, asset.id]);
      auditLog(req, 'REDFISH_IGNORE_SET', { entity: 'asset', entityId: asset.id, site: asset.site, status: 'success' }, { ignored: !!ignored });
      res.json({ success: true, ignored: !!ignored });
    } catch (e) { sendErr(res, e); }
  });

  // Bulk "Delete Selected (Remove Redfish Config)": clears saved BMC credentials and
  // polled Redfish state for the given assets. The asset itself stays in Inventory -
  // only its Redfish configuration is wiped, so it drops out of this page until
  // re-configured (Test & Detect or Discover).
  app.post('/api/monitoring/redfish/unconfigure', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const { assetIds } = req.body;
      if (!Array.isArray(assetIds) || !assetIds.length) return res.status(400).json({ error: 'assetIds array is required' });
      const allowed = await getAllowedSitesForUser(req.user);
      let cleared = 0;
      for (const assetId of assetIds.slice(0, 500)) {
        const [rows] = await pool.query('SELECT id, site FROM assets WHERE id = ?', [assetId]);
        if (!rows.length || !allowed.includes(rows[0].site)) continue;
        await pool.query(
          `UPDATE assets SET redfish_username = NULL, redfish_password = NULL, redfish_port = NULL,
             redfish_version = NULL, bmc_firmware = NULL, health_status = NULL, power_state = NULL,
             redfish_alert_count = NULL, redfish_power_watts = NULL, redfish_monitor_ignored = 0,
             redfish_serial_number = NULL, last_redfish_sync_at = NULL, last_redfish_error = NULL
           WHERE id = ?`,
          [rows[0].id]
        );
        cleared++;
      }
      auditLog(req, 'REDFISH_UNCONFIGURE', { entity: 'asset', status: 'success' }, { count: cleared });
      res.json({ cleared });
    } catch (e) { sendErr(res, e); }
  });

  // Save BMC credentials for a specific asset (never returned back in any GET).
  app.put('/api/monitoring/redfish/:assetId/credentials', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const asset = await loadAssetForUser(req, res, req.params.assetId);
      if (!asset) return;
      const { username, password, port } = req.body;
      if (!username) return res.status(400).json({ error: 'Username is required' });
      await pool.query('UPDATE assets SET redfish_username = ?, redfish_password = ?, redfish_port = ? WHERE id = ?',
        [username, password || '', Number(port) > 0 ? Number(port) : 443, asset.id]);
      auditLog(req, 'REDFISH_CREDENTIALS_SET', { entity: 'asset', entityId: asset.id, site: asset.site, status: 'success' });
      res.json({ success: true });
    } catch (e) { sendErr(res, e); }
  });

  // Re-poll one asset's BMC with its saved credentials and persist the result. Shared by the
  // manual "Sync Now" action and the background auto-sync sweep below, so both ways of
  // triggering a sync behave identically and stay in one place. Identity fields
  // (vendor/model/serial/firmware/bmcFirmware) are COALESCE-safe (filled only if currently
  // blank); health/power/sync time always reflect the latest poll, since they are live state,
  // not identity.
  async function syncOneAsset(asset) {
    if (!asset.mgmt_ip) { const e = new Error('This asset has no management IP set'); e.statusCode = 400; throw e; }
    if (!asset.redfish_username) { const e = new Error('No Redfish credentials saved for this asset yet - use Test & Detect first'); e.statusCode = 400; throw e; }
    const r = await detectRedfish(monitorFetch, asset.mgmt_ip, asset.redfish_port, asset.redfish_username, asset.redfish_password);
    if (!r.reachable) {
      await pool.query('UPDATE assets SET last_redfish_error = ?, last_redfish_sync_at = NOW() WHERE id = ?', [String(r.error || 'Unreachable').slice(0, 255), asset.id]);
      return { reachable: false, error: r.error };
    }
    await pool.query(
      `UPDATE assets SET
         manufacturer = COALESCE(NULLIF(manufacturer, ''), ?), model = COALESCE(NULLIF(model, ''), ?),
         serial_number = COALESCE(NULLIF(serial_number, ''), ?), firmware = COALESCE(NULLIF(firmware, ''), ?),
         redfish_serial_number = ?,
         bmc_firmware = ?, redfish_version = ?, health_status = ?, power_state = ?, redfish_alert_count = ?,
         redfish_power_watts = ?, last_redfish_sync_at = NOW(), last_redfish_error = NULL
       WHERE id = ?`,
      [r.vendor, r.model, r.serialNumber, r.biosVersion, r.serialNumber, r.bmcFirmware, r.redfishVersion, r.healthStatus, r.powerState, r.alertCount, r.powerWatts, asset.id]
    );
    return { reachable: true, ...r };
  }

  app.post('/api/monitoring/redfish/:assetId/sync', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const asset = await loadAssetForUser(req, res, req.params.assetId);
      if (!asset) return;
      // The background auto-sync sweep (if enabled) already has this device open - starting a
      // second request to the same BMC at the same time is wasted load and can trip some BMCs'
      // session limits. Ask the person to wait a moment rather than double-hit the device.
      if (syncInFlight.has(asset.id)) return res.status(409).json({ error: 'This device is being synced automatically right now - try again in a few seconds.' });
      syncInFlight.add(asset.id);
      try {
        const result = await syncOneAsset(asset);
        res.json(result);
      } finally { syncInFlight.delete(asset.id); }
    } catch (e) { sendErr(res, e); }
  });

  // In-memory job state for the two bulk Redfish operations below. A site can have 1000s of
  // assets, and even with the fast-fail timeout fix and higher concurrency, scanning/applying
  // all of them can legitimately take minutes - far longer than most reverse proxies, load
  // balancers, or corporate gateways will hold a single HTTP request open for (a very common
  // default is 60s), regardless of how long the BROWSER's own fetch timeout is set to. Holding
  // the request open for the whole scan was hitting exactly that: the infrastructure in front
  // of this server would cut the connection before Node finished, and the browser would then
  // show a bare "Request failed" (no parseable error body came back at all - just a dropped
  // connection or a gateway's own error page). So both routes below now return IMMEDIATELY with
  // a job id, run the actual work in the background, and the caller polls a small, fast GET for
  // progress/results - no single request is ever open for more than a moment, so there is
  // nothing left for a proxy timeout to trip.
  const discoverJobs = new Map();
  const applyJobs = new Map();
  const REDFISH_JOB_TTL_MS = 15 * 60 * 1000; // finished jobs are forgotten after this so memory doesn't grow unbounded on a long-running server
  function scheduleJobCleanup(map, jobId) { const t = setTimeout(() => map.delete(jobId), REDFISH_JOB_TTL_MS); if (t.unref) t.unref(); }
  // PRODUCTION HARDENING: nothing previously stopped two Discover runs (a double-click, two
  // browser tabs, or two admins) from starting at the same time and both brute-forcing the SAME
  // set of not-yet-configured devices concurrently - doubling the real login attempts against
  // every BMC in scope and meaningfully raising the odds of tripping its account lockout, exactly
  // the failure mode the rest of this file works hard to avoid. One in-flight Discover job and one
  // in-flight Apply job at a time is enough for any real admin workflow; a second attempt is
  // rejected with a clear reason rather than silently doubling the load.
  let discoverRunning = false;
  let applyRunning = false;

  // Dry-run discovery: tries every candidate credential pair (REDFISH_CREDENTIALS,
  // or the single legacy REDFISH_DEFAULT_* pair - see redfishCredentialCandidates
  // above) against every asset that has a management IP but no Redfish credentials
  // saved yet, in order, stopping at the first one that authenticates. This is how
  // 1000s of devices sharing a handful of common passwords (e.g. Dell's root/calvin,
  // root/calvin@123, root/Calvin@123, HPE's hpadmin/hpinvent) get configured without
  // anyone typing credentials in one IP at a time. Reports what it found and which
  // credential matched; saves nothing until /apply.
  app.post('/api/monitoring/redfish/discover', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    // The guard flag must be set SYNCHRONOUSLY, before the very first `await` in this
    // handler - not after. Node still runs one request handler at a time up to its first
    // await, but from that first await onward another request's handler can interleave on
    // the same event loop tick. If the flag were set after even one await (e.g. after
    // getAllowedSitesForUser or the SELECT below), two Discover POSTs arriving close
    // together could BOTH read discoverRunning as false and both pass the guard before
    // either one sets it - the exact concurrent-scan race this guard exists to prevent.
    if (discoverRunning) return res.status(409).json({ error: 'A Discover scan is already running - wait for it to finish before starting another, so the same devices are not brute-forced twice at once.' });
    discoverRunning = true;
    try {
      const candidates = redfishCredentialCandidates();
      if (!candidates.length) { discoverRunning = false; return res.status(400).json({ error: 'No BMC credentials configured - set REDFISH_CREDENTIALS (e.g. "root:calvin,root:calvin@123,root:Calvin@123,hpadmin:hpinvent") or REDFISH_DEFAULT_USERNAME/PASSWORD in .env, or use Test & Detect to add BMC credentials one at a time instead.' }); }
      const allowed = await getAllowedSitesForUser(req.user);
      // redfish_monitor_ignored = 0: excludes devices already auto-ignored by a PREVIOUS Discover
      // run below (none of the candidate credentials matched, and it wasn't a suspected account
      // lockout) and anyone manually ignored via "Ignore from Monitor" - otherwise a device that
      // genuinely has no matching credential gets re-attacked with every candidate password on
      // every single Discover run forever, which does nothing but waste time and risk tripping a
      // real BMC's login lockout again. "Show ignored" + "Un-ignore" in the main list brings a
      // device back into scope any time (e.g. after fixing REDFISH_CREDENTIALS or confirming its
      // actual login by hand) so this never permanently loses a device.
      // Only scan hardware types that are actually servers (e.g. "DellServer", "HPServer").
      // REDFISH_CREDENTIALS is configured for server BMC logins only - storage arrays, switches,
      // firewalls, PDUs etc. have a management IP too but speak nothing Redfish understands, so
      // throwing the same candidate passwords at them every run wastes a full ~30s timeout per
      // device for nothing and was exactly what made a bulk Discover take far longer than it
      // needed to, and look like it was "scanning everything" instead of just the Dell/HP
      // servers credentials were actually given for.
      const conditions = ["mgmt_ip IS NOT NULL", "mgmt_ip <> ''", "(redfish_username IS NULL OR redfish_username = '')", "redfish_monitor_ignored = 0", "LOWER(hardware_type) LIKE '%server%'"];
      const params = [];
      await applySiteScope(allowed, conditions, params);
      // No LIMIT here on purpose - see the comment above the job maps: this used to stop at the
      // first 200 qualifying assets, silently, with nothing in the response telling the caller
      // more existed. `total`/`scanned` below are the TRUE counts so a caller can tell a
      // complete scan from a partial one.
      const [rows] = await pool.query(`SELECT * FROM assets WHERE ${conditions.join(' AND ')} ORDER BY site, rack_no`, params);

      const jobId = genId('rfdisc');
      const job = { status: 'running', total: rows.length, scanned: 0, reachable: 0, autoIgnored: 0, results: [], credentialsTried: candidates.length, error: null };
      discoverJobs.set(jobId, job);
      // discoverRunning was already set true synchronously at the top of this handler.
      let idx = 0;
      async function worker() {
        while (idx < rows.length) {
          const asset = rows[idx++];
          try {
            const r = await detectRedfishAnyCredential(monitorFetch, asset.mgmt_ip, 443, candidates);
            let autoIgnored = false;
            if (r.reachable) {
              job.reachable++;
            } else if (r.rootReachable && !r.lockoutSuspected) {
              // The device answered but none of the candidate credentials worked, and it's not a
              // suspected lockout (where the correct password might just be mid-cooldown) - this
              // is a clean "none of these logins are right for this device" result, so stop
              // re-attacking it on every future scan. See the condition comment above.
              try {
                await pool.query('UPDATE assets SET redfish_monitor_ignored = 1, last_redfish_error = ?, last_redfish_sync_at = NOW() WHERE id = ?', [String(r.error || 'No configured credential matched').slice(0, 255), asset.id]);
                autoIgnored = true; job.autoIgnored++;
              } catch (e) { /* best-effort - a failed write here shouldn't fail the whole scan */ }
            }
            job.results.push({ assetId: asset.id, site: asset.site, rackNo: asset.rack_no, mgmtIp: asset.mgmt_ip, reachable: r.reachable, vendor: r.vendor, model: r.model, serialNumber: r.serialNumber, healthStatus: r.healthStatus, matchedUsername: r.reachable ? r.credential.username : null, matchedCredentialId: r.reachable ? r.credential.id : null, error: r.reachable ? null : r.error, lockoutSuspected: !!r.lockoutSuspected, autoIgnored });
          } catch (e) { job.results.push({ assetId: asset.id, site: asset.site, rackNo: asset.rack_no, mgmtIp: asset.mgmt_ip, reachable: false, error: e.message }); }
          job.scanned++;
        }
      }
      // Deliberately not awaited - the HTTP response below goes out immediately; the scan keeps
      // running in the background and the caller polls GET .../discover/:jobId for progress.
      Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, rows.length) }, worker))
        .then(() => { job.status = 'done'; })
        .catch((e) => { job.status = 'error'; job.error = e.message; })
        .finally(() => { discoverRunning = false; scheduleJobCleanup(discoverJobs, jobId); });
      res.json({ jobId, status: 'running', total: rows.length });
    } catch (e) { discoverRunning = false; sendErr(res, e); }
  });

  // Poll endpoint for the background scan started above. Returns the job's current state
  // whether it's still running or already finished - the shape matches what /discover used to
  // return synchronously (scanned/reachable/results/credentialsTried) so a caller can treat a
  // finished job's response exactly like the old one-shot response.
  app.get('/api/monitoring/redfish/discover/:jobId', authenticateToken, async (req, res) => {
    const job = discoverJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'This scan has finished and its results have been cleared, or the job id is wrong. Start a new scan.' });
    res.json({ status: job.status, total: job.total, scanned: job.scanned, reachable: job.reachable, autoIgnored: job.autoIgnored, results: job.results, credentialsTried: job.credentialsTried, error: job.error });
  });

  // Commit step: re-detects each selected asset (so we know which of the
  // candidate credentials actually worked for IT) and saves that asset's own
  // matching username/password + detected fields. Each device keeps whichever
  // credential authenticated for it - they are not all forced to the same one.
  app.post('/api/monitoring/redfish/discover/apply', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    // Same ordering requirement as /discover above: set the guard flag synchronously,
    // before this handler's first `await`, or two Apply POSTs arriving close together can
    // both pass the check before either one sets it.
    if (applyRunning) return res.status(409).json({ error: 'An Apply is already running - wait for it to finish before starting another.' });
    applyRunning = true;
    try {
      const { assetIds, credentialsByAsset, credentialIdsByAsset } = req.body;
      if (!Array.isArray(assetIds) || !assetIds.length) { applyRunning = false; return res.status(400).json({ error: 'assetIds array is required' }); }
      const candidates = redfishCredentialCandidates();
      if (!candidates.length) { applyRunning = false; return res.status(400).json({ error: 'No BMC credentials configured - set REDFISH_CREDENTIALS or REDFISH_DEFAULT_USERNAME/PASSWORD' }); }
      const allowed = await getAllowedSitesForUser(req.user);
      // No slice() here on purpose - see the comment above the job maps: this used to silently
      // cap every Apply call at the first 200 selected assets, with everything past #200 never
      // even attempted. skippedNotFound/skippedNoMatch below account for the rest of the gap
      // honestly, and the whole thing now runs as a background job (see /discover above) so a
      // large batch isn't held open as one long HTTP request a proxy/gateway can cut off.
      const ids = assetIds;
      const jobId = genId('rfapply');
      const job = { status: 'running', total: ids.length, processed: 0, applied: 0, skippedNotFound: 0, skippedNoMatch: 0, error: null };
      applyJobs.set(jobId, job);
      // applyRunning was already set true synchronously at the top of this handler.
      let idx = 0;
      async function worker() {
        while (idx < ids.length) {
          const assetId = ids[idx++];
          try {
            const [rows] = await pool.query('SELECT * FROM assets WHERE id = ?', [assetId]);
            if (!rows.length || !allowed.includes(rows[0].site) || !rows[0].mgmt_ip) { job.skippedNotFound++; continue; }
            const asset = rows[0];
            // The frontend sends back the exact credential Discover already proved worked for
            // this asset, so Apply confirms with ONE targeted attempt instead of re-running the
            // full candidate list from scratch. Without this, every asset got re-attacked with
            // all 4 candidate passwords a SECOND time (Discover's pass, then Apply's own pass) -
            // on a real Dell iDRAC or HPE iLO, which locks an account out after a handful of
            // failed logins in a row, that second blind pass could easily trip the lockout
            // Discover had just avoided, making a device that clearly matched moments earlier
            // fail here instead.
            //
            // BUG FIX: this used to look candidates up by USERNAME ALONE
            // (credentialsByAsset[assetId]). Several real candidates legitimately share a
            // username (e.g. all three Dell "root" passwords), so that lookup always grabbed the
            // FIRST "root" entry regardless of which password Discover actually confirmed - if
            // that wasn't the right one, Apply would re-send a known-wrong password, get
            // rejected, and mark the device "no match" even though Discover had just proven it
            // reachable moments earlier with a DIFFERENT "root" password. credentialIdsByAsset
            // carries the exact candidate's stable id (its position in REDFISH_CREDENTIALS) so
            // Apply reuses the precise credential, not just a same-named one. credentialsByAsset
            // (username-only) is kept as a fallback for any older caller that still sends it.
            const knownId = credentialIdsByAsset && credentialIdsByAsset[assetId];
            const knownUsername = credentialsByAsset && credentialsByAsset[assetId];
            const knownCred = knownId != null
              ? candidates.find((c) => c.id === knownId)
              : (knownUsername ? candidates.find((c) => c.username === knownUsername) : null);
            const r = knownCred
              ? await detectRedfish(monitorFetch, asset.mgmt_ip, 443, knownCred.username, knownCred.password).then((res) => ({ ...res, credential: knownCred }))
              : await detectRedfishAnyCredential(monitorFetch, asset.mgmt_ip, 443, candidates);
            if (!r.reachable) { job.skippedNoMatch++; continue; }
            await pool.query(
              `UPDATE assets SET redfish_username = ?, redfish_password = ?, redfish_port = 443,
                 manufacturer = COALESCE(NULLIF(manufacturer, ''), ?), model = COALESCE(NULLIF(model, ''), ?),
                 serial_number = COALESCE(NULLIF(serial_number, ''), ?), firmware = COALESCE(NULLIF(firmware, ''), ?),
                 redfish_serial_number = ?,
                 bmc_firmware = ?, redfish_version = ?, health_status = ?, power_state = ?, redfish_alert_count = ?,
                 redfish_power_watts = ?, last_redfish_sync_at = NOW(), last_redfish_error = NULL
               WHERE id = ?`,
              [r.credential.username, r.credential.password || '', r.vendor, r.model, r.serialNumber, r.biosVersion, r.serialNumber, r.bmcFirmware, r.redfishVersion, r.healthStatus, r.powerState, r.alertCount, r.powerWatts, asset.id]
            );
            job.applied++;
          } finally { job.processed++; }
        }
      }
      Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, ids.length) }, worker))
        .then(() => {
          job.status = 'done';
          auditLog(req, 'REDFISH_DISCOVERY_APPLY', { entity: 'asset', status: 'success' }, { count: job.applied, requested: ids.length, skippedNotFound: job.skippedNotFound, skippedNoMatch: job.skippedNoMatch });
        })
        .catch((e) => { job.status = 'error'; job.error = e.message; })
        .finally(() => { applyRunning = false; scheduleJobCleanup(applyJobs, jobId); });
      res.json({ jobId, status: 'running', total: ids.length });
    } catch (e) { applyRunning = false; sendErr(res, e); }
  });

  // Poll endpoint for the background apply started above.
  app.get('/api/monitoring/redfish/discover/apply/:jobId', authenticateToken, async (req, res) => {
    const job = applyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'This apply has finished and its results have been cleared, or the job id is wrong.' });
    res.json({ status: job.status, total: job.total, processed: job.processed, applied: job.applied, requested: job.total, skippedNotFound: job.skippedNotFound, skippedNoMatch: job.skippedNoMatch, error: job.error });
  });

  app.get('/api/monitoring/redfish/:assetId/firmware-inventory', authenticateToken, async (req, res) => {
    try {
      const asset = await loadAssetForUser(req, res, req.params.assetId);
      if (!asset) return;
      if (!asset.redfish_username) return res.status(400).json({ error: 'No Redfish credentials saved for this asset yet' });
      const inv = await getFirmwareInventory(monitorFetch, asset.mgmt_ip, asset.redfish_port, asset.redfish_username, asset.redfish_password, null);
      res.json(inv);
    } catch (e) { sendErr(res, e); }
  });

  // Firmware push via the standard UpdateService SimpleUpdate action. This is
  // the one place Redfish is genuinely less uniform across vendors (see the
  // module header comment) - a BMC that doesn't support SimpleUpdate returns
  // a clear "not supported" error here rather than a silent failure. On
  // success, the resulting Task is tracked in the SAME firmware_jobs table
  // OME/OneView jobs use (vendor='redfish'), so it shows up in the existing
  // "Firmware Update Jobs" panel without any separate UI.
  app.post('/api/monitoring/redfish/:assetId/firmware/update', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const asset = await loadAssetForUser(req, res, req.params.assetId);
      if (!asset) return;
      if (!asset.redfish_username) return res.status(400).json({ error: 'No Redfish credentials saved for this asset yet' });
      const { imageUri } = req.body;
      if (!imageUri || !/^https?:\/\//i.test(imageUri)) return res.status(400).json({ error: 'A valid firmware image URL (http/https) is required - the BMC fetches it directly from that address' });
      const svc = await redfishGet(monitorFetch, asset.mgmt_ip, asset.redfish_port, asset.redfish_username, asset.redfish_password, '/redfish/v1/UpdateService');
      const action = svc.Actions && svc.Actions['#UpdateService.SimpleUpdate'];
      if (!action) return res.status(400).json({ error: 'This BMC does not support the standard Redfish SimpleUpdate action - firmware push isn’t available for this device via Redfish.' });
      const target = action.target || '/redfish/v1/UpdateService/Actions/UpdateService.SimpleUpdate';
      const result = await redfishPost(monitorFetch, asset.mgmt_ip, asset.redfish_port, asset.redfish_username, asset.redfish_password, target, { ImageURI: imageUri });
      const taskPath = result.location || (result.body && result.body['@odata.id']) || null;
      if (!taskPath) return res.status(502).json({ error: 'The BMC accepted the update request but did not return a Task to track it' });
      const [ins] = await pool.query(
        `INSERT INTO firmware_jobs (vendor, site, zone, device_id, device_name, serial, job_ref, task_uri, started_by, started_at, state, source, job_name)
         VALUES ('redfish', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Running', 'dcim', ?)`,
        [asset.site, asset.zone, asset.id, asset.device_name || asset.asset_tag || asset.id, asset.serial_number, taskPath, taskPath, req.user.name || req.user.username, Date.now(), `Firmware update (Redfish) - ${imageUri.split('/').pop()}`]
      );
      auditLog(req, 'REDFISH_FIRMWARE_UPDATE_STARTED', { entity: 'asset', entityId: asset.id, site: asset.site, status: 'success' }, { imageUri });
      res.json({ success: true, jobId: ins.insertId, taskPath });
    } catch (e) { sendErr(res, e); }
  });

  // Background auto-sync: re-polls every already-configured, non-ignored device on a timer
  // (wired up in server.js next to the equivalent PDU_POLL job) so health/power/alerts stay
  // current without anyone having the page open. Bounded concurrency, same as /discover, so a
  // site with 1000s of devices doesn't open 1000s of connections at once. A device already
  // mid-sync (someone just clicked "Sync Now" on it) is skipped for this pass rather than
  // queued or double-hit - it'll be picked up on the next sweep.
  async function pollAllRedfish() {
    const [rows] = await pool.query(
      `SELECT * FROM assets WHERE mgmt_ip IS NOT NULL AND mgmt_ip <> '' AND redfish_username IS NOT NULL
         AND redfish_username <> '' AND redfish_monitor_ignored = 0`
    );
    let idx = 0, skipped = 0;
    const results = [];
    async function worker() {
      while (idx < rows.length) {
        const asset = rows[idx++];
        if (syncInFlight.has(asset.id)) { skipped++; continue; }
        syncInFlight.add(asset.id);
        try { results.push(await syncOneAsset(asset)); }
        catch (e) { results.push({ reachable: false, error: e.message }); }
        finally { syncInFlight.delete(asset.id); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, rows.length) }, worker));
    log.info(`[redfish] auto-sync polled ${results.length} device(s): ${results.filter((r) => r.reachable).length} reachable${skipped ? `, ${skipped} skipped (mid manual sync)` : ''}`);
    return { polled: results.length, reachable: results.filter((r) => r.reachable).length, skipped };
  }

  return {
    getRedfishTaskStatus: (deviceId, taskUri) => getRedfishTaskStatusForDevice(pool, monitorFetch, deviceId, taskUri),
    pollAllRedfish,
  };
};

async function getRedfishTaskStatusForDevice(pool, monitorFetch, deviceId, taskUri) {
  const [rows] = await pool.query('SELECT mgmt_ip, redfish_port, redfish_username, redfish_password FROM assets WHERE id = ?', [deviceId]);
  if (!rows.length || !rows[0].mgmt_ip || !rows[0].redfish_username) return { status: 'Failed', percent: null, step: null, error: 'Device credentials no longer available' };
  const a = rows[0];
  return getRedfishTaskStatus(monitorFetch, a.mgmt_ip, a.redfish_port, a.redfish_username, a.redfish_password, taskUri);
}
