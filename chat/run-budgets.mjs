import { randomUUID } from 'node:crypto';
import { budgetContext, currentRunBudget, openBudgetRun, budgetSpan, finishBudgetSpan, reserveBudgetRequest,
  settleBudgetRequest, assertBudgetRunning, budgetErrorEvent, getBudgetRun, pauseBudgetRun, budgetIsActive } from '../lib/run-budgets.mjs';
import { currentProjectId, currentChatId, projectSessionKey } from '../lib/project-context.mjs';
import { currentTaskContext } from '../lib/task-proxy-context.mjs';
import { getTurn } from '../lib/turn-trace-context.mjs';
import { stableAgentRef } from '../lib/agent-ref.mjs';
import { activeTasks } from '../background-tasks/state.mjs';
import { changeCheckpoint } from '../background-tasks/checkpoints.mjs';
import { getSessionEpoch } from '../sessions.mjs';
import { getScheduledContext } from '../lib/scheduled-context.mjs';

export async function pauseBudgetTask(taskId, userId, reason, runId) {
  const rec = activeTasks.get(taskId);
  if (!rec || rec.userId !== userId) return;
  if (rec.checkpoint) changeCheckpoint(taskId, userId, cp => { cp.status = 'paused'; cp.reason = reason; cp.budgetRunId = runId; });
  rec.status = 'paused'; rec.phase = 'paused'; rec.currentTool = null;
  // The original generator has ended. Stop must retire this paused job rather
  // than abort an already-finished controller and leave its chip stuck.
  rec.abort = () => {
    if (rec.checkpoint?.budgetSpanId) finishBudgetSpan({ userId, runId, spanId: rec.checkpoint.budgetSpanId }, { status: 'cancelled' });
    void import('../background-tasks/dispatch.mjs').then(({ _onComplete }) => _onComplete(taskId, userId,
      rec.coordinatorAgentId || rec.visibleAgentId, rec.agentName, rec.agentEmoji, null, 'Job stopped by user.', 'cancelled'))
      .catch(error => console.error('[budget] stop finalization failed:', error.message));
  };
  const { pushWatcherStatus } = await import('../scheduler/watchers.mjs');
  pushWatcherStatus(userId, rec.watcherId, `Budget paused: ${reason}`, {
    taskId, phase: 'paused', status: 'paused', canCancel: true, budgetRunId: runId,
    recoveryAvailable: false, activity: 'Review this run in Run budgets to authorize more allowance.',
  });
}

// Bind every generator operation: creating a generator under ALS alone does
// not bind its later next()/return() calls or the delegates they start.
export async function* budgetChatStream(source, { agent, userText, userId, systemNote, silent, signal, turnOpts = {} }) {
  const inherited = currentRunBudget();
  const taskId = currentTaskContext()?.userId === userId ? currentTaskContext()?.taskId : null;
  const task = taskId && activeTasks.get(taskId);
  const root = inherited?.userId === userId ? inherited.runId
    : turnOpts.budgetRunId || task?.checkpoint?.budgetRunId || getTurn()?.rootId || turnOpts.rootTaskId || `budget_${randomUUID()}`;
  let context;
  try {
    context = openBudgetRun(userId, { runId: root, projectId: currentProjectId(userId), chatId: currentChatId(userId),
      agentId: stableAgentRef(userId, agent.id), title: userText });
  } catch (error) { yield budgetErrorEvent(error); return; }
  // Preserve the existing unlimited stream's errors and cancellation exactly.
  if (!context) { yield* source(); return; }
  try {
    const sessionKey = projectSessionKey(userId, stableAgentRef(userId, agent.id));
    context = budgetSpan(context, {
      agentId: stableAgentRef(userId, agent.id), sessionId: agent.id, task: String(userText || '').slice(0, 48000),
      note: String(systemNote || '').slice(0, 24000), provider: agent.provider, model: agent.model,
      reasoningEffort: agent.reasoningEffort, toolNames: (agent.tools || []).map(tool => tool.function?.name).filter(Boolean),
      projectId: currentProjectId(userId), chatId: currentChatId(userId), silent: silent === true,
      sessionKey, sessionEpoch: getSessionEpoch(sessionKey), taskId: taskId || null,
      scheduled: getScheduledContext() ? { ...getScheduledContext(), resourceLockConflicts: undefined } : null,
    }, turnOpts.budgetSpanId || null);
    if (task?.checkpoint) {
      changeCheckpoint(taskId, userId, cp => { cp.budgetRunId = context.runId; cp.budgetSpanId = context.spanId; });
      task.checkpoint.budgetRunId = context.runId; task.checkpoint.budgetSpanId = context.spanId;
    }
  } catch (error) { yield budgetErrorEvent(error); return; }
  let output = '', status = 'done', reason = '';
  const iterator = budgetContext.run(context, () => source()[Symbol.asyncIterator]());
  try {
    assertBudgetRunning(context);
    if (context.bounded && (agent.provider === 'fireworks' || agent.provider === 'grok' && /image|video|imagine/i.test(agent.model || ''))) {
      throw pauseBudgetRun(context, 'This media endpoint does not report token usage or a reservable price. Choose a metered text endpoint or explicitly remove the limits.');
    }
    while (true) {
      const step = await budgetContext.run(context, () => iterator.next());
      if (step.done) break;
      const event = step.value;
      if (event.type === 'token') output += event.text || '';
      if (event.type === 'replace' || event.type === '__content') output = String(event.text ?? event.content ?? '');
      if (event.type === 'error') { status = String(event.code || '').startsWith('RUN_BUDGET') ? 'paused' : 'error'; reason = event.message || ''; }
      if (event.type === '__content' || event.type === 'done') assertBudgetRunning(context);
      yield event;
    }
    if (getBudgetRun(userId, context.runId).status === 'paused' && status !== 'paused') {
      status = 'paused'; throw pauseBudgetRun(context, getBudgetRun(userId, context.runId).reason);
    }
  } catch (error) {
    status = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : String(error.code || '').startsWith('RUN_BUDGET') ? 'paused' : 'error'; reason = error.message;
    if (status === 'paused') yield budgetErrorEvent(error);
    else throw error;
  } finally {
    try { await budgetContext.run(context, () => iterator.return?.()); }
    finally { finishBudgetSpan(context, { status: signal?.aborted ? 'cancelled' : status, output, reason }); }
  }
}

export async function* budgetProviderStream(source) {
  const context = currentRunBudget();
  if (!context || !budgetIsActive()) { yield* source; return; }
  let reservation = null;
  let previous = { inputTokens: 0, outputTokens: 0 };
  const reconcile = event => {
    if (!reservation) return;
    const input = event.inputTokens + (event.provider === 'anthropic' ? (event.cachedTokens || 0) + (event.cacheCreatedTokens || 0) : 0);
    const usage = { inputTokens: input - previous.inputTokens, outputTokens: event.outputTokens - previous.outputTokens,
      complete: event.usageComplete, estimated: event.estimated };
    previous = { inputTokens: input, outputTokens: event.outputTokens };
    const id = reservation.id;
    reservation = null;
    settleBudgetRequest(context, id, usage);
  };
  try {
    for await (const event of source) {
      if (event.type === '__model_call') {
        if (reservation) reconcile({ inputTokens: NaN, outputTokens: NaN, usageComplete: false });
        const estimate = event.budgetEstimate;
        if (!estimate) throw pauseBudgetRun(context, 'This provider did not supply a request estimate. No request was authorized.');
        reservation = reserveBudgetRequest(context, estimate, { provider: event.provider, model: event.model, enforceable: estimate.enforceable });
        context.networkReservation = { id: reservation.id, attempts: 0 };
        yield { type: 'run_budget', runId: context.runId, estimated: true, estimate, run: getBudgetRun(context.userId, context.runId) };
      }
      if (event.type === '__budget_usage' || event.type === '__usage') {
        reconcile(event);
        if (event.type === '__budget_usage') continue;
      }
      if (event.type === 'error' && reservation) reconcile({ inputTokens: NaN, outputTokens: NaN, usageComplete: false });
      if (['tool_call', '__content', 'done'].includes(event.type)) assertBudgetRunning(context);
      yield event;
    }
  } catch (error) {
    if (reservation) {
      try { reconcile({ inputTokens: NaN, outputTokens: NaN, usageComplete: false }); }
      catch (paused) { error = paused; }
    }
    if (String(error.code || '').startsWith('RUN_BUDGET')) { yield budgetErrorEvent(error); return; }
    throw error;
  } finally {
    if (reservation) {
      try { reconcile({ inputTokens: NaN, outputTokens: NaN, usageComplete: false }); } catch { /* durable pause remains visible */ }
    }
  }
}
