/**
 * Per-account orchestration policy — the explicit switch between the classic
 * multi-agent ensemble and single-agent mode (one persistent coordinator that
 * owns every enabled skill and delegates only to ephemeral workers).
 *
 * Rules (single-agent-mode integration plan, decisions D2/D4/D5):
 * - The mode is STORED, never inferred. Roster shape, agent count, and
 *   install age play no part in resolving it — a one-agent ensemble is still
 *   an ensemble, and a fresh install is whatever creation stamped it.
 * - A missing or malformed value resolves to "ensemble", so rolling back to
 *   a build that predates this field changes nothing for anyone.
 * - The server enforces the policy (agent-resolver projects the roster from
 *   it); settings surfaces only EDIT it.
 * - Switching is non-destructive in both directions: agents, role
 *   assignments, and layouts are never rewritten by a mode change, and
 *   `primaryAgentId` survives a switch back to ensemble so returning to
 *   single mode restores the same primary.
 */

import { getUser, modifyUser, loadUsers, broadcastAgentList } from '../routes/_helpers.mjs';
import { listAgents } from '../agents.mjs';
import {
  ORCHESTRATION_MODES,
  normalizeOrchestrationPolicy,
  normalizeRequestedOrchestration,
} from './orchestration-policy-core.mjs';

export { ORCHESTRATION_MODES } from './orchestration-policy-core.mjs';

/**
 * Mode stamped onto newly-created accounts. Existing accounts are migrated
 * independently and retain ensemble unless they explicitly switch.
 */
export const NEW_ACCOUNT_DEFAULT_MODE = 'single';

/**
 * New accounts request single mode before an agent exists. The first-agent
 * creation path replaces this transitional record atomically with a validated
 * `{ mode: 'single', primaryAgentId }` policy. Runtime readers never treat the
 * pending shape as active single mode.
 */
export function newAccountOrchestrationPolicy() {
  return NEW_ACCOUNT_DEFAULT_MODE === 'single'
    ? { mode: 'single', pendingPrimary: true }
    : { mode: 'ensemble' };
}

/**
 * Resolve the effective policy for a user. Never throws; never infers.
 *
 * Single mode without a usable primaryAgentId resolves to ensemble — the
 * write path refuses to store that shape, so it only occurs on a hand-edited
 * or half-migrated profile, and ensemble is the behavior every profile had
 * before this field existed.
 *
 * @param {string} userId
 * @returns {{ mode: 'ensemble'|'single', primaryAgentId: string|null }}
 */
export function getOrchestrationPolicy(userId) {
  const user = userId ? getUser(userId) : null;
  if (!user) return { mode: 'ensemble', primaryAgentId: null };
  const owned = listAgents().filter(agent => agent.ownerId === userId);
  return normalizeOrchestrationPolicy(user.orchestration, owned);
}

/**
 * Transitional onboarding state. Most callers need getOrchestrationPolicy;
 * this is only for first-agent creation/recovery.
 */
export function getRequestedOrchestrationPolicy(userId) {
  return normalizeRequestedOrchestration((userId ? getUser(userId) : null)?.orchestration);
}

/**
 * Persist a policy change. Validates before writing:
 * - mode must be a known mode;
 * - single mode requires a primaryAgentId naming an agent OWNED by this user
 *   (a dangling or foreign id would silently degrade to ensemble on read).
 *
 * Switching to ensemble keeps the stored primaryAgentId (D5) unless the
 * caller explicitly passes one to replace it.
 *
 * @param {string} userId
 * @param {{ mode: 'ensemble'|'single', primaryAgentId?: string|null }} policy
 * @returns {Promise<{ mode: 'ensemble'|'single', primaryAgentId: string|null }>} the effective policy after the write
 */
export async function setOrchestrationPolicy(userId, policy = {}, { deferBroadcast = false } = {}) {
  const { mode } = policy;
  if (!ORCHESTRATION_MODES.includes(mode)) {
    throw new Error(`Unknown orchestration mode: ${JSON.stringify(mode)}. Valid: ${ORCHESTRATION_MODES.join(', ')}`);
  }
  const topology = await import('../chat-dispatch/slot-registry.mjs');
  const transition = topology.tryAcquireUserTopologyTransition(userId);
  if (!transition) {
    const error = new Error('Another reply or account setup change is active. Wait for it to finish, then try again.');
    error.code = 'ORCHESTRATION_BUSY';
    throw error;
  }

  let committed = false;
  try {
    const user = userId ? getUser(userId) : null;
    if (!user) throw new Error(`Unknown user: ${userId}`);
    const owned = listAgents().filter(agent => agent.ownerId === userId);
    const ownedIds = new Set(owned.map(agent => agent.id));
    const requested = normalizeRequestedOrchestration(user.orchestration);
    const hasExplicitPrimary = Object.prototype.hasOwnProperty.call(policy, 'primaryAgentId');
    const primary = hasExplicitPrimary
      ? (typeof policy.primaryAgentId === 'string' && policy.primaryAgentId ? policy.primaryAgentId : null)
      : (ownedIds.has(requested.primaryAgentId) ? requested.primaryAgentId : null);

    if (primary && !ownedIds.has(primary)) {
      throw new Error(`primaryAgentId ${primary} is not an agent owned by ${userId}`);
    }
    if (mode === 'single' && !primary) throw new Error('single mode requires primaryAgentId');

    await modifyUser(userId, u => {
      u.orchestration = { mode, ...(primary ? { primaryAgentId: primary } : {}) };
    });
    const after = getOrchestrationPolicy(userId);
    committed = true;

    // An interactive chat switch owns an upgraded turn lease. Keep that
    // writer until the turn emits its terminal event, then refresh every open
    // roster. REST/settings mutations have an external writer and broadcast
    // immediately before releasing it.
    if (deferBroadcast && !transition.external) {
      transition.lease.deferUntilRelease(() => broadcastAgentList());
    } else {
      try { broadcastAgentList(); }
      finally { topology.finishUserTopologyTransition(transition); }
    }
    return after;
  } finally {
    if (!committed) topology.rollbackUserTopologyTransition(transition);
  }
}

/**
 * Complete the new-account onboarding transaction after its first agent has
 * been durably created. Account creation cannot name a primary yet, so it
 * writes `{mode:'single', pendingPrimary:true}`; this replaces that marker
 * with a validated active policy. Existing/migrated ensemble accounts are
 * untouched, as are later agent creations.
 *
 * Safe after a partial failure: startup stamping performs the same completion
 * when a pending account owns exactly one agent.
 */
export async function completePendingPrimary(userId, agentId) {
  const user = userId ? getUser(userId) : null;
  const agent = agentId ? listAgents().find(candidate => candidate.id === agentId) : null;
  if (!user || !agent || agent.ownerId !== userId) return false;
  const requested = normalizeRequestedOrchestration(user.orchestration);
  if (!requested.pendingPrimary) return false;

  // The first assistant must also become the durable ensemble coordinator.
  // Otherwise switching this fresh account back to ensemble leaves no routing
  // anchor, and owner/admin accounts risk falling through to another user's
  // legacy global coordinator assignment.
  const roles = await import('../roles.mjs');
  const previousCoordinator = roles.getRoleAssignment('coordinator', userId);
  roles.setRoleAssignment('coordinator', agentId, userId);
  let completed = false;
  try {
    await modifyUser(userId, current => {
      const live = normalizeRequestedOrchestration(current.orchestration);
      if (!live.pendingPrimary) return;
      current.orchestration = { mode: 'single', primaryAgentId: agentId };
      completed = true;
    });
  } catch (error) {
    roles.setRoleAssignment('coordinator', previousCoordinator, userId);
    throw error;
  }
  if (!completed) {
    roles.setRoleAssignment('coordinator', previousCoordinator, userId);
    return false;
  }
  if (completed) broadcastAgentList();
  return completed;
}

/**
 * Startup migration (D4): canonicalize every stored record. Profiles with no
 * valid policy become ensemble; stale/foreign primaries are cleared; a pending
 * new account with exactly one agent is completed safely after a crash.
 */
export async function stampOrchestrationDefaults() {
  let stamped = 0;
  for (const u of loadUsers()) {
    const requested = normalizeRequestedOrchestration(u?.orchestration);
    const owned = listAgents().filter(agent => agent.ownerId === u.id);
    if (requested.pendingPrimary && owned.length === 1) {
      if (await completePendingPrimary(u.id, owned[0].id)) stamped++;
      continue;
    }
    const effective = normalizeOrchestrationPolicy(u?.orchestration, owned);
    const desired = requested.pendingPrimary
      ? (owned.length === 0
          ? { mode: 'single', pendingPrimary: true }
          : { mode: 'ensemble' })
      : { mode: effective.mode, ...(effective.primaryAgentId ? { primaryAgentId: effective.primaryAgentId } : {}) };
    const current = u?.orchestration ?? null;
    if (current && JSON.stringify(current) === JSON.stringify(desired)) continue;
    await modifyUser(u.id, user => {
      user.orchestration = desired;
    });
    stamped++;
  }
  return stamped;
}

/**
 * Cascade for agent deletion: an account left pointing at a deleted primary
 * must not sit in a shape the read path degrades silently. Reverts the user
 * to ensemble (explicit write, not inference) and drops the dangling id.
 * Call sites: routes/agents.mjs DELETE cascade, next to the
 * skillAssignments cleanup.
 *
 * @returns {Promise<boolean>} true if the profile was modified
 */
export async function handleAgentDeleted(userId, agentId) {
  const u = userId ? getUser(userId) : null;
  if (!u?.orchestration || u.orchestration.primaryAgentId !== agentId) return false;
  await setOrchestrationPolicy(userId, { mode: 'ensemble', primaryAgentId: null });
  return true;
}
