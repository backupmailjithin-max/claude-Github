# DCIM Production Migration Runbook (v3.2.1 to new internal build 3.2.2)

Plan about 15 minutes. The application is unavailable for about 2 minutes while the service restarts. Nothing is deleted: the old folder is kept and you can go back with one command.

**Use the test copy first** (see the recommendation document). Do this on production only after the test copy has been checked by your team.

## Before you start (5 minutes)
1. Choose a quiet time and tell users.
2. In the live app, open **Settings → Backup & Restore**, take a manual backup and **download it to your own PC**.
3. Make sure the server has at least 1 GB free: `df -h /home`
4. Find the live service name. Run this and note the name that belongs to the live app (the test copy is called `dcim-next`; do not use that one):
   `systemctl list-units --type=service | grep -i -E "dcim|webapp"`
5. Confirm the live folder is the OLD version. This command must say "No such file or directory":
   `ls /home/webapp/lib`

## Install the files
6. Copy `Internal-Migration-Package-3.2.2-*.zip` to the server, for example into `/tmp`.
7. Unpack it:
   `cd /tmp && mkdir -p dcim-migration && cd dcim-migration && unzip -o ../Internal-Migration-Package-3.2.2-*.zip`
   (If `unzip` is not installed: `python3 -m zipfile -e ../Internal-Migration-Package-3.2.2-*.zip .`)
8. Check the files arrived intact: `sha256sum -c SHA256SUMS | grep -v ": OK"` must print nothing.

## Cut over (about 2 minutes)
9. Run (replace `<service>` with the name from step 4):
   `sudo SERVICE=<service> ./cutover.sh /home/webapp`
10. The script:
    - saves a database backup next to the folder (`/home/webapp-db-before-<time>.sql.gz`),
    - stops the service,
    - renames the old folder to `/home/webapp.before-<time>`,
    - installs the new files,
    - copies your `.env`, `uploads`, `backups` and `logs` across,
    - starts the service and waits for the health check.
11. It must end with `PASS`. If it ends with `FAIL`, run the rollback command it prints.

## Check (5 minutes)
12. In the browser press **Ctrl+F5**, then sign in.
13. Open: Dashboard, Asset Inventory (count should match yesterday), DC Capacity, Monitoring, Power Capacity, Issue Tracker, Material Movements, Visitor Access, Settings.
14. Settings → Users: your users are all there. Settings → License: reads "Licensing not configured".
15. Settings → Backup & Restore: take a backup. Settings → Notifications: send a test email (set the mail server there if needed).
16. If you use Dell OME or HPE OneView: open Monitoring and press Sync once. Re-enter REDFISH settings in `.env` only if you use Multi-Vendor (Redfish).

## If anything is wrong: go back (about 1 minute)
`cd /tmp/dcim-migration && sudo SERVICE=<service> ./rollback.sh /home/webapp`
The old folder returns. The database needs no change: the new version only adds tables and columns, and the old version ignores them. Data entered after the cutover stays in the database.

## Afterwards
- Keep `/home/webapp.before-<time>` and the `.sql.gz` file for a week, then delete them yourself.
- The new folder is clean: the old `server6.js` to `server12.js`, `app-compiled19.js` to `27.js`, `index1.html` to `index5.html` copies stay only in the old folder.
- The first start creates these tables by itself: asset_connectivity, asset_hw_details, audit_logs, firmware_jobs, pdus, power_readings, visitor_requests, visitor_access_documents.
