/**
 * Per-user routines REST API.
 *
 *   GET    /api/routines          — return this user's routines list
 *   PUT    /api/routines          — replace the full list (web UI + create_routine
 *                                   skill both use this; cleanRoutine in
 *                                   lib/routines.mjs sanitizes)
 *   POST   /api/routines/:id/test — execute a routine immediately (UI "Test"
 *                                   button); deviceId in body or first paired
 *                                   device wins
 *
 * Authoring also goes through the voice-taught create_routine skill, which
 * persists via the same lib/routines.mjs primitives — the only routine writer.
 */

import { requireAuth, readBody } from './_helpers.mjs';
import { loadRoutines, saveRoutines, executeRoutine } from '../lib/routines.mjs';
import { listDevices } from '../lib/voice-devices.mjs';

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
    const saved = saveRoutines(userId, body?.routines || []);
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
    // Pick a target device: explicit deviceId in body, or the first paired
    // device. HA-only routines don't need a device, but play_ambient + tts_say
    // do — the executor surfaces the error in `errors[]` rather than failing
    // the whole call so partial-success is observable.
    let deviceId = typeof body.deviceId === 'string' ? body.deviceId : null;
    if (!deviceId) {
      const devs = listDevices(userId);
      deviceId = devs[0]?.id ?? null;
    }
    const result = await executeRoutine(routine, { userId, deviceId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...result, deviceId }));
    return true;
  }

  return false;
}
