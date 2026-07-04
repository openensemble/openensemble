// @ts-check
/**
 * GATE-WALKER — "why didn't my tool get called?" diagnostic.
 *
 * A tool has to survive ~12 independent, silently-failing gates spread across
 * a dozen files before an agent will ever actually call it. Skill authors
 * (and future maintainers of this very file) burn hours bisecting which one
 * dropped a new tool. This module walks all twelve, in pipeline order, for a
 * given (toolName, agentId, userId) triple and reports PASS / DROP /
 * CONDITIONAL per gate, plus the first gate that drops it.
 *
 * Design contract:
 *   - READ-ONLY, and CHEAP. Never executes a tool, never mutates any file,
 *     never makes an LLM call, never touches the network. Deliberately does
 *     NOT call routes/_helpers/agent-resolver.mjs's getAgentsForUser /
 *     getAgentForUser — that path composes system prompts, warms the MCP
 *     tool-def cache, and does LAN discovery, which is both far more than a
 *     "why isn't this tool visible" question needs and (per a live check
 *     while building this file) can stall waiting on state a running server
 *     also touches. Instead each gate calls the SAME narrow, side-effect-free
 *     exported primitive the real gate uses (resolveAgentTools,
 *     isSkillDisabled, getHiddenTools, getRoleAssignments, getAgentRoles,
 *     trimToolsForTurn, scoreToolsForTurn, classifyByEmbedding, dispatch()),
 *     or faithfully mirrors a small inline block that isn't separately
 *     exported (documented with a source anchor + "re-verify" note so a
 *     future edit to the original is easy to catch).
 *   - Gates 1-6, 9, 12 are STATIC — definitive PASS/DROP, no turn text needed.
 *   - Gates 7, 8, 10, 11 are PER-TURN — CONDITIONAL without `sampleText`
 *     (they depend on what the user says), SIMULATED with `sampleText` via
 *     the real classification/dispatch functions (all embedding calls are
 *     read-only similarity lookups against the bundled local embedder, never
 *     generation, and never leave the process).
 *
 * Anchors verified 2026-07-04 against the live tree. Gate numbering below
 * matches the project's canonical 12-gate list (see memory:
 * project_tool_level_router.md / feedback_skill_tool_gates.md and friends) —
 * re-verify each cited line range before trusting it; this file will drift
 * from the source over time like any other derived documentation.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BASE_DIR } from './paths.mjs';
import {
  listRoles, listAllRoles, getRoleManifest, resolveAgentTools, getRoleAssignments, getAgentRoles,
} from '../roles.mjs';
import { isSkillDisabled, getHiddenTools } from './skill-overrides.mjs';
import { getUserEnabledSkills } from '../routes/_helpers/agent-resolver.mjs';
import { getAgent } from '../agents.mjs';
import { toolRouterCfg, trimToolsForTurn } from './tool-router.mjs';
import { classifyByEmbedding } from './specialist-embed-router.mjs';
import { dispatch, localTierEnabled } from './local-label.mjs';

// Repo-root-relative, NOT BASE_DIR: BASE_DIR is redirected to an isolated
// per-process scratch directory under tests (lib/paths.mjs makeTestBaseDir)
// that holds only user/skill DATA, not the source tree itself. Gate 9 needs
// to read chat-dispatch.mjs's actual source, so it resolves relative to this
// file's own on-disk location instead (mirrors how lib/paths.mjs derives its
// own REAL_BASE).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Human-readable gate metadata, keyed by gate number. Kept separate from the
// evaluators below so formatGateWalkReport and tests can reference names
// without re-deriving them.
export const GATE_DEFS = [
  { gate: 1,  name: 'Manifest declaration',            anchor: 'skills/<id>/manifest.json tools[] (global + user-scoped)' },
  { gate: 2,  name: 'Assignment/bundling',              anchor: 'roles.mjs:851-913 resolveAgentTools' },
  { gate: 3,  name: 'Coordinator defaultToolIds filter', anchor: 'routes/_helpers/agent-resolver.mjs:149-218' },
  { gate: 4,  name: 'Child-account allowedSkills',       anchor: 'roles.mjs visibleEntries / routes/users.mjs' },
  { gate: 5,  name: 'Skill disabled override',           anchor: 'lib/skill-overrides.mjs:71, applied roles.mjs:555' },
  { gate: 6,  name: 'Hidden-tools override',             anchor: 'lib/skill-overrides.mjs:77-81, applied roles.mjs:635/1371/1523' },
  { gate: 7,  name: 'Per-turn skill-level trim (coordinators)', anchor: 'lib/tool-router.mjs:374/405-432' },
  { gate: 8,  name: 'Tool-level v2 trim',                anchor: 'lib/tool-router.mjs:237-306' },
  { gate: 9,  name: 'Voice-device allowlist',            anchor: 'chat-dispatch.mjs:173, applied :229' },
  { gate: 10, name: 'Intent/specialist routing',         anchor: 'lib/specialist-embed-router.mjs:38 (threshold 0.78)' },
  { gate: 11, name: 'localIntents fast-path',            anchor: 'lib/local-label.mjs' },
  { gate: 12, name: 'executeRoleTool runtime gate',      anchor: 'roles.mjs:1354-1373, 1500-1527' },
];
const GATE_NAME = Object.fromEntries(GATE_DEFS.map(g => [g.gate, g.name]));
const GATE_ANCHOR = Object.fromEntries(GATE_DEFS.map(g => [g.gate, g.anchor]));

function gateResult(gate, status, detail, extra = {}) {
  return { gate, name: GATE_NAME[gate], anchor: GATE_ANCHOR[gate], status, detail, ...extra };
}

// ── tiny local helpers (no side effects) ────────────────────────────────────

function readProfileRaw(userId) {
  if (!userId) return null;
  try {
    const p = path.join(BASE_DIR, 'users', userId, 'profile.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function toolNamesOf(manifest) {
  return (manifest?.tools ?? []).map(t => t?.function?.name).filter(Boolean);
}

function namesFromSkillIds(skillIds, userId) {
  const out = new Set();
  for (const id of skillIds) {
    const m = getRoleManifest(id, userId);
    if (!m) continue;
    for (const n of toolNamesOf(m)) out.add(n);
  }
  return out;
}

// The bare (unscoped) agent id. An agent id sometimes arrives scoped as
// "<userId>_<id>" (session keys) and sometimes bare — roles.mjs strips this
// same way in getAgentRoles/getAgentAssignedSkills/agentCanFastpathSkill, so
// we mirror it here for the same assignment lookups.
function bareAgentId(agentId, userId) {
  if (userId && typeof agentId === 'string' && agentId.startsWith(userId + '_')) {
    return agentId.slice(userId.length + 1);
  }
  return agentId;
}

// Mirrors routes/_helpers/agent-resolver.mjs's TOOL_SETS_COMPAT (line ~27) —
// legacy toolSet values map to the skillCategory names roles.mjs understands.
const TOOL_SETS_COMPAT = { web: 'general', general: 'general', gmail: 'email', email: 'email', none: 'none' };

/**
 * Resolve an agent's effective skillCategory the same way
 * routes/_helpers/agent-resolver.mjs:getAgentsForUser does (lines ~117-121,
 * 140-141), WITHOUT running that function's full prompt/MCP/SPA composition.
 * Deliberately reimplemented here — see the module docstring for why we
 * don't call getAgentsForUser/getAgentForUser directly.
 */
function deriveSkillCategory(agentId, userId, profile) {
  let rawAgent = null;
  try { rawAgent = getAgent(agentId); } catch { /* best-effort */ }
  const overrides = (profile?.agentOverrides && typeof profile.agentOverrides === 'object')
    ? profile.agentOverrides[agentId] : null;
  const withOverrides = { ...(rawAgent ?? {}), ...(overrides ?? {}) };
  try {
    const assignments = getRoleAssignments(userId) || {};
    const bare = bareAgentId(agentId, userId);
    const assignedIds = Object.entries(assignments).filter(([, v]) => v === bare || v === agentId).map(([k]) => k);
    const roleSkillId = assignedIds.find(id => getRoleManifest(id, userId)?.service) ?? assignedIds[0];
    return roleSkillId ?? withOverrides.skillCategory ?? TOOL_SETS_COMPAT[withOverrides.toolSet ?? 'web'] ?? null;
  } catch {
    return withOverrides.skillCategory ?? null;
  }
}

// Parse the live VOICE_DEVICE_TOOL_ALLOWLIST Set literal straight out of
// chat-dispatch.mjs's source text. Not exported by that module (it's a
// module-private const), so we inspect the source rather than keep a second,
// driftable copy in this file — this way the phantom-entry check (below) is
// always checking the actual live list, not a stale mirror.
function readVoiceAllowlistNames() {
  try {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'chat-dispatch.mjs'), 'utf8');
    const m = src.match(/const VOICE_DEVICE_TOOL_ALLOWLIST\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
    if (!m) return null;
    return [...m[1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map(x => x[1]);
  } catch { return null; }
}

// ── Gate 1 — manifest declaration ───────────────────────────────────────────

function evalGate1(toolName, userId) {
  // Deliberately NOT listRoles(userId) here: it also excludes disabled skills
  // (roles.mjs:555), which would misattribute a gate-5 drop to gate 1. Gate 1
  // only asks "does ANY manifest declare this tool, and is that manifest
  // visible to this user" — visibility (global vs user-scoped-to-someone-
  // else) is independent of disabled/hidden state, which gates 5/6 own.
  let all = [];
  try { all = listAllRoles(); } catch { /* best-effort */ }
  const owners = all.filter(m => toolNamesOf(m).includes(toolName));
  if (!owners.length) {
    return {
      result: gateResult(1, 'drop',
        `no manifest declares a tool named "${toolName}" — checked skills/*/manifest.json (global) and users/*/skills/*/manifest.json (user-scoped). Typo, or the manifest wasn't reloaded (loadRoleManifests runs at boot)?`),
      skillId: null, manifest: null,
    };
  }
  // loadRoleManifests stamps `createdBy` on every user-scoped skill at load
  // time (Pass 2) but never on global ones (Pass 1) — so "no createdBy" means
  // global/visible-to-everyone, and "createdBy === userId" means this user's
  // own custom skill. Anything else is another user's custom skill.
  const visible = owners.find(m => !m.createdBy || m.createdBy === userId);
  if (visible) {
    const where = visible.createdBy
      ? `user-scoped skill "${visible.id}" (users/${visible.createdBy}/skills/${visible.id}/manifest.json)`
      : `global skill "${visible.id}" (skills/${visible.id}/manifest.json)`;
    return { result: gateResult(1, 'pass', `declared in ${where}`), skillId: visible.id, manifest: visible };
  }
  const elsewhere = owners[0];
  return {
    result: gateResult(1, 'drop',
      `declared in skill "${elsewhere.id}" (owned by user "${elsewhere.createdBy}"), but that manifest is NOT visible to user "${userId}" — it's neither a global skill nor one of this user's own users/${userId}/skills/ entries`),
    skillId: elsewhere.id, manifest: elsewhere,
  };
}

// ── Gate 2 — assignment/bundling (resolveAgentTools) ────────────────────────
//
// This gate asks a SKILL-level question — "is skill X admitted into agent Y's
// tool-gathering at all" — deliberately independent of whether the SPECIFIC
// tool then survives hidden-tools filtering. resolveAgentTools's real output
// can't answer that in isolation: for utility/assigned skills it routes
// through getRoleTools (roles.mjs:630-642), which applies hiddenTools
// (gate 6) INSIDE the same call — so "is toolName present in the resolved
// array" conflates gates 2 and 6 for exactly the tool-visibility question
// gate 6 exists to own (and gives a false gate-2 DROP for a skill that's
// perfectly well-assigned but has this one tool hidden). We still compute the
// real resolveAgentTools() output below (gate2Tools) — it's the correct
// candidate set for gates 3/7/8 — but the PASS/DROP verdict for gate 2 itself
// comes from mirroring resolveAgentTools's admission conditions
// (roles.mjs:851-913) directly against the manifest, not against its
// tools-array output.
function isSkillAdmittedForAgent({ skillId, skillCategory, userSkills, agentId, userId }) {
  const manifest = getRoleManifest(skillId, userId);
  if (!manifest) return { admitted: false, reason: 'no-manifest' };

  // An agent's own primary-role tools are included unconditionally
  // (roles.mjs:883), even if the skill isn't in the user's enabled skills.
  if (skillCategory && skillId === skillCategory) return { admitted: true, reason: 'primary-role' };

  let scopeEntry = null;
  try { scopeEntry = listRoles(userId).find(m => m.id === skillId) ?? null; } catch { /* best-effort */ }
  const isGlobal = scopeEntry ? scopeEntry.userScope === null : true;

  // always_on tools are global-only (roles.mjs:getAlwaysOnTools skips
  // user-scoped skills even if they set always_on:true).
  if (manifest.always_on && isGlobal) return { admitted: true, reason: 'always-on' };

  const assignments = (() => { try { return getRoleAssignments(userId) || {}; } catch { return {}; } })();
  const coordinatorId = assignments['coordinator'] ?? null;
  const isAssignedTo = (sid) => {
    const owner = assignments[sid];
    if (!owner) return false;
    if (owner === agentId) return true;
    if (owner === 'coordinator' && coordinatorId && coordinatorId === agentId) return true;
    return false;
  };

  if (manifest.category === 'utility') {
    if (!userSkills.includes(skillId)) return { admitted: false, reason: 'utility-not-enabled' };
    const owner = assignments[skillId];
    if (!owner) return { admitted: true, reason: 'utility-unowned' };
    return isAssignedTo(skillId) ? { admitted: true, reason: 'utility-assigned' } : { admitted: false, reason: 'utility-assigned-elsewhere' };
  }

  if (manifest.category !== 'delegate' && userSkills.includes(skillId) && isAssignedTo(skillId)) {
    return { admitted: true, reason: 'assigned' };
  }

  if (manifest.bundled_with_role && manifest.bundled_with_role === skillCategory) {
    return { admitted: true, reason: 'bundled' };
  }

  if (manifest.category === 'delegate' && isGlobal) return { admitted: true, reason: 'delegate' };

  return { admitted: false, reason: 'not-admitted' };
}

const ADMIT_REASON_TEXT = {
  'primary-role': (skillId, skillCategory) => `"${skillId}" is agent's own primary-role skill ("${skillCategory}") — its tools are included unconditionally`,
  'always-on': (skillId) => `"${skillId}" is a global always_on skill — its tools are injected into every agent`,
  'utility-unowned': (skillId) => `"${skillId}" is an unowned category:"utility" skill enabled for this user — available to every agent`,
  'utility-assigned': (skillId, _sc, agentId) => `"${skillId}" is a category:"utility" skill assigned specifically to agent "${agentId}"`,
  assigned: (skillId, _sc, agentId) => `"${skillId}" is enabled for this user and assigned to agent "${agentId}" via skillAssignments`,
  bundled: (skillId, skillCategory) => `"${skillId}" declares "bundled_with_role": "${skillCategory}"`,
  delegate: (skillId) => `"${skillId}" is a global delegate-category skill (e.g. ask_agent) — flows to every agent`,
};

function evalGate2({ skillId, skillCategory, userSkills, agentId, userId, toolName }) {
  if (!skillId) return { result: gateResult(2, 'pass', 'not evaluated — gate 1 already found no owning skill'), tools: [] };
  if (!skillCategory) {
    return {
      result: gateResult(2, 'conditional', `couldn't resolve agent "${agentId}"'s skillCategory (agent not found, or no role/skill assignment on record) — cannot determine assignment/bundling admission`),
      tools: [],
    };
  }
  let tools = [];
  try { tools = resolveAgentTools(skillCategory, userSkills, agentId, userId) ?? []; }
  catch { /* best-effort — admission check below doesn't depend on this succeeding */ }

  const admission = isSkillAdmittedForAgent({ skillId, skillCategory, userSkills, agentId, userId });
  if (admission.admitted) {
    const describe = ADMIT_REASON_TEXT[admission.reason] ?? (() => admission.reason);
    return { result: gateResult(2, 'pass', describe(skillId, skillCategory, agentId)), tools };
  }
  return {
    result: gateResult(2, 'drop',
      `skill "${skillId}" is NOT admitted into agent "${agentId}"'s tool set for skillCategory="${skillCategory}" — it's not always_on, not an enabled+unowned utility skill, not assigned to this agent via skillAssignments, not "${skillCategory}"'s own primary-role skill, not bundled_with_role="${skillCategory}", and not a global delegate-category skill (reason: ${admission.reason}). Check: is "${skillId}" in the user's enabled skills AND assigned to this agent?`),
    tools,
  };
}

// ── Gate 3 — coordinator defaultToolIds filter (with bypasses) ─────────────
// Mirrors routes/_helpers/agent-resolver.mjs:149-218, which computes this
// inline inside getAgentsForUser's per-agent map rather than as its own
// exported function. Re-verify against source if this drifts.

function buildGate3Context({ skillCategory, agentId, userId, agentToolIdsOverride }) {
  const toolIds = (Array.isArray(agentToolIdsOverride) && agentToolIdsOverride.length)
    ? agentToolIdsOverride
    : (getRoleManifest(skillCategory, userId)?.defaultToolIds ?? null);
  if (!toolIds || !toolIds.length) return { toolIds: null, usedOverride: false };

  const assignedSkillIds = (() => {
    try {
      const assignments = getRoleAssignments(userId) || {};
      const bare = bareAgentId(agentId, userId);
      return Object.entries(assignments).filter(([, v]) => v === bare || v === agentId).map(([k]) => k);
    } catch { return []; }
  })();
  const assignedSkillToolNames = namesFromSkillIds(assignedSkillIds, userId);

  let userSkills = [];
  try { userSkills = getUserEnabledSkills(userId); } catch { /* best-effort */ }
  const utilitySkillIds = userSkills.filter(id => getRoleManifest(id, userId)?.category === 'utility');
  const utilityToolNames = namesFromSkillIds(utilitySkillIds, userId);

  let heldRoles = [];
  try { heldRoles = getAgentRoles(agentId, userId); } catch { /* best-effort */ }
  const heldRoleTools = namesFromSkillIds(heldRoles, userId);

  let bundledIds = [];
  try { bundledIds = listRoles(userId).filter(m => m.bundled_with_role === skillCategory).map(m => m.id); } catch { /* best-effort */ }
  const bundledRoleTools = namesFromSkillIds(bundledIds, userId);

  let delegateIds = [];
  try { delegateIds = listRoles(userId).filter(m => m.category === 'delegate').map(m => m.id); } catch { /* best-effort */ }
  const delegateToolNames = namesFromSkillIds(delegateIds, userId);

  return {
    toolIds, usedOverride: !!(Array.isArray(agentToolIdsOverride) && agentToolIdsOverride.length),
    assignedSkillIds, assignedSkillToolNames, utilityToolNames, heldRoleTools, bundledRoleTools, delegateToolNames,
  };
}

/** @returns {{allowed: boolean, reason: string}} */
function gate3Verdict(toolNameToCheck, ctx) {
  if (!ctx.toolIds) return { allowed: true, reason: 'no-filter' };
  if (ctx.toolIds.includes(toolNameToCheck)) return { allowed: true, reason: 'listed' };
  if (ctx.assignedSkillToolNames?.has(toolNameToCheck)) return { allowed: true, reason: 'assigned-skill' };
  if (ctx.utilityToolNames?.has(toolNameToCheck)) return { allowed: true, reason: 'utility' };
  if (ctx.heldRoleTools?.has(toolNameToCheck)) return { allowed: true, reason: 'held-role' };
  if (ctx.bundledRoleTools?.has(toolNameToCheck)) return { allowed: true, reason: 'bundled-role' };
  if (ctx.delegateToolNames?.has(toolNameToCheck)) return { allowed: true, reason: 'delegate' };
  return { allowed: false, reason: 'not-allowed' };
}

function evalGate3({ skillId, skillCategory, agentId, userId, toolName, agentToolIdsOverride }) {
  if (!skillId) return { result: gateResult(3, 'pass', 'not evaluated — gate 1 already found no owning skill'), ctx: null };
  if (!skillCategory) return { result: gateResult(3, 'conditional', `couldn't resolve agent "${agentId}"'s skillCategory`), ctx: null };

  const ctx = buildGate3Context({ skillCategory, agentId, userId, agentToolIdsOverride });
  if (!ctx.toolIds) {
    return {
      result: gateResult(3, 'pass', `"${skillCategory}" declares no defaultToolIds (and the agent has no explicit toolIds override) — the filter is a no-op, every tool resolveAgentTools gathered passes straight through`),
      ctx,
    };
  }
  const v = gate3Verdict(toolName, ctx);
  if (v.allowed) {
    const REASON_TEXT = {
      listed: `"${toolName}" is explicitly listed in ${ctx.usedOverride ? `agent "${agentId}"'s explicit toolIds override` : `"${skillCategory}"'s manifest defaultToolIds`}`,
      'assigned-skill': `bypasses defaultToolIds via the ASSIGNED-SKILL bypass — "${skillId}" is explicitly assigned to "${agentId}" (skillAssignments["${skillId}"]); tools from an explicitly-assigned skill always bypass the primary role's defaultToolIds allowlist`,
      utility: `bypasses defaultToolIds via the UTILITY bypass — "${skillId}" is category:"utility" and enabled for this user`,
      'held-role': `bypasses defaultToolIds via the HELD-ROLE bypass — "${agentId}" holds the "${skillId}" service role (getAgentRoles)`,
      'bundled-role': `bypasses defaultToolIds via the BUNDLED-ROLE bypass — a manifest declares "bundled_with_role": "${skillCategory}"`,
      delegate: `bypasses defaultToolIds via the DELEGATE-category bypass (e.g. ask_agent flows to every agent)`,
    };
    return { result: gateResult(3, 'pass', REASON_TEXT[v.reason]), ctx };
  }
  return {
    result: gateResult(3, 'drop',
      `"${toolName}" is not in "${skillCategory}"'s defaultToolIds (${ctx.toolIds.length} entries) and qualifies for none of the bypasses (not separately assigned to "${agentId}", not utility, not a held role, not bundled_with_role="${skillCategory}", not delegate-category) — add "${toolName}" to skills/${skillCategory}/manifest.json's defaultToolIds, or assign skill "${skillId}" to this agent`),
    ctx,
  };
}

// ── Gate 4 — child-account allowedSkills ────────────────────────────────────

function evalGate4({ skillId, profile, userId }) {
  if (!skillId) return gateResult(4, 'pass', 'not evaluated — gate 1 already found no owning skill');
  if (!profile || profile.role !== 'child') {
    return gateResult(4, 'pass', `user "${userId}" is not a child account — the allowedSkills gate doesn't apply`);
  }
  const allowed = Array.isArray(profile.allowedSkills) ? profile.allowedSkills : [];
  if (allowed.includes(skillId)) {
    return gateResult(4, 'pass', `child account's allowedSkills includes "${skillId}"`);
  }
  return gateResult(4, 'drop',
    `child account "${userId}" has allowedSkills=[${allowed.join(', ')}], which does NOT include "${skillId}" — the skill won't reach userSkills, and would be refused again at the gate-12 runtime re-check`);
}

// ── Gate 5 — skill disabled override ────────────────────────────────────────

function evalGate5({ skillId, manifest, userId }) {
  if (!skillId) return gateResult(5, 'pass', 'not evaluated — gate 1 already found no owning skill');
  let disabled = false;
  try { disabled = isSkillDisabled(userId, skillId, !!manifest?.always_on); } catch { /* best-effort */ }
  if (disabled) {
    return gateResult(5, 'drop', `users/${userId}/skill-overrides.json["${skillId}"].disabled === true`);
  }
  return gateResult(5, 'pass', `skill "${skillId}" is not disabled for user "${userId}"`);
}

// ── Gate 6 — hidden-tools override ──────────────────────────────────────────

function evalGate6({ skillId, skillCategory, toolName, userId }) {
  if (!skillId) return gateResult(6, 'pass', 'not evaluated — gate 1 already found no owning skill');
  let hidden = [];
  try { hidden = getHiddenTools(userId, skillId); } catch { /* best-effort */ }
  if (hidden.includes(toolName)) {
    return gateResult(6, 'drop', `"${toolName}" is in users/${userId}/skill-overrides.json["${skillId}"].hiddenTools`);
  }
  // Known nuance: resolveAgentTools only routes utility/assigned tools through
  // getRoleTools (which applies hiddenTools) — an agent's OWN primary-role
  // tools come from getRoleManifest directly (roles.mjs:883), bypassing the
  // hidden-tools filter at assembly time. It's still enforced again at gate 12
  // (executeRoleTool/executeToolStreaming always call getHiddenTools), so a
  // hidden primary tool can appear in the agent's tool list yet get refused
  // when actually called.
  const note = (skillId === skillCategory)
    ? ' (note: this is the agent\'s own primary-role skill — hiddenTools is NOT applied when assembling primaryTools, so a hidden entry could still show up in the tool list and only get blocked at gate 12)'
    : '';
  return gateResult(6, 'pass', `"${toolName}" is not in "${skillId}"'s hiddenTools override${note}`);
}

// ── Gate 7 & 8 — per-turn tool-router trims ─────────────────────────────────
// Both stages live inside lib/tool-router.mjs's trimToolsForTurn, called once
// here so we don't run the (real, if unmocked) embedding classifier twice.
// The candidate list fed in is the gate-1..6 survivors (gate2 tools filtered
// by gate3's allow predicate) — NOT a full agent tool surface — since that's
// cheap to compute from primitives we already called and is all
// trimToolsForTurn needs to make an owner/primary-skill determination for
// THIS tool.

async function evalGate7and8({ toolName, skillId, skillCategory, gate3Ctx, gate2Tools, agentId, userId, source, sampleText }) {
  const candidateTools = gate3Ctx
    ? gate2Tools.filter(t => gate3Verdict(t.function?.name, gate3Ctx).allowed)
    : gate2Tools;
  const isCandidate = skillId != null && candidateTools.some(t => t.function?.name === toolName);

  let g7 = null, g8 = null;

  if (!isCandidate) {
    g7 = gateResult(7, 'pass', 'not evaluated — the tool never reached the resolved toolset at gates 1-6, so there is nothing for the per-turn trim to keep or drop');
    g8 = gateResult(8, 'pass', 'not evaluated — the tool never reached the resolved toolset at gates 1-6');
    return { g7, g8 };
  }

  if (skillCategory !== 'coordinator') {
    g7 = gateResult(7, 'pass',
      `agent "${agentId}"'s skillCategory is "${skillCategory}", not "coordinator" — the skill-level per-turn gate only runs for coordinator-category agents (tool-router.mjs:405); specialists hold their assigned skills directly every turn`);
  } else if (!sampleText) {
    g7 = gateResult(7, 'conditional',
      `coordinator turns trim whole skills per-message — skill "${skillId}" ships only when it's always-on/held/bundled, OR the message's intent classifies to it (regex DIRECT_INTENT_RULES or embedding similarity >= 0.72). Provide sampleText to simulate.`);
  }

  let cfg;
  try { cfg = toolRouterCfg(); } catch { cfg = { enabled: true }; }
  if (!cfg.enabled) {
    g8 = gateResult(8, 'pass', 'config.toolRouter.toolLevel === false — the v2 tool-level pass is disabled entirely, nothing is narrowed');
  } else if (!sampleText) {
    g8 = gateResult(8, 'conditional',
      `the tool-level pass narrows WITHIN kept skills: an agent's own primary-skill tools are never trimmed, but borrowed tasks/self-mgmt-admin/desktop bucket tools are gated by deterministic regex intent. Provide sampleText to simulate.`);
  }

  if (g7 && g8) return { g7, g8 };

  // At least one of the two needs simulation and we have sampleText — run the
  // real trimToolsForTurn once against the (small) candidate list. Pure
  // function; does not mutate its input, makes no network calls (the
  // embedding classifier it may invoke is a local, bundled model lookup).
  try {
    const routerAgent = { id: agentId, skillCategory, tools: candidateTools };
    const r = await trimToolsForTurn({ agent: routerAgent, userText: sampleText, userId, source: source ?? null });
    if (!g7) {
      const keptSkills = r.skillsKept ?? r.initiallyIncludedSkills ?? new Set();
      g7 = keptSkills.has(skillId)
        ? gateResult(7, 'pass', `with sampleText, the skill-level gate kept skill "${skillId}" this turn (${(r.routerNotes ?? []).join('; ')})`)
        : gateResult(7, 'drop', `with sampleText, the skill-level gate did NOT keep skill "${skillId}" this turn — not always-on/held/bundled and the message didn't classify to it (${(r.routerNotes ?? []).join('; ')})`);
    }
    if (!g8) {
      const decision = (r.toolDecisions ?? []).find(d => d.name === toolName);
      if (!decision) {
        g8 = gateResult(8, 'pass', `tool-level pass produced no decision for "${toolName}" (its skill was likely already excluded at gate 7 this turn) — nothing further to narrow`);
      } else if (decision.kept) {
        g8 = gateResult(8, 'pass', `tool-level pass kept "${toolName}" this turn (reason: ${decision.reason})`);
      } else {
        g8 = gateResult(8, 'drop', `tool-level pass DROPPED "${toolName}" this turn (reason: ${decision.reason}) — recoverable mid-turn via request_tools`);
      }
    }
  } catch (e) {
    if (!g7) g7 = gateResult(7, 'conditional', `trimToolsForTurn threw: ${e.message}`);
    if (!g8) g8 = gateResult(8, 'conditional', `trimToolsForTurn threw: ${e.message}`);
  }
  return { g7, g8 };
}

// ── Gate 9 — voice-device allowlist ─────────────────────────────────────────

function evalGate9({ toolName, skillId, source, userId }) {
  if (source !== 'voice-device') {
    return gateResult(9, 'pass', `source is "${source ?? '(unspecified)'}", not "voice-device" — the allowlist only applies to voice-device chat turns`);
  }
  const staticNames = readVoiceAllowlistNames();
  if (staticNames === null) {
    return gateResult(9, 'conditional', 'could not read/parse VOICE_DEVICE_TOOL_ALLOWLIST out of chat-dispatch.mjs — its source shape may have changed; re-verify chat-dispatch.mjs:173');
  }

  // Phantom-entry check (project gotcha): allowlist entries that match no
  // real tool anywhere silently filter whole tool families. Surfaced
  // regardless of whether it affects THIS tool, since it's a live footgun.
  let allToolNames = new Set();
  try { for (const m of listAllRoles()) for (const n of toolNamesOf(m)) allToolNames.add(n); } catch { /* best-effort */ }
  const phantoms = staticNames.filter(n => !allToolNames.has(n));
  const phantomNote = phantoms.length
    ? ` [gotcha: ${phantoms.length} allowlist entr${phantoms.length === 1 ? 'y matches' : 'ies match'} no real tool anywhere — dead weight at best, and if this ever meant to reference a renamed tool it's silently filtering that whole family: ${phantoms.slice(0, 8).join(', ')}${phantoms.length > 8 ? ', …' : ''}]`
    : '';

  let voiceOptInSkillIds = [];
  try { voiceOptInSkillIds = listRoles(userId).filter(m => m.voice_device === true).map(m => m.id); } catch { /* best-effort */ }
  const optedIn = skillId && voiceOptInSkillIds.includes(skillId);

  if (staticNames.includes(toolName)) {
    return gateResult(9, 'pass', `"${toolName}" is in VOICE_DEVICE_TOOL_ALLOWLIST${phantomNote}`);
  }
  if (optedIn) {
    return gateResult(9, 'pass', `owning skill "${skillId}" declares "voice_device": true, adding all its tools to the voice allowlist${phantomNote}`);
  }
  return gateResult(9, 'drop',
    `"${toolName}" is not in VOICE_DEVICE_TOOL_ALLOWLIST and skill "${skillId ?? '(unknown)'}" doesn't declare "voice_device": true — voice-device turns silently drop this tool${phantomNote}`);
}

// ── Gate 10 — intent/specialist routing ─────────────────────────────────────

async function evalGate10({ toolName, agentId, userId, sampleText }) {
  if (!sampleText) {
    return gateResult(10, 'conditional',
      'needs sampleText — if this agent is the user\'s coordinator, the embed router (threshold 0.78) can redirect the WHOLE turn to a different agent before this agent (and this tool) is ever reached. Only matters when diagnosing the coordinator agent.');
  }
  let hit;
  try { hit = await classifyByEmbedding(sampleText, userId, agentId); }
  catch (e) { return gateResult(10, 'conditional', `classifyByEmbedding threw: ${e.message}`); }
  if (!hit) {
    return gateResult(10, 'pass', 'no confident specialist-router match for this text (or this agent is not the coordinator) — the turn proceeds on the diagnosed agent');
  }
  if (hit.agentId && hit.agentId !== agentId) {
    return gateResult(10, 'drop',
      `the embed router would redirect this turn to agent "${hit.agentId}" (skill "${hit.skillId}", similarity ${hit.sim?.toFixed?.(3) ?? hit.sim}) BEFORE "${agentId}" is ever reached — "${toolName}" never gets a chance to run on this agent this turn`);
  }
  return gateResult(10, 'pass', `embed router matched skill "${hit.skillId}" but it resolves back to the same agent — no redirect`);
}

// ── Gate 11 — localIntents fast-path ────────────────────────────────────────

async function evalGate11({ toolName, agentId, userId, sampleText }) {
  let enabled = false;
  try { enabled = localTierEnabled(); } catch { /* best-effort */ }
  if (!enabled) {
    return gateResult(11, 'pass', 'config.localTier.enabled !== true — the local-intent fast-path tier is off entirely, no interference possible');
  }
  if (!sampleText) {
    return gateResult(11, 'conditional',
      'needs sampleText — a matching local intent bound to a DIFFERENT tool fast-paths straight to it and skips the LLM turn entirely (this tool never gets called this turn); a match bound to THIS tool fast-paths it directly, bypassing gates 2-10 altogether.');
  }
  let match;
  try { match = await dispatch(sampleText, userId, { agentId }); }
  catch (e) { return gateResult(11, 'conditional', `dispatch() threw: ${e.message}`); }
  if (!match) {
    return gateResult(11, 'pass', 'no local-intent fast-path match for this text — falls through to the normal LLM tool-calling path');
  }
  if (match.tool === toolName) {
    return gateResult(11, 'pass', `local-intent fast-path matches THIS tool directly (intent "${match.skillId}/${match.intentId}", via ${match.via}) — it would run without even needing an LLM turn`);
  }
  return gateResult(11, 'drop',
    `local-intent fast-path matches a DIFFERENT tool ("${match.tool}", intent "${match.skillId}/${match.intentId}", via ${match.via}) for this text — the turn never reaches an LLM tool-call for "${toolName}"`);
}

// ── Gate 12 — executeRoleTool/executeToolStreaming runtime gate ────────────

function evalGate12({ skillId, g4, g5, g6 }) {
  if (!skillId) return gateResult(12, 'pass', 'not evaluated — gate 1 already found no owning skill');
  const drops = [g4, g5, g6].filter(g => g.status === 'drop');
  if (drops.length) {
    return gateResult(12, 'drop',
      `executeRoleTool / executeToolStreaming re-check allowedSkills, disabled, and hidden-tools state at the moment the tool is actually invoked — would ALSO refuse here, for the same reason${drops.length > 1 ? 's' : ''} as gate ${drops.map(d => d.gate).join(' & ')}`);
  }
  return gateResult(12, 'pass', 're-checks allowedSkills/disabled/hidden-tools at call time — all clear, consistent with gates 4-6 above');
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Walk all 12 tool-visibility gates for (toolName, agentId, userId).
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {string} opts.agentId
 * @param {string} opts.userId
 * @param {'browser'|'voice-device'|'telegram'|'desktop-app'|null} [opts.source]
 * @param {string|null} [opts.sampleText] - an example utterance; when given,
 *   gates 7/8/10/11 are SIMULATED instead of reported as conditional.
 * @returns {Promise<{verdict:string, firstDrop:object|null, toolName:string,
 *   agentId:string, userId:string, source:string|null, sampleText:string|null,
 *   skillId:string|null, gates:object[]}>}
 */
export async function walkToolGates({ toolName, agentId, userId, source = null, sampleText = null }) {
  if (!toolName || typeof toolName !== 'string') throw new Error('walkToolGates: toolName is required');
  if (!agentId || typeof agentId !== 'string') throw new Error('walkToolGates: agentId is required');
  if (!userId || typeof userId !== 'string') throw new Error('walkToolGates: userId is required');

  const gates = [];

  // Gate 1
  const { result: g1, skillId, manifest } = evalGate1(toolName, userId);
  gates.push(g1);

  // Shared context for the remaining gates. Best-effort throughout — a
  // diagnostic tool must never itself crash the turn that's asking "why
  // didn't my tool get called?".
  const profile = readProfileRaw(userId);
  let userSkills = [];
  try { userSkills = getUserEnabledSkills(userId); } catch { /* best-effort */ }
  const skillCategory = deriveSkillCategory(agentId, userId, profile);

  // Gate 2
  const { result: g2, tools: gate2Tools } = evalGate2({ skillId, skillCategory, userSkills, agentId, userId, toolName });
  gates.push(g2);

  // Gate 3
  const agentToolIdsOverride = (profile?.agentOverrides?.[agentId]?.toolIds) ?? null;
  const { result: g3, ctx: gate3Ctx } = evalGate3({ skillId, skillCategory, agentId, userId, toolName, agentToolIdsOverride });
  gates.push(g3);

  // Gate 4
  const g4 = evalGate4({ skillId, profile, userId });
  gates.push(g4);

  // Gate 5
  const g5 = evalGate5({ skillId, manifest, userId });
  gates.push(g5);

  // Gate 6
  const g6 = evalGate6({ skillId, skillCategory, toolName, userId });
  gates.push(g6);

  // Gates 7 & 8 (per-turn tool-router; simulated together)
  const { g7, g8 } = await evalGate7and8({ toolName, skillId, skillCategory, gate3Ctx, gate2Tools, agentId, userId, source, sampleText });
  gates.push(g7, g8);

  // Gate 9
  const g9 = evalGate9({ toolName, skillId, source, userId });
  gates.push(g9);

  // Gate 10
  const g10 = await evalGate10({ toolName, agentId, userId, sampleText });
  gates.push(g10);

  // Gate 11
  const g11 = await evalGate11({ toolName, agentId, userId, sampleText });
  gates.push(g11);

  // Gate 12
  const g12 = evalGate12({ skillId, g4, g5, g6 });
  gates.push(g12);

  const firstDrop = gates.find(g => g.status === 'drop') ?? null;
  const conditionalGates = gates.filter(g => g.status === 'conditional');

  let verdict;
  if (firstDrop) {
    verdict = `dropped at gate ${firstDrop.gate} (${firstDrop.name}): ${firstDrop.detail}`;
  } else if (conditionalGates.length) {
    verdict = `passes every static/simulated gate for agent "${agentId}" — ${conditionalGates.length} per-turn gate${conditionalGates.length > 1 ? 's are' : ' is'} condition-dependent (gate ${conditionalGates.map(g => g.gate).join(', ')}); pass sampleText to simulate ${conditionalGates.length > 1 ? 'them' : 'it'}`;
  } else {
    verdict = `passes all 12 gates — "${toolName}" should reach "${agentId}"'s tool-calling loop for user "${userId}"`;
  }

  return {
    verdict, firstDrop, toolName, agentId, userId,
    source: source ?? null, sampleText: sampleText ?? null,
    skillId, gates,
  };
}

// ── Human-readable formatting ────────────────────────────────────────────────

const STATUS_LABEL = { pass: 'PASS', drop: 'DROP', conditional: 'COND' };

/**
 * Render a walkToolGates() result as compact, chat-friendly text: a
 * fixed-width gate table inside a code fence, followed by the one-line
 * verdict.
 */
export function formatGateWalkReport(result) {
  const header = `Gate walk for tool "${result.toolName}" -> agent "${result.agentId}" (user "${result.userId}"${result.source ? `, source: ${result.source}` : ''}${result.sampleText ? `, sampleText: "${result.sampleText}"` : ''})`;
  const lines = result.gates.map(g => {
    const num = String(g.gate).padStart(2, ' ');
    const label = STATUS_LABEL[g.status] ?? g.status.toUpperCase();
    const name = g.name.padEnd(38, ' ');
    return `${num}. ${name} ${label}  ${g.detail}`;
  });
  return [header, '```', ...lines, '```', '', `VERDICT: ${result.verdict}`].join('\n');
}
