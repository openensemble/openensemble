// @ts-check
/**
 * User-defined OpenAI-compatible provider overlay.
 *
 * The coordinator can add a new provider at runtime (via the oe-admin
 * skill's `add_provider` tool) without a code change. Each entry mirrors
 * the shape of OPENAI_COMPAT_PROVIDERS in chat/providers/_shared.mjs:
 *
 *   { baseUrl, keyField, displayName }
 *
 * The overlay file lives at config/user-providers.json and is merged
 * with the hardcoded registry at read time. Hardcoded entries always
 * win on collision (the overlay can ADD providers but cannot redirect
 * existing ones — that change should be a real code edit, not a
 * runtime override).
 */

import fs from 'fs';
import path from 'path';
import { BASE_DIR } from './paths.mjs';
import { assertWritablePath } from './oe-admin-paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const OVERLAY_PATH = path.join(BASE_DIR, 'config', 'user-providers.json');

let _cache = null;
let _mtime = 0;

/** Read the overlay map from disk. Empty object if the file is absent. */
export function loadUserProviders() {
  try {
    const stat = fs.statSync(OVERLAY_PATH);
    if (_cache && stat.mtimeMs === _mtime) return _cache;
    const raw = JSON.parse(fs.readFileSync(OVERLAY_PATH, 'utf8'));
    _cache = (raw && typeof raw === 'object') ? raw : {};
    _mtime = stat.mtimeMs;
    return _cache;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[user-providers] failed to load overlay:', e.message);
    }
    _cache = {};
    _mtime = 0;
    return _cache;
  }
}

/** Write the full overlay map back to disk. Caller passes the merged map. */
export function saveUserProviders(map) {
  assertWritablePath(OVERLAY_PATH);
  const dir = path.dirname(OVERLAY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(OVERLAY_PATH, JSON.stringify(map ?? {}, null, 2));
  _cache = map ?? {};
  try { _mtime = fs.statSync(OVERLAY_PATH).mtimeMs; } catch {}
}

/** Add or replace one provider in the overlay. */
export function setUserProvider(id, entry) {
  if (!id || typeof id !== 'string') throw new Error('provider id required');
  if (!entry || typeof entry !== 'object' || !entry.baseUrl || !entry.keyField) {
    throw new Error('provider entry must include { baseUrl, keyField }');
  }
  const map = { ...loadUserProviders() };
  map[id] = {
    baseUrl: String(entry.baseUrl),
    keyField: String(entry.keyField),
    displayName: String(entry.displayName ?? id),
    addedAt: entry.addedAt ?? new Date().toISOString(),
    addedBy: entry.addedBy ?? null,
    version: entry.version ?? 1,
  };
  saveUserProviders(map);
  return map[id];
}

/** Remove one provider from the overlay. Returns true if it was present. */
export function removeUserProvider(id) {
  const map = { ...loadUserProviders() };
  if (!(id in map)) return false;
  delete map[id];
  saveUserProviders(map);
  return true;
}

/**
 * Return the merged provider registry: hardcoded ∪ overlay. Hardcoded
 * entries take precedence on collision so the overlay cannot silently
 * redirect a built-in provider.
 *
 * NOTE: `baseRegistry` is passed in by the caller to avoid an import cycle
 * with chat/providers/_shared.mjs (which is itself the canonical home of
 * the hardcoded list). The Proxy in _shared.mjs delegates to this function
 * passing its own internal STATIC_PROVIDERS.
 */
export function mergeProviders(baseRegistry) {
  const overlay = loadUserProviders();
  const merged = { ...overlay };
  // Hardcoded entries win — write them last.
  for (const [k, v] of Object.entries(baseRegistry ?? {})) {
    merged[k] = v;
  }
  return merged;
}
