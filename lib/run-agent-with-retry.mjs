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
import { matchToolPlan } from './tool-plan-memory.mjs';
import { runInTaskContext } from './task-proxy-context.mjs';
import { iterateUntilAbort } from './abortable-async-iterator.mjs';
import { getTurnContext, runWithTurnContext } from './turn-abort-context.mjs';

const DEFAULTS = {
  maxAttempts: 3,
  retryDelayMs: 30_000,
  context: 'agent',
};

// Abort a stream that makes NO progress (no events at all) for this long — the
// AbortController used to be created and never fired, so a hung provider stream
// would block a scheduled task forever. Generous so it never trips legit slow
// tools (which emit tool_progress events that reset the watchdog).
const STALL_MS = 300_000;
// Clearly-permanent failures — retrying maxAttempts × retryDelayMs changes
// nothing, so fail fast. Everything else is treated as transient and retried.
const NON_RETRIABLE_RE = /\b(api key|not set|not configured|no .{0,14}key|unauthorized|forbidden|invalid (?:model|api|key)|401|403)\b/i;

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
 * @param {string|null} [opts.rootTaskId] Stable identity for this detached
 *                                      logical run. Reused across retries so
 *                                      durable side-effect guards see every
 *                                      attempt as the same authorization.
 * @param {string|null} [opts.traceSource] Trace source for detached runs.
 * @param {boolean} [opts.originTaskManual=false] Whether this scheduled fire
 *                                      was an out-of-band Run-now invocation.
 * @param {object|null} [opts.taskContext] Durable owner for unattended runs
 *                                      that must await their real tool results.
 *                                      Scheduled mains deliberately omit this:
 *                                      their child barrier owns generic auto-bg.
 * @returns {Promise<{ succeeded, assistantContent, lastError }>}
 */
export async function runAgentWithRetry(opts) {
  const {
    scopedAgent, userText, systemNote, userId, streamChat,
    maxAttempts = DEFAULTS.maxAttempts,
    retryDelayMs = DEFAULTS.retryDelayMs,
    context = DEFAULTS.context,
    silent = false,
    isolatedTaskRun = true,
    originTaskId = null,
    originTaskOwnerId = null,
    originTaskAgent = null,
    originTaskRunId = null,
    originTaskManual = false,
    rootTaskId = originTaskRunId || originTaskId || null,
    traceSource = originTaskId ? 'scheduled' : null,
    taskContext = null,
  } = opts;

  const ownedTaskContext = taskContext && typeof taskContext === 'object'
    ? {
        ...taskContext,
        userId: taskContext.userId || userId,
        agentId: taskContext.agentId || scopedAgent.id,
        rootTaskId: taskContext.rootTaskId || rootTaskId || taskContext.taskId,
      }
    : null;

  let assistantContent = '';
  let lastError = null;

  const runAttempt = async (attempt) => {
    let failed = false;
    let toolInvoked = false;
    assistantContent = '';
    try {
      await scheduledContext.run({
        scheduledNote: systemNote,
        originTaskId,
        originTaskOwnerId,
        originTaskAgent,
        runId: originTaskRunId,
        manual: originTaskManual === true,
        silent: silent === true,
      }, async () => {
        const ac = new AbortController();
        // Stall watchdog: abort a stream that goes silent for STALL_MS. Reset on
        // every event so legit slow tools (which emit tool_progress) never trip it.
        let stallTimer = null;
        const armStall = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            try { ac.abort(new Error(`Agent stream made no progress for ${STALL_MS / 1000}s`)); }
            catch { /* already terminal */ }
          }, STALL_MS);
        };
        const rememberedPlan = matchToolPlan(userId, { agentId: scopedAgent.id, phrase: userText });
        try {
          armStall();
          const consumeAttempt = async () => {
            for await (const event of iterateUntilAbort(streamChat(scopedAgent, userText, ac.signal, null, userId, null, systemNote, silent, null, {
              toolPlan: rememberedPlan,
              isolatedTaskRun,
              ...(rootTaskId ? { rootTaskId, traceSource: traceSource || context } : {}),
            }), ac.signal, 'Agent stream aborted')) {
              armStall();
              // A tool call means a side effect may have executed this attempt — we
              // must NOT retry the whole turn after that, or it fires twice.
              if (event.type === 'tool_call') toolInvoked = true;
              if (event.type === 'error') {
                lastError = event.message || 'unknown provider error';
                failed = true;
                break;
              }
              if (event.type === '__content') assistantContent = event.content;
            }
          };
          const inheritedTurnContext = getTurnContext() || {};
          await runWithTurnContext({ ...inheritedTurnContext, signal: ac.signal }, async () => {
            if (ownedTaskContext) await runInTaskContext(ownedTaskContext, consumeAttempt);
            else await consumeAttempt();
          });
        } finally {
          clearTimeout(stallTimer);
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
    // Only retry a transient failure where NO tool executed this attempt:
    // re-running the whole turn would re-fire any side-effecting tool
    // (email_send, an HA call, a purchase). Permanent errors fail fast.
    const permanent = NON_RETRIABLE_RE.test(lastError || '');
    if (!toolInvoked && !permanent && attempt < maxAttempts) {
      console.log(`[${context}] attempt ${attempt}/${maxAttempts} failed (${lastError}); retrying in ${retryDelayMs / 1000}s`);
      return new Promise(resolve => setTimeout(() => resolve(runAttempt(attempt + 1)), retryDelayMs));
    }
    if (attempt < maxAttempts) {
      console.log(`[${context}] attempt ${attempt} failed (${lastError}); not retrying — ${toolInvoked ? 'a tool already ran (avoid double-execution)' : 'non-transient error'}`);
    }
    return false;
  };

  const succeeded = await runAttempt(1);
  return { succeeded, assistantContent, lastError };
}
