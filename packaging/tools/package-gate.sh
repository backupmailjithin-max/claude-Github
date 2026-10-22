#!/usr/bin/env bash
# Sourced by the Linux/appliance package builders.
#   package_gate <webapp_dir> <scan_root> [version] [bundled_node_bin]
# Vendor signing: export DCIM_INTEGRITY_SIGN_KEY_FILE=<private key outside the tree>.
#   Automatic once set up: if a vendor key is already pinned (lib/integrity-public-key.js has a non-null
#   key), the manifest MUST be vendor-signed - there is no silent fallback to self-signed once pinned.
#   DCIM_RELEASE_BUILD=1 additionally FAILS the build if no vendor key is pinned yet (use for real release
#   builds once you have run integrity-keygen.js --install; leave unset for dev/test builds).
# Bytenode (optional, speed bump only - see docs/LICENSING-ANTI-CRACK-REVIEW-2026-10-22.md section 4):
#   DCIM_BYTENODE=1 compiles lib/license.js and lib/integrity.js to V8 bytecode with the bundled Node
#   given as the 4th argument (required when DCIM_BYTENODE=1 - bytecode is tied to that exact build).
# 1. (optional) compiles licensing code to bytecode   2. writes the signed integrity manifest   3. FAILS the
# build if the tree holds vendor licence tools, signing material or a private key, or if the manifest does
# not verify, or (DCIM_RELEASE_BUILD=1) if no vendor key is pinned yet. Call it when the tree is final.
package_gate() {
  local webapp="$1" scan="$2" ver="${3:-}" bundled_node="${4:-}" tools node_bin pinned=0 req_vendor=""
  tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] || { for c in "$tools"/../linux/runtime/node/bin/node; do [ -x "$c" ] && node_bin="$c"; done; }
  [ -n "$node_bin" ] || { echo "ERROR: Node.js is required to create the integrity manifest and validate the package (install nodejs or run fetch-node-runtime.sh first)." >&2; return 1; }
  if grep -q "INTEGRITY_PUBLIC_KEY_PEM: \`-----BEGIN" "$webapp/lib/integrity-public-key.js" 2>/dev/null; then pinned=1; fi
  if [ "$pinned" = "1" ]; then
    req_vendor="--require-vendor"
    [ -n "${DCIM_INTEGRITY_SIGN_KEY_FILE:-}" ] || { echo "ERROR: a vendor integrity key is pinned (lib/integrity-public-key.js) but DCIM_INTEGRITY_SIGN_KEY_FILE is not set - every build must be vendor-signed once pinned." >&2; return 1; }
  elif [ "${DCIM_RELEASE_BUILD:-}" = "1" ]; then
    echo "ERROR: DCIM_RELEASE_BUILD=1 but no vendor integrity key is pinned yet - run packaging/tools/integrity-keygen.js --install once before cutting a release (see docs/LICENSING.md)." >&2; return 1
  fi
  if [ "${DCIM_BYTENODE:-}" = "1" ]; then
    [ -n "$bundled_node" ] && [ -x "$bundled_node" ] || { echo "ERROR: DCIM_BYTENODE=1 requires the bundled target node binary as package_gate's 4th argument (bytecode must match the exact Node build this package ships)." >&2; return 1; }
    "$node_bin" "$tools/bytenode-compile.js" --webapp "$webapp" --node "$bundled_node" || return 1
  fi
  "$node_bin" "$tools/make-integrity-manifest.js" --webapp "$webapp" ${ver:+--version "$ver"} || return 1
  "$node_bin" "$tools/validate-package.js" --root "$scan" --require-manifest $req_vendor || { echo "ERROR: package validation failed - package NOT created." >&2; return 1; }
}
