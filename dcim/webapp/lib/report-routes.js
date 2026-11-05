'use strict';
// Monthly management report: routes, PDF history, automatic monthly e-mail.
//   GET  /api/reports/monthly/options              months, locations the user may report on, what the user may do, schedule (admin)
//   POST /api/reports/monthly/pdf                  { month, site, notes }  -> application/pdf (download / on-screen preview)
//   POST /api/reports/monthly/email                { month, site, notes, to:[...] } -> mails the PDF (Admin / Operator)
//   GET  /api/reports/monthly/schedule             saved schedule (Global Admin)
//   PUT  /api/reports/monthly/schedule             save schedule (Global Admin)
//   POST /api/reports/monthly/schedule/test        { email } sends the last full month's report to one address (Global Admin)
//   GET  /api/reports/monthly/history              past reports the user may see
//   GET  /api/reports/monthly/history/:id/pdf      download one
// Nothing here changes an existing table or route. Own tables: report_snapshots (report-data.js), report_history.
const data = require('./report-data');
const { render } = require('./report-pdf');

const SCHED_KEY = 'report.monthly.schedule';
const LAST_KEY = 'report.monthly.last';
const SNAP_DAY_KEY = 'report.snapshot.day';
const HISTORY_MONTHS = 24;
const MAX_ATTEMPTS = 3;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const ALL = '__all__';

module.exports = function registerReportRoutes(app, deps) {
  const { pool, log, sendErr, authenticateToken, requireGlobalAdmin, getAllowedSitesForUser, getSetting, setSetting, auditLog, sendNotification } = deps;

  const jget = async (k, d) => { try { const v = await getSetting(k, ''); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const jset = (k, v) => setSetting(k, JSON.stringify(v));
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { sendErr(res, e); } };
  const bad = (code, msg) => Object.assign(new Error(msg), { statusCode: code });
  const pad = (n) => String(n).padStart(2, '0');
  const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const isGlobalAdmin = (u) => !!u && u.role === 'Admin' && ['All', 'Both'].includes(u.location_access);
  const canEmail = (u) => !!u && (u.role === 'Admin' || u.role === 'Operator');
  const allSiteNames = () => getAllowedSitesForUser({ location_access: 'All' });

  async function ensureHistory() {
    await pool.query(`CREATE TABLE IF NOT EXISTS report_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, month CHAR(7) NOT NULL, scope VARCHAR(120) NOT NULL, sites TEXT, source VARCHAR(10) NOT NULL,
      created_by VARCHAR(100), created_at DATETIME NOT NULL, delivered_to TEXT, delivery VARCHAR(20), size_bytes INT, pdf LONGBLOB,
      KEY idx_report_history_month (month), KEY idx_report_history_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async function smtpConfigured() { const s = await jget('integrations.smtp', null); return !!(s && s.host); }

  // Resolves which locations a request may report on: a single named site, or everything the user is allowed to see.
  async function scopeFor(user, site) {
    const allowed = await getAllowedSitesForUser(user);
    if (!allowed.length) throw bad(403, 'No location is available for your account');
    if (!site || site === ALL) return { sites: allowed, label: allowed.length > 1 ? 'All locations' : allowed[0] };
    if (!allowed.includes(site)) throw bad(403, 'Access denied for this location');
    return { sites: [site], label: site };
  }
  const monthOk = (m) => { if (!data.isMonthKey(m)) throw bad(400, 'Choose a month'); if (m > data.monthKeyOf(new Date())) throw bad(400, 'That month has not started yet'); return m; };
  const cleanNotes = (n) => String(n || '').replace(/\r/g, '').split('\n').slice(0, 10).map((l) => l.slice(0, 400)).join('\n').trim().slice(0, 1500);
  const fileName = (label, month) => `DCIM-Monthly-Report-${String(label).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${month}.pdf`;

  async function makePdf({ sites, label, month, notes, now }) {
    const rep = await data.buildReport(pool, { sites, month, scopeLabel: label, now: now || new Date() });
    return { rep, pdf: render(rep, { notes }) };
  }
  async function saveHistory({ rep, pdf, source, by, to, delivery, sites }) {
    await ensureHistory();
    const [r] = await pool.query('INSERT INTO report_history (month, scope, sites, source, created_by, created_at, delivered_to, delivery, size_bytes, pdf) VALUES (?,?,?,?,?,NOW(),?,?,?,?)',
      [rep.meta.month, rep.meta.scope.slice(0, 120), JSON.stringify(sites), source, by ? String(by).slice(0, 100) : null, to && to.length ? to.join(', ').slice(0, 2000) : null, delivery || null, pdf.length, pdf]);
    await pool.query('DELETE FROM report_history WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MONTH)', [HISTORY_MONTHS]).catch(() => {});
    return r.insertId;
  }

  function mailHtml(rep, extra) {
    const m = rep.meta;
    const t = (x) => {
      const v = x.cur == null ? '-' : `${Math.round(x.cur * 10) / 10}${x.unit || ''}`;
      const d = x.delta == null ? '' : x.delta === 0 ? 'no change' : `${x.delta > 0 ? '+' : '−'}${Math.abs(x.delta)}${(x.unit || '').trim() === '%' ? ' pts' : ''} vs ${esc(m.prevShort)}`;
      return `<td style="padding:8px 12px;border:1px solid #E2E8F0;background:#F8FAFC;vertical-align:top"><div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:.5px">${esc(x.label)}</div><div style="font-size:20px;font-weight:700;color:#0F172A">${esc(v)}</div><div style="font-size:12px;color:#475569">${esc(d)}</div></td>`;
    };
    const rows = []; for (let i = 0; i < rep.tiles.length; i += 3) rows.push(`<tr>${rep.tiles.slice(i, i + 3).map(t).join('')}</tr>`);
    const top = rep.ranked.slice(0, 3).map((r) => `<li>${esc(r.what)}: ${esc(r.prev)} → ${esc(r.cur)}${esc(r.unit || '')}</li>`).join('');
    return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0F172A;max-width:640px"><h2 style="margin:0 0 4px">DCIM monthly report – ${esc(m.label)}</h2>
      <div style="color:#64748B;margin-bottom:12px">${esc(m.scope)} · compared with ${esc(m.prevLabel)}${m.isCurrent ? ' · month to date' : ''}</div>
      <table style="border-collapse:collapse;width:100%">${rows.join('')}</table>
      ${top ? `<p style="margin:14px 0 4px"><b>Biggest changes</b></p><ul style="margin:0;padding-left:18px">${top}</ul>` : ''}
      ${extra ? `<p style="margin:14px 0 0">${esc(extra)}</p>` : ''}
      <p style="margin:14px 0 0;color:#475569">The full report is attached as a PDF.</p>
      <p style="margin:14px 0 0;font-size:11px;color:#94A3B8">Sent automatically by the DCIM dashboard.</p></div>`;
  }

  async function deliver({ rep, pdf, to, subjectPrefix, extra }) {
    return sendNotification({
      subject: `${subjectPrefix || 'DCIM monthly report'} – ${rep.meta.scope} – ${rep.meta.label}`,
      html: mailHtml(rep, extra), to,
      attachments: [{ filename: fileName(rep.meta.scope, rep.meta.month), contentType: 'application/pdf', content: pdf }],
    });
  }

  // ---------------------------------------------------------------- routes ----------------------------------------------------------------
  app.get('/api/reports/monthly/options', authenticateToken, wrap(async (req, res) => {
    const allowed = await getAllowedSitesForUser(req.user);
    const cur = data.monthKeyOf(new Date()); const months = [];
    for (let i = 0; i < HISTORY_MONTHS; i++) { const k = data.addMonths(cur, -i); months.push({ key: k, label: data.monthLabel(k), current: i === 0 }); }
    const admin = isGlobalAdmin(req.user);
    const out = { months, sites: allowed, allowAll: allowed.length > 1, canEmail: canEmail(req.user), canSchedule: admin, smtpConfigured: await smtpConfigured(), defaultMonth: data.addMonths(cur, -1) };
    if (admin) { out.schedule = normalizeSchedule(await jget(SCHED_KEY, null)); out.last = await jget(LAST_KEY, null); out.allSites = await allSiteNames(); }
    res.json(out);
  }));

  app.post('/api/reports/monthly/pdf', authenticateToken, wrap(async (req, res) => {
    const b = req.body || {}; const month = monthOk(b.month);
    const sc = await scopeFor(req.user, b.site);
    const { rep, pdf } = await makePdf({ sites: sc.sites, label: sc.label, month, notes: cleanNotes(b.notes) });
    auditLog(req, 'REPORT_GENERATE', { entity: 'monthly_report', entityId: month, details: { scope: sc.label, size: pdf.length } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': `${b.download === false ? 'inline' : 'attachment'}; filename="${fileName(rep.meta.scope, month)}"`, 'Cache-Control': 'no-store' });
    res.end(pdf);
  }));

  app.post('/api/reports/monthly/data', authenticateToken, wrap(async (req, res) => {
    const b = req.body || {}; const month = monthOk(b.month);
    const sc = await scopeFor(req.user, b.site);
    const rep = await data.buildReport(pool, { sites: sc.sites, month, scopeLabel: sc.label });
    res.json(JSON.parse(JSON.stringify(rep, (k, v) => (v instanceof Map ? [...v] : v))));
  }));

  app.post('/api/reports/monthly/email', authenticateToken, wrap(async (req, res) => {
    if (!canEmail(req.user)) throw bad(403, 'Only Admin and Operator users can e-mail reports');
    const b = req.body || {}; const month = monthOk(b.month);
    const to = [...new Set([].concat(b.to || []).join(',').split(/[\s,;]+/).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
    if (!to.length) throw bad(400, 'Enter at least one e-mail address');
    if (to.length > 10) throw bad(400, 'At most 10 addresses at a time');
    const badOne = to.find((x) => !EMAIL_RE.test(x)); if (badOne) throw bad(400, `"${badOne}" is not a valid e-mail address`);
    if (!(await smtpConfigured())) throw bad(409, 'E-mail is not set up yet. An administrator can configure it in Setup → E-mail (SMTP).');
    const sc = await scopeFor(req.user, b.site);
    const notes = cleanNotes(b.notes);
    const { rep, pdf } = await makePdf({ sites: sc.sites, label: sc.label, month, notes });
    const r = await deliver({ rep, pdf, to, extra: notes ? 'Notes: ' + notes.replace(/\n+/g, ' / ') : '' });
    await saveHistory({ rep, pdf, source: 'manual', by: req.user.username, to, delivery: r.sent ? 'sent' : 'failed', sites: sc.sites });
    auditLog(req, 'REPORT_EMAIL', { entity: 'monthly_report', entityId: month, status: r.sent ? 'success' : 'failure', details: { scope: sc.label, to, reason: r.reason } });
    if (!r.sent) throw bad(502, `The e-mail could not be sent: ${r.reason || 'unknown error'}`);
    res.json({ ok: true, sentTo: to, month, scope: sc.label });
  }));

  function normalizeSchedule(s) {
    const o = s && typeof s === 'object' ? s : {};
    const day = Math.min(28, Math.max(1, parseInt(o.day, 10) || 1));
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(o.time || '')) ? o.time : '08:00';
    const recipients = (Array.isArray(o.recipients) ? o.recipients : []).map((r) => ({ email: String((r && r.email) || '').trim().toLowerCase(), scope: String((r && r.scope) || ALL) }))
      .filter((r) => EMAIL_RE.test(r.email)).slice(0, 20);
    return { enabled: !!o.enabled, day, time, recipients, notes: cleanNotes(o.notes) };
  }

  app.get('/api/reports/monthly/schedule', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    res.json({ schedule: normalizeSchedule(await jget(SCHED_KEY, null)), last: await jget(LAST_KEY, null), smtpConfigured: await smtpConfigured(), sites: await allSiteNames(), next: nextRun(normalizeSchedule(await jget(SCHED_KEY, null))) });
  }));

  app.put('/api/reports/monthly/schedule', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const b = req.body || {}; const sites = await allSiteNames();
    const rawRecipients = Array.isArray(b.recipients) ? b.recipients : [];
    for (const r of rawRecipients) {
      const email = String((r && r.email) || '').trim();
      if (!EMAIL_RE.test(email)) throw bad(400, `"${email}" is not a valid e-mail address`);
      const sc = String((r && r.scope) || ALL); if (sc !== ALL && !sites.includes(sc)) throw bad(400, `Unknown location "${sc}"`);
    }
    if (rawRecipients.length > 20) throw bad(400, 'At most 20 recipients');
    if (b.day != null && !(parseInt(b.day, 10) >= 1 && parseInt(b.day, 10) <= 28)) throw bad(400, 'Day must be between 1 and 28');
    if (b.time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) throw bad(400, 'Time must look like 08:00');
    const next = normalizeSchedule(b);
    if (next.enabled && !next.recipients.length) throw bad(400, 'Add at least one recipient before switching automatic e-mail on');
    await jset(SCHED_KEY, next);
    auditLog(req, 'REPORT_SCHEDULE_UPDATE', { entity: 'monthly_report', details: { enabled: next.enabled, day: next.day, time: next.time, recipients: next.recipients.length } });
    res.json({ ok: true, schedule: next, next: nextRun(next) });
  }));

  app.post('/api/reports/monthly/schedule/test', authenticateToken, requireGlobalAdmin, wrap(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad(400, 'Enter a valid e-mail address');
    if (!(await smtpConfigured())) throw bad(409, 'E-mail is not set up yet. Configure SMTP in Setup first.');
    const sites = await allSiteNames();
    const month = data.addMonths(data.monthKeyOf(new Date()), -1);
    const { rep, pdf } = await makePdf({ sites, label: sites.length > 1 ? 'All locations' : sites[0], month, notes: '' });
    const r = await deliver({ rep, pdf, to: [email], subjectPrefix: 'TEST – DCIM monthly report', extra: 'This is a test message from the report schedule.' });
    await saveHistory({ rep, pdf, source: 'test', by: req.user.username, to: [email], delivery: r.sent ? 'sent' : 'failed', sites });
    auditLog(req, 'REPORT_TEST_EMAIL', { entity: 'monthly_report', status: r.sent ? 'success' : 'failure', details: { to: email, reason: r.reason } });
    if (!r.sent) throw bad(502, `The test e-mail could not be sent: ${r.reason || 'unknown error'}`);
    res.json({ ok: true, sentTo: email, month });
  }));

  async function visibleHistoryRow(user, row) {
    const allowed = await getAllowedSitesForUser(user);
    let sites = []; try { sites = JSON.parse(row.sites || '[]'); } catch (e) { /* ignore */ }
    return sites.length > 0 && sites.every((s) => allowed.includes(s));
  }
  app.get('/api/reports/monthly/history', authenticateToken, wrap(async (req, res) => {
    await ensureHistory();
    const [rows] = await pool.query('SELECT id, month, scope, sites, source, created_by, created_at, delivered_to, delivery, size_bytes FROM report_history ORDER BY created_at DESC, id DESC LIMIT 500');
    const out = [];
    for (const r of rows) if (await visibleHistoryRow(req.user, r)) out.push({ id: r.id, month: r.month, monthLabel: data.monthLabel(r.month), scope: r.scope, source: r.source, createdBy: r.created_by, createdAt: r.created_at, deliveredTo: r.delivered_to, delivery: r.delivery, sizeBytes: r.size_bytes });
    res.json({ items: out });
  }));
  app.get('/api/reports/monthly/history/:id/pdf', authenticateToken, wrap(async (req, res) => {
    await ensureHistory();
    const id = parseInt(req.params.id, 10); if (!id) throw bad(400, 'Invalid report');
    const [rows] = await pool.query('SELECT * FROM report_history WHERE id = ?', [id]);
    if (!rows.length || !(await visibleHistoryRow(req.user, rows[0]))) throw bad(404, 'Report not found');
    auditLog(req, 'REPORT_DOWNLOAD', { entity: 'monthly_report', entityId: String(id), details: { scope: rows[0].scope, month: rows[0].month } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': rows[0].pdf.length, 'Content-Disposition': `attachment; filename="${fileName(rows[0].scope, rows[0].month)}"`, 'Cache-Control': 'no-store' });
    res.end(rows[0].pdf);
  }));

  // ---------------------------------------------------------------- scheduler ----------------------------------------------------------------
  function dueAt(sch, now) { const [hh, mm] = sch.time.split(':').map(Number); return new Date(now.getFullYear(), now.getMonth(), sch.day, hh, mm, 0); }
  function nextRun(sch, now = new Date()) {
    if (!sch || !sch.enabled) return null;
    let d = dueAt(sch, now); if (now >= d) d = new Date(now.getFullYear(), now.getMonth() + 1, sch.day, ...sch.time.split(':').map(Number), 0);
    return { at: d.toISOString(), reportMonth: data.monthLabel(data.addMonths(data.monthKeyOf(d), -1)) };
  }

  async function runScheduled(sch, month, now) {
    const sites = await allSiteNames();
    const groups = new Map();
    for (const r of sch.recipients) { if (r.scope !== ALL && !sites.includes(r.scope)) continue; (groups.get(r.scope) || groups.set(r.scope, []).get(r.scope)).push(r.email); }
    const sent = [], failed = [];
    for (const [scope, to] of groups) {
      const list = scope === ALL ? sites : [scope]; const label = scope === ALL ? (sites.length > 1 ? 'All locations' : sites[0]) : scope;
      try {
        const { rep, pdf } = await makePdf({ sites: list, label, month, notes: sch.notes, now });
        const r = await deliver({ rep, pdf, to });
        await saveHistory({ rep, pdf, source: 'auto', by: 'system', to, delivery: r.sent ? 'sent' : 'failed', sites: list });
        if (r.sent) sent.push(...to); else failed.push({ to, reason: r.reason });
      } catch (e) { failed.push({ to, reason: e.message }); }
    }
    return { sent, failed };
  }

  let ticking = false;
  async function tick(now = new Date()) {
    if (ticking) return; ticking = true;
    try {
      const day = today(now);
      if ((await getSetting(SNAP_DAY_KEY, '')) !== day) {
        const sites = await allSiteNames();
        await data.takeSnapshot(pool, sites, now);
        await setSetting(SNAP_DAY_KEY, day);
      }
      const sch = normalizeSchedule(await jget(SCHED_KEY, null));
      if (!sch.enabled || !sch.recipients.length) return;
      if (now < dueAt(sch, now)) return;
      const month = data.addMonths(data.monthKeyOf(now), -1);
      const last = await jget(LAST_KEY, {}) || {};
      if (last.month === month && (last.status === 'sent' || last.status === 'running')) return;
      const attempts = last.month === month ? (last.attempts || 0) : 0;
      if (attempts >= MAX_ATTEMPTS) return;
      if (last.month === month && last.at && now - new Date(last.at) < 60 * 60 * 1000) return;
      await jset(LAST_KEY, { month, status: 'running', attempts: attempts + 1, at: now.toISOString() });
      const r = await runScheduled(sch, month, now);
      const ok = r.failed.length === 0 && r.sent.length > 0;
      await jset(LAST_KEY, { month, status: ok ? 'sent' : 'failed', attempts: attempts + 1, at: now.toISOString(), sent: r.sent, failed: r.failed.slice(0, 5),
        message: ok ? `Sent to ${r.sent.length} recipient${r.sent.length === 1 ? '' : 's'}` : (r.failed[0] ? r.failed[0].reason : 'No recipient could be reached') });
      auditLog(null, 'REPORT_AUTO_SEND', { username: 'system', entity: 'monthly_report', entityId: month, status: ok ? 'success' : 'failure', details: { sent: r.sent.length, failed: r.failed.length, reason: r.failed[0] && r.failed[0].reason } });
      if (!ok) log.warn(`[report] monthly report for ${month} not fully sent (attempt ${attempts + 1}/${MAX_ATTEMPTS}): ${r.failed[0] ? r.failed[0].reason : 'no recipients'}`);
    } catch (e) {
      log.warn('[report] scheduler tick failed: ' + e.message);
    } finally { ticking = false; }
  }
  const t0 = setTimeout(() => tick(), 90 * 1000); if (t0.unref) t0.unref();
  const t1 = setInterval(() => tick(), 5 * 60 * 1000); if (t1.unref) t1.unref();

  return { tick, runScheduled, normalizeSchedule, nextRun };
};
