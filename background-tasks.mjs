/**
 * Background agent task dispatcher.
 * Fires ask_agent calls without blocking the coordinator's turn.
 * On completion, injects a notification into the coordinator's session
 * and sends a real-time WebSocket task_update event to the UI.
 */

let _broadcast = null;
export function setBackgroundBroadcastFn(fn) { _broadcast = fn; }

// in-flight task registry: taskId -> { agentId, userId, agentName, startedAt }
const activeTasks = new Map();

// Safety net: if a worker hangs forever (stuck upstream stream, etc.) the task
// would stay in activeTasks forever. Sweep every hour, reap anything older
// than 24h so /health + UI don't accumulate ghosts.
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [taskId, info] of activeTasks) {
    if (info.startedAt && (now - info.startedAt) > TASK_TTL_MS) {
      console.warn('[background-tasks] Reaping stale task:', taskId, 'agent:', info.agentName);
      activeTasks.delete(taskId);
      _broadcast?.({ type: 'task_update', taskId, agentName: info.agentName, status: 'error', content: 'Task timed out (>24h)' });
    }
  }
}, 60 * 60 * 1000).unref();

/**
 * Fire a background agent task. Returns a taskId immediately.
 * @param {object} scopedAgent - agent object with scoped id
 * @param {string} task - enriched task text
 * @param {string} userId
 * @param {string} coordinatorAgentId - scoped id of the coordinator
 * @param {string} agentName - display name for notifications
 * @param {string} agentEmoji - emoji icon (e.g. "📧")
 */
export function dispatchBackground(scopedAgent, task, userId, coordinatorAgentId, agentName, agentEmoji = '🤖') {
  const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  activeTasks.set(taskId, { agentId: scopedAgent.id, userId, agentName, startedAt: Date.now() });

  // Notify UI that the task has started (activity panel spinner)
  _broadcast?.({ type: 'task_update', taskId, agentName, agentEmoji, status: 'running', summary: task.slice(0, 80) });

  // Fire and forget — do not await
  (async () => {
    // Honor accessSchedule: a user whose curfew started mid-conversation cannot
    // launch new delegations. The coordinator will see the decline in its session.
    const { isUserTimeBlocked } = await import('./routes/_helpers.mjs');
    if (isUserTimeBlocked(userId)) {
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, null,
        'Access is restricted at this time — delegation refused.');
      return;
    }
    try {
      const { streamChat } = await import('./chat.mjs');
      const { getScheduledNote } = await import('./lib/scheduled-context.mjs');
      // ALS propagates through this detached IIFE because dispatchBackground
      // was called from within scheduledContext.run(...). null in non-scheduled chats.
      const scheduledNote = getScheduledNote();
      let fullText = '';
      for await (const ev of streamChat(scopedAgent, task, null, null, userId, null, scheduledNote)) {
        if (ev.type === 'token') fullText += ev.text;
        if (ev.type === 'error') throw new Error(ev.message);
      }
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, fullText.trim() || `${agentName} completed the task.`);
    } catch (err) {
      console.error('[background-tasks] error in task', taskId, err.message);
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, null, err.message);
    }
  })();

  return taskId;
}

async function _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, result, errorMsg = null) {
  activeTasks.delete(taskId);

  const status  = errorMsg ? 'error' : 'done';
  const content = errorMsg ?? result;

  // 1. Inject into coordinator's session so it has context on next user message
  try {
    const { appendToSession } = await import('./sessions.mjs');
    const notice = errorMsg
      ? `[${agentName} ran into a problem]\n${errorMsg}`
      : `[${agentName} replied]\n${result}`;
    await appendToSession(coordinatorAgentId, { role: 'assistant', content: notice, ts: Date.now() });
  } catch (e) {
    console.error('[background-tasks] failed to inject session notice:', e.message);
  }

  // 2. Activity panel: update row to done/error
  _broadcast?.({ type: 'task_update', taskId, agentName, agentEmoji, status, content });

  // 3. Agent report card: render directly in the user's current chat as a notification from the agent
  _broadcast?.({
    type:       'agent_report',
    agentName,
    agentEmoji,
    content,
    taskId,
    ts: Date.now(),
  });
}

export function getActiveTasks() {
  return [...activeTasks.entries()].map(([taskId, info]) => ({ taskId, ...info }));
}

/**
 * Run an ephemeral agent synchronously (awaitable) and return its final text.
 * Differs from dispatchBackground in that:
 *   - Returns a Promise resolving to the result string (not a taskId)
 *   - Does NOT inject a completion notice into any coordinator session
 *   - Does NOT append to the worker's session (ephemeral agents are stateless)
 * Used by deep_research_parallel to fan out research sub-queries.
 *
 * @param {object} agent - ephemeral agent object (must have ephemeral:true, id prefixed "ephemeral_")
 * @param {string} task - prompt for this worker
 * @param {string} userId
 * @param {object} [opts]
 * @param {(tokenText:string)=>void} [opts.onProgress] - per-token callback (for UI streaming)
 * @param {string} [opts.agentEmoji] - icon for task_update events (default 🔎)
 * @returns {Promise<string>} final concatenated text
 */
export async function dispatchEphemeral(agent, task, userId, opts = {}) {
  const taskId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = agent.name ?? 'Worker';
  const agentEmoji = opts.agentEmoji ?? '🔎';
  activeTasks.set(taskId, { agentId: agent.id, userId, agentName, startedAt: Date.now() });
  _broadcast?.({ type: 'task_update', taskId, agentName, agentEmoji, status: 'running', summary: task.slice(0, 80) });

  try {
    const { streamChat } = await import('./chat.mjs');
    let out = '';
    for await (const ev of streamChat(agent, task, null, null, userId)) {
      if (ev.type === 'token') {
        out += ev.text;
        opts.onProgress?.(ev.text);
      }
      if (ev.type === 'error') throw new Error(ev.message);
    }
    activeTasks.delete(taskId);
    _broadcast?.({ type: 'task_update', taskId, agentName, agentEmoji, status: 'done', content: out.slice(0, 200) });
    return out.trim();
  } catch (err) {
    activeTasks.delete(taskId);
    _broadcast?.({ type: 'task_update', taskId, agentName, agentEmoji, status: 'error', content: err.message });
    throw err;
  }
}
