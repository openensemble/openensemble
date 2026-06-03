/**
 * Home Assistant entity-name cache.
 *
 * Powers the chat-dispatch fast-path so "turn off hall front left" can be
 * resolved to a single HA service call in ~200ms instead of round-tripping
 * through coordinator → HA specialist with 5 gpt-5.5 turns (~28s).
 *
 * Cache shape: Map(normalizedFriendlyName -> { entity_id, domain, friendly_name }).
 * Lazy load on first lookup, then a background refresh every 5 minutes so newly
 * added HA devices show up without a server restart.
 *
 * Lookup pipeline (first unique winner wins, otherwise null → fall through to LLM):
 *   1. exact normalized match
 *   2. prefix match
 *   3. substring match
 *   4. token-set match (every input token present in entity name)
 */

import { getHaConfig, haRequest } from './ha-client.mjs';

const REFRESH_MS = 5 * 60 * 1000;

let _idx = null;          // Map<normalized name, {entity_id, domain, friendly_name}>
let _lastRefresh = 0;
let _inflight = null;
let _bgInterval = null;

export function normalize(s) {
  return String(s ?? '').toLowerCase().trim()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/['"`]/g, '')
    .replace(/[._\-/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

async function fetchAndIndex() {
  const haCfg = getHaConfig();
  if (!haCfg) return null;
  const data = await haRequest(haCfg, '/states');
  if (!Array.isArray(data)) return null;
  const idx = new Map();
  for (const e of data) {
    const id = e?.entity_id;
    if (typeof id !== 'string' || !id.includes('.')) continue;
    const domain = id.split('.', 1)[0];
    // Treat any entity whose attributes.entity_id is an array as a "group"
    // regardless of its domain — covers HA's helper-defined Light Group /
    // Switch Group (which surface under light.*/switch.* rather than the
    // legacy group.*). isGroup is what the entities endpoint exposes so the
    // Routines UI can surface them under the "Groups" optgroup.
    const memberIds = Array.isArray(e?.attributes?.entity_id) ? e.attributes.entity_id : null;
    const isGroup = !!memberIds;
    // Skip diagnostic / non-actionable entities up front so they don't crowd
    // out a real "turn on X" match. We only fast-path domains a user is
    // likely to say "turn on/off/toggle" or "activate/run" against — but
    // groups always pass even if their domain isn't in the allowlist
    // (e.g. a media_player group is still actionable).
    if (!isGroup && !FAST_PATH_DOMAINS.has(domain)) continue;
    const fnRaw = e.attributes?.friendly_name || id.split('.').slice(1).join('.').replace(/_/g, ' ');
    // Drop entities whose friendly_name carries a stringified Python `None`.
    // These come from misconfigured integrations (a device whose subentity
    // label is null gets concatenated as "<Device> None"). The fast-path
    // would otherwise match a phrase like "window ac" → "Window AC None"
    // and turn ON a different/malformed entity than what the user expects.
    // Skip them at index time so a properly-named sibling entity wins.
    if (/(\s|^)None$/.test(fnRaw)) continue;
    const norm = normalize(fnRaw);
    if (!norm) continue;
    // First writer wins on a collision — keeps the cache deterministic across
    // refreshes. Collisions are rare (two devices with the same friendly_name)
    // and they make the entity ambiguous anyway, which the multi-match check
    // in lookup() would correctly bail on.
    if (!idx.has(norm)) idx.set(norm, { entity_id: id, domain, friendly_name: fnRaw, isGroup });
  }
  return idx;
}

// Domains the fast-path acts on. Sensors / binary_sensors / sun / weather etc.
// are read-only and don't fit "turn on X" verbs — keeping them out of the
// cache shrinks the match space so common phrases don't get hijacked by an
// unrelated sensor entity that happens to share a token.
const FAST_PATH_DOMAINS = new Set([
  'light', 'switch', 'fan', 'cover', 'lock',
  'media_player', 'climate',
  'scene', 'script', 'automation',
  'input_boolean',
  // HA "group" domain — legacy multi-entity groupings ("group.living_room_
  // lights"). Modern HA also lets you make groups of lights/switches that
  // surface under their member domain ("light.kitchen_lights") and those
  // are already cached above. Including `group` here means the Routines
  // dropdown picks up both styles.
  'group',
]);

export async function ensureCache(force = false) {
  if (!force && _idx && (Date.now() - _lastRefresh) < REFRESH_MS) return _idx;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const next = await fetchAndIndex();
      if (next) { _idx = next; _lastRefresh = Date.now(); }
      return _idx;
    } finally { _inflight = null; }
  })();
  return _inflight;
}

export function invalidateCache() {
  _idx = null;
  _lastRefresh = 0;
}

export function startBackgroundRefresh() {
  if (_bgInterval) return;
  _bgInterval = setInterval(() => { ensureCache(true).catch(() => {}); }, REFRESH_MS);
  _bgInterval.unref?.();
}

/**
 * Look up a phrase against the entity cache. Returns the matched entity (with
 * the strategy that found it) on a SINGLE unique hit, or null otherwise.
 * Null means: cache empty, no match, OR multiple ambiguous matches — all
 * cases the caller should treat as "fall through to the LLM".
 */
export async function lookupEntity(phrase) {
  const idx = await ensureCache();
  if (!idx || idx.size === 0) return null;
  const norm = normalize(phrase);
  if (!norm) return null;

  // 1. Exact match
  if (idx.has(norm)) return { ...idx.get(norm), strategy: 'exact' };

  const entries = [...idx.entries()];

  // 2. Prefix match — entity name starts with phrase
  const prefix = entries.filter(([k]) => k.startsWith(norm + ' ') || k === norm);
  if (prefix.length === 1) return { ...prefix[0][1], strategy: 'prefix' };

  // 3. Substring match — phrase appears anywhere in entity name
  const sub = entries.filter(([k]) => k.includes(norm));
  if (sub.length === 1) return { ...sub[0][1], strategy: 'substring' };

  // 4. Token-set match — every token in phrase appears as a token in entity name
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length) {
    const tokenMatches = entries.filter(([k]) => {
      const kTokens = new Set(k.split(' '));
      return tokens.every(t => kTokens.has(t));
    });
    if (tokenMatches.length === 1) return { ...tokenMatches[0][1], strategy: 'token-set' };
  }

  return null;
}
