/** Fill omissions in OpenAI catalogs from exact, public official model cards. */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers.mjs';
import { mergeModelMetadata, normalizeModelMetadata } from './model-metadata.mjs';

const CACHE_FILE = path.join(BASE_DIR, 'config', 'openai-model-metadata.json');
const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const MAX_BYTES = 128 * 1024;
const pending = new Map();

function readCache() {
  try {
    const value = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return value.version === 1 && value.models && typeof value.models === 'object' ? value.models : {};
  } catch { return {}; }
}

export function parseOpenAIModelCard(text, id, source) {
  const identity = text.match(/(?:^|\n)(?:-\s*)?Model ID:\s*`?([^`\s]+)`?/i)?.[1];
  const section = title => text.match(new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1];
  const snapshots = [...(section('Snapshots') ?? '').matchAll(/^[-*]\s+`?([a-z0-9.-]+)`?\s*$/gm)].map(m => m[1]);
  if (identity !== id && !(identity && id.startsWith(`${identity}-`) && snapshots.includes(id))) {
    throw new Error('Model card identity did not match the catalog model');
  }
  const list = title => {
    const block = section(title);
    return block == null ? undefined : [...block.matchAll(/^[-*]\s+`?([a-z][a-z0-9_]+)`?\s*$/gm)].map(m => m[1]);
  };
  const modalities = kind => text.match(new RegExp(`^[-*]\\s+${kind} modalities:\\s*(.+)$`, 'mi'))?.[1]
    .split(',').map(value => value.trim().replace(/`/g, ''));
  const tools = list('Supported tools');
  const features = list('Supported features');
  if (!tools?.length && !features?.length) throw new Error('Model card has no structured capabilities');
  const number = expression => Number(text.match(expression)?.[1]?.replace(/,/g, '')) || undefined;
  return normalizeModelMetadata({
    input_modalities: modalities('Input'), output_modalities: modalities('Output'),
    supported_tools: tools, supported_features: features, unsupported_features: list('Unsupported features'),
    context_window: number(/^[-*]\s+([\d,]+) context window$/mi),
    max_input_tokens: number(/^[-*]\s+Maximum input tokens:\s*([\d,]+)$/mi),
    max_output_tokens: number(/^[-*]\s+([\d,]+) max output tokens$/mi),
    sources: [source],
  });
}

async function readBounded(response) {
  if (!response.body?.getReader) throw new Error('Model card body is missing');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error('Model card is too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

async function lookup(id, refresh) {
  if (!/^(?:gpt-|o\d)[a-z0-9.-]{1,96}$/.test(id)) return null;
  const cached = readCache()[id];
  if (!refresh && cached && Date.now() - cached.checkedAt < (cached.failed ? RETRY_MS : TTL_MS)) {
    return cached.metadata ?? null;
  }
  if (pending.has(id)) return pending.get(id);
  const load = (async () => {
    let entry;
    try {
      let metadata;
      const candidates = [...new Set([id, id.replace(/-\d{4}-\d{2}-\d{2}$/, '')])];
      for (const candidate of candidates) {
        const source = `https://developers.openai.com/api/docs/models/${encodeURIComponent(candidate)}.md`;
        const response = await fetch(source, {
          headers: { Accept: 'text/markdown' }, redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 404) continue;
          throw new Error(`Model card HTTP ${response.status}`);
        }
        metadata = parseOpenAIModelCard(await readBounded(response), id, source);
        break;
      }
      if (!metadata) throw new Error('No official model card was found');
      entry = { metadata, checkedAt: Date.now(), fetchedAt: Date.now(), failed: false };
    } catch {
      entry = { ...cached, checkedAt: Date.now(), failed: true };
    }
    await withLock(CACHE_FILE, () => {
      const models = readCache();
      models[id] = entry;
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      atomicWriteSync(CACHE_FILE, JSON.stringify({ version: 1, models }, null, 2));
    });
    return entry.metadata ?? null;
  })();
  pending.set(id, load);
  try { return await load; } finally { pending.delete(id); }
}

export async function enrichOpenAIModelMetadata(models, { refresh = false } = {}) {
  const result = [];
  for (let offset = 0; offset < models.length; offset += 6) {
    result.push(...await Promise.all(models.slice(offset, offset + 6).map(async model => {
      const id = model.id ?? model.slug ?? model.name;
      const advertised = normalizeModelMetadata(model);
      // Complete provider metadata needs no documentation fallback.
      const complete = advertised.inputModalities && advertised.outputModalities && advertised.supportedTools;
      const documented = complete ? null : await lookup(String(id), refresh);
      return { ...model, modelMetadata: mergeModelMetadata(documented, advertised) };
    })));
  }
  return result;
}
