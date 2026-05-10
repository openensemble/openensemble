/**
 * Shared retry helper for non-interactive agent runs.
 *
 * Call sites that need identical-shaped retry logic:
 *   • scheduler.mjs runTask                 — scheduled tasks (cron / one-shot)
 *   • lib/proposals.mjs runAcceptedAgent    — friction-as-proposer accepts
 *   • scheduler/watchers.mjs executeOnFire  — watcher-fired agent runs (single
 *                                             attempt by default, but uses the
 *                                             same error/stall classification)
 *
 * Failure shapes both must handle:
 *   1. streamChat yields {type:'error', message} — provider returned an
 *      explicit error event mid-stream.
 *   2. streamChat throws — fetch failed at the network layer, AsyncIterator
 *      raised before yielding anything. Without try/catch around the
 *      for-await, this would bypass retries entirely.
 *
 * `err.cause` is captured for fetch/AggregateError so failure messages
 * include the underlying network reason (ENOTFOUND, ECONNREFUSED, TLS,
 * etc.) instead of bare "fetch failed".
 */
import { scheduledContext } from './scheduled-context.mjs';

const DEFAULTS = {
  maxAttempts: 3,
  retryDelayMs: 30_000,
  context: 'agent',
};

/**
 * @param {object} opts
 * @param {object} opts.scopedAgent     The agent record with id already scoped
 *                                      to `${userId}_${agentId}` for streaming.
 * @param {string} opts.userText        User-side prompt fed to streamChat.
 * @param {string} opts.systemNote      [SCHEDULED RUN] / [PROPOSAL ACCEPTED] /
 *                                      [WATCHER FIRED] — pinned to scheduledContext
 *                                      so nested ask_agent delegations inherit it.
 * @param {string} opts.userId
 * @param {Function} opts.streamChat    Imported by caller to avoid a circular import.
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.retryDelayMs=30000]
 * @param {string} [opts.context='agent']  Tag for log lines.
 * @returns {Promise<{ succeeded, assistantContent, lastError }>}
 */
export async function runAgentWithRetry(opts) {
  const {
    scopedAgent, userText, systemNote, userId, streamChat,
    maxAttempts = DEFAULTS.maxAttempts,
    retryDelayMs = DEFAULTS.retryDelayMs,
    context = DEFAULTS.context,
    silent = false,
  } = opts;

  let assistantContent = '';
  let lastError = null;

  const runAttempt = async (attempt) => {
    let failed = false;
    assistantContent = '';
    try {
      await scheduledContext.run({ scheduledNote: systemNote }, async () => {
        const ac = new AbortController();
        for await (const event of streamChat(scopedAgent, userText, ac.signal, null, userId, null, systemNote, silent)) {
          if (event.type === 'error') {
            lastError = event.message || 'unknown provider error';
            failed = true;
            break;
          }
          if (event.type === '__content') assistantContent = event.content;
        }
      });
    } catch (e) {
      const causeMsg = e?.cause?.message || (e?.cause?.code ? `${e.cause.code}` : null);
      lastError = causeMsg ? `${e.message}: ${causeMsg}` : (e?.message || String(e));
      failed = true;
    }
    // LoopGuard stalls (chat/compress.mjs) yield a "Stopped: <reason>." token
    // without ever emitting type:'error', so the loop above doesn't flag them.
    // Without this check, a watcher/scheduled run that loops the same tool 4x
    // returns succeeded=true with empty-ish content — the caller has no signal
    // anything went wrong, no retry happens, and the user sees nothing.
    if (!failed) {
      const trimmed = (assistantContent || '').trim();
      if (/^Stopped:\s/.test(trimmed) && trimmed.length < 200) {
        lastError = trimmed.replace(/\.$/, '');
        failed = true;
      }
    }
    if (!failed) return true;
    if (attempt < maxAttempts) {
      console.log(`[${context}] attempt ${attempt}/${maxAttempts} failed (${lastError}); retrying in ${retryDelayMs / 1000}s`);
      return new Promise(resolve => setTimeout(() => resolve(runAttempt(attempt + 1)), retryDelayMs));
    }
    return false;
  };

  const succeeded = await runAttempt(1);
  return { succeeded, assistantContent, lastError };
}
