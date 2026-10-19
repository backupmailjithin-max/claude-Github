'use strict';
// PDU (Power Distribution Unit) power monitoring - registered the same way as
// lib/setup-routes.js: a self-contained module wired into server.js, reusing
// the app's existing location-scoped auth (getAllowedSitesForUser /
// applySiteScope / assertSiteAccess) rather than inventing a new access model.
//
// Schema: one row per PHYSICAL FEED (so a rack with A+B redundant power is two
// rows sharing site/zone/rackType/rackNo), matching the assets table's own
// site/zone/rack_type/rack_no naming and types for consistency. The frontend
// groups feeds into "one row per rack" the same way the approved design does.
//
// Live polling uses SNMP (net-snmp, pure-JS dependency, no native build step -
// safe to ship in an offline bundle) to confirm reachability and read
// sysDescr/sysName for auto-detect. IMPORTANT, read before relying on this in
// production: there is no universal SNMP OID for "current power draw" across
// PDU vendors/models - it is vendor- and sometimes firmware-specific. Rather
// than guess an OID and silently report a number that might be wrong, a PDU
// only gets live wattage once an admin sets its optional "Power OID" (from
// that model's vendor MIB/datasheet) in Edit PDU. Without one, polling still
// confirms online/offline reachability (and surfaces a clear last_error
// explaining why wattage is blank) but never fabricates a reading.
const snmp = require('net-snmp');

const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0';
const SNMP_TIMEOUT_MS = 2500;
const DISCOVERY_TIMEOUT_MS = 1500; // shorter than SNMP_TIMEOUT_MS: a range scan hits mostly-empty IPs, so a slow per-host timeout multiplies into a very slow scan
const DISCOVERY_CONCURRENCY = 20;
const DISCOVERY_MAX_HOSTS = 1024; // hard cap across all configured ranges combined, so a misconfigured range (e.g. a /16 by mistake) can't turn one click into a multi-hour scan

// IPv4 range auto-discovery, configured in .env (not the database - same pattern as the
// OME_*/ONEVIEW_* monitoring config in .env.example). SNMP alone cannot tell you which
// physical Site/Zone/Rack a responding IP belongs to, so the operator maps each IP range
// to a Site+Zone up front; Rack No still has to be assigned by a human per device (see
// PduDiscoveryModal on the frontend). Format, one or more ranges separated by ';':
//   PDU_DISCOVERY_RANGES=10.20.4.100-10.20.4.160:Sample Site A:AZ-1;10.20.5.1-10.20.5.50:Sample Site B:AZ-1
// PDU_DISCOVERY_COMMUNITY is the one SNMP v2c community string used for every scanned
// host - the closest equivalent SNMP v2c has to a shared "username and password" across
// a batch-deployed PDU fleet. There is no SNMPv3 (per-device auth/priv credentials) support.
function ipToInt(ip) {
  const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function intToIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
function parseDiscoveryRanges() {
  const raw = String(process.env.PDU_DISCOVERY_RANGES || '').trim();
  if (!raw) return [];
  const out = [];
  raw.split(';').map((s) => s.trim()).filter(Boolean).forEach((entry) => {
    const parts = entry.split(':');
    if (parts.length !== 3) { log.warn(`[pdu-discovery] ignoring malformed PDU_DISCOVERY_RANGES entry (expected startIP-endIP:Site:Zone): "${entry}"`); return; }
    const [ipRange, site, zone] = parts.map((s) => s.trim());
    const [startIp, endIp] = ipRange.split('-').map((s) => s.trim());
    const startInt = ipToInt(startIp), endInt = ipToInt(endIp || startIp);
    if (startInt === null || endInt === null || !site) { log.warn(`[pdu-discovery] ignoring malformed PDU_DISCOVERY_RANGES entry: "${entry}"`); return; }
    if (endInt < startInt) { log.warn(`[pdu-discovery] ignoring PDU_DISCOVERY_RANGES entry with end before start: "${entry}"`); return; }
    out.push({ startIp, endIp: endIp || startIp, startInt, endInt, site, zone: zone || 'AZ-1' });
  });
  return out;
}
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const VENDOR_HINTS = [
  ['vertiv', 'Vertiv'], ['geist', 'Vertiv'], ['liebert', 'Vertiv'],
  ['apc', 'APC'], ['schneider', 'APC'],
  ['raritan', 'Raritan'], ['server technology', 'Server Technology'], ['servertech', 'Server Technology'],
  ['eaton', 'Eaton'],
];

// Preset "Power OID" catalog for the top worldwide rack-PDU brands (these are
// also the dominant brands in Indian data centers - APC/Schneider, Vertiv,
// Legrand/Raritan and Eaton are the same global players there; there isn't a
// distinct "India-only" rack-PDU brand worth a separate list). Sourced from
// each vendor's own published MIB / support documentation (links in
// docs/PDU-SNMP-OIDS.md) - NOT guessed. Confidence varies by vendor/model
// generation, which is why every entry carries an explicit caveat and the
// Power OID field always stays manually editable in the UI, and "Other /
// Not Listed" (no oid) is always available for anything not covered here.
// `scale`: raw SNMP value x scale = Watts (vendors report in different
// units - W, 0.01 kW, etc; getting this wrong silently corrupts every
// reading, so it travels with the OID, not guessed per-poll).
const VENDOR_OID_PRESETS = [
  {
    id: 'apc-rpdu2', vendor: 'APC / Schneider Electric', model: 'Rack PDU 2G (AP84xx/86xx/88xx/89xx)',
    oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.5.0', scale: 10, confidence: 'high',
    note: 'rPDU2DeviceStatusPower, from APC\'s own PowerNet-MIB FAQ. Reports in hundredths of a kW, so this preset\'s x10 scale converts it to Watts automatically.',
  },
  {
    id: 'apc-rpdu1', vendor: 'APC / Schneider Electric', model: 'Rack PDU 1G / Metered (older AP79xx/AP89xx)',
    oid: '1.3.6.1.4.1.318.1.1.12.1.16.0', scale: 1, confidence: 'medium',
    note: 'rPDUIdentDevicePowerWatts, in Watts directly. On non-metered ("Switched") units this is calculated from current x assumed voltage/power-factor, not truly measured - verify against a metered model if accuracy matters.',
  },
  {
    id: 'eaton-epdu', vendor: 'Eaton', model: 'ePDU (all current families)',
    oid: '1.3.6.1.4.1.534.6.6.4.1.1.2.3.0', scale: 1, confidence: 'high',
    note: 'pduInputPower from EATON-PDU-MIB - present input power demand of the whole unit, in Watts, no index needed.',
  },
  {
    id: 'servertech-sentry3', vendor: 'Server Technology (Legrand)', model: 'Sentry3 PDUs',
    oid: '1.3.6.1.4.1.1718.3.2.2.1.12.1.1', scale: 1, confidence: 'medium',
    note: 'infeedPower from Server Technology\'s own Sentry3 MIB, Watts. The trailing .1.1 selects infeed #1 - if your unit has more than one power infeed, you will need the correct infeed index from an snmpwalk.',
  },
  {
    id: 'raritan-px', vendor: 'Raritan / Legrand', model: 'PX2 / PX3 / PX4',
    oid: null, scale: 1, confidence: 'none',
    note: 'No single confirmed OID across PX firmware versions - Raritan\'s PDU2-MIB exposes inletActivePower (and inletPoleActivePower per phase), but the usable object/index varies by model. Download the PDU2-MIB for your exact unit and confirm with snmpwalk, then enter the OID manually below.',
  },
  {
    id: 'vertiv-geist', vendor: 'Vertiv / Geist', model: 'rPDU (all families)',
    oid: null, scale: 1, confidence: 'none',
    note: 'No confirmed public OID - Vertiv ships a model-specific MIB with every rPDU family (download from vertiv.com support for your exact model). Use snmptranslate/snmpwalk against it to find the active-power object, then enter the OID manually below.',
  },
  {
    id: 'cyberpower', vendor: 'CyberPower', model: 'PDU (all families)',
    oid: null, scale: 1, confidence: 'none',
    note: 'No confirmed total-power OID - download the MIB from CyberPower\'s product support page for your exact model and confirm with snmpwalk, then enter the OID manually below.',
  },
  { id: 'other', vendor: '', model: 'Other / Not Listed', oid: null, scale: 1, confidence: 'none', note: 'Enter everything manually, or leave Power OID blank to monitor reachability only.' },
];
function guessVendor(descr) {
  const d = String(descr || '').toLowerCase();
  for (const [needle, label] of VENDOR_HINTS) if (d.includes(needle)) return label;
  return null;
}
function guessFirmware(descr) {
  const m = String(descr || '').match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  return m ? m[1] : null;
}

function snmpGet(ip, community, oids, timeout) {
  return new Promise((resolve, reject) => {
    let session;
    try { session = snmp.createSession(ip, community || 'public', { timeout: timeout || SNMP_TIMEOUT_MS, retries: 0 }); }
    catch (e) { return reject(e); }
    const done = (err, out) => { try { session.close(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(out); };
    session.on('error', (err) => done(err));
    session.get(oids, (err, varbinds) => {
      if (err) return done(err);
      const bad = varbinds.find((vb) => snmp.isVarbindError(vb));
      if (bad) return done(new Error(snmp.varbindError(bad)));
      const out = {};
      oids.forEach((oid, i) => { out[oid] = varbinds[i].value; });
      done(null, out);
    });
  });
}

module.exports = function registerPduRoutes(app, deps) {
  const { pool, authenticateToken, requireRole, getAllowedSitesForUser, applySiteScope, assertSiteAccess, genId, auditLog, sendErr, httpErr, log } = deps;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pdus (
        id VARCHAR(50) PRIMARY KEY,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) DEFAULT 'AZ-1',
        rack_type VARCHAR(50),
        rack_no VARCHAR(20) NOT NULL,
        feed_label VARCHAR(20) NOT NULL DEFAULT 'Feed A',
        ip_address VARCHAR(100) NOT NULL,
        vendor VARCHAR(50),
        model VARCHAR(150),
        serial_number VARCHAR(150),
        firmware VARCHAR(100),
        phase ENUM('Single-Phase','3-Phase') NOT NULL DEFAULT 'Single-Phase',
        max_load_kw DECIMAL(6,2) DEFAULT NULL,
        snmp_community VARCHAR(100) DEFAULT 'public',
        power_oid VARCHAR(100) DEFAULT NULL,
        power_scale DECIMAL(10,4) NOT NULL DEFAULT 1,
        poll_interval_sec INT NOT NULL DEFAULT 900,
        status ENUM('online','offline','warning','unknown') NOT NULL DEFAULT 'unknown',
        last_power_kw DECIMAL(7,3) DEFAULT NULL,
        last_reading_at DATETIME NULL,
        last_error VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pdu_ip (ip_address),
        KEY idx_site_zone_rack (site, zone, rack_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS power_readings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        pdu_id VARCHAR(50) NOT NULL,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) NOT NULL,
        reading_date DATE NOT NULL,
        avg_kw DECIMAL(7,3) DEFAULT NULL,
        peak_kw DECIMAL(7,3) DEFAULT NULL,
        energy_kwh DECIMAL(9,2) DEFAULT NULL,
        sample_count INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pdu_date (pdu_id, reading_date),
        KEY idx_site_zone_date (site, zone, reading_date),
        CONSTRAINT fk_power_readings_pdu FOREIGN KEY (pdu_id) REFERENCES pdus(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Idempotent migration for a pdus table created before power_scale existed.
    try { await pool.query('ALTER TABLE pdus ADD COLUMN power_scale DECIMAL(10,4) NOT NULL DEFAULT 1 AFTER power_oid'); } catch (e) { /* column already exists */ }
  }

  function mapPdu(r) {
    return {
      id: r.id, site: r.site, zone: r.zone, rackType: r.rack_type, rackNo: r.rack_no, feedLabel: r.feed_label,
      ipAddress: r.ip_address, vendor: r.vendor, model: r.model, serialNumber: r.serial_number, firmware: r.firmware,
      phase: r.phase, maxLoadKw: r.max_load_kw != null ? Number(r.max_load_kw) : null,
      powerOid: r.power_oid, powerScale: r.power_scale != null ? Number(r.power_scale) : 1, pollIntervalSec: r.poll_interval_sec, status: r.status,
      lastPowerKw: r.last_power_kw != null ? Number(r.last_power_kw) : null,
      lastReadingAt: r.last_reading_at, lastError: r.last_error,
    };
  }

  // ---- vendor OID preset catalog (static reference data, served so the frontend never has to duplicate it) ----
  app.get('/api/pdus/vendor-presets', authenticateToken, (req, res) => {
    res.json(VENDOR_OID_PRESETS);
  });

  // ---- list (grouped into racks client-side friendly shape) + create + edit + delete ----
  app.get('/api/pdus', authenticateToken, async (req, res) => {
    try {
      const { site } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      let sql = 'SELECT * FROM pdus';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY site, zone, rack_no, feed_label';
      const [rows] = await pool.query(sql, params);
      res.json(rows.map(mapPdu));
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/pdus', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const b = req.body || {};
      for (const f of ['site', 'rackNo', 'feedLabel', 'ipAddress']) {
        if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `"${f}" is required.` });
      }
      await assertSiteAccess(req.user, b.site);
      const id = genId('PDU');
      await pool.query(
        `INSERT INTO pdus (id, site, zone, rack_type, rack_no, feed_label, ip_address, vendor, model, serial_number, firmware, phase, max_load_kw, snmp_community, power_oid, power_scale)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, b.site, b.zone || 'AZ-1', b.rackType || null, b.rackNo, b.feedLabel, b.ipAddress, b.vendor || null, b.model || null,
          b.serialNumber || null, b.firmware || null, b.phase === '3-Phase' ? '3-Phase' : 'Single-Phase',
          b.maxLoadKw != null && b.maxLoadKw !== '' ? Number(b.maxLoadKw) : null, b.snmpCommunity || 'public', b.powerOid || null,
          b.powerScale != null && b.powerScale !== '' ? Number(b.powerScale) : 1]
      );
      auditLog(req, 'PDU_CREATE', { entity: 'pdu', entityId: id, site: b.site });
      const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [id]);
      res.status(201).json(mapPdu(rows[0]));
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A PDU with this IP address already exists.' });
      sendErr(res, e);
    }
  });

  app.put('/api/pdus/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT * FROM pdus WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'PDU not found' });
      await assertSiteAccess(req.user, existing[0].site);
      const b = req.body || {};
      if (b.site) await assertSiteAccess(req.user, b.site);
      await pool.query(
        `UPDATE pdus SET site=?, zone=?, rack_type=?, rack_no=?, feed_label=?, ip_address=?, vendor=?, model=?, serial_number=?,
           firmware=?, phase=?, max_load_kw=?, snmp_community=?, power_oid=?, power_scale=? WHERE id = ?`,
        [b.site || existing[0].site, b.zone || existing[0].zone, b.rackType != null ? b.rackType : existing[0].rack_type,
          b.rackNo || existing[0].rack_no, b.feedLabel || existing[0].feed_label, b.ipAddress || existing[0].ip_address,
          b.vendor != null ? b.vendor : existing[0].vendor, b.model != null ? b.model : existing[0].model,
          b.serialNumber != null ? b.serialNumber : existing[0].serial_number, b.firmware != null ? b.firmware : existing[0].firmware,
          b.phase === '3-Phase' ? '3-Phase' : (b.phase === 'Single-Phase' ? 'Single-Phase' : existing[0].phase),
          b.maxLoadKw != null && b.maxLoadKw !== '' ? Number(b.maxLoadKw) : (b.maxLoadKw === '' ? null : existing[0].max_load_kw),
          b.snmpCommunity != null ? b.snmpCommunity : existing[0].snmp_community,
          b.powerOid != null ? b.powerOid : existing[0].power_oid,
          b.powerScale != null && b.powerScale !== '' ? Number(b.powerScale) : existing[0].power_scale, req.params.id]
      );
      auditLog(req, 'PDU_UPDATE', { entity: 'pdu', entityId: req.params.id, site: b.site || existing[0].site });
      const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [req.params.id]);
      res.json(mapPdu(rows[0]));
    } catch (e) { sendErr(res, e); }
  });

  app.delete('/api/pdus/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT site FROM pdus WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ error: 'PDU not found' });
      await assertSiteAccess(req.user, existing[0].site);
      await pool.query('DELETE FROM pdus WHERE id = ?', [req.params.id]);
      auditLog(req, 'PDU_DELETE', { entity: 'pdu', entityId: req.params.id, site: existing[0].site });
      res.json({ ok: true });
    } catch (e) { sendErr(res, e); }
  });

  // ---- bulk import: same dry-run-then-commit shape as /api/connectivity/import ----
  // Matched by IP address (the pdus table's one unique key): a row whose IP already
  // exists is treated as an update to that PDU, not a duplicate to reject - this lets
  // the same sheet be used both to add new PDUs and to bulk-correct existing ones.
  app.post('/api/pdus/import', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const dryRun = req.body.dryRun !== false;
      const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'rows[] is required' });
      if (rows.length > 2000) return res.status(400).json({ error: 'Too many rows (max 2000 per import)' });
      const allowed = await getAllowedSitesForUser(req.user);
      const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 255);
      const counts = { total: rows.length, ready: 0, invalid: 0, deniedSite: 0, duplicateInFile: 0, created: 0, updated: 0 };
      const issues = [];
      const seenIp = new Set();
      const toSave = [];
      rows.forEach((r, idx) => {
        const rowNo = (r && Number(r.rowNo)) || idx + 2;
        const site = clean(r && r.site, 50), rackNo = clean(r && r.rackNo, 20), ip = clean(r && r.ipAddress, 100);
        const feedLabel = clean(r && r.feedLabel, 20) || 'Feed A';
        if (!site || !rackNo || !ip) { counts.invalid++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'invalid', message: 'Site, Rack No and IP Address are required - row skipped' }); return; }
        if (!allowed.includes(site)) { counts.deniedSite++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'denied', message: `Access denied for site "${site}" - row skipped` }); return; }
        const ipKey = ip.toLowerCase();
        if (seenIp.has(ipKey)) { counts.duplicateInFile++; if (issues.length < 1000) issues.push({ row: rowNo, ip, status: 'duplicate_in_file', message: 'Same IP appears again in the sheet - only the first row is used' }); return; }
        seenIp.add(ipKey);
        counts.ready++;
        toSave.push({
          site, zone: clean(r.zone, 20) || 'AZ-1', rackType: clean(r.rackType, 50) || null, rackNo, feedLabel, ipAddress: ip,
          vendor: clean(r.vendor, 50) || null, model: clean(r.model, 150) || null, serialNumber: clean(r.serialNumber, 150) || null,
          firmware: clean(r.firmware, 100) || null, phase: String(r.phase || '').trim() === '3-Phase' ? '3-Phase' : 'Single-Phase',
          maxLoadKw: r.maxLoadKw !== undefined && r.maxLoadKw !== '' && !isNaN(Number(r.maxLoadKw)) ? Number(r.maxLoadKw) : null,
          snmpCommunity: clean(r.snmpCommunity, 100) || 'public', powerOid: clean(r.powerOid, 100) || null,
          powerScale: r.powerScale !== undefined && r.powerScale !== '' && !isNaN(Number(r.powerScale)) ? Number(r.powerScale) : 1,
        });
      });
      if (dryRun) return res.json({ dryRun: true, counts, issues });
      if (!toSave.length) return res.json({ dryRun: false, counts, issues });
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const row of toSave) {
          const [existing] = await conn.query('SELECT id FROM pdus WHERE ip_address = ?', [row.ipAddress]);
          if (existing.length) {
            await conn.query(
              `UPDATE pdus SET site=?, zone=?, rack_type=?, rack_no=?, feed_label=?, vendor=?, model=?, serial_number=?,
                 firmware=?, phase=?, max_load_kw=?, snmp_community=?, power_oid=?, power_scale=? WHERE ip_address=?`,
              [row.site, row.zone, row.rackType, row.rackNo, row.feedLabel, row.vendor, row.model, row.serialNumber,
                row.firmware, row.phase, row.maxLoadKw, row.snmpCommunity, row.powerOid, row.powerScale, row.ipAddress]
            );
            counts.updated++;
          } else {
            await conn.query(
              `INSERT INTO pdus (id, site, zone, rack_type, rack_no, feed_label, ip_address, vendor, model, serial_number, firmware, phase, max_load_kw, snmp_community, power_oid, power_scale)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [genId('PDU'), row.site, row.zone, row.rackType, row.rackNo, row.feedLabel, row.ipAddress, row.vendor, row.model,
                row.serialNumber, row.firmware, row.phase, row.maxLoadKw, row.snmpCommunity, row.powerOid, row.powerScale]
            );
            counts.created++;
          }
        }
        await conn.commit();
      } catch (e) { try { await conn.rollback(); } catch (e2) { /* ignore */ } throw e; }
      finally { conn.release(); }
      auditLog(req, 'PDU_IMPORT', { entity: 'pdu', created: counts.created, updated: counts.updated });
      res.json({ dryRun: false, counts, issues });
    } catch (e) { sendErr(res, e); }
  });

  // ---- auto-detect: probe a not-yet-saved IP via SNMP, return best-effort identity fields ----
  app.post('/api/pdus/detect', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    const { ipAddress, snmpCommunity } = req.body || {};
    if (!ipAddress) return res.status(400).json({ error: '"ipAddress" is required.' });
    try {
      const out = await snmpGet(ipAddress, snmpCommunity || 'public', [OID_SYS_DESCR, OID_SYS_NAME]);
      const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
      const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
      res.json({
        reachable: true,
        vendor: guessVendor(descr),
        model: descr || null,
        serialNumber: name || null,
        firmware: guessFirmware(descr),
        note: 'Vendor/Model/Firmware are parsed from the device\'s generic SNMP sysDescr/sysName, which varies by vendor and is not always reliable - review and correct every field before saving. Live wattage polling additionally needs a Power OID from this model\'s vendor MIB/datasheet (set it in the Power OID field); without one, this PDU is still monitored for online/offline reachability only.',
      });
    } catch (e) {
      res.json({ reachable: false, error: 'Could not reach ' + ipAddress + ' via SNMP (' + (e && e.message || 'timeout') + '). Check the IP, that SNMP is enabled on the device, and the community string.' });
    }
  });

  // ---- IP-range discovery: read-only scan + report, nothing is saved here (see /discover/apply and /import) ----
  app.post('/api/pdus/discover', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const allowed = await getAllowedSitesForUser(req.user);
      const ranges = parseDiscoveryRanges().filter((r) => allowed.includes(r.site));
      if (!ranges.length) return res.status(400).json({ error: 'No PDU_DISCOVERY_RANGES configured in .env for your site(s). Ask an admin to set it (see .env.example).' });
      const community = process.env.PDU_DISCOVERY_COMMUNITY || 'public';
      const hosts = []; // { ip, site, zone }
      const seenIp = new Set();
      for (const r of ranges) {
        for (let n = r.startInt; n <= r.endInt && hosts.length < DISCOVERY_MAX_HOSTS; n++) {
          const ip = intToIp(n);
          if (seenIp.has(ip)) continue;
          seenIp.add(ip);
          hosts.push({ ip, site: r.site, zone: r.zone });
        }
        if (hosts.length >= DISCOVERY_MAX_HOSTS) { log.warn(`[pdu-discovery] stopped at DISCOVERY_MAX_HOSTS=${DISCOVERY_MAX_HOSTS} - narrow PDU_DISCOVERY_RANGES if you need to scan more`); break; }
      }
      const [existingRows] = await pool.query('SELECT * FROM pdus WHERE site IN (?)', [ranges.map((r) => r.site)]);
      const byIp = new Map(existingRows.map((r) => [r.ip_address, r]));

      const results = await mapWithConcurrency(hosts, DISCOVERY_CONCURRENCY, async (h) => {
        try {
          const out = await snmpGet(h.ip, community, [OID_SYS_DESCR, OID_SYS_NAME], DISCOVERY_TIMEOUT_MS);
          const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
          const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
          return { ...h, reachable: true, detected: { vendor: guessVendor(descr), model: descr || null, serialNumber: name || null, firmware: guessFirmware(descr) } };
        } catch (e) { return { ...h, reachable: false }; }
      });

      const enrichable = [], unreachable = [], newFound = [];
      let alreadyComplete = 0, scanned = results.length;
      for (const r of results) {
        const existing = byIp.get(r.ip);
        if (existing) {
          if (!r.reachable) { unreachable.push({ id: existing.id, ipAddress: r.ip, site: existing.site, zone: existing.zone, rackNo: existing.rack_no, feedLabel: existing.feed_label }); continue; }
          const missing = !existing.vendor || !existing.model || !existing.serial_number || !existing.firmware;
          if (missing) enrichable.push({ id: existing.id, ipAddress: r.ip, site: existing.site, zone: existing.zone, rackNo: existing.rack_no, feedLabel: existing.feed_label, current: { vendor: existing.vendor, model: existing.model, serialNumber: existing.serial_number, firmware: existing.firmware }, detected: r.detected });
          else alreadyComplete++;
        } else if (r.reachable) {
          newFound.push({ ipAddress: r.ip, site: r.site, zone: r.zone, detected: r.detected });
        }
      }
      res.json({ scanned, ranges: ranges.map((r) => ({ startIp: r.startIp, endIp: r.endIp, site: r.site, zone: r.zone })), enrichable, unreachable, newFound, alreadyComplete });
    } catch (e) { sendErr(res, e); }
  });

  // ---- apply discovered identity to existing PDUs: only fills fields that are currently blank, never overwrites admin-entered data ----
  app.post('/api/pdus/discover/apply', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 200) : [];
      if (!ids.length) return res.status(400).json({ error: '"ids" (array) is required.' });
      const community = process.env.PDU_DISCOVERY_COMMUNITY || 'public';
      const results = await mapWithConcurrency(ids, DISCOVERY_CONCURRENCY, async (id) => {
        try {
          const [rows] = await pool.query('SELECT * FROM pdus WHERE id = ?', [id]);
          if (!rows.length) return { id, applied: false, error: 'PDU not found' };
          const pdu = rows[0];
          await assertSiteAccess(req.user, pdu.site);
          const out = await snmpGet(pdu.ip_address, pdu.snmp_community || community, [OID_SYS_DESCR, OID_SYS_NAME], DISCOVERY_TIMEOUT_MS);
          const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
          const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
          const detected = { vendor: guessVendor(descr), model: descr || null, serialNumber: name || null, firmware: guessFirmware(descr) };
          await pool.query(
            `UPDATE pdus SET vendor = COALESCE(NULLIF(vendor,''), ?), model = COALESCE(NULLIF(model,''), ?),
               serial_number = COALESCE(NULLIF(serial_number,''), ?), firmware = COALESCE(NULLIF(firmware,''), ?) WHERE id = ?`,
            [detected.vendor, detected.model, detected.serialNumber, detected.firmware, id]
          );
          auditLog(req, 'PDU_DISCOVER_APPLY', { entity: 'pdu', entityId: id, site: pdu.site });
          return { id, applied: true };
        } catch (e) { return { id, applied: false, error: e.message || 'Could not reach device' }; }
      });
      res.json({ results });
    } catch (e) { sendErr(res, e); }
  });

  // ---- poll one PDU (reachability always; wattage only if power_oid is configured) ----
  // Also opportunistically fills in vendor/model/serial/firmware if any are still blank,
  // from the same sysDescr/sysName this poll already fetches for reachability - so a PDU
  // added via bulk import or Add PDU with only Site/Rack/IP filled in gets its identity
  // captured automatically on the next sync, no separate "Discover" step required. Same
  // never-overwrite rule as /api/pdus/discover/apply: only fields that are currently blank
  // are touched.
  async function pollOne(pdu) {
    const oids = [OID_SYS_DESCR, OID_SYS_NAME];
    if (pdu.power_oid) oids.push(pdu.power_oid);
    let status = 'offline', lastError = null, powerKw = null, detected = null;
    try {
      const out = await snmpGet(pdu.ip_address, pdu.snmp_community || 'public', oids);
      status = 'online';
      const descr = out[OID_SYS_DESCR] != null ? String(out[OID_SYS_DESCR]) : '';
      const name = out[OID_SYS_NAME] != null ? String(out[OID_SYS_NAME]) : '';
      detected = { vendor: guessVendor(descr), model: descr || null, serialNumber: name || null, firmware: guessFirmware(descr) };
      if (pdu.power_oid) {
        const raw = out[pdu.power_oid];
        const n = typeof raw === 'number' ? raw : parseFloat(raw);
        if (Number.isFinite(n)) {
          // raw SNMP value x power_scale = Watts (set from the vendor preset, or
          // manually) - never guessed per-poll, since vendors report in different
          // units (W, hundredths of kW, etc) and a wrong guess silently corrupts
          // every reading. power_scale defaults to 1 (raw value already in Watts).
          const watts = n * Number(pdu.power_scale || 1);
          powerKw = watts / 1000;
          if (pdu.max_load_kw && powerKw > Number(pdu.max_load_kw) * 1.5) {
            status = 'warning'; lastError = 'Reading far exceeds Max Load - verify the Power OID is correct for this model.';
          }
        } else { lastError = 'Power OID returned a non-numeric value - verify it is correct for this model.'; }
      } else {
        lastError = 'No Power OID configured - reachable, but live wattage is not available until one is set in Edit PDU.';
      }
    } catch (e) {
      status = 'offline'; lastError = 'Unreachable: ' + (e && e.message || 'timeout');
    }
    if (detected) {
      await pool.query(
        `UPDATE pdus SET status=?, last_power_kw=?, last_reading_at=NOW(), last_error=?,
           vendor = COALESCE(NULLIF(vendor,''), ?), model = COALESCE(NULLIF(model,''), ?),
           serial_number = COALESCE(NULLIF(serial_number,''), ?), firmware = COALESCE(NULLIF(firmware,''), ?)
         WHERE id=?`,
        [status, powerKw, lastError, detected.vendor, detected.model, detected.serialNumber, detected.firmware, pdu.id]
      );
    } else {
      await pool.query(
        'UPDATE pdus SET status=?, last_power_kw=?, last_reading_at=NOW(), last_error=? WHERE id=?',
        [status, powerKw, lastError, pdu.id]
      );
    }
    if (powerKw != null) {
      const today = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO power_readings (pdu_id, site, zone, reading_date, avg_kw, peak_kw, energy_kwh, sample_count)
         VALUES (?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE
           avg_kw = (avg_kw * sample_count + VALUES(avg_kw)) / (sample_count + 1),
           peak_kw = GREATEST(peak_kw, VALUES(peak_kw)),
           energy_kwh = energy_kwh + (VALUES(avg_kw) * (? / 3600.0)),
           sample_count = sample_count + 1`,
        [pdu.id, pdu.site, pdu.zone, today, powerKw, powerKw, powerKw, pdu.poll_interval_sec || 900, pdu.poll_interval_sec || 900]
      );
    }
    return { id: pdu.id, status, powerKw, lastError };
  }

  async function pollAllPdus(siteFilter) {
    const conditions = [], params = [];
    if (siteFilter && siteFilter.length) { conditions.push('site IN (' + siteFilter.map(() => '?').join(',') + ')'); params.push(...siteFilter); }
    let sql = 'SELECT * FROM pdus';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    const [rows] = await pool.query(sql, params);
    const results = await Promise.all(rows.map((r) => pollOne(r).catch((e) => ({ id: r.id, status: 'offline', lastError: e.message }))));
    log.info(`[pdu] polled ${results.length} PDU(s): ${results.filter((r) => r.status === 'online').length} online`);
    return results;
  }

  app.post('/api/pdus/sync-all', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const allowed = await getAllowedSitesForUser(req.user);
      const all = allowed; // empty array (no access) correctly polls nothing, never everything
      const results = await pollAllPdus(all.length ? all : ['__none__']);
      auditLog(req, 'PDU_SYNC_ALL', { entity: 'pdu', details: { count: results.length } });
      res.json({ ok: true, synced: results.length, online: results.filter((r) => r.status === 'online').length });
    } catch (e) { sendErr(res, e); }
  });

  // ---- Dashboard summary: total load per site (+ overall), site-scoped ----
  app.get('/api/pdus/summary', authenticateToken, async (req, res) => {
    try {
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      await applySiteScope(allowed, conditions, params);
      let sql = 'SELECT site, COUNT(*) AS pdu_count, SUM(last_power_kw) AS total_kw, SUM(max_load_kw) AS rated_kw, SUM(CASE WHEN status="online" THEN 1 ELSE 0 END) AS online_count FROM pdus';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' GROUP BY site';
      const [rows] = await pool.query(sql, params);
      const bySite = rows.map((r) => ({
        site: r.site, pduCount: Number(r.pdu_count) || 0, onlineCount: Number(r.online_count) || 0,
        totalKw: r.total_kw != null ? Number(r.total_kw) : 0, ratedKw: r.rated_kw != null ? Number(r.rated_kw) : 0,
      }));
      const overall = bySite.reduce((a, s) => ({ totalKw: a.totalKw + s.totalKw, ratedKw: a.ratedKw + s.ratedKw, pduCount: a.pduCount + s.pduCount, onlineCount: a.onlineCount + s.onlineCount }), { totalKw: 0, ratedKw: 0, pduCount: 0, onlineCount: 0 });
      res.json({ bySite, overall });
    } catch (e) { sendErr(res, e); }
  });

  // ---- date-wise trend for a site/zone scope ----
  app.get('/api/pdus/trend', authenticateToken, async (req, res) => {
    try {
      const { site, zone, from, to } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      if (zone && zone !== 'all') { conditions.push('zone = ?'); params.push(zone); }
      if (from) { conditions.push('reading_date >= ?'); params.push(from); }
      if (to) { conditions.push('reading_date <= ?'); params.push(to); }
      let sql = 'SELECT reading_date, SUM(avg_kw) AS avg_kw, SUM(peak_kw) AS peak_kw, SUM(energy_kwh) AS energy_kwh FROM power_readings';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' GROUP BY reading_date ORDER BY reading_date';
      const [rows] = await pool.query(sql, params);
      res.json(rows.map((r) => ({
        date: r.reading_date instanceof Date ? r.reading_date.toISOString().slice(0, 10) : String(r.reading_date),
        avgKw: r.avg_kw != null ? Number(r.avg_kw) : 0, peakKw: r.peak_kw != null ? Number(r.peak_kw) : 0,
        energyKwh: r.energy_kwh != null ? Number(r.energy_kwh) : 0,
      })));
    } catch (e) { sendErr(res, e); }
  });

  return { ensureSchema, pollAllPdus };
};
