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

export async function executeSkillTool(name, _args, userId) {
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
      return `- ${t.agentEmoji || ''} ${t.agentName} (${t.taskId}) — ${elapsed} elapsed${taskLine}${tail}`;
    });
    return `${mine.length} background agent${mine.length === 1 ? '' : 's'} in flight:\n${lines.join('\n')}`;
  } catch (e) {
    return `Error reading active tasks: ${e?.message || String(e)}`;
  }
}

export default executeSkillTool;
