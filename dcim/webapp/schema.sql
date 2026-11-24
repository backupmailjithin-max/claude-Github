-- Data Center Dashboard - MySQL / MariaDB schema
-- Mirrors what server.js -> initDB() creates and migrates to (kept in step with the running schema; checked by tests/schema-sync.test.js). Safe to re-run:
-- every table is CREATE TABLE IF NOT EXISTS and indexes are declared inline.
-- (server.js creates all of this automatically on startup; run this only if you
--  want to prepare the database by hand.)

CREATE DATABASE IF NOT EXISTS datacenter_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE datacenter_db;

-- Users. location_access is 'All' or the exact name of ONE location (no fixed ENUM,
-- so any number of locations can be added without a schema change).
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('Admin','Operator','Viewer') DEFAULT 'Viewer',
  location_access VARCHAR(50) DEFAULT 'All',
  status ENUM('Active','Inactive') DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_approver tinyint(1) NOT NULL DEFAULT 0,
  last_seen_at timestamp NULL,
  last_login_at timestamp NULL,
  session_id varchar(64),
  must_change_password tinyint(1) NOT NULL DEFAULT 0,
  password_changed_at datetime
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Locations (DCs) - seeded with Chennai and Manesar by server.js
CREATE TABLE IF NOT EXISTS locations (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status varchar(20) NOT NULL DEFAULT 'Active',
  archived_at datetime,
  archived_by varchar(100),
  KEY idx_locations_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Catalogs shared by dropdowns and filters
CREATE TABLE IF NOT EXISTS rack_types (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rack_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hardware_types (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  -- 'Device' (default) = a normal active asset. 'Component' = a passive rack
  -- item (Patch Panel, Cable Manager, LIU, STS/ATS, Other, ...): no
  -- model/serial/manufacturer needed, auto-placed in the rack, excluded from
  -- "Devices" counts but still counted toward rack U capacity.
  category VARCHAR(20) NOT NULL DEFAULT 'Device',
  -- Prefills the Add Asset form's Height field for this type; not enforced.
  default_height VARCHAR(10) DEFAULT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_hardware_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Zones: planned availability zones per site (DC Capacity -> "Add Zone")
CREATE TABLE IF NOT EXISTS zones (
  id VARCHAR(50) PRIMARY KEY,
  site VARCHAR(50) NOT NULL,
  zone_name VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_site_zone (site, zone_name),
  INDEX idx_zones_site (site)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Racks: planned rack slots per zone (DC Capacity -> "Add Rack"). w_tiles/h_tiles are the
-- floor footprint in 600 mm tiles; width_mm/depth_mm keep the real-world size entered.
CREATE TABLE IF NOT EXISTS racks (
  id VARCHAR(50) PRIMARY KEY,
  site VARCHAR(50) NOT NULL,
  zone VARCHAR(50) NOT NULL DEFAULT 'AZ-1',
  rack_no VARCHAR(50) NOT NULL,
  rack_type VARCHAR(50),
  u_size INT DEFAULT 42,
  w_tiles DECIMAL(5,2) DEFAULT 1,
  h_tiles DECIMAL(5,2) DEFAULT 2,
  width_mm INT DEFAULT 600,
  depth_mm INT DEFAULT 1200,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_site_zone_rack (site, zone, rack_no),
  INDEX idx_racks_site_zone (site, zone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Floor View canvas: ONE JSON blob per (site, zone) holding rack positions (keyed by rack no.),
-- aisles, Entry/Exit/Boundary lines, cages and electrical items.
CREATE TABLE IF NOT EXISTS floor_plans (
  site VARCHAR(50) NOT NULL,
  zone VARCHAR(50) NOT NULL,
  data LONGTEXT,
  updated_by VARCHAR(100),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (site, zone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Asset inventory
CREATE TABLE IF NOT EXISTS assets (
  id VARCHAR(50) PRIMARY KEY,
  site VARCHAR(50) NOT NULL,
  zone VARCHAR(50) DEFAULT 'AZ-1',
  rack_type VARCHAR(50),
  rack_no VARCHAR(50),
  position VARCHAR(50),
  hardware_type VARCHAR(50),
  height VARCHAR(20),
  manufacturer VARCHAR(150),
  model VARCHAR(150),
  serial_number VARCHAR(150) UNIQUE,
  installation_date DATE,
  asset_tag VARCHAR(100) UNIQUE,
  mgmt_ip VARCHAR(255),
  firmware VARCHAR(255),
  device_name VARCHAR(150),
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  lifecycle_status varchar(30) NOT NULL DEFAULT 'Active',
  custody_location varchar(100),
  last_known_site varchar(50),
  last_known_zone varchar(50),
  last_known_rack varchar(50),
  last_known_position varchar(50),
  last_movement_at datetime,
  last_movement_reason varchar(255),
  redfish_username varchar(100),
  redfish_password varchar(255),
  redfish_port int DEFAULT 443,
  redfish_version varchar(20),
  bmc_firmware varchar(100),
  bios_version varchar(100),
  health_status varchar(20),
  power_state varchar(20),
  last_redfish_sync_at datetime,
  last_redfish_error varchar(255),
  redfish_alert_count int,
  redfish_power_watts int,
  redfish_psu_max_watts int,
  hw_psu_rating_watts int,
  hw_power_watts int,
  hw_psu_max_watts int,
  hw_power_source varchar(12),
  hw_power_synced_at datetime,
  redfish_monitor_ignored tinyint(1) NOT NULL DEFAULT 0,
  redfish_serial_number varchar(150),
  redfish_hw_summary varchar(255),
  redfish_cpu varchar(255),
  redfish_mem varchar(255),
  redfish_disk varchar(255),
  redfish_nic varchar(255),
  redfish_hw_json mediumtext,
  redfish_hw_at datetime,
  firmware_source varchar(10) DEFAULT 'manual',
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
  updated_by varchar(100),
  created_by varchar(100),
  changed_fields varchar(255),
  opening_stock tinyint(1) NOT NULL DEFAULT 0,
  INDEX idx_assets_site (site),
  INDEX idx_assets_hardware (hardware_type),
  KEY idx_assets_lifecycle (lifecycle_status),
  KEY idx_assets_rack (site, zone, rack_no),
  KEY idx_assets_site_zone_hw (site, zone, hardware_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Issue tracker. Issues are linked to an asset by SERIAL NUMBER (asset_id). There is intentionally
-- NO foreign key: manual entries for devices that are not in inventory are allowed. server.js keeps
-- asset_id and the location copy (site/zone/rack_no/u_position) of OPEN issues in step with the asset.
CREATE TABLE IF NOT EXISTS issues (
  id VARCHAR(50) PRIMARY KEY,
  ticket_no VARCHAR(50),
  asset_id VARCHAR(150),
  asset_type VARCHAR(30),
  site VARCHAR(50),
  zone VARCHAR(50) DEFAULT 'AZ-1',
  rack_no VARCHAR(50),
  u_position VARCHAR(50),
  location_detail VARCHAR(200),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  severity ENUM('critical','warning','info') DEFAULT 'warning',
  part_required BOOLEAN DEFAULT FALSE,
  part_name VARCHAR(200),
  reported_date DATETIME,
  diagnosed_date DATETIME,
  received_date DATETIME,
  scheduled_date DATETIME,
  completed_date DATETIME,
  moved_to_store_date DATETIME,
  returned_to_oem_date DATETIME,
  notes TEXT,
  cancelled_date DATETIME,
  cancel_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_issues_site (site),
  INDEX idx_issues_asset (asset_id),
  INDEX idx_issues_severity (severity),
  INDEX idx_issues_status (completed_date),
  KEY idx_issues_reported (reported_date),
  KEY idx_issues_site_status (site, completed_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- DC activity log: Rack/Stacking, Cabling, Firmware Update, UPS Drill, ...
CREATE TABLE IF NOT EXISTS dc_activities (
  id VARCHAR(50) PRIMARY KEY,
  site VARCHAR(50) NOT NULL,
  zone VARCHAR(50) DEFAULT 'AZ-1',
  hardware_type VARCHAR(50),
  activity_type VARCHAR(50) NOT NULL,
  description TEXT,
  start_date DATE,
  completion_date DATE,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_activities_dates (start_date, created_at),
  KEY idx_activities_site (site),
  KEY idx_activities_site_zone (site, zone),
  KEY idx_activities_type (activity_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Material movements: Inward / Outward log with an optional DC/Invoice document per record
CREATE TABLE IF NOT EXISTS material_movements (
  id VARCHAR(50) PRIMARY KEY,
  movement_type ENUM('Inward','Outward') NOT NULL,
  site VARCHAR(50) NOT NULL,
  item_name VARCHAR(200) NOT NULL,
  description TEXT,
  quantity INT DEFAULT 1,
  unit VARCHAR(20),
  receiver_name VARCHAR(100),
  sender_name VARCHAR(100),
  contact_mobile VARCHAR(30),
  party_address TEXT,
  dc_invoice_no VARCHAR(100),
  dc_invoice_file VARCHAR(255),
  dc_invoice_original_name VARCHAR(255),
  movement_date DATE,
  remarks TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ticket_no varchar(50),
  status enum('Pending Approval','Approved','Rejected','Ticket Issued','Received at Site','Not Received','Outward Complete','Cancelled') NOT NULL DEFAULT 'Pending Approval',
  approver_name varchar(150),
  approved_at datetime,
  reject_reason varchar(255),
  INDEX idx_movements_site (site),
  INDEX idx_movements_type (movement_type),
  INDEX idx_movements_date (movement_date),
  KEY idx_movements_site_date (site, movement_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin settings (backup on/off, backup folder, last backup result). Created automatically by server.js; not part of backups.
CREATE TABLE IF NOT EXISTS app_settings (
  k VARCHAR(100) NOT NULL PRIMARY KEY,
  v TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Server cable connectivity (one row per server serial number, loaded from the cable-inventory sheets).
-- Created automatically by server.js; included in backups.
CREATE TABLE IF NOT EXISTS asset_connectivity (
  id INT AUTO_INCREMENT PRIMARY KEY,
  serial_number VARCHAR(150) NOT NULL,
  site VARCHAR(50),
  zone VARCHAR(50),
  sheet_rack_no VARCHAR(40),
  sheet_u_position VARCHAR(40),
  category VARCHAR(255),
  ilo_ip VARCHAR(255),
  subnet_mask VARCHAR(255),
  gateway VARCHAR(255),
  ilo_cable TEXT,
  ilo_port TEXT,
  switch_sn_ip TEXT,
  data_cable TEXT,
  backup_cable TEXT,
  provisioning_cable TEXT,
  hbt_cable TEXT,
  replication_cable TEXT,
  storage_cable TEXT,
  storage_port TEXT,
  storage_blade TEXT,
  remarks TEXT,
  source_file VARCHAR(255),
  updated_by VARCHAR(100),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_connectivity_serial (serial_number),
  INDEX idx_connectivity_site (site)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Server hardware details pulled from Dell OME / HPE OneView, cached until someone clicks Sync now.
CREATE TABLE IF NOT EXISTS asset_hw_details (
  serial_number VARCHAR(150) NOT NULL PRIMARY KEY,
  vendor VARCHAR(40),
  site VARCHAR(50),
  zone VARCHAR(50),
  data LONGTEXT,
  fetched_by VARCHAR(100),
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- PHASE-1 hardening: audit trail (created automatically by server.js on startup as well)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT NULL,
  username VARCHAR(100),
  role VARCHAR(20),
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  site VARCHAR(50),
  status ENUM('success','failure') NOT NULL DEFAULT 'success',
  ip_address VARCHAR(64),
  user_agent VARCHAR(255),
  details TEXT,
  snapshot_data mediumtext,
  KEY idx_audit_created (created_at),
  KEY idx_audit_user (username, created_at),
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lifecycle history of an asset (receive, install, move, transfer, decommission). Linked to assets by asset_id. Created automatically by server.js.
CREATE TABLE IF NOT EXISTS asset_movements (
  id varchar(50) NOT NULL,
  asset_id varchar(50) NOT NULL,
  serial_number varchar(150),
  movement_type varchar(40) NOT NULL,
  from_site varchar(50),
  from_zone varchar(50),
  from_rack_no varchar(50),
  from_position varchar(50),
  to_site varchar(50),
  to_zone varchar(50),
  to_rack_no varchar(50),
  to_position varchar(50),
  movement_date datetime NOT NULL,
  reason varchar(255),
  reference_no varchar(100),
  performed_by varchar(100),
  remarks text,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_asset_movements_asset (asset_id),
  KEY idx_asset_movements_asset_date (asset_id, movement_date),
  KEY idx_asset_movements_date (movement_date),
  KEY idx_asset_movements_from_site (from_site),
  KEY idx_asset_movements_serial (serial_number),
  KEY idx_asset_movements_to_site (to_site)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Non-server rack items (patch panels, PDUs strips, cable managers...). Created automatically by server.js.
CREATE TABLE IF NOT EXISTS rack_components (
  id varchar(50) NOT NULL,
  component_code varchar(64) NOT NULL,
  site varchar(50) NOT NULL,
  zone varchar(20) DEFAULT 'AZ-1',
  rack_type varchar(50),
  rack_no varchar(20) NOT NULL,
  position varchar(20),
  hardware_type varchar(50) NOT NULL,
  height varchar(10),
  manufacturer varchar(50),
  model varchar(150),
  asset_tag varchar(100),
  installation_date date,
  remarks text,
  created_by varchar(100),
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  updated_by varchar(100),
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  changed_fields text,
  PRIMARY KEY (id),
  KEY idx_rack_components_rack (site, zone, rack_no),
  UNIQUE KEY uniq_component_code_per_rack (site, zone, rack_no, component_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cached firmware compliance results.
CREATE TABLE IF NOT EXISTS firmware_compliance_cache (
  k varchar(255) NOT NULL,
  v longtext,
  fetched_at bigint,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Firmware update jobs and their progress (Dell OME / HPE OneView / Redfish).
CREATE TABLE IF NOT EXISTS firmware_jobs (
  id bigint NOT NULL AUTO_INCREMENT,
  vendor varchar(20) NOT NULL,
  site varchar(50) NOT NULL,
  zone varchar(50) NOT NULL,
  device_id varchar(255) NOT NULL,
  device_name varchar(255),
  serial varchar(100),
  job_ref text,
  task_uri varchar(255),
  baseline_id varchar(500),
  baseline_label varchar(500),
  started_by varchar(100),
  started_at bigint NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'Running',
  percent int,
  step text,
  error text,
  updated_at bigint,
  finished_at bigint,
  source varchar(20) NOT NULL DEFAULT 'dcim',
  job_name varchar(255),
  PRIMARY KEY (id),
  KEY idx_fwjobs_device (vendor, site, zone, device_id),
  KEY idx_fwjobs_lookup (vendor, site, zone, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Firmware compliance targets per model.
CREATE TABLE IF NOT EXISTS firmware_model_targets (
  vendor varchar(20) NOT NULL,
  model_key varchar(200) NOT NULL,
  model_name varchar(200) NOT NULL,
  target_version varchar(255) NOT NULL,
  updated_by varchar(100),
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor, model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Firmware compliance targets per device.
CREATE TABLE IF NOT EXISTS firmware_targets (
  vendor varchar(20) NOT NULL,
  target_version varchar(255),
  updated_by varchar(100),
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Edit locks of the floor plan editor.
CREATE TABLE IF NOT EXISTS floor_plan_locks (
  site varchar(50) NOT NULL,
  zone varchar(50) NOT NULL,
  lock_token varchar(120) NOT NULL,
  user_id varchar(50) NOT NULL,
  username varchar(100) NOT NULL,
  user_name varchar(150) NOT NULL,
  acquired_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at datetime NOT NULL,
  PRIMARY KEY (site, zone),
  KEY idx_floor_lock_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Documents attached to a material movement (files live in uploads/movements).
CREATE TABLE IF NOT EXISTS material_movement_documents (
  id varchar(50) NOT NULL,
  movement_id varchar(50) NOT NULL,
  file_name varchar(255) NOT NULL,
  original_name varchar(255) NOT NULL,
  uploaded_by varchar(100),
  uploaded_at timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Power distribution units polled over SNMP (lib/pdu-routes.js).
CREATE TABLE IF NOT EXISTS pdus (
  id varchar(50) NOT NULL,
  site varchar(50) NOT NULL,
  zone varchar(20) DEFAULT 'AZ-1',
  rack_type varchar(50),
  rack_no varchar(20) NOT NULL,
  feed_label varchar(20) NOT NULL DEFAULT 'Feed A',
  ip_address varchar(100) NOT NULL,
  chain_unit tinyint NOT NULL DEFAULT 0,
  vendor varchar(50),
  model varchar(150),
  serial_number varchar(150),
  firmware varchar(100),
  phase enum('Single-Phase','3-Phase') NOT NULL DEFAULT 'Single-Phase',
  max_load_kw decimal(6,2),
  snmp_community varchar(100) DEFAULT 'public',
  power_oid varchar(100),
  power_scale decimal(10,4) NOT NULL DEFAULT 1.0000,
  poll_interval_sec int NOT NULL DEFAULT 900,
  status enum('online','offline','warning','unknown') NOT NULL DEFAULT 'unknown',
  last_power_kw decimal(7,3),
  last_reading_at datetime,
  last_error varchar(255),
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_site_zone_rack (site, zone, rack_no),
  UNIQUE KEY uniq_pdu_ip_unit (ip_address, chain_unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Copies of monthly management reports that were generated or e-mailed (lib/report-routes.js creates it the first time a report is made).
CREATE TABLE IF NOT EXISTS report_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  month CHAR(7) NOT NULL,
  scope VARCHAR(120) NOT NULL,
  sites TEXT,
  source VARCHAR(10) NOT NULL,
  created_by VARCHAR(100),
  created_at DATETIME NOT NULL,
  delivered_to TEXT,
  delivery VARCHAR(20),
  size_bytes INT,
  pdf LONGBLOB,
  KEY idx_report_history_month (month),
  KEY idx_report_history_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Month-end figures saved for the monthly management report (lib/report-data.js).
CREATE TABLE IF NOT EXISTS report_snapshots (
  site varchar(50) NOT NULL,
  month char(7) NOT NULL,
  data longtext,
  taken_at datetime NOT NULL,
  PRIMARY KEY (site, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Documents attached to a visitor request (files live in uploads/visitors).
CREATE TABLE IF NOT EXISTS visitor_access_documents (
  id varchar(50) NOT NULL,
  request_id varchar(50) NOT NULL,
  file_name varchar(255) NOT NULL,
  original_name varchar(255) NOT NULL,
  uploaded_by varchar(100),
  uploaded_at timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_visitor_doc_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Visitor access requests (feature "Visitor Access", off in the internal edition).
CREATE TABLE IF NOT EXISTS visitor_requests (
  id varchar(50) NOT NULL,
  ticket_no varchar(50),
  site varchar(50) NOT NULL,
  zone varchar(20) DEFAULT 'AZ-1',
  visitor_name varchar(150) NOT NULL,
  company varchar(150),
  phone varchar(30),
  purpose text,
  host_employee varchar(150),
  visit_date date,
  visit_date_to date,
  expected_checkin datetime,
  expected_checkout datetime,
  actual_checkin datetime,
  actual_checkout datetime,
  id_proof_type varchar(50),
  id_proof_number varchar(100),
  status enum('Pending Approval','Approved','Rejected','Ticket Issued','In Progress','On Hold','Closed') NOT NULL DEFAULT 'Pending Approval',
  approver_name varchar(150),
  approved_at datetime,
  reject_reason varchar(255),
  remarks text,
  created_by varchar(100),
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_visitor_site (site),
  KEY idx_visitor_status (status),
  KEY idx_visitor_visit_date (visit_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Power history of each PDU (lib/pdu-routes.js).
CREATE TABLE IF NOT EXISTS power_readings (
  id bigint NOT NULL AUTO_INCREMENT,
  pdu_id varchar(50) NOT NULL,
  site varchar(50) NOT NULL,
  zone varchar(20) NOT NULL,
  reading_date date NOT NULL,
  avg_kw decimal(7,3),
  peak_kw decimal(7,3),
  energy_kwh decimal(9,2),
  sample_count int NOT NULL DEFAULT 0,
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_site_zone_date (site, zone, reading_date),
  UNIQUE KEY uniq_pdu_date (pdu_id, reading_date),
  CONSTRAINT fk_power_readings_pdu FOREIGN KEY (pdu_id) REFERENCES pdus(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
