import { requireAuth } from '../_helpers.mjs';
import { getDevice } from '../../lib/voice-devices.mjs';
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
    // Filter ownership before taking the last ten turns, so another user's
    // activity cannot crowd this user's diagnostics out of the result.
    turns: loadVoiceTurns({ limit: 0 }), links: loadLinkEvents({ limit: 0 }),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
  return true;
}
