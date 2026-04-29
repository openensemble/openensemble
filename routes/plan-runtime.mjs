/**
 * Admin routes for managing the scheduler (plan) runtime.
 *
 *   GET  /api/plan-runtime/status         — builtin/ollama/lmstudio availability
 *   POST /api/plan-runtime/ollama         — install our GGUF into the user's Ollama
 *   POST /api/plan-runtime/lmstudio       — install our GGUF into LM Studio
 *   POST /api/plan-runtime/select         — set provider without reinstalling (builtin)
 *   POST /api/plan-runtime/builtin-tier   — switch builtin tier ('fast' | 'accurate')
 *
 * Privileged — gated by requirePrivileged because they mutate server-wide
 * config (scheduler.planProvider) and write to the user's home directory.
 */

import path from 'path';
import { requirePrivileged, safeError, readBody, modifyConfig } from './_helpers.mjs';
import {
  getPlanRuntimeStatus,
  installIntoOllama,
  installIntoLmstudio,
} from '../scheduler/plan-transfer.mjs';
import { reloadBuiltinPlan, getBuiltinPlanTier, getBuiltinPlanModelId } from '../scheduler/builtin-plan.mjs';
import {
  installIntoOllama as _installIntoOllama,
  installIntoLmstudio as _installIntoLmstudio,
} from '../scheduler/plan-transfer.mjs';
import { loadConfig } from './_helpers.mjs';
import { BUNDLED_PLAN_MODELS, DEFAULT_PLAN_TIER, planFileForTier, ensureGguf } from '../lib/model-fetch.mjs';
import { USERS_DIR } from '../lib/paths.mjs';

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
        x.scheduler.planModel = getBuiltinPlanModelId();
      });
      sendJSON(res, 200, { ok: true, provider: 'builtin' });
      return true;
    }

    // Switch model tier ('fast' | 'accurate'). Always:
    //   1. ensure the GGUF on disk (download if missing)
    //   2. update config.scheduler.builtinPlanModel
    //   3. hot-reload the in-process llama.cpp model so future builtin calls
    //      see the new tier even if user is currently on an external runtime
    //      (avoids stale state on the next provider swap-back to builtin)
    //   4. if active provider is ollama/lmstudio, also push the new GGUF into
    //      that runtime — otherwise the user's `planModel` config tag stays
    //      pinned to the previous tier and inference goes to the wrong model.
    if (url.pathname === '/api/plan-runtime/builtin-tier' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const tier = body?.tier;
      if (!BUNDLED_PLAN_MODELS[tier]) {
        sendJSON(res, 400, { error: `tier must be one of: ${Object.keys(BUNDLED_PLAN_MODELS).join(', ')}` });
        return true;
      }
      const file = planFileForTier(tier);
      const modelsDir = path.join(USERS_DIR, '..', 'models');
      const have = await ensureGguf(modelsDir, 'plan', file, { logger: (m) => console.log(m) });
      if (!have) {
        sendJSON(res, 503, { error: `failed to fetch ${file} — is the network up?` });
        return true;
      }
      await modifyConfig(x => {
        x.scheduler = x.scheduler ?? {};
        x.scheduler.builtinPlanModel = file;
        if (x.scheduler.planProvider === 'builtin') x.scheduler.planModel = file;
      });
      let reload = { reloaded: false };
      try {
        reload = await reloadBuiltinPlan();
      } catch (e) {
        // Builtin reload failed but config is saved — surface as warning, not
        // hard error, since the active path may be external anyway.
        reload = { reloaded: false, reloadError: e.message };
      }
      // Re-install into the currently-active external runtime, if any. Each
      // installer reads the now-updated config and pushes the file with a
      // size-prefixed tag (135-vN / 360-vN), so both tiers can coexist on
      // the runtime without collision.
      const currentProvider = (loadConfig()?.scheduler?.planProvider) ?? 'builtin';
      let externalPush = null;
      try {
        if (currentProvider === 'ollama')        externalPush = await _installIntoOllama();
        else if (currentProvider === 'lmstudio') externalPush = await _installIntoLmstudio();
      } catch (e) {
        externalPush = { ok: false, error: `re-install into ${currentProvider} failed: ${e.message}` };
      }
      sendJSON(res, 200, {
        ok: true,
        tier,
        model: file,
        reloaded: reload.reloaded,
        reloadError: reload.reloadError ?? null,
        provider: currentProvider,
        externalPush,
      });
      return true;
    }

    sendJSON(res, 404, { error: 'Not found' });
    return true;
  } catch (e) {
    safeError(res, 500, e.message);
    return true;
  }
}
