/**
 * Pure orchestration-policy normalization shared by the profile policy service,
 * role projection, and tests. This module deliberately has no filesystem or
 * registry imports so callers in roles.mjs do not create a dependency cycle.
 */

export const ORCHESTRATION_MODES = ['ensemble', 'single'];

/**
 * Normalize a stored orchestration record against the user's current owned
 * agents. A remembered primary is useful in ensemble mode (switch-back), but a
 * stale or foreign id is never effective. Single mode without a valid primary
 * conservatively behaves as ensemble.
 *
 * `pendingPrimary` is an internal onboarding marker: new accounts can request
 * single mode before their first agent exists. It never makes the effective
 * mode single; first-agent creation completes that transaction.
 *
 * @param {any} raw
 * @param {Array<{id?: string, ownerId?: string}>} ownedAgents
 * @returns {{mode:'ensemble'|'single', primaryAgentId:string|null}}
 */
export function normalizeOrchestrationPolicy(raw, ownedAgents = []) {
  const storedMode = ORCHESTRATION_MODES.includes(raw?.mode) ? raw.mode : 'ensemble';
  const candidate = typeof raw?.primaryAgentId === 'string' && raw.primaryAgentId
    ? raw.primaryAgentId
    : null;
  const validPrimary = candidate && ownedAgents.some(agent => agent?.id === candidate)
    ? candidate
    : null;

  if (storedMode === 'single' && !validPrimary) {
    return { mode: 'ensemble', primaryAgentId: null };
  }
  return { mode: storedMode, primaryAgentId: validPrimary };
}

/**
 * Read the requested (not necessarily effective) onboarding state. Missing or
 * malformed values are still ensemble. This is intentionally separate from
 * normalizeOrchestrationPolicy so no runtime caller mistakes a primary-less
 * pending account for an active single-agent account.
 */
export function normalizeRequestedOrchestration(raw) {
  const mode = ORCHESTRATION_MODES.includes(raw?.mode) ? raw.mode : 'ensemble';
  const primaryAgentId = typeof raw?.primaryAgentId === 'string' && raw.primaryAgentId
    ? raw.primaryAgentId
    : null;
  return {
    mode,
    primaryAgentId,
    pendingPrimary: mode === 'single' && raw?.pendingPrimary === true && !primaryAgentId,
  };
}
