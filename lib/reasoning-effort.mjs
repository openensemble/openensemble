const EFFORT_VALUES = ['auto', 'off', 'low', 'medium', 'high'];

const LABELS = {
  auto: 'Auto',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const DESCRIPTIONS = {
  auto: 'Use OE defaults for this provider/model.',
  off: 'Fastest. Disables or omits reasoning when the provider supports that.',
  low: 'Faster reasoning for simple requests.',
  medium: 'Balanced reasoning for normal tool use.',
  high: 'Most reliable for complex work and custom tool selection.',
};

export function normalizeReasoningEffort(value, fallback = 'auto') {
  const v = String(value ?? '').trim().toLowerCase();
  return EFFORT_VALUES.includes(v) ? v : fallback;
}

export function reasoningEffortOptions(provider, model) {
  const p = String(provider || '').toLowerCase();
  const id = String(model || '').toLowerCase();
  let values = ['auto'];

  if (p === 'openai-oauth') {
    values = ['auto', 'off', 'low', 'medium', 'high'];
  } else if (p === 'anthropic') {
    values = ['auto', 'low', 'medium', 'high'];
  } else if (p === 'openrouter') {
    values = ['auto', 'off', 'low', 'medium', 'high'];
  } else if (p === 'groq') {
    values = ['auto', 'low', 'medium', 'high'];
  } else if (p === 'grok' || p === 'xai' || p === 'xai-oauth') {
    values = ['auto', 'low', 'medium', 'high'];
  } else if (p === 'ollama' || p === 'lmstudio') {
    values = ['auto', 'off', 'high'];
  } else if (p === 'openai' && /\b(?:gpt-5|o[134]|o\d|reasoning)\b/.test(id)) {
    values = ['auto', 'low', 'medium', 'high'];
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
  // The Responses API has no 'none'/'off' effort. 'minimal' is the lowest valid
  // tier on gpt-5 / Codex models — use it for "off" so the user actually gets
  // the fastest setting instead of falling through to the model default.
  if (effort === 'off') return { effort: 'minimal' };
  return { effort };
}

export function applyAnthropicReasoning(body, agent) {
  const effort = effectiveReasoningEffort(agent, 'auto');
  if (effort === 'auto' || effort === 'off') return false;
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
    if (effort !== 'off') {
      body.reasoning_effort = effort;
      return true;
    }
    return false;
  }

  if (p === 'grok' || p === 'xai') {
    if (effort !== 'off') {
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

  return false;
}

export function isReasoningUnsupportedError(status, text) {
  return status >= 400 && status < 500
    && /\b(?:reasoning|reasoning_effort|effort|output_config|thinking)\b/i.test(String(text || ''));
}

export { EFFORT_VALUES };
