/** Provider-advertised model metadata. Missing fields remain unknown. */

export const MODEL_METADATA_VERSION = 2;

const ALIASES = {
  vision: 'image_input', multimodal: 'image_input',
  tool_use: 'function_calling', tool_calling: 'function_calling', tools: 'function_calling',
  trained_for_tool_use: 'function_calling',
  text_to_image: 'image_generation',
};

function name(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[- ]/g, '_');
  return /^[a-z][a-z0-9_:./]{0,100}$/.test(key) ? (ALIASES[key] ?? key) : null;
}

function names(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.slice(0, 256).map(item => name(typeof item === 'string'
    ? item : item?.type ?? item?.name ?? item?.id)).filter(Boolean))];
}

function flag(value) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object') {
    if (typeof value.supported === 'boolean') return value.supported;
    if (typeof value.enabled === 'boolean') return value.enabled;
  }
  return null;
}

// Retain structured capability declarations, not descriptions or model prompts.
function declarations(value, depth = 0) {
  if (depth > 5) return undefined;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return value.length <= 150 ? value : undefined;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => declarations(item, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 128)
    .filter(([key]) => /^[a-z][a-z0-9_]*$/i.test(key) && !/description|prompt|template|tokenizer|secret|key$/i.test(key))
    .map(([key, item]) => [key, declarations(item, depth + 1)]).filter(([, item]) => item !== undefined));
}

function stringList(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string'
    && /^[a-z][a-z0-9_.:-]{0,100}$/i.test(item)).slice(0, 256))] : null;
}

export function normalizeModelMetadata(value = {}) {
  const raw = value?.modelMetadata ?? value ?? {};
  const support = {};
  const add = (key, enabled) => {
    const clean = name(key);
    if (clean && typeof enabled === 'boolean') support[clean] = enabled;
  };
  const caps = raw.capabilities;
  if (Array.isArray(caps)) {
    for (const key of names(caps)) add(key, true);
  } else if (caps && typeof caps === 'object') {
    for (const [key, enabled] of Object.entries(caps).slice(0, 256)) add(key, flag(enabled));
  }
  const inputModalities = names(raw.inputModalities ?? raw.input_modalities
    ?? raw.architecture?.input_modalities ?? raw.modalities?.input);
  const outputModalities = names(raw.outputModalities ?? raw.output_modalities
    ?? raw.architecture?.output_modalities ?? raw.modalities?.output);
  const supportedTools = names(raw.supportedTools ?? raw.supported_tools ?? raw.tools);
  const supportedFeatures = names(raw.supportedFeatures ?? raw.supported_features);
  const supportedParameters = stringList(raw.supportedParameters ?? raw.supported_parameters);
  const supportedMethods = stringList(raw.supportedMethods ?? raw.supportedGenerationMethods);
  const declared = { ...(caps && !Array.isArray(caps) ? caps : {}),
    ...(raw.native_tools ? { native_tools: raw.native_tools } : {}),
    ...(raw.supports_tool_choice ? { tool_choice: raw.supports_tool_choice } : {}),
    ...(raw.thinking && typeof raw.thinking === 'object' ? { thinking: raw.thinking } : {}),
  };
  const details = declarations(raw.capabilityDetails ?? (Object.keys(declared).length ? declared : null));
  // Anthropic distinguishes execution as a platform feature from the hosted
  // code tool. Preserve both, including nested thinking/context strategies.
  const walk = (value, prefix = '', depth = 0) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'supported' || key === 'enabled') continue;
      const qualified = prefix ? `${prefix}.${key}` : key;
      add(qualified, flag(item));
      walk(item, qualified, depth + 1);
    }
  };
  walk(details);
  if (details?.server_tools) {
    const permitted = flag(details.server_tools) !== false;
    const search = flag(details.server_tools.web_search);
    if (search !== null) add('web_search', permitted && search);
    const code = flag(details.server_tools.code_execution);
    if (code !== null) add('hosted_code_execution', permitted && code);
  }
  if (supportedParameters) {
    add('function_calling', supportedParameters.includes('tools'));
    add('structured_outputs', supportedParameters.includes('structured_outputs'));
    add('json_output', supportedParameters.includes('response_format'));
    add('reasoning', supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort'));
  }
  add('thinking', flag(raw.thinking));
  for (const key of supportedFeatures ?? []) add(key, true);
  for (const key of names(raw.unsupported_features) ?? []) add(key, false);
  for (const key of supportedTools ?? []) add(key, true);
  if (inputModalities) {
    for (const modality of new Set(['text', 'image', 'audio', 'video', ...inputModalities])) add(`${modality}_input`, inputModalities.includes(modality));
  }
  if (outputModalities) {
    for (const modality of new Set(['text', 'image', 'audio', 'video', ...outputModalities])) add(`${modality}_output`, outputModalities.includes(modality));
  }
  // Tool lists describe hosted tools, independently of the model's text output.
  if (supportedTools) {
    if (!Object.hasOwn(support, 'image_generation')) add('image_generation', outputModalities?.includes('image') ?? false);
    if (!Object.hasOwn(support, 'web_search')) add('web_search', false);
  }
  if (raw.web_search_tool_type) add('web_search', true);
  if (raw.apply_patch_tool_type) add('apply_patch', true);
  const booleans = {
    supportsVision: 'image_input', supports_vision: 'image_input',
    supportsImageGeneration: 'image_generation', supports_image_generation: 'image_generation',
    supports_image_editing: 'image_editing', supports_search_tool: 'web_search',
    supports_parallel_tool_calls: 'parallel_tool_calls',
    supports_image_detail_original: 'image_detail_original',
    supports_reasoning_summaries: 'reasoning_summaries',
    supports_reasoning_effort_updates: 'reasoning_effort_updates',
  };
  for (const [key, capability] of Object.entries(booleans)) add(capability, flag(raw[key]));
  for (const [key, enabled] of Object.entries(raw).slice(0, 256)) {
    if (/^supports?_/.test(key) && !Object.hasOwn(booleans, key)) add(key.replace(/^supports?_/, ''), flag(enabled));
  }
  // An explicit denial wins if a catalog also lists the same tool or modality.
  if (caps && !Array.isArray(caps) && typeof caps === 'object') {
    for (const [key, enabled] of Object.entries(caps).slice(0, 256)) {
      if (flag(enabled) === false) add(key, false);
    }
  }
  for (const key of names(raw.unsupported_features) ?? []) add(key, false);
  // A normalized record retains explicit denials across cache reloads.
  for (const [key, enabled] of Object.entries(raw.capabilitySupport ?? {}).slice(0, 256)) add(key, flag(enabled));
  const sources = Array.isArray(raw.sources) ? raw.sources.filter(item => typeof item === 'string').slice(0, 8) : [];
  const limits = {};
  const architecture = raw.model_info?.['general.architecture'];
  const localMaximum = typeof architecture === 'string' ? raw.model_info?.[`${architecture}.context_length`] : undefined;
  const loadedLimits = (raw.loaded_instances ?? []).map(instance => instance?.config?.context_length).filter(n => Number.isSafeInteger(n) && n > 0);
  for (const [key, candidates] of Object.entries({
    contextWindow: [raw.contextLen, raw.context_window, raw.context_length, loadedLimits.length ? Math.min(...loadedLimits) : undefined, raw.limits?.contextWindow],
    maxContextWindow: [raw.max_context_window, raw.max_context_length, localMaximum, raw.limits?.maxContextWindow],
    maxInputTokens: [raw.max_input_tokens, raw.max_prompt_tokens, raw.inputTokenLimit, raw.limits?.maxInputTokens],
    maxOutputTokens: [raw.max_output_tokens, raw.max_tokens, raw.max_completion_tokens, raw.outputTokenLimit, raw.top_provider?.max_completion_tokens, raw.limits?.maxOutputTokens],
  })) {
    const limit = candidates.find(n => Number.isSafeInteger(n) && n > 0);
    if (limit) limits[key] = limit;
  }
  return {
    version: MODEL_METADATA_VERSION, capabilitySupport: support,
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(supportedTools ? { supportedTools } : {}),
    ...(supportedFeatures ? { supportedFeatures } : {}),
    ...(supportedParameters ? { supportedParameters } : {}),
    ...(supportedMethods ? { supportedMethods } : {}),
    ...(details ? { capabilityDetails: details } : {}),
    ...(raw.reasoning && typeof raw.reasoning === 'object' ? { reasoning: declarations(raw.reasoning) } : {}),
    ...(raw.endpoints && Array.isArray(raw.endpoints) ? { endpoints: raw.endpoints.slice(0, 128).map(endpoint => declarations(endpoint)) } : {}),
    ...(Number.isSafeInteger(raw.fetchedAt) ? { fetchedAt: raw.fetchedAt } : {}),
    limits, sources,
  };
}

/** Account/provider declarations take precedence over public documentation. */
export function mergeModelMetadata(fallback, advertised) {
  const lower = normalizeModelMetadata(fallback);
  const upper = normalizeModelMetadata(advertised);
  return {
    ...lower, ...upper,
    capabilitySupport: { ...lower.capabilitySupport, ...upper.capabilitySupport },
    ...((lower.capabilityDetails || upper.capabilityDetails) ? {
      capabilityDetails: { ...lower.capabilityDetails, ...upper.capabilityDetails },
    } : {}),
    limits: { ...lower.limits, ...upper.limits },
    sources: [...new Set([...lower.sources, ...upper.sources])],
  };
}

export function modelCapabilityState(extra, capability) {
  return normalizeModelMetadata(extra).capabilitySupport[capability] ?? null;
}
