#!/usr/bin/env bash
# Restores the files saved by apply-update.sh. Usage: ./rollback-update.sh <backup-folder> [same SERVICE/STOP_CMD/START_CMD/HEALTH_URL settings]
set -euo pipefail
BK="${1:?usage: rollback-update.sh <dcim-update-backup-folder>}"
SERVICE="${SERVICE:-dcim-webapp}"; HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
STOP_CMD="${STOP_CMD:-systemctl stop $SERVICE}"; START_CMD="${START_CMD:-systemctl start $SERVICE}"
TARGET="$(cat "$BK/TARGET.txt")"; FILES="$(cat "$BK/FILES.txt")"
echo "[1/4] Stopping service"; eval "$STOP_CMD"
echo "[2/4] Restoring previous files"
( cd "$BK" && for f in $FILES; do if [ -f "$f" ]; then cp -p "$f" "$TARGET/$f"; fi; done )
if [ -f "$BK/NEW_FILES.txt" ]; then while read -r f; do rm -f "$TARGET/$f"; done < "$BK/NEW_FILES.txt"; fi
echo "[3/4] Starting service"; eval "$START_CMD"
echo "[4/4] Health check"
for i in $(seq 1 30); do if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then echo "PASS: $(curl -fsS "$HEALTH_URL")"; exit 0; fi; sleep 2; done
echo "FAIL: health check did not pass after rollback" >&2; exit 2
