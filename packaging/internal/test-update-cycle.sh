#!/usr/bin/env bash
# Proves an Internal-Update-Package on a stand-in for production: starts the OLD internal build, applies the
# package, checks health/licensing/data, rolls back and checks the old files are restored byte-for-byte.
#   test-update-cycle.sh --baseline <git-ref> --zip <package.zip>
# Needs a reachable MySQL/MariaDB (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME) and `npm ci` done in dcim/webapp.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
BASE=""; ZIP=""
while [ $# -gt 0 ]; do case "$1" in --baseline) BASE="$2"; shift 2;; --zip) ZIP="$2"; shift 2;; *) echo "unknown $1" >&2; exit 2;; esac; done
[ -n "$BASE" ] && [ -f "$ZIP" ] || { echo "usage: $0 --baseline <ref> --zip <file>" >&2; exit 2; }
W="$(mktemp -d)"; PORT="${TEST_PORT:-18982}"; PIDF="$W/node.pid"
cleanup(){ [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; rm -rf "$W"; }; trap cleanup EXIT
export PORT DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-3306}" DB_USER="${DB_USER:-root}" DB_PASSWORD="${DB_PASSWORD:-}" DB_NAME="${DB_NAME:-dcim_update_test}"
export JWT_SECRET="${JWT_SECRET:-update-cycle-test-secret-0123456789abcdef}" NODE_ENV=development
fail=0; ok(){ echo "PASS  $*"; }; bad(){ echo "FAIL  $*"; fail=1; }

# Stand-in production = old internal build
mkdir -p "$W/old"; git -C "$REPO" archive "$BASE" dcim/webapp | tar -x -C "$W/old"
if git -C "$REPO" cat-file -e "$BASE:dcim/internal-no-license" 2>/dev/null; then git -C "$REPO" archive "$BASE" dcim/internal-no-license | tar -x -C "$W/old"; cp -r "$W/old/dcim/internal-no-license/." "$W/old/dcim/webapp/"; fi
PROD="$W/prod"; mv "$W/old/dcim/webapp" "$PROD"; ln -s "$REPO/dcim/webapp/node_modules" "$PROD/node_modules"
mkdir -p "$PROD/uploads" "$PROD/backups" "$PROD/logs"; echo keep > "$PROD/uploads/keep.txt"; echo "PORT=$PORT" > "$PROD/.env"

start(){ ( cd "$PROD" && setsid nohup node server.js > "$W/node.log" 2>&1 & echo $! > "$PIDF" ); }
stop(){ [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; sleep 1; }
health(){ for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

start; health && ok "old build starts" || { bad "old build did not start"; tail -20 "$W/node.log"; exit 1; }
mkdir -p "$W/pkg"; unzip -q "$ZIP" -d "$W/pkg"
( cd "$PROD" && while read -r f; do [ -f "$f" ] && sha256sum "$f"; done < "$W/pkg/FILES.txt" ) > "$W/before.sha"
sha256sum "$PROD/.env" "$PROD/uploads/keep.txt" > "$W/keep.sha"

export STOP_CMD='kill "$(cat '"$PIDF"')" 2>/dev/null || true; sleep 1' HEALTH_URL="http://127.0.0.1:$PORT/api/health"
export START_CMD="cd '$PROD' && setsid nohup node server.js > '$W/node2.log' 2>&1 & echo \$! > '$PIDF'"
( cd "$W/pkg" && ./apply-update.sh "$PROD" ) > "$W/apply.out" 2>&1 && ok "apply-update: stop, backup, replace, start, health" || { bad "apply-update failed"; cat "$W/apply.out"; exit 1; }
sha256sum -c "$W/keep.sha" >/dev/null && ok ".env and uploads untouched" || bad ".env/uploads changed"
cmp -s "$PROD/lib/license-public-key.js" "$REPO/dcim/internal-no-license/lib/license-public-key.js" && ok "licence key is the internal null-key overlay" || bad "licence key is not the overlay"
tok="$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || true
if [ -n "${tok:-}" ]; then
  st="$(curl -sS "http://127.0.0.1:$PORT/api/license/status" -H "Authorization: Bearer $tok" 2>/dev/null || true)"
  if echo "$st" | grep -q 'PASSWORD_CHANGE_REQUIRED'; then echo "SKIP  licence status (the default admin must change its password first; the licence key file check above covers it)"
  else echo "$st" | grep -q '"mode":"off"' && ok "licensing mode is off" || bad "licensing status: $st"; fi
else echo "SKIP  licence status (admin/admin not available on this database)"; fi
grep -qiE "uncaught|TypeError|ReferenceError" "$W/node2.log" && bad "errors in log after update" || ok "no runtime errors in log"

BK="$(ls -d "$W"/dcim-update-backup-* | head -1)"
( cd "$W/pkg" && ./rollback-update.sh "$BK" ) > "$W/rb.out" 2>&1 && ok "rollback-update: restore, start, health" || { bad "rollback failed"; cat "$W/rb.out"; exit 1; }
( cd "$PROD" && while read -r f; do [ -f "$f" ] && sha256sum "$f"; done < "$W/pkg/FILES.txt" ) > "$W/after.sha"
cmp -s "$W/before.sha" "$W/after.sha" && ok "rolled-back files are byte-identical to the old build" || bad "rollback did not restore files"
[ "$fail" -eq 0 ] && echo "RESULT: UPDATE CYCLE PASSED" || { echo "RESULT: UPDATE CYCLE FAILED"; exit 1; }
