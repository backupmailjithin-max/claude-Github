# DCIM Internal Update: Deployment Guide

For the internal, licence-free edition on an existing running server. This is a **file replacement**: no installer, no Node.js, OCR or MariaDB runtime, no database change, no `npm install`.

## What it changes
{{FILE_COUNT}} files only (listed in `FILES.txt` and in CHANGELOG.md). It never touches `.env`, `uploads`, `backups`, `logs`, `node_modules` or the database.

## Before you start
1. Confirm this is the **internal** edition (no licence prompt, no trial banner).
2. Confirm the install is the build this package updates: **{{BASELINE}}**. The script refuses to run on an older install.
3. Take the usual database backup (Settings → Backup & Restore → download) and keep it off the server.
4. Do **not** set `INTEGRITY_MODE=enforce` or `restricted` on the internal edition. It has no signed manifest, so those modes would refuse to start. Leave `INTEGRITY_MODE` unset (default `warn`).

## Deploy (about 1 minute)
1. Copy the zip to the server and unzip it anywhere, for example `/tmp/dcim-internal-update`.
2. `cd /tmp/dcim-internal-update`
3. `sudo SERVICE=<your service name> HEALTH_URL=http://127.0.0.1:<port>/api/health ./apply-update.sh <install folder>`
   Example for the existing server: `sudo SERVICE=dcim-webapp HEALTH_URL=http://127.0.0.1:3001/api/health ./apply-update.sh /home/webapp`
4. The script stops the service, copies the current versions of the files into a folder `dcim-update-backup-<time>` next to the install folder, replaces them, starts the service and waits for the health check.
5. Press **Ctrl+F5** in the browser to load the new interface.

> The service name and port above are the usual defaults. Use the real values from your `systemctl` unit and `.env`.

## After deployment: check
- `PASS` printed by the script (health check).
- Sign in; dashboard, Asset Inventory, Material Movements, Visitor Access, Monitoring, Settings open without errors.
- Settings → License shows no trial and no lock. No activation is needed.
- Settings → Backup & Restore: take a backup.
- Settings → Notifications: send a test email.
- Existing assets, users and uploads are still there.

If anything is wrong, roll back (see ROLLBACK.md).
