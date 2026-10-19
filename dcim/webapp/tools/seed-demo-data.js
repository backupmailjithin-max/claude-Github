#!/usr/bin/env node
'use strict';
// Seeds realistic-looking DEMO data across every module EXCEPT PDUs (which
// already have their own seeder: tools/seed-pdu-demo-data.js) so Asset
// Inventory, DC Capacity, Issue Tracker, DC Activity, and Material
// Movements all have something to show - and so every export/report button
// on those pages produces a real-looking file instead of an empty one.
//
// Run both seeders together for full coverage:
//   node tools/seed-demo-data.js
//   node tools/seed-pdu-demo-data.js
//
// Reads DB connection settings from .env the same way server.js does
// (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME).
//
// Every row this script creates uses an id in the 9000+ range (assets,
// activities, material movements), a ticket number in the 89000s (issues),
// or an id starting with "RK-DEMO-" (racks) so it's easy to find and
// remove later - see the printed summary at the end for exact DELETE
// statements. Existing rows (including the ones already in a fresh
// install's default sample data) are never modified.
//
// WHAT THIS DOES NOT SEED, AND WHY
// -----------------------------------
// - asset_hw_details: this is a cache of hardware specs actually fetched
//   live from a server's iLO/OneView/Redfish management API. Fabricating
//   rows here would look like real fetched data that was never actually
//   retrieved from any device - use the app's own "Refresh Hardware"
//   against a real (or test) management endpoint instead.
// - floor_plans: the rack layout canvas stores each rack's x/y position in
//   a format owned by the frontend component, not documented here. Getting
//   it wrong risks a garbled floor view; laying racks out via the Floor
//   Plan page itself takes a minute and is guaranteed correct.
// - firmware_jobs / firmware_compliance_cache: these track real Dell OME /
//   HPE OneView appliance job IDs and poll those appliances live for
//   status. Fabricated rows would make the UI try to re-poll an appliance
//   that was never configured and fail - not a demonstration of the
//   feature working.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

function rand(min, max) { return min + Math.random() * (max - min); }
function round(n, d) { const p = Math.pow(10, d); return Math.round(n * p) / p; }
function pick(arr, i) { return arr[i % arr.length]; }
function dateStr(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

async function main() {
  const pool = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  console.log(`Connected to ${process.env.DB_NAME} at ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);

  let [locRows] = await pool.query("SELECT name FROM locations WHERE status = 'Active' ORDER BY name");
  let sites = locRows.map((r) => r.name);
  if (!sites.length) sites = ['Sample Site A', 'Sample Site B'];
  console.log('Sites:', sites.join(', '));

  const counts = { zones: 0, racks: 0, assets: 0, connectivity: 0, movements: 0, issues: 0, activities: 0, materials: 0, firmware: 0 };

  // ---------------------------------------------------------------------
  // 1) ZONES - backfill any site that has no zone rows yet (AZ-1/AZ-2),
  //    so rack/asset/floor-plan dropdowns for that site are never empty.
  // ---------------------------------------------------------------------
  for (const site of sites) {
    const [existing] = await pool.query('SELECT zone_name FROM zones WHERE site = ?', [site]);
    if (existing.length) continue;
    for (const zoneName of ['AZ-1', 'AZ-2']) {
      await pool.query('INSERT IGNORE INTO zones (id, site, zone_name, created_by) VALUES (?,?,?,?)',
        [`ZN-DEMO-${site.replace(/\s+/g, '').slice(0, 6).toUpperCase()}-${zoneName}`, site, zoneName, 'System (demo seed)']);
      counts.zones++;
    }
  }

  // ---------------------------------------------------------------------
  // 2) RACKS - the table most reports/capacity views depend on, and the
  //    one most likely to be completely empty on a fresh install even
  //    though assets/PDUs already reference rack numbers. We backfill
  //    every (site, zone, rack_type, rack_no) combo already referenced
  //    by assets or PDUs, then add a few fresh racks per site with real
  //    spare capacity so "available space" has something to show too.
  // ---------------------------------------------------------------------
  const [assetRackRows] = await pool.query(
    "SELECT DISTINCT site, zone, rack_type, rack_no FROM assets WHERE rack_no IS NOT NULL AND rack_type IS NOT NULL"
  );
  const [pduRackRows] = await pool.query(
    "SELECT DISTINCT site, zone, rack_type, rack_no FROM pdus WHERE rack_no IS NOT NULL AND rack_type IS NOT NULL"
  );
  const neededRacks = [...assetRackRows, ...pduRackRows];
  const seenRackKeys = new Set();
  for (const r of neededRacks) {
    const key = `${r.site}|${r.zone}|${r.rack_type}|${r.rack_no}`;
    if (seenRackKeys.has(key)) continue;
    seenRackKeys.add(key);
    const [exists] = await pool.query('SELECT id FROM racks WHERE site=? AND zone=? AND rack_no=?', [r.site, r.zone, r.rack_no]);
    if (exists.length) continue;
    const id = `RK-DEMO-${Date.now()}-${counts.racks}`;
    await pool.query(
      'INSERT IGNORE INTO racks (id, site, zone, rack_no, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm, created_by) VALUES (?,?,?,?,?,42,1,2,600,1200,?)',
      [id, r.site, r.zone, r.rack_no, r.rack_type, 'System (demo seed)']
    );
    counts.racks++;
  }

  // A handful of fresh racks per site with real spare capacity, to house
  // the new demo assets below and show "available space" on DC Capacity.
  const EXTRA_RACKS = [
    { rackType: '42U Standard', rackNo: 'A08', zone: 'AZ-1' },
    { rackType: 'Network Rack', rackNo: 'B05', zone: 'AZ-1' },
    { rackType: 'Storage Rack', rackNo: 'C11', zone: 'AZ-2' },
  ];
  const extraRackIdsBySite = {};
  for (const site of sites) {
    extraRackIdsBySite[site] = [];
    for (const er of EXTRA_RACKS) {
      // Racks are scoped by (site, zone, rack_no), so the same rack number
      // can safely repeat across different sites - no offset needed.
      const rackNo = er.rackNo;
      const [exists] = await pool.query('SELECT id FROM racks WHERE site=? AND zone=? AND rack_no=?', [site, er.zone, rackNo]);
      if (exists.length) { extraRackIdsBySite[site].push({ ...er, rackNo }); continue; }
      const id = `RK-DEMO-${Date.now()}-${counts.racks}`;
      await pool.query(
        'INSERT IGNORE INTO racks (id, site, zone, rack_no, rack_type, u_size, w_tiles, h_tiles, width_mm, depth_mm, created_by) VALUES (?,?,?,?,?,42,1,2,600,1200,?)',
        [id, site, er.zone, rackNo, er.rackType, 'System (demo seed)']
      );
      counts.racks++;
      extraRackIdsBySite[site].push({ ...er, rackNo });
    }
  }

  // ---------------------------------------------------------------------
  // 3) ASSETS - 5 new devices per site in the fresh racks above, using
  //    hardware_type names that exactly match the catalog (so dashboard
  //    widgets that group by exact name, like "Server Count", pick them
  //    up correctly) and asset_connectivity rows for the servers among them.
  // ---------------------------------------------------------------------
  const ASSET_TEMPLATES = [
    { hw: 'HPServer', manu: 'HPE', model: 'ProLiant DL380 Gen11', height: '2U', position: '5-6U', fw: 'iLO 6 v1.60', rack: 0, hasIlo: true },
    { hw: 'DellServer', manu: 'Dell', model: 'PowerEdge R750', height: '2U', position: '8-9U', fw: 'iDRAC 6.10.10.00', rack: 0, hasIlo: true },
    { hw: 'Firewall', manu: 'Palo Alto Networks', model: 'PA-3260', height: '1U', position: '12U', fw: 'PAN-OS 11.1.2', rack: 1, hasIlo: false },
    { hw: 'LoadBalancer', manu: 'F5', model: 'BIG-IP i4800', height: '1U', position: '14U', fw: 'TMOS 17.1.1', rack: 1, hasIlo: false },
    { hw: 'Storage', manu: 'Dell EMC', model: 'PowerStore 500T', height: '4U', position: '10-13U', fw: 'PowerStoreOS 4.0', rack: 2, hasIlo: false },
  ];
  const newAssetsBySite = {};
  let astSeq = 9001;
  for (const site of sites) {
    newAssetsBySite[site] = [];
    const racksForSite = extraRackIdsBySite[site];
    for (const tpl of ASSET_TEMPLATES) {
      const rack = racksForSite[tpl.rack];
      const id = `AST-${astSeq}`;
      const serial = `DEMO-SN-${site.replace(/\s+/g, '').slice(0, 4).toUpperCase()}-${astSeq}`;
      const assetTag = `${tpl.hw.replace(/[a-z]/g, '').toUpperCase() || 'DEV'}-${astSeq}`;
      const mgmtIp = `10.9${sites.indexOf(site)}.${Math.floor(astSeq / 100)}.${astSeq % 100}`;
      const [exists] = await pool.query('SELECT id FROM assets WHERE id = ?', [id]);
      if (!exists.length) {
        await pool.query(
          `INSERT INTO assets (id, site, zone, rack_type, rack_no, position, hardware_type, height, manufacturer, model,
            serial_number, installation_date, asset_tag, mgmt_ip, firmware, device_name, remarks, firmware_source, created_by, lifecycle_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, site, rack.zone, rack.rackType, rack.rackNo, tpl.position, tpl.hw, tpl.height, tpl.manu, tpl.model,
            serial, dateStr(daysAgo(Math.floor(rand(10, 60)))), assetTag, mgmtIp, tpl.fw,
            `${tpl.hw.toLowerCase()}-${rack.rackNo.toLowerCase()}-${astSeq}`, 'Added by demo data seeder - safe to edit or delete.',
            'manual', 'System (demo seed)', 'Active']
        );
        counts.assets++;
      }
      newAssetsBySite[site].push({ id, serial, mgmtIp, hw: tpl.hw, hasIlo: tpl.hasIlo, site, zone: rack.zone });

      if (tpl.hasIlo) {
        const [connExists] = await pool.query('SELECT id FROM asset_connectivity WHERE serial_number = ?', [serial]);
        if (!connExists.length) {
          await pool.query(
            `INSERT INTO asset_connectivity (serial_number, site, zone, sheet_rack_no, sheet_u_position, category, ilo_ip, subnet_mask, gateway,
              ilo_cable, ilo_port, switch_sn_ip, data_cable, remarks, updated_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [serial, site, rack.zone, rack.rackNo, tpl.position, 'Server', mgmtIp, '255.255.255.0',
              mgmtIp.replace(/\.\d+$/, '.1'), `CAT6-${astSeq}`, 'Mgmt-1', `SW-CORE-01 / 10.9${sites.indexOf(site)}.0.1`,
              `CAT6-DATA-${astSeq}`, 'Added by demo data seeder.', 'System (demo seed)']
          );
          counts.connectivity++;
        }
      }
      astSeq++;
    }
  }

  // ---------------------------------------------------------------------
  // 4) ASSET MOVEMENTS - a short history for a couple of the brand-new
  //    assets, so Asset Lifecycle history has something to display too.
  // ---------------------------------------------------------------------
  let amvSeq = 9001;
  for (const site of sites) {
    const a = newAssetsBySite[site][0]; // the HPServer
    const [exists] = await pool.query('SELECT id FROM asset_movements WHERE id = ?', [`AMV-${amvSeq}`]);
    if (!exists.length) {
      await pool.query(
        `INSERT INTO asset_movements (id, asset_id, serial_number, movement_type, from_site, from_zone, from_rack_no, from_position,
          to_site, to_zone, to_rack_no, to_position, movement_date, reason, performed_by, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`AMV-${amvSeq}`, a.id, a.serial, 'Rack Install', null, null, null, null,
          a.site, a.zone, 'Received to Store first', '5-6U', dateStr(daysAgo(20)),
          'Initial installation after receiving into store', 'System (demo seed)', 'Added by demo data seeder.']
      );
      counts.movements++;
    }
    amvSeq++;
  }

  // ---------------------------------------------------------------------
  // 5) ISSUES - fills in the last 3 months (the Issue Tracker's monthly
  //    trend chart otherwise shows zero issues for the current month and
  //    the two before it on a fresh/older sample dataset).
  // ---------------------------------------------------------------------
  const ISSUE_TEMPLATES = [
    { title: 'Fan tray reporting degraded RPM', severity: 'warning', daysAgo: 65, resolvedAfter: 2 },
    { title: 'Uplink interface CRC errors increasing', severity: 'warning', daysAgo: 52, resolvedAfter: null },
    { title: 'Disk predictive failure on data volume', severity: 'critical', daysAgo: 40, resolvedAfter: 3 },
    { title: 'PDU feed B reporting intermittent load spikes', severity: 'info', daysAgo: 28, resolvedAfter: 1 },
    { title: 'iLO/iDRAC certificate expiring in 14 days', severity: 'info', daysAgo: 14, resolvedAfter: null },
    { title: 'Core switch CPU utilization sustained above 85%', severity: 'critical', daysAgo: 6, resolvedAfter: null },
  ];
  let tckSeq = 89001;
  let incSeq = 1060;
  for (let i = 0; i < ISSUE_TEMPLATES.length; i++) {
    const tpl = ISSUE_TEMPLATES[i];
    const site = pick(sites, i);
    const id = `INC-${incSeq}`;
    const [exists] = await pool.query('SELECT id FROM issues WHERE id = ?', [id]);
    if (!exists.length) {
      const reported = daysAgo(tpl.daysAgo);
      const completed = tpl.resolvedAfter != null ? daysAgo(tpl.daysAgo - tpl.resolvedAfter) : null;
      await pool.query(
        `INSERT INTO issues (id, ticket_no, asset_type, site, zone, title, description, severity, reported_date, completed_date, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, `TCK-${tckSeq}`, 'Device', site, 'AZ-1', tpl.title,
          `${tpl.title}. Reported during routine monitoring sweep.`, tpl.severity,
          `${dateStr(reported)} 00:00:00`, completed ? `${dateStr(completed)} 00:00:00` : null,
          'Added by demo data seeder - safe to edit or delete.']
      );
      counts.issues++;
    }
    tckSeq++; incSeq++;
  }

  // ---------------------------------------------------------------------
  // 6) DC ACTIVITIES - recent entries so the activity log/timeline isn't
  //    stuck months in the past.
  // ---------------------------------------------------------------------
  const ACTIVITY_TEMPLATES = [
    { hw: 'HPServer', type: 'Rack/Stacking', desc: 'Racked and cabled 2x new HPE ProLiant servers in zone AZ-1.', daysAgo: 25, durationDays: 1 },
    { hw: 'Firewall', type: 'Install/Commission', desc: 'Commissioned new perimeter firewall pair, HA sync verified.', daysAgo: 18, durationDays: 2 },
    { hw: 'Storage', type: 'Firmware Update', desc: 'Applied quarterly firmware update to primary storage array.', daysAgo: 9, durationDays: 1 },
    { hw: 'Switch', type: 'Cabling Work', desc: 'Re-dressed and labeled uplink cabling after rack audit.', daysAgo: 3, durationDays: null },
  ];
  let actSeq = 9001;
  for (let i = 0; i < ACTIVITY_TEMPLATES.length; i++) {
    const tpl = ACTIVITY_TEMPLATES[i];
    const site = pick(sites, i);
    const id = `ACT-${actSeq}`;
    const [exists] = await pool.query('SELECT id FROM dc_activities WHERE id = ?', [id]);
    if (!exists.length) {
      const start = daysAgo(tpl.daysAgo);
      const completion = tpl.durationDays != null ? daysAgo(tpl.daysAgo - tpl.durationDays) : null;
      await pool.query(
        `INSERT INTO dc_activities (id, site, zone, hardware_type, activity_type, description, start_date, completion_date, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, site, 'AZ-1', tpl.hw, tpl.type, tpl.desc, dateStr(start), completion ? dateStr(completion) : null, 'System (demo seed)']
      );
      counts.activities++;
    }
    actSeq++;
  }

  // ---------------------------------------------------------------------
  // 7) MATERIAL MOVEMENTS - recent inward/outward records.
  // ---------------------------------------------------------------------
  const MATERIAL_TEMPLATES = [
    { type: 'Inward', item: '64GB DDR5 RDIMM', qty: 8, unit: 'pcs', daysAgo: 22 },
    { type: 'Outward', item: '10G SFP+ transceiver (faulty)', qty: 3, unit: 'pcs', daysAgo: 15 },
    { type: 'Inward', item: '2U rail kit', qty: 2, unit: 'pcs', daysAgo: 8 },
    { type: 'Outward', item: 'Decommissioned UPS battery module', qty: 4, unit: 'pcs', daysAgo: 4 },
  ];
  let matSeq = 9001;
  for (let i = 0; i < MATERIAL_TEMPLATES.length; i++) {
    const tpl = MATERIAL_TEMPLATES[i];
    const site = pick(sites, i);
    const id = `MAT-${matSeq}`;
    const [exists] = await pool.query('SELECT id FROM material_movements WHERE id = ?', [id]);
    if (!exists.length) {
      await pool.query(
        `INSERT INTO material_movements (id, movement_type, site, item_name, description, quantity, unit, movement_date, remarks, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, tpl.type, site, tpl.item, `${tpl.type} movement logged during routine inventory handling.`,
          tpl.qty, tpl.unit, dateStr(daysAgo(tpl.daysAgo)), 'Added by demo data seeder - safe to edit or delete.', 'System (demo seed)']
      );
      counts.materials++;
    }
    matSeq++;
  }

  // ---------------------------------------------------------------------
  // 8) FIRMWARE TARGETS - simple admin-configured target versions (not
  //    tied to a live appliance), so the Firmware Compliance target config
  //    isn't empty even without Dell OME / HPE OneView connected.
  // ---------------------------------------------------------------------
  const FW_TARGETS = [
    { vendor: 'dell', target: '6.10.10.00' },
    { vendor: 'hpe', target: 'iLO 6 v1.60' },
  ];
  for (const t of FW_TARGETS) {
    const [exists] = await pool.query('SELECT vendor FROM firmware_targets WHERE vendor = ?', [t.vendor]);
    if (!exists.length) {
      await pool.query('INSERT INTO firmware_targets (vendor, target_version, updated_by) VALUES (?,?,?)', [t.vendor, t.target, 'System (demo seed)']);
      counts.firmware++;
    }
  }
  const FW_MODEL_TARGETS = [
    { vendor: 'dell', modelKey: 'poweredge-r750', modelName: 'PowerEdge R750', target: '6.10.10.00' },
    { vendor: 'hpe', modelKey: 'proliant-dl380-gen11', modelName: 'ProLiant DL380 Gen11', target: 'iLO 6 v1.60' },
  ];
  for (const t of FW_MODEL_TARGETS) {
    const [exists] = await pool.query('SELECT vendor FROM firmware_model_targets WHERE vendor = ? AND model_key = ?', [t.vendor, t.modelKey]);
    if (!exists.length) {
      await pool.query('INSERT INTO firmware_model_targets (vendor, model_key, model_name, target_version, updated_by) VALUES (?,?,?,?,?)',
        [t.vendor, t.modelKey, t.modelName, t.target, 'System (demo seed)']);
      counts.firmware++;
    }
  }

  await pool.end();
  console.log('');
  console.log('Done:');
  console.log(`  ${counts.zones} zone(s), ${counts.racks} rack(s), ${counts.assets} asset(s), ${counts.connectivity} connectivity record(s),`);
  console.log(`  ${counts.movements} asset movement(s), ${counts.issues} issue(s), ${counts.activities} DC activity log(s),`);
  console.log(`  ${counts.materials} material movement(s), ${counts.firmware} firmware target config row(s).`);
  console.log('');
  console.log('Restart the DCIM service (or just refresh the browser) to see them across Asset Inventory, DC Capacity,');
  console.log('Issue Tracker, DC Activity, and Material Movements.');
  console.log('');
  console.log('Not seeded (and why - see the comment block at the top of this file):');
  console.log('  asset_hw_details, floor_plans, firmware_jobs, firmware_compliance_cache.');
  console.log('');
  console.log('To remove this demo data later, run:');
  console.log("  DELETE FROM assets WHERE id LIKE 'AST-9%';");
  console.log("  DELETE FROM asset_connectivity WHERE serial_number LIKE 'DEMO-SN-%';");
  console.log("  DELETE FROM asset_movements WHERE id LIKE 'AMV-9%';");
  console.log("  DELETE FROM issues WHERE id LIKE 'INC-10__' AND notes LIKE '%demo data seeder%';");
  console.log("  DELETE FROM dc_activities WHERE id LIKE 'ACT-9%';");
  console.log("  DELETE FROM material_movements WHERE id LIKE 'MAT-9%';");
  console.log("  DELETE FROM racks WHERE id LIKE 'RK-DEMO-%';");
  console.log("  DELETE FROM zones WHERE id LIKE 'ZN-DEMO-%';");
  console.log("  DELETE FROM firmware_targets WHERE updated_by = 'System (demo seed)';");
  console.log("  DELETE FROM firmware_model_targets WHERE updated_by = 'System (demo seed)';");
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
