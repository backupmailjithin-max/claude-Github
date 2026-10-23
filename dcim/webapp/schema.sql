-- Data Center Dashboard - MySQL / MariaDB schema
-- Mirrors what server.js -> initDB() creates and migrates to. Safe to re-run:
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Locations (DCs) - seeded with Chennai and Manesar by server.js
CREATE TABLE IF NOT EXISTS locations (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Catalogs shared by dropdowns and filters
CREATE TABLE IF NOT EXISTS rack_types (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  INDEX idx_assets_site (site),
  INDEX idx_assets_hardware (hardware_type)
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
  INDEX idx_issues_status (completed_date)
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  dc_invoice_no VARCHAR(100),
  dc_invoice_file VARCHAR(255),
  dc_invoice_original_name VARCHAR(255),
  movement_date DATE,
  remarks TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_movements_site (site),
  INDEX idx_movements_type (movement_type),
  INDEX idx_movements_date (movement_date)
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
  KEY idx_audit_created (created_at),
  KEY idx_audit_user (username, created_at),
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
