'use strict';
// Vendor INTEGRITY public key (verify-only). The matching private key signs integrity.manifest.json at package-build
// time and never leaves the vendor; it is not the licence key and not shipped. While this is null the manifest is
// self-signed by the build (legacy behaviour). Set it once with: node packaging/tools/integrity-keygen.js --install
// (see docs/LICENSING.md, "Vendor-signed integrity manifest").
module.exports = {
  INTEGRITY_PUBLIC_KEY_PEM: null,
};
