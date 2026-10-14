#!/bin/bash
# DCIM WebApp - safe clean-up of obsolete files.
#   Dry run (shows what would move, changes nothing):   bash tools/cleanup-obsolete.sh [APP_DIR]
#   Do it (MOVES files, never deletes):                  bash tools/cleanup-obsolete.sh [APP_DIR] --apply
# APP_DIR defaults to the folder that contains this "tools" folder. Moved files go to  <APP_DIR>/../_obsolete-<date>/  with their
# original sub-folders, so any file can be put back with a plain "mv". The backups/, uploads/, logs/, .env and node_modules (except
# the unused nodemailer package) are never touched. A file is only moved if no runtime file (server.js, index.html, app-compiled*.js) mentions its name.
set -u
APPLY=0; DIR=""
for a in "$@"; do if [ "$a" = "--apply" ]; then APPLY=1; else DIR="$a"; fi; done
[ -z "$DIR" ] && DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$DIR/server.js" ] || { echo "server.js not found in $DIR - give the application folder as the first argument."; exit 1; }
DEST="$DIR/../_obsolete-$(date +%Y%m%d)"
CANDIDATES="server-N-1.js server-N.js server-old.js app-compiled-N-1.js app-compiled-N.js app-compiled00.js app-compiled0js index0.html index00.html schema-old.sql validate.js
libs/babel.min.js libs/_app-transpiled.js libs/download-libs.bat libs/download-libs.ps1
libs/fonts/Inter-Bold.otf libs/fonts/Inter-Medium.otf libs/fonts/Inter-Regular.otf libs/fonts/Inter-SemiBold.otf libs/fonts/JetBrainsMono-500.woff2
libs/fonts/PlusJakartaSans-400.woff2 libs/fonts/PlusJakartaSans-500.woff2 libs/fonts/PlusJakartaSans-600.woff2 libs/fonts/PlusJakartaSans-700.woff2 libs/fonts/PlusJakartaSans-800.woff2
node_modules/nodemailer"
# editor / build leftovers in the application folder itself (not in backups/uploads/logs/node_modules)
EXTRA="$(cd "$DIR" && find . -maxdepth 2 \( -path ./backups -o -path ./uploads -o -path ./logs -o -path ./node_modules \) -prune -o -type f \( -name '*.bak' -o -name '*.orig' -o -name '*.tmp' -o -name '*~' \) -print 2>/dev/null | sed 's#^\./##')"
MOVED=0; KEPT=0
for f in $CANDIDATES $EXTRA; do
  [ -e "$DIR/$f" ] || continue
  base="$(basename "$f")"
  if [ "$f" != "node_modules/nodemailer" ] && grep -q -F -- "$base" "$DIR/server.js" "$DIR/index.html" "$DIR/app-compiled.js" 2>/dev/null; then echo "KEEP   $f  (still mentioned by a runtime file)"; KEPT=$((KEPT+1)); continue; fi
  if [ "$f" = "node_modules/nodemailer" ] && grep -q "require(['\"]nodemailer" "$DIR/server.js" 2>/dev/null; then echo "KEEP   $f  (server.js uses it)"; KEPT=$((KEPT+1)); continue; fi
  if [ $APPLY -eq 1 ]; then mkdir -p "$DEST/$(dirname "$f")" && mv "$DIR/$f" "$DEST/$f" && echo "MOVED  $f"; else echo "WOULD MOVE  $f"; fi
  MOVED=$((MOVED+1))
done
echo "-----"
if [ $APPLY -eq 1 ]; then echo "$MOVED item(s) moved to $DEST   ($KEPT kept)"; else echo "$MOVED item(s) would be moved, $KEPT kept. Nothing was changed. Add --apply to do it."; fi
