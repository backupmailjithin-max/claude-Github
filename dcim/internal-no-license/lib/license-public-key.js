'use strict';
// INTERNAL EDITION OVERLAY - the only code difference between the internal
// (licence-free) edition and the commercial edition.
//
// Copy this one file over dcim/webapp/lib/license-public-key.js. With no public
// key configured, lib/license.js reports "licensing not enforced": no trial,
// no lock screen, no activation prompts, nothing is ever blocked.
//
// NEVER ship this file to a customer. The commercial package must contain the
// vendor public key from dcim/webapp/lib/license-public-key.js.
module.exports = {
  LICENSE_PUBLIC_KEY_PEM: null,
};
