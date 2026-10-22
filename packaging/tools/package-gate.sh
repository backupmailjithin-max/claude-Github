#!/usr/bin/env bash
# Sourced by the Linux/appliance package builders.
#   package_gate <webapp_dir> <scan_root> [version]
# 1. writes the signed integrity manifest into <webapp_dir>   2. FAILS the build if <scan_root> holds vendor licence
# tools, signing material or a private key, or if the manifest does not verify. Call it when the tree is final.
package_gate() {
  local webapp="$1" scan="$2" ver="${3:-}" tools node_bin
  tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] || { for c in "$tools"/../linux/runtime/node/bin/node; do [ -x "$c" ] && node_bin="$c"; done; }
  [ -n "$node_bin" ] || { echo "ERROR: Node.js is required to create the integrity manifest and validate the package (install nodejs or run fetch-node-runtime.sh first)." >&2; return 1; }
  "$node_bin" "$tools/make-integrity-manifest.js" --webapp "$webapp" ${ver:+--version "$ver"} || return 1
  "$node_bin" "$tools/validate-package.js" --root "$scan" --require-manifest || { echo "ERROR: package validation failed - package NOT created." >&2; return 1; }
}
