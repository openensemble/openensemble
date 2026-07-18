// @ts-check
/**
 * Skill → agent role assignments and drawer auto-enable.
 * Extracted from roles.mjs — pure move with bindAssignmentDeps.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { CFG_PATH, USERS_DIR } from '../lib/paths.mjs';
import { listAgents } from '../agents.mjs';
import { normalizeOrchestrationPolicy } from '../lib/orchestration-policy-core.mjs';
import { log } from '../logger.mjs';
import { _readUserProfile } from './user-profile.mjs';

let getRoleManifest = () => null;
let getDefaultRoles = () => [];
let isSkillRuntimeEnabledForUser = () => true;

export function bindAssignmentDeps(deps) {
  if (deps.getRoleManifest !== undefined) getRoleManifest = deps.getRoleManifest;
  if (deps.getDefaultRoles !== undefined) getDefaultRoles = deps.getDefaultRoles;
  if (deps.isSkillRuntimeEnabledForUser !== undefined) isSkillRuntimeEnabledForUser = deps.isSkillRuntimeEnabledForUser;
}

// ── Role Assignments ──────────────────────────────────────────────────────────
// The installation owner keeps the legacy global assignment map in config.json.
// Every other account is per-profile. Admins created by older builds may still
// rely on the global map, so reads merge it as a fallback until that admin has
// its own overrides; new writes always go to the admin profile. This prevents
// one admin's first-assistant onboarding from replacing the owner's coordinator.
function _isOwnerRole(role) { return role === 'owner'; }

function _readGlobalAssignments() {
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf8')).skillAssignments ?? {}; }
  catch { return {}; }
}

// null = unrestricted; Set = the complete account-level capability ceiling.
// Missing/unreadable profiles are fail-closed. Children require an explicit
// array. Regular users retain legacy unrestricted behavior only when the field
// is null/absent; once an array is present it is authoritative, including [].
export function _allowedSkillIdsForProfile(user) {
  if (!user) return new Set();
  if (user.role === 'owner' || user.role === 'admin') return null;
  if (Array.isArray(user.allowedSkills)) return new Set(user.allowedSkills);
  if (user.role === 'child') return new Set();
  return user.allowedSkills == null ? null : new Set();
}

export function getRoleAssignments(userId) {
  const user = userId ? _readUserProfile(userId) : null;
  let raw;
  if (_isOwnerRole(user?.role) || !userId) {
    raw = _readGlobalAssignments();
  } else if (user?.role === 'admin') {
    raw = { ..._readGlobalAssignments(), ...(user.skillAssignments ?? {}) };
  } else {
    raw = user?.skillAssignments ?? {};
  }
  const allowed = userId ? _allowedSkillIdsForProfile(user) : null;
  if (allowed) {
    // An assignment is ownership metadata, never a second capability grant.
    // Keep the coordinator pointer solely for routing; tool resolution still
    // requires the coordinator skill itself before exposing its schemas.
    raw = Object.fromEntries(Object.entries(raw).filter(([skillId]) =>
      skillId === 'coordinator' || allowed.has(skillId)));
  }
  return _projectAssignmentsForOrchestration(user, raw);
}

// Stored assignment lookup with account authorization but WITHOUT single-mode
// projection. Durable background work uses this to follow its real specialist
// when an ensemble is restored, while ordinary runtime consumers continue to
// use getRoleAssignments() above.
export function getDurableRoleAssignment(roleId, userId) {
  const user = userId ? _readUserProfile(userId) : null;
  let raw;
  if (_isOwnerRole(user?.role) || !userId) raw = _readGlobalAssignments();
  else if (user?.role === 'admin') raw = { ..._readGlobalAssignments(), ...(user.skillAssignments ?? {}) };
  else raw = user?.skillAssignments ?? {};
  const allowed = userId ? _allowedSkillIdsForProfile(user) : null;
  if (allowed && roleId !== 'coordinator' && !allowed.has(roleId)) return null;
  return typeof raw?.[roleId] === 'string' && raw[roleId] ? raw[roleId] : null;
}

/**
 * Choose the durable owner stored on a newly-created watcher. While single
 * mode is active, the executor is running under the projected primary even
 * when the enclosing skill is still assigned to a parked specialist. Store
 * that raw specialist target so switching back to ensemble restores the
 * intended owner without rewriting watcher records. Generic/non-skill work
 * follows the symbolic coordinator target instead.
 */
export async function resolveWatcherRegistrationAgentId(userId, currentAgentId, skillId = null) {
  const { getOrchestrationPolicy } = await import('./lib/orchestration-policy.mjs');
  if (getOrchestrationPolicy(userId).mode !== 'single') return currentAgentId;
  if (skillId) {
    const durableOwner = getDurableRoleAssignment(skillId, userId);
    const validOwner = durableOwner && listAgents().some(agent =>
      agent?.ownerId === userId && agent?.id === durableOwner);
    if (validOwner) return `${userId}_${durableOwner}`;
  }
  return `${userId}_coordinator`;
}

/**
 * Read-time orchestration projection (single-agent-mode plan §3.1/D5): when a
 * user's stored policy is single mode, every consumer of role assignments —
 * tool resolution, memory scoping (getAgentAssignedSkills), fastpath rights,
 * coordinator lookup — sees every assigned AND enabled skill as belonging to
 * the primary agent. The stored assignments are never rewritten, so switching
 * back to ensemble restores the exact previous layout.
 *
 * Policy semantics (missing/malformed → no projection) mirror
 * lib/orchestration-policy.mjs, which is canonical. Duplicated inline rather
 * than imported because this is a hot synchronous path already holding the
 * parsed profile, and roles.mjs sits below that module in the import graph.
 */
function _projectAssignmentsForOrchestration(user, raw) {
  const ownedAgents = user?.id ? listAgents().filter(agent => agent.ownerId === user.id) : [];
  const orch = normalizeOrchestrationPolicy(user?.orchestration, ownedAgents);
  const primary = orch.primaryAgentId;
  if (orch.mode !== 'single' || !primary) return raw;
  const projected = {};
  // A child profile's allowedSkills is the permission boundary, including for
  // stale/admin-written assignments. An assignment describes ownership; it is
  // not a second way to grant a capability. Keep the synthetic coordinator
  // assignment below for internal routing, but tool resolution independently
  // requires the coordinator skill itself to be allowed before exposing any of
  // its schemas.
  const allowed = _allowedSkillIdsForProfile(user);
  for (const skillId of Object.keys(raw)) {
    if (skillId !== 'coordinator' && (!allowed || allowed.has(skillId))) projected[skillId] = primary;
  }
  // Enabled skills expand onto the primary, but never beyond the account's
  // allowedSkills scope. enabled_by_default skills are backfilled into
  // `skills` for everyone, and without this intersection a restricted
  // account's primary would receive schemas that no ensemble agent carried.
  const enabledSkills = new Set([
    ...getDefaultRoles(),
    ...(Array.isArray(user.skills) ? user.skills : []),
  ]);
  for (const skillId of enabledSkills) {
    const manifest = getRoleManifest(skillId, user?.id);
    const runtimeEnabled = !manifest || isSkillRuntimeEnabledForUser(skillId, user?.id);
    if (runtimeEnabled && (!allowed || allowed.has(skillId))) projected[skillId] = primary;
  }
  projected.coordinator = primary;
  return projected;
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
    if (manifest?.service && isSkillRuntimeEnabledForUser(roleId, userId)) out.push(roleId);
  }
  return out;
}

/**
 * Every skill assigned to a given agent — service roles AND custom specialist
 * skills (youtube-downloader, pokemon-etb, …). This is the memory-scope
 * universe: an agent sees facts scoped to any skill it's assigned, so a fact
 * scoped to a custom skill reaches its specialist (and only it). Broader than
 * getAgentRoles (service-only) — kept separate so role-display logic that wants
 * just service roles is unaffected.
 */
export function getAgentAssignedSkills(agentId, userId) {
  if (!agentId) return [];
  const bare = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const assignments = getRoleAssignments(userId);
  return Object.entries(assignments)
    .filter(([id, assigned]) => {
      if (assigned !== bare) return false;
      // Preserve legacy/dangling custom scopes for reversible storage, but a
      // known disabled skill must not grant memory or fastpath authority.
      return !getRoleManifest(id, userId) || isSkillRuntimeEnabledForUser(id, userId);
    })
    .map(([id]) => id);
}

/**
 * May this agent run the pre-LLM fast-path for `skillId` (skip the LLM and
 * execute the skill's intent directly)? The coordinator may fast-path ANY
 * skill — it owns every cross-agent handoff. A specialist may fast-path only
 * the skills it's actually assigned (for example, specialist -> email).
 * A non-owner specialist (e.g. the deep-research agent) is denied, so a
 * paraphrase like "give me the latest US news" can't fire email_list — it
 * falls through to the agent's LLM, which escalates to the coordinator.
 * Voice turns resolve to the coordinator by default, so they stay allowed.
 */
export function agentCanFastpathSkill(agentId, skillId, userId) {
  if (!agentId || !skillId) return false;
  const bare = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const coordinatorId = getRoleAssignment('coordinator', userId);
  if (coordinatorId && bare === coordinatorId) return true;
  return getAgentAssignedSkills(agentId, userId).includes(skillId);
}

/**
 * Is this skill a worthwhile memory scope? True for service roles, and for any
 * skill assigned to a specific agent (custom specialist skills). Global/utility
 * skills (web, self-mgmt, delegate, tasks) aren't assigned to anyone, so facts
 * from them stay shared — which is correct, since recall can only route a fact
 * to an agent that's assigned its scope.
 */
export function isScopableSkill(skillId, userId) {
  if (!skillId) return false;
  const manifest = getRoleManifest(skillId, userId);
  if (manifest && !isSkillRuntimeEnabledForUser(skillId, userId)) return false;
  if (manifest?.service) return true;
  return Object.prototype.hasOwnProperty.call(getRoleAssignments(userId), skillId);
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
    // A caller that names an account is asking to mutate that account. Never
    // turn an unreadable/malformed profile into an installation-wide write:
    // doing so lets a transient profile failure overwrite the owner's legacy
    // assignments. Only a positively identified owner may use the global map.
    const user = _readUserProfile(userId);
    if (!user) {
      throw new Error(`Cannot update role assignment for unknown or unreadable user: ${userId}`);
    }
    if (!_isOwnerRole(user.role)) {
      const userPath = path.join(USERS_DIR, userId, 'profile.json');
      user.skillAssignments = user.skillAssignments ?? {};
      if (agentId) user.skillAssignments[roleId] = agentId;
      else delete user.skillAssignments[roleId];
      writeFileSync(userPath, JSON.stringify(user, null, 2));
      syncDrawerForRoleAssignment(userId, roleId, agentId);
      return;
    }
  }
  let cfg = {};
  if (existsSync(CFG_PATH)) cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Cannot update role assignment: invalid global configuration');
  }
  cfg.skillAssignments = cfg.skillAssignments ?? {};
  if (agentId) cfg.skillAssignments[roleId] = agentId;
  else delete cfg.skillAssignments[roleId];
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  // Privileged users (owner/admin) also get per-user pluginPrefs synced so the
  // drawer toggle reflects the role they just assigned.
  syncDrawerForRoleAssignment(userId, roleId, agentId);
}

/**
 * Remove every stored assignment that points at a deleted agent. This reads
 * the unprojected storage record deliberately: using getRoleAssignments in
 * single mode would make every projected skill appear to belong to the
 * primary and destructively erase the user's parked ensemble layout.
 */
export function clearRoleAssignmentsForAgent(agentId, userId) {
  if (!agentId) return 0;

  /** Remove exact references from one persisted assignment container. */
  const clearContainer = (container, targetPath) => {
    const assignments = container.skillAssignments ?? {};
    let removed = 0;
    for (const [skillId, assignedAgentId] of Object.entries(assignments)) {
      if (assignedAgentId !== agentId) continue;
      delete assignments[skillId];
      removed++;
    }
    if (removed) {
      container.skillAssignments = assignments;
      writeFileSync(targetPath, JSON.stringify(container, null, 2));
    }
    return removed;
  };

  const clearGlobal = () => {
    let cfg = {};
    if (existsSync(CFG_PATH)) cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw new Error('Cannot clear role assignments: invalid global configuration');
    }
    return clearContainer(cfg, CFG_PATH);
  };

  if (!userId) return clearGlobal();

  const user = _readUserProfile(userId);
  if (!user) {
    throw new Error(`Cannot clear role assignments for unknown or unreadable user: ${userId}`);
  }
  if (_isOwnerRole(user.role)) return clearGlobal();

  const userPath = path.join(USERS_DIR, userId, 'profile.json');
  const profileRemoved = clearContainer(user, userPath);
  // Older admins could have stored their assignments in the legacy global
  // map. Clean both locations during deletion while regular users remain
  // strictly profile-local.
  return profileRemoved + (user.role === 'admin' ? clearGlobal() : 0);
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
    const assignments = _isOwnerRole(user?.role)
      ? globalAssignments
      : (user?.role === 'admin'
          ? { ...globalAssignments, ...(user?.skillAssignments ?? {}) }
          : (user?.skillAssignments ?? {}));
    for (const [roleId, agentId] of Object.entries(assignments)) {
      if (ROLE_DRAWER_AUTO_ENABLE[roleId] && agentId) {
        syncDrawerForRoleAssignment(userId, roleId, agentId);
      }
    }
  }
}

