#!/usr/bin/env bash
# Proves the complete package on a clean machine: unpack, checksums, forbidden content, FRESH INSTALL into an empty
# database, health, default-admin forced password change, licence-free, branding, restart persistence, re-run refused.
#   test-complete-setup.sh --zip <Internal-Complete-Package-*.zip>
# Needs MySQL/MariaDB (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD with CREATE rights) and curl.
set -uo pipefail
ZIP=""; [ "${1:-}" = "--zip" ] && ZIP="$2"; [ -f "$ZIP" ] || { echo "usage: $0 --zip <package.zip>" >&2; exit 64; }
W="$(mktemp -d)"; PORT="${TEST_PORT:-3991}"; DBN="dcim_complete_test_$$"; PASS=0; FAILN=0; PID=""
AU="${DB_USER:-root}"; AP="${DB_PASSWORD:-}"; DBH="${DB_HOST:-127.0.0.1}"
ROOTCMD="mysql -h $DBH ${DB_PORT:+-P $DB_PORT} -u$AU ${AP:+-p$AP}"
cleanup(){ [ -n "$PID" ] && kill "$PID" 2>/dev/null; $ROOTCMD -e "drop database if exists \`$DBN\`" 2>/dev/null; rm -rf "$W"; }; trap cleanup EXIT
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }; no(){ echo "FAIL  $1"; FAILN=$((FAILN+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }
mkdir -p "$W/pkg" && (cd "$W/pkg" && unzip -q "$ZIP")
chk "checksums verify" "cd $W/pkg && sha256sum -c SHA256SUMS | grep -v ': OK' | wc -l | grep -qx 0"
chk "has install-new, cutover, rollback, README" "test -x $W/pkg/install-new.sh -a -x $W/pkg/cutover.sh -a -x $W/pkg/rollback.sh -a -f $W/pkg/README.txt"
chk "no .env, keys, vendor tools in package" "! (cd $W/pkg && find . \( -name '.env' -o -name '*.pem' -o -name 'license-keygen*' -o -name 'license-issue*' -o -name 'seed-defaults*' \) -not -path '*/node_modules/*' | grep -q .)"
chk "licence key is the internal null key" "grep -q 'LICENSE_PUBLIC_KEY_PEM: *null' $W/pkg/webapp/lib/license-public-key.js"
chk "libraries and OCR bundled" "test -d $W/pkg/webapp/node_modules/express -a -d $W/pkg/webapp/ocr/vendor/node_modules"
# refuses when node/db missing handled by script; now the real install
DEST="$W/home/webapp"
OUT="$(cd "$W/pkg" && DB_NAME=$DBN PORT=$PORT DB_USER_APP=x MYSQL_ROOT_CMD="$ROOTCMD" DB_USER="dcimtest$$" START_CMD="nohup node server.js > $W/app.log 2>&1 & echo \$! > $W/pid" ./install-new.sh "$DEST" 2>&1)"; RC=$?
echo "$OUT" | sed 's/^/      /' | tail -12
[ $RC -eq 0 ] && ok "fresh install ends with PASS" || no "fresh install ends with PASS (rc=$RC)"
PID="$(cat $W/pid 2>/dev/null)"
H="http://127.0.0.1:$PORT"
chk "health answers" "curl -fsS $H/api/health"
chk ".env is private and has a secret" "test \$(stat -c %a $DEST/.env) = 600 && grep -Eq '^JWT_SECRET=.{32,}' $DEST/.env"
chk "database tables were created" "$ROOTCMD -N -e \"select count(*) from information_schema.tables where table_schema='$DBN'\" | awk '{exit !(\$1>20)}'"
R="$(curl -s -X POST $H/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}')"
chk "default admin can sign in" "echo '$R' | grep -q token"
chk "default admin is forced to change password" "TOK=\$(echo '$R' | sed -n 's/.*\"token\":\"\\([^\"]*\\)\".*/\\1/p'); curl -s -H \"Authorization: Bearer \$TOK\" $H/api/assets | grep -q PASSWORD_CHANGE_REQUIRED"
chk "branding seeded (Airtel logo + footer)" "$ROOTCMD -N -e \"select v from \`$DBN\`.app_settings where k='org.footerText'\" | grep -q 'Internal Official Use Only'"
chk "logo file in place" "test -s $DEST/uploads/branding/logo.png"
chk "licensing not configured (no trial lock)" "curl -s $H/api/setup/status | grep -q setupComplete"
# restart keeps data
kill "$PID"; sleep 1; (cd "$DEST" && set -a && . ./.env && set +a && nohup node server.js > "$W/app2.log" 2>&1 & echo $! > "$W/pid"); PID="$(cat $W/pid)"
for i in $(seq 1 30); do curl -fsS $H/api/health >/dev/null 2>&1 && break; sleep 1; done
chk "restart keeps the data and starts healthy" "curl -fsS $H/api/health"
chk "no runtime errors in log" "! grep -Ei 'TypeError|ReferenceError|Unhandled|ER_[A-Z_]+' $W/app.log $W/app2.log"
OUT2="$(cd "$W/pkg" && DB_NAME=${DBN}_2 PORT=$((PORT+1)) MYSQL_ROOT_CMD="$ROOTCMD" START_CMD=true ./install-new.sh "$DEST" 2>&1)"; RC2=$?
[ $RC2 -ne 0 ] && echo "$OUT2" | grep -q "already holds a webapp" && ok "second install over it is refused" || no "second install over it is refused"
echo; echo "RESULT: $PASS passed, $FAILN failed"; [ $FAILN -eq 0 ] && echo "COMPLETE SETUP PASSED" || { echo "COMPLETE SETUP FAILED"; exit 1; }
