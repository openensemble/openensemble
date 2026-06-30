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
import { storeCredential, getCredentialValue, listCredentials, deleteCredential } from './credentials.mjs';

// A child-supplied credential id must be a short, safe slug BEFORE we namespace
// it. Namespacing (`${skillId}__${id}`) then guarantees the lookup id always
// carries this skill's prefix — a child can't craft an id that escapes it.
const CRED_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;
function nsCredId(skillId, childId) {
  if (typeof childId !== 'string' || !CRED_ID_RE.test(childId)) {
    throw new Error(`invalid credential id "${childId}" (expected a short [a-z0-9_.-] slug)`);
  }
  return `${skillId}__${childId}`;
}

/**
 * @param {{ userId: string, agentId?: string|null, skillId: string,
 *           onEvent?: (ev: any) => void, audit?: (method: string, summary: any) => void }} opts
 */
export function makeCtxBroker({ userId, agentId = null, skillId, onEvent = () => {}, audit = () => {} }) {
  if (!userId || !skillId) throw new Error('makeCtxBroker: userId and skillId required');

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
      if (typeof value !== 'string' || !value.length) throw new Error('credentials.set: value must be a non-empty string');
      await storeCredential(userId, { id: nsCredId(skillId, id), label: String(id), kind: 'api_key', value, meta: (meta && typeof meta === 'object') ? meta : {} });
      audit('credentials.set', { id });
      return true;
    },
    'credentials.get': async ([id]) => {
      const v = getCredentialValue(userId, nsCredId(skillId, id));
      audit('credentials.get', { id, found: v != null });
      return v; // raw value handed to the skill that owns it (v1 model; brokered-call mode is a later option)
    },
    'credentials.list': async () => {
      const prefix = `${skillId}__`;
      return listCredentials(userId)
        .filter((c) => c.id.startsWith(prefix))
        .map((c) => ({ ...c, id: c.id.slice(prefix.length) }));
    },
    'credentials.delete': async ([id]) => {
      const ok = deleteCredential(userId, nsCredId(skillId, id));
      audit('credentials.delete', { id, deleted: ok });
      return ok;
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
