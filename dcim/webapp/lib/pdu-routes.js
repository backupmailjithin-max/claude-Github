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

const VENDOR_HINTS = [
  ['vertiv', 'Vertiv'], ['geist', 'Vertiv'], ['liebert', 'Vertiv'],
  ['apc', 'APC'], ['schneider', 'APC'],
  ['raritan', 'Raritan'], ['server technology', 'Server Technology'], ['servertech', 'Server Technology'],
  ['eaton', 'Eaton'],
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
  }

  function mapPdu(r) {
    return {
      id: r.id, site: r.site, zone: r.zone, rackType: r.rack_type, rackNo: r.rack_no, feedLabel: r.feed_label,
      ipAddress: r.ip_address, vendor: r.vendor, model: r.model, serialNumber: r.serial_number, firmware: r.firmware,
      phase: r.phase, maxLoadKw: r.max_load_kw != null ? Number(r.max_load_kw) : null,
      powerOid: r.power_oid, pollIntervalSec: r.poll_interval_sec, status: r.status,
      lastPowerKw: r.last_power_kw != null ? Number(r.last_power_kw) : null,
      lastReadingAt: r.last_reading_at, lastError: r.last_error,
    };
  }

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
        `INSERT INTO pdus (id, site, zone, rack_type, rack_no, feed_label, ip_address, vendor, model, serial_number, firmware, phase, max_load_kw, snmp_community, power_oid)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, b.site, b.zone || 'AZ-1', b.rackType || null, b.rackNo, b.feedLabel, b.ipAddress, b.vendor || null, b.model || null,
          b.serialNumber || null, b.firmware || null, b.phase === '3-Phase' ? '3-Phase' : 'Single-Phase',
          b.maxLoadKw != null && b.maxLoadKw !== '' ? Number(b.maxLoadKw) : null, b.snmpCommunity || 'public', b.powerOid || null]
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
           firmware=?, phase=?, max_load_kw=?, snmp_community=?, power_oid=? WHERE id = ?`,
        [b.site || existing[0].site, b.zone || existing[0].zone, b.rackType != null ? b.rackType : existing[0].rack_type,
          b.rackNo || existing[0].rack_no, b.feedLabel || existing[0].feed_label, b.ipAddress || existing[0].ip_address,
          b.vendor != null ? b.vendor : existing[0].vendor, b.model != null ? b.model : existing[0].model,
          b.serialNumber != null ? b.serialNumber : existing[0].serial_number, b.firmware != null ? b.firmware : existing[0].firmware,
          b.phase === '3-Phase' ? '3-Phase' : (b.phase === 'Single-Phase' ? 'Single-Phase' : existing[0].phase),
          b.maxLoadKw != null && b.maxLoadKw !== '' ? Number(b.maxLoadKw) : (b.maxLoadKw === '' ? null : existing[0].max_load_kw),
          b.snmpCommunity != null ? b.snmpCommunity : existing[0].snmp_community,
          b.powerOid != null ? b.powerOid : existing[0].power_oid, req.params.id]
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

  // ---- poll one PDU (reachability always; wattage only if power_oid is configured) ----
  async function pollOne(pdu) {
    const oids = [OID_SYS_DESCR];
    if (pdu.power_oid) oids.push(pdu.power_oid);
    let status = 'offline', lastError = null, powerKw = null;
    try {
      const out = await snmpGet(pdu.ip_address, pdu.snmp_community || 'public', oids);
      status = 'online';
      if (pdu.power_oid) {
        const raw = out[pdu.power_oid];
        const n = typeof raw === 'number' ? raw : parseFloat(raw);
        if (Number.isFinite(n)) {
          // Most PDU MIBs report watts or deciwatts/deciamps as integers - heuristically
          // normalize to kW: values over 100 are assumed to be watts, not kW.
          powerKw = n > 100 ? n / 1000 : n;
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
    await pool.query(
      'UPDATE pdus SET status=?, last_power_kw=?, last_reading_at=NOW(), last_error=? WHERE id=?',
      [status, powerKw, lastError, pdu.id]
    );
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
