// @ts-check
/**
 * Tiny in-memory log of recent skill-tool EXECUTIONS, so the Phase-3 intent
 * learner (lib/intent-learner.mjs) can see tools that ran inside a *delegated*
 * specialist turn. Those don't persist to the user's main session jsonl —
 * ask_agent runs the specialist in an ephemeral session whose tool calls aren't
 * readable post-turn — so session-readback misses them. This recorder is hooked
 * at the single chokepoint every provider-path tool call funnels through
 * (roles.mjs executeToolStreaming), which covers coordinator-direct AND
 * delegated-specialist calls — and records AFTER completion, only when the
 * normalized result is non-error, so a failed tool is never learned as a good
 * utterance→tool mapping. The LOCAL fastpath uses a different executor
 * (executeRoleTool), so a tool the local tier already handled is NOT recorded
 * here — meaning the recorder only ever holds "the LLM had to do it" successes,
 * which is exactly the miss signal the learner wants. Known limitation: entries
 * are keyed per-user (deliberate — an ephemeral specialist's agentId differs
 * from the coordinator's, so per-agent keys would orphan delegated tools),
 * which can cross-attribute tools between two concurrent turns of one user.
 *
 * Unconditional + cheap (one array push per tool call); bounded + TTL'd so it
 * can't grow. Consumption is gated by the learner.
 */
const TTL_MS = 60_000;
const MAX_PER_USER = 50;
const MAX_USERS = 256;
const _byUser = new Map();   // userId -> [{ tool, ts }]

export function recordToolExecution(userId, tool) {
  if (!userId || !tool) return;
  const now = Date.now();
  let arr = _byUser.get(userId);
  if (!arr) { arr = []; _byUser.set(userId, arr); }
  arr.push({ tool, ts: now });
  const cutoff = now - TTL_MS;
  while (arr.length && (arr[0].ts < cutoff || arr.length > MAX_PER_USER)) arr.shift();
  if (_byUser.size > MAX_USERS) {
    for (const [u, a] of _byUser) if (!a.length || a[a.length - 1].ts < cutoff) _byUser.delete(u);
  }
}

/**
 * Return the tool names executed for this user within the TTL window AND clear
 * them — so each post-turn capture sees only the tools from the turn that just
 * finished (LLM-path turns each run capture; local-path turns record nothing).
 */
export function consumeToolsFor(userId) {
  if (!userId) return [];
  const arr = _byUser.get(userId);
  if (!arr || !arr.length) return [];
  const cutoff = Date.now() - TTL_MS;
  const tools = arr.filter(e => e.ts >= cutoff).map(e => e.tool);
  _byUser.delete(userId);
  return tools;
}
