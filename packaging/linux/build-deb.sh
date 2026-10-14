#!/usr/bin/env bash
# Builds dcim_<version>_amd64.deb from the repo's dcim/webapp payload + this
# directory's installer scripts. Run ./fetch-node-runtime.sh first if you want
# the bundled-runtime package; otherwise the .deb will rely on a system Node.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSION="$(sed -n 's/^Version: //p' "$SCRIPT_DIR/debian/control")"
ARCH="amd64"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
PKG_NAME="dcim_${VERSION}_${ARCH}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/DEBIAN" "$STAGE/usr/share/dcim" "$STAGE/usr/bin"

cp "$SCRIPT_DIR/debian/control" "$STAGE/DEBIAN/control"
cp "$SCRIPT_DIR/debian/postinst" "$STAGE/DEBIAN/postinst"
cp "$SCRIPT_DIR/debian/prerm" "$STAGE/DEBIAN/prerm"
cp "$SCRIPT_DIR/debian/postrm" "$STAGE/DEBIAN/postrm"
chmod 755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"

cp "$SCRIPT_DIR/install.sh" "$STAGE/usr/share/dcim/install.sh"
cp "$SCRIPT_DIR/uninstall.sh" "$STAGE/usr/share/dcim/uninstall.sh"
cp "$SCRIPT_DIR/rollback.sh" "$STAGE/usr/share/dcim/rollback.sh"
cp "$SCRIPT_DIR/dcim.service.template" "$STAGE/usr/share/dcim/dcim.service.template"
cp "$SCRIPT_DIR/nginx-dcim.conf" "$STAGE/usr/share/dcim/nginx-dcim.conf"
chmod 755 "$STAGE/usr/share/dcim/install.sh" "$STAGE/usr/share/dcim/uninstall.sh" "$STAGE/usr/share/dcim/rollback.sh"

cp "$SCRIPT_DIR/dcim-service.sh" "$STAGE/usr/bin/dcim-service"
chmod 755 "$STAGE/usr/bin/dcim-service"

cp -a "$REPO_ROOT/dcim/webapp" "$STAGE/usr/share/dcim/webapp"
rm -rf "$STAGE/usr/share/dcim/webapp/.env" \
       "$STAGE/usr/share/dcim/webapp/uploads" \
       "$STAGE/usr/share/dcim/webapp/backups" \
       "$STAGE/usr/share/dcim/webapp/logs"
mkdir -p "$STAGE/usr/share/dcim/webapp/uploads" \
         "$STAGE/usr/share/dcim/webapp/backups" \
         "$STAGE/usr/share/dcim/webapp/logs"

if [ -x "$SCRIPT_DIR/runtime/node/bin/node" ]; then
  mkdir -p "$STAGE/usr/share/dcim/runtime"
  cp -a "$SCRIPT_DIR/runtime/node" "$STAGE/usr/share/dcim/runtime/node"
  echo "Bundling Node runtime: $("$SCRIPT_DIR/runtime/node/bin/node" --version)"
else
  echo "No staged runtime found (run fetch-node-runtime.sh first for a bundled package); .deb will require system Node.js >= 18."
fi

ln -s /usr/share/dcim/install.sh "$STAGE/usr/bin/dcim-setup"

installed_kb="$(du -sk "$STAGE" | cut -f1)"
sed -i "/^Description:/i Installed-Size: ${installed_kb}" "$STAGE/DEBIAN/control"

mkdir -p "$OUT_DIR"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT_DIR/${PKG_NAME}.deb"
echo "Built $OUT_DIR/${PKG_NAME}.deb"
