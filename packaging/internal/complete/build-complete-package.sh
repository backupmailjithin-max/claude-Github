#!/usr/bin/env bash
# Builds the COMPLETE internal package (whole application + fresh install + cutover from an older version) from the committed source.
#   build-complete-package.sh [--out dir]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; OUT="$REPO/dist"
[ "${1:-}" = "--out" ] && OUT="$2"
cd "$REPO"; [ -z "$(git status --porcelain -- dcim packaging)" ] || { echo "ERROR: uncommitted changes in dcim/ or packaging/" >&2; exit 1; }
V="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' dcim/webapp/package.json | head -1)"; S="$(git rev-parse --short HEAD)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; mkdir -p "$W/pkg"
git archive HEAD dcim/webapp dcim/internal-no-license | tar -x -C "$W"
cp "$W/dcim/internal-no-license/lib/license-public-key.js" "$W/dcim/webapp/lib/license-public-key.js"
grep -q "LICENSE_PUBLIC_KEY_PEM: *null" "$W/dcim/webapp/lib/license-public-key.js" || { echo "ERROR: overlay is not the null-key file" >&2; exit 1; }
cd "$W/dcim/webapp"; rm -rf tools tests docs backups uploads logs .env .env.example integrity.manifest.json lib/vendor/bytenode
mkdir -p uploads backups logs; : > backups/.gitkeep; : > logs/.gitkeep; : > uploads/.gitkeep
test -d node_modules/net-snmp && test -d ocr/vendor/node_modules && test -f lib/visitor-routes.js || { echo "ERROR: required runtime parts missing in the tree" >&2; exit 1; }
if find . \( -name 'license-keygen*' -o -name 'license-issue*' -o -name 'license-generator*' -o -name 'seed-*' -o -name '*.pem' \) -not -path './node_modules/*' | grep -q .; then echo "ERROR: vendor file in tree" >&2; exit 1; fi
cp -a "$W/dcim/webapp" "$W/pkg/webapp"; cd "$REPO"
cp packaging/internal/migration/cutover.sh packaging/internal/migration/rollback.sh packaging/internal/complete/install-new.sh packaging/internal/complete/README.txt "$W/pkg/"; chmod +x "$W/pkg/"*.sh
mkdir -p "$W/pkg/branding"; cp packaging/internal/branding/logo.png packaging/internal/branding/seed-branding.sh "$W/pkg/branding/"; chmod +x "$W/pkg/branding/seed-branding.sh"
[ -f packaging/internal/migration/MIGRATION-RUNBOOK.md ] && cp packaging/internal/migration/MIGRATION-RUNBOOK.md "$W/pkg/"
echo "version $V commit $S" > "$W/pkg/VERSION.txt"; (cd "$W/pkg" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)
mkdir -p "$OUT"; Z="$OUT/Internal-Complete-Package-$V-$S.zip"; rm -f "$Z"; (cd "$W/pkg" && zip -qr "$Z" .); echo "built $Z ($(du -h "$Z" | cut -f1))"
