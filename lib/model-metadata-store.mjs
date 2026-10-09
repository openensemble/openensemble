import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { normalizeModelMetadata } from './model-metadata.mjs';

const cache = new Map();

/** Synchronous prompt composition reuses metadata already resolved for this account. */
export function readStoredModelMetadata(userId, provider, model) {
  if (typeof userId !== 'string' || !/^[a-z0-9_-]+$/i.test(userId)) return {};
  const file = path.join(USERS_DIR, userId, 'execution-model-capabilities.json');
  try {
    const stat = fs.statSync(file);
    let cached = cache.get(file);
    if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { mtime: stat.mtimeMs, size: stat.size, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
      if (cache.size >= 128) cache.clear();
      cache.set(file, cached);
    }
    return normalizeModelMetadata(cached.data?.providers?.[provider]?.[model]?.modelMetadata);
  } catch { return {}; }
}
