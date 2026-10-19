'use strict';
// Public key used to verify signed license files (tools/license-issue.js
// signs with the matching PRIVATE key, which must never be committed here
// or shipped to customers - see docs/LICENSING.md).
//
// Licensing is OFF by default: as long as this is null, lib/license.js
// never blocks anything, so a fresh checkout/build behaves exactly as
// before. Generate a real keypair with tools/license-keygen.js and paste
// the printed public key below to turn enforcement on.
module.exports = {
  LICENSE_PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIdp5YuQVI0Si7LtK/116XuTui9D6d0NGwdIwIla+jQI=
-----END PUBLIC KEY-----
`,
};
