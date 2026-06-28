// @ts-check
/**
 * AsyncLocalStorage that records which service-role skills' tools ran during
 * the current turn, so a fact remembered in that turn can be scoped to the
 * skill that produced it — not to whichever agent happened to write it.
 *
 * Why: tools are already scoped to roles/skills. A fact discovered via the
 * `nodes` skill's tools (node_exec, node_list, …) belongs to the `nodes` role,
 * regardless of whether Chuck (the nodes agent) or the coordinator ran them.
 * The old auto-scope keyed off the *writer's* sole service role, which the
 * coordinator (10 roles) could never satisfy — so its facts always landed
 * unscoped (role_scope='') and leaked into every agent's prompt.
 *
 * Because recall filters user_facts by `role_scope IN (the recalling agent's
 * roles)`, scoping a fact to its role makes it follow the role across
 * reassignment for free: move `nodes` from Chuck to someone else and the
 * node facts move with it.
 *
 * Established once per turn at the head of streamChat() via enterWith (same
 * mechanism toolRouterContext uses, which is why it propagates through the
 * provider tool-loop down to executeToolStreaming). Reads are no-ops outside a
 * turn (direct/scheduled tool calls), so callers don't need to guard.
 */
import { AsyncLocalStorage } from 'async_hooks';

export const memoryScopeContext = new AsyncLocalStorage();

/** Start a fresh per-turn scope. Call at the top of streamChat(). */
export function beginMemoryScope() {
  memoryScopeContext.enterWith({ domainSkills: [] });
}

/**
 * Record that a service-role skill's tool ran this turn. Ordered + deduped;
 * the last entry is the most-recent domain action, which is the best guess for
 * what a subsequently-remembered fact is about. No-op outside a turn.
 */
export function recordDomainSkill(skillId) {
  const s = memoryScopeContext.getStore();
  if (!s || !skillId) return;
  if (!s.domainSkills.includes(skillId)) s.domainSkills.push(skillId);
}

/** Ordered list of service-role skills used this turn (empty outside a turn). */
export function getTurnDomainSkills() {
  return memoryScopeContext.getStore()?.domainSkills ?? [];
}
