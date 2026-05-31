// @ts-check
/**
 * proposeMonitor — high-level wrapper around registerWatcher() that skills
 * use to set up "ping me when X changes" loops without re-deriving the
 * cadence math, dedup logic, and onFire boilerplate on every call.
 *
 * Exposed to skill executors as `ctx.proposeMonitor(opts)` from roles.mjs
 * buildCtx. The intent is: when a user says "make a Publix BOGO skill" or
 * "ping me when there are new uploads from channel X", skill-builder
 * generates a skill whose primary tool just calls ctx.proposeMonitor with a
 * `kind` matching a handler in its own watcherHandlers export. No need to
 * read scheduler/watchers.mjs to learn the registerWatcher arg shape.
 *
 * Cadence presets — keeps the LLM out of "is it seconds or minutes" mistakes.
 * Skills that need a precise schedule (e.g. only Wednesday mornings) tick on
 * the preset cadence and no-op in the handler until the wall-clock condition
 * matches. That's cheaper than a cron primitive and reuses the existing
 * supervisor.
 */

const CADENCE_PRESETS = {
  minutely: 60,
  fast:     300,    // 5 min — fast-changing resources (prices, queue depth)
  hourly:   3600,
  daily:    86400,
  weekly:   604800,
};

function resolveCadence(cadence) {
  if (typeof cadence === 'number' && cadence >= 5) return cadence;
  if (cadence && typeof cadence === 'object' && typeof cadence.sec === 'number') return Math.max(5, cadence.sec);
  if (typeof cadence === 'string' && CADENCE_PRESETS[cadence]) return CADENCE_PRESETS[cadence];
  return CADENCE_PRESETS.hourly;
}

/**
 * @typedef {object} ProposeMonitorOpts
 * @property {string} kind                  Watcher kind — must match a key in
 *                                          the calling skill's watcherHandlers
 *                                          export, OR a built-in system kind
 *                                          (http_jsonpath / exec / file_stat /
 *                                          event_subscription).
 * @property {object} [state]               Opaque per-watcher state passed to
 *                                          the handler on every tick. Common
 *                                          shape: { url, channelId, query, … }.
 * @property {string|number|{sec:number}} [cadence='hourly']
 *                                          One of: 'minutely' | 'fast' | 'hourly'
 *                                          | 'daily' | 'weekly' | number-seconds
 *                                          | { sec: number }.
 * @property {string}  [label]              User-facing description shown in the
 *                                          tasks drawer. Defaults to the kind.
 * @property {number|null} [expiresAt=null] ms wall-clock or null for indefinite.
 *                                          Most "monitor X" intents are open-
 *                                          ended → null is the right default.
 * @property {'notify'|'agent'|'email'|'telegram'} [deliver='notify']
 *                                          'notify'   = quiet status bubble.
 *                                          'agent'    = inject [WATCHER FIRED]
 *                                          note and run an agent turn so the
 *                                          LLM can summarize / TTS the news.
 *                                          'email'    = send email FROM the
 *                                          user's primary account TO their
 *                                          own profile email. No LLM round-
 *                                          trip — use when the user says
 *                                          "email me when X" explicitly.
 *                                          'telegram' = send a Telegram
 *                                          message via the user's linked bot
 *                                          chat. No LLM round-trip — use when
 *                                          the user says "text me when X" /
 *                                          "send me a telegram when X".
 * @property {string}  [agentPrompt]        Prompt injected when deliver='agent'.
 *                                          Defaults to a generic summarization.
 * @property {string}  [emailSubject]       Subject line when deliver='email'.
 *                                          Defaults to "Monitor: <label>".
 * @property {string}  [emailTo]            Override recipient (defaults to
 *                                          the user's own profile email).
 * @property {string}  [emailAccount]       Connected-account label/id to send
 *                                          FROM. Defaults to the user's primary.
 * @property {string}  [telegramPrefix]     Optional leading line prepended to
 *                                          the body when deliver='telegram',
 *                                          e.g. an emoji + label header.
 * @property {string|null} [skillId=null]   Owning skill id — required when the
 *                                          kind resolves to a skill-defined
 *                                          handler (i.e. not a system kind).
 * @property {string}  [dedupKey]           When set, registration is a no-op
 *                                          if an active watcher already exists
 *                                          with the same (skillId, kind, dedupKey).
 *                                          Prevents N-monitors-for-the-same-thing
 *                                          when a "propose after N uses"
 *                                          heuristic fires repeatedly.
 */

/**
 * Build the proposeMonitor closure bound to the current (userId, agentId).
 * Called from roles.mjs buildCtx.
 *
 * @param {{userId: string, agentId: string|null}} bindings
 */
export function buildProposeMonitor({ userId, agentId }) {
  return async function proposeMonitor(/** @type {ProposeMonitorOpts} */ opts = /** @type {any} */ ({})) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('proposeMonitor: opts object required');
    }
    const {
      kind,
      state = {},
      cadence = 'hourly',
      label,
      expiresAt = null,
      deliver = 'notify',
      agentPrompt,
      emailSubject,
      emailTo,
      emailAccount,
      telegramPrefix,
      skillId = null,
      dedupKey,
    } = opts;

    if (!kind || typeof kind !== 'string') {
      throw new Error('proposeMonitor: kind (string) required');
    }
    if (!agentId) {
      throw new Error('proposeMonitor: no agentId in ctx — this helper must be called from inside a tool handler');
    }

    // Dedup: skip if an active watcher with the same (skillId, kind, dedupKey)
    // is already running. dedupKey is stored on state for fast lookup; the
    // skill is expected to pass a stable identity (channelId, sender domain, …).
    if (dedupKey) {
      try {
        const { listWatchers } = await import('../scheduler/watchers.mjs');
        const list = listWatchers(userId);
        const existing = (list?.active || []).find(w =>
          w.kind === kind &&
          (w.skillId || null) === (skillId || null) &&
          w?.state?.dedupKey === dedupKey
        );
        if (existing) return { watcherId: existing.id, deduped: true };
      } catch { /* listWatchers shouldn't throw, but never block registration on it */ }
    }

    let onFire;
    if (deliver === 'agent') {
      onFire = /** @type {{type: 'agent', prompt: string}} */ ({
        type: 'agent',
        prompt: agentPrompt ?? `A monitor you set up fired (${label || kind}). Summarize the new state for the user in one or two sentences.`,
      });
    } else if (deliver === 'email') {
      onFire = /** @type {any} */ ({
        type: 'email',
        subject: emailSubject || `Monitor: ${label || kind}`,
        to: emailTo,
        account: emailAccount,
      });
    } else if (deliver === 'telegram') {
      onFire = /** @type {any} */ ({
        type: 'telegram',
        prefix: telegramPrefix,
      });
    } else {
      onFire = /** @type {{type: 'notify'}} */ ({ type: 'notify' });
    }

    const cadenceSec = resolveCadence(cadence);
    const finalState = dedupKey ? { ...state, dedupKey } : state;

    const { registerWatcher } = await import('../scheduler/watchers.mjs');
    const watcherId = registerWatcher({
      userId,
      agentId,
      kind,
      state: finalState,
      cadenceSec,
      expiresAt: expiresAt ?? null,
      skillId: skillId || null,
      label: label || kind,
      onFire,
    });

    return { watcherId, deduped: false };
  };
}

/**
 * List the active monitors a skill has registered for this user. Skills use
 * this to render their own status panel without re-reading watchers.mjs.
 *
 * @param {string} userId
 * @param {string} skillId
 */
export async function listMonitorsForSkill(userId, skillId) {
  const { listWatchers } = await import('../scheduler/watchers.mjs');
  const list = listWatchers(userId);
  return (list?.active || []).filter(w => (w.skillId || null) === skillId);
}
