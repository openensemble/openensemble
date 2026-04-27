/**
 * Admin routes for managing the scheduler (plan) runtime.
 *
 *   GET  /api/plan-runtime/status     — builtin/ollama/lmstudio availability
 *   POST /api/plan-runtime/ollama     — install our GGUF into the user's Ollama
 *   POST /api/plan-runtime/lmstudio   — install our GGUF into LM Studio
 *   POST /api/plan-runtime/select     — set provider without reinstalling (builtin)
 *
 * Privileged — gated by requirePrivileged because they mutate server-wide
 * config (scheduler.planProvider) and write to the user's home directory.
 */

import { requirePrivileged, safeError, readBody, modifyConfig } from './_helpers.mjs';
import {
  getPlanRuntimeStatus,
  installIntoOllama,
  installIntoLmstudio,
} from '../scheduler/plan-transfer.mjs';

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/plan-runtime/')) return false;
  if (!requirePrivileged(req, res)) return true;

  try {
    if (url.pathname === '/api/plan-runtime/status' && req.method === 'GET') {
      const status = await getPlanRuntimeStatus();
      sendJSON(res, 200, status);
      return true;
    }

    if (url.pathname === '/api/plan-runtime/ollama' && req.method === 'POST') {
      const result = await installIntoOllama();
      sendJSON(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (url.pathname === '/api/plan-runtime/lmstudio' && req.method === 'POST') {
      const result = await installIntoLmstudio();
      sendJSON(res, result.ok ? 200 : 400, result);
      return true;
    }

    // Flip back to builtin without re-running an install — the GGUF is
    // already on disk from postinstall, so nothing to transfer.
    if (url.pathname === '/api/plan-runtime/select' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const provider = body?.provider;
      if (provider !== 'builtin') {
        sendJSON(res, 400, { error: 'Use /ollama or /lmstudio to switch to those runtimes (transfer required).' });
        return true;
      }
      await modifyConfig(x => {
        x.scheduler = x.scheduler ?? {};
        x.scheduler.planProvider = 'builtin';
        x.scheduler.planModel = 'openensemble-plan-v3.q8_0.gguf';
      });
      sendJSON(res, 200, { ok: true, provider: 'builtin' });
      return true;
    }

    sendJSON(res, 404, { error: 'Not found' });
    return true;
  } catch (e) {
    safeError(res, 500, e.message);
    return true;
  }
}
