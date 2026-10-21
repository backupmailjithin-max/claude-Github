require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const zlib = require('zlib'); // also used by BACKUP & RESTORE further down
const license = require('./lib/license');

const app = express();
// Do not disclose the Express implementation/version in response headers.
app.disable('x-powered-by');
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? '' : 'dc-dashboard-secret-key-change-in-production');
if (IS_PRODUCTION && !JWT_SECRET) throw new Error('JWT_SECRET is required when NODE_ENV=production. Set a long random secret in .env before starting the server.');
// Inert unless lib/license-public-key.js has a real public key configured -
// see docs/LICENSING.md. LICENSE_FILE lets an install point at a license
// dropped somewhere other than its default location next to .env.
const LICENSE_FILE = process.env.LICENSE_FILE || path.join(__dirname, 'license.lic');

// =====================================================================
// PHASE-1 HARDENING - shared infrastructure
// (leveled logger, audit trail, password policy, upload security)
// Everything below is additive: no existing route contract changes.
// =====================================================================
const nodeCrypto = require('crypto');
let APP_VERSION = 'unknown';
try { APP_VERSION = require('./package.json').version || 'unknown'; } catch (_) { /* package.json missing */ }
const SERVER_STARTED_AT = new Date();
const HTTPS_ENABLED = ['1', 'true', 'on', 'yes'].includes(String(process.env.HTTPS_ENABLED || '').toLowerCase());
const HSTS_MAX_AGE = Math.max(0, Number(process.env.HSTS_MAX_AGE) || 86400); // 1 day by default (safe for a test host); raise to 31536000 in production
if (process.env.TRUST_PROXY) { // optional: set when running behind nginx/HAProxy so req.ip and req.secure reflect the real client
  const tp = process.env.TRUST_PROXY; app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : (tp === 'true' ? true : tp));
}

// ---- Application logger: INFO / WARN / ERROR / AUDIT -> console + logs/dcim-YYYYMMDD.log ----
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_TO_FILE = String(process.env.LOG_TO_FILE || 'on').toLowerCase() !== 'off';
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 30);
try { if (LOG_TO_FILE) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* logging to file is best effort */ }
const SENSITIVE_KEY_RE = /pass(word)?|token|secret|authorization|cookie|hash/i;
function scrubForLog(v, depth = 0) {
  if (v == null || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubForLog(x, depth + 1));
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : scrubForLog(x, depth + 1); return o; }
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 300) + '...';
  return v;
}
function logFilePath(d = new Date()) { const p = (n) => String(n).padStart(2, '0'); return path.join(LOG_DIR, `dcim-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`); }
function writeLog(level, args) {
  const text = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : (() => { try { return JSON.stringify(scrubForLog(a)); } catch (_) { return String(a); } })()))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line);
  if (LOG_TO_FILE) fs.appendFile(logFilePath(), line + '\n', () => {});
}
const log = {
  info: (...a) => writeLog('INFO', a),
  warn: (...a) => writeLog('WARN', a),
  error: (...a) => writeLog('ERROR', a),
  audit: (...a) => writeLog('AUDIT', a),
};
if (!process.env.JWT_SECRET) log.warn('WARNING: JWT_SECRET is not set in .env - using the development-only built-in default. Set JWT_SECRET before production use.');
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^dcim-\d{8}\.log$/.test(f)) continue;
      const fp = path.join(LOG_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch (_) { /* best effort */ }
}
if (LOG_TO_FILE) pruneOldLogs();

// ---- Standard error body: { error, code, status, requestId } ("error" stays a plain string, so the UI is unaffected) ----
const ERROR_CODES = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNPROCESSABLE', 429: 'TOO_MANY_REQUESTS', 500: 'INTERNAL_ERROR', 502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE' };
function errorBody(status, message, req, extra) {
  return { error: message, code: ERROR_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'), status, requestId: (req && req.id) || undefined, ...(extra || {}) };
}

// ---- Password policy (create user, admin reset, self change) ----
function passwordPolicyError(pw) {
  if (typeof pw !== 'string' || !pw) return 'Password is required.';
  const missing = [];
  if (pw.length < 8) missing.push('at least 8 characters');
  if (!/[A-Z]/.test(pw)) missing.push('an uppercase letter');
  if (!/[a-z]/.test(pw)) missing.push('a lowercase letter');
  if (!/[0-9]/.test(pw)) missing.push('a number');
  if (!/[^A-Za-z0-9\s]/.test(pw)) missing.push('a special character');
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  return missing.length ? `Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number and a special character. Missing: ${missing.join(', ')}.` : null;
}

// ---- Audit trail (table audit_logs; written best-effort, never blocks or breaks a request) ----
function clientIp(req) { return String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '').replace(/^::ffff:/, '').slice(0, 64); }
async function auditLog(req, action, o = {}) {
  try {
    const u = o.user || (req && req.user) || {};
    const username = o.username != null ? o.username : (u.username != null ? u.username : null);
    const failed = o.status === 'failure';
    const details = o.details ? JSON.stringify(scrubForLog(o.details)).slice(0, 4000) : null;
    log.audit(`${action} ${failed ? 'FAILURE' : 'OK'} user=${username || '-'} ip=${clientIp(req) || '-'}${o.entity ? ` ${o.entity}=${o.entityId != null ? o.entityId : '-'}` : ''}${details ? ` ${details}` : ''}`);
    if (!pool) return;
    await pool.query(
      'INSERT INTO audit_logs (user_id, username, role, action, entity_type, entity_id, site, status, ip_address, user_agent, details) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [u.id != null ? u.id : (o.userId != null ? o.userId : null), username != null ? String(username).slice(0, 100) : null, u.role || null, String(action).slice(0, 60),
        o.entity ? String(o.entity).slice(0, 50) : null, o.entityId != null ? String(o.entityId).slice(0, 100) : null, o.site ? String(o.site).slice(0, 50) : null,
        failed ? 'failure' : 'success', clientIp(req), String((req && req.headers && req.headers['user-agent']) || '').slice(0, 255), details]
    );
  } catch (e) { log.warn('[audit] could not write audit record:', e.message); }
}

// ---- Upload security ----
// extension -> accepted declared MIME types + file signature (magic bytes) check
const UPLOAD_TYPES = {
  '.pdf':  { mime: ['application/pdf'], sig: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  '.jpg':  { mime: ['image/jpeg', 'image/pjpeg'], sig: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  '.jpeg': { mime: ['image/jpeg', 'image/pjpeg'], sig: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  '.png':  { mime: ['image/png'], sig: (b) => b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' },
  '.webp': { mime: ['image/webp'], sig: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  '.doc':  { mime: ['application/msword'], sig: (b) => b.slice(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' },
  '.docx': { mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], sig: (b) => b[0] === 0x50 && b[1] === 0x4B },
  '.xls':  { mime: ['application/vnd.ms-excel'], sig: (b) => b.slice(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' },
  '.xlsx': { mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], sig: (b) => b[0] === 0x50 && b[1] === 0x4B },
};
const UPLOAD_MIME_GENERIC = ['application/octet-stream', 'application/x-zip-compressed', 'application/zip', 'application/x-msexcel', 'application/vnd.ms-office']; // some browsers/OSes send these for Office files - the signature check below still has to pass
const UPLOAD_DANGEROUS_EXT = new Set(['exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'scr', 'js', 'mjs', 'cjs', 'jse', 'vbs', 'vbe', 'wsf', 'ps1', 'psm1', 'sh', 'bash', 'zsh', 'php', 'php3', 'php4', 'php5', 'php7', 'phtml', 'phar', 'asp', 'aspx', 'ashx', 'jsp', 'jspx', 'cgi', 'pl', 'py', 'rb', 'jar', 'war', 'html', 'htm', 'xhtml', 'shtml', 'svg', 'xml', 'hta', 'lnk', 'reg', 'swf', 'apk', 'bin', 'so', 'htaccess', 'htpasswd', 'config', 'inf', 'url']);
function uploadError(msg) { const e = new Error(msg); e.statusCode = 400; e.isUploadError = true; return e; }
// Safe display name kept in the DB (never used as a path): no directories, control chars or shell/HTML metacharacters.
function sanitizeUploadName(name) {
  let n = String(name == null ? '' : name).replace(/\0/g, '');
  n = n.split(/[\\/]/).pop();                                       // drop any directory part (../../x, C:\x)
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*;&$`'%^~{}\[\]!#@]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim();
  if (n.length > 120) { const ext = path.extname(n); n = n.slice(0, 120 - ext.length) + ext; }
  return n || 'file';
}
// Returns an error message, or null when the file name + declared MIME type are acceptable.
function uploadNameProblem(originalName, mimeType) {
  const raw = String(originalName || '');
  if (/\0/.test(raw)) return 'Invalid file name.';
  const base = raw.split(/[\\/]/).pop();
  const ext = path.extname(base).toLowerCase();
  if (!UPLOAD_TYPES[ext]) return 'Only PDF, image, Word, or Excel files are allowed';
  const stem = base.slice(0, base.length - ext.length);
  const inner = stem.split('.').slice(1).map((s) => s.trim().toLowerCase()).filter(Boolean);    // everything between the first dot and the final extension
  if (inner.some((s) => UPLOAD_DANGEROUS_EXT.has(s) || UPLOAD_TYPES['.' + s])) return 'Files with a double extension (for example .pdf.exe or .jpg.js) are not allowed.';
  if (UPLOAD_DANGEROUS_EXT.has(stem.toLowerCase().replace(/^\./, ''))) return 'This file name is not allowed.';
  const mt = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (mt && !UPLOAD_TYPES[ext].mime.includes(mt) && !UPLOAD_MIME_GENERIC.includes(mt)) return `The file type (${mt}) does not match its extension (${ext}).`;
  return null;
}
// Runs after multer has written the files: checks the real content (magic bytes), cleans the display name, removes everything on failure.
function verifyUploadedFiles(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  const dropAll = () => files.forEach((f) => { if (f.path) fs.unlink(f.path, () => {}); });
  try {
    for (const f of files) {
      const ext = path.extname(f.filename || f.originalname || '').toLowerCase();
      const t = UPLOAD_TYPES[ext];
      const fd = fs.openSync(f.path, 'r'); const head = Buffer.alloc(16); const n = fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
      if (!t || n < 4 || !t.sig(head.slice(0, n))) { dropAll(); log.warn(`[upload] rejected "${sanitizeUploadName(f.originalname)}" - content does not match ${ext}`); return next(uploadError(`The content of "${sanitizeUploadName(f.originalname)}" does not match its ${ext} file type.`)); }
      f.originalname = sanitizeUploadName(f.originalname);
    }
    next();
  } catch (e) { dropAll(); next(e); }
}
// Every stored upload is addressed by its bare file name inside the uploads folder - a '../' in a DB value or backup can never leave it.
function safeUploadPath(name) { return path.join(MOVEMENTS_UPLOAD_DIR, path.basename(String(name == null ? '' : name))); }

// =====================================================================
// PHASE-2 PERFORMANCE INFRASTRUCTURE (additive; every feature has an .env switch)
//   * slow SQL / slow API logging           SLOW_QUERY_MS (500)  SLOW_API_MS (1500)
//   * short-lived cache of the big read-only list responses   API_CACHE_TTL_MS (15000, 0 = off)  API_CACHE_MAX_MB (64)
//   * compressed + cacheable static files (br/gzip, ETag/304)  STATIC_COMPRESS=off to disable
//   * memory / event-loop monitor with leak warning          MEMORY_MONITOR=off to disable
// =====================================================================
const { monitorEventLoopDelay } = require('perf_hooks');
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS) || 500;
const SLOW_API_MS = Number(process.env.SLOW_API_MS) || 1500;
const API_CACHE_TTL_MS = process.env.API_CACHE_TTL_MS !== undefined && process.env.API_CACHE_TTL_MS !== '' ? Math.max(0, Number(process.env.API_CACHE_TTL_MS) || 0) : 15000;
const API_CACHE_MAX_BYTES = (Number(process.env.API_CACHE_MAX_MB) || 64) * 1048576;
const STATIC_COMPRESS = String(process.env.STATIC_COMPRESS || 'on').toLowerCase() !== 'off';
const perfStats = { queries: 0, slowQueries: 0, apiRequests: 0, slowApi: 0, cacheHits: 0, cacheMisses: 0, cacheStores: 0, recentSlow: [], routes: new Map() };
function noteSlow(kind, text, ms) { perfStats.recentSlow.push({ kind, text: String(text).replace(/\s+/g, ' ').slice(0, 220), ms: Math.round(ms), at: new Date().toISOString() }); if (perfStats.recentSlow.length > 30) perfStats.recentSlow.shift(); }
function sqlText(a0) { return typeof a0 === 'string' ? a0 : (a0 && a0.sql) || ''; }
// Any DB write that touches cached data (e.g. background OME/OneView firmware sync, which runs outside HTTP) drops the read cache.
const CACHED_WRITE_RE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP)\b[^;]*?\b(?:assets|issues|dc_activities|material_movements|material_movement_documents|rack_components|asset_movements|locations|zones|racks|sites|asset_lifecycle\w*)\b/i;
function noteWriteSql(a0) { try { const t = sqlText(a0); if (t && CACHED_WRITE_RE.test(t)) apiCacheClear(); } catch (e) { /* never break a query */ } }
function timedQuery(orig) { // wraps a promise-style .query / .execute; the SQL text (never the parameter values) is logged when slow
  return function (...args) {
    const t0 = process.hrtime.bigint();
    const done = () => { perfStats.queries++; const ms = Number(process.hrtime.bigint() - t0) / 1e6; if (ms >= SLOW_QUERY_MS) { perfStats.slowQueries++; const q = sqlText(args[0]).replace(/\s+/g, ' ').slice(0, 300); noteSlow('sql', q, ms); log.warn(`[slow-query] ${Math.round(ms)} ms: ${q}`); } };
    const r = orig.apply(this, args);
    if (r && typeof r.then === 'function') r.then(() => { done(); noteWriteSql(args[0]); }, done);
    return r;
  };
}
function wrapPoolForTiming(p) {
  if (!p || p.__timed) return p; p.__timed = true;
  p.query = timedQuery(p.query.bind(p)); if (p.execute) p.execute = timedQuery(p.execute.bind(p));
  const origGet = p.getConnection.bind(p);
  p.getConnection = async function () { const c = await origGet(); if (!c.__timed) { c.__timed = true; if (c.commit) { const oc = c.commit.bind(c); c.commit = async function () { try { return await oc(); } finally { apiCacheClear(); } }; } c.query = timedQuery(c.query.bind(c)); if (c.execute) c.execute = timedQuery(c.execute.bind(c)); } return c; };
  return p;
}
// ---- read-cache for the heavy list endpoints ----
const API_CACHE_PATHS = new Set(['/api/assets', '/api/issues', '/api/activities', '/api/material-movements', '/api/rack-components', '/api/asset-lifecycle']);
const NO_INVALIDATE = /^\/api\/(auth\/(login|logout|heartbeat|offline)|assets\/validate-import|floor-plan-lock|ocr\/(extract|confirm))$/;
let cacheGen = 0; const apiCache = new Map(); let apiCacheBytes = 0;
function apiCacheClear() { cacheGen++; apiCache.clear(); apiCacheBytes = 0; }
function apiCacheStore(key, gz) {
  if (!API_CACHE_TTL_MS || gz.length > API_CACHE_MAX_BYTES / 2) return;
  const old = apiCache.get(key); if (old) { apiCacheBytes -= old.gz.length; apiCache.delete(key); }
  while (apiCacheBytes + gz.length > API_CACHE_MAX_BYTES && apiCache.size) { const k = apiCache.keys().next().value; apiCacheBytes -= apiCache.get(k).gz.length; apiCache.delete(k); }
  apiCache.set(key, { gz, exp: Date.now() + API_CACHE_TTL_MS, gen: cacheGen }); apiCacheBytes += gz.length; perfStats.cacheStores++;
}
function routeKey(req, p) { return `${req.method} ${p.replace(/\/(?:[0-9a-f]{8,}|[A-Z]{2,5}-[\w-]+|\d+)(?=\/|$)/g, '/:id')}`; }
function noteRoute(key, ms) { let r = perfStats.routes.get(key); if (!r) { if (perfStats.routes.size >= 300) return; r = { n: 0, total: 0, max: 0 }; perfStats.routes.set(key, r); } r.n++; r.total += ms; if (ms > r.max) r.max = ms; }

// ---- static files: brotli / gzip once, cached in memory, ETag + 304 ----
const staticZ = new Map(); const staticZPending = new Map();
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.otf', '.ttf', '.txt', '.map']);
function pickEncoding(req) { const ae = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null; }
function compressedBuffer(abs, st, enc) {
  const key = `${abs}|${st.size}|${st.mtimeMs}|${enc}`; const hit = staticZ.get(key); if (hit) return Promise.resolve(hit);
  if (staticZPending.has(key)) return staticZPending.get(key);
  const p = fs.promises.readFile(abs).then((raw) => new Promise((resolve, reject) => {
    const cb = (e, out) => { if (e) return reject(e); for (const k of [...staticZ.keys()]) if (k.startsWith(abs + '|') && k !== key) staticZ.delete(k); staticZ.set(key, out); resolve(out); };
    if (enc === 'br') zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, cb); else zlib.gzip(raw, { level: 9 }, cb);
  })).finally(() => staticZPending.delete(key));
  staticZPending.set(key, p); return p;
}
// Sends one static file. cacheControl decides browser caching; files carrying ?v=... are safe to keep for long (the HTML changes the version on every release).
async function sendStaticFile(req, res, next, abs, cacheControl) {
  try {
    const st = await fs.promises.stat(abs).catch(() => null); if (!st || !st.isFile()) return next();
    const ext = path.extname(abs).toLowerCase(); const enc = STATIC_COMPRESS && st.size > 1024 && COMPRESSIBLE.has(ext) ? pickEncoding(req) : null;
    const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}${enc ? '-' + enc : ''}"`;
    res.set({ 'Cache-Control': cacheControl, ETag: etag, 'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type(ext || 'application/octet-stream');
    if (!enc) { res.set('Content-Length', String(st.size)); return req.method === 'HEAD' ? res.end() : fs.createReadStream(abs).pipe(res); }
    const buf = await compressedBuffer(abs, st, enc);
    res.set({ 'Content-Encoding': enc, 'Content-Length': String(buf.length) });
    return req.method === 'HEAD' ? res.end() : res.end(buf);
  } catch (e) { return next(e); }
}
const LONG_CACHE = 'public, max-age=2592000, immutable';   // /libs files (versioned with ?v=)
const APP_CACHE = 'public, max-age=86400';                   // app bundle (versioned with ?v=, bumped on every release)

// ---- memory / event-loop monitor ----
const memSamples = []; const loopHist = (() => { try { const h = monitorEventLoopDelay({ resolution: 20 }); h.enable(); return h; } catch (_) { return null; } })();
let lastLeakWarn = 0;
function sampleMemory() {
  const m = process.memoryUsage();
  const s = { t: Date.now(), rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), extMB: Math.round(m.external / 1048576), loopP99ms: loopHist ? Math.round(loopHist.percentile(99) / 1e6) : null, loopMaxMs: loopHist ? Math.round(loopHist.max / 1e6) : null };
  if (loopHist) loopHist.reset();
  memSamples.push(s); if (memSamples.length > 240) memSamples.shift();
  // housekeeping so no in-memory structure can grow forever
  const now = Date.now(); for (const [k, v] of authUserCache) { if (v.expires < now) authUserCache.delete(k); } while (authUserCache.size > 2000) authUserCache.delete(authUserCache.keys().next().value);
  for (const [k, v] of apiCache) { if (v.exp < now) { apiCacheBytes -= v.gz.length; apiCache.delete(k); } }
  if (s.loopP99ms != null && s.loopP99ms > 500) log.warn(`[perf] event loop was blocked (p99 ${s.loopP99ms} ms, max ${s.loopMaxMs} ms) - a request is doing heavy synchronous work`);
  if (memSamples.length >= 30) { // compare the first and last 10 samples (about 10 minutes each when sampling every minute)
    const avg = (a) => a.reduce((x, y) => x + y.heapMB, 0) / a.length; const first = avg(memSamples.slice(0, 10)), last = avg(memSamples.slice(-10));
    if (last > first * 1.5 && last - first > 100 && now - lastLeakWarn > 3600000) { lastLeakWarn = now; log.warn(`[memory] heap grew from ~${Math.round(first)} MB to ~${Math.round(last)} MB over ${Math.round((memSamples[memSamples.length - 1].t - memSamples[0].t) / 60000)} min - possible memory leak`); }
  }
  if (memSamples.length % 15 === 0) log.info(`[perf] heap ${s.heapMB} MB, rss ${s.rssMB} MB, loop p99 ${s.loopP99ms} ms, api cache ${apiCache.size} entries / ${Math.round(apiCacheBytes / 1024)} KB, slow queries ${perfStats.slowQueries}, slow api ${perfStats.slowApi}`);
}
// =====================================================================
// =====================================================================

// Middleware
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
if (CORS_ORIGIN) {
  const allowedOrigins = CORS_ORIGIN.split(',').map((v) => v.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins }));
} else if (!IS_PRODUCTION) {
  // Development / local-file compatibility. Production is same-origin by default.
  app.use(cors());
}
// ---- HARDENING: Content-Security-Policy ----
// CSP_MODE = enforce (default: violations are blocked and reported) | report-only (reported only) | off.
// Inline <script> blocks of index.html are allowed by SHA-256 hash (computed from the file that is actually served), so 'unsafe-inline' is not needed for scripts.
// The browser talks only to this same origin (Dell OME / HPE OneView are called by the server, never by the browser). CSP_EXTRA_CONNECT / CSP_EXTRA_IMG add origins if ever needed.
const CSP_MODE = (() => { const v = String(process.env.CSP_MODE || 'enforce').toLowerCase(); return ['enforce', 'report-only', 'off'].includes(v) ? v : 'enforce'; })();
// Session Timeout: read once at startup, same "write to .env + restart" pattern as
// CSP_MODE/JWT_SECRET above (see the Setup Wizard's Security tab) - defaults to the
// previous hardcoded 8h if unset or invalid, so an upgrade with no .env change behaves
// exactly as before.
const JWT_EXPIRES_IN = (() => { const n = Number(process.env.SESSION_TIMEOUT_HOURS); return Number.isFinite(n) && n > 0 ? `${n}h` : '8h'; })();
const cspExtra = (name) => String(process.env[name] || '').split(/[\s,]+/).filter((x) => /^(https?:\/\/[A-Za-z0-9.*:_-]+|wss?:\/\/[A-Za-z0-9.*:_-]+)$/.test(x)).join(' ');
// index.html is never hand-versioned: the ?v= on app-compiled.js is rewritten here, on every
// request, to the live bundle's own content hash (same hash appBundlePath() already computes -
// not a file mtime, since the bundle is often deployed by copying a file over an existing one,
// which does not reliably bump mtime). This is what used to be a hardcoded "?v=20261019pduN"
// string in index.html that had to be remembered and bumped by hand on every app-compiled.js
// release - a human (or AI) forgetting to do that is exactly the bug this removes, permanently:
// there is nothing left to forget. CSP script-src hashes are computed from this SAME rewritten
// HTML (not the raw on-disk file), so the hash list always matches what is actually served.
let _indexCache = { htmlMtime: 0, bundleHash: '', html: '', cspHashes: '' };
function getRenderedIndex() {
  const f = path.join(__dirname, 'index.html');
  const st = fs.statSync(f);
  appBundlePath(); // side effect: refreshes _bundleCheck.hash for the current app-compiled.js content
  const bundleHash = _bundleCheck.hash;
  if (_indexCache.html && _indexCache.htmlMtime === st.mtimeMs && _indexCache.bundleHash === bundleHash) return _indexCache;
  let html = fs.readFileSync(f, 'utf8').replace(/(\.\/app-compiled\.js\?v=)[^"'\s]+/, `$1${bundleHash || 'dev'}`);
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ''); const hashes = []; // comments removed first: a '<script>' written inside an HTML comment must not be mistaken for a real tag
  noComments.replace(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => { if (body.trim()) hashes.push(`'sha256-${nodeCrypto.createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`); return m; });
  _indexCache = { htmlMtime: st.mtimeMs, bundleHash, html, cspHashes: hashes.join(' ') };
  return _indexCache;
}
// Inline <script> hashes for the stand-alone admin pages (setup wizard / deployment dashboard), so they keep working when CSP_MODE=enforce.
const ADMIN_PAGES = { '/setup-wizard.html': 'setup-wizard.html', '/deployment-dashboard.html': 'deployment-dashboard.html' };
const _adminCspCache = {};
function adminPageHashes(reqPath) {
  const name = ADMIN_PAGES[reqPath]; if (!name) return null;
  const f = path.join(__dirname, name);
  const st = fs.statSync(f); const c = _adminCspCache[name];
  if (c && c.mtime === st.mtimeMs) return c.hashes;
  const html = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, ''); const hashes = [];
  html.replace(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => { if (body.trim()) hashes.push(`'sha256-${nodeCrypto.createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`); return m; });
  _adminCspCache[name] = { mtime: st.mtimeMs, hashes: hashes.join(' ') };
  return _adminCspCache[name].hashes;
}
function buildCspValue(reqPath) {
  try {
    const cspHashes = (reqPath && adminPageHashes(reqPath)) || getRenderedIndex().cspHashes;
    const conn = ["'self'", cspExtra('CSP_EXTRA_CONNECT')].filter(Boolean).join(' '); const img = ["'self'", 'data:', 'blob:', cspExtra('CSP_EXTRA_IMG')].filter(Boolean).join(' ');
    return ["default-src 'self'", `script-src 'self' ${cspHashes}`.trim(), "style-src 'self' 'unsafe-inline'", `img-src ${img}`, "font-src 'self' data:", "media-src 'self' blob:", `connect-src ${conn}`, "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", 'report-uri /api/csp-report'].join('; ');
  } catch (e) { return ''; }
}
let _cspLogWindow = 0, _cspLogCount = 0;
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }), (req, res) => {
  try {
    const now = Date.now(); if (now - _cspLogWindow > 60000) { _cspLogWindow = now; _cspLogCount = 0; }
    if (CSP_MODE !== 'off' && _cspLogCount++ < 30) { // capped so the endpoint cannot be used to flood the log
      let r = req.body && (req.body['csp-report'] || (Array.isArray(req.body) && req.body[0] && req.body[0].body) || req.body) || {};
      const pick = (k) => String(r[k] || r[k.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] || '').replace(/[\r\n]+/g, ' ').slice(0, 160);
      log.warn(`[csp] ${CSP_MODE}: violated "${pick('violated-directive') || pick('effective-directive')}" blocked "${pick('blocked-uri')}" on "${pick('document-uri')}"`);
    }
  } catch (e) { /* never fails */ }
  res.status(204).end();
});
// Login / auth calls are tiny - cap them so an unauthenticated client cannot force 50 MB parses. Import routes keep the large limit below.
app.use('/api/auth', express.json({ limit: '100kb' }));
// SECURITY: the large (50 MB) JSON parser must never run for anonymous callers - otherwise a handful of unauthenticated
// requests can exhaust memory and stall the process. Mutating /api calls (other than /api/auth/*, handled above with a 100 KB cap)
// must carry a correctly signed, unexpired token BEFORE the body is read. The full session / role checks still happen in authenticateToken.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path.startsWith('/auth/') || req.path === '/csp-report') return next();
  const h = req.headers['authorization']; const tok = h && String(h).split(' ')[1];
  const deny = (msg) => { if (!req.id) { req.id = nodeCrypto.randomBytes(6).toString('hex'); res.set('X-Request-Id', req.id); } res.set('Connection', 'close'); return res.status(401).json({ error: msg, code: 'UNAUTHORIZED', status: 401, requestId: req.id }); };
  if (!tok) return deny('Access token required');
  try { jwt.verify(tok, JWT_SECRET); } catch (e) { return deny('Invalid or expired token'); }
  next();
});
app.use(express.json({ limit: '50mb' }));
// Baseline security response headers (no `helmet` dependency needed - same
// offline-friendly, no-new-package approach used elsewhere in this file). CSP is
// deliberately left out here: this app serves its own inline-scripted pages and a
// login background video, and a generic CSP is more likely to silently break those
// than to add real protection on an internal, non-public DCIM deployment.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  if (CSP_MODE !== 'off' && !req.path.startsWith('/api/')) { const cv = buildCspValue(req.path); if (cv) res.set(CSP_MODE === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', cv); }
  // PHASE-1 hardening headers
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Resource-Policy', process.env.CORP_POLICY || 'same-origin');
  // HSTS only when the request really arrived over HTTPS (direct TLS, a TLS-terminating proxy that sets X-Forwarded-Proto, or HTTPS_ENABLED=true)
  if (HTTPS_ENABLED || req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https') {
    res.set('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}`);
  }
  next();
});
// API responses must always reflect current DCIM state; never serve cached CRUD/dashboard data.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// ---- PHASE-1: which state-changing calls are audited (rule.log = application log only) ----
const AUDIT_BODY_KEYS = ['username', 'name', 'role', 'location_access', 'status', 'site', 'zone', 'rack_no', 'position', 'serial_number', 'asset_tag', 'hardware_type', 'lifecycle_status', 'toStatus', 'to_status', 'action', 'title', 'ticket_no', 'movement_type', 'item_name', 'activity_type', 'dryRun', 'mode'];
const AUDIT_RESULT_KEYS = ['created', 'updated', 'inserted', 'skipped', 'imported', 'failed', 'total', 'count', 'deleted', 'added', 'unchanged', 'errors'];
const AUDIT_RULES = [
  { m: 'POST',   re: /^\/api\/users$/, action: 'USER_CREATE', entity: 'user' },
  { m: 'PATCH',  re: /^\/api\/users\/([^/]+)$/, action: 'USER_UPDATE', entity: 'user' },
  { m: 'DELETE', re: /^\/api\/users\/([^/]+)$/, action: 'USER_DELETE', entity: 'user' },
  { m: 'PATCH',  re: /^\/api\/users\/([^/]+)\/reset-password$/, action: 'PASSWORD_RESET', entity: 'user' },
  { m: 'PATCH',  re: /^\/api\/auth\/change-password$/, action: 'PASSWORD_CHANGE', entity: 'user', self: true },
  { m: 'POST',   re: /^\/api\/assets$/, action: 'ASSET_CREATE', entity: 'asset' },
  { m: 'PATCH',  re: /^\/api\/assets\/([^/]+)$/, action: 'ASSET_UPDATE', entity: 'asset' },
  { m: 'DELETE', re: /^\/api\/assets\/([^/]+)$/, action: 'ASSET_DELETE', entity: 'asset' },
  { m: 'POST',   re: /^\/api\/assets\/bulk-upsert$/, action: 'ASSET_IMPORT', entity: 'asset' },
  { m: 'POST',   re: /^\/api\/assets\/validate-import$/, action: 'ASSET_IMPORT_VALIDATE', entity: 'asset', log: true },
  { m: 'POST',   re: /^\/api\/assets\/([^/]+)\/lifecycle$/, action: 'ASSET_LIFECYCLE', entity: 'asset' },
  { m: 'POST',   re: /^\/api\/assets\/([^/]+)\/hardware\/sync$/, action: 'MONITORING_SYNC', entity: 'asset', log: true },
  { m: 'PATCH',  re: /^\/api\/asset-movements\/([^/]+)$/, action: 'ASSET_MOVEMENT_UPDATE', entity: 'asset_movement' },
  { m: 'PUT',    re: /^\/api\/assets\/([^/]+)\/connectivity$/, action: 'CONNECTIVITY_UPDATE', entity: 'asset' },
  { m: 'DELETE', re: /^\/api\/assets\/([^/]+)\/connectivity$/, action: 'CONNECTIVITY_DELETE', entity: 'asset' },
  { m: 'POST',   re: /^\/api\/connectivity\/import$/, action: 'CONNECTIVITY_IMPORT', entity: 'connectivity' },
  { m: 'POST',   re: /^\/api\/rack-components$/, action: 'RACK_COMPONENT_CREATE', entity: 'rack_component' },
  { m: 'PATCH',  re: /^\/api\/rack-components\/([^/]+)$/, action: 'RACK_COMPONENT_UPDATE', entity: 'rack_component' },
  { m: 'DELETE', re: /^\/api\/rack-components\/([^/]+)$/, action: 'RACK_COMPONENT_DELETE', entity: 'rack_component' },
  { m: 'POST',   re: /^\/api\/rack-components\/bulk-upsert$/, action: 'RACK_COMPONENT_IMPORT', entity: 'rack_component' },
  { m: 'POST',   re: /^\/api\/racks$/, action: 'RACK_CREATE', entity: 'rack' },
  { m: 'PUT',    re: /^\/api\/racks\/upsert-dimensions$/, action: 'RACK_UPDATE', entity: 'rack' },
  { m: 'DELETE', re: /^\/api\/racks\/([^/]+)$/, action: 'RACK_DELETE', entity: 'rack' },
  { m: 'POST',   re: /^\/api\/racks\/move$/, action: 'RACK_MOVE', entity: 'rack' },
  { m: 'PUT',    re: /^\/api\/floor-plan$/, action: 'FLOORPLAN_SAVE', entity: 'floor_plan' },
  { m: 'POST',   re: /^\/api\/issues$/, action: 'ISSUE_CREATE', entity: 'issue' },
  { m: 'PATCH',  re: /^\/api\/issues\/([^/]+)$/, action: 'ISSUE_UPDATE', entity: 'issue' },
  { m: 'DELETE', re: /^\/api\/issues\/([^/]+)$/, action: 'ISSUE_DELETE', entity: 'issue' },
  { m: 'POST',   re: /^\/api\/activities$/, action: 'ACTIVITY_CREATE', entity: 'activity' },
  { m: 'PATCH',  re: /^\/api\/activities\/([^/]+)$/, action: 'ACTIVITY_UPDATE', entity: 'activity' },
  { m: 'DELETE', re: /^\/api\/activities\/([^/]+)$/, action: 'ACTIVITY_DELETE', entity: 'activity' },
  { m: 'POST',   re: /^\/api\/material-movements$/, action: 'MOVEMENT_CREATE', entity: 'material_movement' },
  { m: 'PATCH',  re: /^\/api\/material-movements\/([^/]+)$/, action: 'MOVEMENT_UPDATE', entity: 'material_movement' },
  { m: 'DELETE', re: /^\/api\/material-movements\/([^/]+)$/, action: 'MOVEMENT_DELETE', entity: 'material_movement' },
  { m: 'POST',   re: /^\/api\/material-movements\/([^/]+)\/document$/, action: 'MOVEMENT_DOC_UPLOAD', entity: 'material_movement' },
  { m: 'DELETE', re: /^\/api\/material-movements\/([^/]+)\/documents?(?:\/[^/]+)?$/, action: 'MOVEMENT_DOC_DELETE', entity: 'material_movement' },
  // configuration
  { m: 'POST',   re: /^\/api\/locations$/, action: 'CONFIG_LOCATION_CREATE', entity: 'location' },
  { m: 'POST',   re: /^\/api\/locations\/([^/]+)\/archive$/, action: 'CONFIG_LOCATION_ARCHIVE', entity: 'location' },
  { m: 'POST',   re: /^\/api\/locations\/([^/]+)\/restore$/, action: 'CONFIG_LOCATION_RESTORE', entity: 'location' },
  { m: 'DELETE', re: /^\/api\/locations\/([^/]+)$/, action: 'CONFIG_LOCATION_DELETE', entity: 'location' },
  { m: 'POST',   re: /^\/api\/rack-types$/, action: 'CONFIG_RACK_TYPE_CREATE', entity: 'rack_type' },
  { m: 'POST',   re: /^\/api\/zones$/, action: 'CONFIG_ZONE_CREATE', entity: 'zone' },
  { m: 'DELETE', re: /^\/api\/zones\/([^/]+)$/, action: 'CONFIG_ZONE_DELETE', entity: 'zone' },
  { m: 'POST',   re: /^\/api\/hardware-types$/, action: 'CONFIG_HARDWARE_TYPE_CREATE', entity: 'hardware_type' },
  { m: 'DELETE', re: /^\/api\/hardware-types\/([^/]+)$/, action: 'CONFIG_HARDWARE_TYPE_DELETE', entity: 'hardware_type' },
  { m: 'PUT',    re: /^\/api\/monitoring\/firmware-model-targets$/, action: 'CONFIG_FIRMWARE_MODEL_TARGET', entity: 'firmware_target' },
  { m: 'DELETE', re: /^\/api\/monitoring\/firmware-model-targets$/, action: 'CONFIG_FIRMWARE_MODEL_TARGET_DELETE', entity: 'firmware_target' },
  { m: 'PUT',    re: /^\/api\/monitoring\/firmware-targets$/, action: 'CONFIG_FIRMWARE_TARGET', entity: 'firmware_target' },
  { m: 'POST',   re: /^\/api\/monitoring\/reconciliation\/settings$/, action: 'CONFIG_RECONCILIATION', entity: 'setting' },
  { m: 'PUT',    re: /^\/api\/backup\/settings$/, action: 'CONFIG_BACKUP_SETTINGS', entity: 'setting' },
  { m: 'POST',   re: /^\/api\/monitoring\/firmware\/apply$/, action: 'FIRMWARE_APPLY', entity: 'firmware', always: true },
  // monitoring syncs (OME / OneView): application log only - the integration code itself is untouched
  { m: 'POST',   re: /^\/api\/monitoring\/refresh-hardware$/, action: 'MONITORING_SYNC', entity: 'monitoring', log: true },
  { m: 'POST',   re: /^\/api\/monitoring\/refresh-alerts$/, action: 'MONITORING_SYNC', entity: 'monitoring', log: true },
  { m: 'POST',   re: /^\/api\/monitoring\/firmware-sync$/, action: 'MONITORING_SYNC', entity: 'monitoring', log: true },
  { m: 'POST',   re: /^\/api\/monitoring\/reconciliation$/, action: 'MONITORING_SYNC', entity: 'monitoring', log: true },
  { m: 'POST',   re: /^\/api\/monitoring\/reconciliation\/standardize$/, action: 'MONITORING_SYNC', entity: 'monitoring', log: true },
];
// PHASE-1: request id + standardized error bodies + automatic audit trail for every state-changing API call.
// (Wraps res.json only to *add* code/status/requestId to error bodies and to read the new record's id - existing fields are never changed.)
app.use('/api', (req, res, next) => {
  req.id = nodeCrypto.randomBytes(6).toString('hex');
  res.set('X-Request-Id', req.id);
  const startedAt = Date.now();
  // PHASE-2: per-route timing, slow-API log, cache invalidation after any state-changing call
  const urlPath = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    const ms = Date.now() - startedAt; perfStats.apiRequests++;
    noteRoute(routeKey(req, urlPath), ms);
    if (ms >= SLOW_API_MS) { perfStats.slowApi++; noteSlow('api', `${req.method} ${urlPath} -> ${res.statusCode}`, ms); log.warn(`[slow-api] ${req.method} ${urlPath} -> ${res.statusCode} took ${ms} ms (user ${(req.user && req.user.username) || '-'}, req ${req.id})`); }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !NO_INVALIDATE.test(urlPath)) apiCacheClear();
  });
  if (req.method === 'GET' && API_CACHE_TTL_MS && API_CACHE_PATHS.has(urlPath) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    // Same identity rule as authenticateToken's fast path: only a token already verified (and still inside AUTH_CACHE_TTL_MS) is served from the cache.
    const tok = String(req.headers.authorization || '').split(' ')[1]; const c = tok && authUserCache.get(tok);
    if (c && c.expires > Date.now()) {
      const u = c.row; const key = `${u.id}|${u.role}|${u.location_access}|${req.originalUrl}`; const e = Number(u.must_change_password) ? null : apiCache.get(key);
      if (e && e.gen === cacheGen && e.exp > Date.now()) {
        perfStats.cacheHits++;
        res.set({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'X-Cache': 'HIT' }); res.type('application/json');
        return res.send(e.gz);
      }
      perfStats.cacheMisses++; res.locals.cacheKey = key; res.locals.cacheGenAtStart = cacheGen;
    }
  }
  const origJson = res.json.bind(res);
  res.json = (body) => {
    res.locals.auditBody = body;
    // HARDENING: an unexpected server failure (5xx) never shows SQL / driver / path / exception text to the client. The full message goes to the log only.
    if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
      if (!res.locals.errLogged) log.error(`[error-masked] ${req.method} ${urlPath} -> ${res.statusCode} (req ${req.id}): ${String(body.error).slice(0, 1000)}`);
      return origJson({ error: 'Internal Server Error', referenceId: req.id });
    }
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
      body = { ...body, code: body.code || ERROR_CODES[res.statusCode] || (res.statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'), status: res.statusCode, requestId: req.id };
    }
    return origJson(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.on('finish', () => {
      try {
        const p = req.originalUrl.split('?')[0].replace(/\/+$/, '');
        for (const rule of AUDIT_RULES) {
          if (rule.m !== req.method) continue;
          const m = rule.re.exec(p); if (!m) continue;
          const body = req.body && typeof req.body === 'object' ? req.body : {};
          const resp = res.locals.auditBody && typeof res.locals.auditBody === 'object' ? res.locals.auditBody : {};
          const ok = res.statusCode < 400;
          if (rule.log) { // monitoring syncs / validations: application log only
            (ok ? log.info : log.warn)(`[${rule.action}] ${req.method} ${p} -> ${res.statusCode} (${Date.now() - startedAt} ms) user=${(req.user && req.user.username) || '-'}`);
            return;
          }
          if (!ok && !rule.always && ![401, 403, 429].includes(res.statusCode) && res.statusCode < 500) return; // plain validation errors are not audit events (rules marked `always` audit every failure)
          const details = { method: req.method, path: p, httpStatus: res.statusCode };
          for (const k of AUDIT_BODY_KEYS) if (body[k] != null && typeof body[k] !== 'object') details[k] = String(body[k]).slice(0, 100);
          for (const k of AUDIT_RESULT_KEYS) if (typeof resp[k] === 'number') details[k] = resp[k];
          if (Array.isArray(req.body)) details.rowsSubmitted = req.body.length;
          for (const k of ['rows', 'assets', 'items', 'records']) if (Array.isArray(body[k])) { details.rowsSubmitted = body[k].length; break; }
          if (resp.results && typeof resp.results === 'object') for (const k of AUDIT_RESULT_KEYS) if (typeof resp.results[k] === 'number') details[k] = resp.results[k];
          if (resp.results && Array.isArray(resp.results.errors)) details.errors = resp.results.errors.length;
          if (!ok && resp.error) details.error = String(resp.error).slice(0, 200);
          if (res.locals.auditExtra && typeof res.locals.auditExtra === 'object') Object.assign(details, res.locals.auditExtra);
          auditLog(req, rule.action, { entity: rule.entity, entityId: (m[1] != null ? m[1] : (resp.id != null ? resp.id : (body.id != null && typeof body.id !== 'object' ? body.id : (rule.self && req.user ? req.user.id : null)))), site: body.site || resp.site || null, status: ok ? 'success' : 'failure', details });
          return;
        }
      } catch (e) { /* auditing must never affect the response */ }
    });
  }
  next();
});
// PERF: gzip API responses. Large list endpoints (assets/activities/movements)
// can run into several MB of JSON once the DB has a few thousand rows, and
// sending that uncompressed both slows the page load and adds unnecessary
// network/CPU work on this VM. Implemented with Node's built-in zlib instead
// of the `compression` npm package so this offline build doesn't need a new
// dependency downloaded/copied into node_modules.
app.use('/api', (req, res, next) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!acceptEncoding.includes('gzip')) return next();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const text = JSON.stringify(body);
      if (text && text.length > 1024) {
        const finish = (gz) => {
          if (res.locals.cacheKey && res.statusCode === 200 && res.locals.cacheGenAtStart === cacheGen) apiCacheStore(res.locals.cacheKey, gz); // PHASE-2
          res.set('Content-Encoding', 'gzip');
          res.set('Vary', 'Accept-Encoding');
          res.type('application/json');
          return res.send(gz);
        };
        if (text.length < 512 * 1024) return finish(zlib.gzipSync(text, { level: 5 }));
        // REVIEW: big payloads (tens of thousands of rows) are compressed on the libuv thread-pool so other requests keep being served
        zlib.gzip(text, { level: 5 }, (err, gz) => { if (err || res.headersSent) { if (!res.headersSent) originalJson(body); return; } finish(gz); });
        return res;
      }
    } catch (e) {
      // Any problem compressing falls back to a normal (uncompressed) response.
    }
    return originalJson(body);
  };
  next();
});
// Serve ONLY the optional offline libs folder. The project root (server.js, schema.sql,
// package.json, uploads/ ...) must never be reachable as static files - uploaded DC/Invoice
// documents in particular are only downloadable through the authenticated endpoint below.
const LIBS_DIR = path.join(__dirname, 'libs');
app.use('/libs', (req, res, next) => { // PHASE-2: brotli/gzip + long browser cache for the versioned (?v=) library and font files
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel; try { rel = decodeURIComponent(req.path); } catch (e) { return next(); }
  const abs = path.normalize(path.join(LIBS_DIR, rel));
  if (!abs.startsWith(LIBS_DIR + path.sep) || rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return next();
  return sendStaticFile(req, res, next, abs, req.query.v ? LONG_CACHE : 'public, max-age=300, must-revalidate');
});
app.use('/libs', express.static(LIBS_DIR, { dotfiles: 'deny', index: false })); // fallback (directories, odd requests)
// Production application bundle. When app-compiled.min.js exists AND was built from the current app-compiled.js (checked by hash,
// not by file date) the minified file is sent under the same URL; otherwise the readable source is sent. Either way nothing else changes.
let _bundleCheck = { mtime: 0, size: 0, hash: '' };
function appBundlePath() {
  const src = path.join(__dirname, 'app-compiled.js'), min = path.join(__dirname, 'app-compiled.min.js');
  try {
    const st = fs.statSync(src); const sm = fs.statSync(min);
    if (_bundleCheck.mtime !== st.mtimeMs || _bundleCheck.size !== st.size) _bundleCheck = { mtime: st.mtimeMs, size: st.size, hash: nodeCrypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16) };
    const fd = fs.openSync(min, 'r'); const head = Buffer.alloc(64); fs.readSync(fd, head, 0, 64, 0); fs.closeSync(fd);
    if (sm.size > 1000 && head.toString('latin1').includes('src:' + _bundleCheck.hash)) return min;
    if (!appBundlePath.warned) { appBundlePath.warned = true; log.warn('[static] app-compiled.min.js does not match app-compiled.js - serving the readable source. Rebuild it (tools/build-min.js) or delete app-compiled.min.js'); }
  } catch (e) { /* no minified build */ }
  return src;
}
app.get('/app-compiled.js', (req, res, next) => sendStaticFile(req, res, next, appBundlePath(), req.query.v ? APP_CACHE : 'no-cache'));
// Production HTML: always revalidated (ETag -> 304 when unchanged) so a deployment is picked up at once.
// Served through getRenderedIndex(), not sendStaticFile(), because the app-compiled.js ?v= cache-buster
// inside it is rewritten live from the bundle's own content hash - see getRenderedIndex() above.
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    const { html, htmlMtime, bundleHash } = getRenderedIndex();
    const etag = `"idx-${htmlMtime.toString(16)}-${bundleHash}"`;
    res.set({ 'Cache-Control': 'no-cache', ETag: etag, 'Content-Type': 'text/html; charset=utf-8' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return req.method === 'HEAD' ? res.end() : res.end(html);
  } catch (e) { return next(e); }
});
// Login-page background video + poster (public on purpose: the login screen is shown before sign-in).
app.use('/media', express.static(path.join(__dirname, 'media'), { dotfiles: 'deny', index: false, maxAge: '7d' }));

// ===== Material Movements: DC/Invoice document storage =====
// Uploaded files are optional — an Inward/Outward record can be saved with
// no document at all. When present, they're stored on disk (not in MySQL)
// under ./uploads/movements, with only the generated filename kept in the DB.
const MOVEMENTS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'movements');
fs.mkdirSync(MOVEMENTS_UPLOAD_DIR, { recursive: true });
const movementUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MOVEMENTS_UPLOAD_DIR),
    // server-generated name only; the extension is already limited to the allow-list by fileFilter and is forced to lower case
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || '').toLowerCase()}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per DC/Invoice file
  fileFilter: (req, file, cb) => {
    const problem = uploadNameProblem(file.originalname, file.mimetype); // extension allow-list + double-extension + declared MIME type
    if (problem) { log.warn(`[upload] rejected "${sanitizeUploadName(file.originalname)}": ${problem}`); return cb(uploadError(problem)); }
    cb(null, true);
  },
});

// MySQL Connection Pool (created after the database itself is ensured to exist)
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306, // was previously unread by mysql2 -- DB_PORT in .env silently had no effect
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};
const DB_NAME = process.env.DB_NAME || 'datacenter_db';
let pool;

// Create the database first (without selecting one), then open the pool on it
async function ensureDatabase() {
  let conn;
  try {
    conn = await mysql.createConnection(DB_CONFIG);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.end();
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    throw new Error(`MySQL is unavailable at ${DB_CONFIG.host}. Start MySQL and verify DB_HOST/DB_USER/DB_PASSWORD in .env. (${detail})`);
  }
  pool = mysql.createPool({
    ...DB_CONFIG,
    database: DB_NAME,
    waitForConnections: true,
    // PERF: a single dashboard load already fires ~10 list queries at once;
    // 10 total connections meant one user's page load could exhaust the pool
    // and start queuing everyone else. Raised so a couple of concurrent users
    // opening the dashboard don't stall each other. Override via .env
    // (DB_POOL_SIZE) if your MySQL's max_connections needs a lower cap.
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 25,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });
  wrapPoolForTiming(pool); // PHASE-2: slow-query logging
}

// Test DB connection
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    log.info('✓ MySQL connected');
    conn.release();
    return true;
  } catch (e) {
    log.error('✗ MySQL connection failed:', e.message);
    log.error('  Make sure MySQL is running and DB_PASSWORD in .env is correct.');
    return false;
  }
}

// MySQL-safe index creation helper
async function createIndexIfNotExists(conn, indexName, tableName, columns) {
  try {
    await conn.query(`CREATE INDEX ${indexName} ON ${tableName} (${columns})`);
  } catch (e) {
    if (e.code === 'ER_DUP_KEYNAME' || e.message.includes('Duplicate key name')) {
      // Index already exists, ignore
    } else {
      throw e;
    }
  }
}

// Production-hardening helper: some live installs carry columns left over
// from an earlier, abandoned version of a table's schema - e.g. a field
// that was later renamed (a `component_type` column from before it became
// `hardware_type`/`rack_type`) or dropped from the app's design. Neither
// `CREATE TABLE IF NOT EXISTS` nor the `ADD COLUMN` backfills above can ever
// touch a column like that, because it already exists under a name the app
// no longer writes to. If that leftover column is NOT NULL with no default,
// EVERY insert this app runs fails with "Field '<col>' doesn't have a
// default value", because the app's INSERT statements never mention it.
// This scans the live table for any column outside the app's own known
// column set that is still NOT NULL / no default / not auto-increment, and
// relaxes it to nullable - same type, same existing data, just no longer
// mandatory - so a forgotten legacy column can never block a new row again.
async function relaxLegacyRequiredColumns(conn, tableName, knownColumns) {
  try {
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_TYPE
       FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    for (const col of cols) {
      const name = col.COLUMN_NAME;
      if (knownColumns.has(name)) continue;
      const isAutoIncrement = /auto_increment/i.test(col.EXTRA || '');
      if (col.IS_NULLABLE === 'NO' && col.COLUMN_DEFAULT === null && !isAutoIncrement) {
        try {
          await conn.query(`ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${name}\` ${col.COLUMN_TYPE} NULL`);
          log.info(`  ⚠ ${tableName}.${name}: legacy required column no longer used by this app version - relaxed to nullable so it can't block inserts.`);
        } catch (e) {
          log.error(`  ✗ Could not relax legacy column ${tableName}.${name}:`, e.message);
        }
      }
    }
  } catch (e) {
    // information_schema lookup failed (permissions, etc.) - non-fatal, leave schema as-is
    log.error(`  ✗ Legacy-column scan failed for ${tableName}:`, e.message);
  }
}

// Initialize database tables
async function initDB() {
  let conn;
  try {
    conn = await pool.getConnection();
    // Create database if not exists
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE ${process.env.DB_NAME || 'datacenter_db'}`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role ENUM('Admin','Operator','Viewer') DEFAULT 'Viewer',
        location_access VARCHAR(50) DEFAULT 'All',
        status ENUM('Active','Inactive') DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Sample/demo data (Sample Site A/B and everything seeded under them) is
    // for a brand-new install only - computed once, here, right after the
    // users table exists, so every seed block below (locations/zones as
    // well as assets/issues/activities/movements further down) can gate on
    // it. Without this, a customer who deleted the demo locations entirely
    // to start clean with their own sites would see "Sample Site A"/
    // "Sample Site B" silently reappear on the next restart.
    const SEED_SAMPLE = String(process.env.SEED_SAMPLE_DATA === undefined ? '1' : process.env.SEED_SAMPLE_DATA).trim() !== '0';   // SEED_SAMPLE_DATA=0 in .env: production install with no demo sites/assets/accounts
    const freshInstall = (await conn.query('SELECT COUNT(*) as cnt FROM users'))[0][0].cnt === 0 && SEED_SAMPLE;

    await conn.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id VARCHAR(50) PRIMARY KEY,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) DEFAULT 'AZ-1',
        rack_type VARCHAR(50),
        rack_no VARCHAR(20),
        position VARCHAR(20),
        hardware_type VARCHAR(50),
        height VARCHAR(10),
        manufacturer VARCHAR(50),
        model VARCHAR(150),
        serial_number VARCHAR(150) UNIQUE,
        installation_date DATE,
        asset_tag VARCHAR(100) UNIQUE,
        mgmt_ip VARCHAR(255),
        firmware VARCHAR(100),
        device_name VARCHAR(150),
        remarks TEXT,
        lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'Active',
        custody_location VARCHAR(100),
        last_known_site VARCHAR(50),
        last_known_zone VARCHAR(50),
        last_known_rack VARCHAR(50),
        last_known_position VARCHAR(50),
        last_movement_at DATETIME NULL,
        last_movement_reason VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Asset Lifecycle / Movement History. This is deliberately separate from
    // the current-state assets table so the existing 1,400+ imported assets and
    // the existing Asset Import template remain valid and untouched.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS asset_movements (
        id VARCHAR(50) PRIMARY KEY,
        asset_id VARCHAR(50) NOT NULL,
        serial_number VARCHAR(150),
        movement_type VARCHAR(40) NOT NULL,
        from_site VARCHAR(50),
        from_zone VARCHAR(50),
        from_rack_no VARCHAR(50),
        from_position VARCHAR(50),
        to_site VARCHAR(50),
        to_zone VARCHAR(50),
        to_rack_no VARCHAR(50),
        to_position VARCHAR(50),
        movement_date DATETIME NOT NULL,
        reason VARCHAR(255),
        reference_no VARCHAR(100),
        performed_by VARCHAR(100),
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_asset_movements_asset (asset_id),
        KEY idx_asset_movements_serial (serial_number),
        KEY idx_asset_movements_date (movement_date),
        KEY idx_asset_movements_from_site (from_site),
        KEY idx_asset_movements_to_site (to_site)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS issues (
        id VARCHAR(50) PRIMARY KEY,
        ticket_no VARCHAR(50),
        asset_id VARCHAR(50),
        asset_type VARCHAR(30),
        site VARCHAR(50),
        zone VARCHAR(20) DEFAULT 'AZ-1',
        rack_no VARCHAR(20),
        u_position VARCHAR(20),
        location_detail VARCHAR(200),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        severity ENUM('critical','warning','info') DEFAULT 'warning',
        part_required BOOLEAN DEFAULT FALSE,
        part_name VARCHAR(200),
        reported_date DATETIME,
        diagnosed_date DATETIME,
        received_date DATETIME,
        scheduled_date DATETIME,
        completed_date DATETIME,
        moved_to_store_date DATETIME,
        returned_to_oem_date DATETIME,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // DC Activity log: Rack/Stacking, Cabling, Firmware Update, UPS Drill, etc.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dc_activities (
        id VARCHAR(50) PRIMARY KEY,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) DEFAULT 'AZ-1',
        hardware_type VARCHAR(50),
        activity_type VARCHAR(50) NOT NULL,
        description TEXT,
        start_date DATE,
        completion_date DATE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Material Movements: Inward/Outward log for items moving in and out of
    // the DC (spares, replacement parts, courier drop-offs, RMA pickups,
    // etc.), with an optional DC/Invoice document attached per record.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS material_movements (
        id VARCHAR(50) PRIMARY KEY,
        movement_type ENUM('Inward','Outward') NOT NULL,
        site VARCHAR(50) NOT NULL,
        item_name VARCHAR(200) NOT NULL,
        description TEXT,
        quantity INT DEFAULT 1,
        unit VARCHAR(20),
        receiver_name VARCHAR(100),
        sender_name VARCHAR(100),
        dc_invoice_no VARCHAR(100),
        dc_invoice_file VARCHAR(255),
        dc_invoice_original_name VARCHAR(255),
        movement_date DATE,
        remarks TEXT,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await createIndexIfNotExists(conn, 'idx_movements_site', 'material_movements', 'site');
    await createIndexIfNotExists(conn, 'idx_movements_type', 'material_movements', 'movement_type');
    await createIndexIfNotExists(conn, 'idx_movements_date', 'material_movements', 'movement_date');

    // Locations (DCs): the sites the whole app operates across. Seeded with
    // two generic sample locations as a starting point; rename, remove, or
    // add new ones later via DC Capacity → "Add Location" without any
    // further schema change.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        status VARCHAR(20) NOT NULL DEFAULT 'Active',
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        archived_at DATETIME NULL,
        archived_by VARCHAR(100) NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [locRows] = await conn.query('SELECT COUNT(*) as cnt FROM locations');
    if (freshInstall && locRows[0].cnt === 0) {
      await conn.query('INSERT IGNORE INTO locations (id, name, created_by) VALUES (?,?,?)', ['LOC-SITE-A', 'Sample Site A', 'System']);
      await conn.query('INSERT IGNORE INTO locations (id, name, created_by) VALUES (?,?,?)', ['LOC-SITE-B', 'Sample Site B', 'System']);
    }

    // Rack types: the catalog used everywhere a rack-type dropdown appears
    // (Add Rack, Add/Edit Asset, Asset Inventory filter). Seeded with the
    // set the app always shipped with; new ones can be added inline from
    // the Add Rack form.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS rack_types (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [rackTypeRows] = await conn.query('SELECT COUNT(*) as cnt FROM rack_types');
    if (rackTypeRows[0].cnt === 0) {
      const defaults = ['COMP-1','COMP-2','COMP-3','COMP-4','COMP-5','COMP-6','COMP-7','Storage','Network','Object-Storage','MGMT','PAAS-1','PAAS-2','BACKUP','SAN-1','SAN-2','TapeLibrary'];
      for (const t of defaults) {
        await conn.query('INSERT IGNORE INTO rack_types (id, name, created_by) VALUES (?,?,?)', [`RT-${t.replace(/[^A-Za-z0-9]/g,'')}`, t, 'System']);
      }
    }
    // Structural marker types (physical pillar/column, or a deliberately
    // reserved gap on the floor) — ensured unconditionally (not just on a
    // fresh install) so existing deployments pick them up automatically
    // without an admin having to type them in via "+ Add new rack type…".
    for (const t of ['Pillar', 'Empty Space']) {
      try { await conn.query('INSERT IGNORE INTO rack_types (id, name, created_by) VALUES (?,?,?)', [`RT-${t.replace(/[^A-Za-z0-9]/g,'')}`, t, 'System']); } catch (e) { /* best effort */ }
    }

    // Hardware types: the catalog used everywhere a hardware-type dropdown appears
    // (Add/Edit Asset, Asset Inventory filter, DC Activity). Seeded with the
    // set the app always shipped with; new ones can be added inline from
    // the Add Asset form.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS hardware_types (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [hwTypeRows] = await conn.query('SELECT COUNT(*) as cnt FROM hardware_types');
    if (hwTypeRows[0].cnt === 0) {
      const defaults = ['DellServer','HPServer','Storage','Backup','Switch','Firewall','LoadBalancer','HSM','Tape Library','PDU','Rack','ATS','Others'];
      for (const t of defaults) {
        await conn.query('INSERT IGNORE INTO hardware_types (id, name, created_by) VALUES (?,?,?)', [`HT-${t.replace(/[^A-Za-z0-9]/g,'')}`, t, 'System']);
      }
    }

    // Zones: planned availability zones per site, created ahead of any assets
    // being racked in them (DC Capacity → "Add Zone").
    await conn.query(`
      CREATE TABLE IF NOT EXISTS zones (
        id VARCHAR(50) PRIMARY KEY,
        site VARCHAR(50) NOT NULL,
        zone_name VARCHAR(50) NOT NULL,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_site_zone (site, zone_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Racks: planned rack slots per zone, created ahead of any devices being
    // installed in them (DC Capacity → "Add Rack"). Shows up as an empty
    // tile on the Rack Map / Rack Layout viewer until assets reference it.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS racks (
        id VARCHAR(50) PRIMARY KEY,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(50) NOT NULL DEFAULT 'AZ-1',
        rack_no VARCHAR(20) NOT NULL,
        rack_type VARCHAR(50),
        u_size INT DEFAULT 42,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_site_zone_rack (site, zone, rack_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Floor plan canvas: one JSON blob per (site, zone) holding rack drag
    // positions, cold/hot aisle bands, Entry/Exit/Boundary lines, cages, and
    // electrical (MCP/PDU) items placed in Floor View's "Edit Floor View"
    // mode. Server-side (not localStorage) so every user on every device
    // sees the same floor plan.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS floor_plans (
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(50) NOT NULL,
        data LONGTEXT,
        updated_by VARCHAR(100),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (site, zone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Concurrent Floor View editing: one active editor per site + zone.
    // Locks are ephemeral and deliberately NOT part of backups.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS floor_plan_locks (
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(50) NOT NULL,
        lock_token VARCHAR(120) NOT NULL,
        user_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        user_name VARCHAR(150) NOT NULL,
        acquired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        PRIMARY KEY (site, zone),
        KEY idx_floor_lock_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Admin settings (backup on/off + folder, last run ...). Never included in backups, so restoring can't overwrite a server's own folder.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        k VARCHAR(100) NOT NULL PRIMARY KEY,
        v TEXT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // PHASE-1: audit trail. Never part of backups/restores, so restoring data can not erase the history of who restored it.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id INT NULL,
        username VARCHAR(100),
        role VARCHAR(20),
        action VARCHAR(60) NOT NULL,
        entity_type VARCHAR(50),
        entity_id VARCHAR(100),
        site VARCHAR(50),
        status ENUM('success','failure') NOT NULL DEFAULT 'success',
        ip_address VARCHAR(64),
        user_agent VARCHAR(255),
        details TEXT,
        KEY idx_audit_created (created_at),
        KEY idx_audit_user (username, created_at),
        KEY idx_audit_action (action, created_at),
        KEY idx_audit_entity (entity_type, entity_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Seed the two zones the app always shipped with, for both sites, so
    // existing installs keep working unchanged once this table exists.
    const [zoneRows] = await conn.query('SELECT COUNT(*) as cnt FROM zones');
    if (freshInstall && zoneRows[0].cnt === 0) {
      const seedSites = (await conn.query('SELECT name FROM locations'))[0].map(r => r.name);
      for (const site of seedSites) {
        for (const zn of ['AZ-1', 'AZ-2']) {
          await conn.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [`ZN-${site.slice(0,3).toUpperCase()}-${zn}`, site, zn, 'System']);
        }
      }
    }

    // Asset inventory Remarks field (backward-compatible migration for existing installs)
    try { await conn.query('ALTER TABLE assets ADD COLUMN remarks TEXT'); } catch (e) { /* column already exists */ }

    // Direct-to-BMC Redfish fields (vendor-agnostic hardware monitoring - any
    // brand with a Redfish-capable BMC: Dell iDRAC, HPE iLO, Lenovo XCC, Cisco
    // standalone IMC, NVIDIA DGX, etc.). Reuses the existing mgmt_ip column as
    // the BMC address. redfish_password is stored the same way PDU
    // snmp_community already is (plain, local-network credential, consistent
    // with this app's existing out-of-band-management credential handling -
    // not a user password). health_status/power_state/bmc_firmware reflect
    // live BMC state and are overwritten on every sync (unlike vendor/model/
    // serial/firmware, which stay COALESCE-protected like every other
    // auto-fill in this app and are never silently overwritten).
    try { await conn.query('ALTER TABLE assets ADD COLUMN redfish_username VARCHAR(100)'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN redfish_password VARCHAR(255)'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN redfish_port INT DEFAULT 443'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN redfish_version VARCHAR(20)'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN bmc_firmware VARCHAR(100)'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN health_status VARCHAR(20)'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN power_state VARCHAR(20)'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN last_redfish_sync_at DATETIME NULL'); } catch (e) { /* already exists */ }
    try { await conn.query('ALTER TABLE assets ADD COLUMN last_redfish_error VARCHAR(255)'); } catch (e) { /* already exists */ }
    // Count of sensors (temperatures/fans) reporting Health != OK, plus the
    // overall Status.Health itself if it's not OK - the Redfish-side
    // equivalent of the critical/warning counts already shown for OME/
    // OneView devices. Always reflects the latest poll (live state), same
    // as health_status/power_state above - never COALESCE-protected.
    try { await conn.query('ALTER TABLE assets ADD COLUMN redfish_alert_count INT NULL'); } catch (e) { /* already exists */ }

    // ---- Widen id columns (VARCHAR(20) -> VARCHAR(50)) ----
    // Bulk-upsert generates IDs like AST-<13-digit timestamp>-<batch index>,
    // which can exceed 20 chars and fail with "Data too long for column 'id'".
    try { await conn.query('ALTER TABLE assets MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE issues MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE dc_activities MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE material_movements MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE locations MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query("ALTER TABLE locations ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'Active'"); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE locations ADD COLUMN archived_at DATETIME NULL'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE locations ADD COLUMN archived_by VARCHAR(100) NULL'); } catch (e) { /* column already exists */ }
    try { await conn.query("UPDATE locations SET status='Active' WHERE status IS NULL OR TRIM(status)=''"); } catch (e) { /* best effort */ }
    try { await conn.query('ALTER TABLE zones MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE racks MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    // ---- Physical rack footprint (Floor View custom rack size) ----
    // w_tiles/h_tiles are the footprint in 600mm floor tiles (DECIMAL since
    // e.g. an 800mm-wide rack is 1.33 tiles); width_mm/depth_mm keep the
    // real-world size the admin entered so the tile count can be re-derived.
    try { await conn.query('ALTER TABLE racks ADD COLUMN w_tiles DECIMAL(5,2) DEFAULT 1'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE racks ADD COLUMN h_tiles DECIMAL(5,2) DEFAULT 2'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE racks ADD COLUMN width_mm INT DEFAULT 600'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE racks ADD COLUMN depth_mm INT DEFAULT 1200'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE rack_types MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE hardware_types MODIFY id VARCHAR(50)'); } catch (e) { /* already migrated */ }
    // ---- Widen user-entered text columns for larger import values ----
    try { await conn.query('ALTER TABLE assets MODIFY serial_number VARCHAR(150)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE assets MODIFY asset_tag VARCHAR(100)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE assets MODIFY device_name VARCHAR(150)'); } catch (e) { /* already migrated */ }
    try { await conn.query('ALTER TABLE assets MODIFY model VARCHAR(150)'); } catch (e) { /* already migrated */ }
    // Management IP may contain multiple addresses and a device/location label (e.g. IP1/IP2/IP3/DEVICE_NAME).
    // Widen the field so bulk upload preserves the complete value without MySQL truncation errors.
    try { await conn.query('ALTER TABLE assets MODIFY mgmt_ip VARCHAR(255)'); } catch (e) { /* already migrated */ }

    // ---- Widen columns that were narrower than the data they receive ----
    // e.g. issues.asset_id (50) holds assets.serial_number (150); assets.zone (20) vs zones (50).
    // Without this a longer imported value fails with "Data too long" and rolls back the whole import chunk.
    for (const stmt of [
      "ALTER TABLE assets MODIFY zone VARCHAR(50) DEFAULT 'AZ-1'",
      "ALTER TABLE assets MODIFY rack_no VARCHAR(50)",
      "ALTER TABLE assets MODIFY position VARCHAR(50)",
      "ALTER TABLE assets MODIFY height VARCHAR(20)",
      "ALTER TABLE assets MODIFY manufacturer VARCHAR(150)",
      "ALTER TABLE assets MODIFY firmware VARCHAR(255)",
      "ALTER TABLE issues MODIFY asset_id VARCHAR(150)",
      "ALTER TABLE issues MODIFY zone VARCHAR(50) DEFAULT 'AZ-1'",
      "ALTER TABLE issues MODIFY rack_no VARCHAR(50)",
      "ALTER TABLE issues MODIFY u_position VARCHAR(50)",
      "ALTER TABLE dc_activities MODIFY zone VARCHAR(50) DEFAULT 'AZ-1'",
      "ALTER TABLE racks MODIFY rack_no VARCHAR(50) NOT NULL",
    ]) {
      try { await conn.query(stmt); } catch (e) { log.warn('Column widen skipped:', stmt, '-', e.message); }
    }

    // Material movements no longer carry a Zone (it was never meaningful for stock movements).
    // Drop the legacy column from existing databases; a no-op once it is gone.
    try {
      const [mvZone] = await conn.query(`SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'material_movements' AND COLUMN_NAME = 'zone'`);
      if (mvZone.length) { await conn.query('ALTER TABLE material_movements DROP COLUMN zone'); log.info('✓ material_movements.zone column removed'); }
    } catch (e) { log.warn('material_movements.zone drop skipped:', e.message); }

    // ---- Migrations for existing databases ----
    // location_access used to be a fixed ENUM('Both','Chennai Only','Manesar
    // Only'). It's now a free-form VARCHAR storing either 'All' or the exact
    // name of one location, so any number of locations can be added later.
    try { await conn.query("ALTER TABLE users MODIFY location_access VARCHAR(50) DEFAULT 'All'"); } catch (e) { /* already migrated */ }
    try { await conn.query("UPDATE users SET location_access='All' WHERE location_access='Both'"); } catch (e) { /* n/a */ }
    try { await conn.query("UPDATE users SET location_access='Chennai' WHERE location_access='Chennai Only'"); } catch (e) { /* n/a */ }
    try { await conn.query("UPDATE users SET location_access='Manesar' WHERE location_access='Manesar Only'"); } catch (e) { /* n/a */ }
    // Issues are now tracked by SERIAL NUMBER instead of asset tag.
    // 1) Drop the old FK on asset_tag (ignore error if already dropped)
    try { await conn.query('ALTER TABLE issues DROP FOREIGN KEY fk_issue_asset'); } catch (e) { /* no such FK */ }
    // 2) Convert existing asset_id values from asset tag to serial number
    try {
      await conn.query(`UPDATE issues i JOIN assets a ON i.asset_id = a.asset_tag SET i.asset_id = a.serial_number WHERE i.asset_id IS NOT NULL AND i.asset_id != '' AND a.serial_number IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets s WHERE s.serial_number = i.asset_id)`);
    } catch (e) { /* best effort */ }

    // Migrate existing issues date columns from DATE to DATETIME if needed
    const dateCols = ['reported_date','diagnosed_date','received_date','scheduled_date','completed_date','moved_to_store_date','returned_to_oem_date'];
    for (const col of dateCols) {
      try { await conn.query(`ALTER TABLE issues MODIFY ${col} DATETIME`); } catch(e) { /* already DATETIME or other error */ }
    }

    // Add faulty-part-logistics columns for databases created before this feature existed
    try { await conn.query('ALTER TABLE issues ADD COLUMN moved_to_store_date DATETIME'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE issues ADD COLUMN returned_to_oem_date DATETIME'); } catch (e) { /* column already exists */ }

    // Tracks whether an asset's firmware column was last written by the
    // Monitoring firmware-sync ('api') or by a person via Add Asset/Edit
    // Asset/bulk import ('manual'). Drives the green-vs-default coloring on
    // the Asset Inventory page. Defaults to 'manual' for every existing row —
    // there's no way to know retroactively how today's values got there.
    try { await conn.query("ALTER TABLE assets ADD COLUMN firmware_source VARCHAR(10) DEFAULT 'manual'"); } catch (e) { /* column already exists */ }

    // Recently Added / Recently Modified (Asset Inventory) needs real
    // modification tracking — assets had created_at but nothing for edits.
    // Same ON UPDATE CURRENT_TIMESTAMP pattern already used on floor_plans
    // and firmware_targets; updated_by is set explicitly by each write path
    // below (the DB can't know who made the change, only when).
    try { await conn.query("ALTER TABLE assets ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN updated_by VARCHAR(100)"); } catch (e) { /* column already exists */ }
    // This was missing entirely — /api/assets/recent's SELECT referenced
    // created_by, but assets never had this column, so every call to that
    // route has been throwing a SQL error (silently swallowed on the
    // frontend). Adding the column for real, and wiring it into the create
    // paths below, not just removing the broken reference.
    try { await conn.query("ALTER TABLE assets ADD COLUMN created_by VARCHAR(100)"); } catch (e) { /* column already exists */ }
    // Which column(s) actually changed on the last edit — powers the
    // "Changes Made" column in Recently Modified. A human-readable
    // comma-separated list of field labels, not a structured diff — good
    // enough for "what changed at a glance", not meant for programmatic use.
    try { await conn.query("ALTER TABLE assets ADD COLUMN changed_fields VARCHAR(255)"); } catch (e) { /* column already exists */ }
    // Asset lifecycle fields — backward compatible with every existing asset/import.
    try { await conn.query("ALTER TABLE assets ADD COLUMN lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'Active'"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN custody_location VARCHAR(100)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN last_known_site VARCHAR(50)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN last_known_zone VARCHAR(50)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN last_known_rack VARCHAR(50)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN last_known_position VARCHAR(50)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN last_movement_at DATETIME NULL"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE assets ADD COLUMN last_movement_reason VARCHAR(255)"); } catch (e) { /* column already exists */ }
    try { await conn.query("UPDATE assets SET lifecycle_status='Active' WHERE lifecycle_status IS NULL OR lifecycle_status=''"); } catch (e) { /* best effort */ }
    try { await conn.query("UPDATE assets SET last_known_site=site, last_known_zone=zone, last_known_rack=rack_no, last_known_position=position WHERE last_known_site IS NULL AND site IS NOT NULL"); } catch (e) { /* best effort */ }

    // Multi-file DC/Invoice uploads for Material Movements — the old
    // dc_invoice_file/dc_invoice_original_name single-file columns on
    // material_movements stay untouched (existing uploaded files keep
    // working), new uploads go into this table instead so a movement can
    // have more than one attached document.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS material_movement_documents (
        id VARCHAR(50) PRIMARY KEY,
        movement_id VARCHAR(50) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        uploaded_by VARCHAR(100),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Live login tracking — heartbeat-based, since auth is stateless JWT
    // with no server-side session concept at all today. last_seen_at is
    // bumped by a lightweight heartbeat call from the frontend while the
    // app is open; "online now" is derived as last_seen_at within the last
    // few minutes, not a true persistent-connection concept.
    try { await conn.query('ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMP NULL'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL'); } catch (e) { /* column already exists */ }
    // One active browser session per user: the id of the session that is currently allowed. A new login replaces it, which signs the older browser out.
    try { await conn.query('ALTER TABLE users ADD COLUMN session_id VARCHAR(64) NULL'); } catch (e) { /* column already exists */ }
    // HARDENING: forced change of seeded/default passwords (additive columns; existing users default to 0 = nothing changes for them)
    try { await conn.query('ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) { /* column already exists */ }
    try { await conn.query('ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL'); } catch (e) { /* column already exists */ }

    // Admin-declared "current firmware version being pushed" per vendor —
    // deliberately a manual value, not derived from an OME/OneView baseline
    // API (whose target-version field shape isn't confirmed). This is what
    // the Monitoring page's Latest/Outdated counts compare each device's
    // System ROM against. Starts empty; until an admin sets it, Latest/
    // Outdated has nothing to compare against and the UI says so rather than
    // guessing.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS firmware_targets (
        vendor VARCHAR(20) PRIMARY KEY,
        target_version VARCHAR(255),
        updated_by VARCHAR(100),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Manual BIOS targets by vendor + model. The target is intentionally
    // independent of Dell OME / HPE OneView baselines or catalog releases.
    // OME/OneView provide the installed System ROM; this table stores the
    // operator-approved target BIOS for each hardware model.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS firmware_model_targets (
        vendor VARCHAR(20) NOT NULL,
        model_key VARCHAR(200) NOT NULL,
        model_name VARCHAR(200) NOT NULL,
        target_version VARCHAR(255) NOT NULL,
        updated_by VARCHAR(100),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (vendor, model_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Firmware update jobs started from Monitoring (one row per server). Lets the Firmware Update Jobs panel and the
    // "already in progress" check survive a page refresh, a log-out/in and a service restart.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS firmware_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        vendor VARCHAR(20) NOT NULL,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(50) NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        device_name VARCHAR(255),
        serial VARCHAR(100),
        job_ref TEXT,
        task_uri VARCHAR(255),
        baseline_id VARCHAR(500),
        baseline_label VARCHAR(500),
        started_by VARCHAR(100),
        started_at BIGINT NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'Running',
        percent INT NULL,
        step TEXT,
        error TEXT,
        updated_at BIGINT,
        finished_at BIGINT NULL,
        INDEX idx_fwjobs_lookup (vendor, site, zone, state),
        INDEX idx_fwjobs_device (vendor, site, zone, device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    for (const ddl of ["ALTER TABLE firmware_jobs ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'dcim'", 'ALTER TABLE firmware_jobs ADD COLUMN job_name VARCHAR(255) NULL']) {
      try { await conn.query(ddl); } catch (e) { /* column already exists */ }
    }
    try { await conn.query('DELETE FROM firmware_jobs WHERE started_at < ?', [Date.now() - 14 * 24 * 3600 * 1000]); } catch (e) { /* housekeeping only */ }

    // Consolidate hardware types that differ only by case (e.g. "DellServer",
    // "Dellserver", "DELLServer" from data entered before normalization was
    // added, or from a direct SQL import). Runs on every startup, but is a
    // no-op once the catalog is clean. For each group of names that are
    // identical case-insensitively: keep the entry already used by the most
    // assets as canonical (ties broken by earliest created), repoint every
    // asset row using any of the other variants to that canonical spelling,
    // and remove the now-unused duplicate hardware_types rows.
    try {
      const [allTypes] = await conn.query('SELECT id, name, created_at FROM hardware_types');
      const groups = {};
      for (const t of allTypes) {
        const key = t.name.toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(t);
      }
      for (const key in groups) {
        const variants = groups[key];
        if (variants.length < 2) continue; // nothing to merge
        const usageCounts = await Promise.all(variants.map(async (v) => {
          const [[{ cnt }]] = await conn.query('SELECT COUNT(*) as cnt FROM assets WHERE hardware_type = ?', [v.name]);
          return { ...v, cnt };
        }));
        usageCounts.sort((a, b) => (b.cnt - a.cnt) || (new Date(a.created_at) - new Date(b.created_at)));
        const canonical = usageCounts[0];
        const duplicates = usageCounts.slice(1);
        for (const dup of duplicates) {
          await conn.query('UPDATE assets SET hardware_type = ? WHERE hardware_type = ?', [canonical.name, dup.name]);
          await conn.query('UPDATE dc_activities SET hardware_type = ? WHERE hardware_type = ?', [canonical.name, dup.name]);
          await conn.query('DELETE FROM hardware_types WHERE id = ?', [dup.id]);
        }
        log.info(`✓ Merged hardware type variants [${duplicates.map(d => d.name).join(', ')}] into "${canonical.name}"`);
      }
    } catch (e) { log.error('Hardware type consolidation skipped:', e.message); }

    // Bring existing assets to the one canonical U format (idempotent; set NORMALIZE_U_FORMAT=off to skip)
    try { const fixedU = await normalizeAllUFormat(conn); if (fixedU) log.info(`✓ Normalized U position / height format on ${fixedU} asset(s)`); } catch (e) { log.warn('U format normalization skipped:', e.message); }

    // Create indexes (MySQL-safe)
    await createIndexIfNotExists(conn, 'idx_assets_site', 'assets', 'site');
    await createIndexIfNotExists(conn, 'idx_assets_hardware', 'assets', 'hardware_type');
    await createIndexIfNotExists(conn, 'idx_issues_site', 'issues', 'site');
    await createIndexIfNotExists(conn, 'idx_issues_asset', 'issues', 'asset_id');
    await createIndexIfNotExists(conn, 'idx_issues_severity', 'issues', 'severity');
    await createIndexIfNotExists(conn, 'idx_issues_status', 'issues', 'completed_date');
    await createIndexIfNotExists(conn, 'idx_zones_site', 'zones', 'site');
    await createIndexIfNotExists(conn, 'idx_racks_site_zone', 'racks', 'site, zone');
    await createIndexIfNotExists(conn, 'idx_locations_name', 'locations', 'name');
    await createIndexIfNotExists(conn, 'idx_rack_types_name', 'rack_types', 'name');
    await createIndexIfNotExists(conn, 'idx_hardware_types_name', 'hardware_types', 'name');
    // PERF: these were previously unindexed full-table scans on every
    // Activities / Material Movements list load (both queries ORDER BY these
    // columns), and idx_assets_hardware existed but nothing indexed rack_no,
    // which every U-conflict check (findUConflict) filters on directly.
    await createIndexIfNotExists(conn, 'idx_assets_rack', 'assets', 'site, zone, rack_no');
    await createIndexIfNotExists(conn, 'idx_activities_site', 'dc_activities', 'site');
    await createIndexIfNotExists(conn, 'idx_activities_dates', 'dc_activities', 'start_date, created_at');
    await createIndexIfNotExists(conn, 'idx_movements_site_alt', 'material_movements', 'site');
    // PHASE-1: additional composite indexes (idempotent; a failure here only skips that index and never blocks startup)
    for (const [ix, tbl, cols] of [
      ['idx_assets_site_zone_hw', 'assets', 'site, zone, hardware_type'],   // dashboard / monitoring / power-summary filters
      ['idx_assets_lifecycle', 'assets', 'lifecycle_status'],               // lifecycle (Active / In Store / ...) filters
      ['idx_issues_site_status', 'issues', 'site, completed_date'],         // open-issue counts per site
      ['idx_issues_reported', 'issues', 'reported_date'],                   // list ordering
      ['idx_activities_site_zone', 'dc_activities', 'site, zone'],          // activity list per zone
      ['idx_activities_type', 'dc_activities', 'activity_type'],            // activity-type filter
      ['idx_movements_site_date', 'material_movements', 'site, movement_date'], // list ordered by date per site
      ['idx_asset_movements_asset_date', 'asset_movements', 'asset_id, movement_date'], // "latest movement per asset" sub-query of the lifecycle list
    ]) {
      try { await createIndexIfNotExists(conn, ix, tbl, cols); } catch (e) { log.warn(`Index ${ix} skipped:`, e.message); }
    }

    // ----- Rack components (Patch Panel / Cable Manager / LIU / STS-ATS / passive items) -----
    // hardware_types gets a `category` so the UI can tell a passive rack
    // component (no model/serial/manufacturer, auto-placed, excluded from the
    // "Devices" count but still counted toward rack U capacity) apart from a
    // normal active device — and a `default_height` used to prefill the Add
    // Asset form's Height field for that type.
    try { await conn.query("ALTER TABLE hardware_types ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'Device'"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE hardware_types ADD COLUMN default_height VARCHAR(10) DEFAULT NULL"); } catch (e) { /* column already exists */ }
    const DEFAULT_COMPONENT_TYPES = [
      ['Patch Panel', '1U'],
      ['Cable Manager', '1U'],
      ['LIU', '1U'],
      ['STS/ATS', '1U'],
      ['Other', '1U'],
    ];
    for (const [name, height] of DEFAULT_COMPONENT_TYPES) {
      try {
        // Only seeded the first time this name doesn't exist yet — never
        // silently recategorize a name the site may already be using as a
        // normal device.
        const [existing] = await conn.query('SELECT id FROM hardware_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [name]);
        if (existing.length === 0) {
          await conn.query(
            'INSERT INTO hardware_types (id, name, category, default_height, created_by) VALUES (?,?,?,?,?)',
            [genId('HT'), name, 'Component', height, 'System']
          );
        }
      } catch (e) { log.warn(`Rack component hardware type "${name}" seed skipped:`, e.message); }
    }

    // Rack components now live in their own table, separate from `assets`.
    // They have no serial number, so their human-readable identity is an
    // auto-generated code instead: "<RackNo>-<TypeAbbrev>-<Seq>" (e.g.
    // "A04-PP-01"), unique per rack (site+zone+rack_no). Not counted as an
    // asset anywhere, but still counted toward rack U capacity alongside
    // `assets` (see findUConflict, which now checks both tables).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS rack_components (
        id VARCHAR(50) PRIMARY KEY,
        component_code VARCHAR(64) NOT NULL,
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) DEFAULT 'AZ-1',
        rack_type VARCHAR(50),
        rack_no VARCHAR(20) NOT NULL,
        position VARCHAR(20),
        hardware_type VARCHAR(50) NOT NULL,
        height VARCHAR(10),
        manufacturer VARCHAR(50),
        model VARCHAR(150),
        asset_tag VARCHAR(100),
        installation_date DATE,
        remarks TEXT,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_by VARCHAR(100),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        changed_fields TEXT,
        UNIQUE KEY uniq_component_code_per_rack (site, zone, rack_no, component_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await createIndexIfNotExists(conn, 'idx_rack_components_rack', 'rack_components', 'site, zone, rack_no');
    // Defensive column backfill: if `rack_components` already existed on this
    // database from an earlier/partial run (e.g. CREATE TABLE IF NOT EXISTS
    // above is a no-op against a pre-existing table), make sure every column
    // this code relies on is actually present - same try/catch-ignore pattern
    // used for every other table's additive migration in this file.
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN component_code VARCHAR(64) NOT NULL DEFAULT ''"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN site VARCHAR(50) NOT NULL DEFAULT ''"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN zone VARCHAR(20) DEFAULT 'AZ-1'"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN rack_type VARCHAR(50)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN rack_no VARCHAR(20) NOT NULL DEFAULT ''"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN position VARCHAR(20)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN hardware_type VARCHAR(50) NOT NULL DEFAULT ''"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN height VARCHAR(10)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN manufacturer VARCHAR(50)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN model VARCHAR(150)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN asset_tag VARCHAR(100)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN installation_date DATE"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN remarks TEXT"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN created_by VARCHAR(100)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN updated_by VARCHAR(100)"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"); } catch (e) { /* column already exists */ }
    try { await conn.query("ALTER TABLE rack_components ADD COLUMN changed_fields TEXT"); } catch (e) { /* column already exists */ }

    // Deep production validation: relax any leftover legacy NOT-NULL/no-default
    // column on every table this app writes to, so a stale field from an
    // earlier schema version (like the `component_type` column reported on a
    // live install) can never silently block an insert again, on any table -
    // not just the one that happened to get reported.
    // Server cable connectivity (one row per server serial number, from the cable-inventory sheets).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS asset_connectivity (
        id INT AUTO_INCREMENT PRIMARY KEY,
        serial_number VARCHAR(150) NOT NULL,
        site VARCHAR(50),
        zone VARCHAR(50),
        sheet_rack_no VARCHAR(40),
        sheet_u_position VARCHAR(40),
        category VARCHAR(255),
        ilo_ip VARCHAR(255),
        subnet_mask VARCHAR(255),
        gateway VARCHAR(255),
        ilo_cable TEXT,
        ilo_port TEXT,
        switch_sn_ip TEXT,
        data_cable TEXT,
        backup_cable TEXT,
        provisioning_cable TEXT,
        hbt_cable TEXT,
        replication_cable TEXT,
        storage_cable TEXT,
        storage_port TEXT,
        storage_blade TEXT,
        remarks TEXT,
        source_file VARCHAR(255),
        updated_by VARCHAR(100),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_connectivity_serial (serial_number),
        INDEX idx_connectivity_site (site)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Hardware details pulled from the appliance (Dell OME / HPE OneView), cached until someone clicks Sync now.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS asset_hw_details (
        serial_number VARCHAR(150) NOT NULL PRIMARY KEY,
        vendor VARCHAR(40),
        site VARCHAR(50),
        zone VARCHAR(50),
        data LONGTEXT,
        fetched_by VARCHAR(100),
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await relaxLegacyRequiredColumns(conn, 'rack_components', new Set(['id', 'component_code', 'site', 'zone', 'rack_type', 'rack_no', 'position', 'hardware_type', 'height', 'manufacturer', 'model', 'asset_tag', 'installation_date', 'remarks', 'created_by', 'created_at', 'updated_by', 'updated_at', 'changed_fields']));
    await relaxLegacyRequiredColumns(conn, 'assets', new Set(['id', 'site', 'zone', 'rack_type', 'rack_no', 'position', 'hardware_type', 'height', 'manufacturer', 'model', 'serial_number', 'installation_date', 'asset_tag', 'mgmt_ip', 'firmware', 'device_name', 'remarks', 'lifecycle_status', 'custody_location', 'last_known_site', 'last_known_zone', 'last_known_rack', 'last_known_position', 'last_movement_at', 'last_movement_reason', 'created_at', 'firmware_source', 'updated_at', 'updated_by', 'created_by', 'changed_fields']));
    await relaxLegacyRequiredColumns(conn, 'asset_movements', new Set(['id', 'asset_id', 'serial_number', 'movement_type', 'from_site', 'from_zone', 'from_rack_no', 'from_position', 'to_site', 'to_zone', 'to_rack_no', 'to_position', 'movement_date', 'reason', 'reference_no', 'performed_by', 'remarks', 'created_at']));
    await relaxLegacyRequiredColumns(conn, 'issues', new Set(['id', 'ticket_no', 'asset_id', 'asset_type', 'site', 'zone', 'rack_no', 'u_position', 'location_detail', 'title', 'description', 'severity', 'part_required', 'part_name', 'reported_date', 'diagnosed_date', 'received_date', 'scheduled_date', 'completed_date', 'moved_to_store_date', 'returned_to_oem_date', 'notes', 'created_at']));
    await relaxLegacyRequiredColumns(conn, 'dc_activities', new Set(['id', 'site', 'zone', 'hardware_type', 'activity_type', 'description', 'start_date', 'completion_date', 'created_by', 'created_at']));
    await relaxLegacyRequiredColumns(conn, 'material_movements', new Set(['id', 'movement_type', 'site', 'item_name', 'description', 'quantity', 'unit', 'receiver_name', 'sender_name', 'dc_invoice_no', 'dc_invoice_file', 'dc_invoice_original_name', 'movement_date', 'remarks', 'created_by', 'created_at']));
    await relaxLegacyRequiredColumns(conn, 'locations', new Set(['id', 'name', 'status', 'created_by', 'created_at', 'archived_at', 'archived_by']));
    await relaxLegacyRequiredColumns(conn, 'rack_types', new Set(['id', 'name', 'created_by', 'created_at']));
    await relaxLegacyRequiredColumns(conn, 'hardware_types', new Set(['id', 'name', 'created_by', 'created_at', 'category', 'default_height']));
    await relaxLegacyRequiredColumns(conn, 'zones', new Set(['id', 'site', 'zone_name', 'created_by', 'created_at']));
    await relaxLegacyRequiredColumns(conn, 'racks', new Set(['id', 'site', 'zone', 'rack_no', 'rack_type', 'u_size', 'created_by', 'created_at', 'w_tiles', 'h_tiles', 'width_mm', 'depth_mm']));
    await relaxLegacyRequiredColumns(conn, 'users', new Set(['id', 'username', 'password_hash', 'name', 'role', 'location_access', 'status', 'created_at', 'last_seen_at', 'last_login_at']));

    // One-time (idempotent) migration: any `assets` row whose hardware type is
    // Component-category came from the earlier combined-table design and
    // needs to move into rack_components now that it's a separate entity.
    // Naturally idempotent - once migrated, this SELECT returns nothing on
    // every later restart.
    const [legacyComponentRows] = await conn.query(
      `SELECT a.* FROM assets a JOIN hardware_types h ON LOWER(h.name) = LOWER(a.hardware_type) WHERE h.category = 'Component'`
    );
    if (legacyComponentRows.length > 0) {
      log.info(`Migrating ${legacyComponentRows.length} rack-component row(s) out of assets into rack_components...`);
      for (const r of legacyComponentRows) {
        try {
          const code = await nextComponentCode(conn, r.site, r.zone || 'AZ-1', r.rack_no, r.hardware_type);
          await conn.query(
            `INSERT INTO rack_components (id, component_code, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, asset_tag, installation_date, remarks, created_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [genId('RC'), code, r.site, r.zone || 'AZ-1', r.rack_type, r.rack_no, r.position, r.hardware_type, r.height, r.manufacturer, r.model, r.asset_tag, r.installation_date, r.remarks, r.created_by || 'System', r.created_at]
          );
          await conn.query('DELETE FROM assets WHERE id = ?', [r.id]);
        } catch (e) { log.warn(`Failed to migrate rack-component row ${r.id}:`, e.message); }
      }
    }

    // Seed default users
    const [userRows] = await conn.query('SELECT COUNT(*) as cnt FROM users');
    // freshInstall itself is computed earlier, right after the users table
    // is created, so the locations/zones seed blocks above can gate on it too.
    if (userRows[0].cnt === 0) {
      log.info('Seeding default users...');
      const hash = await bcrypt.hash('admin', 10);
      await conn.query(
        'INSERT INTO users (username, password_hash, name, role, location_access, status) VALUES (?,?,?,?,?,?)',
        ['admin', hash, 'System Administrator', 'Admin', 'All', 'Active']
      );
      if (SEED_SAMPLE) {   // the two demo operator accounts only exist on a sample-data install (SEED_SAMPLE_DATA=0 skips them)
        const hash2 = await bcrypt.hash('pass', 10);
        await conn.query(
          'INSERT INTO users (username, password_hash, name, role, location_access, status) VALUES (?,?,?,?,?,?)',
          ['site-a-op', hash2, 'Site A Operator', 'Operator', 'Sample Site A', 'Active']
        );
        await conn.query(
          'INSERT INTO users (username, password_hash, name, role, location_access, status) VALUES (?,?,?,?,?,?)',
          ['site-b-op', hash2, 'Site B Operator', 'Operator', 'Sample Site B', 'Active']
        );
      }
      log.info('✓ Users seeded');
    }

    // Seed sample assets
    const [assetRows] = await conn.query('SELECT COUNT(*) as cnt FROM assets');
    if (freshInstall && assetRows[0].cnt === 0) {
      log.info('Seeding sample assets...');
      const seedAssets = [
        ['AST-0001','Sample Site A','AZ-1','42U Standard','A04','U12','DellServer','1U','Dell','PowerEdge R660','SRV0231SN882','2024-03-11','SRV-0231','10.12.4.31','iDRAC 6.10.00.00','app-web-031'],
        ['AST-0002','Sample Site A','AZ-1','42U Standard','A06','U22','HPServer','1U','HPE','ProLiant DL380 Gen11','SRV0247SN117','2024-05-02','SRV-0247','10.12.4.47','iLO 6 v1.55','app-db-047'],
        ['AST-0003','Sample Site A','AZ-2','Storage Rack','C09','U18','Storage Array','4U','NetApp','FAS8300','STG0114SN220','2023-08-14','STG-0114','10.12.6.14','ONTAP 9.13.1','storage-nas-114'],
        ['AST-0004','Sample Site A','AZ-1','Network Rack','B02','U40','Network Switch','1U','Cisco','Nexus 9336C-FX2','SW0087SN903','2022-09-30','SW-0087','10.12.1.87','NX-OS 10.3(4a)','tor-switch-087'],
        ['AST-0005','Sample Site A','AZ-2','Open Frame','MR2','Floor','CRAC / Cooling','n/a','Liebert','DSE Precision Cooling','CRAC003SN019','2020-12-01','CRAC-003','10.12.9.3','n/a','crac-mr2-003'],
        ['AST-0006','Sample Site B','AZ-1','42U Standard','A11','U05','HPServer','2U','HPE','ProLiant DL560 Gen10','SRV0198SN552','2023-11-20','SRV-0198','10.20.4.98','iLO 5 v3.05','app-cache-198'],
        ['AST-0007','Sample Site B','AZ-1','Network Rack','B03','U38','Network Switch','1U','Arista','7050X3','SW0065SN441','2022-06-18','SW-0065','10.20.1.65','EOS 4.30.2','tor-switch-065'],
        ['AST-0008','Sample Site B','AZ-2','42U Standard','A04','PDU-B','PDU','0U','Vertiv','Geist rPDU','PDU0022SN008','2021-04-05','PDU-0022','10.20.9.22','n/a','pdu-a04-b'],
        ['AST-0009','Sample Site B','AZ-2','Storage Rack','C02','U10','Storage Array','4U','Dell EMC','PowerStore 1000T','STG0210SN441','2024-01-09','STG-0210','10.20.6.10','PowerStoreOS 3.5','storage-nas-210']
      ];
      for (const a of seedAssets) {
        await conn.query(
          `INSERT INTO assets (id, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, serial_number, installation_date, asset_tag, mgmt_ip, firmware, device_name) 
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          a
        );
      }
      log.info('✓ Assets seeded');
    }

    // Seed sample issues
    const [issueRows] = await conn.query('SELECT COUNT(*) as cnt FROM issues');
    if (freshInstall && issueRows[0].cnt === 0) {
      log.info('Seeding sample issues...');
      const seedIssues = [
        ['INC-1042','TCK-88401','SRV0231SN882','server','Sample Site A','AZ-1','A04','U12','','Predictive failure on boot drive','SMART reallocated-sector count crossed threshold on the primary boot SSD. Drive still online but flagged for replacement before failure.','critical',true,'960GB NVMe boot SSD','2026-07-10','2026-07-10','2026-07-16','2026-07-27',null,'Customer maintenance window confirmed for the 27th, 10pm-2am local time.'],
        ['INC-1039','TCK-88377','SW0087SN903','network','Sample Site A','AZ-1','B02','U40','','Uplink port flapping','Port 24 on the top-of-rack switch is flapping intermittently, causing brief link loss to the aggregation layer.','warning',true,'48-port ToR switch module','2026-07-18','2026-07-18',null,null,null,'OEM case #OEM-88213 open. Awaiting the replacement module to reach site.'],
        ['INC-1031','TCK-87920','PDU0022SN008','power','Sample Site B','AZ-2','A04','','PDU bank B','Breaker tripped on PDU bank B','Overcurrent trip on bank B, believed caused by a transient load spike. Reset and monitored, no recurrence.','info',false,null,'2026-07-05','2026-07-05',null,null,'2026-07-06','No part needed. Load rebalanced across banks A and B.'],
        ['INC-1024','TCK-87654','STG0210SN441','storage','Sample Site B','AZ-2','C02','U10','','RAID controller reporting faults','Storage array controller is throwing correctable ECC errors at an increasing rate. Vendor confirms replacement is required.','critical',true,'RAID controller card','2026-06-28','2026-06-28','2026-07-05','2026-07-18',null,'Scheduled window missed due to change-freeze extension. Needs re-scheduling.'],
        ['INC-1052','TCK-87301','CRAC003SN019','cooling','Sample Site A','AZ-2','MR2','Floor','Mechanical Room 2','Return-air sensor fault','CRAC unit 3 return-air temperature sensor was reading erratic values, tripping false high-temp alarms.','warning',true,'Return-air temperature sensor','2026-06-30','2026-06-30','2026-07-06','2026-07-08','2026-07-08','Sensor swapped during scheduled PM window. Unit back to normal readings.'],
        ['INC-1058','TCK-88512','SRV0247SN117','server','Sample Site A','AZ-1','A06','U22','','DIMM ECC errors climbing','BMC log shows correctable ECC errors on DIMM slot 4 increasing over the past 48 hours.','warning',true,'32GB DDR5 RDIMM','2026-07-21','2026-07-22',null,null,null,'Part requested from OEM; watching error rate in the meantime.'],
        ['INC-1046','TCK-88110','SRV0198SN552','server','Sample Site B','AZ-1','A11','U05','','PSU redundancy lost','PSU 2 of 2 failed, node running on single power supply. Redundancy lost but node still up.','critical',true,'1600W redundant PSU','2026-07-14','2026-07-14','2026-07-19',null,null,'Part on site in spares cage, awaiting a maintenance window to be scheduled.'],
        ['INC-1017','TCK-86980','SW0065SN441','network','Sample Site B','AZ-1','B03','U38','','Firmware bug causing packet drops','Known firmware issue causing occasional packet drops under high throughput. Vendor patch applied.','info',false,null,'2026-06-20','2026-06-21',null,null,'2026-06-24','Firmware upgraded to 14.2.3, packet drops resolved.']
      ];
      for (const i of seedIssues) {
        await conn.query(
          `INSERT INTO issues (id, ticket_no, asset_id, asset_type, site, zone, rack_no, u_position, location_detail, title, description, severity, part_required, part_name, reported_date, diagnosed_date, received_date, scheduled_date, completed_date, notes) 
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          i
        );
      }
      log.info('✓ Issues seeded');
    }

    // Seed sample DC activities
    const [actRows] = await conn.query('SELECT COUNT(*) as cnt FROM dc_activities');
    if (freshInstall && actRows[0].cnt === 0) {
      log.info('Seeding sample DC activities...');
      const seedActivities = [
        ['ACT-0001','Sample Site A','AZ-1','DellServer','Rack/Stacking','Racked and stacked 4x Dell PowerEdge R660 in row A as part of COMP-1 expansion.','2026-07-06','2026-07-07','System Administrator'],
        ['ACT-0002','Sample Site A','AZ-2','Switch','Cabling Work','Structured cabling for new ToR uplinks in zone AZ-2, 24x OM4 fiber runs dressed and labeled.','2026-07-12','2026-07-14','System Administrator'],
        ['ACT-0003','Sample Site B','AZ-1','PDU','UPS Drill','Quarterly UPS load-bank drill and battery runtime verification for Sample Site B AZ-1.','2026-07-19','2026-07-19','System Administrator'],
        ['ACT-0004','Sample Site B','AZ-2','Storage','Firmware Update','PowerStoreOS 3.5 to 3.6 firmware upgrade on storage-nas-210 during approved window.','2026-07-26',null,'System Administrator']
      ];
      for (const a of seedActivities) {
        await conn.query(
          `INSERT INTO dc_activities (id, site, zone, hardware_type, activity_type, description, start_date, completion_date, created_by)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          a
        );
      }
      log.info('✓ DC activities seeded');
    }

    // Seed sample material movements
    const [movRows] = await conn.query('SELECT COUNT(*) as cnt FROM material_movements');
    if (freshInstall && movRows[0].cnt === 0) {
      log.info('Seeding sample material movements...');
      const seedMovements = [
        ['MAT-0001','Inward','Sample Site A','AZ-1','32GB DDR5 RDIMM','Replacement DIMM received from Dell for INC-1058','4','Nos','Site Technician','Dell Logistics','DC-88512','2026-07-22','Delivered to site security, verified against PO before handover.'],
        ['MAT-0002','Outward','Sample Site A','AZ-1','960GB NVMe boot SSD (faulty)','Faulty drive from INC-1042 returned to OEM for RMA','1','Nos','Dell Service Center','Site Technician','RMA-22019','2026-07-28','Packed with anti-static wrap, courier POD collected.'],
        ['MAT-0003','Inward','Sample Site B','AZ-1','1600W redundant PSU','Spare PSU received for INC-1046','2','Nos','Site Technician','HPE Parts Depot','INV-55231','2026-07-15','Stored in spares cage rack A11.'],
        ['MAT-0004','Outward','Sample Site B','AZ-2','RAID controller card (faulty)','Faulty controller from INC-1024 sent back to vendor','1','Nos','Dell EMC Service Center','Site Technician','RMA-19832','2026-07-10','Awaiting pickup confirmation from courier.']
      ];
      for (const m of seedMovements) {
        await conn.query(
          `INSERT INTO material_movements (id, movement_type, site, item_name, description, quantity, unit, receiver_name, sender_name, dc_invoice_no, movement_date, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          m.filter((_, idx) => idx !== 3)
        );
      }
      log.info('✓ Material movements seeded');
    }

    log.info('Database initialized successfully');
  } catch (e) {
    log.error('Database init error:', e.message);
    throw e;
  } finally {
    if (conn) conn.release();
  }
}

// ===== Shared helpers =====
// Replies with the status code an error carries (e.g. 403 from assertSiteAccess, 400 from validation)
// instead of always answering 500.
function sendErr(res, e) {
  const code = e && e.statusCode;
  const status = code >= 400 && code < 600 ? code : 500;
  if (status >= 500) { res.locals.errLogged = true; const rq = res.req || {}; log.error(`[error] ${rq.method || ''} ${String(rq.originalUrl || '').split('?')[0]} -> ${status} (req ${rq.id || '-'}): ${(e && e.stack) || (e && e.message) || e}`); }
  res.status(status).json({ error: (e && e.message) || 'Internal server error' }); // code / status / requestId are added by the /api response wrapper
}
// PREFIX-<ms>, with a counter appended when two ids are requested in the same millisecond.
let _idLastMs = 0, _idSeq = 0;
function genId(prefix) {
  const ms = Date.now();
  if (ms === _idLastMs) { _idSeq += 1; return `${prefix}-${ms}-${_idSeq}`; }
  _idLastMs = ms; _idSeq = 0;
  return `${prefix}-${ms}`;
}
// Serialises "generate next ticket number + insert" so two people reporting at once can't get the same number.
let _ticketChain = Promise.resolve();
function acquireTicketLock() {
  let release; const next = new Promise((r) => { release = r; });
  const prev = _ticketChain; _ticketChain = prev.then(() => next);
  return prev.then(() => release);
}
// Issues carry a copy of the asset's serial number and location. Keep them in step when the asset
// changes (serial edited, device moved to another rack/zone/site). Only OPEN issues follow the move;
// closed ones keep the location they were raised at.
async function syncIssuesForAsset(conn, oldSerial, a) {
  if (!oldSerial) return;
  if (a.serial && a.serial !== oldSerial) await conn.query('UPDATE issues SET asset_id = ? WHERE asset_id = ?', [a.serial, oldSerial]);
  const key = a.serial || oldSerial;
  await conn.query(
    'UPDATE issues SET site = ?, zone = ?, rack_no = ?, u_position = ? WHERE asset_id = ? AND completed_date IS NULL',
    [a.site, a.zone || 'AZ-1', a.rackNo || null, a.position || null, key]
  );
}
// Validates the issue <-> asset link (issues are keyed by serial number) and fills blank location fields
// from the inventory record. Manual entries for devices that aren't in inventory are still allowed.
async function applyIssueAssetLink(i, opts = {}) {
  const serial = i.assetId && String(i.assetId).trim() ? String(i.assetId).trim() : null;
  i.assetId = serial;
  if (!serial) return;
  const [rows] = await pool.query('SELECT site, zone, rack_no, position FROM assets WHERE serial_number = ? LIMIT 1', [serial]);
  if (!rows.length) return;
  const a = rows[0];
  // When an existing ticket is edited without re-pointing it (same site, same serial), the asset may legitimately have moved
  // to another site since (Transfer / Reuse) - that must not block updating or closing the ticket.
  if (i.site && a.site !== i.site && !opts.keepExistingLink) {
    const err = new Error(`Serial ${serial} is installed at ${a.site}, but this issue is for ${i.site}.`);
    err.statusCode = 400; throw err;
  }
  if (!i.zone) i.zone = a.zone;
  if (!i.rackNo) i.rackNo = a.rack_no;
  if (!i.uPosition) i.uPosition = a.position;
}
// Floor View stores rack positions in floor_plans.data as JSON keyed by rack number. Run `fn(data)` on the
// (site, zone) plan and save it back unless fn returns false.
async function mutateFloorPlan(conn, site, zone, fn) {
  const [rows] = await conn.query('SELECT data FROM floor_plans WHERE site = ? AND zone = ?', [site, zone]);
  if (!rows.length) return;
  let d; try { d = JSON.parse(rows[0].data || '{}'); } catch (e) { return; }
  if (!d || typeof d.layout !== 'object' || !d.layout) return;
  if (fn(d) === false) return;
  await conn.query('UPDATE floor_plans SET data = ? WHERE site = ? AND zone = ?', [JSON.stringify(d), site, zone]);
}
function findLayoutKey(layout, rackNo) {
  const want = String(rackNo || '').trim().toUpperCase();
  return Object.keys(layout).find((k) => k.trim().toUpperCase() === want);
}

// ===== ONE canonical U format for Position + Height =====
//   Position : "5U" (single)  or  "3-4U" (range, start-end)          - number first, "U" last
//   Height   : "1U", "2U", "3U" ...                                   - number first, "U" last
//   Multi-U devices are always stored as a range + its height ("5-6U" + "2U").
// Accepts messy input (5, u5, 5U, U 5, 3-4, U3-U4, U3 to U4, 5,6,7, "U20 (2U)", 2, 2 RU, two ...) and anything it
// cannot understand is left exactly as it was (never lost, never guessed).
const U_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function parseUHeightLoose(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const s = String(raw).replace(/\u00a0/g, ' ').trim().toLowerCase();
  if (!s) return null;
  if (U_WORDS[s]) return U_WORDS[s];
  let m = s.match(/^(\d+(?:\.\d+)?)\s*-?\s*(?:u|ru|rack\s*units?|units?)?$/);
  if (m) { const v = parseFloat(m[1]); return Number.isInteger(v) ? v : null; }
  m = s.match(/^([a-z]+)\s*(?:u|ru|rack\s*units?)$/);
  if (m && U_WORDS[m[1]]) return U_WORDS[m[1]];
  return null;
}
function parseUPosLoose(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) ? { start: raw, end: raw, hint: null } : null;
  let s = String(raw).replace(/\u00a0/g, ' ').replace(/[\u2013\u2014\u2212]/g, '-').replace(/~/g, '-').trim();
  if (!s) return null;
  let hint = null;
  const hm = s.match(/[\(\[]\s*(\d+(?:\.\d+)?)\s*(?:ru|u|rack\s*units?)?\s*[\)\]]\s*$/i);
  if (hm) { const v = parseFloat(hm[1]); if (Number.isInteger(v)) hint = v; s = s.slice(0, hm.index).trim(); }
  const NUM = 'U?\\s*0*(\\d{1,3})\\s*U?';
  let m = s.match(new RegExp('^' + NUM + '\\s*(?:-|to|till|through|until)\\s*' + NUM + '$', 'i'));
  if (m) { const a = parseInt(m[1], 10), b = parseInt(m[2], 10); return { start: Math.min(a, b), end: Math.max(a, b), hint }; }
  m = s.match(new RegExp('^' + NUM + '$', 'i'));
  if (m) return { start: parseInt(m[1], 10), end: parseInt(m[1], 10), hint };
  if (/^(?:U?\s*\d{1,3}\s*U?\s*(?:,|;|&|\/|\+|\band\b)\s*)+U?\s*\d{1,3}\s*U?$/i.test(s)) {
    const nums = (s.match(/\d+/g) || []).map(Number).sort((x, y) => x - y);
    if (nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return { start: nums[0], end: nums[nums.length - 1], hint };
  }
  return null;
}
function normalizeUFormat(position, height) {
  const p = parseUPosLoose(position);
  let h = parseUHeightLoose(height);
  const hBlank = height === null || height === undefined || String(height).trim() === '';
  if (h === null && hBlank && p && p.hint !== null) h = p.hint;
  let outPos = position, outH = height;
  if (h === null && !hBlank) {
    // Height text that cannot be understood is kept exactly as typed; only the position is tidied.
    if (p && p.start >= 1) outPos = p.end === p.start ? `${p.start}U` : `${p.start}-${p.end}U`;
  } else if (h === 0) {
    outH = '0U';                                    // 0U devices (side-mounted PDUs etc.): keep the position as typed
  } else if (p && p.start >= 1) {
    const a = p.start; let b = p.end; const span = b - a + 1;
    if (h === null) h = span;                       // blank height -> 1U, or the size of the range
    else if (span === 1 && h > 1) b = a + h - 1;    // "U5" + "2U" -> U5-6
    else if (span > 1 && h !== span) h = span;      // an explicit range wins over a different height
    outPos = b === a ? `${a}U` : `${a}-${b}U`;                 // number first, U last: 5U / 2-3U
    outH = `${h}U`;
  } else if (h !== null) {
    outH = `${h}U`;                                 // no usable position: still make the Height uniform
  }
  const changed = String(outPos == null ? '' : outPos) !== String(position == null ? '' : position) || String(outH == null ? '' : outH) !== String(height == null ? '' : height);
  return { position: outPos, height: outH, changed };
}

// Brings every asset (and the open issues linked to it) to the canonical U format. Rows already canonical are not touched and
// values that cannot be understood are left as they are. Returns how many assets were changed.
async function normalizeAllUFormat(conn) {
  if (String(process.env.NORMALIZE_U_FORMAT || 'on').toLowerCase() === 'off') return 0;
  const [uRows] = await conn.query('SELECT id, serial_number, position, height FROM assets');
  let fixedU = 0;
  for (const r of uRows) {
    const nf = normalizeUFormat(r.position, r.height);
    if (!nf.changed) continue;
    await conn.query('UPDATE assets SET position = ?, height = ? WHERE id = ?', [nf.position, nf.height, r.id]);
    if (r.serial_number) await conn.query('UPDATE issues SET u_position = ? WHERE asset_id = ? AND completed_date IS NULL', [nf.position, r.serial_number]);
    fixedU++;
  }
  return fixedU;
}

// ===== U-position conflict helpers =====
// "U12" -> 12 ; anything else ("Floor", "PDU-B") -> null (not a U-slot)
function parseUPos(pos) {
  const s = String(pos || '').trim();
  // U12, u12, U 12
  const m = s.match(/^U\s?(\d+)$/i);
  if (m) return { start: parseInt(m[1], 10), end: parseInt(m[1], 10), valid: true };
  // 12U, 12u
  const m2 = s.match(/^(\d+)\s?U$/i);
  if (m2) return { start: parseInt(m2[1], 10), end: parseInt(m2[1], 10), valid: true };
  // Bare number like "12" — treat as U12
  const m3 = s.match(/^(\d+)$/);
  if (m3) return { start: parseInt(m3[1], 10), end: parseInt(m3[1], 10), valid: true };
  // Range formats: U12-U15, U12-15, 12-15
  const m4 = s.match(/^U?\s?(\d+)\s*U?\s*[-–]\s*U?\s?(\d+)\s*U?$/i);
  if (m4) {
    const start = parseInt(m4[1], 10);
    const end = parseInt(m4[2], 10);
    if (end >= start) return { start, end, valid: true };
  }
  return { valid: false };
}
// "1U","2U","4U","0U" -> integer U count (default 1 when parseable position)
function parseHeightU(h) {
  const s = String(h || '').trim();
  const m = s.match(/^(\d+)\s?U$/i);
  if (m) return parseInt(m[1], 10);
  const m2 = s.match(/^(\d+)$/);
  if (m2) return parseInt(m2[1], 10);
  return 1;
}
// Returns the first existing asset OR rack component whose U-range overlaps
// the given one in the same site + zone + rack, or null. Devices and rack
// components share the same physical U space (Rack Elevation = Device U +
// Component U), so both tables are checked together here - device placement
// can't silently overlap an existing component and vice versa. Multi-U rows
// occupy position..position+height-1. Asset ids (AST-...) and rack component
// ids (RC-...) never collide, so excludeId works across both tables as-is.
async function findUConflict(site, zone, rackNo, position, height, excludeId) {
  const parsed = parseUPos(position);
  if (!parsed.valid || !rackNo || !String(rackNo).trim()) return null;
  const h = parseHeightU(height) || 1;
  // Calculate actual occupied range from start U + height
  const newStart = parsed.start;
  const newEnd = Math.max(parsed.end, parsed.start + h - 1);
  const rackKey = String(rackNo).trim().toUpperCase();
  const [assetRows] = await pool.query(
    'SELECT id, site, zone, rack_no, position, height, device_name, asset_tag, serial_number FROM assets WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))',
    [site, zone || 'AZ-1', rackNo]
  );
  const [compRows] = await pool.query(
    'SELECT id, site, zone, rack_no, position, height, component_code, hardware_type FROM rack_components WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))',
    [site, zone || 'AZ-1', rackNo]
  );
  const rows = [
    ...assetRows.map((r) => ({ id: r.id, position: r.position, height: r.height, label: r.device_name || r.asset_tag || r.serial_number || 'asset', assetTag: r.asset_tag, serialNumber: r.serial_number })),
    ...compRows.map((r) => ({ id: r.id, position: r.position, height: r.height, label: r.component_code || r.hardware_type, assetTag: null, serialNumber: null })),
  ];
  for (const r of rows) {
    if (excludeId && r.id === excludeId) continue;
    const rp = parseUPos(r.position);
    if (!rp.valid) continue;
    const rh = parseHeightU(r.height) || 1;
    const rStart = rp.start;
    const rEnd = Math.max(rp.end, rp.start + rh - 1);
    if (rStart <= newEnd && newStart <= rEnd) {
      return { id: r.id, position: r.position, height: r.height, deviceName: r.label, assetTag: r.assetTag, serialNumber: r.serialNumber, range: `${rStart}${rEnd > rStart ? '-' + rEnd : ''}U` };
    }
  }
  return null;
}

// Rack component identity: no serial number, so its display code is
// auto-generated as "<RackNo>-<TypeAbbrev>-<Seq>" (e.g. "A04-PP-01"),
// sequenced per rack (site+zone+rack_no) + hardware type. Fixed at creation
// time and never changes on edit/move/re-import, the same way an asset's
// internal id never changes.
const COMPONENT_TYPE_ABBR = { 'patch panel': 'PP', 'cable manager': 'CM', 'liu': 'LIU', 'sts/ats': 'ATS', 'other': 'OTH' };
function componentTypeAbbr(hwType) {
  const key = String(hwType || '').trim().toLowerCase();
  if (COMPONENT_TYPE_ABBR[key]) return COMPONENT_TYPE_ABBR[key];
  const letters = String(hwType || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters.slice(0, 4) || 'RC';
}
async function nextComponentCode(conn, site, zone, rackNo, hwType) {
  const abbr = componentTypeAbbr(hwType);
  const rackKey = String(rackNo || '').trim().toUpperCase();
  const prefix = `${rackKey}-${abbr}-`;
  const [rows] = await conn.query(
    "SELECT component_code FROM rack_components WHERE site = ? AND COALESCE(zone, 'AZ-1') = ? AND UPPER(TRIM(rack_no)) = ? AND component_code LIKE ?",
    [site, zone || 'AZ-1', rackKey, `${prefix}%`]
  );
  let maxSeq = 0;
  for (const r of rows) {
    const code = String(r.component_code || '');
    if (code.toUpperCase().startsWith(prefix.toUpperCase())) {
      const n = parseInt(code.slice(prefix.length), 10);
      if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(2, '0')}`;
}

// Helper: convert empty strings to null for date fields
function normalizeDates(obj, dateFields) {
  const result = { ...obj };
  dateFields.forEach(field => {
    if (result[field] === '' || result[field] === undefined) {
      result[field] = null;
    }
  });
  return result;
}

// Helper: normalize any date input to YYYY-MM-DD string or null
function normalizeDateInput(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    // Read the calendar date the Date object actually represents in THIS
    // server's local time, not toISOString()'s UTC date. toISOString()
    // converts through UTC, and for any timezone ahead of UTC (this server
    // runs in Asia/Calcutta, UTC+5:30) local midnight rolls back into the
    // previous UTC day — e.g. 10-Mar-2025 00:00 IST becomes 09-Mar-2025
    // 18:30 UTC, so .toISOString().slice(0,10) silently saved "2025-03-09".
    // That one-day-early shift is the "N-1" installation-date bug.
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear(), m = String(val.getMonth() + 1).padStart(2, '0'), d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Excel serial dates may arrive as numbers OR numeric strings.
  // Use the 1899-12-30 epoch directly; do NOT subtract one day.
  const excelSerial = typeof val === 'number'
    ? val
    : (typeof val === 'string' && /^\d+(?:\.\d+)?$/.test(val.trim()) ? Number(val.trim()) : NaN);
  if (Number.isFinite(excelSerial) && excelSerial >= 1 && excelSerial <= 2958465) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(excelSerial) * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const mmmMatch = str.match(/^(\d{1,2})[-\s]([a-zA-Z]{3})[-\s](\d{4})$/);
  if (mmmMatch) {
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const day = parseInt(mmmMatch[1], 10);
    const mon = months[mmmMatch[2].toLowerCase()];
    const year = parseInt(mmmMatch[3], 10);
    if (mon !== undefined && year >= 1900 && year <= 9999) {
      const d = new Date(Date.UTC(year, mon, day));
      if (d.getUTCFullYear() === year && d.getUTCMonth() === mon && d.getUTCDate() === day) return `${year}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  const shortMatch = str.match(/^(\d{1,2})[-\s]([a-zA-Z]{3})[-\s](\d{2})$/);
  if (shortMatch) {
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const day = parseInt(shortMatch[1], 10);
    const mon = months[shortMatch[2].toLowerCase()];
    let year = parseInt(shortMatch[3], 10);
    year = year < 50 ? year + 2000 : year + 1900;
    if (mon !== undefined) {
      const d = new Date(Date.UTC(year, mon, day));
      if (d.getUTCFullYear() === year && d.getUTCMonth() === mon && d.getUTCDate() === day) return `${year}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  const iso = str.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  return iso ? iso[1] : null;
}

// Converts a MySQL DATE column value into a plain "YYYY-MM-DD" string for API
// responses and diff/change-log comparisons. mysql2 returns DATE columns as
// JS Date objects at LOCAL midnight, so this reads the LOCAL calendar date
// (getFullYear/getMonth/getDate) rather than calling .toISOString(), which
// converts through UTC and rolls the date back a day on any server running
// ahead of UTC (this one runs in Asia/Calcutta, UTC+5:30) — the "N-1"
// installation-date bug. Used for every stored date field: asset/component
// installation dates, DC Activity start/completion dates, material movement
// dates, and the update-diff comparisons that decide what shows up in a
// change log.
function dateOnlyStr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}
// "Today" as a local calendar date string — used as a fallback when no date
// was supplied (e.g. a movement record with no date). Also avoids
// new Date().toISOString().slice(0,10), which reads UTC's date and would
// show yesterday's date as "today" during the first ~5.5 hours of the IST day.
function localTodayStr() { return dateOnlyStr(new Date()); }

// Normalize hardware type to canonical catalog name (case-insensitive).
// If the type does not exist in hardware_types, auto-creates it and returns
// the newly inserted name so the catalog and asset inventory stay in sync.
async function normalizeHardwareType(conn, rawName, createdBy, info) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  const [rows] = await conn.query('SELECT id, name FROM hardware_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [name]);
  if (rows.length > 0) { if (info) { info.id = rows[0].id; info.created = false; } return rows[0].name; }
  if (name.length > 50) { const err = new Error('Hardware type name must be 50 characters or fewer'); err.statusCode = 400; throw err; }
  // Auto-create so the catalog stays complete
  const id = genId('HT');
  await conn.query('INSERT INTO hardware_types (id, name, created_by) VALUES (?,?,?)', [id, name, createdBy || 'System']);
  if (info) { info.id = id; info.created = true; }
  return name;
}

// Auto-generate ticket number: SSA260801 or SSB260801 for the two sample
// sites seeded on install (new/renamed locations get a deterministic
// 3-letter prefix derived from their own name instead).
function ticketPrefix(site) {
  if (site === 'Sample Site A') return 'SSA';
  if (site === 'Sample Site B') return 'SSB';
  const letters = String(site || 'TCK').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
  return letters || 'TCK';
}
async function generateTicketNo(site) {
  const prefix = ticketPrefix(site);
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const base = `${prefix}${yy}${mm}`;
  const [rows] = await pool.query(
    "SELECT ticket_no FROM issues WHERE ticket_no LIKE ? ORDER BY CAST(SUBSTRING(ticket_no, ?) AS UNSIGNED) DESC LIMIT 1",
    [`${base}%`, base.length + 1]
  );
  let seq = 1;
  if (rows.length > 0 && rows[0].ticket_no) {
    const existing = rows[0].ticket_no;
    const match = existing.match(new RegExp(`^${base}(\\d+)$`));
    if (match) seq = parseInt(match[1], 10) + 1;
  }
  return `${base}${String(seq).padStart(2, '0')}`;
}

// ===== Dynamic locations (DCs) =====
// location_access on the users table now stores either 'All' (access to
// every location) or the exact name of a single location — no longer a
// fixed ENUM of 'Chennai Only' / 'Manesar Only', so any number of locations
// can be added later without a schema change to `users`.
let _siteNamesMemo = { gen: -1, exp: 0, v: null }; // PHASE-2: asked on nearly every request; refreshed after any write (cacheGen) or every 5 s
async function getAllSiteNames() {
  if (_siteNamesMemo.v && _siteNamesMemo.gen === cacheGen && _siteNamesMemo.exp > Date.now()) return _siteNamesMemo.v.slice();
  const gen = cacheGen;
  const [rows] = await pool.query("SELECT name FROM locations WHERE status = 'Active' ORDER BY name");
  const v = rows.map(r => r.name);
  _siteNamesMemo = { gen, exp: Date.now() + 5000, v };
  return v.slice();
}
// Appends a site-scoping WHERE condition for location-restricted users.
// Correctness notes: (1) restriction is a strict-subset test against the live
// DC list, not a hardcoded count, so it stays right as locations are added;
// (2) an empty `allowed` (user's assigned location was renamed/deleted) must
// NOT emit `site IN ()`, which is a MySQL syntax error that 500s the whole
// module — emit an always-false predicate instead.
async function applySiteScope(allowed, conditions, params) {
  const all = await getAllSiteNames();
  if (allowed.length >= all.length) return;
  if (allowed.length === 0) { conditions.push('1 = 0'); return; }
  conditions.push('site IN (' + allowed.map(() => '?').join(',') + ')');
  params.push(...allowed);
}

async function getAllowedSitesForUser(user) {
  const all = await getAllSiteNames();
  if (!user) return [];
  // Global visibility is explicit. Blank/null/unknown location access is denied
  // rather than silently expanding to every data-center location.
  if (user.location_access === 'All' || user.location_access === 'Both') return all;
  if (!String(user.location_access || '').trim()) return [];
  return all.includes(user.location_access) ? [user.location_access] : [];
}

async function assertSiteAccess(user, site) {const allowed = await getAllowedSitesForUser(user);
  if (!site || !allowed.includes(site)) {
    const err = new Error('Access denied for this site');
    err.statusCode = 403;
    throw err;
  }
  return allowed;
}

const ISSUE_DATE_FIELDS = ['reportedDate', 'diagnosedDate', 'receivedDate', 'scheduledDate', 'completedDate', 'movedToStoreDate', 'returnedToOemDate'];

// Auth middleware
// PERF: the dashboard fires several API calls in parallel per page load, and
// every one of them used to re-run this exact "look up the user by id" query
// even though they all land within the same fraction of a second. Caching the
// row per-token for a few seconds collapses that burst down to ~1 DB query
// instead of one per request, without meaningfully weakening the "always
// enforce current DB role/status" guarantee below (a deactivated/role-changed
// user is picked up again within AUTH_CACHE_TTL_MS).
const AUTH_CACHE_TTL_MS = 15000;
const authUserCache = new Map(); // token -> { row, expires }
function purgeAuthCacheForUser(userId) {
  for (const [k, v] of authUserCache) { if (v.row && String(v.row.id) === String(userId)) authUserCache.delete(k); }
}
// HARDENING: an account that still has its seeded/default password may only change that password (or sign out) until it has done so.
// /api/setup/admin-account is allowed here too: it's the installer's equivalent of
// change-password (same must_change_password=0 / password_changed_at=NOW() bookkeeping),
// just able to also set a custom username in the same call. Discovered by actually running
// the installer end-to-end: without this, the forced-default-password gate below blocks the
// install flow from ever reaching that endpoint.
// /api/health/validate and /api/support/bundle are allowed too, for the same reason: the
// installer (and a repair run) signs in with the still-default admin/admin to print a
// post-install health report, which would otherwise 403 on every fresh install.
const MUST_CHANGE_ALLOWED = new Set(['POST /api/auth/logout', 'POST /api/auth/heartbeat', 'GET /api/auth/me', 'PATCH /api/auth/change-password', 'POST /api/setup/admin-account', 'GET /api/health/validate', 'POST /api/support/bundle']);
function mustChangeBlocked(req, res) {
  if (!req.user || !Number(req.user.must_change_password)) return false;
  if (MUST_CHANGE_ALLOWED.has(`${req.method} ${String(req.originalUrl || '').split('?')[0]}`)) return false;
  res.status(403).json({ error: 'You must change your default password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
  return true;
}
// Checked before mustChangeBlocked so even a forced-default-password account
// can only reach license-management routes on an unlicensed/expired install -
// same allow-list pattern as MUST_CHANGE_ALLOWED above. A no-op (never
// blocks) until lib/license-public-key.js has a real key configured.
const LICENSE_ALLOWED = new Set(['POST /api/auth/logout', 'POST /api/auth/heartbeat', 'GET /api/auth/me', 'PATCH /api/auth/change-password', 'GET /api/license/status', 'GET /api/license/fingerprint', 'POST /api/license/activate']);
function licenseBlocked(req, res) {
  const status = license.getLicenseStatus(LICENSE_FILE);
  if (!status.enforced || status.valid) return false;
  if (LICENSE_ALLOWED.has(`${req.method} ${String(req.originalUrl || '').split('?')[0]}`)) return false;
  res.status(402).json({ error: `License required: ${status.reason}`, code: 'LICENSE_REQUIRED' });
  return true;
}
const DEFAULT_ACCOUNT_PASSWORDS = { admin: 'admin', 'site-a-op': 'pass', 'site-b-op': 'pass' };
// Flags seeded accounts whose password is still the shipped default. Never touches accounts that already changed it (password_changed_at set) or whose password differs.
async function flagDefaultPasswordAccounts() {
  try {
    const names = Object.keys(DEFAULT_ACCOUNT_PASSWORDS);
    const [rows] = await pool.query('SELECT id, username, password_hash FROM users WHERE username IN (?) AND must_change_password = 0 AND password_changed_at IS NULL', [names]);
    const flagged = [];
    for (const u of rows) {
      const def = DEFAULT_ACCOUNT_PASSWORDS[String(u.username).toLowerCase()];
      if (def && await bcrypt.compare(def, u.password_hash)) { await pool.query('UPDATE users SET must_change_password = 1 WHERE id = ?', [u.id]); purgeAuthCacheForUser(u.id); flagged.push(u.username); }
    }
    if (flagged.length) log.warn(`SECURITY: default password still set for: ${flagged.join(', ')} - these accounts must change it at next sign-in.`);
  } catch (e) { log.warn('[auth] default-password check skipped: ' + e.message); }
}
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  const cached = authUserCache.get(token);
  if (cached && cached.expires > Date.now()) {
    req.user = cached.row;
    if (licenseBlocked(req, res)) return;
    if (mustChangeBlocked(req, res)) return;
    return next();
  }
  jwt.verify(token, JWT_SECRET, async (err, tokenUser) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    try {
      // Always enforce the current DB role/location assignment, not stale JWT claims.
      const [rows] = await pool.query(
        'SELECT id, username, name, role, location_access, status, session_id, must_change_password FROM users WHERE id = ?',
        [tokenUser.id]
      );
      if (rows.length === 0 || rows[0].status !== 'Active') {
        authUserCache.delete(token);
        return res.status(401).json({ error: 'User account is inactive or no longer exists' });
      }
      // Single-session enforcement: a token whose session id is no longer the user's current one was replaced by a newer login.
      if (rows[0].session_id && tokenUser.sid !== rows[0].session_id) {
        authUserCache.delete(token);
        return res.status(401).json({ error: 'You were signed out because this account was signed in from another browser.', code: 'SESSION_REPLACED' });
      }
      if (!rows[0].session_id) {
        // Session was ended (logout) - the old token must not keep working.
        authUserCache.delete(token);
        return res.status(401).json({ error: 'Session ended. Please sign in again.', code: 'SESSION_ENDED' });
      }
      req.user = rows[0];
      authUserCache.set(token, { row: rows[0], expires: Date.now() + AUTH_CACHE_TTL_MS });
      if (licenseBlocked(req, res)) return;
      if (mustChangeBlocked(req, res)) return;
      next();
    } catch (dbErr) {
      log.error('Authentication user lookup failed:', dbErr);
      res.status(500).json({ error: 'Authentication service unavailable' });
    }
  });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireGlobalAdmin(req, res, next) {
  const access = req.user && req.user.location_access;
  // Global administration is an explicit security boundary: Admin + All only.
  // Legacy Both is accepted solely for databases that have not yet completed
  // the location_access migration to All. Blank/null access is NEVER global.
  if (!req.user || req.user.role !== 'Admin' || !['All', 'Both'].includes(access)) {
    return res.status(403).json({ error: 'Global Admin access required for user and location administration' });
  }
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

// ============================================================================
// LICENSING — see lib/license.js and docs/LICENSING.md. Inert (status always
// reports enforced:false) until lib/license-public-key.js has a real key.
// ============================================================================

// Allowed even on an unlicensed/expired install (see LICENSE_ALLOWED) so an
// Admin signed in with an expired/missing license can still see why and fix
// it, without needing filesystem access on the server.
app.get('/api/license/status', authenticateToken, (req, res) => {
  res.json(license.getLicenseStatus(LICENSE_FILE));
});

// Global-Admin only, same as other install-affecting settings - the machine
// ID itself isn't secret, but who's allowed to see/change license state is.
app.get('/api/license/fingerprint', authenticateToken, requireGlobalAdmin, (req, res) => {
  res.json({ fingerprint: license.formatFingerprint(license.computeMachineFingerprint()) });
});

const licenseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 }, // a .lic file is a small JSON blob
});
// Accepts either a .lic file upload (multipart field "license") or a pasted
// activation code (JSON body { code: "..." }) — the code is just the same
// signed license, base64url-encoded into one line so it can be emailed/pasted
// instead of attached as a file. Both end up validated and stored the same way.
function decodeLicenseInput(req) {
  if (req.file) {
    const text = req.file.buffer.toString('utf8');
    try { return { buffer: req.file.buffer, parsed: JSON.parse(text) }; }
    catch (e) { return { error: 'That file is not a valid license (not JSON).' }; }
  }
  const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
  const cleaned = code.replace(/[\s-]/g, '');
  if (!cleaned) return { error: 'Paste an activation code or upload a .lic file.' };
  let text;
  try { text = Buffer.from(cleaned, 'base64url').toString('utf8'); }
  catch (e) { return { error: 'That activation code is not valid.' }; }
  try { return { buffer: Buffer.from(text, 'utf8'), parsed: JSON.parse(text) }; }
  catch (e) { return { error: 'That activation code is not valid.' }; }
}

app.post('/api/license/activate', authenticateToken, requireGlobalAdmin, licenseUpload.single('license'), async (req, res) => {
  try {
    const decoded = decodeLicenseInput(req);
    if (decoded.error) return res.status(400).json({ error: decoded.error });
    const parsed = decoded.parsed;
    if (!parsed || parsed.alg !== 'Ed25519' || typeof parsed.payloadJson !== 'string' || typeof parsed.signature !== 'string') {
      return res.status(400).json({ error: 'That is not a recognized license.' });
    }
    await fs.promises.writeFile(LICENSE_FILE, decoded.buffer);
    const status = license.getLicenseStatus(LICENSE_FILE);
    if (!status.valid) {
      // Keep the file either way (so the admin/support can see exactly what
      // was uploaded and why it failed), just report the real reason.
      return res.status(400).json({ error: `License file saved, but is not valid: ${status.reason}`, status });
    }
    auditLog(req, 'LICENSE_ACTIVATE', { entity: 'license', details: { licenseId: status.license && status.license.licenseId, customer: status.license && status.license.customer } });
    res.json({ success: true, status });
  } catch (e) {
    sendErr(res, e);
  }
});

// ============================================================================
// HARDWARE MONITORING INTEGRATION — Dell OME + HPE OneView (per site + zone)
// ----------------------------------------------------------------------------
// Each zone (e.g. Chennai/AZ-1, Chennai/AZ-2, Manesar/AZ-1) can have its own
// OME and/or OneView appliance. Credentials live only in .env — never sent to
// the browser. A zone with no matching env vars is simply reported as
// "not configured" rather than erroring, since not every zone will have both
// (or either) product deployed.
//
// Required .env vars per zone (SITE and ZONE are upper-cased, non-alnum chars
// stripped — e.g. site "Chennai" + zone "AZ-1" -> CHENNAI_AZ1):
//   OME_<SITE>_<ZONE>_HOST / _USER / _PASS
//   ONEVIEW_<SITE>_<ZONE>_HOST / _USER / _PASS
//   ONEVIEW_API_VERSION   — optional; if unset, it's auto-discovered per host
//                           via GET /rest/version and cached, so you never
//                           have to hardcode a version number.
// ============================================================================

function monitorEnvKey(product, site, zone) {
  const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${product}_${clean(site)}_${clean(zone)}`;
}

function getMonitorConfig(product, site, zone) {
  const key = monitorEnvKey(product, site, zone);
  const host = process.env[`${key}_HOST`];
  const user = process.env[`${key}_USER`];
  const pass = process.env[`${key}_PASS`];
  if (!host || !user || !pass) return null;
  return { host: host.replace(/\/$/, ''), user, pass };
}

// Node's native fetch will reject appliances with self-signed certs by
// default. These appliances almost always use one internally, so TLS verify
// is relaxed ONLY for these specific integration calls (never globally) via
// an explicit per-request dispatcher when NODE_TLS_REJECT_UNAUTHORIZED isn't
// already set at the process level.
const https = require('https');
let insecureDispatcher = null;
try { const { Agent } = require('undici'); insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } }); }
catch (e) { log.warn('NOTE: "undici" is not installed - Dell OME / HPE OneView appliances with self-signed certificates will be rejected. Run: npm install undici'); }
const MONITOR_FETCH_TIMEOUT_MS = 30000;
function monitorFetch(url, opts = {}) {
  const isHttps = url.startsWith('https://');
  // A hung appliance must never hang a request (or the auto-sync cycle) forever.
  const signal = opts.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(MONITOR_FETCH_TIMEOUT_MS) : undefined);
  return fetch(url, { ...opts, ...(signal ? { signal } : {}), ...(isHttps && insecureDispatcher ? { dispatcher: insecureDispatcher } : {}) });
}
// SECURITY: appliance resource references come from the browser. They are appended to the appliance host and sent with its
// session token, so anything that is not a plain resource id / REST path (e.g. "@evil.host/x", "..", "?") must be rejected.
function isSafeApplianceRef(vendor, ref) {
  const v = String(ref == null ? '' : ref);
  if (vendor === 'ome') return /^\d{1,12}$/.test(v);
  return /^\/rest\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,3}$/.test(v);
}
function assertSafeApplianceRefs(res, vendor, refs) {
  const bad = (Array.isArray(refs) ? refs : [refs]).find((r) => !isSafeApplianceRef(vendor, r));
  if (bad !== undefined) { res.status(400).json({ error: 'Invalid device or job reference' }); return false; }
  return true;
}

// ---- Dell OME ----
const omeSessionCache = {}; // key -> { token, expiresAt }
async function getOmeToken(site, zone) {
  const cfg = getMonitorConfig('OME', site, zone);
  if (!cfg) return null;
  const key = monitorEnvKey('OME', site, zone);
  const cached = omeSessionCache[key];
  if (cached && cached.expiresAt > Date.now()) return cached;

  const res = await monitorFetch(`${cfg.host}/api/SessionService/Sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ UserName: cfg.user, Password: cfg.pass, SessionType: 'API' }),
  });
  if (!res.ok) throw new Error(`OME login failed (${res.status})`);
  const token = res.headers.get('x-auth-token') || res.headers.get('X-Auth-Token');
  if (!token) throw new Error('OME login did not return an auth token');
  const session = { host: cfg.host, token, expiresAt: Date.now() + 25 * 60 * 1000 };
  omeSessionCache[key] = session;
  return session;
}
// Normalizes an OME device record into the shape the Monitoring UI expects.
// Field names follow Dell's documented OME schema; verify against your
// instance's actual /api/DeviceService/Devices response and adjust if a
// firmware update has changed them.
// Small bounded-concurrency helper. Fetching System ROM for every device now
// means one extra request per device — firing all of them at once risks
// overwhelming/rate-limiting the appliance, and running fully serial could
// take minutes on a 400+ device estate. This runs `limit` at a time and
// preserves item order in the result.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
const FIRMWARE_FETCH_CONCURRENCY = 8;

function normalizeOmeDevice(d) {
  const inv = (d.DeviceManagement && d.DeviceManagement[0]) || {};
  return {
    id: d.Id, // native OME device id — required to target any firmware/power action at this device
    vendor: 'Dell OME',
    name: d.DeviceName || inv.DnsName || `Device ${d.Id}`,
    model: d.Model || '—',
    serialNumber: d.DeviceServiceTag || inv.ServiceTag || null,
    ipAddress: inv.NetworkAddress || null,
    deviceType: d.Type, // OME device type: 1000 = server (chassis/storage/network devices are other values)
    healthStatus: OME_HEALTH_MAP[d.Status] || 'Unknown',
    powerState: OME_POWER_MAP[d.PowerState] || 'Unknown',
    firmwareVersion: null, // filled in below, per device, via fetchOmeSystemRom
  };
}
// Dell OME device Status enum: 1000 Normal, 2000 Unknown, 3000 Warning, 4000 Critical, 5000 No status/informational.
const OME_HEALTH_MAP = { 1000: 'OK', 2000: 'Unknown', 3000: 'Warning', 4000: 'Critical', 5000: 'Unknown' };
const OME_POWER_MAP = { 17: 'On', 18: 'Off', 20: 'Unknown' };

// Per-device System ROM (BIOS) version — the host firmware version, not
// iDRAC's own firmware. OME's device list has no firmware field at all, so
// this is unavoidably one extra call per device. Takes (site, zone) rather
// than a pre-fetched session, and re-resolves the token via getOmeToken()
// on every call — getOmeToken() itself only re-authenticates if the cached
// session has actually expired, so this is cheap in the common case, but it
// means a slow pass on a huge estate can outlast one 25-minute OME session
// without every remaining device silently failing.
async function fetchOmeSystemRom(site, zone, deviceId) {
  const session = await getOmeToken(site, zone);
  if (!session) return null;
  // Confirmed against Dell's own official OpenManage Enterprise RESTful API
  // Guide (dell.com/support/manuals): 'deviceSoftware' is the correct
  // InventoryType for firmware/BIOS entries — 'serverDeviceCards' (the
  // original guess here) is a different category entirely and never
  // contained a BIOS entry to find. Each entry's DeviceDescription (e.g.
  // "System CPLD", "iDRAC Service Module Installer") is the confirmed field
  // for what the entry actually is — not SubDeviceType or Name, which don't
  // appear in the documented response at all.
  const url = `${session.host}/api/DeviceService/Devices(${deviceId})/InventoryDetails('deviceSoftware')`;
  const res = await monitorFetch(url, {
    headers: { 'X-Auth-Token': session.token },
  });
  if (!res.ok) {
    log.warn(`OME System ROM fetch failed for device ${deviceId}: HTTP ${res.status} on ${url}`);
    return null;
  }
  const data = await res.json().catch(() => null);
  // OME documents InventoryDetails(InventoryType) with InventoryInfo[] for
  // deviceSoftware, but some device models / appliance versions can return a
  // successful 200 response without a populated inventory collection. Treat
  // that as "ROM not available" rather than a server-side fault. Also accept
  // a nested value[] shape seen in collection/proxy responses.
  let cards = Array.isArray(data?.InventoryInfo) ? data.InventoryInfo : [];
  if (!cards.length && Array.isArray(data?.value)) {
    cards = data.value.flatMap((x) => Array.isArray(x?.InventoryInfo) ? x.InventoryInfo : []);
  }
  if (!cards.length) return null;
  // Same defensive exclusion as the HPE match below: Dell's deviceSoftware
  // inventory normally only lists one "BIOS" entry per server, but on the
  // chance a given model/firmware generation also exposes a backup/rollback
  // image entry (e.g. "Previous BIOS", "BIOS Recovery Image"), explicitly
  // exclude those so only the currently-running BIOS entry can match —
  // never a backup/staged one.
  const isCurrentBiosEntry = (c) => {
    const text = [c.DeviceDescription, c.SubDeviceType, c.SoftwareType, c.Name, c.Description].filter(Boolean).join(' ');
    return /bios|system\s*rom/i.test(text) && !/redundant|backup|recovery|previous|rollback|golden|staged/i.test(text);
  };
  const bios = cards.find(isCurrentBiosEntry);
  if (!bios) return null;
  return bios.Version || null;
}

// Shared snapshot cache for the full device+firmware pass, keyed by
// vendor+site+zone. This is the actual fix for hitting Dell OME / HPE
// OneView's own appliance twice for the same data: viewing a zone on the
// Monitoring page and running Firmware Sync both go through
// fetchOmeDevices()/fetchOneviewServers(), and both now share this cache
// instead of each independently re-running the full pagination + per-device
// System ROM pass. A short TTL (not "forever") is deliberate: firmware only
// actually changes when someone runs an update job (through this app or
// natively), so a few minutes of staleness is an acceptable, known trade-off
// for cutting real appliance load — not silently pretending the data is
// always live.
const DEVICE_SNAPSHOT_TTL_MS = Number(process.env.MONITOR_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min default
const deviceSnapshotCache = {}; // "OME|site|zone" -> { devices, fetchedAt }
function snapshotKey(vendor, site, zone) { return `${vendor}|${site}|${zone}`; }
function invalidateDeviceSnapshot(vendor, site, zone) { delete deviceSnapshotCache[snapshotKey(vendor, site, zone)]; }

// Generic in-flight de-duplication: coalesces concurrent callers that share
// the same key into a single underlying call. Used so that if two people (or
// two tabs) trigger a sync for the SAME zone+vendor at close to the same
// moment, the appliance only ever sees one real request — every other caller
// just awaits that same in-progress promise and gets its result, instead of
// each kicking off its own redundant pull. A key is only ever "in flight" for
// as long as its one real call is running; it's removed the instant that call
// settles (success or failure), so the next click after that starts fresh.
const inFlightRequests = {};
function dedupeInFlight(key, fn) {
  if (inFlightRequests[key]) return inFlightRequests[key];
  const p = (async () => {
    try { return await fn(); }
    finally { delete inFlightRequests[key]; }
  })();
  inFlightRequests[key] = p;
  return p;
}

// Active-alert counts (Critical/Warning only — Info/Normal is deliberately
// not surfaced here, it would just be noise next to the Vendor IP badge).
// Populated ONLY by the 30-minute auto-sync cycle below, the same appliance
// call that already refreshes hardware/firmware — this is a read-only cache,
// never fetched live on a page view, by design: alerts piggyback on the
// existing poll instead of adding a second one.
const alertSnapshotCache = {}; // "OME|site|zone" -> { counts: {critical, warning}, fetchedAt }
function getCachedAlertCounts(vendor, site, zone) {
  const cached = alertSnapshotCache[snapshotKey(vendor, site, zone)];
  return cached ? { ...cached.counts, asOf: cached.fetchedAt } : null;
}

// Was hardcoded to a single $top=200 page, so any OME instance with more than
// 200 devices (e.g. 428) silently showed only the first 200 with no
// indication more existed. Pages through $skip using OData's @odata.count as
// the stop condition; MAX_PAGES is just a safety net against a misbehaving
// appliance that never reports a shrinking page, not an expected ceiling.
const OME_PAGE_SIZE = 200;
const MONITOR_MAX_PAGES = 25; // 25 * 200 = 5000 devices ceiling, safety-net only
// `forceRefresh` is true only for an explicit "Sync from Dell OME / HPE
// OneView" click — that button's entire purpose is "pull fresh right now",
// so it always bypasses the cache. Everything else (opening a zone,
// Firmware Sync) uses the cache when it's still fresh.
// Just the paginated device list, normalized — no firmware fetch, no cache
// interaction. This is what Reconciliation uses (via fetchOmeDevicesLight
// below): it only needs serial numbers, so paying for a System ROM call per
// device on every zone (fetchOmeDevices' full behavior) was pure waste —
// likely the actual cause of Reconciliation timing out on any estate with
// more than a handful of zones.
async function fetchOmeDevicesRaw(site, zone) {
  const session = await getOmeToken(site, zone);
  if (!session) return null; // not configured for this zone
  let all = [];
  let skip = 0;
  for (let page = 0; page < MONITOR_MAX_PAGES; page++) {
    const res = await monitorFetch(`${session.host}/api/DeviceService/Devices?$top=${OME_PAGE_SIZE}&$skip=${skip}`, {
      headers: { 'X-Auth-Token': session.token },
    });
    if (!res.ok) throw new Error(`OME device list failed (${res.status})`);
    const data = await res.json();
    const batch = data.value || [];
    all = all.concat(batch);
    skip += OME_PAGE_SIZE;
    const total = data['@odata.count'];
    if (batch.length < OME_PAGE_SIZE) break;
    if (typeof total === 'number' && all.length >= total) break;
  }
  return all.map(normalizeOmeDevice);
}
// Reconciliation-only: raw device list, no firmware, no cache. Deliberately
// never touches deviceSnapshotCache — writing a firmware-less result there
// would poison it for Monitoring/Firmware Sync, which genuinely need
// firmware data and would otherwise read back "unknown" for everything.
async function fetchOmeDevicesLight(site, zone) {
  return fetchOmeDevicesRaw(site, zone);
}
async function fetchOmeDevices(site, zone, forceRefresh = false) {
  const key = snapshotKey('OME', site, zone);
  const cached = deviceSnapshotCache[key];
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < DEVICE_SNAPSHOT_TTL_MS) return cached.devices;

  // Coalesce concurrent callers for this same zone (two people clicking Sync
  // at once, or a page view racing a manual sync) into one real appliance
  // pull — see dedupeInFlight above.
  return dedupeInFlight(key, async () => {
    // Re-check the cache now that we actually hold the lock: if we were
    // queued behind another caller's fetch for this same zone, that fetch
    // may have just populated the cache — honor it instead of immediately
    // pulling the appliance a second time back-to-back.
    const cachedAgain = deviceSnapshotCache[key];
    if (!forceRefresh && cachedAgain && Date.now() - cachedAgain.fetchedAt < DEVICE_SNAPSHOT_TTL_MS) return cachedAgain.devices;

    const devices = await fetchOmeDevicesRaw(site, zone);
    if (devices === null) return null;
    // Fetch every device's System ROM version — requested explicitly: the
    // Monitoring page should show the same firmware every device has on the
    // real OME dashboard, for the full device list, not a lazy subset.
    await mapWithConcurrency(devices, FIRMWARE_FETCH_CONCURRENCY, async (d) => {
      try { d.firmwareVersion = await fetchOmeSystemRom(site, zone, d.id); }
      catch (e) { d.firmwareVersion = null; } // one device's inventory call failing shouldn't break the whole list
    });
    deviceSnapshotCache[key] = { devices, fetchedAt: Date.now() };
    return devices;
  });
}

// Active alert counts from Dell OME's AlertService.
// IMPORTANT #1: AlertService/Alerts' `SeverityType` is a DIFFERENT enum from
// DeviceService/Devices' `Status` field (which is what OME_HEALTH_MAP above
// decodes, 1000/2000/3000/4000). Confirmed against a real OME 4.7.0
// appliance's actual /api/AlertService/Alerts response (see the
// "[OME alerts] sample SeverityType" diagnostic log below): alerts use
// 1=Unknown, 2=Info, 4=Normal, 8=Warning, 16=Critical. An earlier version of
// this function wrongly reused the device-status codes here, which silently
// matched zero real alerts.
// IMPORTANT #2: Alerts also carry a separate `StatusType` field for
// acknowledgment state — 1000=Acknowledged, 2000=Not-Acknowledged (per
// Dell's own OpenManage Enterprise RESTful API Guide, e.g. the
// "AlertsFilterStatusType eq 2000" reference page). "Active alerts" means
// currently outstanding/unacknowledged, so the OData $filter below restricts
// the fetch to StatusType eq 2000 — without it, every acknowledged/resolved
// alert ever logged gets counted too, which is the earlier symptom of
// "showing far too many, including already-handled ones."
// Paginated the same way as the device list, so a large, noisy alert log
// can't silently truncate the count on a busy appliance. Only called from
// the 30-min auto-sync cycle, never from a page view.
const OME_ALERT_SEVERITY = { CRITICAL: 16, WARNING: 8 };
const OME_ALERT_STATUS_NOT_ACKNOWLEDGED = 2000;
async function fetchOmeAlertCounts(site, zone) {
  const session = await getOmeToken(site, zone);
  if (!session) return null;
  let critical = 0, warning = 0;
  let skip = 0;
  let rawTotal = 0;
  let loggedSample = false;
  const filter = encodeURIComponent(`StatusType eq ${OME_ALERT_STATUS_NOT_ACKNOWLEDGED}`);
  for (let page = 0; page < MONITOR_MAX_PAGES; page++) {
    const res = await monitorFetch(`${session.host}/api/AlertService/Alerts?$top=${OME_PAGE_SIZE}&$skip=${skip}&$filter=${filter}`, {
      headers: { 'X-Auth-Token': session.token },
    });
    if (!res.ok) throw new Error(`OME alerts fetch failed (${res.status})`);
    const data = await res.json();
    const batch = data.value || [];
    rawTotal += batch.length;
    // DIAGNOSTIC: log the FULL first alert record (not just keys) once per
    // process, so any further mismatch — severity codes, status codes, or
    // anything else this appliance does differently — shows up directly in
    // the server console instead of being guessed at again. Safe to leave in
    // permanently; this is internal server console output only, never sent
    // to the browser.
    if (!loggedSample && batch.length) {
      log.info(`[OME alerts] ${site}/${zone}: sample record (full) = ${JSON.stringify(batch[0])}`);
      loggedSample = true;
    }
    batch.forEach((a) => {
      // Number(...) coercion: some OME versions/proxies serialize this as a
      // numeric string ("4000") rather than a number — strict === against a
      // number literal would silently miss every alert in that case.
      const sev = Number(a.SeverityType);
      if (sev === OME_ALERT_SEVERITY.CRITICAL) critical++;
      else if (sev === OME_ALERT_SEVERITY.WARNING) warning++;
    });
    skip += OME_PAGE_SIZE;
    const total = data['@odata.count'];
    if (batch.length < OME_PAGE_SIZE) break;
    if (typeof total === 'number' && skip >= total) break;
  }
  log.info(`[OME alerts] ${site}/${zone}: ${rawTotal} raw not-acknowledged alert record(s) fetched (filter=StatusType eq ${OME_ALERT_STATUS_NOT_ACKNOWLEDGED}) -> ${critical} Critical, ${warning} Warning`);
  return { critical, warning };
}

// ---- HPE OneView ----
const oneviewVersionCache = {}; // host -> { version, expiresAt }
async function getOneviewApiVersion(host) {
  if (process.env.ONEVIEW_API_VERSION) return process.env.ONEVIEW_API_VERSION;
  const cached = oneviewVersionCache[host];
  if (cached && cached.expiresAt > Date.now()) return cached.version;
  const res = await monitorFetch(`${host}/rest/version`);
  if (!res.ok) throw new Error(`OneView version discovery failed (${res.status})`);
  const data = await res.json();
  const version = data.currentVersion;
  oneviewVersionCache[host] = { version, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  return version;
}
const oneviewSessionCache = {}; // key -> { sessionId, host, apiVersion, expiresAt }
async function getOneviewSession(site, zone) {
  const cfg = getMonitorConfig('ONEVIEW', site, zone);
  if (!cfg) return null;
  const key = monitorEnvKey('ONEVIEW', site, zone);
  const cached = oneviewSessionCache[key];
  if (cached && cached.expiresAt > Date.now()) return cached;

  const apiVersion = await getOneviewApiVersion(cfg.host);
  const res = await monitorFetch(`${cfg.host}/rest/login-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Version': String(apiVersion) },
    body: JSON.stringify({ userName: cfg.user, password: cfg.pass }),
  });
  if (!res.ok) throw new Error(`OneView login failed (${res.status})`);
  const data = await res.json();
  if (!data.sessionID) throw new Error('OneView login did not return a sessionID');
  const session = { host: cfg.host, sessionId: data.sessionID, apiVersion, expiresAt: Date.now() + 50 * 60 * 1000 };
  oneviewSessionCache[key] = session;
  return session;
}
// OneView can end a session before our 50-minute cache does (appliance restart, an administrator signing the session out).
// Drop the cached session and sign in again once.
async function reloginOneview(site, zone) {
  delete oneviewSessionCache[monitorEnvKey('ONEVIEW', site, zone)];
  return getOneviewSession(site, zone);
}
// Short, actionable hint added after OneView's own message for the HTTP codes operators actually hit.
function oneviewFirmwareHint(status) {
  if (status === 401) return ' - OneView refused the integration account even after signing in again; check the OneView user name and password configured for this zone.';
  if (status === 403) return ' - the OneView integration account is not allowed to update firmware on this server (it needs the Infrastructure administrator role, or a scope that includes this server).';
  if (status === 404) return ' - OneView no longer knows this server or firmware baseline; reload the page and try again.';
  if (status === 409) return ' - OneView is busy with another task on this server; wait for it to finish and try again.';
  if (status === 412) return ' - the server is not in the state OneView requires (for example its power state); check the server in OneView and retry.';
  if (status >= 500) return ' - OneView reported an internal error; check the appliance and retry.';
  return '';
}
// Normalizes a OneView server-hardware record. Field names follow HPE's
// documented schema (stable across the 6.x-10.x line); verify against your
// instance's actual /rest/server-hardware response and adjust if needed.
function normalizeOneviewServer(s) {
  return {
    uri: s.uri, // native OneView resource URI — required to target any firmware/power action at this device
    vendor: 'HPE OneView',
    name: s.name || s.model || `Server ${s.uuid || ''}`,
    model: s.model || '—',
    serialNumber: s.serialNumber || null,
    ipAddress: (s.mpHostInfo && s.mpHostInfo.mpIpAddresses && s.mpHostInfo.mpIpAddresses[0] && s.mpHostInfo.mpIpAddresses[0].address) || null,
    healthStatus: s.status || 'Unknown', // OK / Warning / Critical / Disabled / Unknown
    powerState: s.powerState || 'Unknown', // On / Off / Unknown
    firmwareVersion: null, // filled in below, per device, via fetchOneviewSystemRom — this is System ROM, not iLO's own firmware
  };
}

// Per-device System ROM version, from OneView's own firmware-inventory
// endpoint for that server. Field names ('components'/'componentName'/
// 'componentVersion') per HPE's documented schema — verify against your
// instance, since the exact shape has varied across OneView releases.
//
// BUG FIX: HPE servers report the active boot BIOS as "System ROM" AND
// separately list a "Redundant System ROM" (the standby/backup ROM bank —
// HPE's dual-ROM failover design, not what's actually running). The old
// match here was `/system\s*rom/i.test(componentName)`, which is an
// unanchored substring test — it matches "Redundant System ROM" just as
// happily as "System ROM", so whichever of the two happened to come first
// in the appliance's response array silently won. That's what was showing
// the redundant/backup version instead of the currently running one.
// Fixed by explicitly excluding anything with "redundant" in the name, so
// only the active System ROM entry can match, however the two are ordered.
async function fetchOneviewSystemRom(site, zone, deviceUri) {
  const session = await getOneviewSession(site, zone);
  if (!session) return null;
  const res = await monitorFetch(`${session.host}${deviceUri}/firmware`, {
    headers: { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const components = (data && data.components) || [];
  const rom = components.find((c) => /system\s*rom/i.test(c.componentName || '') && !/redundant/i.test(c.componentName || ''));
  return (rom && rom.componentVersion) || null;
}

// Was hardcoded to a single count=200 page — same silent-truncation bug as
// OME above. Pages through start/count using the response's own `total`.
const ONEVIEW_PAGE_SIZE = 200;
async function fetchOneviewServersRaw(site, zone) {
  const session = await getOneviewSession(site, zone);
  if (!session) return null; // not configured for this zone
  let all = [];
  let start = 0;
  for (let page = 0; page < MONITOR_MAX_PAGES; page++) {
    const res = await monitorFetch(`${session.host}/rest/server-hardware?start=${start}&count=${ONEVIEW_PAGE_SIZE}`, {
      headers: { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) },
    });
    if (!res.ok) throw new Error(`OneView server list failed (${res.status})`);
    const data = await res.json();
    const batch = data.members || [];
    all = all.concat(batch);
    start += ONEVIEW_PAGE_SIZE;
    const total = data.total;
    if (batch.length < ONEVIEW_PAGE_SIZE) break;
    if (typeof total === 'number' && all.length >= total) break;
  }
  return all.map(normalizeOneviewServer);
}
async function fetchOneviewServersLight(site, zone) {
  return fetchOneviewServersRaw(site, zone);
}
async function fetchOneviewServers(site, zone, forceRefresh = false) {
  const key = snapshotKey('ONEVIEW', site, zone);
  const cached = deviceSnapshotCache[key];
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < DEVICE_SNAPSHOT_TTL_MS) return cached.devices;

  // See dedupeInFlight above — coalesces concurrent syncs of the same zone.
  return dedupeInFlight(key, async () => {
    const cachedAgain = deviceSnapshotCache[key];
    if (!forceRefresh && cachedAgain && Date.now() - cachedAgain.fetchedAt < DEVICE_SNAPSHOT_TTL_MS) return cachedAgain.devices;

    const devices = await fetchOneviewServersRaw(site, zone);
    if (devices === null) return null;
    // Same reasoning as OME above: fetch System ROM for every device so the
    // Monitoring page's firmware column matches the full estate, not a lazy
    // subset.
    await mapWithConcurrency(devices, FIRMWARE_FETCH_CONCURRENCY, async (d) => {
      try { d.firmwareVersion = await fetchOneviewSystemRom(site, zone, d.uri); }
      catch (e) { d.firmwareVersion = null; }
    });
    deviceSnapshotCache[key] = { devices, fetchedAt: Date.now() };
    return devices;
  });
}

// Active alert counts from HPE OneView's /rest/alerts, filtered server-side
// to alertState='Active' ONLY — by explicit choice, matching Dell OME's
// "Unacknowledged only" scope. This deliberately EXCLUDES alerts in other
// non-cleared states such as "Locked" (used when an alert needs explicit
// acknowledgment before it can clear) — e.g. backup/license alerts that sit
// in Locked state will not be counted here. An earlier version of this
// function counted every non-Cleared state, which did include those, but
// that broader scope was replaced with this narrower Active-only definition
// on request.
//
// IMPORTANT on the filter syntax: HPE OneView's `filter` query parameter
// value must be a full double-quoted string, with the field/value
// expression's own single quotes INSIDE it — e.g. the literal filter text
// is  "alertState='Active'"  (outer double quotes included), matching how
// HPE's own oneview-python SDK sends it and confirmed working against a
// mock appliance. Sending only the inner alertState='Active' part without
// the wrapping double quotes silently returns zero results instead of an
// error.
// Paginated the same way as the server-hardware list above. Only called from
// the 30-min auto-sync cycle, never from a page view.
async function fetchOneviewAlertCounts(site, zone) {
  const session = await getOneviewSession(site, zone);
  if (!session) return null;
  let critical = 0, warning = 0;
  let start = 0;
  let rawTotal = 0;
  let loggedSample = false;
  const filter = encodeURIComponent(`"alertState='Active'"`);
  for (let page = 0; page < MONITOR_MAX_PAGES; page++) {
    const res = await monitorFetch(`${session.host}/rest/alerts?start=${start}&count=${ONEVIEW_PAGE_SIZE}&filter=${filter}`, {
      headers: { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) },
    });
    if (!res.ok) throw new Error(`OneView alerts fetch failed (${res.status})`);
    const data = await res.json();
    const batch = data.members || [];
    rawTotal += batch.length;
    // DIAGNOSTIC: log the FULL first alert record (not just keys) once per
    // process, so the real alertState/severity values in use on this
    // appliance are visible directly instead of guessed at again. Safe to
    // leave in permanently; internal server console output only.
    if (!loggedSample && batch.length) {
      log.info(`[OneView alerts] ${site}/${zone}: sample record (full) = ${JSON.stringify(batch[0])}`);
      loggedSample = true;
    }
    batch.forEach((a) => {
      const sev = String(a.severity || '').toLowerCase();
      if (sev === 'critical') critical++;
      else if (sev === 'warning') warning++;
    });
    start += ONEVIEW_PAGE_SIZE;
    const total = data.total;
    if (batch.length < ONEVIEW_PAGE_SIZE) break;
    if (typeof total === 'number' && start >= total) break;
  }
  log.info(`[OneView alerts] ${site}/${zone}: ${rawTotal} raw alert record(s) fetched (filter="alertState='Active'") -> ${critical} Critical, ${warning} Warning`);
  return { critical, warning };
}

// GET /api/monitoring/config — tells the frontend which site/zone combos have
// OME and/or OneView configured, WITHOUT exposing any credentials, so the
// left-panel tree can show a "configured" dot per zone up front.
// GET/PUT the admin-declared "current firmware version being pushed" per
// vendor. This is a manual value, not derived from OME/OneView baselines —
// the Monitoring page's Latest/Outdated counts compare each device's System
// ROM against whatever is set here. Any authenticated user can read it;
// only Admin/Operator can change it.
function normalizeFirmwareModelKey(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Manual BIOS targets per vendor/model. These are the only values used for
// firmware compliance comparison in the frontend. They are never populated
// from OME/OneView baselines or release catalogs.
app.get('/api/monitoring/firmware-model-targets', authenticateToken, async (req, res) => {
  try {
    const allowed = ['ome', 'oneview'];
    const vendor = req.query.vendor && String(req.query.vendor).trim().toLowerCase();
    let sql = 'SELECT vendor, model_name, target_version, updated_by, updated_at FROM firmware_model_targets';
    const params = [];
    if (vendor) {
      if (!allowed.includes(vendor)) return res.status(400).json({ error: 'vendor must be ome or oneview' });
      sql += ' WHERE vendor = ?'; params.push(vendor);
    }
    sql += ' ORDER BY vendor, model_name';
    const [rows] = await pool.query(sql, params);
    const result = { ome: [], oneview: [] };
    rows.forEach((r) => {
      if (result[r.vendor]) result[r.vendor].push({ model: r.model_name, targetVersion: r.target_version, updatedBy: r.updated_by, updatedAt: r.updated_at });
    });
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

app.put('/api/monitoring/firmware-model-targets', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const vendor = String(req.body.vendor || '').trim().toLowerCase();
    const model = String(req.body.model || '').trim().replace(/\s+/g, ' ');
    const targetVersion = String(req.body.targetVersion || '').trim();
    if (!['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'vendor must be ome or oneview' });
    if (!model) return res.status(400).json({ error: 'Model is required' });
    if (!targetVersion) return res.status(400).json({ error: 'Manual BIOS target version is required' });
    if (model.length > 200) return res.status(400).json({ error: 'Model must be 200 characters or fewer' });
    if (targetVersion.length > 255) return res.status(400).json({ error: 'Target BIOS version must be 255 characters or fewer' });
    const user = req.user;
    const key = normalizeFirmwareModelKey(model);
    await pool.query(
      'INSERT INTO firmware_model_targets (vendor, model_key, model_name, target_version, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE model_name = ?, target_version = ?, updated_by = ?',
      [vendor, key, model, targetVersion, user.name || user.username, model, targetVersion, user.name || user.username]
    );
    res.json({ vendor, model, targetVersion });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/monitoring/firmware-model-targets', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const vendor = String(req.body.vendor || '').trim().toLowerCase();
    const model = String(req.body.model || '').trim();
    if (!['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'vendor must be ome or oneview' });
    if (!model) return res.status(400).json({ error: 'Model is required' });
    await pool.query('DELETE FROM firmware_model_targets WHERE vendor = ? AND model_key = ?', [vendor, normalizeFirmwareModelKey(model)]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.get('/api/monitoring/firmware-targets', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT vendor, target_version, updated_by, updated_at FROM firmware_targets');
    const result = { ome: null, oneview: null };
    rows.forEach((r) => { result[r.vendor] = { targetVersion: r.target_version, updatedBy: r.updated_by, updatedAt: r.updated_at }; });
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});
app.put('/api/monitoring/firmware-targets', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const { vendor, targetVersion } = req.body;
    if (!['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'vendor must be ome or oneview' });
    const user = req.user;
    await pool.query(
      'INSERT INTO firmware_targets (vendor, target_version, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE target_version = ?, updated_by = ?',
      [vendor, targetVersion || null, user.name || user.username, targetVersion || null, user.name || user.username]
    );
    res.json({ vendor, targetVersion: targetVersion || null });
  } catch (e) {
    sendErr(res, e);
  }
});

app.get('/api/monitoring/config', authenticateToken, async (req, res) => {
  try {
    const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones ORDER BY site, zone_name');
    const allowed = await getAllowedSitesForUser(req.user);
    const result = zoneRows
      .filter((z) => allowed.includes(z.site))
      .map((z) => ({
        site: z.site,
        zone: z.zone,
        ome: !!getMonitorConfig('OME', z.site, z.zone),
        oneview: !!getMonitorConfig('ONEVIEW', z.site, z.zone),
      }));
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

// GET /api/monitoring/search?q=<text> — one search box across ALL zones the user may see.
// Read-only and appliance-free: it only reads the device snapshots that Monitoring / the
// 30-minute auto-sync already collected (any age, with its fetch time), so a search never
// calls Dell OME / HPE OneView. Zones that have an appliance configured but no snapshot yet
// are listed in `notLoaded` so the page can offer to load them.
app.get('/api/monitoring/search', authenticateToken, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ query: q, results: [], total: 0, zonesSearched: 0, notLoaded: [], truncated: false });
    const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones ORDER BY site, zone_name');
    const allowed = await getAllowedSitesForUser(req.user);
    const LIMIT = 200;
    const results = [], notLoaded = [];
    let zonesSearched = 0, total = 0;
    const norm = (v) => String(v == null ? '' : v).toLowerCase();
    for (const z of zoneRows) {
      if (!allowed.includes(z.site)) continue;
      for (const [product, label] of [['OME', 'Dell OME'], ['ONEVIEW', 'HPE OneView']]) {
        if (!getMonitorConfig(product, z.site, z.zone)) continue;
        const snap = deviceSnapshotCache[snapshotKey(product, z.site, z.zone)];
        if (!snap) { notLoaded.push({ site: z.site, zone: z.zone, vendor: label }); continue; }
        zonesSearched++;
        for (const d of snap.devices || []) {
          if (![d.name, d.model, d.serialNumber, d.ipAddress].some((f) => norm(f).includes(q))) continue;
          total++;
          if (results.length < LIMIT) results.push({ site: z.site, zone: z.zone, vendor: label, name: d.name || null, model: d.model || null, serialNumber: d.serialNumber || null, ipAddress: d.ipAddress || null, healthStatus: d.healthStatus || null, powerState: d.powerState || null, firmwareVersion: d.firmwareVersion || null, fetchedAt: snap.fetchedAt });
        }
      }
    }
    res.json({ query: q, results, total, zonesSearched, notLoaded, truncated: total > results.length });
  } catch (e) {
    sendErr(res, e);
  }
});

// GET /api/monitoring/devices?site=X&zone=Y — live device data for one zone,
// from whichever of OME/OneView are configured for it. Never fails the whole
// request just because one vendor is down — each is reported independently.
app.get('/api/monitoring/devices', authenticateToken, async (req, res) => {
  try {
    const { site, zone } = req.query;
    const forceRefresh = req.query.refresh === 'true' && req.user.role !== 'Viewer'; // forcing a live appliance poll is an Admin/Operator action
    if (!site || !zone) return res.status(400).json({ error: 'site and zone are required' });
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });

    const result = { ome: { configured: false, devices: [], error: null, host: null, alertCounts: null, devicesFetchedAt: null }, oneview: { configured: false, devices: [], error: null, host: null, alertCounts: null, devicesFetchedAt: null } };

    const omeCfg = getMonitorConfig('OME', site, zone);
    result.ome.configured = !!omeCfg;
    result.ome.host = omeCfg ? omeCfg.host : null;
    if (result.ome.configured) {
      try { result.ome.devices = await fetchOmeDevices(site, zone, forceRefresh) || []; }
      catch (e) { result.ome.error = e.message; }
      // devicesFetchedAt is read straight back from the shared cache AFTER
      // the call above — whether that call just wrote a fresh entry or the
      // call returned an existing one untouched, this is always the true
      // "as of" time for the data just returned, not "when this browser
      // happened to load the page". That's what lets two different users
      // who open the same zone see the SAME, accurate "Last synced" time.
      result.ome.devicesFetchedAt = (deviceSnapshotCache[snapshotKey('OME', site, zone)] || {}).fetchedAt || null;
      // Alert counts are read-only here — never fetched live on a page view,
      // only ever written by the 30-min auto-sync cycle. null means "not
      // synced yet" (e.g. right after startup), not "zero alerts".
      result.ome.alertCounts = getCachedAlertCounts('OME', site, zone);
    }

    const ovCfg = getMonitorConfig('ONEVIEW', site, zone);
    result.oneview.configured = !!ovCfg;
    result.oneview.host = ovCfg ? ovCfg.host : null;
    if (result.oneview.configured) {
      try { result.oneview.devices = await fetchOneviewServers(site, zone, forceRefresh) || []; }
      catch (e) { result.oneview.error = e.message; }
      result.oneview.devicesFetchedAt = (deviceSnapshotCache[snapshotKey('ONEVIEW', site, zone)] || {}).fetchedAt || null;
      result.oneview.alertCounts = getCachedAlertCounts('ONEVIEW', site, zone);
    }

    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

// ----------------------------------------------------------------------------
// FIRMWARE ACTIONS — catalog, apply, job status, and the Asset Inventory sync.
// Every route below is a genuinely privileged action (it can push firmware to
// production hardware, or overwrite an Asset Inventory field), so all of them
// require Admin/Operator, not just an authenticated viewer.
// ----------------------------------------------------------------------------

// ---- Firmware catalog: real baselines/bundles that exist on THIS appliance.
// Never return a hardcoded/guessed list — if the appliance has none configured,
// return an empty array and let the UI say so, rather than inventing options.
async function fetchOmeBaselines(site, zone) {
  const session = await getOmeToken(site, zone);
  if (!session) return null;
  const res = await monitorFetch(`${session.host}/api/UpdateService/Baselines`, {
    headers: { 'X-Auth-Token': session.token },
  });
  if (!res.ok) throw new Error(`OME baseline list failed (${res.status})`);
  const data = await res.json();
  // Field names per Dell's documented Baselines schema — verify against your
  // instance's actual response (older OME builds have used slightly different keys).
  return (data.value || []).map((b) => ({ id: b.Id, label: b.Name || `Baseline ${b.Id}` }));
}
async function fetchOneviewBundles(site, zone, deviceUri, wantProbes) {
  const session = await getOneviewSession(site, zone);
  if (!session) return null;
  // OneView returns only its DEFAULT page (25 items) when no start/count is sent, so the
  // Service Pack (SPP) bundles beyond the first page were silently missing from the list.
  // Page through everything using the response's own `total`. If that returns nothing
  // (some OneView builds answer differently to start/count), fall back to other request forms
  // and report what each returned so an empty list can be diagnosed instead of guessed at.
  const headers = { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) };
  const tried = [];
  const byUri = new Map();
  const pull = async (label, path, paged, hdrs) => {
    for (let guard = 0, start = 0; guard < 50; guard++) {
      const url = paged ? `${path}${path.includes('?') ? '&' : '?'}start=${start}&count=${ONEVIEW_PAGE_SIZE}` : path;
      const res = await monitorFetch(`${session.host}${url}`, { headers: hdrs || headers });
      if (!res.ok) { tried.push({ via: label, status: res.status }); return; }
      const data = await res.json().catch(() => ({}));
      const batch = Array.isArray(data.members) ? data.members : (Array.isArray(data) ? data : []);
      batch.forEach((m) => { if (m && m.uri && !byUri.has(m.uri)) byUri.set(m.uri, m); });
      tried.push({ via: label, status: res.status, returned: batch.length, total: typeof data.total === 'number' ? data.total : null });
      start += ONEVIEW_PAGE_SIZE;
      if (!paged || batch.length === 0 || batch.length < ONEVIEW_PAGE_SIZE || (typeof data.total === 'number' && start >= data.total)) return;
    }
  };
  await pull('paged', '/rest/firmware-drivers', true);
  if (byUri.size === 0) await pull('plain', '/rest/firmware-drivers', false);
  if (byUri.size === 0) await pull('count=-1', '/rest/firmware-drivers?start=0&count=-1', false);
  // On this OneView build the firmware-drivers collection can answer 0 items under the newest API version header
  // while returning the baselines under an older one (seen: 7600 -> 0, 4000 -> 9). Read the full list under the
  // first older version that returns items. Only the READ of the list uses it; the update call is unchanged.
  if (byUri.size === 0) {
    for (const v of [4000, 6000, 7200, null]) {
      if (v !== null && String(v) === String(session.apiVersion)) continue;
      const h = { Auth: session.sessionId, ...(v === null ? {} : { 'X-API-Version': String(v) }) };
      await pull(v === null ? 'no API-version header' : `API ${v}`, '/rest/firmware-drivers', true, h);
      if (byUri.size > 0) break;
    }
  }
  // Last resort: the appliance's resource index lists every firmware-drivers resource regardless of how the
  // collection endpoint pages/filters it.
  if (byUri.size === 0) {
    try {
      for (let guard = 0, start = 0; guard < 50; guard++) {
        const res = await monitorFetch(`${session.host}/rest/index/resources?category=firmware-drivers&start=${start}&count=${ONEVIEW_PAGE_SIZE}`, { headers });
        if (!res.ok) { tried.push({ via: 'index', status: res.status }); break; }
        const data = await res.json().catch(() => ({}));
        const batch = Array.isArray(data.members) ? data.members : [];
        batch.forEach((m) => { if (m && m.uri && /^\/rest\/firmware-drivers\//.test(m.uri) && !byUri.has(m.uri)) byUri.set(m.uri, { uri: m.uri, name: m.name, version: m.attributes && (m.attributes.version || m.attributes.bundleVersion), bundleType: m.attributes && m.attributes.bundleType }); });
        tried.push({ via: 'index', status: res.status, returned: batch.length, total: typeof data.total === 'number' ? data.total : null });
        start += ONEVIEW_PAGE_SIZE;
        if (batch.length < ONEVIEW_PAGE_SIZE) break;
      }
    } catch (e) { tried.push({ via: 'index', status: 'error ' + e.message }); }
  }
  // OneView 10: the Firmware > Updates page and the Update firmware dialog are fed by /rest/updates (the HPE service-pack
  // catalog), not by /rest/firmware-drivers (which stays empty until a pack is downloaded into the repository).
  // Each catalog entry carries sppId; the baseline URI OneView uses on a server is /rest/firmware-drivers/<sppId>.
  let updatesInfo = null;
  if (byUri.size === 0) {
    try {
      const items = [];
      for (let guard = 0, start = 0; guard < 20; guard++) {
        const res = await monitorFetch(`${session.host}/rest/updates?start=${start}&count=${ONEVIEW_PAGE_SIZE}`, { headers });
        if (!res.ok) { tried.push({ via: 'updates', status: res.status }); break; }
        const data = await res.json().catch(() => null);
        const batch = Array.isArray(data) ? data : (data && Array.isArray(data.members) ? data.members : []);
        items.push(...batch);
        tried.push({ via: 'updates', status: res.status, returned: batch.length });
        start += ONEVIEW_PAGE_SIZE;
        if (batch.length < ONEVIEW_PAGE_SIZE) break;
      }
      const states = {};
      let noId = 0;
      items.forEach((u) => {
        if (!u || typeof u !== 'object') return;
        states[String(u.state)] = (states[String(u.state)] || 0) + 1;
        const spp = typeof u.sppId === 'string' ? u.sppId.trim() : '';
        if (!spp || !/^[A-Za-z0-9._+-]+$/.test(spp)) { noId++; return; }
        const uri = `/rest/firmware-drivers/${spp}`;
        const downloaded = typeof u.sizeOfDownloadedComps === 'number' ? u.sizeOfDownloadedComps > 0 : null;
        if (!byUri.has(uri)) byUri.set(uri, { uri, name: u.name, version: u.version, bundleType: u.bundleType || 'SPP', _gen: u.bundleGeneration, _downloaded: downloaded, _state: u.state, _size: u.sizeOfDownloadedComps });
      });
      updatesInfo = { count: items.length, usable: byUri.size, withoutSppId: noId, states, sample: items.slice(0, 3).map((u) => ({ name: u && u.name, version: u && u.version, state: u && u.state, sppId: u && u.sppId, bundleGeneration: u && u.bundleGeneration, sizeOfDownloadedComps: u && u.sizeOfDownloadedComps })) };
    } catch (e) { tried.push({ via: 'updates', status: 'error ' + e.message }); }
  }
  // Report the appliance's firmware repositories too (baselines can live in an external repository),
  // so an empty list can be explained rather than guessed at.
  let repos = [];
  let account = null;
  if (byUri.size === 0) {
    // Both the collection and the index are empty although the appliance has bundles: the usual cause is the
    // API account's permissions (a role limited to a scope cannot see unscoped resources such as firmware bundles).
    try {
      const cfg = getMonitorConfig('ONEVIEW', site, zone);
      const ur = await monitorFetch(`${session.host}/rest/users/${encodeURIComponent(cfg.user)}`, { headers });
      if (ur.ok) {
        const ud = await ur.json().catch(() => ({}));
        const perms = (ud.permissions || []).map((p) => `${p.roleName || '?'}${p.scopeUri ? ' (limited to a scope)' : ' (all resources)'}`);
        account = { user: cfg.user, permissions: perms };
      } else { account = { user: cfg.user, permissions: [], status: ur.status }; }
    } catch (e) { /* ignore */ }
  }
  if (byUri.size === 0) {
    try {
      const rr = await monitorFetch(`${session.host}/rest/repositories?start=0&count=50`, { headers });
      if (rr.ok) { const rd = await rr.json().catch(() => ({})); repos = (rd.members || []).map((r) => `${r.name || r.repositoryName || '?'} (${r.repositoryType || r.type || '?'})`); }
      tried.push({ via: 'repositories', status: rr.status, returned: repos.length });
    } catch (e) { /* ignore */ }
  }
  // ---- TEMPORARY DIAGNOSTICS (only runs when every normal lookup came back empty) ----
  // Probes the candidate OneView endpoints/API versions and records, for each: URL, API version header,
  // HTTP status, total/count, top-level keys, member keys and the first object. Any probe that returns
  // firmware-drivers resources is also used to fill the list, so a working endpoint fixes the screen too.
  let probes = null;
  let workingVer; // first API version header (null = none sent) under which /rest/firmware-drivers returned items
  if (byUri.size === 0) {
    probes = [];
    const clip = (o) => { try { const t = JSON.stringify(o); return t.length > 700 ? t.slice(0, 700) + '…' : t; } catch (e) { return ''; } };
    const probe = async (endpoint, apiVer, opts = {}) => {
      const rec = { endpoint, apiVersion: apiVer == null ? '(none)' : String(apiVer) };
      try {
        const h = { ...(opts.noAuth ? {} : { Auth: session.sessionId }) };
        if (apiVer != null) h['X-API-Version'] = String(apiVer);
        const res = await monitorFetch(`${session.host}${endpoint}`, { headers: h });
        rec.status = res.status;
        const data = await res.json().catch(() => null);
        if (data && typeof data === 'object') {
          rec.keys = Object.keys(data).slice(0, 25);
          if (data.firmwareSettings && typeof data.firmwareSettings.baselineUri === 'string') knownBaseline = data.firmwareSettings.baselineUri;
          const mem = Array.isArray(data.members) ? data.members : (Array.isArray(data) ? data : null);
          if (mem) {
            rec.count = mem.length; rec.total = typeof data.total === 'number' ? data.total : null;
            if (mem[0]) { rec.memberKeys = Object.keys(mem[0]).slice(0, 30); rec.first = opts.noSample ? undefined : clip(mem[0]); }
            if (mem.length && /^\/rest\/firmware-drivers\?start=0&count=5$/.test(endpoint) && workingVer === undefined) workingVer = apiVer;
            mem.forEach((m) => { if (m && typeof m.uri === 'string' && /^\/rest\/firmware-drivers\/[^\/?#\s]+$/.test(m.uri) && !byUri.has(m.uri)) { const at = m.attributes || {}; byUri.set(m.uri, { ...m, version: m.version || at.version || at.bundleVersion, bundleType: m.bundleType || at.bundleType }); } });
          } else if (!opts.noSample) { rec.first = clip(data); }
        }
      } catch (e) { rec.status = 'error: ' + String(e.message).slice(0, 80); }
      probes.push(rec);
    };
    let knownBaseline = null;
    const cur = Number(session.apiVersion) || 0;
    await probe('/rest/version', null, { noAuth: true });
    await probe('/rest/appliance/nodeinfo/version', session.apiVersion);
    await probe('/rest/firmware-drivers?start=0&count=5', session.apiVersion);
    for (const v of [4000, 6000, 7200].filter((x) => x < cur)) await probe('/rest/firmware-drivers?start=0&count=5', v);
    await probe('/rest/firmware-drivers?start=0&count=5', null);
    await probe(`/rest/firmware-drivers?start=0&count=5&filter=${encodeURIComponent("\"bundleType='SPP'\"")}`, session.apiVersion);
    await probe('/rest/firmware-bundles?start=0&count=5', session.apiVersion);
    await probe('/rest/index/resources?category=firmware-drivers&start=0&count=5', session.apiVersion);
    await probe('/rest/repositories?start=0&count=10', session.apiVersion);
    // Free-text search over the whole appliance index: reveals the category/endpoint that really holds the Service Packs.
    for (const q of ['"Service pack"', 'ServicePack', '"HPE ProLiant"']) await probe(`/rest/index/resources?query=${encodeURIComponent(q)}&start=0&count=10`, session.apiVersion);
    // Other collection names a OneView 10 "Updates" page could be using.
    for (const p of ['/rest/updates', '/rest/firmware-updates', '/rest/firmware-catalog', '/rest/firmware-baselines', '/rest/baselines', '/rest/appliance/firmware-updates', '/rest/repositories/internal']) await probe(`${p}${p.includes('/repositories/') ? '' : '?start=0&count=5'}`, session.apiVersion);
    // Suggested in a reference chat (server hardware types listing baselines): checked here so the answer is evidence, not a guess.
    await probe('/rest/server-hardware-types?start=0&count=5', session.apiVersion);
    if (deviceUri && /^\/rest\/server-hardware\/[A-Za-z0-9_-]+$/.test(deviceUri)) {
      await probe(`${deviceUri}/firmware/settings`, session.apiVersion);
      await probe(`${deviceUri}/firmware`, session.apiVersion, { noSample: true });
      // The baseline this server already uses is addressable even though the collection is empty: read it.
      if (knownBaseline && /^\/rest\/firmware-drivers\/[^\/?#\s]+$/.test(knownBaseline)) await probe(knownBaseline, session.apiVersion);
    }
    // Read OneView's own web UI scripts and list the REST paths they mention for updates / baselines / firmware,
    // which shows which endpoint the Firmware > Updates page and the Update firmware dialog really call.
    try {
      const rootRes = await monitorFetch(`${session.host}/`, {});
      const html = rootRes.ok ? await rootRes.text() : '';
      const srcs = [...html.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/g)].map((m) => m[1]).slice(0, 12);
      const found = new Set();
      const base = new URL(rootRes.url || `${session.host}/`);
      for (const src of srcs) {
        let u; try { u = new URL(src, base); } catch (e) { continue; }
        if (u.host !== base.host) continue;
        try {
          const jr = await monitorFetch(u.href, {});
          if (!jr.ok) continue;
          const txt = (await jr.text()).slice(0, 12000000);
          for (const m of txt.matchAll(/\/rest\/[A-Za-z0-9_\/{}$.-]*(?:updat|baselin|firmware|repositor|catalog|bundle)[A-Za-z0-9_\/{}$.-]*/gi)) { found.add(m[0].slice(0, 90)); if (found.size >= 80) break; }
        } catch (e) { /* skip this script */ }
        if (found.size >= 80) break;
      }
      probes.push({ endpoint: '(OneView web UI scan)', status: rootRes.status, scripts: srcs.length, found: [...found].sort() });
    } catch (e) { probes.push({ endpoint: '(OneView web UI scan)', status: 'error: ' + String(e.message).slice(0, 80) }); }
  }
  if (probes && byUri.size > 0 && typeof workingVer !== 'undefined' && String(workingVer) !== String(session.apiVersion)) {
    // The collection only answers under another API version header: read the complete list that way.
    byUri.clear();
    const h2 = { Auth: session.sessionId, ...(workingVer == null ? {} : { 'X-API-Version': String(workingVer) }) };
    for (let guard = 0, start = 0; guard < 50; guard++) {
      const res = await monitorFetch(`${session.host}/rest/firmware-drivers?start=${start}&count=${ONEVIEW_PAGE_SIZE}`, { headers: h2 });
      if (!res.ok) break;
      const data = await res.json().catch(() => ({}));
      const batch = Array.isArray(data.members) ? data.members : [];
      batch.forEach((m) => { if (m && m.uri && !byUri.has(m.uri)) byUri.set(m.uri, m); });
      start += ONEVIEW_PAGE_SIZE;
      if (batch.length < ONEVIEW_PAGE_SIZE || (typeof data.total === 'number' && start >= data.total)) break;
    }
    probes.push({ endpoint: '(full list)', apiVersion: workingVer == null ? '(none)' : String(workingVer), status: 200, count: byUri.size });
  }
  const all = [...byUri.values()];
  if (all.length === 0) log.warn(`[oneview] firmware-drivers returned no bundles for ${site}/${zone} (api ${session.apiVersion}): ${JSON.stringify(tried)}`);
  // Field names per HPE's firmware-drivers schema — verify against your instance.
  // Several Service Packs often share the same `name`, so the version is added to the label
  // to tell them apart; non-SPP bundles (hotfix / supplemental) are marked, SPPs listed first.
  const label = (b) => {
    const name = String(b.name || '').trim(), version = String(b.version || '').trim();
    let l = name && version && !name.includes(version) ? `${name} ${version}` : (name || version || `Bundle ${b.resourceId || ''}`);
    const type = String(b.bundleType || '').trim();
    if (type && !/^(spp|servicepack)/i.test(type) && !/service pack/i.test(l)) l += ` [${type}]`;
    if (b._downloaded === false) l += ' (not downloaded yet)';
    if (b._state) l += ` [${b._state}${typeof b._size === 'number' ? ', downloaded ' + b._size : ''}]`;
    return l;
  };
  const isSpp = (b) => /^(spp|servicepack)/i.test(String(b.bundleType || '')) || /service pack/i.test(String(b.name || ''));
  // OneView only accepts packs that are already downloaded onto the appliance (the Update firmware dialog lists those).
  // When the catalog says which ones are downloaded, offer only those; otherwise keep the full catalog.
  const downloadedOnly = all.some((b) => b._downloaded === true) ? all.filter((b) => b._downloaded !== false) : all;
  const list = downloadedOnly
    .map((b) => ({ id: b.uri, label: label(b), _spp: isSpp(b), _dl: b._downloaded === false ? 0 : 1, _v: String(b.version || b.name || '') }))
    .sort((x, y) => (y._spp - x._spp) || (y._dl - x._dl) || y._v.localeCompare(x._v, undefined, { numeric: true }))
    .map(({ id, label }) => ({ id, label }));
  list.diag = { hiddenNotDownloaded: all.length - downloadedOnly.length, apiVersion: String(session.apiVersion), tried, repositories: repos, account, ...(updatesInfo ? { updates: updatesInfo } : {}), ...(wantProbes && probes ? { probes } : {}) };
  return list;
}

// GET /api/monitoring/firmware/baselines?site=&zone=&vendor=ome|oneview
app.get('/api/monitoring/firmware/baselines', authenticateToken, async (req, res) => {
  try {
    const { site, zone, vendor } = req.query;
    if (!site || !zone || !['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'site, zone and vendor (ome|oneview) are required' });
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const devUri = typeof req.query.deviceUri === 'string' ? req.query.deviceUri : '';
    const baselines = vendor === 'ome' ? await fetchOmeBaselines(site, zone) : await fetchOneviewBundles(site, zone, devUri, req.user.role !== 'Viewer');
    if (baselines === null) return res.status(400).json({ error: `${vendor === 'ome' ? 'Dell OME' : 'HPE OneView'} is not configured for this zone` });
    res.json({ baselines, ...(baselines && baselines.diag ? { diag: baselines.diag } : {}) });
  } catch (e) {
    sendErr(res, e);
  }
});

// ---- Submitting the job. Only ever targets the device IDs/URIs the caller
// sends — never "all devices" — and always against a baseline/bundle id the
// caller must have gotten from the /baselines route above (never a default).
async function applyOmeFirmware(site, zone, deviceIds, baselineId, scheduleMode) {
  const session = await getOmeToken(site, zone);
  if (!session) throw new Error('Dell OME is not configured for this zone');
  // OME has no "ApplyBaseline" REST action (that call returned 501 Not Implemented).
  // A baseline update is a normal Update_Task JOB, exactly as Dell's own Ansible module
  // (dellemc.openmanage.ome_firmware, baseline mode) submits it:
  //   1. read the baseline (RepositoryId / CatalogId),
  //   2. read its DeviceComplianceReports and collect, per selected device, the components
  //      whose UpdateAction is UPGRADE / DOWNGRADE (SourceName joined with ';'),
  //   3. POST /api/JobService/Jobs with JobType Update_Task and those Targets.
  const hdr = { 'X-Auth-Token': session.token };
  const getJson = async (path, what) => {
    const r = await monitorFetch(`${session.host}${path}`, { headers: hdr });
    if (!r.ok) throw new Error(`OME ${what} failed (${r.status})`);
    return r.json();
  };
  const bid = Number(baselineId);
  const base = await getJson(`/api/UpdateService/Baselines(${bid})`, 'baseline lookup');
  // Compliance reports, paged.
  const reports = [];
  for (let skip = 0, guard = 0; guard < 50; guard++) {
    const d = await getJson(`/api/UpdateService/Baselines(${bid})/DeviceComplianceReports?$top=${OME_PAGE_SIZE}&$skip=${skip}`, 'baseline compliance report');
    const batch = d.value || [];
    reports.push(...batch);
    skip += OME_PAGE_SIZE;
    if (batch.length < OME_PAGE_SIZE) break;
  }
  const wanted = new Set(deviceIds.map((x) => String(x)));
  const targets = [];
  const upToDate = [];
  const notInBaseline = new Set(wanted);
  for (const rep of reports) {
    const id = String(rep.DeviceId);
    if (!wanted.has(id)) continue;
    notInBaseline.delete(id);
    const comps = (rep.ComponentComplianceReports || []).filter((c) => c.UpdateAction === 'UPGRADE' || c.UpdateAction === 'DOWNGRADE').map((c) => c.SourceName).filter(Boolean);
    if (!comps.length) { upToDate.push(id); continue; }
    targets.push({ Id: Number(rep.DeviceId), Data: comps.join(';'), TargetType: { Id: rep.DeviceTypeId, Name: rep.DeviceTypeName } });
  }
  if (!targets.length) {
    const bad = (m) => { const er = new Error(m); er.statusCode = 400; return er; };
    if (notInBaseline.size === wanted.size) throw bad('None of the selected servers are part of this baseline in OME. Add them to the baseline (OME > Configuration > Firmware/Driver Compliance) and run the compliance check first.');
    throw bad('Nothing to update: the selected server(s) already match this baseline (no firmware component needs an upgrade).');
  }
  // Job type id: look it up (normally 5), fall back to the standard id.
  let jobTypeId = 5;
  try {
    const jt = await getJson(`/api/JobService/JobTypes?$filter=${encodeURIComponent("Name eq 'Update_Task'")}`, 'job type lookup');
    if (jt.value && jt.value[0] && typeof jt.value[0].Id === 'number') jobTypeId = jt.value[0].Id;
  } catch (e) { /* use the default */ }
  const stage = scheduleMode === 'stage';
  const params = [
    { Key: 'operationName', Value: 'INSTALL_FIRMWARE' },
    { Key: 'stagingValue', Value: stage ? 'true' : 'false' },
    { Key: 'signVerify', Value: 'true' },
  ];
  if (!stage) params.push({ Key: 'rebootType', Value: '3' }); // graceful reboot with forced shutdown, as Dell's module default
  params.push(
    { Key: 'complianceReportId', Value: String(bid) },
    { Key: 'repositoryId', Value: String(base.RepositoryId) },
    { Key: 'catalogId', Value: String(base.CatalogId) },
    { Key: 'complianceUpdate', Value: 'true' },
  );
  const res = await monitorFetch(`${session.host}/api/JobService/Jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': session.token },
    body: JSON.stringify({
      Id: 0, JobName: 'Firmware Update Task', JobDescription: 'Firmware update submitted from Monitoring',
      Schedule: 'startnow', State: 'Enabled', JobType: { Id: jobTypeId, Name: 'Update_Task' }, Targets: targets, Params: params,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { const t = await res.text(); const j = JSON.parse(t); const m = j && j.error && (j.error['@Message.ExtendedInfo'] || [])[0]; detail = (m && (m.Message || m.MessageId)) || ''; } catch (e) { /* no body detail */ }
    throw new Error(`OME firmware update job failed (${res.status})${detail ? ': ' + String(detail).slice(0, 300) : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  const jobId = data.Id != null ? data.Id : data.JobId;
  if (jobId == null || jobId === 0) throw new Error('OME accepted the request but did not return a job id');
  return { jobRef: String(jobId), vendor: 'ome', skippedUpToDate: upToDate, notInBaseline: [...notInBaseline] };
}
async function applyOneviewFirmware(site, zone, deviceUris, bundleUri, forceInstall, installType) {
  let session = await getOneviewSession(site, zone);
  if (!session) throw new Error('HPE OneView is not configured for this zone');
  // Every call below goes through ovFetch: if OneView answers 401 (session ended early) it signs in again and repeats the call once.
  const ovFetch = async (url, init) => {
    const go = () => monitorFetch(url, { ...(init || {}), headers: { ...((init && init.headers) || {}), Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) } });
    let r = await go();
    if (r.status === 401) { session = await reloginOneview(site, zone); r = await go(); }
    return r;
  };
  // firmwareInstallType values are quoted directly from HPE's own "Server
  // profile firmware settings" documentation — not independently confirmed
  // against a live request the way refreshState was, but a real documented
  // enum rather than a guess: 'FirmwareOnlyOfflineMode' boots into the
  // Service Pack environment (no OS/SUT needed, closest to an immediate,
  // self-contained update); 'FirmwareOnly' or 'FirmwareAndOSDrivers' apply
  // live via Smart Update Tools while the OS is running, and per HPE's own
  // docs "a server reboot may be required to complete the firmware
  // activation" afterward — i.e. reboot timing isn't a separate request
  // field, it's a consequence of which of these you pick. Verify the exact
  // string values against your instance regardless.
  const resolvedInstallType = installType === 'osdrivers' ? 'FirmwareAndOSDrivers' : (installType === 'live' ? 'FirmwareOnly' : 'FirmwareOnlyOfflineMode');
  // Server hardware without a profile is updated with PATCH {hardware uri}/firmware/settings
  // (HPE OneView Python SDK: ServerHardware.perform_firmware_update). The earlier POST {uri}/firmware
  // is not an update call. Body: [{op:'replace', value:{baselineUri, firmwareInstallType, installationPolicy}}].
  // Prerequisites (same checks the SDK makes): Gen10 or newer, no server profile, iLO Advanced, not already
  // updating, and power state Off for the offline mode / On for the Smart Update Tools modes.
  const installationPolicy = forceInstall ? 'NotEqualToBaseline' : 'LowerThanBaseline';
  const results = [];
  for (const uri of deviceUris) {
    try {
      const hdrs = { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) };
      const hr = await ovFetch(`${session.host}${uri}`, { headers: hdrs });
      if (!hr.ok) throw new Error(`could not read the server record (HTTP ${hr.status})${oneviewFirmwareHint(hr.status)}`);
      const hw = await hr.json();
      const problems = [];
      const gen = String(hw.mpModel || '').match(/\d+$/);
      if (gen && Number(gen[0]) < 5) problems.push('server is older than Gen10 (OneView only updates Gen10 and newer without a profile)');
      if (hw.serverProfileUri) problems.push('a server profile is assigned - update the firmware from the Server Profile instead');
      if (hw.state === 'UpdatingFirmware') problems.push('a firmware update is already running on this server');
      if (hw.powerState !== 'Off' && resolvedInstallType === 'FirmwareOnlyOfflineMode') problems.push('the server must be powered Off for "Firmware only" (offline mode)');
      if (hw.powerState !== 'On' && resolvedInstallType !== 'FirmwareOnlyOfflineMode') problems.push('the server must be powered On for the Smart Update Tools methods');
      if (hw.mpLicenseType && hw.mpLicenseType !== 'iLO Advanced') problems.push('iLO Advanced license is required');
      if (problems.length) throw new Error(problems.join('; '));
      const sendPatch = (baselineUri) => ovFetch(`${session.host}${uri}/firmware/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...hdrs },
        body: JSON.stringify([{ op: 'replace', value: { baselineUri, firmwareInstallType: resolvedInstallType, installationPolicy } }]),
      });
      let res = await sendPatch(bundleUri);
      let retryNote = '';
      if (!res.ok) {
        let detail = ''; try { const j = await res.clone().json(); detail = j.message || j.errorCode || ''; } catch (e) { /* no body */ }
        const notValid = /baseline is not valid|FWBASELINE/i.test(detail);
        let catalogNote = '';
        if (notValid) {
          try {
            const id = String(bundleUri).split('/').pop();
            const cr = await ovFetch(`${session.host}/rest/updates?start=0&count=500`, { headers: hdrs });
            const cd = cr.ok ? await cr.json().catch(() => null) : null;
            const item = (Array.isArray(cd) ? cd : (cd && cd.members) || []).find((u) => u && u.sppId === id);
            // OneView 10 downloads only the components a server needs (inventory-based download), so the pack may be
            // addressable by its catalog URI (/rest/updates/<id>) even though it is not in firmware-drivers. Try that once.
            if (item && typeof item.uri === 'string' && /^\/rest\/updates\/[^\/?#\s]+$/.test(item.uri)) {
              const r2 = await sendPatch(item.uri);
              if (r2.ok) { res = r2; } else { let d2 = ''; try { const j2 = await r2.json(); d2 = j2.message || j2.errorCode || ''; } catch (e) { /* no body */ } retryNote = ` [retry with ${item.uri}: HTTP ${r2.status}${d2 ? ' ' + String(d2).slice(0, 120) : ''}]`; }
            }
            if (item) catalogNote = ` [OneView catalog: state=${item.state}, downloaded=${item.sizeOfDownloadedComps}, appliance=${JSON.stringify(item.applianceData || null).slice(0, 200)}]`;
          } catch (e) { /* note is optional */ }
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}${detail ? ': ' + String(detail).slice(0, 300) : ''}${notValid ? ' - this pack is probably not downloaded onto OneView yet. In OneView open Firmware > Updates, download it (Actions > Download), then retry.' + catalogNote + retryNote : oneviewFirmwareHint(res.status)}`);
      }
      const data = await res.json().catch(() => ({}));
      const taskUri = data.uri || res.headers.get('Location');
      if (!taskUri) throw new Error('no task uri in response');
      results.push({ uri, ok: true, taskUri });
    } catch (e) {
      results.push({ uri, ok: false, error: e.message });
    }
  }
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (succeeded.length === 0) {
    const er = new Error(`OneView firmware update was not started for ${deviceUris.length === 1 ? 'the selected server' : 'any of the ' + deviceUris.length + ' selected servers'}: ${failed.map((f) => (deviceUris.length > 1 ? f.uri + ' - ' : '') + f.error).slice(0, 3).join(' | ')}`);
    er.statusCode = 422;
    throw er;
  }
  return { jobRef: succeeded.map((r) => r.taskUri).join(','), vendor: 'oneview', failed, perDevice: succeeded.map((r) => ({ id: r.uri, taskUri: r.taskUri })) };
}

// ---- Persistent per-server firmware job records (table firmware_jobs) ----
const FW_JOB_LIST_RUNNING_MS = 12 * 3600 * 1000; // a job still "Running" after this long is no longer listed
const FW_JOB_LIST_DONE_MS = 2 * 3600 * 1000;     // finished jobs stay listed this long
function fwJobAggregate(rows) {
  if (rows.some((r) => r.state === 'Running')) return 'Running';
  return rows.every((r) => r.state === 'Failed') ? 'Failed' : 'Completed';
}
// Final outcome of one server's update -> audit trail (the start is audited as FIRMWARE_APPLY). Written once, when a Running row finishes.
function auditFirmwareOutcome(row, state, error) {
  try {
    auditLog(null, state === 'Completed' ? 'FIRMWARE_COMPLETED' : 'FIRMWARE_FAILED', { username: row.started_by || 'system', entity: 'firmware', entityId: row.device_id, site: row.site, status: state === 'Completed' ? 'success' : 'failure',
      details: { vendor: row.vendor, zone: row.zone, device: row.device_name, serial: row.serial, baseline: row.baseline_label || row.baseline_id, taskUri: row.task_uri, jobRef: row.job_ref, source: row.source || 'dcim', ...(error ? { error: String(error).slice(0, 300) } : {}) } });
  } catch (e) { /* auditing never affects tracking */ }
}
async function persistFirmwareJobStatus(vendor, site, zone, jobRef, result) {
  try {
    const [rows] = await pool.query('SELECT * FROM firmware_jobs WHERE vendor=? AND site=? AND zone=? AND job_ref=?', [vendor, site, zone, jobRef]);
    const now = Date.now();
    for (const row of rows) {
      if (row.state !== 'Running') continue; // a finished row never goes back to Running
      let d = null;
      if (Array.isArray(result.devices)) {
        d = result.devices.find((x) => (x.taskUri ? x.taskUri === row.task_uri : (x.key && [row.device_id, row.serial, row.device_name].some((v) => v && String(v) === x.key))));
      }
      let state = d && d.status ? d.status : null;
      let percent = d && d.percent != null ? d.percent : null;
      const step = d && d.step ? d.step : null;
      const error = d && d.error ? d.error : null;
      if (!state && (result.status === 'Completed' || result.status === 'Failed')) { state = result.status; if (result.status === 'Completed') percent = 100; }
      if (!state) state = 'Running';
      const done = state === 'Completed' || state === 'Failed';
      await pool.query('UPDATE firmware_jobs SET state=?, percent=COALESCE(?, percent), step=COALESCE(?, step), error=COALESCE(?, error), updated_at=?, finished_at=? WHERE id=?',
        [state, percent, step, error, now, done ? now : null, row.id]);
      if (done) auditFirmwareOutcome(row, state, error);
    }
  } catch (e) { log.warn(`[firmware-jobs] could not save status: ${e.message}`); }
}
// Before a new update is accepted: for each requested server that has a recorded job (database or memory), ask the
// appliance whether that job is really still running. Finished jobs are released (so the server can be updated again),
// running ones are (re)registered in the in-memory tracker so the normal "already in progress" check catches them.
async function refreshTrackedFirmwareJobs(vendor, site, zone, deviceIds) {
  const ids = deviceIds.map(String);
  let rows = [];
  try { [rows] = await pool.query("SELECT * FROM firmware_jobs WHERE vendor=? AND site=? AND zone=? AND state='Running' AND device_id IN (?)", [vendor, site, zone, ids]); } catch (e) { rows = []; }
  const cache = new Map();
  const live = async (ref) => {
    if (cache.has(ref)) return cache.get(ref);
    let out = null;
    try { out = vendor === 'ome' ? await getOmeJobStatus(site, zone, ref) : await getOneviewTaskStatus(site, zone, ref); } catch (e) { out = null; }
    cache.set(ref, out);
    return out;
  };
  for (const id of ids) {
    const key = deviceJobKey(vendor, site, zone, id);
    const mem = deviceFirmwareJobs[key];
    if (mem && !mem.jobRef) continue; // another request is submitting this server right now
    const row = rows.find((r) => r.device_id === id);
    const ref = vendor === 'oneview' && row && row.task_uri ? row.task_uri : (row ? row.job_ref : (mem && mem.jobRef));
    if (!ref) continue;
    const st = await live(ref);
    if (st && (st.status === 'Completed' || st.status === 'Failed')) {
      delete deviceFirmwareJobs[key];
      if (row) { try { await pool.query('UPDATE firmware_jobs SET state=?, percent=?, updated_at=?, finished_at=? WHERE id=?', [st.status, st.status === 'Completed' ? 100 : row.percent, Date.now(), Date.now(), row.id]); auditFirmwareOutcome(row, st.status, st.error); } catch (e) { /* best effort */ } }
    } else if (!mem && row && (st || Date.now() - Number(row.started_at) < FIRMWARE_JOB_TRACK_TTL_MS)) {
      // Still running (or the appliance could not be asked just now): treat as in progress.
      deviceFirmwareJobs[key] = { jobRef: row.job_ref, baselineId: row.baseline_id, startedBy: row.started_by, startedAt: Number(row.started_at) };
    }
  }
}
// ---- Updates started directly in HPE OneView / Dell OME (not through DCIM) ----
// A background pass reads each configured appliance's own task/job list, records any running firmware update it does not already
// know (source = 'appliance'), and keeps the status of every running row fresh. These rows lock the server and show to all users.
const FW_SCAN_INTERVAL_MS = Math.max(10000, Number(process.env.MONITOR_FW_SCAN_MS) || 30000);
let fwJobsTickBusy = false;
let fwJobsLastTick = 0;
function fwSubmissionInFlight(vendor, site, zone) { const p = `${vendor}|${site}|${zone}|`; return Object.keys(deviceFirmwareJobs).some((k) => k.startsWith(p) && !deviceFirmwareJobs[k].jobRef); }
async function scanOneviewExternalFirmware(site, zone) {
  const diag = { site, zone, vendor: 'oneview' };
  if (fwSubmissionInFlight('oneview', site, zone)) { diag.skipped = 'a DCIM submission is being recorded'; return { added: 0, diag }; }
  const session = await getOneviewSession(site, zone);
  if (!session) { diag.skipped = 'not configured'; return { added: 0, diag }; }
  const hdrs = { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) };
  // Running tasks only (server-side filter), newest first; fall back to the unfiltered newest tasks if the appliance refuses the filter.
  const attempts = [
    ['filter running', `/rest/tasks?start=0&count=200&filter=${encodeURIComponent("\"taskState='Running'\"")}`],
    ['newest first', '/rest/tasks?start=0&count=200&sort=created:descending'],
    ['plain', '/rest/tasks?start=0&count=200'],
  ];
  let tasks = [];
  for (const [label, path] of attempts) {
    const res = await monitorFetch(`${session.host}${path}`, { headers: hdrs });
    diag.query = label; diag.status = res.status;
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    tasks = Array.isArray(data) ? data : (data && Array.isArray(data.members) ? data.members : []);
    diag.returned = tasks.length; diag.total = data && typeof data.total === 'number' ? data.total : null;
    break;
  }
  const RUNNING = ['Running', 'Starting', 'New', 'Pending', 'Stopping'];
  const textOf = (t) => {
    const pu = Array.isArray(t.progressUpdates) && t.progressUpdates.length ? t.progressUpdates[t.progressUpdates.length - 1] : null;
    return `${t.name || ''} ${t.taskStatus || ''} ${t.taskType || ''} ${(pu && (pu.statusUpdate || pu.message)) || ''}`;
  };
  const resUri = (t) => { const ar = t.associatedResource || {}; return typeof ar.resourceUri === 'string' ? ar.resourceUri : ''; };
  const isFw = (t) => RUNNING.includes(t.taskState) && /^\/rest\/server-hardware\/[A-Za-z0-9_-]+$/.test(resUri(t)) && /firmware|baseline|smart update|service pack|\bSPP\b|\bupdat/i.test(textOf(t)) && !/power|refresh|collect|identify|\bled\b|reset|remote console/i.test(String(t.name || ''));
  diag.running = tasks.filter((t) => t && RUNNING.includes(t.taskState)).length;
  diag.runningSample = tasks.filter((t) => t && RUNNING.includes(t.taskState)).slice(0, 10).map((t) => ({ name: t.name, taskState: t.taskState, taskStatus: t.taskStatus, taskType: t.taskType, owner: t.owner && (t.owner.name || t.owner), resource: t.associatedResource && { uri: t.associatedResource.resourceUri, name: t.associatedResource.resourceName, category: t.associatedResource.resourceCategory }, matched: isFw(t) }));
  let added = 0;
  for (const t of tasks) {
    if (!t || typeof t.uri !== 'string' || !isFw(t)) continue;
    const ar = t.associatedResource || {};
    const uri = resUri(t);
    const [exists] = await pool.query('SELECT id FROM firmware_jobs WHERE vendor=? AND site=? AND zone=? AND (task_uri=? OR job_ref=? OR (device_id=? AND state=? AND source=?)) LIMIT 1', ['oneview', site, zone, t.uri, t.uri, uri, 'Running', 'dcim']);
    if (exists.length) continue;
    const pc = [t.computedPercentComplete, t.percentComplete].find((v) => typeof v === 'number');
    const created = Date.parse(t.created) || Date.now();
    await pool.query('INSERT INTO firmware_jobs (vendor, site, zone, device_id, device_name, serial, job_ref, task_uri, baseline_id, baseline_label, started_by, started_at, state, percent, step, updated_at, source, job_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['oneview', site, zone, uri, String(ar.resourceName || uri).slice(0, 255), null, t.uri, t.uri, null, String(t.name || 'Firmware update').slice(0, 500), String((t.owner && (t.owner.name || t.owner)) || t.owner || 'OneView console').slice(0, 100), created, 'Running', typeof pc === 'number' ? Math.min(100, pc) : 0, t.taskStatus ? String(t.taskStatus).slice(0, 200) : null, Date.now(), 'appliance', String(t.name || '').slice(0, 255)]);
    added++;
  }
  diag.added = added;
  return { added, diag };
}
async function scanOmeExternalFirmware(site, zone) {
  const diag = { site, zone, vendor: 'ome' };
  if (fwSubmissionInFlight('ome', site, zone)) { diag.skipped = 'a DCIM submission is being recorded'; return { added: 0, diag }; }
  const session = await getOmeToken(site, zone);
  if (!session) { diag.skipped = 'not configured'; return { added: 0, diag }; }
  const hdrs = { 'X-Auth-Token': session.token };
  // Newest jobs first when the appliance supports ordering; otherwise read all pages (up to 1000 jobs).
  let jobs = [];
  let res = await monitorFetch(`${session.host}/api/JobService/Jobs?$top=200&$orderby=Id desc`, { headers: hdrs });
  diag.status = res.status;
  if (res.ok) {
    const data = await res.json().catch(() => null);
    jobs = data && Array.isArray(data.value) ? data.value : [];
    diag.query = 'newest first';
  } else {
    diag.query = 'all pages';
    for (let skip = 0; skip < 1000; skip += 100) {
      const r = await monitorFetch(`${session.host}/api/JobService/Jobs?$top=100&$skip=${skip}`, { headers: hdrs });
      diag.status = r.status;
      if (!r.ok) break;
      const d = await r.json().catch(() => null);
      const batch = d && Array.isArray(d.value) ? d.value : [];
      jobs.push(...batch);
      if (batch.length < 100) break;
    }
  }
  diag.returned = jobs.length;
  const statusOf = (j) => String((j.LastRunStatus && j.LastRunStatus.Name) || (j.JobStatus && j.JobStatus.Name) || '');
  const isRunning = (j) => /^(running|starting|queued)$/i.test(statusOf(j));
  const isFw = (j) => isRunning(j) && ((j.JobType && j.JobType.Name === 'Update_Task') || /firmware|baseline|catalog update|update/i.test(`${j.JobName || ''} ${j.JobDescription || ''}`) && !/inventory|warranty|refresh|report|discovery|health|status|power/i.test(`${(j.JobType && j.JobType.Name) || ''} ${j.JobName || ''}`));
  diag.running = jobs.filter(isRunning).length;
  diag.runningSample = jobs.filter(isRunning).slice(0, 10).map((j) => ({ Id: j.Id, JobName: j.JobName, type: j.JobType && j.JobType.Name, status: statusOf(j), createdBy: j.CreatedBy, targets: Array.isArray(j.Targets) ? j.Targets.map((t) => `${t.Id}${t.TargetType ? ':' + t.TargetType.Name : ''}`).slice(0, 6) : null, matched: isFw(j) }));
  const cached = deviceSnapshotCache[snapshotKey('OME', site, zone)];
  let names = cached && Array.isArray(cached.devices) ? cached.devices : null;
  let added = 0;
  for (const j of jobs) {
    if (!j || !isFw(j)) continue;
    const [exists] = await pool.query('SELECT id FROM firmware_jobs WHERE vendor=? AND site=? AND zone=? AND job_ref=? LIMIT 1', ['ome', site, zone, String(j.Id)]);
    if (exists.length) continue;
    if (!names) { try { names = await fetchOmeDevicesRaw(site, zone); } catch (e) { names = []; } }
    const started = Date.parse(j.LastRun || j.StartTime || j.CreationTime || '') || Date.now();
    let targets = (Array.isArray(j.Targets) ? j.Targets : []).filter((t) => t && t.Id != null && (!t.TargetType || /device/i.test(String(t.TargetType.Name || 'DEVICE'))));
    if (!targets.length) targets = [{ Id: `job-${j.Id}`, none: true }]; // keep the job visible even when OME lists no device targets
    for (const t of targets) {
      const dev = (names || []).find((d) => String(d.id) === String(t.Id)) || {};
      await pool.query('INSERT INTO firmware_jobs (vendor, site, zone, device_id, device_name, serial, job_ref, task_uri, baseline_id, baseline_label, started_by, started_at, state, percent, updated_at, source, job_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ['ome', site, zone, String(t.Id), String(t.none ? (j.JobName || `OME job ${j.Id}`) : (dev.name || `Device ${t.Id}`)).slice(0, 255), dev.serialNumber || null, String(j.Id), null, null, String(j.JobName || 'Firmware update').slice(0, 500), String(j.CreatedBy || j.Owner || 'Dell OME console').slice(0, 100), started, 'Running', 0, Date.now(), 'appliance', String(j.JobName || '').slice(0, 255)]);
      added++;
    }
  }
  diag.added = added;
  return { added, diag };
}
// Runs every scan now and reports exactly what each appliance returned (Admin / Operator).
async function fwJobsScanDiag(allowedSites) {
  const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones ORDER BY site, zone_name');
  const out = [];
  for (const z of zoneRows) {
    if (!allowedSites.includes(z.site)) continue;
    for (const [vendor, product, fn] of [['oneview', 'ONEVIEW', scanOneviewExternalFirmware], ['ome', 'OME', scanOmeExternalFirmware]]) {
      if (!getMonitorConfig(product, z.site, z.zone)) continue;
      try { out.push((await fn(z.site, z.zone)).diag); } catch (e) { out.push({ site: z.site, zone: z.zone, vendor, error: String(e.message).slice(0, 200) }); }
    }
  }
  return out;
}
async function fwJobsTick(force) {
  if (fwJobsTickBusy) return;
  if (!force && Date.now() - fwJobsLastTick < 8000) return;
  fwJobsTickBusy = true;
  try {
    const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones');
    for (const z of zoneRows) {
      if (getMonitorConfig('ONEVIEW', z.site, z.zone)) { try { await scanOneviewExternalFirmware(z.site, z.zone); } catch (e) { log.warn(`[firmware-jobs] OneView scan ${z.site}/${z.zone}: ${String(e.message).slice(0, 120)}`); } }
      if (getMonitorConfig('OME', z.site, z.zone)) { try { await scanOmeExternalFirmware(z.site, z.zone); } catch (e) { log.warn(`[firmware-jobs] OME scan ${z.site}/${z.zone}: ${String(e.message).slice(0, 120)}`); } }
    }
    // Keep every running row current, whoever started it and whether or not anyone has the page open.
    const [running] = await pool.query("SELECT DISTINCT vendor, site, zone, job_ref, device_id FROM firmware_jobs WHERE state='Running' AND started_at > ? AND job_ref IS NOT NULL", [Date.now() - FW_JOB_LIST_RUNNING_MS]);
    for (const g of running) {
      try {
        const result = g.vendor === 'ome' ? await getOmeJobStatus(g.site, g.zone, g.job_ref)
          : g.vendor === 'redfish' ? await redfishRoutesModule.getRedfishTaskStatus(g.device_id, g.job_ref)
          : await getOneviewTaskStatus(g.site, g.zone, g.job_ref);
        await persistFirmwareJobStatus(g.vendor, g.site, g.zone, g.job_ref, result);
        if (result.status === 'Completed' || result.status === 'Failed') {
          const [rows] = await pool.query('SELECT device_id FROM firmware_jobs WHERE vendor=? AND site=? AND zone=? AND job_ref=?', [g.vendor, g.site, g.zone, g.job_ref]);
          rows.forEach((r) => { const k = deviceJobKey(g.vendor, g.site, g.zone, r.device_id); if (deviceFirmwareJobs[k] && deviceFirmwareJobs[k].jobRef === g.job_ref) delete deviceFirmwareJobs[k]; });
        }
      } catch (e) { /* appliance unreachable this round: keep the last known state */ }
    }
  } catch (e) { log.warn(`[firmware-jobs] background pass failed: ${String(e.message).slice(0, 160)}`); }
  finally { fwJobsTickBusy = false; fwJobsLastTick = Date.now(); }
}
// GET /api/monitoring/firmware/jobs/scan — scan the appliances right now and return what they reported (Admin / Operator)
app.get('/api/monitoring/firmware/jobs/scan', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const allowed = await getAllowedSitesForUser(req.user);
    res.json({ scannedAt: Date.now(), intervalSeconds: Math.round(FW_SCAN_INTERVAL_MS / 1000), zones: await fwJobsScanDiag(allowed) });
  } catch (e) { sendErr(res, e); }
});
// GET /api/monitoring/firmware/jobs/active?site=&zone= — jobs still running (and recently finished) for the sites this user may see
app.get('/api/monitoring/firmware/jobs/active', authenticateToken, async (req, res) => {
  try {
    if (req.query.refresh === '1') fwJobsTick(false).catch(() => { });
    const histHours = Math.min(72, Math.max(0, Number(req.query.history) || 0));
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.length) return res.json({ jobs: [] });
    const where = ['site IN (?)'];
    const params = [allowed];
    if (req.query.site) { where.push('site=?'); params.push(String(req.query.site)); }
    if (req.query.zone) { where.push('zone=?'); params.push(String(req.query.zone)); }
    const now = Date.now();
    const [rows] = await pool.query(`SELECT * FROM firmware_jobs WHERE ${where.join(' AND ')} AND ((state='Running' AND started_at > ?) OR (state<>'Running' AND finished_at > ?)) ORDER BY started_at ASC, id ASC`,
      [...params, now - FW_JOB_LIST_RUNNING_MS, now - Math.max(FW_JOB_LIST_DONE_MS, histHours * 3600 * 1000)]);
    const groups = new Map();
    rows.forEach((r) => {
      const gk = `${r.vendor}|${r.site}|${r.zone}|${r.job_ref}|${r.started_at}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(r);
    });
    const jobs = [...groups.values()].map((g) => ({
      vendor: g[0].vendor, vendorLabel: g[0].vendor === 'ome' ? 'Dell OME' : g[0].vendor === 'oneview' ? 'HPE OneView' : 'Redfish', site: g[0].site, zone: g[0].zone,
      jobRef: g[0].job_ref, targetLabel: g[0].baseline_label || '', startedBy: g[0].started_by, startedAt: Number(g[0].started_at), source: g[0].source || 'dcim',
      finishedAt: g.every((r) => r.state !== 'Running') ? Math.max(...g.map((r) => Number(r.finished_at) || 0)) || null : null,
      deviceCount: g.length, requestedCount: g.length, failedCount: 0, status: fwJobAggregate(g),
      rows: g.map((r) => ({ id: r.device_id, name: r.device_name || r.device_id, tag: r.serial || null, taskUri: r.task_uri || null, status: r.state, percent: r.percent, step: r.step, jobError: r.error, done: r.state !== 'Running' })),
    }));
    res.json({ jobs });
  } catch (e) { sendErr(res, e); }
});

// Per-DEVICE "a firmware job is currently running on this" tracker. This is
// what actually matters for safety — not whether a request was repeated
// verbatim, but whether a specific piece of hardware already has a job in
// flight, even if it's only part of a larger, non-identical batch (e.g. User
// A updates devices 1-3, User B separately selects 3-5: device 3 overlaps
// and must be caught even though the two requests don't match).
// Keyed "vendor|site|zone|deviceId" -> { jobRef, baselineId, startedBy, startedAt }.
const deviceFirmwareJobs = {};
function deviceJobKey(vendor, site, zone, deviceId) { return `${vendor}|${site}|${zone}|${deviceId}`; }
// Safety backstop: entries are normally removed the moment the job-status
// poll below (the same 5s poll the "Firmware Update Jobs" panel already
// runs) observes Completed/Failed. But if everyone closes the Monitoring
// page before that poll ever fires again, nothing would ever clear the
// entry — so anything older than this is treated as stale and ignored,
// rather than blocking that device forever over a job no one is watching
// anymore.
const FIRMWARE_JOB_TRACK_TTL_MS = Number(process.env.MONITOR_FW_JOB_TTL_MS) || 3 * 60 * 60 * 1000; // 3h default
function isTrackedJobStale(entry) { return !entry || (Date.now() - entry.startedAt > FIRMWARE_JOB_TRACK_TTL_MS); }

// POST /api/monitoring/firmware/apply
// body: { site, zone, vendor, deviceIds: [...], baselineId, forceInstall? }
app.post('/api/monitoring/firmware/apply', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const { site, zone, vendor, deviceIds, baselineId, forceInstall, scheduleMode, installType } = req.body;
    if (!site || !zone || !['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'site, zone and vendor (ome|oneview) are required' });
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return res.status(400).json({ error: 'deviceIds must be a non-empty array' });
    if (!baselineId) return res.status(400).json({ error: 'baselineId is required — pick one from /api/monitoring/firmware/baselines, never a default' });
    if (vendor === 'oneview' && installType != null && installType !== '' && !['offline', 'live', 'osdrivers'].includes(String(installType))) return res.status(400).json({ error: 'installType must be one of: offline, live, osdrivers' });
    if (!assertSafeApplianceRefs(res, vendor, deviceIds)) return;
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const user = req.user;
    const rawMeta = req.body.deviceMeta && typeof req.body.deviceMeta === 'object' ? req.body.deviceMeta : {};
    const baselineLabel = typeof req.body.baselineLabel === 'string' ? req.body.baselineLabel.slice(0, 500) : '';
    // Audit detail for this request (merged into the FIRMWARE_APPLY audit record by the audit middleware, success or failure).
    res.locals.auditExtra = { vendor, baselineId: String(baselineId).slice(0, 200), baselineLabel: baselineLabel.slice(0, 200), ...(vendor === 'oneview' ? { installType: installType || 'offline' } : {}), forceInstall: !!forceInstall,
      devices: deviceIds.slice(0, 50).map((id) => ({ id, name: rawMeta[id] && rawMeta[id].name ? String(rawMeta[id].name).slice(0, 100) : undefined })) };
    // Ask the appliance whether earlier jobs for these servers are really still running (see refreshTrackedFirmwareJobs).
    await refreshTrackedFirmwareJobs(vendor, site, zone, deviceIds);

    // Split the requested devices into "already has a job running — skip
    // it and say so" vs "free to submit", and RESERVE the free ones in the
    // tracker immediately. This whole loop runs synchronously (nothing is
    // awaited inside it), so two requests racing for the same device can't
    // both see it as free — whichever request's turn runs first on Node's
    // single thread claims it, and the other correctly sees it already
    // taken. The reservation uses a null jobRef as a placeholder until the
    // appliance actually accepts the submission below.
    const skipped = [];
    const toSubmit = [];
    for (const id of deviceIds) {
      const key = deviceJobKey(vendor, site, zone, id);
      const existing = deviceFirmwareJobs[key];
      if (existing && !isTrackedJobStale(existing)) {
        skipped.push({ deviceId: id, startedBy: existing.startedBy, startedAt: existing.startedAt, jobRef: existing.jobRef });
      } else {
        toSubmit.push(id);
        deviceFirmwareJobs[key] = { jobRef: null, baselineId, startedBy: user.name || user.username, startedAt: Date.now() };
      }
    }

    if (toSubmit.length === 0) {
      return res.json({ submitted: [], skipped, jobRef: null, vendor, failed: [],
        message: `All ${deviceIds.length} selected device(s) already have a firmware update in progress.` });
    }

    try {
      const r = vendor === 'ome'
        ? await applyOmeFirmware(site, zone, toSubmit, baselineId, scheduleMode)
        : await applyOneviewFirmware(site, zone, toSubmit, baselineId, forceInstall, installType);

      // Fill in the real job reference now that the appliance has actually
      // accepted it, replacing the placeholder reservation. OME returns one
      // shared job for the whole batch, so every submitted device gets that
      // same jobRef and will be cleared together when it resolves — which
      // matches reality, since it genuinely IS one job on the appliance
      // side. OneView submits one task PER device, so each device is
      // tracked by its own task URI instead, and clears independently.
      if (vendor === 'ome') {
        // Servers OME reported as already matching the baseline (or not in it) are not part of the job: release them.
        const notInJob = new Set([...(r.skippedUpToDate || []), ...(r.notInBaseline || [])].map(String));
        toSubmit.forEach((id) => { const key = deviceJobKey(vendor, site, zone, id); if (!deviceFirmwareJobs[key]) return; if (notInJob.has(String(id))) delete deviceFirmwareJobs[key]; else deviceFirmwareJobs[key].jobRef = r.jobRef; });
      } else {
        // applyOneviewFirmware attempts each device independently and
        // reports which URIs failed to submit (r.failed); everything else
        // in toSubmit succeeded. A failed submission never actually started
        // a job on the appliance, so its reservation is released rather than
        // tracked. applyOneviewFirmware doesn't expose a per-device taskUri
        // mapping for the succeeded ones (only the joined jobRef + failed
        // list), so successes fall back to the shared joined jobRef — still
        // correct, just means a OneView batch's devices clear together
        // rather than one-by-one, same as the OME case above.
        const failedUris = new Set((r.failed || []).map((f) => f.uri));
        toSubmit.forEach((uri) => {
          const key = deviceJobKey(vendor, site, zone, uri);
          if (!deviceFirmwareJobs[key]) return;
          if (failedUris.has(uri)) { delete deviceFirmwareJobs[key]; return; }
          deviceFirmwareJobs[key].jobRef = r.jobRef;
        });
      }

      // The submitted devices' firmware is about to change on the appliance —
      // don't let a cached pre-job snapshot linger and answer the next view or
      // sync with stale data for up to DEVICE_SNAPSHOT_TTL_MS. (The job itself
      // still takes real time to complete on the appliance, so the very next
      // fetch may still show the old version — that part isn't fixable here,
      // it's just no longer masked by our own cache on top of it.)
      invalidateDeviceSnapshot(vendor === 'ome' ? 'OME' : 'ONEVIEW', site, zone);
      Object.assign(res.locals.auditExtra, { jobRef: String(r.jobRef || '').slice(0, 500), submitted: toSubmit.length - ((r.failed && r.failed.length) || 0), failedToSubmit: (r.failed && r.failed.length) || 0, skippedBusy: skipped.length,
        ...(r.failed && r.failed.length ? { failedDetail: r.failed.slice(0, 20).map((f) => ({ id: f.uri, error: String(f.error).slice(0, 160) })) } : {}) });

      // Audit trail — this is a privileged action against production hardware.
      await pool.query(
        `INSERT INTO dc_activities (id, site, zone, hardware_type, activity_type, description, start_date, completion_date, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [genId('ACT'), site, zone, vendor === 'ome' ? 'DellServer' : 'HPServer', 'Firmware Update',
         `Firmware update submitted via Monitoring for ${toSubmit.length} device(s) against ${baselineId} (job ref: ${r.jobRef || 'pending'})` +
         (r.failed && r.failed.length ? ` — ${r.failed.length} of ${toSubmit.length} device(s) failed to submit and were not included` : '') +
         (skipped.length ? ` — ${skipped.length} other device(s) in the original selection were skipped (already had an update in progress)` : ''),
         normalizeDateInput(new Date()), null, user.name || user.username]
      );

      try {
        const failedSet = new Set((r.failed || []).map((f) => String(f.uri)));
        const outSet = new Set([...(r.skippedUpToDate || []), ...(r.notInBaseline || [])].map(String));
        const taskBy = new Map((r.perDevice || []).map((p) => [String(p.id), p.taskUri]));
        const now = Date.now();
        for (const id of toSubmit.map(String)) {
          if (failedSet.has(id) || outSet.has(id)) continue;
          const m = rawMeta[id] && typeof rawMeta[id] === 'object' ? rawMeta[id] : {};
          await pool.query('INSERT INTO firmware_jobs (vendor, site, zone, device_id, device_name, serial, job_ref, task_uri, baseline_id, baseline_label, started_by, started_at, state, percent, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [vendor, site, zone, id, String(m.name || id).slice(0, 255), m.tag ? String(m.tag).slice(0, 100) : null, r.jobRef || null, taskBy.get(id) || null, String(baselineId).slice(0, 500), baselineLabel, user.name || user.username, now, 'Running', 0, now]);
        }
      } catch (e) { log.warn(`[firmware-jobs] could not record job: ${e.message}`); }

      const excluded = new Set([...(r.skippedUpToDate || []), ...(r.notInBaseline || [])].map(String));
      res.json({ ...r, submitted: toSubmit.filter((id) => !excluded.has(String(id))), skipped });
    } catch (e) {
      // Submission itself failed — release the reservation for these
      // devices so they aren't left blocked by a job that never actually
      // started.
      toSubmit.forEach((id) => delete deviceFirmwareJobs[deviceJobKey(vendor, site, zone, id)]);
      throw e;
    }
  } catch (e) {
    sendErr(res, e);
  }
});

// ---- Job/task status polling.
async function getOmeJobStatus(site, zone, jobRef) {
  const session = await getOmeToken(site, zone);
  if (!session) throw new Error('Dell OME is not configured for this zone');
  const res = await monitorFetch(`${session.host}/api/JobService/Jobs(${jobRef})`, { headers: { 'X-Auth-Token': session.token } });
  if (!res.ok) throw new Error(`OME job lookup failed (${res.status})`);
  const data = await res.json();
  const rawStatus = (data.LastRunStatus && data.LastRunStatus.Name) || 'Unknown'; // e.g. Running, Completed, Failed
  // Finished with warnings counts as finished; failed / aborted / cancelled / stopped count as failed; everything else is still running.
  const status = /^(completed|warning)$/i.test(rawStatus) ? 'Completed' : (/fail|abort|cancel|error|stop/i.test(rawStatus) ? 'Failed' : rawStatus);
  // Best effort: per-target progress from the job's latest execution history (Key = target, JobStatus, Progress).
  let devices = null;
  try {
    const hr = await monitorFetch(`${session.host}/api/JobService/Jobs(${jobRef})/ExecutionHistories`, { headers: { 'X-Auth-Token': session.token } });
    const hd = hr.ok ? await hr.json().catch(() => null) : null;
    const hist = hd && Array.isArray(hd.value) ? hd.value : [];
    const latest = hist.reduce((a, b) => (!a || Number(b.Id) > Number(a.Id) ? b : a), null);
    if (latest) {
      const dr = await monitorFetch(`${session.host}/api/JobService/Jobs(${jobRef})/ExecutionHistories(${latest.Id})/ExecutionHistoryDetails`, { headers: { 'X-Auth-Token': session.token } });
      const dd = dr.ok ? await dr.json().catch(() => null) : null;
      if (dd && Array.isArray(dd.value) && dd.value.length) {
        devices = dd.value.map((d) => {
          const js = String((d.JobStatus && d.JobStatus.Name) || '');
          const st = /complete/i.test(js) ? 'Completed' : (/fail|error|abort|warn/i.test(js) && !/running|progress/i.test(js) ? 'Failed' : 'Running');
          const prog = parseInt(String(d.Progress == null ? '' : d.Progress).replace(/[^0-9]/g, ''), 10);
          return { key: String(d.Key == null ? '' : d.Key), status: st, percent: st === 'Completed' ? 100 : (Number.isFinite(prog) ? Math.min(100, prog) : null), step: d.Value ? String(d.Value).slice(0, 800) : null };
        });
      }
    }
  } catch (e) { /* per-device detail is optional */ }
  return { status, devices };
}
async function getOneviewTaskStatus(site, zone, jobRef) {
  const session = await getOneviewSession(site, zone);
  if (!session) throw new Error('HPE OneView is not configured for this zone');
  // jobRef may be a comma-joined list of per-device task URIs (see applyOneviewFirmware).
  const uris = jobRef.split(',').filter(Boolean);
  let sess = session;
  const statuses = [];
  const percents = [];
  const devices = [];
  let step = '';
  let error = '';
  for (const uri of uris) {
    const getTask = () => monitorFetch(`${sess.host}${uri}`, { headers: { Auth: sess.sessionId, 'X-API-Version': String(sess.apiVersion) } });
    let res = await getTask();
    if (res.status === 401) { sess = await reloginOneview(site, zone); res = await getTask(); }
    if (!res.ok) { statuses.push('Unknown'); devices.push({ taskUri: uri, status: 'Running', percent: 0, step: null, error: null }); continue; }
    const data = await res.json();
    statuses.push(data.taskState || 'Unknown'); // e.g. Running, Completed, Error
    const devRec = { taskUri: uri, status: data.taskState === 'Completed' || data.taskState === 'Warning' ? 'Completed' : (['Error', 'Terminated', 'Killed'].includes(data.taskState) ? 'Failed' : 'Running') };
    devices.push(devRec);
    // OneView task fields: computedPercentComplete / percentComplete (0-100), progressUpdates[].statusUpdate, taskErrors[].message
    const pc = [data.computedPercentComplete, data.percentComplete].find((v) => typeof v === 'number');
    const pct = data.taskState === 'Completed' ? 100 : (typeof pc === 'number' ? Math.max(0, Math.min(100, pc)) : 0);
    percents.push(pct);
    const pu = Array.isArray(data.progressUpdates) && data.progressUpdates.length ? data.progressUpdates[data.progressUpdates.length - 1] : null;
    const devStep = (pu && (pu.statusUpdate || pu.message)) ? String(pu.statusUpdate || pu.message).slice(0, 160) : (data.taskStatus ? String(data.taskStatus).slice(0, 160) : '');
    if (devStep && !step) step = devStep;
    const te = Array.isArray(data.taskErrors) && data.taskErrors[0];
    let devErr = te ? String(te.message || te.errorCode || '').slice(0, 300) : '';
    // Terminated / Killed = the task was cancelled (by an operator in OneView or by the appliance). Say so instead of leaving a bare "Failed".
    if (!devErr && (data.taskState === 'Terminated' || data.taskState === 'Killed')) devErr = 'Cancelled: the update task was ' + (data.taskState === 'Killed' ? 'killed' : 'terminated') + ' in HPE OneView before it finished.';
    if (devErr && !error) error = devErr;
    Object.assign(devRec, { percent: pct, step: devStep || null, error: devErr || null });
  }
  // Finished with warnings still counts as finished; Error / Terminated / Killed count as failed.
  const failed = statuses.some((s) => ['Error', 'Terminated', 'Killed'].includes(s));
  return {
    status: statuses.every((s) => s === 'Completed' || s === 'Warning') ? 'Completed' : (failed ? 'Failed' : 'Running'),
    perDevice: statuses,
    devices,
    percent: percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null,
    step: step || null,
    error: error || null,
  };
}
// GET /api/monitoring/firmware/jobs?site=&zone=&vendor=&jobRef=
app.get('/api/monitoring/firmware/jobs', authenticateToken, async (req, res) => {
  try {
    const { site, zone, vendor, jobRef } = req.query;
    if (!site || !zone || !jobRef || !['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'site, zone, vendor and jobRef are required' });
    if (!assertSafeApplianceRefs(res, vendor, vendor === 'ome' ? String(jobRef) : String(jobRef).split(',').filter(Boolean))) return;
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const result = vendor === 'ome' ? await getOmeJobStatus(site, zone, jobRef) : await getOneviewTaskStatus(site, zone, jobRef);
    await persistFirmwareJobStatus(vendor, site, zone, jobRef, result);
    // This is the same 5s poll the "Firmware Update Jobs" panel already runs
    // to update its own UI — piggyback on it to clear the per-device tracker
    // reservation(s) for this job once it's actually done, so the device(s)
    // become selectable again instead of waiting out the 3h stale backstop.
    if (result.status === 'Completed' || result.status === 'Failed') {
      const prefix = `${vendor}|${site}|${zone}|`;
      Object.keys(deviceFirmwareJobs).forEach((key) => {
        if (key.startsWith(prefix) && deviceFirmwareJobs[key].jobRef === jobRef) delete deviceFirmwareJobs[key];
      });
    }
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

// ----------------------------------------------------------------------------
// REFRESH HARDWARE STATUS — triggers the appliance's OWN re-discovery for a
// device, distinct from our normal fetch (which just reads whatever OME/
// OneView currently has on record). This is the actual fix for "shows Power
// On but it's really off": that staleness lives inside OME/OneView's own
// polling cycle, not in our cache, so re-reading their record more often
// can't fix it — only making THEM re-poll the physical hardware can.
//
// Endpoint shapes confirmed via Dell's own community PowerShell module
// (Invoke-OMEInventoryRefresh.ps1) and HPE's OneView Python/Java SDKs
// (server_hardware.refresh_state -> PUT {uri}/refreshState). Verify the
// OneView refreshState body's exact field name against your OneView
// 10.00.00 instance if this doesn't behave as expected — RefreshStateRequest
// isn't fully documented publicly.
// ----------------------------------------------------------------------------
async function refreshOmeInventory(site, zone, deviceIds) {
  const session = await getOmeToken(site, zone);
  if (!session) throw new Error('Dell OME is not configured for this zone');
  const res = await monitorFetch(`${session.host}/api/JobService/Jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': session.token },
    body: JSON.stringify({
      Id: 0,
      JobName: `Inventory Refresh (Monitoring) ${new Date().toISOString()}`,
      JobDescription: 'Refresh hardware status, submitted from Monitoring',
      Schedule: 'startnow',
      State: 'Enabled',
      JobType: { Id: 8, Name: 'Inventory_Task' },
      Targets: deviceIds.map((id) => ({ Id: Number(id), Data: '', TargetType: { Id: 1000, Name: 'DEVICE' } })),
      // Same Params Dell's own Ansible module (ome_devices refresh_inventory) sends.
      Params: [{ Key: 'action', Value: 'CONFIG_INVENTORY' }, { Key: 'isCollectDriverInventory', Value: 'true' }],
    }),
  });
  if (!res.ok) throw new Error(`OME inventory refresh job failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  return { jobRef: typeof data.Id === 'number' ? String(data.Id) : '', vendor: 'ome' };
}
async function refreshOneviewState(site, zone, deviceUris) {
  const session = await getOneviewSession(site, zone);
  if (!session) throw new Error('HPE OneView is not configured for this zone');
  const results = [];
  for (const uri of deviceUris) {
    try {
      const res = await monitorFetch(`${session.host}${uri}/refreshState`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) },
        body: JSON.stringify({ refreshState: 'RefreshPending' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      results.push({ uri, ok: true, taskUri: data.uri || null });
    } catch (e) {
      results.push({ uri, ok: false, error: e.message });
    }
  }
  return { vendor: 'oneview', results };
}
app.post('/api/monitoring/refresh-hardware', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const { site, zone, vendor, deviceIds } = req.body;
    if (!site || !zone || !['ome', 'oneview'].includes(vendor)) return res.status(400).json({ error: 'site, zone and vendor (ome|oneview) are required' });
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return res.status(400).json({ error: 'deviceIds must be a non-empty array' });
    if (!assertSafeApplianceRefs(res, vendor, deviceIds)) return;
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });

    // Same device set re-submitted while the first request is still running
    // (double click, two tabs) reuses that same in-progress re-discovery
    // call instead of asking the appliance to re-poll the same devices
    // twice in parallel.
    const dedupeKey = `HWREFRESH|${vendor}|${site}|${zone}|${[...deviceIds].sort().join(',')}`;
    const result = await dedupeInFlight(dedupeKey, () =>
      vendor === 'ome' ? refreshOmeInventory(site, zone, deviceIds) : refreshOneviewState(site, zone, deviceIds)
    );
    // Our cache is now known-stale relative to what the appliance is about
    // to report — clear it so the next view doesn't serve pre-refresh data.
    // (The appliance's own re-discovery still takes real time to finish;
    // this doesn't make that instant, it just stops us from masking it.)
    invalidateDeviceSnapshot(vendor === 'ome' ? 'OME' : 'ONEVIEW', site, zone);
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

// POST /api/monitoring/refresh-alerts — explicit "Refresh Alerts Now" action.
// The Alerts badge normally only ever reads getCachedAlertCounts(), a value
// written exclusively by the 30-min auto-sync cycle (see below) — so an
// alert cleared/acknowledged directly on the appliance can sit stale in the
// app for up to 30 minutes. This endpoint is the on-demand escape hatch: it
// pulls Critical/Warning counts live from the appliance for this one zone
// right now and overwrites the SAME shared alertSnapshotCache entry the
// auto-sync cycle writes to — so the refreshed count is immediately visible
// to every user viewing this zone (the cache is shared app-wide, not
// per-session), not just the user who clicked it.
app.post('/api/monitoring/refresh-alerts', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const { site, zone } = req.body;
    if (!site || !zone) return res.status(400).json({ error: 'site and zone are required' });
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });

    // Same in-flight dedupe as the device/firmware sync: two people clicking
    // "Refresh Alerts Now" on the same zone within the same moment share one
    // real appliance call instead of each triggering their own.
    const result = { ome: null, oneview: null };
    if (getMonitorConfig('OME', site, zone)) {
      try {
        const r = await dedupeInFlight(`ALERTS|${snapshotKey('OME', site, zone)}`, async () => {
          const counts = await fetchOmeAlertCounts(site, zone);
          const fetchedAt = Date.now();
          alertSnapshotCache[snapshotKey('OME', site, zone)] = { counts, fetchedAt };
          return { ...counts, asOf: fetchedAt };
        });
        result.ome = r;
      } catch (e) { result.ome = { error: e.message }; }
    }
    if (getMonitorConfig('ONEVIEW', site, zone)) {
      try {
        const r = await dedupeInFlight(`ALERTS|${snapshotKey('ONEVIEW', site, zone)}`, async () => {
          const counts = await fetchOneviewAlertCounts(site, zone);
          const fetchedAt = Date.now();
          alertSnapshotCache[snapshotKey('ONEVIEW', site, zone)] = { counts, fetchedAt };
          return { ...counts, asOf: fetchedAt };
        });
        result.oneview = r;
      } catch (e) { result.oneview = { error: e.message }; }
    }
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

// ---- Dell/HP server model-name recognition (Inventory Reconciliation) ----
// Admins type model names in all kinds of formats — "PowerEdge R750",
// "Power EdgeR750", "PoweredgeR750", or just the bare "R750" — so this
// strips everything but letters/digits and uppercases, collapsing all of
// those to the same comparable string before matching.
function normalizeModelText(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Dell PowerEdge: either the line name appears anywhere in the text, or the
// text is just the bare series code (R/T/M/MX/FC/C + 3-4 digits + an
// optional letter suffix, e.g. R750, R750XD, MX750C).
function isDellServerModelText(model) {
  const n = normalizeModelText(model);
  if (!n) return false;
  if (n.includes('POWEREDGE')) return true;
  return /^(R|T|M|MX|FC|C)\d{3,4}[A-Z]{0,3}$/.test(n);
}
// HPE ProLiant (and the Apollo/Synergy server lines): same approach — line
// name anywhere in the text, or the bare series code (DL/ML/BL/SL/XL/RL +
// 2-4 digits, optionally with a Gen suffix, e.g. DL380, DL380GEN10).
function isHpServerModelText(model) {
  const n = normalizeModelText(model);
  if (!n) return false;
  if (n.includes('PROLIANT') || n.includes('APOLLO') || n.includes('SYNERGY')) return true;
  return /^(DL|ML|BL|SL|XL|RL)\d{2,4}[A-Z]{0,3}(GEN\d{1,2})?$/.test(n);
}

// ----------------------------------------------------------------------------
// INVENTORY RECONCILIATION — compares Asset Inventory's server-type assets
// against what Dell OME / HPE OneView actually report, both directions:
// assets recorded in Inventory but not confirmed via either API, and devices
// the APIs report that aren't in Inventory at all. Deliberately ALWAYS
// fetches live (forceRefresh=true) — this is the one exception to Firmware
// Sync's "never independently fetch" rule, chosen explicitly because
// reconciliation accuracy matters more here than avoiding appliance load,
// and it's a manually-triggered audit action, not a routine background one.
// WHICH ASSETS ARE COMPARED, AND HOW THAT DECISION IS MADE — DESIGN HISTORY:
// Three earlier approaches were tried here, each replaced after a real false
// positive or false negative it caused:
//   1. `LOWER(hardware_type) LIKE '%server%'` — an unanchored substring
//      match. Too loose: let through any non-Dell/HP box tagged with the
//      generic "Server" type, plus any custom type merely containing
//      "server" (e.g. "Backup Server"), pulling Veritas/storage appliances
//      into the comparison.
//   2. `hardware_type IN ('DellServer','HPServer')` only. Fixed the above,
//      but introduced a false NEGATIVE: a genuine Dell/HP server typed as
//      plain "Server" was silently skipped instead of flagged.
//   3. Automatic three-signal detection (exact type, OR live serial match,
//      OR model-text pattern match via isDellServerModelText/
//      isHpServerModelText). This closed the false-negative gap, but
//      reopened false positives a different way: a live serial match
//      trusted ANY device OME/OneView returned as proof, and Dell OME's
//      device list isn't server-only — it's a general device-management
//      console that returns anything it's been set up to monitor (a
//      network-discovered load balancer, a switch, etc.), so those devices
//      landed in "Found via API, not in Asset Inventory" with no real
//      Inventory counterpart. And on the Inventory side, automatic
//      pattern-matching had no way to know that a site/project legitimately
//      keeps Dell/HP-branded servers that this particular OME/OneView
//      deployment was never meant to manage (a different project's
//      estate) — those got force-compared and always came up "missing".
//
// CURRENT DESIGN — admin-controlled, not pattern-guessed:
//   - Which Inventory Hardware Types participate at all is an explicit,
//     admin-chosen list (`reconciliation.hardwareTypes` in app_settings,
//     via getReconciliationHardwareTypes() below) — configured from the
//     Inventory Reconciliation tab's "Compare Categories" control. An asset
//     is only ever considered if its hardware_type is in that list. This
//     replaces all automatic Inventory-side detection: no more guessing
//     from model text, so a "LoadBalancer"-typed asset (or any other
//     category the admin didn't select) can never be pulled in, however its
//     model field reads.
//   - A zone with neither Dell OME nor HPE OneView configured is skipped
//     from the comparison ENTIRELY (assets AND any live devices) — there's
//     no appliance to confirm against, so those assets would otherwise
//     always show up as a false "missing from API". This is what actually
//     covers "a different project's servers that this OME/OneView
//     deployment doesn't manage": scope them to a zone with no monitor
//     configured and reconciliation leaves them alone.
//   - The OME/OneView side still screens out non-Dell/HP devices the
//     appliance happens to report (case 3's second bug, above) by requiring
//     the live device's own Model text to pass isDellServerModelText/
//     isHpServerModelText before it's added to vendorBySerial — OME has no
//     per-device "is this a server" flag to check instead, so this is the
//     most reliable signal available. A real Dell/HP server's Model field
//     from OME/OneView is always a clean canonical string ("PowerEdge
//     R750", "ProLiant DL380 Gen10"), so this never excludes a genuine
//     server — only non-Dell/HP devices OME/OneView happens to list.
//
// An included asset whose serial number matches a live device, but whose
// hardware_type and/or model don't match what the appliance reports, is
// collected into `nonStandardMatches` below — these are real Dell/HP
// servers recorded in a non-standard way, with a one-click "Apply
// Standardization" fix available from the Inventory Reconciliation tab
// (never applied automatically).
// ----------------------------------------------------------------------------
// Admin-configured list of Inventory Hardware Types eligible for this
// comparison — see the design-history comment above. Stored as a JSON array
// under this app_settings key; defaults to the two vendor-specific types
// (the old exact-match behavior) until an admin opens "Compare Categories"
// and picks their own list, so an un-configured install isn't silently
// comparing nothing.
const RECON_HARDWARE_TYPES_SETTING_KEY = 'reconciliation.hardwareTypes';
const RECON_HARDWARE_TYPES_DEFAULT = ['DellServer', 'HPServer'];
async function getReconciliationHardwareTypes() {
  const raw = await getSetting(RECON_HARDWARE_TYPES_SETTING_KEY, JSON.stringify(RECON_HARDWARE_TYPES_DEFAULT));
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr.map(String) : RECON_HARDWARE_TYPES_DEFAULT.slice();
  } catch (e) {
    return RECON_HARDWARE_TYPES_DEFAULT.slice();
  }
}
// In-memory job state — one reconciliation run at a time is enough for this
// tool's usage pattern. Real progress (zones processed / total), not a
// simulated or time-based estimate: each zone increments processedZones as
// it's actually finished being fetched and compared.
let reconciliationJob = null; // { running, processedZones, totalZones, startedAt, result, error }

async function runReconciliationJob(allowedSites) {
  const job = { running: true, processedZones: 0, totalZones: 0, startedAt: new Date(), completedAt: null, result: null, error: null };
  reconciliationJob = job;
  try {
    const [zoneRows] = await pool.query(
      'SELECT DISTINCT site, zone_name AS zone FROM zones WHERE site IN (?)',
      [allowedSites.length ? allowedSites : ['__none__']]
    );
    job.totalZones = zoneRows.length;
    const normSerial = (s) => String(s || '').trim().toUpperCase();

    // serial -> { name, vendor, model, site, zone } — always a live fetch,
    // per above, but now via the *light* variants: reconciliation only
    // needs serial numbers (and now model, for the standardization check
    // below), so the per-device System ROM pass that
    // fetchOmeDevices/fetchOneviewServers normally do was pure overhead here
    // — across every zone, that overhead was almost certainly what made
    // this request time out ("Request failed" with no real error message
    // is the classic symptom of a proxy/fetch timeout, not a thrown error).
    const vendorBySerial = new Map();
    // Zones with neither OME nor OneView configured are tracked here and
    // excluded from the Inventory side entirely below — see the design
    // comment above (a different project's estate, scoped to an
    // unmonitored zone, should never be compared against an appliance that
    // was never set up to manage it).
    const monitoredZoneKeys = new Set();
    const zk = (site, zone) => `${site}|${zone}`;
    const failedZones = [];
    for (const z of zoneRows) {
      let hasMonitor = false;
      let zoneFetchFailed = false;
      if (getMonitorConfig('OME', z.site, z.zone)) {
        hasMonitor = true;
        try {
          const devices = await fetchOmeDevicesLight(z.site, z.zone);
          // OME's device list isn't server-only (see design-history comment
          // above) — only keep devices OME itself reports with a real Dell
          // PowerEdge model string, so a network-discovered non-Dell device
          // (a switch, a load balancer, anything else someone pointed OME at
          // for monitoring) can't be mistaken for a missing server.
          (devices || []).forEach((d) => { if (d.serialNumber && isDellServerModelText(d.model)) vendorBySerial.set(normSerial(d.serialNumber), { name: d.name, vendor: 'Dell OME', model: d.model, site: z.site, zone: z.zone, nonServer: d.deviceType != null && Number(d.deviceType) !== 1000 }); });
        } catch (e) { zoneFetchFailed = true; /* one zone's OME being down shouldn't fail the whole reconciliation - but that zone must not be compared (every asset would look "missing") */ }
      }
      if (getMonitorConfig('ONEVIEW', z.site, z.zone)) {
        hasMonitor = true;
        try {
          const devices = await fetchOneviewServersLight(z.site, z.zone);
          // OneView's /rest/server-hardware is server-only by the endpoint's
          // own design, but the same model check is applied here too for
          // symmetry and defense-in-depth rather than trusting that by name alone.
          (devices || []).forEach((d) => { if (d.serialNumber && isHpServerModelText(d.model)) vendorBySerial.set(normSerial(d.serialNumber), { name: d.name, vendor: 'HPE OneView', model: d.model, site: z.site, zone: z.zone }); });
        } catch (e) { zoneFetchFailed = true; /* same */ }
      }
      if (hasMonitor && zoneFetchFailed) failedZones.push({ site: z.site, zone: z.zone });
      else if (hasMonitor) monitoredZoneKeys.add(zk(z.site, z.zone));
      job.processedZones++;
    }

    // Which Inventory Hardware Types are even eligible — admin-configured,
    // see getReconciliationHardwareTypes() and the design-history comment
    // above. Case-insensitive so "DellServer" and "dellserver" both match.
    const includedTypes = await getReconciliationHardwareTypes();
    const includedSet = new Set(includedTypes.map((t) => t.toLowerCase()));

    // Pull every asset for these sites (same breadth Firmware Sync already
    // reads); classification below is now a direct admin-list membership
    // check plus the monitored-zone gate, not pattern-guessing.
    const [allAssetRows] = await pool.query(
      `SELECT id, site, zone, rack_no, serial_number, device_name, model, manufacturer, remarks, hardware_type FROM assets WHERE site IN (?) AND (lifecycle_status IS NULL OR lifecycle_status = 'Active')`,
      [allowedSites.length ? allowedSites : ['__none__']]
    );

    const assetRows = [];
    const nonStandardMatches = [];
    const skippedAssets = [];
    const nonStandardAssetIds = new Set(); // feeds reconStatus on pivotRows below
    const matchedAssetIds = new Set();     // feeds reconStatus/inApi on pivotRows below
    for (const a of allAssetRows) {
      const hwType = String(a.hardware_type || '');
      const hwLower = hwType.trim().toLowerCase();
      if (!includedSet.has(hwLower)) continue; // not one of the admin-selected compare categories
      if (!monitoredZoneKeys.has(zk(a.site, a.zone))) {
        // Not compared - but reported, so these assets never disappear silently from the totals.
        skippedAssets.push({ site: a.site, zone: a.zone, name: a.device_name || a.model || '—', serialNumber: a.serial_number || '—', hardwareType: a.hardware_type || '—', reason: failedZones.some((f) => f.site === a.site && f.zone === a.zone) ? 'Appliance could not be reached' : 'No Dell OME / HPE OneView configured for this zone' });
        continue;
      }

      const serialKey = a.serial_number ? normSerial(a.serial_number) : null;
      const liveDevice = serialKey ? vendorBySerial.get(serialKey) : null;
      assetRows.push(a);

      // Serial-confirmed assets get checked against the live appliance
      // record for a standardization suggestion — never guessed from model
      // text alone, only ever from this solid ground truth.
      if (liveDevice) {
        matchedAssetIds.add(a.id);
        const canonicalHwType = liveDevice.vendor === 'Dell OME' ? 'DellServer' : 'HPServer';
        const suggestions = {};
        if (hwType !== canonicalHwType) suggestions.hardwareType = { from: hwType || '(blank)', to: canonicalHwType };
        const liveModel = liveDevice.model && liveDevice.model !== '—' ? liveDevice.model : null;
        if (liveModel && normalizeModelText(a.model) !== normalizeModelText(liveModel)) {
          suggestions.model = { from: a.model || '(blank)', to: liveModel };
        }
        if (Object.keys(suggestions).length) {
          nonStandardAssetIds.add(a.id);
          nonStandardMatches.push({
            assetId: a.id, site: a.site, zone: a.zone, serialNumber: a.serial_number,
            name: a.device_name || a.model || '—', vendor: liveDevice.vendor, suggestions,
          });
        }
      }
    }

    // OME also lists chassis / sleds / storage under PowerEdge model names (e.g. MX7000); a non-server device with no Inventory asset of that serial is not a server missing from Inventory.
    const assetSerialSet = new Set(assetRows.map((a) => (a.serial_number ? normSerial(a.serial_number) : null)).filter(Boolean));
    vendorBySerial.forEach((d, k) => { if (d.nonServer && !assetSerialSet.has(k)) vendorBySerial.delete(k); });
    const matchedSerials = new Set();
    const missingFromApi = [];
    for (const a of assetRows) {
      const key = normSerial(a.serial_number);
      if (a.serial_number && vendorBySerial.has(key)) {
        matchedSerials.add(key);
      } else {
        missingFromApi.push({ site: a.site, zone: a.zone, name: a.device_name || a.model || '—', serialNumber: a.serial_number || '—', rackNo: a.rack_no || '—', hardwareType: a.hardware_type || '—' });
      }
    }
    const foundViaApiNotInInventory = [];
    vendorBySerial.forEach((d, serial) => {
      if (!matchedSerials.has(serial)) foundViaApiNotInInventory.push({ site: d.site, zone: d.zone, name: d.name, serialNumber: serial, vendor: d.vendor });
    });

    // Flat, per-asset/per-device rows for the pivot table view — one entry
    // per compared Inventory asset PLUS one per live device found via API
    // with no Inventory counterpart, each tagged so the frontend can group
    // by any combination of Hardware Type / Manufacturer / Model / Site /
    // Zone / Rack No / Remarks / Device Name / Reconciliation Status and
    // get both an Inventory count and an API count per slice, exactly
    // mirroring the top-level inventoryTotal/apiTotal split above.
    //   inInventory — counts toward "Inventory count" for its slice.
    //   inApi       — counts toward "API count" for its slice (true for a
    //                 matched/non-standard Inventory row AND for an
    //                 API-only row — the same live device either way).
    const pivotRows = [];
    assetRows.forEach((a) => {
      const status = nonStandardAssetIds.has(a.id) ? 'Non-standard' : matchedAssetIds.has(a.id) ? 'Matched' : 'Missing from API';
      pivotRows.push({
        hardwareType: a.hardware_type || '(blank)', manufacturer: a.manufacturer || '(blank)', model: a.model || '(blank)',
        site: a.site, zone: a.zone, rackNo: a.rack_no || '(blank)', remarks: (a.remarks && String(a.remarks).trim()) || '(blank)',
        deviceName: a.device_name || '(blank)', serialNumber: a.serial_number || '(blank)',
        reconStatus: status, inInventory: true, inApi: matchedAssetIds.has(a.id),
      });
    });
    vendorBySerial.forEach((d, serial) => {
      if (matchedSerials.has(serial)) return; // already represented by its matched Inventory row above
      const vendorHwType = d.vendor === 'Dell OME' ? 'DellServer' : 'HPServer';
      const vendorMfr = d.vendor === 'Dell OME' ? 'Dell' : 'HPE';
      pivotRows.push({
        hardwareType: vendorHwType, manufacturer: vendorMfr, model: d.model || '(blank)',
        site: d.site, zone: d.zone, rackNo: '(blank)', remarks: '(blank)',
        deviceName: d.name || '(blank)', serialNumber: serial,
        reconStatus: 'Found via API (not in Inventory)', inInventory: false, inApi: true,
      });
    });

    // Only zones actually part of the comparison (Dell OME or HPE OneView
    // configured) are shown in the per-zone breakdown — an unmonitored
    // zone showing "0 / 0 — Matched" would misleadingly look audited when
    // it was never compared at all.
    const zoneStats = {};
    zoneRows.forEach((z) => { if (monitoredZoneKeys.has(zk(z.site, z.zone))) zoneStats[zk(z.site, z.zone)] = { site: z.site, zone: z.zone, inventoryCount: 0, apiCount: 0 }; });
    assetRows.forEach((a) => { const k = zk(a.site, a.zone); if (zoneStats[k]) zoneStats[k].inventoryCount++; });
    vendorBySerial.forEach((d) => { const k = zk(d.site, d.zone); if (zoneStats[k]) zoneStats[k].apiCount++; });

    job.result = {
      inventoryTotal: assetRows.length,
      apiTotal: vendorBySerial.size,
      zones: Object.values(zoneStats),
      nonStandardMatches,
      missingFromApi,
      foundViaApiNotInInventory,
      includedHardwareTypes: includedTypes,
      unmonitoredZoneCount: zoneRows.length - monitoredZoneKeys.size,
      skippedAssets, // selected-category assets in zones that were not compared, with the reason
      failedZones, // zones whose appliance could not be reached - skipped, not reported as "missing"
      pivotRows,
    };
  } catch (e) {
    job.error = e.message;
  } finally {
    job.running = false;
    job.completedAt = new Date();
  }
}

app.post('/api/monitoring/reconciliation', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    if (reconciliationJob && reconciliationJob.running) return res.json({ started: false, alreadyRunning: true });
    const allowedSites = await getAllowedSitesForUser(req.user);
    runReconciliationJob(allowedSites); // deliberately not awaited — runs in the background, polled via the status route below
    res.json({ started: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// "Compare Categories" settings — which Inventory Hardware Types are
// eligible for the Dell OME/HPE OneView comparison at all. See the
// design-history comment above runReconciliationJob for why this replaced
// automatic detection. GET lists every Device-category Hardware Type from
// the catalog (so the UI can offer the full, real list — never a
// hand-typed one that could drift from what Inventory actually uses)
// alongside the currently selected subset.
app.get('/api/monitoring/reconciliation/settings', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT name FROM hardware_types WHERE category = 'Device' OR category IS NULL ORDER BY name");
    const selected = await getReconciliationHardwareTypes();
    res.json({ availableHardwareTypes: rows.map((r) => r.name), selected });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/monitoring/reconciliation/settings', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const list = Array.isArray(req.body.hardwareTypes) ? req.body.hardwareTypes.map((s) => String(s).trim()).filter(Boolean) : null;
    if (!list) return res.status(400).json({ error: 'hardwareTypes must be a list of hardware type names' });
    // Validate against the real catalog so a typo (or stale client state)
    // can't silently create a dead filter entry that never matches anything.
    const [rows] = await pool.query('SELECT name FROM hardware_types');
    const valid = new Set(rows.map((r) => r.name));
    const unknown = list.filter((n) => !valid.has(n));
    if (unknown.length) return res.status(400).json({ error: `Unknown hardware type(s): ${unknown.join(', ')}` });
    await setSetting(RECON_HARDWARE_TYPES_SETTING_KEY, JSON.stringify(list));
    res.json({ saved: true, selected: list });
  } catch (e) {
    sendErr(res, e);
  }
});

// This intentionally returns the LAST known result even when nothing is
// currently running — reconciliationJob is a persistent module-level object,
// not cleared between runs, so the frontend can call this on mount/tab
// switch to redisplay the previous result and its completedAt time without
// forcing a fresh (expensive, live-fetch) run just to see what was already
// found. Resets only on a server restart, same in-memory-only limitation as
// the device snapshot cache elsewhere in this file.
function scopeReconciliationResult(result, allowedSites) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    out[k] = Array.isArray(v) ? v.filter((row) => !row || typeof row !== 'object' || row.site == null || allowedSites.includes(row.site)) : v;
  }
  if (Array.isArray(out.pivotRows)) {
    out.inventoryTotal = out.pivotRows.filter((r) => r.inInventory).length;
    out.apiTotal = out.pivotRows.filter((r) => r.inApi).length;
  }
  return out;
}
app.get('/api/monitoring/reconciliation-status', authenticateToken, (req, res) => {
  if (!reconciliationJob) return res.json({ running: false, result: null, completedAt: null });
  const { running, processedZones, totalZones, result, error, completedAt } = reconciliationJob;
  // SECURITY: the job result is global (whoever ran it last) - only show a requester the rows for sites they may access.
  getAllowedSitesForUser(req.user).then((allowedSites) => {
    res.json({ running, processedZones, totalZones, percent: totalZones ? Math.round((processedZones / totalZones) * 100) : 0, result: scopeReconciliationResult(result, allowedSites), error, completedAt });
  }).catch((e) => sendErr(res, e));
});

// POST /api/monitoring/reconciliation/standardize
// body: { assetIds?: [...] } — omit/empty to apply every suggestion from the
// last completed run.
//
// Applies the `nonStandardMatches` suggestions computed by the reconciliation
// run above — never anything the client supplies directly. The client can
// only narrow WHICH of the server's own already-computed suggestions to
// apply (by asset id); it cannot hand this endpoint an arbitrary new
// hardware_type/model value for any asset. This is the explicit,
// admin-reviewed "Apply Standardization" action — nothing here ever runs
// automatically as part of a reconciliation pass itself.
app.post('/api/monitoring/reconciliation/standardize', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    if (!reconciliationJob || !reconciliationJob.result || !Array.isArray(reconciliationJob.result.nonStandardMatches)) {
      return res.status(400).json({ error: 'Run Inventory Reconciliation first — there are no standardization suggestions to apply yet.' });
    }
    const allowedSites = await getAllowedSitesForUser(req.user);
    const requestedIds = Array.isArray(req.body.assetIds) && req.body.assetIds.length ? new Set(req.body.assetIds.map(String)) : null;
    const candidates = reconciliationJob.result.nonStandardMatches.filter(
      (m) => (!requestedIds || requestedIds.has(String(m.assetId))) && allowedSites.includes(m.site)
    );

    let updated = 0;
    const appliedIds = [];
    const updatedBy = `Inventory Reconciliation (${req.user.name || req.user.username})`;
    for (const m of candidates) {
      const sets = [];
      const vals = [];
      const changedFields = [];
      if (m.suggestions.hardwareType) { sets.push('hardware_type = ?'); vals.push(m.suggestions.hardwareType.to); changedFields.push('Hardware Type'); }
      if (m.suggestions.model) { sets.push('model = ?'); vals.push(m.suggestions.model.to); changedFields.push('Model'); }
      if (!sets.length) continue;
      await pool.query(
        `UPDATE assets SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP, updated_by = ?, changed_fields = ? WHERE id = ?`,
        [...vals, updatedBy, changedFields.join(', '), m.assetId]
      );
      updated++;
      appliedIds.push(m.assetId);
    }

    // Drop the applied entries from the cached result so re-rendering the
    // Reconciliation tab doesn't keep offering to "fix" something already
    // fixed — the counts/lists above (missingFromApi etc.) are untouched,
    // since a hardware_type/model correction doesn't change whether that
    // asset's serial was already matched.
    reconciliationJob.result.nonStandardMatches = reconciliationJob.result.nonStandardMatches.filter(
      (m) => !appliedIds.includes(m.assetId)
    );

    res.json({ updated, appliedIds });
  } catch (e) {
    sendErr(res, e);
  }
});

// ---- Firmware sync into Asset Inventory. Matches by serial number ONLY,
// writes ONLY the `firmware` column on rows that already exist, and never
// calls createAsset()/the bulk-upsert path — it is a single scoped UPDATE per
// matched row, so it cannot create, delete, or touch any other asset field.
//
// fetchOmeDevices/fetchOneviewServers now fetch System ROM for every device
// (see above), so this route just reads d.firmwareVersion directly — no
// separate per-device detail calls needed here anymore.
// Pure cache read — never talks to Dell OME/HPE OneView. Returns the cached
// device list if a fresh Monitoring-page fetch exists for this vendor+zone,
// or null if it doesn't (never fetched, or the TTL expired). This is what
// makes Firmware Sync structurally unable to independently hit the
// appliances: it has no path to fetchOmeDevices()/fetchOneviewServers() at all.
function getCachedDevicesOnly(vendor, site, zone) {
  const cached = deviceSnapshotCache[snapshotKey(vendor, site, zone)];
  if (cached && Date.now() - cached.fetchedAt < DEVICE_SNAPSHOT_TTL_MS) return cached.devices;
  return null;
}

// Reusable core of Firmware Sync — takes an explicit site list so it works
// both for a user's allowed sites (the route) and for every site system-wide
// (the 30-min auto-sync). Still a pure cache reader: never calls
// fetchOmeDevices()/fetchOneviewServers() itself, only getCachedDevicesOnly().
async function runFirmwareSync(sites, opts = {}) {
  const readOnly = !!opts.readOnly; // status views must never write to the assets table
  const [zoneRows] = await pool.query(
    'SELECT DISTINCT site, zone_name AS zone FROM zones WHERE site IN (?)',
    [sites.length ? sites : ['__none__']]
  );

  const normSerial = (s) => String(s || '').trim().toUpperCase();
  const vendorBySerial = new Map();
  const zoneCovered = {};
  const notLoadedZones = [];

  for (const z of zoneRows) {
    const hasOme = !!getMonitorConfig('OME', z.site, z.zone);
    const hasOv = !!getMonitorConfig('ONEVIEW', z.site, z.zone);
    let omeOk = !hasOme, ovOk = !hasOv;

    if (hasOme) {
      const devices = getCachedDevicesOnly('OME', z.site, z.zone);
      if (devices) {
        omeOk = true;
        devices.forEach((d) => { if (d.serialNumber) vendorBySerial.set(normSerial(d.serialNumber), { firmware: d.firmwareVersion || null }); });
      }
    }
    if (hasOv) {
      const devices = getCachedDevicesOnly('ONEVIEW', z.site, z.zone);
      if (devices) {
        ovOk = true;
        devices.forEach((d) => { if (d.serialNumber) vendorBySerial.set(normSerial(d.serialNumber), { firmware: d.firmwareVersion || null }); });
      }
    }

    const covered = omeOk && ovOk;
    zoneCovered[`${z.site}|${z.zone}`] = covered;
    if (!covered) notLoadedZones.push(`${z.site} · ${z.zone}`);
  }

  const [assetRows] = await pool.query(
    'SELECT id, site, zone, serial_number, firmware, firmware_source FROM assets WHERE site IN (?)',
    [sites.length ? sites : ['__none__']]
  );

  let updated = 0, verified = 0, inSync = 0, unknown = 0, notFound = 0, notLoaded = 0;
  const normFw = (s) => String(s || '').trim();
  for (const a of assetRows) {
    if (!a.serial_number) { continue; }
    const v = vendorBySerial.get(normSerial(a.serial_number));
    if (!v) {
      if (zoneCovered[`${a.site}|${a.zone}`] === false) { notLoaded++; } else { notFound++; }
      continue;
    }

    if (!v.firmware) { unknown++; continue; }
    const apiFw = normFw(v.firmware);
    const invFw = normFw(a.firmware);
    if (apiFw !== invFw) {
      if (!readOnly) await pool.query("UPDATE assets SET firmware = ?, firmware_source = 'api', updated_at = CURRENT_TIMESTAMP, updated_by = 'Firmware Sync (API)', changed_fields = 'Firmware' WHERE id = ?", [apiFw, a.id]);
      updated++;
    } else if (a.firmware_source !== 'api') {
      // The stored value already matches the vendor's — nothing to change
      // in the value itself, but it was never actually confirmed against
      // the API (likely typed in manually and happened to be correct).
      // Mark it verified so it's not stuck showing as an unconfirmed manual
      // entry forever, without touching updated_at/updated_by (no real
      // edit happened, just a confirmation).
      if (!readOnly) await pool.query("UPDATE assets SET firmware_source = 'api' WHERE id = ?", [a.id]);
      verified++;
    } else {
      inSync++;
    }
  }

  return { matched: updated + verified + inSync + unknown, updated, verified, inSync, unknown, notFound, notLoaded, notLoadedZones };
}

app.post('/api/monitoring/firmware-sync', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const allowedSites = await getAllowedSitesForUser(req.user);
    const result = await runFirmwareSync(allowedSites);
    res.json(result);
  } catch (e) {
    sendErr(res, e);
  }
});

// ----------------------------------------------------------------------------
// 30-MINUTE AUTO-SYNC — refreshes every configured zone's device+firmware
// data live from Dell OME/HPE OneView, then immediately runs Firmware Sync
// against that just-refreshed cache. This is the one place in the app that
// polls the appliances on a timer rather than only when a person looks at
// something; requested explicitly to guarantee coverage without requiring
// someone to browse every zone in Monitoring first.
// ----------------------------------------------------------------------------
const AUTO_SYNC_INTERVAL_MS = Number(process.env.MONITOR_AUTOSYNC_INTERVAL_MS) || 30 * 60 * 1000; // 30 min default
// Power On/Off/Unknown counts per vendor+site+zone, recorded by the auto-sync cycle only (and saved to the
// database at the end of each cycle so a restart does not blank the dashboard module).
const powerSnapshot = {}; // "OME|site|zone" -> { on, off, unknown, total, fetchedAt }
function recordPowerSnapshot(vendorKey, site, zone, devices) {
  if (!Array.isArray(devices)) return;
  const servers = vendorKey === 'OME' ? devices.filter((x) => x.deviceType === undefined || x.deviceType === null || Number(x.deviceType) === 1000) : devices;
  const snap = { on: 0, off: 0, unknown: 0, total: servers.length, fetchedAt: Date.now() };
  servers.forEach((x) => { if (x.powerState === 'On') snap.on++; else if (x.powerState === 'Off') snap.off++; else snap.unknown++; });
  powerSnapshot[snapshotKey(vendorKey, site, zone)] = snap;
}
let lastAutoSyncAt = null;
let lastAutoSyncResult = null;
let autoSyncRunning = false; // guards against a cycle still running when the next one would start
let autoSyncProgress = { processedZones: 0, totalZones: 0 };

// ---- Firmware Compliance (read-only): the Monitoring page's cached devices + firmware, kept per zone ----
// Written by the 30-minute auto-sync from the device list it has just refreshed (no extra appliance call); the Dashboard only reads it.
const fwComplianceCache = {}; // "OME|site|zone" -> { fetchedAt, items: [...] }
let fwComplianceTableReady = false;
async function ensureFwComplianceTable() {
  if (fwComplianceTableReady) return;
  await pool.query('CREATE TABLE IF NOT EXISTS firmware_compliance_cache (k VARCHAR(255) NOT NULL PRIMARY KEY, v LONGTEXT, fetched_at BIGINT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  fwComplianceTableReady = true;
}
let fwComplianceLoaded = false;
async function ensureFwComplianceLoaded() {
  if (fwComplianceLoaded) return;
  fwComplianceLoaded = true;
  try {
    await ensureFwComplianceTable();
    const [rows] = await pool.query('SELECT k, v FROM firmware_compliance_cache');
    rows.forEach((r) => { if (!fwComplianceCache[r.k]) { try { const o = JSON.parse(r.v); if (o && Array.isArray(o.items)) fwComplianceCache[r.k] = o; } catch (e) { /* ignore a damaged row */ } } });
  } catch (e) { log.warn('Firmware compliance cache could not be loaded:', e.message); }
}
async function saveFwComplianceSnapshot(key) {
  try {
    await ensureFwComplianceTable();
    const o = fwComplianceCache[key];
    await pool.query('INSERT INTO firmware_compliance_cache (k, v, fetched_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), fetched_at = VALUES(fetched_at)', [key, JSON.stringify(o), o.fetchedAt]);
  } catch (e) { log.warn('Firmware compliance snapshot not saved:', e.message); }
}
// Cached device + firmware list (exactly what the Monitoring page shows) stored per zone after each 30-minute refresh.
// The Dashboard compares it with the per-model firmware targets already kept for Monitoring - same rule, same numbers.
function buildFwSnapshotItems(vendor, site, zone) {
  const devices = getCachedDevicesOnly(vendor, site, zone);
  if (!devices) return null;
  return devices.filter((d) => vendor !== 'OME' || d.deviceType == null || Number(d.deviceType) === 1000).map((d) => ({
    name: d.name, serial: d.serialNumber || '', model: d.model || '', current: d.firmwareVersion || '', ip: d.ipAddress || '', health: d.healthStatus || '', power: d.powerState || '',
  }));
}
async function refreshFwCompliance(vendor, site, zone) {
  const key = snapshotKey(vendor, site, zone);
  try {
    const items = buildFwSnapshotItems(vendor, site, zone);
    if (!items) return;
    fwComplianceCache[key] = { fetchedAt: Date.now(), items };
    await saveFwComplianceSnapshot(key);
  } catch (e) { log.warn(`Auto-sync: ${vendor} firmware snapshot failed for ${site}/${zone}:`, e.message); } // keeps the previous snapshot
}
async function runAutoSyncCycle() {
  if (autoSyncRunning) { log.warn('Auto-sync: previous cycle still running, skipping this tick'); return; }
  autoSyncRunning = true;
  try {
    const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones');
    autoSyncProgress = { processedZones: 0, totalZones: zoneRows.length };
    for (const z of zoneRows) {
      if (getMonitorConfig('OME', z.site, z.zone)) {
        try { recordPowerSnapshot('OME', z.site, z.zone, await fetchOmeDevices(z.site, z.zone, true)); } catch (e) { log.warn(`Auto-sync: OME refresh failed for ${z.site}/${z.zone}:`, e.message); }
        // Active alerts (Critical/Warning) — piggybacks on this same 30-min
        // appliance call rather than polling separately. One vendor's alert
        // fetch failing doesn't touch the previous cached counts, so the
        // Monitoring page badge just keeps showing the last known values.
        try { alertSnapshotCache[snapshotKey('OME', z.site, z.zone)] = { counts: await fetchOmeAlertCounts(z.site, z.zone), fetchedAt: Date.now() }; }
        catch (e) { log.warn(`Auto-sync: OME alerts fetch failed for ${z.site}/${z.zone}:`, e.message); }
        await refreshFwCompliance('OME', z.site, z.zone);
      }if (getMonitorConfig('ONEVIEW', z.site, z.zone)) {
        try { recordPowerSnapshot('ONEVIEW', z.site, z.zone, await fetchOneviewServers(z.site, z.zone, true)); } catch (e) { log.warn(`Auto-sync: OneView refresh failed for ${z.site}/${z.zone}:`, e.message); }
        try { alertSnapshotCache[snapshotKey('ONEVIEW', z.site, z.zone)] = { counts: await fetchOneviewAlertCounts(z.site, z.zone), fetchedAt: Date.now() }; }
        catch (e) { log.warn(`Auto-sync: OneView alerts fetch failed for ${z.site}/${z.zone}:`, e.message); }
        await refreshFwCompliance('ONEVIEW', z.site, z.zone);
      }
      autoSyncProgress.processedZones++;
    }
    const allSites = [...new Set(zoneRows.map((z) => z.site))];
    lastAutoSyncResult = await runFirmwareSync(allSites);
    lastAutoSyncAt = new Date();
    try { await setSetting('power_snapshot', JSON.stringify(powerSnapshot)); } catch (e) { log.warn('Auto-sync: could not save the power snapshot:', e.message); }
  } catch (e) {
    log.warn('Auto-sync cycle failed:', e.message);
  } finally {
    autoSyncRunning = false;
    // Schedule the NEXT run relative to when this one actually finished, not
    // to a fixed clock from process start — this is also what makes
    // nextRunAt below correct rather than a guess.
    setTimeout(runAutoSyncCycle, AUTO_SYNC_INTERVAL_MS);
  }
}
setTimeout(runAutoSyncCycle, 60 * 1000); // first run shortly after startup; every run after that reschedules itself

app.get('/api/monitoring/autosync-status', authenticateToken, async (req, res) => {
  try {
    // lastAutoSyncResult (module-level) is computed system-wide across every
    // site — returning it verbatim would leak other sites' zone names and
    // counts (via notLoadedZones) to a location-restricted user. Timing
    // fields are harmless to share (knowing "the cycle last ran at X" isn't
    // sensitive), but the result content must be scoped per requester.
    // runFirmwareSync is a pure cache reader (see above) — safe to call
    // fresh here with no extra appliance load, just to get a properly
    // scoped view of already-cached data.
    const allowedSites = await getAllowedSitesForUser(req.user);
    const scopedResult = lastAutoSyncAt ? await runFirmwareSync(allowedSites, { readOnly: true }) : null;
    res.json({
      intervalMs: AUTO_SYNC_INTERVAL_MS,
      lastRunAt: lastAutoSyncAt,
      nextRunAt: lastAutoSyncAt ? new Date(lastAutoSyncAt.getTime() + AUTO_SYNC_INTERVAL_MS) : null,
      lastResult: scopedResult,
      running: autoSyncRunning,
      processedZones: autoSyncProgress.processedZones,
      totalZones: autoSyncProgress.totalZones,
      percent: autoSyncProgress.totalZones ? Math.round((autoSyncProgress.processedZones / autoSyncProgress.totalZones) * 100) : 0,
    });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== AUTH ROUTES ==========
// In-memory login brute-force guard, keyed by username+IP (not by IP alone, so one
// noisy client can't lock other users out of the same shared network). No new
// dependency, same offline-friendly approach used for gzip above. This resets on
// server restart, which is acceptable here: it's a throttle against automated
// password guessing, not a durable audit trail.
const LOGIN_DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_LOCK_ACCOUNT = String(process.env.LOGIN_LOCK_ACCOUNT || 'on').toLowerCase() !== 'off';
const loginAttempts = new Map(); // key -> { count, lockedUntil }
setInterval(() => {
  const now = Date.now();
  for (const [key, v] of loginAttempts) { if (v.lockedUntil && v.lockedUntil < now) loginAttempts.delete(key); }
}, 10 * 60 * 1000).unref?.();
// Two counters per attempt: username+IP (one noisy client can not lock others out of a shared network) and the account itself
// (guessing from many IPs still hits the limit). Set LOGIN_LOCK_ACCOUNT=off to use only the username+IP counter.
function loginAttemptKeys(req, username) {
  // The DB compares usernames case-, accent- and trailing-space-insensitively, so the limiter must too (otherwise "admin " / "admín" each get a fresh counter).
  const norm = String(username || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const keys = [`${norm}|${req.ip}`];
  if (LOGIN_LOCK_ACCOUNT) keys.push(`acct|${norm}`);
  return keys;
}
function loginLockedUntil(keys) {
  let until = 0; const now = Date.now();
  for (const k of keys) { const a = loginAttempts.get(k); if (a && a.lockedUntil && a.lockedUntil > now && a.lockedUntil > until) until = a.lockedUntil; }
  return until;
}
function loginRecordFailure(keys) { // returns true when this failure locked something
  let locked = false; const now = Date.now();
  for (const k of keys) {
    let a = loginAttempts.get(k) || { count: 0 };
    if (a.lockedUntil && a.lockedUntil <= now) a = { count: 0 };      // an expired lock starts a fresh count
    const next = { count: a.count + 1 };
    if (next.count >= LOGIN_MAX_ATTEMPTS) { next.lockedUntil = now + LOGIN_LOCKOUT_MS; locked = true; }
    loginAttempts.set(k, next);
  }
  while (loginAttempts.size > 5000) loginAttempts.delete(loginAttempts.keys().next().value);
  return locked;
}
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const attemptKeys = loginAttemptKeys(req, username);
    const lockedUntil = loginLockedUntil(attemptKeys);
    if (lockedUntil) {
      const waitMs = lockedUntil - Date.now(); const waitMin = Math.ceil(waitMs / 60000);
      res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
      auditLog(req, 'LOGIN_BLOCKED', { username: String(username).slice(0, 100), entity: 'user', status: 'failure', details: { reason: 'locked_out', retryAfterMinutes: waitMin } });
      return res.status(429).json({ error: `Too many failed login attempts. Try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.` });
    }
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ? AND status = 'Active'", [username]);
    const user = rows[0];
    let valid = false;
    if (!user) await bcrypt.compare(String(password), LOGIN_DUMMY_HASH); // same work as a real check, so timing does not reveal which usernames exist
    else valid = await bcrypt.compare(String(password), user.password_hash);
    if (!valid) {
      const nowLocked = loginRecordFailure(attemptKeys);
      await auditLog(req, 'LOGIN_FAILURE', { username: String(username).slice(0, 100), entity: 'user', status: 'failure', details: { reason: user ? 'bad_password' : 'unknown_or_inactive_user' } });
      if (nowLocked) {
        log.warn(`[auth] ${LOGIN_MAX_ATTEMPTS} failed logins for "${String(username).slice(0, 50)}" from ${clientIp(req)} - locked for ${LOGIN_LOCKOUT_MS / 60000} minutes`);
        auditLog(req, 'ACCOUNT_LOCKED', { username: String(username).slice(0, 100), entity: 'user', status: 'failure', details: { minutes: LOGIN_LOCKOUT_MS / 60000, attempts: LOGIN_MAX_ATTEMPTS } });
      }
      return res.status(401).json({ error: 'Username or password is incorrect' });
    }
    attemptKeys.forEach((k) => loginAttempts.delete(k)); // successful login clears the failure history
    // a seeded account that signs in with its shipped default password is always flagged (also covers a reset back to the default)
    if (!Number(user.must_change_password) && DEFAULT_ACCOUNT_PASSWORDS[String(user.username).toLowerCase()] === String(password) && !user.password_changed_at) { user.must_change_password = 1; await pool.query('UPDATE users SET must_change_password = 1 WHERE id = ?', [user.id]); }
    const sid = require('crypto').randomBytes(16).toString('hex');
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role, location_access: user.location_access, sid },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    // New login wins: store the new session id, and drop cached auth rows so the older browser is rejected on its very next request.
    await pool.query('UPDATE users SET session_id = ? WHERE id = ?', [sid, user.id]);
    purgeAuthCacheForUser(user.id);
    await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    auditLog(req, 'LOGIN_SUCCESS', { user: { id: user.id, username: user.username, role: user.role }, entity: 'user', entityId: user.id });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, location_access: user.location_access, ...(Number(user.must_change_password) ? { mustChangePassword: true } : {}) } });
  } catch (e) {
    sendErr(res, e);
  }
});

// "Online now" window — how recently last_seen_at has to be for a user to
// count as currently online. There's no real persistent-connection tracking
// (stateless JWT), so this is a heartbeat heuristic: the frontend pings
// /api/auth/heartbeat periodically while the app is open, and anyone whose
// last ping is within this window counts as online. Closing the tab without
// logging out just means they stop appearing after this window elapses —
// there's no logout-detection event to make that instant.
const ONLINE_WINDOW_MS = 60 * 1000; // 60 seconds (browser heartbeats every 15s; explicit logout / tab close removes the user immediately)

app.post('/api/auth/heartbeat', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Just the count — available to any authenticated user (not Admin-only),
// since the Dashboard badge should work for Operators/Viewers too.
// Explicit sign-out: ends the server-side session and removes the user from the live count at once.
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE users SET session_id = NULL, last_seen_at = NULL WHERE id = ?', [req.user.id]);
    purgeAuthCacheForUser(req.user.id);
    auditLog(req, 'LOGOUT', { entity: 'user', entityId: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    sendErr(res, e);
  }
});
// Tab/browser closed (navigator.sendBeacon can't set an Authorization header, so the token is read from the body).
// Only marks the user offline; the session stays valid so a reload / reopened tab simply comes back online on its next heartbeat.
app.post('/api/auth/offline', async (req, res) => {
  try {
    const token = req.body && req.body.token;
    if (!token) return res.json({ ok: true });
    jwt.verify(token, JWT_SECRET, async (err, tokenUser) => {
      try {
        if (!err && tokenUser && tokenUser.id) await pool.query('UPDATE users SET last_seen_at = NULL WHERE id = ? AND session_id = ?', [tokenUser.id, tokenUser.sid || '']);
      } catch (e) { /* best effort */ }
      res.json({ ok: true });
    });
  } catch (e) {
    res.json({ ok: true });
  }
});

app.get('/api/users/online-count', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM users WHERE status = "Active" AND last_seen_at IS NOT NULL AND last_seen_at > (NOW() - INTERVAL ? SECOND)',
      [ONLINE_WINDOW_MS / 1000]
    );
    res.json({ onlineCount: rows[0].cnt, windowMs: ONLINE_WINDOW_MS });
  } catch (e) {
    sendErr(res, e);
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, name, role, location_access, status, must_change_password FROM users WHERE id = ?', [req.user.id]);
    const me = rows[0] || {}; const mc = Number(me.must_change_password); delete me.must_change_password;
    res.json(mc ? { ...me, mustChangePassword: true } : me);
  } catch (e) {
    sendErr(res, e);
  }
});

app.patch('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current password and new password are required' });
    const pwErr = passwordPolicyError(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const [rows] = await pool.query('SELECT password_hash, must_change_password FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    if (Number(rows[0].must_change_password) && String(newPassword) === String(currentPassword)) return res.status(400).json({ error: 'The new password must be different from the default password.' });
    const hash = await bcrypt.hash(newPassword, 10);
    // Every other browser holding an old token is signed out; this browser gets a fresh token for the new session.
    const newSid = require('crypto').randomBytes(16).toString('hex');
    await pool.query('UPDATE users SET password_hash = ?, session_id = ?, must_change_password = 0, password_changed_at = NOW() WHERE id = ?', [hash, newSid, req.user.id]);
    purgeAuthCacheForUser(req.user.id);
    const freshToken = jwt.sign(
      { id: req.user.id, username: req.user.username, name: req.user.name, role: req.user.role, location_access: req.user.location_access, sid: newSid },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ success: true, token: freshToken });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== USERS ==========
app.get('/api/users', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, name, role, location_access, status, created_at, last_login_at, last_seen_at FROM users');
    const now = Date.now();
    res.json(rows.map((r) => ({
      ...r,
      isOnline: !!(r.last_seen_at && (now - new Date(r.last_seen_at).getTime()) < ONLINE_WINDOW_MS),
    })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/users', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const { username, password, name, role, location_access } = req.body;
    if (!username || !String(username).trim() || !name || !String(name).trim()) return res.status(400).json({ error: 'Username and full name are required' });
    if (!['Admin', 'Operator', 'Viewer'].includes(role)) return res.status(400).json({ error: 'Role must be Admin, Operator or Viewer' });
    const validLocs = await getAllSiteNames();
    if (location_access !== 'All' && !validLocs.includes(location_access)) return res.status(400).json({ error: `Location access must be "All" or one of: ${validLocs.join(', ')}` });
    const pwErr = passwordPolicyError(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const licStatus = license.getLicenseStatus(LICENSE_FILE);
    if (licStatus.enforced && licStatus.valid && licStatus.license && licStatus.license.maxUsers) {
      const [[{ cnt }]] = await pool.query("SELECT COUNT(*) as cnt FROM users WHERE status = 'Active'");
      if (cnt >= licStatus.license.maxUsers) {
        return res.status(402).json({ error: `This license allows up to ${licStatus.license.maxUsers} active user(s); that limit has been reached. Deactivate an existing user or contact your vendor to raise the limit.`, code: 'LICENSE_SEAT_LIMIT' });
      }
    }
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, name, role, location_access, status) VALUES (?,?,?,?,?,?)',
      [username, hash, name, role, location_access, 'Active']
    );
    res.json({ id: result.insertId, username, name, role, location_access, status: 'Active' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    sendErr(res, e);
  }
});

app.patch('/api/users/:id', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { name, role, location_access, status } = req.body || {};
    if (!['Admin', 'Operator', 'Viewer'].includes(role)) return res.status(400).json({ error: 'Role must be Admin, Operator or Viewer' });
    if (!['Active', 'Inactive'].includes(status)) return res.status(400).json({ error: 'Status must be Active or Inactive' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Full name is required' });
    const validLocs = await getAllSiteNames();
    if (location_access !== 'All' && !validLocs.includes(location_access)) return res.status(400).json({ error: `Location access must be "All" or one of: ${validLocs.join(', ')}` });
    const [rows] = await pool.query('SELECT id, username, role, location_access, status FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const current = rows[0];
    if (id === String(req.user.id) && (role !== current.role || location_access !== current.location_access || status !== current.status)) {
      return res.status(400).json({ error: 'You cannot change your own role, location access or account status while signed in.' });
    }

    // Never allow an Admin to remove the last active global Admin. This prevents
    // locking the application with nobody able to manage users/locations.
    const becomesGlobalAdmin = role === 'Admin' && location_access === 'All' && status === 'Active';
    const currentlyGlobalAdmin = current.role === 'Admin' && (current.location_access === 'All' || current.location_access === 'Both') && current.status === 'Active';
    if (currentlyGlobalAdmin && !becomesGlobalAdmin) {
      const [[{ cnt }]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM users WHERE role='Admin' AND status='Active' AND (location_access='All' OR location_access='Both') AND id <> ?`,
        [id]
      );
      if (Number(cnt) < 1) return res.status(409).json({ error: 'At least one active global Admin must remain.' });
    }

    // HARDENING: a disabled account, or a changed role / location, ends that user's sessions at once (cache entries dropped, stored session id cleared).
    const accessChanged = role !== current.role || location_access !== current.location_access || status !== current.status;
    if (accessChanged) await pool.query('UPDATE users SET name=?, role=?, location_access=?, status=?, session_id=NULL, last_seen_at=NULL WHERE id=?', [String(name).trim(), role, location_access, status, id]);
    else await pool.query('UPDATE users SET name=?, role=?, location_access=?, status=? WHERE id=?', [String(name).trim(), role, location_access, status, id]);
    if (accessChanged) purgeAuthCacheForUser(id);
    res.json({ success: true, id, name: String(name).trim(), role, location_access, status });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/users/:id', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'You cannot delete your own account' });
    const [rows] = await pool.query("SELECT role, status, location_access FROM users WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    if (u.role === 'Admin' && u.status === 'Active' && (u.location_access === 'All' || u.location_access === 'Both')) {
      const [[{ cnt }]] = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE role='Admin' AND status='Active' AND (location_access='All' OR location_access='Both')");
      if (Number(cnt) <= 1) return res.status(409).json({ error: 'Cannot delete the last active global Admin.' });
    }
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    purgeAuthCacheForUser(req.params.id);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.patch('/api/users/:id/reset-password', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    const pwErr = passwordPolicyError(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(newPassword, 10);
    // Resetting a password also ends that user's current session (a stolen token must not survive the reset).
    const [resetRes] = await pool.query('UPDATE users SET password_hash = ?, session_id = NULL, last_seen_at = NULL WHERE id = ?', [hash, req.params.id]);
    if (!resetRes.affectedRows) return res.status(404).json({ error: 'User not found' });
    purgeAuthCacheForUser(req.params.id);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== ASSETS ==========
app.get('/api/assets', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);

    let sql = 'SELECT * FROM assets';
    const params = [];
    const conditions = [];

    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?');
      params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    const [rows] = await pool.query(sql, params);
    const mapped = rows.map(r => ({
      id: r.id, site: r.site, zone: r.zone, rackType: r.rack_type, rackNo: r.rack_no, position: r.position,
      hardwareType: r.hardware_type, height: r.height, manufacturer: r.manufacturer, model: r.model,
      serialNumber: r.serial_number,
      installationDate: dateOnlyStr(r.installation_date),
      assetTag: r.asset_tag,
      mgmtIp: r.mgmt_ip, firmware: r.firmware, firmwareSource: r.firmware_source || 'manual', deviceName: r.device_name, remarks: r.remarks || "",
      lifecycleStatus: r.lifecycle_status || 'Active', custodyLocation: r.custody_location || null,
      lastKnownSite: r.last_known_site || null, lastKnownZone: r.last_known_zone || null,
      lastKnownRack: r.last_known_rack || null, lastKnownPosition: r.last_known_position || null,
      lastMovementAt: r.last_movement_at || null, lastMovementReason: r.last_movement_reason || null
    }));
    res.json(mapped);
  } catch (e) {
    sendErr(res, e);
  }
});

// Recently Added / Recently Modified for the Asset Inventory dashboard
// module. "Modified" is filtered to updated_by IS NOT NULL — a brand-new
// row's updated_at defaults to the same moment as created_at (both TIMESTAMP
// DEFAULT CURRENT_TIMESTAMP), so relying on updated_at alone would show
// every newly created asset as "just modified" too; updated_by is only ever
// set by an actual edit path (never on creation), so it's the real signal.
app.get('/api/assets/recent', authenticateToken, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 10, 50));
    const allowed = await getAllowedSitesForUser(req.user);
    const conditions = [];
    const params = [];
    await applySiteScope(allowed, conditions, params);
    const whereSite = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [added] = await pool.query(
      `SELECT id, site, zone, rack_no, model, serial_number, hardware_type, device_name, created_at, created_by
       FROM assets ${whereSite} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit]
    );
    const modifiedWhere = whereSite ? `${whereSite} AND updated_by IS NOT NULL` : 'WHERE updated_by IS NOT NULL';
    const [modified] = await pool.query(
      `SELECT id, site, zone, rack_no, model, serial_number, hardware_type, device_name, updated_at, updated_by, changed_fields
       FROM assets ${modifiedWhere} ORDER BY updated_at DESC LIMIT ?`,
      [...params, limit]
    );

    const shape = (r, whoKey, whenKey) => ({
      id: r.id, site: r.site, zone: r.zone, rackNo: r.rack_no, model: r.model,
      serialNumber: r.serial_number, hardwareType: r.hardware_type, deviceName: r.device_name,
      by: r[whoKey], at: r[whenKey], changes: r.changed_fields || null,
    });
    res.json({
      added: added.map((r) => shape(r, 'created_by', 'created_at')),
      modified: modified.map((r) => shape(r, 'updated_by', 'updated_at')),
    });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/assets', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  let tx = null;
  try {
    const a = { ...req.body };
    { const nf = normalizeUFormat(a.position, a.height); a.position = nf.position; a.height = nf.height; }
    await assertSiteAccess(req.user, a.site);
    const id = genId('AST');
    const initialLifecycleStatus = String(a.initialLifecycleStatus || 'Active').trim() === 'In Store' ? 'In Store' : 'Active';
    const initialStore = initialLifecycleStatus === 'In Store';
    const assetZone = initialStore ? null : (a.zone || 'AZ-1');
    const rackType = initialStore ? null : (a.rackType || null);
    const rackNo = initialStore ? null : (a.rackNo || null);
    const position = initialStore ? null : (a.position || null);
    const installDate = initialStore ? null : normalizeDateInput(a.installationDate);
    const custodyLocation = initialStore ? (String(a.custodyLocation || '').trim() || `${a.site} Store`) : null;
    const receiptReason = initialStore ? (String(a.receiptReason || a.reason || '').trim() || 'Received into DC store') : null;
    const receiptReference = initialStore ? (String(a.referenceNo || '').trim() || null) : null;

    // Rack/U validation only applies when the asset is being installed immediately.
    if (!initialStore && a.position && String(a.position).trim()) {
      const uParsed = parseUPos(a.position);
      if (!uParsed.valid) {
        return res.status(400).json({ error: 'Invalid U position format. Use 1U, 2U, 12U, or a range like 3-4U.' });
      }
    }
    if (initialStore && (a.rackNo || a.position || a.rackType)) {
      // Receiving into store must not create a misleading rack placement.
      return res.status(400).json({ error: 'A new asset received into Store cannot have rack, rack type, or U position. Install it later from Asset Lifecycle.' });
    }
    // Check for duplicate serial number
    if (a.serialNumber) {
      const [existing] = await pool.query('SELECT id FROM assets WHERE serial_number = ?', [a.serialNumber]);
      if (existing.length > 0) return res.status(409).json({ error: 'Asset already available' });
    }
    // Check for duplicate asset tag
    if (a.assetTag) {
      const [existingTag] = await pool.query('SELECT id FROM assets WHERE asset_tag = ?', [a.assetTag]);
      if (existingTag.length > 0) return res.status(409).json({ error: 'Asset tag already exists' });
    }
    if (!initialStore) {
      const uConflict = await findUConflict(a.site, assetZone, rackNo, position, a.height, null);
      if (uConflict) return res.status(409).json({ error: 'Other asset already available at same U position', conflict: uConflict });
    }
    const assetTag = a.assetTag && String(a.assetTag).trim() ? String(a.assetTag).trim() : null;
    const serialNumber = a.serialNumber && String(a.serialNumber).trim() ? String(a.serialNumber).trim() : null;
    const mgmtIp = a.mgmtIp && String(a.mgmtIp).trim() ? String(a.mgmtIp).trim() : null;
    const firmware = a.firmware && String(a.firmware).trim() ? String(a.firmware).trim() : null;
    const deviceName = a.deviceName && String(a.deviceName).trim() ? String(a.deviceName).trim() : null;
    const remarks = a.remarks && String(a.remarks).trim() ? String(a.remarks).trim() : null;
    const hwType = await normalizeHardwareType(pool, a.hardwareType, req.user && (req.user.name || req.user.username));
    // Rack components (Patch Panel, Cable Manager, LIU, STS/ATS, Other, ...) live in
    // their own rack_components table now - Asset Inventory / assets is devices only.
    const [hwCatRows] = await pool.query('SELECT category FROM hardware_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [hwType]);
    if (hwCatRows.length && hwCatRows[0].category === 'Component') {
      return res.status(400).json({ error: `"${hwType}" is a rack component type - add it from the Rack Components tab instead.` });
    }

    if (initialStore) {
      tx = await pool.getConnection();
      await tx.beginTransaction();
    }
    const db = tx || pool;
    await db.query(
      `INSERT INTO assets (id, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, serial_number, installation_date, asset_tag, mgmt_ip, firmware, device_name, remarks, firmware_source, created_by, lifecycle_status, custody_location)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, a.site, assetZone, rackType, rackNo, position, hwType, a.height, a.manufacturer, a.model, serialNumber, installDate, assetTag, mgmtIp, firmware, deviceName, remarks, 'manual', req.user.name || req.user.username, initialLifecycleStatus, custodyLocation]
    );

    // Keep the zones catalog in step with assets that are installed into a zone.
    if (!initialStore) {
      try { await db.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [genId('ZN'), a.site, String(assetZone).trim(), req.user && (req.user.name || req.user.username)]); } catch (e) { /* best effort */ }
    } else {
      const movementId = genId('AMV');
      const now = `${normalizeDateInput(a.movementDate) || localTodayStr()} ${new Date().toTimeString().slice(0,8)}`;
      await db.query(`INSERT INTO asset_movements (id, asset_id, serial_number, movement_type, from_site, from_zone, from_rack_no, from_position, to_site, to_zone, to_rack_no, to_position, movement_date, reason, reference_no, performed_by, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        movementId, id, serialNumber, 'Received to Store', null, null, null, null,
        a.site, null, null, null, now, receiptReason, receiptReference,
        req.user.name || req.user.username, remarks
      ]);
      await db.query('UPDATE assets SET last_movement_at = ?, last_movement_reason = ?, changed_fields = ? WHERE id = ?', [now, receiptReason, 'Lifecycle: Received to Store', id]);
    }
    if (tx) await tx.commit();

    res.json({ id, ...a,
      site: a.site, zone: assetZone, rackType, rackNo, position,
      installationDate: installDate ? installDate.slice(0, 10) : null,
      lifecycleStatus: initialLifecycleStatus, custodyLocation
    });
  } catch (e) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    sendErr(res, e);
  } finally {
    if (tx) tx.release();
  }
});

app.patch('/api/assets/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const a = req.body;
    { const nf = normalizeUFormat(a.position, a.height); a.position = nf.position; a.height = nf.height; }
    const id = req.params.id;
    const [existingRows] = await pool.query(
      `SELECT id, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, serial_number,
              installation_date, asset_tag, mgmt_ip, firmware AS existing_firmware, device_name, remarks
       FROM assets WHERE id = ?`,
      [id]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    await assertSiteAccess(req.user, existingRows[0].site);
    await assertSiteAccess(req.user, a.site);
    const installDate = normalizeDateInput(a.installationDate);
    // Validate U position format
    if (a.position && String(a.position).trim()) {
      const uParsed = parseUPos(a.position);
      if (!uParsed.valid) {
        return res.status(400).json({ error: 'Invalid U position format. Use 1U, 2U, 12U, or a range like 3-4U.' });
      }
    }
    // Check for duplicate serial number on a *different* asset
    if (a.serialNumber) {
      const [existing] = await pool.query('SELECT id FROM assets WHERE serial_number = ? AND id != ?', [a.serialNumber, id]);
      if (existing.length > 0) return res.status(409).json({ error: 'Asset already available' });
    }
    // Check for duplicate asset tag on a *different* asset
    if (a.assetTag) {
      const [existingTag] = await pool.query('SELECT id FROM assets WHERE asset_tag = ? AND id != ?', [a.assetTag, id]);
      if (existingTag.length > 0) return res.status(409).json({ error: 'Asset tag already exists' });
    }
    const uConflict = await findUConflict(a.site, a.zone, a.rackNo, a.position, a.height, id);
    if (uConflict) return res.status(409).json({ error: 'Other asset already available at same U position', conflict: uConflict });
    const assetTag = a.assetTag && String(a.assetTag).trim() ? String(a.assetTag).trim() : null;
    const serialNumber = a.serialNumber && String(a.serialNumber).trim() ? String(a.serialNumber).trim() : null;
    const mgmtIp = a.mgmtIp && String(a.mgmtIp).trim() ? String(a.mgmtIp).trim() : null;
    const firmware = a.firmware && String(a.firmware).trim() ? String(a.firmware).trim() : null;
    const deviceName = a.deviceName && String(a.deviceName).trim() ? String(a.deviceName).trim() : null;
    const remarks = a.remarks && String(a.remarks).trim() ? String(a.remarks).trim() : null;
    const hwType = await normalizeHardwareType(pool, a.hardwareType, req.user && (req.user.name || req.user.username));
    const [hwCatRowsEdit] = await pool.query('SELECT category FROM hardware_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [hwType]);
    if (hwCatRowsEdit.length && hwCatRowsEdit[0].category === 'Component') {
      return res.status(400).json({ error: `"${hwType}" is a rack component type - manage it from the Rack Components tab instead.` });
    }
    // A person editing this asset just supplied this exact firmware value —
    // if it's actually different from what was stored, that's a manual
    // override (even of a previously API-synced value, per how this is
    // meant to work); if they left it unchanged, don't touch its source.
    const firmwareChanged = firmware !== (existingRows[0].existing_firmware || null);
    // Real field-level diff against the row as it was before this edit —
    // powers the "Changes Made" column in Recently Modified. Compares final
    // values (post-normalization) against the old row, not raw request
    // input, so e.g. trimming/casing normalization doesn't falsely register
    // as a change.
    const oldRow = existingRows[0];
    const cmp = (v) => (v === null || v === undefined) ? '' : String(v).trim();
    const dateCmp = (v) => v ? (dateOnlyStr(v) || '') : '';
    const diffs = [];
    if (cmp(a.site) !== cmp(oldRow.site)) diffs.push('Site');
    if (cmp(a.zone || 'AZ-1') !== cmp(oldRow.zone)) diffs.push('Zone');
    if (cmp(a.rackType) !== cmp(oldRow.rack_type)) diffs.push('Rack Type');
    if (cmp(a.rackNo) !== cmp(oldRow.rack_no)) diffs.push('Rack No');
    if (cmp(a.position) !== cmp(oldRow.position)) diffs.push('Position');
    if (cmp(hwType) !== cmp(oldRow.hardware_type)) diffs.push('Hardware Type');
    if (cmp(a.height) !== cmp(oldRow.height)) diffs.push('Height');
    if (cmp(a.manufacturer) !== cmp(oldRow.manufacturer)) diffs.push('Manufacturer');
    if (cmp(a.model) !== cmp(oldRow.model)) diffs.push('Model');
    if (cmp(serialNumber) !== cmp(oldRow.serial_number)) diffs.push('Serial Number');
    if (dateCmp(installDate) !== dateCmp(oldRow.installation_date)) diffs.push('Installation Date');
    if (cmp(assetTag) !== cmp(oldRow.asset_tag)) diffs.push('Asset Tag');
    if (cmp(mgmtIp) !== cmp(oldRow.mgmt_ip)) diffs.push('Mgmt IP');
    if (firmwareChanged) diffs.push('Firmware');
    if (cmp(deviceName) !== cmp(oldRow.device_name)) diffs.push('Device Name');
    if (cmp(remarks) !== cmp(oldRow.remarks)) diffs.push('Remarks');
    const changedFieldsStr = diffs.length ? diffs.join(', ') : null;
    await pool.query(
      `UPDATE assets SET site=?, zone=?, rack_type=?, rack_no=?, position=?, hardware_type=?, height=?, manufacturer=?, model=?, serial_number=?, installation_date=?, asset_tag=?, mgmt_ip=?, firmware=?, device_name=?, remarks=?, updated_at=CURRENT_TIMESTAMP, updated_by=?, changed_fields=?${firmwareChanged ? ", firmware_source='manual'" : ''} WHERE id=?`,
      [a.site, a.zone || 'AZ-1', a.rackType, a.rackNo, a.position, hwType, a.height, a.manufacturer, a.model, serialNumber, installDate, assetTag, mgmtIp, firmware, deviceName, remarks, req.user.name || req.user.username, changedFieldsStr, id]
    );
    // keep linked issues in step with the asset (serial edit / move to another rack, zone or site)
    await syncIssuesForAsset(pool, existingRows[0].serial_number, { serial: serialNumber, site: a.site, zone: a.zone, rackNo: a.rackNo, position: a.position });
    res.json({ id, ...a, installationDate: installDate ? installDate.slice(0, 10) : null });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/assets/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT site, serial_number FROM assets WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    await assertSiteAccess(req.user, rows[0].site);
    const [[{ movementCount }]] = await pool.query('SELECT COUNT(*) AS movementCount FROM asset_movements WHERE asset_id = ?', [req.params.id]);
    if (Number(movementCount) > 0) return res.status(409).json({ error: 'This asset has lifecycle history and cannot be permanently deleted. Use Decommission / Archive instead.' });
    if (rows[0].serial_number) {
      const [[{ cnt }]] = await pool.query('SELECT COUNT(*) AS cnt FROM issues WHERE asset_id = ? AND completed_date IS NULL', [rows[0].serial_number]);
      if (cnt > 0) return res.status(409).json({ error: `This asset still has ${cnt} open issue(s). Close or delete them in the Issue Tracker first.` });
    }
    await pool.query('DELETE FROM assets WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/assets/validate-import', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of assets' });
    }
    const errors = [];
    const seenTags = new Set();
    const seenSerials = new Set();
    const validSites = await getAllSiteNames();
    const [zoneRowsAll] = await pool.query('SELECT site, zone_name FROM zones');
    const zonesBySite = {}; zoneRowsAll.forEach(r => { (zonesBySite[r.site] = zonesBySite[r.site] || []).push(r.zone_name); });
    // Rack components live in their own table/import now - this endpoint (and
    // Asset Inventory generally) is devices only again.
    const [compTypeRowsV] = await pool.query("SELECT name FROM hardware_types WHERE category = 'Component'");
    const componentHwNamesV = new Set(compTypeRowsV.map(r => String(r.name || '').trim().toLowerCase()));
    const isComponentType = (hw) => componentHwNamesV.has(String(hw || '').trim().toLowerCase());

    // Fetch existing tags and serials from DB for duplicate check
    const allowedForUserV = await getAllowedSitesForUser(req.user);
    const [existingRows] = await pool.query('SELECT asset_tag, serial_number, site FROM assets WHERE asset_tag IS NOT NULL OR serial_number IS NOT NULL');
    const foreignSerials = new Set(existingRows.filter(r => r.serial_number && !allowedForUserV.includes(r.site)).map(r => String(r.serial_number).trim().toLowerCase()));
    // A serial that already exists is an UPDATE (that is what bulk-upsert does), not an error.
    // An asset tag is only a conflict when it belongs to a *different* serial number.
    const tagOwner = new Map(existingRows.filter(r => r.asset_tag).map(r => [r.asset_tag, r.serial_number]));

    items.forEach((item, idx) => {
      const row = idx + 2; // assuming header is row 1
      const rowErrors = [];
      // Asset tag is optional. When supplied, it must be unique. Serial number is
      // always required here - a rack-component-typed row belongs in the separate
      // Rack Components import instead.
      if (!item.serialNumber || String(item.serialNumber).trim() === '') rowErrors.push('Serial number is required');
      else if (foreignSerials.has(String(item.serialNumber).trim().toLowerCase())) rowErrors.push('Serial number belongs to an asset at a site you do not have access to');
      if (isComponentType(item.hardwareType)) rowErrors.push(`"${item.hardwareType}" is a rack component type - import it from the Rack Components tab instead`);
      if (!item.site || !validSites.includes(item.site)) rowErrors.push(`Site must be one of: ${validSites.join(', ')}`);
      if (!item.hardwareType || String(item.hardwareType).trim() === '') rowErrors.push('Hardware type is required');
      if (item.zone && item.site && validSites.includes(item.site) && !(zonesBySite[item.site] || []).includes(item.zone)) rowErrors.push(`Zone "${item.zone}" is not defined for ${item.site}. Available: ${(zonesBySite[item.site] || []).join(', ') || 'none'}`);

      const tag = item.assetTag ? String(item.assetTag).trim() : '';
      const serial = item.serialNumber ? String(item.serialNumber).trim() : '';

      if (tag) {
        if (seenTags.has(tag)) rowErrors.push(`Duplicate asset tag "${tag}" in import batch`);
        else if (tagOwner.has(tag) && tagOwner.get(tag) !== serial) rowErrors.push(`Asset tag "${tag}" is already used by another asset`);
        seenTags.add(tag);
      }
      if (serial) {
        if (seenSerials.has(serial)) rowErrors.push(`Duplicate serial number "${serial}" in import batch`);

        seenSerials.add(serial);
      }

      if (rowErrors.length) errors.push({ row, assetTag: tag || '(empty)', serialNumber: serial || '(empty)', errors: rowErrors });
    });

    res.json({ valid: errors.length === 0, errors, total: items.length });
  } catch (e) {
    sendErr(res, e);
  }
});


// Bulk upsert — update existing by serial_number, insert new.
//
// PERF: this used to do 4-6 sequential DB round-trips PER ROW (existence
// lookup, tag-conflict lookup, hardware-type lookup/insert, the write itself,
// and up to 2 more for linked-issue sync) inside one open transaction. For a
// 200-row chunk that was 800-1200+ round-trips, one at a time - slow for the
// person importing, and it held a pool connection (and row locks on `assets`)
// for the whole stretch, which is what made OTHER logged-in users feel the
// app stall while someone else's import was running.
//
// This version does the same validation and produces byte-for-byte the same
// results shape, but resolves each chunk in a fixed small number of queries
// regardless of row count: one bulk lookup for existing rows, one bulk lookup
// for tag ownership, one bulk lookup (+bulk insert of anything new) for
// hardware types, then a single multi-row INSERT ... ON DUPLICATE KEY UPDATE
// that creates and updates every row in the chunk in one round-trip, and one
// or two bulk UPDATEs to keep linked issue tickets in sync.
app.post('/api/assets/bulk-upsert', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const user = req.user;
    const items = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of assets' });
    }

    await conn.beginTransaction();

    const results = { created: 0, updated: 0, errors: [] };
    const seenTagsInBatch = new Set();
    const seenSerialsInBatch = new Map(); // serial -> first row it appeared on
    const validSites = await getAllSiteNames();
    const [zoneRowsAll2] = await conn.query('SELECT site, zone_name FROM zones');
    const zonesBySite = {}; zoneRowsAll2.forEach(r => { (zonesBySite[r.site] = zonesBySite[r.site] || []).push(r.zone_name); });
    const allowedForUser = await getAllowedSitesForUser(user); // once, not once per row
    // Rack components live in their own table/import now - a Component-category
    // hardware type in this (device) import is rejected, not silently relaxed.
    const [compTypeRowsB] = await conn.query("SELECT name FROM hardware_types WHERE category = 'Component'");
    const componentHwNamesB = new Set(compTypeRowsB.map(r => String(r.name || '').trim().toLowerCase()));
    const isComponentHw = (hw) => componentHwNamesB.has(String(hw || '').trim().toLowerCase());

    // U-occupancy snapshot (assets + rack_components, DB + this batch) for
    // cross-validating U positions - a device import must not silently overlap
    // an existing rack component either (Rack Elevation = Device U + Component U).
    const [occAssetRows] = await conn.query('SELECT id, site, zone, rack_no, position, height, serial_number FROM assets');
    const [occCompRows] = await conn.query('SELECT id, site, zone, rack_no, position, height, component_code FROM rack_components');
    const occupied = [
      ...occAssetRows.map((r) => ({ id: r.id, site: r.site, zone: r.zone || 'AZ-1', rackNo: String(r.rack_no || '').trim().toUpperCase(), label: r.serial_number, u: parseUPos(r.position), h: parseHeightU(r.height) || 1 })),
      ...occCompRows.map((r) => ({ id: r.id, site: r.site, zone: r.zone || 'AZ-1', rackNo: String(r.rack_no || '').trim().toUpperCase(), label: r.component_code, u: parseUPos(r.position), h: parseHeightU(r.height) || 1 })),
    ].filter((r) => r.u && r.u.valid && r.rackNo);

    // ---- Pass 1: normalize + validate everything that needs no DB round-trip
    // (identical checks/messages to before), building the list of candidate
    // rows plus the small set of DB facts we'll need to fetch in bulk. ----
    const bcmp = (v) => (v === null || v === undefined) ? '' : String(v).trim();
    const bdateCmp = (v) => v ? (dateOnlyStr(v) || '') : '';
    const candidates = [];
    const neededSerials = new Set();
    const neededTags = new Set();
    const neededHwKeys = new Map(); // lowercased name -> first-seen original casing

    for (let idx = 0; idx < items.length; idx++) {
      const item = { ...items[idx] };
      { const nf = normalizeUFormat(item.position, item.height); item.position = nf.position; item.height = nf.height; }
      const row = idx + 2;
      const rowErrors = [];

      const tag = item.assetTag ? String(item.assetTag).trim() : '';
      const serial = item.serialNumber ? String(item.serialNumber).trim() : '';
      const tagKey = tag.toLowerCase();
      const serialKey = serial.toLowerCase();
      const site = item.site;
      const hw = item.hardwareType;
      const hwKey = String(hw || '').trim().toLowerCase();
      const zone = item.zone || 'AZ-1';

      if (!serial) rowErrors.push('Serial number is required');
      else {
        // A repeated serial inside one import is the SAME asset: without this the 2nd row silently overwrote the 1st
        // and was counted as an "update", so N rows in the file produced N-1 assets.
        if (seenSerialsInBatch.has(serialKey)) rowErrors.push(`Duplicate serial number "${serial}" - already on row ${seenSerialsInBatch.get(serialKey)} of this import, row skipped`);
        else seenSerialsInBatch.set(serialKey, row);
      }
      if (isComponentHw(hw)) rowErrors.push(`"${hw}" is a rack component type - import it from the Rack Components tab instead`);
      if (!site || !validSites.includes(site)) rowErrors.push(`Site must be one of: ${validSites.join(', ')}`);
      else if (!allowedForUser.includes(site)) rowErrors.push(`Access denied for site ${site}`);
      if (!hw || String(hw).trim() === '') rowErrors.push('Hardware type is required');
      else if (String(hw).trim().length > 50) rowErrors.push('Hardware type must be 50 characters or fewer');
      if (zone && site && validSites.includes(site) && !(zonesBySite[site] || []).includes(zone)) rowErrors.push(`Zone "${zone}" is not defined for ${site}. Available: ${(zonesBySite[site] || []).join(', ') || 'none'}`);

      // Cross-validate U position against existing inventory (devices + components) + earlier rows in this batch
      const newU = parseUPos(item.position);
      if (newU && newU.valid && item.rackNo && String(item.rackNo).trim()) {
        const newH = parseHeightU(item.height) || 1;
        const rackKey = String(item.rackNo).trim().toUpperCase();
        const newStart = newU.start;
        const newEnd = Math.max(newU.end, newU.start + newH - 1);
        const clash = occupied.find((o) =>
          o.site === site && o.zone === zone && o.rackNo === rackKey && o.label !== serial &&
          o.u.start <= newEnd && newStart <= Math.max(o.u.end, o.u.start + o.h - 1)
        );
        if (clash) rowErrors.push(`Other asset already available at same U position (${clash.u.start}${clash.h > 1 ? '-' + (clash.u.start + clash.h - 1) : ''}U, ${clash.label || 'occupied'})`);
      }

      // Asset tag is optional, but if supplied it must be unique within this import batch.
      if (tagKey) {
        if (seenTagsInBatch.has(tagKey)) rowErrors.push(`Duplicate asset tag "${tag}" in this import batch`);
        else seenTagsInBatch.add(tagKey);
      }

      if (rowErrors.length) {
        results.errors.push({ row, assetTag: tag || '(empty)', errors: rowErrors });
        continue;
      }

      // Reserve this row's U-range so later rows in the batch can't clash with it
      if (newU && newU.valid && item.rackNo && String(item.rackNo).trim()) {
        const rackKey = String(item.rackNo).trim().toUpperCase();
        for (let oi = occupied.length - 1; oi >= 0; oi--) { if (occupied[oi].label === serial) occupied.splice(oi, 1); }
        occupied.push({ id: null, site, zone, rackNo: rackKey, label: serial, u: newU, h: parseHeightU(item.height) || 1 });
      }

      const installDate = normalizeDateInput(item.installationDate);
      neededSerials.add(serialKey);
      if (tagKey) neededTags.add(tagKey);
      if (hwKey && !neededHwKeys.has(hwKey)) neededHwKeys.set(hwKey, String(hw).trim());
      candidates.push({ row, item, tag, tagKey, serial, serialKey, site, hw, hwKey, zone, installDate });
    }

    // ---- Pass 2: bulk-fetch the DB facts every candidate row might need,
    // in a handful of queries total instead of one set per row. ----
    let existingBySerial = new Map(); // serialKey -> row
    if (neededSerials.size) {
      const [rows] = await conn.query(
        `SELECT id, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, serial_number, asset_tag,
                installation_date, mgmt_ip, firmware AS existing_firmware, firmware_source AS existing_firmware_source, device_name, remarks
         FROM assets WHERE LOWER(serial_number) IN (?)`,
        [Array.from(neededSerials)]
      );
      existingBySerial = new Map(rows.map((r) => [String(r.serial_number || '').toLowerCase(), r]));
    }
    let tagOwnerById = new Map(); // tagKey -> owning asset id
    if (neededTags.size) {
      const [rows] = await conn.query('SELECT id, asset_tag FROM assets WHERE LOWER(asset_tag) IN (?)', [Array.from(neededTags)]);
      tagOwnerById = new Map(rows.map((r) => [String(r.asset_tag || '').toLowerCase(), r.id]));
    }
    const hwCanonicalByKey = new Map(); // lowercased name -> canonical stored name
    if (neededHwKeys.size) {
      const [rows] = await conn.query('SELECT name FROM hardware_types WHERE LOWER(name) IN (?)', [Array.from(neededHwKeys.keys())]);
      rows.forEach((r) => hwCanonicalByKey.set(String(r.name || '').toLowerCase(), r.name));
      const missing = Array.from(neededHwKeys.entries()).filter(([k]) => !hwCanonicalByKey.has(k));
      if (missing.length) {
        // INSERT IGNORE: two people bulk-importing at the same moment can both
        // try to auto-create the same brand-new hardware type - IGNORE means
        // the loser of that race silently skips instead of failing the chunk.
        await conn.query(
          'INSERT IGNORE INTO hardware_types (id, name, created_by) VALUES ' + missing.map(() => '(?,?,?)').join(','),
          missing.flatMap(([, name]) => [genId('HT'), name, user.name || user.username])
        );
        const [rows2] = await conn.query('SELECT name FROM hardware_types WHERE LOWER(name) IN (?)', [missing.map(([k]) => k)]);
        rows2.forEach((r) => hwCanonicalByKey.set(String(r.name || '').toLowerCase(), r.name));
      }
    }

    // Track tag reassignment happening within this same batch (row A gives up
    // a tag that row B wants) so the DB-ownership check below doesn't flag a
    // legitimate in-batch handoff as a conflict.
    const updatingIdToNewTagKey = new Map();
    for (const c of candidates) {
      const existing = existingBySerial.get(c.serialKey);
      if (existing) updatingIdToNewTagKey.set(existing.id, c.tagKey || null);
    }

    // ---- Pass 3: final per-row decision using only in-memory data, then
    // build one multi-row write per chunk. ----
    const writeRows = []; // one tuple per row that will actually be written
    const issueRenames = []; // { fromSerial, toSerial } for rows that changed their own serial number
    const openIssueRefresh = []; // { serial, site, zone, rackNo, position } for every updated row

    for (const c of candidates) {
      const { row, item, tag, tagKey, serial, serialKey, site, hw, hwKey, zone, installDate } = c;
      const existing = existingBySerial.get(serialKey);
      const hwType = hwCanonicalByKey.get(hwKey) || String(hw).trim();
      // SECURITY: a row may only update an asset the user is allowed to touch - never move/overwrite another site's asset by matching its serial.
      if (existing && !allowedForUser.includes(existing.site)) {
        results.errors.push({ row, assetTag: tag, errors: [`Serial number "${serial}" belongs to an asset at a site you do not have access to`] });
        continue;
      }

      if (tagKey) {
        const ownerId = tagOwnerById.get(tagKey);
        const selfId = existing ? existing.id : null;
        const ownerIsSelf = ownerId && selfId && ownerId === selfId;
        const ownerIsVacatingInThisBatch = ownerId && updatingIdToNewTagKey.has(ownerId) && updatingIdToNewTagKey.get(ownerId) !== tagKey;
        if (ownerId && !ownerIsSelf && !ownerIsVacatingInThisBatch) {
          results.errors.push({ row, assetTag: tag, errors: [`Asset tag "${tag}" already exists`] });
          continue;
        }
      }

      const updateTag = tag || null;
      const updateSerial = serial || null;

      if (existing) {
        const bulkFirmwareChanged = (item.firmware || null) !== (existing.existing_firmware || null);
        const bulkDiffs = [];
        if (bcmp(site) !== bcmp(existing.site)) bulkDiffs.push('Site');
        if (bcmp(zone) !== bcmp(existing.zone)) bulkDiffs.push('Zone');
        if (bcmp(item.rackType) !== bcmp(existing.rack_type)) bulkDiffs.push('Rack Type');
        if (bcmp(item.rackNo) !== bcmp(existing.rack_no)) bulkDiffs.push('Rack No');
        if (bcmp(item.position) !== bcmp(existing.position)) bulkDiffs.push('Position');
        if (bcmp(hwType) !== bcmp(existing.hardware_type)) bulkDiffs.push('Hardware Type');
        if (bcmp(item.height) !== bcmp(existing.height)) bulkDiffs.push('Height');
        if (bcmp(item.manufacturer) !== bcmp(existing.manufacturer)) bulkDiffs.push('Manufacturer');
        if (bcmp(item.model) !== bcmp(existing.model)) bulkDiffs.push('Model');
        if (bcmp(updateSerial) !== bcmp(existing.serial_number)) bulkDiffs.push('Serial Number');
        if (bdateCmp(installDate) !== bdateCmp(existing.installation_date)) bulkDiffs.push('Installation Date');
        if (bcmp(updateTag) !== bcmp(existing.asset_tag)) bulkDiffs.push('Asset Tag');
        if (bcmp(item.mgmtIp) !== bcmp(existing.mgmt_ip)) bulkDiffs.push('Mgmt IP');
        if (bulkFirmwareChanged) bulkDiffs.push('Firmware');
        if (bcmp(item.deviceName) !== bcmp(existing.device_name)) bulkDiffs.push('Device Name');
        if (bcmp(item.remarks) !== bcmp(existing.remarks)) bulkDiffs.push('Remarks');
        const bulkChangedFieldsStr = bulkDiffs.length ? bulkDiffs.join(', ') : null;

        writeRows.push([
          existing.id, site, zone, item.rackType || null, item.rackNo || null, item.position || null, hwType, item.height || null,
          item.manufacturer || null, item.model || null, updateSerial, installDate, updateTag, item.mgmtIp || null, item.firmware || null,
          item.deviceName || null, item.remarks || null,
          bulkFirmwareChanged ? 'manual' : (existing.existing_firmware_source || 'manual'),
          user.name || user.username, bulkChangedFieldsStr,
        ]);
        if (updateSerial && updateSerial !== existing.serial_number) issueRenames.push({ fromSerial: existing.serial_number, toSerial: updateSerial });
        openIssueRefresh.push({ serial: updateSerial || existing.serial_number, site, zone, rackNo: item.rackNo, position: item.position });
        results.updated++;
      } else {
        const id = genId('AST');
        writeRows.push([
          id, site, zone, item.rackType || null, item.rackNo || null, item.position || null, hwType, item.height || null,
          item.manufacturer || null, item.model || null, updateSerial, installDate, updateTag, item.mgmtIp || null, item.firmware || null,
          item.deviceName || null, item.remarks || null, 'manual', user.name || user.username, null,
        ]);
        results.created++;
      }
    }

    // ---- Pass 4: the actual writes - one statement for every row in the
    // chunk, plus (at most) two bulk statements to keep linked issue tickets
    // in sync, instead of one UPDATE/INSERT + up to 2 issue-sync queries PER ROW. ----
    if (writeRows.length) {
      // Every row's tuple (both branches, above) carries the importing user's
      // name in the `created_by` position. For a genuinely NEW row that value
      // becomes the real created_by. For a row that collides on `id` (an
      // update) MySQL takes the ON DUPLICATE KEY UPDATE branch instead, which
      // deliberately does NOT reference created_by - so the existing row's
      // original creator is left untouched - and instead reuses that same
      // per-row value via VALUES(created_by) to stamp updated_by, which is
      // exactly "the user who ran this import". updated_by is also
      // deliberately left OUT of the INSERT column list entirely, so a brand
      // new row's updated_by stays NULL (never faked to look "modified") -
      // see the /api/assets/recent comment above about why that distinction matters.
      await conn.query(
        `INSERT INTO assets
           (id, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, serial_number,
            installation_date, asset_tag, mgmt_ip, firmware, device_name, remarks, firmware_source, created_by, changed_fields)
         VALUES ${writeRows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
         ON DUPLICATE KEY UPDATE
           site=VALUES(site), zone=VALUES(zone), rack_type=VALUES(rack_type), rack_no=VALUES(rack_no), position=VALUES(position),
           hardware_type=VALUES(hardware_type), height=VALUES(height), manufacturer=VALUES(manufacturer), model=VALUES(model),
           serial_number=VALUES(serial_number), installation_date=VALUES(installation_date), asset_tag=VALUES(asset_tag),
           mgmt_ip=VALUES(mgmt_ip), firmware=VALUES(firmware), device_name=VALUES(device_name), remarks=VALUES(remarks),
           firmware_source=VALUES(firmware_source), updated_at=CURRENT_TIMESTAMP, updated_by=VALUES(created_by), changed_fields=VALUES(changed_fields)`,
        writeRows.flat()
      );
    }
    if (issueRenames.length) {
      // One statement renaming every asset_id that changed serial in this chunk, instead of one UPDATE per row.
      await conn.query(
        `UPDATE issues SET asset_id = CASE ${issueRenames.map(() => 'WHEN asset_id = ? THEN ?').join(' ')} ELSE asset_id END
         WHERE asset_id IN (?)`,
        [...issueRenames.flatMap((r) => [r.fromSerial, r.toSerial]), issueRenames.map((r) => r.fromSerial)]
      );
    }
    if (openIssueRefresh.length) {
      // One statement refreshing site/zone/rack/position on every OPEN issue linked to any updated asset in this
      // chunk, instead of one UPDATE per updated row.
      const cols = ['site', 'zone', 'rack_no', 'u_position'];
      const caseSql = cols.map((col) => `${col} = CASE asset_id ${openIssueRefresh.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ${col} END`).join(', ');
      const caseParams = cols.flatMap((col) => openIssueRefresh.flatMap((r) => [
        r.serial,
        col === 'site' ? r.site : col === 'zone' ? (r.zone || 'AZ-1') : col === 'rack_no' ? (r.rackNo || null) : (r.position || null),
      ]));
      await conn.query(
        `UPDATE issues SET ${caseSql} WHERE asset_id IN (?) AND completed_date IS NULL`,
        [...caseParams, openIssueRefresh.map((r) => r.serial)]
      );
    }

    await conn.commit();
    res.json(results);
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    sendErr(res, e);
  } finally {
    if (conn) conn.release();
  }
});

// ===== Rack Components (Patch Panel, Cable Manager, LIU, STS/ATS, Other, ...) =====
// A separate entity from `assets` (own table, own tab, own import) - never counted
// as a Device, but sharing rack U space with assets (Rack Elevation = Device U +
// Component U), so findUConflict and the bulk-import U-clash check both look at
// this table too. Identity is an auto-generated component_code (e.g. "A04-PP-01"),
// fixed at creation and never changed by an edit, move, or re-import.
function mapRackComponentRow(r) {
  return {
    id: r.id, componentCode: r.component_code, site: r.site, zone: r.zone,
    rackType: r.rack_type, rackNo: r.rack_no, position: r.position,
    hardwareType: r.hardware_type, height: r.height, manufacturer: r.manufacturer, model: r.model,
    assetTag: r.asset_tag,
    installationDate: dateOnlyStr(r.installation_date),
    remarks: r.remarks || '', createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at, changes: r.changed_fields || null,
  };
}
// Resolves a hardware type name to its canonical catalog entry, requiring it to be
// a Component-category type - auto-creates it as one if it's genuinely new, but
// refuses to silently repurpose an existing Device-category type.
async function normalizeComponentHardwareType(conn, rawName, createdBy) {
  const name = String(rawName || '').trim();
  if (!name) { const err = new Error('Hardware type is required'); err.statusCode = 400; throw err; }
  const [rows] = await conn.query('SELECT id, name, category FROM hardware_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [name]);
  if (rows.length > 0) {
    if (rows[0].category !== 'Component') {
      const err = new Error(`"${rows[0].name}" is a device hardware type, not a rack component type.`);
      err.statusCode = 400; throw err;
    }
    return rows[0].name;
  }
  if (name.length > 50) { const err = new Error('Hardware type name must be 50 characters or fewer'); err.statusCode = 400; throw err; }
  await conn.query('INSERT INTO hardware_types (id, name, category, created_by) VALUES (?,?,?,?)', [genId('HT'), name, 'Component', createdBy || 'System']);
  return name;
}

app.get('/api/rack-components', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const allowed = await getAllowedSitesForUser(req.user);
    let sql = 'SELECT * FROM rack_components';
    const params = [];
    const conditions = [];
    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?');
      params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(mapRackComponentRow));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/rack-components', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const c = { ...req.body };
    { const nf = normalizeUFormat(c.position, c.height); c.position = nf.position; c.height = nf.height; }
    await assertSiteAccess(req.user, c.site);
    if (!c.rackNo || !String(c.rackNo).trim()) return res.status(400).json({ error: 'Rack No. is required' });
    if (c.position && String(c.position).trim()) {
      const uParsed = parseUPos(c.position);
      if (!uParsed.valid) return res.status(400).json({ error: 'Invalid U position format. Use 1U, 2U, 12U, or a range like 3-4U.' });
    }
    const zone = c.zone || 'AZ-1';
    const hwType = await normalizeComponentHardwareType(pool, c.hardwareType, req.user.name || req.user.username);
    const uConflict = await findUConflict(c.site, zone, c.rackNo, c.position, c.height, null);
    if (uConflict) return res.status(409).json({ error: 'Other asset already available at same U position', conflict: uConflict });
    const id = genId('RC');
    const code = await nextComponentCode(pool, c.site, zone, c.rackNo, hwType);
    const installDate = normalizeDateInput(c.installationDate);
    const assetTag = c.assetTag && String(c.assetTag).trim() ? String(c.assetTag).trim() : null;
    const remarks = c.remarks && String(c.remarks).trim() ? String(c.remarks).trim() : null;
    await pool.query(
      `INSERT INTO rack_components (id, component_code, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, asset_tag, installation_date, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, c.site, zone, c.rackType || null, c.rackNo, c.position || null, hwType, c.height, c.manufacturer || null, c.model || null, assetTag, installDate, remarks, req.user.name || req.user.username]
    );
    try { await pool.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [genId('ZN'), c.site, String(zone).trim(), req.user.name || req.user.username]); } catch (e) { /* best effort */ }
    res.json({ id, componentCode: code, ...c, zone, hardwareType: hwType, installationDate: installDate ? installDate.slice(0, 10) : null });
  } catch (e) {
    sendErr(res, e);
  }
});

app.patch('/api/rack-components/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const c = req.body;
    { const nf = normalizeUFormat(c.position, c.height); c.position = nf.position; c.height = nf.height; }
    const id = req.params.id;
    const [existingRows] = await pool.query('SELECT * FROM rack_components WHERE id = ?', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Rack component not found' });
    const oldRow = existingRows[0];
    await assertSiteAccess(req.user, oldRow.site);
    await assertSiteAccess(req.user, c.site);
    if (c.position && String(c.position).trim()) {
      const uParsed = parseUPos(c.position);
      if (!uParsed.valid) return res.status(400).json({ error: 'Invalid U position format. Use 1U, 2U, 12U, or a range like 3-4U.' });
    }
    const zone = c.zone || 'AZ-1';
    const hwType = await normalizeComponentHardwareType(pool, c.hardwareType, req.user.name || req.user.username);
    const uConflict = await findUConflict(c.site, zone, c.rackNo, c.position, c.height, id);
    if (uConflict) return res.status(409).json({ error: 'Other asset already available at same U position', conflict: uConflict });
    const installDate = normalizeDateInput(c.installationDate);
    const assetTag = c.assetTag && String(c.assetTag).trim() ? String(c.assetTag).trim() : null;
    const remarks = c.remarks && String(c.remarks).trim() ? String(c.remarks).trim() : null;
    // Note: component_code is fixed at creation - moving/editing a component never renames it.
    const cmp = (v) => (v === null || v === undefined) ? '' : String(v).trim();
    const dateCmp = (v) => v ? (dateOnlyStr(v) || '') : '';
    const diffs = [];
    if (cmp(c.site) !== cmp(oldRow.site)) diffs.push('Site');
    if (cmp(zone) !== cmp(oldRow.zone)) diffs.push('Zone');
    if (cmp(c.rackType) !== cmp(oldRow.rack_type)) diffs.push('Rack Type');
    if (cmp(c.rackNo) !== cmp(oldRow.rack_no)) diffs.push('Rack No');
    if (cmp(c.position) !== cmp(oldRow.position)) diffs.push('Position');
    if (cmp(hwType) !== cmp(oldRow.hardware_type)) diffs.push('Hardware Type');
    if (cmp(c.height) !== cmp(oldRow.height)) diffs.push('Height');
    if (cmp(c.manufacturer) !== cmp(oldRow.manufacturer)) diffs.push('Manufacturer');
    if (cmp(c.model) !== cmp(oldRow.model)) diffs.push('Model');
    if (dateCmp(installDate) !== dateCmp(oldRow.installation_date)) diffs.push('Installation Date');
    if (cmp(assetTag) !== cmp(oldRow.asset_tag)) diffs.push('Asset Tag');
    if (cmp(remarks) !== cmp(oldRow.remarks)) diffs.push('Remarks');
    const changedFieldsStr = diffs.length ? diffs.join(', ') : null;
    await pool.query(
      `UPDATE rack_components SET site=?, zone=?, rack_type=?, rack_no=?, position=?, hardware_type=?, height=?, manufacturer=?, model=?, asset_tag=?, installation_date=?, remarks=?, updated_at=CURRENT_TIMESTAMP, updated_by=?, changed_fields=? WHERE id=?`,
      [c.site, zone, c.rackType || null, c.rackNo, c.position || null, hwType, c.height, c.manufacturer || null, c.model || null, assetTag, installDate, remarks, req.user.name || req.user.username, changedFieldsStr, id]
    );
    res.json({ id, componentCode: oldRow.component_code, ...c, zone, hardwareType: hwType, installationDate: installDate ? installDate.slice(0, 10) : null });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/rack-components/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT site FROM rack_components WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Rack component not found' });
    await assertSiteAccess(req.user, rows[0].site);
    await pool.query('DELETE FROM rack_components WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Bulk import for rack components - no serial number, so a re-import matches an
// existing row by its physical slot (site+zone+rack+position+hw type) instead,
// UPDATEing it in place rather than inserting a duplicate every time the same
// file is imported again. Two different components aimed at the same slot in
// one batch are flagged, same as the U-position clash check below.
// PERF: same batching treatment as /api/assets/bulk-upsert above - was one
// slot-lookup query (with COALESCE/UPPER/TRIM wrapped around the WHERE
// columns, which also defeated the index on that table) + one hardware-type
// query + one write PER ROW. Now: one bulk slot-fetch for every rack touched
// by this chunk, one bulk hardware-type lookup/create, all matching and
// component-code sequencing done in memory, then one multi-row write.
app.post('/api/rack-components/bulk-upsert', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const user = req.user;
    const items = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of rack components' });
    }
    await conn.beginTransaction();
    const results = { created: 0, updated: 0, errors: [] };
    const seenSlotsInBatch = new Map(); // "site|zone|rack|position|hwtype" -> first row
    const validSites = await getAllSiteNames();
    const [zoneRowsAllC] = await conn.query('SELECT site, zone_name FROM zones');
    const zonesBySiteC = {}; zoneRowsAllC.forEach(r => { (zonesBySiteC[r.site] = zonesBySiteC[r.site] || []).push(r.zone_name); });
    const allowedForUser = await getAllowedSitesForUser(user);

    // U-occupancy snapshot (assets + rack_components, DB + this batch)
    const [occAssetRowsC] = await conn.query('SELECT id, site, zone, rack_no, position, height, serial_number FROM assets');
    const [occCompRowsC] = await conn.query('SELECT id, site, zone, rack_no, position, height, component_code FROM rack_components');
    const occupied = [
      ...occAssetRowsC.map((r) => ({ id: r.id, site: r.site, zone: r.zone || 'AZ-1', rackNo: String(r.rack_no || '').trim().toUpperCase(), label: r.serial_number, u: parseUPos(r.position), h: parseHeightU(r.height) || 1 })),
      ...occCompRowsC.map((r) => ({ id: r.id, site: r.site, zone: r.zone || 'AZ-1', rackNo: String(r.rack_no || '').trim().toUpperCase(), label: r.component_code, u: parseUPos(r.position), h: parseHeightU(r.height) || 1 })),
    ].filter((r) => r.u && r.u.valid && r.rackNo);

    // ---- Pass 1: normalize + every check that needs no DB round-trip ----
    const candidates = [];
    const neededRackKeys = new Set(); // "site|zone" -> bulk-fetch every component in that rack's site+zone
    const neededHwKeys = new Map(); // lowercased name -> first-seen original casing
    for (let idx = 0; idx < items.length; idx++) {
      const item = { ...items[idx] };
      { const nf = normalizeUFormat(item.position, item.height); item.position = nf.position; item.height = nf.height; }
      const row = idx + 2;
      const rowErrors = [];
      const site = item.site;
      const hw = item.hardwareType;
      const zone = item.zone || 'AZ-1';
      const rackKey = item.rackNo ? String(item.rackNo).trim().toUpperCase() : '';
      const posKey = item.position ? String(item.position).trim().toUpperCase() : '';
      const hwKey = hw ? String(hw).trim().toLowerCase() : '';
      const slotKey = site && rackKey && posKey && hwKey ? `${site}|${zone}|${rackKey}|${posKey}|${hwKey}` : null;

      if (!site || !validSites.includes(site)) rowErrors.push(`Site must be one of: ${validSites.join(', ')}`);
      else if (!allowedForUser.includes(site)) rowErrors.push(`Access denied for site ${site}`);
      if (!hw || String(hw).trim() === '') rowErrors.push('Hardware type is required');
      if (!item.rackNo || !String(item.rackNo).trim()) rowErrors.push('Rack No. is required');
      if (zone && site && validSites.includes(site) && !(zonesBySiteC[site] || []).includes(zone)) rowErrors.push(`Zone "${zone}" is not defined for ${site}. Available: ${(zonesBySiteC[site] || []).join(', ') || 'none'}`);
      if (slotKey) {
        if (seenSlotsInBatch.has(slotKey)) rowErrors.push(`Duplicate rack component at same position - already on row ${seenSlotsInBatch.get(slotKey)} of this import, row skipped`);
        else seenSlotsInBatch.set(slotKey, row);
      }

      if (rowErrors.length) {
        results.errors.push({ row, hardwareType: hw || '(empty)', errors: rowErrors });
        continue;
      }

      if (site && rackKey) neededRackKeys.add(`${site}|${zone}`);
      if (hwKey && !neededHwKeys.has(hwKey)) neededHwKeys.set(hwKey, String(hw).trim());
      candidates.push({ row, item, site, hw, hwKey, zone, rackKey, posKey, slotKey, idx });
    }

    // ---- Pass 2: bulk-fetch what every candidate row might need ----
    // Slot match: every existing component in any (site, zone) touched by this chunk, matched
    // in memory using the exact same normalization the old per-row WHERE clause used
    // (COALESCE zone / UPPER+TRIM rack_no+position / LOWER+TRIM hardware_type) - this also
    // fixes the old query's problem of wrapping indexed columns in functions, which meant
    // MySQL couldn't use the (site, zone, rack_no) index and fell back to scanning.
    const existingBySlot = new Map(); // slotKey -> full row
    const existingCodesByRack = new Map(); // "site|zone|rackKey" -> array of component_code strings
    if (neededRackKeys.size) {
      // Filter on the plain, unwrapped `site` column (the leading column of
      // idx_rack_components_rack) so this can still use the index even though
      // there are many sites - then narrow to the exact (site, zone) pairs in JS.
      const neededSites = Array.from(new Set(Array.from(neededRackKeys).map((k) => k.split('|')[0])));
      const [rows] = await conn.query(`SELECT * FROM rack_components WHERE site IN (?)`, [neededSites]);
      rows.forEach((r) => {
        const rSite = r.site, rZone = r.zone || 'AZ-1';
        if (!neededRackKeys.has(`${rSite}|${rZone}`)) return; // right site, but a zone this chunk doesn't touch
        const rRackKey = String(r.rack_no || '').trim().toUpperCase();
        const rPosKey = String(r.position || '').trim().toUpperCase();
        const rHwKey = String(r.hardware_type || '').trim().toLowerCase();
        existingBySlot.set(`${rSite}|${rZone}|${rRackKey}|${rPosKey}|${rHwKey}`, r);
        const rackBucketKey = `${rSite}|${rZone}|${rRackKey}`;
        if (!existingCodesByRack.has(rackBucketKey)) existingCodesByRack.set(rackBucketKey, []);
        existingCodesByRack.get(rackBucketKey).push(r.component_code);
      });
    }
    const hwCanonicalByKey = new Map(); // lowercased name -> { name, category }
    if (neededHwKeys.size) {
      const [rows] = await conn.query('SELECT name, category FROM hardware_types WHERE LOWER(name) IN (?)', [Array.from(neededHwKeys.keys())]);
      rows.forEach((r) => hwCanonicalByKey.set(String(r.name || '').toLowerCase(), { name: r.name, category: r.category }));
      const missing = Array.from(neededHwKeys.entries()).filter(([k]) => !hwCanonicalByKey.has(k));
      if (missing.length) {
        // INSERT IGNORE: two concurrent bulk imports auto-creating the same brand-new
        // component type at once - the loser of that race just skips instead of erroring.
        await conn.query(
          "INSERT IGNORE INTO hardware_types (id, name, category, created_by) VALUES " + missing.map(() => '(?,?,?,?)').join(','),
          missing.flatMap(([, name]) => [genId('HT'), name, 'Component', user.name || user.username])
        );
        const [rows2] = await conn.query('SELECT name, category FROM hardware_types WHERE LOWER(name) IN (?)', [missing.map(([k]) => k)]);
        rows2.forEach((r) => hwCanonicalByKey.set(String(r.name || '').toLowerCase(), { name: r.name, category: r.category }));
      }
    }

    // ---- Pass 3: resolve matches, run the U-conflict check (same in-order
    // reservation logic as before), assign new component codes sequentially,
    // and build the write tuples - all in memory, in original row order. ----
    const writeRows = [];
    for (const c of candidates) {
      const { row, item, site, hw, hwKey, zone, rackKey, posKey, slotKey, idx } = c;
      const rowErrors = [];

      const hwInfo = hwCanonicalByKey.get(hwKey);
      if (hwInfo && hwInfo.category !== 'Component') {
        results.errors.push({ row, hardwareType: hw, errors: [`"${hwInfo.name}" is a device hardware type, not a rack component type.`] });
        continue;
      }
      const hwType = hwInfo ? hwInfo.name : String(hw).trim();

      const existing = slotKey ? existingBySlot.get(slotKey) : null;
      const matchedId = existing ? existing.id : null;
      const selfOccId = matchedId || `NEW-${idx}`;

      const newU = parseUPos(item.position);
      if (newU && newU.valid && rackKey) {
        const newH = parseHeightU(item.height) || 1;
        const newStart = newU.start;
        const newEnd = Math.max(newU.end, newU.start + newH - 1);
        const clash = occupied.find((o) =>
          o.site === site && o.zone === zone && o.rackNo === rackKey && o.id !== selfOccId &&
          o.u.start <= newEnd && newStart <= Math.max(o.u.end, o.u.start + o.h - 1)
        );
        if (clash) rowErrors.push(`Other asset already available at same U position (${clash.u.start}${clash.h > 1 ? '-' + (clash.u.start + clash.h - 1) : ''}U, ${clash.label || 'occupied'})`);
      }

      if (rowErrors.length) {
        results.errors.push({ row, hardwareType: hw || '(empty)', errors: rowErrors });
        continue;
      }

      if (newU && newU.valid && rackKey) {
        for (let oi = occupied.length - 1; oi >= 0; oi--) { if (occupied[oi].id === selfOccId) occupied.splice(oi, 1); }
        occupied.push({ id: selfOccId, site, zone, rackNo: rackKey, label: matchedId ? existing.component_code : null, u: newU, h: parseHeightU(item.height) || 1 });
      }

      const installDate = normalizeDateInput(item.installationDate);
      const assetTag = item.assetTag && String(item.assetTag).trim() ? String(item.assetTag).trim() : null;
      const remarks = item.remarks && String(item.remarks).trim() ? String(item.remarks).trim() : null;

      if (matchedId) {
        writeRows.push([
          matchedId, existing.component_code, site, zone, item.rackType || null, item.rackNo, item.position || null, hwType,
          item.height || null, item.manufacturer || null, item.model || null, assetTag, installDate, remarks, user.name || user.username,
        ]);
        results.updated++;
      } else {
        const id = genId('RC');
        // Same sequential numbering as the old per-row nextComponentCode(), just computed
        // against the bulk-fetched snapshot (+ codes already handed out earlier in this
        // same batch) instead of a fresh query for every single row.
        const abbr = componentTypeAbbr(hwType);
        const prefix = `${rackKey}-${abbr}-`;
        const rackBucketKey = `${site}|${zone}|${rackKey}`;
        const codes = existingCodesByRack.get(rackBucketKey) || [];
        let maxSeq = 0;
        for (const code of codes) {
          if (String(code || '').toUpperCase().startsWith(prefix.toUpperCase())) {
            const n = parseInt(String(code).slice(prefix.length), 10);
            if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
          }
        }
        const newCode = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`;
        if (!existingCodesByRack.has(rackBucketKey)) existingCodesByRack.set(rackBucketKey, []);
        existingCodesByRack.get(rackBucketKey).push(newCode); // reserve it for later rows in this same batch

        writeRows.push([
          id, newCode, site, zone, item.rackType || null, item.rackNo, item.position || null, hwType,
          item.height || null, item.manufacturer || null, item.model || null, assetTag, installDate, remarks, user.name || user.username,
        ]);
        results.created++;
      }
    }

    // ---- Pass 4: one write for the whole chunk instead of one per row ----
    if (writeRows.length) {
      // component_code is deliberately NOT in the ON DUPLICATE UPDATE clause below - a
      // component's code is fixed at creation and never changes on edit/move/re-import,
      // same as before. As with assets above, updated_by reuses the per-row created_by
      // value (every tuple carries the importing user there); the actual created_by
      // COLUMN is left untouched for updates since it's not referenced in that clause.
      await conn.query(
        `INSERT INTO rack_components
           (id, component_code, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model, asset_tag, installation_date, remarks, created_by)
         VALUES ${writeRows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
         ON DUPLICATE KEY UPDATE
           site=VALUES(site), zone=VALUES(zone), rack_type=VALUES(rack_type), rack_no=VALUES(rack_no), position=VALUES(position),
           hardware_type=VALUES(hardware_type), height=VALUES(height), manufacturer=VALUES(manufacturer), model=VALUES(model),
           asset_tag=VALUES(asset_tag), installation_date=VALUES(installation_date), remarks=VALUES(remarks),
           updated_at=CURRENT_TIMESTAMP, updated_by=VALUES(created_by)`,
        writeRows.flat()
      );
    }

    await conn.commit();
    res.json(results);
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    sendErr(res, e);
  } finally {
    if (conn) conn.release();
  }
});

// Preview next ticket number for a site
app.get('/api/issues/next-ticket', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const validSites = await getAllSiteNames();
    if (!site || !validSites.includes(site)) {
      return res.status(400).json({ error: `Site must be one of: ${validSites.join(', ')}` });
    }
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const ticket = await generateTicketNo(site);
    res.json({ ticketNo: ticket });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== ISSUES ==========
app.get('/api/issues', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);

    let sql = 'SELECT * FROM issues';
    const params = [];
    const conditions = [];

    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?');
      params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    const [rows] = await pool.query(sql, params);
    const toDateTimeStr = (v) => {
      if (!v) return null;
      if (v instanceof Date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${pad(v.getMonth()+1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
      }
      return String(v);
    };
    const mapped = rows.map(r => ({
      id: r.id, ticketNo: r.ticket_no, assetId: r.asset_id, assetType: r.asset_type, site: r.site, zone: r.zone,
      rackNo: r.rack_no, uPosition: r.u_position, locationDetail: r.location_detail, title: r.title,
      description: r.description, severity: r.severity, partRequired: !!r.part_required, partName: r.part_name,
      reportedDate: toDateTimeStr(r.reported_date), diagnosedDate: toDateTimeStr(r.diagnosed_date), receivedDate: toDateTimeStr(r.received_date),
      scheduledDate: toDateTimeStr(r.scheduled_date), completedDate: toDateTimeStr(r.completed_date),
      movedToStoreDate: toDateTimeStr(r.moved_to_store_date), returnedToOemDate: toDateTimeStr(r.returned_to_oem_date), notes: r.notes
    }));
    res.json(mapped);
  } catch (e) {
    sendErr(res, e);
  }
});

const ISSUE_SEVERITIES = ['critical', 'warning', 'info'];
function normalizeSeverity(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'warning';
  const v = String(value).trim().toLowerCase();
  if (!ISSUE_SEVERITIES.includes(v)) {
    const err = new Error(`Invalid severity "${value}". Allowed values: ${ISSUE_SEVERITIES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  return v;
}

app.post('/api/issues', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  let releaseTicketLock = null;
  try {
    const i = normalizeDates(req.body, ISSUE_DATE_FIELDS);
    await assertSiteAccess(req.user, i.site);
    if (!i.title || !String(i.title).trim()) return res.status(400).json({ error: 'Issue title is required' });
    i.severity = normalizeSeverity(i.severity);

    await applyIssueAssetLink(i);
    releaseTicketLock = await acquireTicketLock();
    if (!i.ticketNo || String(i.ticketNo).trim() === '') {
      i.ticketNo = await generateTicketNo(i.site);
    }
    // Auto-capture current datetime for reportedDate if empty
    if (!i.reportedDate) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      i.reportedDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    // Convert empty assetId to null to satisfy FK constraint
    const assetId = (i.assetId && String(i.assetId).trim() !== '') ? String(i.assetId).trim() : null;
    const id = genId('INC');
    await pool.query(
      `INSERT INTO issues (id, ticket_no, asset_id, asset_type, site, zone, rack_no, u_position, location_detail, title, description, severity, part_required, part_name, reported_date, diagnosed_date, received_date, scheduled_date, completed_date, moved_to_store_date, returned_to_oem_date, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, i.ticketNo, assetId, i.assetType, i.site, i.zone || 'AZ-1', i.rackNo, i.uPosition, i.locationDetail, i.title, i.description, i.severity, i.partRequired, i.partName, i.reportedDate, i.diagnosedDate, i.receivedDate, i.scheduledDate, i.completedDate, i.movedToStoreDate, i.returnedToOemDate, i.notes]
    );
    res.json({ id, ...i, assetId: assetId });
  } catch (e) {
    sendErr(res, e);
  } finally {
    if (releaseTicketLock) releaseTicketLock();
  }
});

app.patch('/api/issues/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const i = normalizeDates(req.body, ISSUE_DATE_FIELDS);
    const [existingRows] = await pool.query('SELECT site, asset_id FROM issues WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Issue not found' });
    await assertSiteAccess(req.user, existingRows[0].site);
    await assertSiteAccess(req.user, i.site);
    if (!i.title || !String(i.title).trim()) return res.status(400).json({ error: 'Issue title is required' });
    i.severity = normalizeSeverity(i.severity);
    const keepExistingLink = i.site === existingRows[0].site && String(i.assetId || '').trim() === String(existingRows[0].asset_id || '').trim();
    await applyIssueAssetLink(i, { keepExistingLink });

    await pool.query(
      `UPDATE issues SET ticket_no=?, asset_id=?, asset_type=?, site=?, zone=?, rack_no=?, u_position=?, location_detail=?, title=?, description=?, severity=?, part_required=?, part_name=?, reported_date=?, diagnosed_date=?, received_date=?, scheduled_date=?, completed_date=?, moved_to_store_date=?, returned_to_oem_date=?, notes=? WHERE id=?`,
      [i.ticketNo, i.assetId, i.assetType, i.site, i.zone, i.rackNo, i.uPosition, i.locationDetail, i.title, i.description, i.severity, i.partRequired, i.partName, i.reportedDate, i.diagnosedDate, i.receivedDate, i.scheduledDate, i.completedDate, i.movedToStoreDate, i.returnedToOemDate, i.notes, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/issues/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT site FROM issues WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Issue not found' });
    await assertSiteAccess(req.user, rows[0].site);
    await pool.query('DELETE FROM issues WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== ASSET LIFECYCLE / MOVEMENT HISTORY ==========
const ASSET_LIFECYCLE_ACTIONS = ['Store', 'Transfer / Reuse', 'Decommission', 'RMA / OEM'];
function lifecycleRowToJson(r) {
  return {
    id: r.id, site: r.site, zone: r.zone, rackNo: r.rack_no, position: r.position,
    serialNumber: r.serial_number, assetTag: r.asset_tag, deviceName: r.device_name,
    manufacturer: r.manufacturer, model: r.model, hardwareType: r.hardware_type,
    installationDate: dateOnlyStr(r.installation_date),
    lifecycleStatus: r.lifecycle_status || 'Active', custodyLocation: r.custody_location || null,
    lastKnownSite: r.last_known_site || null, lastKnownZone: r.last_known_zone || null,
    lastKnownRack: r.last_known_rack || null, lastKnownPosition: r.last_known_position || null,
    lastMovementAt: r.last_movement_at || null, lastMovementReason: r.last_movement_reason || null,
    latestMovementType: r.latest_movement_type || null, latestMovementDate: r.latest_movement_date || null,
    latestFromSite: r.latest_from_site || null, latestToSite: r.latest_to_site || null,
    latestReason: r.latest_reason || null, latestReferenceNo: r.latest_reference_no || null,
    reused: !!r.reused,
  };
}

app.get('/api/asset-lifecycle', authenticateToken, async (req, res) => {
  try {
    const allowed = await getAllowedSitesForUser(req.user);
    const conditions = [];
    const params = [];
    await applySiteScope(allowed, conditions, params);
    if (req.query.status && req.query.status !== 'all') { conditions.push('a.lifecycle_status = ?'); params.push(req.query.status); }
    if (req.query.site && req.query.site !== 'all') {
      if (!allowed.includes(req.query.site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('a.site = ?'); params.push(req.query.site);
    }
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      conditions.push('(a.serial_number LIKE ? OR a.asset_tag LIKE ? OR a.device_name LIKE ? OR a.model LIKE ? OR a.manufacturer LIKE ? OR a.site LIKE ?)');
      params.push(q,q,q,q,q,q);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `
      SELECT a.*,
        lm.movement_type AS latest_movement_type, lm.movement_date AS latest_movement_date,
        lm.from_site AS latest_from_site, lm.to_site AS latest_to_site,
        lm.reason AS latest_reason, lm.reference_no AS latest_reference_no,
        EXISTS(
          SELECT 1 FROM asset_movements rm
          WHERE rm.asset_id = a.id AND rm.movement_type = 'Inter-DC Transfer' AND COALESCE(rm.from_site,'') <> COALESCE(rm.to_site,'')
        ) AS reused
      FROM assets a
      LEFT JOIN asset_movements lm ON lm.id = (
        SELECT m2.id FROM asset_movements m2 WHERE m2.asset_id = a.id ORDER BY m2.movement_date DESC, m2.created_at DESC LIMIT 1
      )
      ${where}
      ORDER BY CASE a.lifecycle_status WHEN 'Active' THEN 0 WHEN 'In Store' THEN 1 WHEN 'Transferred' THEN 2 WHEN 'RMA / OEM' THEN 3 WHEN 'Decommissioned' THEN 4 ELSE 5 END, a.site, a.serial_number`;
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(lifecycleRowToJson));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/assets/:id/lifecycle-history', authenticateToken, async (req, res) => {
  try {
    const [assetRows] = await pool.query('SELECT id, site FROM assets WHERE id = ?', [req.params.id]);
    if (!assetRows.length) return res.status(404).json({ error: 'Asset not found' });
    await assertSiteAccess(req.user, assetRows[0].site);
    const [rows] = await pool.query(`SELECT id, asset_id, serial_number, movement_type, from_site, from_zone, from_rack_no, from_position, to_site, to_zone, to_rack_no, to_position, movement_date, reason, reference_no, performed_by, remarks, created_at FROM asset_movements WHERE asset_id = ? ORDER BY movement_date DESC, created_at DESC`, [req.params.id]);
    res.json(rows.map(r => ({
      id:r.id, assetId:r.asset_id, serialNumber:r.serial_number, movementType:r.movement_type,
      fromSite:r.from_site, fromZone:r.from_zone, fromRackNo:r.from_rack_no, fromPosition:r.from_position,
      toSite:r.to_site, toZone:r.to_zone, toRackNo:r.to_rack_no, toPosition:r.to_position,
      movementDate:r.movement_date, reason:r.reason, referenceNo:r.reference_no, performedBy:r.performed_by, remarks:r.remarks, createdAt:r.created_at
    })));
  } catch (e) { sendErr(res, e); }
});

// List active DC destinations by name only. A source-site engineer is allowed
// to initiate an inter-DC transfer to another active DC, even when they are not
// scoped to that destination. They do not receive access to the destination DC's
// operational data; the receiving engineer owns the later install step.
app.get('/api/asset-lifecycle/destinations', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM locations WHERE status='Active' ORDER BY name");
    res.json(rows.map(r => ({ id: r.id, name: r.name })));
  } catch (e) { sendErr(res, e); }
});

// Serial-number lookup for lifecycle tracking. Asset Tag is optional everywhere;
// serial number is the durable identity used for movement history.
app.get('/api/asset-lifecycle/by-serial/:serial/history', authenticateToken, async (req, res) => {
  try {
    const serial = String(req.params.serial || '').trim();
    if (!serial) return res.status(400).json({ error: 'Serial number is required.' });
    const [assetRows] = await pool.query('SELECT * FROM assets WHERE serial_number = ? LIMIT 1', [serial]);
    if (!assetRows.length) return res.status(404).json({ error: `No asset found for serial number ${serial}.` });
    await assertSiteAccess(req.user, assetRows[0].site);
    const [historyRows] = await pool.query(`SELECT id, asset_id, serial_number, movement_type, from_site, from_zone, from_rack_no, from_position, to_site, to_zone, to_rack_no, to_position, movement_date, reason, reference_no, performed_by, remarks, created_at FROM asset_movements WHERE serial_number = ? ORDER BY movement_date DESC, created_at DESC`, [serial]);
    const a = assetRows[0];
    res.json({
      asset: lifecycleRowToJson(a),
      history: historyRows.map(r => ({
        id:r.id, assetId:r.asset_id, serialNumber:r.serial_number, movementType:r.movement_type,
        fromSite:r.from_site, fromZone:r.from_zone, fromRackNo:r.from_rack_no, fromPosition:r.from_position,
        toSite:r.to_site, toZone:r.to_zone, toRackNo:r.to_rack_no, toPosition:r.to_position,
        movementDate:r.movement_date, reason:r.reason, referenceNo:r.reference_no, performedBy:r.performed_by, remarks:r.remarks, createdAt:r.created_at
      }))
    });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/assets/:id/lifecycle', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    // The row lock taken by SELECT ... FOR UPDATE below only holds inside a transaction - open it first so two simultaneous actions on one asset serialize.
    await conn.beginTransaction();
    const action = String(req.body?.action || '').trim();
    const allowedActions = ['Store', 'Move Out / External', 'Transfer / Reuse', 'Receive & Install', 'Accept & Move To Store', 'Install from Store', 'Refuse / Return to Source', 'Decommission', 'RMA / OEM'];
    if (!allowedActions.includes(action)) return res.status(400).json({ error: `Invalid lifecycle action. Use: ${allowedActions.join(', ')}` });

    const [rows] = await conn.query('SELECT id, site, zone, rack_no, position, height, serial_number, asset_tag, device_name, lifecycle_status, custody_location FROM assets WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Asset not found' });
    const asset = rows[0];
    if (!asset.serial_number || !String(asset.serial_number).trim()) {
      return res.status(400).json({ error: 'Lifecycle tracking requires a Serial Number. Asset Tag is optional.' });
    }

    await assertSiteAccess(req.user, asset.site);
    const movementDate = normalizeDateInput(req.body.movementDate) || localTodayStr();
    const dateTime = `${movementDate} ${new Date().toTimeString().slice(0,8)}`;
    const reason = String(req.body.reason || '').trim() || null;
    const installFromStore = action === 'Install from Store';
    const referenceNo = String(req.body.referenceNo || '').trim() || null;
    const remarks = String(req.body.remarks || '').trim() || null;
    const from = { site: asset.site, zone: asset.zone || null, rackNo: asset.rack_no || null, position: asset.position || null };
    let status = asset.lifecycle_status || 'Active';
    let to = { site: null, zone: null, rackNo: null, position: null };
    let custody = null;
    let movementType = action;
    let receivePrevious = null;
    let receiveHeightUnits = null;
    let pendingDestinationRack = null;
    let destinationRackMeta = null;

    if (action === 'Store') {
      status = 'In Store';
      custody = String(req.body.custodyLocation || '').trim() || `${asset.site} Store`;
      movementType = 'Store';
    } else if (action === 'Move Out / External') {
      const destinationType = String(req.body.destinationType || '').trim();
      const destinationName = String(req.body.destinationName || '').trim();
      if (!destinationType) return res.status(400).json({ error: 'Destination type is required.' });
      if (!destinationName) return res.status(400).json({ error: 'Destination name is required.' });
      status = 'Moved Out / External';
      custody = `${destinationType}: ${destinationName}`;
      movementType = 'External Move Out';
    } else if (action === 'Decommission') {
      status = 'Decommissioned';
      custody = 'Decommissioned';
      movementType = 'Decommission';
    } else if (action === 'RMA / OEM') {
      status = 'RMA / OEM';
      custody = String(req.body.custodyLocation || '').trim() || 'OEM / Vendor';
      movementType = 'RMA / OEM';
    } else if (action === 'Transfer / Reuse') {
      const destinationSite = String(req.body.destinationSite || '').trim();
      if (!destinationSite) return res.status(400).json({ error: 'Destination DC is required.' });
      if (destinationSite === asset.site) return res.status(400).json({ error: 'Transfer / Reuse is for another DC. Use the normal rack/asset edit flow for the same DC.' });
      const [destRows] = await conn.query("SELECT name FROM locations WHERE status='Active' AND name = ? LIMIT 1", [destinationSite]);
      if (!destRows.length) return res.status(400).json({ error: `Destination DC "${destinationSite}" is not an active location.` });
      // Source engineer's responsibility ends here. Do NOT require destination access
      // and do NOT ask the source engineer for destination rack/U details.
      status = 'Transferred';
      custody = `Awaiting acceptance at ${destinationSite}`;
      movementType = 'Inter-DC Transfer';
      to = { site: destinationSite, zone: null, rackNo: null, position: null };
    } else if (action === 'Accept & Move To Store') {
      // Destination DC accepts the transfer but does not rack it yet: the asset stays in the destination
      // DC's inventory as In Store, with no zone / rack / U (so it is not counted in rack capacity or elevation).
      if (asset.lifecycle_status !== 'Transferred') return res.status(400).json({ error: 'Only an asset in Transferred status can be accepted into the store.' });
      status = 'In Store';
      custody = String(req.body.custodyLocation || '').trim().slice(0, 255) || `${asset.site} Store`;
      movementType = 'Store';
    } else if (action === 'Refuse / Return to Source') {
      if (asset.lifecycle_status !== 'Transferred') return res.status(400).json({ error: 'Only an asset in Transferred status can be refused and returned to source.' });
      const [transferRows] = await conn.query(
        `SELECT from_site, from_zone, from_rack_no, from_position, to_site
           FROM asset_movements
          WHERE asset_id = ? AND movement_type = 'Inter-DC Transfer'
          ORDER BY movement_date DESC, created_at DESC LIMIT 1`,
        [asset.id]
      );
      const priorTransfer = transferRows[0];
      if (!priorTransfer || !priorTransfer.from_site) return res.status(400).json({ error: 'Original source DC could not be identified for this transfer.' });
      status = 'Transfer Refused';
      custody = `Returned to ${priorTransfer.from_site} — awaiting source handling`;
      movementType = 'Inter-DC Transfer Refused';
      to = { site: priorTransfer.from_site, zone: null, rackNo: null, position: null };
    } else if (action === 'Receive & Install' || installFromStore) {
      if (installFromStore) {
        if (asset.lifecycle_status !== 'In Store') return res.status(400).json({ error: 'Only an asset in In Store status can be installed from Store.' });
        if (String(req.body.destinationSite || asset.site).trim() !== String(asset.site).trim()) return res.status(400).json({ error: 'Install from Store is for the store-owning DC. Use Transfer / Reuse when another DC will receive the asset.' });
      } else if (!['Transferred','Transfer Refused'].includes(asset.lifecycle_status)) {
        return res.status(400).json({ error: 'Only an asset in Transferred or Transfer Refused status can be received and installed.' });
      }
      await assertSiteAccess(req.user, asset.site);
      const destinationZone = String(req.body.destinationZone || '').trim();
      const destinationRack = String(req.body.destinationRackNo || '').trim();
      const destinationPositionRaw = String(req.body.destinationPosition || '').trim();
      if (!destinationZone) return res.status(400).json({ error: 'Destination zone is required for installation.' });
      if (!destinationRack) return res.status(400).json({ error: 'Destination rack is required for installation.' });
      if (!destinationPositionRaw) return res.status(400).json({ error: 'Destination U position is required for installation.' });
      if (!asset.height || !String(asset.height).trim()) return res.status(400).json({ error: 'Asset height is missing. Update the source asset height before installing at the destination DC.' });

      // Physical chassis height is immutable during an inter-DC transfer.
      // The receiving engineer supplies the complete start-end U range;
      // the server validates that its span exactly matches the source asset height.
      receiveHeightUnits = parseHeightU(asset.height);
      if (!Number.isInteger(receiveHeightUnits) || receiveHeightUnits < 1) {
        return res.status(400).json({ error: `Invalid source asset height "${asset.height}". A valid U height is required before installation.` });
      }
      const parsedDest = parseUPosLoose(destinationPositionRaw);
      if (!parsedDest || parsedDest.start < 1) {
        return res.status(400).json({ error: 'Invalid destination U position. Use the same format as Add Asset, for example 1U or 1-2U.' });
      }
      const explicitRange = /^U?\s*\d+\s*U?\s*-\s*U?\s*\d+\s*U?$/i.test(destinationPositionRaw);
      const explicitSpan = parsedDest.end - parsedDest.start + 1;
      // For multi-U assets the receiving engineer must enter the complete start-end range,
      // exactly as it is recorded in Add Asset (e.g. 1-2U for a 2U device).
      if (receiveHeightUnits > 1 && !explicitRange) {
        return res.status(400).json({ error: `This asset is ${receiveHeightUnits}U. Enter the complete destination U range, for example 1-${receiveHeightUnits}U.` });
      }
      if (explicitSpan !== receiveHeightUnits) {
        return res.status(400).json({ error: `This asset is ${receiveHeightUnits}U. Destination position must occupy exactly ${receiveHeightUnits}U.` });
      }
      const normalizedDestinationPosition = receiveHeightUnits === 1
        ? `${parsedDest.start}U`
        : `${parsedDest.start}-${parsedDest.end}U`;

      // Preserve the true previous installed location. For an inter-DC transfer
      // use the original transfer row; for a Store-held asset use last_known_* so
      // a never-installed asset correctly has no fake previous rack/location.
      if (installFromStore) {
        receivePrevious = {
          site: asset.last_known_site || null,
          zone: asset.last_known_zone || null,
          rackNo: asset.last_known_rack || null,
          position: asset.last_known_position || null,
        };
      } else {
        const [transferRows] = await conn.query(
          `SELECT from_site, from_zone, from_rack_no, from_position
             FROM asset_movements
            WHERE asset_id = ? AND movement_type = 'Inter-DC Transfer'
            ORDER BY movement_date DESC, created_at DESC LIMIT 1`,
          [asset.id]
        );
        const prior = transferRows[0] || {};
        receivePrevious = {
          site: prior.from_site || asset.last_known_site || null,
          zone: prior.from_zone || asset.last_known_zone || null,
          rackNo: prior.from_rack_no || asset.last_known_rack || null,
          position: prior.from_position || asset.last_known_position || null,
        };
      }

      // Destination rack is independent of the source rack type. If a planned rack exists,
      // use its authoritative type/dimensions. Otherwise a new planned rack may be created
      // atomically as part of Receive & Install using the same physical-size model as Add Rack.
      const [destRackRows] = await conn.query(
        'SELECT id, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm FROM racks WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?)) LIMIT 1',
        [asset.site, destinationZone, destinationRack]
      );
      const destinationRackExists = destRackRows.length > 0;
      if (!destinationRackExists && !req.body.createDestinationRack) return res.status(400).json({ error: `Destination rack "${destinationRack}" does not exist in ${asset.site} / ${destinationZone}. Select an existing rack or enable new rack creation.` });
      destinationRackMeta = destinationRackExists ? destRackRows[0] : null;
      if (!destinationRackExists) {
        if (!req.body.createDestinationRack) return res.status(400).json({ error: `Destination rack "${destinationRack}" does not exist in ${asset.site} / ${destinationZone}. Select an existing rack or enable new rack creation.` });
        const rt = String(req.body.destinationRackType || '').trim();
        const uCap = parseInt(req.body.destinationRackUSize, 10) > 0 ? parseInt(req.body.destinationRackUSize, 10) : 42;
        const wmm = parseInt(req.body.destinationRackWmm, 10) > 0 ? parseInt(req.body.destinationRackWmm, 10) : 600;
        const dmm = parseInt(req.body.destinationRackDmm, 10) > 0 ? parseInt(req.body.destinationRackDmm, 10) : 1200;
        const wt = parseFloat(req.body.destinationRackWTiles) > 0 ? parseFloat(req.body.destinationRackWTiles) : Math.round((wmm / 600) * 100) / 100;
        const ht = parseFloat(req.body.destinationRackHTiles) > 0 ? parseFloat(req.body.destinationRackHTiles) : Math.round((dmm / 600) * 100) / 100;
        if (!rt) return res.status(400).json({ error: 'Destination rack type is required when creating a new rack.' });
        if (['Pillar','Empty Space'].includes(rt)) return res.status(400).json({ error: `Rack type "${rt}" is structural and cannot receive an asset.` });
        if (wmm < 100 || dmm < 100 || wt < 0.5 || ht < 0.5) return res.status(400).json({ error: 'Destination rack physical dimensions are invalid.' });
        if (uCap < parsedDest.end) return res.status(400).json({ error: `New destination rack has only ${uCap}U capacity; the selected U range ends at U${parsedDest.end}.` });
        pendingDestinationRack = { id: genId('RK'), site: asset.site, zone: destinationZone, rackNo: destinationRack, rackType: rt, uSize:uCap, wTiles:wt, hTiles:ht, wMm:wmm, dMm:dmm };
        destinationRackMeta = { id: pendingDestinationRack.id, rack_type:rt, u_size:uCap, w_tiles:wt, h_tiles:ht, width_mm:wmm, depth_mm:dmm };
      }
      const destinationRackType = destinationRackMeta?.rack_type || null;
      const rackCapacity = Number(destinationRackMeta?.u_size || 42);
      if (parsedDest.end > rackCapacity) return res.status(400).json({ error: `Destination rack has only ${rackCapacity}U capacity; the selected U range ends at U${parsedDest.end}.` });
      if (destinationRackType && ['Pillar','Empty Space'].includes(String(destinationRackType))) return res.status(400).json({ error: `Rack type "${destinationRackType}" is structural and cannot receive an asset.` });
      to = { site: asset.site, zone: destinationZone, rackNo: destinationRack, position: normalizedDestinationPosition };
      status = 'Active';
      custody = null;
      movementType = installFromStore ? 'Store / Install' : 'Receive / Install';
      const conflict = await findUConflict(to.site, to.zone, to.rackNo, to.position, `${receiveHeightUnits}U`, asset.id);
      if (conflict) return res.status(409).json({ error: 'Another asset already occupies the destination U position.', conflict });
      receivePrevious = { ...(receivePrevious || {}), rackType: destinationRackType };
    }

    try {
      if ((action === 'Receive & Install' || installFromStore) && pendingDestinationRack) {
        try {
          await conn.query('INSERT INTO racks (id, site, zone, rack_no, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [pendingDestinationRack.id, pendingDestinationRack.site, pendingDestinationRack.zone, pendingDestinationRack.rackNo, pendingDestinationRack.rackType, pendingDestinationRack.uSize, pendingDestinationRack.wTiles, pendingDestinationRack.hTiles, pendingDestinationRack.wMm, pendingDestinationRack.dMm, req.user.name || req.user.username]);
        } catch (e) {
          if (e.code === 'ER_DUP_ENTRY') {
            const [fresh] = await conn.query('SELECT id, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm FROM racks WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?)) LIMIT 1', [pendingDestinationRack.site, pendingDestinationRack.zone, pendingDestinationRack.rackNo]);
            if (!fresh.length) throw e;
            destinationRackMeta = fresh[0];
          } else throw e;
        }
        try { await conn.query('INSERT IGNORE INTO rack_types (id, name, created_by) VALUES (?,?,?)', [genId('RT'), pendingDestinationRack.rackType, req.user.name || req.user.username]); } catch (e) { /* best effort */ }
      }
      const updates = [
        'lifecycle_status = ?', 'custody_location = ?'
      ];
      const values = [status, custody];
      if (action === 'Receive & Install' || installFromStore) {
        updates.push('last_known_site = ?', 'last_known_zone = ?', 'last_known_rack = ?', 'last_known_position = ?');
        values.push(receivePrevious?.site || null, receivePrevious?.zone || null, receivePrevious?.rackNo || null, receivePrevious?.position || null);
      } else if (action === 'Refuse / Return to Source' || action === 'Accept & Move To Store') {
        // Keep the previous installed location as the audit location; the movement row records the refusal/return / acceptance.
      } else {
        updates.push('last_known_site = ?', 'last_known_zone = ?', 'last_known_rack = ?', 'last_known_position = ?');
        values.push(from.site, from.zone, from.rackNo, from.position);
      }
      updates.push('last_movement_at = ?', 'last_movement_reason = ?', 'updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
      values.push(dateTime, reason, req.user.name || req.user.username);

      if (action === 'Transfer / Reuse') {
        updates.push('site = ?', 'zone = NULL', 'rack_no = NULL', 'position = NULL');
        values.push(to.site);
      } else if (action === 'Refuse / Return to Source') {
        updates.push('site = ?', 'zone = NULL', 'rack_no = NULL', 'position = NULL');
        values.push(to.site);
      } else if (action === 'Receive & Install' || installFromStore) {
        updates.push('zone = ?', 'rack_no = ?', 'position = ?', 'rack_type = ?');
        values.push(to.zone, to.rackNo, to.position, receivePrevious?.rackType || asset.rack_type || null);
        // A newly received-to-store asset did not have an installation date;
        // the first physical installation establishes it. Existing installed
        // assets retain their original installation date.
        updates.push('installation_date = COALESCE(installation_date, ?)');
        values.push(movementDate);
      } else {
        updates.push('zone = NULL', 'rack_no = NULL', 'position = NULL');
      }
      updates.push('changed_fields = ?');
      values.push(`Lifecycle: ${action}`);
      values.push(asset.id);
      await conn.query(`UPDATE assets SET ${updates.join(', ')} WHERE id = ?`, values);

      // Destination acceptance is recorded as its own history entry (Transferred -> Accepted -> Store / Install).
      // It is written one second earlier than the action row so the history always reads in the right order.
      if (asset.lifecycle_status === 'Transferred' && (action === 'Accept & Move To Store' || action === 'Receive & Install')) {
        const [accSrc] = await conn.query(
          `SELECT from_site, from_zone, from_rack_no, from_position FROM asset_movements
            WHERE asset_id = ? AND movement_type = 'Inter-DC Transfer' ORDER BY movement_date DESC, created_at DESC LIMIT 1`, [asset.id]);
        const src = accSrc[0] || {};
        await conn.query(`INSERT INTO asset_movements (id, asset_id, serial_number, movement_type, from_site, from_zone, from_rack_no, from_position, to_site, to_zone, to_rack_no, to_position, movement_date, reason, reference_no, performed_by, remarks, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, DATE_SUB(NOW(), INTERVAL 1 SECOND))`, [
          genId('AMV'), asset.id, asset.serial_number, 'Transfer Accepted',
          src.from_site || null, src.from_zone || null, src.from_rack_no || null, src.from_position || null,
          asset.site, null, null, null, dateTime, `Accepted by ${asset.site}`, referenceNo, req.user.name || req.user.username, null
        ]);
      }
      const movementId = genId('AMV');
      await conn.query(`INSERT INTO asset_movements (id, asset_id, serial_number, movement_type, from_site, from_zone, from_rack_no, from_position, to_site, to_zone, to_rack_no, to_position, movement_date, reason, reference_no, performed_by, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        movementId, asset.id, asset.serial_number,
        movementType,
        from.site, from.zone, from.rackNo, from.position,
        to.site, to.zone, to.rackNo, to.position,
        dateTime, reason, referenceNo, req.user.name || req.user.username, remarks
      ]);
      await conn.commit();

      // Do not move an issue to the destination DC merely because a source engineer
      // dispatched the asset. The source engineer's operational responsibility ends
      // at handover; the receiving DC becomes authoritative only after Receive & Install.
      // External/Store/RMA/Decommission also retain their original issue location as audit history.
      if (action === 'Receive & Install' || installFromStore) {
        await syncIssuesForAsset(pool, asset.serial_number, { serial: asset.serial_number, site: to.site, zone: to.zone, rackNo: to.rackNo, position: to.position });
      }

      res.json({ success:true, assetId:asset.id, serialNumber:asset.serial_number, lifecycleStatus:status, movementId, from, to, reused: action === 'Receive & Install' || (action === 'Transfer / Reuse' && from.site !== to.site) });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      throw e;
    }
  } catch (e) { sendErr(res, e); }
  finally { if (conn) { await conn.rollback().catch(() => {}); conn.release(); } } // no-op after commit; frees the lock on early returns
});

// Read-only overview for the destination-acceptance workflow: the Pending Transfer Acceptance queue, Store Inventory and
// rejected transfers, each with the source DC and transfer / accepted / rejected dates taken from the movement history.
// Site scoped like every other list: destination users see what is waiting for them, source users see their own outgoing
// transfers as view-only, global admins see everything.
const TRANSFER_META_SQL = `
  SELECT a.id, a.site, a.serial_number, a.asset_tag, a.device_name, a.manufacturer, a.model, a.hardware_type, a.height,
         a.lifecycle_status, a.custody_location, a.last_movement_at,
         (SELECT t.from_site FROM asset_movements t WHERE t.asset_id = a.id AND t.movement_type = 'Inter-DC Transfer' ORDER BY t.movement_date DESC, t.created_at DESC LIMIT 1) AS src_site,
         (SELECT t.movement_date FROM asset_movements t WHERE t.asset_id = a.id AND t.movement_type = 'Inter-DC Transfer' ORDER BY t.movement_date DESC, t.created_at DESC LIMIT 1) AS transfer_date,
         (SELECT t.performed_by FROM asset_movements t WHERE t.asset_id = a.id AND t.movement_type = 'Inter-DC Transfer' ORDER BY t.movement_date DESC, t.created_at DESC LIMIT 1) AS transfer_by,
         (SELECT c.movement_date FROM asset_movements c WHERE c.asset_id = a.id AND c.movement_type = 'Transfer Accepted' ORDER BY c.movement_date DESC, c.created_at DESC LIMIT 1) AS accepted_date,
         (SELECT r.movement_date FROM asset_movements r WHERE r.asset_id = a.id AND r.movement_type = 'Inter-DC Transfer Refused' ORDER BY r.movement_date DESC, r.created_at DESC LIMIT 1) AS rejected_date,
         (SELECT r.from_site FROM asset_movements r WHERE r.asset_id = a.id AND r.movement_type = 'Inter-DC Transfer Refused' ORDER BY r.movement_date DESC, r.created_at DESC LIMIT 1) AS rejected_by
    FROM assets a WHERE a.lifecycle_status = ?`;
function transferMetaToJson(r) {
  return {
    id: r.id, site: r.site, serialNumber: r.serial_number, assetTag: r.asset_tag, deviceName: r.device_name,
    manufacturer: r.manufacturer, model: r.model, hardwareType: r.hardware_type, height: r.height,
    lifecycleStatus: r.lifecycle_status, custodyLocation: r.custody_location || null,
    sourceSite: r.src_site || null, transferDate: r.transfer_date || null, transferBy: r.transfer_by || null,
    acceptedDate: r.accepted_date || null, rejectedDate: r.rejected_date || null, rejectedBy: r.rejected_by || null,
  };
}
app.get('/api/transfers/overview', authenticateToken, async (req, res) => {
  try {
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.length) return res.json({ incoming: [], outgoing: [], store: [], rejected: [] });
    const inSet = (col) => `${col} IN (${allowed.map(() => '?').join(',')})`;
    const [inc] = await pool.query(`${TRANSFER_META_SQL} AND ${inSet('a.site')} ORDER BY a.last_movement_at DESC LIMIT 2000`, ['Transferred', ...allowed]);
    const [out] = await pool.query(`SELECT * FROM (${TRANSFER_META_SQL}) x WHERE NOT (${inSet('x.site')}) AND ${inSet('x.src_site')} ORDER BY x.last_movement_at DESC LIMIT 2000`, ['Transferred', ...allowed, ...allowed]);
    const [store] = await pool.query(`${TRANSFER_META_SQL} AND ${inSet('a.site')} ORDER BY a.site, a.serial_number LIMIT 5000`, ['In Store', ...allowed]);
    const [rej] = await pool.query(`SELECT * FROM (${TRANSFER_META_SQL}) x WHERE ${inSet('x.site')} OR ${inSet('x.rejected_by')} ORDER BY x.last_movement_at DESC LIMIT 2000`, ['Transfer Refused', ...allowed, ...allowed]);
    res.json({ incoming: inc.map(transferMetaToJson), outgoing: out.map(transferMetaToJson), store: store.map(transferMetaToJson), rejected: rej.map(transferMetaToJson) });
  } catch (e) { sendErr(res, e); }
});

// Correct a lifecycle log entry that was saved with a wrong date or wrong free-text details.
// Only descriptive fields can be changed (date/time, reason, reference no, remarks and, for the
// newest Store / RMA entry, the custody location). Where the asset physically is (site / rack / U)
// is never changed from here - use a new lifecycle action for that.
app.patch('/api/asset-movements/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [mvRows] = await conn.query('SELECT * FROM asset_movements WHERE id = ?', [req.params.id]);
    if (!mvRows.length) return res.status(404).json({ error: 'Lifecycle entry not found' });
    const mv = mvRows[0];
    const [assetRows] = await conn.query('SELECT id, site, lifecycle_status, custody_location, installation_date FROM assets WHERE id = ?', [mv.asset_id]);
    const asset = assetRows[0] || null;
    // The engineer must have access to the DC the asset is in now, or the DC it was moved from.
    let allowedOk = false;
    for (const site of [asset && asset.site, mv.from_site]) {
      if (!site) continue;
      try { await assertSiteAccess(req.user, site); allowedOk = true; break; } catch (e) { /* try next */ }
    }
    if (!allowedOk) return res.status(403).json({ error: 'Access denied for this asset\'s location' });

    const b = req.body || {};
    const m = String(b.movementDate || '').trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return res.status(400).json({ error: 'Enter a valid date and time.' });
    const dateOnly = m[1];
    const chk = new Date(`${dateOnly}T00:00:00`);
    if (isNaN(chk.getTime()) || `${chk.getFullYear()}-${String(chk.getMonth() + 1).padStart(2, '0')}-${String(chk.getDate()).padStart(2, '0')}` !== dateOnly) return res.status(400).json({ error: 'Enter a valid date.' });
    const hh = m[2] !== undefined ? m[2] : String(mv.movement_date instanceof Date ? mv.movement_date.getHours() : 0).padStart(2, '0');
    const mi = m[3] !== undefined ? m[3] : String(mv.movement_date instanceof Date ? mv.movement_date.getMinutes() : 0).padStart(2, '0');
    const ss = m[4] !== undefined ? m[4] : '00';
    const newDateTime = `${dateOnly} ${hh}:${mi}:${ss}`;
    const reason = String(b.reason || '').trim().slice(0, 255) || null;
    const referenceNo = String(b.referenceNo || '').trim().slice(0, 100) || null;
    const remarks = String(b.remarks || '').trim() || null;

    await conn.beginTransaction();
    try {
      await conn.query('UPDATE asset_movements SET movement_date=?, reason=?, reference_no=?, remarks=? WHERE id=?', [newDateTime, reason, referenceNo, remarks, mv.id]);
      if (asset) {
        const [latest] = await conn.query('SELECT id FROM asset_movements WHERE asset_id = ? ORDER BY movement_date DESC, created_at DESC LIMIT 1', [mv.asset_id]);
        const isLatest = latest.length && latest[0].id === mv.id;
        const sets = [];
        const vals = [];
        if (isLatest) {
          sets.push('last_movement_at = ?', 'last_movement_reason = ?');
          vals.push(newDateTime, reason);
          const custody = String(b.custodyLocation || '').trim();
          if (custody && ['In Store', 'RMA / OEM'].includes(asset.lifecycle_status) && ['Store', 'RMA / OEM'].includes(mv.movement_type)) {
            sets.push('custody_location = ?');
            vals.push(custody.slice(0, 255));
          }
        }
        // The first install from Store / transfer sets the installation date - keep it in step with the corrected date.
        if (['Receive / Install', 'Store / Install'].includes(mv.movement_type) && asset.installation_date) {
          const oldDay = normalizeDateInput(mv.movement_date);
          if (normalizeDateInput(asset.installation_date) === oldDay) { sets.push('installation_date = ?'); vals.push(dateOnly); }
        }
        if (sets.length) {
          sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?', 'changed_fields = ?');
          vals.push(req.user.name || req.user.username, 'Lifecycle entry corrected');
          vals.push(asset.id);
          await conn.query(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, vals);
        }
      }
      await conn.commit();
    } catch (e) { if (conn) await conn.rollback().catch(() => {}); throw e; }
    res.json({ success: true });
  } catch (e) { sendErr(res, e); }
  finally { if (conn) conn.release(); }
});

// ========== OCR-ASSISTED MATERIAL MOVEMENT CAPTURE (assistive only) ==========
// Reads a DC copy / delivery challan / invoice / POD / GRN / shipment document and returns the values it finds, so the user
// has less to type. It NEVER creates, changes or deletes anything: no asset, location, lifecycle, transfer or movement record is
// touched here. The file and the recognised text are processed in memory only and are not stored; the user still reviews the
// values and saves the Material Movement through the normal form. Turn off with OCR_ENABLED=off (the button then disappears).
let ocrEngine = null;
try { ocrEngine = require('./ocr/ocr-engine'); } catch (e) { log.warn('[ocr] OCR engine not loaded - Material Movement works as before without it:', e.message); }
const OCR_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);
const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const problem = uploadNameProblem(file.originalname, file.mimetype);
    if (problem) return cb(uploadError(problem));
    if (!OCR_EXTS.has(path.extname(String(file.originalname || '')).toLowerCase())) return cb(uploadError('OCR supports PDF, JPG, JPEG, PNG and WEBP files only.'));
    cb(null, true);
  },
});
app.get('/api/ocr/status', authenticateToken, (req, res) => {
  const st = ocrEngine ? ocrEngine.status() : { enabled: false, documentTypes: [] };
  res.json({ enabled: !!st.enabled, documentTypes: st.documentTypes, ...(req.user && req.user.role === 'Admin' ? { engineRunning: !!st.engineRunning, stats: st.stats } : {}) });
});
app.post('/api/ocr/extract', authenticateToken, requireRole(['Admin', 'Operator']), ocrUpload.single('file'), async (req, res) => {
  try {
    if (!ocrEngine || !ocrEngine.isAvailable()) return res.status(503).json({ ok: false, error: 'Document reading is not available on this server. Please continue with manual entry.' });
    const f = req.file; if (!f || !f.buffer || !f.buffer.length) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const ext = path.extname(String(f.originalname || '')).toLowerCase();
    const t = UPLOAD_TYPES[ext];
    if (!t || f.buffer.length < 4 || !t.sig(f.buffer.slice(0, 16))) return res.status(400).json({ ok: false, error: `The content of "${sanitizeUploadName(f.originalname)}" does not match its ${ext} file type.` });
    const r = await ocrEngine.extract({ buffer: f.buffer, ext });
    const n = r.ok ? Object.keys(r.fields || {}).length : 0;
    auditLog(req, 'OCR_EXTRACT', { entity: 'ocr', status: r.ok ? 'success' : 'failure', details: { ocrUsed: 'Yes', documentUploaded: sanitizeUploadName(f.originalname), fileType: ext, sizeKB: Math.round(f.buffer.length / 1024), documentType: r.ok ? r.documentType.id : null, fieldsFound: n, serialsFound: r.ok ? r.serialNumbers.length : 0, ms: r.ms || null } });
    if (r.busy) return res.status(429).json(r);
    res.json(r);
  } catch (e) { sendErr(res, e); }
});
// Written after the user has reviewed the OCR values and saved the Material Movement through the normal form. Audit entry only.
app.post('/api/ocr/confirm', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const b = req.body || {};
    const [rows] = await pool.query('SELECT id, site FROM material_movements WHERE id = ?', [String(b.movementId || '')]);
    if (!rows.length) return res.status(404).json({ error: 'Material movement record not found' });
    await assertSiteAccess(req.user, rows[0].site);
    const num = (v) => Math.max(0, Math.min(999, parseInt(v, 10) || 0));
    auditLog(req, 'OCR_MOVEMENT_SAVED', { entity: 'material_movement', entityId: rows[0].id, site: rows[0].site, status: 'success', details: { ocrUsed: 'Yes', userReviewedOcr: 'Yes', userSavedRecord: 'Yes', documentUploaded: (Array.isArray(b.fileNames) && b.fileNames.length ? b.fileNames.slice(0, 5).map((n) => sanitizeUploadName(String(n || '')) || '').filter(Boolean).join(', ') : sanitizeUploadName(b.fileName || '')) || null, documentCount: Math.max(1, Math.min(5, parseInt(b.fileCount, 10) || 1)), documentAttached: b.documentAttached ? 'Yes' : 'No', documentType: String(b.documentType || '').slice(0, 40) || null, valuesEdited: num(b.edited), valuesRemoved: num(b.removed), valuesAdded: num(b.added) } });
    res.json({ success: true });
  } catch (e) { sendErr(res, e); }
});

// ========== LOCATIONS (DCs — future expansion planning) ==========
app.get('/api/locations', authenticateToken, async (req, res) => {
  try {
    const isGlobalAdmin = req.user.role === 'Admin' && ['All', 'Both'].includes(req.user.location_access);
    let rows;
    if (isGlobalAdmin) {
      [rows] = await pool.query("SELECT * FROM locations ORDER BY CASE WHEN status='Active' THEN 0 ELSE 1 END, name");
    } else {
      const allowed = await getAllowedSitesForUser(req.user);
      if (allowed.length === 0) return res.json([]);
      [rows] = await pool.query("SELECT * FROM locations WHERE status='Active' AND name IN (" + allowed.map(() => '?').join(',') + ") ORDER BY name", allowed);
    }
    res.json(rows.map(r => ({ id: r.id, name: r.name, status: r.status || 'Active', createdBy: r.created_by, createdAt: r.created_at, archivedAt: r.archived_at, archivedBy: r.archived_by })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/locations', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    // Only a global Admin can create a new data-center location. An Admin
    // restricted to an existing location is treated as location-scoped and
    // cannot expand the security boundary by creating another location.
    if (!['All', 'Both'].includes(req.user.location_access)) {
      return res.status(403).json({ error: 'Only a global Admin with All-location access can create a new location.' });
    }
    const { name, zoneName } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Location name is required' });
    if (!zoneName || !String(zoneName).trim()) return res.status(400).json({ error: 'Initial zone name is required' });
    const site = String(name).trim();
    const zone = String(zoneName).trim();
    const id = genId('LOC');
    try {
      await pool.query('INSERT INTO locations (id, name, created_by) VALUES (?,?,?)', [id, site, req.user.name || req.user.username]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Location "${site}" already exists` });
      throw e;
    }
    // Zones are location-specific. Create the initial zone selected by the admin.
    const zoneId = `ZN-${site.slice(0,3).toUpperCase()}-${Date.now()}`;
    try {
      await pool.query('INSERT INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [zoneId, site, zone, req.user.name || req.user.username]);
    } catch (e) {
      try { await pool.query('DELETE FROM locations WHERE id = ?', [id]); } catch (_) {}
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Zone "${zone}" already exists for location "${site}"` });
      throw e;
    }
    res.json({ id, name: site, createdBy: req.user.name || req.user.username, zoneName: zone, zoneId });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/locations/:id/archive', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const [locRows] = await pool.query('SELECT id, name, status FROM locations WHERE id = ?', [req.params.id]);
    if (!locRows.length) return res.status(404).json({ error: 'Location not found' });
    if (locRows[0].status === 'Archived') return res.json({ success: true, status: 'Archived', name: locRows[0].name });
    await pool.query("UPDATE locations SET status='Archived', archived_at=CURRENT_TIMESTAMP, archived_by=? WHERE id=?", [req.user.name || req.user.username, req.params.id]);
    // Any active floor edit session for the archived site is immediately invalid.
    await pool.query('DELETE FROM floor_plan_locks WHERE site = ?', [locRows[0].name]);
    res.json({ success: true, status: 'Archived', name: locRows[0].name });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/locations/:id/restore', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const [locRows] = await pool.query('SELECT id, name, status FROM locations WHERE id = ?', [req.params.id]);
    if (!locRows.length) return res.status(404).json({ error: 'Location not found' });
    if (locRows[0].status === 'Active') return res.json({ success: true, status: 'Active', name: locRows[0].name });
    await pool.query("UPDATE locations SET status='Active', archived_at=NULL, archived_by=NULL WHERE id=?", [req.params.id]);
    res.json({ success: true, status: 'Active', name: locRows[0].name });
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/locations/:id', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    if (!['All', 'Both'].includes(req.user.location_access)) {
      return res.status(403).json({ error: 'Only a global Admin with All-location access can delete a location.' });
    }
    const [locRows] = await pool.query('SELECT id, name, status FROM locations WHERE id = ?', [req.params.id]);
    if (locRows.length === 0) return res.status(404).json({ error: 'Location not found' });
    if ((locRows[0].status || 'Active') !== 'Archived') {
      return res.status(409).json({ error: `Location "${locRows[0].name}" must be Archived before it can be permanently deleted.` });
    }
    const name = locRows[0].name;
    // Refuse to orphan data: assets/issues/etc. recorded here would otherwise become invisible
    // in the location lists while still being counted in totals.
    const inUse = [];
    for (const [label, sql, param] of [
      ['asset(s)', 'SELECT COUNT(*) AS c FROM assets WHERE site = ?', name],
      ['rack component(s)', 'SELECT COUNT(*) AS c FROM rack_components WHERE site = ?', name],
      ['asset movement history record(s)', 'SELECT COUNT(*) AS c FROM asset_movements WHERE from_site = ? OR to_site = ?', name],
      ['issue(s)', 'SELECT COUNT(*) AS c FROM issues WHERE site = ?', name],
      ['DC activity record(s)', 'SELECT COUNT(*) AS c FROM dc_activities WHERE site = ?', name],
      ['material movement(s)', 'SELECT COUNT(*) AS c FROM material_movements WHERE site = ?', name],
      ['user(s) restricted to it', 'SELECT COUNT(*) AS c FROM users WHERE location_access = ?', name]
    ]) {
      const params = (sql.match(/\?/g) || []).length === 2 ? [param, param] : [param];
      const [[{ c }]] = await pool.query(sql, params);
      if (Number(c) > 0) inUse.push(`${c} ${label}`);
    }
    if (inUse.length) return res.status(409).json({ error: `Location "${name}" still has ${inUse.join(', ')}. Remove or reassign them first.` });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM floor_plan_locks WHERE site = ?', [name]);
      await conn.query('DELETE FROM floor_plans WHERE site = ?', [name]);
      await conn.query('DELETE FROM racks WHERE site = ?', [name]);
      await conn.query('DELETE FROM zones WHERE site = ?', [name]);
      await conn.query('DELETE FROM locations WHERE id = ?', [req.params.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== RACK TYPES (used by Add Rack, Add/Edit Asset, Inventory filter) ==========
app.get('/api/rack-types', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM rack_types ORDER BY name');
    res.json(rows.map(r => ({ id: r.id, name: r.name, createdBy: r.created_by, createdAt: r.created_at })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/rack-types', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Rack type name is required' });
    const rt = String(name).trim();
    const id = genId('RT');
    try {
      await pool.query('INSERT INTO rack_types (id, name, created_by) VALUES (?,?,?)', [id, rt, req.user.name || req.user.username]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Rack type "${rt}" already exists` });
      throw e;
    }
    res.json({ id, name: rt, createdBy: req.user.name || req.user.username });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== ZONES (DC Capacity — future expansion planning) ==========
app.get('/api/zones', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    let sql = 'SELECT * FROM zones';
    const params = [];
    const conditions = [];
    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?'); params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY site, zone_name';
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(r => ({ id: r.id, site: r.site, zoneName: r.zone_name, createdBy: r.created_by, createdAt: r.created_at })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/zones', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zoneName } = req.body;
    const validSites = await getAllSiteNames();
    if (!site || !validSites.includes(site)) return res.status(400).json({ error: `Location must be one of: ${validSites.join(', ')}` });
    if (!zoneName || !String(zoneName).trim()) return res.status(400).json({ error: 'Zone name is required' });
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const name = String(zoneName).trim();
    const id = genId('ZN');
    try {
      await pool.query('INSERT INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [id, site, name, user.name || user.username]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Zone "${name}" already exists at ${site}` });
      throw e;
    }
    res.json({ id, site, zoneName: name, createdBy: user.name || user.username });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/zones/:id', authenticateToken, requireRole(['Admin']), async (req, res) => {
  try {
    const [zRows] = await pool.query('SELECT site, zone_name FROM zones WHERE id = ?', [req.params.id]);
    if (zRows.length === 0) return res.status(404).json({ error: 'Zone not found' });
    await assertSiteAccess(req.user, zRows[0].site);
    const [[{ rc }]] = await pool.query('SELECT COUNT(*) AS rc FROM racks WHERE site = ? AND zone = ?', [zRows[0].site, zRows[0].zone_name]);
    const [[{ ac }]] = await pool.query('SELECT COUNT(*) AS ac FROM assets WHERE site = ? AND zone = ?', [zRows[0].site, zRows[0].zone_name]);
    const [[{ cc }]] = await pool.query('SELECT COUNT(*) AS cc FROM rack_components WHERE site = ? AND zone = ?', [zRows[0].site, zRows[0].zone_name]);
    if (rc > 0 || ac > 0 || cc > 0) return res.status(409).json({ error: `Zone "${zRows[0].zone_name}" still has ${rc} rack(s), ${ac} asset(s) and ${cc} rack component(s). Move or delete them first.` });
    await pool.query('DELETE FROM floor_plan_locks WHERE site = ? AND zone = ?', [zRows[0].site, zRows[0].zone_name]);
    await pool.query('DELETE FROM floor_plans WHERE site = ? AND zone = ?', [zRows[0].site, zRows[0].zone_name]);
    await pool.query('DELETE FROM zones WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== RACKS (DC Capacity — future expansion planning) ==========
app.get('/api/racks', authenticateToken, async (req, res) => {
  try {
    const { site, zone } = req.query;
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    let sql = 'SELECT * FROM racks';
    const params = [];
    const conditions = [];
    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?'); params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (zone && zone !== 'all') { conditions.push('zone = ?'); params.push(zone); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY site, zone, rack_no';
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, site: r.site, zone: r.zone, rackNo: r.rack_no, rackType: r.rack_type, uSize: r.u_size,
      wTiles: r.w_tiles != null ? Number(r.w_tiles) : 1, hTiles: r.h_tiles != null ? Number(r.h_tiles) : 2,
      wMm: r.width_mm || 600, dMm: r.depth_mm || 1200,
      createdBy: r.created_by, createdAt: r.created_at
    })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/racks', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zone, rackNo, rackType, uSize, wMm, dMm, wTiles, hTiles } = req.body;
    const validSites = await getAllSiteNames();
    if (!site || !validSites.includes(site)) return res.status(400).json({ error: `Location must be one of: ${validSites.join(', ')}` });
    if (!zone || !String(zone).trim()) return res.status(400).json({ error: 'Zone is required' });
    if (!rackNo || !String(rackNo).trim()) return res.status(400).json({ error: 'Rack no. is required' });
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const size = parseInt(uSize, 10) > 0 ? parseInt(uSize, 10) : 42;
    const rn = String(rackNo).trim();
    const zn = String(zone).trim();
    const id = genId('RK');
    const wmm = parseInt(wMm, 10) > 0 ? parseInt(wMm, 10) : 600;
    const dmm = parseInt(dMm, 10) > 0 ? parseInt(dMm, 10) : 1200;
    const wt = parseFloat(wTiles) > 0 ? parseFloat(wTiles) : Math.round((wmm / 600) * 100) / 100;
    const ht = parseFloat(hTiles) > 0 ? parseFloat(hTiles) : Math.round((dmm / 600) * 100) / 100;
    try {
      await pool.query('INSERT INTO racks (id, site, zone, rack_no, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, site, zn, rn, rackType || null, size, wt, ht, wmm, dmm, user.name || user.username]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Rack "${rn}" already exists in ${zn} at ${site}` });
      throw e;}
    // If this rack introduced a brand-new type, add it to the shared catalog
    // so it's immediately available in the Asset Inventory rack-type dropdown too.
    if (rackType && String(rackType).trim()) {
      try { await pool.query('INSERT IGNORE INTO rack_types (id, name, created_by) VALUES (?,?,?)', [genId('RT'), String(rackType).trim(), user.name || user.username]); } catch (e) { /* best effort */ }
    }
    // Likewise register the zone itself if it wasn't already a known zone for
    // this site. Without this, a rack added to a location that has no zones yet
    // (e.g. a newly created location) leaves the zones catalog empty, so the
    // zone never appears in DC Capacity, Rack Elevation, or any zone dropdown.
    try { await pool.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [genId('ZN'), site, zn, user.name || user.username]); } catch (e) { /* best effort */ }
    res.json({ id, site, zone: zn, rackNo: rn, rackType: rackType || null, uSize: size, wTiles: wt, hTiles: ht, wMm: wmm, dMm: dmm, createdBy: user.name || user.username });
  } catch (e) {
    sendErr(res, e);
  }
});

app.put('/api/racks/upsert-dimensions', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zone, rackNo, rackType, uSize, wMm, dMm, wTiles, hTiles } = req.body || {};
    const validSites = await getAllSiteNames();
    if (!site || !validSites.includes(site)) return res.status(400).json({ error: `Location must be one of: ${validSites.join(', ')}` });
    const allowed = await getAllowedSitesForUser(req.user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const zn = String(zone || '').trim();
    const rn = String(rackNo || '').trim();
    if (!zn) return res.status(400).json({ error: 'Zone is required' });
    if (!rn) return res.status(400).json({ error: 'Rack no. is required' });

    const size = Number.isFinite(Number(uSize)) && Number(uSize) >= 1 ? Math.min(60, Math.floor(Number(uSize))) : 42;
    const wmm = Number.isFinite(Number(wMm)) && Number(wMm) >= 100 ? Math.min(2400, Math.floor(Number(wMm))) : 600;
    const dmm = Number.isFinite(Number(dMm)) && Number(dMm) >= 100 ? Math.min(2400, Math.floor(Number(dMm))) : 1200;
    const wt = Number.isFinite(Number(wTiles)) && Number(wTiles) >= 0.5 ? Number(Number(wTiles).toFixed(2)) : Number((wmm / 600).toFixed(2));
    const ht = Number.isFinite(Number(hTiles)) && Number(hTiles) >= 0.5 ? Number(Number(hTiles).toFixed(2)) : Number((dmm / 600).toFixed(2));
    if (wt <= 0 || ht <= 0) return res.status(400).json({ error: 'Rack footprint must be greater than zero.' });

    const userName = req.user.name || req.user.username;
    const rt = rackType && String(rackType).trim() ? String(rackType).trim() : null;
    const id = genId('RK');

    // Upsert on the existing (site, zone, rack_no) unique key. This preserves the
    // original rack id when editing an existing rack and creates the planned-rack
    // record automatically when the rack came only from Asset Inventory.
    await pool.query(
      `INSERT INTO racks (id, site, zone, rack_no, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         rack_type = VALUES(rack_type),
         u_size = VALUES(u_size),
         w_tiles = VALUES(w_tiles),
         h_tiles = VALUES(h_tiles),
         width_mm = VALUES(width_mm),
         depth_mm = VALUES(depth_mm)`,
      [id, site, zn, rn, rt, size, wt, ht, wmm, dmm, userName]
    );

    if (rt) {
      try { await pool.query('INSERT IGNORE INTO rack_types (id, name, created_by) VALUES (?,?,?)', [genId('RT'), rt, userName]); } catch (e) { /* catalog sync is best effort */ }
    }
    try { await pool.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [genId('ZN'), site, zn, userName]); } catch (e) { /* catalog sync is best effort */ }

    const [rows] = await pool.query(
      `SELECT id, site, zone, rack_no, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm, created_by, created_at
       FROM racks WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?)) LIMIT 1`,
      [site, zn, rn]
    );
    if (!rows.length) return res.status(500).json({ error: 'Rack dimension save completed but the rack could not be read back.' });
    const r = rows[0];
    res.json({
      id: r.id, site: r.site, zone: r.zone, rackNo: r.rack_no, rackType: r.rack_type,
      uSize: Number(r.u_size) || 42, wTiles: Number(r.w_tiles) || 1, hTiles: Number(r.h_tiles) || 2,
      wMm: Number(r.width_mm) || 600, dMm: Number(r.depth_mm) || 1200,
      createdBy: r.created_by, createdAt: r.created_at,
    });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/racks/:id', authenticateToken, requireRole(['Admin']), async (req, res) => {
  try {
    const [rkRows] = await pool.query('SELECT site, zone, rack_no FROM racks WHERE id = ?', [req.params.id]);
    if (rkRows.length === 0) return res.status(404).json({ error: 'Rack not found' });
    const rk = rkRows[0];
    await assertSiteAccess(req.user, rk.site);
    const [[{ dc }]] = await pool.query('SELECT COUNT(*) AS dc FROM assets WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))', [rk.site, rk.zone, rk.rack_no]);
    if (dc > 0) return res.status(409).json({ error: `Rack "${rk.rack_no}" still has ${dc} device(s) installed - remove them first.` });
    // Rack components live in their own table (separate from assets, since the
    // section-11 split) and were not checked here — a rack holding only components
    // (no devices) could be deleted while its components silently kept pointing at
    // a rack_no that no longer has a `racks` row, becoming an undeletable orphan.
    const [[{ rc }]] = await pool.query('SELECT COUNT(*) AS rc FROM rack_components WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))', [rk.site, rk.zone, rk.rack_no]);
    if (rc > 0) return res.status(409).json({ error: `Rack "${rk.rack_no}" still has ${rc} rack component(s) installed - remove them first.` });
    await pool.query('DELETE FROM racks WHERE id = ?', [req.params.id]);
    // drop its saved position from the Floor View plan
    await mutateFloorPlan(pool, rk.site, rk.zone, (d) => { const k = findLayoutKey(d.layout, rk.rack_no); if (!k) return false; delete d.layout[k]; });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Move / rename a rack (or a Pillar / Empty Space floor marker) to a
// different floor tile — a new zone and/or a new rack number/name — while
// carrying every device currently racked there along with it. This is how
// a rack's "location" on the floor is freed up for other use: since floor
// position is derived from the row+number in the rack name (not separate
// x/y coordinates), moving = renaming (optionally into a different zone).
// Matches purely on (site, zone, rack_no) so it also works for racks that
// only exist implicitly via asset records, not just ones with a row in the
// `racks` table.
app.post('/api/racks/move', authenticateToken, requireRole(['Admin']), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { site, zone, rackNo, newZone, newRackNo, newRackType } = req.body;
    if (!site || !zone || !rackNo) return res.status(400).json({ error: 'site, zone and rackNo are required' });
    const targetZone = String(newZone || zone).trim();
    const targetRackNo = String(newRackNo || rackNo).trim();
    if (!targetZone) return res.status(400).json({ error: 'Destination zone is required' });
    if (!targetRackNo) return res.status(400).json({ error: 'Destination rack no. is required' });

    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });

    const sameSpot = targetZone.toUpperCase() === String(zone).trim().toUpperCase() && targetRackNo.toUpperCase() === String(rackNo).trim().toUpperCase();
    if (!sameSpot) {
      // Refuse to move onto a tile that's already occupied by another rack's devices.
      const [occRows] = await conn.query(
        'SELECT COUNT(*) as cnt FROM assets WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))',
        [site, targetZone, targetRackNo]
      );
      if (occRows[0].cnt > 0) return res.status(409).json({ error: `Rack "${targetRackNo}" in ${targetZone} already has devices installed — pick an empty tile.` });
      const [occPlanned] = await conn.query(
        'SELECT COUNT(*) as cnt FROM racks WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))',
        [site, targetZone, targetRackNo]
      );
      if (occPlanned[0].cnt > 0) return res.status(409).json({ error: `Rack "${targetRackNo}" already exists in ${targetZone}.` });
    }

    await conn.beginTransaction();
    try {
      const assetUpdateFields = ['zone = ?', 'rack_no = ?', 'updated_at = CURRENT_TIMESTAMP', 'updated_by = ?'];
      const assetUpdateParams = [targetZone, targetRackNo, req.user.name || req.user.username];
      let assetChangedFields = 'Zone, Rack No';
      if (newRackType && String(newRackType).trim()) { assetUpdateFields.push('rack_type = ?'); assetUpdateParams.push(String(newRackType).trim()); assetChangedFields += ', Rack Type'; }
      assetUpdateFields.push('changed_fields = ?');
      assetUpdateParams.push(assetChangedFields);
      await conn.query(
        `UPDATE assets SET ${assetUpdateFields.join(', ')} WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))`,
        [...assetUpdateParams, site, zone, rackNo]
      );

      // Rack components (Patch Panel, Cable Manager, LIU, STS/ATS, Other) live in
      // their own table since the section-11 split and were never carried along by
      // a rack move/rename here — they kept the OLD rack_no while the `racks` row
      // and every device moved to the new one, so buildRacks() (app-compiled.js)
      // would key the stranded components under a fresh, unregistered "<old rack
      // no.>" bucket: a phantom "Unassigned" tile with no plannedId, auto-placed at
      // the next free floor slot (undeletable, since it isn't a real `racks` row).
      // Update them in lockstep with assets so a renamed/moved rack carries its
      // components along exactly like it carries its devices.
      const componentUpdateFields = ['zone = ?', 'rack_no = ?', 'updated_at = CURRENT_TIMESTAMP', 'updated_by = ?'];
      const componentUpdateParams = [targetZone, targetRackNo, req.user.name || req.user.username];
      let componentChangedFields = 'Zone, Rack No';
      if (newRackType && String(newRackType).trim()) { componentUpdateFields.push('rack_type = ?'); componentUpdateParams.push(String(newRackType).trim()); componentChangedFields += ', Rack Type'; }
      componentUpdateFields.push('changed_fields = ?');
      componentUpdateParams.push(componentChangedFields);
      await conn.query(
        `UPDATE rack_components SET ${componentUpdateFields.join(', ')} WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))`,
        [...componentUpdateParams, site, zone, rackNo]
      );

      const [rackRows] = await conn.query(
        'SELECT id, u_size FROM racks WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?))',
        [site, zone, rackNo]
      );
      if (rackRows.length > 0) {
        const rackUpdateFields = ['zone = ?', 'rack_no = ?'];
        const rackUpdateParams = [targetZone, targetRackNo];
        if (newRackType && String(newRackType).trim()) { rackUpdateFields.push('rack_type = ?'); rackUpdateParams.push(String(newRackType).trim()); }
        await conn.query(`UPDATE racks SET ${rackUpdateFields.join(', ')} WHERE id = ?`, [...rackUpdateParams, rackRows[0].id]);
      } else {
        // No planned-rack bookkeeping row existed (this rack was only known
        // through its assets) — create one now so the new name/zone is
        // registered and the freed-up old tile can be reused right away.
        try {
          await conn.query('INSERT INTO racks (id, site, zone, rack_no, rack_type, u_size, created_by) VALUES (?,?,?,?,?,?,?)', [
            genId('RK'), site, targetZone, targetRackNo, (newRackType && String(newRackType).trim()) || null, 42, user.name || user.username
          ]);
        } catch (e) { /* best effort — not fatal if this fails */ }
      }

      // Register the destination zone if it's new to this site.
      try { await conn.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)', [genId('ZN'), site, targetZone, user.name || user.username]); } catch (e) { /* best effort */ }

      if (!sameSpot) {
        // Issues keep a copy of zone / rack no. - keep the open ones pointing at the rack's new name.
        await conn.query(
          'UPDATE issues SET zone = ?, rack_no = ? WHERE site = ? AND zone = ? AND UPPER(TRIM(rack_no)) = UPPER(TRIM(?)) AND completed_date IS NULL',
          [targetZone, targetRackNo, site, zone, rackNo]
        );
        // Floor View positions are keyed by rack number: carry the tile position across a rename in the
        // same zone; for a move to another zone drop the stale entry (the new zone auto-places it).
        await mutateFloorPlan(conn, site, zone, (d) => {
          const k = findLayoutKey(d.layout, rackNo); if (!k) return false;
          const pos = d.layout[k]; delete d.layout[k];
          if (targetZone.toUpperCase() === String(zone).trim().toUpperCase()) d.layout[targetRackNo] = pos;
        });
      }

      await conn.commit();
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      throw e;
    }
    res.json({ success: true, site, zone: targetZone, rackNo: targetRackNo });
  } catch (e) {
    sendErr(res, e);
  } finally {
    if (conn) conn.release();
  }
});

// ========== FLOOR PLAN (server-side, replaces localStorage) ==========
// One JSON blob per (site, zone): { layout, aisles, lines, cages, elecItems }.
// GET is available to anyone with site access (read-only browsing of the
// floor); PUT (save) requires Admin or Operator, same as other DC-Capacity
// edit actions (Add Rack, etc.) — it doesn't touch device/asset data, only
// the visual arrangement, so it's intentionally not Admin-only.
// Saved floor size per zone: {cols, rows} in tiles, or null (= default 50 x 50 that grows on its own).
const FLOOR_MIN_SIZE = 20, FLOOR_MAX_SIZE = 150;
function floorSizeOrNull(size) {
  if (!size || typeof size !== 'object') return null;
  const c = Number(size.cols), r = Number(size.rows);
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < FLOOR_MIN_SIZE || r < FLOOR_MIN_SIZE || c > FLOOR_MAX_SIZE || r > FLOOR_MAX_SIZE) return null;
  return { cols: c, rows: r };
}

const FLOOR_LOCK_TTL_SECONDS = 90;
async function cleanupExpiredFloorLock(site, zone) {
  await pool.query('DELETE FROM floor_plan_locks WHERE site = ? AND zone = ? AND expires_at <= CURRENT_TIMESTAMP', [site, zone]);
}
async function getFloorLock(site, zone) {
  await cleanupExpiredFloorLock(site, zone);
  const [rows] = await pool.query('SELECT * FROM floor_plan_locks WHERE site = ? AND zone = ? LIMIT 1', [site, zone]);
  return rows.length ? rows[0] : null;
}
function floorLockPayload(row, req) {
  if (!row) return { locked: false, mine: false };
  return { locked: true, mine: String(row.user_id) === String(req.user.id), userId: row.user_id, username: row.username, userName: row.user_name, acquiredAt: row.acquired_at, heartbeatAt: row.heartbeat_at, expiresAt: row.expires_at, lockToken: String(row.user_id) === String(req.user.id) ? row.lock_token : undefined };
}

app.get('/api/floor-plan-lock', authenticateToken, async (req, res) => {
  try {
    const { site, zone } = req.query;
    if (!site || !zone) return res.status(400).json({ error: 'site and zone are required' });
    await assertSiteAccess(req.user, site);
    const row = await getFloorLock(site, zone);
    res.json(floorLockPayload(row, req));
  } catch (e) { sendErr(res, e); }
});

app.post('/api/floor-plan-lock', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zone, lockToken: requestedToken } = req.body || {};
    if (!site || !zone) return res.status(400).json({ error: 'site and zone are required' });
    await assertSiteAccess(req.user, site);
    await cleanupExpiredFloorLock(site, zone);
    const existing = await getFloorLock(site, zone);
    if (existing) {
      // Same browser/session can refresh its own lock, but a second browser tab
      // for the same account is still blocked so two sessions cannot overwrite each other.
      if (String(existing.user_id) === String(req.user.id) && requestedToken && String(existing.lock_token) === String(requestedToken)) {
        const token = String(existing.lock_token);
        await pool.query('UPDATE floor_plan_locks SET heartbeat_at=CURRENT_TIMESTAMP, expires_at=DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND) WHERE site=? AND zone=?', [FLOOR_LOCK_TTL_SECONDS, site, zone]);
        const row = await getFloorLock(site, zone);
        return res.json({ ...floorLockPayload(row, req), lockToken: token });
      }
      const ownerText = String(existing.user_id) === String(req.user.id) ? 'You already have an active editing session for this zone in another browser/tab.' : `Floor layout is currently being edited by ${existing.user_name || existing.username}. Please wait until the editing session is released.`;
      return res.status(409).json({ error: ownerText, locked: true, userName: existing.user_name || existing.username, username: existing.username, acquiredAt: existing.acquired_at, expiresAt: existing.expires_at });
    }
    const token = String(requestedToken || genId('FL'));
    try {
      await pool.query('INSERT INTO floor_plan_locks (site, zone, lock_token, user_id, username, user_name, acquired_at, heartbeat_at, expires_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND))', [site, zone, token, String(req.user.id), req.user.username, req.user.name || req.user.username, FLOOR_LOCK_TTL_SECONDS]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        const winner = await getFloorLock(site, zone);
        return res.status(409).json({ error: `Floor layout is currently being edited by ${winner?.user_name || winner?.username || 'another user'}. Please wait until the editing session is released.`, locked: true, userName: winner?.user_name || winner?.username, username: winner?.username, acquiredAt: winner?.acquired_at, expiresAt: winner?.expires_at });
      }
      throw e;
    }
    const row = await getFloorLock(site, zone);
    res.json({ ...floorLockPayload(row, req), lockToken: token });
  } catch (e) { sendErr(res, e); }
});

app.put('/api/floor-plan-lock', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zone, lockToken } = req.body || {};
    if (!site || !zone || !lockToken) return res.status(400).json({ error: 'site, zone and lockToken are required' });
    await assertSiteAccess(req.user, site);
    const row = await getFloorLock(site, zone);
    if (!row || String(row.user_id) !== String(req.user.id) || row.lock_token !== String(lockToken)) return res.status(409).json({ error: 'Your Floor View editing session is no longer active. Re-enter Edit Layout to continue.', locked: !!row, ...(row ? floorLockPayload(row, req) : {}) });
    await pool.query('UPDATE floor_plan_locks SET heartbeat_at=CURRENT_TIMESTAMP, expires_at=DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND) WHERE site=? AND zone=? AND user_id=? AND lock_token=?', [FLOOR_LOCK_TTL_SECONDS, site, zone, String(req.user.id), lockToken]);
    const updated = await getFloorLock(site, zone);
    res.json({ ...floorLockPayload(updated, req), lockToken });
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/floor-plan-lock', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zone, lockToken } = req.body || {};
    if (!site || !zone || !lockToken) return res.status(400).json({ error: 'site, zone and lockToken are required' });
    await assertSiteAccess(req.user, site);
    await pool.query('DELETE FROM floor_plan_locks WHERE site=? AND zone=? AND user_id=? AND lock_token=?', [site, zone, String(req.user.id), lockToken]);
    res.json({ success: true });
  } catch (e) { sendErr(res, e); }
});

app.get('/api/floor-plan', authenticateToken, async (req, res) => {
  try {
    const { site, zone } = req.query;
    if (!site || !zone) return res.status(400).json({ error: 'site and zone are required' });
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    const [rows] = await pool.query('SELECT data FROM floor_plans WHERE site = ? AND zone = ?', [site, zone]);
    if (!rows.length) return res.json({ layout: {}, aisles: [], lines: [], cages: [], elecItems: [], textNotes: [], size: null });
    let parsed;
    try { parsed = JSON.parse(rows[0].data || '{}'); } catch (e) { parsed = {}; }
    res.json({
      layout: parsed.layout || {}, aisles: parsed.aisles || [], lines: parsed.lines || [],
      cages: parsed.cages || [], elecItems: parsed.elecItems || [], textNotes: parsed.textNotes || [], size: floorSizeOrNull(parsed.size),
    });
  } catch (e) {
    sendErr(res, e);
  }
});

app.put('/api/floor-plan', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { site, zone, layout, aisles, lines, cages, elecItems, textNotes, size, lockToken } = req.body;
    if (!site || !zone) return res.status(400).json({ error: 'site and zone are required' });
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
    // A live editing lock blocks writes from another editor. Legacy/system saves without a token
    // remain compatible only when no one currently owns the zone lock.
    const activeLock = await getFloorLock(site, zone);
    if (activeLock) {
      if (!lockToken || String(activeLock.lock_token) !== String(lockToken) || String(activeLock.user_id) !== String(user.id)) {
        return res.status(409).json({ error: `Floor layout is currently being edited by ${activeLock.user_name || activeLock.username}. Your changes were not saved.`, locked: true, userName: activeLock.user_name || activeLock.username, username: activeLock.username, acquiredAt: activeLock.acquired_at, expiresAt: activeLock.expires_at });
      }
    }
    // No "size" in the request (an older cached page) = keep the size that is already saved; explicit null = back to the default
    let sizeToSave = floorSizeOrNull(size);
    if (size === undefined) {
      const [old] = await pool.query('SELECT data FROM floor_plans WHERE site = ? AND zone = ?', [site, zone]);
      if (old.length) { try { sizeToSave = floorSizeOrNull(JSON.parse(old[0].data || '{}').size); } catch (e) { sizeToSave = null; } }
    }
    const data = JSON.stringify({
      layout: layout || {}, aisles: aisles || [], lines: lines || [],
      cages: cages || [], elecItems: elecItems || [], textNotes: textNotes || [], size: sizeToSave,
    });
    await pool.query(
      'INSERT INTO floor_plans (site, zone, data, updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)',
      [site, zone, data, user.name || user.username]
    );
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== DC ACTIVITIES ==========
const ACTIVITY_TYPES = ['Rack/Stacking','Cabling Work','Firmware Update','UPS Drill','Rack Power ON/OFF','Audit Inspection','Port/Link Down Issue 2','Rack Provision','Cage Alteration','Others'];

app.get('/api/activities', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);

    let sql = 'SELECT * FROM dc_activities';
    const params = [];
    const conditions = [];
    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?');
      params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY start_date DESC, created_at DESC';
    const [rows] = await pool.query(sql, params);
    const toDateStr = (v) => dateOnlyStr(v);
    res.json(rows.map(r => ({
      id: r.id, site: r.site, zone: r.zone, hardwareType: r.hardware_type,
      activityType: r.activity_type, description: r.description,
      startDate: toDateStr(r.start_date), completionDate: toDateStr(r.completion_date),
      createdBy: r.created_by, createdAt: r.created_at
    })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/activities', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const a = req.body;
    const validSites = await getAllSiteNames();
    if (!a.site || !validSites.includes(a.site)) return res.status(400).json({ error: `Location must be one of: ${validSites.join(', ')}` });
    if (!a.activityType || !(ACTIVITY_TYPES.includes(a.activityType) || a.activityType === 'PSU Provision')) return res.status(400).json({ error: 'Invalid activity type' });
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(a.site)) return res.status(403).json({ error: 'Access denied for this site' });
    const id = genId('ACT');
    const startDate = normalizeDateInput(a.startDate);
    const completionDate = normalizeDateInput(a.completionDate);
    await pool.query(
      `INSERT INTO dc_activities (id, site, zone, hardware_type, activity_type, description, start_date, completion_date, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, a.site, a.zone || 'AZ-1', a.hardwareType || null, a.activityType, a.description || null, startDate, completionDate, user.name || user.username]
    );
    res.json({ id, site: a.site, zone: a.zone || 'AZ-1', hardwareType: a.hardwareType || null, activityType: a.activityType, description: a.description || null, startDate, completionDate, createdBy: user.name || user.username });
  } catch (e) {
    sendErr(res, e);
  }
});

app.patch('/api/activities/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const a = req.body;
    const [existing] = await pool.query('SELECT id, site FROM dc_activities WHERE id = ?', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Activity not found' });
    await assertSiteAccess(req.user, existing[0].site);
    await assertSiteAccess(req.user, a.site);
    if (!a.activityType || !(ACTIVITY_TYPES.includes(a.activityType) || a.activityType === 'PSU Provision')) return res.status(400).json({ error: 'Invalid activity type' });
    const startDate = normalizeDateInput(a.startDate);
    const completionDate = normalizeDateInput(a.completionDate);
    await pool.query(
      `UPDATE dc_activities SET site=?, zone=?, hardware_type=?, activity_type=?, description=?, start_date=?, completion_date=? WHERE id=?`,
      [a.site, a.zone || 'AZ-1', a.hardwareType || null, a.activityType, a.description || null, startDate, completionDate, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/activities/:id', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT site FROM dc_activities WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Activity not found' });
    await assertSiteAccess(req.user, rows[0].site);
    await pool.query('DELETE FROM dc_activities WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== MATERIAL MOVEMENTS ==========
const MOVEMENT_TYPES = ['Inward', 'Outward'];
function movementRowToJson(r) {
  const toDateStr = (v) => dateOnlyStr(v);
  return {
    id: r.id, movementType: r.movement_type, site: r.site,
    itemName: r.item_name, description: r.description, quantity: r.quantity, unit: r.unit,
    receiverName: r.receiver_name, senderName: r.sender_name,
    dcInvoiceNo: r.dc_invoice_no, hasDocument: !!r.dc_invoice_file, documentName: r.dc_invoice_original_name,
    movementDate: toDateStr(r.movement_date), remarks: r.remarks,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

app.get('/api/material-movements', authenticateToken, async (req, res) => {
  try {
    const { site } = req.query;
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);

    let sql = 'SELECT * FROM material_movements';
    const params = [];
    const conditions = [];
    if (site && site !== 'all') {
      if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
      conditions.push('site = ?');
      params.push(site);
    } else {
      await applySiteScope(allowed, conditions, params);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY movement_date DESC, created_at DESC';
    const [rows] = await pool.query(sql, params);

    // One batch query for every movement's multi-file documents, instead of
    // a query per row. Legacy single-file (dc_invoice_file) stays as-is on
    // the row itself via movementRowToJson — this only adds the new
    // multi-file list alongside it.
    const ids = rows.map((r) => r.id);
    let docsByMovement = {};
    if (ids.length) {
      const [docs] = await pool.query(
        `SELECT id, movement_id, original_name, uploaded_by, uploaded_at FROM material_movement_documents WHERE movement_id IN (?) ORDER BY uploaded_at ASC`,
        [ids]
      );
      docs.forEach((d) => {
        (docsByMovement[d.movement_id] = docsByMovement[d.movement_id] || []).push({ id: d.id, name: d.original_name, uploadedBy: d.uploaded_by, uploadedAt: d.uploaded_at });
      });
    }
    res.json(rows.map((r) => ({ ...movementRowToJson(r), documents: docsByMovement[r.id] || [] })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/material-movements', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const m = req.body;
    const validSites = await getAllSiteNames();
    if (!m.site || !validSites.includes(m.site)) return res.status(400).json({ error: `Location must be one of: ${validSites.join(', ')}` });
    if (!m.movementType || !MOVEMENT_TYPES.includes(m.movementType)) return res.status(400).json({ error: 'Movement type must be Inward or Outward' });
    if (!m.itemName || !String(m.itemName).trim()) return res.status(400).json({ error: 'Item name is required' });
    const user = req.user;
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.includes(m.site)) return res.status(403).json({ error: 'Access denied for this site' });
    const id = genId('MAT');
    const movementDate = normalizeDateInput(m.movementDate) || localTodayStr();
    await pool.query(
      `INSERT INTO material_movements (id, movement_type, site, item_name, description, quantity, unit, receiver_name, sender_name, dc_invoice_no, movement_date, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, m.movementType, m.site, m.itemName, m.description || null, Math.max(1, parseInt(m.quantity, 10) || 1), m.unit || null, m.receiverName || null, m.senderName || null, m.dcInvoiceNo || null, movementDate, m.remarks || null, user.name || user.username]
    );
    const [rows] = await pool.query('SELECT * FROM material_movements WHERE id = ?', [id]);
    res.json(movementRowToJson(rows[0]));
  } catch (e) {
    sendErr(res, e);
  }
});

app.patch('/api/material-movements/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const m = req.body;
    const [existing] = await pool.query('SELECT id, site FROM material_movements WHERE id = ?', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Material movement record not found' });
    await assertSiteAccess(req.user, existing[0].site);
    await assertSiteAccess(req.user, m.site);
    if (!m.movementType || !MOVEMENT_TYPES.includes(m.movementType)) return res.status(400).json({ error: 'Movement type must be Inward or Outward' });
    if (!m.itemName || !String(m.itemName).trim()) return res.status(400).json({ error: 'Item name is required' });
    const movementDate = normalizeDateInput(m.movementDate);
    if (m.movementDate && !movementDate) return res.status(400).json({ error: 'Movement date is not a valid date' });
    await pool.query(
      `UPDATE material_movements SET movement_type=?, site=?, item_name=?, description=?, quantity=?, unit=?, receiver_name=?, sender_name=?, dc_invoice_no=?, movement_date=?, remarks=? WHERE id=?`,
      [m.movementType, m.site, m.itemName, m.description || null, Math.max(1, parseInt(m.quantity, 10) || 1), m.unit || null, m.receiverName || null, m.senderName || null, m.dcInvoiceNo || null, movementDate, m.remarks || null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/material-movements/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT dc_invoice_file, site FROM material_movements WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Material movement record not found' });
    await assertSiteAccess(req.user, rows[0].site);
    // Attachments live in their own table + files on disk - remove them with the record, not leave them orphaned forever.
    const [docRows] = await pool.query('SELECT file_name FROM material_movement_documents WHERE movement_id = ?', [req.params.id]);
    await pool.query('DELETE FROM material_movement_documents WHERE movement_id = ?', [req.params.id]);
    await pool.query('DELETE FROM material_movements WHERE id = ?', [req.params.id]);
    docRows.forEach((d) => { if (d.file_name) fs.unlink(safeUploadPath(d.file_name), () => {}); });
    if (rows[0].dc_invoice_file) {
      const filePath = safeUploadPath(rows[0].dc_invoice_file);
      fs.unlink(filePath, () => {}); // best-effort cleanup, ignore if already gone
    }
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Upload (or replace) the optional DC/Invoice document for a movement record
// Multiple files per movement now — up to 10 per upload call. The old
// single-file columns (dc_invoice_file/dc_invoice_original_name) are left
// exactly as they were for any movement that already has one; this route
// no longer writes to them at all, only to material_movement_documents.
app.post('/api/material-movements/:id/document', authenticateToken, requireRole(['Admin', 'Operator']), movementUpload.array('files', 10), verifyUploadedFiles, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const [rows] = await pool.query('SELECT site FROM material_movements WHERE id = ?', [req.params.id]);
    if (rows.length === 0) { req.files.forEach((f) => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Material movement record not found' }); }
    try { await assertSiteAccess(req.user, rows[0].site); } catch (e) { req.files.forEach((f) => fs.unlink(f.path, () => {})); throw e; } // don't leave rejected uploads on disk
    const user = req.user;
    const inserted = [];
    for (const f of req.files) {
      const docId = genId('DOC');
      await pool.query(
        'INSERT INTO material_movement_documents (id, movement_id, file_name, original_name, uploaded_by) VALUES (?,?,?,?,?)',
        [docId, req.params.id, f.filename, f.originalname, user.name || user.username]
      );
      inserted.push({ id: docId, name: f.originalname });
    }
    res.json({ success: true, documents: inserted });
  } catch (e) {
    sendErr(res, e);
  }
});

// Download one specific document from the multi-file set
app.get('/api/material-movements/:id/documents/:docId', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT d.file_name, d.original_name, m.site FROM material_movement_documents d JOIN material_movements m ON m.id = d.movement_id WHERE d.id = ? AND d.movement_id = ?',
      [req.params.docId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    await assertSiteAccess(req.user, rows[0].site);
    const filePath = safeUploadPath(rows[0].file_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Document file is missing on the server' });
    res.download(filePath, rows[0].original_name || rows[0].file_name);
  } catch (e) {
    sendErr(res, e);
  }
});

// Remove one specific document from the multi-file set (the movement record and any other attached files are untouched)
app.delete('/api/material-movements/:id/documents/:docId', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT d.file_name, m.site FROM material_movement_documents d JOIN material_movements m ON m.id = d.movement_id WHERE d.id = ? AND d.movement_id = ?',
      [req.params.docId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    await assertSiteAccess(req.user, rows[0].site);
    fs.unlink(safeUploadPath(rows[0].file_name), () => {});
    await pool.query('DELETE FROM material_movement_documents WHERE id = ?', [req.params.docId]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Download the DC/Invoice document for a movement record
app.get('/api/material-movements/:id/document', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT dc_invoice_file, dc_invoice_original_name, site FROM material_movements WHERE id = ?', [req.params.id]);
    if (rows.length === 0 || !rows[0].dc_invoice_file) return res.status(404).json({ error: 'No document attached to this record' });
    await assertSiteAccess(req.user, rows[0].site);
    const filePath = safeUploadPath(rows[0].dc_invoice_file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Document file is missing on the server' });
    res.download(filePath, rows[0].dc_invoice_original_name || rows[0].dc_invoice_file);
  } catch (e) {
    sendErr(res, e);
  }
});

// Remove just the attached document, keeping the movement record itself
app.delete('/api/material-movements/:id/document', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT dc_invoice_file, site FROM material_movements WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Material movement record not found' });
    await assertSiteAccess(req.user, rows[0].site);
    if (rows[0].dc_invoice_file) fs.unlink(safeUploadPath(rows[0].dc_invoice_file), () => {});
    await pool.query('UPDATE material_movements SET dc_invoice_file=NULL, dc_invoice_original_name=NULL WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ========== HARDWARE TYPES ==========
app.get('/api/hardware-types', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM hardware_types ORDER BY name');
    res.json(rows.map(r => ({ id: r.id, name: r.name, category: r.category || 'Device', defaultHeight: r.default_height || null, createdBy: r.created_by, createdAt: r.created_at })));
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/hardware-types', authenticateToken, requireRole(['Admin','Operator']), async (req, res) => {
  try {
    const { name, category, defaultHeight } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Hardware type name is required' });
    const ht = String(name).trim();
    // 'Component' marks a passive rack item (Patch Panel, Cable Manager, LIU,
    // STS/ATS, Other, or a custom one added the same way) — anything else is
    // treated as a normal active device. Optional; defaults to 'Device' so
    // the existing "+ Add new hardware type" flow (which never sends this)
    // keeps working exactly as before.
    const cat = String(category || '').trim() === 'Component' ? 'Component' : 'Device';
    const height = defaultHeight ? String(defaultHeight).trim().slice(0, 10) : null;
    const info = {};
    const canonical = await normalizeHardwareType(pool, ht, req.user.name || req.user.username, info);
    if (canonical.toLowerCase() !== ht.toLowerCase()) {
      return res.status(409).json({ error: `Hardware type "${ht}" already exists as "${canonical}"` });
    }
    if (info.created && (cat === 'Component' || height)) {
      await pool.query('UPDATE hardware_types SET category = ?, default_height = ? WHERE id = ?', [cat, height, info.id]);
    }
    // info.id is the id actually stored, so a follow-up DELETE by this id works
    res.json({ id: info.id, name: canonical, category: info.created ? cat : undefined, defaultHeight: info.created ? height : undefined, createdBy: req.user.name || req.user.username });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/hardware-types/:id', authenticateToken, requireRole(['Admin']), async (req, res) => {
  try {
    const [htRows] = await pool.query('SELECT name FROM hardware_types WHERE id = ?', [req.params.id]);
    if (htRows.length === 0) return res.status(404).json({ error: 'Hardware type not found' });
    const [[{ ac }]] = await pool.query('SELECT COUNT(*) AS ac FROM assets WHERE hardware_type = ?', [htRows[0].name]);
    const [[{ tc }]] = await pool.query('SELECT COUNT(*) AS tc FROM dc_activities WHERE hardware_type = ?', [htRows[0].name]);
    const [[{ rc }]] = await pool.query('SELECT COUNT(*) AS rc FROM rack_components WHERE hardware_type = ?', [htRows[0].name]);
    if (ac > 0 || tc > 0 || rc > 0) return res.status(409).json({ error: `"${htRows[0].name}" is still used by ${ac} asset(s), ${rc} rack component(s), and ${tc} activity record(s). Change those first.` });
    await pool.query('DELETE FROM hardware_types WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ status: 'starting', database: 'not-ready' });
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString(), offlineUi: fs.existsSync(path.join(__dirname, 'app-compiled.js')) && fs.existsSync(path.join(__dirname, 'libs', 'react.production.min.js')) });
  } catch (e) {
    log.error('[health] database check failed:', e.message);
    res.status(500).json({ status: 'error', database: 'unavailable' });
  }
});
// Version / build information (public, like /api/health; contains nothing sensitive)
app.get('/api/version', (req, res) => {
  res.json({ name: 'dcim-webapp', version: APP_VERSION, environment: IS_PRODUCTION ? 'production' : 'development', backupFormatVersion: BACKUP_VERSION, startedAt: SERVER_STARTED_AT.toISOString(), uptimeSeconds: Math.round(process.uptime()) });
});
// Performance snapshot (global Admin only): slowest routes, recent slow SQL/API calls, cache and memory figures
app.get('/api/perf', authenticateToken, requireGlobalAdmin, (req, res) => {
  const routes = [...perfStats.routes.entries()].map(([k, v]) => ({ route: k, calls: v.n, avgMs: Math.round(v.total / v.n), maxMs: Math.round(v.max), totalMs: Math.round(v.total) })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 30);
  res.json({ uptimeSeconds: Math.round(process.uptime()), thresholds: { slowQueryMs: SLOW_QUERY_MS, slowApiMs: SLOW_API_MS }, counters: { queries: perfStats.queries, slowQueries: perfStats.slowQueries, apiRequests: perfStats.apiRequests, slowApi: perfStats.slowApi },
    cache: { ttlMs: API_CACHE_TTL_MS, entries: apiCache.size, kb: Math.round(apiCacheBytes / 1024), hits: perfStats.cacheHits, misses: perfStats.cacheMisses, stores: perfStats.cacheStores },
    memory: memSamples.slice(-30), routes, recentSlow: perfStats.recentSlow.slice(-30).reverse() });
});
// Audit trail viewer (global Admin only; read-only). Filters: action, username, entity, status, from, to (ISO dates); paging: limit (max 500), offset.
app.get('/api/audit-logs', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const q = req.query || {}; const where = []; const params = [];
    if (q.action) { where.push('action = ?'); params.push(String(q.action)); }
    if (q.username) { where.push('username = ?'); params.push(String(q.username)); }
    if (q.entity) { where.push('entity_type = ?'); params.push(String(q.entity)); }
    if (q.status === 'success' || q.status === 'failure') { where.push('status = ?'); params.push(q.status); }
    if (q.from) { where.push('created_at >= ?'); params.push(new Date(q.from)); }
    if (q.to) { where.push('created_at <= ?'); params.push(new Date(q.to)); }
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500); const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs${clause}`, params);
    const [rows] = await pool.query(`SELECT * FROM audit_logs${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ total, limit, offset, rows });
  } catch (e) { sendErr(res, e); }
});

// ===== BACKUP & RESTORE (Admin only) =====
// One backup = one compressed file (.json.gz) holding EVERY table plus the uploaded DC/Invoice documents, with a SHA-256
// checksum so a damaged or edited file is refused instead of half-restored.
//   * Automatic: every day at 23:00 (server time) into the backup folder; files older than the last 3 days are deleted.
//   * Manual   : downloaded to a location the admin chooses on their own PC (browser "Save as" dialog).
//   * Restore  : from a file on the admin's PC or from the backup folder. Inside ONE database transaction (all or nothing),
//                after an automatic safety backup of the current data.
// Settings (enabled / folder) live in the app_settings table and can only be read or changed by an Admin.
const crypto = require('crypto'); // zlib is required once, near the top of the file
// Every data table the app depends on. (rack_components / asset_movements / material_movement_documents were missing: a restore silently lost rack components and lifecycle history.)
// app_settings added so Organization/Branding settings and the Infrastructure wizard's
// OME/OneView/SMTP config travel with Backup/Restore too (previously silently dropped on
// a restore). Encrypted credential values inside it only decrypt on a server with the same
// JWT_SECRET they were encrypted under -- restoring to a different server still needs those
// passwords re-entered via the wizard, exactly as Config Export/Import already documents.
const BACKUP_TABLES = ['locations', 'rack_types', 'hardware_types', 'zones', 'racks', 'floor_plans', 'users', 'assets', 'rack_components', 'asset_movements', 'issues', 'dc_activities', 'material_movements', 'material_movement_documents', 'firmware_targets', 'firmware_model_targets', 'asset_connectivity', 'asset_hw_details', 'app_settings'];
const BACKUP_FORMAT = 'dc-dashboard-backup', BACKUP_VERSION = 1;
const BACKUP_RETENTION_DAYS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 7); // configurable; default widened from the old hardcoded 3 to 7 per the packaging review
const BACKUP_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/.test(process.env.BACKUP_TIME || '') ? process.env.BACKUP_TIME : '23:00';   // HH:MM server time
const DEFAULT_BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(__dirname, 'backups');
const BACKUP_NAME_RE = /^dc-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(auto|manual|prerestore)\.json\.gz$/;
const BACKUP_SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_BACKUP_UPLOAD = 300 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
let backupBusy = false, backupTimer = null;
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BACKUP_UPLOAD } });

function httpErr(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const pad2 = (n) => String(n).padStart(2, '0');
function backupStamp(d) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; }
function backupNameDate(name) { const m = BACKUP_NAME_RE.exec(name); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; }
const dateStringCast = (field, next) => (['DATE', 'DATETIME', 'TIMESTAMP', 'NEWDATE'].includes(field.type) ? field.string() : next());

async function getSetting(key, dflt) { const [r] = await pool.query('SELECT v FROM app_settings WHERE k = ?', [key]); return r.length ? r[0].v : dflt; }
async function setSetting(key, value) { await pool.query('INSERT INTO app_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, String(value)]); }
async function backupConfig() {
  const enabled = await getSetting('backup.enabled', '1'); const dir = await getSetting('backup.dir', '');
  const retentionRaw = await getSetting('backup.retentionDays', '');
  const retentionDays = retentionRaw ? Math.max(1, Math.min(365, Number(retentionRaw) || BACKUP_RETENTION_DAYS)) : BACKUP_RETENTION_DAYS;
  return { enabled: enabled !== '0', dir: dir || DEFAULT_BACKUP_DIR, customDir: !!dir, retentionDays };
}

// A folder is accepted only if it is a full path, is (or can be made into) a folder and a test file can be written to it
async function validateBackupDir(p) {
  const s = String(p || '').trim();
  if (!s) throw httpErr(400, 'Enter the folder path where backups should be saved.');
  if (!path.isAbsolute(s)) throw httpErr(400, 'Enter a full folder path (for example D:\\Backups or /var/backups/dc), not a relative one.');
  const dir = path.resolve(s);
  if (path.parse(dir).root === dir) throw httpErr(400, 'Choose a folder, not the root of a drive.');
  if (process.platform !== 'win32' && /^\/(proc|sys|dev)(\/|$)/.test(dir)) throw httpErr(400, 'That is a system location, not a place to keep backups. Choose a normal folder.');
  // every file-system check gets a time limit so an unreachable network drive or odd location can never hang the request
  const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out - the location is not responding')), 8000))]);
  try { await within(fs.promises.mkdir(dir, { recursive: true })); } catch (e) { throw httpErr(400, `The folder cannot be created: ${e.message}`); }
  let st; try { st = await within(fs.promises.stat(dir)); } catch (e) { throw httpErr(400, `The folder cannot be read: ${e.message}`); }
  if (!st.isDirectory()) throw httpErr(400, 'That path is not a folder.');
  const probe = path.join(dir, `.write-test-${crypto.randomBytes(4).toString('hex')}`);
  try { await within(fs.promises.writeFile(probe, 'ok')); await within(fs.promises.unlink(probe)); } catch (e) { throw httpErr(400, `The server cannot write to that folder: ${e.message}`); }
  return dir;
}

async function buildBackup(kind, by) {
  const conn = await pool.getConnection(); const tables = {};
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');          // every table as of the same instant
    for (const t of BACKUP_TABLES) { const [rows] = await conn.query({ sql: `SELECT * FROM \`${t}\`${t === 'app_settings' ? " WHERE k NOT LIKE 'license.%'" : ''}`, typeCast: dateStringCast }); tables[t] = rows; }   // license.* (trial record) stays per machine - never exported
    await conn.query('COMMIT');
  } finally { conn.release(); }
  const files = {}, skippedFiles = [];
  try {
    for (const f of fs.readdirSync(MOVEMENTS_UPLOAD_DIR)) {
      const fp = safeUploadPath(f); const st = fs.statSync(fp);
      if (!st.isFile() || !BACKUP_SAFE_FILE_RE.test(f)) continue;
      if (st.size > MAX_ATTACHMENT_BYTES) { skippedFiles.push(f); continue; }
      files[f] = fs.readFileSync(fp).toString('base64');
    }
  } catch (e) { /* no uploads folder yet */ }
  const sha256 = crypto.createHash('sha256').update(JSON.stringify({ tables, files })).digest('hex');
  const counts = {}; BACKUP_TABLES.forEach((t) => { counts[t] = tables[t].length; });
  const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, appVersion: APP_VERSION, createdAt: new Date().toISOString(), createdBy: by || 'system', kind, counts, fileCount: Object.keys(files).length, skippedFiles, sha256, tables, files };
  return { buffer: zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 6 }), manifest };
}

async function writeBackupFile(kind, by) {
  const cfg = await backupConfig(); await fs.promises.mkdir(cfg.dir, { recursive: true });
  const { buffer, manifest } = await buildBackup(kind, by);
  const name = `dc-backup-${backupStamp(new Date())}-${kind}.json.gz`; const full = path.join(cfg.dir, name);
  const fileSha256 = nodeCrypto.createHash('sha256').update(buffer).digest('hex');
  await fs.promises.writeFile(full + '.tmp', buffer);
  // PHASE-1: verify the file that actually reached the disk BEFORE it is published (size + SHA-256 of the whole file + full structural/checksum validation)
  try {
    const back = await fs.promises.readFile(full + '.tmp');
    if (back.length !== buffer.length || nodeCrypto.createHash('sha256').update(back).digest('hex') !== fileSha256) throw new Error('the file on disk does not match what was written (disk full or write error)');
    parseBackupBuffer(back);
  } catch (e) { await fs.promises.unlink(full + '.tmp').catch(() => {}); throw new Error(`Backup verification failed - nothing was kept. (${e.message})`); }
  await fs.promises.rename(full + '.tmp', full);   // never leaves a half-written backup
  // PHASE-1: metadata next to the backup (version, timestamp, checksum, user)
  const meta = { file: name, format: BACKUP_FORMAT, formatVersion: BACKUP_VERSION, appVersion: APP_VERSION, createdAt: manifest.createdAt, createdBy: manifest.createdBy, kind, size: buffer.length, fileSha256, dataSha256: manifest.sha256, counts: manifest.counts, fileCount: manifest.fileCount, verified: true };
  try { await fs.promises.writeFile(full + '.meta.json.tmp', JSON.stringify(meta, null, 2)); await fs.promises.rename(full + '.meta.json.tmp', full + '.meta.json'); } catch (e) { log.warn('[backup] could not write the metadata file for', name, e.message); }
  return { name, size: buffer.length, dir: cfg.dir, manifest, meta };
}
async function readBackupMeta(dir, name) { try { return JSON.parse(await fs.promises.readFile(path.join(dir, name + '.meta.json'), 'utf8')); } catch (e) { return null; } }

// Keep today and the previous (RETENTION - 1) days; delete OUR backup files older than that. Other files are never touched.
async function pruneBackups(dir, retentionDays = BACKUP_RETENTION_DAYS, now = new Date()) {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retentionDays - 1)).getTime(); const deleted = [];
  let names = []; try { names = await fs.promises.readdir(dir); } catch (e) { return deleted; }
  for (const f of names) { const d = backupNameDate(f); if (d && d.getTime() < cutoff) { try { await fs.promises.unlink(path.join(dir, f)); fs.promises.unlink(path.join(dir, f + '.meta.json')).catch(() => {}); deleted.push(f); } catch (e) { log.warn('[backup] could not delete', f, e.message); } } }
  return deleted;
}

async function listBackupFiles(dir) {
  let names = []; try { names = await fs.promises.readdir(dir); } catch (e) { return []; }
  const out = [];
  for (const f of names) { const d = backupNameDate(f); if (!d) continue; try { const st = await fs.promises.stat(path.join(dir, f)); const meta = await readBackupMeta(dir, f); out.push({ name: f, size: st.size, createdAt: d.toISOString(), kind: BACKUP_NAME_RE.exec(f)[7], ...(meta ? { checksum: meta.fileSha256, appVersion: meta.appVersion, createdBy: meta.createdBy, verified: !!meta.verified } : {}) }); } catch (e) { /* vanished */ } }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function runBackupJob(kind, by) {
  if (backupBusy) return { ok: false, at: new Date().toISOString(), kind, error: 'Another backup or restore is already running.' };
  backupBusy = true; const at = new Date().toISOString();
  try {
    const w = await writeBackupFile(kind, by); const cfg = await backupConfig(); const deleted = await pruneBackups(w.dir, cfg.retentionDays);
    const res = { ok: true, at, kind, file: w.name, size: w.size, dir: w.dir, deleted };
    await setSetting('backup.lastRun', JSON.stringify(res)); if (kind === 'auto') await setSetting('backup.lastAutoOk', at);
    auditLog(null, 'BACKUP_CREATE', { username: by || 'system', entity: 'backup', entityId: w.name, details: { kind, size: w.size, sha256: w.meta && w.meta.fileSha256, appVersion: APP_VERSION } });
    log.info(`[backup] ${kind} backup saved: ${path.join(w.dir, w.name)} (${w.size} bytes)${deleted.length ? `; removed old: ${deleted.join(', ')}` : ''}`);
    return res;
  } catch (e) {
    const res = { ok: false, at, kind, error: e.message }; log.error('[backup] FAILED:', e.message);
    auditLog(null, 'BACKUP_CREATE', { username: by || 'system', entity: 'backup', status: 'failure', details: { kind, error: String(e.message).slice(0, 300) } });
    try { await setSetting('backup.lastRun', JSON.stringify(res)); } catch (e2) { /* settings table unavailable */ }
    return res;
  } finally { backupBusy = false; }
}

function nextBackupAt(from = new Date()) { const [h, m] = BACKUP_TIME.split(':').map(Number); const t = new Date(from); t.setHours(h, m, 0, 0); if (t <= from) t.setDate(t.getDate() + 1); return t; }
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  const at = nextBackupAt(new Date(Date.now() + 1000));          // +1 s: a timer firing a few ms early can never schedule the same minute twice
  backupTimer = setTimeout(async () => {
    try { const cfg = await backupConfig(); if (cfg.enabled) await runBackupJob('auto', 'scheduler'); else log.info('[backup] scheduled run skipped (auto backup is switched off)'); } catch (e) { log.error('[backup] scheduler error:', e.message); }
    scheduleBackup();
  }, Math.min(Math.max(at.getTime() - Date.now(), 1000), 2147483000));
}
function startBackupScheduler() {
  scheduleBackup();
  // If the server was off at backup time, take one shortly after it starts (only when no automatic backup happened in the last 25 h)
  if (String(process.env.BACKUP_CATCHUP || 'on').toLowerCase() !== 'off') {
    setTimeout(async () => {
      try {
        const cfg = await backupConfig(); if (!cfg.enabled) return;
        const last = await getSetting('backup.lastAutoOk', ''); const age = last ? Date.now() - new Date(last).getTime() : Infinity;
        if (age > 25 * 3600 * 1000) { log.info('[backup] no automatic backup in the last 25 h - taking one now'); await runBackupJob('auto', 'catch-up'); }
      } catch (e) { log.error('[backup] catch-up error:', e.message); }
    }, Number(process.env.BACKUP_CATCHUP_DELAY_MS) || 20000);
  }
}

// ---- reading + checking a backup file (nothing is changed here) ----
function parseBackupBuffer(buf) {
  let raw; try { raw = zlib.gunzipSync(buf); } catch (e) { throw httpErr(400, 'This is not a DC Dashboard backup file (it could not be decompressed).'); }
  let m; try { m = JSON.parse(raw.toString('utf8')); } catch (e) { throw httpErr(400, 'The backup file is damaged (its content cannot be read).'); }
  if (!m || m.format !== BACKUP_FORMAT) throw httpErr(400, 'This is not a DC Dashboard backup file.');
  if (m.version !== BACKUP_VERSION) throw httpErr(400, `Unsupported backup version ${m.version}.`);
  if (m.scope === 'site') throw httpErr(400, 'This file is a location export (one location\'s data only, made by a normal user). It cannot be used to restore - only a full backup made by the Admin can.');
  if (!m.tables || typeof m.tables !== 'object' || Array.isArray(m.tables)) throw httpErr(400, 'The backup file is incomplete (no data tables).');
  const files = m.files && typeof m.files === 'object' && !Array.isArray(m.files) ? m.files : {};
  if (crypto.createHash('sha256').update(JSON.stringify({ tables: m.tables, files })).digest('hex') !== m.sha256) throw httpErr(400, 'The backup file is damaged or was modified (checksum mismatch). Nothing was changed.');
  for (const [t, rows] of Object.entries(m.tables)) { if (!BACKUP_TABLES.includes(t)) throw httpErr(400, `The backup contains an unknown table "${t}".`); if (!Array.isArray(rows)) throw httpErr(400, `Table "${t}" in the backup is not valid.`); }
  if (m.tables.users && !m.tables.users.some((u) => u.role === 'Admin' && u.status === 'Active')) throw httpErr(400, 'Refused: this backup has no active Admin user, so nobody could log in after restoring it.');
  for (const f of Object.keys(files)) if (!BACKUP_SAFE_FILE_RE.test(f) || typeof files[f] !== 'string') throw httpErr(400, `The backup contains an unsafe file name "${String(f).slice(0, 40)}".`);
  // PHASE-1: structural validation - every row is a plain record, and the recorded row counts match what is really inside
  for (const [t, rows] of Object.entries(m.tables)) {
    if (rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw httpErr(400, `Table "${t}" in the backup contains an invalid row.`);
    if (m.counts && typeof m.counts[t] === 'number' && m.counts[t] !== rows.length) throw httpErr(400, `Table "${t}" in the backup is incomplete (expected ${m.counts[t]} rows, found ${rows.length}). Nothing was changed.`);
  }
  if (m.fileCount != null && Number(m.fileCount) !== Object.keys(files).length) throw httpErr(400, 'The backup file list is incomplete (attachment count mismatch). Nothing was changed.');
  return m;
}
async function currentCounts() { const out = {}; for (const t of BACKUP_TABLES) { const [[r]] = await pool.query(`SELECT COUNT(*) AS c FROM \`${t}\``); out[t] = r.c; } return out; }

// ---- restore: all or nothing ----
async function restoreManifest(m, by) {
  const restored = {}, untouched = [];
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of BACKUP_TABLES) {
      const rows = m.tables[t];
      if (!rows) { untouched.push(t); continue; }                                   // an older backup without this table: leave the current one alone
      const [cols] = await conn.query(`SHOW COLUMNS FROM \`${t}\``); const known = new Set(cols.map((c) => c.Field));
      await conn.query(t === 'app_settings' ? "DELETE FROM `app_settings` WHERE k NOT LIKE 'license.%'" : `DELETE FROM \`${t}\``);   // keep this machine's own trial record
      const rowsIn = t === 'app_settings' ? rows.filter((r) => !String(r && r.k || '').startsWith('license.')) : rows;
      if (rowsIn.length) {
        const use = Object.keys(rowsIn[0]).filter((c) => known.has(c));
        for (let i = 0; i < rowsIn.length; i += 300) {
          const chunk = rowsIn.slice(i, i + 300);
          await conn.query(`INSERT INTO \`${t}\` (${use.map((c) => `\`${c}\``).join(',')}) VALUES ?`, [chunk.map((r) => use.map((c) => (r[c] === undefined ? null : r[c])))]);
        }
      }
      restored[t] = rows.length;
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.commit();
  } catch (e) { try { if (conn) await conn.rollback().catch(() => {}); } catch (e2) { /* connection lost */ } throw httpErr(500, `Restore failed and was rolled back - your current data is unchanged. (${e.message})`); }
  finally { try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (e) { /* ignore */ } if (conn) conn.release(); }
  // uploaded DC / Invoice documents
  let filesRestored = 0; fs.mkdirSync(MOVEMENTS_UPLOAD_DIR, { recursive: true });
  for (const [name, b64] of Object.entries(m.files || {})) { try { fs.writeFileSync(safeUploadPath(name), Buffer.from(b64, 'base64')); filesRestored++; } catch (e) { log.warn('[restore] could not write file', name, e.message); } }
  // Nothing is edited after the restore: what comes back is exactly what was in the backup file.
  return { restored, untouched, filesRestored };
}
function backupSummary(m) { return { createdAt: m.createdAt, createdBy: m.createdBy, kind: m.kind, counts: m.counts || Object.fromEntries(Object.entries(m.tables).map(([t, r]) => [t, r.length])), fileCount: Object.keys(m.files || {}).length, tablesIncluded: Object.keys(m.tables) }; }


// ===== Server connectivity (cable inventory), hardware details and power summary =====
// Connectivity: one row per server SERIAL NUMBER, loaded from the cable-inventory sheets
// (AZ-1 / AZ-2 layouts). The serial in the sheet is matched to assets.serial_number; nothing
// in the assets table is ever changed by an import. Usernames, passwords and the Handover team
// column in the sheets are deliberately never read or stored.
const CONN_FIELDS = [
  ['category', 'category'], ['iloIp', 'ilo_ip'], ['subnetMask', 'subnet_mask'], ['gateway', 'gateway'],
  ['iloCable', 'ilo_cable'], ['iloPort', 'ilo_port'], ['switchSnIp', 'switch_sn_ip'], ['dataCable', 'data_cable'],
  ['backupCable', 'backup_cable'], ['provisioningCable', 'provisioning_cable'], ['hbtCable', 'hbt_cable'],
  ['replicationCable', 'replication_cable'], ['storageCable', 'storage_cable'], ['storagePort', 'storage_port'],
  ['storageBlade', 'storage_blade'], ['remarks', 'remarks'],
];
const connSerialKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
const connFirstNumber = (v) => { const m = String(v == null ? '' : v).match(/\d+/); return m ? parseInt(m[0], 10) : null; };
const connClean = (v, max) => { const s = String(v == null ? '' : v).replace(/\u0000/g, '').trim(); return s.length > max ? s.slice(0, max) : s; };
function mapConnectivityRow(r) {
  const o = { serialNumber: r.serial_number, site: r.site, zone: r.zone, sheetRackNo: r.sheet_rack_no, sheetUPosition: r.sheet_u_position, sourceFile: r.source_file, updatedBy: r.updated_by, updatedAt: r.updated_at };
  CONN_FIELDS.forEach(([k, c]) => { o[k] = r[c] || ''; });
  return o;
}
async function loadAssetForConnectivity(req, id) {
  const [rows] = await pool.query('SELECT id, site, zone, rack_no, position, serial_number, manufacturer, model, device_name FROM assets WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw httpErr(404, 'Asset not found');
  await assertSiteAccess(req.user, rows[0].site);
  return rows[0];
}

app.post('/api/connectivity/import', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const dryRun = req.body.dryRun !== false; // anything but an explicit false only previews
    const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows[] is required' });
    if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows (max 5000 per import)' });
    const sourceName = connClean(req.body.sourceName, 255);
    const allowed = await getAllowedSitesForUser(req.user);
    const keys = [...new Set(rows.map((r) => connSerialKey(r && r.serialNumber)).filter(Boolean))];
    const byKey = new Map();
    for (let i = 0; i < keys.length; i += 500) {
      const [found] = await pool.query("SELECT id, site, zone, rack_no, position, serial_number, device_name FROM assets WHERE REPLACE(UPPER(TRIM(serial_number)), ' ', '') IN (?)", [keys.slice(i, i + 500)]);
      found.forEach((a) => { byKey.set(connSerialKey(a.serial_number), a); });
    }
    const counts = { total: rows.length, ready: 0, noSerial: 0, notInInventory: 0, duplicateInFile: 0, warnings: 0 };
    const issues = [];
    const seen = new Set();
    const toSave = [];
    rows.forEach((r, idx) => {
      const rowNo = (r && Number(r.rowNo)) || idx + 2;
      const key = connSerialKey(r && r.serialNumber);
      if (!key) { counts.noSerial++; if (issues.length < 1000) issues.push({ row: rowNo, serial: '', rack: connClean(r && r.rackNo, 40), u: connClean(r && r.uPosition, 40), status: 'no_serial', message: 'Serial number is blank in the sheet - not saved' }); return; }
      if (seen.has(key)) { counts.duplicateInFile++; if (issues.length < 1000) issues.push({ row: rowNo, serial: key, status: 'duplicate_in_file', message: 'Same serial number appears again in the sheet - only the first row is used' }); return; }
      seen.add(key);
      const a = byKey.get(key);
      if (!a || !allowed.includes(a.site)) { counts.notInInventory++; if (issues.length < 1000) issues.push({ row: rowNo, serial: key, rack: connClean(r.rackNo, 40), u: connClean(r.uPosition, 40), status: 'not_in_inventory', message: 'Serial number not found in inventory - not saved' }); return; }
      const warns = [];
      const sheetRack = connClean(r.rackNo, 40).toUpperCase();
      if (sheetRack && String(a.rack_no || '').trim().toUpperCase() !== sheetRack) warns.push(`Sheet rack ${sheetRack}, inventory rack ${a.rack_no || '-'}`);
      const su = connFirstNumber(r.uPosition), au = connFirstNumber(a.position);
      if (su !== null && au !== null && su !== au) warns.push(`Sheet U ${r.uPosition}, inventory U ${a.position}`);
      counts.ready++;
      if (warns.length) { counts.warnings++; if (issues.length < 1000) issues.push({ row: rowNo, serial: key, status: 'warning', message: warns.join('; ') + ' - saved, please verify', deviceName: a.device_name || '' }); }
      toSave.push({ a, r });
    });
    if (dryRun) return res.json({ dryRun: true, counts, issues });
    if (!toSave.length) return res.json({ dryRun: false, saved: 0, counts, issues });
    const cols = ['serial_number', 'site', 'zone', 'sheet_rack_no', 'sheet_u_position', ...CONN_FIELDS.map((f) => f[1]), 'source_file', 'updated_by'];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < toSave.length; i += 200) {
        const chunk = toSave.slice(i, i + 200).map(({ a, r }) => [a.serial_number, a.site, a.zone || 'AZ-1', connClean(r.rackNo, 40), connClean(r.uPosition, 40), ...CONN_FIELDS.map((f) => connClean(r[f[0]], ['category', 'iloIp', 'subnetMask', 'gateway'].includes(f[0]) ? 255 : 4000)), sourceName, req.user.username || null]);
        await conn.query(`INSERT INTO asset_connectivity (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ${cols.filter((c) => c !== 'serial_number').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`, [chunk]);
      }
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch (e2) { /* ignore */ } throw e; }
    finally { conn.release(); }
    res.json({ dryRun: false, saved: toSave.length, counts, issues });
  } catch (e) { sendErr(res, e); }
});

app.get('/api/assets/:id/connectivity', authenticateToken, async (req, res) => {
  try {
    const a = await loadAssetForConnectivity(req, req.params.id);
    const [rows] = a.serial_number ? await pool.query('SELECT * FROM asset_connectivity WHERE serial_number = ? LIMIT 1', [a.serial_number]) : [[]];
    res.json({ connectivity: rows.length ? mapConnectivityRow(rows[0]) : null });
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/assets/:id/connectivity', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const a = await loadAssetForConnectivity(req, req.params.id);
    const [r] = await pool.query('DELETE FROM asset_connectivity WHERE serial_number = ?', [a.serial_number]);
    res.json({ deleted: r.affectedRows || 0 });
  } catch (e) { sendErr(res, e); }
});

// ---- Hardware details (Dell OME / HPE OneView), pulled on demand and cached in the database ----
// Hardware-details providers. To support another manufacturer later, add ONE entry here: how to recognise
// the manufacturer text on the asset, the monitoring config key (same *_HOST/_USER/_PASS .env scheme), and a
// pull function that returns { vendor, summary: [{label, value}] }.
const HW_PROVIDERS = [
  { key: 'OME', label: 'Dell OME', match: /dell/i, pull: (site, zone, serial) => pullOmeHardware(site, zone, serial) },
  { key: 'ONEVIEW', label: 'HPE OneView', match: /\bhpe?\b|hewlett/i, pull: (site, zone, serial) => pullOneviewHardware(site, zone, serial) },
];
function hwProviderFor(manufacturer) { const m = String(manufacturer || ''); return HW_PROVIDERS.find((p) => p.match.test(m)) || null; }
const HW_VENDOR_LABEL = Object.fromEntries(HW_PROVIDERS.map((p) => [p.key, p.label]));
function hwSizeToGb(v) {
  const m = String(v == null ? '' : v).replace(/,/g, '').match(/([\d.]+)\s*(TB|GB|MB|T|G|M)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]); if (!isFinite(n)) return null;
  const u = (m[2] || 'GB').toUpperCase();
  return u.startsWith('T') ? n * 1024 : u.startsWith('M') ? n / 1024 : n;
}
function hwFmtGb(gb) { if (gb === null || gb === undefined || !isFinite(gb)) return null; return gb >= 1024 ? `${(gb / 1024).toFixed(gb % 1024 === 0 ? 0 : 2)} TB` : `${Math.round(gb * 100) / 100} GB`; }
function hwCount(items, keyFn) { const m = new Map(); items.forEach((i) => { const k = keyFn(i) || 'Unknown'; m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()]; }

async function omeGetJson(session, pathAndQuery) {
  const res = await monitorFetch(`${session.host}${pathAndQuery}`, { headers: { 'X-Auth-Token': session.token } });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json().catch(() => null) };
}
function omeInfoList(data) {
  let a = Array.isArray(data && data.InventoryInfo) ? data.InventoryInfo : [];
  if (!a.length && Array.isArray(data && data.value)) a = data.value.flatMap((x) => (Array.isArray(x && x.InventoryInfo) ? x.InventoryInfo : []));
  return a;
}
// ---- NIC port helpers: the appliances nest MAC / speed in different places, so look through the port object ----
const HW_MAC_RE = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
function hwFindMacs(obj, depth, out) {
  depth = depth || 0; out = out || [];
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') { const t = v.trim(); if (/mac/i.test(k) && HW_MAC_RE.test(t) && !/^(00[:-]){5}00$/i.test(t)) out.push({ k, v: t.toUpperCase() }); }
    else if (v && typeof v === 'object') hwFindMacs(v, depth + 1, out);
  }
  return out;
}
function hwPickMacs(obj) {
  const all = hwFindMacs(obj);
  const cur = all.filter((x) => /current/i.test(x.k));
  const plain = all.filter((x) => !/iscsi|fcoe|virtual/i.test(x.k));
  const use = cur.length ? cur : (plain.length ? plain : all);
  return [...new Set(use.map((x) => x.v))].join(', ');
}
function hwFindSpeed(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 3) return '';
  for (const [k, v] of Object.entries(obj)) {
    if (/speed/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '' && String(v) !== '0') {
      if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) { const n = Number(v); const g = (/mbps/i.test(k) || n >= 1000) ? n / 1000 : n; return `${Math.round(g * 100) / 100} Gbps`; }
      return String(v).trim();
    }
  }
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = hwFindSpeed(v, depth + 1); if (r) return r; } }
  return '';
}
// No speed reported by the appliance: fall back to the rating written in the adapter's name (e.g. "10/25Gb 2-port") and say so.
function hwRatedSpeedFromName(name) {
  const m = String(name || '').match(/(\d+(?:\/\d+)*)\s*G(?:b|bps|be|bit)?\b/i);
  return m ? `${m[1]} Gb (rated)` : '';
}
async function pullOmeHardware(site, zone, serial) {
  const session = await getOmeToken(site, zone);
  if (!session) throw httpErr(400, `Dell OME is not configured for ${site} / ${zone}`);
  const filter = encodeURIComponent(`DeviceServiceTag eq '${serial}'`);
  const found = await omeGetJson(session, `/api/DeviceService/Devices?$filter=${filter}`);
  if (!found.ok) throw httpErr(502, `Dell OME device lookup failed (HTTP ${found.status})`);
  const dev = found.data && Array.isArray(found.data.value) ? found.data.value[0] : null;
  if (!dev) throw httpErr(404, `Serial ${serial} was not found on Dell OME for ${site} / ${zone}`);
  const id = dev.Id;
  const inv = (dev.DeviceManagement && dev.DeviceManagement[0]) || {};
  const [cpuR, memR, diskR, nicR, swR, osR] = await Promise.all(['serverProcessors', 'serverMemoryDevices', 'serverArrayDisks', 'serverNetworkInterfaces', 'deviceSoftware', 'serverOperatingSystems']
    .map((t) => omeGetJson(session, `/api/DeviceService/Devices(${id})/InventoryDetails('${t}')`).catch(() => ({ ok: false, data: null }))));
  const summary = [];
  const add = (label, value) => { if (value !== null && value !== undefined && String(value).trim() !== '') summary.push({ label, value: String(value) }); };
  add('Model', dev.Model);
  add('Service tag', dev.DeviceServiceTag || serial);
  add('Power', OME_POWER_MAP[dev.PowerState] || 'Unknown');
  add('Health', OME_HEALTH_MAP[dev.Status] || 'Unknown');
  add('Management IP', inv.NetworkAddress);
  const sw = omeInfoList(swR.data);
  const swText = (c) => [c.DeviceDescription, c.SubDeviceType, c.SoftwareType, c.Name, c.Description].filter(Boolean).join(' ');
  const bios = sw.find((c) => /bios|system\s*rom/i.test(swText(c)) && !/redundant|backup|recovery|previous|rollback|golden|staged/i.test(swText(c)));
  const idrac = sw.find((c) => /idrac|integrated\s+dell\s+remote/i.test(swText(c)) && !/service\s*module|installer|backup|previous|rollback/i.test(swText(c)));
  add('BIOS version', bios && bios.Version);
  add('iDRAC firmware', idrac && idrac.Version);
  const cpus = omeInfoList(cpuR.data);
  if (cpus.length) add('CPU', hwCount(cpus, (c) => String(c.ModelName || c.Family || '').replace(/\s+/g, ' ').trim()).map(([n, c]) => { const one = cpus.find((x) => String(x.ModelName || x.Family || '').replace(/\s+/g, ' ').trim() === n); const cores = one && (one.NumberOfEnabledCores || one.NumberOfCores); return `${c} × ${n}${cores ? ` (${cores} cores each)` : ''}`; }).join('; '));
  const dimms = omeInfoList(memR.data).filter((m) => hwSizeToGb(m.Size) > 0 || Number(m.Size) > 0);
  if (dimms.length) {
    // OME reports DIMM Size in MB (e.g. 32768); a value that already carries a unit is honoured as written.
    const gbOf = (m) => (typeof m.Size === 'number' || /^\d+$/.test(String(m.Size).trim())) ? Number(m.Size) / 1024 : hwSizeToGb(m.Size);
    const total = dimms.reduce((s, m) => s + (gbOf(m) || 0), 0);
    add('Memory', `${hwFmtGb(total)} (${dimms.length} DIMM${dimms.length === 1 ? '' : 's'})`);
  }
  const disks = omeInfoList(diskR.data);
  if (disks.length) {
    const total = disks.reduce((s, d) => s + (hwSizeToGb(d.Size) || 0), 0);
    const kinds = hwCount(disks, (d) => d.MediaType || d.BusProtocol).map(([k, c]) => `${c} × ${k}`).join(', ');
    add('Storage', `${disks.length} disk${disks.length === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}${total ? `, ${hwFmtGb(total)} raw` : ''}`);
  }
  const nics = omeInfoList(nicR.data);
  if (nics.length) { const ports = nics.reduce((s, n) => s + (Array.isArray(n.Ports) ? n.Ports.length : 0), 0); add('Network', `${nics.length} adapter${nics.length === 1 ? '' : 's'}${ports ? `, ${ports} port${ports === 1 ? '' : 's'}` : ''}`); }
  // Per-adapter detail: name, part number, firmware (matched from the device software list), and each port's MAC / speed / link.
  const GENERIC_NIC_WORDS = /^(network|adapter|ethernet|controller|card|port|dual|quad|gigabit|family|series|device)$/i;
  const nicSw = sw.filter((c) => /network|ethernet|\bnic\b|nx|e8\d\d|connectx|broadcom|intel|mellanox|qlogic|emulex|marvell/i.test(swText(c)) && !/idrac|bios|lifecycle|diagnostic|driver pack|cpld|backplane|raid|perc|power supply|chassis/i.test(swText(c)));
  const nicList = nics.map((n) => {
    const firstPort = (Array.isArray(n.Ports) ? n.Ports : []).find((q) => q && (q.ProductName || q.Description));
    const product = String(n.ProductName || n.Description || (firstPort && (firstPort.ProductName || firstPort.Description)) || '').trim();
    const name = [n.VendorName && !product.toLowerCase().includes(String(n.VendorName).toLowerCase()) ? n.VendorName : '', product].filter(Boolean).join(' ').trim() || 'Network adapter';
    const words = product.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC_NIC_WORDS.test(w));
    const fwEntry = nicSw.find((c) => { const t = swText(c).toLowerCase(); return words.some((w) => t.includes(w)); });
    const ports = (Array.isArray(n.Ports) ? n.Ports : []).map((p) => ({
      id: String(p.PortId || p.PortNumber || p.Fqdd || '').trim(),
      mac: hwPickMacs(p),
      speed: hwFindSpeed(p) || hwRatedSpeedFromName(name),
      link: String(p.LinkStatus || p.LinkStatusDescription || '').trim(),
      type: '',
    }));
    return { name, id: String(n.NicId || n.Fqdd || n.Slot || '').trim(), partNumber: String(n.PartNumber || '').trim(), firmware: fwEntry ? String(fwEntry.Version || '').trim() : '', ports };
  });
  const osr = omeInfoList(osR.data)[0];
  add('Operating system', osr && [osr.OsName, osr.OsVersion].filter(Boolean).join(' '));
  return { vendor: 'Dell OME', summary, nics: nicList };
}

// ---- HPE port link status ----
// OneView does not report whether a server port is Up or Down. It can, however, hand out a session for the server's own iLO
// (GET <server-hardware uri>/remoteConsoleUrl); the iLO Redfish API then lists every port with LinkStatus and speed.
// Best effort: if the iLO cannot be reached from this server, the rest of the hardware details are still returned, with a note.
const ILO_SCHEME = process.env.ILO_SCHEME === 'http' ? 'http' : 'https';
function iloMacKey(v) { return String(v || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase(); }
function iloCollectPorts(obj, out, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => iloCollectPorts(x, out, depth + 1)); return out; }
  const link = obj.LinkStatus;
  const macs = [obj.MacAddress, obj.MACAddress, obj.PermanentMACAddress, ...(Array.isArray(obj.AssociatedNetworkAddresses) ? obj.AssociatedNetworkAddresses : [])].filter((x) => typeof x === 'string' && HW_MAC_RE.test(x.trim()));
  if (typeof link === 'string' && macs.length) {
    const mbps = Number(obj.SpeedMbps || obj.CurrentLinkSpeedMbps || 0) || 0;
    out.push({ keys: macs.map(iloMacKey), link: /no ?link|down/i.test(link) ? 'Down' : (/up/i.test(link) ? 'Up' : link), mbps });
  }
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') iloCollectPorts(v, out, depth + 1); });
  return out;
}
async function iloPortLinks(session, hdrs, serverUri) {
  const out = { ports: [], note: '' };
  try {
    if (!/^\/rest\/server-hardware\/[A-Za-z0-9_-]+$/.test(serverUri || '')) { out.note = 'Link status unavailable (unexpected server reference)'; return out; }
    const r = await monitorFetch(`${session.host}${serverUri}/remoteConsoleUrl`, { headers: hdrs });
    if (!r.ok) { out.note = `Link status unavailable: OneView did not give an iLO session (HTTP ${r.status})`; return out; }
    const j = await r.json().catch(() => ({}));
    const url = String(j.remoteConsoleUrl || '');
    let addr = (url.match(/addr=([^&\s]+)/) || [])[1] || '';
    const key = (url.match(/sessionkey=([^&\s]+)/) || [])[1] || '';
    try { addr = decodeURIComponent(addr); } catch (e) { /* keep raw */ }
    if (!addr || !key) { out.note = 'Link status unavailable: OneView returned no iLO address / session'; return out; }
    if (!/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(addr)) { out.note = 'Link status unavailable: unexpected iLO address'; return out; }
    const base = `${ILO_SCHEME}://${addr}`;
    const get = async (path) => {
      const rr = await monitorFetch(base + path, { headers: { 'X-Auth-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      return rr.ok ? rr.json().catch(() => null) : null;
    };
    const base1 = await get('/redfish/v1/Systems/1/BaseNetworkAdapters?$expand=.');
    if (base1) iloCollectPorts(base1, out.ports);
    if (!out.ports.length) {
      const ad = await get('/redfish/v1/Chassis/1/NetworkAdapters?$expand=.');
      if (ad) {
        iloCollectPorts(ad, out.ports);
        if (!out.ports.length) {
          const uris = [];
          (function walk(o, d) { if (!o || typeof o !== 'object' || d > 6) return; if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; } if (o.NetworkPorts && o.NetworkPorts['@odata.id']) uris.push(o.NetworkPorts['@odata.id']); if (o.Links && Array.isArray(o.Links.NetworkPorts)) o.Links.NetworkPorts.forEach((x) => x && x['@odata.id'] && uris.push(x['@odata.id'])); Object.values(o).forEach((v) => walk(v, d + 1)); })(ad, 0);
          for (const u of [...new Set(uris)].slice(0, 32)) {
            if (!/^\/redfish\/v1\/[A-Za-z0-9_\/.-]+$/.test(u)) continue;
            const pj = await get(u + (/NetworkPorts\/?$/i.test(u) ? '?$expand=.' : ''));
            if (pj) iloCollectPorts(pj, out.ports);
          }
        }
      }
    }
    if (!out.ports.length) out.note = 'Link status unavailable: the iLO answered but listed no port link data (older iLO firmware?)';
  } catch (e) {
    out.note = `Link status unavailable: iLO not reachable from this server (${String(e && e.message || e).slice(0, 80)})`;
  }
  return out;
}

async function pullOneviewHardware(site, zone, serial) {
  const session = await getOneviewSession(site, zone);
  if (!session) throw httpErr(400, `HPE OneView is not configured for ${site} / ${zone}`);
  const hdrs = { Auth: session.sessionId, 'X-API-Version': String(session.apiVersion) };
  const filter = encodeURIComponent(`"serialNumber='${serial}'"`);
  const res = await monitorFetch(`${session.host}/rest/server-hardware?filter=${filter}&count=2`, { headers: hdrs });
  if (!res.ok) throw httpErr(502, `HPE OneView device lookup failed (HTTP ${res.status})`);
  const data = await res.json().catch(() => null);
  const s = data && Array.isArray(data.members) ? data.members[0] : null;
  if (!s) throw httpErr(404, `Serial ${serial} was not found on HPE OneView for ${site} / ${zone}`);
  const summary = [];
  const add = (label, value) => { if (value !== null && value !== undefined && String(value).trim() !== '') summary.push({ label, value: String(value) }); };
  const n = normalizeOneviewServer(s);
  add('Model', s.model);
  add('Serial number', s.serialNumber || serial);
  add('Power', n.powerState);
  add('Health', n.healthStatus);
  add('Management IP', n.ipAddress);
  add('System ROM (BIOS)', s.romVersion);
  add('iLO', [s.mpModel, s.mpFirmwareVersion].filter(Boolean).join(' '));
  if (s.processorType || s.processorCount) add('CPU', `${s.processorCount || '?'} × ${String(s.processorType || '').replace(/\s+/g, ' ').trim()}${s.processorCoreCount ? ` (${s.processorCoreCount} cores each)` : ''}${s.processorSpeedMhz ? `, ${s.processorSpeedMhz} MHz` : ''}`);
  if (s.memoryMb) add('Memory', hwFmtGb(Number(s.memoryMb) / 1024));
  const slots = (s.portMap && Array.isArray(s.portMap.deviceSlots)) ? s.portMap.deviceSlots : [];
  if (slots.length) { const ports = slots.reduce((t, d) => t + (Array.isArray(d.physicalPorts) ? d.physicalPorts.length : 0), 0); add('Network', `${slots.length} adapter${slots.length === 1 ? '' : 's'}${ports ? `, ${ports} port${ports === 1 ? '' : 's'}` : ''}`); }
  add('Server profile', s.serverProfileUri ? 'Assigned' : 'Not assigned');
  add('Form factor', s.formFactor);
  const nicList = slots.map((d, i) => ({
    name: String(d.deviceName || `Adapter ${d.slotNumber != null ? d.slotNumber : i + 1}`).trim(),
    id: String(d.location || (d.slotNumber != null ? `Slot ${d.slotNumber}` : '')).trim(),
    partNumber: '', firmware: '',
    ports: (Array.isArray(d.physicalPorts) ? d.physicalPorts : []).map((p) => ({
      id: String(p.portNumber != null ? p.portNumber : '').trim(),
      mac: hwPickMacs(p) || String(p.wwn || '').trim(),
      speed: hwFindSpeed(p) || hwFindSpeed(d) || hwRatedSpeedFromName(d.deviceName),
      link: String(p.portStatus || p.linkStatus || '').trim(),
      type: String(p.type || '').trim(),
    })),
  }));
  // Link status + live speed from the iLO, matched to the OneView ports by MAC address.
  const ilo = await iloPortLinks(session, hdrs, s.uri);
  let linked = 0;
  if (ilo.ports.length) {
    nicList.forEach((nic) => nic.ports.forEach((q) => {
      const keys = String(q.mac || '').split(',').map(iloMacKey).filter(Boolean);
      const hit = ilo.ports.find((x) => x.keys.some((k) => keys.includes(k)));
      if (hit) { q.link = hit.link; if (hit.mbps) q.speed = `${Math.round(hit.mbps / 10) / 100} Gbps`; linked++; }
    }));
    if (!linked) ilo.note = 'Link status unavailable: the iLO ports could not be matched to the OneView ports by MAC address';
  }
  return { vendor: 'HPE OneView', summary, nics: nicList, nicNote: linked ? '' : ilo.note };
}

async function readHardwareCache(serial) {
  const [rows] = await pool.query('SELECT vendor, data, fetched_at, fetched_by FROM asset_hw_details WHERE serial_number = ? LIMIT 1', [serial]);
  if (!rows.length) return null;
  let parsed = {}; try { parsed = JSON.parse(rows[0].data || '{}'); } catch (e) { parsed = {}; }
  return { vendor: rows[0].vendor, summary: parsed.summary || [], nics: parsed.nics || [], nicNote: parsed.nicNote || '', fetchedAt: rows[0].fetched_at, fetchedBy: rows[0].fetched_by };
}

app.get('/api/assets/:id/hardware', authenticateToken, async (req, res) => {
  try {
    const a = await loadAssetForConnectivity(req, req.params.id);
    const prov = hwProviderFor(a.manufacturer);
    const hardware = a.serial_number ? await readHardwareCache(a.serial_number) : null;
    res.json({
      hardware,
      vendor: prov ? prov.label : null,
      supported: !!prov,
      configured: !!(prov && getMonitorConfig(prov.key, a.site, a.zone || 'AZ-1')),
      canSync: ['Admin', 'Operator'].includes(req.user.role),
    });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/assets/:id/hardware/sync', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const a = await loadAssetForConnectivity(req, req.params.id);
    const serial = String(a.serial_number || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(serial)) return res.status(400).json({ error: 'This asset has no usable serial number' });
    const prov = hwProviderFor(a.manufacturer);
    if (!prov) return res.status(400).json({ error: `Hardware details are not available for manufacturer "${a.manufacturer || 'unknown'}" yet (supported: ${HW_PROVIDERS.map((p) => p.label).join(', ')})` });
    const zone = a.zone || 'AZ-1';
    const result = await dedupeInFlight(`HW|${prov.key}|${serial}`, () => prov.pull(a.site, zone, serial));
    await pool.query('INSERT INTO asset_hw_details (serial_number, vendor, site, zone, data, fetched_by) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE vendor = VALUES(vendor), site = VALUES(site), zone = VALUES(zone), data = VALUES(data), fetched_by = VALUES(fetched_by), fetched_at = CURRENT_TIMESTAMP',
      [serial, result.vendor, a.site, zone, JSON.stringify({ summary: result.summary, nics: result.nics || [], nicNote: result.nicNote || '' }), req.user.username || null]);
    res.json({ hardware: await readHardwareCache(serial) });
  } catch (e) { sendErr(res, e); }
});

// ---- Edit one server's connectivity by hand (new server, or a changed cable) ----
app.put('/api/assets/:id/connectivity', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
  try {
    const a = await loadAssetForConnectivity(req, req.params.id);
    const serial = String(a.serial_number || '').trim();
    if (!serial) return res.status(400).json({ error: 'This asset has no serial number' });
    const body = req.body || {};
    const SHORT = ['category', 'iloIp', 'subnetMask', 'gateway'];
    const vals = CONN_FIELDS.map((f) => connClean(body[f[0]], SHORT.includes(f[0]) ? 255 : 4000));
    if (!vals.some((v) => v)) return res.status(400).json({ error: 'Enter at least one connectivity detail (or use Remove connectivity)' });
    const cols = ['serial_number', 'site', 'zone', 'sheet_rack_no', 'sheet_u_position', ...CONN_FIELDS.map((f) => f[1]), 'source_file', 'updated_by'];
    await pool.query(`INSERT INTO asset_connectivity (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ${cols.filter((c) => c !== 'serial_number').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`,
      [[[serial, a.site, a.zone || 'AZ-1', connClean(a.rack_no, 40), connClean(a.position, 40), ...vals, 'Edited in app', req.user.username || null]]]);
    const [rows] = await pool.query('SELECT * FROM asset_connectivity WHERE serial_number = ? LIMIT 1', [serial]);
    res.json({ connectivity: rows.length ? mapConnectivityRow(rows[0]) : null });
  } catch (e) { sendErr(res, e); }
});

// ---- Exports ----
// scope=data (default): every server that has saved connectivity. scope=missing: servers that have none yet
// (a blank sheet to fill in and import back). Both are limited to the user's permitted locations.
app.get('/api/connectivity/export', authenticateToken, async (req, res) => {
  try {
    const allowed = await getAllowedSitesForUser(req.user);
    const sites = allowed.length ? allowed : ['__none__'];
    const scope = req.query.scope === 'missing' ? 'missing' : 'data';
    const base = 'a.id AS asset_id, a.rack_type AS a_rack_type, a.mgmt_ip AS a_mgmt_ip, a.site AS a_site, a.zone AS a_zone, a.rack_no, a.position, a.hardware_type, a.manufacturer, a.model AS a_model, a.device_name, a.serial_number AS a_serial';
    const sql = scope === 'data'
      ? `SELECT c.*, ${base} FROM asset_connectivity c JOIN assets a ON a.serial_number = c.serial_number WHERE a.site IN (?) ORDER BY a.site, a.zone, a.rack_no, a.position LIMIT 20000`
      : `SELECT ${base} FROM assets a LEFT JOIN asset_connectivity c ON c.serial_number = a.serial_number WHERE c.serial_number IS NULL AND a.site IN (?) AND a.serial_number IS NOT NULL AND a.serial_number <> '' AND a.hardware_type REGEXP 'server' AND COALESCE(a.lifecycle_status, 'Active') = 'Active' ORDER BY a.site, a.zone, a.rack_no, a.position LIMIT 20000`;
    let rows;
    try { [rows] = await pool.query(sql, [sites]); }
    catch (e) { if (scope === 'missing' && /lifecycle_status/.test(e.message)) { [rows] = await pool.query(sql.replace(" AND COALESCE(a.lifecycle_status, 'Active') = 'Active'", ''), [sites]); } else throw e; }
    res.json({ scope, rows: rows.map((r) => {
      const o = { serialNumber: r.a_serial, site: r.a_site, zone: r.a_zone, rackNo: r.rack_no, rackType: r.a_rack_type || r.category || '', position: r.position, hardwareType: r.hardware_type, manufacturer: r.manufacturer, model: r.a_model, deviceName: r.device_name };
      CONN_FIELDS.forEach(([k, c]) => { o[k] = r[c] || ''; });
      if (!o.iloIp && r.a_mgmt_ip) o.iloIp = r.a_mgmt_ip; // the asset inventory already holds the iLO / management IP
      return o;
    }) });
  } catch (e) { sendErr(res, e); }
});

// Everything the "Export with Connectivity & H/W details" button needs in one call, keyed by serial number.
app.get('/api/connectivity/inventory-extras', authenticateToken, async (req, res) => {
  try {
    const allowed = await getAllowedSitesForUser(req.user);
    const sites = allowed.length ? allowed : ['__none__'];
    const [c] = await pool.query('SELECT * FROM asset_connectivity WHERE site IN (?)', [sites]);
    const [h] = await pool.query('SELECT serial_number, vendor, data, fetched_at FROM asset_hw_details WHERE site IN (?)', [sites]);
    const connectivity = {}; c.forEach((r) => { connectivity[connSerialKey(r.serial_number)] = mapConnectivityRow(r); });
    const hardware = {};
    h.forEach((r) => { let p = {}; try { p = JSON.parse(r.data || '{}'); } catch (e) { p = {}; } hardware[connSerialKey(r.serial_number)] = { vendor: r.vendor, fetchedAt: r.fetched_at, summary: p.summary || [], nics: p.nics || [] }; });
    res.json({ connectivity, hardware });
  } catch (e) { sendErr(res, e); }
});

// ---- Server power status (dashboard module) ----
// A pure cache reader: the numbers are recorded by the 30-minute auto-sync (recordPowerSnapshot) from the very
// same appliance call it already makes - opening the dashboard never contacts Dell OME / HPE OneView.
let powerLoadedFromDb = false;
async function ensurePowerSnapshotLoaded() {
  if (powerLoadedFromDb) return;
  powerLoadedFromDb = true;
  try {
    const raw = await getSetting('power_snapshot', '');
    if (raw && !Object.keys(powerSnapshot).length) { const p = JSON.parse(raw); if (p && typeof p === 'object') Object.assign(powerSnapshot, p); }
  } catch (e) { /* no snapshot yet */ }
}
app.get('/api/monitoring/power-summary', authenticateToken, async (req, res) => {
  try {
    await ensurePowerSnapshotLoaded();
    const allowed = await getAllowedSitesForUser(req.user);
    const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones WHERE site IN (?)', [allowed.length ? allowed : ['__none__']]);
    const sites = allowed.map((site) => {
      const zs = zoneRows.filter((z) => z.site === site);
      const out = { site, on: 0, off: 0, unknown: 0, total: 0, zonesConfigured: 0, zonesReported: 0, asOf: null, zones: [] };
      zs.forEach((z) => {
        HW_PROVIDERS.map((p) => p.key).forEach((vk) => {
          if (!getMonitorConfig(vk, z.site, z.zone)) return;
          out.zonesConfigured++;
          const snap = powerSnapshot[snapshotKey(vk, z.site, z.zone)];
          if (!snap) { out.zones.push({ zone: z.zone, vendor: HW_VENDOR_LABEL[vk], reported: false }); return; }
          out.zonesReported++;
          out.on += snap.on; out.off += snap.off; out.unknown += snap.unknown; out.total += snap.total;
          if (!out.asOf || snap.fetchedAt < out.asOf) out.asOf = snap.fetchedAt;
          out.zones.push({ zone: z.zone, vendor: HW_VENDOR_LABEL[vk], reported: true, on: snap.on, off: snap.off, unknown: snap.unknown, total: snap.total, fetchedAt: snap.fetchedAt });
        });
      });
      return out;
    });
    const stamps = sites.map((s) => s.asOf).filter(Boolean);
    const lastRunAt = lastAutoSyncAt ? lastAutoSyncAt.getTime() : (stamps.length ? Math.max(...stamps) : null);
    res.json({
      sites, lastRunAt, intervalMs: AUTO_SYNC_INTERVAL_MS,
      nextRunAt: lastAutoSyncAt ? lastAutoSyncAt.getTime() + AUTO_SYNC_INTERVAL_MS : null,
      running: autoSyncRunning,
      anyConfigured: sites.some((s) => s.zonesConfigured > 0),
    });
  } catch (e) { sendErr(res, e); }
});


// Firmware Compliance (dashboard module): a pure cache reader of what OME / OneView reported during the last 30-minute auto-sync.
app.get('/api/monitoring/firmware-compliance', authenticateToken, async (req, res) => {
  try {
    await ensureFwComplianceLoaded();
    const allowed = await getAllowedSitesForUser(req.user);
    const [zoneRows] = await pool.query('SELECT DISTINCT site, zone_name AS zone FROM zones WHERE site IN (?)', [allowed.length ? allowed : ['__none__']]);
    const rows = [], zones = [];
    zoneRows.forEach((z) => {
      ['OME', 'ONEVIEW'].forEach((vk) => {
        if (!getMonitorConfig(vk, z.site, z.zone)) return;
        const snap = fwComplianceCache[snapshotKey(vk, z.site, z.zone)];
        zones.push({ vendor: vk, site: z.site, zone: z.zone, reported: !!snap, fetchedAt: snap ? snap.fetchedAt : null, count: snap ? snap.items.length : 0 });
        if (snap) snap.items.forEach((it) => rows.push({ vendor: vk, site: z.site, zone: z.zone, ...it, fetchedAt: snap.fetchedAt }));
      });
    });
    res.json({ rows, zones, lastRunAt: lastAutoSyncAt ? lastAutoSyncAt.getTime() : null, intervalMs: AUTO_SYNC_INTERVAL_MS, running: autoSyncRunning });
  } catch (e) { sendErr(res, e); }
});

// ===== Location-scoped export (any signed-in user) =====
// A user restricted to one location can save a copy of THEIR location's data. It never contains the users table (no password hashes),
// other locations' data or the backup settings, and it cannot be used to restore (only a full Admin backup can).
const SCOPED_TABLES = [['locations', 'name'], ['zones', 'site'], ['racks', 'site'], ['floor_plans', 'site'], ['assets', 'site'], ['rack_components', 'site'], ['asset_connectivity', 'site'], ['asset_hw_details', 'site'], ['issues', 'site'], ['dc_activities', 'site'], ['material_movements', 'site'], ['hardware_types', null], ['rack_types', null]];
async function buildScopedExport(sites, by) {
  const conn = await pool.getConnection(); const tables = {};
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    for (const [t, col] of SCOPED_TABLES) {
      const sql = col ? (sites.length ? `SELECT * FROM \`${t}\` WHERE \`${col}\` IN (?)` : `SELECT * FROM \`${t}\` WHERE 1 = 0`) : `SELECT * FROM \`${t}\``;
      const [rows] = await conn.query({ sql, values: col && sites.length ? [sites] : [], typeCast: dateStringCast }); tables[t] = rows;
    }
    await conn.query('COMMIT');
  } finally { conn.release(); }
  const files = {}, skippedFiles = [];
  for (const mv of tables.material_movements) {           // only the documents that belong to this location's movements
    const f = mv.dc_invoice_file; if (!f || !BACKUP_SAFE_FILE_RE.test(f)) continue;
    try { const fp = safeUploadPath(f); const st = fs.statSync(fp); if (!st.isFile()) continue; if (st.size > MAX_ATTACHMENT_BYTES) { skippedFiles.push(f); continue; } files[f] = fs.readFileSync(fp).toString('base64'); } catch (e) { /* file missing on disk */ }
  }
  const sha256 = crypto.createHash('sha256').update(JSON.stringify({ tables, files })).digest('hex');
  const counts = {}; Object.keys(tables).forEach((t) => { counts[t] = tables[t].length; });
  const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, scope: 'site', sites, createdAt: new Date().toISOString(), createdBy: by || 'user', kind: 'export', counts, fileCount: Object.keys(files).length, skippedFiles, sha256, tables, files };
  return { buffer: zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 6 }), manifest };
}
app.get('/api/backup/download-mine', authenticateToken, async (req, res) => {
  try {
    const sites = await getAllowedSitesForUser(req.user);
    const { buffer } = await buildScopedExport(sites, req.user.name || req.user.username);
    const slug = sites.length && sites.length <= 3 ? sites.map((x) => x.replace(/[^A-Za-z0-9]+/g, '')).join('-') : 'all-locations';
    const name = `dc-export-${slug}-${backupStamp(new Date())}.json.gz`;
    log.info(`[backup] location export by ${req.user.username} for [${sites.join(', ')}] (${buffer.length} bytes)`);
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'no-store' }); res.send(buffer);
  } catch (e) { sendErr(res, e); }
});

async function settingsPayload() {
  const cfg = await backupConfig(); let lastRun = null; try { lastRun = JSON.parse(await getSetting('backup.lastRun', 'null')); } catch (e) { lastRun = null; }
  let dirExists = false, dirWritable = false; try { await fs.promises.access(cfg.dir, fs.constants.F_OK); dirExists = true; await fs.promises.access(cfg.dir, fs.constants.W_OK); dirWritable = true; } catch (e) { /* not there yet / not writable */ }
  return { enabled: cfg.enabled, dir: cfg.dir, customDir: cfg.customDir, defaultDir: DEFAULT_BACKUP_DIR, dirExists, dirWritable, time: BACKUP_TIME, retentionDays: cfg.retentionDays,
    nextRun: cfg.enabled ? nextBackupAt().toISOString() : null, lastRun, files: await listBackupFiles(cfg.dir), busy: backupBusy, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, serverNow: new Date().toISOString() };
}

app.get('/api/backup/settings', authenticateToken, requireGlobalAdmin, async (req, res) => { try { res.json(await settingsPayload()); } catch (e) { sendErr(res, e); } });
app.put('/api/backup/settings', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const { enabled, path: p, retentionDays } = req.body || {};
    if (p !== undefined) { if (p === null || String(p).trim() === '') await setSetting('backup.dir', ''); else await setSetting('backup.dir', await validateBackupDir(p)); }
    if (enabled !== undefined) await setSetting('backup.enabled', enabled ? '1' : '0');
    if (retentionDays !== undefined) {
      const n = Number(retentionDays);
      if (!Number.isFinite(n) || n < 1 || n > 365) return res.status(400).json({ error: 'Retention must be a whole number of days between 1 and 365.' });
      await setSetting('backup.retentionDays', String(Math.round(n)));
    }
    log.info(`[backup] settings changed by ${req.user.username}: enabled=${(await backupConfig()).enabled}, folder=${(await backupConfig()).dir}, retentionDays=${(await backupConfig()).retentionDays}`);
    res.json(await settingsPayload());
  } catch (e) { sendErr(res, e); }
});
app.post('/api/backup/run', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try { const r = await runBackupJob('manual', req.user.name || req.user.username); if (!r.ok) return res.status(500).json({ error: r.error }); res.json({ ...r, settings: await settingsPayload() }); } catch (e) { sendErr(res, e); }
});
// Manual backup: the file is sent to the browser, which lets the admin choose where to save it on their own computer
app.get('/api/backup/download', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    const { buffer } = await buildBackup('manual', req.user.name || req.user.username); const name = `dc-backup-${backupStamp(new Date())}-manual.json.gz`;
    log.info(`[backup] manual download by ${req.user.username} (${buffer.length} bytes)`);
    auditLog(req, 'BACKUP_DOWNLOAD', { entity: 'backup', entityId: name, details: { size: buffer.length, sha256: nodeCrypto.createHash('sha256').update(buffer).digest('hex'), appVersion: APP_VERSION } });
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'no-store' }); res.send(buffer);
  } catch (e) { sendErr(res, e); }
});
app.get('/api/backup/files/:name/download', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    if (!BACKUP_NAME_RE.test(req.params.name)) throw httpErr(400, 'Invalid backup file name.');
    const cfg = await backupConfig(); const full = path.join(cfg.dir, req.params.name); if (!fs.existsSync(full)) throw httpErr(404, 'Backup file not found.');
    auditLog(req, 'BACKUP_DOWNLOAD', { entity: 'backup', entityId: req.params.name });
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${req.params.name}"`, 'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'no-store' }); res.send(await fs.promises.readFile(full));
  } catch (e) { sendErr(res, e); }
});
app.delete('/api/backup/files/:name', authenticateToken, requireGlobalAdmin, async (req, res) => {
  try {
    if (!BACKUP_NAME_RE.test(req.params.name)) throw httpErr(400, 'Invalid backup file name.');
    const cfg = await backupConfig(); const full = path.join(cfg.dir, req.params.name); if (!fs.existsSync(full)) throw httpErr(404, 'Backup file not found.');
    await fs.promises.unlink(full); fs.promises.unlink(full + '.meta.json').catch(() => {});
    log.info(`[backup] ${req.user.username} deleted ${req.params.name}`); auditLog(req, 'BACKUP_DELETE', { entity: 'backup', entityId: req.params.name }); res.json({ success: true });
  } catch (e) { sendErr(res, e); }
});
// Restore (or, with dryRun, only check the file and show what it contains). Needs the word RESTORE as confirmation.
app.post('/api/backup/restore', authenticateToken, requireGlobalAdmin, restoreUpload.single('file'), async (req, res) => {
  const restoreAudit = { dryRun: false, source: null, stage: 'validate' };
  try {
    const body = req.body || {}; const dryRun = body.dryRun === true || ['true', '1'].includes(String(body.dryRun));
    restoreAudit.dryRun = dryRun;
    let buf, source, recordedSha = null;
    if (req.file) {
      // PHASE-1 upload validation: must be a gzip file with a .gz extension (the real content is validated by parseBackupBuffer below)
      if (!/\.gz$/i.test(req.file.originalname || '') || req.file.buffer.length < 20 || req.file.buffer[0] !== 0x1f || req.file.buffer[1] !== 0x8b) throw httpErr(400, 'Only a .json.gz backup file made by this application can be restored.');
      buf = req.file.buffer; source = `upload "${sanitizeUploadName(req.file.originalname)}"`;
    }
    else if (body.name) {
      if (!BACKUP_NAME_RE.test(String(body.name))) throw httpErr(400, 'Invalid backup file name.');
      const cfg = await backupConfig(); const full = path.join(cfg.dir, String(body.name)); if (!fs.existsSync(full)) throw httpErr(404, 'Backup file not found.');
      buf = await fs.promises.readFile(full); source = `server file ${body.name}`;
      const meta = await readBackupMeta(cfg.dir, String(body.name)); recordedSha = meta && meta.fileSha256 || null;
    } else throw httpErr(400, 'Choose a backup file to restore.');
    const fileSha256 = nodeCrypto.createHash('sha256').update(buf).digest('hex');
    // PHASE-1: a backup kept in the server folder must still match the checksum recorded when it was created
    if (recordedSha && recordedSha !== fileSha256) throw httpErr(400, 'This backup file no longer matches the checksum recorded when it was created (it was changed or damaged). Nothing was restored.');
    const m = parseBackupBuffer(buf); const info = { ...backupSummary(m), appVersion: m.appVersion || null, fileSha256, checksumVerified: !!recordedSha };
    restoreAudit.source = source;
    if (dryRun) { auditLog(req, 'RESTORE_VALIDATE', { entity: 'backup', entityId: source, details: { backupCreatedAt: m.createdAt, sha256: fileSha256 } }); return res.json({ ok: true, dryRun: true, backup: info, current: await currentCounts() }); }
    restoreAudit.stage = 'restore';
    if (String(body.confirm) !== 'RESTORE') throw httpErr(400, 'Type RESTORE to confirm.');
    if (backupBusy) throw httpErr(409, 'A backup or restore is already running. Try again in a minute.');
    backupBusy = true;
    try {
      log.info(`[restore] ${req.user.username} restoring from ${source} (backup made ${m.createdAt})`);
      let safety; try { safety = await writeBackupFile('prerestore', req.user.name || req.user.username); } catch (e) { throw httpErr(500, `Could not take the safety backup of the current data, so nothing was restored. (${e.message})`); }
      const r = await restoreManifest(m, req.user.username);
      authUserCache.clear(); await flagDefaultPasswordAccounts();
      log.info(`[restore] done. Safety backup of the previous data: ${safety.name}`);
      auditLog(req, 'RESTORE', { entity: 'backup', entityId: source, details: { backupCreatedAt: m.createdAt, safetyBackup: safety.name, sha256: fileSha256 } });
      res.json({ ok: true, ...r, backup: info, safetyBackup: safety.name });
    } finally { backupBusy = false; }
  } catch (e) {
    auditLog(req, restoreAudit.dryRun ? 'RESTORE_VALIDATE' : 'RESTORE', { entity: 'backup', entityId: restoreAudit.source || null, status: 'failure', details: { error: String(e && e.message).slice(0, 300) } });
    sendErr(res, e);
  }
});

// Packaging-roadmap additions (org/branding settings, OME/OneView/SMTP wizard,
// default catalog seeding, deep health check, deployment dashboard, config
// export/import) — kept in its own module; nothing above this line changes.
// `pool` is only assigned later, inside startServer() -> ensureDatabase(), which
// runs after this module-load-time registration call. A plain `pool` reference
// here would permanently capture `undefined`, so forward through a proxy that
// reads the live variable at call time (routes only ever run after the server
// has actually started and `pool` is set).
const livePool = new Proxy({}, { get: (_, prop) => { const v = pool[prop]; return typeof v === 'function' ? v.bind(pool) : v; } });
const setupRoutesModule = require('./lib/setup-routes')(app, {
  pool: livePool, fs, path, multer, log, httpErr, sendErr, bcrypt,
  authenticateToken, requireGlobalAdmin,
  getSetting, setSetting, genId, normalizeHardwareType,
  APP_VERSION, JWT_SECRET, DB_NAME, DB_CONFIG, testConnection,
  getOmeToken, getOneviewSession, monitorEnvKey,
  validateBackupDir, backupConfig, ocrEngine, webappDir: __dirname,
});
const pduRoutesModule = require('./lib/pdu-routes')(app, {
  pool: livePool, log, httpErr, sendErr,
  authenticateToken, requireRole, getAllowedSitesForUser, applySiteScope, assertSiteAccess,
  genId, auditLog,
});
const PDU_POLL_INTERVAL_MS = Math.max(60000, Number(process.env.PDU_POLL_INTERVAL_MS) || 15 * 60 * 1000); // 15 min default
const redfishRoutesModule = require('./lib/redfish-routes')(app, {
  pool: livePool, log, httpErr, sendErr,
  authenticateToken, requireRole, getAllowedSitesForUser, applySiteScope, assertSiteAccess,
  genId, auditLog, monitorFetch,
});

// Serve frontend (SPA fallback) — compatible with Express 4 and Express 5.
app.use((req, res, next) => {
  // Unmatched API/static requests must not be converted into index.html.
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/backups/')) {
    return next();
  }
  // Missing files with an extension should remain 404s.
  if (path.extname(req.path) && req.path.toLowerCase() !== '/index.html') {
    return res.status(404).send('Not found');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(getRenderedIndex().html);
});

// Error handler — must be registered last, with all 4 args, for Express to
// treat it as an error handler. Catches multer upload errors in particular
// (wrong file type from the fileFilter, file too large) so they come back
// as a clean JSON { error } response instead of Express's default HTML
// error page, which would otherwise break JSON parsing on the client.
// Unknown /api paths answer with the same JSON error shape instead of Express's HTML page.
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isApi = req.path.startsWith('/api');
  if (!req.id) { req.id = nodeCrypto.randomBytes(6).toString('hex'); res.set('X-Request-Id', req.id); } // errors raised before the /api middleware (e.g. JSON parsing)
  const send = (status, message, extra) => res.status(status).json(errorBody(status, message, req, extra));
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return send(400, req.path.startsWith('/api/backup') ? 'The backup file is too large (300MB limit).' : 'File is too large (15MB limit).');
    return send(400, err.message);
  }
  if (err && err.isUploadError) return send(400, err.message);
  if (err && req.path.includes('/document') && /Only PDF, image, Word, or Excel/.test(err.message || '')) return send(400, err.message);
  // malformed / oversized JSON bodies (body-parser)
  if (err && err.type === 'entity.parse.failed') return send(400, 'The request body is not valid JSON.');
  if (err && err.type === 'entity.too.large') return send(413, 'The request body is too large.');
  const status = err && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : (err && err.status >= 400 && err.status < 500 ? err.status : 500);
  if (status < 500) return send(status, (err && err.message) || 'Bad request');
  // Unexpected failure: full details (incl. stack) go to the log only - the client gets a generic message and a request id to quote.
  log.error(`[unhandled] ${req.method} ${String(req.originalUrl || '').split('?')[0]} (req ${req.id || '-'}):`, (err && err.stack) || err);
  return res.status(500).json({ error: 'Internal Server Error', referenceId: req.id });
});

// Start server
let httpServer = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`[shutdown] ${signal} received; closing server...`);
  try { await auditLog(null, 'SERVER_STOP', { username: 'system', entity: 'server', details: { signal, version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) } }); } catch (_) {}
  try { if (httpServer) await new Promise((resolve) => httpServer.close(resolve)); } catch (_) {}
  try { if (pool) await pool.end(); } catch (_) {}
  log.info('[shutdown] complete');
  setTimeout(() => process.exit(0), 100); // let the log file flush
}
process.on('uncaughtException', (err) => { log.error('[uncaughtException]', (err && err.stack) || err); setTimeout(() => process.exit(1), 200); });
// A failed background promise must be logged, never take the whole server (and every user's session) down.
process.on('unhandledRejection', (reason) => { log.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason); });
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function startServer() {
  try {
    await ensureDatabase();
    const ok = await testConnection();
    if (!ok) {
      log.error('\nCould not connect to MySQL. Check your .env file and make sure MySQL is running.\n');
      process.exitCode = 1;
      return;
    }
    await initDB();
    await setupRoutesModule.applyIntegrationEnv();
    await pduRoutesModule.ensureSchema();
    // 10-day free trial + auto-lock (see lib/license.js). Only when licensing is enforced.
    if (license.isLicensingConfigured()) {
      try {
        const t = await license.initTrial({ filePath: path.join(__dirname, '.trial-state'), dbGet: getSetting, dbSet: setSetting, log });
        const st = license.getLicenseStatus(LICENSE_FILE);
        log.info(`[license] mode=${st.mode}${t && st.mode === 'trial' ? `, ${t.daysLeft} day(s) left (ends ${t.endsAt.slice(0, 10)})` : ''}`);
        let lastMode = st.mode;
        const watcher = setInterval(() => {
          const cur = license.getLicenseStatus(LICENSE_FILE).mode;
          if (cur !== lastMode) { if (cur === 'locked') log.warn('[license] LOCKED - free trial ended and no valid license is active.'); lastMode = cur; }
        }, 60 * 1000);
        if (watcher.unref) watcher.unref();
      } catch (e) { log.warn('[license] trial initialisation failed: ' + e.message); }
    }
    // BIND_HOST (optional, e.g. 127.0.0.1 when nginx is the only entry point). Unset = all interfaces, exactly as before.
    httpServer = app.listen(...(process.env.BIND_HOST ? [PORT, process.env.BIND_HOST] : [PORT]), () => {
      log.info(`[startup] DCIM server v${APP_VERSION} listening on port ${PORT} (${IS_PRODUCTION ? 'production' : 'development'}, node ${process.version}, pid ${process.pid}, db ${DB_NAME})`);
      if (IS_PRODUCTION) {   // production hygiene hints (log only, never blocks start)
        if (!CORS_ORIGIN || CORS_ORIGIN.split(',').map((v) => v.trim()).includes('*')) log.warn('[security] CORS_ORIGIN is unset or "*" - set it to this site\'s real URL (e.g. https://dcim.example.com) in .env.');
        if (CSP_MODE !== 'enforce') log.warn(`[security] CSP_MODE is "${CSP_MODE}" - "enforce" is recommended in production.`);
        try { const m = fs.statSync(path.join(__dirname, '.env')).mode & 0o077; if (m && process.platform !== 'win32') log.warn('[security] .env is readable by other users - run: chmod 600 .env'); } catch (e) { /* no .env file (variables supplied by the service) */ }
      }
      { // REVIEW: audit-trail retention (AUDIT_RETENTION_DAYS, default 365; 0 = keep forever). Deletes in small batches so it never locks the table for long.
        const keepDays = process.env.AUDIT_RETENTION_DAYS !== undefined && process.env.AUDIT_RETENTION_DAYS !== '' ? Math.max(0, Number(process.env.AUDIT_RETENTION_DAYS) || 0) : 365;
        const purgeAudit = async () => { try { let total = 0, n; do { const [r] = await pool.query('DELETE FROM audit_logs WHERE created_at < (NOW() - INTERVAL ? DAY) LIMIT 2000', [keepDays]); n = r.affectedRows; total += n; } while (n === 2000); if (total) log.info(`[audit] purged ${total} audit_logs rows older than ${keepDays} days`); } catch (e) { log.warn('[audit] retention purge skipped: ' + e.message); } };
        if (keepDays > 0) { setTimeout(purgeAudit, 60000).unref(); setInterval(purgeAudit, 86400000).unref(); }
      }
      if (String(process.env.MEMORY_MONITOR || 'on').toLowerCase() !== 'off') { sampleMemory(); setInterval(sampleMemory, 60000).unref(); }
      if (STATIC_COMPRESS) setTimeout(async () => { // pre-compress the big static files so the first visitor does not wait for it
        try {
          const files = [path.join(__dirname, 'index.html'), appBundlePath(), ...['react.production.min.js', 'react-dom.production.min.js', 'xlsx.full.min.js', 'exceljs.min.js', 'jspdf.umd.min.js', 'html2canvas.min.js'].map((f) => path.join(LIBS_DIR, f))];
          for (const f of files) { const st = await fs.promises.stat(f).catch(() => null); if (st) { await compressedBuffer(f, st, 'br'); await compressedBuffer(f, st, 'gzip'); } }
          log.info('[static] static files pre-compressed');
        } catch (e) { log.warn('[static] pre-compression skipped:', e.message); }
      }, 1500).unref();
      if (String(process.env.MONITOR_FW_SCAN || 'on').toLowerCase() !== 'off') { setTimeout(() => fwJobsTick(true).catch(() => { }), 20000).unref(); setInterval(() => fwJobsTick(true).catch(() => { }), FW_SCAN_INTERVAL_MS).unref(); }
      if (String(process.env.PDU_POLL || 'on').toLowerCase() !== 'off') { setTimeout(() => pduRoutesModule.pollAllPdus().catch((e) => log.warn('[pdu] poll skipped: ' + e.message)), 25000).unref(); setInterval(() => pduRoutesModule.pollAllPdus().catch((e) => log.warn('[pdu] poll skipped: ' + e.message)), PDU_POLL_INTERVAL_MS).unref(); }
      auditLog(null, 'SERVER_START', { username: 'system', entity: 'server', details: { version: APP_VERSION, port: Number(PORT), node: process.version } });
      console.log(`\n========================================`);
      log.info(`  Data Center API Server Ready`);
      log.info(`  http://localhost:${PORT}`);
      console.log(`========================================`);
      // Only warn when a seeded default password is genuinely still in use (never print credentials that may no longer exist).
      flagDefaultPasswordAccounts(); // seeded accounts that still use the shipped password must change it at next sign-in
      console.log(`========================================`);
      log.info(`Offline UI bundle: ${require('fs').existsSync(path.join(__dirname, 'app-compiled.js')) ? '✓ Found' : '✗ NOT FOUND'}`);
      log.info(`Offline React runtime: ${require('fs').existsSync(path.join(__dirname, 'libs', 'react.production.min.js')) && require('fs').existsSync(path.join(__dirname, 'libs', 'react-dom.production.min.js')) ? '✓ Found' : '✗ NOT FOUND'}`);
      log.info(`Login video (media/login-bg.mp4): ${require('fs').existsSync(path.join(__dirname, 'media', 'login-bg.mp4')) ? '✓ Found' : '✗ NOT FOUND - put the media folder next to server.js (login page will show the animated fallback)'}`);
      log.info(`Serving from folder: ${__dirname}`);
      startBackupScheduler();
      backupConfig().then((c) => log.info(`Auto backup: ${c.enabled ? 'ON' : 'OFF'} - daily at ${BACKUP_TIME} (server time), keeps the last ${c.retentionDays} days -> ${c.dir}`)).catch(() => {});
      console.log(`========================================\n`);
    });
  } catch (e) {
    log.error('Failed to initialize:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
  }
}

startServer().catch((e) => {
  log.error('Fatal startup error:', e && e.message ? e.message : e);
  process.exitCode = 1;
});