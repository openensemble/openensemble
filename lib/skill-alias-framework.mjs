/**
 * Skill-alias framework — generalizes the per-entity alias modules (skill,
 * agent, node, email_account, project, yt_channel) into a manifest-driven
 * pattern. Skills opt in by declaring an `alias_catalog` block in their
 * manifest.json:
 *
 *   "alias_catalog": {
 *     "entity_kind":     "yt_channel",          // globally unique
 *     "noun_singular":   "channel",             // for "the X <noun>" phrases
 *     "noun_plural":     "channels",
 *     "extra_phrase_patterns": [                // OPTIONAL skill-specific regexes
 *       "\\bnew\\s+(?:videos?|uploads?)\\s+from\\s+(.+?)\\b"
 *     ],
 *     "catalog_source": {                       // ONE of two modes:
 *       "type":      "config_file",
 *       "path":      "users/{userId}/youtube-downloader-config.json",
 *       "json_path": "watchedChannels",         // dot-path, optional
 *       "format":    "object_map"               // "object_map" | "array"
 *     },
 *     // OR: { "type": "exported_function", "function": "listAliasEntries" }
 *
 *     "id_field":      "channelId",             // path within an entry
 *     "name_fields":   ["channelName"],         // ordered; first non-null wins
 *     "id_arg_names":  ["channel_id", "channelId"],
 *     "cascade_on_tools": [
 *       { "tool": "youtube_downloader_unwatch_channel", "id_arg": "channel_id" }
 *     ]
 *   }
 *
 * What the framework does with this declaration:
 *   - Compiles phrase regexes from noun_singular/plural (+ extras)
 *   - Caches catalog reads with a 5-min TTL
 *   - On chat-dispatch resolution: stored alias → name match → id substring
 *   - Auto-learns the alias on a fallback hit
 *   - Listens to tool calls whose args contain any id_arg_names — learns from
 *     LLM-resolved cases the resolver missed
 *   - Cascade-deletes user aliases when a tool in cascade_on_tools succeeds
 *
 * Skill authors write zero new code inside their execute.mjs — the framework
 * hooks happen at the dispatcher level. Only requirement: the catalog must
 * be readable by the framework (file path OR an exported function).
 *
 * Storage: users/<userId>/<entity_kind>-aliases.json
 *   { "<normalized phrase>": "<entity_id>" }
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR, BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { isLearnableAliasPhrase, normalizeLearnedPhrase } from './learning-safety.mjs';

const CATALOG_TTL_MS = 5 * 60 * 1000;

const _registered = new Map();   // scope:key → { spec, userScope, skillId, patterns, executorImport }
const _catalogCache = new Map(); // `${userId}:${registryKey}` → { entries, ts }

function registryKey(entityKind, userScope = null) {
  return userScope ? `user:${userScope}:${entityKind}` : `global:${entityKind}`;
}

function* visibleRegistrations(userId) {
  for (const reg of _registered.values()) {
    if (reg.userScope == null || reg.userScope === userId) yield reg;
  }
}

async function registrationAllowed(userId, reg) {
  if (!reg || (reg.userScope && reg.userScope !== userId)) return false;
  if (!reg.skillId) return true; // trusted inline system catalog
  try {
    const { isSkillRuntimeEnabledForUser } = await import('../roles.mjs');
    return isSkillRuntimeEnabledForUser(reg.skillId, userId);
  } catch {
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dotPath(obj, dp) {
  if (!obj || !dp) return obj;
  return String(dp).split('.').reduce((cur, k) => (cur == null ? cur : cur[k]), obj);
}

function aliasPath(userId, entityKind) {
  return path.join(USERS_DIR, userId, `${entityKind}-aliases.json`);
}

// Phrase normalization. Strips leading articles + a trailing match of the
// entity's noun if present. Mirrors the per-entity normalize functions so
// stored aliases collide consistently regardless of phrasing variation.
function normalizePhrase(s, nounSingular) {
  return normalizeLearnedPhrase(s, nounSingular);
}

// Compile the regex set that recognizes references to this entity in user
// messages. Generic patterns derived from noun_singular/plural, plus any
// skill-author-supplied extras. Patterns must capture the entity name in
// group 1.
function compilePatterns(spec) {
  const ns = escapeRegex(spec.noun_singular);
  const np = spec.noun_plural ? escapeRegex(spec.noun_plural) : `${ns}s`;
  // All patterns get /gi: case-insensitive + global so matchAll finds EVERY
  // candidate phrase in a single user/task message. Without /g, .match()
  // returns only the first hit per pattern — meaning a message like
  // "delete the latest email in <user>'s <account-label> account" extracts
  // X="latest" (from "latest email") and never gets to "<account-label>
  // account" further in. That bug let delegation tasks fail to resolve
  // even when an obvious account name was present.
  const generic = [
    new RegExp(`\\bthe\\s+([A-Za-z][A-Za-z0-9 _-]{1,40}?)\\s+(?:${ns}|${np})\\b`, 'gi'),
    new RegExp(`\\b([A-Za-z][A-Za-z0-9 _-]{1,40}?)\\s+(?:${ns}|${np})\\b`, 'gi'),
    new RegExp(`\\b([A-Za-z][A-Za-z0-9_-]{1,40})['’]s\\s+(?:${ns}|${np})\\b`, 'gi'),
  ];
  const extras = (spec.extra_phrase_patterns || [])
    .map(p => {
      try {
        // Normalize the caller's flags to include 'g' + 'i' regardless of
        // what they wrote — caller-supplied patterns target their own
        // domain (the email-skill manifest) and shouldn't have to worry
        // about engine-specific quirks.
        const src = p instanceof RegExp ? p.source : String(p);
        return new RegExp(src, 'gi');
      } catch { return null; }
    })
    .filter(Boolean);
  return [...generic, ...extras];
}

// ── Catalog loading ─────────────────────────────────────────────────────────

async function loadCatalog(userId, reg) {
  // Authorization must precede the cache lookup. Otherwise a catalog that was
  // loaded while permitted remains readable after a child permission revoke
  // or ordinary skill disablement. Inline system catalogs have no skillId and
  // are intentionally exempt.
  if (!(await registrationAllowed(userId, reg))) return [];
  const key = `${userId}:${reg.registryKey}`;
  const now = Date.now();
  const cached = _catalogCache.get(key);
  if (cached && now - cached.ts < CATALOG_TTL_MS) return cached.entries;

  let entries = [];
  const src = reg.spec.catalog_source || {};
  try {
    if (src.type === 'config_file') {
      const rel = String(src.path || '').replace('{userId}', userId);
      let abs = rel.startsWith('/') ? rel : path.join(BASE_DIR, rel);
      if (reg.userScope) {
        // A user-authored manifest is untrusted input. Its declarative catalog
        // may read only inside its owning profile; absolute paths, traversal,
        // cross-user substitutions, and symlink escapes all fail closed.
        if (path.isAbsolute(rel) || userId !== reg.userScope) return [];
        const root = path.resolve(USERS_DIR, reg.userScope);
        abs = path.resolve(BASE_DIR, rel);
        if (abs !== root && !abs.startsWith(root + path.sep)) return [];
        if (fs.existsSync(abs)) {
          const realRoot = fs.realpathSync(root);
          const realFile = fs.realpathSync(abs);
          if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return [];
        }
      }
      if (fs.existsSync(abs)) {
        const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
        const sub = src.json_path ? dotPath(data, src.json_path) : data;
        if (src.format === 'object_map' && sub && typeof sub === 'object') {
          entries = Object.values(sub);
        } else if (src.format === 'array' && Array.isArray(sub)) {
          entries = sub;
        } else if (!src.format) {
          entries = Array.isArray(sub)
            ? sub
            : (sub && typeof sub === 'object' ? Object.values(sub) : []);
        }
      }
    } else if (src.type === 'exported_function' && reg.executorImport) {
      // The caller identity is threaded into the importer so roles.mjs can
      // enforce skill ownership/allowedSkills before loading code and can
      // proxy custom exports through the sandbox.
      const mod = await reg.executorImport(userId);
      const fn = mod && mod[src.function];
      if (typeof fn === 'function') {
        const res = await fn(userId);
        entries = Array.isArray(res) ? res : [];
      }
    } else if (src.type === 'inline_function' && typeof src.fn === 'function') {
      // System-level catalogs (agents, etc.) that aren't owned by a skill
      // manifest. Caller passes the function directly at registerAliasCatalog
      // time. Spec stays in-process — never serialized.
      const res = await src.fn(userId);
      entries = Array.isArray(res) ? res : [];
    }
  } catch (e) {
    console.warn(`[alias-framework] catalog load failed (${reg.spec.entity_kind}): ${e.message}`);
  }

  _catalogCache.set(key, { entries, ts: now });
  return entries;
}

function invalidateCatalog(userId, entityKind) {
  for (const reg of visibleRegistrations(userId)) {
    if (reg.spec.entity_kind === entityKind) {
      _catalogCache.delete(`${userId}:${reg.registryKey}`);
    }
  }
}

// ── Storage ─────────────────────────────────────────────────────────────────

function loadAliases(userId, entityKind) {
  const p = aliasPath(userId, entityKind);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || {}; }
  catch { return {}; }
}

function saveAliases(userId, entityKind, map) {
  const p = aliasPath(userId, entityKind);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(map, null, 2));
}

function setAlias(userId, entityKind, phrase, id, nounSingular) {
  if (!isLearnableAliasPhrase(phrase, nounSingular)) return;
  const k = normalizePhrase(phrase, nounSingular);
  if (!k || !id) return;
  const all = loadAliases(userId, entityKind);
  all[k] = String(id);
  saveAliases(userId, entityKind, all);
}

function deleteAlias(userId, entityKind, phrase, nounSingular) {
  const k = normalizePhrase(phrase, nounSingular);
  if (!k) return false;
  const all = loadAliases(userId, entityKind);
  if (!(k in all)) return false;
  delete all[k];
  saveAliases(userId, entityKind, all);
  return true;
}

/**
 * Drop every alias pointing at a specific (entity_kind, id). Exported so
 * route handlers that own deletion paths outside the tool-dispatch loop
 * (routes/nodes.mjs DELETE, routes/agents.mjs DELETE, routes/email-accounts.mjs
 * DELETE) can still call cascade — `cascade_on_tools` covers skill-tool
 * deletions only.
 */
export function deleteAliasesByEntityId(userId, entityKind, id) {
  const all = loadAliases(userId, entityKind);
  let removed = 0;
  for (const [k, v] of Object.entries(all)) {
    if (v === id) { delete all[k]; removed++; }
  }
  if (removed > 0) saveAliases(userId, entityKind, all);
  // Invalidate the catalog cache so the next resolver miss re-reads from
  // disk; without this a stale-entry resolution would survive until TTL.
  invalidateCatalog(userId, entityKind);
  return removed;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register one skill's alias_catalog block. Caller (roles.mjs at boot, or
 * skill-builder after a hot-reload) provides an `executorImport` thunk so the
 * `exported_function` catalog source can lazy-load the skill module.
 */
export function registerAliasCatalog(spec, executorImport, { userScope = null, skillId = null } = {}) {
  if (!spec || typeof spec !== 'object' || !spec.entity_kind || !spec.noun_singular) return;
  const key = registryKey(spec.entity_kind, userScope);
  if (_registered.has(key)) {
    console.warn(`[alias-framework] duplicate entity_kind "${spec.entity_kind}" in ${userScope || 'global'} scope; ignoring later registration`);
    return;
  }
  // A user-local catalog cannot shadow a global catalog of the same kind for
  // that user's messages. Cross-user reuse is safe because registrations are
  // scoped and never visible outside their owner.
  if (userScope && _registered.has(registryKey(spec.entity_kind, null))) {
    console.warn(`[alias-framework] user catalog "${spec.entity_kind}" conflicts with a global catalog; ignoring ${userScope}/${skillId || 'skill'}`);
    return;
  }
  _registered.set(key, {
    spec,
    registryKey: key,
    userScope,
    skillId,
    patterns: compilePatterns(spec),
    executorImport,
  });
  console.log(`[alias-framework] registered "${spec.entity_kind}" (${userScope || 'global'}, noun=${spec.noun_singular})`);
}

/**
 * Unregister an entity kind. Called by skill-builder on skill_delete so a
 * removed skill's catalog stops being scanned per chat turn.
 */
export function unregisterAliasCatalog(entityKind, userScope = null) {
  const keyToDelete = registryKey(entityKind, userScope);
  if (_registered.delete(keyToDelete)) {
    for (const key of [..._catalogCache.keys()]) {
      if (key.endsWith(`:${keyToDelete}`)) _catalogCache.delete(key);
    }
  }
}

/** Read-only registry inspection — used by buildContextHints + diagnostics. */
export function listRegistered() {
  return [..._registered.values()].map(r => r.spec);
}

/**
 * Discover + register every loaded skill that declares alias_catalog. The
 * importerFor(skillId) callback returns the skill's executor module promise,
 * letting the framework call exported_function sources.
 */
export function registerFromManifests(manifests, importerFor) {
  let count = 0;
  for (const m of manifests || []) {
    if (m && m.alias_catalog) {
      const skillId = m.id;
      const importer = (typeof importerFor === 'function')
        ? (catalogUserId) => importerFor(skillId, m.userScope ?? null, catalogUserId)
        : null;
      registerAliasCatalog(m.alias_catalog, importer, { userScope: m.userScope ?? null, skillId });
      count++;
    }
  }
  if (count > 0) console.log(`[alias-framework] registered ${count} skill catalog(s) from manifests`);
}

/**
 * Try every registered resolver against the user's text. Returns the first
 * matching resolution or null. Patterns iterate in registration order; the
 * first match wins (skill authors should pick narrow extra_phrase_patterns
 * to avoid collisions).
 *
 * @returns {Promise<{entity_kind, phrase, id, entry, spec} | null>}
 */
export async function resolveFromMessage(userId, text) {
  if (!userId || typeof text !== 'string' || text.length < 4) return null;

  for (const reg of visibleRegistrations(userId)) {
    if (!(await registrationAllowed(userId, reg))) continue;
    // Collect every candidate phrase the patterns extract from this text.
    // A previous version broke at the first matching pattern, which made
    // greedy patterns like `my X email` capture "my LATEST email" and
    // short-circuit the resolver before a later account-label phrase was
    // even tried. Now we gather everything and resolve each in order —
    // first one that actually maps to a catalog entry wins.
    // Collect EVERY candidate from EVERY pattern. matchAll requires the /g
    // flag (we set it in compilePatterns). Without /g, .match() returns
    // only the first hit per regex — which silently drops valid candidates
    // when an earlier phrase incidentally matches (e.g. "the latest email"
    // beats "the <account-label> account" in a single greedy pass).
    const candidates = [];
    const seen = new Set();
    for (const re of reg.patterns) {
      for (const m of text.matchAll(re)) {
        if (!m || !m[1]) continue;
        const phrase = m[1].trim().replace(/[,.;:!?]+$/, '');
        if (phrase && !seen.has(phrase.toLowerCase())) {
          candidates.push(phrase);
          seen.add(phrase.toLowerCase());
        }
      }
    }
    if (!candidates.length) continue;

    const noun = reg.spec.noun_singular;
    const entries = await loadCatalog(userId, reg);

    for (const phrase of candidates) {
      const normPhrase = normalizePhrase(phrase, noun);

      // 1. stored alias for this candidate
      const stored = loadAliases(userId, reg.spec.entity_kind);
      if (stored[normPhrase]) {
        const entry = entries.find(e => String(dotPath(e, reg.spec.id_field)) === stored[normPhrase]);
        if (entry) {
          return { entity_kind: reg.spec.entity_kind, phrase, id: stored[normPhrase], entry, spec: reg.spec };
        }
        // Catalog says the entry is gone — stale alias. Drop and keep trying.
        deleteAlias(userId, reg.spec.entity_kind, phrase, noun);
      }

      if (!entries.length) continue;

      // 2. exact name-field match (try fields in order)
      let hit = null;
      for (const nf of (reg.spec.name_fields || [])) {
        const matches = entries.filter(e => normalizePhrase(dotPath(e, nf) || '', noun) === normPhrase);
        if (matches.length === 1) { hit = matches[0]; break; }
      }

      // 3. id substring — only on unique hit
      if (!hit) {
        const subs = entries.filter(e => {
          const eid = String(dotPath(e, reg.spec.id_field) || '');
          if (!eid) return false;
          const ne = normalizePhrase(eid, '');
          return ne === normPhrase || ne.includes(normPhrase) || normPhrase.includes(ne);
        });
        if (subs.length === 1) hit = subs[0];
      }

      if (!hit) continue;

      const id = String(dotPath(hit, reg.spec.id_field) || '');
      if (!id) continue;
      if (!isLearnableAliasPhrase(phrase, noun)) return { entity_kind: reg.spec.entity_kind, phrase, id, entry: hit, spec: reg.spec };
      try { setAlias(userId, reg.spec.entity_kind, phrase, id, noun); } catch {}
      return { entity_kind: reg.spec.entity_kind, phrase, id, entry: hit, spec: reg.spec };
    }
  }

  return null;
}

/**
 * Build the system note for a resolution. Caller (context-resolvers) just
 * forwards this string into the LLM's per-turn schedulerNote.
 */
export function buildHintNote(resolution) {
  if (!resolution) return null;
  const { entity_kind, phrase, id, entry, spec } = resolution;
  const name = (spec.name_fields || []).map(nf => dotPath(entry, nf)).find(Boolean);
  const nameStr = name && String(name) !== String(id)
    ? `"${name}"`
    : '(name not yet enriched)';
  const idArgs = spec.id_arg_names || ['id'];
  const primaryArg = idArgs[0];
  return `<${entity_kind}_reference>User referenced "${phrase}" → ${spec.noun_singular} ${nameStr} (id="${id}"). Pass ${primaryArg}="${id}" to the relevant tools directly — do NOT enumerate the catalog or web_search to look it up.</${entity_kind}_reference>`;
}

/**
 * Learner hook — called from alias-learner.observeTurnAndLearn for every
 * tool call. If the tool args contain a value matching any registered
 * entity's id_arg_names, learn the user's phrase → id mapping.
 *
 * @returns {Promise<boolean>} true if a learning event fired
 */
export async function maybeLearnAliasFromCall(userId, userText, toolName, args) {
  if (!userId || !args || typeof args !== 'object') return false;
  for (const reg of visibleRegistrations(userId)) {
    if (!(await registrationAllowed(userId, reg))) continue;
    const idArgNames = reg.spec.id_arg_names || [];
    for (const argName of idArgNames) {
      const value = args[argName];
      if (!value || typeof value !== 'string') continue;

      // Skip if the resolver already maps this phrase to this id
      const already = await resolveFromMessage(userId, userText);
      if (already && already.entity_kind === reg.spec.entity_kind && already.id === value) {
        return true;
      }

      // Extract a candidate phrase from the user text using this spec's patterns
      let candidate = null;
      for (const re of reg.patterns) {
        const m = userText.match(re);
        if (m && m[1]) { candidate = m[1].trim().replace(/[,.;:!?]+$/, ''); break; }
      }
      if (!candidate) continue;
      if (!isLearnableAliasPhrase(candidate, reg.spec.noun_singular)) continue;

      try {
        setAlias(userId, reg.spec.entity_kind, candidate, value, reg.spec.noun_singular);
        console.log(`[alias-learner] learned ${reg.spec.entity_kind} alias: "${candidate}" → ${value} (framework-observed)`);
        return true;
      } catch (_) { /* fall through to next entity */ }
    }
  }
  return false;
}

/**
 * Cascade hook — called from roles.mjs:executeToolStreaming after a tool
 * completes successfully. If the tool name + arg matches a registered
 * cascade_on_tools entry, drop aliases for that entity id and invalidate
 * the catalog cache so the next lookup re-reads from disk.
 */
export async function maybeCascadeOnToolSuccess(userId, toolName, args) {
  if (!userId || !toolName || !args || typeof args !== 'object') return;
  for (const reg of visibleRegistrations(userId)) {
    if (!(await registrationAllowed(userId, reg))) continue;
    for (const hook of (reg.spec.cascade_on_tools || [])) {
      if (hook.tool === toolName) {
        const id = args[hook.id_arg];
        if (id && typeof id === 'string') {
          const removed = deleteAliasesByEntityId(userId, reg.spec.entity_kind, id);
          if (removed > 0) console.log(`[alias-framework] cascade dropped ${removed} alias(es) for ${reg.spec.entity_kind} "${id}"`);
          invalidateCatalog(userId, reg.spec.entity_kind);
        }
      }
    }
  }
}

/**
 * Path B (clarification → yes): probe every registered entity to see if a
 * candidate string (e.g. an entity name extracted from the LLM's clarifying
 * question "did you mean <name>?") resolves. Returns the first hit or null.
 */
export async function probeAllRegistered(userId, candidate) {
  for (const reg of visibleRegistrations(userId)) {
    const probeText = `the ${candidate} ${reg.spec.noun_singular}`;
    const r = await resolveFromMessage(userId, probeText);
    if (r) return r;
  }
  return null;
}

/**
 * Persist an alias from path B affirmation. Exposed so the affirmation
 * consumer can save without going through the catalog match path.
 */
export async function setAliasExternal(userId, entityKind, phrase, id) {
  const reg = [...visibleRegistrations(userId)].find(candidate => candidate.spec.entity_kind === entityKind);
  if (!reg) return false;
  if (!(await registrationAllowed(userId, reg))) return false;
  try {
    setAlias(userId, entityKind, phrase, id, reg.spec.noun_singular);
    return true;
  } catch { return false; }
}
