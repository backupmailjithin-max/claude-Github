'use strict';
// Visitor Access - a full approval workflow, registered the same way as
// lib/pdu-routes.js / lib/redfish-routes.js: a self-contained module wired
// into server.js, reusing the app's existing location-scoped auth
// (getAllowedSitesForUser / applySiteScope / assertSiteAccess) and the same
// ticket-numbering scheme already used by Hardware Issues and Material
// Movements (PREFIX + YY + MM + 2-digit monthly sequence).
//
// Workflow: Pending Approval -> Approved -> Ticket Issued -> In Progress <->
// On Hold -> Closed, or Pending Approval -> Rejected (terminal). Any
// Admin/Operator can submit a request; Approve/Reject is gated by
// requireApproverOrAdmin (server.js) - Admin can always approve, and any
// user an Admin has flagged "Approver" can approve for the sites they
// already have access to. The "approver" named on the record is just an
// attribution label picked from the configured notification-recipients
// list, separate from who was actually allowed to click the button.
//
// In Progress / On Hold / Closed (formerly "Checked In" / - / "Checked Out")
// are a ticket-lifecycle, not a daily attendance log: this app's DC
// Operations team only needs to know the ticket is active, temporarily
// paused (the visitor stepped out but is expected back under the SAME
// ticket), or fully closed out - exact per-day entry/exit timestamps are the
// physical security team's own system, out of scope here. A ticket can move
// In Progress -> On Hold -> In Progress as many times as the visitor leaves
// and returns before Ops closes it.
const VISITOR_STATUSES = ['Pending Approval', 'Approved', 'Rejected', 'Ticket Issued', 'In Progress', 'On Hold', 'Closed'];

module.exports = function registerVisitorRoutes(app, deps) {
  const {
    pool, fs, path, multer, log, httpErr, sendErr, esc,
    authenticateToken, requireRole, requireApproverOrAdmin, getAllowedSitesForUser, applySiteScope, assertSiteAccess, getAllSiteNames,
    genId, auditLog, auditLogDeleteWithSnapshot, acquireTicketLock, generateTicketNoGeneric,
    normalizeDateInput, dateOnlyStr,
    uploadNameProblem, sanitizeUploadName, uploadError, verifyUploadedFiles,
    sendNotification, webappDir,
  } = deps;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_requests (
        id VARCHAR(50) PRIMARY KEY,
        ticket_no VARCHAR(50),
        site VARCHAR(50) NOT NULL,
        zone VARCHAR(20) DEFAULT 'AZ-1',
        visitor_name VARCHAR(150) NOT NULL,
        company VARCHAR(150),
        phone VARCHAR(30),
        purpose TEXT,
        host_employee VARCHAR(150),
        visit_date DATE,
        visit_date_to DATE NULL,
        expected_checkin DATETIME NULL,
        expected_checkout DATETIME NULL,
        actual_checkin DATETIME NULL,
        actual_checkout DATETIME NULL,
        id_proof_type VARCHAR(50),
        id_proof_number VARCHAR(100),
        status ENUM('Pending Approval','Approved','Rejected','Ticket Issued','In Progress','On Hold','Closed') NOT NULL DEFAULT 'Pending Approval',
        approver_name VARCHAR(150) NULL,
        approved_at DATETIME NULL,
        reject_reason VARCHAR(255) NULL,
        remarks TEXT,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_visitor_site (site),
        KEY idx_visitor_status (status),
        KEY idx_visitor_visit_date (visit_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Additive, idempotent - safe to run against an installation whose
    // visitor_requests table was created before this column existed.
    try { await pool.query(`ALTER TABLE visitor_requests ADD COLUMN visit_date_to DATE NULL AFTER visit_date`); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
    // Rename the old two-state "Checked In"/"Checked Out" workflow to the
    // three-state "In Progress"/"On Hold"/"Closed" one. Safe to run on every
    // startup: widen the enum to accept both the old and new values, move any
    // existing rows across, then narrow the enum to the final set - a no-op
    // once an installation has already been migrated.
    try {
      await pool.query(`ALTER TABLE visitor_requests MODIFY status ENUM('Pending Approval','Approved','Rejected','Ticket Issued','Checked In','Checked Out','In Progress','On Hold','Closed') NOT NULL DEFAULT 'Pending Approval'`);
      await pool.query(`UPDATE visitor_requests SET status='In Progress' WHERE status='Checked In'`);
      await pool.query(`UPDATE visitor_requests SET status='Closed' WHERE status='Checked Out'`);
      await pool.query(`ALTER TABLE visitor_requests MODIFY status ENUM('Pending Approval','Approved','Rejected','Ticket Issued','In Progress','On Hold','Closed') NOT NULL DEFAULT 'Pending Approval'`);
    } catch (e) { log.warn('[visitors] could not migrate legacy Checked In/Checked Out statuses:', e.message); }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_access_documents (
        id VARCHAR(50) PRIMARY KEY,
        request_id VARCHAR(50) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        uploaded_by VARCHAR(100),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_visitor_doc_request (request_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  const VISITOR_UPLOAD_DIR = path.join(webappDir, 'uploads', 'visitors');
  // Never let a permission problem on this one sub-folder take the whole
  // server down - mirrors the "best effort" pattern used for the log
  // directory elsewhere in this app. If it can't be created, ID-proof
  // uploads for visitor requests just won't work until the folder's
  // permissions are fixed; nothing else about the app is affected.
  try { fs.mkdirSync(VISITOR_UPLOAD_DIR, { recursive: true }); }
  catch (e) { log.warn(`[visitors] could not create upload folder ${VISITOR_UPLOAD_DIR}: ${e.message}. Visitor document uploads will fail until this is fixed.`); }
  const visitorUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, VISITOR_UPLOAD_DIR),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || '').toLowerCase()}`),
    }),
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per ID-proof scan
    fileFilter: (req, file, cb) => {
      const problem = uploadNameProblem(file.originalname, file.mimetype);
      if (problem) { log.warn(`[upload] rejected "${sanitizeUploadName(file.originalname)}": ${problem}`); return cb(uploadError(problem)); }
      cb(null, true);
    },
  });
  function safeVisitorUploadPath(name) { return path.join(VISITOR_UPLOAD_DIR, path.basename(String(name == null ? '' : name))); }

  function rowToJson(r) {
    return {
      id: r.id, ticketNo: r.ticket_no, site: r.site, zone: r.zone,
      visitorName: r.visitor_name, company: r.company, phone: r.phone, purpose: r.purpose,
      hostEmployee: r.host_employee, visitDate: dateOnlyStr(r.visit_date), visitDateTo: dateOnlyStr(r.visit_date_to),
      expectedCheckin: r.expected_checkin, expectedCheckout: r.expected_checkout,
      actualCheckin: r.actual_checkin, actualCheckout: r.actual_checkout,
      idProofType: r.id_proof_type, idProofNumber: r.id_proof_number,
      status: r.status, approverName: r.approver_name, approvedAt: r.approved_at, rejectReason: r.reject_reason,
      remarks: r.remarks, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  function visitorEmailTable(r, extraRows = '') {
    return `<table cellpadding="6" style="border-collapse:collapse">
      <tr><td><b>Ticket No</b></td><td>${esc(r.ticket_no || '(not yet issued)')}</td></tr>
      <tr><td><b>Visitor</b></td><td>${esc(r.visitor_name)}${r.company ? ' (' + esc(r.company) + ')' : ''}</td></tr>
      <tr><td><b>Site / Zone</b></td><td>${esc(r.site)} / ${esc(r.zone)}</td></tr>
      <tr><td><b>Host Employee</b></td><td>${esc(r.host_employee || '')}</td></tr>
      <tr><td><b>Purpose</b></td><td>${esc(r.purpose || '')}</td></tr>
      <tr><td><b>Visit Date</b></td><td>${esc(dateOnlyStr(r.visit_date))}</td></tr>
      ${extraRows}
    </table>`;
  }

  // ---------- list / detail ----------
  app.get('/api/visitor-requests', authenticateToken, async (req, res) => {
    try {
      const { site, status, from, to } = req.query;
      const allowed = await getAllowedSitesForUser(req.user);
      const conditions = [], params = [];
      if (site && site !== 'all') {
        if (!allowed.includes(site)) return res.status(403).json({ error: 'Access denied for this site' });
        conditions.push('site = ?'); params.push(site);
      } else {
        await applySiteScope(allowed, conditions, params);
      }
      if (status && status !== 'all') {
        if (!VISITOR_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${VISITOR_STATUSES.join(', ')}` });
        conditions.push('status = ?'); params.push(status);
      }
      if (from) { conditions.push('visit_date >= ?'); params.push(from); }
      if (to) { conditions.push('visit_date <= ?'); params.push(to); }
      let sql = 'SELECT * FROM visitor_requests';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      const [rows] = await pool.query(sql, params);
      if (rows.length === 0) return res.json([]);
      const [docRows] = await pool.query(
        `SELECT id, request_id, original_name, uploaded_by, uploaded_at FROM visitor_access_documents WHERE request_id IN (?) ORDER BY uploaded_at ASC`,
        [rows.map((r) => r.id)]
      );
      const docsByRequest = {};
      for (const d of docRows) (docsByRequest[d.request_id] = docsByRequest[d.request_id] || []).push({ id: d.id, name: d.original_name, uploadedBy: d.uploaded_by, uploadedAt: d.uploaded_at });
      res.json(rows.map((r) => ({ ...rowToJson(r), documents: docsByRequest[r.id] || [] })));
    } catch (e) { sendErr(res, e); }
  });

  // ---------- create (submits a Pending Approval request) ----------
  app.post('/api/visitor-requests', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const b = req.body || {};
      const validSites = await getAllSiteNames();
      if (!b.site || !validSites.includes(b.site)) return res.status(400).json({ error: `Location must be one of: ${validSites.join(', ')}` });
      await assertSiteAccess(req.user, b.site);
      if (!b.visitorName || !String(b.visitorName).trim()) return res.status(400).json({ error: 'Visitor name is required' });
      if (!b.visitDate) return res.status(400).json({ error: 'Visit date is required' });
      const visitDateTo = b.visitDateTo ? normalizeDateInput(b.visitDateTo) : null;
      if (visitDateTo && visitDateTo < normalizeDateInput(b.visitDate)) return res.status(400).json({ error: 'Visit Date To cannot be earlier than Visit Date From' });
      const user = req.user;
      const id = genId('VST');
      await pool.query(
        `INSERT INTO visitor_requests (id, site, zone, visitor_name, company, phone, purpose, host_employee, visit_date, visit_date_to, expected_checkin, expected_checkout, id_proof_type, id_proof_number, remarks, created_by, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Pending Approval')`,
        [id, b.site, b.zone || 'AZ-1', String(b.visitorName).trim(), b.company || null, b.phone || null, b.purpose || null, b.hostEmployee || null,
         normalizeDateInput(b.visitDate), visitDateTo, b.expectedCheckin || null, b.expectedCheckout || null, b.idProofType || null, b.idProofNumber || null, b.remarks || null, user.name || user.username]
      );
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [id]);
      auditLog(req, 'VISITOR_REQUEST_CREATE', { entity: 'visitor_request', entityId: id, site: b.site, details: { visitorName: b.visitorName, status: 'Pending Approval' } });
      res.json(rowToJson(rows[0]));
      sendNotification({
        subject: `[DCIM] Visitor Access approval needed - ${esc(b.visitorName)} (${esc(b.site)})`,
        html: `<p>A new visitor access request is waiting for approval.</p>${visitorEmailTable(rows[0])}
          <p>Submitted by: ${esc(user.name || user.username)}</p>`,
      }).catch(() => {});
    } catch (e) { sendErr(res, e); }
  });

  // ---------- edit (only while still Pending Approval) ----------
  app.patch('/api/visitor-requests/:id', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (existing[0].status !== 'Pending Approval') return res.status(400).json({ error: `Only a request still "Pending Approval" can be edited (this one is "${existing[0].status}")` });
      const b = req.body || {};
      if (!b.visitorName || !String(b.visitorName).trim()) return res.status(400).json({ error: 'Visitor name is required' });
      const newVisitDate = normalizeDateInput(b.visitDate) || existing[0].visit_date;
      const visitDateTo = b.visitDateTo ? normalizeDateInput(b.visitDateTo) : null;
      if (visitDateTo && visitDateTo < newVisitDate) return res.status(400).json({ error: 'Visit Date To cannot be earlier than Visit Date From' });
      await pool.query(
        `UPDATE visitor_requests SET visitor_name=?, company=?, phone=?, purpose=?, host_employee=?, visit_date=?, visit_date_to=?, expected_checkin=?, expected_checkout=?, id_proof_type=?, id_proof_number=?, remarks=? WHERE id=?`,
        [String(b.visitorName).trim(), b.company || null, b.phone || null, b.purpose || null, b.hostEmployee || null, newVisitDate, visitDateTo,
         b.expectedCheckin || null, b.expectedCheckout || null, b.idProofType || null, b.idProofNumber || null, b.remarks || null, req.params.id]
      );
      res.json({ success: true });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- delete (Admin only, while Pending Approval or Rejected) ----------
  app.delete('/api/visitor-requests/:id', authenticateToken, requireRole(['Admin']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (!['Pending Approval', 'Rejected'].includes(existing[0].status)) return res.status(400).json({ error: `Cannot delete a request that is "${existing[0].status}"` });
      const [docRows] = await pool.query('SELECT file_name FROM visitor_access_documents WHERE request_id = ?', [req.params.id]);
      await pool.query('DELETE FROM visitor_access_documents WHERE request_id = ?', [req.params.id]);
      await pool.query('DELETE FROM visitor_requests WHERE id = ?', [req.params.id]);
      docRows.forEach((d) => fs.unlink(safeVisitorUploadPath(d.file_name), () => {}));
      await auditLogDeleteWithSnapshot(req, 'VISITOR_REQUEST_DELETE', 'visitor_request', req.params.id, existing[0].site, existing[0]);
      res.json({ success: true });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- approve / reject (Admin only) ----------
  app.post('/api/visitor-requests/:id/approve', authenticateToken, requireApproverOrAdmin, async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (existing[0].status !== 'Pending Approval') return res.status(400).json({ error: `Only a "Pending Approval" request can be approved (this one is "${existing[0].status}")` });
      const approverName = String((req.body && req.body.approverName) || req.user.name || req.user.username).trim();
      await pool.query(`UPDATE visitor_requests SET status='Approved', approver_name=?, approved_at=NOW() WHERE id=?`, [approverName, req.params.id]);
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      auditLog(req, 'VISITOR_REQUEST_APPROVE', { entity: 'visitor_request', entityId: req.params.id, site: existing[0].site, details: { approverName } });
      res.json(rowToJson(rows[0]));
      sendNotification({
        subject: `[DCIM] Visitor Access request APPROVED - ${esc(rows[0].visitor_name)} (${esc(rows[0].site)})`,
        html: `<p>This visitor access request has been approved by <b>${esc(approverName)}</b>. A ticket can now be generated.</p>${visitorEmailTable(rows[0])}`,
      }).catch(() => {});
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/visitor-requests/:id/reject', authenticateToken, requireApproverOrAdmin, async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (existing[0].status !== 'Pending Approval') return res.status(400).json({ error: `Only a "Pending Approval" request can be rejected (this one is "${existing[0].status}")` });
      const approverName = String((req.body && req.body.approverName) || req.user.name || req.user.username).trim();
      const reason = String((req.body && req.body.reason) || '').trim();
      if (!reason) return res.status(400).json({ error: 'A reason is required to reject a visitor access request.' });
      await pool.query(`UPDATE visitor_requests SET status='Rejected', approver_name=?, approved_at=NOW(), reject_reason=? WHERE id=?`, [approverName, reason, req.params.id]);
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      auditLog(req, 'VISITOR_REQUEST_REJECT', { entity: 'visitor_request', entityId: req.params.id, site: existing[0].site, details: { approverName, reason } });
      res.json(rowToJson(rows[0]));
      sendNotification({
        subject: `[DCIM] Visitor Access request REJECTED - ${esc(rows[0].visitor_name)} (${esc(rows[0].site)})`,
        html: `<p>This visitor access request has been rejected by <b>${esc(approverName)}</b>.</p><p><b>Reason:</b> ${esc(reason)}</p>${visitorEmailTable(rows[0])}`,
      }).catch(() => {});
    } catch (e) { sendErr(res, e); }
  });

  // ---------- generate ticket (only once Approved) ----------
  app.post('/api/visitor-requests/:id/generate-ticket', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    let releaseTicketLock = null;
    try {
      const [existing] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (existing[0].status !== 'Approved') return res.status(400).json({ error: `A ticket can only be generated for an "Approved" request (this one is "${existing[0].status}")` });
      releaseTicketLock = await acquireTicketLock();
      const ticketNo = await generateTicketNoGeneric('VIS', 'visitor_requests');
      await pool.query(`UPDATE visitor_requests SET ticket_no=?, status='Ticket Issued' WHERE id=?`, [ticketNo, req.params.id]);
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      auditLog(req, 'VISITOR_TICKET_ISSUED', { entity: 'visitor_request', entityId: req.params.id, site: existing[0].site, ticket_no: ticketNo });
      res.json(rowToJson(rows[0]));
      sendNotification({
        subject: `[DCIM] Visitor Access ticket ${ticketNo} issued - ${esc(rows[0].visitor_name)} (${esc(rows[0].site)})`,
        html: `<p>A visitor access ticket has been generated.</p>${visitorEmailTable(rows[0])}`,
      }).catch(() => {});
    } catch (e) { sendErr(res, e); } finally { if (releaseTicketLock) releaseTicketLock(); }
  });

  // ---------- ticket lifecycle: Start / Hold / Resume / Close Ticket ----------
  // A remarks note added here is appended (never overwrites) to whatever is
  // already in the remarks column, each on its own timestamped line, so a
  // note left at creation/edit time and one left at any of these steps all
  // survive side by side.
  //
  // This is a TICKET lifecycle, not a daily attendance log: DC Operations
  // only needs In Progress (ticket active) / On Hold (visitor stepped out,
  // expected back under this SAME ticket) / Closed (Ops told the visitor is
  // fully done) - exact per-day entry/exit times are the physical security
  // team's own system, out of scope here. In Progress <-> On Hold can repeat
  // any number of times; Closed is terminal.
  function appendTimestampedRemark(existingRemarks, label, note) {
    const trimmed = String(note || '').trim();
    if (!trimmed) return existingRemarks || null;
    const line = `[${label} ${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${trimmed}`;
    return existingRemarks ? `${existingRemarks}\n${line}` : line;
  }

  // Start (first Ticket Issued -> In Progress) or Resume (On Hold -> In Progress).
  // actual_checkin is only ever set on the very first transition (Start) -
  // a later Resume never overwrites it, so it keeps meaning "when the ticket
  // first went active", not "when it was most recently resumed".
  app.post('/api/visitor-requests/:id/checkin', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT site, status, remarks FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (!['Ticket Issued', 'On Hold'].includes(existing[0].status)) return res.status(400).json({ error: `Start/Resume requires a "Ticket Issued" or "On Hold" request (this one is "${existing[0].status}")` });
      const label = existing[0].status === 'On Hold' ? 'Resume' : 'Start';
      const newRemarks = appendTimestampedRemark(existing[0].remarks, label, req.body && req.body.remarks);
      await pool.query(`UPDATE visitor_requests SET actual_checkin=IF(actual_checkin IS NULL, NOW(), actual_checkin), status='In Progress', remarks=? WHERE id=?`, [newRemarks, req.params.id]);
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      res.json(rowToJson(rows[0]));
    } catch (e) { sendErr(res, e); }
  });

  // Hold (In Progress -> On Hold): the visitor has left for now but is expected back under this same ticket.
  app.post('/api/visitor-requests/:id/hold', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT site, status, remarks FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (existing[0].status !== 'In Progress') return res.status(400).json({ error: `Hold requires an "In Progress" request (this one is "${existing[0].status}")` });
      const newRemarks = appendTimestampedRemark(existing[0].remarks, 'Hold', req.body && req.body.remarks);
      await pool.query(`UPDATE visitor_requests SET status='On Hold', remarks=? WHERE id=?`, [newRemarks, req.params.id]);
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      res.json(rowToJson(rows[0]));
    } catch (e) { sendErr(res, e); }
  });

  // Close Ticket (In Progress or On Hold -> Closed): terminal, once Ops is told the visitor is fully done.
  app.post('/api/visitor-requests/:id/checkout', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [existing] = await pool.query('SELECT site, status, remarks FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (existing.length === 0) return res.status(404).json({ error: 'Visitor request not found' });
      await assertSiteAccess(req.user, existing[0].site);
      if (!['In Progress', 'On Hold'].includes(existing[0].status)) return res.status(400).json({ error: `Close Ticket requires an "In Progress" or "On Hold" request (this one is "${existing[0].status}")` });
      const newRemarks = appendTimestampedRemark(existing[0].remarks, 'Closed', req.body && req.body.remarks);
      await pool.query(`UPDATE visitor_requests SET actual_checkout=NOW(), status='Closed', remarks=? WHERE id=?`, [newRemarks, req.params.id]);
      const [rows] = await pool.query('SELECT * FROM visitor_requests WHERE id = ?', [req.params.id]);
      res.json(rowToJson(rows[0]));
    } catch (e) { sendErr(res, e); }
  });

  // ---------- ID-proof / supporting documents ----------
  app.post('/api/visitor-requests/:id/document', authenticateToken, requireRole(['Admin', 'Operator']), visitorUpload.array('files', 5), verifyUploadedFiles, async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
      const [rows] = await pool.query('SELECT site FROM visitor_requests WHERE id = ?', [req.params.id]);
      if (rows.length === 0) { req.files.forEach((f) => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Visitor request not found' }); }
      try { await assertSiteAccess(req.user, rows[0].site); } catch (e) { req.files.forEach((f) => fs.unlink(f.path, () => {})); throw e; }
      const user = req.user;
      const inserted = [];
      for (const f of req.files) {
        const docId = genId('VDOC');
        await pool.query(
          'INSERT INTO visitor_access_documents (id, request_id, file_name, original_name, uploaded_by) VALUES (?,?,?,?,?)',
          [docId, req.params.id, f.filename, f.originalname, user.name || user.username]
        );
        inserted.push({ id: docId, name: f.originalname });
      }
      res.json({ success: true, documents: inserted });
    } catch (e) { sendErr(res, e); }
  });

  app.get('/api/visitor-requests/:id/documents/:docId', authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT d.file_name, d.original_name, v.site FROM visitor_access_documents d JOIN visitor_requests v ON v.id = d.request_id WHERE d.id = ? AND d.request_id = ?',
        [req.params.docId, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
      await assertSiteAccess(req.user, rows[0].site);
      const filePath = safeVisitorUploadPath(rows[0].file_name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Document file is missing on the server' });
      res.download(filePath, rows[0].original_name || rows[0].file_name);
    } catch (e) { sendErr(res, e); }
  });

  app.delete('/api/visitor-requests/:id/documents/:docId', authenticateToken, requireRole(['Admin', 'Operator']), async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT d.file_name, v.site FROM visitor_access_documents d JOIN visitor_requests v ON v.id = d.request_id WHERE d.id = ? AND d.request_id = ?',
        [req.params.docId, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
      await assertSiteAccess(req.user, rows[0].site);
      fs.unlink(safeVisitorUploadPath(rows[0].file_name), () => {});
      await pool.query('DELETE FROM visitor_access_documents WHERE id = ?', [req.params.docId]);
      res.json({ success: true });
    } catch (e) { sendErr(res, e); }
  });

  return { ensureSchema };
};
