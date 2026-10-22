# Integrity Verification — strict mode (`INTEGRITY_MODE=enforce`) — 2026-10-22

Unchanged: license format, activation workflow (`/api/license/*`), offline validation. Default mode remains `warn`; `restricted` unchanged. Strict mode is opt-in (`.env`).

## Behaviour
Triggers (any one): `server.js`, `lib/license.js`, `lib/license-public-key.js` (or `lib/integrity.js`) differ from the signed manifest; the loaded licence public key differs from the manifest; the manifest is invalid, unreadable, or **missing** (otherwise deleting it would switch the check off).
Not triggers: environment overrides (still audited/warned), hot-fixes elsewhere in the app.

When triggered:
- **Refuses normal startup**: no schema migrations, integration setup, backup scheduler, firmware/PDU polling, retention jobs. Audit `SERVER_START_REFUSED`.
- **HTTP gate** (in `lib/integrity.js`, installed before the server listens): everything except `/api/health`, `/api/license/*` and `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` gets `503`. The three sign-in routes are the one addition to your list — the licence routes are authenticated, so without them an administrator could not reach activation. Paths with `%`, `\`, `..`, `//` are never allow-listed (no encoded/traversal bypass).
- **Reference ID** `INT-<yyyymmddHHMMSS>-<8 hex>`: in every refusal (JSON body + `X-Integrity-Reference` header, or an HTML recovery page for browsers), the `INTEGRITY_ENFORCED` audit event (with affected files), the service log, and `GET /api/license/status` (`integrity.referenceId`, `integrity.recovery`).
- **Recovery instructions** are in each response: find files via the reference ID → restore with the repair utility / `dcim-repair` / `dcim-rollback` → restart; `INTEGRITY_MODE=warn` only for a deliberate change. Activation stays available.
- **Sticky**: a violation detected while running (the 60-second check) engages the gate immediately and stays until restart — restoring files on disk does not lift it, because the already-loaded code is what is suspect.

## Risk assessment
| | Before (warn/restricted) | Strict mode |
|---|---|---|
| Edit `license.js` / `license-public-key.js` on disk, restart | Detected, app still serves (warn) | **Refuses to serve the app**; only health + licence API |
| Delete or forge the manifest | Detected / unsigned | **Refused** |
| Edit `server.js` while keeping `license.js`/`integrity.js` | Detected | **Refused** (the gate lives in `integrity.js`, loaded via `license.js`) |
| Attacker removes the licence/integrity `require` from `server.js` | Undetected at runtime | Still undetected **if the entry file never loads the guard** — in-process enforcement cannot cover a rewritten entry point. Mitigation: read-only code mount in the systemd unit, root-owned files. |
| Attacker rewrites all files + manifest + `integrity.js` | Succeeds | Succeeds (offline Node limit) — needs coordinated edits; leaves audit traces first |
| Operational risk | — | A hand-copied hot-fix to a protected file locks the install until a matching manifest is deployed. Hence opt-in; update zips carry a matching manifest. |
Keygen risk: LOW (unchanged, no new key material).

## Performance
Warn mode: no change (gate not installed). Strict mode: one boolean check per request; allow-list evaluation only while enforced (**0.33 µs/request**); startup verification ≈2 ms; no new I/O.

## Test results
- Enforce unit/HTTP: **68/68** — all 4 file triggers + 3 manifest failures (bad signature, garbage, deleted) + in-memory key swap each enforce, with reference ID format, audit event (same ID, files, recovery) and log; clean tree not enforced; warn/restricted unaffected; env override alone not enforced; deferred-audit queue; live tamper flips on next tick; restore does not lift (sticky); 10 allowed / 18 denied path cases incl. traversal, encoding, case, double slash, wrong method; real HTTP server: health + licence reach the handler, other paths 503 JSON with reference + recovery, browsers get an HTML page, API paths never HTML.
- Real server end-to-end (restarts): clean build in enforce mode behaves normally; tampered `server.js`, `license.js`, `license-public-key.js`, invalid manifest → health 200, sign-in 200, licence status shows the reference, valid activation **200** and bad code 400, `/api/assets` and `/api/users` 503, browser page shows the reference, background jobs not started, audit rows `INTEGRITY_VIOLATION`, `INTEGRITY_ENFORCED`, `SERVER_START_REFUSED`; same tamper in warn mode serves normally; live tamper while running engages after the tick; restoring files + restart returns to normal.
- Regression: earlier integrity unit **36/36**, license unit **51/51**, full 175-check suite **173/175 = unmodified-code control** (same 2 fixture-dependent failures).
- Not executed: real systemd / Windows service with strict mode; rpm/appliance/Windows package builds.

## Rollback
Remove `INTEGRITY_MODE=enforce` from `.env` (or set `warn`) and restart — immediate, no data change. Code rollback: `git revert` the commit (restores the previous `integrity.js`, `license.js`, `server.js`); no migrations, license/trial/DB state untouched.
