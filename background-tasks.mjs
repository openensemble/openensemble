/**
 * Background agent task dispatcher.
 * Fires ask_agent calls without blocking the coordinator's turn.
 * Live progress surfaces via the task_proxy watcher chip in chat; on
 * completion a notification is injected into the coordinator's session
 * and an agent_report card is broadcast to the UI.
 */

import { registerWatcher, pushWatcherStatus, completeWatcher } from './scheduler/watchers.mjs';
import { runInTaskContext } from './lib/task-proxy-context.mjs';

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
  const summary = (task || '').slice(0, 120);
  activeTasks.set(taskId, { agentId: scopedAgent.id, userId, agentName, agentEmoji, startedAt: Date.now(), summary });

  // Phase 14: register a task_proxy watcher so the task surfaces as a chat
  // chip + becomes inspectable via list_watches. The watcher's history
  // accumulates progress events; on completion completeWatcher transitions
  // it to done/error. The activeTasks record gets the watcherId so progress
  // callbacks can update the same watcher.
  let watcherId = null;
  try {
    watcherId = registerWatcher({
      userId,
      agentId: coordinatorAgentId,   // chip lives in the coordinator's chat
      kind: 'task_proxy',
      label: `${agentEmoji} ${agentName}: ${summary.slice(0, 60)}${summary.length > 60 ? '…' : ''}`,
      state: {
        taskId,
        targetAgentId: scopedAgent.id,
        targetAgentName: agentName,
        targetAgentEmoji: agentEmoji,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      },
      cadenceSec: 30,
      expiresAt: null,   // indefinite — task runs as long as it takes
      // No skillId: system-handler (registered via _systemHandlers in watchers.mjs)
    });
    const rec = activeTasks.get(taskId);
    if (rec) rec.watcherId = watcherId;
    pushWatcherStatus(userId, watcherId, `Started: ${summary}`);
  } catch (e) {
    console.warn('[background-tasks] task_proxy watcher registration failed:', e.message);
  }

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
      let toolsUsed = 0;
      let currentTool = null;
      // Phase-14b: wrap the streamChat loop in a task_proxy context so
      // ask_user_via_task (called inside the agent's tool chain) can find
      // this run's watcherId without any extra parameter threading.
      const taskCtx = { taskId, watcherId, userId, agentId: scopedAgent.id };
      await runInTaskContext(taskCtx, async () => {
      for await (const ev of streamChat(scopedAgent, task, null, null, userId, null, scheduledNote)) {
        if (ev.type === 'token') fullText += ev.text;
        // Track in-flight tool calls so list_active_agents can report "Ada is
        // currently running coder_edit_file" instead of just an opaque spinner.
        if (ev.type === 'tool_call' && ev.name) {
          toolsUsed++;
          currentTool = ev.name;
          const rec = activeTasks.get(taskId);
          if (rec) {
            rec.toolsUsed = toolsUsed;
            rec.currentTool = ev.name;
            rec.lastUpdateAt = Date.now();
          }
          // Push to the watcher chip — the chip is the user-visible surface.
          // History accumulates each tool call so list_watches/get_task_log
          // can replay what happened.
          if (rec?.watcherId) {
            pushWatcherStatus(userId, rec.watcherId, `→ ${ev.name}`, { currentTool: ev.name, toolsUsed });
          }
        }
        if (ev.type === 'tool_result' && ev.name) {
          const rec = activeTasks.get(taskId);
          if (rec) {
            rec.currentTool = null;
            rec.lastResultPreview = (ev.text || '').slice(0, 80);
            rec.lastUpdateAt = Date.now();
          }
        }
        if (ev.type === 'error') throw new Error(ev.message);
      }
      });   // end runInTaskContext
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, fullText.trim() || `${agentName} completed the task.`);
    } catch (err) {
      console.error('[background-tasks] error in task', taskId, err.message);
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, null, err.message);
    }
  })();

  return taskId;
}

async function _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, result, errorMsg = null) {
  const rec = activeTasks.get(taskId);
  activeTasks.delete(taskId);

  // Phase 14: finalize the task_proxy watcher (chip) so it shows done/error
  // and slides into the "recent" pile. Lives independently of the activity-
  // panel broadcast below — the chip is the user's primary visible surface.
  if (rec?.watcherId) {
    try {
      const finalText = errorMsg
        ? `⚠ ${agentName} failed: ${errorMsg}`
        : `✓ ${agentName} done`;
      completeWatcher(userId, rec.watcherId, {
        status: errorMsg ? 'error' : 'done',
        finalText,
      });
    } catch (e) {
      console.warn('[background-tasks] watcher complete failed:', e.message);
    }
  }

  const content = errorMsg ?? result;

  // 1. Inject into coordinator's session so it has context on next user message.
  //    Include the original task summary so the user (and the LLM on its next
  //    turn) can see WHICH task Ada is replying to — important when multiple
  //    background tasks are in flight at once.
  try {
    const { appendToSession } = await import('./sessions.mjs');
    const taskSummary = rec?.summary || '';
    const taskRef = taskSummary
      ? ` — re: "${taskSummary.length > 80 ? taskSummary.slice(0, 80) + '…' : taskSummary}"`
      : '';
    const notice = errorMsg
      ? `[${agentName} ran into a problem${taskRef}]\n${errorMsg}`
      : `[${agentName} replied${taskRef}]\n${result}`;
    await appendToSession(coordinatorAgentId, { role: 'assistant', content: notice, ts: Date.now() });
  } catch (e) {
    console.error('[background-tasks] failed to inject session notice:', e.message);
  }

  // 2. Agent report card: render directly in the user's current chat as a notification from the agent
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
 * @param {string} [opts.agentEmoji] - icon (default 🔎)
 * @returns {Promise<string>} final concatenated text
 */
export async function dispatchEphemeral(agent, task, userId, opts = {}) {
  const taskId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = agent.name ?? 'Worker';
  const agentEmoji = opts.agentEmoji ?? '🔎';
  activeTasks.set(taskId, { agentId: agent.id, userId, agentName, startedAt: Date.now() });

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
    return out.trim();
  } catch (err) {
    activeTasks.delete(taskId);
    throw err;
  }
}
