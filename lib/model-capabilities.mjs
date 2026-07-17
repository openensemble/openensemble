/**
 * Model capability classifier — single source of truth for "does this model
 * accept vision?" used both by the model-list API endpoints and any callsite
 * that needs to filter to vision-capable models (expense extraction, chat
 * upload routing, etc.).
 *
 * Per-provider heuristics:
 *   • LM Studio reports `capabilities: ['vision', ...]` on /models — trust it.
 *   • Anthropic: every Claude 3+ supports vision; classic claude-2 / older does not.
 *   • OpenAI / openai-oauth / OpenRouter: gpt-4o, gpt-4-vision, gpt-4-turbo with
 *     vision, gpt-5*, claude-* via OpenRouter, Llama-3.2-vision, gemini-pro-vision,
 *     gemini-1.5+. Match by name pattern.
 *   • Ollama (local + cloud): llava, bakllava, llama3.2-vision, qwen-vl, moondream,
 *     glm-4v, llama-vision, anything containing `-vision`/`-vl-`/`vlm`.
 *   • Bundled (built-in reason/embed): no vision.
 *   • Grok / Perplexity / Fireworks: small per-model lists.
 *
 * The list is intentionally a heuristic — it doesn't need to be perfect.
 * False negatives are recoverable (user picks a non-listed model); false
 * positives are recoverable (extraction fails with a clear provider error).
 */

const ANTHROPIC_VISION_RE = /\bclaude-(?:3|3-5|3-7|4|sonnet|haiku|opus)/i;
const OPENAI_VISION_RE = /\b(?:gpt-4o|gpt-4-vision|gpt-4(?:\.|-)?(?:5|6|7|8)|gpt-5|o1(?:-|$)|o3(?:-|$)|chatgpt-)/i;
// ChatGPT-login/Codex model list exposes input_modalities; these are the
// current visible models that report image input. gpt-5.3-codex-spark does not.
const OPENAI_OAUTH_VISION_RE = /^(?:gpt-5\.5|gpt-5\.4|gpt-5\.4-mini|codex-auto-review)$/i;
const GEMINI_VISION_RE = /\bgemini-(?:1\.5|2|pro-vision|2\.5|3)/i;
const OPENAI_IMAGE_GENERATION_RE = /^(?:gpt-5\.5|gpt-5\.4-(?:mini|nano)|gpt-5\.2|gpt-5|gpt-5-nano|o3|gpt-4\.1|gpt-4\.1-mini|gpt-4\.1-nano|gpt-4o|gpt-4o-mini)$/i;
// ChatGPT-login/Codex backend capability differs slightly from the public API
// list: gpt-5.4 accepts the hosted image_generation tool, while
// gpt-5.3-codex-spark explicitly rejects it. Live-verified 2026-07-01.
const OPENAI_OAUTH_IMAGE_GENERATION_RE = /^(?:gpt-5\.5|gpt-5\.4|gpt-5\.4-mini)$/i;
// Ollama vision-capable model name patterns. Cover both hyphenated
// (`gemma-3`) and unhyphenated (`gemma3`) variants since the user's local
// pulls follow whichever convention the upstream model author chose.
// `-vl[-:]?` catches qwen2-vl, qwen3-vl, qwen-2.5-vl, etc.
const OLLAMA_VISION_RE = /(?:^|[\W_])(?:llava|bakllava|moondream|qwen[\d.]*-?vl|llama-?3\.2-?vision|llama-?vision|glm-?4v|llava-llama3|llava-phi3|llama4|gemma-?3|gemma-?4|minicpm-?v|cogvlm|pixtral|vlm|-vision\b|-vl[-:]?\b)/i;
const GROK_VISION_RE = /\bgrok-(?:vision|2|3|4|5)/i;
const FIREWORKS_VISION_RE = /\b(?:llava|qwen2-vl|firellava|llama-3\.2-vision)/i;
const OPENROUTER_VISION_RE = /(?:vision|-vl[-:]?|-vl\b|claude-3|claude-4|claude-sonnet|claude-haiku|claude-opus|gpt-4o|gpt-5|o1\b|gemini-1\.5|gemini-2|llava|moondream|llama-?3\.2-vision)/i;

/**
 * @param {string} provider — slug like 'anthropic' | 'ollama' | 'openai' | 'openai-oauth' | 'openrouter' | 'lmstudio' | 'fireworks' | 'grok' | 'perplexity' | 'builtin'
 * @param {string} modelId — model id/name as listed by the provider
 * @param {{capabilities?: string[]}} [extra] — provider-supplied metadata, e.g. LM Studio's `capabilities` array
 * @returns {boolean}
 */
export function supportsVision(provider, modelId, extra = {}) {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  // Provider-supplied capability flag wins (LM Studio, future providers that
  // report this honestly). 'image_input', 'vision', 'multimodal' are the
  // flag names we've seen.
  const caps = (extra?.capabilities || []).map(c => String(c).toLowerCase());
  if (caps.some(c => c === 'vision' || c === 'image_input' || c === 'multimodal')) return true;

  switch (provider) {
    case 'anthropic':    return ANTHROPIC_VISION_RE.test(id);
    case 'openai':       return OPENAI_VISION_RE.test(id);
    case 'openai-oauth': return OPENAI_OAUTH_VISION_RE.test(id);
    case 'gemini':
    case 'google':       return GEMINI_VISION_RE.test(id);
    case 'ollama':       return OLLAMA_VISION_RE.test(id);
    case 'grok':
    case 'xai':
    case 'xai-oauth':    return GROK_VISION_RE.test(id);
    case 'fireworks':    return FIREWORKS_VISION_RE.test(id);
    case 'openrouter':   return OPENROUTER_VISION_RE.test(id);
    case 'perplexity':   return /\bsonar-(?:pro|reasoning|deep-research)/i.test(id); // Sonar-Pro takes images
    case 'lmstudio':     return false; // covered by `capabilities` above; otherwise unknown → no
    case 'builtin':      return false; // bundled reason/plan/embed are text-only
    default:             return false;
  }
}

/**
 * Whether this provider/model can produce image output.
 *
 * This is intentionally separate from supportsVision(), which means image input.
 * A text model may accept uploaded images but not generate images, and vice versa.
 *
 * @param {string} provider
 * @param {string} modelId
 * @param {{capabilities?: string[], output_modalities?: string[], tools?: string[]}} [extra]
 * @returns {boolean}
 */
export function supportsImageGeneration(provider, modelId, extra = {}) {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  const p = String(provider || '').toLowerCase();
  const caps = [
    ...(extra?.capabilities || []),
    ...(extra?.output_modalities || []),
    ...(extra?.tools || []),
  ].map(c => String(c).toLowerCase());
  if (caps.some(c => c === 'image_generation' || c === 'image_output' || c === 'text_to_image')) return true;

  switch (p) {
    case 'openai-oauth':
      return OPENAI_OAUTH_IMAGE_GENERATION_RE.test(id);
    case 'openai':
      return OPENAI_IMAGE_GENERATION_RE.test(id);
    case 'grok':
    case 'xai':
    case 'xai-oauth':
      return /\b(?:grok-imagine-image|grok-.*image|.*imagine.*image)/i.test(id);
    case 'fireworks':
      return /\b(?:flux|stable-diffusion|playground|ssd-1b|segmind|kontext)\b/i.test(id);
    default:
      return false;
  }
}

export function modelCapabilities(provider, modelId, extra = {}) {
  const caps = [];
  if (supportsVision(provider, modelId, extra)) caps.push('image_input');
  if (supportsImageGeneration(provider, modelId, extra)) caps.push('image_generation');
  return caps;
}

export function modelCapabilityPrompt(provider, modelId, extra = {}) {
  const caps = modelCapabilities(provider, modelId, extra);
  if (!caps.length) return '';
  const lines = [`You are running on \`${provider || 'unknown'}/${modelId || 'unknown'}\`.`];
  if (caps.includes('image_input')) {
    lines.push('- You can inspect and reason over image attachments sent by the user.');
  }
  if (caps.includes('image_generation')) {
    lines.push('- You can generate images directly. When the user asks you to create, draw, render, or edit an image, use image generation; do not claim you are text-only.');
  }
  return `## Current model capabilities\n\n${lines.join('\n')}`;
}

/**
 * Native (provider-hosted) web search descriptor.
 *
 * Some providers can search the web AND synthesize in a single inference call —
 * far faster than our local Brave `web_search` tool followed by a second
 * synthesis pass (which costs one provider round-trip per search). When an
 * agent already holds the `web_search` tool AND its provider/model can search
 * natively, the provider layer swaps the Brave function for the provider's
 * hosted tool so the model does search+synthesis in one round-trip.
 *
 * Returns null when there's no native path (→ keep the Brave tool), else a
 * descriptor telling the provider layer HOW to inject it. The `kind` selects
 * the injection shape; the per-provider tool shapes differ and are NOT
 * interchangeable, so this is a descriptor, not a boolean.
 *
 * Gating is intentional: we only swap when the agent was *already* granted
 * `web_search` — this makes existing searches faster, it never hands web access
 * to an agent that didn't have it. The provider layer enforces that check.
 *
 * Wired today: kind 'responses' (openai-oauth / Codex), verified live on
 * gpt-5.x. The other kinds describe how each remaining provider's adapter will
 * inject its tool (anthropic / openrouter / grok / ollama / perplexity) — they
 * are inert until that provider's file reads them.
 *
 * @param {string} provider — provider slug (see supportsVision)
 * @param {string} modelId  — model id as the provider lists it
 * @returns {null | { kind: string, tool?: object }}
 */
export function nativeWebSearch(provider, modelId) {
  const id = String(modelId || '').toLowerCase();
  switch (provider) {
    // ChatGPT Codex (Responses API). Hosted tool name is `web_search` — NOT
    // `web_search_preview`, which the Codex backend rejects with HTTP 400
    // "Unsupported tool type". Verified live against gpt-5.5 (real search ran,
    // returned a dated headline). Scoped to openai-oauth: plain 'openai' in OE
    // goes through the /chat/completions compat path, which can't take this.
    case 'openai-oauth':
      return /\bgpt-5/.test(id) ? { kind: 'responses', tool: { type: 'web_search' } } : null;
    // Anthropic Messages API server tool. The _20260209 variant (dynamic
    // filtering) needs Opus 4.6+ / Sonnet 4.6 / Fable; older Claude models take
    // the basic _20250305. No beta header required for either.
    case 'anthropic':
      return { kind: 'anthropic', tool: {
        type: /\bclaude-(?:opus-4-(?:6|7|8)|sonnet-4-6|fable)/.test(id) ? 'web_search_20260209' : 'web_search_20250305',
        name: 'web_search',
      } };
    // OpenRouter server tool — works across any tool-calling model it proxies.
    // (The older `:online` model suffix / `plugins:[{id:'web'}]` are deprecated.)
    case 'openrouter':
      return { kind: 'openai-compat', tool: { type: 'openrouter:web_search' } };
    // xAI grok: native web search lives ONLY on the Responses API
    // (`POST https://api.x.ai/v1/responses`, `{type:'web_search'}`) — NOT on
    // /chat/completions, where it's 410 Gone (live-verified 2026-06-28). So this
    // is a `responses`-kind descriptor, consumed by the shared Responses adapter
    // (chat/providers/openai-responses.mjs, which serves both Codex and grok).
    // `resolveNativeWebSearch` deliberately ignores `responses` kind so the
    // /chat/completions adapters (openai-compat) leave grok on Brave instead of
    // injecting a tool that endpoint rejects. Docs:
    // https://docs.x.ai/developers/tools/web-search
    case 'grok':
    case 'xai':
    case 'xai-oauth':
      return { kind: 'responses', tool: { type: 'web_search' } };
    // Ollama's hosted Web Search, exposed as a wired web_search/web_fetch tool.
    // The adapter must verify an Ollama cloud API key is present and the model
    // is a capable instruction-follower (cloud models, Qwen 3, Llama 3.1) —
    // bare local Ollama with no key cannot reach the search service.
    case 'ollama':
      return { kind: 'ollama-tool' };
    // Perplexity Sonar models are web-connected by construction — there is no
    // tool to inject; routing to a Sonar model IS the native path.
    case 'perplexity':
      return /\bsonar/.test(id) ? { kind: 'model-implicit' } : null;
    // openai-compat (fireworks / lmstudio / local ollama), gemini, builtin →
    // no native path; keep the Brave web_search tool.
    default:
      return null;
  }
}

/**
 * Apply the native-web-search swap to an agent's tool list for one provider.
 *
 * Single chokepoint so every provider adapter shares ONE gating rule: only swap
 * when the agent ALREADY holds our Brave `web_search` function (this makes an
 * existing search faster — it never grants new web access to an agent that
 * lacked it) AND the provider has a native path the adapter can actually inject.
 *
 * The adapter calls this with its tools in the internal
 * `{type:'function', function:{name}}` shape, converts the returned
 * `functionTools` to its own wire shape, then appends `nativeTool` (already in
 * the provider's shape) if present. Two native shapes exist:
 *   • injectable tool (anthropic / openrouter / grok) → `nativeTool` set, append it
 *   • model-implicit (perplexity Sonar searches by construction) → `nativeTool`
 *     is null; we just drop Brave so the model does its own search
 *
 * `ollama-tool` is deliberately NOT fulfilled here: it would need a bespoke
 * search-backend integration (route web_search to Ollama's hosted
 * /api/web_search) and is still tool→execute→synthesize — no round-trip saved —
 * so it stays on Brave. The descriptor is kept for if that's ever built.
 *
 * @param {string} provider — provider slug as the adapter knows itself ('anthropic','openrouter','xai','perplexity',…)
 * @param {string} modelId  — running model id
 * @param {Array}  tools    — agent.tools (internal function shape)
 * @param {{disabled?: boolean}} [opts] — disabled=true forces the Brave path; a
 *        provider's 400-fallback sets this to retry the same turn locally
 * @returns {{ useNative: boolean, functionTools: Array, nativeTool: object|null, kind: string|null }}
 */
export function resolveNativeWebSearch(provider, modelId, tools, { disabled = false } = {}) {
  const noop = { useNative: false, functionTools: tools, nativeTool: null, kind: null };
  if (disabled) return noop;
  const desc = nativeWebSearch(provider, modelId);
  if (!desc) return noop;
  // `responses` kind is a hosted tool for the Responses API only — it's consumed
  // directly by the Responses adapter (openai-responses.mjs), NOT by the
  // /chat/completions-style callers of this helper (anthropic/openrouter/
  // openai-compat), which can't inject it. Leave their tools on Brave.
  // `ollama-tool` needs a bespoke search-backend integration (no round-trip
  // saved) — also not fulfilled here.
  if (desc.kind === 'responses' || desc.kind === 'ollama-tool') return { ...noop, kind: desc.kind };
  const holdsBrave = tools?.some(t => (t.function?.name ?? t.name) === 'web_search');
  if (!holdsBrave) return { ...noop, kind: desc.kind };
  const functionTools = tools.filter(t => (t.function?.name ?? t.name) !== 'web_search');
  return { useNative: true, functionTools, nativeTool: desc.tool ?? null, kind: desc.kind };
}
