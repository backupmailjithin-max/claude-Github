# DCIM Administrator Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

## Service control

| Task | Linux | Windows |
|---|---|---|
| Start | `sudo dcim-service start` | `dcim-service start` (or `Start-Service DCIM`) |
| Stop | `sudo dcim-service stop` | `dcim-service stop` |
| Restart | `sudo dcim-service restart` | `dcim-service restart` |
| Status | `sudo dcim-service status` | `dcim-service status` |
| Tail logs | `sudo dcim-service logs` (follows `journalctl -u dcim`) | `Get-Content C:\DCIM\webapp\logs\service-stdout.log -Wait` |

Log locations: Linux uses the systemd journal (`journalctl -u dcim`);
Windows writes to `<InstallDir>\webapp\logs\service-stdout.log` and
`service-stderr.log` (rotated automatically via NSSM's `AppRotateFiles`).

## Setup Wizard reference

Reachable at `/setup-wizard.html` (Admin role required):

- **Organization** - company name, department/org unit, support contact,
  footer text.
- **Branding** - logo/favicon upload, with a live preview before saving.
- **Security** - session timeout (hours), password minimum length (8-128,
  `security.passwordMinLength`), CSP mode, audit log retention, JWT
  behavior.
- **Monitoring** - Dell OME / HPE OneView / SMTP connection settings, each
  with a real **Test Connection** / **Test Email** button that calls the
  live endpoint before you save.
- **Infrastructure** - one-click seeding of standard default Locations /
  Zones / Rack Types / Hardware Types, or manage your own.
- **Export/Import** - download a full configuration bundle (see Disaster
  Recovery Guide) and a separate files archive for uploaded documents.

## Health validation

`GET /api/health/validate` (Admin, or during install/upgrade/repair as part
of the installer's own output) runs a structured check and returns
PASS/WARNING/FAIL per item:

| Check | What it verifies |
|---|---|
| Service | Process uptime, Node version |
| Database | A real `SELECT 1` against the configured DB |
| OCR | The OCR engine loaded successfully |
| API Health | The HTTP layer itself is responding |
| Version Endpoint | `APP_VERSION` is readable |
| Upload Engine | A real write+delete probe against the uploads folder |
| Backup Engine | Backup folder is writable and the last backup result |
| SMTP | Configured and reachable (WARNING if not configured) |
| Dell OME | Configured and reachable (WARNING if not configured) |
| HPE OneView | Configured and reachable (WARNING if not configured) |

`overall` is `FAIL` if any check fails, `WARNING` if any warn (e.g.
SMTP/OME/OneView not yet configured - expected on a fresh install), else
`PASS`.

## Support Bundle

`POST /api/support/bundle` (Admin) generates a downloadable zip containing:
system information, version, recent logs (platform-appropriate - Windows
reads `service-stdout.log`/`service-stderr.log`, Linux shells out to
`journalctl -u dcim -n 500`), a redacted `.env` snapshot (secrets stripped),
a health report, and a performance snapshot. Attach this when opening a
support case rather than hand-collecting logs.

## User & security administration

- **Users**: Admin/Operator/Viewer roles, per-location access scoping.
- **Default accounts**: the seeded `admin`/`admin` (and demo
  `site-a-op`/`site-b-op`) accounts are automatically flagged
  `mustChangePassword` on first login against the known default - they
  cannot be used to do anything else until changed.
- **Password policy**: configurable minimum length (default 8, up to 128)
  via Setup Wizard > Security.
- **Session timeout**: configurable in hours via Setup Wizard > Security;
  takes effect on next JWT issuance (requires a service restart to apply
  the new token lifetime to already-issued sessions' refresh behavior).
- **Audit log**: every security-relevant action (login, password change,
  backup/restore, user management, config changes) is recorded with actor,
  IP, and outcome. Retention is configurable (`--audit-retention-days` /
  `-AuditRetentionDays`, default 365 days, 0 = forever).
- **CSP (Content Security Policy)**: `report-only` (default, logs
  violations without blocking), `enforce` (blocks), or `off`.

## Routine maintenance checklist

- [ ] Confirm nightly automatic backups are running (Setup Wizard > Backup,
  or `/api/backup/settings`).
- [ ] Review the audit log periodically for `LOGIN_FAILURE` patterns.
- [ ] Run `/api/health/validate` after any infrastructure change (DNS,
  firewall, cert rotation) that could affect OME/OneView/SMTP reachability.
- [ ] Keep the Distribution Kit's `CHECKSUMS.sha256` alongside your deployed
  version for change-management evidence.
- [ ] Before any upgrade/repair, confirm `/var/backups/dcim/` (Linux) or
  `C:\ProgramData\dcim-backups\` (Windows) has free space - each
  upgrade/repair takes its own pre-change snapshot automatically.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Service won't start | `journalctl -u dcim -n 100` / `service-stderr.log` |
| Can't reach OME/OneView from Monitoring tab | Use the **Test Connection** button first - it reports the exact failure (DNS, TLS, auth) |
| "Access token required" / 401 on everything | Sign out and back in; check system clock skew (JWT `exp` is time-based) |
| 403 with `PASSWORD_CHANGE_REQUIRED` | The signed-in account still has the seeded default password - change it first |
| Upload rejected | Check the file's MIME type/extension against the upload validation rules; see Security Validation in the Release Gate for the exact allowlist |

For anything not covered here, generate a **Support Bundle** and include it
with your support request.
