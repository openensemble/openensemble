/**
 * OpenEnsemble Roles Registry
 *
 * Discovers and loads skill modules from two locations:
 *   - /skills/{skillId}/           → global skills, visible to every user
 *   - /users/{userId}/skills/{id}/ → per-user custom skills, visible only to their creator
 *
 * Each skill has a manifest.json (metadata + tool schemas) and execute.mjs (executor).
 *
 * Internal keying:
 *   - Global skills:  key = "global:{skillId}"
 *   - User skills:    key = "user:{userId}:{skillId}"
 * This is invisible to callers — public functions take (id, userId?) and resolve internally.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync, cpSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import { SKILLS_DIR, CFG_PATH, USERS_DIR, userSkillsDir } from './lib/paths.mjs';
import { log } from './logger.mjs';

// Wrapper shape: { manifest, userId, dir }
//   userId: null for global, userId string for per-user
//   dir:    absolute path to the skill directory on disk
const _manifests    = new Map();  // internalKey -> wrapper
const _executors    = new Map();  // internalKey -> execute function
const _executorBust = new Map();  // internalKey -> bust timestamp

const globalKey = id => `global:${id}`;
const userKey   = (uid, id) => `user:${uid}:${id}`;

// Try resolving an id in the user's scope first, then globally. Returns internalKey or null.
function resolveKey(id, userId) {
  if (userId) {
    const uk = userKey(userId, id);
    if (_manifests.has(uk)) return uk;
  }
  const gk = globalKey(id);
  if (_manifests.has(gk)) return gk;
  return null;
}

// Iterate entries visible to a given caller: globals + that user's own skills.
// Used by execution paths so a user can never reach another user's tool.
function* visibleEntries(userId) {
  for (const [key, wrap] of _manifests) {
    if (wrap.userId === null || wrap.userId === userId) yield [key, wrap];
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

// Load all manifests synchronously — called once at startup from server.mjs
export function loadRoleManifests() {
  _manifests.clear();

  // Pass 1: global skills
  if (existsSync(SKILLS_DIR)) {
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(SKILLS_DIR, entry.name);
      const mPath = path.join(dir, 'manifest.json');
      if (!existsSync(mPath)) continue;
      try {
        const m = JSON.parse(readFileSync(mPath, 'utf8'));
        const id = m.id ?? entry.name;
        _manifests.set(globalKey(id), { manifest: m, userId: null, dir });
      } catch (e) {
        console.warn(`[roles] Failed to load global manifest for ${entry.name}:`, e.message);
      }
    }
  }

  // Migration runs between the two passes: globals are loaded (needed for the
  // profile-cleanup logic to recognize global ids), then any legacy /skills/usr_*
  // entries get moved into /users/{createdBy}/skills/{slug} before Pass 2 picks them up.
  try { migrateLegacyUserSkills(); }
  catch (e) { console.warn('[migrate] Legacy user skill migration failed:', e.message); }

  // Pass 2: per-user custom skills
  if (existsSync(USERS_DIR)) {
    for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const uid = entry.name;
      // Skip junk / validation directories that have no profile.json
      if (!existsSync(path.join(USERS_DIR, uid, 'profile.json'))) continue;
      const skillRoot = userSkillsDir(uid);
      if (!existsSync(skillRoot)) continue;
      for (const sEntry of readdirSync(skillRoot, { withFileTypes: true })) {
        if (!sEntry.isDirectory()) continue;
        const dir = path.join(skillRoot, sEntry.name);
        const mPath = path.join(dir, 'manifest.json');
        if (!existsSync(mPath)) continue;
        try {
          const m = JSON.parse(readFileSync(mPath, 'utf8'));
          const id = m.id ?? sEntry.name;
          if (!m.createdBy) m.createdBy = uid;  // stamp ownership if missing
          _manifests.set(userKey(uid, id), { manifest: m, userId: uid, dir });
        } catch (e) {
          console.warn(`[roles] Failed to load user manifest for ${uid}/${sEntry.name}:`, e.message);
        }
      }
    }
  }
}

// ── Legacy migration: /skills/usr_* → /users/{createdBy}/skills/{slug} ────────

function migrateLegacyUserSkills() {
  if (!existsSync(SKILLS_DIR)) return;
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('usr_')) continue;
    const oldDir = path.join(SKILLS_DIR, entry.name);
    const manifestPath = path.join(oldDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (e) { console.warn(`[migrate] Failed to read ${manifestPath}:`, e.message); continue; }
    const createdBy = manifest.createdBy;
    if (!createdBy) {
      console.warn(`[migrate] ⚠️  /skills/${entry.name}: no createdBy field — leaving in place`);
      continue;
    }
    if (!existsSync(path.join(USERS_DIR, createdBy))) {
      console.warn(`[migrate] ⚠️  /skills/${entry.name}: createdBy=${createdBy} but /users/${createdBy} not found — leaving in place`);
      continue;
    }
    const slug = entry.name.replace(/^usr_/, '');
    const newParent = userSkillsDir(createdBy);
    const newDir = path.join(newParent, slug);
    if (existsSync(newDir)) {
      console.warn(`[migrate] ⏭  /users/${createdBy}/skills/${slug} already exists — skipping /skills/${entry.name}`);
      continue;
    }
    try {
      mkdirSync(newParent, { recursive: true });
      try { renameSync(oldDir, newDir); }
      catch (e) {
        if (e.code === 'EXDEV') {
          cpSync(oldDir, newDir, { recursive: true });
          rmSync(oldDir, { recursive: true, force: true });
        } else throw e;
      }
      // Rewrite manifest with stripped id so on-disk id matches the new slug
      const newManifest = { ...manifest, id: slug };
      writeFileSync(path.join(newDir, 'manifest.json'), JSON.stringify(newManifest, null, 2));
      // Drop the stale entry from the global manifests map (it was loaded in Pass 1)
      _manifests.delete(globalKey(entry.name));
      console.log(`[migrate] /skills/${entry.name} → /users/${createdBy}/skills/${slug}`);
    } catch (e) {
      console.warn(`[migrate] Failed to migrate /skills/${entry.name}:`, e.message);
    }
  }

  // Cross-user profile cleanup: drop stale usr_* references and rewrite self-owned to new slug.
  // Guarded per-user by a .migrated marker file so it only runs once.
  if (!existsSync(USERS_DIR)) return;
  for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    const profilePath = path.join(USERS_DIR, uid, 'profile.json');
    if (!existsSync(profilePath)) continue;
    const skillRoot = userSkillsDir(uid);
    const marker = path.join(skillRoot, '.migrated');
    if (existsSync(marker)) continue;
    try {
      const user = JSON.parse(readFileSync(profilePath, 'utf8'));
      const ownedIds = existsSync(skillRoot)
        ? readdirSync(skillRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        : [];
      const ownedSet = new Set(ownedIds);
      const isGlobal = id => _manifests.has(globalKey(id));

      const before = Array.isArray(user.skills) ? [...user.skills] : null;
      if (before) {
        user.skills = before
          .map(s => s.startsWith('usr_') ? s.replace(/^usr_/, '') : s)
          .filter(s => isGlobal(s) || ownedSet.has(s));
      }

      if (user.skillAssignments && typeof user.skillAssignments === 'object') {
        const next = {};
        for (const [sid, agent] of Object.entries(user.skillAssignments)) {
          const key = sid.startsWith('usr_') ? sid.replace(/^usr_/, '') : sid;
          if (isGlobal(key) || ownedSet.has(key)) next[key] = agent;
        }
        user.skillAssignments = next;
      }

      if (before) {
        const after = user.skills ?? [];
        const removed = before.filter(s => {
          const rewritten = s.startsWith('usr_') ? s.replace(/^usr_/, '') : s;
          return !after.includes(rewritten);
        });
        if (removed.length) console.log(`[migrate] ${uid}: cleaned user.skills (removed: ${removed.join(', ')})`);
      }
      writeFileSync(profilePath, JSON.stringify(user, null, 2));
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    } catch (e) {
      console.warn(`[migrate] Failed to clean profile for ${uid}:`, e.message);
    }
  }
}

// ── Public registry API ───────────────────────────────────────────────────────

/** Return all skill manifests visible to `userId` — globals + that user's own skills. */
export function listRoles(userId = null) {
  const out = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId === null || wrap.userId === userId) out.push(wrap.manifest);
  }
  return out;
}

/** Return every manifest in the registry regardless of ownership. For admin/debug use only. */
export function listAllRoles() {
  return [..._manifests.values()].map(w => w.manifest);
}

/** Look up a manifest by id. Tries the user scope first, then globals. */
export function getRoleManifest(id, userId = null) {
  const key = resolveKey(id, userId);
  return key ? _manifests.get(key).manifest : null;
}

/** Add or replace a manifest. If `userId` is given, stores as a per-user skill. */
export function addRoleManifest(manifest, userId = null) {
  const id = manifest.id;
  if (userId) {
    const dir = path.join(userSkillsDir(userId), id);
    _manifests.set(userKey(userId, id), { manifest, userId, dir });
  } else {
    const dir = path.join(SKILLS_DIR, id);
    _manifests.set(globalKey(id), { manifest, userId: null, dir });
  }
}

/** Remove a manifest from the registry. Pass `userId` to target a per-user skill. */
export function removeRoleManifest(id, userId = null) {
  const key = userId ? userKey(userId, id) : globalKey(id);
  _manifests.delete(key);
  _executors.delete(key);
  _executorBust.delete(key);
}

/** Clear an executor cache entry so the next call re-imports fresh code. */
export function clearExecutorCache(skillId, userId = null) {
  const key = resolveKey(skillId, userId);
  if (!key) return;
  _executors.delete(key);
  _executorBust.set(key, Date.now());
}

export function getRoleTools(id, userId = null) {
  return getRoleManifest(id, userId)?.tools ?? [];
}

export function getToolsForRoleIds(roleIds, userId = null) {
  return roleIds.flatMap(id => getRoleTools(id, userId));
}

// ── Role Assignments ──────────────────────────────────────────────────────────
// Owner/admin assignments live in config.json; non-owner users have their own
// assignments stored in their users.json record under `skillAssignments`.
function _isPrivilegedUserRole(role) { return role === 'owner' || role === 'admin'; }

export function getRoleAssignments(userId) {
  if (userId) {
    try {
      const userPath = path.join(USERS_DIR, userId, 'profile.json');
      if (existsSync(userPath)) {
        const user = JSON.parse(readFileSync(userPath, 'utf8'));
        if (user && !_isPrivilegedUserRole(user.role)) return user.skillAssignments ?? {};
      }
    } catch {}
  }
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf8')).skillAssignments ?? {}; } catch { return {}; }
}

export function getRoleAssignment(roleId, userId) {
  return getRoleAssignments(userId)[roleId] ?? null;
}

/**
 * Return all service role ids currently held by a given agent for this user.
 * Accepts either a scoped agent id ("user_XYZ_ada") or a bare one ("ada").
 * Only `service: true` roles are returned — delegate/system roles are skipped.
 */
export function getAgentRoles(agentId, userId) {
  if (!agentId) return [];
  const bare = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const assignments = getRoleAssignments(userId);
  const out = [];
  for (const [roleId, assignedAgentId] of Object.entries(assignments)) {
    if (assignedAgentId !== bare) continue;
    const manifest = getRoleManifest(roleId, userId);
    if (manifest?.service) out.push(roleId);
  }
  return out;
}

// Role → drawer-plugin pairs that should auto-enable on assignment.
const ROLE_DRAWER_AUTO_ENABLE = {
  role_tutor: 'tutor-today',
};

function syncDrawerForRoleAssignment(userId, roleId, agentId) {
  if (!userId) return;
  const drawerId = ROLE_DRAWER_AUTO_ENABLE[roleId];
  if (!drawerId || !agentId) return;
  try {
    const userPath = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(userPath)) return;
    const user = JSON.parse(readFileSync(userPath, 'utf8'));
    let dirty = false;
    user.pluginPrefs = user.pluginPrefs ?? {};
    user.pluginPrefs[drawerId] = user.pluginPrefs[drawerId] ?? {};
    if (user.pluginPrefs[drawerId].enabled !== true) {
      user.pluginPrefs[drawerId].enabled = true;
      dirty = true;
    }
    if (Array.isArray(user.allowedFeatures) && !user.allowedFeatures.includes(drawerId)) {
      user.allowedFeatures = [...user.allowedFeatures, drawerId];
      dirty = true;
    }
    if (dirty) writeFileSync(userPath, JSON.stringify(user, null, 2));
  } catch {}
}

export function setRoleAssignment(roleId, agentId, userId) {
  if (userId) {
    try {
      const userPath = path.join(USERS_DIR, userId, 'profile.json');
      if (existsSync(userPath)) {
        const user = JSON.parse(readFileSync(userPath, 'utf8'));
        if (user && !_isPrivilegedUserRole(user.role)) {
          user.skillAssignments = user.skillAssignments ?? {};
          if (agentId) user.skillAssignments[roleId] = agentId;
          else delete user.skillAssignments[roleId];
          writeFileSync(userPath, JSON.stringify(user, null, 2));
          syncDrawerForRoleAssignment(userId, roleId, agentId);
          return;
        }
      }
    } catch {}
  }
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch {}
  cfg.skillAssignments = cfg.skillAssignments ?? {};
  if (agentId) cfg.skillAssignments[roleId] = agentId;
  else delete cfg.skillAssignments[roleId];
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  // Privileged users (owner/admin) also get per-user pluginPrefs synced so the
  // drawer toggle reflects the role they just assigned.
  syncDrawerForRoleAssignment(userId, roleId, agentId);
}

/**
 * One-shot backfill: walk every user and enable role-paired drawers for any
 * role they already have assigned. Safe to call at startup; idempotent.
 */
export function reconcileRoleDrawers() {
  if (!existsSync(USERS_DIR)) return;
  let globalCfg = {};
  try { globalCfg = JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch {}
  const globalAssignments = globalCfg.skillAssignments ?? {};
  for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const userPath = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(userPath)) continue;
    let user;
    try { user = JSON.parse(readFileSync(userPath, 'utf8')); } catch { continue; }
    const assignments = _isPrivilegedUserRole(user?.role)
      ? globalAssignments
      : (user?.skillAssignments ?? {});
    for (const [roleId, agentId] of Object.entries(assignments)) {
      if (ROLE_DRAWER_AUTO_ENABLE[roleId] && agentId) {
        syncDrawerForRoleAssignment(userId, roleId, agentId);
      }
    }
  }
}

// ── Tool resolution ───────────────────────────────────────────────────────────

// Tools from always_on skills — injected into every agent regardless of category.
// Intentionally global-only: a user's custom always_on: true skill should NOT leak
// into other users' sessions. This is an isolation tradeoff — user custom skills
// must be explicitly enabled via user.skills rather than auto-injected.
function getAlwaysOnTools() {
  const tools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (wrap.manifest.always_on) tools.push(...(wrap.manifest.tools ?? []));
  }
  return tools;
}

// Resolve what tools an agent gets based on its skillCategory and the user's enabled roles
export function resolveAgentTools(skillCategory, userSkills, agentId = null, userId = null) {
  const assignments = getRoleAssignments(userId);
  const coordinatorId = assignments['coordinator'] ?? null;
  const alwaysOn = getAlwaysOnTools();

  // Resolve assignment: supports literal agent IDs and the special "coordinator" alias
  function isAssignedTo(skillId) {
    const owner = assignments[skillId];
    if (!owner) return false;
    if (owner === agentId) return true;
    // "coordinator" alias: assign to whoever owns the coordinator skill
    if (owner === 'coordinator' && coordinatorId && coordinatorId === agentId) return true;
    return false;
  }

  // Utility roles: unassigned → all agents; assigned → only their agent
  const utilityTools = userSkills.filter(s => {
    const m = getRoleManifest(s, userId);
    if (m?.category !== 'utility') return false;
    const owner = assignments[s];
    return owner ? isAssignedTo(s) : true;
  }).flatMap(id => getRoleTools(id, userId));

  // Service roles (email, finance, etc.): assignment-based only — no implicit category lock
  const assignedTools = userSkills.filter(s => {
    const m = getRoleManifest(s, userId);
    if (!m || m.category === 'utility' || m.category === 'delegate') return false;
    return isAssignedTo(s);
  }).flatMap(id => getRoleTools(id, userId));

  // Always include the agent's primary role tools (even if not in userSkills).
  // Primary role is always a global skill category (coder, email, etc.).
  const primaryTools = skillCategory ? (getRoleManifest(skillCategory)?.tools ?? []) : [];

  const dedup = tools => {
    const seen = new Set();
    return tools.filter(t => {
      const name = t.function?.name ?? t.name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  };

  if (skillCategory === 'general' || skillCategory === 'web') {
    // Delegate tools are global-only by design (agent roster is global).
    const delegateTools = [];
    for (const wrap of _manifests.values()) {
      if (wrap.userId !== null) continue;
      if (wrap.manifest.category === 'delegate') delegateTools.push(...(wrap.manifest.tools ?? []));
    }
    return dedup([...alwaysOn, ...utilityTools, ...assignedTools, ...delegateTools]);
  }

  return dedup([...alwaysOn, ...utilityTools, ...assignedTools, ...primaryTools]);
}

// Get default role IDs for new users — globals only.
export function getDefaultRoles() {
  const out = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId === null && wrap.manifest.enabled_by_default) out.push(wrap.manifest.id);
  }
  return out;
}

// ── Executor loading ──────────────────────────────────────────────────────────

// Load executor lazily. `internalKey` identifies the wrapper; `dir` comes from it.
async function getExecutorByKey(internalKey) {
  if (_executors.has(internalKey)) return _executors.get(internalKey);
  const wrap = _manifests.get(internalKey);
  if (!wrap) return null;
  const execPath = path.join(wrap.dir, 'execute.mjs');
  if (!existsSync(execPath)) return null;
  try {
    const bust = _executorBust.get(internalKey);
    const url = pathToFileURL(execPath).href + (bust ? `?v=${bust}` : '');
    const mod = await import(url);
    const fn = mod.default ?? mod.executeSkillTool ?? mod.execute ?? null;
    _executors.set(internalKey, fn);
    return fn;
  } catch (e) {
    console.warn(`[skills] Failed to load executor for ${internalKey}:`, e.message);
    return null;
  }
}

// Validate that every manifest tool name is actually handled by its executor.
// Runs at startup; mismatches are logged as warnings. Safe: a thrown error (bad args)
// still means the name was recognised — only null means "not handled".
export async function validateSkills() {
  for (const [internalKey, wrap] of _manifests) {
    const { manifest } = wrap;
    const execPath = path.join(wrap.dir, 'execute.mjs');
    if (!existsSync(execPath)) continue;
    const exec = await getExecutorByKey(internalKey);
    if (!exec) continue;
    const toolNames = (manifest.tools ?? []).map(t => t.function?.name).filter(Boolean);
    if (toolNames.length === 0) continue;
    const unhandled = [];
    for (const toolName of toolNames) {
      try {
        const result = await exec(toolName, { __validate: true }, null, null);
        if (result === null) unhandled.push(toolName);
      } catch {
        // threw on bad args but the name was recognised — that's fine
      }
    }
    if (unhandled.length > 0) {
      const label = wrap.userId ? `${wrap.userId}/${manifest.id}` : manifest.id;
      console.warn(`[skills] ⚠️  ${label}: executor does not handle tool(s): ${unhandled.join(', ')}`);
      console.warn(`[skills]    Manifest tools: ${toolNames.join(', ')}`);
    }
  }
}

// Call a role's onEnable hook if it exports one — fire and forget from the caller
export async function onRoleEnabled(roleId, userId) {
  const key = resolveKey(roleId, userId);
  if (!key) return;
  const wrap = _manifests.get(key);
  const execPath = path.join(wrap.dir, 'execute.mjs');
  if (!existsSync(execPath)) return;
  try {
    const mod = await import(pathToFileURL(execPath).href);
    if (typeof mod.onEnable === 'function') await mod.onEnable(userId);
  } catch (e) {
    console.warn(`[roles] onEnable error for ${roleId}:`, e.message);
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────

// Lazy ws-handler import — avoids the chat-dispatch ↔ roles ↔ ws-handler cycle.
let _wsMod = null;
async function _wsHandler() {
  if (_wsMod === null) {
    try { _wsMod = await import('./ws-handler.mjs'); }
    catch { _wsMod = false; }
  }
  return _wsMod || null;
}

// Build the per-call context object passed to skill executors as the 5th arg.
// Skills that don't accept it (4-param signature) ignore it transparently.
async function buildCtx(userId, agentId) {
  const ctx = { userId, agentId };
  ctx.showImage = async ({ base64, mimeType = 'image/png', filename, savedPath, prompt } = {}) => {
    if (!agentId || !base64 || !filename) return 0;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'image', agent: agentId, base64, mimeType, filename, savedPath, prompt });
  };
  ctx.showVideo = async ({ url, filename, savedPath } = {}) => {
    if (!agentId || !url || !filename) return 0;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'video', agent: agentId, url, filename, savedPath });
  };
  return ctx;
}

// Execute a tool — routes to the skill that owns it, scoped to what `userId` can see.
export async function executeRoleTool(name, args, userId = 'default', agentId = null) {
  for (const [key, wrap] of visibleEntries(userId)) {
    if (wrap.manifest.tools?.some(t => t.function?.name === name)) {
      const exec = await getExecutorByKey(key);
      if (exec) return exec(name, args, userId, agentId, await buildCtx(userId, agentId));
      break;
    }
  }
  return null; // not handled by any skill
}

// Convenience alias — resolves tool to role and executes, with "Unknown tool" fallback
export async function executeTool(name, args, userId = 'default', agentId = null) {
  const result = await executeRoleTool(name, args, userId, agentId);
  if (result !== null) return result;
  return `Unknown tool: ${name}`;
}

// Tool name aliases — models sometimes call a bare name instead of the prefixed one.
const TOOL_ALIASES = {
  'todo_write':       'coder_todo_write',
  'todo_read':        'coder_todo_read',
  'write_file':       'coder_write_file',
  'read_file':        'coder_read_file',
  'edit_file':        'coder_edit_file',
  'run_command':      'coder_run_command',
  'list_files':       'coder_list_files',
  'search':           'coder_search',
  'create_project':   'coder_create_project',
  'switch_project':   'coder_switch_project',
  'start_server':     'coder_start_server',
  'stop_server':      'coder_stop_server',
  'server_status':    'coder_server_status',
};

// Read a user's profile directly without going through routes/_helpers.mjs
// (which would create a circular import). Used only for the child-account
// tool gate below — a tight, read-only, non-cached path.
function _readUserProfile(userId) {
  if (!userId) return null;
  try {
    const p = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return null; }
}

// Streaming variant — if the skill's executor returns an async generator, streams it.
// Otherwise wraps the promise result in a single { type: 'result' } yield.
// Yields: { type: 'token', text } | { type: 'tool_call', name, args }
//         | { type: 'tool_result', name, text } | { type: 'result', text }
export async function* executeToolStreaming(name, args, userId = 'default', agentId = null) {
  // Resolve alias before lookup so models that drop the skill prefix still work.
  const resolvedName = TOOL_ALIASES[name] ?? name;
  let skillExec = null;
  let owningSkillId = null;
  for (const [key, wrap] of visibleEntries(userId)) {
    if (wrap.manifest.tools?.some(t => t.function?.name === resolvedName)) {
      owningSkillId = wrap.manifest.id;
      skillExec = await getExecutorByKey(key);
      break;
    }
  }

  if (!skillExec) { yield { type: 'result', text: `Unknown tool: ${name}` }; return; }

  // Child-account allowedSkills enforcement — blocks tool calls that the model
  // hallucinated or that arrived via a delegation/prompt-injection path where
  // the tool schema wasn't normally offered. This is the *last* gate before
  // execution, so it catches paths that bypass the UI/roster filters.
  const profile = _readUserProfile(userId);
  if (profile?.role === 'child' && owningSkillId) {
    const allowed = profile.allowedSkills;
    if (Array.isArray(allowed) && !allowed.includes(owningSkillId)) {
      yield { type: 'result', text: `Tool "${name}" is not permitted for this account.` };
      return;
    }
  }
  // Use resolvedName for actual execution
  name = resolvedName;

  const _toolStart = Date.now();
  try {
    const result = skillExec(name, args, userId, agentId, await buildCtx(userId, agentId));
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      for await (const chunk of result) yield chunk;
    } else {
      const text = String((await result) ?? '');
      yield { type: 'result', text };
    }
    log.info('tool', 'tool complete', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart });
  } catch (e) {
    console.error(`[skills] Runtime error in tool "${name}":`, e.message);
    log.error('tool', 'tool threw', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart, err: e.message });
    yield { type: 'result', text: `Tool error (${name}): ${e.message}` };
  }
}
