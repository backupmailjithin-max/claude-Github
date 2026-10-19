#!/usr/bin/env node
'use strict';
// Seeds realistic-looking DEMO PDU data (pdus + power_readings) so the PDU
// Power page, its Highest Rack Power Load / trend modules, and the Dashboard
// "Total Power Load by Location" card all have something to show on a fresh
// install, before you point it at real PDUs.
//
// Every row this script creates is clearly marked (id starts with
// "PDU-DEMO-") so it is easy to find and remove later - see the printed
// summary at the end for the exact DELETE statement.
//
// Usage (from the webapp folder, same place you run `npm start`):
//   node tools/seed-pdu-demo-data.js
//
// Reads DB connection settings from .env the same way server.js does
// (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const VENDOR_PRESETS = [
  { vendor: 'APC / Schneider Electric', model: 'Rack PDU 2G AP8865', oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.5.0', scale: 10 },
  { vendor: 'Eaton', model: 'ePDU G3 Managed', oid: '1.3.6.1.4.1.534.6.6.4.1.1.2.3.0', scale: 1 },
];
const RACK_TYPES = ['COMP-1', 'COMP-2', 'Network'];

function rand(min, max) { return min + Math.random() * (max - min); }
function round(n, d) { const p = Math.pow(10, d); return Math.round(n * p) / p; }
function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

async function main() {
  const pool = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  console.log(`Connected to ${process.env.DB_NAME} at ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);

  let [locRows] = await pool.query('SELECT name FROM locations WHERE archived_at IS NULL ORDER BY name');
  let sites = locRows.map((r) => r.name);
  if (!sites.length) sites = ['Sample Site A', 'Sample Site B'];
  console.log('Sites:', sites.join(', '));

  const ts = Date.now();
  let pduCount = 0, rackCount = 0, readingCount = 0;

  for (let si = 0; si < sites.length; si++) {
    const site = sites[si];
    let [zoneRows] = await pool.query('SELECT zone_name FROM zones WHERE site = ? ORDER BY zone_name', [site]);
    let zones = zoneRows.map((r) => r.zone_name);
    if (!zones.length) zones = ['AZ-1', 'AZ-2'];

    const rackCountForSite = 3;
    for (let ri = 0; ri < rackCountForSite; ri++) {
      const zone = zones[ri % zones.length];
      const rackType = RACK_TYPES[ri % RACK_TYPES.length];
      const rackNo = String(10 + ri);
      const phase = ri % 3 === 0 ? '3-Phase' : 'Single-Phase';
      const preset = VENDOR_PRESETS[ri % VENDOR_PRESETS.length];
      const maxLoadPerFeed = round(rand(2.5, 4.5), 1);
      rackCount++;

      for (const feedLabel of ['Feed A', 'Feed B']) {
        const feedIdx = feedLabel === 'Feed A' ? 1 : 2;
        const id = `PDU-DEMO-${ts}-${si}${ri}${feedIdx}`;
        const ip = `10.50.${si}.${ri * 10 + feedIdx}`;
        const usedPct = rand(0.35, 0.78);
        const lastPowerKw = round(maxLoadPerFeed * usedPct, 2);
        const serial = `DEMO-SN-${site.replace(/\s+/g, '').slice(0, 4).toUpperCase()}-${rackNo}-${feedIdx}`;

        await pool.query(
          `INSERT IGNORE INTO pdus
            (id, site, zone, rack_type, rack_no, feed_label, ip_address, vendor, model, serial_number, firmware,
             phase, max_load_kw, snmp_community, power_oid, power_scale, poll_interval_sec, status,
             last_power_kw, last_reading_at, last_error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NULL)`,
          [id, site, zone, rackType, rackNo, feedLabel, ip, preset.vendor, preset.model, serial, '1.0.0',
            phase, maxLoadPerFeed, 'public', preset.oid, preset.scale, 900, 'online', lastPowerKw]
        );
        pduCount++;

        // 90 days of history so the trend chart / Highest Rack Power Load
        // module and the compact 30-day sparkline all have real data.
        for (let d = 89; d >= 0; d--) {
          const dayVariance = rand(0.85, 1.15);
          const avgKw = round(lastPowerKw * dayVariance, 3);
          const peakKw = round(avgKw * rand(1.05, 1.3), 3);
          const energyKwh = round(avgKw * 24, 2);
          await pool.query(
            `INSERT IGNORE INTO power_readings (pdu_id, site, zone, reading_date, avg_kw, peak_kw, energy_kwh, sample_count)
             VALUES (?,?,?,?,?,?,?,?)`,
            [id, site, zone, isoDaysAgo(d), avgKw, peakKw, energyKwh, 96]
          );
          readingCount++;
        }
      }
    }
  }

  await pool.end();
  console.log('');
  console.log(`Done: ${pduCount} demo PDUs across ${rackCount} racks, ${readingCount} power_readings rows inserted.`);
  console.log('Restart the DCIM service (or just refresh the browser) to see them on the PDU Power page and Dashboard.');
  console.log('');
  console.log('To remove this demo data later (before going to production with real PDUs), run:');
  console.log(`  DELETE FROM pdus WHERE id LIKE 'PDU-DEMO-%';   -- power_readings rows cascade-delete automatically`);
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
