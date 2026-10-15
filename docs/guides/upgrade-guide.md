# DCIM Upgrade Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

## What an upgrade does, automatically

1. **Create Backup** - a full pre-change snapshot (`.env`, webapp files
   excluding `node_modules`, and a real `mysqldump` of the database) saved
   to `/var/backups/dcim/<timestamp>/` (Linux) or
   `C:\ProgramData\dcim-backups\<timestamp>\` (Windows).
2. **Stop Service**.
3. **Upgrade** - new application files are synced in (your `.env`,
   `uploads/`, `backups/`, and `logs/` are always preserved - never
   overwritten).
4. **Validate** - the systemd unit / Windows service is re-registered, and
   the embedded database (if used) is re-verified as the same instance.
5. **Restart Service**.
6. **Verify** - health is polled until it reports `ok`, then a structured
   `/api/health/validate` report runs automatically.

Everything in the database and your configuration survives an upgrade:
Users, Assets, Locations, Zones, Transfers, Store Inventory, Firmware
Targets/Settings, Monitoring Settings, Branding, and `app_settings`.

## Linux

```bash
sudo dcim-upgrade --port 8974 --db-user dcim --db-password 'YourPassword' --db-name dcim
# or, for an embedded-DB install, simply:
sudo dcim-upgrade --port 8974
```
`dcim-upgrade` is a dedicated, memorable entry point - internally it's
`install.sh --mode upgrade --yes` with the same flags as install.

**Standalone installs (not via `.deb`/`.rpm`):** `dcim-upgrade` re-applies
the *cached* copy of the webapp from your original install/appliance run -
it does not fetch a newer version on its own. To upgrade to a genuinely
newer release on a standalone install, re-run the **new** version's
`install.sh --mode upgrade` directly from its own extracted source. A
`.deb`/`.rpm` upgrade (`sudo dpkg -i dcim_<new-version>_amd64.deb` or
`sudo rpm -U dcim-<new-version>.rpm`) always picks up the new package's own
bundled files automatically - this distinction doesn't apply there.

## Windows

```powershell
.\DCIM-Upgrade.exe
# or, for scripted/unattended:
packaging\windows\install.ps1 -Mode upgrade -Yes -InstallDir C:\DCIM -Port 8974
```
`DCIM-Upgrade.exe` carries its own full, current-version payload (it is
built fresh for each release from the same source as `DCIM-Setup.exe`), so
it always upgrades to the version it was built from - no "cached version"
caveat on Windows.

## Before you upgrade

- [ ] Confirm free disk space for the automatic pre-upgrade backup (a full
  `mysqldump` plus a webapp files snapshot).
- [ ] Note your current version (`GET /api/health` returns it) for the
  Upgrade Matrix in this kit's `common/docs/`.
- [ ] If you use `--embedded-db`, no action needed - the embedded instance
  is auto-detected and preserved without re-passing the flag.

## After you upgrade

- Confirm `GET /api/health` reports `ok` and the new version number.
- Review the automatic `/api/health/validate` report printed at the end of
  the upgrade (or re-run it via the dashboard).
- The pre-upgrade snapshot is NOT deleted automatically - see the Backup
  Guide for retention and the Rollback Guide if you need to revert.
