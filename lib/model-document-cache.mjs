import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';

const CACHE_FILE = path.join(BASE_DIR, 'config', 'provider-model-documents.json');
const pending = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return data.version === 1 ? data.models ?? {} : {};
  } catch { return {}; }
}

/** Public structured model documentation only; never send account credentials. */
export async function documentedModelMetadata(provider, id, url, parse, { refresh = false } = {}) {
  const key = `${provider}/${id}`;
  const prior = readCache()[key];
  if (!refresh && prior && Date.now() - prior.checkedAt < (prior.failed ? 15 * 60_000 : TTL_MS)) return prior.metadata ?? null;
  if (pending.has(key)) return pending.get(key);
  const load = (async () => {
    let entry;
    try {
      const response = await fetch(url, {
        headers: { 'Accept-Language': 'en' }, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Model documentation HTTP ${response.status}`); }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new Error('Model documentation exceeded size limit');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const metadata = parse(Buffer.concat(chunks).toString('utf8'), id, url);
      entry = { metadata, checkedAt: Date.now(), failed: false };
    } catch { entry = { ...prior, checkedAt: Date.now(), failed: true }; }
    await withLock(CACHE_FILE, () => {
      const models = readCache();
      models[key] = entry;
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      atomicWriteSync(CACHE_FILE, JSON.stringify({ version: 1, models }, null, 2));
    });
    return entry.metadata ?? null;
  })();
  pending.set(key, load);
  try { return await load; } finally { pending.delete(key); }
}
