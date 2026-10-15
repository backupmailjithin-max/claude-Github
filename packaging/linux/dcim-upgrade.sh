#!/usr/bin/env bash
# Dedicated Upgrade utility. Internally reuses install.sh's --mode upgrade
# logic unchanged -- this is a thin, memorable entry point, not a separate
# implementation. Resolves install.sh next to itself first (appliance /
# git-checkout layout), falling back to the .deb/.rpm installed location.
set -euo pipefail
# readlink -f (not plain dirname on $BASH_SOURCE) so this still finds install.sh
# correctly when invoked through a symlink (e.g. /usr/bin/dcim-upgrade ->
# /opt/dcim/cli/dcim-upgrade.sh, as install.sh's own install_cli_utilities sets
# up for a standalone/appliance install) - dirname on the symlink path itself
# would resolve to the symlink's directory (/usr/bin), not the real file's.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"
[ -x "$INSTALL_SH" ] || INSTALL_SH="/usr/share/dcim/install.sh"
exec "$INSTALL_SH" --mode upgrade --yes "$@"
