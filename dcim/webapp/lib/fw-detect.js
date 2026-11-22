'use strict';
// Decides whether a job / task listed by Dell OME or HPE OneView is a real firmware update that someone started.
// Both appliances run many housekeeping jobs of their own (catalog checks, inventory, warranty, health, iLO data
// collection ...). Those must never appear on the Firmware Jobs tab, so detection is deliberately strict.

const OME_RUNNING = /^(running|starting|queued)$/i;
const OME_NOISE = /inventory|warranty|refresh|report|discovery|health|status|power|catalog|check for|compliance|alert|telemetry|collect|purge|backup/i;
const OME_STRONG = /firmware|baseline|\bbios\b|idrac|driver|smart update|service pack/i;

function omeStatus(j) { return String((j && ((j.LastRunStatus && j.LastRunStatus.Name) || (j.JobStatus && j.JobStatus.Name))) || ''); }
function omeIsRunning(j) { return OME_RUNNING.test(omeStatus(j)); }
function omeHasTargets(j) { return !!(j && Array.isArray(j.Targets) && j.Targets.some((t) => t && t.Id != null)); }

// A real OME firmware update always names the server(s) or group it runs on; system jobs have no targets.
function omeIsFirmwareJob(j) {
  if (!j || !omeIsRunning(j) || !omeHasTargets(j)) return false;
  const type = String((j.JobType && j.JobType.Name) || '');
  const name = String(j.JobName || '');
  const text = `${name} ${j.JobDescription || ''}`;
  if (OME_NOISE.test(`${type} ${name}`)) return false;
  return type === 'Update_Task' || OME_STRONG.test(text);
}

const ONEVIEW_RUNNING = ['Running', 'Starting', 'New', 'Pending', 'Stopping'];
const ONEVIEW_STRONG = /firmware|baseline|smart update|service pack|\bSPP\b/i;
const ONEVIEW_NAME_NOISE = /power|refresh|collect|identify|\bled\b|reset|remote console|inventory|telemetry|health|alert|utilization/i;

function oneviewTaskText(t) {
  const pu = Array.isArray(t.progressUpdates) && t.progressUpdates.length ? t.progressUpdates[t.progressUpdates.length - 1] : null;
  return `${t.name || ''} ${t.taskStatus || ''} ${t.taskType || ''} ${(pu && (pu.statusUpdate || pu.message)) || ''}`;
}
function oneviewResUri(t) { const ar = (t && t.associatedResource) || {}; return typeof ar.resourceUri === 'string' ? ar.resourceUri : ''; }

// Must be running, belong to one server, and say "firmware / baseline / SPP" - a bare word such as "update" is not enough.
function oneviewIsFirmwareTask(t) {
  if (!t || !ONEVIEW_RUNNING.includes(t.taskState)) return false;
  if (!/^\/rest\/server-hardware\/[A-Za-z0-9_-]+$/.test(oneviewResUri(t))) return false;
  if (ONEVIEW_NAME_NOISE.test(String(t.name || ''))) return false;
  return ONEVIEW_STRONG.test(oneviewTaskText(t));
}

module.exports = { omeIsFirmwareJob, omeIsRunning, omeStatus, oneviewIsFirmwareTask, oneviewTaskText, oneviewResUri, ONEVIEW_RUNNING };
