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

  // Provider config: GET is readable by any authed user (so non-admin clients
  // can see which providers are enabled and populate the agent model picker);
  // POST stays admin-only since it writes API keys and toggle state.
  if (req.url === '/api/provider-config') {
    const authId = req.method === 'POST'
      ? requirePrivileged(req, res)
      : requireAuth(req, res);
    if (!authId) return true;
    if (req.method === 'GET') {
      const cfg = loadConfig();
      // Dynamic OpenAI-compat provider key flags (openaiKeySet, deepseekKeySet, …)
      const compatFlags = {};
      for (const [prov, { keyField }] of Object.entries(COMPAT_PROVIDERS)) {
        compatFlags[`${prov}KeySet`] = !!cfg[keyField];
      }
      // Self-describing compat provider list. The UI uses this to render the
      // Providers panel + the agent model-picker optgroups so that providers
      // added at runtime via oe-admin's add_provider (saved to the
      // config/user-providers.json overlay) appear in the UI just like the
      // built-in ones — without the UI shipping a hardcoded list of names.
      const userProviderIds = new Set(Object.keys(loadUserProviders() || {}));
      const compatProviders = Object.entries(COMPAT_PROVIDERS).map(([id, p]) => ({
        id,
        displayName: p.displayName || id,
        baseUrl: p.baseUrl,
        keyField: p.keyField,
        keySet: !!cfg[p.keyField],
        enabled: cfg.enabledProviders?.[id] !== false,
        source: userProviderIds.has(id) ? 'user' : 'static',
      }));
      // Probe local Piper service (500 ms cap) so the UI can show "install"
      // vs "running" status without a separate round-trip. ffmpegAvailable
      // gates every TTS provider (we always resample/encode through ffmpeg)
      // so Settings → Providers can disable options when ffmpeg is missing.
      const [piperAvailable, kittenttsAvailable, pocketTtsAvailable, fasterWhisperAvailable, ffmpegAvailable] = await Promise.all([
        probePiperAvailable(cfg),
        probeKittenttsAvailable(cfg),
        probePocketTtsAvailable(cfg),
        probeFasterWhisperAvailable(cfg),
        probeFfmpegAvailable(),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        anthropicKeySet:   !!cfg.anthropicApiKey,
        fireworksKeySet:   !!cfg.fireworksApiKey,
        grokKeySet:        !!cfg.grokApiKey,

        ollamaKeySet:      !!cfg.cortex?.ollamaApiKey,
        lmstudioKeySet:    !!cfg.cortex?.lmstudioApiKey,
        openrouterKeySet:  !!cfg.openrouterApiKey,
        ollamaUrl:    OLLAMA_DEFAULT,
        lmstudioUrl:  cfg.cortex?.lmstudioUrl  ?? LMS_DEFAULT,
        // Secondary, local-only Ollama endpoint. Users with Ollama Cloud for
        // chat still need a local Ollama to host the memory-lane GGUF (Cloud
        // refuses /api/create). Kept separate so they can have both.
        ollamaLocalUrl:    cfg.cortex?.ollamaLocalUrl    ?? '',
        ollamaLocalKeySet: !!cfg.cortex?.ollamaLocalApiKey,
        braveKeySet:  !!cfg.braveApiKey,
        ttsKeySet:    !!cfg.ttsApiKey,
        ttsApiUrl:    cfg.ttsApiUrl   ?? '',
        ttsModel:     cfg.ttsModel    ?? '',
        ttsVoice:     cfg.ttsVoice    ?? '',
        ttsProvider:  cfg.ttsProvider ?? 'openai',
        // sttMode controls where /api/stt sends audio. 'remote' uses
        // sttApiUrl + sttApiKey (the default OpenAI-compat path). 'local'
        // forces 127.0.0.1:5154 (the Faster-Whisper service) regardless of
        // the URL field, so users can keep their remote credentials saved
        // while flipping between local and remote without losing either.
        sttMode:      cfg.sttMode === 'local' ? 'local' : 'remote',
        piperLengthScale: Number.isFinite(cfg.piperLengthScale) ? cfg.piperLengthScale : 1.1,
        piperAvailable,
        kittenttsAvailable,
        pocketTtsAvailable,
        // Installed (unit file present) vs available (service responding). Local
        // TTS installers no longer auto-start; selecting + saving starts the
        // service. The UI keys selectability off *Installed so an installed-but-
        // stopped provider can still be picked (Save then starts it).
        piperInstalled:     fs.existsSync(path.join(os.homedir(), '.config/systemd/user/piper-tts.service')),
        kittenttsInstalled: fs.existsSync(path.join(os.homedir(), '.config/systemd/user/kittentts.service')),
        pocketTtsInstalled: fs.existsSync(path.join(os.homedir(), '.config/systemd/user/pocket-tts.service')),
        fasterWhisperAvailable,
        // Persisted install state — set true at profile-install time. The UI
        // keys "installed vs pick-a-profile" off THIS (not the live probe), so
        // a transient probe miss during cold-start/restart (model load takes up
        // to ~15 s) doesn't wrongly tell the user to reinstall. The probe still
        // drives the "running now" sub-state.
        fasterWhisperInstalled: cfg.integrations?.faster_whisper?.installed === true,
        fasterWhisperProfile: cfg.integrations?.faster_whisper?.profile ?? null,
        // Which GPU the STT service is pinned to (CUDA_VISIBLE_DEVICES index,
        // with CUDA_DEVICE_ORDER=PCI_BUS_ID so it matches nvidia-smi's index).
        // null = no explicit pin (CUDA's default, usually device 0). Only
        // meaningful on the cuda profile + a multi-GPU box. Lets users keep STT
        // off a GPU they want free for e.g. local training.
        fasterWhisperGpuId: Number.isInteger(cfg.integrations?.faster_whisper?.gpuId)
          ? cfg.integrations.faster_whisper.gpuId : null,
        ffmpegAvailable,
        elevenlabsKeySet: !!cfg.elevenlabsApiKey,
        elevenlabsModel:  cfg.elevenlabsModel ?? '',
        // ElevenLabs speaking-pace control (voice_settings.speed). 1.0 = the
        // model's brisk default; <1 slows it. Default 0.85 fixes the turbo
        // model's rushed cadence. UI exposes a slider like Piper's pace.
        elevenlabsSpeed:  Number.isFinite(cfg.elevenlabsSpeed) ? cfg.elevenlabsSpeed : 0.85,
        sttKeySet:    !!cfg.sttApiKey,
        sttApiUrl:    cfg.sttApiUrl   ?? '',
        sttModel:     cfg.sttModel    ?? '',
        enabledProviders: cfg.enabledProviders ?? {},
        msClientIdSet:     !!cfg.msClientId,
        msClientSecretSet: !!cfg.msClientSecret,
        msTenant:          cfg.msTenant ?? '',
        providerFailover: cfg.providerFailover ?? { enabled: false, fallbackProvider: '', fallbackModel: '' },
        ...compatFlags,
        compatProviders,
      }));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        // Validate admin-writable provider URLs *before* the modifyConfig
        // transaction so a bad value 400s loudly instead of half-writing.
        // (POST is already gated to requirePrivileged at the dispatch above.)
        if (body.lmstudioUrl !== undefined) {
          body.lmstudioUrl = validateProviderUrl('lmstudioUrl', body.lmstudioUrl);
        }
        if (body.ollamaLocalUrl !== undefined) {
          body.ollamaLocalUrl = validateProviderUrl('ollamaLocalUrl', body.ollamaLocalUrl);
        }
        // Brave Search API key — validate against Brave before saving so a
        // mistyped or wrong-vendor key fails loudly instead of silently
        // breaking web search later. Empty string is an explicit clear.
        if (body.braveApiKey !== undefined && body.braveApiKey) {
          const probe = await fetch(
            'https://api.search.brave.com/res/v1/web/search?q=ping&count=1',
            { headers: { 'Accept': 'application/json', 'X-Subscription-Token': body.braveApiKey } },
          ).catch(e => ({ ok: false, status: 0, _err: e.message }));
          if (!probe.ok) {
            const detail = probe._err ?? (await probe.text().catch(() => '')).slice(0, 300);
            const hint = probe.status === 401 || probe.status === 403
              ? `That doesn't look like a valid Brave Search key. Get one at api.search.brave.com (Subscriptions → API keys).`
              : `Brave rejected the key (status ${probe.status}). ${detail}`;
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: hint }));
            return true;
          }
        }
        // Validate the STT GPU pin against actually-present GPUs *before* the
        // transaction, so a bad index 400s loudly instead of silently writing a
        // unit that fails to start. null clears the pin.
        if (body.fasterWhisperGpuId !== undefined && body.fasterWhisperGpuId !== null) {
          const g = Number(body.fasterWhisperGpuId);
          const gpus = await listNvidiaGpus();
          if (!Number.isInteger(g) || g < 0 || !gpus.some(d => d.index === g)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `fasterWhisperGpuId must be the index of a detected GPU (have: ${gpus.map(d => d.index).join(', ') || 'none'})` }));
            return true;
          }
        }
        // Set inside the modifyConfig closure when sttMode actually flips, so
        // the systemd side-effect below only runs on a real transition.
        let fwServiceAction = null; // 'stop' (→ remote) | 'start' (→ local)
        // Set when the STT GPU pin changes, applied (unit rewrite + restart)
        // after the config save. undefined = unchanged; null = clear pin.
        let fwGpuPinToApply;
        // Set when the TTS provider is (re)saved. After the save we enforce
        // "one local TTS service at a time": stop the others, start the selected
        // one. undefined = ttsProvider not in this request → leave services alone.
        let ttsProviderToApply;
        await modifyConfig(cfg => {
          if (body.anthropicApiKey)   cfg.anthropicApiKey   = body.anthropicApiKey;
          if (body.fireworksApiKey)   cfg.fireworksApiKey   = body.fireworksApiKey;
          if (body.grokApiKey)        cfg.grokApiKey        = body.grokApiKey;

          if (body.openrouterApiKey)  cfg.openrouterApiKey  = body.openrouterApiKey;
          // Brave Search API key — used by web/deep_research skills and news plugin.
          // Validated above; empty string clears.
          if (body.braveApiKey !== undefined) {
            if (body.braveApiKey) cfg.braveApiKey = body.braveApiKey;
            else delete cfg.braveApiKey;
          }

          // OpenAI-compat provider keys (openaiApiKey, deepseekApiKey, …)
          for (const { keyField } of Object.values(COMPAT_PROVIDERS)) {
            if (body[keyField]) cfg[keyField] = body[keyField];
          }
          cfg.cortex = cfg.cortex ?? {};
          // Cloud Ollama endpoint is fixed (OLLAMA_DEFAULT) and not user-editable;
          // ignore any ollamaUrl the client sends and keep the canonical value.
          cfg.cortex.ollamaUrl = OLLAMA_DEFAULT;
          if (body.lmstudioUrl !== undefined) {
            const prev = cfg.cortex.lmstudioUrl ?? '';
            if (body.lmstudioUrl !== prev) log.warn('config', 'lmstudioUrl changed', { from: prev, to: body.lmstudioUrl, by: authId });
            cfg.cortex.lmstudioUrl = body.lmstudioUrl;
          }
          if (body.ollamaApiKey)                 cfg.cortex.ollamaApiKey   = body.ollamaApiKey;
          if (body.lmstudioApiKey)               cfg.cortex.lmstudioApiKey = body.lmstudioApiKey;
          if (body.ollamaLocalUrl !== undefined) {
            const prev = cfg.cortex.ollamaLocalUrl ?? '';
            if (body.ollamaLocalUrl !== prev) log.warn('config', 'ollamaLocalUrl changed', { from: prev, to: body.ollamaLocalUrl, by: authId });
            cfg.cortex.ollamaLocalUrl = body.ollamaLocalUrl;
          }
          if (body.ollamaLocalApiKey)               cfg.cortex.ollamaLocalApiKey = body.ollamaLocalApiKey;
          if (body.ttsApiKey)                      cfg.ttsApiKey   = body.ttsApiKey;
          if (body.ttsApiUrl   !== undefined)      cfg.ttsApiUrl   = body.ttsApiUrl;
          if (body.ttsModel    !== undefined)      cfg.ttsModel    = body.ttsModel;
          if (body.ttsVoice    !== undefined)      cfg.ttsVoice    = body.ttsVoice;
          if (body.piperLengthScale !== undefined) {
            // Clamp to [0.7, 1.6]: below 0.7 sounds chipmunked, above 1.6
            // sounds drunk. UI slider exposes 0.8-1.5 inside this safe band.
            const n = Number(body.piperLengthScale);
            if (Number.isFinite(n) && n >= 0.7 && n <= 1.6) cfg.piperLengthScale = n;
          }
          if (body.ttsProvider !== undefined) {
            const allowed = ['openai', 'piper', 'kittentts', 'elevenlabs', 'pocket-tts'];
            if (allowed.includes(body.ttsProvider)) {
              cfg.ttsProvider = body.ttsProvider;
              // Enforce one-local-TTS-at-a-time after the save (below).
              ttsProviderToApply = body.ttsProvider;
            }
          }
          if (body.elevenlabsApiKey)               cfg.elevenlabsApiKey = body.elevenlabsApiKey;
          if (body.elevenlabsModel !== undefined)  cfg.elevenlabsModel  = body.elevenlabsModel;
          if (body.elevenlabsSpeed !== undefined) {
            const n = Number(body.elevenlabsSpeed);
            if (Number.isFinite(n) && n >= 0.7 && n <= 1.2) cfg.elevenlabsSpeed = n;
          }
          if (body.sttApiKey)                      cfg.sttApiKey   = body.sttApiKey;
          if (body.sttApiUrl   !== undefined)      cfg.sttApiUrl   = body.sttApiUrl;
          if (body.sttModel    !== undefined)      cfg.sttModel    = body.sttModel;
          if (body.sttMode === 'remote' || body.sttMode === 'local') {
            // Stop the local Faster-Whisper systemd unit when switching to a
            // remote STT API (it'd otherwise keep holding GPU/VRAM for nothing);
            // restart it when switching back to local. Only when it's actually
            // installed — we stop, never uninstall, so the swap back is instant.
            const prevMode = cfg.sttMode === 'local' ? 'local' : 'remote';
            if (body.sttMode !== prevMode && cfg.integrations?.faster_whisper?.installed === true) {
              fwServiceAction = body.sttMode === 'remote' ? 'stop' : 'start';
            }
            cfg.sttMode = body.sttMode;
          }
          // Pin (or clear) which GPU the local STT service runs on. Accepts a
          // non-negative integer (GPU index) or null (clear). Only applied when
          // faster-whisper is installed; persisted either way so a later install
          // honors it. Validated against detected GPUs above.
          if (body.fasterWhisperGpuId !== undefined) {
            const g = body.fasterWhisperGpuId;
            const val = (g === null) ? null : Number(g);
            cfg.integrations ??= {};
            cfg.integrations.faster_whisper ??= {};
            if (val === null) delete cfg.integrations.faster_whisper.gpuId;
            else cfg.integrations.faster_whisper.gpuId = val;
            if (cfg.integrations.faster_whisper.installed === true) fwGpuPinToApply = val;
          }
          if (body.enabledProviders !== undefined) cfg.enabledProviders = { ...(cfg.enabledProviders ?? {}), ...body.enabledProviders };
          if (body.providerFailover !== undefined) cfg.providerFailover = body.providerFailover;
          if (body.clearMicrosoftCreds) { delete cfg.msClientId; delete cfg.msClientSecret; delete cfg.msTenant; }
          else {
            if (body.msClientId)             cfg.msClientId     = body.msClientId;
            if (body.msClientSecret)         cfg.msClientSecret = body.msClientSecret;
            if (body.msTenant !== undefined) cfg.msTenant       = body.msTenant;
          }
        });
        // Apply the Faster-Whisper service transition AFTER the config save.
        // `--now` does stop+disable / start+enable in one call, so the choice
        // also survives reboots (no point auto-starting whisper on boot while
        // the user is on a remote API). Non-fatal: log on failure; never block
        // the config save on a systemd hiccup.
        if (fwServiceAction) {
          const verb = fwServiceAction === 'stop' ? 'disable' : 'enable';
          const child = spawn('systemctl', ['--user', verb, '--now', 'faster-whisper.service'], {
            env: { ...process.env, HOME: os.homedir() },
            stdio: 'ignore',
          });
          child.on('error', (e) => log.warn('config', 'faster-whisper service control failed', { action: fwServiceAction, error: e.message }));
          child.on('exit', (code) => {
            if (code === 0) { invalidateVoiceDepsCache(); log.info('config', `faster-whisper ${fwServiceAction === 'stop' ? 'stopped (switched to remote STT)' : 'started (switched to local STT)'}`); }
            else log.warn('config', 'faster-whisper service control non-zero exit', { action: fwServiceAction, code });
          });
        }
        // Apply the GPU pin (rewrite unit + restart if running). Skipped when we
        // also just toggled the service on/off above — that path already wrote
        // CUDA env via the installer/enable and a double restart is pointless.
        if (fwGpuPinToApply !== undefined && !fwServiceAction) {
          pinServiceGpu('faster-whisper.service', fwGpuPinToApply)
            .then(r => { if (!r.ok) log.warn('config', 'STT GPU pin failed', r); })
            .catch(e => log.warn('config', 'STT GPU pin error', { error: e.message }));
        }
        // One-local-TTS-at-a-time. Installers no longer auto-start their service;
        // selecting + saving a provider is what starts it. Here we stop+disable
        // every local TTS unit except the selected, then start+enable the
        // selected one (if it's a local service) and wait for it to accept
        // requests so the post-save UI reflects "running". Remote providers
        // (openai, elevenlabs) just stop all local TTS. STT is untouched.
        if (ttsProviderToApply !== undefined) {
          const TTS_UNITS = {
            piper:        { unit: 'piper-tts.service', port: 5151 },
            kittentts:    { unit: 'kittentts.service', port: 5153 },
            'pocket-tts': { unit: 'pocket-tts.service', port: 5155 },
          };
          const sel = TTS_UNITS[ttsProviderToApply] || null;
          const sysctl = (args) => new Promise(resolve => {
            const c = spawn('systemctl', ['--user', ...args], { env: { ...process.env, HOME: os.homedir() }, stdio: 'ignore' });
            c.on('error', () => resolve(-1));
            c.on('exit', code => resolve(code ?? -1));
          });
          try {
            for (const { unit } of Object.values(TTS_UNITS)) {
              if (!sel || unit !== sel.unit) await sysctl(['disable', '--now', unit]);
            }
            if (sel) {
              await sysctl(['enable', '--now', sel.unit]);
              for (let i = 0; i < 12; i++) { // up to ~6s for model load
                try {
                  const r = await fetch(`http://127.0.0.1:${sel.port}/`, { signal: AbortSignal.timeout(500) });
                  if (r.status >= 200 && r.status < 600) break;
                } catch {}
                await new Promise(r => setTimeout(r, 500));
              }
            }
            invalidateVoiceDepsCache();
            log.info('config', `TTS provider → ${ttsProviderToApply}${sel ? ` (started ${sel.unit}, others stopped)` : ' (remote — local TTS stopped)'}`);
          } catch (e) {
            log.warn('config', 'TTS service switch failed', { provider: ttsProviderToApply, error: e.message });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return true;
    }
  }

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
