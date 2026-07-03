// @ts-check
/**
 * Per-user routines REST API.
 *
 *   GET    /api/routines                  — return this user's routines list
 *   PUT    /api/routines                  — replace the full list (web UI +
 *                                           create_routine skill both use this;
 *                                           cleanRoutine in lib/routines.mjs
 *                                           sanitizes + auto-generates
 *                                           webhook_token)
 *   POST   /api/routines/:id/test         — execute a routine immediately (UI
 *                                           "Test" button); deviceId in body or
 *                                           routine.device_id or first paired
 *                                           device wins
 *   POST   /api/routines/:id/regen-token  — issue a fresh webhook token for
 *                                           the routine (revokes the old URL)
 *   POST   /api/routines/webhook/:token   — UNAUTHENTICATED external trigger.
 *                                           iPhone NFC shortcuts POST here to
 *                                           fire the routine. Token in URL is
 *                                           the only credential — capability-
 *                                           URL model, same shape as HA
 *                                           webhooks. Targets routine.device_id
 *                                           for play_ambient / tts_say.
 *
 * Authoring also goes through the voice-taught create_routine skill, which
 * persists via the same lib/routines.mjs primitives — the only routine writer.
 */

import { requireAuth, readBody } from './_helpers.mjs';
import {
  loadRoutines, saveRoutines, executeRoutine, runDeferredAmbient,
  findRoutineByWebhookToken, regenerateWebhookToken, resolveRoutineDeviceId,
} from '../lib/routines.mjs';
import { listDevices } from '../lib/voice-devices.mjs';
import { speakRoutineTts } from '../lib/voice-reminder.mjs';

// Speak a routine's reply (if any) then start its deferred ambient sound only
// after the announcement finishes. Shared by the Test button and webhook fires
// (both push to an idle device, no live chat session). Non-blocking.
async function speakThenAmbient(userId, deviceId, result) {
  let ttsMs = 0;
  if (result.text && deviceId) {
    try {
      ({ durationMs: ttsMs } = await speakRoutineTts({ userId, deviceIds: [deviceId], text: result.text }));
    } catch (e) {
      console.warn(`[routines] tts push failed: ${e.message}`);
    }
  }
  const ambient = Array.isArray(result.ambient) ? result.ambient : [];
  if (ambient.length && deviceId) {
    setTimeout(() => {
      runDeferredAmbient(ambient, { userId, deviceId })
        .catch(e => console.warn(`[routines] ambient start failed: ${e.message}`));
    }, ttsMs > 0 ? ttsMs + 300 : 0);
  }
}

export async function handle(req, res) {
  if (req.url === '/api/routines' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadRoutines(userId)));
    return true;
  }

  if (req.url === '/api/routines' && req.method === 'PUT') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    // Full-replace endpoint: a body MISSING the key must not silently save
    // an empty list and wipe every routine. An explicit [] still clears.
    if (!Array.isArray(body?.routines)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body.routines must be an array (send [] to clear)' }));
      return true;
    }
    const saved = saveRoutines(userId, body.routines);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(saved));
    return true;
  }

  const testMatch = req.url.match(/^\/api\/routines\/([^/?]+)\/test$/);
  if (testMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(testMatch[1]);
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* optional body */ }
    const { routines } = loadRoutines(userId);
    const routine = routines.find(r => r.id === id);
    if (!routine) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'routine not found' }));
      return true;
    }
    // Target device precedence: explicit body.deviceId > routine.device_id >
    // first paired device. HA-only routines don't need a device, but
    // play_ambient + tts_say do — the executor surfaces the error in
    // `errors[]` rather than failing the whole call so partial-success is
    // observable.
    let deviceId = typeof body.deviceId === 'string' ? body.deviceId : null;
    // A caller-supplied deviceId must belong to the caller — the TTS half was
    // ownership-filtered but the ambient half sent straight to any device id,
    // letting user A start looping audio on user B's device.
    if (deviceId && !listDevices(userId).some(d => d.id === deviceId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'deviceId is not one of your paired devices' }));
      return true;
    }
    if (!deviceId) deviceId = resolveRoutineDeviceId(routine, null);
    if (!deviceId) {
      const devs = listDevices(userId);
      deviceId = devs[0]?.id ?? null;
    }
    const result = await executeRoutine(routine, { userId, deviceId });
    // Speak the reply (MP3-marker path; the "Test" button has no live WS chat
    // session) then start any ambient sound only after it finishes.
    await speakThenAmbient(userId, deviceId, result);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...result, deviceId }));
    return true;
  }

  const regenMatch = req.url.match(/^\/api\/routines\/([^/?]+)\/regen-token$/);
  if (regenMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = decodeURIComponent(regenMatch[1]);
    const updated = regenerateWebhookToken(userId, id);
    if (!updated) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'routine not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routine: updated }));
    return true;
  }

  const webhookMatch = req.url.match(/^\/api\/routines\/webhook\/([a-f0-9]{16,64})$/);
  if (webhookMatch && req.method === 'POST') {
    const token = webhookMatch[1];
    const hit = findRoutineByWebhookToken(token);
    if (!hit) {
      // Generic 404; don't leak whether the token format matched a real one.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    const { userId, routine } = hit;
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* optional body */ }
    // The webhook is unauthenticated (capability URL) — a caller-supplied
    // deviceId is honored only when it's one of the routine OWNER's paired
    // devices; anything else silently falls back to the routine's own target
    // (a 403 would leak which device ids exist).
    let requested = typeof body.deviceId === 'string' ? body.deviceId : null;
    if (requested && !listDevices(userId).some(d => d.id === requested)) requested = null;
    const deviceId = resolveRoutineDeviceId(routine, requested);
    const result = await executeRoutine(routine, { userId, deviceId });
    // Webhook fires don't have an open chat session — push TTS via the
    // MP3-marker path so an idle paired device speaks the reply, then start any
    // ambient sound only after the announcement finishes.
    await speakThenAmbient(userId, deviceId, result);
    if (result.followupPrompt) {
      // run_prompt inside a webhook-triggered routine is a known gap — the
      // followup needs an active chat session to stream the LLM reply back to
      // the device, and the webhook handler doesn't own one. Log + surface as
      // a non-fatal error so the user can see why their NFC tap was quieter
      // than they expected.
      console.warn(`[routines] webhook ${routine.id}: run_prompt skipped (webhook can't stream LLM reply)`);
      result.errors = [...(result.errors || []),
        { type: 'run_prompt', message: 'run_prompt actions are not supported for webhook-triggered routines yet' }];
    }
    console.log(`[routines] webhook fire: ${routine.id} (user=${userId} device=${deviceId || '-'} errors=${result.errors.length})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routine_id: routine.id, deviceId, errors: result.errors }));
    return true;
  }

  return false;
}
