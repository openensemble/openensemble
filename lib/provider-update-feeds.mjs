/** Public feeds supply proposals only. No credentials or chat data leave OE here. */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const FILE = path.join(BASE_DIR, 'config', 'provider-update-feeds.json');
const TTL = 6 * 60 * 60_000;
export const PROVIDER_FEEDS = Object.freeze({
  modelsdev: 'https://models.dev/api.json',
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/llms/openai_like/providers.json',
});
let cache;
let pending;
let attemptedAt = 0;
let timer;

export function startProviderFeedRefresh() {
  if (timer) return;
  void refreshProviderFeeds();
  timer = setInterval(() => { void refreshProviderFeeds(); }, TTL);
  timer.unref();
}

export async function readBoundedJson(response, limit = 24 * 1024 * 1024) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Response exceeded size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Response exceeded size limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function readCache() {
  if (cache) return cache;
  try {
    if (fs.statSync(FILE).size <= 2 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (saved.version === 1 && saved.sources && saved.data) cache = saved;
    }
  } catch { /* First run or invalid cache. */ }
  return cache ??= { version: 1, sources: {}, data: {} };
}

function normalize(source, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid feed structure');
  const entries = Object.entries(data);
  if (!entries.length || entries.length > 5000) throw new Error('Invalid provider count');
  const result = {};
  for (const [id, row] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) || !row || typeof row !== 'object') continue;
    if (source === 'modelsdev') {
      if (!row.models || typeof row.models !== 'object' || Array.isArray(row.models)) continue;
      result[id] = {
        baseUrl: typeof row.api === 'string' ? row.api.slice(0, 500) : null,
        compatible: /openai-compatible/.test(row.npm ?? ''),
        modelCount: Object.keys(row.models).length,
      };
    } else if (typeof row.base_url === 'string' && row.base_url.length <= 500) {
      const mappings = row.param_mappings ?? {};
      result[id] = {
        baseUrl: row.base_url,
        mappings,
        // Unknown transformations stay visible for an adapter update; never execute them.
        unsupported: (row.base_class != null && !['openai_gpt', 'openai_like'].includes(row.base_class))
          || Object.keys(row).some(key => !['base_url', 'api_key_env', 'api_base_env', 'base_class', 'param_mappings', 'supported_endpoints'].includes(key)),
      };
    }
  }
  if (!Object.keys(result).length) throw new Error('Feed contained no valid providers');
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('Feed registry exceeded size limit');
  return result;
}

export async function refreshProviderFeeds({ force = false } = {}) {
  const current = readCache();
  if (pending) return pending;
  const due = Object.keys(PROVIDER_FEEDS).some(key => Date.now() - (current.sources[key]?.checkedAt || 0) > TTL);
  if ((!force && !due) || (attemptedAt && Date.now() - attemptedAt < 60_000)) return current;
  attemptedAt = Date.now();
  pending = (async () => {
    await Promise.all(Object.entries(PROVIDER_FEEDS).map(async ([source, url]) => {
      try {
        const response = await fetch(url, { redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        const data = normalize(source, await readBoundedJson(response));
        current.data[source] = data;
        current.sources[source] = { checkedAt: Date.now(), status: 'available', providers: Object.keys(data).length };
      } catch {
        current.sources[source] = { ...current.sources[source], checkedAt: Date.now(), status: 'unavailable',
          message: 'Update feed unavailable or invalid. Previous feed data retained.' };
      }
    }));
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      atomicWriteSync(FILE, JSON.stringify(current), { mode: 0o600 });
    } catch { console.warn('[provider-updates] Could not cache update feeds.'); }
    return current;
  })().finally(() => { pending = null; });
  return pending;
}

export function providerFeedStatus() { return readCache().sources; }

/** Built-in origin and protocol remain authoritative. Feeds cannot add providers. */
export async function proposedProviderCompatibility(provider, cfg, current, { refresh = false } = {}) {
  const data = (refresh ? await refreshProviderFeeds({ force: true }) : readCache()).data;
  const alias = { together: 'togetherai', gemini: 'google', grok: 'xai' }[provider] || provider;
  const lite = data.litellm?.[provider];
  const metadata = data.modelsdev?.[alias];
  const entry = lite ?? (metadata?.compatible ? metadata : null);
  if (!entry?.baseUrl) return null;
  const source = lite ? 'LiteLLM' : 'Models.dev';
  const configuredEndpoint = `${cfg.baseUrl.replace(/\/$/, '')}${cfg.chatEndpoint || '/chat/completions'}`;
  const proposal = { ...current, endpoint: `${entry.baseUrl.replace(/\/$/, '')}${cfg.chatEndpoint || '/chat/completions'}` };
  const mappings = entry.mappings ?? {};
  const knownMappings = { max_tokens: 'max_completion_tokens', max_completion_tokens: 'max_tokens' };
  let unsupported = entry.unsupported || Object.entries(mappings).some(([key, value]) => knownMappings[key] !== value);
  if (mappings.max_tokens === 'max_completion_tokens') proposal.useMaxCompletionTokens = true;
  if (mappings.max_completion_tokens === 'max_tokens') proposal.useMaxCompletionTokens = false;
  try {
    const target = new URL(proposal.endpoint), trusted = new URL(configuredEndpoint);
    if (target.origin !== trusted.origin || target.username || target.password || target.search || target.hash
      || target.protocol !== 'https:' || /[%\\\s]/.test(proposal.endpoint)) unsupported = true;
    proposal.endpoint = target.href;
  } catch { unsupported = true; }
  // Metadata for custom Sonar/Agent endpoints does not define a chat adapter.
  if (cfg.chatEndpoint && entry.baseUrl.replace(/\/$/, '') !== cfg.baseUrl.replace(/\/$/, '')) unsupported = true;
  if (!unsupported && proposal.endpoint === (current.endpoint || configuredEndpoint)
    && proposal.useMaxCompletionTokens === current.useMaxCompletionTokens) return null;
  return { source, proposal, unsupported: !!unsupported };
}
