// @ts-check
/**
 * Sandbox gating + role tool dispatch (non-streaming).
 * Streaming executeToolStreaming stays in tool-execution.mjs.
 */

import { readConfig } from '../lib/paths.mjs';
import { skillDeclaresNetwork } from '../lib/skill-net-policy.mjs';
import { getHiddenTools } from '../lib/skill-overrides.mjs';
import { abortError } from '../lib/abort-utils.mjs';
import { getTurnContext } from '../lib/turn-abort-context.mjs';
import {
  _manifests,
  resolveKey,
} from './state.mjs';

let getRoleManifest = () => null;
let getExecutorByKey = async () => null;
let buildCtx = async () => ({});
let isSkillAllowedForUser = () => true;
let isSkillRuntimeEnabledForUser = () => true;
let isScopableSkill = () => false;
let listRoles = () => [];
let _readUserProfile = () => null;
let visibleEntries = function* () {};

export function bindExecutionDeps(deps) {
  for (const k of Object.keys(deps)) {
    if (deps[k] === undefined) continue;
    if (k === 'getRoleManifest') getRoleManifest = deps[k];
    else if (k === 'getExecutorByKey') getExecutorByKey = deps[k];
    else if (k === 'buildCtx') buildCtx = deps[k];
    else if (k === 'isSkillAllowedForUser') isSkillAllowedForUser = deps[k];
    else if (k === 'isSkillRuntimeEnabledForUser') isSkillRuntimeEnabledForUser = deps[k];
    else if (k === 'isScopableSkill') isScopableSkill = deps[k];
    else if (k === 'listRoles') listRoles = deps[k];
    else if (k === '_readUserProfile') _readUserProfile = deps[k];
    else if (k === 'visibleEntries') visibleEntries = deps[k];
  }
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
  const { runCustomSkillSandboxed } = await import('../lib/skill-subprocess.mjs');
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
  const { materializeReviewedInformationalSnapshot } = await import('../lib/personalization/reviewed-informational-skills.mjs');
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
  const grants = await import('../lib/personalization/skill-preference-grants.mjs');
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


