// Read-only probe: shows what YOUR Dell OME returns for power, so the integration can be matched to your version.
// Run from the webapp folder:  node tools/probe-ome-power.js https://OME-HOST USER PASSWORD
// Writes ome-power-probe.json next to where you run it (no passwords inside). Safe: only GET/POST reads.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const [host, user, pass] = process.argv.slice(2);
if (!host || !user || !pass) { console.log('Usage: node tools/probe-ome-power.js https://OME-HOST USER PASSWORD'); process.exit(1); }
const j = async (p, o) => { try { const r = await fetch(host + p, o); const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 300); } return { status: r.status, body: b }; } catch (e) { return { error: e.message }; } };
(async () => {
  const s = await fetch(host + '/api/SessionService/Sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ UserName: user, Password: pass, SessionType: 'API' }) });
  const tok = s.headers.get('x-auth-token'); if (!tok) { console.log('Login failed, HTTP ' + s.status); process.exit(1); }
  const H = { 'X-Auth-Token': tok, 'Content-Type': 'application/json' };
  const list = await j('/api/DeviceService/Devices?$filter=Type eq 1000&$top=2', { headers: H });
  const devs = (list.body && list.body.value) || [];
  const out = { omeVersionHint: (await j('/api/ApplicationService/Info', { headers: H })).body, devices: [] };
  for (const d of devs) {
    const id = d.Id;
    out.devices.push({ id, model: d.Model,
      powerUsageByDevice: await j(`/api/DeviceService/Devices(${id})/PowerUsageByDevice`, { headers: H }),
      serverPowerSupplies: await j(`/api/DeviceService/Devices(${id})/InventoryDetails('serverPowerSupplies')`, { headers: H }),
      metricsPlugin: await j('/api/MetricService/Metrics', { method: 'POST', headers: H, body: JSON.stringify({ PluginId: '2F6D05BE-EE4B-4B0E-B873-C8D2F64A4625', EntityType: 0, EntityId: id, MetricTypes: [4], Duration: 0, SortOrder: 0 }) }),
    });
  }
  fs.writeFileSync('ome-power-probe.json', JSON.stringify(out, null, 2));
  console.log('Done. Send me the file ome-power-probe.json');
})();
