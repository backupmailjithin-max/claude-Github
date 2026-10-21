#!/usr/bin/env bash
# Builds dcim-<version>-1.x86_64.rpm. Requires rpmbuild (rpm-build package);
# this is not installed in every environment, so CI builds this on a
# Fedora/RHEL-family runner. The RPM path currently requires a system-installed
# Node.js >= 18 (no bundled runtime support yet -- see build-deb.sh for that).
set -euo pipefail

command -v rpmbuild >/dev/null 2>&1 || { echo "rpmbuild not found; install the 'rpm-build' package." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
TOPDIR="$(mktemp -d)"
trap 'rm -rf "$TOPDIR"' EXIT

mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
PAYLOAD="$TOPDIR/SOURCES/dcim-payload"
mkdir -p "$PAYLOAD"

cp "$SCRIPT_DIR/dcim-service.sh" "$TOPDIR/SOURCES/dcim-service.sh"
cp "$SCRIPT_DIR/dcim-upgrade.sh" "$TOPDIR/SOURCES/dcim-upgrade.sh"
cp "$SCRIPT_DIR/dcim-repair.sh" "$TOPDIR/SOURCES/dcim-repair.sh"
cp "$SCRIPT_DIR/install.sh" "$PAYLOAD/install.sh"
cp "$SCRIPT_DIR/uninstall.sh" "$PAYLOAD/uninstall.sh"
cp "$SCRIPT_DIR/rollback.sh" "$PAYLOAD/rollback.sh"
cp "$SCRIPT_DIR/dcim.service.template" "$PAYLOAD/dcim.service.template"
cp "$SCRIPT_DIR/dcim-mariadb.service.template" "$PAYLOAD/dcim-mariadb.service.template"
cp "$SCRIPT_DIR/nginx-dcim.conf" "$PAYLOAD/nginx-dcim.conf"
chmod 755 "$PAYLOAD/install.sh" "$PAYLOAD/uninstall.sh" "$PAYLOAD/rollback.sh"

cp -a "$REPO_ROOT/dcim/webapp" "$PAYLOAD/webapp"
rm -rf "$PAYLOAD/webapp/license.lic" "$PAYLOAD/webapp/.trial-state" "$PAYLOAD/webapp/.env" "$PAYLOAD/webapp/uploads" "$PAYLOAD/webapp/backups" "$PAYLOAD/webapp/logs"
mkdir -p "$PAYLOAD/webapp/uploads" "$PAYLOAD/webapp/backups" "$PAYLOAD/webapp/logs"

rpmbuild --define "_topdir $TOPDIR" -bb "$SCRIPT_DIR/rpm/dcim.spec"

mkdir -p "$OUT_DIR"
find "$TOPDIR/RPMS" -name '*.rpm' -exec cp {} "$OUT_DIR/" \;
echo "Built RPM(s) in $OUT_DIR"
