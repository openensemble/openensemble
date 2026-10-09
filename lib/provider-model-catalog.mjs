import { createHash } from 'node:crypto';
import { normalizeModelMetadata } from './model-metadata.mjs';
import { enrichGeminiModelMetadata } from './gemini-model-metadata.mjs';

const detailCache = new Map();
const pending = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

export async function fetchModelCatalog(url, { headers = {}, timeoutMs = 15000, ...options } = {}) {
  const response = await fetch(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`Model catalog HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function annotateProviderModel(provider, value, source) {
  const raw = typeof value === 'string' ? { id: value } : { ...value };
  // Hosted API limits are usable limits. Local model maximums can exceed the
  // context configured for a running instance, so keep those separate.
  if (provider === 'anthropic') raw.context_window ??= raw.max_input_tokens;
  if (provider === 'gemini') raw.context_window ??= raw.inputTokenLimit;
  if (provider === 'mistral') raw.context_window ??= raw.max_context_length;
  const metadata = normalizeModelMetadata(raw);
  return { ...raw, modelMetadata: { ...metadata,
    sources: [...new Set([...metadata.sources, source].filter(Boolean))],
    fetchedAt: metadata.fetchedAt ?? Date.now(),
  } };
}

async function cachedDetail(key, load, { refresh = false } = {}) {
  const prior = detailCache.get(key);
  if (!refresh && prior && Date.now() - prior.checkedAt < (prior.failed ? 60_000 : TTL_MS)) return prior.value;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    try {
      const value = await load();
      if (detailCache.size >= 2048) detailCache.clear();
      detailCache.set(key, { value, checkedAt: Date.now() });
      return value;
    } catch (error) {
      if ([401, 403].includes(error.status)) throw error;
      if (!prior) {
        detailCache.set(key, { value: null, failed: true, checkedAt: Date.now() });
        throw error;
      }
      detailCache.set(key, { ...prior, failed: true, checkedAt: Date.now() });
      return prior.value;
    }
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}

function connectionKey(url, headers) {
  return `${url}:${createHash('sha256').update(JSON.stringify(headers)).digest('hex')}`;
}

export async function readAnthropicModelCatalog(headers) {
  const models = [];
  const cursors = new Set();
  let after = null;
  do {
    const url = `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const data = await fetchModelCatalog(url, { headers });
    models.push(...(data.data ?? []).map(model => annotateProviderModel('anthropic', model, 'https://api.anthropic.com/v1/models')));
    after = data.has_more ? data.last_id : null;
    if (after && cursors.has(after)) throw new Error('Anthropic model catalog repeated its pagination cursor');
    if (after) cursors.add(after);
  } while (after && cursors.size < 10);
  if (after) throw new Error('Anthropic model catalog exceeded its page limit');
  return models;
}

export async function readOpenRouterModelCatalog(headers) {
  const url = 'https://openrouter.ai/api/v1/models';
  const data = await fetchModelCatalog(url, { headers });
  return (data.data ?? []).map(model => annotateProviderModel('openrouter', model, url));
}

export async function readGrokModelCatalog(headers) {
  let url = 'https://api.x.ai/v1/language-models';
  let data;
  try { data = await fetchModelCatalog(url, { headers }); }
  catch (error) {
    if ([401, 403].includes(error.status)) throw error;
    url = 'https://api.x.ai/v1/models';
    data = await fetchModelCatalog(url, { headers });
  }
  return (data.models ?? data.data ?? []).map(model => annotateProviderModel('grok', model, url));
}

export async function readOpenRouterModelEndpoints(modelId, headers, options = {}) {
  if (typeof modelId !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.:+-]+$/i.test(modelId)) return null;
  const url = `https://openrouter.ai/api/v1/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`;
  return cachedDetail(connectionKey(url, headers), async () => {
    const data = (await fetchModelCatalog(url, { headers, timeoutMs: 5000 })).data;
    if (!Array.isArray(data?.endpoints)) throw new Error('OpenRouter endpoint metadata is missing');
    return { source: url, fetchedAt: Date.now(), endpoints: data.endpoints.map(endpoint => ({
      provider: endpoint.provider_name ?? endpoint.name,
      ...(endpoint.tag ? { tag: endpoint.tag } : {}),
      ...(endpoint.quantization ? { quantization: endpoint.quantization } : {}),
      ...normalizeModelMetadata(endpoint),
    })) };
  }, options);
}

export async function readGeminiModelCatalog(apiKey, { refresh = false } = {}) {
  const source = 'https://generativelanguage.googleapis.com/v1beta/models';
  const headers = { 'x-goog-api-key': apiKey };
  // Native metadata is richer than Google's OpenAI-compatible model list.
  const models = [];
  const tokens = new Set();
  let token = null;
  do {
    const url = `${source}?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const data = await fetchModelCatalog(url, { headers });
    for (const model of data.models ?? []) {
      const id = String(model.name ?? '').replace(/^models\//, '');
      if (!id) continue;
      models.push(annotateProviderModel('gemini', { ...model, id,
        // This controls chat selection without disguising embeddings or media
        // models as text models. The full catalog metadata remains available.
        ...(Array.isArray(model.supportedGenerationMethods) ? {
          textModelKnown: true,
          textModel: model.supportedGenerationMethods.some(method => ['generateContent', 'streamGenerateContent'].includes(method)),
        } : {}),
      }, source));
    }
    token = data.nextPageToken ?? null;
    if (token && tokens.has(token)) throw new Error('Gemini model catalog repeated its pagination token');
    if (token) tokens.add(token);
  } while (token && tokens.size < 10);
  if (token) throw new Error('Gemini model catalog exceeded its page limit');
  return enrichGeminiModelMetadata(models, { refresh });
}

export async function enrichOllamaModelCatalog(base, headers, models, options = {}) {
  const url = `${base.replace(/\/+$/, '')}/api/show`;
  const results = [];
  for (let offset = 0; offset < models.length; offset += 12) {
    results.push(...await Promise.all(models.slice(offset, offset + 12).map(async model => {
      const id = model.name ?? model.id;
      let shown = {};
      try {
        shown = await cachedDetail(`${connectionKey(url, headers)}:${id}:${model.digest ?? ''}`, async () => {
          try {
            const data = await fetchModelCatalog(url, { method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: id }), timeoutMs: 4000 });
            // /show also contains templates, licenses and tokenizer arrays.
            // Those are not capability metadata and must never enter the cache.
            return { ...(data.capabilities ? { capabilities: data.capabilities } : {}),
              ...(data.details ? { details: data.details } : {}),
              model_info: Object.fromEntries(Object.entries(data.model_info ?? {})
                .filter(([key]) => key === 'general.architecture' || key.endsWith('.context_length'))),
              ...(data.thinking ? { thinking: data.thinking } : {}), fetchedAt: Date.now() };
          } catch (error) {
            if ([404, 410].includes(error.status)) return { retired: true };
            throw error;
          }
        }, options) ?? {};
      } catch { /* Keep the catalog item; absent detail remains unknown. */ }
      if (shown.retired && (model.remote_host || /[:-]cloud$/.test(id))) return null;
      const detail = { ...model, ...shown };
      const caps = Array.isArray(detail.capabilities) ? detail.capabilities : null;
      const thinking = caps?.includes('thinking');
      const gptOss = detail.details?.family === 'gptoss' || /(?:^|[/_-])gpt-?oss(?:$|[:/_-])/i.test(id);
      return annotateProviderModel('ollama', { ...detail, id,
        textModelKnown: true, textModel: caps?.includes('completion') ?? false,
        ...(caps ? { supportsVision: caps.includes('vision'),
          supports_function_calling: caps.includes('tools'), supports_thinking: thinking } : {}),
        reasoningCapabilitiesKnown: true,
        supportedReasoningLevels: thinking ? (gptOss ? ['low', 'medium', 'high'] : ['off', 'high']) : [],
      }, url);
    })));
  }
  return results.filter(Boolean);
}

export async function readLmstudioModelCatalog(base, headers = {}) {
  const root = base.replace(/\/+$/, '');
  const native = `${root}/api/v1/models`;
  try {
    const data = await fetchModelCatalog(native, { headers, timeoutMs: 4000 });
    return (data.models ?? []).filter(model => !model.type || model.type === 'llm')
      .map(model => annotateProviderModel('lmstudio', { ...model, id: model.key ?? model.id }, native));
  } catch (error) {
    if ([401, 403].includes(error.status)) throw error;
    const compat = `${root}/v1/models`;
    const data = await fetchModelCatalog(compat, { headers, timeoutMs: 4000 });
    return (data.data ?? []).filter(model => !/^text-embedding-/i.test(model.id))
      .map(model => annotateProviderModel('lmstudio', model, compat));
  }
}

export function clearProviderModelDetailCache() { detailCache.clear(); pending.clear(); }
