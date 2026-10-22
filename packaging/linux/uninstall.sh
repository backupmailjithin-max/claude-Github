#!/usr/bin/env bash
# Removes the DCIM systemd service and, optionally, its data.
set -euo pipefail

SERVICE_NAME="dcim"
INSTALL_DIR="/opt/dcim"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PURGE_DATA=0

log() { printf '[dcim-uninstall] %s\n' "$*"; }
die() { printf '[dcim-uninstall] ERROR: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE_DATA=1 ;;
    -h|--help) echo "Usage: $0 [--purge-data]"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  log "Service '$SERVICE_NAME' stopped, disabled, and unit file removed."
else
  log "No '$SERVICE_NAME' systemd unit found; nothing to disable."
fi

# Embedded (bundled) MariaDB service, when the install used --embedded-db.
# Stopped after the app so no connections are cut mid-request, and always
# before /opt/dcim (its binaries and data) is removed.
DB_SERVICE_NAME="dcim-mariadb"
DB_UNIT_PATH="/etc/systemd/system/${DB_SERVICE_NAME}.service"
EMBEDDED_DB_PRESENT=0
if [ -f "$DB_UNIT_PATH" ] || [ -d "$INSTALL_DIR/mariadb/data" ]; then EMBEDDED_DB_PRESENT=1; fi
if [ -f "$DB_UNIT_PATH" ]; then
  systemctl stop "$DB_SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$DB_SERVICE_NAME" 2>/dev/null || true
  rm -f "$DB_UNIT_PATH"
  systemctl daemon-reload
  log "Embedded database service '$DB_SERVICE_NAME' stopped, disabled, and unit file removed."
fi

if [ "$PURGE_DATA" -eq 1 ]; then
  log "Removing $INSTALL_DIR (application files, uploads, backups, logs, .env) ..."
  rm -rf "$INSTALL_DIR"
  if [ "$EMBEDDED_DB_PRESENT" -eq 1 ]; then
    log "The bundled (embedded) database and all of its data were stored under $INSTALL_DIR and have been removed with it."
    log "If you also used an external MySQL/MariaDB server for another install, it was NOT touched."
  else
    log "Note: the external MySQL/MariaDB database itself was NOT touched. Drop it manually if desired:"
    log "  mysql -u root -p -e \"DROP DATABASE dcim; DROP USER 'dcim'@'localhost';\""
  fi
else
  if [ "$EMBEDDED_DB_PRESENT" -eq 1 ]; then
    log "Application files and the bundled database data are left in place at $INSTALL_DIR (the database service was stopped; use --purge-data to remove everything)."
  else
    log "Application files left in place at $INSTALL_DIR (use --purge-data to remove them too)."
  fi
fi

log "Uninstall complete."
