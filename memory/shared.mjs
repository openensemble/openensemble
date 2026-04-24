/**
 * Cortex shared utilities — constants, config, write queue, provider health,
 * LLM generate helpers, Ebbinghaus retention math.
 *
 * No dependencies on other memory/* modules — safe to import everywhere.
 */

import path from 'path';
import { loadConfig, modifyConfig } from '../routes/_helpers.mjs';
import { USERS_DIR } from '../lib/paths.mjs';
import {
  OPENAI_COMPAT_PROVIDERS, getCompatKey,
  getAnthropicKey, getFireworksKey, getGrokKey, getOpenRouterKey, getOllamaKey,
} from '../chat/providers/_shared.mjs';

export const VECTOR_DIM = 768;

// ── Token budgets for context injection ──────────────────────────────────────
export const CORTEX_TOTAL_CAP = 2000;
export const TOKEN_BUDGET = {
  systemInstructions: 800,
  userContext:        400,
  episodeHistory:     800,
};

// ── Identity + LanceDB query hygiene ─────────────────────────────────────────
// Memory IDs are generated as `mem_<ms>_<rand>` (see lance.mjs rememberFast/remember)
// and table init rows as `_init_<table_name>`. We also accept classic UUIDs for
// forward-compat. Anything else (quotes, spaces, semicolons, SQL metachars) is
// rejected so the value can be safely interpolated into LanceDB `.where()` strings.
export const MEMORY_ID_RE = /^[a-zA-Z0-9_\-]{3,120}$/;
// Back-compat alias — older callers imported UUID_RE to skip "legacy" non-UUID
// rows during recall updates. Current ID format is not a UUID, so aliasing to
// MEMORY_ID_RE ensures those call sites don't silently skip live memories.
export const UUID_RE = MEMORY_ID_RE;
export function assertId(id) {
  if (typeof id !== 'string' || !MEMORY_ID_RE.test(id)) {
    throw new Error(`Invalid memory ID: ${id}`);
  }
  return id;
}

/** Sanitize values interpolated into LanceDB .where() strings to prevent injection. */
export function safeLanceVal(v) {
  const s = String(v);
  if (!/^[a-zA-Z0-9_.:T\-]+$/.test(s)) throw new Error('Invalid query value');
  return s;
}

export function dbPath(userId) {
  return path.join(USERS_DIR, userId, 'cortex');
}

// ── Embed provider migration ─────────────────────────────────────────────────
// Older installs had embedProvider: 'ollama'/'lmstudio'/etc. Ship the bundled
// model as the default so cortex works without any external dependency; stash
// the old setting under _legacyEmbedProvider for manual recovery. Runs at most
// once per process — subsequent reads see the already-migrated config on disk.
let _migrationChecked = false;
function _migrateEmbedProvider(cfg) {
  if (_migrationChecked) return;
  _migrationChecked = true;
  const c = cfg.cortex ?? {};
  if (!c.embedProvider || c.embedProvider === 'builtin') return;
  const oldProvider = c.embedProvider;
  const oldModel = c.embedModel;
  modifyConfig(x => {
    x.cortex = x.cortex ?? {};
    x.cortex._legacyEmbedProvider = oldProvider;
    if (oldModel) x.cortex._legacyEmbedModel = oldModel;
    x.cortex.embedProvider = 'builtin';
    x.cortex.embedModel = 'nomic-embed-text-v1';
    delete x.cortex.embedUrl;
  }).catch(e => console.warn('[cortex] Migration write failed:', e.message));
  console.warn(
    `[cortex] migrated embed provider ${oldProvider} → builtin. ` +
    `Old setting saved under cortex._legacyEmbedProvider.`
  );
}

// ── Reason provider migration ────────────────────────────────────────────────
// Same story as embed: pre-builtin installs hardcoded reasonProvider to an
// external runtime. Flip stale configs to 'auto' so the bundled reason model
// kicks in on next boot. Old value stashed under _legacyReasonProvider.
let _reasonMigrationChecked = false;
function _migrateReasonProvider(cfg) {
  if (_reasonMigrationChecked) return;
  _reasonMigrationChecked = true;
  const c = cfg.cortex ?? {};
  // Only migrate values we know pre-date the builtin support (ollama/lmstudio).
  // Leave 'auto', 'builtin', or any cloud provider choice alone.
  if (c.reasonProvider !== 'ollama' && c.reasonProvider !== 'lmstudio') return;
  const oldProvider = c.reasonProvider;
  modifyConfig(x => {
    x.cortex = x.cortex ?? {};
    x.cortex._legacyReasonProvider = oldProvider;
    x.cortex.reasonProvider = 'auto';
  }).catch(e => console.warn('[cortex] Reason migration write failed:', e.message));
  console.warn(
    `[cortex] migrated reason provider ${oldProvider} → auto. ` +
    `Old setting saved under cortex._legacyReasonProvider.`
  );
}

// ── Cortex config ────────────────────────────────────────────────────────────
export function getCortexConfig() {
  const cfg = loadConfig();
  _migrateEmbedProvider(cfg);
  _migrateReasonProvider(cfg);
  const c = cfg.cortex ?? {};

  const embedProvider = c.embedProvider ?? 'builtin';
  // reasonProvider: 'auto' (default — prefers builtin, falls back to lmstudio/ollama),
  // 'builtin' (force in-process), or any provider name for external routing.
  const reasonProvider = c.reasonProvider ?? 'auto';

  const lmstudioBase = c.lmstudioUrl ?? 'http://127.0.0.1:1234';
  const ollamaBase   = c.ollamaUrl   ?? 'http://localhost:11434';

  // Canonical reasonModel — falls back to the legacy provider-suffixed fields
  // so configs written before the multi-provider switch still work. Default
  // names match where each runtime stores our fine-tuned adapter (reason-transfer.mjs).
  const reasonModel = c.reasonModel
    ?? (reasonProvider === 'builtin'  ? 'openensemble-reason-v1.q8_0.gguf'
     :  reasonProvider === 'lmstudio' ? (c.reasonModelLmstudio ?? 'openensemble/reason-v1')
     :  reasonProvider === 'ollama'   ? (c.reasonModelOllama   ?? 'openensemble-reason:v1')
     :  c.reasonModelOllama ?? c.reasonModelLmstudio ?? 'openensemble-reason-v1.q8_0.gguf');

  // Undocumented dev-only flag: when true, memory/training-log.mjs appends every
  // _chatCall I/O to ~/.openensemble/training/capture/ for corpus building.
  // Not exposed in any UI — only flipped manually in config.json for dogfooding.
  const devCapture = c._devCapture === true;

  return {
    embedProvider,
    embedModel: c.embedModel ?? (embedProvider === 'builtin' ? 'nomic-embed-text-v1' : 'nomic-embed-text'),
    embedUrl:   c.embedUrl,    // optional override; routeEmbedEndpoint derives default if absent
    reasonProvider,
    reasonModel,
    // Legacy fields — kept for backcompat callers that read them directly.
    // Defaults match the install names used by reason-transfer.mjs.
    reasonModelLmstudio: c.reasonModelLmstudio ?? c.reasonModel ?? 'openensemble/reason-v1',
    reasonModelOllama:   c.reasonModelOllama   ?? c.reasonModel ?? 'openensemble-reason:v1',
    lmstudioBase,
    ollamaBase,
    devCapture,
  };
}

// ── Provider routing ─────────────────────────────────────────────────────────
// Given a provider name, return { baseUrl, headers, supportsEmbed, supportsChat }.
// Covers Ollama, LM Studio, every OpenAI-compat provider (openai, deepseek,
// mistral, groq, together, perplexity, gemini, xai), plus fireworks /
// openrouter / anthropic special cases. Unknown providers return null.
export function getProviderSpec(provider) {
  const cfg = loadConfig();
  const c = cfg.cortex ?? {};

  if (provider === 'builtin') {
    return {
      baseUrl: null, apiStyle: 'builtin', headers: {},
      // supportsChat switched on once builtin-reason.mjs landed — the runtime
      // dispatches to the in-process SmolLM2 pipeline via _chatCall's builtin
      // branch. Embed still routes through builtin-embed.mjs independently.
      supportsEmbed: true, supportsChat: true,
    };
  }
  if (provider === 'ollama') {
    // Users may store the URL with or without a trailing /api — normalize so
    // path building (`${base}/api/embeddings`) doesn't double up.
    const base = (c.ollamaUrl ?? 'http://localhost:11434')
      .replace(/\/$/, '').replace(/\/api$/, '');
    const key = getOllamaKey();
    return {
      baseUrl: base, apiStyle: 'ollama',
      headers: key ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } : { 'Content-Type': 'application/json' },
      supportsEmbed: true, supportsChat: true,
    };
  }
  if (provider === 'lmstudio') {
    const base = (c.lmstudioUrl ?? 'http://127.0.0.1:1234').replace(/\/$/, '');
    const key = c.lmstudioApiKey;
    return {
      baseUrl: `${base}/v1`, apiStyle: 'openai',
      headers: key ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } : { 'Content-Type': 'application/json' },
      supportsEmbed: true, supportsChat: true,
    };
  }
  if (OPENAI_COMPAT_PROVIDERS[provider]) {
    const { baseUrl } = OPENAI_COMPAT_PROVIDERS[provider];
    const key = getCompatKey(provider);
    // groq, perplexity & zai don't expose /embeddings; still allow for chat.
    const supportsEmbed = !['groq', 'perplexity', 'zai'].includes(provider);
    return {
      baseUrl, apiStyle: 'openai',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      supportsEmbed, supportsChat: true,
    };
  }
  if (provider === 'fireworks') {
    const key = getFireworksKey();
    return {
      baseUrl: 'https://api.fireworks.ai/inference/v1', apiStyle: 'openai',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      supportsEmbed: true, supportsChat: true,
    };
  }
  if (provider === 'openrouter') {
    const key = getOpenRouterKey();
    return {
      baseUrl: 'https://openrouter.ai/api/v1', apiStyle: 'openai',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      supportsEmbed: false, supportsChat: true, // openrouter doesn't expose /embeddings
    };
  }
  if (provider === 'anthropic') {
    const key = getAnthropicKey();
    return {
      baseUrl: 'https://api.anthropic.com/v1', apiStyle: 'anthropic',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) },
      supportsEmbed: false, // Anthropic has no public embeddings endpoint
      supportsChat: true,
    };
  }
  if (provider === 'grok' || provider === 'xai') {
    const key = getGrokKey();
    return {
      baseUrl: 'https://api.x.ai/v1', apiStyle: 'openai',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      supportsEmbed: false, supportsChat: true,
    };
  }
  return null;
}

// Quick reachability check for a single provider base URL.
async function _isReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch { return false; } // expected: provider may be offline
}

export async function providerHealthy() {
  const provider = await resolveReasonProvider();
  if (!provider) return false;
  // Builtin is healthy as long as the pipeline module loads — weights missing
  // is surfaced at startup and individual calls return null, not throw.
  if (provider === 'builtin') return true;
  // Cloud providers with an API key are assumed reachable — probing them costs
  // tokens and rate-limit headroom. Only local providers get a ping.
  if (provider === 'ollama') {
    const { ollamaBase } = getCortexConfig();
    return _isReachable(`${ollamaBase}/api/tags`);
  }
  if (provider === 'lmstudio') {
    const { lmstudioBase } = getCortexConfig();
    return _isReachable(`${lmstudioBase}/v1/models`);
  }
  const spec = getProviderSpec(provider);
  // If we have a key for a cloud provider, treat as healthy.
  return !!(spec && spec.headers && (spec.headers.Authorization || spec.headers['x-api-key']));
}

/** Resolve 'auto' to whatever local reasoner is available.
 *  Preference order: builtin > lmstudio > ollama > null.
 *  The builtin model is always preferred on 'auto' because it's bundled with
 *  OpenEnsemble and requires no external runtime — matches how embed works.
 *  Non-auto values (any provider name) are returned as-is. */
export async function resolveReasonProvider() {
  const { reasonProvider, lmstudioBase, ollamaBase } = getCortexConfig();
  if (reasonProvider !== 'auto') return reasonProvider;
  // Builtin is considered available unless explicitly failed to warm. The
  // startup health check in server.mjs prints a banner if weights are missing;
  // individual _chatCall invocations will return null on failure and the caller
  // falls back gracefully (salience/contradiction already degrade to defaults).
  try {
    const { isBuiltinReasonReady, initBuiltinReason } = await import('./builtin-reason.mjs');
    if (isBuiltinReasonReady()) return 'builtin';
    // Kick off warmup in background — first call might miss, subsequent hit.
    initBuiltinReason().catch(() => {});
    // Prefer builtin even on first miss — downstream handles null gracefully.
    return 'builtin';
  } catch { /* module missing in weird install states — fall through */ }
  if (await _isReachable(`${lmstudioBase}/v1/models`)) return 'lmstudio';
  if (await _isReachable(`${ollamaBase}/api/tags`))    return 'ollama';
  return null;
}

// ── JSON tolerant parsing ────────────────────────────────────────────────────
export function safeParseJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const stripped = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  try { return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1')); } catch {}
  return null;
}

// ── Provider-aware chat call ────────────────────────────────────────────────
// Single code path for salience scoring, signal detection, contradiction
// checks, friction matching, and session summaries. Routes to whichever
// provider reasonProvider resolves to — including the in-process builtin
// model (memory/builtin-reason.mjs).
//
// `meta.caller` tags the call with its task name ('salience' | 'contradiction'
// | 'signals' | 'friction' | 'summary'). Used by:
//   1. builtin-reason to select the task-prefix token for the fine-tuned model
//   2. memory/training-log.mjs to bucket captured I/O by task for corpus building
async function _chatCall({ system, user, temperature = 0.1 }, meta = {}) {
  const cfg = getCortexConfig();
  const provider = await resolveReasonProvider();
  if (!provider) return null;

  const spec = getProviderSpec(provider);
  if (!spec || !spec.supportsChat) {
    console.warn('[cortex] Reason provider', provider, 'not supported.');
    return null;
  }

  const model = cfg.reasonModel;
  const signal = AbortSignal.timeout(20000);
  const startedAt = Date.now();
  let output = null;
  let rawResponse = null;

  try {
    if (spec.apiStyle === 'builtin') {
      const { builtinGenerate } = await import('./builtin-reason.mjs');
      output = await builtinGenerate({ system, user, temperature, task: meta.caller });
      rawResponse = output;
    } else if (spec.apiStyle === 'ollama') {
      const body = JSON.stringify({
        model, stream: false,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        options: { temperature, num_ctx: 512 },
      });
      const res = await fetch(`${spec.baseUrl}/api/chat`, { method: 'POST', headers: spec.headers, body, signal });
      const data = await res.json();
      rawResponse = data;
      output = data.message?.content?.trim() ?? null;
    } else if (spec.apiStyle === 'openai') {
      const body = JSON.stringify({
        model, temperature, stream: false,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      });
      const res = await fetch(`${spec.baseUrl}/chat/completions`, { method: 'POST', headers: spec.headers, body, signal });
      const data = await res.json();
      rawResponse = data;
      output = data.choices?.[0]?.message?.content?.trim() ?? null;
    } else if (spec.apiStyle === 'anthropic') {
      const body = JSON.stringify({
        model, max_tokens: 512, temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: user }],
      });
      const res = await fetch(`${spec.baseUrl}/messages`, { method: 'POST', headers: spec.headers, body, signal });
      const data = await res.json();
      rawResponse = data;
      output = data.content?.map(c => c.text).filter(Boolean).join('').trim() || null;
    }
  } catch (e) {
    console.warn('[cortex] Chat call failed (' + provider + '):', e.message);
    output = null;
    rawResponse = { error: e.message };
  }

  // Dev-only training capture — undocumented, gated by cortex._devCapture.
  // Failure here never affects the return value; logger handles its own errors.
  if (cfg.devCapture) {
    import('./training-log.mjs')
      .then(({ captureChatCall }) => captureChatCall({
        caller: meta.caller ?? 'unknown',
        userId: meta.userId ?? null,
        agentId: meta.agentId ?? null,
        provider, model, temperature,
        system, user,
        raw_output: rawResponse,
        parsed_output: output,
        latency_ms: Date.now() - startedAt,
      }))
      .catch(() => {}); // logger is best-effort
  }

  return output;
}

// ── Lightweight LLM generate (prompt-style) ──────────────────────────────────
export async function generate(prompt, meta = {}) {
  return _chatCall({ system: null, user: prompt }, meta);
}

// ── Combined signal detection — one model call replaces 4 ───────────────────
export async function generateCombined(instruction, inputText, meta = {}) {
  return _chatCall({
    system: 'You are a memory assistant. Output JSON only.',
    user: `${instruction}\n${inputText}`,
  }, meta);
}

// ── Write queue — prevents LanceDB concurrent write conflicts ────────────────
const _writeQueues = {};
export function queuedWrite(tableName, fn) {
  if (!_writeQueues[tableName]) _writeQueues[tableName] = Promise.resolve();
  _writeQueues[tableName] = _writeQueues[tableName]
    .then(() => fn())
    .catch(e => console.warn('[cortex] Queued write failed for', tableName + ':', e.message));
  return _writeQueues[tableName];
}

// ── Ebbinghaus retention math ────────────────────────────────────────────────
export function calcRetention(memory) {
  const hoursSince = (Date.now() - new Date(memory.last_recalled_at || memory.created_at).getTime()) / 3_600_000;
  return Math.exp(-hoursSince / (memory.stability || 24));
}

export function initialStability(salienceComposite) {
  return 72 * (1 + salienceComposite * 8);
}

export function recencyScore(createdAt) {
  const hoursAgo = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  return Math.exp(-hoursAgo / 48); // 48h half-life
}
