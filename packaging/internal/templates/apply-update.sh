#!/usr/bin/env bash
# DCIM internal update: replaces ONLY the files in this package. Never touches .env, uploads, backups, logs,
# node_modules or the database. Usage (run as root or the service owner):
#   ./apply-update.sh /home/webapp            # default service name: dcim-webapp
#   SERVICE=dcim ./apply-update.sh /opt/dcim/webapp
# Test hooks: STOP_CMD / START_CMD override the systemctl calls; HEALTH_URL overrides the health address.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?usage: apply-update.sh <install-dir containing server.js>}"
SERVICE="${SERVICE:-dcim-webapp}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
STOP_CMD="${STOP_CMD:-systemctl stop $SERVICE}"
START_CMD="${START_CMD:-systemctl start $SERVICE}"
[ -f "$TARGET/server.js" ] || { echo "ERROR: $TARGET/server.js not found - wrong folder?" >&2; exit 1; }
FILES="$(cd "$HERE" && cat FILES.txt)"
# Refuse to run on an install that is older than the build this package updates.
while read -r need; do
  [ -z "$need" ] && continue
  [ -f "$TARGET/$need" ] || { echo "ERROR: $TARGET/$need is missing - this install is older than the build this package updates. Stop and ask for a full update." >&2; exit 1; }
done < "$HERE/REQUIRES.txt"
for f in $FILES; do [ -f "$HERE/$f" ] || { echo "ERROR: package is missing $f" >&2; exit 1; }; done
TS="$(date +%Y%m%d-%H%M%S)"; BK="$TARGET/../dcim-update-backup-$TS"; mkdir -p "$BK"
echo "[1/5] Stopping service"; eval "$STOP_CMD"
echo "[2/5] Backing up current files to $BK"
( cd "$TARGET" && for f in $FILES; do if [ -f "$f" ]; then mkdir -p "$BK/$(dirname "$f")"; cp -p "$f" "$BK/$f"; else echo "$f" >> "$BK/NEW_FILES.txt"; fi; done )
echo "$TARGET" > "$BK/TARGET.txt"; cp "$HERE/FILES.txt" "$BK/FILES.txt"
echo "[3/5] Replacing files"
( cd "$HERE" && for f in $FILES; do mkdir -p "$TARGET/$(dirname "$f")"; cp -p "$f" "$TARGET/$f"; done )
echo "[4/5] Starting service"; eval "$START_CMD"
echo "[5/5] Health check"
ok=0; for i in $(seq 1 30); do if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi; sleep 2; done
if [ "$ok" -eq 1 ]; then echo "PASS: $(curl -fsS "$HEALTH_URL")"; echo "Rollback if needed: ./rollback-update.sh $BK"; else echo "FAIL: health check did not pass. Roll back: ./rollback-update.sh $BK" >&2; exit 2; fi
