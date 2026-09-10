import { requireAuth, readBody, isChildRequest } from '../_helpers.mjs';
import { getDevice, getSlotAssignment } from '../../lib/voice-devices.mjs';
import { deviceWakeCutoff, saveDeviceWakeCutoff, summarizeRoomCalibration } from '../../lib/voice-calibration.mjs';
import { getDeviceHealth } from '../../lib/voice-device-health.mjs';
import { isDeviceOnline } from '../../ws-handler.mjs';
import { loadVoiceTurns } from '../../lib/voice-turn-journal.mjs';
import { loadLinkEvents } from '../../lib/voice-connectivity-journal.mjs';
import { buildVoiceDiagnostics } from '../../lib/voice-diagnostics.mjs';

export function handleVoiceDiagnostics(req, res, pathname) {
  const match = pathname.match(/^\/api\/devices\/([^/]+)\/diagnostics$/);
  if (!match || req.method !== 'GET') return false;
  const userId = requireAuth(req, res);
  if (!userId) return true;
  let deviceId;
  try { deviceId = decodeURIComponent(match[1]); } catch { deviceId = ''; }
  const device = getDevice(userId, deviceId);
  res.setHeader('Cache-Control', 'private, no-store');
  if (!device) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Device not found.' }));
    return true;
  }
  const result = buildVoiceDiagnostics({
    userId, device, online: isDeviceOnline(device.id), health: getDeviceHealth(device.id),
    includeContent: new URL(req.url, 'http://localhost').searchParams.get('details') === '1',
    // Filter ownership before taking the last ten turns, so another user's
    // activity cannot crowd this user's diagnostics out of the result.
    turns: loadVoiceTurns({ limit: 0 }), links: loadLinkEvents({ limit: 0 }),
  });
  result.calibrationSlots = Array.from({ length: 6 }, (_, slot) => {
    const assignment = getSlotAssignment(userId, device.id, slot);
    return assignment?.ownerUserId === userId && assignment.wakewordId
      ? { slot, wakewordId: assignment.wakewordId, cutoff: assignment.avg_prob_cutoff,
        overridden: deviceWakeCutoff(userId, device.id, slot, assignment) !== undefined } : null;
  }).filter(Boolean);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
  return true;
}

export async function handleVoiceCalibration(req, res, pathname) {
  const match = pathname.match(/^\/api\/devices\/([^/]+)\/calibration$/);
  if (!match || req.method !== 'POST') return false;
  const userId = requireAuth(req, res); if (!userId) return true;
  if (isChildRequest(req)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Voice devices are managed by an admin.' })); return true; }
  try {
    const device = getDevice(userId, decodeURIComponent(match[1]));
    if (!device) { res.writeHead(404); res.end(JSON.stringify({ error: 'Device not found.' })); return true; }
    const body = JSON.parse(await readBody(req));
    const assignment = getSlotAssignment(userId, device.id, body.slot);
    if (!assignment || assignment.ownerUserId !== userId || assignment.wakewordId !== body.wakewordId) throw new Error('Wake-word assignment changed. Refresh and try again.');
    let result;
    if (body.action === 'apply' || body.action === 'reset') {
      await saveDeviceWakeCutoff(userId, device.id, body.slot, assignment, body.action === 'reset' ? null : body.cutoff);
      result = { ok: true };
    } else if (body.action === 'summarize') {
      const now = Date.now();
      if (!Number.isFinite(body.startedAt) || !Number.isFinite(body.quietUntil) || body.startedAt < now - 10 * 60_000
          || body.quietUntil < body.startedAt + 20_000 || body.quietUntil > now) throw new Error('Calibration has expired or the quiet-room step is incomplete.');
      const data = buildVoiceDiagnostics({ userId, device, online: isDeviceOnline(device.id), health: getDeviceHealth(device.id), turns: loadVoiceTurns({ limit: 0 }) });
      result = summarizeRoomCalibration(data.room.samples, data.turns, body);
    } else throw new Error('Unknown calibration action.');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  return true;
}
