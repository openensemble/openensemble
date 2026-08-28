/**
 * lib/agent-ref.mjs
 *
 * Collapse a *session* agent id down to the stable agent it belongs to.
 *
 * Agent ids reach skills and background machinery in several wrapped shapes:
 *   - scoped:      `<userId>_<agentId>`
 *   - deleg:       `ephemeral_deleg_d<depth>_<ts>_<rand>_<agentId>`
 *   - legacy deleg:`ephemeral_deleg_<ts>_<rand>_<agentId>`
 *   - router:      `ephemeral_router_<ts>_<rand>_<agentId>`   (chat-dispatch/llm-loop.mjs)
 *   - worker:      `ephemeral_worker_<ts>_<rand>_<ownerKey>`  (skills/delegate/execute.mjs)
 *   - workstream:  `ephemeral_workstream_<ts>_<rand>_<ownerKey>`
 *
 * `ephemeral_plan_<hex>` and `ephemeral_synth_<hex>` (deep_research) are
 * deliberately NOT in the list: they carry no agent suffix to recover, so they
 * fall through and key on themselves.
 *
 * All of them must resolve to the same key, so that per-agent state (e.g. the
 * coder skill's active project) is shared between a direct chat with an agent
 * and a Coordinator delegation that spins up an ephemeral session for it.
 *
 * Deliberately dependency-free: the coder skill imports this, and skills must
 * not drag the background-task/scheduler graph into their sandbox.
 */
export function stableAgentRef(userId, value) {
  let raw = String(value || '');
  const scopedPrefix = `${userId}_`;
  if (raw.startsWith(scopedPrefix)) raw = raw.slice(scopedPrefix.length);
  // One pattern for every wrapper that appends the owning agent last. The
  // optional `d<depth>_` group is the delegation-depth marker; everything else
  // is `<prefix>_<ts>_<rand>_<agentId>`, and the trailing capture is greedy so
  // agent ids containing underscores (`agent_b77774aa`) survive intact.
  const ephemeral = raw.match(
    /^ephemeral_(?:deleg|router|worker|workstream)_(?:d\d+_)?[^_]+_[^_]+_(.+)$/,
  );
  return ephemeral?.[1] || raw;
}
