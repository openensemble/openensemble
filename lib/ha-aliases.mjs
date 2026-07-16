/**
 * Per-user Home Assistant phrase aliases.
 *
 * Maps a spoken/typed phrase to a specific HA entity_id so the HA fast-path
 * can resolve it in ~200 ms regardless of which control verb the user used.
 * "kitchen" → "light.kitchen_group" makes:
 *   - "turn off kitchen"
 *   - "toggle kitchen"
 *   - "set kitchen to 50%"
 * all hit the same entity without any LLM round-trip.
 *
 * Schema: users/<userId>/ha-aliases.json
 *   { "<normalized phrase>": "<entity_id>" }
 *
 * Normalization mirrors lib/ha-cache.mjs's normalize() so a phrase a user
 * stored as "Kitchen" matches when the verb regex captures "kitchen".
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

function aliasPath(userId) {
  return path.join(USERS_DIR, userId, 'ha-aliases.json');
}

const ENTITY_RE = /^[a-z_]{1,32}\.[a-z0-9_]{1,64}$/i;

export function normalizeAliasPhrase(s) {
  return String(s ?? '').toLowerCase().trim()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/['"`]/g, '')
    .replace(/[._\-/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function loadAliases(userId) {
  if (!userId) return {};
  const p = aliasPath(userId);
  if (!fs.existsSync(p)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.warn(`[ha-aliases] read failed for ${userId}: ${e.message}`);
    return {};
  }
}

export function saveAliases(userId, map) {
  const clean = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const nk = normalizeAliasPhrase(k);
    if (!nk) continue;
    const ent = v.trim();
    if (!ENTITY_RE.test(ent)) continue;
    clean[nk] = ent;
  }
  const p = aliasPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(clean, null, 2));
  return clean;
}

export function setAlias(userId, phrase, entityId) {
  const all = loadAliases(userId);
  const k = normalizeAliasPhrase(phrase);
  if (!k) throw new Error('Empty phrase');
  if (!ENTITY_RE.test(entityId)) throw new Error(`Invalid entity_id: ${entityId}`);
  all[k] = entityId;
  return saveAliases(userId, all);
}

export function deleteAlias(userId, phrase) {
  const all = loadAliases(userId);
  const k = normalizeAliasPhrase(phrase);
  if (!(k in all)) return false;
  delete all[k];
  saveAliases(userId, all);
  return true;
}

/**
 * Resolve a phrase to its aliased entity_id. Returns null if no alias is
 * configured. Called inline from the HA fast-path before the cache lookup.
 */
export function resolveAlias(userId, phrase, { suppressLearning = false } = {}) {
  if (!userId || typeof phrase !== 'string') return null;
  const all = loadAliases(userId);
  const normPhrase = normalizeAliasPhrase(phrase);
  const entityId = all[normPhrase] || null;
  // Phase-9: log the hit for the alias_proposal outcome measurer.
  // Fire-and-forget so a slow disk write doesn't delay HA dispatch.
  if (entityId && !suppressLearning) {
    import('./alias-hits.mjs').then(m =>
      m.appendAliasHit(userId, { phrase: normPhrase, entityId })
    ).catch(e => console.warn('[ha-aliases] hit-log failed:', e.message));
  }
  return entityId;
}
