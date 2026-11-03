'use strict';
// Optional operational improvements (all additive, all read-only unless an admin switches a feature on):
//   * backup replication to a mounted share / secondary path        (P1.2)
//   * security health check                                           (P1.3)
//   * TLS status + compatibility probe                                (P1.1)
//   * data quality report + hardware-type catalog                     (P2.5-2.7)
//   * scheduled hardware sync                                         (P3.8)
//   * operational health dashboard + optional alert e-mails           (P3.10)
//   * opt-in paged asset list                                         (P4.11)
//   * saved views per user                                            (P5.13)
//   * QR / barcode payloads and scan lookup                           (P5.14)
// Nothing here changes an existing route, table or setting. New settings live in app_settings under ops.* / backup.replica*
// / dq.* / user.views.* keys. Every feature is OFF until an admin turns it on.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

module.exports = function registerOpsRoutes(app, deps) {
  const {
    pool, log, httpErr, sendErr, authenticateToken, requireGlobalAdmin, getAllowedSitesForUser, getSetting, setSetting, auditLog,
    tlsConfig, backupConfig, hwSyncAsset, hwProviderFor, getMonitorConfig, getOmeToken, getOneviewSession, getAutoSyncInfo,
    sendNotification, APP_VERSION, webappDir,
  } = deps;

  const jget = async (k, d) => { try { const v = await getSetting(k, ''); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const jset = (k, v) => setSetting(k, JSON.stringify(v));
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { sendErr(res, e); } };
  const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtBytes = (n) => { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(i ? 1 : 0)} ${u[i]}`; };

  // ============ P1.1  TLS ============
  app.get('/api/ops/tls', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => { res.json(tlsConfig.status()); }));

  // Compatibility probe: tries a strict handshake (internal CA + public CAs) against every configured appliance and the SMTP
  // server, WITHOUT changing anything. Tells the admin which integrations would keep working if ENABLE_STRICT_TLS=true.
  app.post('/api/ops/tls/probe', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const targets = [];
    const add = (label, host, port) => { if (host && !targets.some((t) => t.host === host && t.port === port)) targets.push({ label, host, port }); };
    const body = req.body || {};
    if (body.host) add('Custom', String(body.host).trim(), Number(body.port) || 443);
    else {
      for (const [k, v] of Object.entries(process.env)) {
        const m = /^(OME|ONEVIEW)_.+_HOST$/.exec(k); if (!m || !v) continue;
        try { const u = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`); if (u.protocol === 'https:') add(m[1] === 'OME' ? 'Dell OME' : 'HPE OneView', u.hostname, Number(u.port) || 443); } catch (e) { /* skip */ }
      }
      const smtp = await jget('integrations.smtp', null);
      if (smtp && smtp.host && (smtp.secure || Number(smtp.port) === 465)) add('SMTP (TLS)', smtp.host, Number(smtp.port) || 465);
    }
    const results = [];
    for (const t of targets.slice(0, 25)) results.push({ label: t.label, ...(await tlsConfig.probe(t.host, t.port)) });
    const ok = results.filter((r) => r.strictOk).length;
    res.json({ checkedAt: new Date().toISOString(), strictActive: tlsConfig.status().active, total: results.length, strictOk: ok, wouldBreak: results.length - ok, results,
      note: 'Redfish BMCs and SMTP on STARTTLS (port 587) are checked at connection time and are not probed here. Hosts that cannot verify can be kept relaxed with TLS_RELAXED_HOSTS.' });
  }));

  // ============ P1.2  Backup replication ============
  const REPLICA_KEY = 'backup.replica';
  const REPLICA_LAST = 'backup.replica.last';
  const BACKUP_FILE_RE = /^dc-backup-.*\.json\.gz(\.meta\.json)?$/;
  async function replicaCfg() { const c = await jget(REPLICA_KEY, {}); return { enabled: !!c.enabled, path: String(c.path || ''), keepDays: Math.min(3650, Math.max(1, Number(c.keepDays) || 30)), notify: c.notify !== false }; }

  function mountInfo(p) {
    try {
      const real = fs.existsSync(p) ? fs.realpathSync(p) : p;
      const lines = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
      let best = null;
      for (const l of lines) { const f = l.split(' '); if (f.length < 3) continue; const mp = f[1].replace(/\\040/g, ' '); if ((real === mp || real.startsWith(mp.endsWith('/') ? mp : mp + '/')) && (!best || mp.length > best.mp.length)) best = { mp, type: f[2], source: f[0] }; }
      return best;
    } catch (e) { return null; }
  }
  function describeKind(type) { return /cifs|smb/i.test(type || '') ? 'SMB share' : /nfs/i.test(type || '') ? 'NFS share' : 'local / secondary path'; }

  async function checkReplicaPath(p) {
    if (!p || !path.isAbsolute(p)) throw httpErr(400, 'Enter a full folder path for the copy (for example /mnt/backup-share/dcim).');
    const dir = path.resolve(p);
    if (path.parse(dir).root === dir) throw httpErr(400, 'Choose a folder, not the root of a drive.');
    if (/^\/(proc|sys|dev)(\/|$)/.test(dir)) throw httpErr(400, 'That is a system location.');
    await within(fs.promises.mkdir(dir, { recursive: true }), 8000, 'creating the folder').catch((e) => { throw httpErr(400, `The folder cannot be created: ${e.message}`); });
    const probe = path.join(dir, `.write-test-${crypto.randomBytes(4).toString('hex')}`);
    try { await within(fs.promises.writeFile(probe, 'ok'), 8000, 'write test'); await fs.promises.unlink(probe); }
    catch (e) { throw httpErr(400, `The folder is not writable: ${e.message}`); }
    const m = mountInfo(dir);
    let sameDisk = false;
    try { const primary = (await backupConfig()).dir; sameDisk = fs.statSync(primary).dev === fs.statSync(dir).dev; } catch (e) { /* ignore */ }
    return { dir, kind: m ? describeKind(m.type) : 'local / secondary path', fsType: m ? m.type : null, mountSource: m ? m.source : null, sameDiskAsPrimary: sameDisk };
  }

  let replicaBusy = false;
  // Copies one finished backup (and its .meta.json) to the replica folder. Never throws; records the outcome.
  async function replicateBackup(srcDir, name, trigger) {
    const cfg = await replicaCfg();
    if (!cfg.enabled || !cfg.path) return { skipped: true };
    if (replicaBusy) return { skipped: true, reason: 'busy' };
    replicaBusy = true;
    const started = Date.now(); const at = new Date().toISOString();
    try {
      const info = await checkReplicaPath(cfg.path);
      const copied = [];
      for (const f of [name, name + '.meta.json']) {
        const src = path.join(srcDir, f); if (!fs.existsSync(src)) continue;
        const dst = path.join(info.dir, f); const tmp = dst + '.tmp';
        await within(fs.promises.copyFile(src, tmp), 10 * 60 * 1000, 'copy');
        const a = crypto.createHash('sha256').update(await fs.promises.readFile(src)).digest('hex');
        const b = crypto.createHash('sha256').update(await fs.promises.readFile(tmp)).digest('hex');
        if (a !== b) { await fs.promises.unlink(tmp).catch(() => {}); throw new Error(`the copy of ${f} does not match the original (checksum differs)`); }
        await fs.promises.rename(tmp, dst); copied.push(f);
      }
      if (!copied.length) throw new Error('the backup file to copy was not found');
      // prune OUR old replica files only
      const cutoff = Date.now() - cfg.keepDays * 86400000; let removed = 0;
      for (const f of await fs.promises.readdir(info.dir)) { if (!BACKUP_FILE_RE.test(f)) continue; try { const st = await fs.promises.stat(path.join(info.dir, f)); if (st.mtimeMs < cutoff) { await fs.promises.unlink(path.join(info.dir, f)); removed++; } } catch (e) { /* skip */ } }
      const last = { ok: true, at, file: name, dir: info.dir, kind: info.kind, fsType: info.fsType, ms: Date.now() - started, removedOld: removed, trigger };
      await jset(REPLICA_LAST, last);
      log.info(`[backup-replica] ${name} copied to ${info.dir} (${info.kind})`);
      return last;
    } catch (e) {
      const prev = await jget(REPLICA_LAST, null);
      const last = { ok: false, at, file: name, error: e.message, trigger, failingSince: prev && prev.ok === false ? (prev.failingSince || prev.at) : at };
      try { await jset(REPLICA_LAST, last); } catch (e2) { /* ignore */ }
      log.warn(`[backup-replica] FAILED for ${name}: ${e.message}`);
      auditLog(null, 'BACKUP_REPLICATE', { username: 'system', entity: 'backup', entityId: name, status: 'failure', details: { error: String(e.message).slice(0, 300) } });
      if (cfg.notify && !(prev && prev.ok === false && prev.notifiedAt && Date.now() - new Date(prev.notifiedAt).getTime() < 86400000)) {
        try { await sendNotification({ subject: '[DCIM] Backup copy failed', html: `<p>The backup <b>${name}</b> was created, but copying it to the secondary location <b>${cfg.path}</b> failed:</p><p>${String(e.message).replace(/[<>&]/g, '')}</p><p>The original backup is safe on the server.</p>` }); last.notifiedAt = new Date().toISOString(); await jset(REPLICA_LAST, last); } catch (e2) { /* e-mail is best effort */ }
      }
      return last;
    } finally { replicaBusy = false; }
  }
  // called by server.js after a SUCCESSFUL backup; fire-and-forget so the existing backup flow is untouched
  function afterBackup(w) { if (!w || !w.name) return; replicateBackup(w.dir, w.name, 'after-backup').catch(() => {}); }

  app.get('/api/ops/backup-replica', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const cfg = await replicaCfg(); const last = await jget(REPLICA_LAST, null);
    let target = null; if (cfg.path) { try { const m = mountInfo(cfg.path); target = { exists: fs.existsSync(cfg.path), kind: m ? describeKind(m.type) : 'local / secondary path', fsType: m ? m.type : null }; } catch (e) { /* ignore */ } }
    res.json({ config: cfg, last, target, primaryDir: (await backupConfig()).dir,
      help: 'SMB / NFS: mount the share on the server once (for example in /etc/fstab) and enter the mounted folder here. The app copies each new backup there and verifies the checksum.' });
  }));
  app.put('/api/ops/backup-replica', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const next = { enabled: !!b.enabled, path: String(b.path || '').trim(), keepDays: Number(b.keepDays) || 30, notify: b.notify !== false };
    let check = null;
    if (next.enabled || next.path) check = await checkReplicaPath(next.path);
    await jset(REPLICA_KEY, next);
    auditLog(req, 'BACKUP_REPLICA_SETTINGS', { entity: 'backup', details: { enabled: next.enabled, path: next.path, keepDays: next.keepDays } });
    res.json({ config: await replicaCfg(), check });
  }));
  app.post('/api/ops/backup-replica/test', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const p = String((req.body && req.body.path) || (await replicaCfg()).path || '').trim();
    res.json({ ok: true, ...(await checkReplicaPath(p)) });
  }));
  // copy the newest existing backup now (does not create a new backup)
  app.post('/api/ops/backup-replica/run', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const cfg = await replicaCfg(); if (!cfg.enabled || !cfg.path) throw httpErr(400, 'Backup copy is switched off or has no folder.');
    const dir = (await backupConfig()).dir; const names = (await fs.promises.readdir(dir).catch(() => [])).filter((f) => /^dc-backup-.*\.json\.gz$/.test(f)).sort();
    if (!names.length) throw httpErr(400, 'There is no backup file to copy yet.');
    res.json(await replicateBackup(dir, names[names.length - 1], 'manual'));
  }));

  // ============ P1.3  Security health check ============
  async function securityChecks() {
    const checks = []; const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });
    const envFile = path.join(webappDir, '.env');
    try {
      const st = fs.statSync(envFile); const mode = st.mode & 0o777;
      if (process.platform === 'win32') add('.env permissions', 'PASS', 'permission bits are not checked on Windows');
      else if (mode & 0o077) add('.env permissions', 'WARNING', `.env is readable by other users (mode ${mode.toString(8)}). It holds database and appliance passwords.`, `chmod 600 ${envFile}`);
      else add('.env permissions', 'PASS', `restricted (mode ${mode.toString(8)})`);
      if (process.platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid() && process.getuid() !== 0) add('.env owner', 'WARNING', 'the .env file belongs to a different user than the service');
    } catch (e) { add('.env permissions', 'PASS', 'no .env file next to the app (settings come from the service definition)'); }
    const jwt = String(process.env.JWT_SECRET || '');
    if (!jwt) add('JWT secret', 'FAIL', 'JWT_SECRET is not set');
    else if (jwt.length < 32) add('JWT secret', 'WARNING', `JWT_SECRET is short (${jwt.length} characters)`, 'use a random value of 48+ characters');
    else if (/change.?me|secret|password|default|example/i.test(jwt)) add('JWT secret', 'WARNING', 'JWT_SECRET looks like a placeholder');
    else add('JWT secret', 'PASS', `set (${jwt.length} characters)`);
    if (!process.env.DB_PASSWORD) add('Database password', 'WARNING', 'DB_PASSWORD is empty'); else add('Database password', 'PASS', 'set');
    const t = tlsConfig.status();
    if (t.active) add('TLS verification', 'PASS', `strict (${t.caLoaded} internal CA certificate(s))`);
    else if (t.requested) add('TLS verification', 'WARNING', `strict TLS was requested but is not active: ${t.caError || 'unknown reason'}`);
    else add('TLS verification', 'WARNING', 'certificate verification is relaxed for appliance and SMTP connections (current default)', 'optional: set ENABLE_STRICT_TLS=true and INTERNAL_CA_FILE=/path/ca.pem after running the TLS compatibility probe');
    if (t.processWideVerifyDisabled) add('Process-wide TLS switch', 'WARNING', 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set for the whole service (disables verification for every outgoing TLS call)', 'remove it from the service definition once strict TLS is verified');
    if ((process.env.NODE_ENV || '') !== 'production') add('NODE_ENV', 'WARNING', `NODE_ENV is "${process.env.NODE_ENV || 'not set'}"`); else add('NODE_ENV', 'PASS', 'production');
    if (process.platform !== 'win32' && typeof process.getuid === 'function') { if (process.getuid() === 0) add('Service account', 'WARNING', 'the service runs as root', 'run it as a dedicated user'); else add('Service account', 'PASS', `runs as ${os.userInfo().username}`); }
    for (const [label, dir] of [['Uploads folder', path.join(webappDir, 'uploads')], ['Backups folder', (await backupConfig().catch(() => ({ dir: '' }))).dir]]) {
      if (!dir) continue;
      try { const st = fs.statSync(dir); if (process.platform !== 'win32' && (st.mode & 0o002)) add(label, 'WARNING', `${dir} is writable by everyone`, `chmod o-w ${dir}`); else add(label, 'PASS', dir); } catch (e) { add(label, 'WARNING', `${dir} not found`); }
    }
    try { const [[r]] = await pool.query("SELECT COUNT(*) c FROM users WHERE must_change_password = 1 AND status = 'Active'"); if (r.c) add('Pending password changes', 'WARNING', `${r.c} active user(s) still have a first-login password`); else add('Pending password changes', 'PASS', 'none'); } catch (e) { /* column may not exist */ }
    const overall = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'PASS';
    return { overall, checkedAt: new Date().toISOString(), checks };
  }
  app.get('/api/ops/security', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => { res.json(await securityChecks()); }));

  // ============ P2.5-2.7  Data quality ============
  const CATEGORIES = ['Server', 'Storage', 'Network', 'Firewall', 'Backup Appliance', 'PDU'];
  const CAT_RULES = [
    ['Backup Appliance', /backup|data\s*domain|\bdd\d/i], ['PDU', /\bpdu\b|power\s*distribution/i], ['Firewall', /firewall|fortigate|palo\s*alto|checkpoint|\basa\b/i],
    ['Network', /switch|router|network|nexus|\baci\b|leaf|spine|load\s*balancer|\bf5\b|aristra|arista/i], ['Storage', /storage|\bsan\b|\bnas\b|netapp|powerstore|unity|3par|array|\bsan\s*switch/i], ['Server', /server|blade|chassis|node/i],
  ];
  // accepted spellings out of the box; the admin can accept more (they are then no longer flagged)
  const DEFAULT_ACCEPTED = { Server: ['Server', 'DellServer', 'HPServer', 'Dell Server', 'HPE Server'], Storage: ['Storage'], Network: ['Network', 'Switch'], Firewall: ['Firewall'], 'Backup Appliance': ['Backup Appliance'], PDU: ['PDU'] };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function categoryOf(raw) { const t = String(raw || ''); for (const [c, re] of CAT_RULES) if (re.test(t)) return c; return null; }
  async function loadCatalog() {
    const cfg = await jget('dq.hwTypeCatalog', {}); const accepted = {};
    for (const c of CATEGORIES) accepted[c] = Array.from(new Set([...(DEFAULT_ACCEPTED[c] || []), ...((cfg.accepted && cfg.accepted[c]) || [])]));
    return { categories: CATEGORIES, accepted, overrides: cfg.overrides || {} };
  }
  const DEVICE_NAME_FLAGS = [/no\s*connectivity/i, /not\s*in\s*(ome|one\s*view|oneview)/i, /unknown\s*device/i, /^\s*(n\/?a|none|null|tbd|unknown|-+)\s*$/i, /not\s*(found|available|applicable)/i];
  const ISSUES = [
    ['missingManufacturer', 'Missing Manufacturer'], ['missingSerial', 'Missing Serial Number'], ['missingHwDetails', 'Missing H/W Details'], ['missingConnectivity', 'Missing Connectivity'],
    ['missingPdu', 'Missing PDU Mapping'], ['missingLocation', 'Missing Location'], ['missingZone', 'Missing Zone'], ['missingRack', 'Missing Rack Mapping'], ['hwTypeNonStandard', 'Invalid Hardware Type'], ['deviceNameStatusText', 'Device Name Issues'],
  ];

  async function buildDataQuality(user, siteFilter) {
    const allowed = await getAllowedSitesForUser(user);
    if (siteFilter && siteFilter !== 'all' && !allowed.includes(siteFilter)) throw httpErr(403, 'Access denied for this site');
    const sites = siteFilter && siteFilter !== 'all' ? [siteFilter] : (allowed.length ? allowed : ['__none__']);
    let rows;
    try { [rows] = await pool.query("SELECT id, site, zone, rack_no, position, hardware_type, manufacturer, model, serial_number, device_name, mgmt_ip FROM assets WHERE site IN (?) AND COALESCE(lifecycle_status,'Active') = 'Active'", [sites]); }
    catch (e) { [rows] = await pool.query('SELECT id, site, zone, rack_no, position, hardware_type, manufacturer, model, serial_number, device_name, mgmt_ip FROM assets WHERE site IN (?)', [sites]); }
    const [conn] = await pool.query('SELECT serial_number FROM asset_connectivity WHERE site IN (?)', [sites]);
    const [hw] = await pool.query('SELECT serial_number FROM asset_hw_details WHERE site IN (?)', [sites]);
    let pdus = []; try { [pdus] = await pool.query('SELECT site, zone, rack_no FROM pdus WHERE site IN (?)', [sites]); } catch (e) { pdus = []; }
    const key = (s) => String(s || '').trim().toLowerCase();
    const connSet = new Set(conn.map((r) => key(r.serial_number))); const hwSet = new Set(hw.map((r) => key(r.serial_number)));
    const pduRack = new Set(pdus.map((r) => `${key(r.site)}|${key(r.zone)}|${key(r.rack_no)}`)); const pduSites = new Set(pdus.map((r) => key(r.site)));
    const cat = await loadCatalog();
    const acceptedNorm = new Set(Object.values(cat.accepted).flat().map(norm));
    const out = []; const typeCount = {}; const applicable = {};
    const bump = (k) => { applicable[k] = (applicable[k] || 0) + 1; };
    for (const a of rows) {
      const issues = []; const serial = String(a.serial_number || '').trim(); const hwt = String(a.hardware_type || '').trim();
      const category = cat.overrides[hwt] || categoryOf(hwt);
      const isServer = category === 'Server' || /server/i.test(hwt);
      const prov = hwProviderFor(a.manufacturer);
      let flagged = false; const dn = String(a.device_name || '');
      if (DEVICE_NAME_FLAGS.some((re) => re.test(dn))) { flagged = true; issues.push('deviceNameStatusText'); }
      bump('deviceNameStatusText');
      bump('missingManufacturer'); if (!String(a.manufacturer || '').trim()) issues.push('missingManufacturer');
      bump('missingSerial'); if (!serial) issues.push('missingSerial');
      bump('missingLocation'); if (!String(a.site || '').trim()) issues.push('missingLocation');
      bump('missingZone'); if (!String(a.zone || '').trim()) issues.push('missingZone');
      bump('missingRack'); if (!String(a.rack_no || '').trim()) issues.push('missingRack');
      if (isServer && serial) { bump('missingConnectivity'); if (!connSet.has(key(serial))) issues.push('missingConnectivity'); }
      if (isServer && serial && prov && /^[A-Za-z0-9_.-]{3,64}$/.test(serial)) { bump('missingHwDetails'); if (!hwSet.has(key(serial))) issues.push('missingHwDetails'); }
      if (String(a.rack_no || '').trim() && pduSites.has(key(a.site))) { bump('missingPdu'); if (!pduRack.has(`${key(a.site)}|${key(a.zone)}|${key(a.rack_no)}`)) issues.push('missingPdu'); }
      bump('hwTypeNonStandard');
      let suggestion = '';
      if (!hwt) { issues.push('hwTypeNonStandard'); suggestion = 'Set a hardware type'; }
      else if (!acceptedNorm.has(norm(hwt))) { issues.push('hwTypeNonStandard'); suggestion = category ? `Suggested category: ${category}` : 'No matching catalog category'; }
      typeCount[hwt || '(blank)'] = typeCount[hwt || '(blank)'] || { raw: hwt || '(blank)', count: 0, category: category || null, standard: !!hwt && acceptedNorm.has(norm(hwt)) };
      typeCount[hwt || '(blank)'].count++;
      if (issues.length) out.push({ id: a.id, site: a.site, zone: a.zone, rackNo: a.rack_no, position: a.position, hardwareType: a.hardware_type, manufacturer: a.manufacturer, model: a.model, serialNumber: a.serial_number, deviceName: a.device_name, mgmtIp: a.mgmt_ip, issues, suggestion, deviceNameFlagged: flagged });
    }
    const summary = ISSUES.map(([k, label]) => ({ key: k, label, count: out.filter((r) => r.issues.includes(k)).length, applicable: applicable[k] || 0 }));
    return { generatedAt: new Date().toISOString(), totalAssets: rows.length, assetsWithIssues: out.length, summary, rows: out, hwTypes: Object.values(typeCount).sort((x, y) => y.count - x.count), catalog: cat,
      notes: { missingPdu: pdus.length ? 'PDU mapping is checked per rack (site + zone + rack) and only for locations that have PDUs recorded.' : 'No PDUs are recorded yet, so PDU mapping is not checked.', deviceNameStatusText: 'These are flagged for information only - nothing is changed. Your "No Connectivity - Not in OME/OneView" convention can be hidden with the "Hide flagged names" filter.' } };
  }
  app.get('/api/ops/data-quality', authenticateToken, wrap(async (req, res) => { res.json(await buildDataQuality(req.user, req.query.site)); }));
  app.get('/api/ops/hw-type-catalog', authenticateToken, wrap(async (req, res) => { res.json(await loadCatalog()); }));
  // Accept a raw hardware-type spelling as standard (or map it to a category). Data in assets is never touched.
  app.put('/api/ops/hw-type-catalog', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const cfg = await jget('dq.hwTypeCatalog', {}); cfg.accepted = cfg.accepted || {}; cfg.overrides = cfg.overrides || {};
    const raw = String(b.raw || '').trim().slice(0, 50); const category = String(b.category || '');
    if (!raw || !CATEGORIES.includes(category)) throw httpErr(400, 'Choose a hardware type and a catalog category.');
    cfg.accepted[category] = Array.from(new Set([...(cfg.accepted[category] || []), raw])).slice(0, 200);
    cfg.overrides[raw] = category;
    await jset('dq.hwTypeCatalog', cfg);
    auditLog(req, 'DQ_CATALOG_ACCEPT', { entity: 'hardware_type', entityId: raw, details: { category } });
    res.json(await loadCatalog());
  }));

  // ============ P3.8  Scheduled hardware sync ============
  const HWSYNC_KEY = 'ops.hwsync'; const HWSYNC_LAST = 'ops.hwsync.last'; const HWSYNC_HIST = 'ops.hwsync.history';
  async function hwSyncCfg() { const c = await jget(HWSYNC_KEY, {}); return { mode: ['daily', 'weekly'].includes(c.mode) ? c.mode : 'disabled', time: /^\d{2}:\d{2}$/.test(c.time || '') ? c.time : '02:30', weekday: Number.isInteger(c.weekday) && c.weekday >= 0 && c.weekday <= 6 ? c.weekday : 0, site: c.site || 'all' }; }
  let hwSyncRunning = null;
  async function runScheduledHwSync(trigger, by) {
    if (hwSyncRunning) throw httpErr(409, 'A hardware sync is already running.');
    const cfg = await hwSyncCfg(); const startedAt = new Date();
    hwSyncRunning = { startedAt: startedAt.toISOString(), done: 0, total: 0, trigger };
    try {
      let rows;
      try { [rows] = await pool.query("SELECT id, site, zone, rack_no, position, serial_number, manufacturer, model, device_name, hardware_type FROM assets WHERE hardware_type REGEXP 'server' AND COALESCE(lifecycle_status,'Active') = 'Active'"); }
      catch (e) { [rows] = await pool.query("SELECT id, site, zone, rack_no, position, serial_number, manufacturer, model, device_name, hardware_type FROM assets WHERE hardware_type REGEXP 'server'"); }
      const failures = []; let success = 0; let skipped = 0; const targets = [];
      for (const a of rows) {
        if (cfg.site !== 'all' && a.site !== cfg.site) continue;
        const serial = String(a.serial_number || '').trim(); const prov = hwProviderFor(a.manufacturer);
        if (!prov || !/^[A-Za-z0-9_.-]{3,64}$/.test(serial)) continue;
        if (!getMonitorConfig(prov.key, a.site, a.zone || 'AZ-1')) { skipped++; failures.push({ serial, site: a.site, zone: a.zone, deviceName: a.device_name, error: `${prov.label} is not configured for ${a.site}/${a.zone || 'AZ-1'}`, skipped: true }); continue; }
        targets.push(a);
      }
      hwSyncRunning.total = targets.length;
      let idx = 0;
      const worker = async () => {
        while (idx < targets.length) {
          const a = targets[idx++];
          try { await hwSyncAsset(a, by || 'scheduler'); success++; }
          catch (e) { failures.push({ serial: a.serial_number, site: a.site, zone: a.zone, deviceName: a.device_name, error: String(e.message || e).slice(0, 200) }); }
          hwSyncRunning.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const failed = failures.filter((f) => !f.skipped).length;
      const result = { trigger, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), total: targets.length, success, failed, skipped, failures: failures.slice(0, 500) };
      await jset(HWSYNC_LAST, result);
      const hist = await jget(HWSYNC_HIST, []); hist.unshift({ ...result, failures: undefined }); await jset(HWSYNC_HIST, hist.slice(0, 15));
      log.info(`[hw-sync] ${trigger}: ${success} ok, ${failed} failed, ${skipped} skipped (of ${targets.length + skipped})`);
      return result;
    } finally { hwSyncRunning = null; }
  }
  app.get('/api/ops/hw-sync', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => { const cfg = await hwSyncCfg(); res.json({ config: cfg, last: await jget(HWSYNC_LAST, null), history: await jget(HWSYNC_HIST, []), running: hwSyncRunning, nextRun: nextHwSyncRun(cfg) }); }));
  app.put('/api/ops/hw-sync', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const next = { mode: ['daily', 'weekly'].includes(b.mode) ? b.mode : 'disabled', time: /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '02:30', weekday: Number.isInteger(b.weekday) ? b.weekday : 0, site: b.site || 'all' };
    await jset(HWSYNC_KEY, next); auditLog(req, 'HWSYNC_SCHEDULE', { entity: 'hw-sync', details: next }); res.json({ config: await hwSyncCfg() });
  }));
  app.post('/api/ops/hw-sync/run', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    if (hwSyncRunning) throw httpErr(409, 'A hardware sync is already running.');
    runScheduledHwSync('manual-run', req.user.username).catch((e) => log.warn('[hw-sync] run failed: ' + e.message));
    res.json({ started: true });
  }));
  function nextHwSyncRun(cfg) {
    if (cfg.mode === 'disabled') return null;
    const [h, m] = cfg.time.split(':').map(Number); const now = new Date();
    for (let i = 0; i < 8; i++) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m, 0); if (d > now && (cfg.mode === 'daily' || d.getDay() === cfg.weekday)) return d.toISOString(); }
    return null;
  }
  async function hwSyncTick() {
    try {
      const cfg = await hwSyncCfg(); if (cfg.mode === 'disabled' || hwSyncRunning) return;
      const now = new Date(); const [h, m] = cfg.time.split(':').map(Number);
      const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      const sinceMin = (now - due) / 60000; if (sinceMin < 0 || sinceMin > 30) return;
      if (cfg.mode === 'weekly' && now.getDay() !== cfg.weekday) return;
      const dayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      if ((await getSetting('ops.hwsync.lastDay', '')) === dayKey) return;
      await setSetting('ops.hwsync.lastDay', dayKey);
      await runScheduledHwSync(cfg.mode, 'scheduler');
    } catch (e) { log.warn('[hw-sync] scheduler: ' + e.message); }
  }

  // ============ P3.10  Operational health ============
  async function diskInfo(p) {
    try { const s = await fs.promises.statfs(p); const total = s.blocks * s.bsize; const free = s.bavail * s.bsize; return { path: p, total, free, usedPct: total ? Math.round(((total - free) / total) * 100) : 0 }; } catch (e) { return null; }
  }
  async function healthChecks(live) {
    const checks = []; const add = (key, name, status, detail) => checks.push({ key, name, status, detail });
    const t0 = Date.now(); try { await within(pool.query('SELECT 1'), 5000, 'database'); add('database', 'Database', 'PASS', `responding (${Date.now() - t0} ms)`); } catch (e) { add('database', 'Database', 'FAIL', e.message); }
    add('api', 'API Health', 'PASS', `up ${Math.round(process.uptime() / 60)} min, memory ${fmtBytes(process.memoryUsage().rss)}`);
    const bcfg = await backupConfig().catch(() => null);
    for (const [label, p] of [['App disk', webappDir], ['Backup disk', bcfg && bcfg.dir]]) {
      if (!p) continue; const d = await diskInfo(p);
      if (!d) { add('disk', label, 'WARNING', 'could not read disk usage'); continue; }
      add('disk', label, d.usedPct >= 90 ? 'FAIL' : d.usedPct >= 80 ? 'WARNING' : 'PASS', `${d.usedPct}% used, ${fmtBytes(d.free)} free of ${fmtBytes(d.total)}`);
    }
    // backup
    if (bcfg) {
      const lastRun = await jget('backup.lastRun', null); const lastOk = await getSetting('backup.lastAutoOk', '');
      if (!bcfg.enabled) add('backup', 'Backup', 'WARNING', 'automatic backup is switched off');
      else if (lastRun && lastRun.ok === false) add('backup', 'Backup', 'FAIL', `last backup failed: ${lastRun.error}`);
      else { const age = lastOk ? (Date.now() - new Date(lastOk).getTime()) / 3600000 : Infinity; add('backup', 'Backup', age > 72 ? 'FAIL' : age > 36 ? 'WARNING' : 'PASS', lastOk ? `last automatic backup ${Math.round(age)} h ago` : 'no automatic backup recorded yet'); }
    }
    const rc = await replicaCfg(); const rl = await jget(REPLICA_LAST, null);
    if (rc.enabled) add('replica', 'Backup copy', !rl ? 'WARNING' : rl.ok ? 'PASS' : 'FAIL', !rl ? 'switched on, no copy made yet' : rl.ok ? `last copy ${rl.at} -> ${rl.dir}` : `copy failing since ${rl.failingSince || rl.at}: ${rl.error}`);
    // SMTP (configured only; a live send is never triggered from here)
    const smtp = await jget('integrations.smtp', null);
    add('smtp', 'SMTP', smtp && smtp.host ? 'PASS' : 'WARNING', smtp && smtp.host ? `configured: ${smtp.host}:${smtp.port}` : 'not configured');
    // OME / OneView
    const [zones] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones').catch(() => [[]]);
    for (const [prod, label, getter] of [['OME', 'Dell OME', getOmeToken], ['ONEVIEW', 'HPE OneView', getOneviewSession]]) {
      const cfgd = zones.filter((z) => getMonitorConfig(prod, z.site, z.zone));
      if (!cfgd.length) { add(prod.toLowerCase(), label, 'WARNING', 'not configured'); continue; }
      if (!live) {
        const as = getAutoSyncInfo(); const age = as.lastAutoSyncAt ? (Date.now() - new Date(as.lastAutoSyncAt).getTime()) / 60000 : null;
        add(prod.toLowerCase(), label, age == null ? 'WARNING' : age > 120 ? 'WARNING' : 'PASS', `${cfgd.length} zone(s) configured; last 30-min auto-sync ${age == null ? 'not yet run' : Math.round(age) + ' min ago'}`);
        continue;
      }
      const bad = [];
      for (const z of cfgd) { try { const s = await within(getter(z.site, z.zone), 8000, label); if (!s) bad.push(`${z.site}/${z.zone}`); } catch (e) { bad.push(`${z.site}/${z.zone}: ${e.message}`); } }
      add(prod.toLowerCase(), label, bad.length ? 'FAIL' : 'PASS', bad.length ? `sign-in failed: ${bad.join('; ')}` : `${cfgd.length} zone(s) signed in`);
    }
    // PDU
    try {
      const [p] = await pool.query("SELECT status, COUNT(*) c FROM pdus GROUP BY status"); const by = {}; p.forEach((r) => { by[r.status] = r.c; });
      const total = Object.values(by).reduce((a, b) => a + b, 0);
      if (!total) add('pdu', 'PDU', 'PASS', 'no PDUs recorded');
      else add('pdu', 'PDU', (by.offline || 0) ? 'WARNING' : 'PASS', `${total} PDU feed(s): ${by.online || 0} online, ${by.offline || 0} offline, ${by.warning || 0} warning, ${by.unknown || 0} unknown`);
    } catch (e) { add('pdu', 'PDU', 'PASS', 'PDU module not in use'); }
    const hs = await jget(HWSYNC_LAST, null); const hc = await hwSyncCfg();
    if (hc.mode !== 'disabled') add('hwsync', 'Scheduled H/W sync', hs && hs.failed ? 'WARNING' : 'PASS', hs ? `last run ${hs.finishedAt}: ${hs.success} ok, ${hs.failed} failed` : `${hc.mode}, not run yet`);
    const overall = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'PASS';
    const alerts = checks.filter((c) => c.status !== 'PASS').map((c) => ({ level: c.status === 'FAIL' ? 'alert' : 'warning', key: c.key, name: c.name, message: c.detail }));
    return { overall, checkedAt: new Date().toISOString(), live: !!live, version: APP_VERSION, checks, alerts };
  }
  app.get('/api/ops/health', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => { res.json(await healthChecks(req.query.live === '1')); }));
  app.get('/api/ops/health-settings', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => { const c = await jget('ops.health.notify', {}); res.json({ notify: !!c.enabled, lastNotified: c.lastNotified || null }); }));
  app.put('/api/ops/health-settings', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => { const c = await jget('ops.health.notify', {}); c.enabled = !!(req.body && req.body.notify); await jset('ops.health.notify', c); auditLog(req, 'HEALTH_NOTIFY_SETTING', { entity: 'health', details: { enabled: c.enabled } }); res.json({ notify: c.enabled }); }));
  let lastHealthSig = '';
  async function healthNotifyTick() {
    try {
      const c = await jget('ops.health.notify', {}); if (!c.enabled) return;
      const h = await healthChecks(false); const bad = h.alerts.filter((a) => a.level === 'alert');
      const sig = bad.map((a) => a.key).sort().join(',');
      if (!sig || sig === lastHealthSig) { if (!sig) lastHealthSig = ''; return; }
      if (c.lastNotified && Date.now() - new Date(c.lastNotified).getTime() < 3600000) return;
      lastHealthSig = sig;
      const html = `<p>DCIM health check found ${bad.length} problem(s):</p><ul>${bad.map((a) => `<li><b>${a.name}</b>: ${String(a.message).replace(/[<>&]/g, '')}</li>`).join('')}</ul>`;
      await sendNotification({ subject: `[DCIM] Health alert: ${bad.map((a) => a.name).join(', ')}`, html });
      c.lastNotified = new Date().toISOString(); await jset('ops.health.notify', c);
    } catch (e) { log.warn('[health] notify tick: ' + e.message); }
  }

  // ============ P4.11  opt-in paged asset list ============
  // The existing GET /api/assets is untouched. This is a separate, optional endpoint for large inventories.
  app.get('/api/ops/assets', authenticateToken, wrap(async (req, res) => {
    const allowed = await getAllowedSitesForUser(req.user); const q = req.query;
    const site = q.site && q.site !== 'all' ? String(q.site) : null; if (site && !allowed.includes(site)) throw httpErr(403, 'Access denied for this site');
    const sites = site ? [site] : (allowed.length ? allowed : ['__none__']);
    const where = ['site IN (?)']; const params = [sites];
    for (const [qk, col] of [['zone', 'zone'], ['hardwareType', 'hardware_type'], ['manufacturer', 'manufacturer'], ['rackNo', 'rack_no']]) if (q[qk]) { where.push(`${col} = ?`); params.push(String(q[qk])); }
    if (q.q) { const like = `%${String(q.q).replace(/[%_\\]/g, '\\$&')}%`; where.push('(serial_number LIKE ? OR asset_tag LIKE ? OR device_name LIKE ? OR model LIKE ? OR mgmt_ip LIKE ? OR rack_no LIKE ?)'); params.push(like, like, like, like, like, like); }
    const sortCols = { site: 'site', zone: 'zone', rackNo: 'rack_no', position: 'position', hardwareType: 'hardware_type', manufacturer: 'manufacturer', model: 'model', serialNumber: 'serial_number', deviceName: 'device_name', created: 'created_at' };
    const sort = sortCols[q.sort] || 'site'; const dir = String(q.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 50)); const page = Math.max(1, Number(q.page) || 1);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM assets WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY ${sort} ${dir}, id LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    const body = { total, page, limit, pages: Math.ceil(total / limit), rows: rows.map((r) => ({ id: r.id, site: r.site, zone: r.zone, rackType: r.rack_type, rackNo: r.rack_no, position: r.position, hardwareType: r.hardware_type, height: r.height, manufacturer: r.manufacturer, model: r.model, serialNumber: r.serial_number, assetTag: r.asset_tag, mgmtIp: r.mgmt_ip, firmware: r.firmware, deviceName: r.device_name, remarks: r.remarks || '' })) };
    const etag = `"${crypto.createHash('md5').update(JSON.stringify(body)).digest('hex')}"`;
    res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Authorization' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json(body);
  }));

  // ============ P5.13  Saved views ============
  app.get('/api/ops/views', authenticateToken, wrap(async (req, res) => {
    const screen = String(req.query.screen || 'assets').slice(0, 40); const all = await jget(`user.views.${req.user.id}`, {});
    const s = all[screen] || { views: [], defaultId: null }; res.json(s);
  }));
  app.put('/api/ops/views', authenticateToken, wrap(async (req, res) => {
    const b = req.body || {}; const screen = String(b.screen || 'assets').slice(0, 40);
    if (!Array.isArray(b.views) || b.views.length > 30) throw httpErr(400, 'Up to 30 saved views are allowed.');
    const views = b.views.map((v) => ({ id: String(v.id || crypto.randomBytes(4).toString('hex')).slice(0, 40), name: String(v.name || 'View').trim().slice(0, 60), filters: v.filters && typeof v.filters === 'object' ? v.filters : {}, columns: Array.isArray(v.columns) ? v.columns.map(String).slice(0, 60) : null, sort: v.sort && typeof v.sort === 'object' ? v.sort : null }));
    if (JSON.stringify(views).length > 30000) throw httpErr(400, 'Saved views are too large.');
    const all = await jget(`user.views.${req.user.id}`, {}); all[screen] = { views, defaultId: views.some((v) => v.id === b.defaultId) ? b.defaultId : null };
    await jset(`user.views.${req.user.id}`, all); res.json(all[screen]);
  }));

  // ============ P5.14  QR / barcode ============
  const qrFor = {
    asset: (a) => `DCIM:A:${a.serial_number || a.asset_tag || a.id}`,
    rack: (r) => `DCIM:R:${r.site}|${r.zone}|${r.rack_no}`,
    location: (l) => `DCIM:L:${l.site}`,
  };
  app.get('/api/ops/qr/labels', authenticateToken, wrap(async (req, res) => {
    const allowed = await getAllowedSitesForUser(req.user); const type = ['asset', 'rack', 'location'].includes(req.query.type) ? req.query.type : 'asset';
    const site = req.query.site && req.query.site !== 'all' ? String(req.query.site) : null; if (site && !allowed.includes(site)) throw httpErr(403, 'Access denied for this site');
    const sites = site ? [site] : (allowed.length ? allowed : ['__none__']);
    let labels = [];
    if (type === 'asset') { const [r] = await pool.query('SELECT id, site, zone, rack_no, position, serial_number, asset_tag, device_name, model FROM assets WHERE site IN (?) ORDER BY site, zone, rack_no, position LIMIT 5000', [sites]); labels = r.map((a) => ({ code: qrFor.asset(a), title: a.device_name || a.model || a.serial_number, line2: a.serial_number, line3: `${a.site} / ${a.zone} / ${a.rack_no || '-'} U${a.position || '-'}` })); }
    else if (type === 'rack') { const [r] = await pool.query('SELECT DISTINCT site, zone, rack_no FROM assets WHERE site IN (?) AND rack_no IS NOT NULL AND rack_no <> "" ORDER BY site, zone, rack_no LIMIT 5000', [sites]); labels = r.map((a) => ({ code: qrFor.rack(a), title: `Rack ${a.rack_no}`, line2: `${a.site} / ${a.zone}`, line3: '' })); }
    else { labels = sites.filter((s) => s !== '__none__').map((s) => ({ code: qrFor.location({ site: s }), title: s, line2: 'Location', line3: '' })); }
    res.json({ type, count: labels.length, labels });
  }));
  // Resolve a scanned/typed code to an existing inventory record. Accepts DCIM: payloads and plain serial / asset tag.
  app.get('/api/ops/qr/resolve', authenticateToken, wrap(async (req, res) => {
    const allowed = await getAllowedSitesForUser(req.user); const code = String(req.query.code || '').trim().slice(0, 200); if (!code) throw httpErr(400, 'No code given.');
    const m = /^DCIM:([ARL]):(.+)$/.exec(code);
    if (m && m[1] === 'L') { const s = m[2]; return allowed.includes(s) ? res.json({ type: 'location', site: s }) : res.status(404).json({ error: 'Not found' }); }
    if (m && m[1] === 'R') { const [site, zone, rack] = m[2].split('|'); if (!allowed.includes(site)) return res.status(404).json({ error: 'Not found' }); const [r] = await pool.query('SELECT id, hardware_type, device_name, serial_number, position FROM assets WHERE site = ? AND zone = ? AND rack_no = ? ORDER BY position', [site, zone, rack]); return res.json({ type: 'rack', site, zone, rackNo: rack, assets: r.map((a) => ({ id: a.id, hardwareType: a.hardware_type, deviceName: a.device_name, serialNumber: a.serial_number, position: a.position })) }); }
    const key = m ? m[2] : code;
    const [r] = await pool.query('SELECT id, site, zone, rack_no, position, hardware_type, manufacturer, model, serial_number, asset_tag, device_name FROM assets WHERE (serial_number = ? OR asset_tag = ?) LIMIT 2', [key, key]);
    const hit = r.find((a) => allowed.includes(a.site)); if (!hit) return res.status(404).json({ error: 'No asset with that serial number or asset tag.' });
    res.json({ type: 'asset', asset: { id: hit.id, site: hit.site, zone: hit.zone, rackNo: hit.rack_no, position: hit.position, hardwareType: hit.hardware_type, manufacturer: hit.manufacturer, model: hit.model, serialNumber: hit.serial_number, assetTag: hit.asset_tag, deviceName: hit.device_name } });
  }));

  function startSchedulers() {
    setInterval(hwSyncTick, 60000).unref();
    setInterval(healthNotifyTick, 15 * 60000).unref();
  }

  return { afterBackup, startSchedulers, replicateBackup, securityChecks, healthChecks, buildDataQuality, runScheduledHwSync };
};
