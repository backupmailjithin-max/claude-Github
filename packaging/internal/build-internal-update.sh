#!/usr/bin/env bash
# Builds the INTERNAL (licence-free) update package: only the files that differ between the build that is
# already running (a git ref) and the current source. No runtimes, no installer, no unchanged files.
#   build-internal-update.sh --baseline <git-ref> [--out <dir>] [--allow-dependency-change]
# The internal edition = dcim/webapp + the one-file overlay in dcim/internal-no-license (null licence key).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
BASE=""; OUT="$REPO/dist"; ALLOWDEP=0
while [ $# -gt 0 ]; do case "$1" in
  --baseline) BASE="$2"; shift 2;; --out) OUT="$2"; shift 2;; --allow-dependency-change) ALLOWDEP=1; shift;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[ -n "$BASE" ] || { echo "usage: $0 --baseline <git-ref of the build in production>" >&2; exit 2; }
cd "$REPO"; git rev-parse --verify -q "$BASE^{commit}" >/dev/null || { echo "ERROR: baseline ref '$BASE' not found (fetch full history)" >&2; exit 2; }
[ -n "$(git status --porcelain -- dcim packaging 2>/dev/null)" ] && { echo "ERROR: working tree has uncommitted changes in dcim/ or packaging/" >&2; exit 1; }
HEAD_SHA="$(git rev-parse --short HEAD)"; BASE_SHA="$(git rev-parse --short "$BASE^{commit}")"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' dcim/webapp/package.json | head -1)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/old" "$W/new" "$W/pkg/lib" "$W/pkg/docs"

# Old internal build = baseline webapp + baseline overlay (the overlay may hold full files in the old layout).
git archive "$BASE" dcim/webapp | tar -x -C "$W/old"
if git cat-file -e "$BASE:dcim/internal-no-license" 2>/dev/null; then
  git archive "$BASE" dcim/internal-no-license | tar -x -C "$W/old"
  cp -r "$W/old/dcim/internal-no-license/." "$W/old/dcim/webapp/"
fi
OLD="$W/old/dcim/webapp"
# New internal build = current webapp + current overlay.
git archive HEAD dcim/webapp dcim/internal-no-license | tar -x -C "$W/new"
NEW="$W/new/dcim/webapp"
cp "$W/new/dcim/internal-no-license/lib/license-public-key.js" "$NEW/lib/license-public-key.js"
grep -q "LICENSE_PUBLIC_KEY_PEM: *null" "$NEW/lib/license-public-key.js" || { echo "ERROR: internal overlay is not the null-key file" >&2; exit 1; }

# Candidate runtime files: exclude dev/vendor/data/doc content.
mapfile -t CAND < <(cd "$NEW" && find . -type f \
  ! -path './node_modules/*' ! -path './tests/*' ! -path './tools/*' ! -path './docs/*' ! -path './lib/vendor/*' \
  ! -path './uploads/*' ! -path './backups/*' ! -path './logs/*' ! -path './runtime/*' ! -path './ocr/vendor/*' \
  ! -name '*.md' ! -name '*.sh' ! -name '*.bat' ! -name 'package.json' ! -name 'package-lock.json' ! -name 'schema.sql' \
  ! -name '.env*' ! -name '.gitkeep' ! -name 'integrity.manifest.json' | sed 's|^\./||' | sort)
: > "$W/FILES.txt"; : > "$W/CHANGES.txt"
for f in "${CAND[@]}"; do
  if [ ! -f "$OLD/$f" ]; then echo "$f" >> "$W/FILES.txt"; echo "NEW|$f" >> "$W/CHANGES.txt"
  elif ! cmp -s "$OLD/$f" "$NEW/$f"; then echo "$f" >> "$W/FILES.txt"; echo "CHANGED|$f" >> "$W/CHANGES.txt"; fi
done
[ -s "$W/FILES.txt" ] || { echo "ERROR: no differences between $BASE and HEAD - nothing to package" >&2; exit 1; }

# Dependencies must be identical: this package does not run npm.
DEPOLD="$(node -e "const p=require('$OLD/package.json');console.log(JSON.stringify(p.dependencies||{}))")"
DEPNEW="$(node -e "const p=require('$NEW/package.json');console.log(JSON.stringify(p.dependencies||{}))")"
if [ "$DEPOLD" != "$DEPNEW" ] && [ "$ALLOWDEP" -ne 1 ]; then
  echo "ERROR: npm dependencies changed since $BASE. A file-replacement update cannot install them. Use a full install, or re-run with --allow-dependency-change and run 'npm ci --omit=dev' yourself." >&2; exit 3; fi
SCHEMA_NOTE="unchanged"; cmp -s "$OLD/schema.sql" "$NEW/schema.sql" || SCHEMA_NOTE="differs (fresh installs only; existing databases are migrated by the server at start)"

# Hard guards: nothing vendor-only or secret may be in the package.
if grep -qiE '(^|/)(license-(keygen|issue|generator|fingerprint)|Run-License-Generator|seed-.*data|cleanup-obsolete|build-min)|\.pem$|\.env$' "$W/FILES.txt"; then echo "ERROR: forbidden file in update list" >&2; cat "$W/FILES.txt" >&2; exit 1; fi

while read -r f; do mkdir -p "$W/pkg/$(dirname "$f")"; cp -p "$NEW/$f" "$W/pkg/$f"; done < "$W/FILES.txt"
cp "$W/FILES.txt" "$W/pkg/FILES.txt"
# Files the target must already have (everything the old build ran from).
(cd "$OLD" && { ls lib/*.js 2>/dev/null; echo server.js; echo app-compiled.js; }) | sort -u > "$W/pkg/REQUIRES.txt"
cp "$HERE/templates/apply-update.sh" "$HERE/templates/rollback-update.sh" "$W/pkg/"; chmod +x "$W/pkg/"*.sh
COUNT="$(wc -l < "$W/FILES.txt" | tr -d ' ')"
for d in DEPLOYMENT ROLLBACK; do sed -e "s|{{FILE_COUNT}}|$COUNT|g" -e "s|{{BASELINE}}|$BASE ($BASE_SHA)|g" "$HERE/templates/docs/$d.md" > "$W/pkg/docs/$d.md"; done
{
  echo "# DCIM Internal Update: Change Log"; echo
  echo "Version $VERSION, source commit $HEAD_SHA, updates the build at $BASE ($BASE_SHA)."
  echo "Licensing stays off: the internal edition uses the null-key overlay."; echo
  echo "## Files ($COUNT)"; echo; echo "| Status | File |"; echo "|---|---|"
  while IFS='|' read -r st f; do echo "| $st | $f |"; done < "$W/CHANGES.txt"
  echo; echo "## Not changed"; echo; echo "Database (no migration step in this package), \`.env\`, uploads, backups, logs, runtimes, npm packages. schema.sql: $SCHEMA_NOTE."
  echo; echo "## Commits since the baseline"; echo
  git log --no-merges --format='- %s' "$BASE..HEAD" 2>/dev/null | head -60
} > "$W/pkg/docs/CHANGELOG.md"
printf 'DCIM Internal Update Package (internal, licence-free edition) - version %s, commit %s\n  docs/DEPLOYMENT.md, docs/ROLLBACK.md, docs/CHANGELOG.md\n  apply-update.sh / rollback-update.sh, FILES.txt, REQUIRES.txt, SHA256SUMS\nNot for customers.\n' "$VERSION" "$HEAD_SHA" > "$W/pkg/README.txt"
(cd "$W/pkg" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)
mkdir -p "$OUT"; ZIP="$OUT/Internal-Update-Package-$VERSION-$HEAD_SHA.zip"; rm -f "$ZIP"
(cd "$W/pkg" && zip -qr "$ZIP" .)
echo "[internal] baseline $BASE ($BASE_SHA) -> HEAD $HEAD_SHA: $COUNT file(s)"; cat "$W/CHANGES.txt"
echo "[internal] built $ZIP"
