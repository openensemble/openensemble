// @ts-check
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
import { buildProposeMonitor, buildCollectionHelpers } from './lib/monitor-helper.mjs';
import { mergeDefaults, recordToolCall, recordPinUsage } from './lib/tool-defaults.mjs';
import { recordToolFailure } from './lib/tool-failures.mjs';
import { isSkillDisabled, getHiddenTools } from './lib/skill-overrides.mjs';
import {
  isEphemeralAgentId as _isEphem,
  cacheGet as _ephemCacheGet,
  cacheSet as _ephemCacheSet,
  rerankListResult as _ephemRerank,
  isListStyleTool as _ephemIsListTool,
} from './lib/ephemeral-tool-cache.mjs';
import { log } from './logger.mjs';

// Resolve the agent id we should attribute background-task surfaces to
// (chip, session injection) when the caller didn't pass one. Uses the
// user's configured coordinator agent — works regardless of what each
// user named their coordinator. Falls back to userId only if the user has
// no coordinator assigned (edge case during onboarding).
async function _resolveAttributionAgent(userId, agentId) {
  if (agentId) return agentId;
  try {
    const { getUserCoordinatorAgentId } = await import('./routes/_helpers.mjs');
    const coordId = getUserCoordinatorAgentId(userId);
    return coordId ? `${userId}_${coordId}` : userId;
  } catch { return userId; }
}

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

  // Alias-framework: scan every loaded manifest for an `alias_catalog` block
  // and register a resolver for each. Done after both passes so user-skill
  // declarations are picked up alongside global ones. Lazy-imports the
  // framework so installs without it (none today) still boot cleanly.
  try {
    import('./lib/skill-alias-framework.mjs').then(async (fw) => {
      const allManifests = [..._manifests.values()].map(v => v.manifest);
      const importerFor = (skillId) => {
        const entry = [..._manifests.values()].find(v => v.manifest.id === skillId);
        if (!entry) return Promise.resolve({});
        // Reuse getExecutorByKey so we hit the same executor cache the
        // dispatcher uses; ensures exported_function catalog sources see
        // the same fresh code as live tool dispatches.
        const key = entry.userId ? userKey(entry.userId, skillId) : globalKey(skillId);
        return getExecutorByKey(key).then(execFn => {
          // execFn IS the skill's executeSkillTool. We need the WHOLE module
          // export object so exported_function can find named exports. Open
          // the file path and dynamic-import directly.
          const filePath = path.join(entry.dir, 'execute.mjs');
          return import(pathToFileURL(filePath).href + `?bust=${_executorBust.get(key) || 0}`)
            .catch(() => ({}));
        });
      };
      fw.registerFromManifests(allManifests, importerFor);

      // Lockdown migration (one-shot per user): every CUSTOM skill that
      // currently has no entry in the user's skillAssignments gets pinned
      // to that user's coordinator. Preserves today's effective behavior —
      // coordinators see the user's custom skills as before — while shutting
      // off the auto-bypass to specialists that was added in agent-resolver
      // (commit "lockdown specialist toolset"). After this runs once,
      // newly-created skills go through skill-builder's `assign_to` flow,
      // and existing skills can be reassigned via setRoleAssignment.
      try {
        const { getUserCoordinatorAgentId } = await import('./routes/_helpers.mjs');
        const seenUsers = new Set();
        for (const wrap of _manifests.values()) {
          const m = wrap.manifest;
          if (!m?.custom || !wrap.userId) continue;
          if (seenUsers.has(wrap.userId + ':' + m.id)) continue;
          seenUsers.add(wrap.userId + ':' + m.id);
          const assignments = getRoleAssignments(wrap.userId) || {};
          if (assignments[m.id]) continue;  // already assigned somewhere
          const coordId = getUserCoordinatorAgentId(wrap.userId);
          if (!coordId) continue;
          setRoleAssignment(m.id, coordId, wrap.userId);
          console.log(`[roles] lockdown-migration: assigned custom skill "${m.id}" to coordinator "${coordId}" for user ${wrap.userId}`);
        }
      } catch (e) { console.warn('[roles] lockdown-migration failed:', e.message); }

      // Cleanup: an earlier iteration tried to make active-agents and
      // skill-builder user-assignable (with a Settings UI dropdown). That
      // was the wrong model — they're inherent to the coordinator and coder
      // roles, not separately-assignable. The current design uses
      // `bundled_with_role` in the manifest (see resolveAgentTools). Strip
      // any leftover skillAssignments entries so they don't ghost in the UI.
      try {
        const { loadUsers, modifyUser } = await import('./routes/_helpers.mjs');
        const stale = ['active-agents', 'skill-builder'];
        // Owner / admin scoped assignments live in config.json.
        try {
          const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
          let dirty = false;
          for (const skillId of stale) {
            if (cfg.skillAssignments?.[skillId]) {
              delete cfg.skillAssignments[skillId];
              dirty = true;
              console.log(`[roles] cleanup: removed stale skillAssignments["${skillId}"] from config.json`);
            }
          }
          if (dirty) writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
        } catch (e) { console.debug('[roles] cleanup: config.json read/write skipped:', e.message); }
        // Plain-user scoped assignments live in users/<id>/profile.json.
        for (const u of loadUsers()) {
          if (!u.skillAssignments) continue;
          const needsClean = stale.some(k => u.skillAssignments[k]);
          if (!needsClean) continue;
          modifyUser(u.id, p => {
            for (const skillId of stale) delete p.skillAssignments?.[skillId];
          });
          console.log(`[roles] cleanup: removed stale scoped-tool assignments for user ${u.id}`);
        }
      } catch (e) { console.warn('[roles] scoped-tools-cleanup failed:', e.message); }

      // System-level "agent" catalog — no skill manifest owns agents, so
      // we register a runtime spec with an inline function that calls
      // getAgentsForUser. Same shape as a manifest-declared catalog but
      // the listEntries is a JS function, not a config-file path.
      try {
        const { getAgentsForUser } = await import('./routes/_helpers/agent-resolver.mjs');
        fw.registerAliasCatalog({
          entity_kind:   'agent',
          noun_singular: 'agent',
          noun_plural:   'agents',
          extra_phrase_patterns: [
            "\\bask\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\b",
            "\\btalk\\s+to\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\b",
            "\\btell\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\s+to\\b",
            "\\bdelegate\\s+(?:this\\s+)?to\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\b",
          ],
          catalog_source: {
            type: 'inline_function',
            fn: (userId) => {
              const agents = getAgentsForUser(userId) || [];
              return agents.map(a => ({
                id: a.id,
                name: a.name || a.id,
                role: a.role || a.skillCategory || 'specialist',
                description: a.description || '',
              }));
            },
          },
          id_field:     'id',
          name_fields:  ['name', 'id'],
          id_arg_names: ['agent_id', 'agentId'],
          cascade_on_tools: [],
        }, null);
      } catch (e) { console.warn('[roles] agent-alias system register failed:', e.message); }
    }).catch(e => console.warn('[roles] alias-framework boot register failed:', e.message));
  } catch (e) { /* framework optional */ }
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
    if (wrap.userId === null || wrap.userId === userId) {
      // Phase-10: user can disable any non-always_on skill. The override is
      // read at runtime from disk — manifests stay immutable in the cache.
      if (userId && isSkillDisabled(userId, wrap.manifest.id, !!wrap.manifest.always_on)) continue;
      // userScope: null = global skill, <userId> = user-scoped custom skill.
      // Surfaced so admin UIs can filter out user-scoped skills when rendering
      // cross-user permission grids — granting another user access to a
      // user-scoped skill is a no-op since the registry won't yield it to them.
      out.push({ ...wrap.manifest, userScope: wrap.userId });
    }
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
  let dir;
  if (userId) {
    dir = path.join(userSkillsDir(userId), id);
    _manifests.set(userKey(userId, id), { manifest, userId, dir });
  } else {
    dir = path.join(SKILLS_DIR, id);
    _manifests.set(globalKey(id), { manifest, userId: null, dir });
  }
  // Register the alias catalog if this manifest declares one. Mirrors the
  // boot-time registration in loadRoleManifests so newly-created skills
  // (via skill-builder skill_create) pick up alias support immediately.
  if (manifest.alias_catalog) {
    import('./lib/skill-alias-framework.mjs').then(fw => {
      const filePath = path.join(dir, 'execute.mjs');
      const key = userId ? userKey(userId, id) : globalKey(id);
      const importer = () => import(pathToFileURL(filePath).href + `?bust=${_executorBust.get(key) || 0}`).catch(() => ({}));
      // Unregister first in case this is a replace (skill_update_code) — the
      // entity_kind may have changed, or the catalog source may differ.
      try { fw.unregisterAliasCatalog(manifest.alias_catalog.entity_kind); } catch {}
      fw.registerAliasCatalog(manifest.alias_catalog, importer);
    }).catch(e => console.warn('[roles] alias-framework register failed:', e.message));
  }
}

/** Remove a manifest from the registry. Pass `userId` to target a per-user skill. */
export function removeRoleManifest(id, userId = null) {
  const key = userId ? userKey(userId, id) : globalKey(id);
  const entry = _manifests.get(key);
  // Drop the alias-framework registration BEFORE clearing the manifest so we
  // can read the entity_kind off the about-to-be-removed entry. Without this,
  // a deleted skill's alias resolver keeps trying to load its catalog on
  // every chat turn and logs a noisy file-not-found.
  if (entry?.manifest?.alias_catalog?.entity_kind) {
    import('./lib/skill-alias-framework.mjs')
      .then(fw => fw.unregisterAliasCatalog(entry.manifest.alias_catalog.entity_kind))
      .catch(() => {});
  }
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
  const tools = getRoleManifest(id, userId)?.tools ?? [];
  // Phase-10: per-user hidden-tools filter. Removes any tool whose
  // function.name appears in users/<id>/skill-overrides.json[id].hiddenTools.
  if (userId && tools.length) {
    const hidden = getHiddenTools(userId, id);
    if (hidden.length) {
      const set = new Set(hidden);
      return tools.filter(t => !set.has(t?.function?.name));
    }
  }
  return tools;
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
 * Accepts either a scoped agent id ("user_XYZ_coder") or a bare one ("coder").
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

// Tools that ride along with a primary role — e.g. active-agents is "the
// coordinator's job" and skill-builder is "the coder's job". The manifest
// declares `bundled_with_role: <roleId>` and the resolver auto-injects
// those tools whenever an agent's skillCategory matches. Treated as part
// of the role, not a separately-assignable skill (so they're also marked
// `hidden: true` so they don't show up in Settings → Skills).
function getBundledRoleTools(skillCategory) {
  if (!skillCategory) return [];
  const tools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (wrap.manifest.bundled_with_role === skillCategory) {
      tools.push(...(wrap.manifest.tools ?? []));
    }
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

  // Tools bundled with the primary role (e.g. active-agents → coordinator,
  // skill-builder → coder). These are treated as inherent to the role, not
  // as separately-assignable skills, so they're auto-injected here.
  const bundledTools = getBundledRoleTools(skillCategory);

  const dedup = tools => {
    const seen = new Set();
    return tools.filter(t => {
      const name = t.function?.name ?? t.name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  };

  // Delegate tools (ask_agent etc.) flow to EVERY agent now — not just the
  // coordinator. Specialists can escalate to the coordinator when they hit
  // a wall (no email tool, no skill-edit tool, etc.). The actual restriction
  // ("specialists may only target the coordinator") and the depth cap are
  // enforced inside skills/delegate/execute.mjs at call time.
  const delegateTools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (wrap.manifest.category === 'delegate') delegateTools.push(...(wrap.manifest.tools ?? []));
  }
  if (skillCategory === 'general' || skillCategory === 'web') {
    return dedup([...alwaysOn, ...utilityTools, ...assignedTools, ...delegateTools, ...bundledTools]);
  }
  return dedup([...alwaysOn, ...utilityTools, ...assignedTools, ...primaryTools, ...bundledTools, ...delegateTools]);
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

// Cache the full module per skill so we can read named exports
// (watcherHandlers, etc.) in addition to the default executor function.
const _modules = new Map(); // internalKey -> imported module

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
    _modules.set(internalKey, mod);
    return fn;
  } catch (e) {
    console.warn(`[skills] Failed to load executor for ${internalKey}:`, e.message);
    return null;
  }
}

/**
 * Return a watcher handler from the named skill, or null if not present.
 * Used by the watcher supervisor to look up handlers lazily.
 */
export async function getWatcherHandler(skillId, userId, kind) {
  const key = resolveKey(skillId, userId);
  if (!key) return null;
  // Trigger lazy load to populate _modules.
  await getExecutorByKey(key);
  const mod = _modules.get(key);
  return mod?.watcherHandlers?.[kind] || null;
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
  // Providers pass the scoped `${userId}_${rawAgentId}` here, but the dashboard
  // matches inbound bubbles against the raw agent id. Strip the prefix so
  // ctx.showImage/showVideo land in the right chat thread.
  const wsAgentId = (userId && typeof agentId === 'string' && agentId.startsWith(`${userId}_`))
    ? agentId.slice(userId.length + 1)
    : agentId;
  const ctx = { userId, agentId };
  ctx.showImage = /** @param {{base64?: string, mimeType?: string, filename?: string, savedPath?: string, prompt?: string}} [opts] */ async ({ base64, mimeType = 'image/png', filename, savedPath, prompt } = {}) => {
    if (!wsAgentId || !base64 || !filename) return 0;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'image', agent: wsAgentId, base64, mimeType, filename, savedPath, prompt });
  };
  ctx.showVideo = /** @param {{url?: string, filename?: string, savedPath?: string}} [opts] */ async ({ url, filename, savedPath } = {}) => {
    if (!wsAgentId || !url || !filename) return 0;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'video', agent: wsAgentId, url, filename, savedPath });
  };

  // Register a long-running poll/watcher. Supervisor in scheduler/watchers.mjs
  // ticks each watcher's handler (defined via the skill's watcherHandlers
  // export) on its cadence. Status updates land as muted/italic chat bubbles
  // distinct from agent assistant turns.
  //
  // opts: { kind, state?, cadenceSec?, expiresAt, label?, skillId? }
  // Returns the watcherId (string) or null if registration was rejected
  // (per-user cap, missing fields).
  //
  // expiresAt should be set explicitly by the caller based on a realistic
  // estimate of how long the work takes. Pass `null` for indefinite watchers
  // (price alerts, "tell me when X" — supervisor never auto-reaps these,
  // user must dismiss them from the tasks drawer).
  ctx.watch = /** @param {{kind?: string, state?: any, cadenceSec?: number, expiresAt?: number|null, skillId?: string, label?: string, onFire?: any}} [opts] */ async (opts = {}) => {
    try {
      const watchers = await import('./scheduler/watchers.mjs');
      return watchers.registerWatcher(/** @type {any} */ ({
        ...opts,
        userId,
        agentId: wsAgentId,
        // If the caller didn't specify which skill owns this watcher, try to
        // infer it. The agent in this ctx might not be a skill; an explicit
        // skillId is best-effort and required only if the handler is not in
        // the system registry.
        skillId: opts.skillId || null,
      }));
    } catch (e) { console.warn('[ctx.watch]', e.message); return null; }
  };
  ctx.unwatch = async (watcherId) => {
    try {
      const watchers = await import('./scheduler/watchers.mjs');
      return watchers.unregisterWatcher(userId, watcherId);
    } catch (e) { console.warn('[ctx.unwatch]', e.message); return false; }
  };
  // Bulk-cancel watchers matching a predicate. Used by skills that tear down
  // a resource a watcher polls (e.g. terminating a pod that has a render
  // watcher attached) so we don't keep showing stale progress bubbles.
  // predicate is a sync function (record) -> bool, evaluated in-process.
  ctx.unwatchMatching = async (predicate) => {
    try {
      const watchers = await import('./scheduler/watchers.mjs');
      return watchers.unregisterMatchingWatchers(userId, predicate);
    } catch (e) { console.warn('[ctx.unwatchMatching]', e.message); return 0; }
  };
  // proposeMonitor: high-level wrapper around ctx.watch that handles cadence
  // presets ('daily', 'weekly', …), default expiresAt=null for open-ended
  // monitors, default onFire shape, and dedup so "propose after N uses"
  // heuristics don't stack N copies of the same watcher. Lives in
  // lib/monitor-helper.mjs so skill-builder can teach the LLM a single
  // call shape for "ping me when X changes" instead of forcing every skill
  // to re-learn registerWatcher's arg layout.
  ctx.proposeMonitor = buildProposeMonitor({ userId, agentId: wsAgentId });

  // ctx.collection — group many similar items under ONE watcher record with
  // per-item cadence. Use when a skill needs to monitor N peers (channels,
  // retailers, stores, products) that share the same handler logic. Each
  // item polls at its own cadenceSec; the parent watcher ticks at 60s and
  // the handler iterates due items via helpers.mapItems. See
  // lib/monitor-helper.mjs:buildCollectionHelpers JSDoc for the full API.
  // skillIdHint is bound late — skills pass their own SKILL_ID through the
  // `ensure({ skillId })` arg if they need cross-skill isolation, otherwise
  // the helpers fall back to the (kind) key alone.
  ctx.collection = buildCollectionHelpers({ userId, agentId: wsAgentId });

  // Encrypted credential primitive — wraps lib/credentials.mjs so user skills
  // don't have to know the install-root-relative import depth (four-up from
  // users/<id>/skills/<id>/execute.mjs, two-up from built-in skills/<id>/
  // execute.mjs — easy to miscount). Plaintext values from requestCredential
  // never enter the LLM message history; the chat-providers substitute a
  // placeholder when the tool result is flagged { isCredential: true }.
  //
  //   const key = await ctx.getCredential('myskill_api_key')
  //              ?? await ctx.requestCredential({
  //                   id: 'myskill_api_key',
  //                   label: 'My Service API key',
  //                   kind: 'api_key', persist: true,
  //                 });
  ctx.getCredential = async (id) => {
    try {
      const m = await import('./lib/credentials.mjs');
      return m.getCredentialValue(userId, id);
    } catch (e) { console.warn('[ctx.getCredential]', e.message); return null; }
  };
  ctx.requestCredential = async (opts = {}) => {
    try {
      const m = await import('./lib/credentials.mjs');
      return m.requestCredential({ ...opts, userId });
    } catch (e) { console.warn('[ctx.requestCredential]', e.message); return null; }
  };
  ctx.storeCredential = async (opts = /** @type {any} */ ({})) => {
    try {
      const m = await import('./lib/credentials.mjs');
      return m.storeCredential(userId, opts);
    } catch (e) { console.warn('[ctx.storeCredential]', e.message); return null; }
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
//
// allowedTools: optional array of tool names (from agent.tools resolution).
// When provided, any tool call outside that set is refused — defends against
// LLM hallucinated calls and prompt-injected JSON tool_calls that try to
// reach destructive tools (node_exec, dispatch_op, send_email, etc.) outside
// the agent's declared toolset. Caller is responsible for resolving alias
// names before passing the list (we re-check post-alias below).
export async function* executeToolStreaming(name, args, userId = 'default', agentId = null, allowedTools = null) {
  // Resolve alias before lookup so models that drop the skill prefix still work.
  const resolvedName = TOOL_ALIASES[name] ?? name;

  // Per-agent allowlist enforcement. Reject with a generic "Unknown tool"
  // message so a probing model can't enumerate which tools exist on the box.
  if (Array.isArray(allowedTools) && allowedTools.length) {
    const allow = new Set(allowedTools.flatMap(n => [n, TOOL_ALIASES[n] ?? n]));
    if (!allow.has(resolvedName)) {
      log.warn('tool', 'tool call outside agent allowlist', { tool: resolvedName, userId, agentId });
      yield { type: 'result', text: `Unknown tool: ${name}` };
      return;
    }
  }

  let skillExec = null;
  let owningSkillId = null;
  // MCP-namespaced server tools (mcp_<server>__<tool>) route to skills/mcp/.
  // Detected by the `__` namespace separator — NOT just the `mcp_` prefix,
  // because the mcp-admin skill's tools (mcp_list_servers, mcp_add_server,
  // mcp_remove_server, mcp_assign_server, mcp_unassign_server, mcp_refresh)
  // share the prefix but live in a static manifest and resolve normally
  // through the manifest scan below. The double-underscore is the
  // unambiguous marker that this tool came from a third-party MCP server.
  if (resolvedName.startsWith('mcp_') && resolvedName.includes('__')) {
    for (const [key, wrap] of visibleEntries(userId)) {
      if (wrap.manifest.id === 'mcp') {
        owningSkillId = 'mcp';
        skillExec = await getExecutorByKey(key);
        break;
      }
    }
  }
  if (!skillExec) {
    for (const [key, wrap] of visibleEntries(userId)) {
      if (wrap.manifest.tools?.some(t => t.function?.name === resolvedName)) {
        owningSkillId = wrap.manifest.id;
        skillExec = await getExecutorByKey(key);
        break;
      }
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

  // Phase-10: defense-in-depth. listRoles/getRoleTools already filter the
  // catalog the LLM sees, but if a tool name leaks via aliasing, manual
  // request_tools, or a delegated turn that pre-resolved its toolset, we
  // still want disabled-skill/hidden-tool overrides to win at the gate.
  if (userId && owningSkillId) {
    const owningManifest = _manifests.get(resolveKey(owningSkillId, userId))?.manifest;
    if (isSkillDisabled(userId, owningSkillId, !!owningManifest?.always_on)) {
      yield { type: 'result', text: `Tool "${name}" is from a disabled skill.` };
      return;
    }
    if (getHiddenTools(userId, owningSkillId).includes(resolvedName)) {
      yield { type: 'result', text: `Tool "${name}" is hidden by your settings.` };
      return;
    }
  }
  // Use resolvedName for actual execution
  name = resolvedName;

  // Phase-2: merge accepted default-arg pins before invocation. User-provided
  // args win over pins — mergeDefaults only fills keys absent from `args`.
  // Sync read (small JSON, cached at OS level) so we don't add an await before
  // the LLM-visible dispatch yield.
  const mergedArgs = (args && typeof args === 'object') ? mergeDefaults(userId, name, args) : args;

  // Ephemeral-delegation memoization: same (toolName, args) within one
  // delegated session returns the prior result, skipping skill execution +
  // the LLM turn that would parse the round-trip. Only fires for the small
  // read-only whitelist defined in lib/ephemeral-tool-cache.mjs — anything
  // that can mutate state is never memoized. Cache initialized by
  // skills/delegate/execute.mjs at delegation entry.
  if (_isEphem(agentId)) {
    const hit = _ephemCacheGet(agentId, name, mergedArgs);
    if (hit) {
      log.info('tool', 'ephemeral cache hit', { tool: name, agentId });
      yield { type: 'result', text: `[cached from earlier ${name} this session]\n${hit.text}` };
      return;
    }
  }

  // Phase-4.5: record fill/reaffirm/override events for the default_arg
  // outcome measurer. Fire-and-forget — never blocks dispatch.
  if (args && typeof args === 'object') {
    recordPinUsage(userId, name, args)
      .catch(e => console.warn('[tool-defaults] pin-usage record failed:', e.message));
  }

  const _toolStart = Date.now();
  // Phase-14e: any tool taking longer than this auto-backgrounds. The
  // network/promise stays alive — events just get redirected to a
  // task_proxy chip instead of yielding up to the LLM. The coordinator's turn
  // finishes immediately with a "still running, see chip" synthetic result.
  const AUTO_BG_MS = 10_000;

  // Ephemeral-delegation post-processor for the final `{type:'result'}` yield.
  // Two things happen here, only when agentId is an ephemeral_deleg_* session:
  //   (a) For list-style tools (list_files, search_files, grep), the result
  //       text is run through the embedder ranker so the most task-relevant
  //       lines surface first with a ★ prefix. Ordering hint only — never
  //       drops items, falls back to original text on any embed failure.
  //   (b) The (possibly-reranked) text is memoized under (toolName, args).
  //       Future identical calls within the same session short-circuit at
  //       the cache check above this function in the dispatcher.
  const _postProcessResult = async (value) => {
    if (!_isEphem(agentId)) return value;
    if (value?.type !== 'result' || typeof value.text !== 'string') return value;
    let outText = value.text;
    if (_ephemIsListTool(name)) {
      try { outText = await _ephemRerank(agentId, name, outText); }
      catch { /* embedder error → keep original */ }
    }
    _ephemCacheSet(agentId, name, mergedArgs, outText);
    return outText === value.text ? value : { ...value, text: outText };
  };
  try {
    const result = skillExec(name, mergedArgs, userId, agentId, await buildCtx(userId, agentId));

    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      // ── Streaming path ──────────────────────────────────────────────────
      const iter = result[Symbol.asyncIterator]();
      const startedAt = Date.now();
      let backgrounded = false;
      let watcherId = null;
      let watchersMod = null;

      while (true) {
        let next;
        try { next = await iter.next(); }
        catch (err) {
          // Tool threw during iteration — bubble up. The outer catch handles
          // background-mode case separately via the detached IIFE below.
          throw err;
        }
        if (next.done) break;
        const value = next.value;

        // First time crossing 10s: register chip, yield deferred result,
        // hand the iterator to a detached worker, and return.
        if (!backgrounded && Date.now() - startedAt >= AUTO_BG_MS) {
          try {
            watchersMod = await import('./scheduler/watchers.mjs');
            watcherId = watchersMod.registerWatcher({
              userId,
              agentId: await _resolveAttributionAgent(userId, agentId),
              kind: 'task_proxy',
              label: `⏵ ${name}`,
              state: {
                taskId: `autobg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                targetAgentName: name,
                targetAgentEmoji: '⏵',
                tool: name,
                startedAt,
                lastActivityAt: Date.now(),
              },
              cadenceSec: 30,
              expiresAt: null,
            });
            backgrounded = true;
            // Push the just-yielded value into the chip too
            if (value?.type === 'tool_progress' && value.text) {
              watchersMod.pushWatcherStatus(userId, watcherId, String(value.text).slice(-200));
            }
          } catch (e) {
            console.warn('[auto-bg] watcher register failed; staying foreground:', e.message);
            // If we can't register the watcher, fall through to normal yield
          }

          if (backgrounded) {
            // Inform the coordinator's LLM the tool was backgrounded — its turn
            // ends gracefully with this message in place of the real result.
            yield { type: 'result', text: `\`${name}\` is taking longer than 10s — moved to background. A live progress chip is in the chat; you don't need to reply about it.` };
            yield { type: '__hide_turn', reason: 'bg_chip', taskId: watcherId };

            // Detached worker: continue draining iter, push to chip, finalize
            // when done. The tool's network/promise stays alive — we just
            // route its output to a different sink.
            const captured = { name, watcherId, userId, agentId, owningSkillId, startedAt };
            (async () => {
              let finalText = '';
              try {
                while (true) {
                  const r = await iter.next();
                  if (r.done) break;
                  const v = r.value;
                  if (v?.type === 'tool_progress' && v.text) {
                    watchersMod.pushWatcherStatus(captured.userId, captured.watcherId, String(v.text).slice(-200));
                  } else if (v?.type === 'result' && v.text) {
                    finalText = String(v.text);
                  }
                }
                watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                  status: 'done',
                  finalText: `✓ ${captured.name} done${finalText ? `: ${finalText.slice(-1200)}` : ''}`,
                });
                // Append the result into the agent session so the next LLM
                // turn has context. Best-effort; chip is the primary surface.
                if (captured.agentId) {
                  try {
                    const { appendToSession } = await import('./sessions.mjs');
                    const key = captured.agentId.startsWith(`${captured.userId}_`) ? captured.agentId : `${captured.userId}_${captured.agentId}`;
                    // Persist with kind:'agent_report' + sender metadata so a
                    // hard browser reload re-renders the same fancy bubble
                    // the live broadcast paints. Without kind, the entry
                    // renders as a flat assistant bubble with the literal
                    // "[<name> finished in background]" prefix and loses
                    // the sender-tagged styling.
                    await appendToSession(key, {
                      role: 'assistant',
                      kind: 'agent_report',
                      agentName: captured.name,
                      agentEmoji: captured.agentEmoji ?? '⏵',
                      content: `[${captured.name} finished in background]\n${(finalText || '').slice(0, 4000)}`,
                      ts: Date.now(),
                    });
                  } catch (_) { /* best-effort */ }
                }
                // Broadcast a notification so the user sees the result land
                // even if the task chip is scrolled out of view. Same path
                // dispatchBackground uses for background ask_agent results.
                // `agent` field tells the browser which coordinator's session
                // this report belongs to so it persists in sessions[<id>].
                try {
                  const { sendToUser } = await import('./ws-handler.mjs');
                  sendToUser(captured.userId, {
                    type: 'agent_report',
                    agent: captured.agentId ?? null,
                    agentName: captured.name,
                    agentEmoji: captured.agentEmoji ?? '⏵',
                    content: finalText || `${captured.name} completed.`,
                    taskId: `autobg_${captured.watcherId}`,
                    ts: Date.now(),
                  });
                } catch (_) { /* best-effort */ }
                log.info('tool', 'auto-bg tool complete', { skill: captured.owningSkillId, tool: captured.name, userId: captured.userId, durationMs: Date.now() - captured.startedAt });
              } catch (err) {
                watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                  status: 'error',
                  finalText: `⚠ ${captured.name} failed: ${err.message}`,
                });
                log.warn('tool', 'auto-bg tool threw', { skill: captured.owningSkillId, tool: captured.name, userId: captured.userId, err: err.message });
              }
            })();
            return;   // outer generator ends — LLM sees the deferred result + turn finishes
          }
          // else: fall through to normal yield (registration failed)
        }

        yield await _postProcessResult(value);
      }
    } else {
      // ── Single-promise path ─────────────────────────────────────────────
      // Race the await against a 10s timer. If the timer wins, register a
      // chip, yield deferred result, let the promise resolve into the chip.
      const racePromise = Promise.resolve(result);
      const TIMER_TOKEN = Symbol('AUTO_BG_TIMER');
      const winner = await Promise.race([
        racePromise,
        new Promise(resolve => setTimeout(() => resolve(TIMER_TOKEN), AUTO_BG_MS)),
      ]);

      if (winner === TIMER_TOKEN) {
        const watchersMod = await import('./scheduler/watchers.mjs');
        const attribAgentId = await _resolveAttributionAgent(userId, agentId);
        const wid = watchersMod.registerWatcher({
          userId,
          agentId: attribAgentId,
          kind: 'task_proxy',
          label: `⏵ ${name}`,
          state: {
            taskId: `autobg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            targetAgentName: name,
            targetAgentEmoji: '⏵',
            tool: name,
            startedAt: _toolStart,
            lastActivityAt: Date.now(),
          },
          cadenceSec: 30,
          expiresAt: null,
        });
        yield { type: 'result', text: `\`${name}\` is taking longer than 10s — moved to background. A live progress chip is in the chat; you don't need to reply about it.` };
        yield { type: '__hide_turn', reason: 'bg_chip', taskId: wid };

        racePromise.then(async (val) => {
          const text = String(val ?? '');
          watchersMod.completeWatcher(userId, wid, {
            status: 'done',
            finalText: `✓ ${name} done${text ? `: ${text.slice(-1200)}` : ''}`,
          });
          if (agentId) {
            try {
              const { appendToSession } = await import('./sessions.mjs');
              const key = agentId.startsWith(`${userId}_`) ? agentId : `${userId}_${agentId}`;
              await appendToSession(key, {
                role: 'assistant',
                kind: 'agent_report',
                agentName: name,
                agentEmoji: '⏵',
                content: `[${name} finished in background]\n${text.slice(0, 4000)}`,
                ts: Date.now(),
              });
            } catch (_) { /* best-effort */ }
          }
          try {
            const { sendToUser } = await import('./ws-handler.mjs');
            sendToUser(userId, {
              type: 'agent_report',
              agent: agentId ?? null,
              agentName: name,
              agentEmoji: '⏵',
              content: text || `${name} completed.`,
              taskId: `autobg_${wid}`,
              ts: Date.now(),
            });
          } catch (_) { /* best-effort */ }
          log.info('tool', 'auto-bg tool complete', { skill: owningSkillId, tool: name, userId, durationMs: Date.now() - _toolStart });
        }).catch((err) => {
          watchersMod.completeWatcher(userId, wid, {
            status: 'error',
            finalText: `⚠ ${name} failed: ${err.message}`,
          });
          log.warn('tool', 'auto-bg tool threw', { skill: owningSkillId, tool: name, userId, err: err.message });
        });
        return;
      }

      // Won the race — normal sync result
      yield await _postProcessResult({ type: 'result', text: String(winner ?? '') });
    }
    log.info('tool', 'tool complete', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart });

    // Alias-framework cascade: any registered manifest can declare
    // cascade_on_tools — when one of those tools succeeds, drop user-stored
    // aliases for the corresponding entity id. Fire-and-forget; never
    // blocks the main flow.
    if (userId) {
      import('./lib/skill-alias-framework.mjs')
        .then(fw => fw.maybeCascadeOnToolSuccess(userId, name, mergedArgs))
        .catch(() => {});
    }

    // Phase-2: count the call (only the args the model actually supplied —
    // not mergedArgs — so pinned values don't re-count themselves). Fire-and-
    // forget so a slow disk write doesn't block the LLM stream. If the
    // threshold tripped, emit a default_arg proposal off the same async tick.
    if (args && typeof args === 'object') {
      recordToolCall(userId, name, args).then(async signal => {
        if (signal?.proposed) {
          try {
            const { proposeDefaultArg } = await import('./lib/proposals.mjs');
            await proposeDefaultArg({
              userId, agentId: agentId || '',
              tool: signal.tool, arg: signal.arg, value: signal.value, count: signal.count,
            });
          } catch (e) {
            console.warn('[tool-defaults] propose failed:', e.message);
          }
        }
      }).catch(e => console.warn('[tool-defaults] record failed:', e.message));
    }
  } catch (e) {
    console.error(`[skills] Runtime error in tool "${name}":`, e.message);
    log.error('tool', 'tool threw', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart, err: e.message });
    yield { type: 'result', text: `Tool error (${name}): ${e.message}` };

    // Phase-3: count the failure. Fire-and-forget so the user's bubble lands
    // immediately. On threshold trip we emit a tool_failure proposal — the
    // owning-skill id is captured here because the proposer needs to know
    // whether to route the remedy through refine (user skill) or a diagnostic
    // (built-in).
    recordToolFailure(userId, name, e.message).then(async signal => {
      if (signal?.proposed) {
        try {
          const { proposeToolFailure } = await import('./lib/proposals.mjs');
          await proposeToolFailure({
            userId, agentId: agentId || '',
            tool: signal.tool,
            skillId: owningSkillId,
            recentErrors: signal.recentErrors,
            count: signal.count,
          });
        } catch (err) {
          console.warn('[tool-failures] propose failed:', err.message);
        }
      }
    }).catch(err => console.warn('[tool-failures] record failed:', err.message));
  }
}
