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
 * Entries are correlated to the root turn id when a turn trace is available,
 * so coordinator and delegated-specialist calls share one bucket without
 * mixing two concurrent turns from the same user. Direct legacy callers fall
 * back to a bounded per-user bucket.
 *
 * Unconditional + cheap (one array push per tool call); bounded + TTL'd so it
 * can't grow. Consumption is gated by the learner.
 */
const TTL_MS = 60_000;
const MAX_PER_TURN = 50;
const MAX_SCOPES = 1024;
const _byScope = new Map();   // `${userId}\0turn:${rootTurnId}` -> [{ tool, ts }]

function scopeKey(userId, turnCorrelationId = null) {
  const scope = typeof turnCorrelationId === 'string' && turnCorrelationId
    ? `turn:${turnCorrelationId}`
    : 'legacy';
  return `${userId}\0${scope}`;
}

export function recordToolExecution(userId, tool, turnCorrelationId = null) {
  if (!userId || !tool) return;
  const now = Date.now();
  const key = scopeKey(userId, turnCorrelationId);
  let arr = _byScope.get(key);
  if (!arr) { arr = []; _byScope.set(key, arr); }
  arr.push({ tool, ts: now });
  const cutoff = now - TTL_MS;
  while (arr.length && (arr[0].ts < cutoff || arr.length > MAX_PER_TURN)) arr.shift();
  if (_byScope.size > MAX_SCOPES) {
    for (const [scope, entries] of _byScope) {
      if (!entries.length || entries[entries.length - 1].ts < cutoff) _byScope.delete(scope);
    }
    // A burst can create more than MAX_SCOPES live buckets inside the TTL.
    // Enforce the bound even then; Map order gives deterministic oldest-scope
    // eviction, and losing learning telemetry is safer than unbounded memory.
    while (_byScope.size > MAX_SCOPES) {
      const oldestScope = _byScope.keys().next().value;
      if (oldestScope === undefined) break;
      _byScope.delete(oldestScope);
    }
  }
}

/**
 * Return the tool names executed for this user within the TTL window AND clear
 * them — so each post-turn capture sees only the tools from the turn that just
 * finished (LLM-path turns each run capture; local-path turns record nothing).
 */
export function consumeToolsFor(userId, turnCorrelationId = null) {
  if (!userId) return [];
  const key = scopeKey(userId, turnCorrelationId);
  const arr = _byScope.get(key);
  if (!arr || !arr.length) return [];
  const cutoff = Date.now() - TTL_MS;
  const tools = arr.filter(e => e.ts >= cutoff).map(e => e.tool);
  _byScope.delete(key);
  return tools;
}
