#!/usr/bin/env bash
# Verifies that a built package is a genuine vendor-signed commercial build.
#   verify-signed-build.sh <package.deb | extracted-dir>
# Checks: signed manifest present and valid, signed with the pinned VENDOR key, pinned key equals the key
# committed in this repository, no vendor tools/keys in the payload, installers set INTEGRITY_MODE=enforce.
# Exit 0 only when every check passes. Read-only: changes nothing.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
SRC="${1:-}"; [ -n "$SRC" ] || { echo "usage: $0 <package.deb|dir>"; exit 2; }
WORK=""; trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT
if [ -f "$SRC" ]; then
  WORK="$(mktemp -d)"; case "$SRC" in *.deb) dpkg-deb -x "$SRC" "$WORK" ;; *) echo "unsupported package type (use .deb or an extracted directory)"; exit 2 ;; esac
  SRC="$WORK"
fi
ROOT="$(find "$SRC" -name integrity.manifest.json -not -path '*/node_modules/*' -print -quit 2>/dev/null | xargs -r dirname)"
fail=0; ok(){ echo "PASS  $*"; }; bad(){ echo "FAIL  $*"; fail=1; }
[ -n "$ROOT" ] && ok "signed manifest found: ${ROOT#$SRC/}" || { bad "no integrity.manifest.json in package"; echo "RESULT: NOT A SIGNED BUILD"; exit 1; }
node "$HERE/validate-package.js" --root "$ROOT" --require-manifest --require-vendor >/tmp/vsb.$$ 2>&1 && ok "manifest verifies and is signed with the pinned vendor key; no vendor tools or keys in payload" || { bad "validate-package: $(tail -3 /tmp/vsb.$$ | tr '\n' ' ')"; }
rm -f /tmp/vsb.$$
a="$(sha256sum "$ROOT/lib/integrity-public-key.js" | cut -d' ' -f1)"; b="$(sha256sum "$REPO/dcim/webapp/lib/integrity-public-key.js" | cut -d' ' -f1)"
[ "$a" = "$b" ] && ok "pinned integrity key equals this repository's vendor key" || bad "pinned integrity key differs from this repository's vendor key (test or foreign key)"
a="$(sha256sum "$ROOT/lib/license-public-key.js" | cut -d' ' -f1)"; b="$(sha256sum "$REPO/dcim/webapp/lib/license-public-key.js" | cut -d' ' -f1)"
[ "$a" = "$b" ] && ok "licence public key equals this repository's licence key" || bad "licence public key differs from this repository"
grep -q "REPLACE_WITH\|null" "$ROOT/lib/license-public-key.js" 2>/dev/null && grep -q "LICENSE_PUBLIC_KEY_PEM: *null" "$ROOT/lib/license-public-key.js" && bad "licence key is null (internal edition): licensing OFF"
grep -qs "INTEGRITY_MODE=enforce" "$REPO/packaging/linux/install.sh" "$REPO/packaging/windows/install.js" && ok "installers write INTEGRITY_MODE=enforce" || bad "installers do not write INTEGRITY_MODE=enforce"
[ "$fail" -eq 0 ] && echo "RESULT: VERIFIED VENDOR-SIGNED BUILD" || { echo "RESULT: NOT VERIFIED"; exit 1; }
