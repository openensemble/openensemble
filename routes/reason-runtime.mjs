/**
 * Admin routes for managing the memory-lane reasoning runtime.
 *
 *   GET  /api/reason-runtime/status    — builtin/ollama/lmstudio availability
 *   POST /api/reason-runtime/ollama    — install our GGUF into the user's Ollama
 *   POST /api/reason-runtime/lmstudio  — install our GGUF into LM Studio
 *
 * All three are privileged — they mutate server-wide config (`cortex.reasonProvider`)
 * and write to the user's home directory. Scoped to owner/admin via requirePrivileged.
 */

import { requirePrivileged, safeError } from './_helpers.mjs';
import {
  getReasonRuntimeStatus,
  installIntoOllama,
  installIntoLmstudio,
} from '../memory/reason-transfer.mjs';

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/reason-runtime/')) return false;
  if (!requirePrivileged(req, res)) return true;

  try {
    if (url.pathname === '/api/reason-runtime/status' && req.method === 'GET') {
      const status = await getReasonRuntimeStatus();
      sendJSON(res, 200, status);
      return true;
    }

    if (url.pathname === '/api/reason-runtime/ollama' && req.method === 'POST') {
      const result = await installIntoOllama();
      sendJSON(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (url.pathname === '/api/reason-runtime/lmstudio' && req.method === 'POST') {
      const result = await installIntoLmstudio();
      sendJSON(res, result.ok ? 200 : 400, result);
      return true;
    }

    sendJSON(res, 404, { error: 'Not found' });
    return true;
  } catch (e) {
    safeError(res, 500, e.message);
    return true;
  }
}
