// @ts-check
/**
 * Server-enforced agent-tool capability for outbound MCP turns.
 *
 * A `chat` PAT grants access to an agent, not to every tool assigned to that
 * agent.  Tools explicitly marked readOnly by a first-party manifest are the
 * default surface; additional exact tool names must be stored on the PAT.
 *
 * This policy uses its own AsyncLocalStorage instead of the turn context.  OE
 * replaces the turn context when it delegates or detaches a worker, while a
 * distinct store follows the entire async tree without each hop having to
 * remember to copy a security-critical field.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const policyStore = new AsyncLocalStorage();

// These tools only route or observe work. The leaf tools used by a delegated
// agent/worker still pass through the same policy gate. stop_worker is omitted:
// it can cancel work that was started outside this MCP request.
export const MCP_POLICY_CONTROL_TOOLS = new Set([
  'ask_agent',
  'spawn_worker',
  'check_workers',
  'report_progress',
  'request_tools',
]);

const MCP_POLICY_CONTROL_OWNERS = new Map([
  ['ask_agent', new Set(['delegate'])],
  ['spawn_worker', new Set(['delegate'])],
  ['check_workers', new Set(['delegate'])],
  ['report_progress', new Set(['delegate'])],
  ['request_tools', new Set(['coordinator'])],
]);

/**
 * @typedef {object} McpToolPolicy
 * @property {string|null} tokenId
 * @property {string} userId
 * @property {string|null} boundAgentId
 * @property {string[]} toolAllowlist
 */

/**
 * Run a complete external-agent async tree under one immutable policy.
 * @param {{tokenId?: string|null, userId: string, boundAgentId?: string|null, toolAllowlist?: string[]}} policy
 * @param {() => any} fn
 */
export function runWithMcpToolPolicy(policy, fn) {
  const normalized = Object.freeze({
    tokenId: policy?.tokenId ? String(policy.tokenId) : null,
    userId: String(policy?.userId || ''),
    boundAgentId: policy?.boundAgentId ? String(policy.boundAgentId) : null,
    toolAllowlist: Object.freeze([...new Set(
      Array.isArray(policy?.toolAllowlist) ? policy.toolAllowlist.map(String) : [],
    )]),
  });
  return policyStore.run(normalized, fn);
}

/** @returns {McpToolPolicy|null} */
export function getMcpToolPolicy() {
  return /** @type {McpToolPolicy|null} */ (policyStore.getStore() ?? null);
}

/**
 * Evaluate one resolved tool against the ambient (or supplied) PAT policy.
 * No ambient policy means an ordinary OE turn and preserves existing behavior.
 *
 * `ownerUserId` distinguishes bundled first-party manifests from user code.
 * A custom skill cannot self-assert readOnly and thereby widen every existing
 * PAT; its exact tool name must be granted explicitly.
 *
 * @param {{
 *   name: string,
 *   toolDef?: any,
 *   manifest?: any,
 *   ownerUserId?: string|null,
 *   policy?: McpToolPolicy|null,
 * }} input
 */
export function evaluateMcpToolAccess({
  name,
  toolDef = null,
  manifest = null,
  ownerUserId = null,
  policy = getMcpToolPolicy(),
}) {
  if (!policy) return { allowed: true, reason: 'ordinary-turn' };
  const cleanName = String(name || '');
  // A token bound to one agent cannot escape through that agent's internal
  // delegation or inspect account-wide worker state. Spawning a copy of the
  // same agent remains safe because every leaf tool inherits this policy.
  if (policy.boundAgentId && (cleanName === 'ask_agent' || cleanName === 'check_workers')) {
    return { allowed: false, reason: 'agent-binding' };
  }
  const trustedControlOwners = MCP_POLICY_CONTROL_OWNERS.get(cleanName);
  if (ownerUserId == null
    && manifest?.custom !== true
    && trustedControlOwners?.has(manifest?.id)) {
    return { allowed: true, reason: 'transitive-control' };
  }
  if (policy.toolAllowlist.includes(cleanName)) {
    return { allowed: true, reason: 'explicit-token-allowlist' };
  }
  const firstParty = ownerUserId == null && manifest?.custom !== true;
  if (firstParty && toolDef?.readOnly === true) {
    return { allowed: true, reason: 'first-party-read-only' };
  }
  return { allowed: false, reason: 'not-granted-by-token' };
}

/**
 * Remove unavailable schemas before a provider sees them. This improves model
 * behavior; evaluateMcpToolAccess at dispatch remains the authorization gate.
 * At this stage only the schema is available, so a custom tool that asserts
 * readOnly may remain visible. The dispatcher still rejects it unless its
 * owning manifest is first-party or its exact name is explicitly granted.
 *
 * @param {any[]} tools
 * @param {McpToolPolicy|null} [policy]
 */
export function filterToolsForMcpPolicy(tools, policy = getMcpToolPolicy()) {
  if (!policy || !Array.isArray(tools)) return tools;
  return tools.filter(tool => {
    const name = tool?.function?.name;
    if (!name) return false;
    if (policy.boundAgentId && (name === 'ask_agent' || name === 'check_workers')) return false;
    if (MCP_POLICY_CONTROL_TOOLS.has(name)) return true;
    if (policy.toolAllowlist.includes(name)) return true;
    return tool?.readOnly === true;
  });
}
