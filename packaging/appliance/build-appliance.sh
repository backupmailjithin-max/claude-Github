#!/usr/bin/env bash
# Phase 7 - Offline Enterprise Appliance: builds ONE self-extracting file
# (dist/dcim-appliance-<version>-linux-x64.run) that contains the Node
# runtime, the webapp, and every installer script. No internet access is
# needed on the target machine, and no separate "unzip then run install.sh"
# step - the recipient runs ONE file.
#
# Run packaging/linux/fetch-node-runtime.sh first so the runtime is staged;
# this script refuses to build without it (an appliance that still needs the
# target to have Node.js installed isn't offline).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LINUX_DIR="$REPO_ROOT/packaging/linux"
VERSION="$(sed -n 's/^Version: //p' "$LINUX_DIR/debian/control")"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -x "$LINUX_DIR/runtime/node/bin/node" ] || {
  echo "No bundled runtime at $LINUX_DIR/runtime/node - run packaging/linux/fetch-node-runtime.sh first." >&2
  exit 1
}

PAYLOAD="$STAGE/dcim-appliance"
mkdir -p "$PAYLOAD"
cp "$LINUX_DIR/install.sh" "$LINUX_DIR/uninstall.sh" "$LINUX_DIR/rollback.sh" "$LINUX_DIR/dcim-service.sh" \
   "$LINUX_DIR/dcim.service.template" "$LINUX_DIR/nginx-dcim.conf" "$PAYLOAD/"
chmod 755 "$PAYLOAD"/*.sh

cp -a "$LINUX_DIR/runtime" "$PAYLOAD/runtime"

cp -a "$REPO_ROOT/dcim/webapp" "$PAYLOAD/webapp"
rm -rf "$PAYLOAD/webapp/.env" "$PAYLOAD/webapp/uploads" "$PAYLOAD/webapp/backups" "$PAYLOAD/webapp/logs"
mkdir -p "$PAYLOAD/webapp/uploads" "$PAYLOAD/webapp/backups" "$PAYLOAD/webapp/logs"

TARBALL="$STAGE/payload.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" "$(basename "$PAYLOAD")"

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/dcim-appliance-${VERSION}-linux-x64.run"

cat > "$OUT_FILE" <<'STUB'
#!/usr/bin/env bash
# DCIM Offline Enterprise Appliance - self-extracting installer.
# Usage: sudo ./dcim-appliance-*.run [install.sh options, e.g. --mode install --yes]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
ARCHIVE_LINE=$(awk '/^__ARCHIVE_BELOW__$/{print NR + 1; exit 0}' "$0")
tail -n +"$ARCHIVE_LINE" "$0" | tar xz -C "$WORKDIR"
cd "$WORKDIR"/dcim-appliance
exec ./install.sh "$@"
__ARCHIVE_BELOW__
STUB
cat "$TARBALL" >> "$OUT_FILE"
chmod 755 "$OUT_FILE"

echo "Built offline appliance: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
echo "Install on an air-gapped host with: sudo ./$(basename "$OUT_FILE")"
