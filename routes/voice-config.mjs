/**
 * Per-user voice-config API.
 *
 *   GET  /api/voice-config   — return this user's config { version, slot_assignments }
 *   PUT  /api/voice-config   — replace this user's config; auto-pushes wake words
 *                              to every online voice device paired to this user
 *
 * ONE config per OE-install user → applies to ALL of their voice devices.
 * Designed so a household with multiple voice devices configures slots
 * once instead of per-device. See lib/voice-config.mjs for the schema.
 */

import { requireAuth, readBody, getUser } from './_helpers.mjs';
import { readVoiceConfig, writeVoiceConfig, pushConfigToDevice } from '../lib/voice-config.mjs';
import { listDevices, markVoiceConfigPushed } from '../lib/voice-devices.mjs';

/**
 * Push the user's current voice-config to every device paired to them.
 * Online devices get the OTA immediately; offline ones come up to date
 * on their next WS connect (the ws-handler hook reads voice_config_pushed_version
 * and re-pushes when stale).
 *
 * Per-device push is async (sequential per-slot with ack-wait); devices
 * are fanned out with Promise.all so a slow device doesn't block the
 * others. Version is marked pushed only when every configured slot acked.
 */
async function pushToAllDevices(userId) {
  const cfg = readVoiceConfig(userId);
  const devices = listDevices(userId);
  const perDevice = {};
  await Promise.all(devices.map(async (d) => {
    const r = await pushConfigToDevice(d.id, userId);
    perDevice[d.id] = r;
    const fullySucceeded =
      r.pushedSlots.length > 0 &&
      r.offlineSlots.length === 0 &&
      r.failedSlots.length === 0 &&
      r.ackedSlots.length === r.pushedSlots.length;
    if (fullySucceeded) {
      markVoiceConfigPushed(userId, d.id, cfg.version);
    }
  }));
  return perDevice;
}

export async function handle(req, res) {
  if (req.url === '/api/voice-config' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readVoiceConfig(userId)));
    return true;
  }

  if (req.url === '/api/voice-config' && req.method === 'PUT') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    const saved = writeVoiceConfig(userId, body?.slot_assignments || {}, {
      userExists: (id) => !!getUser(id),
    });
    const push = await pushToAllDevices(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: saved, push }));
    return true;
  }

  return false;
}
