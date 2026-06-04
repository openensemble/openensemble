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
export const LMSTUDIO_NATIVE  = 'http://127.0.0.1:1234/api/v1/chat';         // stateful, no history overhead
export const LMSTUDIO_COMPAT  = 'http://127.0.0.1:1234/v1/chat/completions'; // OpenAI compat, used for tool calls
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
  // we don't need a separate branch here.
  const isOpenAiLike =
    provider === 'openai-oauth' || provider === 'openrouter' ||
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
  // LM Studio + anything else: fall back to a text-only note. The LLM
  // won't see the pixels but at least won't crash on an unknown content
  // shape, and will know an image WOULD have been here.
  return { role: 'user', content: `${text}\n\n[${safeImages.length} image(s) attached but ${provider} doesn't accept vision input in this code path]` };
}
