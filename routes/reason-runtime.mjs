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

import { requirePrivileged, safeError, readBody, modifyConfig } from './_helpers.mjs';
import {
  getReasonRuntimeStatus,
  installIntoOllama,
  installIntoLmstudio,
} from '../memory/reason-transfer.mjs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { pinServiceGpu } from './config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function runScript(script, env) {
  return new Promise((resolve) => {
    const out = [];
    const c = spawn('bash', [path.join(REPO_ROOT, 'scripts', script)],
      { env: { ...process.env, ...env, HOME: os.homedir() } });
    c.stdout.on('data', d => out.push(d.toString()));
    c.stderr.on('data', d => out.push(d.toString()));
    c.on('error', e => resolve({ code: 1, log: e.message }));
    c.on('exit', code => resolve({ code: code ?? 1, log: out.join('') }));
  });
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

    // Install + select the local llama.cpp GPU server for cortex/reason.
    if (url.pathname === '/api/reason-runtime/llamacpp' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      const gpuId = Number.isInteger(body?.gpuId) ? body.gpuId : 0;
      const r = await runScript('install-llama-server.sh', { OE_LLAMA_KIND: 'cortex', OE_LLAMA_GPU_ID: String(gpuId) });
      if (r.code !== 0) { sendJSON(res, 500, { error: 'install failed', log: r.log }); return true; }
      await modifyConfig(x => {
        x.cortex = x.cortex ?? {};
        x.cortex.reasonProvider = 'llamacpp';
        x.integrations = x.integrations ?? {};
        x.integrations.cortex_llama = { installed: true, gpuId, port: 5157 };
      });
      sendJSON(res, 200, { ok: true, provider: 'llamacpp', gpuId, log: r.log });
      return true;
    }

    if (url.pathname === '/api/reason-runtime/llamacpp-gpu' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      const gpuId = Number.isInteger(body?.gpuId) ? body.gpuId : 0;
      const pin = await pinServiceGpu('oe-cortex-llama.service', gpuId, { envVar: 'GGML_VK_VISIBLE_DEVICES' });
      if (!pin.ok) { sendJSON(res, 400, { error: `GPU pin failed: ${pin.reason}` }); return true; }
      await modifyConfig(x => {
        x.integrations = x.integrations ?? {};
        x.integrations.cortex_llama = { ...(x.integrations.cortex_llama ?? { installed: true, port: 5157 }), gpuId };
      });
      sendJSON(res, 200, { ok: true, gpuId, restarted: pin.restarted });
      return true;
    }

    if (url.pathname === '/api/reason-runtime/llamacpp-uninstall' && req.method === 'POST') {
      await runScript('uninstall-llama-server.sh', { OE_LLAMA_KIND: 'cortex' });
      await modifyConfig(x => {
        x.cortex = x.cortex ?? {};
        x.cortex.reasonProvider = 'builtin';
        x.cortex.reasonModel = 'openensemble-reason-v3.q8_0.gguf';
        if (x.integrations?.cortex_llama) x.integrations.cortex_llama.installed = false;
      });
      sendJSON(res, 200, { ok: true, provider: 'builtin' });
      return true;
    }

    sendJSON(res, 404, { error: 'Not found' });
    return true;
  } catch (e) {
    safeError(res, e, 500);
    return true;
  }
}
