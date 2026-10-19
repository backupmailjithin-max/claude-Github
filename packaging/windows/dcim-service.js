#!/usr/bin/env node
// Convenience wrapper so admins don't have to remember sc query DCIM.
// "status" needs no elevation (read-only); start/stop/restart do - sc.exe
// itself fails with an access-denied error and non-zero exit code when not
// elevated, which this surfaces directly instead of silently doing nothing.
'use strict';
const { spawnSync } = require('child_process');

const SERVICE_NAME = 'DCIM';
const action = process.argv[2];
if (!['start', 'stop', 'restart', 'status'].includes(action)) {
  console.error('Usage: node dcim-service.js <start|stop|restart|status>');
  process.exit(1);
}

function run(args) {
  const res = spawnSync('sc.exe', args, { encoding: 'utf8' });
  process.stdout.write(res.stdout || '');
  process.stderr.write(res.stderr || '');
  return res.status;
}

let code;
if (action === 'status') code = run(['query', SERVICE_NAME]);
else if (action === 'start') code = run(['start', SERVICE_NAME]);
else if (action === 'stop') code = run(['stop', SERVICE_NAME]);
else {
  run(['stop', SERVICE_NAME]);
  code = run(['start', SERVICE_NAME]);
}
process.exit(code === 0 ? 0 : 1);
