'use strict';
// Vendor INTEGRITY public key (verify-only). The matching private key signs integrity.manifest.json at package-build
// time and never leaves the vendor; it is not the licence key and not shipped.
module.exports = {
  INTEGRITY_PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA73MFDUABK5qrLDiK1fdeX9ZvmPcSr1JOgrVPqYwY2DU=
-----END PUBLIC KEY-----
`,
};
