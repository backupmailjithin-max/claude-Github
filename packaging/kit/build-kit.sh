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
[ -f "$REPO_ROOT/docs/KNOWN_LIMITATIONS.md" ] && cp "$REPO_ROOT/docs/KNOWN_LIMITATIONS.md" "$KIT/common/docs/"
[ -f "$REPO_ROOT/docs/UPGRADE_MATRIX.md" ] && cp "$REPO_ROOT/docs/UPGRADE_MATRIX.md" "$KIT/common/docs/"
if [ -d "$REPO_ROOT/docs/guides" ]; then
  mkdir -p "$KIT/common/docs/guides"
  cp "$REPO_ROOT/docs/guides/"*.md "$KIT/common/docs/guides/" 2>/dev/null || warn "no guide files found in $REPO_ROOT/docs/guides"
fi

cat > "$KIT/README.md" <<EOF
# DCIM Enterprise Offline Distribution Kit v${VERSION}

Start here. Everything needed to install, run, and manage DCIM is in this
kit - no internet access is required or used at any point.

## 1. Install

| Platform | Run |
|---|---|
| Linux    | \`sudo ./install\` (auto-picks .deb/.rpm/appliance for your distro) |
| Windows  | \`.\install.ps1\` (launches the bundled \`windows\DCIM-Setup.exe\`) |

Installing by hand instead? See \`common/docs/guides/installation-guide.md\`
for every native package, flag, and the guided GUI/terminal wizard both
platforms offer.

## 2. Running the website day to day

Once installed, DCIM runs as a background service (systemd on Linux, a
Windows Service on Windows) that starts automatically on boot - there is
nothing to manually "start" after install.

| Task | Linux | Windows |
|---|---|---|
| Open the site | \`http://<server>:<port>/\` in a browser | same |
| Check it's running | \`systemctl status dcim\` | \`Get-Service DCIM\` |
| Health check | \`curl http://127.0.0.1:<port>/api/health\` | \`Invoke-RestMethod http://127.0.0.1:<port>/api/health\` |
| Restart it | \`sudo systemctl restart dcim\` | \`Restart-Service DCIM\` |
| View logs | \`journalctl -u dcim -n 100\` | \`<installdir>\webapp\logs\` + Event Viewer |
| Upgrade | \`sudo dcim-upgrade\` | run \`windows\DCIM-Upgrade.exe\` |
| Repair | \`sudo dcim-repair\` | run \`windows\DCIM-Repair.exe\` |

## 3. Your port, admin account, and database - where to find them

**Install, Upgrade, and Repair all end by printing a Configuration
Summary** with the exact URL, administrator account, database connection
(including the auto-generated password if you picked the embedded
database - shown nowhere else), and config file location. Save it when it
appears.

- Linux / Windows console: printed directly to the terminal.
- Windows GUI installer (\`DCIM-Setup.exe\`): also saved to
  \`INSTALL-SUMMARY.txt\` in the install directory, since the installer's
  own window closes as soon as it finishes - tick "View installation
  summary" on the Finish page, or open that file any time afterward.

Full details: \`common/docs/guides/installation-guide.md\` section 5.

## 4. Everything else

| Document | Covers |
|---|---|
| \`common/docs/guides/installation-guide.md\` | Full install reference, both platforms |
| \`common/docs/guides/administrator-guide.md\` | Setup Wizard, users, monitoring integrations, troubleshooting |
| \`common/docs/guides/upgrade-guide.md\`, \`repair-guide.md\`, \`rollback-guide.md\` | Day-2 operations |
| \`common/docs/guides/backup-guide.md\`, \`disaster-recovery-guide.md\` | Backups and DR |
| \`common/docs/RELEASE_NOTES.md\`, \`KNOWN_LIMITATIONS.md\`, \`UPGRADE_MATRIX.md\` | What's in this release |
| \`common/docs/VERSION_REPORT.md\`, \`DEPENDENCY_REPORT.md\` | Exact versions bundled in this build |
| \`MANIFEST.txt\`, \`CHECKSUMS.sha256\` | Verify this kit hasn't been tampered with |
EOF

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

# ---- Generated release artifacts (derived from the actual build, so they
# can never drift from what's really in this kit - never hand-maintained). ----

COMMIT_ID="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "unknown (not a git checkout)")"
BUILD_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

{
  echo "# DCIM Version Report"
  echo
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| Version | $VERSION |"
  echo "| Commit | $COMMIT_ID |"
  echo "| Build date (UTC) | $BUILD_DATE |"
  echo
  echo "## Package sizes"
  echo
  echo "| Artifact | Size |"
  echo "|---|---|"
  for f in "$KIT"/linux/deb/*.deb "$KIT"/linux/rpm/*.rpm "$KIT"/linux/appliance/*.run \
           "$KIT"/windows/*.exe; do
    [ -f "$f" ] || continue
    printf "| %s | %s |\n" "$(basename "$f")" "$(du -h "$f" | cut -f1)"
  done
} > "$KIT/common/docs/VERSION_REPORT.md"

{
  echo "# DCIM Dependency Report"
  echo
  echo "Bundled runtimes (offline - fetched once at build time, never at"
  echo "install/upgrade/repair time):"
  echo
  echo "| Component | Version |"
  echo "|---|---|"
  node_ver="$(sed -n 's/^NODE_VERSION="\${NODE_VERSION:-\(.*\)}"/\1/p' "$REPO_ROOT/packaging/linux/fetch-node-runtime.sh" 2>/dev/null || true)"
  mariadb_ver="$(sed -n 's/^MARIADB_VERSION="\${MARIADB_VERSION:-\(.*\)}"/\1/p' "$REPO_ROOT/packaging/linux/fetch-mariadb-runtime.sh" 2>/dev/null || true)"
  echo "| Node.js (bundled) | ${node_ver:-see fetch-node-runtime.sh} |"
  echo "| MariaDB (bundled, --embedded-db) | ${mariadb_ver:-see fetch-mariadb-runtime.sh} |"
  echo "| OCR engine | Tesseract.js (bundled under webapp/ocr/vendor) |"
  echo
  echo "Direct application dependencies (from webapp/package.json):"
  echo
  echo "| Package | Version |"
  echo "|---|---|"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const pkg = require(process.argv[1]);
      for (const [name, ver] of Object.entries(pkg.dependencies || {})) {
        console.log(`| ${name} | ${ver} |`);
      }
    ' "$REPO_ROOT/dcim/webapp/package.json"
  else
    python3 -c "
import json
with open('$REPO_ROOT/dcim/webapp/package.json') as f:
    pkg = json.load(f)
for name, ver in pkg.get('dependencies', {}).items():
    print(f'| {name} | {ver} |')
"
  fi
} > "$KIT/common/docs/DEPENDENCY_REPORT.md"

# MANIFEST.txt: every file in the kit with its size, generated before
# CHECKSUMS.sha256 (below) so it's covered by the checksum too - unlike
# CHECKSUMS.sha256 itself, a manifest listing itself is not self-referentially
# broken (its own size just won't count its own final byte count, which is
# an accepted cosmetic quirk, not a correctness issue).
( cd "$KIT" && find . -type f | sort | while IFS= read -r f; do
    printf '%-70s %10s bytes\n' "$f" "$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")"
  done ) > "$KIT/MANIFEST.txt"

# Write checksums to a temp file OUTSIDE $KIT first, then move it in - writing
# directly to $KIT/CHECKSUMS.sha256 via redirection creates the (empty) file
# before `find` runs, so it would hash itself as an empty file and ship a
# bogus self-referential entry.
#
# Found via real execution (package-validation.yml's checksum-verification
# step): paths must be relative to $KIT itself (./VERSION, ./install, ...),
# not prefixed with $KIT_NAME - a customer (or the CI check above) naturally
# extracts the tarball, cd's into the resulting DCIM-Enterprise-Offline-Kit-*
# directory, and runs `sha256sum -c CHECKSUMS.sha256` from there. Prefixing
# every path with the kit's own directory name made every single entry
# resolve to a nonexistent double-nested path from that directory.
CHECKSUMS_TMP="$STAGE/CHECKSUMS.sha256.tmp"
( cd "$KIT" && find . -type f | sort | xargs sha256sum ) > "$CHECKSUMS_TMP"
mv "$CHECKSUMS_TMP" "$KIT/CHECKSUMS.sha256"

mkdir -p "$OUT_DIR"
( cd "$STAGE" && tar -czf "$OUT_DIR/${KIT_NAME}.tar.gz" "$KIT_NAME" )
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -rq "$OUT_DIR/${KIT_NAME}.zip" "$KIT_NAME" )
fi

echo "[build-kit] Built distribution kit:"
echo "  $OUT_DIR/${KIT_NAME}.tar.gz"
[ -f "$OUT_DIR/${KIT_NAME}.zip" ] && echo "  $OUT_DIR/${KIT_NAME}.zip"
