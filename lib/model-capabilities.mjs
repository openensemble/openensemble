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
const GEMINI_VISION_RE = /\bgemini-(?:1\.5|2|pro-vision|2\.5|3)/i;
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
    case 'openai':
    case 'openai-oauth': return OPENAI_VISION_RE.test(id);
    case 'gemini':
    case 'google':       return GEMINI_VISION_RE.test(id);
    case 'ollama':       return OLLAMA_VISION_RE.test(id);
    case 'grok':
    case 'xai':          return GROK_VISION_RE.test(id);
    case 'fireworks':    return FIREWORKS_VISION_RE.test(id);
    case 'openrouter':   return OPENROUTER_VISION_RE.test(id);
    case 'perplexity':   return /\bsonar-(?:pro|reasoning|deep-research)/i.test(id); // Sonar-Pro takes images
    case 'lmstudio':     return false; // covered by `capabilities` above; otherwise unknown → no
    case 'builtin':      return false; // bundled reason/plan/embed are text-only
    default:             return false;
  }
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
    // xAI Agent Tools. The old `search_parameters` "Live Search" was retired
    // 2026-01-12 (410 Gone); the `web_search` server tool is the replacement.
    case 'grok':
    case 'xai':
      return { kind: 'openai-compat', tool: { type: 'web_search' } };
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
