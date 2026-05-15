/**
 * Wake-word library API.
 *
 *   GET    /api/wakewords           — list this user's library entries
 *   POST   /api/wakewords           — upload a wake word ({ tflite_b64, manifest })
 *   DELETE /api/wakewords/:id       — remove an entry
 *
 * Upload uses JSON+base64 (not multipart) because the files are small
 * (≤256 KB tflite, ≤4 KB manifest). Total ~340 KB JSON for a max-size
 * upload — well under our WS payload cap and fine for fetch().
 *
 * The library is per-user; deletes don't cascade into device
 * slot_assignments references (they fall back to the firmware-built-in
 * slot on next reload), see lib/wakeword-library.mjs comment for why.
 */

import { requireAuth, readBody } from './_helpers.mjs';
import {
  validateUpload, addLibraryWakeword, listLibraryWakewords, deleteLibraryWakeword,
  listStockWakewords, isStockWwId,
} from '../lib/wakeword-library.mjs';

export async function handle(req, res) {
  if (req.url === '/api/wakewords' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    // Stock entries first (alphabetised by phrase) so the dropdown defaults
    // people who haven't uploaded anything onto something usable.
    const wakewords = [...listStockWakewords(), ...listLibraryWakewords(userId)];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ wakewords }));
    return true;
  }

  if (req.url === '/api/wakewords' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (typeof body?.tflite_b64 !== 'string' || !body.manifest) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tflite_b64 + manifest required' }));
      return true;
    }
    let tfliteBuffer;
    try { tfliteBuffer = Buffer.from(body.tflite_b64, 'base64'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tflite_b64 is not valid base64' }));
      return true;
    }
    const err = validateUpload(tfliteBuffer, body.manifest);
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err }));
      return true;
    }
    try {
      const id = addLibraryWakeword(userId, {
        tfliteBuffer,
        manifestObj: body.manifest,
        originalFilename: typeof body.original_filename === 'string' ? body.original_filename : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      // Library-full is a user-actionable 409, not a 500.
      const status = e.code === 'LIBRARY_FULL' ? 409 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  const idMatch = req.url.match(/^\/api\/wakewords\/([\w-]+)$/);
  if (idMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const id = idMatch[1];
    if (isStockWwId(id)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stock wake words cannot be deleted' }));
      return true;
    }
    const ok = deleteLibraryWakeword(userId, id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { removed: true } : { error: 'not found' }));
    return true;
  }

  return false;
}
