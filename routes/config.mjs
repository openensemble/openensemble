/**
 * Config routes: /api/config, /api/config-public, /api/cortex-config,
 *                /api/cortex-health, /api/models
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import os from 'os';
import {
  requireAuth, requirePrivileged, loadConfig, modifyConfig, readBody, readBodyBuffer, CFG_PATH, safeError,
  getAuthToken,
} from './_helpers.mjs';
import { getSessionMeta } from './_helpers/auth-sessions.mjs';
import { getSlotAssignment } from '../lib/voice-devices.mjs';
import { getVoiceRef } from '../lib/voice-refs.mjs';
import {
  takeTestMp3,
  takeAmbientStream, registerAmbientResponse, unregisterAmbientResponse,
  pinAmbientMp3, rearmAmbientTtl,
} from './devices.mjs';
import { ambientFilePath } from '../lib/routines.mjs';
import { supportsImageGeneration, supportsVision } from '../lib/model-capabilities.mjs';
import { listOpenAIOAuthModels } from '../lib/openai-codex-models.mjs';
import { listXaiOAuthModels } from '../lib/xai-oauth-models.mjs';
import {
  probePiperAvailable,
  probeKittenttsAvailable,
  probePocketTtsAvailable,
  probeFasterWhisperAvailable,
  probeFfmpegAvailable,
  getTtsAvailability,
  invalidateVoiceDepsCache,
} from '../lib/voice-deps.mjs';
import { log } from '../logger.mjs';
import { OPENAI_COMPAT_PROVIDERS } from '../chat/providers/_shared.mjs';
import { tryHandleModelRoutes } from './config/models.mjs';
import { tryHandleProviderInstall } from './config/provider-install.mjs';
import { tryHandleSpeechRoutes } from './config/speech.mjs';
import { tryHandleProviderSettings, bindProviderSettingsDeps } from './config/provider-settings.mjs';

// TTS/STT + ambient: routes/config/speech.mjs
import { loadUserProviders } from '../lib/user-providers.mjs';

// Tailored URL gate for admin-writable provider endpoints (LM Studio, local
// Ollama). Looser than lib/url-guard.mjs:isUrlSafe — loopback and LAN ranges
// must remain valid (LM Studio normally runs on 127.0.0.1; Ollama may live on
// another box on the same VLAN). We do block link-local / cloud-metadata
// (169.254.x — IMDSv1, GCP metadata, etc.) and refuse non-http(s) schemes /
// malformed input so a typo can't end up in the config.
function validateProviderUrl(field, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return ''; // empty = clear
  let u;
  try { u = new URL(v); } catch { throw new Error(`${field} is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${field} protocol ${u.protocol} not allowed (use http or https)`);
  }
  const host = u.hostname.toLowerCase();
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 169 && b === 254) throw new Error(`${field} points at link-local / cloud-metadata range`);
    if (a === 0)               throw new Error(`${field} points at unspecified-address range`);
    if (a >= 224)              throw new Error(`${field} points at multicast / reserved range`);
  } else if (net.isIPv6(host)) {
    if (host.startsWith('fe80:')) throw new Error(`${field} points at IPv6 link-local range`);
    if (host.startsWith('ff'))    throw new Error(`${field} points at IPv6 multicast range`);
  }
  return v;
}

// This is the default for the "Ollama (cloud)" provider field — the Ollama
// (local) field has its own separate OLLAMA_LOCAL_DEFAULT below. Historically
// this defaulted to localhost even though the UI labels it "cloud", which made
// the pre-filled value look wrong to any new user.
const OLLAMA_DEFAULT = 'https://ollama.com/api';
const LMS_DEFAULT    = 'http://127.0.0.1:1234';
const GROK_BASE      = 'https://api.x.ai/v1';
const GROK_MGMT_BASE = 'https://management-api.x.ai/v1';

// OpenAI-compatible providers: imported from chat/providers/_shared.mjs so
// both the chat dispatch and the config UI see the same map. The shared
// export is a Proxy that transparently merges any runtime-added providers
// from the oe-admin user-providers overlay (config/user-providers.json).
const COMPAT_PROVIDERS = OPENAI_COMPAT_PROVIDERS;

// Perplexity doesn't expose GET /models — hardcode the current Sonar family.
const PERPLEXITY_STATIC_MODELS = [
  { id: 'sonar',                 name: 'Sonar' },
  { id: 'sonar-pro',             name: 'Sonar Pro' },
  { id: 'sonar-reasoning',       name: 'Sonar Reasoning' },
  { id: 'sonar-reasoning-pro',   name: 'Sonar Reasoning Pro' },
  { id: 'sonar-deep-research',   name: 'Sonar Deep Research' },
];

// Enumerate NVIDIA GPUs via nvidia-smi for the "pin a local service to a GPU"
// settings UI. Returns [] when nvidia-smi is absent (CPU-only box) — callers
// treat empty as "no GPU selector". Cached briefly so repeated Settings opens
// don't fork nvidia-smi each time.
let _gpuCache = null; // { at, gpus }
const GPU_CACHE_MS = 30_000;
function listNvidiaGpus() {
  if (_gpuCache && (Date.now() - _gpuCache.at) < GPU_CACHE_MS) {
    return Promise.resolve(_gpuCache.gpus);
  }
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (gpus) => { if (done) return; done = true; _gpuCache = { at: Date.now(), gpus }; resolve(gpus); };
    let child;
    try {
      child = spawn('nvidia-smi',
        ['--query-gpu=index,name,memory.total,memory.free', '--format=csv,noheader,nounits'],
        { env: { ...process.env, HOME: os.homedir() }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish([]); }
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish([]); }, 3000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(killer); finish([]); });
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (code !== 0) return finish([]);
      const gpus = out.trim().split('\n').filter(Boolean).map((line) => {
        const [index, name, total, free] = line.split(',').map(s => s.trim());
        return {
          index: Number(index),
          name,
          memTotalMiB: Number(total) || null,
          memFreeMiB: Number(free) || null,
        };
      }).filter(g => Number.isInteger(g.index));
      finish(gpus);
    });
  });
}

// Rewrite a user systemd unit so a local service is pinned to a specific GPU
// (CUDA_VISIBLE_DEVICES=<index> + CUDA_DEVICE_ORDER=PCI_BUS_ID so the index
// matches nvidia-smi). gpuId === null clears the pin (back to CUDA's default).
// daemon-reloads, and restarts the unit only if it's currently active so we
// don't auto-start a service the user has stopped (e.g. STT switched to remote).
// Reusable for any future GPU-backed local service. Non-fatal: resolves to
// { ok, reason } and logs; never throws into the request path.
export async function pinServiceGpu(serviceName, gpuId, { envVar = 'CUDA_VISIBLE_DEVICES' } = {}) {
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
  if (!fs.existsSync(unitPath)) return { ok: false, reason: 'unit-missing' };
  let unit;
  try { unit = fs.readFileSync(unitPath, 'utf8'); } catch (e) { return { ok: false, reason: e.message }; }
  const isCuda = /^CUDA/.test(envVar);   // CUDA needs the PCI_BUS_ID order; Vulkan (GGML_VK_*) does not
  // Drop any existing pin lines for THIS env var (+ the CUDA order + our marker)
  // so this is idempotent across CUDA-pinned (STT) and Vulkan-pinned (llama) units.
  const lines = unit.split('\n').filter(l =>
    !new RegExp(`^Environment=${envVar}=`).test(l) &&
    !/^Environment=CUDA_DEVICE_ORDER=/.test(l) &&
    !/^# OE GPU pin\b/.test(l));
  if (Number.isInteger(gpuId) && gpuId >= 0) {
    // Insert right after the [Service] header so the env applies to ExecStart.
    const idx = lines.findIndex(l => l.trim() === '[Service]');
    const inject = ['# OE GPU pin (managed by Settings)'];
    if (isCuda) inject.push('Environment=CUDA_DEVICE_ORDER=PCI_BUS_ID');
    inject.push(`Environment=${envVar}=${gpuId}`);
    if (idx >= 0) lines.splice(idx + 1, 0, ...inject);
    else lines.push(...inject);
  }
  try { fs.writeFileSync(unitPath, lines.join('\n')); } catch (e) { return { ok: false, reason: e.message }; }
  const sysctl = (args) => new Promise((resolve) => {
    const c = spawn('systemctl', ['--user', ...args], { env: { ...process.env, HOME: os.homedir() }, stdio: 'ignore' });
    c.on('error', () => resolve(1));
    c.on('exit', (code) => resolve(code ?? 1));
  });
  await sysctl(['daemon-reload']);
  // Only restart if active — `is-active` exits 0 when running.
  const active = await sysctl(['is-active', '--quiet', serviceName]);
  if (active === 0) await sysctl(['restart', serviceName]);
  invalidateVoiceDepsCache();
  log.info('config', `pinned ${serviceName} to GPU`, { gpuId, restarted: active === 0 });
  return { ok: true, restarted: active === 0 };
}

export async function handle(req, res) {
  // GET /api/hardware/gpus — enumerate NVIDIA GPUs for the GPU-pin settings UI.
  // Readable by any authed user (read-only hardware info, no secrets).
  if (req.url === '/api/hardware/gpus' && req.method === 'GET') {
    const authId = requireAuth(req, res);
    if (!authId) return true;
    const gpus = await listNvidiaGpus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gpus, available: gpus.length > 0 }));
    return true;
  }

  if (await tryHandleProviderInstall(req, res)) return true;
  if (await tryHandleModelRoutes(req, res)) return true;
  if (await tryHandleProviderSettings(req, res)) return true;


  // Cortex config
  if (req.url === '/api/cortex-config') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    if (req.method === 'GET') {
      const cfg = loadConfig();
      const cortex = cfg.cortex ?? {};
      // Never echo decrypted secrets. Mask any *ApiKey field to a boolean
      // *KeySet flag (mirrors /api/provider-config); the POST path below treats
      // an absent/empty key as "unchanged" so the mask can't wipe a stored key.
      const out = {};
      for (const [k, v] of Object.entries(cortex)) {
        if (/ApiKey$/.test(k)) out[k.replace(/ApiKey$/, 'KeySet')] = !!v;
        else out[k] = v;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const update = JSON.parse(await readBody(req));
        await modifyConfig(cfg => {
          cfg.cortex = cfg.cortex ?? {};
          for (const [k, v] of Object.entries(update)) {
            // Never persist the masked read-back flags the GET emits.
            if (/KeySet$/.test(k)) continue;
            // Secrets: null explicitly clears; empty/missing means "unchanged"
            // (the GET masks these, so a re-save must not wipe a stored key).
            if (/ApiKey$/.test(k)) {
              if (v === null) delete cfg.cortex[k];
              else if (v) cfg.cortex[k] = v;
              continue;
            }
            if (v === null) delete cfg.cortex[k]; // null = delete (used to clear stale URL overrides)
            else cfg.cortex[k] = v;
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return true;
    }
  }

  // Cortex health
  if (req.url === '/api/cortex-health') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const c = cfg.cortex ?? {};
    const lmsBase    = c.lmstudioUrl ?? 'http://127.0.0.1:1234';
    const ollamaBase = (c.ollamaUrl ?? 'http://localhost:11434').replace(/\/api\/?$/, '');
    const ollamaKey  = c.ollamaApiKey ?? null;
    const embedProvider = c.embedProvider ?? 'builtin';
    const reasonProvider = c.reasonProvider ?? 'auto';
    const check = async (url, headers = {}) => {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2000), headers }); return r.ok; }
      catch (e) { console.debug('[cortex] Health check failed for', url + ':', e.message); return false; }
    };
    const ollamaAuthHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};
    // OE's managed local llama.cpp GPU server has no API key — it must be PROBED
    // like ollama/lmstudio, not treated as a cloud key-based provider. Cortex 5157.
    const llamacppBase = (c.llamacppReasonUrl ?? 'http://127.0.0.1:5157').replace(/\/$/, '');
    const [ollamaOk, lmsOk, llamacppOk] = await Promise.all([
      check(`${ollamaBase}/api/tags`, ollamaAuthHeaders),
      check(`${lmsBase}/v1/models`),
      reasonProvider === 'llamacpp' ? check(`${llamacppBase}/health`) : Promise.resolve(false),
    ]);
    // Cloud providers are "reachable" as long as their API key is configured —
    // probing them costs rate-limit headroom. getProviderSpec returns the
    // authoritative header set (with api key or without).
    const { getProviderSpec } = await import('../memory/shared.mjs');
    const cloudReady = prov => {
      const spec = getProviderSpec(prov);
      return !!(spec && (spec.headers?.Authorization || spec.headers?.['x-api-key']));
    };
    const providerOk = (prov, needEmbed) => {
      if (prov === 'builtin')  return false; // handled specially below for embed
      if (prov === 'ollama')   return ollamaOk;
      if (prov === 'lmstudio') return lmsOk;
      if (prov === 'llamacpp') return llamacppOk;
      if (prov === 'auto')     return ollamaOk || lmsOk;
      const spec = getProviderSpec(prov);
      if (!spec) return false;
      if (needEmbed && !spec.supportsEmbed) return false;
      return cloudReady(prov);
    };
    let embedOk;
    if (embedProvider === 'builtin') {
      const { isBuiltinReady } = await import('../memory/builtin-embed.mjs');
      embedOk = isBuiltinReady();
    } else {
      embedOk = providerOk(embedProvider, true);
    }
    // Reason has its own in-process (llama.cpp) tier. `providerOk()` returns
    // false for 'builtin' by design; handle it here, and also let 'auto' count
    // the built-in runtime as a valid fallback before trying external ones.
    const { isBuiltinReasonReady } = await import('../memory/builtin-reason.mjs');
    const builtinReasonOk = isBuiltinReasonReady();
    const reasonOk = reasonProvider === 'builtin'
      ? builtinReasonOk
      : reasonProvider === 'auto'
        ? (builtinReasonOk || ollamaOk || lmsOk)
        : providerOk(reasonProvider, false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embed: embedOk, reason: reasonOk, salience: reasonOk, signals: reasonOk }));
    return true;
  }

  // Public config — readable by any authed user. Returns only non-secret UI
  // settings (vision model, session expiry, strip-thinking toggle); safe to
  // expose to regular users so loadSkillsList() and similar non-admin paths
  // don't 403 trying to fetch it.
  if (req.url === '/api/config-public' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      visionProvider: cfg.visionProvider, visionModel: cfg.visionModel,
      sessionExpiryHours: cfg.sessionExpiryHours,
      stripThinkingTags: cfg.stripThinkingTags !== false,
    }));
    return true;
  }

  // Config PATCH
  if (req.url === '/api/config' && req.method === 'PATCH') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const changes = JSON.parse(await readBody(req));
      const allowed = ['sessionExpiryHours', 'visionProvider', 'visionModel', 'stripThinkingTags', 'providerFailover'];
      await modifyConfig(cfg => { for (const key of allowed) { if (key in changes) cfg[key] = changes[key]; } });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }
  if (await tryHandleSpeechRoutes(req, res)) return true;

}

bindProviderSettingsDeps({ validateProviderUrl, listNvidiaGpus, pinServiceGpu });
