# DCIM

Data Center Infrastructure Management dashboard (Node.js/Express + MySQL/MariaDB).

- Application source: [`dcim/webapp`](dcim/webapp)
- Installable packages for Linux and Windows, an offline appliance build,
  and admin setup/dashboard pages: see [`packaging/`](packaging) and
  [`docs/PACKAGING.md`](docs/PACKAGING.md) for the full breakdown of what's
  implemented against the packaging roadmap.

## Quick start (from source, for development)

```bash
cd dcim/webapp
cp .env.example .env   # edit DB credentials, JWT_SECRET, PORT
npm start
```

## Installing as a service

See [`docs/PACKAGING.md`](docs/PACKAGING.md) for building and running the
Linux (`.deb`/`.rpm`/`install.sh`) and Windows (`.exe`/`install.ps1`)
installers, including the Install / Upgrade / Repair flow and the
pre-flight validation checks each one runs.
