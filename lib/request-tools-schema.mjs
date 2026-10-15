/**
 * Roster-aware request_tools schema policy.
 *
 * The coordinator manifest describes normal multi-agent OE behavior. A
 * singleton roster has no valid named agent to delegate to, so its effective
 * runtime schema replaces ask_agent guidance with task-scoped worker guidance.
 * Keep that transformation here so runtime resolution and lab attestation use
 * the same canonical definition.
 */

export const SINGLETON_REQUEST_TOOLS_DESCRIPTION = 'Expand your own tool surface mid-turn. Your initial list was trimmed, but the server retains your full permission-scoped surface. If a needed tool is absent, call request_tools and continue the task yourself. Use spawn_worker only when the user explicitly requests background or agent execution; a long task alone is not authorization. Scheduled tasks already run in the background and should complete directly unless their task explicitly requests workers. The cost is one extra model round-trip, so call only when the needed tool is missing.';

export function applyRequestToolsRosterPolicy(tool, { rosterSolo = false } = {}) {
  if (!rosterSolo || tool?.function?.name !== 'request_tools') return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      description: SINGLETON_REQUEST_TOOLS_DESCRIPTION,
    },
  };
}
