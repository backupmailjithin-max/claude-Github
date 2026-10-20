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

const DISCOVERY_CONCURRENCY = 10;

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
  if (!res.ok) { const err = new Error(`Redfish ${path} returned ${res.status}`); err.statusCode = res.status; throw err; }
  return res.json();
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
async function detectRedfish(monitorFetch, ip, port, username, password) {
  const out = {
    reachable: false, redfishVersion: null, vendor: null, model: null, serialNumber: null,
    biosVersion: null, bmcFirmware: null, healthStatus: null, powerState: null,
    powerWatts: null, temperatures: [], fans: [], systemPath: null, chassisPath: null,
    managerPath: null, updateServicePath: null, error: null, alertCount: null,
  };
  let root;
  try { root = await redfishGet(monitorFetch, ip, port, username, password, '/redfish/v1/'); }
  catch (e) { out.error = e.statusCode === 401 ? 'Authentication failed - check the BMC username/password.' : `Could not reach Redfish service: ${e.message}`; return out; }
  out.reachable = true;
  out.redfishVersion = root.RedfishVersion || null;
  out.updateServicePath = (root.UpdateService && root.UpdateService['@odata.id']) || null;

  // Systems collection -> first member's detail
  try {
    const sysLink = root.Systems && root.Systems['@odata.id'];
    if (sysLink) {
      const sysColl = await redfishGet(monitorFetch, ip, port, username, password, sysLink);
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
  } catch (e) { /* Systems collection missing/unreachable on this BMC - leave identity fields null, not fatal */ }

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
      const firstMgr = mgrColl.Members && mgrColl.Members[0] && mgrColl.Members[0]['@odata.id'];
      if (firstMgr) {
        out.managerPath = firstMgr;
        const mgr = await redfishGet(monitorFetch, ip, port, username, password, firstMgr);
        out.bmcFirmware = mgr.FirmwareVersion || null;
        if (!out.vendor) out.vendor = normalizeVendor(mgr.Manufacturer, Object.keys(mgr.Oem || {}));
      }
    }
  } catch (e) { /* Managers collection missing - leave bmcFirmware null, not fatal */ }

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

module.exports = function registerRedfishRoutes(app, deps) {
  const { pool, log, httpErr, sendErr, authenticateToken, requireRole, getAllowedSitesForUser, applySiteScope, assertSiteAccess, genId, auditLog, monitorFetch } = deps;

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
    redfishConfigured: !!a.redfish_username, redfishVersion: a.redfish_version, bmcFirmware: a.bmc_firmware,
    healthStatus: a.health_status, powerState: a.power_state, alertCount: a.redfish_alert_count,
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
      const { site } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = ["mgmt_ip IS NOT NULL", "mgmt_ip <> ''"];
      const params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      const [rows] = await pool.query(`SELECT * FROM assets WHERE ${conditions.join(' AND ')} ORDER BY site, rack_no`, params);
      res.json(rows.map(assetPreview));
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

  // Re-poll an asset's BMC with its saved credentials and persist the
  // result: identity fields (vendor/model/serial/firmware/bmcFirmware) are
  // COALESCE-safe (filled only if currently blank); health/power/sync time
  // always reflect the latest poll, since they are live state, not identity.
  app.post('/api/monitoring/redfish/:assetId/sync', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const asset = await loadAssetForUser(req, res, req.params.assetId);
      if (!asset) return;
      if (!asset.mgmt_ip) return res.status(400).json({ error: 'This asset has no management IP set' });
      if (!asset.redfish_username) return res.status(400).json({ error: 'No Redfish credentials saved for this asset yet - use Test & Detect first' });
      const r = await detectRedfish(monitorFetch, asset.mgmt_ip, asset.redfish_port, asset.redfish_username, asset.redfish_password);
      if (!r.reachable) {
        await pool.query('UPDATE assets SET last_redfish_error = ?, last_redfish_sync_at = NOW() WHERE id = ?', [String(r.error || 'Unreachable').slice(0, 255), asset.id]);
        return res.json({ reachable: false, error: r.error });
      }
      await pool.query(
        `UPDATE assets SET
           manufacturer = COALESCE(NULLIF(manufacturer, ''), ?), model = COALESCE(NULLIF(model, ''), ?),
           serial_number = COALESCE(NULLIF(serial_number, ''), ?), firmware = COALESCE(NULLIF(firmware, ''), ?),
           bmc_firmware = ?, redfish_version = ?, health_status = ?, power_state = ?, redfish_alert_count = ?,
           last_redfish_sync_at = NOW(), last_redfish_error = NULL
         WHERE id = ?`,
        [r.vendor, r.model, r.serialNumber, r.biosVersion, r.bmcFirmware, r.redfishVersion, r.healthStatus, r.powerState, r.alertCount, asset.id]
      );
      res.json({ reachable: true, ...r });
    } catch (e) { sendErr(res, e); }
  });

  // Dry-run discovery: tries one shared default credential (REDFISH_DEFAULT_*
  // in .env - same pattern as PDU_DISCOVERY_COMMUNITY) against every asset
  // that has a management IP but no Redfish credentials saved yet. Reports
  // what it found; saves nothing until /apply.
  app.post('/api/monitoring/redfish/discover', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const defaultUser = process.env.REDFISH_DEFAULT_USERNAME;
      const defaultPass = process.env.REDFISH_DEFAULT_PASSWORD;
      if (!defaultUser) return res.status(400).json({ error: 'REDFISH_DEFAULT_USERNAME / REDFISH_DEFAULT_PASSWORD are not configured in .env - set them, or use Test & Detect to add BMC credentials one at a time instead.' });
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = ["mgmt_ip IS NOT NULL", "mgmt_ip <> ''", "(redfish_username IS NULL OR redfish_username = '')"];
      const params = [];
      await applySiteScope(allowed, conditions, params);
      const [rows] = await pool.query(`SELECT * FROM assets WHERE ${conditions.join(' AND ')} ORDER BY site, rack_no LIMIT 200`, params);

      const results = [];
      let idx = 0;
      async function worker() {
        while (idx < rows.length) {
          const asset = rows[idx++];
          try {
            const r = await detectRedfish(monitorFetch, asset.mgmt_ip, 443, defaultUser, defaultPass);
            results.push({ assetId: asset.id, site: asset.site, rackNo: asset.rack_no, mgmtIp: asset.mgmt_ip, reachable: r.reachable, vendor: r.vendor, model: r.model, serialNumber: r.serialNumber, healthStatus: r.healthStatus, error: r.reachable ? null : r.error });
          } catch (e) { results.push({ assetId: asset.id, site: asset.site, rackNo: asset.rack_no, mgmtIp: asset.mgmt_ip, reachable: false, error: e.message }); }
        }
      }
      await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, rows.length) }, worker));
      res.json({ scanned: rows.length, reachable: results.filter((r) => r.reachable).length, results });
    } catch (e) { sendErr(res, e); }
  });

  // Commit step: save the shared default credential + detected fields for
  // the asset IDs the admin selected from the discover preview.
  app.post('/api/monitoring/redfish/discover/apply', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const { assetIds } = req.body;
      if (!Array.isArray(assetIds) || !assetIds.length) return res.status(400).json({ error: 'assetIds array is required' });
      const defaultUser = process.env.REDFISH_DEFAULT_USERNAME;
      const defaultPass = process.env.REDFISH_DEFAULT_PASSWORD;
      if (!defaultUser) return res.status(400).json({ error: 'REDFISH_DEFAULT_USERNAME is not configured' });
      const allowed = await getAllowedSitesForUser(req.user);
      let applied = 0;
      for (const assetId of assetIds.slice(0, 200)) {
        const [rows] = await pool.query('SELECT * FROM assets WHERE id = ?', [assetId]);
        if (!rows.length || !allowed.includes(rows[0].site) || !rows[0].mgmt_ip) continue;
        const asset = rows[0];
        const r = await detectRedfish(monitorFetch, asset.mgmt_ip, 443, defaultUser, defaultPass);
        if (!r.reachable) continue;
        await pool.query(
          `UPDATE assets SET redfish_username = ?, redfish_password = ?, redfish_port = 443,
             manufacturer = COALESCE(NULLIF(manufacturer, ''), ?), model = COALESCE(NULLIF(model, ''), ?),
             serial_number = COALESCE(NULLIF(serial_number, ''), ?), firmware = COALESCE(NULLIF(firmware, ''), ?),
             bmc_firmware = ?, redfish_version = ?, health_status = ?, power_state = ?, redfish_alert_count = ?,
             last_redfish_sync_at = NOW(), last_redfish_error = NULL
           WHERE id = ?`,
          [defaultUser, defaultPass || '', r.vendor, r.model, r.serialNumber, r.biosVersion, r.bmcFirmware, r.redfishVersion, r.healthStatus, r.powerState, r.alertCount, asset.id]
        );
        applied++;
      }
      auditLog(req, 'REDFISH_DISCOVERY_APPLY', { entity: 'asset', status: 'success' }, { count: applied });
      res.json({ applied });
    } catch (e) { sendErr(res, e); }
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

  return { getRedfishTaskStatus: (deviceId, taskUri) => getRedfishTaskStatusForDevice(pool, monitorFetch, deviceId, taskUri) };
};

async function getRedfishTaskStatusForDevice(pool, monitorFetch, deviceId, taskUri) {
  const [rows] = await pool.query('SELECT mgmt_ip, redfish_port, redfish_username, redfish_password FROM assets WHERE id = ?', [deviceId]);
  if (!rows.length || !rows[0].mgmt_ip || !rows[0].redfish_username) return { status: 'Failed', percent: null, step: null, error: 'Device credentials no longer available' };
  const a = rows[0];
  return getRedfishTaskStatus(monitorFetch, a.mgmt_ip, a.redfish_port, a.redfish_username, a.redfish_password, taskUri);
}
