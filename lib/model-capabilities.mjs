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
