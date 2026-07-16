// @ts-check
/**
 * Memory contract for detached task-scoped workers.
 *
 * Workers inherit the owner's already permission-filtered persona, child
 * safety text, tool schemas, and standing per-skill role rules in their cloned
 * agent record. Cortex contributes only query-relevant standing context from
 * that same stable owner: params/rules, scoped user facts, and governed
 * confirmed global preferences/constraints. Episodes are always excluded.
 * chat.mjs separately keeps ordinary session history, trigger nudges,
 * cross-agent reads, and every memory write disabled for ephemeral workers.
 */

/**
 * Validate the only ephemeral shape allowed to request owner memory.
 * Requiring an explicit owner marker on the clone prevents a generic
 * ephemeral caller from using turnOpts as an owned-agent memory oracle.
 */
export function workerStandingMemoryOwner(agent, turnOpts = {}) {
  const requested = typeof turnOpts?.workerMemoryAgentId === 'string'
    ? turnOpts.workerMemoryAgentId.trim()
    : '';
  if (!requested || agent?.ephemeral !== true || turnOpts?.isolatedTaskRun !== true) return null;
  if (typeof agent?.workerOwnerId !== 'string' || agent.workerOwnerId !== requested) return null;
  return requested;
}

// A detached worker may perform the task's ordinary domain actions, but it may
// not rewrite the assistant/account that owns it or create more autonomous
// work. Keep this list explicit: these are OE control-plane writes, not a
// heuristic over names such as "create" or "delete" (which would also remove
// legitimate task tools like create_document or email_delete).
//
// Read-only counterparts intentionally remain available (recall_facts,
// skill_list_rules, list_roles, mcp_list_servers, profile_load, etc.), as do
// request_tools and report_progress. chat.mjs filters this set before routing,
// then filters both the routed and recoverable sets again.
const WORKER_LEAF_FORBIDDEN_TOOL_GROUPS = Object.freeze({
  delegation: Object.freeze([
    'spawn_worker',
    'ask_agent',
    'check_workers',
    'stop_worker',
  ]),
  standingMemoryAndRules: Object.freeze([
    'remember_fact',
    'forget_fact',
    'skill_add_rule',
    'skill_remove_rule',
    // Back-compat aliases accepted by the executor.
    'role_add_rule',
    'role_remove_rule',
    'teach_fastpath_phrase',
    'forget_fastpath_phrase',
    'create_routine',
    'delete_routine',
    'browser_site_notes_write',
    'browser_routine_create_from_teach',
    'browser_routine_delete',
  ]),
  accountAndRoster: Object.freeze([
    'set_orchestration_mode',
    'set_email_send_without_confirm',
    'manage_user',
    'claim_role',
    'create_agent',
    'create_role',
    'delete_role',
    'assign_role_to_agent',
  ]),
  skillTopology: Object.freeze([
    'skill_create',
    'skill_update_code',
    'skill_patch_code',
    'skill_update_tool_def',
    'skill_update_manifest',
    'skill_rollback',
    'skill_try_tool',
    'skill_delete',
    'skill_draft_start',
    'skill_draft_update',
    'skill_draft_build',
    'skill_draft_discard',
  ]),
  integrationTopology: Object.freeze([
    'mcp_add_server',
    'mcp_remove_server',
    'mcp_assign_server',
    'mcp_unassign_server',
    'mcp_refresh',
    'add_provider',
    'install_integration',
    'save_integration_recipe',
    'set_config_field',
    'restart_server',
    'revert_audit_entry',
    'oe_update_apply',
    'tunnel_configure',
    'tunnel_start',
    'tunnel_stop',
  ]),
  managedServiceTopology: Object.freeze([
    'profile_save',
    'profile_patch',
    'profile_set_trust_state',
    // Despite its name this persists per-operation verification flags.
    'profile_verify_readonly',
    'node_pair_code',
    'node_grant_permission',
    'node_set_parent_host',
    'node_set_readable_folders',
  ]),
  autonomousWorkTopology: Object.freeze([
    'schedule_task',
    'set_reminder',
    'set_alarm',
    'delete_task',
    'cancel_reminder',
    'create_watch',
    'update_watch',
    'cancel_watch',
    'update_watch_item',
    'remove_watch_item',
  ]),
});

export const WORKER_LEAF_FORBIDDEN_TOOL_NAMES = Object.freeze(
  [...new Set(Object.values(WORKER_LEAF_FORBIDDEN_TOOL_GROUPS).flat())],
);

const WORKER_LEAF_FORBIDDEN_TOOLS = new Set(WORKER_LEAF_FORBIDDEN_TOOL_NAMES);

/** Remove OE control-plane mutations from a validated worker's schema. */
export function filterWorkerLeafTools(tools, agent, turnOpts = {}) {
  if (!Array.isArray(tools) || !workerStandingMemoryOwner(agent, turnOpts)) return tools;
  return tools.filter(tool => !WORKER_LEAF_FORBIDDEN_TOOLS.has(tool?.function?.name));
}

/**
 * Resolve the stable owner under the current user's authorization projection,
 * then build context with episodes hard-disabled.
 */
export async function buildWorkerStandingMemoryContext({
  agent,
  turnOpts,
  userId,
  query,
  resolveOwnedAgent,
  buildContext,
}) {
  const ownerId = workerStandingMemoryOwner(agent, turnOpts);
  if (!ownerId || !userId || typeof resolveOwnedAgent !== 'function' || typeof buildContext !== 'function') {
    return null;
  }
  const owner = await resolveOwnedAgent(ownerId, userId);
  if (!owner || owner.id !== ownerId) return null;
  return buildContext(ownerId, query, userId, { includeEpisodes: false });
}
