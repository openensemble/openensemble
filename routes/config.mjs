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
  pinAmbientMp3,
} from './devices.mjs';
import { ambientFilePath } from '../lib/routines.mjs';
import { supportsVision } from '../lib/model-capabilities.mjs';
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

// Live ffmpeg processes for ambient streams keyed by marker. Lets the
// /api/tts handler reattach a new HTTP response to an existing ffmpeg
// when the device reconnects after a wake (no cold ffmpeg restart, no
// PassThrough warmup, no decode-error burst on resume). Entries are
// removed on explicit stop (forceKill) or grace timeout.
//   marker → { ff, ff_buf, killTimer, forceKill }
const _ambientStreams = new Map();
const STREAM_GRACE_MS = 10_000;

// Start the grace timer when the current ambient response closes. ffmpeg
// keeps encoding into ff_buf until the buffer fills (then it back-pressures
// and pauses). If the device re-requests this marker within the window,
// the /api/tts handler clears the timer and pipes ff_buf to the new res.
function startAmbientGrace(streamEntry, marker, res) {
  if (streamEntry.killTimer) return; // already in grace from a prior close
  try { streamEntry.ff_buf.unpipe(res); } catch {}
  streamEntry.killTimer = setTimeout(() => {
    if (streamEntry.killTimer) streamEntry.forceKill?.();
    console.log(`[tts] ambient stream EXPIRED after ${STREAM_GRACE_MS / 1000}s grace marker=${marker}`);
  }, STREAM_GRACE_MS);
  console.log(`[tts] ambient stream PAUSED (grace ${STREAM_GRACE_MS / 1000}s) marker=${marker}`);
}

// KittenTTS nano-0.2 ships 8 preset voices (no cloning). Listed here so the
// UI dropdown and /api/tts/info can surface them without round-tripping to
// the kittentts subprocess.
const KITTENTTS_VOICES = [
  'expr-voice-2-m', 'expr-voice-2-f',
  'expr-voice-3-m', 'expr-voice-3-f',
  'expr-voice-4-m', 'expr-voice-4-f',
  'expr-voice-5-m', 'expr-voice-5-f',
];
const KITTENTTS_DEFAULT_VOICE = 'expr-voice-2-f';

// Piper voice catalog — what the Settings/Providers UI offers users to
// download once the Piper service is installed. Each entry is downloadable
// independently (POST /api/provider-config/install-piper-voice). The
// multivoice server in scripts/piper-multivoice-server.py picks up new files
// automatically (no service restart needed). `source: 'openensemble'` voices
// live in our own HF repo; everything else falls back to rhasspy/piper-voices.
const PIPER_VOICE_CATALOG = [
  { id: 'en_AU-OE_custom-medium',      label: 'OE Custom AU (Australian female)',    lang: 'en_AU', gender: 'female', quality: 'medium', size_mb: 61,  multi_speaker: false, source: 'openensemble' },
  { id: 'en_US-amy-medium',            label: 'Amy (American female)',                lang: 'en_US', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_US-lessac-medium',         label: 'Lessac (American female)',             lang: 'en_US', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_US-ryan-medium',           label: 'Ryan (American male)',                 lang: 'en_US', gender: 'male',   quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_US-libritts_r-medium',     label: 'LibriTTS-R (904-speaker multi)',       lang: 'en_US', gender: 'mixed',  quality: 'medium', size_mb: 75,  multi_speaker: true,  source: 'rhasspy' },
  { id: 'en_GB-alba-medium',           label: 'Alba (Scottish female)',               lang: 'en_GB', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_GB-jenny_dioco-medium',    label: 'Jenny (British RP female)',            lang: 'en_GB', gender: 'female', quality: 'medium', size_mb: 63,  multi_speaker: false, source: 'rhasspy' },
  { id: 'en_GB-cori-high',             label: 'Cori (British female, high quality)',  lang: 'en_GB', gender: 'female', quality: 'high',   size_mb: 109, multi_speaker: false, source: 'rhasspy' },
];

// Derive the HF base URL for a voice id (mirrors install-piper.sh URL logic).
function piperVoiceUrlBase(voiceId) {
  const repo = voiceId.startsWith('en_AU-OE_custom-')
    ? 'https://huggingface.co/openensemble/piper-voices/resolve/main'
    : 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
  // Convention: <lang_REGION>-<name>-<quality> → /<lang>/<lang_REGION>/<name>/<quality>/
  const [langRegion, ...rest] = voiceId.split('-');
  const quality = rest[rest.length - 1];
  const name = rest.slice(0, -1).join('-');
  const lang = langRegion.split('_')[0];
  return `${repo}/${lang}/${langRegion}/${name}/${quality}`;
}
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

// ChatGPT backend (OAuth) — the Codex /responses endpoint accepts these model
// slugs against a ChatGPT Plus/Pro account. There's no /models endpoint, and
// the backend rejects every -pro/-codex/-mini/-nano variant of 5.5/5.3 plus
// the entire o-series and 4o/4.1 families with: "The '<slug>' model is not
// supported when using Codex with a ChatGPT account." Verified by probing
// /responses with each slug (scripts/probe-oauth-models.mjs, 2026-04-25).
const OPENAI_OAUTH_STATIC_MODELS = [
  { id: 'gpt-5.5',       name: 'GPT-5.5' },
  { id: 'gpt-5.4',       name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini',  name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'gpt-5.2',       name: 'GPT-5.2' },
];

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

  // POST /api/provider-config/install-piper
  // Admin-only. Spawns scripts/install-piper.sh, streams its stdout/stderr
  // to the client as Server-Sent Events so the UI can show live progress
  // ("Downloading model 40%…"). The same script is invoked non-interactively
  // by install.sh on fresh install, so the install path is identical for
  // CLI-bootstrapped users and post-install "Install Piper" UI clicks.
  if (req.url === '/api/provider-config/install-piper' && req.method === 'POST') {
    const authId = requirePrivileged(req, res);
    if (!authId) return true;

    // Resolve the install script path relative to this file (works whether
    // OE is run from /opt, ~/.openensemble, or a dev checkout).
    const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                    '..', 'scripts', 'install-piper.sh');
    if (!fs.existsSync(scriptPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `install-piper.sh not found at ${scriptPath}` }));
      return true;
    }

    // Optional body: { voice: "<id from catalog>" } picks which voice is
    // installed as the default. Empty body = libritts_r (legacy default,
    // matches the bare-install path from install.sh).
    let initialVoice = '';
    try {
      const raw = await readBody(req);
      if (raw) {
        const body = JSON.parse(raw);
        if (body && typeof body.voice === 'string' && body.voice) {
          if (!PIPER_VOICE_CATALOG.find(v => v.id === body.voice)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `unknown voice id: ${body.voice}` }));
            return true;
          }
          initialVoice = body.voice;
        }
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `bad request body: ${e.message}` }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const child = spawn('/usr/bin/env', ['bash', scriptPath], {
      // Run as the OE process owner so systemctl --user targets the right
      // user manager (whoever runs OE is the user Piper installs for).
      env: {
        ...process.env,
        HOME: os.homedir(),
        ...(initialVoice ? { PIPER_VOICE: initialVoice } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    send('start', { script: scriptPath });

    const onLine = (kind) => (chunk) => {
      // SSE doesn't tolerate raw newlines mid-event, so split and emit one
      // event per line. Empty trailing line from the final chunk is dropped.
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line) send('log', { kind, line });
      }
    };
    child.stdout.on('data', onLine('stdout'));
    child.stderr.on('data', onLine('stderr'));

    child.on('exit', (code, signal) => {
      // Successful install → drop the 60 s availability cache so the
      // next /api/provider-config GET reflects "running" immediately
      // instead of waiting up to a minute.
      if (code === 0) invalidateVoiceDepsCache();
      send('done', { code, signal: signal ?? null, ok: code === 0 });
      try { res.end(); } catch {}
    });
    child.on('error', (err) => {
      send('done', { code: -1, error: err.message, ok: false });
      try { res.end(); } catch {}
    });

    // Best-effort: kill the install if the client disconnects mid-stream.
    // Idempotent re-run from the UI picks up wherever the previous run left
    // off (venv exists / pip cached / model already downloaded).
    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return true;
  }

  // POST /api/provider-config/uninstall-piper
  // POST /api/provider-config/uninstall-kittentts
  // Admin-only. Spawn the matching uninstall-*.sh, wait for completion,
  // return a JSON envelope with the captured stdout. Plain JSON (no SSE)
  // because uninstall runs in <1 s — streaming would be theater. The
  // voice-deps cache is invalidated on success so the next
  // /api/provider-config GET reflects the change immediately.
  {
    const uninstallMatch = req.url.match(/^\/api\/provider-config\/uninstall-(piper|kittentts|faster-whisper|pocket-tts)$/);
    if (uninstallMatch && req.method === 'POST') {
      const authId = requirePrivileged(req, res);
      if (!authId) return true;
      const which = uninstallMatch[1];
      const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                      '..', 'scripts', `uninstall-${which}.sh`);
      if (!fs.existsSync(scriptPath)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `uninstall-${which}.sh not found at ${scriptPath}` }));
        return true;
      }
      const child = spawn('/usr/bin/env', ['bash', scriptPath], {
        env: { ...process.env, HOME: os.homedir() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks = [];
      child.stdout.on('data', c => chunks.push(c));
      child.stderr.on('data', c => chunks.push(c));
      child.on('exit', (code) => {
        const ok = code === 0;
        if (ok) invalidateVoiceDepsCache();
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, code, output: Buffer.concat(chunks).toString('utf8') }));
      });
      child.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
      return true;
    }
  }

  // POST /api/provider-config/install-faster-whisper  body: { profile: "cpu" | "cuda" }
  // Same SSE shape as install-piper/install-kittentts. profile picks the
  // installer's FW_DEVICE env: cpu = distil-large-v3 int8, cuda =
  // large-v3-turbo float16 (needs NVIDIA driver — the script bails early
  // if nvidia-smi isn't present so the failure is visible in the SSE log).
  if (req.url === '/api/provider-config/install-faster-whisper' && req.method === 'POST') {
    const authId = requirePrivileged(req, res);
    if (!authId) return true;

    const cfg = loadConfig();
    const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                    '..', 'scripts', 'install-faster-whisper.sh');
    if (!fs.existsSync(scriptPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `install-faster-whisper.sh not found at ${scriptPath}` }));
      return true;
    }

    let profile = 'cpu';
    try {
      const raw = await readBody(req);
      if (raw) {
        const body = JSON.parse(raw);
        if (body?.profile === 'cuda' || body?.profile === 'cpu') profile = body.profile;
        else if (body?.profile != null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `profile must be "cpu" or "cuda", got ${body.profile}` }));
          return true;
        }
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `bad request body: ${e.message}` }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const child = spawn('/usr/bin/env', ['bash', scriptPath], {
      env: {
        ...process.env, HOME: os.homedir(), FW_DEVICE: profile,
        // Honor a previously-chosen GPU pin so reinstalling/switching profiles
        // doesn't silently move STT back onto the default GPU.
        ...(profile === 'cuda' && Number.isInteger(cfg.integrations?.faster_whisper?.gpuId)
          ? { FW_GPU_ID: String(cfg.integrations.faster_whisper.gpuId) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };
    send('start', { script: scriptPath, profile });

    const onLine = (kind) => (chunk) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line) send('log', { kind, line });
      }
    };
    child.stdout.on('data', onLine('stdout'));
    child.stderr.on('data', onLine('stderr'));

    child.on('exit', (code, signal) => {
      if (code === 0) {
        invalidateVoiceDepsCache();
        // Persist which profile is installed so /api/provider-config can
        // surface it in the UI without re-probing the systemd unit file.
        modifyConfig(cfg => {
          cfg.integrations ??= {};
          cfg.integrations.faster_whisper ??= {};
          cfg.integrations.faster_whisper.installed = true;
          cfg.integrations.faster_whisper.profile = profile;
        });
      }
      send('done', { code, signal: signal ?? null, ok: code === 0 });
      try { res.end(); } catch {}
    });
    child.on('error', (err) => {
      send('done', { code: -1, error: err.message, ok: false });
      try { res.end(); } catch {}
    });
    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return true;
  }

  // POST /api/provider-config/install-kittentts
  // Same shape as install-piper: SSE-stream the install script's output.
  // KittenTTS is the no-GPU / no-API-key fallback tier; install is CPU-only,
  // ~50 MB, and finishes in under a minute on first run.
  // POST /api/provider-config/install-pocket-tts
  // Same SSE shape as install-kittentts. Pocket TTS (Kyutai 100M CPU TTS,
  // zero-shot voice cloning). Weights are mirrored non-gated (CC-BY-4.0) at
  // openensemble/pocket-tts so users never hit the upstream HF access gate.
  if (req.url === '/api/provider-config/install-pocket-tts' && req.method === 'POST') {
    const authId = requirePrivileged(req, res);
    if (!authId) return true;

    const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                    '..', 'scripts', 'install-pocket-tts.sh');
    if (!fs.existsSync(scriptPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `install-pocket-tts.sh not found at ${scriptPath}` }));
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const childP = spawn('/usr/bin/env', ['bash', scriptPath], {
      env: { ...process.env, HOME: os.homedir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sendP = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };
    sendP('start', { script: scriptPath });
    const onLineP = (kind) => (chunk) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) { if (line) sendP('log', { kind, line }); }
    };
    childP.stdout.on('data', onLineP('stdout'));
    childP.stderr.on('data', onLineP('stderr'));
    childP.on('exit', (code, signal) => {
      if (code === 0) invalidateVoiceDepsCache();
      sendP('done', { code, signal: signal ?? null, ok: code === 0 });
      try { res.end(); } catch {}
    });
    childP.on('error', (err) => {
      sendP('done', { code: -1, error: err.message, ok: false });
      try { res.end(); } catch {}
    });
    req.on('close', () => { try { childP.kill('SIGTERM'); } catch {} });
    return true;
  }

  if (req.url === '/api/provider-config/install-kittentts' && req.method === 'POST') {
    const authId = requirePrivileged(req, res);
    if (!authId) return true;

    const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                    '..', 'scripts', 'install-kittentts.sh');
    if (!fs.existsSync(scriptPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `install-kittentts.sh not found at ${scriptPath}` }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const child = spawn('/usr/bin/env', ['bash', scriptPath], {
      env: { ...process.env, HOME: os.homedir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    send('start', { script: scriptPath });

    const onLine = (kind) => (chunk) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line) send('log', { kind, line });
      }
    };
    child.stdout.on('data', onLine('stdout'));
    child.stderr.on('data', onLine('stderr'));

    child.on('exit', (code, signal) => {
      if (code === 0) invalidateVoiceDepsCache();
      send('done', { code, signal: signal ?? null, ok: code === 0 });
      try { res.end(); } catch {}
    });
    child.on('error', (err) => {
      send('done', { code: -1, error: err.message, ok: false });
      try { res.end(); } catch {}
    });

    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return true;
  }


  // List available chat models from xAI Grok (authoritative — no hardcoding).
  // Image/video models live on separate endpoints and are handled client-side as static slugs.
  if (req.url === '/api/grok-models' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (cfg.enabledProviders?.grok === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    const key = cfg.grokApiKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY;
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    try {
      const r = await fetch(`${GROK_BASE}/language-models`, {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      // Fall back to /models if /language-models isn't available on the account
      const resp = r.ok ? r : await fetch(`${GROK_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`xAI API ${resp.status}`);
      const data = await resp.json();
      const list = data.models ?? data.data ?? [];
      const models = list
        .map(m => ({ id: m.id ?? m.name, displayName: m.id ?? m.name, supportsVision: supportsVision('grok', m.id ?? m.name) }))
        .filter(m => m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // List available chat models from Anthropic (authoritative — no hardcoding)
  if (req.url === '/api/anthropic-models' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (cfg.enabledProviders?.anthropic === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    try {
      let allModels = [], afterId = null, pagesFetched = 0;
      do {
        const url = `https://api.anthropic.com/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
        const r = await fetch(url, {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
        const data = await r.json();
        allModels = allModels.concat(data.data ?? []);
        afterId = data.has_more ? data.last_id : null;
        pagesFetched++;
        if (pagesFetched > 10) break;
      } while (afterId);

      const models = allModels
        .map(m => ({
          id: m.id,
          displayName: m.display_name ?? m.id,
          createdAt: m.created_at ?? null,
          supportsVision: supportsVision('anthropic', m.id),
        }))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // List available Fireworks image generation models
  if (req.url === '/api/fireworks-models' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (cfg.enabledProviders?.fireworks === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    const key = cfg.fireworksApiKey || process.env.FIREWORKS_API_KEY;
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    try {
      let allModels = [], pageToken = null, pagesFetched = 0;
      do {
        const url = `https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`Fireworks API ${r.status}`);
        const data = await r.json();
        allModels = allModels.concat(data.models ?? []);
        pageToken = data.nextPageToken ?? null;
        pagesFetched++;
        // Safety cap in case the upstream returns a non-terminating cursor.
        if (pagesFetched > 20) break;
      } while (pageToken);

      // FLUMINA = Fireworks-native image models (Flux). Image-generation, not vision input.
      const fluminaModels = allModels
        .filter(m => m.kind?.startsWith('FLUMINA'))
        .map(m => ({ id: (m.name ?? '').split('/').pop(), displayName: m.displayName || m.name, supportsVision: false }));

      // SD/Playground models exist in the web UI but aren't returned by the listing API
      // They use a different inference endpoint (/inference/v1/image_generation/...)
      const legacyImageModels = [
        { id: 'stable-diffusion-xl-1024-v1-0',    displayName: 'Stable Diffusion XL',                supportsVision: false },
        { id: 'playground-v2-1024px-aesthetic',    displayName: 'Playground v2 1024',                supportsVision: false },
        { id: 'playground-v2-5-1024px-aesthetic',  displayName: 'Playground v2.5 1024',              supportsVision: false },
        { id: 'SSD-1B',                            displayName: 'Segmind Stable Diffusion 1B',       supportsVision: false },
        { id: 'japanese-stable-diffusion-xl',      displayName: 'Japanese Stable Diffusion XL',      supportsVision: false },
      ];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...fluminaModels, ...legacyImageModels]));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // List available chat models from OpenRouter
  if (req.url === '/api/openrouter-models' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (cfg.enabledProviders?.openrouter === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    const key = cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`OpenRouter API ${r.status}`);
      const data = await r.json();
      const models = (data.data ?? [])
        .filter(m => m.architecture?.modality?.includes('text'))
        .map(m => ({
          id:          m.id,
          name:        m.name ?? m.id,
          contextLen:  m.context_length ?? null,
          inputPrice:  m.pricing?.prompt  != null ? parseFloat(m.pricing.prompt)  * 1_000_000 : null,
          outputPrice: m.pricing?.completion != null ? parseFloat(m.pricing.completion) * 1_000_000 : null,
          // OpenRouter exposes input modality on each model — image input means vision-capable.
          supportsVision: Array.isArray(m.architecture?.input_modalities)
            ? m.architecture.input_modalities.includes('image')
            : supportsVision('openrouter', m.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Cache pricing in config.json so estimateCost can use it without an API call
      const pricing = {};
      for (const m of models) {
        if (m.inputPrice != null || m.outputPrice != null) {
          pricing[m.id] = { input: m.inputPrice ?? 0, output: m.outputPrice ?? 0 };
        }
      }
      await modifyConfig(cfg => { cfg.openrouterPricing = pricing; });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // Generic per-provider model listing for OpenAI-compat providers.
  //   GET /api/provider-models/:provider
  // Returns [{ id, name, contextLen?, created? }] sorted by name.
  if (req.url?.startsWith('/api/provider-models/') && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const prov = req.url.slice('/api/provider-models/'.length).split('?')[0];
    // OAuth-backed ChatGPT provider: no key field, no /models endpoint — static list.
    if (prov === 'openai-oauth') {
      const annotated = OPENAI_OAUTH_STATIC_MODELS.map(m => ({ ...m, supportsVision: supportsVision('openai-oauth', m.id ?? m.name) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(annotated));
      return true;
    }
    const provCfg = COMPAT_PROVIDERS[prov];
    if (!provCfg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown provider: ${prov}` }));
      return true;
    }
    const cfg = loadConfig();
    if (cfg.enabledProviders?.[prov] === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    const key = cfg[provCfg.keyField] || process.env[provCfg.keyField.replace(/ApiKey$/, '').toUpperCase() + '_API_KEY'];
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return true;
    }
    // Perplexity has no /models endpoint — return the hardcoded Sonar family.
    if (prov === 'perplexity') {
      const annotated = PERPLEXITY_STATIC_MODELS.map(m => ({ ...m, supportsVision: supportsVision('perplexity', m.id ?? m.name) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(annotated));
      return true;
    }
    try {
      const url = `${provCfg.baseUrl.replace(/\/$/, '')}/models`;
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`${provCfg.displayName} API ${r.status}: ${await r.text()}`);
      const data = await r.json();
      // Handle both OpenAI shape ({ data: [...] }) and alternate ({ models: [...] })
      const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const models = raw.map(m => ({
        id:             m.id ?? m.name,
        name:           m.id ?? m.name,
        contextLen:     m.context_length ?? m.context_window ?? null,
        created:        m.created ?? null,
        supportsVision: supportsVision(prov, m.id ?? m.name, { capabilities: m.capabilities }),
      })).filter(m => m.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // List available models from all providers
  if (req.url === '/api/models') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const configuredOllamaBase = (cfg.cortex?.ollamaUrl ?? OLLAMA_DEFAULT).replace(/\/api\/?$/, '');
    const ollamaKey  = cfg.cortex?.ollamaApiKey ?? null;
    const ollamaHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};
    const lmsBase    = cfg.cortex?.lmstudioUrl ?? LMS_DEFAULT;

    // Always probe localhost for local Ollama, even when cortex.ollamaUrl points
    // at the cloud — so users running both see both sets. Skip localhost if the
    // configured URL already *is* localhost (avoid duplicate fetch).
    const LOCAL = 'http://localhost:11434';
    const probeLocal = !configuredOllamaBase.startsWith('http://localhost') && !configuredOllamaBase.startsWith('http://127.0.0.1');
    const isCloudUrl = /ollama\.com/i.test(configuredOllamaBase);

    // Classify an Ollama model as local or cloud. Local daemon proxies cloud
    // models via a `:cloud` tag or `remote_host` field — those are still cloud.
    const classifyOllama = (m, sourceIsCloud) => {
      if (sourceIsCloud) return 'cloud';
      if (m.remote_host) return 'cloud';
      if (typeof m.name === 'string' && m.name.endsWith(':cloud')) return 'cloud';
      return 'local';
    };

    const fetchOllamaTags = (base, headers, sourceIsCloud) =>
      fetch(`${base}/api/tags`, { headers, signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then(d => (d.models ?? []).map(m => ({
          name: m.name, provider: 'ollama', tier: classifyOllama(m, sourceIsCloud),
          supportsVision: supportsVision('ollama', m.name),
        })));

    const ollamaFetches = [];
    // Configured URL (may be local OR cloud)
    ollamaFetches.push(fetchOllamaTags(configuredOllamaBase, ollamaHeaders, isCloudUrl));
    // Localhost probe (only when configured URL wasn't already localhost)
    if (probeLocal) ollamaFetches.push(fetchOllamaTags(LOCAL, {}, false));

    const [lmRes, ...ollamaResults] = await Promise.allSettled([
      fetch(`${lmsBase}/api/v1/models`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())
        .then(d => (d.models ?? [])
          .filter(m => m.type === 'llm' || !m.type)
          .map(m => ({
            name:        m.key ?? m.id,
            provider:    'lmstudio',
            displayName: m.display_name ?? m.key,
            contextLen:  m.max_context_length,
            loaded:      (m.loaded_instances?.length ?? 0) > 0,
            capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
            supportsVision: supportsVision('lmstudio', m.key ?? m.id, { capabilities: m.capabilities }),
          }))
        ),
      ...ollamaFetches,
    ]);

    // Merge Ollama results and dedupe on canonical-name + tier. The cloud catalog
    // exposes the same model under both a bare name (`glm-4.7`, `cogito-2.1:671b`)
    // and a suffixed alias (`glm-4.7:cloud`, `cogito-2.1:671b-cloud`); without
    // canonicalization the picker shows duplicates. Local-tier entries skip the
    // strip so a real `something-cloud` local pull (rare) wouldn't collapse.
    const canonicalCloudName = (name) => {
      if (typeof name !== 'string') return name;
      if (name.endsWith(':cloud')) return name.slice(0, -':cloud'.length);
      if (name.endsWith('-cloud')) return name.slice(0, -'-cloud'.length);
      return name;
    };
    const ollamaSeen = new Set();
    const ollamaMerged = [];
    for (const r of ollamaResults) {
      if (r.status !== 'fulfilled') continue;
      for (const m of r.value) {
        const canonical = m.tier === 'cloud' ? canonicalCloudName(m.name) : m.name;
        const key = `${canonical}::${m.tier}`;
        if (ollamaSeen.has(key)) continue;
        ollamaSeen.add(key);
        // Prefer the bare canonical form so the picker shows e.g. `glm-4.7`
        // instead of `glm-4.7:cloud` even if the suffixed variant arrived first.
        ollamaMerged.push(m.tier === 'cloud' && canonical !== m.name ? { ...m, name: canonical } : m);
      }
    }

    // Bundled reason model filename — imported lazily so config routes don't
    // eagerly load node-llama-cpp on machines where it's not installed yet.
    let builtinReasonId = 'openensemble-reason-v3.q8_0.gguf';
    try {
      const { getBuiltinReasonModelId } = await import('../memory/builtin-reason.mjs');
      builtinReasonId = getBuiltinReasonModelId();
    } catch { /* fall back to default name */ }

    const models = [
      // Bundled models — always available, no external runtime required.
      { name: 'nomic-embed-text-v1', provider: 'builtin', displayName: 'Nomic Embed (built-in)', tier: 'bundled', supportsVision: false },
      { name: builtinReasonId, provider: 'builtin', displayName: 'OpenEnsemble Reason v1 (built-in)', tier: 'bundled', supportsVision: false },
      ...ollamaMerged,
      ...(lmRes.status === 'fulfilled' ? lmRes.value : []),
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(models));
    return true;
  }

  // Cortex config
  if (req.url === '/api/cortex-config') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    if (req.method === 'GET') {
      const cfg = loadConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cfg.cortex ?? {}));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const update = JSON.parse(await readBody(req));
        await modifyConfig(cfg => {
          cfg.cortex = cfg.cortex ?? {};
          for (const [k, v] of Object.entries(update)) {
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

  // Lightweight read-only info about the configured TTS provider. Used by
  // the Voice devices drawer to render the right voice-picker control
  // (numeric speaker ID for piper, named voice for openai). No secrets
  // returned; cheaper than re-fetching the full /api/config blob.
  if (req.url === '/api/tts/info' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const ALLOWED = ['openai', 'piper', 'kittentts', 'elevenlabs', 'pocket-tts'];
    const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
    // Runtime availability snapshot — lets the devices drawer show a
    // banner when the configured provider can't actually fulfill TTS
    // (missing ffmpeg, Piper service down, key cleared, etc.) instead
    // of letting the device hang in THINKING on the next wake.
    const available = await getTtsAvailability(cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      provider,
      defaultVoice: cfg.ttsVoice ?? null,
      available,
      ...(provider === 'piper' ? { speakerCount: 904 } : {}),
      ...(provider === 'kittentts' ? { voices: KITTENTTS_VOICES } : {}),
      ...(provider === 'elevenlabs' ? { keySet: !!cfg.elevenlabsApiKey } : {}),
    }));
    return true;
  }

  // List ElevenLabs voices (pre-made + user-cloned). Proxies the EL
  // /v1/voices endpoint so the API key stays server-side; UI populates
  // its per-slot dropdown from the response. Cached in-memory for 60 s
  // to avoid hammering EL on every drawer reopen.
  if (req.url === '/api/tts/elevenlabs/voices' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (!cfg.elevenlabsApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
      return true;
    }
    try {
      const elRes = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': cfg.elevenlabsApiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!elRes.ok) throw new Error(`ElevenLabs returned ${elRes.status}`);
      const data = await elRes.json();
      const voices = (data.voices || []).map(v => ({
        id: v.voice_id,
        label: v.name,
        category: v.category,  // 'premade' / 'cloned' / 'generated' / 'professional'
        description: v.description ?? null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // GET /api/tts/piper/catalog
  // Static list of Piper voices the UI offers for download. Anyone authed
  // can read it; the install action below is admin-only.
  if (req.url === '/api/tts/piper/catalog' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ voices: PIPER_VOICE_CATALOG }));
    return true;
  }

  // GET /api/tts/piper/voices
  // Proxy to the multivoice server's /voices endpoint — list what's *installed*
  // on this box right now. Voice Devices uses this to populate slot dropdowns.
  if (req.url === '/api/tts/piper/voices' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const base = (cfg.piperUrl || 'http://127.0.0.1:5151/').replace(/\/+$/, '');
    try {
      const pr = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(3000) });
      if (!pr.ok) throw new Error(`piper service returned ${pr.status}`);
      const installed = await pr.json();
      // Enrich each installed entry with catalog label/gender/etc when known.
      const catIndex = Object.fromEntries(PIPER_VOICE_CATALOG.map(v => [v.id, v]));
      const voices = installed.map(v => ({ ...v, ...(catIndex[v.id] ?? {}) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices }));
    } catch (e) {
      // Piper service down → return empty list rather than 500, so UI degrades
      // to "no voices installed" instead of breaking the Voice Devices panel.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices: [], error: e.message }));
    }
    return true;
  }

  // POST /api/provider-config/install-piper-voice  body: { voice: "<voice-id>" }
  // Downloads one Piper voice (onnx + onnx.json) into models/tts/. The
  // multivoice server hot-picks it up on the next /voices request — no
  // systemd restart needed. Admin-only because it writes shared system state.
  if (req.url === '/api/provider-config/install-piper-voice' && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const { voice } = JSON.parse(await readBody(req));
      const entry = PIPER_VOICE_CATALOG.find(v => v.id === voice);
      if (!entry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown voice id: ${voice}` }));
        return true;
      }
      const modelDir = path.join(os.homedir(), '.openensemble', 'models', 'tts');
      fs.mkdirSync(modelDir, { recursive: true });
      const base = piperVoiceUrlBase(voice);
      const targets = [
        { url: `${base}/${voice}.onnx`,      dest: path.join(modelDir, `${voice}.onnx`) },
        { url: `${base}/${voice}.onnx.json`, dest: path.join(modelDir, `${voice}.onnx.json`) },
      ];
      const { pipeline } = await import('node:stream/promises');
      const { Readable } = await import('node:stream');
      for (const { url, dest } of targets) {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue; // resumable
        const dl = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!dl.ok) throw new Error(`download failed (${dl.status}) for ${url}`);
        await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(dest));
      }
      invalidateVoiceDepsCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, voice }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // TTS endpoint — generates audio from text using configured TTS provider
  if (req.url === '/api/tts' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    // Three providers supported (f5-tts was removed 2026-05-15 — kept as
    // dead-code branch below for revert convenience; selecting it is no
    // longer possible from the UI and the config validator rejects it):
    //   'openai'      — remote OpenAI-compatible (named voice)
    //   'elevenlabs'  — remote ElevenLabs (voice_id, including user-cloned)
    //   'piper'       — local libritts_r multi-speaker via piper-tts.service:5151
    //   'kittentts'   — local 25M-param ONNX (CPU) via kittentts.service:5153
    const ALLOWED = ['openai', 'piper', 'kittentts', 'elevenlabs', 'pocket-tts'];
    const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
    if (provider === 'openai' && (!cfg.ttsApiKey || !cfg.ttsApiUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TTS provider not configured' }));
      return true;
    }
    if (provider === 'elevenlabs' && !cfg.elevenlabsApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
      return true;
    }
    try {
      const { text, lang, wake_slot, voice: explicitVoice } = JSON.parse(await readBody(req));
      if (!text) throw new Error('text is required');
      // Test-audio short-circuit: when the device echoes back a
      // `__test_audio_XXX__` marker (planted by POST /api/devices/<id>/play-mp3),
      // we return the cached MP3 directly without going through any TTS
      // provider. The cache entry is one-shot (deleted on first read).
      const trimmedText = text.trim();
      if (/^__test_audio_[a-f0-9]+__$/.test(trimmedText)) {
        const cached = takeTestMp3(trimmedText);
        if (cached) {
          console.log(`[tts] test-audio hit marker=${trimmedText} bytes=${cached.length}`);
          // Stream raw audio/mpeg — libhelix on the device decodes chunks
          // as they arrive over the wire. No JSON wrap, no base64 in
          // either direction; firmware oe_tts feeds HTTP_EVENT_ON_DATA
          // bytes straight into mp3_dec.
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': cached.length });
          res.end(cached);
          return true;
        }
        console.warn(`[tts] test-audio marker=${trimmedText} missed cache, falling through to TTS`);
        // Marker recognized but cache miss (expired or already consumed) —
        // fall through to normal TTS so the device still gets something
        // rather than hanging.
      }
      // Pre-flight: every code path below this point shells out to ffmpeg
      // (ambient stream loop, resample to 16 kHz, WAV→MP3 encode). If
      // ffmpeg isn't on PATH, fail fast with a structured 503 so the
      // device firmware can log the install hint and exit THINKING
      // instead of hanging on a dead socket. Cached probe → ~free.
      if (!(await probeFfmpegAvailable())) {
        console.warn('[tts] ffmpeg not installed — refusing TTS request');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'ffmpeg not installed',
          install: 'sudo apt install ffmpeg (or your distro equivalent), then restart OE',
        }));
        return true;
      }
      // Ambient marker — server streams ONE continuous MP3 via ffmpeg
      // `-stream_loop -1` so the device gets zero silence at loop seams.
      // The response holds open until either the device closes the socket
      // (wake fire / stop) OR a server-side dropAmbientForDevice ends it.
      if (/^__ambient_[a-f0-9]+__$/.test(trimmedText)) {
        const meta = takeAmbientStream(trimmedText);
        if (meta) {
          // Two flavours of source:
          //   meta.file — relative filename in the user's ambient-library dir
          //               (the existing "user uploaded an MP3" flow)
          //   meta.url  — direct http/https URL (skills calling
          //               ctx.device.playStream pass these; ffmpeg pulls
          //               the bytes itself and transcodes inline)
          let sourcePath = null;
          if (meta.url && /^https?:\/\//i.test(meta.url)) {
            sourcePath = meta.url;
          } else if (meta.file) {
            sourcePath = ambientFilePath(meta.userId, meta.file);
          }
          if (!sourcePath) {
            console.warn(`[tts] ambient marker=${trimmedText} resolved no source (file=${meta.file ?? '-'} url=${meta.url ?? '-'})`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ambient source missing' }));
            return true;
          }
          // Grace-period stream reattach: when a wake fires during ambient,
          // the device closes the HTTP response, but we DON'T tear down ffmpeg
          // immediately — we hold it warm in `_ambientStreams` for
          // STREAM_GRACE_MS. If the device re-requests the SAME marker within
          // the grace window (auto-restore after wake), we re-pipe the same
          // ff_buf to the new response — no ffmpeg cold start, no buffer
          // warmup, no decode-error burst at resume. Only explicit stop
          // (dropAmbientMp3 → forceKill) or grace expiry kills ffmpeg.
          const existing = _ambientStreams.get(trimmedText);
          if (existing) {
            if (existing.killTimer) {
              clearTimeout(existing.killTimer);
              existing.killTimer = null;
            }
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
            existing.ff_buf.pipe(res);
            const onResClose = () => startAmbientGrace(existing, trimmedText, res);
            res.on('close', onResClose);
            res.on('error', onResClose);
            registerAmbientResponse(trimmedText, res, existing.forceKill);
            pinAmbientMp3(trimmedText);  // cancel the orphan-cleanup TTL — stream is live
            console.log(`[tts] ambient stream RESUMED (warm reattach) marker=${trimmedText}`);
            return true;
          }
          const { spawn } = await import('child_process');
          const { PassThrough } = await import('stream');
          // Bumped from 'error' → 'warning' so encoder issues surface in
          // server logs. libhelix decode errors on device come from frame
          // issues; ffmpeg's own warnings often correlate. Drop back to
          // 'error' once we're confident the stream is clean.
          const args = ['-loglevel', 'warning'];
          if (meta.loop !== false) args.push('-stream_loop', '-1');
          // Strict CBR + bit-reservoir disabled. libhelix on the device
          // chokes on:
          //   - bit reservoir: frames borrowing bits from prior frames
          //     (errors -2 MAINDATA_UNDERFLOW) — any TCP hiccup loses the
          //     borrowed bits and the decoder can't reassemble the frame.
          //   - VBR / ABR: even within "CBR target" mode libmp3lame varies
          //     frame sizes to maintain quality. Forcing min/max equal to
          //     target makes every frame the same size, eliminating
          //     reservoir trickery entirely.
          //   - bufsize: 16k VBV window matches a tight per-frame budget so
          //     no rate-shaping juggling happens.
          // Cost: marginal audio quality loss vs ABR, fine for ambient
          // thunderstorm / sleep sounds.
          args.push('-i', sourcePath,
                    '-ac', '2', '-ar', '48000',
                    '-c:a', 'libmp3lame',
                    '-b:a', '160k',
                    '-minrate', '160k', '-maxrate', '160k', '-bufsize', '16k',
                    '-reservoir', '0',
                    '-f', 'mp3', 'pipe:1');
          const ff = spawn('ffmpeg', args);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
          // 1 MB buffer between ffmpeg stdout and the HTTP response. Without
          // this, transient network slowness fills the kernel TCP send buffer,
          // backpressures the response stream, and stalls ff.stdout — ffmpeg
          // pauses encoding mid-frame. When the network catches up ffmpeg
          // bursts the backlog and the device sees byte-rate spikes that
          // libhelix mis-decodes as INVALID_HUFFCODES / FRAMEHEADER errors.
          // Holds ~50s of 160k stereo (1MB ÷ 20 KB/s), enough to absorb
          // realistic Wi-Fi hiccups. During grace this also lets ffmpeg keep
          // encoding without a consumer until full, after which it pauses via
          // backpressure — bytes are preserved for the reattach on resume.
          const ff_buf = new PassThrough({ highWaterMark: 1024 * 1024 });
          ff.stdout.pipe(ff_buf).pipe(res);
          ff.stderr.on('data', d => console.warn(`[tts] ambient ffmpeg: ${d.toString().trim()}`));
          const streamEntry = { ff, ff_buf, killTimer: null, forceKill: null };
          const forceKill = () => {
            if (streamEntry.killTimer) {
              clearTimeout(streamEntry.killTimer);
              streamEntry.killTimer = null;
            }
            try { ff.kill('SIGKILL'); } catch {}
            _ambientStreams.delete(trimmedText);
            unregisterAmbientResponse(trimmedText);
          };
          streamEntry.forceKill = forceKill;
          _ambientStreams.set(trimmedText, streamEntry);
          const onResClose = () => startAmbientGrace(streamEntry, trimmedText, res);
          ff.on('error', forceKill);
          ff.on('exit', forceKill);
          res.on('close', onResClose);
          res.on('error', onResClose);
          registerAmbientResponse(trimmedText, res, forceKill);
          pinAmbientMp3(trimmedText);  // cancel the orphan-cleanup TTL — stream is live
          console.log(`[tts] ambient stream started (cold) marker=${trimmedText} src=${meta.url ?? meta.file ?? '?'} loop=${meta.loop !== false}`);
          return true;
        }
        console.warn(`[tts] ambient marker=${trimmedText} missed cache (TTL expired or never cached)`);
      }
      // Voice resolution order:
      //   1. explicit `voice` body param (used by Settings → voice preview
      //      to audition an unsaved value before committing it)
      //   2. slot_assignments[wake_slot].ttsVoice for the device making
      //      the request (voice-device + slot in body)
      //   3. cfg.ttsVoice (server-global default)
      //   4. 'alloy' for openai / '0' for piper (hardcoded fallback)
      const defaultVoice =
        provider === 'piper' ? '0' :
        provider === 'kittentts' ? KITTENTTS_DEFAULT_VOICE :
        provider === 'pocket-tts' ? '' : // empty → OE Default voice-state (offline); cloned voices are ref_<hex>; presets are catalog names
        provider === 'elevenlabs' ? '21m00Tcm4TlvDq8ikWAM' : // Rachel — EL stock voice id
        'alloy';
      let voice = cfg.ttsVoice || defaultVoice;
      if (Number.isInteger(wake_slot)) {
        const meta = getSessionMeta(getAuthToken(req));
        if (meta?.deviceId) {
          const a = getSlotAssignment(authId, meta.deviceId, wake_slot);
          if (a?.ttsVoice) voice = a.ttsVoice;
        }
      }
      if (typeof explicitVoice === 'string' && explicitVoice) voice = explicitVoice;
      if (provider === 'elevenlabs') {
        // ElevenLabs returns MP3 directly — no conversion step. voice is a
        // voice_id (UUID-ish string). Default model 'eleven_turbo_v2_5' is
        // their low-latency option; users can override via cfg.elevenlabsModel.
        const elModel = cfg.elevenlabsModel || 'eleven_turbo_v2_5';
        // eleven_turbo_v2_5 ships a brisk default cadence (~25% faster than
        // natural — the "chipmunk" reports). `speed` (0.7-1.2) on voice_settings
        // slows it; `style: 0` keeps pacing stable. Configurable via
        // cfg.elevenlabsSpeed; default 0.85 lands near natural for short replies.
        const elSpeed = Number.isFinite(cfg.elevenlabsSpeed)
          ? Math.min(1.2, Math.max(0.7, cfg.elevenlabsSpeed)) : 0.85;
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
          method: 'POST',
          headers: {
            'xi-api-key': cfg.elevenlabsApiKey,
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: elModel,
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: elSpeed },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!elRes.ok) {
          const errBody = await elRes.text().catch(() => '');
          throw new Error(`ElevenLabs ${elRes.status}: ${errBody.slice(0, 200)}`);
        }
        const elMp3 = Buffer.from(await elRes.arrayBuffer());
        // ElevenLabs returns MP3 at 22050 or 44100 Hz. The device's I²S
        // playback runs at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE), so
        // anything higher plays slow + pitched-down. Resample via ffmpeg
        // before sending. Browser-side previews don't suffer this because
        // <audio> handles arbitrary sample rates; only the on-device
        // playback path needs the conversion. Could short-circuit when
        // the request is from a browser-auth session, but the savings
        // (~30 ms ffmpeg pass) aren't worth the branching.
        const { spawn: spawnEl } = await import('child_process');
        const ffEl = spawnEl('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'mp3', '-i', 'pipe:0',
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const elChunks = [];
        ffEl.stdout.on('data', c => elChunks.push(c));
        const ffElPromise = new Promise((resolve, reject) => {
          ffEl.on('error', reject);
          ffEl.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ffEl.stdin.end(elMp3);
        await ffElPromise;
        const elMp3_16k = Buffer.concat(elChunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': elMp3_16k.length });
        res.end(elMp3_16k);
        return true;
      }
      if (provider === 'pocket-tts') {
        // Pocket TTS speaks {text, ref_path} (zero-shot clone from a user's
        // uploaded reference) or {text, voice} (a preset catalog name). A
        // cloned voice is a voice-ref id (ref_<hex>) owned by the AUTH user —
        // the device-paired user manages all voices for their device. No
        // transcript needed (unlike F5): Pocket TTS is fully zero-shot.
        const pocketBody = { text };
        const isRef = typeof voice === 'string' && voice.startsWith('ref_');
        const pref = isRef ? getVoiceRef(authId, voice) : null;
        const oeDefaultState = path.join(os.homedir(), '.openensemble', 'models', 'tts', 'pocket-tts', 'default-voice.safetensors');
        if (pref) pocketBody.ref_path = pref.wavPath;
        else if (voice && !isRef && voice !== 'default-en' && voice !== 'default') pocketBody.voice = voice; // explicit preset
        // OE Default (empty/legacy/deleted-ref) → bundled offline voice-state; else a catalog preset.
        else if (fs.existsSync(oeDefaultState)) pocketBody.ref_path = oeDefaultState;
        else pocketBody.voice = 'george';
        const pocketUrl = cfg.pocketTtsUrl || 'http://127.0.0.1:5155/';
        const pRes = await fetch(pocketUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pocketBody),
          signal: AbortSignal.timeout(60000),
        });
        if (!pRes.ok) throw new Error(`Pocket TTS returned ${pRes.status}`);
        const wavBuf = Buffer.from(await pRes.arrayBuffer());
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      if (provider === 'kittentts') {
        // KittenTTS HTTP server speaks {text, voice} → WAV (24 kHz mono).
        // Voice is a preset name from the 8 baked-in choices; we let the
        // server fall back to its default if the caller passes something
        // unrecognized. ffmpeg resamples to the device's 16 kHz I²S bus.
        const kittenttsUrl = cfg.kittenttsUrl || 'http://127.0.0.1:5153/';
        const kRes = await fetch(kittenttsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice }),
          signal: AbortSignal.timeout(30000),
        });
        if (!kRes.ok) throw new Error(`KittenTTS returned ${kRes.status}`);
        const wavBuf = Buffer.from(await kRes.arrayBuffer());
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      if (provider === 'piper') {
        // Piper multivoice server speaks {text, voice, speaker_id?} → WAV.
        // We translate OpenAI-shape, run through ffmpeg to get MP3 (matches
        // the device's existing decode path), and return audio/mpeg.
        //
        // The stored slot voice has three shapes:
        //   "en_AU-OE_custom-medium"     → single-speaker voice, no speaker_id
        //   "en_US-libritts_r-medium:42" → multi-speaker voice + speaker_id
        //   "42"                         → legacy bare-numeric, maps to libritts_r:42
        let voiceId = '', speakerId = null;
        if (voice) {
          if (/^\d+$/.test(voice)) {
            voiceId = 'en_US-libritts_r-medium';
            speakerId = Number.parseInt(voice, 10);
          } else if (voice.includes(':')) {
            const [v, s] = voice.split(':', 2);
            voiceId = v;
            const n = Number.parseInt(s, 10);
            if (Number.isFinite(n)) speakerId = n;
          } else {
            voiceId = voice;
          }
        }
        const piperBase = (cfg.piperUrl || 'http://127.0.0.1:5151/').replace(/\/+$/, '');
        // length_scale > 1.0 slows speech; 1.1 takes ~10% longer (Piper VITS
        // voices ship a touch fast for most listeners). Override via
        // cfg.piperLengthScale in config.json.
        const lengthScale = Number.isFinite(cfg.piperLengthScale) ? cfg.piperLengthScale : 1.1;
        const pRes = await fetch(piperBase + '/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            ...(voiceId ? { voice: voiceId } : {}),
            ...(Number.isFinite(speakerId) ? { speaker_id: speakerId } : {}),
            length_scale: lengthScale,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!pRes.ok) throw new Error(`Piper returned ${pRes.status}`);
        const wavBuf = Buffer.from(await pRes.arrayBuffer());
        // WAV → MP3 via ffmpeg subprocess. Pipe in, pipe out. Avoids any
        // disk I/O. 64 kbps mono is fine for speech and keeps the base64
        // payload roughly the same size as OpenAI's tts-1 output.
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          // Sending higher-rate MP3 → libhelix decodes at source rate →
          // played into a 16 kHz I²S pipeline → audio is slower + pitched
          // down. Resample server-side to match the bus.
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      // OpenAI provider (default / legacy)
      const ttsRes = await fetch(cfg.ttsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.ttsApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.ttsModel || 'tts-1',
          voice,
          input: text,
          ...(lang ? { language: lang } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!ttsRes.ok) throw new Error(`TTS API returned ${ttsRes.status}`);
      const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
      const mimeType = ttsRes.headers.get('content-type') || 'audio/mpeg';
      res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': audioBuffer.length });
      res.end(audioBuffer);
    } catch (e) { safeError(res, e); }
    return true;
  }

  if (req.url === '/api/stt' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (!cfg.sttApiKey || !cfg.sttApiUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'STT provider not configured', configured: false }));
      return true;
    }
    try {
      const ctype = req.headers['content-type'] || '';
      const match = ctype.match(/boundary=(?:"?)([^";]+)/);
      if (!match) throw new Error('Expected multipart/form-data with a boundary');
      // Binary-safe read — readBody() would UTF-8-mangle the WAV bytes.
      const raw = await readBodyBuffer(req);
      // Walk parts, pick the first file part named audio/* or the first audio part
      const boundary = match[1];
      const sep = Buffer.from('--' + boundary);
      let audioBuf = null, audioName = 'speech.webm', audioMime = 'audio/webm';
      let lang = '';
      let cursor = 0;
      while (cursor < raw.length) {
        const sepIdx = raw.indexOf(sep, cursor);
        if (sepIdx === -1) break;
        const nextSep = raw.indexOf(sep, sepIdx + sep.length);
        const part = raw.slice(sepIdx + sep.length, nextSep === -1 ? raw.length : nextSep);
        cursor = sepIdx + sep.length;
        if (part.length < 4) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4, part.length - 2);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const name = nameMatch?.[1];
        if (!name) continue;
        if (headers.includes('filename=')) {
          if (!audioBuf) {
            audioBuf = body;
            audioName = (headers.match(/filename="([^"]+)"/) ?? [])[1] ?? audioName;
            audioMime = (headers.match(/Content-Type:\s*([^\r\n]+)/) ?? [])[1]?.trim() ?? audioMime;
          }
        } else if (name === 'lang') {
          lang = body.toString().trim();
        }
      }
      if (!audioBuf) throw new Error('No audio part in request');

      // Debug dump: save the most recent upload so we can inspect malformed
      // WAVs / silence / clipped audio when STT rejects with "could not
      // process file". Overwrites previous /tmp/oe-stt-last.* every call.
      try {
        const fs = await import('fs');
        fs.writeFileSync(`/tmp/oe-stt-last-${audioName.replace(/[^\w.-]/g, '_')}`, audioBuf);
        console.log(`[stt] dump: ${audioBuf.length} bytes (${audioMime}) → /tmp/oe-stt-last-*`);
      } catch (e) { console.warn('[stt] dump failed:', e.message); }

      // Send to configured STT provider (OpenAI-compatible multipart).
      // sttMode=local routes to the Faster-Whisper service regardless of the
      // configured remote URL/key, so users can keep their Groq/OpenAI
      // credentials saved while flipping between local and remote.
      const form = new FormData();
      form.append('file', new Blob([audioBuf], { type: audioMime }), audioName);
      form.append('model', cfg.sttModel || 'whisper-1');
      // Always pin a language. With none, multilingual Whisper auto-detects and,
      // on the silence/noise that follows a FALSE wake, hallucinates whatever is
      // statistically common in its training data — YouTube end-cards in Japanese/
      // Korean/Russian ("ご視聴ありがとうございました" etc.). Device-sent lang wins;
      // else the config default; else English. Override via cfg.sttLanguage.
      form.append('language', lang || cfg.sttLanguage || 'en');
      const isLocal = cfg.sttMode === 'local';
      const sttUrl = isLocal
        ? 'http://127.0.0.1:5154/v1/audio/transcriptions'
        : cfg.sttApiUrl;
      const sttKey = isLocal ? 'local' : cfg.sttApiKey;
      const sttRes = await fetch(sttUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sttKey}` },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!sttRes.ok) throw new Error(`STT API returned ${sttRes.status}: ${await sttRes.text()}`);
      const data = await sttRes.json();
      let transcript = data.text ?? data.transcript ?? '';
      // Whisper renders times like "11:02 AM" as "11.02 AM" or just "11.22"
      // — period instead of colon. Normalize any HH.MM in valid time range
      // (00-23 hours, 00-59 minutes) to HH:MM. The bounds keep prices
      // ("$1.99") and version numbers ("v1.2") from getting rewritten.
      transcript = transcript.replace(
        /\b([0-1]?\d|2[0-3])\.([0-5]\d)\b/g,
        '$1:$2',
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript, raw: data }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;
}
