#!/usr/bin/env bash
# Fails if any customer guide still contains an unfilled vendor field ([[FILL IN: ...]]),
# an underscore blank (signature lines in customer-handover-kit.md are exempt), or a TODO/TBD marker. Usage: check-doc-placeholders.sh [guides-dir]
set -u
DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)/docs/guides}"
bad=0
if grep -rnE '\[\[FILL IN|_{6,}|\bTODO\b|\bTBD\b|\bFIXME\b' "$DIR" --include='*.md' --exclude=customer-handover-kit.md; then bad=1; fi
if [ "$bad" -eq 1 ]; then echo "[doc-placeholders] FAIL: unfilled placeholders in $DIR" >&2; exit 1; fi
echo "[doc-placeholders] PASS: no placeholders in $DIR"
