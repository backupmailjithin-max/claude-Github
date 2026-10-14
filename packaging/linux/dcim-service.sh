#!/usr/bin/env bash
# Convenience wrapper so admins don't have to remember the systemd unit name.
# Installed as /usr/bin/dcim-service by the .deb/.rpm package.
set -euo pipefail
SERVICE_NAME="dcim"
usage() { echo "Usage: dcim-service {start|stop|restart|status|logs}"; exit 1; }
[ $# -ge 1 ] || usage
case "$1" in
  start)   exec systemctl start "$SERVICE_NAME" ;;
  stop)    exec systemctl stop "$SERVICE_NAME" ;;
  restart) exec systemctl restart "$SERVICE_NAME" ;;
  status)  exec systemctl status "$SERVICE_NAME" ;;
  logs)    exec journalctl -u "$SERVICE_NAME" -f ;;
  *) usage ;;
esac
