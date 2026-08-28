/**
 * Agent definitions for OpenEnsemble.
 * Each agent has an id, display name, model, system prompt, and tool list.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, watch } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import { CFG_PATH, USERS_DIR, readConfig } from './lib/paths.mjs';
import { isReservedAgentId } from './lib/agent-ref.mjs';
import { withLock, atomicWriteSync } from './routes/_helpers/io-lock.mjs';
// Simple in-process caches — invalidated on write or file change
let _customAgentsCache = null; // cache of ALL agents across all user files
let _agentByIdCache = null;    // Map id → agent, rebuilt with _customAgentsCache
let _modelOverridesCache = null;

// Invalidate caches when files change externally (direct edits, model hot-swap).
// One narrow watcher per existing users/<id>/agents.json — avoids the recursive
// watch on USERS_DIR that fans out to one inotify instance per subdirectory.
const _watchedAgentFiles = new Set();
function watchAgentsFile(filePath) {
  if (_watchedAgentFiles.has(filePath) || !existsSync(filePath)) return;
  try {
    const w = watch(filePath, () => { _customAgentsCache = null; _agentByIdCache = null; });
    w.on('error', e => console.warn('[agents] agents.json watcher error:', e.message));
    _watchedAgentFiles.add(filePath);
  } catch (e) { console.warn('[agents] failed to watch', filePath, ':', e.message); }
}

try {
  if (existsSync(USERS_DIR)) {
    for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      watchAgentsFile(path.join(USERS_DIR, entry.name, 'agents.json'));
    }
  }
  if (existsSync(CFG_PATH)) {
    const w = watch(CFG_PATH, () => { _modelOverridesCache = null; });
    w.on('error', e => console.warn('[agents] config watcher error:', e.message));
  }
} catch (e) { console.warn('[agents] fs.watch unavailable:', e.message); }

// ── Custom agent persistence ───────────────────────────────────────────────────
function getUserAgentsPath(userId) {
  return path.join(USERS_DIR, userId, 'agents.json');
}

function loadUserAgents(userId) {
  const p = getUserAgentsPath(userId);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

function saveUserAgents(userId, list) {
  const dir = path.join(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = getUserAgentsPath(userId);
  // Atomic temp+rename — a crash mid-write used to truncate agents.json and
  // silently drop every custom agent for this user on the next load.
  atomicWriteSync(p, JSON.stringify(list, null, 2));
  _customAgentsCache = null;
  _agentByIdCache = null;
  watchAgentsFile(p);
}

export function loadCustomAgents() {
  if (_customAgentsCache) return _customAgentsCache;
  if (!existsSync(USERS_DIR)) return (_customAgentsCache = []);
  try {
    const agents = [];
    for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(USERS_DIR, entry.name, 'agents.json');
      try { if (existsSync(p)) agents.push(...JSON.parse(readFileSync(p, 'utf8'))); } catch {}
    }
    return (_customAgentsCache = agents);
  } catch { return (_customAgentsCache = []); }
}

/**
 * Return the durable agent record exactly as stored in agents.json. Runtime
 * roster projection may replace skillCategory in single-assistant mode, so
 * editor and lifecycle code must use this accessor instead of getAgent().
 */
export function getCustomAgentRecord(id, ownerId = null) {
  const agent = findAgentById(id);
  if (!agent || (ownerId && agent.ownerId !== ownerId)) return null;
  return { ...agent };
}

/** Deterministic fallback for the one default routing pointer of a role. */
export function findDurablePrimaryRoleAgent(roleId, ownerId, { excludeAgentId = null } = {}) {
  if (!roleId || !ownerId) return null;
  return loadUserAgents(ownerId)
    .filter(agent => agent?.ownerId === ownerId
      && agent.id !== excludeAgentId
      && agent.skillCategory === roleId)
    .sort((a, b) => {
      const left = String(a.id);
      const right = String(b.id);
      return left < right ? -1 : (left > right ? 1 : 0);
    })[0] ?? null;
}

/**
 * Remove a deleted role from durable agent records. A null owner clears a
 * global role from every account; a user id confines cleanup to that account.
 */
export function clearCustomAgentPrimaryRolesForRole(roleId, ownerId = null) {
  if (!roleId) return 0;
  const ownerIds = ownerId
    ? [ownerId]
    : (existsSync(USERS_DIR)
      ? readdirSync(USERS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
      : []);
  let cleared = 0;
  for (const id of ownerIds) {
    const list = loadUserAgents(id);
    let changed = false;
    const next = list.map(agent => {
      if (agent?.skillCategory !== roleId) return agent;
      const copy = { ...agent };
      delete copy.skillCategory;
      changed = true;
      cleared++;
      return copy;
    });
    if (changed) saveUserAgents(id, next);
  }
  return cleared;
}

export const CHILD_SAFE_PRIMARY_ROLE_IDS = Object.freeze([
  'deep_research', 'web', 'image_generator',
]);

/**
 * Validate a durable primary-role mutation against the same account policy for
 * HTTP and chat creation/editing. Returning an unchanged value is deliberate:
 * disabling or locking a role must not make an unrelated agent edit erase it.
 */
export async function validatePrimarySkillCategory(
  userId,
  requestedRole,
  { currentSkillCategory = null, allowUnchanged = true } = {},
) {
  if (requestedRole != null && typeof requestedRole !== 'string') {
    return { ok: false, status: 400, error: 'skillCategory must be a role id or null' };
  }
  const normalized = typeof requestedRole === 'string' && requestedRole.trim()
    ? requestedRole.trim()
    : null;
  if (normalized && normalized.length > 128) {
    return { ok: false, status: 400, error: 'skillCategory is too long' };
  }
  const current = typeof currentSkillCategory === 'string' && currentSkillCategory.trim()
    ? currentSkillCategory.trim()
    : null;
  if (allowUnchanged && normalized === current) {
    return { ok: true, skillCategory: normalized, unchanged: true };
  }

  const [{ getUser }, roles] = await Promise.all([
    import('./routes/_helpers.mjs'),
    import('./roles.mjs'),
  ]);
  const user = getUser(userId);
  if (!user) return { ok: false, status: 404, error: 'User not found' };
  const privileged = user.role === 'owner' || user.role === 'admin';
  if (!privileged && user.skillsLocked) {
    return { ok: false, status: 403, error: 'Your tools are managed by an administrator' };
  }
  if (!normalized) return { ok: true, skillCategory: null, unchanged: false };
  if (user.role === 'child' && !CHILD_SAFE_PRIMARY_ROLE_IDS.includes(normalized)) {
    return { ok: false, status: 403, error: 'That role is not available on this account.' };
  }
  const role = roles.listRoles(userId, { includeDisabled: true })
    .find(item => item.id === normalized && item.service === true
      && !item.hidden && item.category !== 'delegate');
  if (!role) {
    return { ok: false, status: 400, error: `Unknown or unavailable role: ${normalized}` };
  }
  if (!roles.isSkillRuntimeEnabledForUser(normalized, userId)) {
    return { ok: false, status: 403, error: `Role is disabled for this account: ${normalized}` };
  }
  return { ok: true, skillCategory: normalized, role, unchanged: false };
}

// O(1) id lookup for the hot paths (getAgent runs per chat dispatch,
// getCoordinatorModel per reasoning-effort resolution). First-writer-wins on
// a duplicate id, matching what .find() over the flattened array returned.
function findAgentById(id) {
  if (!_agentByIdCache) {
    const map = new Map();
    for (const a of loadCustomAgents()) {
      if (a?.id != null && !map.has(a.id)) map.set(a.id, a);
    }
    _agentByIdCache = map;
  }
  return _agentByIdCache.get(id) ?? null;
}

function buildSystemPrompt(name, emoji, description) {
  // Identity-only template. Role/capability guidance is injected at runtime
  // from skill manifests' systemPromptAddition based on which tools resolve
  // for this agent (see routes/_helpers.mjs:getAgentsForUser).
  // {{AGENT_NAME}} / {{AGENT_EMOJI}} are expanded per-request so the stored
  // prompt stays portable across renames and role swaps.
  return `You are {{AGENT_NAME}} {{AGENT_EMOJI}}, {{USER_NAME}}'s AI assistant. ${description}

Be concise and direct. {{USER_NAME}} prefers short, focused answers over long explanations.

You have access to persistent memory — relevant facts from past conversations may appear in your context. Use them naturally. When {{USER_NAME}} says "remember X", confirm briefly. When they say "forget X", confirm it's been removed.`;
}

// Slug a display name into an agent id candidate. We try this first so an
// agent called e.g. "Researcher" becomes id "researcher" instead of
// "agent_<hex>" — readable
// IDs are easier for the coordinator's LLM to call (it stops inventing wrong
// hex ids like "agent_mira" by extrapolating the hex pattern from the tool
// description). Falls back to a hex id when the slug is empty, too short,
// collides with an existing agent in this user's roster, or collides with a
// reserved word that other parts of the system pattern-match on.
const RESERVED_AGENT_IDS = new Set([
  'coordinator', // alias in skillAssignments — would shadow assignment resolution
  'agent', 'system', 'user', 'tool', 'admin',
]);
function pickAgentId(name, ownerId) {
  const slug = String(name ?? '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const hexId = () => 'agent_' + randomBytes(4).toString('hex');
  if (!slug || slug.length < 2 || RESERVED_AGENT_IDS.has(slug)
      || isReservedAgentId(ownerId, slug)) return hexId();
  if (/^[a-z0-9_]+$/.test(slug) === false) return hexId();
  // Collision check across THIS user's roster + the global roster. Agent IDs
  // are globally unique by convention (skillAssignments stores raw ids).
  const all = [...loadUserAgents(ownerId ?? 'shared'), ...loadCustomAgents()];
  if (all.some(a => a.id === slug)) return hexId();
  return slug;
}

export function createCustomAgent({ name, emoji = '🤖', description, model, provider, toolSet = 'web', skillCategory = null, systemPrompt, personality, maxTokens, contextSize, ownerId = null }) {
  const id = pickAgentId(name, ownerId);
  const agent = {
    id, name, emoji,
    model:    model    ?? getCoordinatorModel().model,
    provider: provider ?? getCoordinatorModel().provider,
    toolSet,
    // Primary role. Grants this agent the role's tools directly (roles.mjs
    // resolveAgentTools), independently of the single-valued skillAssignments
    // map — that map still names ONE default routing target per role, but two
    // agents may now both BE coders.
    ...(skillCategory ? { skillCategory } : {}),
    description,
    systemPrompt: systemPrompt ?? buildSystemPrompt(name, emoji, description),
    // Personality is stored separately from systemPrompt and injected as its
    // own block at resolve time (see routes/_helpers/agent-resolver.mjs), so
    // renames/role swaps that rebuild the template never wipe it.
    ...(typeof personality === 'string' && personality.trim() ? { personality: personality.trim() } : {}),
    custom: true,
    ...(ownerId    ? { ownerId }    : {}),
    ...(maxTokens  ? { maxTokens }  : {}),
    ...(contextSize ? { contextSize } : {}),
    // reasoningEffort is intentionally NOT stored here — it is a per-user
    // (account-specific) setting kept in each user's agentOverrides, so two
    // users sharing an agent can pick different efforts. See routes/agents.mjs.
  };
  const userId = ownerId ?? 'shared';
  const list = loadUserAgents(userId);
  list.push(agent);
  saveUserAgents(userId, list);
  return agent;
}

export function updateCustomAgent(id, changes) {
  if (changes && 'ownerId' in changes) {
    throw new Error('ownerId is immutable; agents cannot be transferred between users');
  }
  const all = loadCustomAgents();
  const existing = all.find(a => a.id === id);
  if (!existing) return null;
  const userId = existing.ownerId ?? 'shared';
  const list = loadUserAgents(userId);
  const idx = list.findIndex(a => a.id === id);
  if (idx === -1) return null;
  const prev = list[idx];
  const next = { ...prev, ...changes };
  if (!changes.systemPrompt && (changes.name || changes.emoji || changes.description)) {
    // Rebuild the template prompt ONLY when the stored prompt is still the
    // template for the OLD identity — renaming used to rebuild
    // unconditionally, silently wiping a user's customized prompt. If the
    // template renderer ever changes shape, mismatches fail SAFE (keep the
    // stored prompt).
    const prevTemplate = buildSystemPrompt(prev.name, prev.emoji, prev.description ?? '');
    if (!prev.systemPrompt || prev.systemPrompt === prevTemplate) {
      next.systemPrompt = buildSystemPrompt(
        next.name, next.emoji, next.description ?? prev.description ?? ''
      );
    }
  }
  list[idx] = next;
  saveUserAgents(userId, list);
  return list[idx];
}

export async function deleteCustomAgent(id) {
  const all = loadCustomAgents();
  const existing = all.find(a => a.id === id);
  if (!existing) return;
  const userId = existing.ownerId ?? 'shared';
  const list = loadUserAgents(userId).filter(a => a.id !== id);
  saveUserAgents(userId, list);
  // Drop the agent's session JSONL, streaming buffer, LM Studio response-id
  // file, and the in-memory tracking entries. Without this, a deleted agent
  // leaves litter on disk forever and Map keys in sessions.mjs never get
  // evicted — caught while auditing the post-logger-fix hot paths.
  try {
    const { deleteSession } = await import('./sessions.mjs');
    await deleteSession(`${userId}_${id}`);
  } catch (e) {
    console.warn('[agents] deleteSession on agent removal failed:', e.message);
  }
}

// Update name/emoji for ANY agent (built-in or custom) — built-ins stored in config.json
export async function updateAgentMeta(id, changes) {
  // Custom agents: update the JSON file
  const customs = loadCustomAgents();
  if (customs.find(a => a.id === id)) return updateCustomAgent(id, changes);

  // Built-in agents: store allowed overrides in config.json agentModels.
  // NOTE: reasoningEffort is deliberately excluded — it is per-user state
  // (users/<id>/agentOverrides), never a global agent-config field.
  const allowed = {};
  for (const k of ['name', 'emoji', 'model', 'provider', 'maxTokens', 'contextSize']) {
    if (k in changes) allowed[k] = changes[k];
  }
  if (!Object.keys(allowed).length) return null;
  try {
    // Same lock key as routes/_helpers modifyConfig, so this raw round-trip
    // (encrypted values stay encrypted — we never touch them) can't interleave
    // with a lock-holding Settings save and lose one side's fields. Atomic
    // temp+rename write so a crash can't tear config.json.
    await withLock(CFG_PATH, () => {
      const cfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};
      cfg.agentModels = cfg.agentModels ?? {};
      cfg.agentModels[id] = { ...(cfg.agentModels[id] ?? {}), ...allowed };
      atomicWriteSync(CFG_PATH, JSON.stringify(cfg, null, 2));
    });
    invalidateModelOverridesCache();
    return getAgent(id);
  } catch (e) { console.warn('[agents] Failed to update agent meta:', e.message); return null; }
}

function getAgentModelOverrides() {
  if (_modelOverridesCache) return _modelOverridesCache;
  const cfg = readConfig();
  _modelOverridesCache = cfg.agentModels ?? {};
  return _modelOverridesCache;
}

export function invalidateModelOverridesCache() {
  _modelOverridesCache = null;
}

/**
 * Returns the ID of the coordinator agent from config.
 */
export function getCoordinatorAgentId() {
  const cfg = readConfig();
  return cfg.coordinatorAgent ?? null;
}

/**
 * Returns { model, provider } for the coordinator agent,
 * resolving config overrides over the custom agent definition.
 */
function getCoordinatorModel() {
  const coordId = getCoordinatorAgentId();
  const overrides = getAgentModelOverrides()[coordId] ?? {};
  const agent = findAgentById(coordId);
  return {
    model:    overrides.model    ?? agent?.model    ?? 'claude-sonnet-4-6',
    provider: overrides.provider ?? agent?.provider ?? 'anthropic',
  };
}

export function getAgentScope(id) {
  const agent = findAgentById(id);
  const overrides = getAgentModelOverrides()[id] ?? {};
  const scope = overrides.scope ?? agent?.scope ?? 'private';
  const shareGroup = overrides.shareGroup ?? agent?.shareGroup ?? null;
  const crossAgentRead = overrides.crossAgentRead ?? agent?.crossAgentRead ?? [];
  return { scope, shareGroup, crossAgentRead };
}

export function getAgent(id) {
  const overrides = getAgentModelOverrides();
  const agent = findAgentById(id);
  if (!agent) return null;
  const a = overrides[id] ? { ...agent, ...overrides[id] } : agent;
  return { ...a, tools: a.tools ?? [] };
}

export function listAgents() {
  const overrides = getAgentModelOverrides();
  return loadCustomAgents().map(a => {
    const resolved = overrides[a.id] ? { ...a, ...overrides[a.id] } : a;
    return { ...resolved, tools: resolved.tools ?? [] };
  });
}
