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
const os = require('os');
const { execFile } = require('child_process');
const mysql = require('mysql2/promise');
const { testSmtp } = require('./smtp-client');
const { buildZip } = require('./zip-writer');

const ORG_KEYS = ['companyName', 'appName', 'department', 'orgUnit', 'footerText', 'supportEmail', 'supportContact', 'logoPath', 'faviconPath'];
const ORG_EDITABLE_KEYS = ['companyName', 'appName', 'department', 'orgUnit', 'footerText', 'supportEmail', 'supportContact'];
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
    pool, fs, path, multer, log, httpErr, sendErr, bcrypt,
    authenticateToken, requireGlobalAdmin,
    getSetting, setSetting, genId, normalizeHardwareType,
    APP_VERSION, JWT_SECRET, DB_NAME, DB_CONFIG, testConnection,
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
        faviconUrl: org.faviconPath || '',
      });
    } catch (e) { sendErr(res, e); }
  });

  app.get('/api/setup/organization', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try { res.json(await readOrgSettings()); } catch (e) { sendErr(res, e); }
  });

  app.put('/api/setup/organization', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      for (const k of ORG_EDITABLE_KEYS) {
        if (body[k] !== undefined) await setSetting(`org.${k}`, String(body[k]).slice(0, 500));
      }
      if (!(await getSetting(SETUP_COMPLETE_KEY, ''))) await setSetting(SETUP_COMPLETE_KEY, new Date().toISOString());
      res.json(await readOrgSettings());
    } catch (e) { sendErr(res, e); }
  });

  // Lets the installer (or an Admin, post-install) replace the seeded default
  // admin/admin credentials with a chosen username/password, in one call, as
  // part of first-run setup. Only ever touches the CALLER'S OWN account (never
  // another user's) - it is a thin wrapper around the exact same users-table
  // update the existing change-password endpoint already does, so the
  // must_change_password / password_changed_at bookkeeping behaves identically:
  // a deliberately-chosen password here is not flagged for a forced change,
  // while leaving the password at its default still gets caught by the
  // existing flagDefaultPasswordAccounts() check, unchanged.
  app.post('/api/setup/admin-account', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const { newUsername, newPassword } = req.body || {};
      if (!newUsername && !newPassword) return res.status(400).json({ error: 'Provide newUsername and/or newPassword.' });
      if (newUsername !== undefined) {
        const uname = String(newUsername).trim();
        if (!/^[A-Za-z0-9._-]{3,50}$/.test(uname)) return res.status(400).json({ error: 'Username must be 3-50 characters: letters, numbers, dot, underscore, or hyphen.' });
        try {
          await pool.query('UPDATE users SET username = ? WHERE id = ?', [uname, req.user.id]);
        } catch (e) {
          if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Username "${uname}" is already taken.` });
          throw e;
        }
      }
      if (newPassword !== undefined) {
        if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = NOW() WHERE id = ?', [hash, req.user.id]);
      }
      res.json({ success: true });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- database (view current connection + test candidate credentials) ----------
  // Deliberately does NOT change the live connection: DB_HOST/PORT/NAME/USER/PASSWORD are
  // only ever read once at process startup from .env (see DB_CONFIG in server.js), and
  // switching them live would mean tearing down and recreating `pool` while requests may
  // be in flight -- out of scope for a packaging fix. This gives the wizard a way to
  // view what's currently connected and test new credentials BEFORE an admin edits .env
  // and restarts (via the installer's --db-* flags or by hand), catching typos early.
  app.get('/api/setup/database', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      res.json({ host: DB_CONFIG.host, port: DB_CONFIG.port, name: DB_NAME, user: DB_CONFIG.user, connected: !!(await testConnection().catch(() => false)) });
    } catch (e) { sendErr(res, e); }
  });
  app.post('/api/setup/database/test', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const { host, port, name, user, password } = req.body || {};
      if (!host || !user) throw httpErr(400, 'Host and username are required.');
      let conn;
      try {
        conn = await mysql.createConnection({ host: String(host), port: Number(port) || 3306, user: String(user), password: password || '', connectTimeout: 8000 });
        if (name) await conn.query(`USE \`${String(name).replace(/`/g, '')}\``);
        await conn.query('SELECT 1');
      } finally {
        if (conn) await conn.end().catch(() => {});
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ---------- security (JWT secret / CSP mode / audit retention) ----------
  // JWT_SECRET, CSP_MODE, and AUDIT_RETENTION_DAYS are all read ONCE from .env at process
  // startup by the existing (untouched) security code in server.js - rotating JWT_SECRET
  // live would invalidate every signed-in session instantly and mid-request, and CSP_MODE /
  // AUDIT_RETENTION_DAYS are consts closed over by code that runs once at startup. Changing
  // any of them safely means writing the new value to .env and restarting the service - the
  // exact same "edit .env, then restart" pattern the Database tab above already uses, not a
  // live override. Backup Retention is the one exception: it's already DB-backed (Phase 3/7)
  // and takes effect immediately via the existing /api/backup/settings endpoint.
  const envPath = path.join(webappDir, '.env');
  function readEnvRaw() { try { return fs.readFileSync(envPath, 'utf8'); } catch (e) { return ''; } }
  function readEnvVar(key) { const m = readEnvRaw().match(new RegExp(`^${key}=(.*)$`, 'm')); return m ? m[1] : ''; }
  function writeEnvVar(key, value) {
    const raw = readEnvRaw();
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    const next = re.test(raw) ? raw.replace(re, line) : (raw && !raw.endsWith('\n') ? raw + '\n' : raw) + line + '\n';
    fs.writeFileSync(envPath, next, { mode: 0o600 });
  }

  app.get('/api/setup/security', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const cfg = await backupConfig();
      res.json({
        cspMode: readEnvVar('CSP_MODE') || 'report-only',
        auditRetentionDays: readEnvVar('AUDIT_RETENTION_DAYS') || '365',
        jwtSecretConfigured: !!readEnvVar('JWT_SECRET'),
        backupRetentionDays: cfg.retentionDays,
      });
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/setup/security/generate-jwt-secret', authenticateToken, requireGlobalAdmin, (req, res) => {
    res.json({ secret: crypto.randomBytes(32).toString('hex') });
  });

  app.put('/api/setup/security', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const { cspMode, auditRetentionDays, jwtSecret } = req.body || {};
      const changed = [];
      if (cspMode !== undefined) {
        if (!['enforce', 'report-only', 'off'].includes(cspMode)) throw httpErr(400, 'cspMode must be enforce, report-only, or off.');
        writeEnvVar('CSP_MODE', cspMode); changed.push('CSP_MODE');
      }
      if (auditRetentionDays !== undefined) {
        const n = Number(auditRetentionDays);
        if (!Number.isFinite(n) || n < 0 || n > 3650 || Math.round(n) !== n) throw httpErr(400, 'auditRetentionDays must be a whole number of days from 0 (keep forever) to 3650.');
        writeEnvVar('AUDIT_RETENTION_DAYS', String(n)); changed.push('AUDIT_RETENTION_DAYS');
      }
      if (jwtSecret !== undefined) {
        const s = String(jwtSecret);
        if (s.length < 32) throw httpErr(400, 'jwtSecret must be at least 32 characters. Use Generate Secure Default for a safe value.');
        if (/[\r\n]/.test(s)) throw httpErr(400, 'jwtSecret cannot contain newlines.');
        writeEnvVar('JWT_SECRET', s); changed.push('JWT_SECRET');
      }
      res.json({ success: true, changed, requiresRestart: changed.length > 0 });
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

  const faviconUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(x-icon|vnd\.microsoft\.icon|png)$/.test(file.mimetype)),
  });
  const FAVICON_MIME = { ico: 'image/x-icon', png: 'image/png' };
  app.post('/api/setup/favicon', authenticateToken, requireGlobalAdmin, faviconUpload.single('favicon'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Upload a .ico or .png favicon (max 512KB).' });
      const ext = /png/.test(req.file.mimetype) ? 'png' : 'ico';
      for (const old of fs.readdirSync(brandingDir)) { if (/^favicon\./.test(old)) fs.unlinkSync(path.join(brandingDir, old)); }
      const fname = `favicon.${ext}`;
      fs.writeFileSync(path.join(brandingDir, fname), req.file.buffer);
      await setSetting('org.faviconPath', `/branding/${fname}`);
      res.json({ faviconUrl: `/branding/${fname}` });
    } catch (e) { sendErr(res, e); }
  });
  // Browsers request /favicon.ico by convention regardless of any <link> tag in
  // index.html, so this makes an uploaded favicon appear without touching the
  // compiled frontend at all. No upload yet -> 404, same as if the file never existed.
  app.get('/favicon.ico', async (req, res) => {
    try {
      const faviconPath = await getSetting('org.faviconPath', '');
      if (!faviconPath) return res.status(404).end();
      const ext = faviconPath.slice(faviconPath.lastIndexOf('.') + 1);
      const full = path.join(brandingDir, `favicon.${ext}`);
      if (!fs.existsSync(full)) return res.status(404).end();
      res.set('Content-Type', FAVICON_MIME[ext] || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(full).pipe(res);
    } catch (e) { res.status(404).end(); }
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

  // ---------- structured health validation (PASS/WARNING/FAIL) ----------
  // Separate from /api/health/full above (kept untouched - it's already relied
  // on) rather than refactored to share code with it, so this new report can't
  // regress that existing endpoint. Run automatically by install.sh/install.ps1
  // immediately after install/upgrade/repair, and shown in the deployment
  // dashboard.

  async function checkUploadEngine() {
    const uploadsDir = path.join(webappDir, 'uploads');
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
      const probe = path.join(uploadsDir, `.health-probe-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return { name: 'Upload Engine', status: 'PASS', detail: uploadsDir };
    } catch (e) {
      return { name: 'Upload Engine', status: 'FAIL', detail: e.message };
    }
  }

  async function checkBackupEngine() {
    try {
      const cfg = await backupConfig();
      await withTimeout(validateBackupDir(cfg.dir), 8000, 'backup folder check');
      if (!cfg.enabled) return { name: 'Backup Engine', status: 'WARNING', detail: 'Backup is disabled.' };
      let lastBackup = null;
      try { lastBackup = JSON.parse(await getSetting('backup.lastResult', 'null')); } catch (e) { /* ignore */ }
      if (lastBackup && lastBackup.ok === false) return { name: 'Backup Engine', status: 'WARNING', detail: `Last backup run failed: ${lastBackup.error || 'unknown error'}` };
      return { name: 'Backup Engine', status: 'PASS', detail: cfg.dir };
    } catch (e) {
      return { name: 'Backup Engine', status: 'FAIL', detail: e.message };
    }
  }

  async function checkMonitoringProduct(product) {
    const entries = (await readMonitoringEntries()).filter((e) => e.product === product);
    if (!entries.length) return { name: product === 'OME' ? 'Dell OME' : 'HPE OneView', status: 'WARNING', detail: 'Not configured.' };
    const results = [];
    for (const e of entries) {
      try {
        const session = product === 'OME' ? await withTimeout(getOmeToken(e.site, e.zone), 8000, 'OME check') : await withTimeout(getOneviewSession(e.site, e.zone), 8000, 'OneView check');
        results.push({ site: e.site, zone: e.zone, ok: !!session });
      } catch (err) { results.push({ site: e.site, zone: e.zone, ok: false, error: err.message }); }
    }
    const allOk = results.every((r) => r.ok);
    return { name: product === 'OME' ? 'Dell OME' : 'HPE OneView', status: allOk ? 'PASS' : 'FAIL', detail: results.map((r) => `${r.site}/${r.zone}: ${r.ok ? 'ok' : r.error || 'failed'}`).join('; ') };
  }

  async function runHealthValidation() {
    const checks = [];
    checks.push({ name: 'Service', status: 'PASS', detail: `up ${Math.round(process.uptime())}s, node ${process.version}` });

    try {
      await withTimeout(pool.query('SELECT 1'), 5000, 'db check');
      checks.push({ name: 'Database', status: 'PASS', detail: `${DB_NAME}@${DB_CONFIG.host}:${DB_CONFIG.port}` });
    } catch (e) {
      checks.push({ name: 'Database', status: 'FAIL', detail: e.message });
    }

    checks.push(ocrEngine
      ? { name: 'OCR', status: 'PASS', detail: 'engine loaded' }
      : { name: 'OCR', status: 'WARNING', detail: 'OCR engine not loaded (OCR features unavailable).' });

    checks.push({ name: 'API Health', status: 'PASS', detail: 'responding' });

    checks.push(APP_VERSION
      ? { name: 'Version Endpoint', status: 'PASS', detail: APP_VERSION }
      : { name: 'Version Endpoint', status: 'WARNING', detail: 'APP_VERSION is not set.' });

    checks.push(await checkUploadEngine());
    checks.push(await checkBackupEngine());

    const smtp = await readSmtpSettings().catch(() => null);
    checks.push(smtp
      ? { name: 'SMTP', status: 'PASS', detail: `${smtp.host}:${smtp.port}` }
      : { name: 'SMTP', status: 'WARNING', detail: 'Not configured.' });

    checks.push(await checkMonitoringProduct('OME'));
    checks.push(await checkMonitoringProduct('ONEVIEW'));

    const overall = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'PASS';
    return { overall, checkedAt: new Date().toISOString(), version: APP_VERSION, checks };
  }

  app.get('/api/health/validate', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const report = await runHealthValidation();
      res.status(report.overall === 'FAIL' ? 503 : 200).json(report);
    } catch (e) { sendErr(res, e); }
  });

  // ---------- support bundle (for troubleshooting) ----------

  function execFilePromise(cmd, args, opts) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stderr }));
        resolve(stdout);
      });
    });
  }

  function redactEnv() {
    try {
      return fs.readFileSync(path.join(webappDir, '.env'), 'utf8').replace(/^(.*(PASSWORD|SECRET).*)=.*/gim, '$1=[redacted]');
    } catch (e) { return `(.env not readable: ${e.message})`; }
  }

  async function collectLogs() {
    if (process.platform === 'win32') {
      const out = {};
      for (const f of ['service-stdout.log', 'service-stderr.log']) {
        try { out[f] = fs.readFileSync(path.join(webappDir, 'logs', f), 'utf8').split(/\r?\n/).slice(-500).join('\n'); }
        catch (e) { out[f] = `(not available: ${e.message})`; }
      }
      return out;
    }
    try {
      const out = await execFilePromise('journalctl', ['-u', 'dcim', '-n', '500', '--no-pager'], { timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
      return { 'journalctl-dcim.log': out };
    } catch (e) {
      return { 'journalctl-dcim.log': `(not available from inside the running process - this usually needs root/systemd-journal group access. Run on the server: sudo journalctl -u dcim -n 500. Error: ${e.message})` };
    }
  }

  function performanceSnapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.round(process.uptime()),
      cpuUsage: process.cpuUsage(),
      memory: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external },
      os: { platform: os.platform(), release: os.release(), arch: os.arch(), totalMemMB: Math.round(os.totalmem() / 1048576), freeMemMB: Math.round(os.freemem() / 1048576), loadavg: os.loadavg() },
    };
  }

  app.post('/api/support/bundle', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const [health, logs] = await Promise.all([runHealthValidation().catch((e) => ({ overall: 'FAIL', error: e.message })), collectLogs()]);
      const systemInfo = {
        generatedAt: new Date().toISOString(),
        generatedBy: req.user.name || req.user.username,
        appVersion: APP_VERSION,
        nodeVersion: process.version,
        platform: os.platform(),
        hostname: os.hostname(),
      };
      const entries = [
        { name: 'system-info.json', data: Buffer.from(JSON.stringify(systemInfo, null, 2)) },
        { name: 'health-report.json', data: Buffer.from(JSON.stringify(health, null, 2)) },
        { name: 'performance-report.json', data: Buffer.from(JSON.stringify(performanceSnapshot(), null, 2)) },
        { name: 'env-redacted.txt', data: Buffer.from(redactEnv()) },
      ];
      for (const [fname, content] of Object.entries(logs)) {
        entries.push({ name: `logs/${fname}`, data: Buffer.from(content) });
      }
      const zip = buildZip(entries);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="dcim-support-bundle-${stamp}.zip"`);
      res.send(zip);
    } catch (e) { sendErr(res, e); }
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

  async function buildExportBundle(req) {
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
    // Security settings are opt-in and separate from the rest of the bundle: CSP mode and
    // audit retention aren't secret, but the JWT secret is, and it needs to be decryptable
    // on a DIFFERENT server (that's the point of exporting it for DR/UAT-to-prod) - so unlike
    // the OME/OneView passwords above, it can't be encrypted under THIS server's own
    // JWT_SECRET (that would make it undecryptable anywhere else by definition). It's
    // encrypted under an admin-supplied passphrase instead, reusing the same AES-256-GCM
    // helpers, and only included at all if the caller explicitly asks for it.
    if (req.body && req.body.includeSecurity) {
      if (!req.body.securityPassphrase || String(req.body.securityPassphrase).length < 8) {
        throw httpErr(400, 'securityPassphrase (at least 8 characters) is required to include security settings in the export.');
      }
      const currentJwtSecret = readEnvVar('JWT_SECRET') || JWT_SECRET;
      bundle.security = {
        cspMode: readEnvVar('CSP_MODE') || 'report-only',
        auditRetentionDays: readEnvVar('AUDIT_RETENTION_DAYS') || '365',
        jwtSecretEnc: encryptSecret(req.body.securityPassphrase, currentJwtSecret),
      };
    }
    return bundle;
  }

  app.get('/api/setup/export', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const bundle = await buildExportBundle(req);
      res.setHeader('Content-Disposition', `attachment; filename="dcim-config-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(bundle);
    } catch (e) { sendErr(res, e); }
  });
  // Same export, but accepts a body so includeSecurity/securityPassphrase never ride in a URL
  // (query strings get logged by proxies/servers; a POST body does not).
  app.post('/api/setup/export', authenticateToken, requireGlobalAdmin, async (req, res) => {
    try {
      const bundle = await buildExportBundle(req);
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
        for (const k of ORG_EDITABLE_KEYS) {
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

      let securityNote;
      if (bundle.security) {
        const changed = [];
        if (bundle.security.cspMode && ['enforce', 'report-only', 'off'].includes(bundle.security.cspMode)) { writeEnvVar('CSP_MODE', bundle.security.cspMode); changed.push('CSP_MODE'); }
        if (bundle.security.auditRetentionDays !== undefined) { writeEnvVar('AUDIT_RETENTION_DAYS', String(bundle.security.auditRetentionDays)); changed.push('AUDIT_RETENTION_DAYS'); }
        if (bundle.security.jwtSecretEnc) {
          const pass = req.body && req.body.securityPassphrase;
          const decrypted = pass ? decryptSecret(pass, bundle.security.jwtSecretEnc) : '';
          if (decrypted && decrypted.length >= 32) { writeEnvVar('JWT_SECRET', decrypted); changed.push('JWT_SECRET'); }
          else securityNote = pass ? 'JWT secret in the bundle could not be decrypted with that passphrase - it was not changed.' : 'The bundle includes an encrypted JWT secret, but no securityPassphrase was provided - it was not changed.';
        }
        if (changed.length) securityNote = `Security settings written to .env (${changed.join(', ')}) - restart the service for these to take effect.` + (securityNote ? ' ' + securityNote : '');
      }

      res.json({ success: true, imported: summary, note: summary.monitoring ? 'Imported monitoring entries have no password - add credentials in the Infrastructure wizard before testing them.' : undefined, securityNote });
    } catch (e) { sendErr(res, e); }
  });

  // Not called here: `pool` isn't connected yet at require/register time.
  // The caller invokes applyIntegrationEnv() once the database is up.
  return { applyIntegrationEnv };
};
