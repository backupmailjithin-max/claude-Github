'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { omeIsFirmwareJob, oneviewIsFirmwareTask } = require('../lib/fw-detect');

const run = { LastRunStatus: { Name: 'Running' } };
test('OME: a real firmware update with device targets is detected', () => {
  assert.ok(omeIsFirmwareJob({ ...run, JobName: 'Update Firmware R750', JobType: { Name: 'Update_Task' }, Targets: [{ Id: 101, TargetType: { Name: 'DEVICE' } }] }));
});
test('OME: housekeeping / no-target jobs are not firmware updates', () => {
  assert.ok(!omeIsFirmwareJob({ ...run, JobName: 'Check for catalog updates', JobType: { Name: 'Update_Task' }, Targets: [] }));
  assert.ok(!omeIsFirmwareJob({ ...run, JobName: 'Update Catalog', JobType: { Name: 'Update_Task' }, Targets: [{ Id: 1 }] }));
  assert.ok(!omeIsFirmwareJob({ ...run, JobName: 'Default Inventory Task', JobType: { Name: 'Inventory_Task' }, Targets: [{ Id: 1 }] }));
  assert.ok(!omeIsFirmwareJob({ ...run, JobName: 'Warranty update', JobType: { Name: 'Update_Task' }, Targets: [{ Id: 1 }] }));
  assert.ok(!omeIsFirmwareJob({ ...run, JobName: 'Update Firmware R750', JobType: { Name: 'Update_Task' }, Targets: [{ Id: 101 }], LastRunStatus: { Name: 'Completed' } }));
});
test('OneView: only tasks that name firmware/baseline/SPP count', () => {
  const base = { taskState: 'Running', associatedResource: { resourceUri: '/rest/server-hardware/ABC123' } };
  assert.ok(oneviewIsFirmwareTask({ ...base, name: 'Update firmware', taskStatus: 'Applying SPP baseline' }));
  assert.ok(!oneviewIsFirmwareTask({ ...base, name: 'Update', taskStatus: 'Updating server status' }));
  assert.ok(!oneviewIsFirmwareTask({ ...base, name: 'Update', taskStatus: 'iLO data collection' }));
  assert.ok(!oneviewIsFirmwareTask({ ...base, taskState: 'Completed', name: 'Update firmware' }));
});
