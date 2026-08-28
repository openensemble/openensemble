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
export const RESERVED_AGENT_ID_PREFIXES = Object.freeze(['ephemeral_']);

/**
 * Durable ids must not occupy syntax used to wrap a session id. Otherwise a
 * perfectly ordinary durable agent can be mistaken for another agent when its
 * id happens to resemble an ephemeral wrapper or a user-scoped id.
 */
export function isReservedAgentId(userId, value) {
  const raw = String(value ?? '');
  if (!raw) return false;
  if (RESERVED_AGENT_ID_PREFIXES.some(prefix => raw.startsWith(prefix))) return true;
  return !!userId && raw.startsWith(`${userId}_`);
}

/** Return a user-facing validation result suitable for agent creation code. */
export function validateDurableAgentId(userId, value) {
  const id = String(value ?? '');
  if (!id) return { ok: false, error: 'Agent id is required.' };
  if (id.startsWith('ephemeral_')) {
    return { ok: false, error: 'Agent ids beginning with "ephemeral_" are reserved for temporary sessions.' };
  }
  if (userId && id.startsWith(`${userId}_`)) {
    return { ok: false, error: 'Agent id conflicts with the reserved user-scoped session namespace.' };
  }
  return { ok: true };
}

export function stableAgentRef(userId, value) {
  let raw = String(value || '');
  const scopedPrefix = `${userId}_`;
  // Worker/workstream owners can themselves be user-scoped or wrapped. Peel
  // the finite wrapper stack until the durable id is reached.
  for (let depth = 0; depth < 8; depth++) {
    if (raw.startsWith(scopedPrefix)) {
      raw = raw.slice(scopedPrefix.length);
      continue;
    }

    // Match only wrapper shapes OE actually emits. The prior `[^_]+` matcher
    // treated durable ids such as `ephemeral_worker_alpha_beta_frontend` as a
    // worker wrapper and silently re-keyed their state to `frontend`.
    const ephemeral = raw.match(
      /^ephemeral_deleg_d\d+_\d{10,}_[a-z0-9]{5,}_(.+)$/,
    ) || raw.match(
      /^ephemeral_(?:deleg|router|worker|workstream)_\d{10,}_[a-z0-9]{5,}_(.+)$/,
    );
    if (!ephemeral) break;
    raw = ephemeral[1];
  }
  return raw;
}
