# DCIM Rollback Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

## What Rollback is for

Every Upgrade and every Repair automatically takes a full pre-change
snapshot first - application files, `.env`, and a real database dump
(`mysqldump`). Rollback restores DCIM to that exact snapshot. Use it when
an upgrade or repair produces unexpected results and you need to revert.

Rollback restores: **Files, Database, Configuration (`.env`), Branding, and
Monitoring settings** - everything captured in the pre-change snapshot,
which covers the full `app_settings`/configuration table set, not just the
application code.

## Linux

```bash
# Roll back to the most recent snapshot (recorded automatically by every
# Upgrade/Repair at /opt/dcim/.last-pre-change-backup):
sudo bash rollback.sh

# Or roll back to a specific snapshot:
sudo bash rollback.sh /var/backups/dcim/20261015-213028
```
You will be prompted to confirm (`y`/`N`) before anything is stopped or
restored - this is destructive to whatever state exists right now.

## Windows

```powershell
# Roll back to the most recent snapshot:
.\rollback.ps1 -InstallDir C:\DCIM

# Or a specific one, non-interactively:
.\rollback.ps1 -InstallDir C:\DCIM -SnapshotDir "C:\ProgramData\dcim-backups\20261015-213028" -Yes
```
`-Yes` skips the confirmation prompt - use it only in scripted/unattended
contexts where you've already confirmed the right snapshot out-of-band.

## What happens during a rollback

1. The service is stopped.
2. Application files are restored from the snapshot's
   `webapp-files.tar.gz` (if present).
3. `.env` is restored from the snapshot (if present).
4. If the snapshot has a `database.sql.gz`, the database is restored via a
   real `mysql` import - the restore's exit code is checked explicitly, so
   a failed import is reported as a failure, never silently treated as
   success.
5. The service is restarted and health is re-verified.

## Important notes

- Rollback only has snapshots to work with going back as far as your
  Upgrade/Repair history - it is not a substitute for the independent,
  scheduled backups covered in the Backup Guide. Keep both.
- If no `database.sql.gz` exists in the snapshot (e.g. `mysqldump` wasn't
  available at snapshot time), only files/config are restored - you'll see
  this clearly logged, not silently skipped.
- Rolling back does not delete the snapshot you rolled back *from* - you
  can always move forward again by re-running Upgrade.
