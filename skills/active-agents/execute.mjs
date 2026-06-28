/**
 * active-agents — exposes background-tasks.mjs's getActiveTasks() registry
 * so the coordinator can answer "what is the coder doing?" / "is the email
 * agent still working?" / etc. without guessing.
 *
 * Only background ask_agent dispatches land in this registry (taskId prefix
 * "bg_…"). Synchronous ask_agent calls don't — those block the coordinator's
 * turn so the user already sees them inline.
 */

function fmtElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

export async function executeSkillTool(name, args, userId) {
  // Phase-14d: deep-dive on a single task_proxy watcher
  if (name === 'get_task_log') {
    const watcherId = args?.watcherId;
    if (!watcherId) return 'Missing watcherId. Call list_active_agents (or list_watches) first to find the id.';
    try {
      const { getWatcher } = await import('../../scheduler/watchers.mjs');
      const w = getWatcher(userId, watcherId);
      if (!w) return `No watcher found with id ${watcherId}.`;
      const lines = [];
      lines.push(`Task: ${w.label || w.kind} (${w.status})`);
      if (w.state?.targetAgentName) lines.push(`Agent: ${w.state.targetAgentEmoji || ''} ${w.state.targetAgentName}`);
      if (w.state?.rootTaskId) lines.push(`Root task: ${w.state.rootTaskId}`);
      if (w.state?.parentTaskId) lines.push(`Parent task: ${w.state.parentTaskId}`);
      if (w.state?.spanId) lines.push(`Span: ${w.state.spanId}`);
      if (Array.isArray(w.state?.childTasks) && w.state.childTasks.length) {
        lines.push('Child tasks:');
        for (const c of w.state.childTasks) {
          lines.push(`  - ${c.name || 'Agent'} [${c.taskId}]${c.watcherId ? ` watcher=${c.watcherId}` : ''} — ${c.status || 'running'}${c.currentTool ? `, running ${c.currentTool}` : ''}`);
        }
      }
      const elapsed = w.endedAt
        ? fmtElapsed(w.endedAt - (w.createdAt || w.endedAt))
        : fmtElapsed(Date.now() - (w.createdAt || Date.now()));
      lines.push(`Elapsed: ${elapsed}`);
      if (w.state?.awaiting_input && w.state?.pending_question) {
        lines.push(`⏳ Awaiting your reply: "${w.state.pending_question}"`);
      }
      if (w.lastStatusText) lines.push(`Last status: ${w.lastStatusText}`);
      const history = Array.isArray(w.history) ? w.history : [];
      if (history.length) {
        lines.push('');
        lines.push(`Progress (${history.length} event${history.length === 1 ? '' : 's'}):`);
        for (const h of history) {
          const t = String(h.text || '').replace(/\s+/g, ' ').slice(0, 160);
          const stamp = h.ts ? new Date(h.ts).toISOString().slice(11, 19) : '';
          lines.push(`  [${stamp}] ${t}`);
        }
      } else {
        lines.push('(no history yet)');
      }
      return lines.join('\n');
    } catch (e) {
      return `Error reading task log: ${e?.message || String(e)}`;
    }
  }

  if (name !== 'list_active_agents') return null;
  try {
    const { getActiveTasks } = await import('../../background-tasks.mjs');
    const all = getActiveTasks();
    // Filter to this user's tasks — getActiveTasks returns every user's;
    // we only want to expose this user's in-flight work to their coordinator.
    const mine = all.filter(t => t.userId === userId);
    if (!mine.length) return 'No background agents are running right now.';
    const now = Date.now();
    const lines = mine.map(t => {
      const elapsed = fmtElapsed(now - (t.startedAt || now));
      const taskLine = t.summary ? ` — task: "${t.summary}"` : '';
      // Tail status: prefer "currently running tool X" (live), fall back to
      // "last tool X completed" (just finished, before next call), then any
      // tool-result preview, then the task summary alone.
      let tail = '';
      if (t.currentTool) {
        tail = `\n   ↪ running tool: ${t.currentTool}`;
      } else if (t.toolsUsed) {
        const preview = t.lastResultPreview ? ` (last result: "${t.lastResultPreview.replace(/\s+/g, ' ').trim()}…")` : '';
        tail = `\n   ↪ ${t.toolsUsed} tool call${t.toolsUsed === 1 ? '' : 's'} so far${preview}`;
      }
      const ids = [];
      if (t.rootTaskId && t.rootTaskId !== t.taskId) ids.push(`root ${t.rootTaskId}`);
      if (t.watcherId) ids.push(`watcher ${t.watcherId}`);
      if (t.spanId) ids.push(`span ${t.spanId}`);
      const idLine = ids.length ? `\n   ids: ${ids.join(' · ')}` : '';
      const childLine = Array.isArray(t.childTasks) && t.childTasks.length
        ? `\n   children: ${t.childTasks.map(c => `${c.name || 'Agent'}=${c.status || 'running'}${c.currentTool ? `/${c.currentTool}` : ''}`).join(', ')}`
        : '';
      return `- ${t.agentEmoji || ''} ${t.agentName} (${t.taskId}) — ${elapsed} elapsed${taskLine}${idLine}${childLine}${tail}`;
    });
    return `${mine.length} background agent${mine.length === 1 ? '' : 's'} in flight:\n${lines.join('\n')}`;
  } catch (e) {
    return `Error reading active tasks: ${e?.message || String(e)}`;
  }
}

export default executeSkillTool;
