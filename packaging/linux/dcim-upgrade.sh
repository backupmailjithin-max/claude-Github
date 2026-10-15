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
# Note for a standalone (non-.deb/.rpm) install: $INSTALL_SH here is the CACHED
# copy install_cli_utilities() staged at first install, not whatever newer
# install.sh may exist elsewhere - so this re-applies the currently cached
# version (useful for re-registering the service, fixing permissions, etc.),
# it does not fetch or apply a newer release. To actually move to a newer
# version on such an install, run the NEW version's own install.sh --mode
# upgrade directly (or the Distribution Kit's per-version artifacts) instead
# of this PATH shortcut. A .deb/.rpm install doesn't have this limitation:
# installing the new package itself replaces this file with the new version
# before any upgrade logic runs.
exec "$INSTALL_SH" --mode upgrade --yes "$@"
