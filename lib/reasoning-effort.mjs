import { isGrokMultiAgentModel } from './provider-model-protocol.mjs';

const EFFORT_VALUES = ['auto', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const LABELS = {
  auto: 'Auto',
  off: 'Off',
  on: 'On',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

const DESCRIPTIONS = {
  auto: 'Use OE defaults for this provider/model.',
  off: 'Fastest. Disables or omits reasoning when the provider supports that.',
  on: 'Enable the model-defined reasoning mode.',
  none: 'Use no reasoning tokens when the provider exposes a none level.',
  minimal: 'Smallest provider-supported reasoning budget.',
  low: 'Faster reasoning for simple requests.',
  medium: 'Balanced reasoning for normal tool use.',
  high: 'Most reliable for complex work and custom tool selection.',
  xhigh: 'Extra reasoning depth for long-horizon, difficult work.',
  max: 'Maximum advertised reasoning depth for the hardest work.',
  ultra: 'Maximum reasoning with model-managed delegation when supported.',
};

export function normalizeReasoningEffort(value, fallback = 'auto') {
  const v = String(value ?? '').trim().toLowerCase();
  return isReasoningEffortValue(v) ? v : fallback;
}

export function isReasoningEffortValue(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

function advertisedEffortValues(advertisedLevels) {
  let entries = advertisedLevels;
  if (typeof entries === 'string') entries = entries.split(/[\s,]+/);
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    const nested = entries.values ?? entries.levels ?? entries.efforts ?? entries.supported;
    if (nested !== undefined && nested !== entries
        && (Array.isArray(nested) || typeof nested === 'string'
          || (nested && typeof nested === 'object'))) {
      return advertisedEffortValues(nested);
    }
    entries = Object.entries(entries)
      // Capability containers commonly carry their own `supported` flag.
      // It describes the feature, not an effort level.
      .filter(([value, enabled]) => value !== 'supported'
        && (enabled === true
          || (enabled && typeof enabled === 'object' && enabled.supported === true)))
      .map(([value]) => value);
  }
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const values = [];
  for (const entry of entries.slice(0, 64)) {
    const value = String(
      typeof entry === 'string'
        ? entry
        : entry?.effort ?? entry?.value ?? entry?.id ?? entry?.slug ?? entry?.name ?? '',
    ).trim().toLowerCase();
    if (!isReasoningEffortValue(value) || value === 'auto' || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

export function reasoningEffortOptions(provider, model, advertisedLevels = null) {
  const p = String(provider || '').toLowerCase();
  const id = String(model || '').toLowerCase();
  let values = ['auto'];
  const advertisedProvided = advertisedLevels !== null && advertisedLevels !== undefined;
  const advertised = advertisedEffortValues(advertisedLevels);

  if (advertisedProvided) {
    values = ['auto', ...advertised];
  } else if (p === 'openai-oauth') {
    if (/^gpt-5\.6-(?:sol|terra)(?:$|[-:])/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    } else if (/^gpt-5\.6-luna(?:$|[-:])/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    } else if (/^gpt-5\.3-codex(?:-spark)?(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh'];
    } else if (/^gpt-5\.[45](?:$|[-:])/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh'];
    }
  } else if (p === 'grok' || p === 'xai' || p === 'xai-oauth') {
    values = isGrokMultiAgentModel(id)
      ? ['auto', 'low', 'medium', 'high', 'xhigh']
      : (/^grok-4\.6(?:$|[-:])/.test(id)
        ? ['auto', 'low', 'medium', 'high', 'xhigh']
        : (/^grok-4\.3(?:$|[-:])/.test(id)
          ? ['auto', 'none', 'low', 'medium', 'high']
          : (/^grok-4\.5(?:$|[-:])/.test(id)
        ? ['auto', 'low', 'medium', 'high']
        : ['auto'])));
  } else if (p === 'ollama' || p === 'ollama-local') {
    values = /(?:^|[/_-])gpt-?oss(?:$|[:/_-])/.test(id)
      ? ['auto', 'low', 'medium', 'high']
      : ['auto'];
  } else if (p === 'anthropic') {
    // Anthropic's /v1/models response does not consistently expose effort
    // metadata. Keep this fallback restricted to documented effort-capable
    // families; explicit catalog metadata above remains authoritative.
    if (/^claude-(?:(?:fable|mythos)-5(?:-1)?|opus-(?:5|4[-.][78])|sonnet-5)(?:$|-)/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    } else if (/^claude-(?:mythos-preview|opus-4[-.]6|sonnet-4[-.]6)(?:$|-)/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'max'];
    } else if (/^claude-opus-4[-.]5(?:$|-)/.test(id)) {
      values = ['auto', 'low', 'medium', 'high'];
    }
  } else if (p === 'perplexity' && /sonar-(?:reasoning|deep-research)/.test(id)) {
    values = ['auto', 'minimal', 'low', 'medium', 'high'];
  } else if (p === 'openai') {
    if (/^gpt-5\.6-(?:sol|terra|luna)(?:$|[-:])/.test(id)) {
      values = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
    } else if (/^gpt-6-astra(?:$|[-:])/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    } else if (/^gpt-5\.3-codex(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
      values = ['auto', 'low', 'medium', 'high', 'xhigh'];
    } else if (/^gpt-5-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
      values = ['auto', 'high'];
    } else if (/^gpt-5\.(?:2|4|5)-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
      values = ['auto', 'medium', 'high', 'xhigh'];
    } else if (/^gpt-5\.(?:2|4|5)(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)
        || /^gpt-5\.4-(?:mini|nano)(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
      values = ['auto', 'none', 'low', 'medium', 'high', 'xhigh'];
    } else if (/^gpt-5\.1(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
      values = ['auto', 'none', 'low', 'medium', 'high'];
    } else if (/^gpt-5(?:$|-\d{4}-\d{2}-\d{2}$|-(?:mini|nano)(?:$|-\d{4}-\d{2}-\d{2}$))/.test(id)) {
      values = ['auto', 'minimal', 'low', 'medium', 'high'];
    } else if (/^o[134](?:$|[-:])/.test(id)) {
      values = ['auto', 'low', 'medium', 'high'];
    }
  }

  return values.map(value => ({
    value,
    label: LABELS[value] || value,
    description: DESCRIPTIONS[value] || '',
  }));
}

export function effectiveReasoningEffort(agent, fallback = 'auto') {
  return normalizeReasoningEffort(agent?.reasoningEffort, fallback);
}

export function mapOpenAIResponsesReasoning(agent) {
  const effort = effectiveReasoningEffort(agent, 'auto');
  if (effort === 'auto') return { effort: 'high' };
  // The Codex model catalog exposes Ultra as an OE/CLI orchestration tier, but
  // the underlying Responses endpoint accepts `max` as its highest wire value.
  // Keep Ultra selectable while making the transport translation observable in
  // the model-call trace (requested `ultra`, wire `max`).
  if (agent?.provider === 'openai-oauth' && effort === 'ultra') return { effort: 'max' };
  // Explicit execution targets are validated against the exact provider/model
  // catalog. Preserve the advertised slug verbatim so a future provider level
  // is never silently weakened or translated after validation.
  if (agent?._executionEffortLocked === true) return { effort };
  // The Responses API has no 'none'/'off' effort. 'minimal' is the lowest valid
  // tier on gpt-5 / Codex models — use it for "off" so the user actually gets
  // the fastest setting instead of falling through to the model default.
  if (effort === 'off') return { effort: 'minimal' };
  return { effort };
}

export function applyAnthropicReasoning(body, agent) {
  const effort = effectiveReasoningEffort(agent, 'auto');
  if (effort === 'auto' || (effort === 'off' && agent?._executionEffortLocked !== true)) return false;
  body.output_config = { ...(body.output_config || {}), effort };
  return true;
}

export function applyOpenAICompatReasoning(body, provider, agent) {
  const effort = effectiveReasoningEffort(agent, 'auto');
  if (effort === 'auto') return false;

  const p = String(provider || '').toLowerCase();
  const model = String(agent?.model || '').toLowerCase();

  if (p === 'openrouter') {
    if (effort === 'off') body.reasoning = { enabled: false };
    else body.reasoning = { effort };
    return true;
  }

  if (p === 'groq') {
    if (effort !== 'off' || agent?._executionEffortLocked === true) {
      body.reasoning_effort = effort;
      return true;
    }
    return false;
  }

  if (p === 'grok' || p === 'xai') {
    if (effort !== 'off' || agent?._executionEffortLocked === true) {
      body.reasoning_effort = effort;
      return true;
    }
    return false;
  }

  if (p === 'openai' && /\b(?:gpt-5|o[134]|o\d|reasoning)\b/.test(model)) {
    if (effort !== 'off') {
      body.reasoning_effort = effort;
      return true;
    }
  }

  // Catalog-backed compatible providers can advertise levels OE has never
  // seen. Forward the saved slug conventionally; unlocked durable agents still
  // retain the adapter's bounded retry-without-effort self-heal on rejection.
  body.reasoning_effort = effort;
  return true;
}

export function isReasoningUnsupportedError(status, text) {
  return status >= 400 && status < 500
    && /\b(?:reasoning|reasoning_effort|effort|output_config|thinking)\b/i.test(String(text || ''));
}

export { EFFORT_VALUES, advertisedEffortValues };
