#!/usr/bin/env bash
# Dedicated Repair utility. Internally reuses install.sh's --mode repair
# logic unchanged -- this is a thin, memorable entry point, not a separate
# implementation. Resolves install.sh next to itself first (appliance /
# git-checkout layout), falling back to the .deb/.rpm installed location.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"
[ -x "$INSTALL_SH" ] || INSTALL_SH="/usr/share/dcim/install.sh"
exec "$INSTALL_SH" --mode repair --yes "$@"
