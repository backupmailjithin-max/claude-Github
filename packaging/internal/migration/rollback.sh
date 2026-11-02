#!/usr/bin/env bash
# Puts the old folder back (the one cutover.sh kept). Your database needs no change: the new version only ADDS tables
# and columns, which the old version ignores. Data entered since the cutover stays in the database.
#   sudo SERVICE=<service name> ./rollback.sh [/home/webapp]
set -euo pipefail
OLD="${1:-/home/webapp}"; SERVICE="${SERVICE:?Set SERVICE=<service name>}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
STOP_CMD="${STOP_CMD:-systemctl stop $SERVICE}"; START_CMD="${START_CMD:-systemctl start $SERVICE}"
KEEP="$(cat "$OLD/.cutover-previous" 2>/dev/null || true)"
[ -n "$KEEP" ] && [ -f "$KEEP/server.js" ] || { echo "ERROR: no kept old folder found (.cutover-previous missing)." >&2; exit 1; }
TS="$(date +%Y%m%d-%H%M%S)"
echo "[1/4] Stopping service"; eval "$STOP_CMD"
echo "[2/4] Setting the new folder aside as ${OLD}.failed-${TS}"; mv "$OLD" "${OLD}.failed-${TS}"
echo "[3/4] Restoring $KEEP"; mv "$KEEP" "$OLD"
# keep files users added after cutover
for d in uploads backups; do if [ -d "${OLD}.failed-${TS}/$d" ]; then cp -an "${OLD}.failed-${TS}/$d/." "$OLD/$d/" 2>/dev/null || true; fi; done
echo "[4/4] Starting service"; eval "$START_CMD"
for i in $(seq 1 45); do if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then echo "PASS: old version is running again: $(curl -fsS "$HEALTH_URL")"; exit 0; fi; sleep 2; done
echo "FAIL: old version did not become healthy" >&2; exit 2
