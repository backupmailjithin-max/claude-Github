#!/usr/bin/env bash
# Moves a running OLDER internal webapp (for example v3.2.1) to the new internal build in one safe step.
# The old folder is KEPT (renamed) so you can go back at any time. Nothing is deleted.
#   sudo SERVICE=<service name> ./cutover.sh [/home/webapp]
# Optional: HEALTH_URL (default http://127.0.0.1:3001/api/health), SKIP_DB_DUMP=1 (not recommended),
#           STOP_CMD / START_CMD (for testing).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OLD="${1:-/home/webapp}"
SERVICE="${SERVICE:?Set SERVICE=<systemd service name of the live app>, e.g. sudo SERVICE=dcim-webapp ./cutover.sh}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
STOP_CMD="${STOP_CMD:-systemctl stop $SERVICE}"; START_CMD="${START_CMD:-systemctl start $SERVICE}"
NEWSRC="$HERE/webapp"; TS="$(date +%Y%m%d-%H%M%S)"; KEEP="${OLD}.before-${TS}"
[ -f "$OLD/server.js" ] && [ -f "$OLD/.env" ] || { echo "ERROR: $OLD does not look like the live webapp (server.js or .env missing)." >&2; exit 1; }
[ -f "$NEWSRC/server.js" ] || { echo "ERROR: new files not found at $NEWSRC (unzip the package next to this script)." >&2; exit 1; }
[ -d "$OLD/lib" ] && [ -f "$OLD/lib/visitor-routes.js" ] && { echo "ERROR: $OLD already has the new library folder - it looks migrated. Use apply-update.sh for small updates." >&2; exit 1; }
envval(){ { grep -E "^$1=" "$OLD/.env" || true; } | tail -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'; }

echo "[1/7] Database backup (before anything changes)"
if [ "${SKIP_DB_DUMP:-0}" != "1" ]; then
  DBH="$(envval DB_HOST)"; DBU="$(envval DB_USER)"; DBP="$(envval DB_PASSWORD)"; DBN="$(envval DB_NAME)"; DBO="$(envval DB_PORT)"
  DUMP="${OLD}-db-before-${TS}.sql.gz"
  MYSQL_PWD="$DBP" mysqldump -h "${DBH:-localhost}" ${DBO:+-P "$DBO"} -u "${DBU:-root}" --single-transaction --routines "${DBN:-datacenter_db}" | gzip > "$DUMP"
  [ -s "$DUMP" ] && echo "      saved $DUMP ($(du -h "$DUMP" | cut -f1))" || { echo "ERROR: database backup is empty - stopping. Nothing was changed." >&2; exit 1; }
else echo "      skipped (SKIP_DB_DUMP=1)"; fi

echo "[2/7] Stopping service $SERVICE"; eval "$STOP_CMD"
echo "[3/7] Keeping the old folder as $KEEP"; mv "$OLD" "$KEEP"
echo "[4/7] Installing the new files"; cp -a "$NEWSRC" "$OLD"
echo "[5/7] Carrying over your settings and data (.env, uploads, backups, logs)"
cp -a "$KEEP/.env" "$OLD/.env"
for d in uploads backups logs; do if [ -d "$KEEP/$d" ]; then rm -rf "$OLD/$d"; cp -a "$KEEP/$d" "$OLD/$d"; else mkdir -p "$OLD/$d"; fi; done
chown -R --reference="$KEEP" "$OLD" 2>/dev/null || true
command -v restorecon >/dev/null 2>&1 && restorecon -R "$OLD" 2>/dev/null || true
echo "$KEEP" > "$OLD/.cutover-previous"

echo "[6/7] Starting service"; eval "$START_CMD"
echo "[7/7] Health check"
for i in $(seq 1 45); do if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo "PASS: $(curl -fsS "$HEALTH_URL")"; echo "Old version kept at: $KEEP"
  echo "If anything is wrong:  sudo SERVICE=$SERVICE ./rollback.sh $OLD"; exit 0; fi; sleep 2; done
echo "FAIL: the new version did not become healthy. Run:  sudo SERVICE=$SERVICE ./rollback.sh $OLD" >&2; exit 2
