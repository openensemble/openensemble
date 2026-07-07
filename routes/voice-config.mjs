/**
 * Per-user voice-config API.
 *
 *   GET  /api/voice-config        — return this user's config { version, slot_assignments }
 *   PUT  /api/voice-config        — replace this user's config (SAVE ONLY, no push)
 *   POST /api/voice-config/push   — explicitly push the saved config (wake words,
 *                                   cutoffs, voices) to every device paired to this user
 *
 * Save and push are decoupled on purpose: editing a wake word / voice / cutoff
 * just persists; the device only gets the OTA when the user hits Push. This
 * stops every keystroke from thrashing the firmware's fragile hot-reload.
 *
 * ONE config per OE-install user → applies to ALL of their voice devices.
 * Designed so a household with multiple voice devices configures slots
 * once instead of per-device. See lib/voice-config.mjs for the schema.
 */

import { requireAuth, readBody, getUser, isPrivileged, isChildRequest } from './_helpers.mjs';
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
  const devices = listDevices(userId);
  const perDevice = {};
  await Promise.all(devices.map(async (d) => {
    const r = await pushConfigToDevice(d.id, userId, { fwVersion: d.fw_version });
    perDevice[d.id] = r;
    // In sync when every push acked and nothing dropped/failed across both the
    // push pass and the clear pass (unassigned slots). No pushedSlots>0 gate —
    // a clear-only config (all users removed) is a valid in-sync state.
    const fullySucceeded =
      r.offlineSlots.length === 0 &&
      r.failedSlots.length === 0 &&
      r.ackedSlots.length === r.pushedSlots.length;
    if (fullySucceeded) {
      markVoiceConfigPushed(userId, d.id, r.version, r.assignments);
    }
  }));
  return perDevice;
}

export async function handle(req, res) {
  // Child accounts cannot change voice devices — an admin manages them. (Hiding
  // the drawer in the child UI is a separate nicety; this is the hard gate.)
  if (/^(POST|PUT|DELETE|PATCH)$/.test(req.method)
      && req.url.startsWith('/api/voice-config') && isChildRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Voice devices are managed by an admin for this account.' }));
    return true;
  }
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
    // Full-replace endpoint: a body MISSING the key must not silently save an
    // empty map and wipe every slot. An explicit {} still clears.
    if (!body || typeof body.slot_assignments !== 'object' || body.slot_assignments === null || Array.isArray(body.slot_assignments)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body.slot_assignments must be an object (send {} to clear)' }));
      return true;
    }
    const assignments = body.slot_assignments;
    // Impersonation guard: a non-admin may only bind a slot to their OWN
    // account. Pinning ownerUserId to the caller stops them pointing a slot at
    // another user and speaking as that user. Admins may assign any account
    // (legitimate household setup — one device, a slot per family member).
    if (!isPrivileged(userId)) {
      for (const a of Object.values(assignments)) {
        if (a && typeof a === 'object') a.ownerUserId = userId;
      }
    }
    const saved = writeVoiceConfig(userId, assignments, {
      userExists: (id) => !!getUser(id),
    });
    // SAVE ONLY — no auto-push. The device gets changes when the user clicks
    // Push (POST /api/voice-config/push below).
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: saved }));
    return true;
  }

  if (req.url === '/api/voice-config/push' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const push = await pushToAllDevices(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ push }));
    return true;
  }

  return false;
}
