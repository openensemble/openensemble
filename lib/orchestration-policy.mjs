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

import { getUser, modifyUser, loadUsers } from '../routes/_helpers.mjs';
import { listAgents } from '../agents.mjs';

export const ORCHESTRATION_MODES = ['ensemble', 'single'];

/**
 * Mode stamped onto accounts at creation time. Stage 3 of the integration
 * plan flips this single line to 'single' (gated on the full-plan's G5/G7
 * acceptance); everything else reads through it. Existing accounts are
 * always stamped 'ensemble' by stampOrchestrationDefaults regardless of
 * this value.
 */
export const NEW_ACCOUNT_DEFAULT_MODE = 'ensemble';

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
  const raw = (userId ? getUser(userId) : null)?.orchestration;
  const mode = ORCHESTRATION_MODES.includes(raw?.mode) ? raw.mode : 'ensemble';
  const primaryAgentId =
    typeof raw?.primaryAgentId === 'string' && raw.primaryAgentId ? raw.primaryAgentId : null;
  if (mode === 'single' && !primaryAgentId) return { mode: 'ensemble', primaryAgentId };
  return { mode, primaryAgentId };
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
export async function setOrchestrationPolicy(userId, { mode, primaryAgentId = null } = {}) {
  if (!ORCHESTRATION_MODES.includes(mode)) {
    throw new Error(`Unknown orchestration mode: ${JSON.stringify(mode)}. Valid: ${ORCHESTRATION_MODES.join(', ')}`);
  }
  if (!userId || !getUser(userId)) throw new Error(`Unknown user: ${userId}`);
  if (primaryAgentId != null) {
    const agent = listAgents().find(a => a.id === primaryAgentId);
    if (!agent || agent.ownerId !== userId) {
      throw new Error(`primaryAgentId ${primaryAgentId} is not an agent owned by ${userId}`);
    }
  }
  if (mode === 'single' && !primaryAgentId && !getOrchestrationPolicy(userId).primaryAgentId) {
    // No candidate stored from a previous stint in single mode either.
    throw new Error('single mode requires primaryAgentId');
  }
  await modifyUser(userId, u => {
    const kept = u.orchestration?.primaryAgentId;
    const primary = primaryAgentId ?? (typeof kept === 'string' && kept ? kept : null);
    u.orchestration = { mode, ...(primary ? { primaryAgentId: primary } : {}) };
  });
  return getOrchestrationPolicy(userId);
}

/**
 * Startup migration (D4): stamp an explicit `{ mode: 'ensemble' }` onto every
 * profile that has no valid orchestration mode, so no account's behavior ever
 * depends on field absence. Idempotent; returns how many profiles were
 * stamped. Always stamps 'ensemble' — NEW_ACCOUNT_DEFAULT_MODE is for
 * creation only and never rewrites history.
 */
export async function stampOrchestrationDefaults() {
  let stamped = 0;
  for (const u of loadUsers()) {
    if (ORCHESTRATION_MODES.includes(u?.orchestration?.mode)) continue;
    await modifyUser(u.id, user => {
      user.orchestration = { ...(user.orchestration ?? {}), mode: 'ensemble' };
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
  await modifyUser(userId, user => {
    user.orchestration = { mode: 'ensemble' };
  });
  return true;
}
