// Read-only probe: shows what YOUR Dell OME returns for power/energy, so the integration can be matched to your version.
// Run from the webapp folder:  node tools/probe-ome-power.js https://OME-HOST USER PASSWORD
// Writes ome-power-probe.json in the folder you run it from (no passwords inside). Only reads data.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const [host, user, pass] = process.argv.slice(2);
if (!host || !user || !pass) { console.log('Usage: node tools/probe-ome-power.js https://OME-HOST USER PASSWORD'); process.exit(1); }
const j = async (p, o) => { try { const r = await fetch(host + p, o); const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 300); } return { status: r.status, body: b }; } catch (e) { return { error: e.message }; } };
(async () => {
  const s = await fetch(host + '/api/SessionService/Sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ UserName: user, Password: pass, SessionType: 'API' }) });
  const tok = s.headers.get('x-auth-token'); if (!tok) { console.log('Login failed, HTTP ' + s.status); process.exit(1); }
  const H = { 'X-Auth-Token': tok, 'Content-Type': 'application/json' };
  // Powered-on servers only (PowerState 17 = On)
  const list = await j('/api/DeviceService/Devices?$filter=' + encodeURIComponent('Type eq 1000 and PowerState eq 17') + '&$top=2', { headers: H });
  const devs = (list.body && list.body.value) || [];
  const out = { devices: [] };
  for (const d of devs) {
    const id = d.Id;
    const idx = await j(`/api/DeviceService/Devices(${id})/InventoryDetails`, { headers: H });
    const entries = (idx.body && idx.body.value) || [];
    const names = entries.map((e) => e.InventoryType || e.Name || JSON.stringify(e).slice(0, 60));
    const rec = { id, model: d.Model, inventoryTypesAvailable: names, powerRelated: {} };
    // every inventory type whose name looks power/energy/environment related
    const want = new Set(names.filter((n) => /power|energy|environ|thermal|statist/i.test(String(n))));
    ['serverPowerStatistics', 'powerStatistics', 'serverEnvironment', 'deviceEnvironment'].forEach((n) => want.add(n));
    for (const n of want) rec.powerRelated[n] = await j(`/api/DeviceService/Devices(${id})/InventoryDetails('${n}')`, { headers: H });
    // The device Overview page shows "Power: NNN W" and "Instantaneous Headroom"; try every place that data could be served from.
    rec.deviceRecord = await j(`/api/DeviceService/Devices(${id})`, { headers: H });
    for (const p of ['Power', 'PowerStatistics', 'PowerUsage', 'PowerStates', 'EnvironmentDetails', 'Environment', 'Temperature', 'TemperatureStatistics', 'DeviceHealth', 'SubSystemHealth', 'DeviceBladeSlots', 'DeviceCapabilities']) rec.powerRelated['GET ' + p] = await j(`/api/DeviceService/Devices(${id})/${p}`, { headers: H });
    rec.powerRelated['GET Power (v2)'] = await j(`/api/DeviceService/Devices(${id})/PowerUsageByDevice?$top=5`, { headers: H });
    rec.powerRelated['MetricService types'] = await j('/api/MetricService/MetricTypes', { headers: H });
    out.devices.push(rec);
  }
  fs.writeFileSync('ome-power-probe.json', JSON.stringify(out, null, 2));
  console.log('Done. Send me the file ome-power-probe.json  (' + out.devices.length + ' device(s))');
})();
