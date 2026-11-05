#!/usr/bin/env bash
# Complete setup of the INTERNAL DCIM webapp on a server that has no DCIM yet.
# Needs on the server: Node.js 18 or newer, and MariaDB/MySQL running. Nothing is downloaded.
#   sudo ./install-new.sh [/home/webapp]
# Optional settings (environment): SERVICE (webapp)  PORT (3001)  DB_NAME (datacenter_db)  DB_USER (dcim)
#   DB_PASSWORD (random)  DB_HOST (localhost)  SVC_USER (webapp)  NODE_BIN  MYSQL_ROOT_CMD ("mysql -uroot")
#   CORS_ORIGIN (https://<server>)  SKIP_SYSTEMD=1 / START_CMD / STOP_CMD (for test runs)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-/home/webapp}"; SERVICE="${SERVICE:-webapp}"; PORT="${PORT:-3001}"
DB_NAME="${DB_NAME:-datacenter_db}"; DB_USER="${DB_USER:-dcim}"; DB_HOST="${DB_HOST:-localhost}"
SVC_USER="${SVC_USER:-webapp}"; NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
MYSQL_ROOT_CMD="${MYSQL_ROOT_CMD:-mysql -uroot}"; HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$PORT/api/health}"
rand(){ openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
DB_PASSWORD="${DB_PASSWORD:-$(rand 12)}"
fail(){ echo "ERROR: $*" >&2; exit 1; }

echo "[1/8] Checking the server"
[ -f "$HERE/webapp/server.js" ] || fail "the webapp folder is not next to this script (unzip the whole package first)."
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "Node.js is not installed (need version 18 or newer)."
NV="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"; [ "$NV" -ge 18 ] || fail "Node.js $NV is too old (need 18 or newer)."
[ ! -e "$DEST/server.js" ] || fail "$DEST already holds a webapp. For a server that already runs DCIM use cutover.sh (older version) or apply-update.sh (small update)."
if [ -z "${START_CMD:-}" ]; then command -v systemctl >/dev/null 2>&1 || fail "systemd not found."; [ ! -f "/etc/systemd/system/$SERVICE.service" ] || fail "service $SERVICE already exists. Use another name: SERVICE=<name> ./install-new.sh"; fi
(echo >/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null && fail "port $PORT is already in use. Choose another: PORT=<number> ./install-new.sh"
$MYSQL_ROOT_CMD -e "select 1" >/dev/null 2>&1 || fail "cannot reach the database as administrator. Check that MariaDB/MySQL is running, or set MYSQL_ROOT_CMD (for example 'mysql -uroot -pSECRET')."
EXIST="$($MYSQL_ROOT_CMD -N -e "select count(*) from information_schema.schemata where schema_name='$DB_NAME'")"
[ "$EXIST" = "0" ] || fail "database $DB_NAME already exists. Choose another name: DB_NAME=<name> ./install-new.sh"

echo "[2/8] Creating the database $DB_NAME and user $DB_USER"
$MYSQL_ROOT_CMD -e "CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"

echo "[3/8] Installing the files into $DEST"
mkdir -p "$(dirname "$DEST")"; cp -a "$HERE/webapp" "$DEST"
mkdir -p "$DEST/uploads" "$DEST/backups" "$DEST/logs"

echo "[4/8] Writing the settings file (.env)"
HOSTIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat > "$DEST/.env" <<ENV
PORT=$PORT
DB_HOST=$DB_HOST
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
JWT_SECRET=$(rand 32)
CORS_ORIGIN=${CORS_ORIGIN:-https://${HOSTIP:-localhost}}
NODE_ENV=production
ENV
chmod 600 "$DEST/.env"

echo "[5/8] Service account and folder owner"
if [ -z "${START_CMD:-}" ]; then
  id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DEST" --shell /sbin/nologin "$SVC_USER"
  chown -R "$SVC_USER": "$DEST"
fi
command -v restorecon >/dev/null 2>&1 && restorecon -R "$DEST" 2>/dev/null || true

echo "[6/8] Registering the service $SERVICE"
if [ -z "${START_CMD:-}" ]; then
  cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=DCIM web application (internal)
After=network.target mysqld.service mariadb.service
[Service]
Type=simple
WorkingDirectory=$DEST
ExecStart=$NODE_BIN server.js
EnvironmentFile=$DEST/.env
User=$SVC_USER
Group=$SVC_USER
Restart=always
RestartSec=3
SyslogIdentifier=$SERVICE
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable "$SERVICE" >/dev/null 2>&1
fi

echo "[7/8] Starting"
if [ -n "${START_CMD:-}" ]; then (cd "$DEST" && set -a && . ./.env && set +a && eval "$START_CMD"); else systemctl start "$SERVICE"; fi

echo "[8/8] Health check"
for i in $(seq 1 45); do if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  [ -f "$HERE/branding/seed-branding.sh" ] && { "$HERE/branding/seed-branding.sh" "$DEST" || echo "      (branding step failed - set branding in the setup wizard)"; }
  echo "PASS: $(curl -fsS "$HEALTH_URL")"
  echo "Open https://${HOSTIP:-<server>}  (or http://127.0.0.1:$PORT here). First sign-in: admin / admin - you are asked to change the password at once."
  echo "Database password is stored only in $DEST/.env. Put nginx/HTTPS in front before real use."
  exit 0; fi; sleep 2; done
echo "FAIL: the app did not become healthy. See: journalctl -u $SERVICE -n 50" >&2; exit 2
