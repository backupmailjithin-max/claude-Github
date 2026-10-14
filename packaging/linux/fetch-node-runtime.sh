#!/usr/bin/env bash
# Downloads and stages a standalone Node.js runtime for bundling into the Linux package.
# Not run by install.sh itself -- run at package-build time (locally or in CI) so the
# git repository never has to carry a vendored binary.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-20.18.1}"
ARCH="${1:-x64}"   # x64 | arm64
OUT_DIR="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime}"

DIST="node-v${NODE_VERSION}-linux-${ARCH}"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${DIST}.tar.xz"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
echo "[fetch-node-runtime] downloading $URL"
curl -fsSL "$URL" -o "/tmp/${DIST}.tar.xz"
tar -xJf "/tmp/${DIST}.tar.xz" -C "$OUT_DIR"
mv "$OUT_DIR/${DIST}" "$OUT_DIR/node"
rm -f "/tmp/${DIST}.tar.xz"
# Trim to what the app needs at runtime: npm/corepack aren't needed in
# production, and the C++ headers (include/) are only for compiling native
# addons -- this app's dependencies (bcryptjs, mysql2, undici, multer, ...)
# are all pure JS, so there's nothing to compile against.
rm -rf "$OUT_DIR/node/lib/node_modules/npm" "$OUT_DIR/node/lib/node_modules/corepack"
rm -rf "$OUT_DIR/node/include" "$OUT_DIR/node/share"
"$OUT_DIR/node/bin/node" --version
echo "[fetch-node-runtime] staged bundled runtime at $OUT_DIR/node"
