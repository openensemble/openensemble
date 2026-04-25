/**
 * Agent delegation skill — lets a coordinator agent route tasks to specialist agents.
 * Uses dynamic imports to avoid circular dependency: chat.mjs → roles.mjs → here → chat.mjs
 */

export async function* executeSkillTool(name, args, userId = 'default', callerAgentId = null) {
  if (name !== 'ask_agent') { yield { type: 'result', text: null }; return; }

  const { agent_id, task: rawTask, background = false, _parallel = false } = args;
  let task = rawTask;
  if (!agent_id || !task) { yield { type: 'result', text: 'Missing agent_id or task.' }; return; }

  // Dynamic imports — by the time this executes, all modules are fully initialized
  const { streamChat } = await import('../../chat.mjs');
  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
  const { isAgentBusy, waitForAgentIdle, markAgentBusy } = await import('../../chat-dispatch.mjs');
  const { getScheduledNote } = await import('../../lib/scheduled-context.mjs');

  const agents = getAgentsForUser(userId);
  // Accept either the real id (agent_2dfdf5ca) or the display name ("Ada").
  // Some models (notably gpt-5.x via the Codex backend) hallucinate names even
  // when the tool description lists real ids, so we fall back to a
  // case-insensitive name match before giving up.
  let agent = agents.find(a => a.id === agent_id);
  if (!agent) {
    const needle = String(agent_id).toLowerCase();
    agent = agents.find(a => a.name?.toLowerCase() === needle)
         ?? agents.find(a => a.id.toLowerCase().endsWith('_' + needle));
  }
  if (!agent) { yield { type: 'result', text: `Agent '${agent_id}' not found or not available.` }; return; }

  // Every coordinator delegation is ephemeral: a fresh session per call with no
  // prior history loaded and nothing persisted back. Prevents cross-task context
  // bleed (e.g. stale file references from a completed delegation steering the
  // next run into a recon loop). Direct user↔agent WS chat bypasses this skill,
  // so that path keeps its persistent ${agent_id}.jsonl.
  const delegId = `ephemeral_deleg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${agent_id}`;
  const scopedAgent = { ...agent, id: delegId, ephemeral: true };
  const agentName   = agent.name  ?? agent_id;
  const agentEmoji  = agent.emoji ?? '🤖';

  // Enrich system prompt with date context (mirrors server.mjs WS handler enrichment)
  // Without this, finance agents don't get date ranges and can't resolve "this month" etc.
  {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart  = `${now.getFullYear()}-01-01`;
    const financeExtra = (agent.skillCategory === 'finance' || agent.skillCategory === 'expenses')
      ? `\nUser ID: ${userId}\nAlways pass this exact User ID to every expense tool call.`
      : '';
    scopedAgent.systemPrompt = `${agent.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}${financeExtra}`;
  }

  // Expand any doc_XXXXXXXX references in the task so the target agent gets
  // the actual content — most specialist agents don't have get_research access.
  const docRefs = [...new Set(task.match(/\bdoc_[0-9a-f]{8}\b/g) ?? [])];
  if (docRefs.length) {
    try {
      const { readFileSync } = await import('fs');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');
      const researchDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research', userId);
      const indexPath = join(researchDir, 'index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      let enriched = task;
      for (const docId of docRefs) {
        const entry = index.find(d => d.id === docId);
        if (!entry) continue;
        const filePath = join(researchDir, entry.filename);
        const content = readFileSync(filePath, 'utf8');
        enriched = enriched.replace(
          new RegExp(`\\b${docId}\\b`, 'g'),
          `"${entry.title}" (content below)`
        );
        enriched += `\n\n---\n## ${entry.title}\n\n${content}`;
      }
      task = enriched;
    } catch { /* if doc lookup fails, proceed with original task */ }
  }

  // Background mode: fire and forget, return immediately.
  // Triggered either by explicit background:true from the model, or by _parallel:true injected
  // by chat.mjs when multiple ask_agent calls are detected in a single response.
  if (background || _parallel) {
    const { dispatchBackground } = await import('../../background-tasks.mjs');
    const taskId = dispatchBackground(scopedAgent, task, userId, callerAgentId ?? `${userId}_${agent_id}`, agentName, agentEmoji);
    yield { type: 'result', text: `Dispatching ${agentName} in background (task ${taskId}).` };
    return;
  }

  // Queue behind any in-flight run on the target agent. If busy, surface a
  // visible indicator so the user sees we're waiting instead of silently hanging.
  const scopedAgentId = `${userId}_${agent_id}`;
  let waitedMs = 0;
  if (isAgentBusy(scopedAgentId)) {
    const waitStart = Date.now();
    yield {
      type: 'tool_call',
      name: 'waiting_for_agent',
      args: { agent: agentName, reason: 'busy with prior task' },
    };
    await waitForAgentIdle(scopedAgentId);
    waitedMs = Date.now() - waitStart;
    yield {
      type: 'tool_result',
      name: 'waiting_for_agent',
      text: `${agentName} finished prior task after ${Math.round(waitedMs / 1000)}s — starting now.`,
      preview: `${agentName} ready (waited ${Math.round(waitedMs / 1000)}s)`,
    };
  }

  // Claim the busy slot so any subsequent delegate calls (or WS messages) see us.
  const slot = markAgentBusy(scopedAgentId);
  let fullText = '';
  let errText = null;
  // Inherit the [SCHEDULED RUN] note from the calling chain (set by
  // scheduler.runTask via AsyncLocalStorage). Without this, sub-agents
  // fall back to their default "show draft and wait" behavior, which
  // never resolves on a scheduled run since no human is there to answer.
  const scheduledNote = getScheduledNote();
  try {
    for await (const event of streamChat(scopedAgent, task, null, null, userId, null, scheduledNote)) {
      if (event.type === 'token') fullText += event.text;
      if (event.type === 'error') { errText = `Error from ${agent_id}: ${event.message}`; break; }
    }
  } finally {
    slot.release();
  }

  if (errText) { yield { type: 'result', text: errText }; return; }
  const waitNote = waitedMs > 1000
    ? `[Note: waited ${Math.round(waitedMs / 1000)}s for ${agentName} to finish a prior task before delegating.]\n\n`
    : '';
  yield { type: 'result', text: waitNote + (fullText.trim() || `No response from ${agent_id}.`) };
}

export default executeSkillTool;
