# DCIM Release Notes

## v3.2.2 - DCIM Enterprise Offline Distribution Kit

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
