// @ts-check
/**
 * Parent-side ctx broker for sandboxed custom skills (Phase 3).
 *
 * The sandboxed skill can't hold live OE objects, so its `ctx.*` calls arrive as
 * RPCs (see lib/skill-host.mjs). This module is the ONLY thing that services
 * them — a deliberately small ALLOWLIST. Sandboxed skills therefore get strictly
 * less than the in-process `ctx` (buildCtx): least privilege, by construction.
 *
 * Every handler runs with the (userId, agentId, skillId) the PARENT established
 * for this run — never a value the child asserts — so a skill can't act as
 * another user or reach another skill's data. Credentials are namespaced by
 * skillId, so one custom skill can't read another's secrets even within a user.
 */
import { buildSkillCredentials } from './credentials.mjs';

/**
 * @param {{ userId: string, agentId?: string|null, skillId: string,
 *           onEvent?: (ev: any) => void, audit?: (method: string, summary: any) => void }} opts
 */
export function makeCtxBroker({ userId, agentId = null, skillId, onEvent = () => {}, audit = () => {} }) {
  if (!userId || !skillId) throw new Error('makeCtxBroker: userId and skillId required');
  const creds = buildSkillCredentials(userId, skillId); // shared with in-process ctx

  /** @type {Record<string, (args: any[]) => Promise<any>>} */
  const handlers = {
    // ── diagnostics ──────────────────────────────────────────────────────────
    // A skill's structured log line. Surfaced to the live turn (so the owning
    // agent can read its skill's runtime) rather than buried.
    'log': async ([level, msg]) => {
      onEvent({ type: 'skill-log', level: String(level || 'info'), msg: String(msg ?? ''), skillId });
      return null;
    },

    // ── secrets (the RunPod case) ────────────────────────────────────────────
    // Namespaced per skill + encrypted with the user master key in THIS process;
    // the key/plaintext-at-rest never enters the sandbox.
    'credentials.set': async ([id, value, meta]) => {
      await creds.set(id, value, meta);
      audit('credentials.set', { id });
      return true;
    },
    'credentials.get': async ([id]) => {
      const v = await creds.get(id);
      audit('credentials.get', { id, found: v != null });
      return v; // raw value handed to the skill that owns it (v1 model)
    },
    'credentials.list': async () => creds.list(),
    'credentials.delete': async ([id]) => {
      const ok = await creds.delete(id);
      audit('credentials.delete', { id, deleted: ok });
      return ok;
    },

    // ── watchers / monitors ──────────────────────────────────────────────────
    // Registration args are serializable (onFire is a {type,prompt} object, not a
    // closure). userId/agentId/skillId are FORCED here so a child can't register
    // a watcher owned by another skill or user. unwatchMatching's predicate can't
    // cross IPC, so the host runs it child-side over the list this returns.
    'watch': async ([opts]) => {
      const { registerWatcher } = await import('../scheduler/watchers.mjs');
      const o = (opts && typeof opts === 'object') ? opts : {};
      const id = registerWatcher({ ...o, userId, agentId, skillId });
      audit('watch', { kind: o.kind, id });
      return id;
    },
    'proposeMonitor': async ([opts]) => {
      const { buildProposeMonitor } = await import('./monitor-helper.mjs');
      const o = (opts && typeof opts === 'object') ? opts : {};
      const res = await buildProposeMonitor({ userId, agentId })({ ...o, skillId });
      audit('proposeMonitor', { kind: o.kind, id: res?.watcherId, deduped: res?.deduped });
      return res;
    },
    // Only this skill's own watchers can be cancelled — verify ownership by id.
    'unwatch': async ([watcherId]) => {
      const { getWatcher, unregisterWatcher } = await import('../scheduler/watchers.mjs');
      const id = String(watcherId || '');
      const w = getWatcher(userId, id);
      if (!w || (w.skillId || null) !== skillId) return false;
      return unregisterWatcher(userId, id);
    },
    'watchers.list': async () => {
      const { listMonitorsForSkill } = await import('./monitor-helper.mjs');
      return listMonitorsForSkill(userId, skillId); // already scoped to this skill
    },
  };

  return {
    /** Method names a sandboxed skill is allowed to call (for the host's ctx shape). */
    methods: Object.keys(handlers),
    /**
     * Service one RPC. Throws on unknown/forbidden method or bad args; the caller
     * marshals that into an error rpc-result back to the child.
     * @param {string} method @param {any[]} args
     */
    async handle(method, args) {
      const h = handlers[method];
      if (!h) throw new Error(`ctx.${method} is not available to sandboxed custom skills`);
      return await h(Array.isArray(args) ? args : [args]);
    },
  };
}
