# DCIM Internal Update: Rollback Guide

Rollback restores exactly the {{FILE_COUNT}} files that the update replaced. Data is untouched.

1. Find the backup folder printed by the update (`dcim-update-backup-<time>`, next to the install folder).
2. `sudo SERVICE=<your service name> HEALTH_URL=http://127.0.0.1:<port>/api/health ./rollback-update.sh <backup folder>`
3. The script stops the service, copies the old files back, removes files the update added (listed as NEW in CHANGELOG.md), starts the service and waits for the health check.
4. Press Ctrl+F5 in the browser.

Keep the backup folder until you are satisfied with the update. The database needs no rollback because the update does not change it.
