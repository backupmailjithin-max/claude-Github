# DCIM Backup & Restore Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

This covers the **application-level** backup/restore feature (full database
export/import via the UI and API) - distinct from the automatic pre-change
snapshots that Upgrade/Repair take for themselves (see the Rollback Guide
for those).

## What's included in a backup

Every row in: Locations, Rack Types, Hardware Types, Zones, Racks, Floor
Plans, Users, Assets, Rack Components, Asset Movements, Issues, DC
Activities, Material Movements, Material Movement Documents, Firmware
Targets, Firmware Model Targets, Asset Connectivity, Asset Hardware
Details, and `app_settings` (which covers Branding, Monitoring
configuration, and Security settings like password policy).

Uploaded files (branding logo/favicon, Material Movement documents) are
**not** included in the database backup above - export them separately via
**Setup Wizard > Export/Import > Export Files Archive** for a complete
disaster-recovery set (see the Disaster Recovery Guide).

## Creating a backup

**Via the UI:** Setup Wizard > Backup > **Download Backup Now**, or
configure automatic nightly backups (enabled by default - daily, 7-day
retention, configurable).

**Via the API:**
```bash
# Download a fresh backup directly (no server-side file kept):
curl -fsS http://127.0.0.1:8974/api/backup/download \
  -H "Authorization: Bearer $TOKEN" -o dcim-backup.json.gz

# Or trigger a server-side backup (kept in the configured backup folder,
# subject to retention):
curl -fsS -X POST http://127.0.0.1:8974/api/backup/run \
  -H "Authorization: Bearer $TOKEN"
```
Backups are `.json.gz` - a gzip-compressed JSON export, not a raw SQL dump.

## Restoring a backup

**This is destructive** - it replaces current data with the backup's data.
A safety backup of the *current* state is always taken automatically
immediately before a restore proceeds, so a restore can itself be undone.

```bash
curl -fsS -X POST http://127.0.0.1:8974/api/backup/restore \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@dcim-backup.json.gz;type=application/gzip" \
  -F "confirm=RESTORE"
```
The literal string `RESTORE` in the `confirm` field is required - this is
intentional friction to prevent an accidental restore. Via the UI, this is
the same confirmation typed into the Restore dialog.

You can also run a **dry run** first (`dryRun: true` instead of `confirm`)
to see what the backup contains and how it compares to current data,
without changing anything.

## Retention & scheduling

Configurable via Setup Wizard > Backup or `GET`/`PUT /api/backup/settings`:
enable/disable automatic backups, the destination folder, and retention
(days to keep, default 7). Old backups beyond retention are pruned
automatically; you can also download or delete individual server-side
backup files from the same page.

## Verifying a backup is restorable

Run a dry-run restore (above) periodically against your production backups
in a non-production environment - this validates the backup file is
readable and intact (checksum-verified when restoring from a server-kept
file) without any risk to live data.
