#!/usr/bin/env bash
# Restores application files, .env, and the database from a snapshot taken
# automatically by install.sh before an Upgrade or Repair (see
# backup_before_change() in install.sh). Use when an upgrade goes wrong.
set -euo pipefail

SERVICE_NAME="dcim"
INSTALL_DIR="/opt/dcim"
ENV_FILE="$INSTALL_DIR/webapp/.env"

log() { printf '[dcim-rollback] %s\n' "$*"; }
die() { printf '[dcim-rollback] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

SNAPSHOT_DIR="${1:-}"
if [ -z "$SNAPSHOT_DIR" ]; then
  [ -f "$INSTALL_DIR/.last-pre-change-backup" ] || die "No snapshot specified and no recorded last snapshot. Pass a path under /var/backups/dcim/<timestamp>."
  SNAPSHOT_DIR="$(cat "$INSTALL_DIR/.last-pre-change-backup")"
  log "Using most recent recorded snapshot: $SNAPSHOT_DIR"
fi
[ -d "$SNAPSHOT_DIR" ] || die "Snapshot directory not found: $SNAPSHOT_DIR"

read -r -p "This will stop DCIM, restore files/.env from $SNAPSHOT_DIR, and restore the database if a dump is present. Continue? [y/N] " confirm
[ "$confirm" = "y" ] || [ "$confirm" = "Y" ] || die "Aborted."

systemctl stop "$SERVICE_NAME" 2>/dev/null || true

if [ -f "$SNAPSHOT_DIR/webapp-files.tar.gz" ]; then
  log "Restoring application files..."
  tar -xzf "$SNAPSHOT_DIR/webapp-files.tar.gz" -C "$INSTALL_DIR"
fi
if [ -f "$SNAPSHOT_DIR/.env" ]; then
  cp -a "$SNAPSHOT_DIR/.env" "$ENV_FILE"
  log "Restored .env"
fi

if [ -f "$SNAPSHOT_DIR/database.sql.gz" ]; then
  mysql_bin="$(command -v mysql || true)"
  if [ -z "$mysql_bin" ]; then
    log "WARNING: mysql client not found; database was NOT restored. Restore manually: gunzip -c $SNAPSHOT_DIR/database.sql.gz | mysql ..."
  else
    host="$(sed -n 's/^DB_HOST=//p' "$ENV_FILE")"; user="$(sed -n 's/^DB_USER=//p' "$ENV_FILE")"
    pass="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE")"; name="$(sed -n 's/^DB_NAME=//p' "$ENV_FILE")"
    pw_arg=(); [ -n "$pass" ] && pw_arg=(-p"$pass")
    dbport="$(sed -n 's/^DB_PORT=//p' "$ENV_FILE")"; port_arg=(); [ -n "$dbport" ] && port_arg=(-P "$dbport")
    log "Restoring database '$name' from $SNAPSHOT_DIR/database.sql.gz ..."
    gunzip -c "$SNAPSHOT_DIR/database.sql.gz" | "$mysql_bin" -h "${host:-localhost}" "${port_arg[@]}" -u "${user:-dcim}" "${pw_arg[@]}" "${name:-dcim}"
    log "Database restored."
  fi
else
  log "No database.sql.gz in this snapshot; database was left as-is."
fi

chown -R dcim:dcim "$INSTALL_DIR" 2>/dev/null || true
systemctl start "$SERVICE_NAME"
log "Rollback complete. Check: systemctl status $SERVICE_NAME && curl -s localhost:$(sed -n 's/^PORT=//p' "$ENV_FILE")/api/health"
