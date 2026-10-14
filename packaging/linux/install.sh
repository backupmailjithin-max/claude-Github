#!/usr/bin/env bash
# DCIM installer for Linux (systemd). Supports fresh install, upgrade, and repair.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_NAME="DCIM"
SERVICE_NAME="dcim"
SERVICE_USER="dcim"
INSTALL_DIR="/opt/dcim"
ENV_FILE="$INSTALL_DIR/webapp/.env"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
MIN_NODE_MAJOR=18
MIN_FREE_MB=500
REQUIRED_PORT_DEFAULT=8974

PAYLOAD_WEBAPP="$SCRIPT_DIR/webapp"
PAYLOAD_RUNTIME="$SCRIPT_DIR/runtime/node"
[ -d "$PAYLOAD_WEBAPP" ] || PAYLOAD_WEBAPP="$SCRIPT_DIR/../../dcim/webapp"

MODE=""
PORT="$REQUIRED_PORT_DEFAULT"
DB_HOST="localhost"
DB_PORT="3306"
DB_USER="dcim"
DB_PASSWORD=""
DB_NAME="dcim"
CORS_ORIGIN=""
ASSUME_YES=0
PURGE_DATA=0

log()  { printf '[dcim-install] %s\n' "$*"; }
err()  { printf '[dcim-install] ERROR: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [--mode install|upgrade|repair] [options]

Options:
  --mode MODE          install | upgrade | repair (skips the interactive menu)
  --port PORT          HTTP port the app listens on (default: $REQUIRED_PORT_DEFAULT)
  --db-host HOST        (default: localhost)
  --db-port PORT        (default: 3306)
  --db-user USER        (default: dcim)
  --db-password PASS
  --db-name NAME         (default: dcim)
  --cors-origin ORIGIN
  --yes                 non-interactive, assume defaults / confirmations
  --purge-data          (uninstall only) also remove the database and data files
  -h, --help            show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    --db-port) DB_PORT="$2"; shift 2 ;;
    --db-user) DB_USER="$2"; shift 2 ;;
    --db-password) DB_PASSWORD="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --cors-origin) CORS_ORIGIN="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --purge-data) PURGE_DATA=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

require_root() {
  [ "$(id -u)" -eq 0 ] || die "This installer must be run as root (use sudo)."
}

existing_install_present() {
  [ -d "$INSTALL_DIR/webapp" ] && [ -f "$ENV_FILE" ]
}

# ---------- Validation ----------

validate_node() {
  local node_bin=""
  if [ -x "$PAYLOAD_RUNTIME/bin/node" ]; then
    node_bin="$PAYLOAD_RUNTIME/bin/node"
    log "Using bundled Node.js runtime at $node_bin"
  elif command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
    log "No bundled runtime found; using system Node.js at $node_bin"
  else
    die "No Node.js runtime found (bundled or system). Install Node.js ${MIN_NODE_MAJOR}+ or re-run the packaged installer that bundles it."
  fi
  local ver major
  ver="$("$node_bin" --version)"
  major="$(echo "${ver#v}" | cut -d. -f1)"
  [ "$major" -ge "$MIN_NODE_MAJOR" ] || die "Node.js $ver found, but $APP_NAME requires >= v$MIN_NODE_MAJOR."
  log "Node.js version check passed ($ver)."
  NODE_BIN="$node_bin"
}

validate_disk_space() {
  local avail_mb
  avail_mb="$(df -Pm "$(dirname "$INSTALL_DIR")" | awk 'NR==2 {print $4}')"
  [ "$avail_mb" -ge "$MIN_FREE_MB" ] || die "Only ${avail_mb}MB free; at least ${MIN_FREE_MB}MB is required."
  log "Disk space check passed (${avail_mb}MB available)."
}

validate_port() {
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${PORT}\$"; then
    if [ "$MODE" = "install" ]; then
      die "Port $PORT is already in use. Choose a different --port or stop the conflicting service."
    else
      log "Port $PORT is in use (expected: the existing $APP_NAME service)."
    fi
  else
    log "Port $PORT check passed (available)."
  fi
}

validate_write_permissions() {
  local parent
  parent="$(dirname "$INSTALL_DIR")"
  local probe="$parent/.dcim-install-write-test-$$"
  if ! ( : > "$probe" ) 2>/dev/null; then
    die "No write permission under $parent."
  fi
  rm -f "$probe"
  log "Write permission check passed ($parent)."
}

run_validations() {
  log "Running pre-flight validation..."
  validate_node
  validate_disk_space
  validate_port
  validate_write_permissions
  log "All validation checks passed."
}

# ---------- Mode selection ----------

choose_mode() {
  if [ -n "$MODE" ]; then return; fi
  if [ "$ASSUME_YES" -eq 1 ]; then
    MODE="install"
    if existing_install_present; then MODE="upgrade"; fi
    return
  fi
  echo ""
  echo "  $APP_NAME Setup"
  echo "  ------------"
  echo "  1) Install $APP_NAME"
  echo "  2) Upgrade Existing $APP_NAME"
  echo "  3) Repair Existing $APP_NAME"
  echo ""
  if existing_install_present; then
    log "Existing installation detected at $INSTALL_DIR."
  else
    log "No existing installation detected."
  fi
  read -r -p "Select an option [1-3]: " choice
  case "$choice" in
    1) MODE="install" ;;
    2) MODE="upgrade" ;;
    3) MODE="repair" ;;
    *) die "Invalid selection." ;;
  esac
}

# ---------- Actions ----------

ensure_service_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    log "Created service account '$SERVICE_USER'."
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 64
  fi
}

test_db_connection() {
  local mysql_bin
  mysql_bin="$(command -v mysql || true)"
  [ -n "$mysql_bin" ] || { log "mysql client not found on PATH; skipping live connection test (server will validate on first start)."; return 0; }
  local pw_arg=()
  [ -n "$DB_PASSWORD" ] && pw_arg=(-p"$DB_PASSWORD")
  if "$mysql_bin" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${pw_arg[@]}" -e "SELECT 1;" >/dev/null 2>&1; then
    log "Database connection test passed ($DB_HOST:$DB_PORT as $DB_USER)."
  else
    die "Could not connect to MySQL/MariaDB at $DB_HOST:$DB_PORT as $DB_USER. Check the DB is running and credentials are correct, then re-run with --db-* options."
  fi
}

write_env_file() {
  local jwt_secret
  jwt_secret="$(random_secret)"
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
JWT_SECRET=$jwt_secret
CORS_ORIGIN=$CORS_ORIGIN
NODE_ENV=production
EOF
  chmod 600 "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  log "Wrote $ENV_FILE with a freshly generated JWT secret."
}

sync_payload() {
  log "Syncing application files to $INSTALL_DIR/webapp ..."
  install -d -m 755 "$INSTALL_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.env' --exclude 'uploads' --exclude 'backups' --exclude 'logs' \
      "$PAYLOAD_WEBAPP/" "$INSTALL_DIR/webapp/"
  else
    mkdir -p "$INSTALL_DIR/webapp"
    for item in "$PAYLOAD_WEBAPP"/*; do
      base="$(basename "$item")"
      case "$base" in .env|uploads|backups|logs) continue ;; esac
      rm -rf "${INSTALL_DIR:?}/webapp/${base}"
      cp -a "$item" "$INSTALL_DIR/webapp/$base"
    done
  fi
  mkdir -p "$INSTALL_DIR/webapp/uploads" "$INSTALL_DIR/webapp/backups" "$INSTALL_DIR/webapp/logs"
  if [ -d "$PAYLOAD_RUNTIME" ]; then
    rm -rf "$INSTALL_DIR/runtime"
    install -d "$INSTALL_DIR/runtime"
    cp -a "$PAYLOAD_RUNTIME" "$INSTALL_DIR/runtime/node"
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
}

install_systemd_unit() {
  local exec_node="/usr/bin/node"
  [ -x "$INSTALL_DIR/runtime/node/bin/node" ] && exec_node="$INSTALL_DIR/runtime/node/bin/node"
  sed \
    -e "s#@EXEC_NODE@#$exec_node#g" \
    -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
    -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
    "$SCRIPT_DIR/dcim.service.template" > "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  log "Installed and enabled systemd service '$SERVICE_NAME' (auto-start on boot)."
}

import_schema_if_fresh() {
  local mysql_bin
  mysql_bin="$(command -v mysql || true)"
  [ -n "$mysql_bin" ] || { log "mysql client not found; the application will create/verify the schema on first start."; return 0; }
  local pw_arg=()
  [ -n "$DB_PASSWORD" ] && pw_arg=(-p"$DB_PASSWORD")
  if ! "$mysql_bin" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${pw_arg[@]}" -e "USE \`$DB_NAME\`; SHOW TABLES;" 2>/dev/null | grep -q .; then
    log "Importing schema.sql into database '$DB_NAME' ..."
    "$mysql_bin" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${pw_arg[@]}" "$DB_NAME" < "$INSTALL_DIR/webapp/schema.sql"
  else
    log "Database '$DB_NAME' already has tables; skipping schema import."
  fi
}

backup_before_change() {
  local ts backup_dir
  ts="$(date +%Y%m%d-%H%M%S)"
  backup_dir="/var/backups/dcim/$ts"
  install -d "$backup_dir"
  [ -f "$ENV_FILE" ] && cp -a "$ENV_FILE" "$backup_dir/.env"
  [ -d "$INSTALL_DIR/webapp" ] && tar -czf "$backup_dir/webapp-files.tar.gz" -C "$INSTALL_DIR" webapp --exclude=webapp/node_modules --exclude=webapp/ocr/vendor/node_modules 2>/dev/null || true
  # Real database snapshot via mysqldump, read from the installed .env (same
  # credentials the app itself uses) so Upgrade/Repair always has a restorable
  # rollback point, not just the config/file list above.
  local dump_bin
  dump_bin="$(command -v mysqldump || true)"
  if [ -n "$dump_bin" ] && [ -f "$ENV_FILE" ]; then
    local host user pass name
    host="$(sed -n 's/^DB_HOST=//p' "$ENV_FILE")"; user="$(sed -n 's/^DB_USER=//p' "$ENV_FILE")"
    pass="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE")"; name="$(sed -n 's/^DB_NAME=//p' "$ENV_FILE")"
    local pw_arg=(); [ -n "$pass" ] && pw_arg=(-p"$pass")
    if "$dump_bin" -h "${host:-localhost}" -u "${user:-dcim}" "${pw_arg[@]}" --single-transaction --routines --triggers "${name:-dcim}" 2>"$backup_dir/mysqldump.err" | gzip > "$backup_dir/database.sql.gz"; then
      log "Database snapshot saved to $backup_dir/database.sql.gz"
    else
      rm -f "$backup_dir/database.sql.gz"
      log "WARNING: mysqldump failed (see $backup_dir/mysqldump.err); only config/file snapshot was taken. Consider running the app's own Backup/Restore before continuing."
    fi
  else
    log "mysqldump not found; only config/file snapshot was taken. Consider running the app's own Backup/Restore before continuing."
  fi
  log "Pre-change snapshot saved to $backup_dir"
  echo "$backup_dir" > "$INSTALL_DIR/.last-pre-change-backup" 2>/dev/null || true
}

wait_for_health() {
  log "Waiting for the service to report healthy ..."
  local i
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
      log "Health check passed: http://127.0.0.1:${PORT}/api/health"
      return 0
    fi
    sleep 1
  done
  err "Service did not report healthy within 30s. Check: journalctl -u $SERVICE_NAME -n 100"
  return 1
}

do_install() {
  run_validations
  ensure_service_user
  sync_payload
  write_env_file
  test_db_connection
  import_schema_if_fresh
  install_systemd_unit
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  log "$APP_NAME installed. Sign in as admin / admin and change the password immediately."
}

do_upgrade() {
  existing_install_present || die "No existing installation found at $INSTALL_DIR; use --mode install instead."
  run_validations
  backup_before_change
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sync_payload
  install_systemd_unit
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  log "$APP_NAME upgraded in place. Previous config snapshot kept under /var/backups/dcim/."
}

do_repair() {
  existing_install_present || die "No existing installation found at $INSTALL_DIR; use --mode install instead."
  run_validations
  ensure_service_user
  backup_before_change
  sync_payload
  install_systemd_unit
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  log "$APP_NAME repaired (files, service, and permissions re-applied; your .env and data were preserved)."
}

main() {
  require_root
  choose_mode
  case "$MODE" in
    install) do_install ;;
    upgrade) do_upgrade ;;
    repair)  do_repair ;;
    *) die "Unknown mode: $MODE" ;;
  esac
}

main "$@"
