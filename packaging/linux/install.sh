#!/usr/bin/env bash
# DCIM installer for Linux (systemd). Supports fresh install, upgrade, and repair.
set -euo pipefail

# readlink -f (not plain dirname) because the .deb/.rpm ship /usr/bin/dcim-setup
# as a real symlink to this file - dirname on the symlink itself would resolve
# to /usr/bin instead of this script's actual directory, same class of bug
# already fixed in dcim-upgrade.sh/dcim-repair.sh.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

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
PAYLOAD_MARIADB="$SCRIPT_DIR/runtime/mariadb"
[ -d "$PAYLOAD_WEBAPP" ] || PAYLOAD_WEBAPP="$SCRIPT_DIR/../../dcim/webapp"
# Repair's own last-resort source of truth for a standalone/appliance install
# (see sync_payload/install_cli_utilities below) - populated from a genuine
# source whenever one is available, never from itself.
CLI_CACHE_DIR="$INSTALL_DIR/cli"
CACHED_WEBAPP_DIR="$CLI_CACHE_DIR/webapp-src"

MODE=""
PORT="$REQUIRED_PORT_DEFAULT"
DB_HOST="localhost"
DB_PORT="3306"
DB_USER="dcim"
DB_PASSWORD=""
DB_NAME="dcim"
CORS_ORIGIN=""
ADMIN_USER=""
ADMIN_PASSWORD=""
CSP_MODE="report-only"
AUDIT_RETENTION_DAYS="365"
ASSUME_YES=0
PURGE_DATA=0
EMBEDDED_DB=0
EMBEDDED_DB_PORT=3307
EMBEDDED_DB_SERVICE="dcim-mariadb"
EMBEDDED_DB_DIR="$INSTALL_DIR/mariadb"

log()  { printf '[dcim-install] %s\n' "$*"; }
err()  { printf '[dcim-install] ERROR: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [--mode install|upgrade|repair] [options]

Options:
  --mode MODE          install | upgrade | repair (skips the interactive menu)
  --port PORT          HTTP port the app listens on (default: $REQUIRED_PORT_DEFAULT)
  --db-host HOST        (default: localhost; ignored with --embedded-db - it
                        always runs on its own private socket)
  --db-port PORT        (default: 3306; ignored with --embedded-db)
  --db-user USER        (default: dcim; also used as the embedded DB's app
                        user when --embedded-db is given)
  --db-password PASS    (also used for the embedded DB's app user when
                        --embedded-db is given; a secure random one is
                        generated if left blank, either way)
  --db-name NAME         (default: dcim; also used with --embedded-db)
  --embedded-db         bundle and run a private MariaDB instance instead of
                        using an external one (Option 1 vs. the --db-* flags'
                        Option 2) - requires the package to have been built
                        with fetch-mariadb-runtime.sh
  --embedded-db-port PORT  port for the embedded instance (default: 3307,
                        deliberately not 3306, to avoid colliding with any
                        existing system MySQL/MariaDB)
  --cors-origin ORIGIN
  --admin-user USER     (install only) replace the seeded "admin" username on first install
  --admin-password PASS (install only) replace the seeded "admin" password on first install
  --csp-mode MODE       enforce | report-only (default) | off
  --audit-retention-days N  days of audit log to keep; 0 = forever (default: 365)
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
    --embedded-db) EMBEDDED_DB=1; shift ;;
    --embedded-db-port) EMBEDDED_DB_PORT="$2"; shift 2 ;;
    --cors-origin) CORS_ORIGIN="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --csp-mode) CSP_MODE="$2"; shift 2 ;;
    --audit-retention-days) AUDIT_RETENTION_DAYS="$2"; shift 2 ;;
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

# Found via real execution of the "Lost Configuration" repair scenario:
# do_repair's own entry guard used existing_install_present (which requires
# .env), so when .env is exactly the thing that's missing, repair refused to
# even start ("No existing installation found") before ever reaching its own
# .env self-heal logic in sync_payload. Repair needs a looser signal that an
# install exists at all - the webapp directory or the systemd unit file -
# since recovering a missing/corrupted .env is a scenario repair must
# support, not reject.
repair_target_present() {
  [ -d "$INSTALL_DIR/webapp" ] || [ -f "$UNIT_PATH" ]
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

# ---------- Interactive configuration wizard (install only, no --yes) ----------
# A formal, prompt-driven setup for someone running this by hand at a
# terminal - uses whiptail's boxes when available (works over SSH, no X11
# needed) and falls back to plain read prompts otherwise. CI/automation is
# never affected: this only runs when choose_mode's own interactive branch
# ran, i.e. no --mode and no --yes were passed.

have_whiptail() { command -v whiptail >/dev/null 2>&1; }

ask_text() {
  local prompt="$1" default="$2" answer
  if have_whiptail; then
    answer="$(whiptail --backtitle "$APP_NAME Setup" --inputbox "$prompt" 10 70 "$default" 3>&1 1>&2 2>&3)" || die "Setup cancelled."
  else
    read -r -p "$prompt [$default]: " answer
  fi
  echo "${answer:-$default}"
}

ask_password() {
  local prompt="$1" answer
  if have_whiptail; then
    answer="$(whiptail --backtitle "$APP_NAME Setup" --passwordbox "$prompt" 10 70 3>&1 1>&2 2>&3)" || die "Setup cancelled."
  else
    read -r -s -p "$prompt: " answer
    echo >&2
  fi
  echo "$answer"
}

ask_yesno() {
  local prompt="$1" default="$2" answer
  if have_whiptail; then
    if whiptail --backtitle "$APP_NAME Setup" --yesno "$prompt" 12 70; then echo 1; else echo 0; fi
  else
    read -r -p "$prompt [${3:-y/N}]: " answer
    case "$answer" in
      [Yy]*) echo 1 ;;
      "") echo "$default" ;;
      *) echo 0 ;;
    esac
  fi
}

interactive_configure_install() {
  log "Let's configure your installation. Press Enter to accept the bracketed default."
  PORT="$(ask_text "HTTP port $APP_NAME should listen on" "$PORT")"

  if [ "$(ask_yesno "Use a bundled, private database?\n\nRecommended - no setup required. Choose No to connect to your own MySQL/MariaDB server instead." 1 "Y/n")" = "1" ]; then
    EMBEDDED_DB=1
  else
    EMBEDDED_DB=0
    DB_HOST="$(ask_text "Database host" "$DB_HOST")"
    DB_PORT="$(ask_text "Database port" "$DB_PORT")"
    DB_USER="$(ask_text "Database username" "$DB_USER")"
    DB_PASSWORD="$(ask_password "Database password")"
    DB_NAME="$(ask_text "Database name" "$DB_NAME")"
  fi

  if [ "$(ask_yesno "Set a custom administrator account now?\n\nChoose No to sign in as admin/admin and change the password on first use." 0 "y/N")" = "1" ]; then
    ADMIN_USER="$(ask_text "Administrator username" "admin")"
    local pw1 pw2
    pw1="$(ask_password "Administrator password")"
    pw2="$(ask_password "Confirm administrator password")"
    [ -n "$pw1" ] && [ "$pw1" = "$pw2" ] || die "Passwords did not match (or were empty) - re-run and try again."
    ADMIN_PASSWORD="$pw1"
  fi
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
  case "$CSP_MODE" in enforce|report-only|off) ;; *) die "--csp-mode must be enforce, report-only, or off (got: $CSP_MODE)" ;; esac
  case "$AUDIT_RETENTION_DAYS" in ''|*[!0-9]*) die "--audit-retention-days must be a non-negative whole number (got: $AUDIT_RETENTION_DAYS)" ;; esac
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
CSP_MODE=$CSP_MODE
AUDIT_RETENTION_DAYS=$AUDIT_RETENTION_DAYS
NODE_ENV=production
EOF
  chmod 600 "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  log "Wrote $ENV_FILE with a freshly generated JWT secret."
}

sync_payload() {
  # Found via real execution of the "Missing Files" repair scenario on a
  # standalone (non-.deb/.rpm) install: on a repair run invoked through the
  # install_cli_utilities script cache (SCRIPT_DIR == $INSTALL_DIR/cli),
  # PAYLOAD_WEBAPP's "../../dcim/webapp" fallback resolves to
  # $INSTALL_DIR/webapp itself (walking ".." from .../cli lands back under
  # $INSTALL_DIR), so rsync silently synced the installed webapp onto itself
  # - a missing file stayed missing with no error at all. A .deb/.rpm install
  # never hits this (PAYLOAD_WEBAPP finds the package's own permanent copy
  # at /usr/share/dcim/webapp on the first check). Fall back to the cached
  # copy install_cli_utilities keeps for exactly this case instead of
  # resyncing a directory onto itself.
  local source_webapp="$PAYLOAD_WEBAPP"
  if [ ! -f "$source_webapp/server.js" ] || [ "$(cd "$source_webapp" 2>/dev/null && pwd)" = "$(cd "$INSTALL_DIR/webapp" 2>/dev/null && pwd)" ]; then
    if [ -f "$CACHED_WEBAPP_DIR/server.js" ]; then
      log "No distinct webapp payload found next to this invocation (expected for a cached repair run) - restoring from the last known-good copy cached at $CACHED_WEBAPP_DIR."
      source_webapp="$CACHED_WEBAPP_DIR"
    else
      die "Could not find a real webapp payload to repair from (looked in $PAYLOAD_WEBAPP, and no cached copy exists at $CACHED_WEBAPP_DIR). Re-run the original install.sh/appliance from its source, or reinstall via the .deb/.rpm package (which always keeps its own permanent copy under /usr/share/dcim/webapp)."
    fi
  fi
  log "Syncing application files to $INSTALL_DIR/webapp ..."
  install -d -m 755 "$INSTALL_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.env' --exclude 'uploads' --exclude 'backups' --exclude 'logs' \
      "$source_webapp/" "$INSTALL_DIR/webapp/"
  else
    mkdir -p "$INSTALL_DIR/webapp"
    for item in "$source_webapp"/*; do
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
  # NODE_BIN is set by validate_node() (always called via run_validations before
  # this function runs). Bundled runtime wins if present; otherwise use the
  # actual resolved system node path -- NOT a hardcoded /usr/bin/node, which
  # silently fails with systemd exit code 203/EXEC wherever Node isn't installed
  # at exactly that path (e.g. nvm/n/NodeSource-style installs under
  # /usr/local/bin -- confirmed by running this on a real GitHub Actions
  # ubuntu-latest runner, where system Node lives at /usr/local/bin/node).
  local exec_node="${NODE_BIN:-/usr/bin/node}"
  [ -x "$INSTALL_DIR/runtime/node/bin/node" ] && exec_node="$INSTALL_DIR/runtime/node/bin/node"
  local db_dep_suffix="" db_requires_line=""
  if [ -d "$EMBEDDED_DB_DIR/data" ]; then
    db_dep_suffix=" ${EMBEDDED_DB_SERVICE}.service"
    db_requires_line="Requires=${EMBEDDED_DB_SERVICE}.service"
  fi
  sed \
    -e "s#@EXEC_NODE@#$exec_node#g" \
    -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" \
    -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
    -e "s#@DB_DEPENDENCY_SUFFIX@#$db_dep_suffix#g" \
    -e "s#@DB_REQUIRES_LINE@#$db_requires_line#g" \
    "$SCRIPT_DIR/dcim.service.template" > "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  log "Installed and enabled systemd service '$SERVICE_NAME' (auto-start on boot)."
}

setup_embedded_db() {
  local engine_dir="$EMBEDDED_DB_DIR/engine"
  local data_dir="$EMBEDDED_DB_DIR/data"
  local socket_path="$EMBEDDED_DB_DIR/mariadb.sock"
  local pid_file="$EMBEDDED_DB_DIR/mariadb.pid"
  local marker="$EMBEDDED_DB_DIR/.initialized"
  local unit_path="/etc/systemd/system/${EMBEDDED_DB_SERVICE}.service"

  install -d -m 755 "$EMBEDDED_DB_DIR"
  if [ -x "$PAYLOAD_MARIADB/bin/mariadbd" ]; then
    rm -rf "$engine_dir"
    install -d -m 755 "$engine_dir"
    cp -a "$PAYLOAD_MARIADB/." "$engine_dir/"
  elif [ -x "$engine_dir/bin/mariadbd" ]; then
    # Found via real execution: a repair run via the cached /opt/dcim/cli copy
    # (see install_cli_utilities) has no bundled runtime payload next to it -
    # only the scripts are cached there, not the multi-hundred-MB MariaDB
    # engine. Reuse the already-staged engine from the original install
    # instead of requiring a payload that was never going to be there.
    log "No bundled MariaDB payload found next to this invocation (expected for a cached repair run) - reusing the already-staged engine at $engine_dir."
  else
    die "--embedded-db requires a bundled MariaDB runtime (run fetch-mariadb-runtime.sh at package-build time)."
  fi

  local first_init=0
  if [ ! -d "$data_dir" ]; then
    first_init=1
    install -d -m 750 "$data_dir"
    log "Initializing embedded MariaDB data directory..."
    local install_db_bin="$engine_dir/bin/mariadb-install-db"
    [ -x "$install_db_bin" ] || install_db_bin="$engine_dir/scripts/mariadb-install-db"
    [ -x "$install_db_bin" ] || install_db_bin="$engine_dir/scripts/mysql_install_db"
    [ -x "$install_db_bin" ] || die "Could not find mariadb-install-db in the bundled MariaDB runtime."
    # --force: skips the hostname-resolves-to-itself check, which fails in many
    # containers/offline hosts with unusual /etc/hosts or no DNS at all (found
    # via real execution: "Neither host '...' nor 'localhost' could be looked
    # up") - this installer already doesn't depend on the system hostname
    # resolving to anything for the app itself to work, so skipping that check
    # here is safe.
    "$install_db_bin" --no-defaults --basedir="$engine_dir" --datadir="$data_dir" \
      --auth-root-authentication-method=normal --force >/dev/null
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$EMBEDDED_DB_DIR"

  # Render + (re)install the dedicated systemd unit for the embedded instance -
  # idempotent and safe to re-run on install/repair; data is untouched either way.
  sed \
    -e "s#@MARIADBD_BIN@#$engine_dir/bin/mariadbd#g" \
    -e "s#@DATA_DIR@#$data_dir#g" \
    -e "s#@SOCKET_PATH@#$socket_path#g" \
    -e "s#@PID_FILE@#$pid_file#g" \
    -e "s#@DB_PORT@#$EMBEDDED_DB_PORT#g" \
    -e "s#@BASE_DIR@#$engine_dir#g" \
    -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
    "$SCRIPT_DIR/dcim-mariadb.service.template" > "$unit_path"
  systemctl daemon-reload
  systemctl enable "$EMBEDDED_DB_SERVICE" >/dev/null
  systemctl restart "$EMBEDDED_DB_SERVICE"

  log "Waiting for embedded MariaDB to become available..."
  local i
  # 90s, not 30s: a first-ever start right after mariadb-install-db has to
  # initialize the data directory, which can take well over 30s on real
  # hardware (slower disk, other load) even though the service comes up
  # fine - see the matching comment in packaging/windows/install.js.
  for i in $(seq 1 90); do
    "$engine_dir/bin/mysqladmin" --no-defaults --socket="$socket_path" -u root ping >/dev/null 2>&1 && break
    sleep 1
  done
  "$engine_dir/bin/mysqladmin" --no-defaults --socket="$socket_path" -u root ping >/dev/null 2>&1 \
    || die "Embedded MariaDB did not start within 90s. Check: journalctl -u $EMBEDDED_DB_SERVICE -n 100"

  if [ "$first_init" -eq 1 ]; then
    # Respect a password actually supplied via --db-password for the embedded
    # DB's app user - only generate one when it was left blank, instead of
    # always discarding it (previously true even with --embedded-db).
    [ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(random_secret | head -c 32)"
    local root_pw esc_db_pw esc_root_pw
    root_pw="$(random_secret | head -c 32)"
    esc_db_pw="$(printf '%s' "$DB_PASSWORD" | sed "s/'/''/g")"
    esc_root_pw="$(printf '%s' "$root_pw" | sed "s/'/''/g")"
    "$engine_dir/bin/mysql" --no-defaults --socket="$socket_path" -u root <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$esc_root_pw';
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$esc_db_pw';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
    echo "$root_pw" > "$EMBEDDED_DB_DIR/.root-password"
    chmod 600 "$EMBEDDED_DB_DIR/.root-password"
    chown "$SERVICE_USER:$SERVICE_USER" "$EMBEDDED_DB_DIR/.root-password"
    touch "$marker"
    log "Embedded MariaDB initialized: database '$DB_NAME', user '$DB_USER'. Root password saved to $EMBEDDED_DB_DIR/.root-password (needed only for advanced maintenance)."
  else
    # Repair / re-run: data + credentials already exist. Reuse the existing
    # DB_PASSWORD from .env rather than generating a new one - generating one
    # here without also updating MariaDB's own stored password for the user
    # would just lock the app out.
    if [ -f "$ENV_FILE" ]; then DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE")"; fi
    [ -n "$DB_PASSWORD" ] || die "Embedded MariaDB data already exists but no existing DB_PASSWORD was found in $ENV_FILE to reuse. Restore it from backup, or remove $EMBEDDED_DB_DIR to reinitialize (data loss)."
    log "Embedded MariaDB already initialized; reusing the existing database and credentials."
  fi

  DB_HOST="127.0.0.1"
  DB_PORT="$EMBEDDED_DB_PORT"
}

install_cli_utilities() {
  # Found via real execution (test-lifecycle.yml): when install.sh is run
  # directly (not via the .deb/.rpm, e.g. a standalone extract or the
  # offline appliance), dcim-service/dcim-upgrade/dcim-repair/dcim-setup
  # never land on PATH - those symlinks are normally created by the
  # package's own postinst. Copy the scripts to a stable location under
  # $INSTALL_DIR (so they survive even if $SCRIPT_DIR, e.g. a temp extract
  # dir, is later removed) and link them on PATH, but only if nothing is
  # already there - a .deb/.rpm install already placed real files at these
  # paths before calling into install.sh, and this must not clobber those.
  local cli_dir="$INSTALL_DIR/cli"
  install -d -m 755 "$cli_dir"
  # install.sh itself renders dcim.service.template / dcim-mariadb.service.template
  # from "$SCRIPT_DIR/..." - once dcim-upgrade/dcim-repair resolve back to this
  # cached copy (see below), SCRIPT_DIR becomes $cli_dir, so those templates must
  # be cached here too or a later repair/upgrade run fails to find them.
  for f in dcim-service.sh dcim-upgrade.sh dcim-repair.sh install.sh uninstall.sh rollback.sh \
           dcim.service.template dcim-mariadb.service.template; do
    [ -f "$SCRIPT_DIR/$f" ] || continue
    # On a standalone (non-.deb/.rpm) install, /usr/bin/dcim-upgrade resolves back to
    # THIS SAME cached copy at $cli_dir (that's the point - it survives the original
    # extract dir being removed), so re-running upgrade/repair makes $SCRIPT_DIR ==
    # $cli_dir and this would otherwise try to `install` a file onto itself. Skip
    # when source and destination are already the same file (confirmed via real
    # execution: "install: '...' and '...' are the same file").
    if [ -e "$cli_dir/$f" ] && [ "$SCRIPT_DIR/$f" -ef "$cli_dir/$f" ]; then continue; fi
    install -m 755 "$SCRIPT_DIR/$f" "$cli_dir/$f"
  done
  for name in dcim-service dcim-upgrade dcim-repair; do
    [ -e "/usr/bin/$name" ] || ln -s "$cli_dir/${name}.sh" "/usr/bin/$name"
  done
  # Cache a real copy of the webapp payload too (small - ~50MB including
  # node_modules and the OCR vendor tree), so a later repair run invoked via
  # this very cache (see sync_payload's fallback) has a genuine, known-good
  # source to restore missing/corrupted webapp files from, instead of
  # silently syncing the installed directory onto itself. Only refresh it
  # when $PAYLOAD_WEBAPP is a real, distinct source (true during install/
  # upgrade, which always run from the original checkout/appliance/package -
  # false during a repair invoked through this same cache, where it must
  # never overwrite a known-good cache with an already-damaged one).
  if [ -f "$PAYLOAD_WEBAPP/server.js" ] && [ "$(cd "$PAYLOAD_WEBAPP" 2>/dev/null && pwd)" != "$(cd "$INSTALL_DIR/webapp" 2>/dev/null && pwd)" ]; then
    install -d -m 755 "$CACHED_WEBAPP_DIR"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete --exclude '.env' --exclude 'uploads' --exclude 'backups' --exclude 'logs' \
        "$PAYLOAD_WEBAPP/" "$CACHED_WEBAPP_DIR/"
    else
      cp -a "$PAYLOAD_WEBAPP/." "$CACHED_WEBAPP_DIR/"
    fi
  fi
  [ -e /usr/bin/dcim-setup ] || ln -s "$cli_dir/install.sh" /usr/bin/dcim-setup
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
    # --set-gtid-purged=OFF: found via real execution against MySQL 8 (choco's
    # mysql package on the Windows path) - mysqldump failed outright with
    # "Couldn't execute 'FLUSH TABLES': Access denied; you need (at least one
    # of) the RELOAD or FLUSH_TABLES privilege(s)". MySQL 8 attempts to record
    # GTID state (needing that FLUSH TABLES call) even with
    # --single-transaction, unless told not to - and a least-privilege DB user
    # scoped to just this app's database (exactly what this installer asks
    # customers to grant) will never have that global privilege.
    # Feature-detected, not assumed present: also found via real execution
    # that MariaDB's mysqldump does NOT recognize this MySQL-specific flag at
    # all ("unknown option"), which broke the previously-working MariaDB path
    # outright the first time this was added unconditionally.
    local gtid_flag=()
    "$dump_bin" --help 2>/dev/null | grep -q -- '--set-gtid-purged' && gtid_flag=(--set-gtid-purged=OFF)
    if "$dump_bin" -h "${host:-localhost}" -u "${user:-dcim}" "${pw_arg[@]}" --single-transaction "${gtid_flag[@]}" --routines --triggers "${name:-dcim}" 2>"$backup_dir/mysqldump.err" | gzip > "$backup_dir/database.sql.gz"; then
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

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

apply_admin_account() {
  [ -n "$ADMIN_USER" ] || [ -n "$ADMIN_PASSWORD" ] || return 0
  local login_resp token payload
  login_resp="$(curl -fsS -m 10 -X POST "http://127.0.0.1:${PORT}/api/auth/login" \
    -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' 2>/dev/null || true)"
  token="$(printf '%s' "$login_resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [ -z "$token" ]; then
    log "Skipping --admin-user/--admin-password: the default admin/admin login no longer works (already customized on a previous run, or this is an Upgrade/Repair, not a fresh install)."
    return 0
  fi
  payload="{"
  [ -n "$ADMIN_USER" ] && payload="${payload}\"newUsername\":\"$(json_escape "$ADMIN_USER")\""
  if [ -n "$ADMIN_PASSWORD" ]; then
    [ "$payload" != "{" ] && payload="${payload},"
    payload="${payload}\"newPassword\":\"$(json_escape "$ADMIN_PASSWORD")\""
  fi
  payload="${payload}}"
  if curl -fsS -m 10 -X POST "http://127.0.0.1:${PORT}/api/setup/admin-account" \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $token" -d "$payload" >/dev/null 2>&1; then
    log "Admin account customized (username/password applied as requested)."
  else
    err "Could not apply --admin-user/--admin-password; the seeded admin/admin account is still in place. Re-run with --mode repair or sign in and change it via the Setup Wizard."
  fi
}

print_health_validation() {
  local login_user login_pass login_resp token
  login_user="${ADMIN_USER:-admin}"
  login_pass="${ADMIN_PASSWORD:-admin}"
  login_resp="$(curl -fsS -m 10 -X POST "http://127.0.0.1:${PORT}/api/auth/login" \
    -H 'Content-Type: application/json' -d "{\"username\":\"$(json_escape "$login_user")\",\"password\":\"$(json_escape "$login_pass")\"}" 2>/dev/null || true)"
  token="$(printf '%s' "$login_resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [ -z "$token" ]; then
    log "Health validation skipped (could not sign in as '$login_user' to run it - this is expected if the admin password was already changed). View it at: http://127.0.0.1:${PORT}/api/health/validate (after signing in via the dashboard)."
    return 0
  fi
  local report
  report="$(curl -fsS -m 15 "http://127.0.0.1:${PORT}/api/health/validate" -H "Authorization: Bearer $token" 2>/dev/null || true)"
  [ -n "$report" ] || { log "Health validation: could not reach /api/health/validate."; return 0; }
  echo ""
  echo "  Health Validation"
  echo "  -----------------"
  "$NODE_BIN" -e '
    let d=""; process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const r = JSON.parse(d);
        for (const c of r.checks) console.log("  " + c.status.padEnd(8) + c.name.padEnd(18) + (c.detail || ""));
        console.log("");
        console.log("  Overall: " + r.overall);
      } catch (e) { console.log("  (could not parse health report)"); }
    });
  ' <<< "$report"
  echo ""
}

# Re-reads the installed .env so the summary below is always accurate even
# when the in-memory PORT/DB_*/CSP_MODE/etc. variables don't reflect the real
# running config - e.g. an upgrade/repair run where these flags weren't
# re-passed and still hold their command-line defaults, not what's actually
# in the file that was written on the original install.
reload_env_for_summary() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v="$(sed -n 's/^PORT=//p' "$ENV_FILE")"; [ -n "$v" ] && PORT="$v"
  v="$(sed -n 's/^DB_HOST=//p' "$ENV_FILE")"; [ -n "$v" ] && DB_HOST="$v"
  v="$(sed -n 's/^DB_PORT=//p' "$ENV_FILE")"; [ -n "$v" ] && DB_PORT="$v"
  v="$(sed -n 's/^DB_USER=//p' "$ENV_FILE")"; [ -n "$v" ] && DB_USER="$v"
  v="$(sed -n 's/^DB_NAME=//p' "$ENV_FILE")"; [ -n "$v" ] && DB_NAME="$v"
  DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE")"
  v="$(sed -n 's/^CSP_MODE=//p' "$ENV_FILE")"; [ -n "$v" ] && CSP_MODE="$v"
  v="$(sed -n 's/^AUDIT_RETENTION_DAYS=//p' "$ENV_FILE")"; [ -n "$v" ] && AUDIT_RETENTION_DAYS="$v"
  # NOTE: must not be the last statement above as a bare `[ ... ] && X=1` (or
  # an if/fi with no else) - under `set -e`, a function's exit status is that
  # of its last command, and this function is always called as a bare
  # statement, so a false condition here would otherwise silently kill the
  # whole install/upgrade/repair run right after reporting success.
  if [ -d "$EMBEDDED_DB_DIR/data" ]; then EMBEDDED_DB=1; fi
  return 0
}

# Prints (and, for the GUI/whiptail-driven install, relies on being the only
# place) every value a customer needs to actually reach the app afterward -
# port, admin account, database connection, config file location - since the
# embedded-db password and JWT secret in particular are generated here and
# never shown anywhere else except $ENV_FILE itself. Called at the end of
# install/upgrade/repair so it's always the last thing on screen.
print_summary() {
  local server_ip db_desc admin_user_shown admin_pass_shown
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$server_ip" ] || server_ip="<this-server-ip>"

  if [ "$EMBEDDED_DB" -eq 1 ]; then
    db_desc="Embedded (bundled private MariaDB)"
  else
    db_desc="External MySQL/MariaDB"
  fi

  if [ -n "$ADMIN_USER" ] || [ -n "$ADMIN_PASSWORD" ]; then
    admin_user_shown="${ADMIN_USER:-admin}"
    admin_pass_shown="(the password you provided)"
  else
    admin_user_shown="admin"
    admin_pass_shown="admin   <- you MUST change this on first sign-in"
  fi

  log ""
  log "======================================================================"
  log " $APP_NAME Installation Summary - SAVE THIS INFORMATION"
  log "======================================================================"
  log " Web UI (from this machine): http://localhost:${PORT}/"
  log " Web UI (from the network):  http://${server_ip}:${PORT}/"
  log ""
  log " Administrator account:"
  log "   Username: $admin_user_shown"
  log "   Password: $admin_pass_shown"
  log ""
  log " Database ($db_desc):"
  log "   Host:Port: ${DB_HOST}:${DB_PORT}"
  log "   Database:  $DB_NAME"
  log "   DB user:   $DB_USER"
  if [ "$EMBEDDED_DB" -eq 1 ]; then
    log "   DB password: $DB_PASSWORD   (auto-generated; also saved in $ENV_FILE)"
  fi
  log ""
  log " Security: CSP mode=$CSP_MODE, audit log retention=${AUDIT_RETENTION_DAYS}d (0=forever)"
  log ""
  log " Install directory: $INSTALL_DIR"
  log " Config file:        $ENV_FILE"
  log " Service:            systemctl status $SERVICE_NAME"
  log "======================================================================"
  log ""
}

do_install() {
  run_validations
  ensure_service_user
  sync_payload
  install_cli_utilities
  [ "$EMBEDDED_DB" -eq 1 ] && setup_embedded_db
  write_env_file
  test_db_connection
  install_systemd_unit
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  apply_admin_account
  print_health_validation
  log "$APP_NAME installed."
  reload_env_for_summary
  print_summary
}

do_upgrade() {
  existing_install_present || die "No existing installation found at $INSTALL_DIR; use --mode install instead."
  run_validations
  backup_before_change
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sync_payload
  install_cli_utilities
  install_systemd_unit
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  print_health_validation
  log "$APP_NAME upgraded in place. Previous config snapshot kept under /var/backups/dcim/."
  reload_env_for_summary
  print_summary
}

do_repair() {
  repair_target_present || die "No existing installation found at $INSTALL_DIR; use --mode install instead."
  run_validations
  ensure_service_user
  backup_before_change
  # Found via real execution of the "Lost Configuration" repair scenario:
  # sync_payload only ever touches webapp files, never recreates .env, so a
  # repair run had no recovery path when .env itself was the thing missing -
  # it would restart the service with no DB password/JWT secret and fail.
  # Self-heal from the most recent backup that still has one (every prior
  # backup_before_change call captured .env whenever it existed at the time);
  # if none exists, fail loudly rather than leave the service silently unable
  # to connect to its database.
  if [ ! -f "$ENV_FILE" ]; then
    local latest_env
    latest_env="$(ls -1t /var/backups/dcim/*/.env 2>/dev/null | head -1 || true)"
    if [ -n "$latest_env" ]; then
      log "No .env found at $ENV_FILE; restoring the most recent one from backup: $latest_env"
      install -d -m 750 "$(dirname "$ENV_FILE")"
      cp -a "$latest_env" "$ENV_FILE"
      chmod 640 "$ENV_FILE"
    else
      die "No .env found at $ENV_FILE and no prior backup contains one; repair cannot recover the configuration. Restore it manually (e.g. from an external backup) or reinstall with --mode install."
    fi
  fi
  sync_payload
  install_cli_utilities
  # Auto-detect: a repair run doesn't need --embedded-db re-passed to know an
  # embedded instance is in use, since its data directory is the evidence.
  [ -d "$EMBEDDED_DB_DIR/data" ] && EMBEDDED_DB=1
  [ "$EMBEDDED_DB" -eq 1 ] && setup_embedded_db
  install_systemd_unit
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  print_health_validation
  log "$APP_NAME repaired (files, service, and permissions re-applied; your .env and data were preserved)."
  reload_env_for_summary
  print_summary
}

main() {
  require_root
  choose_mode
  if [ "$MODE" = "install" ] && [ "$ASSUME_YES" -eq 0 ] && ! existing_install_present; then
    interactive_configure_install
  fi
  case "$MODE" in
    install) do_install ;;
    upgrade) do_upgrade ;;
    repair)  do_repair ;;
    *) die "Unknown mode: $MODE" ;;
  esac
}

main "$@"
