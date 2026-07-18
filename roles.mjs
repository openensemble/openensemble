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
import { SKILLS_DIR, CFG_PATH, USERS_DIR, userSkillsDir, getUserFilesDir, readConfig } from './lib/paths.mjs';
import { buildSkillCredentials } from './lib/credentials.mjs';
import { skillDeclaresNetwork } from './lib/skill-net-policy.mjs';
import { buildProposeMonitor, buildCollectionHelpers } from './lib/monitor-helper.mjs';
import { buildBrowserHelpers } from './lib/browser-helper.mjs';
import { buildDeviceHelpers, _registerVoiceContextResolver } from './lib/device-helper.mjs';
import { buildSkillLogger } from './lib/skill-logger.mjs';
import { recordDomainSkill } from './lib/memory-scope-context.mjs';
import { recordToolExecution } from './lib/tool-exec-log.mjs';
import { recordToolObservation } from './lib/personalization/recorder.mjs';
import { buildRegisterLead } from './lib/personalization/lead-helper.mjs';
import { buildSkillPersonalizationHelpers } from './lib/personalization/skill-helper.mjs';
import { getVoiceContext } from './lib/voice-context.mjs';
import { listDesktops, sendDesktopCommand } from './lib/desktop-bus.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';
import { registerScheduledChild, completeScheduledChild } from './lib/scheduled-child-barrier.mjs';
// One-time: hand the voice-context getter to device-helper so ctx.device.id()
// can resolve the current device sync.
_registerVoiceContextResolver(getVoiceContext);
import { mergeDefaults, recordPinUsage } from './lib/tool-defaults.mjs';
import { normalizeToolResult, toolError } from './lib/tool-error.mjs';
import { hasPendingPrompt } from './lib/credentials.mjs';
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
import { listAgents } from './agents.mjs';
import { normalizeOrchestrationPolicy } from './lib/orchestration-policy-core.mjs';
import { getTurnContext } from './lib/turn-abort-context.mjs';
import { currentTaskContext, runInTaskContext } from './lib/task-proxy-context.mjs';
import {
  abortError,
  createLinkedAbortController,
  isAbortError,
  raceWithAbort,
} from './lib/abort-utils.mjs';
import {
  drainIteratorIncludingBoundary,
  racePendingIteratorNext,
  autoBackgroundToolsInCurrentContext,
  setAutoBackgroundDelayForTest,
  normalizeAutoBgCompletion,
  // private helpers used by executeToolStreaming
  _resolveAttributionAgent,
  _agentIdFromSessionKey,
  _emitAutoBgNotify,
  _runAutoBgToolContinuation,
  _autoBgChildId,
  _autoBackgroundDelayMs,
  _registerScheduledAutoBgChild,
  _completeScheduledAutoBgChild,
  _emitAutoBgToolReport,
  BG_REPORT_TOOLS,
} from './roles/auto-background.mjs';

import { _readUserProfile } from './roles/user-profile.mjs';
export { _readUserProfile } from './roles/user-profile.mjs';
import {
  bindAssignmentDeps,
  getRoleAssignments,
  getDurableRoleAssignment,
  resolveWatcherRegistrationAgentId,
  getRoleAssignment,
  getAgentRoles,
  getAgentAssignedSkills,
  agentCanFastpathSkill,
  isScopableSkill,
  setRoleAssignment,
  clearRoleAssignmentsForAgent,
  reconcileRoleDrawers,
  _allowedSkillIdsForProfile,
} from './roles/assignments.mjs';
export {
  getRoleAssignments,
  getDurableRoleAssignment,
  resolveWatcherRegistrationAgentId,
  getRoleAssignment,
  getAgentRoles,
  getAgentAssignedSkills,
  agentCanFastpathSkill,
  isScopableSkill,
  setRoleAssignment,
  clearRoleAssignmentsForAgent,
  reconcileRoleDrawers,
} from './roles/assignments.mjs';
export {
  drainIteratorIncludingBoundary,
  racePendingIteratorNext,
  autoBackgroundToolsInCurrentContext,
  setAutoBackgroundDelayForTest,
  normalizeAutoBgCompletion,
} from './roles/auto-background.mjs';

// Wrapper shape: { manifest, userId, dir }
//   userId: null for global, userId string for per-user
//   dir:    absolute path to the skill directory on disk
const _manifests    = new Map();  // internalKey -> wrapper
const _executors    = new Map();  // internalKey -> execute function
const _executorBust = new Map();  // internalKey -> bust timestamp

const globalKey = id => `global:${id}`;
const userKey   = (uid, id) => `user:${uid}:${id}`;

// Try resolving an id in the user's scope first, then globally. Returns internalKey or null.
export function resolveKey(id, userId) {
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
export function* visibleEntries(userId) {
  for (const [key, wrap] of _manifests) {
    if (wrap.userId === null || wrap.userId === userId) yield [key, wrap];
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

// Load all manifests synchronously — called once at startup from server.mjs.
// Isolated lab copies are read-only fixtures: skip every startup migration so
// verifier boot cannot rewrite copied profiles, assignments, or config.
export function loadRoleManifests({
  runMigrations = process.env.OPENENSEMBLE_LAB !== '1',
} = {}) {
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
  if (runMigrations) {
    try { migrateLegacyUserSkills(); }
    catch (e) { console.warn('[migrate] Legacy user skill migration failed:', e.message); }
  }

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
      const allManifests = [..._manifests.values()]
        .map(v => ({ ...v.manifest, userScope: v.userId }));
      const importerFor = (skillId, declaredScope, catalogUserId) => {
        const entry = declaredScope
          ? _manifests.get(userKey(declaredScope, skillId))
          : _manifests.get(globalKey(skillId));
        if (!entry) return Promise.resolve({});
        return importAliasCatalogModule(entry, catalogUserId);
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
      if (runMigrations) try {
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
      if (runMigrations) try {
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

/**
 * Tools a remembered "selected" tool plan may never drop, as declared by skill
 * manifests (`"selected_plan_keep": ["save_research", ...]`). Lets a skill
 * protect its role-critical tools from stale recipes without a chat.mjs edit.
 *
 * When `selectedToolNames` is supplied, only declarations from manifests that
 * own at least one selected tool are returned. That distinction matters for a
 * singleton coordinator: it holds every user's tools, so a global union would
 * preserve unrelated actions on every remembered plan. Traditional scoped
 * agents retain the legacy all-manifest union by omitting the first argument.
 */
export function getSelectedPlanKeepTools(selectedToolNames = null, userId = null) {
  const selected = selectedToolNames == null
    ? null
    : new Set(Array.from(selectedToolNames).filter(t => typeof t === 'string' && t));
  const visible = [..._manifests.values()]
    .filter(wrap => !userId || wrap?.userId === null || wrap?.userId === userId);
  // Execution and schema assembly resolve duplicate names by registry order.
  // Mirror that first-owner rule so a later custom manifest cannot expand the
  // retained terminal surface merely by repeating a selected tool name.
  const eligible = selected
    ? [...selected].map(name => visible.find(wrap =>
        (Array.isArray(wrap?.manifest?.tools) ? wrap.manifest.tools : [])
          .some(tool => (tool?.function?.name ?? tool?.name) === name)))
        .filter(Boolean)
    : visible;
  const keep = new Set();
  for (const wrap of new Set(eligible)) {
    const manifest = wrap?.manifest;
    const manifestToolNames = new Set((Array.isArray(manifest?.tools) ? manifest.tools : [])
      .map(tool => tool?.function?.name ?? tool?.name).filter(Boolean));
    const arr = manifest?.selected_plan_keep;
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (typeof t === 'string' && t && manifestToolNames.has(t)) keep.add(t);
      }
    }
  }
  return keep;
}

/** Return all skill manifests visible to `userId` — globals + that user's own skills. */
export function listRoles(userId = null) {
  const out = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId === null || wrap.userId === userId) {
      if (userId && !isSkillAllowedForUser(wrap.manifest.id, userId)) continue;
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
  const key = userId ? userKey(userId, id) : globalKey(id);
  const previousAliasKind = _manifests.get(key)?.manifest?.alias_catalog?.entity_kind ?? null;
  let dir;
  if (userId) {
    dir = path.join(userSkillsDir(userId), id);
    _manifests.set(key, { manifest, userId, dir });
  } else {
    dir = path.join(SKILLS_DIR, id);
    _manifests.set(key, { manifest, userId: null, dir });
  }
  // Register the alias catalog if this manifest declares one. Mirrors the
  // boot-time registration in loadRoleManifests so newly-created skills
  // (via skill-builder skill_create) pick up alias support immediately.
  if (previousAliasKind || manifest.alias_catalog) {
    import('./lib/skill-alias-framework.mjs').then(fw => {
      const wrap = _manifests.get(key);
      const importer = (catalogUserId) => importAliasCatalogModule(wrap, catalogUserId);
      // Remove the old registration before considering the replacement. An
      // update may change entity_kind or remove alias_catalog entirely.
      if (previousAliasKind) {
        try { fw.unregisterAliasCatalog(previousAliasKind, userId); } catch {}
      }
      if (manifest.alias_catalog) {
        try { fw.unregisterAliasCatalog(manifest.alias_catalog.entity_kind, userId); } catch {}
        fw.registerAliasCatalog(manifest.alias_catalog, importer, { userScope: userId, skillId: id });
      }
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
      .then(fw => fw.unregisterAliasCatalog(entry.manifest.alias_catalog.entity_kind, userId))
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
  if (userId && !isSkillAllowedForUser(id, userId)) return [];
  const manifest = getRoleManifest(id, userId);
  if (userId && manifest && isSkillDisabled(userId, id, !!manifest.always_on)) return [];
  const tools = manifest?.tools ?? [];
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

// Role assignments: roles/assignments.mjs
// ── Tool resolution ───────────────────────────────────────────────────────────

/**
 * Account-level skill authorization. Restricted accounts are fail-closed and
 * an explicit allowedSkills array is authoritative for regular users too.
 * Owner/admin accounts remain unrestricted. Missing/unreadable profiles deny.
 */
export function isSkillAllowedForUser(skillId, userId) {
  if (!skillId || !userId) return true;
  const profile = _readUserProfile(userId);
  const allowed = _allowedSkillIdsForProfile(profile);
  return allowed === null || allowed.has(skillId);
}

/**
 * Runtime authorization shared by tool, alias, lifecycle, and watcher seams.
 * `profile.skills` is one activation source, not the only one: hidden
 * delegate tools are orchestration infrastructure, role bundles ride with an
 * enabled parent role, and an agent's primary role remains its capability.
 */
export function isSkillRuntimeEnabledForUser(skillId, userId, agentId = null) {
  if (!skillId || !userId || !isSkillAllowedForUser(skillId, userId)) return false;
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap) return false;
  if (isSkillDisabled(userId, skillId, !!wrap.manifest?.always_on)) return false;
  if (wrap.manifest?.always_on === true) return true;
  const profile = _readUserProfile(userId);
  if (!profile) return false;
  const enabled = new Set([
    ...getDefaultRoles(),
    ...(Array.isArray(profile.skills) ? profile.skills : []),
    ...(!Array.isArray(profile.skills) && profile.emailProvider === 'gmail' ? ['gmail'] : []),
  ]);
  if (enabled.has(skillId)) return true;
  if (wrap.manifest?.category === 'delegate') return true;
  if (wrap.manifest?.bundled_with_role && enabled.has(wrap.manifest.bundled_with_role)) return true;
  if (agentId) {
    const prefix = `${userId}_`;
    const bare = String(agentId).startsWith(prefix) ? String(agentId).slice(prefix.length) : String(agentId);
    const agent = listAgents().find(candidate => candidate.ownerId === userId && candidate.id === bare);
    if (agent?.skillCategory === skillId) return true;
  }
  return false;
}

function accountAllowedSkillIds(userId) {
  if (!userId) return null;
  const profile = _readUserProfile(userId);
  return _allowedSkillIdsForProfile(profile);
}

// Tools from always_on skills — injected into every agent regardless of category.
// Intentionally global-only: a user's custom always_on: true skill should NOT leak
// into other users' sessions. This is an isolation tradeoff — user custom skills
// must be explicitly enabled via user.skills rather than auto-injected.
function getAlwaysOnTools(allowedSkillIds = null) {
  const tools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (allowedSkillIds && !allowedSkillIds.has(wrap.manifest.id)) continue;
    if (wrap.manifest.always_on) tools.push(...(wrap.manifest.tools ?? []));
  }
  return tools;
}

// Tools that ride along with owned roles — e.g. active-agents is "the
// coordinator's job" and skill-builder is "the coder's job". In the
// single-coordinator shape one agent can own several service roles, so looking
// only at its primary skillCategory silently drops bundles for every secondary
// role. Treat every assigned role as owned; bundles remain inherent to their
// role rather than separately assignable (and stay hidden in Settings).
function getBundledRoleTools(roleIds, allowedSkillIds = null, userId = null) {
  const owned = new Set(Array.isArray(roleIds) ? roleIds : [roleIds].filter(Boolean));
  if (!owned.size) return [];
  const tools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (allowedSkillIds && !allowedSkillIds.has(wrap.manifest.id)) continue;
    if (userId && isSkillDisabled(userId, wrap.manifest.id, !!wrap.manifest.always_on)) continue;
    if (owned.has(wrap.manifest.bundled_with_role)) {
      tools.push(...(wrap.manifest.tools ?? []));
    }
  }
  return tools;
}

// Resolve what tools an agent gets based on its skillCategory and the user's enabled roles
export function resolveAgentTools(skillCategory, userSkills, agentId = null, userId = null) {
  const allowedSkillIds = accountAllowedSkillIds(userId);
  // getUserEnabledSkills backfills enabled_by_default skills for historical
  // profiles. For a child that storage convenience must never widen the
  // runtime capability surface beyond the parent-managed allowedSkills list.
  userSkills = Array.isArray(userSkills)
    ? userSkills.filter(skillId => !allowedSkillIds || allowedSkillIds.has(skillId))
    : [];
  const assignments = getRoleAssignments(userId);
  const coordinatorId = assignments['coordinator'] ?? null;
  const alwaysOn = getAlwaysOnTools(allowedSkillIds);

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
  const primaryTools = skillCategory && (!allowedSkillIds || allowedSkillIds.has(skillCategory))
    ? getRoleTools(skillCategory, userId)
    : [];

  // Bundles follow every role this agent owns, not only its primary role.
  // This matters when one Jarvis coordinator owns coordinator + coder + email
  // and the coder role's hidden skill-builder bundle must remain available.
  // Secondary assignments still have to be enabled for this user; a stale
  // assignment must not resurrect a bundle after an admin revokes its role.
  const enabledSkills = new Set(userSkills);
  const ownedRoleIds = [
    skillCategory,
    ...Object.keys(assignments).filter(roleId => enabledSkills.has(roleId) && isAssignedTo(roleId)),
  ].filter(Boolean);
  const bundledTools = getBundledRoleTools(ownedRoleIds, allowedSkillIds, userId);

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
    if (allowedSkillIds && !allowedSkillIds.has(wrap.manifest.id)) continue;
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

async function importAliasCatalogModule(wrap, catalogUserId) {
  if (!wrap?.manifest?.id || !catalogUserId) return {};
  const skillId = wrap.manifest.id;
  if (wrap.userId && wrap.userId !== catalogUserId) return {};
  // Alias resolution runs before an agent/tool is selected, so it needs its
  // own account boundary. Denied or disabled skills return an empty module
  // without evaluating execute.mjs.
  if (!isSkillRuntimeEnabledForUser(skillId, catalogUserId)) return {};

  const functionName = wrap.manifest.alias_catalog?.catalog_source?.function;
  if (wrap.userId && shouldSandboxSkill(wrap)) {
    if (!functionName) return {};
    return {
      [functionName]: async () => {
        const { runCustomSkillExportedFunctionSandboxed } = await import('./lib/skill-subprocess.mjs');
        return runCustomSkillExportedFunctionSandboxed({
          userId: catalogUserId,
          skillId,
          functionName,
          net: skillDeclaresNetwork(catalogUserId, skillId),
        });
      },
    };
  }

  const key = wrap.userId ? userKey(wrap.userId, skillId) : globalKey(skillId);
  const filePath = path.join(wrap.dir, 'execute.mjs');
  return import(pathToFileURL(filePath).href + `?bust=${_executorBust.get(key) || 0}`)
    .catch(() => ({}));
}

// Load executor lazily. `internalKey` identifies the wrapper; `dir` comes from it.
export async function getExecutorByKey(internalKey) {
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
  const wrap = _manifests.get(key);
  if (!isSkillRuntimeEnabledForUser(skillId, userId) || shouldSandboxSkill(wrap)) return null;
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

    // Validate optional `localIntents` (skill-agnostic local cognition tier).
    // Warnings only — lib/local-label.mjs defensively skips anything invalid at
    // runtime, so a bad entry never breaks chat; this just surfaces authoring
    // bugs (unknown tool, slot that isn't a tool parameter, uncompilable regex).
    if (Array.isArray(manifest.localIntents)) {
      const label = wrap.userId ? `${wrap.userId}/${manifest.id}` : manifest.id;
      for (const li of manifest.localIntents) {
        if (!li?.id || !li?.tool) { console.warn(`[skills] ⚠️  ${label}: localIntent missing id/tool`); continue; }
        const tool = (manifest.tools ?? []).find(t => t.function?.name === li.tool);
        if (!tool) { console.warn(`[skills] ⚠️  ${label}: localIntent '${li.id}' binds unknown tool '${li.tool}'`); continue; }
        const props = tool.function?.parameters?.properties ?? {};
        for (const slot of (Array.isArray(li.slots) ? li.slots : [])) {
          if (!(slot in props)) console.warn(`[skills] ⚠️  ${label}: localIntent '${li.id}' slot '${slot}' is not a parameter of '${li.tool}'`);
        }
        for (const pat of (Array.isArray(li.patterns) ? li.patterns : [])) {
          try { new RegExp(pat, 'i'); } catch (e) { console.warn(`[skills] ⚠️  ${label}: localIntent '${li.id}' bad regex /${pat}/: ${e.message}`); }
        }
      }
    }

    const execPath = path.join(wrap.dir, 'execute.mjs');
    if (!existsSync(execPath)) continue;
    // Sandboxed custom skills never load in-process — not even here. This
    // loop used to import() every user-authored execute.mjs at boot (its
    // top-level code ran unjailed, with the server's env and fs) and invoke
    // each tool with {__validate:true}. The authoring-time smoke test (which
    // runs in the bwrap jail) covers custom skills; the boot probe keeps its
    // value for global (repo-shipped, first-party) skills only.
    if (wrap.userId !== null) continue;
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
  if (!isSkillRuntimeEnabledForUser(roleId, userId)) return;
  // Custom lifecycle hooks are not part of the sandbox RPC contract. Refuse
  // them instead of importing user-authored code into the server process;
  // repo-shipped global hooks retain the existing behavior.
  if (wrap.userId !== null) return;
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

function _desktopToolText(data) {
  const item = Array.isArray(data?.content) ? data.content.find(p => p?.type === 'text') : null;
  return item?.text ? String(item.text) : '';
}

function _desktopSavedPath(data) {
  const text = _desktopToolText(data);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} userId
 * @param {{sandbox?: string, filename?: string, base64?: string, url?: string, timeoutMs?: number}} [opts]
 */
async function saveDesktopArtifact(userId, { sandbox, filename, base64, url, timeoutMs = 60_000 } = {}) {
  if (getVoiceContext()?.source !== 'desktop-app' || !userId || !sandbox || !filename) return null;
  if (!listDesktops(userId).length) return null;
  try {
    const data = base64
      ? await sendDesktopCommand(userId, 'desktop_save_file', { sandbox, path: filename, content: base64, encoding: 'base64' }, { timeoutMs })
      : await sendDesktopCommand(userId, 'desktop_download_url', { sandbox, path: filename, url }, { timeoutMs });
    return _desktopSavedPath(data);
  } catch (e) {
    console.warn(`[desktop-artifact] failed to save ${sandbox}/${filename}:`, e.message);
    return null;
  }
}

// Build the per-call context object passed to skill executors as the 5th arg.
// Skills that don't accept it (4-param signature) ignore it transparently.
export async function buildCtx(userId, agentId, skillId = null, signal = getTurnContext()?.signal ?? null) {
  // Providers pass the scoped `${userId}_${rawAgentId}` here, but the dashboard
  // matches inbound bubbles against the raw agent id. Strip the prefix so
  // ctx.showImage/showVideo land in the right chat thread.
  const wsAgentId = (userId && typeof agentId === 'string' && agentId.startsWith(`${userId}_`))
    ? agentId.slice(userId.length + 1)
    : agentId;
  const suppressLearning = getTurnContext()?.suppressLearning === true;
  const ctx = {
    userId,
    agentId,
    signal,
    throwIfAborted() {
      if (signal?.aborted) throw abortError(signal, 'Tool execution cancelled');
    },
  };
  // Structured failure signal: `return ctx.toolError('…')` records the tool call
  // as a failure (trace ok:false, flaky-tool proposals, not learned as a recipe)
  // instead of the legacy `return `Error: …`` string the trace can't read. See
  // lib/tool-error.mjs + SKILL_BLUEPRINT.md → "Signaling failure".
  ctx.toolError = (message) => toolError(message);
  ctx.showImage = /** @param {{base64?: string, mimeType?: string, filename?: string, savedPath?: string, prompt?: string}} [opts] */ async ({ base64, mimeType = 'image/png', filename, savedPath, prompt } = {}) => {
    if (!wsAgentId || !base64 || !filename) return 0;
    const desktopSavedPath = await saveDesktopArtifact(userId, {
      sandbox: 'images',
      filename,
      base64,
    });
    if (desktopSavedPath) savedPath = desktopSavedPath;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'image', agent: wsAgentId, base64, mimeType, filename, savedPath, prompt });
  };
  ctx.showVideo = /** @param {{url?: string, filename?: string, savedPath?: string}} [opts] */ async ({ url, filename, savedPath } = {}) => {
    if (!wsAgentId || !url || !filename) return 0;
    const desktopSavedPath = await saveDesktopArtifact(userId, {
      sandbox: 'videos',
      filename,
      url,
      timeoutMs: 300_000,
    });
    if (desktopSavedPath) savedPath = desktopSavedPath;
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
  ctx.watch = /** @param {{kind?: string, state?: any, cadenceSec?: number, expiresAt?: number|null, skillId?: string, label?: string, onFire?: any, followDurableSkillOwner?: boolean, requirePersist?: boolean}} [opts] */ async (opts = {}) => {
    try {
      const watchers = await import('./scheduler/watchers.mjs');
      const { followDurableSkillOwner, ...watcherOpts } = opts;
      void followDurableSkillOwner; // legacy option; ownership is now automatic
      const effectiveSkillId = opts.skillId || skillId || null;
      const watcherAgentId = await resolveWatcherRegistrationAgentId(
        userId,
        wsAgentId,
        effectiveSkillId,
      );
      return watchers.registerWatcher(/** @type {any} */ ({
        ...watcherOpts,
        userId,
        agentId: watcherAgentId,
        // If the caller didn't specify which skill owns this watcher, try to
        // infer it. The agent in this ctx might not be a skill; an explicit
        // skillId is best-effort and required only if the handler is not in
        // the system registry.
        skillId: effectiveSkillId,
      }));
    } catch (e) { console.warn('[ctx.watch]', e.message); return null; }
  };
  ctx.unwatch = async (watcherId) => {
    try {
      const { getPreferenceSafeAutoContext } = await import('./lib/personalization/safe-auto-context.mjs');
      if (getPreferenceSafeAutoContext()?.activationNonce) {
        throw new Error('unwatch is unavailable while committing a preference monitor activation');
      }
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
      const { getPreferenceSafeAutoContext } = await import('./lib/personalization/safe-auto-context.mjs');
      if (getPreferenceSafeAutoContext()?.activationNonce) {
        throw new Error('unwatchMatching is unavailable while committing a preference monitor activation');
      }
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

  // ctx.registerLead — personalization "open lead" registration: stores a
  // tool+args re-run for later (silent) follow-up when an answer isn't
  // available yet ("is this back in stock"). See lib/personalization/lead-helper.mjs.
  ctx.registerLead = suppressLearning
    ? async () => ({
        ok: false,
        announce: 'Automatic follow-up registration is disabled during this verification run.',
      })
    : buildRegisterLead({ userId, agentId: wsAgentId });

  // Read-only, master-switch-gated confirmed preferences scoped to the
  // owning skill's declared preferenceOpportunities keywords.
  ctx.personalization = buildSkillPersonalizationHelpers({ userId, skillId });

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

  // ctx.browser — primitive surface for skills that want to use the user's
  // connected OE Bridge browser extension. Phase 1 is read-only: list /
  // openTab / readPage + the Tier 1.5 mediaControl (next/previous/playpause)
  // because media keys are a tiny, bounded surface that doesn't need the
  // full per-site permission model. ctx.browser.click / fill / select land
  // with Phase 2 (Tier 1 writes + permission UX).
  ctx.browser = buildBrowserHelpers({ userId, agentId: wsAgentId });

  // ctx.device — primitive surface for skills that want to drive the user's
  // voice device(s). Mirrors ctx.browser's shape — bounded operations
  // (playStream/stop/speak/notify) that hide the marker-cache, ffmpeg, and
  // WS plumbing. v1 covers the YouTube-Music streaming use case; multi-turn
  // handoff, LED, recording, quiet hours etc are tracked in
  // project_voice_device_skill_api_todo.md.
  ctx.device = buildDeviceHelpers({ userId });

  // ctx.log — per-skill structured logging that ALSO lands in OE's app.log
  // tagged `skill:<id>`. Skills should prefer this over console.log because
  // (a) entries are queryable via skill_read_logs, and (b) the agent that
  // owns the skill can read its own runtime log to diagnose failures.
  // Bound to the calling skill — when buildCtx is called from a skill
  // executor we have the skillId; for non-skill ctx callers (chat hot paths)
  // ctx.log falls back to logging under skill='unknown'. SkillId is
  // populated below from the agentId's owning skill registry lookup if
  // available; for now bind to the agentId as the skill key so logs are at
  // least segregated per agent.
  // skillId is passed in by the dispatcher (executeRoleTool / the generator
  // at the bottom of this file) and identifies the SKILL that owns the tool
  // being executed — not the agent calling it. That matters for log routing:
  // The coordinator calling a skill's tool should write entries to
  // users/<id>/skills/<skill>/runtime.log, not the coordinator's runtime.log.
  // Falls back to wsAgentId only when buildCtx is reached from a non-skill
  // path (rare; mostly chat-side direct ctx usage).
  ctx.log = buildSkillLogger({ userId, skillId: skillId || wsAgentId || 'unknown', agentId: wsAgentId });

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

  // ── External-runtime provisioning + sandbox ────────────────────────────────
  // A skill OWNS its external binaries under <skillDir>/bin (so deleting things
  // elsewhere can't brick it), provisions them with explicit per-download user
  // consent (NO allowlist — the user approves the exact URL), and RUNS them
  // sandboxed via bubblewrap so a third-party binary can't read credentials or
  // other users' data. See SKILL_BLUEPRINT.md → "Skills that need an external
  // runtime". (This sandboxes the spawned binary, not the skill's own JS — see
  // the multi-tenant isolation note.)
  const _skillDir = (() => {
    if (!skillId) return null;
    const ud = path.join(userSkillsDir(userId), skillId);
    if (existsSync(ud)) return ud;
    const bd = path.join(SKILLS_DIR, skillId);
    return existsSync(bd) ? bd : null;
  })();
  /** @param {{ name?: string, url?: string, sha256?: string|null, label?: string|null, confirmTtlMs?: number }} [opts] */
  ctx.ensureRuntime = async ({ name, url, sha256 = null, label = null, confirmTtlMs = 5 * 60 * 1000 } = {}) => {
    if (!_skillDir) throw new Error('ctx.ensureRuntime: skill directory unknown');
    if (!name || !url) throw new Error('ctx.ensureRuntime: { name, url } required');
    const rt = await import('./lib/skill-runtime.mjs');
    const existing = rt.resolveSkillBinary(_skillDir, name);
    if (existing) return existing;                       // self-heal / already provisioned
    // Consent: explicit, per-download, reusing the wired 'confirm' prompt. The
    // user sees the exact URL; Cancel/timeout rejects and we abort.
    const m = await import('./lib/credentials.mjs');
    try {
      await m.requestCredential({
        userId, kind: 'confirm', ttlMs: confirmTtlMs,
        label: label || `Download ${name}?`,
        description: `The "${skillId}" skill needs to download an external program:\n\n  ${name}\n  from ${url}\n\nI can't guarantee this binary is safe. It will run sandboxed — its filesystem access is limited to the skill's own folder plus any output folder. Type "${name}" to approve, or Cancel to decline.`,
      });
    } catch {
      throw new Error(`Download of ${name} was declined or timed out — cannot continue without it.`);
    }
    return rt.provisionBinary({ skillDir: _skillDir, name, url, sha256 });
  };
  ctx.runSandboxed = async (bin, binArgs = [], opts = {}) => {
    const sb = await import('./lib/skill-sandbox.mjs');
    const roDirs = [_skillDir, ...(opts.roDirs || [])].filter(Boolean);
    return sb.runSandboxed(bin, binArgs, {
      ...opts,
      signal: opts.signal ?? signal,
      roDirs,
    });
  };
  // Per-user output dir for a skill (creates it). e.g. ctx.userFilesDir('videos').
  ctx.userFilesDir = (sub) => getUserFilesDir(userId, sub);

  // ctx.credentials — per-skill encrypted secret store, namespaced by skillId.
  // Same accessor the sandbox broker exposes, so a secret set in-process reads
  // back identically when the skill later runs jailed. Only when we know the
  // owning skill (non-skill ctx callers don't get it).
  if (skillId) ctx.credentials = buildSkillCredentials(userId, skillId);

  return ctx;
}

// Regression seam for the context-bound watcher ownership contract. It lets
// tests exercise a skill that calls ctx.watch without redundantly passing its
// own skillId, while production execution continues through buildCtx above.
export async function buildSkillExecutionContextForTest(userId, agentId, skillId = null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('skill execution context test seam is unavailable');
  return buildCtx(userId, agentId, skillId);
}

// ── Custom-skill sandbox routing (multi-tenant isolation) ────────────────────
// Custom (user-authored) skills run their execute.mjs in a bwrap jail via
// lib/skill-subprocess.mjs so they can't read other users' data, token files, or
// the master key. Trusted global skills (wrap.userId === null) stay in-process.
// Flag-gated (config.skillSandbox.enabled, default off) until exercised live.
export function shouldSandboxSkill(wrap) {
  if (!wrap || wrap.userId == null) return false; // global = first-party = trusted
  const ownerProfile = _readUserProfile(wrap.userId);
  // Missing/unreadable ownership data and child-owned custom code are always
  // isolated. A manifest is untrusted input and cannot opt itself out of the
  // account boundary.
  if (!ownerProfile || ownerProfile.role === 'child') return true;
  // Manifest self-declaration (set by skill_create): the portable default — new custom
  // skills ship with sandbox.isolate:true and travel sandboxed without a config edit.
  // Explicit isolate:false is a trust opt-out, still overridable by the operator config.
  if (wrap.manifest?.sandbox?.isolate === true) return true;
  try {
    const sb = readConfig()?.skillSandbox || {};
    if (sb.enabled === true) return true;                                   // all custom skills
    if (Array.isArray(sb.skills) && sb.skills.includes(wrap.manifest?.id)) return true; // per-skill trial
    return false;
  } catch { return false; }
}

// Public form for callers that only have (skillId, userId) — e.g. the watcher
// supervisor deciding whether to fire a handler in the jail.
export function isSandboxedSkill(skillId, userId) {
  const key = resolveKey(skillId, userId);
  return shouldSandboxSkill(key ? _manifests.get(key) : null);
}

// Run a custom skill's tool in the sandbox, returning a plain value that matches
// the in-process executor contract so both dispatch seams stay unchanged.
// Streaming yields are folded into result text for now (live streaming through
// the jail is a follow-up); failures throw so the normal tool-failure path runs.
export async function runCustomSkillValue({
  userId, agentId, skillId, name, args, execSnapshotPath = null,
  signal = getTurnContext()?.signal ?? null,
}) {
  const { runCustomSkillSandboxed } = await import('./lib/skill-subprocess.mjs');
  // Default-deny egress: the jail only gets network if the skill's manifest declares
  // `sandbox.network`. An undeclared (or rogue) skill runs with --unshare-net so it
  // can't exfiltrate anything it can read. See lib/skill-net-policy.mjs.
  const net = skillDeclaresNetwork(userId, skillId);
  const r = await runCustomSkillSandboxed({
    userId, agentId, skillId, toolName: name, args, net, execSnapshotPath, signal,
  });
  if (signal?.aborted) throw abortError(signal, `custom skill ${skillId}.${name} cancelled`);
  if (!r.ok) throw new Error(/** @type {any} */ (r).error || `custom skill ${skillId}.${name} failed`);
  if (Array.isArray(r.events) && r.events.length) {
    const text = r.events.filter(e => e?.type === 'token').map(e => e.text).join('');
    if (text) return { type: 'result', text };
  }
  return r.result;
}

/**
 * Execute a tool only from one exact owning skill. Safe automation uses this
 * instead of the global name-first resolver so a legacy/manual manifest with
 * a colliding tool name cannot intercept another skill's validated contract.
 */
export async function executeRoleToolForSkillInternal(
  skillId, name, args, userId = 'default', agentId = null,
  { execSnapshotPath = null, requireSandbox = false } = {},
) {
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap || wrap.manifest.id !== skillId
    || !wrap.manifest.tools?.some(tool => tool.function?.name === name)) {
    return `Tool "${name}" is not declared by skill "${skillId}".`;
  }
  if (userId) {
    if (!isSkillAllowedForUser(skillId, userId)) {
      return `Tool "${name}" is not permitted for this account.`;
    }
    if (!isSkillRuntimeEnabledForUser(skillId, userId, agentId)) {
      return `Tool "${name}" is from a disabled skill.`;
    }
    if (getHiddenTools(userId, skillId).includes(name)) {
      return `Tool "${name}" is hidden by your settings.`;
    }
  }
  if (execSnapshotPath || requireSandbox) {
    if (!shouldSandboxSkill(wrap) || !execSnapshotPath) {
      throw new Error(`reviewed safe-auto execution requires a sandboxed immutable snapshot for "${skillId}"`);
    }
    return runCustomSkillValue({ userId, agentId, skillId, name, args, execSnapshotPath });
  }
  if (shouldSandboxSkill(wrap)) return runCustomSkillValue({ userId, agentId, skillId, name, args });
  const exec = await getExecutorByKey(key);
  if (!exec) return `Tool "${name}" could not load from skill "${skillId}".`;
  return exec(name, args, userId, agentId, await buildCtx(userId, agentId, skillId));
}

export async function executeRoleToolForSkill(skillId, name, args, userId = 'default', agentId = null) {
  return executeRoleToolForSkillInternal(skillId, name, args, userId, agentId);
}

/**
 * Safe-auto-only exact dispatcher. It reads and hashes reviewed bytes once,
 * overlays that private snapshot at the canonical execute.mjs path inside a
 * mandatory sandbox, and cleans it up only after the child exits. Mutable disk
 * code and in-process executor caches are never used by this seam.
 */
export async function executeReviewedRoleToolForSkill(
  skillId, name, args, userId = 'default', agentId = null, expectedDigest = '',
) {
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap || wrap.manifest.id !== skillId || !shouldSandboxSkill(wrap)) {
    throw new Error(`reviewed safe-auto skill "${skillId}" is unavailable or not sandboxed`);
  }
  const { materializeReviewedInformationalSnapshot } = await import('./lib/personalization/reviewed-informational-skills.mjs');
  const snapshot = materializeReviewedInformationalSnapshot(
    userId, { ...wrap.manifest, userScope: wrap.userId }, expectedDigest,
  );
  if (!snapshot) throw new Error(`reviewed safe-auto snapshot for "${skillId}" could not be verified`);
  try {
    return await executeRoleToolForSkillInternal(skillId, name, args, userId, agentId, {
      execSnapshotPath: snapshot.execPath,
      requireSandbox: true,
    });
  } finally {
    snapshot.cleanup();
  }
}

/** Exact immutable-snapshot dispatcher for a user-approved preference grant. */
export async function executeGrantedRoleToolForSkill(
  skillId, name, args, userId = 'default', agentId = null, expectedIdentity = {},
) {
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap || wrap.manifest.id !== skillId || !shouldSandboxSkill(wrap)) {
    throw new Error(`approved preference skill "${skillId}" is unavailable or not sandboxed`);
  }
  const grants = await import('./lib/personalization/skill-preference-grants.mjs');
  const manifest = { ...wrap.manifest, userScope: wrap.userId };
  const snapshot = grants.materializeGrantedSkillSnapshot(userId, manifest, expectedIdentity);
  if (!snapshot) throw new Error(`approved preference snapshot for "${skillId}" could not be verified`);
  try {
    return await executeRoleToolForSkillInternal(skillId, name, args, userId, agentId, {
      execSnapshotPath: snapshot.execPath,
      requireSandbox: true,
    });
  } finally {
    snapshot.cleanup();
  }
}

// Execute a tool — routes to the skill that owns it, scoped to what `userId` can see.
export async function executeRoleTool(name, args, userId = 'default', agentId = null) {
  for (const [key, wrap] of visibleEntries(userId)) {
    if (wrap.manifest.tools?.some(t => t.function?.name === name)) {
      const skillId = wrap.manifest.id;
      // Same last-line gates executeToolStreaming enforces. This entry point
      // (the local-intent fast-path via runIntent, and executeTool callers
      // like /api/email/action) used to skip all three — a child whose phrase
      // matched a localIntent of a non-allowed skill ran the tool ungated,
      // and disabled-skill / hidden-tool overrides didn't apply here.
      if (userId) {
        if (!isSkillAllowedForUser(skillId, userId)) {
          return `Tool "${name}" is not permitted for this account.`;
        }
        if (!isSkillRuntimeEnabledForUser(skillId, userId, agentId)) {
          return `Tool "${name}" is from a disabled skill.`;
        }
        if (getHiddenTools(userId, skillId).includes(name)) {
          return `Tool "${name}" is hidden by your settings.`;
        }
      }
      if (shouldSandboxSkill(wrap)) return runCustomSkillValue({ userId, agentId, skillId, name, args });
      const exec = await getExecutorByKey(key);
      if (exec) return exec(name, args, userId, agentId, await buildCtx(userId, agentId, skillId));
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

// User profile: roles/user-profile.mjs

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

import {
  bindToolExecutionDeps,
  executeToolStreaming as _executeToolStreaming,
  TOOL_ALIASES,
  NON_LEARNING_BLOCKED_TOOLS,
} from './roles/tool-execution.mjs';


bindAssignmentDeps({ getRoleManifest });
bindToolExecutionDeps({
  resolveKey,
  visibleEntries,
  getExecutorByKey,
  buildCtx,
  runCustomSkillValue,
  shouldSandboxSkill,
  isSkillAllowedForUser,
  isSkillRuntimeEnabledForUser,
  isScopableSkill,
  getRoleManifest,
  listRoles,
  _readUserProfile,
});

export { TOOL_ALIASES, NON_LEARNING_BLOCKED_TOOLS };
export const executeToolStreaming = _executeToolStreaming;

