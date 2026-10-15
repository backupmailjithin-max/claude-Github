#!/usr/bin/env bash
# Assembles the single-download DCIM Enterprise Offline Distribution Kit from
# the already-built, independently-tested native artifacts (each produced by
# its own build-*.sh/.ps1 / CI job, unchanged by this script). This script
# only arranges files into the kit layout plus the two OS-detecting
# dispatchers (install, install.ps1) - it contains no install logic itself.
#
# Expects (overridable via env vars):
#   DIST_DIR       dist/*.deb, dist/*.rpm, dist/*.run   (default: $REPO_ROOT/dist)
#   WIN_OUT_DIR    windows/DCIM-Setup*.exe               (default: packaging/windows/Output)
#   WIN_UTILS_DIR  windows/DCIM-Upgrade*.exe, DCIM-Repair*.exe (default: same as WIN_OUT_DIR)
# Any artifact that isn't present is skipped with a warning, so this can run
# on a partial build (e.g. Linux-only CI) without failing the whole kit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSION="$(sed -n 's/^Version: //p' "$REPO_ROOT/packaging/linux/debian/control")"

DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
WIN_OUT_DIR="${WIN_OUT_DIR:-$REPO_ROOT/packaging/windows/Output}"
WIN_UTILS_DIR="${WIN_UTILS_DIR:-$WIN_OUT_DIR}"
OUT_DIR="${OUT_DIR:-$DIST_DIR}"

KIT_NAME="DCIM-Enterprise-Offline-Kit-v${VERSION}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
KIT="$STAGE/$KIT_NAME"

mkdir -p "$KIT"/windows "$KIT"/linux/deb "$KIT"/linux/rpm "$KIT"/linux/appliance \
         "$KIT"/common/docs "$KIT"/common/branding "$KIT"/common/templates "$KIT"/common/release-notes

warn() { echo "[build-kit] WARNING: $*" >&2; }

cp "$SCRIPT_DIR/install" "$KIT/install"
cp "$SCRIPT_DIR/install.ps1" "$KIT/install.ps1"
chmod 755 "$KIT/install"

shopt -s nullglob
deb_files=("$DIST_DIR"/*.deb); [ "${#deb_files[@]}" -gt 0 ] && cp "${deb_files[@]}" "$KIT/linux/deb/" || warn "no .deb found in $DIST_DIR"
rpm_files=("$DIST_DIR"/*.rpm); [ "${#rpm_files[@]}" -gt 0 ] && cp "${rpm_files[@]}" "$KIT/linux/rpm/" || warn "no .rpm found in $DIST_DIR"
run_files=("$DIST_DIR"/*.run); [ "${#run_files[@]}" -gt 0 ] && cp "${run_files[@]}" "$KIT/linux/appliance/" || warn "no .run found in $DIST_DIR"
shopt -u nullglob

cp "$REPO_ROOT/packaging/linux/dcim-upgrade.sh" "$KIT/linux/dcim-upgrade"
cp "$REPO_ROOT/packaging/linux/dcim-repair.sh" "$KIT/linux/dcim-repair"
chmod 755 "$KIT/linux/dcim-upgrade" "$KIT/linux/dcim-repair"

shopt -s nullglob
setup_exes=("$WIN_OUT_DIR"/DCIM-Setup*.exe "$WIN_OUT_DIR"/dcim-setup*.exe)
if [ "${#setup_exes[@]}" -gt 0 ]; then cp "${setup_exes[0]}" "$KIT/windows/"; else warn "no DCIM-Setup*.exe found in $WIN_OUT_DIR"; fi
upgrade_exes=("$WIN_UTILS_DIR"/DCIM-Upgrade*.exe)
if [ "${#upgrade_exes[@]}" -gt 0 ]; then cp "${upgrade_exes[0]}" "$KIT/windows/DCIM-Upgrade.exe"; else warn "no DCIM-Upgrade*.exe found in $WIN_UTILS_DIR (build it with packaging/windows/dcim-upgrade-utility.iss first)"; fi
repair_exes=("$WIN_UTILS_DIR"/DCIM-Repair*.exe)
if [ "${#repair_exes[@]}" -gt 0 ]; then cp "${repair_exes[0]}" "$KIT/windows/DCIM-Repair.exe"; else warn "no DCIM-Repair*.exe found in $WIN_UTILS_DIR (build it with packaging/windows/dcim-repair-utility.iss first)"; fi
shopt -u nullglob

[ -f "$REPO_ROOT/docs/PACKAGING.md" ] && cp "$REPO_ROOT/docs/PACKAGING.md" "$KIT/common/docs/"
[ -f "$REPO_ROOT/docs/RELEASE_NOTES.md" ] && cp "$REPO_ROOT/docs/RELEASE_NOTES.md" "$KIT/common/release-notes/"

cat > "$KIT/common/branding/README.md" <<'EOF'
Reserved for customer-supplied branding assets (logo, favicon). These are
applied at runtime through the Setup Wizard's Organization/Branding tab, not
by dropping files here - this directory exists only so a customer's own
brand kit can travel alongside the install media if they prefer to hand it
to their deployment team as part of this archive.
EOF

cat > "$KIT/common/templates/README.md" <<'EOF'
Reserved for customer-supplied document templates (e.g. report letterhead).
Templates are applied through the application itself, not by dropping files
here - this directory exists for distribution convenience only.
EOF

echo "$VERSION" > "$KIT/VERSION"

# Write checksums to a temp file OUTSIDE $KIT first, then move it in - writing
# directly to $KIT/CHECKSUMS.sha256 via redirection creates the (empty) file
# before `find` runs, so it would hash itself as an empty file and ship a
# bogus self-referential entry.
CHECKSUMS_TMP="$STAGE/CHECKSUMS.sha256.tmp"
( cd "$STAGE" && find "$KIT_NAME" -type f | sort | xargs sha256sum ) > "$CHECKSUMS_TMP"
mv "$CHECKSUMS_TMP" "$KIT/CHECKSUMS.sha256"

mkdir -p "$OUT_DIR"
( cd "$STAGE" && tar -czf "$OUT_DIR/${KIT_NAME}.tar.gz" "$KIT_NAME" )
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -rq "$OUT_DIR/${KIT_NAME}.zip" "$KIT_NAME" )
fi

echo "[build-kit] Built distribution kit:"
echo "  $OUT_DIR/${KIT_NAME}.tar.gz"
[ -f "$OUT_DIR/${KIT_NAME}.zip" ] && echo "  $OUT_DIR/${KIT_NAME}.zip"
