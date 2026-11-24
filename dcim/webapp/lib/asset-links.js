'use strict';
// Rows that hang off an asset by its SERIAL NUMBER rather than by its asset id:
//   asset_connectivity (one row per serial, cable sheet data)
//   asset_hw_details   (one row per serial, cached OME / OneView hardware detail)
// Issues are linked the same way (issues.asset_id holds the serial) and are handled by syncIssuesForAsset in server.js.
//
// These helpers take any mysql2 connection / pool (so they can run inside the caller's transaction) and never
// open a transaction themselves. Table names are fixed constants - nothing here is built from user input.

const LINK_TABLES = ['asset_connectivity', 'asset_hw_details'];

function clean(s) { return s === null || s === undefined ? '' : String(s).trim(); }

// Move the serial-keyed rows of an asset from its old serial number to its new one.
// - nothing to move (no row under the old serial): nothing changes, a row already under the new serial is left alone
// - a leftover row already sitting under the NEW serial (from an earlier deleted asset) is replaced by the row that
//   belongs to this asset, so there is never a duplicate and the asset keeps its own data
// - a change that only differs in letter case / spacing re-keys the same row in place (never deletes it)
async function moveSerialLinks(conn, oldSerial, newSerial) {
  const from = clean(oldSerial), to = clean(newSerial);
  const out = { connectivity: 0, hwDetails: 0, replacedStale: 0 };
  if (!from || !to || from === to) return out;
  for (const table of LINK_TABLES) {
    const [src] = await conn.query(`SELECT serial_number FROM \`${table}\` WHERE serial_number = ? LIMIT 1`, [from]);
    if (!src.length) continue;
    const [dst] = await conn.query(`SELECT serial_number FROM \`${table}\` WHERE serial_number = ? LIMIT 1`, [to]);
    // the same stored row is found under both spellings (case / trailing-space collation): just re-key it
    const sameRow = dst.length && src[0].serial_number === dst[0].serial_number;
    if (dst.length && !sameRow) {
      await conn.query(`DELETE FROM \`${table}\` WHERE serial_number = ?`, [to]);
      out.replacedStale++;
    }
    await conn.query(`UPDATE \`${table}\` SET serial_number = ? WHERE serial_number = ?`, [to, src[0].serial_number]);
    if (table === 'asset_connectivity') out.connectivity = 1; else out.hwDetails = 1;
  }
  return out;
}

// Read the serial-keyed rows of an asset (used to keep them in the delete snapshot so Restore can bring them back).
async function captureSerialLinks(conn, serial) {
  const key = clean(serial);
  const links = { connectivity: null, hwDetails: null };
  if (!key) return links;
  const [c] = await conn.query('SELECT * FROM asset_connectivity WHERE serial_number = ? LIMIT 1', [key]);
  const [h] = await conn.query('SELECT * FROM asset_hw_details WHERE serial_number = ? LIMIT 1', [key]);
  if (c.length) links.connectivity = c[0];
  if (h.length) links.hwDetails = h[0];
  return links;
}

// Remove the serial-keyed rows of a deleted asset - but only when no other asset still carries that serial.
async function removeSerialLinks(conn, serial, deletedAssetId) {
  const key = clean(serial);
  const out = { connectivity: 0, hwDetails: 0 };
  if (!key) return out;
  const [others] = await conn.query('SELECT id FROM assets WHERE serial_number = ? AND id != ? LIMIT 1', [key, deletedAssetId || '']);
  if (others.length) return out;
  const [c] = await conn.query('DELETE FROM asset_connectivity WHERE serial_number = ?', [key]);
  const [h] = await conn.query('DELETE FROM asset_hw_details WHERE serial_number = ?', [key]);
  out.connectivity = Number(c && c.affectedRows) || 0;
  out.hwDetails = Number(h && h.affectedRows) || 0;
  return out;
}

// Put captured rows back (audit-log Restore of a deleted asset). Existing rows win - nothing is overwritten.
async function restoreSerialLinks(conn, links) {
  const out = { connectivity: 0, hwDetails: 0 };
  if (!links || typeof links !== 'object') return out;
  const put = async (table, row) => {
    if (!row || typeof row !== 'object' || !clean(row.serial_number)) return 0;
    const cols = Object.keys(row).filter((c) => /^[a-z_]+$/.test(c));
    const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
    const [r] = await conn.query(`INSERT IGNORE INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
    return Number(r && r.affectedRows) || 0;
  };
  // the auto-increment id of a connectivity row is dropped so a restored row can never collide with a new one
  if (links.connectivity) { const { id, ...rest } = links.connectivity; out.connectivity = await put('asset_connectivity', rest); }
  if (links.hwDetails) out.hwDetails = await put('asset_hw_details', links.hwDetails);
  return out;
}

module.exports = { LINK_TABLES, moveSerialLinks, captureSerialLinks, removeSerialLinks, restoreSerialLinks };
