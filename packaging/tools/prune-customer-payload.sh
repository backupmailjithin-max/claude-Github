#!/usr/bin/env bash
# Sourced by the Linux/appliance package builders.
#   prune_customer_payload <webapp_dir>
# Removes everything that must never reach a customer machine from a STAGED COPY of dcim/webapp:
#   - vendor licence tooling (keygen / issuer / wizard / fingerprint / templates / SEA build files)
#   - seed + demo utilities, developer build helpers, tests, internal notes (whole tools/, tests/, docs/ folders)
#   - per-install state: .env, license.lic, .trial-state, .license-clock, uploads/, backups/, logs/ (recreated empty)
# The build gate (package_gate -> validate-package.js) then FAILS the build if anything above is still present.
prune_customer_payload() {
  local w="$1"
  [ -d "$w" ] || { echo "prune_customer_payload: not a directory: $w" >&2; return 1; }
  rm -rf "$w/tools" "$w/tests" "$w/docs" "$w/.env" "$w/license.lic" "$w/.trial-state" "$w/.license-clock" \
         "$w/uploads" "$w/backups" "$w/logs" "$w/node_modules/.cache"
  find "$w" -path "$w/node_modules" -prune -o -name '*.test.js' -type f -delete 2>/dev/null || true
  mkdir -p "$w/uploads" "$w/backups" "$w/logs"
}
