/**
 * Agent delegation skill — lets a coordinator agent route tasks to specialist agents.
 * Uses dynamic imports to avoid circular dependency: chat.mjs → roles.mjs → here → chat.mjs
 */

// Max nested delegation depth. user→A→coordinator→B = 2 hops, which is
// the deepest useful chain (specialist escalates to coordinator who then
// re-dispatches). Anything deeper is almost certainly a loop or the LLM
// getting confused — reject with a clear error so the chain unwinds.
const MAX_DELEGATION_DEPTH = 2;

// Parse an ephemeral session id like `ephemeral_deleg_d2_<ts>_<rand>_<suffix>`
// (or the legacy `ephemeral_deleg_<ts>_<rand>_<suffix>` which we treat as
// depth 1). Returns { effectiveAgentId, depth }. The suffix is the agent
// that the previous delegate call targeted — i.e. the agent currently
// running this ephemeral session. For a non-ephemeral caller, depth = 0.
//
// Direct WS chats arrive with a `${userId}_${agentId}` prefix applied by
// chat-dispatch.mjs:290 for session isolation (so two users chatting with
// the same-named agent don't share state). Strip that prefix so the agent
// lookup below finds the raw agent record by its real id.
function _parseCallerSession(callerAgentId) {
  if (!callerAgentId) return { effectiveAgentId: null, depth: 0 };
  // New format with explicit depth marker.
  let m = String(callerAgentId).match(/^ephemeral_deleg_d(\d+)_\d+_[a-z0-9]+_(.+)$/);
  if (m) return { effectiveAgentId: m[2], depth: parseInt(m[1], 10) };
  // Legacy format (no depth marker) — treat as depth 1.
  m = String(callerAgentId).match(/^ephemeral_deleg_\d+_[a-z0-9]+_(.+)$/);
  if (m) return { effectiveAgentId: m[1], depth: 1 };
  // Direct (non-ephemeral) caller — may carry a `user_<id>_` prefix from
  // chat-dispatch's per-user session-key wrapper. Strip it so the agents
  // lookup finds the bare agent id.
  m = String(callerAgentId).match(/^user_[a-z0-9]+_(.+)$/);
  if (m) return { effectiveAgentId: m[1], depth: 0 };
  return { effectiveAgentId: callerAgentId, depth: 0 };
}

// ── Agent-owned background workers (manager/employee model) ──────────────────
// spawn_worker / check_workers / stop_worker ride on this skill, so EVERY agent
// gets them. A worker is a background clone of the spawning agent (same role +
// tools), owned by that agent's STABLE id — so the owner can watch and report on
// it from its own direct chat OR from an ephemeral delegation (the coordinator
// asking "how's your work going"). Workers are LEAVES: they cannot hire workers.
const MAX_WORKERS_PER_AGENT = 5;

async function* _workerTool(name, args, userId, callerAgentId) {
  const bg = await import('../../background-tasks.mjs');
  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
  // The owner is the STABLE agent behind whatever session is calling — strip the
  // ephemeral/direct-chat wrapper so every incarnation resolves the same workers.
  const { effectiveAgentId: ownerKey } = _parseCallerSession(callerAgentId);

  // A worker posting its own milestone note ("Batch 3 done: 200 labeled, ~600
  // left"). It finds its own task via the task_proxy ALS context that
  // spawnWorker established around the run — no id threading needed.
  if (name === 'report_progress') {
    const note = args.note || args.text || args.message;
    if (!note) { yield { type: 'result', text: 'Missing note — describe what just happened (e.g. "200 labeled, ~600 left").' }; return; }
    let tc = null;
    try { const m = await import('../../lib/task-proxy-context.mjs'); tc = m.currentTaskContext?.(); } catch { /* not in a worker */ }
    if (tc?.taskId && bg.recordWorkerProgress(tc.taskId, note)) {
      yield { type: 'result', text: `Progress recorded: ${String(note).slice(0, 100)}` };
    } else {
      yield { type: 'result', text: 'Noted, but you are not running as a background worker so there is nothing to attach this to.' };
    }
    return;
  }

  if (name === 'check_workers') {
    const workers = bg.listWorkersForOwner(userId, ownerKey);
    const recent = bg.listRecentWorkersForOwner(userId, ownerKey);
    if (!workers.length && !recent.length) {
      yield { type: 'result', text: 'You have no background workers — none running, and none finished recently.' };
      return;
    }
    const ago = s => s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
    const out = [];
    if (workers.length) {
      out.push(`Running (${workers.length}):`);
      for (const w of workers) {
        const head = w.stalled
          ? `⚠ STALLED — no activity for ${ago(w.idleSec)} (was running ${w.currentTool || 'nothing'})`
          : (w.currentTool ? `running ${w.currentTool}` : 'between steps');
        out.push(`• ${w.name} [${w.taskId}] — ${head}; ${w.toolsUsed} tool calls, ${ago(w.elapsedSec)} elapsed. Job: ${w.summary}`);
        const log = (w.progress || []).map(p =>
          p.kind === 'note' ? `    • ${p.text}`
          : p.kind === 'result' ? `    ↳ ${p.tool}: ${p.text}`
          : `    → ${p.tool}`);
        if (log.length) out.push(log.join('\n'));
      }
    }
    if (recent.length) {
      out.push(`Recently finished:`);
      for (const r of recent.slice(0, 5)) {
        const mark = r.outcome === 'done' ? '✓' : (r.outcome === 'stopped' ? '■' : '⚠');
        const verb = r.outcome === 'done' ? 'finished' : (r.outcome === 'stopped' ? 'was stopped' : 'FAILED');
        out.push(`${mark} ${r.name} [${r.taskId}] ${verb} ${ago(r.endedAgoSec)} ago (${r.toolsUsed} tool calls) — ${r.finalText || r.summary}`);
      }
    }
    yield { type: 'result', text: out.join('\n') };
    return;
  }

  if (name === 'stop_worker') {
    const id = args.worker_id;
    if (!id) { yield { type: 'result', text: 'Missing worker_id (get it from check_workers).' }; return; }
    const r = bg.stopWorker(userId, id, ownerKey);
    yield { type: 'result', text: r.ok ? `Stopping ${r.name} (${id}).` : `Couldn't stop ${id}: ${r.reason}.` };
    return;
  }

  // name === 'spawn_worker' — leaf rule: a worker can't hire workers.
  if (String(callerAgentId || '').startsWith('ephemeral_worker_')) {
    yield { type: 'result', text: 'Workers are individual contributors and cannot hire their own workers. Do the job directly, then report back to whoever assigned it.' };
    return;
  }
  const task = args.task;
  if (!task) { yield { type: 'result', text: 'Missing task — describe the complete job for the worker.' }; return; }

  const agents = getAgentsForUser(userId);
  const ownerAgent = agents.find(a => a.id === ownerKey);
  if (!ownerAgent) { yield { type: 'result', text: `Couldn't resolve your own agent record (${ownerKey}) to staff a worker.` }; return; }

  const running = bg.listWorkersForOwner(userId, ownerKey).length;
  if (running >= MAX_WORKERS_PER_AGENT) {
    yield { type: 'result', text: `You already have ${running} workers running (max ${MAX_WORKERS_PER_AGENT}). Wait for one to finish or stop one with stop_worker before hiring another.` };
    return;
  }

  const label = args.label || (task.length > 56 ? task.slice(0, 56) + '…' : task);
  const workerId = `ephemeral_worker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${ownerKey}`;
  const workerAgent = { ...ownerAgent, id: workerId, ephemeral: true };
  // No human is watching the worker's session — make it run to completion on its
  // own and finish with a concise report.
  const workerTask = `${task}\n\n[You are a background worker running detached from the chat. Work autonomously to completion — do NOT ask for confirmation or wait for approval; the user is not watching this session. Use your tools directly. When finished, reply with a short summary of what you did and anything that needs a human.]`;
  const chipOwnerId = `${userId}_${ownerKey}`;   // owner's direct-chat session: chip + completion report land here

  const tid = bg.spawnWorker({
    workerAgent, task: workerTask, userId, chipOwnerId, ownerKey,
    workerName: `${ownerAgent.name} worker`, emoji: ownerAgent.emoji || '🤖',
  });
  yield { type: 'result', text: `Hired a background worker (${tid}) on: ${label}. It's running now — I can check on it anytime with check_workers, and its report will land here when it's done.` };
}

export async function* executeSkillTool(name, args, userId = 'default', callerAgentId = null) {
  if (name === 'spawn_worker' || name === 'check_workers' || name === 'stop_worker' || name === 'report_progress') {
    yield* _workerTool(name, args, userId, callerAgentId);
    return;
  }
  if (name !== 'ask_agent') { yield { type: 'result', text: null }; return; }

  const { agent_id, task: rawTask, no_confirm = false, _parallel = false } = args;
  let task = rawTask;
  if (!agent_id || !task) { yield { type: 'result', text: 'Missing agent_id or task.' }; return; }

  // Sync-vs-background is decided below, AFTER the delegation direction is known
  // (see "Decide sync vs background"). Auto-backgrounding applies only when the
  // coordinator dispatches DOWN to a specialist — never when a specialist
  // escalates UP — so a user waiting in a specialist's chat watches the
  // escalation stream live instead of going dark.

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
  //   1. exact id match (agent_<hex>, or a slug id like "coder")
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
         // the coder agent's hex id). Accept that — there's usually one agent per role
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

  // ── Delegation-chain enforcement ───────────────────────────────────────
  // Two rules:
  //   1. Specialists may ONLY escalate to the coordinator. They cannot
  //      sidestep the hierarchy by calling each other directly.
  //   2. Max chain depth is MAX_DELEGATION_DEPTH (=2). Beyond that we're
  //      either in a loop or the LLM is getting confused.
  const { effectiveAgentId: callerEffectiveId, depth: currentDepth } = _parseCallerSession(callerAgentId);
  const callerAgent = callerEffectiveId
    ? agents.find(a => a.id === callerEffectiveId)
    : null;
  const callerIsCoordinator = callerAgent?.skillCategory === 'coordinator';
  if (!callerIsCoordinator && agent.skillCategory !== 'coordinator') {
    yield {
      type: 'result',
      text: `Specialists may only escalate to the coordinator (use agent_id="coordinator"). Direct specialist-to-specialist delegation is not allowed — ask the coordinator to route this.`,
    };
    return;
  }
  if (currentDepth >= MAX_DELEGATION_DEPTH) {
    yield {
      type: 'result',
      text: `Delegation chain is already ${currentDepth} hops deep (max ${MAX_DELEGATION_DEPTH}). Cannot delegate further from here — respond to the caller with what you have.`,
    };
    return;
  }
  const newDepth = currentDepth + 1;

  // ── Decide sync vs background ──────────────────────────────────────────
  // Auto-backgrounding (the task-shaped keyword heuristic) applies ONLY when the
  // COORDINATOR is dispatching DOWN to a specialist — the case where a long task
  // should detach and report back later. When a SPECIALIST escalates UP to the
  // coordinator, the user is sitting in that specialist's chat waiting on the
  // answer, so we stream the coordinator's reply live (sync) instead of going
  // dark. Explicit background:true from the model is honored; _parallel
  // (several delegations in one response) still backgrounds at the dispatch check
  // below, since multiple live streams can't share one chat.
  const LONG_TASK_RE = /\b(create|build|make|generate|refactor|rewrite|fix|update|modify|change|delete|remove|install|deploy|configure|setup|set up|investigate|debug|trace|run|execute|test|download|upload|patch|migrate|optimize|implement|write|edit|read|search|analyze|review)\b/i;
  let background;
  if (typeof args.background === 'boolean') {
    background = args.background;                  // LLM was explicit — honor it
  } else if (callerIsCoordinator) {
    background = LONG_TASK_RE.test(rawTask);       // coordinator → specialist: long tasks detach
    if (background) console.log('[delegate] auto-background:true (coordinator→specialist, task-shaped) for', agent_id);
  } else {
    background = false;                            // specialist → coordinator escalation: stream live
  }

  // Every coordinator delegation is ephemeral: a fresh session per call with no
  // prior history loaded and nothing persisted back. Prevents cross-task context
  // bleed (e.g. stale file references from a completed delegation steering the
  // next run into a recon loop). Direct user↔agent WS chat bypasses this skill,
  // so that path keeps its persistent ${agent_id}.jsonl.
  // The `d${depth}` marker lets a nested executeSkillTool call read its own
  // depth via _parseCallerSession (chat.mjs passes the running scoped-agent
  // id straight through as callerAgentId on tool dispatch). The suffix uses
  // the RESOLVED agent.id rather than the LLM-supplied agent_id so the
  // parser can later look up the agent in getAgentsForUser by exact id.
  const delegId = `ephemeral_deleg_d${newDepth}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${agent.id}`;
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
  const taskSummary = (task || '').slice(0, 120);

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

  // Hint propagation: when the coordinator delegates a task that references
  // a named entity (e.g. "Delete the latest email from my <account-label>
  // account"), the alias resolver fires on the coordinator's turn but the
  // resulting hint doesn't automatically reach the delegated agent — its
  // ephemeral session starts fresh with just the task as the first user
  // message. Without this block it would call email_list_accounts to
  // discover the account_id all over again. We re-resolve here against the
  // task text and prepend any hints to the delegated agent's system prompt
  // so it goes straight to the right tool.
  try {
    const { buildContextHints } = await import('../../lib/context-resolvers.mjs');
    const { hints } = await buildContextHints(userId, task);
    if (hints) {
      scopedAgent.systemPrompt = `${scopedAgent.systemPrompt}\n\n## Pre-resolved references\n${hints}`;
    }
  } catch (_) { /* best-effort — never block the delegation */ }

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
    const autoContinue = callerIsCoordinator;
    const taskId = dispatchBackground(scopedAgent, task, userId, callerAgentId ?? `${userId}_${agent_id}`, agentName, agentEmoji, { autoContinue });
    // Phrase the result as something the calling agent can relay verbatim to the
    // user — not internal jargon — so the user knows what's happening and that a
    // result will follow, without having to watch logs.
    yield { type: 'result', text: `Handed this to ${agentName} to work on in the background — the result will be posted here when it's ready. (background task ${taskId})` };
    return;
  }

  let syncWatcherId = null;
  let syncWatcherTaskId = null;
  let syncWatchers = null;
  try {
    syncWatchers = await import('../../scheduler/watchers.mjs');
    syncWatcherTaskId = `deleg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    syncWatcherId = syncWatchers.registerWatcher({
      userId,
      agentId: callerAgentId ?? `${userId}_${callerEffectiveId || agent_id}`,
      kind: 'task_proxy',
      label: `${agentEmoji} ${agentName}: ${taskSummary}`,
      state: {
        taskId: syncWatcherTaskId,
        status: 'running',
        targetAgentId: scopedAgent.id,
        targetAgentName: agentName,
        targetAgentEmoji: agentEmoji,
        summary: taskSummary,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        phase: 'queued',
        toolsUsed: 0,
        currentTool: null,
        canCancel: false,
      },
      cadenceSec: 30,
      expiresAt: null,
    });
    syncWatchers.pushWatcherStatus(userId, syncWatcherId, `Delegating to ${agentName}: ${taskSummary}`, {
      phase: 'queued',
      canCancel: false,
    });
  } catch (e) {
    console.warn('[delegate] sync task_proxy watcher registration failed:', e.message);
  }

  // Queue behind any in-flight run on the target agent. If busy, surface a
  // visible indicator so the user sees we're waiting instead of silently hanging.
  const scopedAgentId = `${userId}_${agent_id}`;
  let waitedMs = 0;
  if (isAgentBusy(scopedAgentId)) {
    const waitStart = Date.now();
    if (syncWatcherId) {
      syncWatchers.pushWatcherStatus(userId, syncWatcherId, `Waiting for ${agentName} to finish a prior task`, {
        phase: 'queued',
        currentTool: 'waiting_for_agent',
      });
    }
    yield {
      type: 'tool_call',
      name: 'waiting_for_agent',
      args: { agent: agentName, reason: 'busy with prior task' },
    };
    // Bound the wait. With sync escalations a specialist's turn stays open while
    // the coordinator runs, so the coordinator delegating BACK to that specialist
    // hits a slot that only frees when the suspended turn ends — a wait that
    // never resolves (waitForAgentIdle has no timeout). Cap it and bail with a
    // clear instruction so a loop-back degrades to a message, not the hang the
    // user was complaining about. Normal contention clears well under this.
    const IDLE_WAIT_TIMEOUT_MS = 20000;
    let _to;
    const timedOut = await Promise.race([
      waitForAgentIdle(scopedAgentId).then(() => false),
      new Promise(res => { _to = setTimeout(() => res(true), IDLE_WAIT_TIMEOUT_MS); }),
    ]);
    clearTimeout(_to);
    waitedMs = Date.now() - waitStart;
    if (timedOut) {
      if (syncWatcherId) {
        syncWatchers.completeWatcher(userId, syncWatcherId, {
          status: 'error',
          finalText: `⚠ ${agentName} stayed busy after ${Math.round(waitedMs / 1000)}s`,
        });
      }
      yield {
        type: 'tool_result',
        name: 'waiting_for_agent',
        text: `${agentName} still busy after ${Math.round(waitedMs / 1000)}s — giving up the wait.`,
        preview: `${agentName} still busy`,
      };
      yield {
        type: 'result',
        text: `${agentName} is busy with another task in this conversation and didn't free up — this happens when a request loops back to an agent that's already working on it. Answer the user directly with what you have instead of delegating to ${agentName}.`,
      };
      return;
    }
    yield {
      type: 'tool_result',
      name: 'waiting_for_agent',
      text: `${agentName} finished prior task after ${Math.round(waitedMs / 1000)}s — starting now.`,
      preview: `${agentName} ready (waited ${Math.round(waitedMs / 1000)}s)`,
    };
    if (syncWatcherId) {
      syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${agentName} is ready; starting now`, {
        phase: 'running',
        currentTool: null,
      });
    }
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
  const { matchToolPlan } = await import('../../lib/tool-plan-memory.mjs');
  const rememberedToolPlan = matchToolPlan(userId, { agentId: scopedAgent.id, phrase: task });
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
  let syncToolsUsed = 0;
  let syncCurrentTool = null;
  try {
    if (syncWatcherId) {
      syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${agentName} started working`, {
        phase: 'running',
        currentTool: null,
      });
    }
    for await (const event of streamChat(scopedAgent, task, null, null, userId, null, combinedNote, false, null, { toolPlan: rememberedToolPlan })) {
      if (event.type === 'token') {
        fullText += event.text;
        yield { type: 'tool_progress', name: 'ask_agent', text: event.text, sourceLabel: streamLabel };
      }
      if (event.type === 'tool_call' && event.name) {
        syncToolsUsed++;
        syncCurrentTool = event.name;
        yield {
          type: 'tool_call',
          name: event.name,
          args: event.args || null,
          delegated: true,
          agentName,
          targetAgentId: scopedAgent.id,
        };
        if (syncWatcherId) syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${agentName} is using ${event.name}`, {
          phase: 'tool',
          currentTool: event.name,
          toolsUsed: syncToolsUsed,
        });
      }
      if (event.type === 'tool_progress' && event.text && syncWatcherId) {
        syncWatchers.pushWatcherStatus(userId, syncWatcherId, String(event.text).slice(-1200), {
          phase: 'streaming',
          currentTool: syncCurrentTool,
          toolsUsed: syncToolsUsed,
        });
      }
      if (event.type === 'tool_result' && event.name) {
        const preview = String(event.text || '').split('\n').find(l => l.trim()) || '';
        syncCurrentTool = null;
        yield {
          type: 'tool_result',
          name: event.name,
          text: event.text || '',
          preview,
          delegated: true,
          agentName,
          targetAgentId: scopedAgent.id,
        };
        if (preview && syncWatcherId) {
          syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${event.name}: ${preview.slice(0, 240)}`, {
            phase: 'result',
            currentTool: null,
            toolsUsed: syncToolsUsed,
          });
        }
      }
      if (event.type === 'error') { errText = `Error from ${agent_id}: ${event.message}`; break; }
    }
  } finally {
    slot.release();
  }

  if (errText) {
    if (syncWatcherId) {
      syncWatchers.completeWatcher(userId, syncWatcherId, {
        status: 'error',
        finalText: `⚠ ${agentName} failed: ${errText}`,
      });
    }
    yield { type: 'result', text: errText };
    return;
  }
  const waitNote = waitedMs > 1000
    ? `[Note: waited ${Math.round(waitedMs / 1000)}s for ${agentName} to finish a prior task before delegating.]\n\n`
    : '';
  if (syncWatcherId) {
    syncWatchers.pushWatcherStatus(userId, syncWatcherId, `✓ ${agentName} replied`, {
      status: 'done',
      phase: 'done',
      currentTool: null,
      canCancel: false,
      finalReportPreview: fullText.trim().slice(0, 800),
    });
    syncWatchers.completeWatcher(userId, syncWatcherId, {
      status: 'done',
      finalText: `✓ ${agentName} replied`,
    });
  }
  yield { type: 'result', text: waitNote + (fullText.trim() || `No response from ${agent_id}.`) };
}

export default executeSkillTool;
