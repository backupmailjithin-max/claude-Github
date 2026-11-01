# DCIM Release Notes

## v3.2.2 - Commercial Release (production branch `release/commercial`)

This release brings the licensing, packaging and operations work into one production codebase. The sections below are what changed since the earlier v3.2.2 distribution kit, which is described further down.

### Licensing hardening

- Signed offline licences (Ed25519): customer, user limit, expiry and optional machine ID. A licence that is edited or issued for another machine is rejected.
- Seat limit enforced when users are created.
- Licence screen under **Settings → License**: activate by pasting a code or uploading a `.lic` file; replacing a licence is atomic.
- Application locks after expiry and shows the machine ID; data is never touched.

### Vendor signing

- Every package carries `integrity.manifest.json`, signed with the vendor integrity key. The matching public key is built into the application.
- Release builds (`DCIM_RELEASE_BUILD=1`) refuse to build without the vendor signing key and without a clean customer payload.
- Vendor licence tools, demo-data scripts and clean-up scripts are removed from every customer package; the build checks this.

### Machine binding

- The machine ID comes from the operating system's own identifier, so a host name or network-card change no longer breaks a licence. Licences issued earlier against the old composite ID are still accepted.
- New procedures: Machine Rebind Procedure and Lost Licence Recovery Guide.

### Trial protection

- A 10-day trial starts on first run. The trial start is kept in two places and signed; deleting one does not restart it. Winding the clock back does not add days.

### Visitor access

- Visitor requests with access documents and a visitor lifecycle, included in backups.

### Approval workflow

- Material movements separate **Approve** from **Generate Ticket** (INW/OUT prefixes). Approvers are a user flag.

### Notification framework

- Email sender using the configured SMTP server; recipients are validated and de-duplicated and saved with the settings. Used for approval requests and material-movement notices. Test email available in the Setup Wizard.

### PDU enhancements

- PDU monitoring data and power readings are stored and included in backups.

### Server power analytics

- Current watts and PSU capacity from Dell OME and HPE OneView, a Server Power Consumption dashboard module (location load against PSU rating, top servers, zone breakdown with filters and sorting) and a live sync progress bar.

### Redfish enhancements

- Multi-vendor (Redfish) discovery and sync run as background jobs with a concurrent-scan guard, vendor-aware credential ordering and lock-out protection, column filters, row selection, ignore-from-monitor, and BIOS version capture.

### Backup improvements

- Backups now cover 23 tables, including `pdus`, `power_readings`, `visitor_requests` and `visitor_access_documents`, and application settings. Licence data is deliberately excluded. Restore takes a pre-restore backup first and asks for the word RESTORE.

### Packaging remediation

- One production source tree (`dcim/webapp`). The internal (no-licence) edition is a one-file overlay on it.
- Upgrade, repair and rollback keep `license.lic`, `.trial-state` and `.license-clock` on Linux and Windows.
- New installs run in `INTEGRITY_MODE=enforce`.

### Security improvements

- Strict integrity mode, trust-root protection and runtime-hijack checks; licence-tamper events are written to the audit log.
- Windows service runs under a dedicated restricted account with read-only application code.

### Upgrade impact

- Existing licence, trial, settings, uploads and backups are kept. Take a backup first as usual.
- Existing installs keep their current `.env`; `INTEGRITY_MODE` is not changed by an upgrade. Set `INTEGRITY_MODE=enforce` yourself if you want strict mode on an upgraded install.
- After an upgrade, the first start creates the visitor tables if they are missing.
- The Windows service account changes to a dedicated restricted account.

### Breaking changes

- Customer packages no longer contain the licence generator, demo-data and clean-up scripts. Any process that used them on a customer server must move to the vendor side.
- Licence files must be issued machine-bound unless the issuer opts out.
- In strict integrity mode, files copied by hand onto an install make the application refuse normal startup. Use repair or rollback, or `INTEGRITY_MODE=warn` for a deliberate change.
- Fresh installs contain no demo data.

### Known issues

See Known Limitations. In short: no remote licence revocation, a copied virtual machine keeps its licence, failed notification emails are not retried, SMTP server certificates are not verified, and Dell OME, HPE OneView and PDU features need real hardware to be exercised.

---

## v3.2.2 - DCIM Enterprise Offline Distribution Kit (earlier distribution notes)

### Highlights

- **Single-download Distribution Kit.** One archive
  (`DCIM-Enterprise-Offline-Kit-v3.2.2`) containing native installers for
  every supported platform (Windows `.exe`, Linux `.deb`/`.rpm`/`.run`)
  behind a single OS-detecting dispatcher (`install` / `install.ps1`) - one
  download, native installation mechanisms preserved underneath.
- **Embedded database option.** Installs can now bring up their own
  private, bundled MariaDB 11.4.4 instance (`--embedded-db` /
  `-EmbeddedDb`) with no external database server required, alongside the
  existing external-database option. Fully supported across install,
  upgrade, and repair, on both Windows and Linux.
- **Fully offline.** Node.js runtime, OCR engine (Tesseract), fonts,
  PDF/Excel export libraries, templates, branding assets, and all npm
  dependencies are bundled in the kit. No `npm install`, no
  `apt`/`yum`/`winget`/`choco` calls are made during install, upgrade, or
  repair.
- **Structured health validation.** `GET /api/health/validate` reports
  PASS/WARNING/FAIL across Service, Database, OCR, API Health, Version,
  Upload Engine, Backup Engine, SMTP, Dell OME, and HPE OneView - run
  automatically after install/upgrade/repair and available on demand.
- **Support Bundle generator.** One-click/one-call (`POST
  /api/support/bundle`) export of system info, version, recent logs
  (platform-appropriate), a redacted configuration snapshot, a health
  report, and a performance snapshot, for troubleshooting without
  hand-collecting files.
- **Expanded Disaster Recovery.** A new files-archive export (`GET
  /api/backup/files-archive`) closes the gap left by the existing database
  backup/export - uploaded files (branding assets, Material Movement
  documents) can now be exported alongside the full database/config
  export.
- **Configurable security.** Session timeout and password minimum length
  are now configurable via the Setup Wizard's Security tab (previously
  fixed/hardcoded), in addition to the existing CSP mode, audit retention,
  and JWT configuration.
- **Dedicated Upgrade/Repair utilities.** Standalone `DCIM-Upgrade.exe` /
  `DCIM-Repair.exe` on Windows and `dcim-upgrade` / `dcim-repair` on Linux,
  separate from the main installer, for a clearer operator experience.

### Fixed in this release (found via real execution, not code review)

- **Linux:** the `.deb`/`.rpm` package's `dcim-setup` command (a symlink to
  `install.sh`) failed to resolve its own real directory, breaking the
  webapp file sync on every invocation through that symlink.
- **Linux:** a standalone/appliance install's Repair could silently fail to
  restore missing or corrupted webapp files (a path-resolution fallback
  pointed back at the already-installed directory instead of a real
  source) - repair now falls back to a small cached copy kept for exactly
  this purpose.
- **Linux/Windows:** Repair had no recovery path when the `.env`
  configuration file itself was missing or corrupted - it now self-heals
  from the most recent backup that still has one.
- **Windows:** registering the embedded database service and the main
  application service both tried to copy the NSSM service-wrapper binary
  to the same path, failing when the embedded-DB service was already
  running and had that file open.
- **Windows:** the pre-upgrade/pre-repair database backup silently
  "succeeded" even when the restore/dump actually failed; this is now
  checked explicitly and reported as a real failure.
- **Both platforms:** `mysqldump`'s `--set-gtid-purged=OFF` flag (needed
  for MySQL 8 to avoid a privilege error) is now feature-detected rather
  than assumed, since MariaDB's `mysqldump` does not support it at all.

### Known limitations

See `KNOWN_LIMITATIONS.md` in this kit's `common/docs/` folder.

### Upgrade matrix

See `UPGRADE_MATRIX.md` in this kit's `common/docs/` folder.
