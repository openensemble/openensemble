/**
 * Agent delegation skill — lets a coordinator agent route tasks to specialist agents.
 * Uses dynamic imports to avoid circular dependency: chat.mjs → roles.mjs → here → chat.mjs
 */

export async function* executeSkillTool(name, args, userId = 'default', callerAgentId = null) {
  if (name !== 'ask_agent') { yield { type: 'result', text: null }; return; }

  const { agent_id, task: rawTask, no_confirm = false, _parallel = false } = args;
  let task = rawTask;
  if (!agent_id || !task) { yield { type: 'result', text: 'Missing agent_id or task.' }; return; }

  // Auto-default `background` to true for task-shaped delegations when the
  // LLM didn't pass an explicit value. Coordinators that ignore the SPA
  // recommendation still end up backgrounding skill-creation / refactor /
  // multi-step work. Sync remains the default ONLY for quick lookups
  // (single-tool-call shapes). Distinguish "explicit false" (honor) from
  // "undefined" (apply heuristic) by reading args.background directly.
  const LONG_TASK_RE = /\b(create|build|make|generate|refactor|rewrite|fix|update|modify|change|delete|remove|install|deploy|configure|setup|set up|investigate|debug|trace|run|execute|test|download|upload|patch|migrate|optimize|implement|write|edit|read|search|analyze|review)\b/i;
  let background;
  if (typeof args.background === 'boolean') {
    background = args.background;     // LLM was explicit — honor it
  } else {
    background = LONG_TASK_RE.test(rawTask);
    if (background) {
      console.log('[delegate] auto-background:true (task-shaped keyword match) for', agent_id);
    }
  }

  // Dynamic imports — by the time this executes, all modules are fully initialized
  const { streamChat } = await import('../../chat.mjs');
  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
  const { isAgentBusy, waitForAgentIdle, markAgentBusy } = await import('../../chat-dispatch.mjs');
  const { getScheduledNote } = await import('../../lib/scheduled-context.mjs');

  const agents = getAgentsForUser(userId);
  // Accept either the real id (agent_2dfdf5ca) or the display name.
  // Some models (notably gpt-5.x via the Codex backend) hallucinate names even
  // when the tool description lists real ids, so we fall back through several
  // normalizations before giving up:
  //   1. exact id match (agent_2dfdf5ca, slug ids like "mira")
  //   2. case-insensitive name match
  //   3. id ends with _<needle> (rare hand-typed id endings)
  //   4. needle stripped of an "agent_" prefix — the model often invents
  //      "agent_<name>" by extrapolating the hex pattern; strip and match by name
  let agent = agents.find(a => a.id === agent_id);
  if (!agent) {
    const raw = String(agent_id);
    const needle = raw.toLowerCase();
    agent = agents.find(a => a.name?.toLowerCase() === needle)
         ?? agents.find(a => a.id.toLowerCase().endsWith('_' + needle))
         // LLMs frequently pass the agent's ROLE (e.g. "coder" instead of
         // Ada's hex id). Accept that — there's usually one agent per role
         // on a given install, and if multiple exist we take the first
         // (matches the implicit "default agent for role" mental model).
         ?? agents.find(a => a.role?.toLowerCase() === needle)
         ?? agents.find(a => a.skillCategory?.toLowerCase() === needle);
    if (!agent && /^agent_[a-z0-9_]+$/i.test(raw)) {
      const stripped = raw.replace(/^agent_/i, '').toLowerCase();
      // Hex suffixes are 8 chars of [0-9a-f] — leave those to the exact-id
      // path above (already failed). Only retry when the stripped form looks
      // like a name (has at least one non-hex char, or is too long/short for
      // our 4-byte hex IDs).
      if (stripped && stripped.length !== 8 || /[g-z_]/.test(stripped)) {
        agent = agents.find(a => a.name?.toLowerCase() === stripped)
             ?? agents.find(a => a.id.toLowerCase() === stripped)
             ?? agents.find(a => a.role?.toLowerCase() === stripped);
      }
    }
  }
  if (!agent) { yield { type: 'result', text: `Agent '${agent_id}' not found or not available.` }; return; }

  // Every coordinator delegation is ephemeral: a fresh session per call with no
  // prior history loaded and nothing persisted back. Prevents cross-task context
  // bleed (e.g. stale file references from a completed delegation steering the
  // next run into a recon loop). Direct user↔agent WS chat bypasses this skill,
  // so that path keeps its persistent ${agent_id}.jsonl.
  const delegId = `ephemeral_deleg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${agent_id}`;
  const scopedAgent = { ...agent, id: delegId, ephemeral: true };

  // Seed the ephemeral session's tool-call cache + task embedding so the
  // dispatcher in roles.mjs:executeToolStreaming can short-circuit repeat
  // reads and embed-rank list-style results against this exact task.
  // No-op if delegId pattern doesn't match (guards inside).
  try {
    const { initSession } = await import('../../lib/ephemeral-tool-cache.mjs');
    initSession(delegId, task);
  } catch (_) { /* best-effort; absent module = no caching, no breakage */ }
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
  // Per-call no-confirm: the coordinator can pass no_confirm:true when the
  // user explicitly authorized the action in the triggering message
  // ("just send it", "no need to confirm"). Composes with scheduledNote
  // when both apply.
  const noConfirmNote = no_confirm
    ? `[DELEGATION OVERRIDE — NO CONFIRM] The coordinator has authorized this delegation as a direct send. The user's original message in the coordinator chat IS the confirmation. Do NOT show a draft, do NOT ask "are you sure?", do NOT wait for "send it" — call the action tool directly with reasonable defaults for anything unspecified, then report what you did. This overrides any "show draft and wait for approval" rule from your role's prompt for this single delegation only.`
    : null;
  const combinedNote = [scheduledNote, noConfirmNote].filter(Boolean).join('\n\n') || null;
  // Surface the specialist's prose into the coordinator's chat as a
  // live-streaming tool bubble (rendered by public/chat.js _ensureStreamBubble
  // via the tool_progress event). Without this, the user only sees the small
  // ask_agent pill in the coordinator's chat and has to either expand the
  // pill or switch to the specialist's chat tab to read the actual reply —
  // which defeats the whole point of delegating from the coordinator.
  // We label the stream with the specialist's name + emoji so a 3-way
  // parallel delegation (email + calendar + weather) shows three distinct
  // sub-streams instead of three identical "ask_agent" bubbles.
  const streamLabel = `${agentEmoji} ${agentName}`.trim();
  try {
    for await (const event of streamChat(scopedAgent, task, null, null, userId, null, combinedNote)) {
      if (event.type === 'token') {
        fullText += event.text;
        yield { type: 'tool_progress', name: 'ask_agent', text: event.text, sourceLabel: streamLabel };
      }
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
