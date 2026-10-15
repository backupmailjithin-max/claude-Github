#!/usr/bin/env bash
# Downloads and stages a standalone, relocatable MariaDB server for the
# embedded-database option (--embedded-db on install.sh). Not run by
# install.sh itself -- run at package-build time (locally or in CI), same
# pattern as fetch-node-runtime.sh, so the git repository never has to carry
# a vendored binary and the committed source stays small.
set -euo pipefail

MARIADB_VERSION="${MARIADB_VERSION:-11.4.4}"
OUT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime}"

DIST="mariadb-${MARIADB_VERSION}-linux-systemd-x86_64"
URL="https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/bintar-linux-systemd-x86_64/${DIST}.tar.gz"

rm -rf "$OUT_DIR/mariadb"
mkdir -p "$OUT_DIR"
echo "[fetch-mariadb-runtime] downloading $URL"
curl -fsSL "$URL" -o "/tmp/${DIST}.tar.gz" || {
  echo "[fetch-mariadb-runtime] ERROR: could not download $URL" >&2
  echo "[fetch-mariadb-runtime] MariaDB may have moved/retired this version - check https://archive.mariadb.org/ for the current bintar-linux-systemd-x86_64 path and set MARIADB_VERSION accordingly." >&2
  exit 1
}
tar -xzf "/tmp/${DIST}.tar.gz" -C "$OUT_DIR"
mv "$OUT_DIR/${DIST}" "$OUT_DIR/mariadb"
rm -f "/tmp/${DIST}.tar.gz"

# Trim only what's clearly unused at runtime (docs/tests) - man pages,
# mysql-test, and sql-bench are safe to drop. share/ itself is NOT trimmed
# down to just english/charsets: found via actually running mariadb-install-db
# against a reconstructed bundle that its system-table bootstrap SQL
# (mysql_system_tables.sql, mysql_system_tables_data.sql,
# fill_help_tables.sql, maria_add_gis_sp_bootstrap.sql, ...) lives as plain
# files directly under share/, not inside a locale subdirectory - an earlier
# version of this trim step deleted them as "not english/charsets" and broke
# install-db outright ("Could not find .../share/mysql/fill_help_tables.sql").
# Only non-English locale subdirectories of share/ are pruned, by name, since
# those are unambiguously optional (error messages in other languages).
rm -rf "$OUT_DIR/mariadb/man" "$OUT_DIR/mariadb/mysql-test" "$OUT_DIR/mariadb/sql-bench"
for d in "$OUT_DIR"/mariadb/share/*/; do
  name="$(basename "$d")"
  case "$name" in
    english|charsets) ;;
    bulgarian|chinese|czech|danish|dutch|estonian|french|german|greek|hindi|hungarian|italian|japanese|korean|norwegian|norwegian-ny|polish|portuguese|romanian|russian|serbian|slovak|spanish|swedish|ukrainian|georgian)
      rm -rf "$d" ;;
    *) ;; # unrecognized - leave it alone rather than risk deleting something needed
  esac
done

"$OUT_DIR/mariadb/bin/mariadbd" --version
echo "[fetch-mariadb-runtime] staged bundled MariaDB at $OUT_DIR/mariadb"
