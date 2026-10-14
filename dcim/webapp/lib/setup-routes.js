// Additive routes for the DCIM packaging roadmap's Phase 2 (first-run config),
// Phase 3 (Dell OME / HPE OneView / SMTP wizard), Phase 4 (default catalog
// seeding), Phase 5 (deep health check), Phase 9 (deployment dashboard), and
// the recommended Config Export/Import wizard.
//
// Deliberately kept in its own module and wired into server.js with a single
// require + register call, instead of editing the existing route logic in
// place, so none of the app's current behavior is touched.
'use strict';
const crypto = require('crypto');
const { testSmtp } = require('./smtp-client');

const ORG_KEYS = ['companyName', 'appName', 'footerText', 'supportEmail', 'supportContact', 'logoPath'];
const MONITORING_SETTING_KEY = 'integrations.monitoring';
const SMTP_SETTING_KEY = 'integrations.smtp';
const SETUP_COMPLETE_KEY = 'setup.completedAt';

const DEFAULT_HARDWARE_TYPES = ['Dell Server', 'HPE Server', 'Storage', 'Switch', 'Firewall', 'Load Balancer', 'HSM', 'PDU', 'ATS', 'Others'];
const DEFAULT_RACK_TYPES = ['Compute', 'Storage', 'Network', 'Backup', 'Management', 'Custom'];

function deriveKey(secret) {
  return crypto.scryptSync(String(secret || 'dcim-dev-secret'), 'dcim-setup-wizard-v1', 32);
}
function encryptSecret(secret, plaintext) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(secret, blob) {
  if (!blob) return '';
  try {
    const key = deriveKey(secret);
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return ''; // encrypted under a different JWT_SECRET (e.g. restored on another server) - treat as not set
  }
}

module.exports = function registerSetupRoutes(app, deps) {
  const {
    pool, fs, path, multer, log, httpErr, sendErr,
    authenticateToken, requireGlobalAdmin,
    getSetting, setSetting, genId, normalizeHardwareType,
    APP_VERSION, JWT_SECRET, DB_NAME, testConnection,
    getOmeToken, getOneviewSession, monitorEnvKey,
    validateBackupDir, backupConfig, ocrEngine, webappDir,
  } = deps;

  // The app serves every root-level static file through its own explicit
  // route (no generic express.static(__dirname)) - these two need the same.
  app.get('/setup-wizard.html', (req, res) => res.sendFile(path.join(webappDir, 'setup-wizard.html')));
  app.get('/deployment-dashboard.html', (req, res) => res.sendFile(path.join(webappDir, 'deployment-dashboard.html')));

  // ---------- organization / branding ----------

  async function readOrgSettings() {
    const out = {};
    for (const k of ORG_KEYS) out[k] = await getSetting(`org.${k}`, '');
    return out;
  }

  app.get('/api/setup/status', async (req, res) => {
    try {
      const org = await readOrgSettings();
      const completedAt = await getSetting(SETUP_COMPLETE_KEY, '');
      res.json({
        setupComplete: !!completedAt,
        companyName: org.companyName || 'DCIM Dashboard',
        appName: org.appName || 'DCIM Dashboard',
        logoUrl: org.logoPath || '',
      });
    } catch (e) { sendErr(res, e); }
  });

  app.get('/api/setup/organization', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try { res.json(await readOrgSettings()); } catch (e) { sendErr(res, e); }
  });

  app.put('/api/setup/organization', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      for (const k of ['companyName', 'appName', 'footerText', 'supportEmail', 'supportContact']) {
        if (body[k] !== undefined) await setSetting(`org.${k}`, String(body[k]).slice(0, 500));
      }
      if (!(await getSetting(SETUP_COMPLETE_KEY, ''))) await setSetting(SETUP_COMPLETE_KEY, new Date().toISOString());
      res.json(await readOrgSettings());
    } catch (e) { sendErr(res, e); }
  });

  const brandingDir = path.join(webappDir, 'uploads', 'branding');
  fs.mkdirSync(brandingDir, { recursive: true });
  app.use('/branding', require('express').static(brandingDir, { dotfiles: 'deny', index: false, maxAge: '1h' }));
  const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|svg\+xml|x-icon)$/.test(file.mimetype)),
  });
  app.post('/api/setup/logo', authenticateToken, requireGlobalAdmin, logoUpload.single('logo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Upload a PNG, JPEG, or SVG logo (max 2MB).' });
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' }[req.file.mimetype] || 'png';
      for (const old of fs.readdirSync(brandingDir)) { if (/^logo\./.test(old)) fs.unlinkSync(path.join(brandingDir, old)); }
      const fname = `logo.${ext}`;
      fs.writeFileSync(path.join(brandingDir, fname), req.file.buffer);
      await setSetting('org.logoPath', `/branding/${fname}`);
      res.json({ logoUrl: `/branding/${fname}` });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- Dell OME / HPE OneView / SMTP (infra wizard) ----------

  async function readMonitoringEntries() {
    const raw = await getSetting(MONITORING_SETTING_KEY, '[]');
    try { return JSON.parse(raw); } catch (e) { return []; }
  }
  async function readSmtpSettings() {
    const raw = await getSetting(SMTP_SETTING_KEY, 'null');
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // Applies saved (encrypted) integration settings into process.env, in the
  // exact OME_<SITE>_<ZONE>_HOST/_USER/_PASS shape the existing monitoring
  // code already reads, so nothing else in server.js has to change. A value
  // already set via the real .env always wins - the wizard only fills gaps.
  async function applyIntegrationEnv() {
    try {
      const entries = await readMonitoringEntries();
      for (const e of entries) {
        const key = monitorEnvKey(e.product, e.site, e.zone);
        if (!process.env[`${key}_HOST`]) process.env[`${key}_HOST`] = e.host;
        if (!process.env[`${key}_USER`]) process.env[`${key}_USER`] = e.user;
        if (!process.env[`${key}_PASS`] && e.passEnc) process.env[`${key}_PASS`] = decryptSecret(JWT_SECRET, e.passEnc);
      }
    } catch (e) { log.warn('[setup] failed to apply saved integration settings: ' + e.message); }
  }

  app.get('/api/settings/integrations', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const entries = (await readMonitoringEntries()).map((e) => ({ product: e.product, site: e.site, zone: e.zone, host: e.host, user: e.user, hasPassword: !!e.passEnc }));
      const smtp = await readSmtpSettings();
      res.json({
        monitoring: entries,
        smtp: smtp ? { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, fromAddress: smtp.fromAddress, hasPassword: !!smtp.passEnc } : null,
      });
    } catch (e) { sendErr(res, e); }
  });

  app.put('/api/settings/integrations', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      if (Array.isArray(body.monitoring)) {
        const existing = await readMonitoringEntries();
        const next = body.monitoring.map((e) => {
          if (!e.product || !['OME', 'ONEVIEW'].includes(String(e.product).toUpperCase())) throw httpErr(400, 'product must be OME or ONEVIEW');
          if (!e.site || !e.zone || !e.host || !e.user) throw httpErr(400, 'site, zone, host, and user are required for each entry');
          const product = String(e.product).toUpperCase();
          const prior = existing.find((x) => x.product === product && x.site === e.site && x.zone === e.zone);
          const passEnc = e.password ? encryptSecret(JWT_SECRET, e.password) : (prior ? prior.passEnc : undefined);
          return { product, site: String(e.site), zone: String(e.zone), host: String(e.host).replace(/\/$/, ''), user: String(e.user), passEnc };
        });
        await setSetting(MONITORING_SETTING_KEY, JSON.stringify(next));
      }
      if (body.smtp !== undefined) {
        if (body.smtp === null) {
          await setSetting(SMTP_SETTING_KEY, 'null');
        } else {
          const s = body.smtp;
          if (!s.host || !s.port) throw httpErr(400, 'SMTP host and port are required');
          const prior = await readSmtpSettings();
          const passEnc = s.password ? encryptSecret(JWT_SECRET, s.password) : (prior ? prior.passEnc : undefined);
          await setSetting(SMTP_SETTING_KEY, JSON.stringify({ host: String(s.host), port: Number(s.port), secure: !!s.secure, user: s.user || '', fromAddress: s.fromAddress || s.user || '', passEnc }));
        }
      }
      await applyIntegrationEnv();
      res.json({ success: true });
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/settings/integrations/test', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      await applyIntegrationEnv();
      if (body.kind === 'smtp') {
        const smtp = await readSmtpSettings();
        if (!smtp) throw httpErr(400, 'SMTP is not configured yet.');
        const result = await testSmtp({
          host: smtp.host, port: smtp.port, secure: smtp.secure,
          user: smtp.user, pass: decryptSecret(JWT_SECRET, smtp.passEnc),
          fromAddress: smtp.fromAddress, toAddress: body.to || smtp.fromAddress,
        });
        return res.json(result);
      }
      const product = String(body.product || '').toUpperCase();
      if (!['OME', 'ONEVIEW'].includes(product)) throw httpErr(400, 'product must be OME, ONEVIEW, or kind "smtp"');
      if (!body.site || !body.zone) throw httpErr(400, 'site and zone are required');
      const session = product === 'OME' ? await getOmeToken(body.site, body.zone) : await getOneviewSession(body.site, body.zone);
      if (!session) throw httpErr(400, `${product} is not configured for ${body.site} / ${body.zone}`);
      res.json({ ok: true, host: session.host });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- default catalog seeding ----------

  app.post('/api/setup/seed-defaults', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const created = { hardwareTypes: [], rackTypes: [] };
      for (const name of DEFAULT_HARDWARE_TYPES) {
        const info = {};
        const canonical = await normalizeHardwareType(pool, name, req.user.name || req.user.username, info);
        if (info.created) created.hardwareTypes.push(canonical);
      }
      for (const name of DEFAULT_RACK_TYPES) {
        try {
          await pool.query('INSERT INTO rack_types (id, name, created_by) VALUES (?,?,?)', [genId('RT'), name, req.user.name || req.user.username]);
          created.rackTypes.push(name);
        } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
      }
      res.json(created);
    } catch (e) { sendErr(res, e); }
  });

  // ---------- deep health check ----------

  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);

  app.get('/api/health/full', authenticateToken, requireGlobalAdmin, async (req, res) => {
    const checks = {};
    try { await withTimeout(pool.query('SELECT 1'), 5000, 'db read'); checks.dbRead = { ok: true }; }
    catch (e) { checks.dbRead = { ok: false, error: e.message }; }

    try {
      await withTimeout(setSetting('health.probe', String(Date.now())), 5000, 'db write');
      await withTimeout(getSetting('health.probe', ''), 5000, 'db read-back');
      checks.dbWrite = { ok: true };
    } catch (e) { checks.dbWrite = { ok: false, error: e.message }; }

    checks.ocr = { ok: !!ocrEngine, error: ocrEngine ? undefined : 'OCR engine not loaded' };

    try {
      const cfg = await backupConfig();
      await withTimeout(validateBackupDir(cfg.dir), 8000, 'backup folder check');
      checks.backup = { ok: true, dir: cfg.dir, enabled: cfg.enabled };
    } catch (e) { checks.backup = { ok: false, error: e.message }; }

    try {
      await applyIntegrationEnv();
      const entries = await readMonitoringEntries();
      const results = [];
      for (const e of entries) {
        try {
          const session = e.product === 'OME' ? await withTimeout(getOmeToken(e.site, e.zone), 8000, 'OME check') : await withTimeout(getOneviewSession(e.site, e.zone), 8000, 'OneView check');
          results.push({ product: e.product, site: e.site, zone: e.zone, ok: !!session });
        } catch (err) { results.push({ product: e.product, site: e.site, zone: e.zone, ok: false, error: err.message }); }
      }
      checks.monitoring = { ok: results.every((r) => r.ok), zones: results };
    } catch (e) { checks.monitoring = { ok: false, error: e.message }; }

    const smtp = await readSmtpSettings().catch(() => null);
    checks.smtp = { ok: !!smtp, configured: !!smtp };

    const overallOk = Object.values(checks).every((c) => c.ok !== false);
    res.status(overallOk ? 200 : 503).json({ status: overallOk ? 'ok' : 'degraded', version: APP_VERSION, checks });
  });

  // ---------- deployment dashboard ----------

  app.get('/api/deployment/status', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const dbOk = await testConnection().catch(() => false);
      const entries = await readMonitoringEntries();
      const smtp = await readSmtpSettings();
      const cfg = await backupConfig();
      let lastBackup = null;
      try { lastBackup = JSON.parse(await getSetting('backup.lastResult', 'null')); } catch (e) { /* ignore */ }
      res.json({
        version: APP_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        database: { ok: dbOk, name: DB_NAME },
        ocr: { ok: !!ocrEngine },
        monitoring: { omeZones: entries.filter((e) => e.product === 'OME').length, oneviewZones: entries.filter((e) => e.product === 'ONEVIEW').length },
        smtp: { configured: !!smtp },
        backup: { enabled: cfg.enabled, dir: cfg.dir, last: lastBackup },
        appUrl: `${req.protocol}://${req.get('host')}`,
      });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- configuration export / import (DR / UAT-to-prod / rollouts) ----------

  app.get('/api/setup/export', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const [[locations], [zones], [hardwareTypes], [rackTypes]] = await Promise.all([
        pool.query('SELECT id, name FROM locations'),
        pool.query('SELECT id, site, zone_name FROM zones'),
        pool.query('SELECT id, name, category, default_height FROM hardware_types'),
        pool.query('SELECT id, name FROM rack_types'),
      ]);
      const monitoring = (await readMonitoringEntries()).map((e) => ({ product: e.product, site: e.site, zone: e.zone, host: e.host, user: e.user })); // credentials never leave the server
      const smtp = await readSmtpSettings();
      const bundle = {
        format: 'dcim-config-bundle', version: 1, exportedAt: new Date().toISOString(), exportedBy: req.user.name || req.user.username, appVersion: APP_VERSION,
        organization: await readOrgSettings(),
        locations, zones, hardwareTypes, rackTypes,
        monitoring,
        smtp: smtp ? { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, fromAddress: smtp.fromAddress } : null,
        backup: await backupConfig(),
      };
      res.setHeader('Content-Disposition', `attachment; filename="dcim-config-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(bundle);
    } catch (e) { sendErr(res, e); }
  });

  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  app.post('/api/setup/import', authenticateToken, requireGlobalAdmin, importUpload.single('bundle'), async (req, res) => {
    try {
      const raw = req.file ? req.file.buffer.toString('utf8') : JSON.stringify(req.body);
      let bundle;
      try { bundle = JSON.parse(raw); } catch (e) { throw httpErr(400, 'Not a valid JSON configuration bundle.'); }
      if (bundle.format !== 'dcim-config-bundle') throw httpErr(400, 'Unrecognized bundle format.');
      const summary = { locations: 0, zones: 0, hardwareTypes: 0, rackTypes: 0, monitoring: 0 };

      if (bundle.organization) {
        for (const k of ['companyName', 'appName', 'footerText', 'supportEmail', 'supportContact']) {
          if (bundle.organization[k]) await setSetting(`org.${k}`, String(bundle.organization[k]).slice(0, 500));
        }
      }
      for (const loc of bundle.locations || []) {
        try { await pool.query('INSERT INTO locations (id, name, created_by) VALUES (?,?,?)', [loc.id || genId('LOC'), loc.name, req.user.name]); summary.locations++; } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
      }
      for (const z of bundle.zones || []) {
        try { await pool.query('INSERT INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [z.id || genId('ZN'), z.site, z.zone_name, req.user.name]); summary.zones++; } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
      }
      for (const ht of bundle.hardwareTypes || []) {
        const info = {};
        const canonical = await normalizeHardwareType(pool, ht.name, req.user.name, info);
        if (info.created) {
          if (ht.category || ht.default_height) await pool.query('UPDATE hardware_types SET category = COALESCE(?, category), default_height = COALESCE(?, default_height) WHERE id = ?', [ht.category || null, ht.default_height || null, info.id]);
          summary.hardwareTypes++;
        }
      }
      for (const rt of bundle.rackTypes || []) {
        try { await pool.query('INSERT INTO rack_types (id, name, created_by) VALUES (?,?,?)', [rt.id || genId('RT'), rt.name, req.user.name]); summary.rackTypes++; } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
      }
      if (Array.isArray(bundle.monitoring) && bundle.monitoring.length) {
        const existing = await readMonitoringEntries();
        const next = existing.slice();
        for (const m of bundle.monitoring) {
          if (!next.find((x) => x.product === m.product && x.site === m.site && x.zone === m.zone)) {
            next.push({ product: m.product, site: m.site, zone: m.zone, host: m.host, user: m.user }); // no password: admin must enter it via the wizard
            summary.monitoring++;
          }
        }
        await setSetting(MONITORING_SETTING_KEY, JSON.stringify(next));
      }

      res.json({ success: true, imported: summary, note: summary.monitoring ? 'Imported monitoring entries have no password - add credentials in the Infrastructure wizard before testing them.' : undefined });
    } catch (e) { sendErr(res, e); }
  });

  // Not called here: `pool` isn't connected yet at require/register time.
  // The caller invokes applyIntegrationEnv() once the database is up.
  return { applyIntegrationEnv };
};
