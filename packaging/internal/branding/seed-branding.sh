#!/usr/bin/env bash
# Puts the Airtel logo and the "Internal Official Use Only" footer back after a migration or a restore.
# Safe to run any time: it only fills in values that are EMPTY, so branding you set in the wizard is never overwritten.
#   sudo ./seed-branding.sh [/home/webapp]        (run it on the server, next to the branding folder)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="${1:-/home/webapp}"
[ -f "$APP/.env" ] || { echo "ERROR: $APP/.env not found" >&2; exit 1; }
envval(){ { grep -E "^$1=" "$APP/.env" || true; } | tail -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'; }
MYSQL="${MYSQL_CMD:-mysql}"; DBN="$(envval DB_NAME)"; DBN="${DBN:-datacenter_db}"; DBO="$(envval DB_PORT)"
mkdir -p "$APP/uploads/branding"
ls "$APP"/uploads/branding/logo.* >/dev/null 2>&1 || cp "$HERE/logo.png" "$APP/uploads/branding/logo.png"
chown -R --reference="$APP" "$APP/uploads/branding" 2>/dev/null || true
FOOT="Internal Official Use Only · Built in-house by DCOPS Team"
SQL="INSERT IGNORE INTO app_settings (k,v) VALUES ('org.logoPath','/branding/logo.png'),('org.footerText','$FOOT'),('org.companyName','Airtel'),('org.appName','DCIM Dashboard');
UPDATE app_settings SET v='/branding/logo.png' WHERE k='org.logoPath' AND (v IS NULL OR v='');
UPDATE app_settings SET v='$FOOT' WHERE k='org.footerText' AND (v IS NULL OR v='');
UPDATE app_settings SET v='Airtel' WHERE k='org.companyName' AND (v IS NULL OR v='');"
DBH="$(envval DB_HOST)"; MYSQL_PWD="$(envval DB_PASSWORD)" $MYSQL -h "${DBH:-localhost}" ${DBO:+-P "$DBO"} -u "$(envval DB_USER)" --default-character-set=utf8mb4 "$DBN" -e "$SQL" 2>&1 \
  && echo "Branding in place: Airtel logo + Internal Official Use Only footer." \
  || { echo "WARNING: could not write the branding settings. Set them in the setup wizard instead (Organization and Branding)." >&2; exit 3; }
