# DCIM Repair Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

## When to use Repair

Use Repair when the application or its service is broken but your
**data** (database) is intact - for example:

- A webapp file was accidentally deleted or modified outside the app.
- The systemd unit / Windows service registration was removed or corrupted.
- A `node_modules` package got corrupted or partially deleted.
- The `.env` configuration file was lost or corrupted.

Repair **never** touches your database rows. It re-applies known-good
application files, re-registers the service, and (if needed) restores
`.env` from the most recent backup that still has one.

## What Repair does, automatically

1. Takes a pre-change snapshot (same as Upgrade).
2. If `.env` is missing, restores it from the most recent prior backup
   automatically (failing loudly, with a clear message, only if no backup
   exists at all - restore it manually from an external copy in that case).
3. Re-syncs the webapp files from a known-good source (the original
   package's permanent copy for `.deb`/`.rpm` installs, or a small cached
   copy kept specifically for this purpose on standalone/appliance
   installs).
4. Re-registers and restarts the service.
5. Re-verifies health, including the embedded database service if you used
   `--embedded-db`/`-EmbeddedDb` (auto-detected - you do not need to
   re-pass the flag).

## Linux

```bash
sudo dcim-repair --port 8974 --db-user dcim --db-password 'YourPassword' --db-name dcim
# or, for an embedded-DB install:
sudo dcim-repair --port 8974
```

## Windows

```powershell
.\DCIM-Repair.exe
# or, for scripted/unattended:
packaging\windows\install.ps1 -Mode repair -Yes -InstallDir C:\DCIM -Port 8974
```

## What Repair cannot fix

- **A corrupted or lost database.** Use the Backup/Restore Guide or
  Disaster Recovery Guide instead - Repair is files/service only.
- **A damaged bundled Node runtime or embedded MariaDB engine on a
  standalone/appliance install**, if no prior cached copy exists at all
  (this would only happen if Repair has never successfully run since the
  very first install). In that case, reinstall from the original
  `.deb`/`.rpm`/appliance, which always carries its own complete, fresh
  copy.

## Verifying a repair

```bash
# Linux
sudo systemctl is-active dcim
curl http://127.0.0.1:8974/api/health

# Windows
Get-Service DCIM
Invoke-RestMethod http://127.0.0.1:8974/api/health
```
Your data (Users, Assets, Locations, Transfers, etc.) is unaffected - no
verification of application data is needed after a repair, only that the
service is healthy again.
