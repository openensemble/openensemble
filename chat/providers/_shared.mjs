/**
 * Provider-shared utilities:
 *   - Provider URLs + API-key getters (Anthropic/Fireworks/Grok/OpenRouter/Ollama)
 *   - OPENAI_COMPAT_PROVIDERS registry + getCompatKey
 *   - NDJSON + SSE stream readers
 *   - stripThinking / stripReasoningPreamble text cleanup
 */

import { loadConfig } from '../../routes/_helpers.mjs';

// ── Provider endpoints ───────────────────────────────────────────────────────
export const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';
export const FIREWORKS_BASE   = 'https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models';
export const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENAI_OAUTH_BASE = 'https://chatgpt.com/backend-api/codex';

const OLLAMA_URL_DEFAULT = 'http://localhost:11434/api/chat';
export function getOllamaUrl() {
  const base = loadConfig()?.cortex?.ollamaUrl;
  return base ? base.replace(/\/$/, '') + '/chat' : OLLAMA_URL_DEFAULT;
}
export function getOllamaKey() {
  const cfg = loadConfig();
  return cfg?.cortex?.ollamaApiKey ?? cfg?.ollamaApiKey ?? null;
}

// ── LM Studio — configurable like Ollama ─────────────────────────────────────
// The LMSTUDIO_* constants above are just localhost defaults. Real listing +
// inference resolve the base from cortex.lmstudioUrl so LM Studio can run on
// ANOTHER host (IP/domain), and send a Bearer key if the server requires one
// (type a random key when it doesn't — the server ignores it).
const LMSTUDIO_BASE_DEFAULT = 'http://127.0.0.1:1234';
export function getLmstudioBase() {
  const cfg = loadConfig();
  const base = cfg?.cortex?.lmstudioUrl ?? cfg?.lmstudioUrl ?? LMSTUDIO_BASE_DEFAULT;
  return String(base).replace(/\/+$/, '');
}
export function getLmstudioNativeUrl() { return getLmstudioBase() + '/api/v1/chat'; }
export function getLmstudioCompatUrl() { return getLmstudioBase() + '/v1/chat/completions'; }
export function getLmstudioKey() {
  const cfg = loadConfig();
  return cfg?.cortex?.lmstudioApiKey ?? cfg?.lmstudioApiKey ?? null;
}
export function lmstudioAuthHeaders() {
  const k = getLmstudioKey();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

// ── OpenAI-compatible providers ──────────────────────────────────────────────
// Each provider exposes the same `/chat/completions` schema. We only need to
// know the base URL and the config key name that stores the API key.
//
// `OPENAI_COMPAT_PROVIDERS` is exposed as a Proxy that transparently merges
// the user-providers overlay (config/user-providers.json) on every read so
// runtime-added providers via the oe-admin skill light up immediately. The
// hardcoded list below always wins on collision — the overlay can ADD a new
// provider but cannot silently redirect a built-in one.
const STATIC_OPENAI_COMPAT_PROVIDERS = {
  openai:      { baseUrl: 'https://api.openai.com/v1',                               keyField: 'openaiApiKey',      displayName: 'OpenAI' },
  deepseek:    { baseUrl: 'https://api.deepseek.com/v1',                             keyField: 'deepseekApiKey',    displayName: 'DeepSeek' },
  mistral:     { baseUrl: 'https://api.mistral.ai/v1',                               keyField: 'mistralApiKey',     displayName: 'Mistral' },
  groq:        { baseUrl: 'https://api.groq.com/openai/v1',                          keyField: 'groqApiKey',        displayName: 'Groq' },
  together:    { baseUrl: 'https://api.together.xyz/v1',                             keyField: 'togetherApiKey',    displayName: 'Together AI' },
  perplexity:  { baseUrl: 'https://api.perplexity.ai',                               keyField: 'perplexityApiKey',  displayName: 'Perplexity' },
  gemini:      { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyField: 'geminiApiKey',      displayName: 'Google Gemini' },
  xai:         { baseUrl: 'https://api.x.ai/v1',                                     keyField: 'grokApiKey',        displayName: 'xAI Grok' },
  zai:         { baseUrl: 'https://api.z.ai/api/paas/v4',                            keyField: 'zaiApiKey',         displayName: 'Z.AI' },
};

// All traps run on property access, never at module-load, so a top-level
// ESM import is safe (the user-providers module is fully initialized by the
// time any provider lookup fires from chat.mjs / memory / etc.).
import { mergeProviders } from '../../lib/user-providers.mjs';

function mergedCompatProvidersSync() {
  try { return mergeProviders(STATIC_OPENAI_COMPAT_PROVIDERS); }
  catch { return STATIC_OPENAI_COMPAT_PROVIDERS; }
}

export const OPENAI_COMPAT_PROVIDERS = new Proxy(STATIC_OPENAI_COMPAT_PROVIDERS, {
  get(_target, key) {
    if (typeof key === 'symbol') return _target[key];
    return mergedCompatProvidersSync()[key];
  },
  has(_target, key) {
    return key in mergedCompatProvidersSync();
  },
  ownKeys() {
    return Object.keys(mergedCompatProvidersSync());
  },
  getOwnPropertyDescriptor(_target, key) {
    const m = mergedCompatProvidersSync();
    if (key in m) return { configurable: true, enumerable: true, value: m[key] };
    return undefined;
  },
});

export function getCompatKey(provider) {
  const cfg = loadConfig();
  const field = OPENAI_COMPAT_PROVIDERS[provider]?.keyField;
  if (!field) return null;
  // Check env var too (e.g. OPENAI_API_KEY, DEEPSEEK_API_KEY)
  const envVar = field.replace(/ApiKey$/, '').toUpperCase() + '_API_KEY';
  return process.env[envVar] ?? cfg[field] ?? null;
}

function getApiKey(envVar, configKey) {
  if (process.env[envVar]) return process.env[envVar];
  const cfg = loadConfig();
  return cfg[configKey] ?? null;
}
export function getAnthropicKey()  { return getApiKey('ANTHROPIC_API_KEY',  'anthropicApiKey'); }
export function getFireworksKey()  { return getApiKey('FIREWORKS_API_KEY',  'fireworksApiKey'); }
export function getGrokKey()       { return getApiKey('GROK_API_KEY',       'grokApiKey'); }
export function getOpenRouterKey() { return getApiKey('OPENROUTER_API_KEY', 'openrouterApiKey'); }

export function getStripThinkingTags() {
  return loadConfig()?.stripThinkingTags !== false;
}

// ── Resilient fetch ──────────────────────────────────────────────────────────
// Shared retry wrapper for the initial provider request. Retries transient
// statuses (honoring Retry-After, capped at 8s) and network-level failures
// with short backoff. Only the request initiation is retried — nothing has
// streamed and no tool has run yet, so a retry can't double-execute anything.
// Non-retryable 4xx (400/401/403/404/422) return immediately so per-provider
// fallback handlers (native web_search, reasoning, max_completion_tokens,
// stream_options) see them untouched.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function _retryDelay(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function fetchWithRetry(url, opts = {}, { tries = 3, label = 'provider' } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (e.name === 'AbortError' || opts.signal?.aborted) throw e;
      lastErr = e;
      if (attempt === tries) throw e;
      console.warn(`[${label}] fetch failed (${e.message}) — retrying (${attempt}/${tries})`);
      await _retryDelay(1000 * attempt, opts.signal);
      continue;
    }
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === tries) return res;
    const ra = parseFloat(res.headers.get('retry-after'));
    const delayMs = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** (attempt - 1), 8000);
    try { await res.text(); } catch { /* drain to release the socket */ }
    console.warn(`[${label}] ${res.status} — retrying in ${delayMs}ms (${attempt}/${tries})`);
    await _retryDelay(delayMs, opts.signal);
    if (opts.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  }
  throw lastErr ?? new Error(`${label}: retries exhausted`);
}

// ── Self-healing notices ─────────────────────────────────────────────────────
// A provider adapter silently downgrading a request (dropping native web
// search, dropping reasoning-effort, renaming a rejected parameter) used to
// be console.warn-only — the user just felt their agent lose a capability
// with no explanation. capabilityNotice() turns the FIRST occurrence of a
// given (provider, capability) rejection into a one-line event; every
// subsequent occurrence for the same pair returns null (the existing
// per-turn retry latch already prevents the actual retry loop, this just
// prevents re-toasting on every future turn for the life of the process).
//
// Wire format reuses the existing `cortex_warning` WS event (see
// lib/runtime-warn.mjs) rather than inventing a new type: the frontend
// already renders it as an ephemeral showToast() with no persistent
// notification-center entry, and both of the send paths that can carry it
// (ws-handler.mjs's per-turn onEvent fan-out, and broadcast/sendToUser)
// explicitly skip voice-device sockets — so it can never reach a voice
// device, let alone be spoken (only `token`/`error`/`done` events feed the
// TTS streamer; anything else — this included — is either dropped for
// voice-suppressed turns or forwarded as an inert JSON frame the firmware
// doesn't act on, same as `tool_progress`/`tool_call` already are today).
const _notifiedCapabilities = new Set();
export function capabilityNotice(provider, capability, message) {
  const key = `${provider}:${capability}`;
  if (_notifiedCapabilities.has(key)) return null;
  _notifiedCapabilities.add(key);
  return { type: 'cortex_warning', message };
}

// ── Stream readers ───────────────────────────────────────────────────────────

// Read an NDJSON (newline-delimited JSON) stream from a Response body
export async function* readNDJSON(body) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (line.trim()) {
        try { yield JSON.parse(line); } catch { /* skip malformed NDJSON line */ }
      }
    }
  }
  if (buffer.trim()) {
    try { yield JSON.parse(buffer); } catch { /* skip malformed trailing NDJSON */ }
  }
}

// Anthropic / OpenAI-style SSE reader — parses `data: {...}` lines
export async function* readAnthropicSSE(body) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* skip malformed SSE event */ }
      }
    }
  }
}

// ── Reasoning cleanup ────────────────────────────────────────────────────────

// Strip thinking blocks from qwen3.5 / deepseek models
export function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Strip "thinking out loud" preamble paragraphs that some models emit as plain text
// Matches the FIRST LINE of a paragraph that is model self-reasoning / thinking-out-loud.
// Only the first line needs to match — if a paragraph opens with thinking, the whole thing goes.
const THINKING_LINE_RE = /^(the user (want|ask|need|is|said|just|has)|i (should|need to|will |am going|can see|must|notice|realize|understand|think|believe|know|want to|have to|can't|cannot|now see|am now|also need|would|may |might )|let me |my task|first,? i |looking at|based on (this|the|their|what)|now,? i |next,? i |this (shows|is a|seems|appears|means|tells|indicates|looks like)|but (i |this |that |it )|since (the |this |they |we )|so (i |this |the |it )|given (that|this|the)|therefore|however,? |actually,? |also,? i |i'll |i'm (going|now|not|also)|alright|okay,? (so|let|i|now)|wait,? |hmm|it (seems|looks|appears)|they (want|asked|need|are asking)|the (search (results?|shows?|returns?|doesn't|don't)|results? (don't|doesn't|show|seem|appear|indicate)|web results?|tool result|api result))/i;

export function stripReasoningPreamble(text) {
  const paragraphs = text.split(/\n\n+/);
  let i = 0;
  while (i < paragraphs.length) {
    const lines = paragraphs[i].split('\n').map(l => l.trim()).filter(Boolean);
    // Skip paragraph if its first line looks like model self-reasoning
    if (lines.length > 0 && THINKING_LINE_RE.test(lines[0])) {
      i++;
    } else {
      break;
    }
  }
  if (i === 0) return text; // nothing stripped
  return paragraphs.slice(i).join('\n\n').trimStart() || text;
}

/**
 * Build a synthetic user message that carries images returned by a tool
 * (browser_screenshot, image-gen previews, etc.) back into the LLM
 * context for the NEXT model turn. Each provider has its own vision
 * shape — Anthropic uses {type:'image', source:{type:'base64', ...}},
 * OpenAI uses image_url with a data URL, Ollama has a top-level `images`
 * array. Providers that don't support vision get a text-only fallback
 * describing what would have been attached.
 *
 * Returns a `messages`-array entry ready to push onto `working[]`.
 *
 * @param {string}  provider  agent.provider
 * @param {Array<{base64: string, mediaType: string}>} images
 * @param {string}  text      one-line caption ("Screenshot of <tab title>")
 */
export function buildImageUserMessage(provider, images, text) {
  const safeImages = (images || []).filter(i => i?.base64 && i?.mediaType);
  if (!safeImages.length) return { role: 'user', content: text };
  if (provider === 'anthropic') {
    return {
      role: 'user',
      content: [
        ...safeImages.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        })),
        { type: 'text', text },
      ],
    };
  }
  if (provider === 'ollama') {
    return { role: 'user', content: text, images: safeImages.map(i => i.base64) };
  }
  // OpenAI Chat-Completions + Responses API both accept image_url parts
  // in user messages. The Responses converter (chat/providers/openai-
  // responses.mjs toResponsesInput) reshapes image_url → input_image so
  // we don't need a separate branch here. LM Studio's /v1/chat/completions
  // accepts the same image_url shape (its tool path is the only caller;
  // the native /api/v1/chat path never carries tool images).
  const isOpenAiLike =
    provider === 'openai-oauth' || provider === 'openrouter' || provider === 'lmstudio' ||
    OPENAI_COMPAT_PROVIDERS[provider === 'grok' ? 'xai' : provider];
  if (isOpenAiLike) {
    return {
      role: 'user',
      content: [
        ...safeImages.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        })),
        { type: 'text', text },
      ],
    };
  }
  // Anything else: fall back to a text-only note. The LLM won't see the
  // pixels but at least won't crash on an unknown content shape, and will
  // know an image WOULD have been here.
  return { role: 'user', content: `${text}\n\n[${safeImages.length} image(s) attached but ${provider} doesn't accept vision input in this code path]` };
}

// ── Attachment normalization (multi-file chat wire) ──────────────────────────
// The composer's tray can hold several files, but chat entry points grew up
// around a single `attachment` object: ws-handler.mjs's incoming WS 'chat'
// frame, routes/telegram.mjs, scheduler.mjs / background-tasks.mjs / roles.mjs
// (ask_agent) internal turns, and third-party callers already living in this
// codebase (public/docs.js's "ask about this doc" send still puts a bare
// `attachment: {...}` on the wire). The wire now also accepts `attachments:
// [...]`. This is the ONE normalizer both shapes funnel through: chat-
// dispatch.mjs calls it once per turn (handleChatMessage) so every downstream
// consumer works with a plain array, and chat.mjs calls it again defensively
// inside streamChat, whose attachment-ish argument is still passed as a bare
// object (or null) by a dozen non-chat-dispatch call sites (background-tasks,
// skills/delegate, lib/mcp-outbound, lib/run-agent-with-retry). Lives here
// (not chat.mjs) so chat-dispatch.mjs can import it without pulling in chat.mjs
// — several guard tests (tests/chat-dispatch.test.mjs, tests/approval-pending-
// pill.test.mjs) replace chat.mjs's whole module with `{ streamChat }` only.
//
// Capped at MAX_CHAT_ATTACHMENTS so a malformed/hostile payload can't balloon
// a single turn's vision payload — the server-side twin of the composer's own
// cap in public/chat.js (see feedback_upload_caps_4_places: size/count caps
// necessarily live in more than one place; this is the count-cap's pair).
export const MAX_CHAT_ATTACHMENTS = 6;

/**
 * @param {Array<object>|null|undefined} attachments  new-shape array (wins when non-empty)
 * @param {object|null|undefined} attachment          legacy singular shape, wrapped when `attachments` is absent/empty
 * @returns {Array<object>} ordered, capped, plain-object-filtered attachment list — never null
 */
export function normalizeAttachments(attachments, attachment) {
  if (Array.isArray(attachments) && attachments.length) {
    return attachments.filter(a => a && typeof a === 'object').slice(0, MAX_CHAT_ATTACHMENTS);
  }
  if (attachment && typeof attachment === 'object') return [attachment];
  return [];
}
