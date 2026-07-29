/**
 * Agent delegation skill — lets a coordinator agent route tasks to specialist agents.
 * Uses dynamic imports to avoid circular dependency: chat.mjs → roles.mjs → here → chat.mjs
 */

import { currentTaskContext, iterateInTaskContext } from '../../lib/task-proxy-context.mjs';
import { iterateUntilAbort } from '../../lib/abortable-async-iterator.mjs';
import { getScheduledContext } from '../../lib/scheduled-context.mjs';
import { getTurnContext, iterateInTurnContext } from '../../lib/turn-abort-context.mjs';
import { getToolRouterContext } from '../../lib/tool-router-context.mjs';
import { createLinkedAbortController, isAbortError } from '../../lib/abort-utils.mjs';
import { isEphemeralReadOnlyTool } from '../../lib/ephemeral-tool-cache.mjs';
import {
  MAX_PARALLEL_WORKSTREAMS,
  unlockParallelWorkGate,
} from '../../lib/parallel-work-gate.mjs';
import {
  canonicalWorkClaimKey,
  claimWork,
  completeCoordinatedTask,
  reserveParallelWork,
  reserveCoordinatedTasks,
  taskCoordinationSnapshot,
} from '../../lib/work-coordination.mjs';

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
  // Detached owner clones and their bounded parallel children retain the
  // stable owner id as the final suffix.
  m = String(callerAgentId).match(/^ephemeral_(?:worker|workstream)_[^_]+_[^_]+_(.+)$/);
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
const MAX_ADAPTIVE_WORKSTREAMS = Math.min(4, MAX_PARALLEL_WORKSTREAMS);
const MAX_DECLARED_WORKSTREAMS = 12;
const MAX_WORKSTREAM_RESULT_CHARS = 10_000;
const MIN_WORKSTREAM_RESULT_CHARS = 2_000;
const MAX_PARALLEL_RESULT_CHARS = 40_000;
// Admission for this feature's child lanes. A coordinator's provider loop is
// suspended while its parallel_work tool awaits them, so these are the added
// concurrent model streams. Other subsystems retain their own existing caps.
const MAX_PARALLEL_LANES_PER_USER = Math.max(
  1,
  Math.min(12, Number.parseInt(process.env.OPENENSEMBLE_MAX_PARALLEL_WORKSTREAMS || '6', 10) || 6),
);
const PARALLEL_TEAM_DEADLINE_MS = Math.max(
  30_000,
  Math.min(
    30 * 60_000,
    Number.parseInt(process.env.OPENENSEMBLE_PARALLEL_TEAM_TIMEOUT_MS || '600000', 10) || 600_000,
  ),
);
const MAX_WORKSTREAM_TOOL_LOOPS = 16;
const MAX_PARALLEL_TEAM_TOOL_LOOPS = 64;

/** @type {Map<string, {active:number, waiters:Array<any>}>} */
const workstreamSlots = new Map();

function _slotState(userId) {
  let state = workstreamSlots.get(userId);
  if (!state) {
    state = { active: 0, waiters: [] };
    workstreamSlots.set(userId, state);
  }
  return state;
}

async function _acquireWorkstreamSlot(userId, signal = null) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Parallel work cancelled');
  }
  const state = _slotState(userId);
  if (state.active < MAX_PARALLEL_LANES_PER_USER) {
    state.active += 1;
    return;
  }
  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Parallel work cancelled'));
    };
    state.waiters.push(waiter);
    signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
    if (signal?.aborted) waiter.onAbort();
  });
}

function _releaseWorkstreamSlot(userId) {
  const state = workstreamSlots.get(userId);
  if (!state) return;
  while (state.waiters.length) {
    const waiter = state.waiters.shift();
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    if (waiter.signal?.aborted) continue;
    waiter.resolve();
    return;
  }
  state.active = Math.max(0, state.active - 1);
  if (state.active === 0) workstreamSlots.delete(userId);
}

const PARALLEL_BUILTIN_SAFE_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'list_profile_files',
  'read_profile_file',
  'list_documents',
  'read_document',
  'list_document_versions',
  'email_list_accounts',
  'email_learned_labels',
  'list_research',
  'get_research',
]);

async function _parallelChildTools() {
  const router = getToolRouterContext();
  const pool = Array.isArray(router?.fullTools) && router.fullTools.length
    ? router.fullTools
    : (Array.isArray(router?.agent?.tools) ? router.agent.tools : []);
  const trustedParallelReads = new Set();
  try {
    const { listRoles } = await import('../../roles.mjs');
    for (const manifest of listRoles(null)) {
      if (manifest?.custom === true || manifest?.userScope) continue;
      for (const tool of (Array.isArray(manifest?.tools) ? manifest.tools : [])) {
        if (tool?.parallelSafeRead === true && tool?.function?.name) {
          trustedParallelReads.add(tool.function.name);
        }
      }
    }
  } catch {
    // Exact built-in allowlists below still provide a fail-closed surface.
  }
  const blocked = new Set([
    'parallel_work',
    'spawn_worker',
    'ask_agent',
    'check_workers',
    'stop_worker',
    'redirect_worker',
  ]);
  const safeControls = new Set(['claim_work', 'report_progress', 'request_tools']);
  return pool.filter(tool => {
    const name = tool?.function?.name;
    if (!name || blocked.has(name)) return false;
    if (safeControls.has(name)) return true;
    // `parallelSafeRead` is intentionally distinct from the platform-wide
    // `readOnly` permission bit. The latter also affects ambient MCP tokens
    // and unattended lead sweeps; this feature must not widen either surface.
    // Generic claims cannot prove that arbitrary mutating arguments remain
    // inside a lane, so the coordinator serializes writes after synthesis.
    return trustedParallelReads.has(name)
      || PARALLEL_BUILTIN_SAFE_TOOL_NAMES.has(name)
      || isEphemeralReadOnlyTool(name);
  });
}

function _makeParallelChild(baseAgent, ownerKey, item, tools, teamSize) {
  const id = `ephemeral_workstream_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${ownerKey}`;
  const childContract = [
    '## Coordinated child workstream',
    `You are one bounded member of a parallel team. Work only on: ${item.label}.`,
    `Assignment: ${item.task}`,
    'The coordinator has already reserved your primary workstream. Before expanding to another shared source, file, endpoint, account, topic, or resource, call claim_work with a stable kind/key.',
    'If claim_work reports a conflict, do not duplicate that work; choose an uncovered alternative and claim it first.',
    'Coordinator updates appended to tool results are authoritative. Follow them before taking another action.',
    'Your tool surface is read-only by design. Analyze and gather evidence only; never mutate shared state. The coordinator will serialize any writes after synthesizing all lanes.',
    'Use report_progress for concrete milestones. Return a concise, evidence-based result for this lane only; the coordinator will synthesize all lanes.',
    'Do not delegate, create background work, or attempt to manage another child.',
  ].join('\n');
  const child = {
    ...baseAgent,
    id,
    name: item.label,
    ephemeral: true,
    workerOwnerId: ownerKey,
    _coordinatedWorkstream: true,
    // The root coordinator may currently carry a locked preflight object.
    // Never inherit that mutable state into a leaf: children already are the
    // fan-out and must run their assigned read-only tools directly.
    _parallelWorkGate: null,
    maxToolLoops: Math.min(
      MAX_WORKSTREAM_TOOL_LOOPS,
      Math.max(1, Number(baseAgent?.maxToolLoops) || MAX_WORKSTREAM_TOOL_LOOPS),
      Math.max(1, Math.floor(MAX_PARALLEL_TEAM_TOOL_LOOPS / Math.max(1, teamSize))),
    ),
    maxTokens: Math.min(4_096, Math.max(512, Number(baseAgent?.maxTokens) || 4_096)),
    tools,
    systemPrompt: [baseAgent?.systemPrompt || '', childContract].filter(Boolean).join('\n\n'),
  };
  // Tool trimming and request_tools both recompose prompts from these cached
  // source fields. Put the lane contract in the source as well as the flat
  // prompt so capability recovery cannot erase the assignment or leaf rule.
  if (baseAgent?._promptTiers) {
    child._promptTiers = {
      ...baseAgent._promptTiers,
      volatile: [baseAgent._promptTiers.volatile || '', childContract].filter(Boolean).join('\n\n'),
    };
    child.systemPrompt = [
      child._promptTiers.stable,
      child._promptTiers.context,
      child._promptTiers.volatile,
    ].filter(Boolean).join('\n\n');
  } else if (baseAgent?._systemPromptShell) {
    child._systemPromptShell = [baseAgent._systemPromptShell, childContract]
      .filter(Boolean)
      .join('\n\n');
  }
  delete child._promptTiersAssembled;
  return child;
}

function _normalizedWorkstreamCount(value) {
  const count = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  return Number.isSafeInteger(count) && count >= 2 ? count : null;
}

function _parallelItems(args, maxItems) {
  const raw = Array.isArray(args?.work_items) ? args.work_items : [];
  if (raw.length < 2 || raw.length > maxItems) return [];
  const allowedModes = new Set(['exclusive', 'shared', 'verification']);
  const items = [];
  for (const item of raw) {
    if (typeof item?.label !== 'string'
        || typeof item?.task !== 'string'
        || typeof item?.claim?.kind !== 'string'
        || typeof item?.claim?.key !== 'string') {
      return [];
    }
    const label = item.label.trim().slice(0, 80);
    const task = item.task.trim().slice(0, 8_000);
    const kind = item.claim.kind.trim().slice(0, 40);
    const key = item.claim.key.trim().slice(0, 240);
    const mode = item.claim.mode ?? 'exclusive';
    if (!label || !task || !kind || !key || !allowedModes.has(mode)) return [];
    items.push({
      label,
      task,
      claim: {
        kind,
        key,
        label: String(item.claim.label || label).trim().slice(0, 160),
        mode,
      },
    });
  }
  return items;
}

function _expectedWorkstreamCount(baseAgent) {
  const assessment = baseAgent?._parallelWorkGate?.assessment;
  const assessedExplicit = ['structured', 'route-text'].includes(assessment?.laneCountSource)
    ? _normalizedWorkstreamCount(assessment?.effectiveLanes)
    : null;
  // An over-limit request is intentionally represented by the gate's effective
  // count so the configured safety cap is visible rather than silently applied.
  if (assessment?.requestExceedsLimit === true && assessedExplicit !== null) {
    return { count: assessedExplicit, source: assessment.laneCountSource };
  }
  const structured = _normalizedWorkstreamCount(baseAgent?.requestedWorkstreams);
  if (structured !== null) return { count: structured, source: 'structured' };
  if (assessedExplicit !== null) {
    return { count: assessedExplicit, source: assessment.laneCountSource };
  }
  return null;
}

function _parallelConcurrency(args, itemCount) {
  if (args?.max_parallelism == null) {
    return { ok: true, value: Math.min(itemCount, MAX_ADAPTIVE_WORKSTREAMS) };
  }
  const requested = typeof args.max_parallelism === 'number'
    ? args.max_parallelism
    : (
      typeof args.max_parallelism === 'string' && /^\d+$/.test(args.max_parallelism.trim())
        ? Number(args.max_parallelism.trim())
        : NaN
    );
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > itemCount) {
    return {
      ok: false,
      reason: `max_parallelism must be a whole number from 1 to the ${itemCount} requested work_items. No workstreams were started.`,
    };
  }
  return { ok: true, value: requested };
}

function _workstreamResultCharLimit(itemCount) {
  return Math.max(
    MIN_WORKSTREAM_RESULT_CHARS,
    Math.min(
      MAX_WORKSTREAM_RESULT_CHARS,
      Math.floor(MAX_PARALLEL_RESULT_CHARS / Math.max(1, itemCount)),
    ),
  );
}

async function* _claimWorkTool(args) {
  const tc = currentTaskContext();
  if (!tc?.taskId || !tc?.rootTaskId || !tc?.parentTaskId) {
    yield {
      type: 'result',
      text: 'claim_work is only available inside a coordinated child workstream.',
      isError: true,
    };
    return;
  }
  const result = claimWork({
    rootTaskId: tc.rootTaskId,
    taskId: tc.taskId,
    kind: args?.kind,
    key: args?.key,
    label: args?.label,
    mode: args?.mode,
  });
  const bg = await import('../../background-tasks.mjs');
  if (result.ok) {
    const claim = result.claim;
    bg.noteTaskCoordination(
      tc.taskId,
      result.duplicate
        ? `Already covering ${claim?.label || args?.key}`
        : `Claimed ${claim?.label || args?.key}`,
    );
    yield {
      type: 'result',
      text: result.duplicate
        ? `You already own "${claim?.label || args?.key}". Continue without claiming it again.`
        : `Claim accepted: ${claim?.kind || 'work'} "${claim?.label || args?.key}" (${claim?.mode || 'exclusive'}).`,
    };
    return;
  }
  bg.noteTaskCoordination(tc.taskId, `Overlap avoided: ${result.reason || 'claim conflict'}`);
  yield {
    type: 'result',
    text: `Claim rejected: ${result.reason || 'another worker already owns this scope'}`,
  };
}

async function* _redirectWorkerTool(args, userId, callerAgentId) {
  const taskId = String(args?.worker_id || '').trim();
  const directive = String(args?.directive || '').trim();
  if (!taskId || !directive) {
    yield { type: 'result', text: 'redirect_worker requires worker_id and directive.', isError: true };
    return;
  }
  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
  const agents = getAgentsForUser(userId);
  const singleMode = agents.length === 1 && agents[0]?._rosterSolo === true;
  const { effectiveAgentId: ownerKey } = _parseCallerSession(callerAgentId);
  const bg = await import('../../background-tasks.mjs');
  const result = bg.redirectTaskWork(userId, taskId, directive, {
    ownerKey: singleMode ? null : ownerKey,
    reason: String(args?.reason || '').trim(),
    releaseClaims: args?.release_claims !== false,
  });
  yield {
    type: 'result',
    text: result.ok
      ? `${result.duplicate ? 'Redirect already queued' : 'Redirect queued'} for ${taskId}. It will be delivered immediately after the worker's current tool call.`
      : `Could not redirect ${taskId}: ${result.reason}.`,
    ...(result.ok ? {} : { isError: true }),
  };
}

async function* _parallelWorkTool(args, userId, callerAgentId, ctx = null) {
  const taskContext = currentTaskContext();
  if (!taskContext?.taskId
      || !taskContext?.ownerKey
      || taskContext?.parentTaskId
      || taskContext.rootTaskId !== taskContext.taskId) {
    yield {
      type: 'result',
      text: 'parallel_work is only available to a detached coordinator worker. Start one complete background outcome with spawn_worker; that worker can fan out independent lanes safely.',
      isError: true,
    };
    return;
  }

  const rawItemCount = Array.isArray(args?.work_items) ? args.work_items.length : 0;
  if (rawItemCount > MAX_PARALLEL_WORKSTREAMS) {
    yield {
      type: 'result',
      text: `parallel_work received ${rawItemCount} work_items, above this server's per-outcome safety cap of ${MAX_PARALLEL_WORKSTREAMS}. No workstreams were started; keep the requested count visible and replan within the cap.`,
      isError: true,
    };
    return;
  }
  // Validate the complete plan shape before looking up runtime agent metadata.
  // This keeps malformed calls fail-closed even if their router context is
  // unavailable, while exact-count enforcement below still uses that context.
  const items = _parallelItems(args, MAX_PARALLEL_WORKSTREAMS);
  if (items.length < 2) {
    yield {
      type: 'result',
      text: 'parallel_work needs at least 2 complete, genuinely independent work_items, each with label, task, and claim.kind/key. No workstreams were started.',
      isError: true,
    };
    return;
  }

  const router = getToolRouterContext();
  const { effectiveAgentId: parsedOwner } = _parseCallerSession(callerAgentId);
  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
  const durableAgents = getAgentsForUser(userId);
  const baseAgent = router?.agent
    || durableAgents.find(agent => agent.id === parsedOwner)
    || durableAgents.find(agent => callerAgentId?.endsWith?.(`_${agent.id}`))
    || durableAgents[0];
  const ownerKey = baseAgent?.workerOwnerId || parsedOwner || baseAgent?.id;
  if (!baseAgent || !ownerKey) {
    if (items.length > MAX_ADAPTIVE_WORKSTREAMS) {
      yield {
        type: 'result',
        text: `Adaptive parallel_work plans may use 2–${MAX_ADAPTIVE_WORKSTREAMS} work_items, but received ${items.length}. No workstreams were started; an explicit larger count requires its coordinator metadata.`,
        isError: true,
      };
      return;
    }
    yield { type: 'result', text: 'parallel_work could not resolve the calling agent.', isError: true };
    return;
  }

  const expectedCount = _expectedWorkstreamCount(baseAgent);
  if (expectedCount?.count > MAX_PARALLEL_WORKSTREAMS) {
    yield {
      type: 'result',
      text: `This outcome requests ${expectedCount.count} child workstreams, above this server's per-outcome safety cap of ${MAX_PARALLEL_WORKSTREAMS}. No workstreams were started; preserve the request and report the limit instead of silently reducing it.`,
      isError: true,
    };
    return;
  }
  if (expectedCount && rawItemCount !== expectedCount.count) {
    yield {
      type: 'result',
      text: `This outcome requires exactly ${expectedCount.count} child workstreams (${expectedCount.source} count), but parallel_work received ${rawItemCount} work_items. No workstreams were started; submit one complete non-overlapping item for every requested child.`,
      isError: true,
    };
    return;
  }
  if (!expectedCount && rawItemCount > MAX_ADAPTIVE_WORKSTREAMS) {
    yield {
      type: 'result',
      text: `Adaptive parallel_work plans may use 2–${MAX_ADAPTIVE_WORKSTREAMS} work_items, but received ${rawItemCount}. No workstreams were started; use the fewest useful adaptive lanes unless the user explicitly requested a count.`,
      isError: true,
    };
    return;
  }
  const concurrencyPlan = _parallelConcurrency(args, items.length);
  if (!concurrencyPlan.ok) {
    yield { type: 'result', text: concurrencyPlan.reason, isError: true };
    return;
  }
  const seenClaims = new Map();
  const conflictingInitialClaim = items.some(item => {
    const key = canonicalWorkClaimKey(item.claim.kind, item.claim.key);
    const priorMode = seenClaims.get(key);
    seenClaims.set(key, item.claim.mode);
    return priorMode && (priorMode === 'exclusive' || item.claim.mode === 'exclusive');
  });
  if (conflictingInitialClaim) {
    yield {
      type: 'result',
      text: 'parallel_work rejected overlapping initial claims. Give each workstream a distinct resource/scope, or keep intentional corroboration in one lane.',
      isError: true,
    };
    return;
  }

  const childTools = await _parallelChildTools();
  if (!childTools.length) {
    yield { type: 'result', text: 'parallel_work has no safe child tools available in this turn.', isError: true };
    return;
  }

  const reservation = reserveParallelWork({
    rootTaskId: taskContext.rootTaskId,
    coordinatorTaskId: taskContext.taskId,
    userId,
    childCount: items.length,
    maxCalls: 1,
    maxChildren: MAX_PARALLEL_WORKSTREAMS,
    deadlineMs: PARALLEL_TEAM_DEADLINE_MS,
  });
  if (!reservation.ok) {
    yield { type: 'result', text: `parallel_work was not started: ${reservation.reason}`, isError: true };
    return;
  }

  const plannedAt = Date.now();
  const plannedItems = items.map((item, index) => ({
    ...item,
    taskId: `eph_${plannedAt}_${Math.random().toString(36).slice(2, 7)}_${index + 1}`,
  }));
  const planned = reserveCoordinatedTasks({
    rootTaskId: taskContext.rootTaskId,
    parentTaskId: taskContext.taskId,
    userId,
    tasks: plannedItems.map(item => ({
      taskId: item.taskId,
      name: item.label,
      label: item.label,
      claim: item.claim,
    })),
  });
  if (!planned.ok) {
    yield {
      type: 'result',
      text: `parallel_work could not reserve its central lane plan: ${planned.reason}`,
      isError: true,
    };
    return;
  }
  const bg = await import('../../background-tasks.mjs');
  bg.noteTaskTeamPlan?.(
    taskContext.rootTaskId,
    `Coordinator assigned ${plannedItems.length} non-overlapping workstreams`,
  );

  const parentSignal = ctx?.signal || getTurnContext()?.signal || null;
  const teamAbort = createLinkedAbortController(parentSignal, 'Parallel work cancelled');
  const deadlineDelay = Math.max(1, reservation.deadlineAt - Date.now());
  const deadlineTimer = setTimeout(
    () => teamAbort.abort('Parallel work reached its team deadline'),
    deadlineDelay,
  );
  deadlineTimer.unref?.();
  const signal = teamAbort.signal;
  const concurrency = concurrencyPlan.value;
  const goal = String(args?.goal || 'the assigned task').trim().slice(0, 500);
  const sharedCapacity = Math.min(items.length, MAX_PARALLEL_LANES_PER_USER);
  const scheduling = [
    `local concurrency cap ${concurrency}`,
    `shared user capacity ${sharedCapacity}`,
  ].join('; ');
  const results = Array(plannedItems.length);
  let cursor = 0;
  const runOne = async index => {
    const item = plannedItems[index];
    let acquired = false;
    try {
      await _acquireWorkstreamSlot(userId, signal);
      acquired = true;
      const child = _makeParallelChild(
        baseAgent,
        ownerKey,
        item,
        childTools,
        plannedItems.length,
      );
      const text = await bg.dispatchEphemeral(child, item.task, userId, {
        taskId: item.taskId,
        preRegistered: true,
        signal,
        coordinated: true,
        label: item.label,
        ownerKey,
        isolatedTaskRun: true,
        workerMemoryAgentId: ownerKey,
        routeText: item.task,
        agentEmoji: baseAgent.emoji || '↳',
      });
      results[index] = { item, status: 'done', text };
    } catch (error) {
      const coordination = taskCoordinationSnapshot(item.taskId);
      if (coordination && !coordination.endedAt) {
        completeCoordinatedTask(
          item.taskId,
          isAbortError(error, signal) ? 'cancelled' : 'error',
          error?.message || String(error),
        );
      }
      results[index] = {
        item,
        status: isAbortError(error, signal) ? 'cancelled' : 'error',
        text: error?.message || String(error),
      };
    } finally {
      if (acquired) _releaseWorkstreamSlot(userId);
    }
  };
  try {
    // Keep the first yield inside the cleanup boundary. Consumers may close an
    // async generator while it is paused at this progress token; the linked
    // abort listener and deadline timer must still be released in that case.
    yield {
      type: 'token',
      text: `Starting ${items.length} independent workstreams (${scheduling}; excess lanes queue) for ${goal}…\n`,
    };
    const runners = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= plannedItems.length) return;
        await runOne(index);
      }
    });
    await Promise.all(runners);
  } finally {
    clearTimeout(deadlineTimer);
    teamAbort.dispose();
  }

  const completed = results.filter(result => result?.status === 'done').length;
  // The coordinator crossed the barrier for one structurally valid wave.
  // Restore exactly the surface selected before the preflight (not fullTools);
  // provider loops re-read this object before their next continuation.
  unlockParallelWorkGate(
    baseAgent,
    completed === plannedItems.length ? 'completed' : (completed ? 'partial' : 'failed-lanes'),
  );
  const resultCharLimit = _workstreamResultCharLimit(plannedItems.length);
  const sections = results.map((result, index) => {
    if (!result) return `## ${plannedItems[index].label}\n\nWorkstream did not return a result.`;
    const body = String(result.text || '').slice(0, resultCharLimit);
    const suffix = String(result.text || '').length > resultCharLimit
      ? '\n\n[Workstream result truncated for coordinator context.]'
      : '';
    const status = result.status === 'done' ? '' : ` (${result.status})`;
    return `## ${result.item.label}${status}\n\n${body}${suffix}`;
  }).join('\n\n');
  yield {
    type: 'result',
    text: `Parallel work complete: ${completed}/${plannedItems.length} workstreams succeeded. Synthesize these lane results into the final answer; resolve conflicts explicitly and do not merely concatenate them.\n\n${sections}`,
    ...(completed ? {} : { isError: true }),
  };
}

async function* _workerTool(name, args, userId, callerAgentId, internalOptions = null) {
  const bg = await import('../../background-tasks.mjs');
  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
  // The owner is the STABLE agent behind whatever session is calling — strip the
  // ephemeral/direct-chat wrapper so every incarnation resolves the same workers.
  const { effectiveAgentId: ownerKey } = _parseCallerSession(callerAgentId);
  const agents = getAgentsForUser(userId);
  const singleMode = agents.length === 1 && agents[0]?._rosterSolo === true;
  const liveWorkers = () => singleMode
    ? bg.listWorkersForUser(userId)
    : bg.listWorkersForOwner(userId, ownerKey);
  const recentWorkers = () => singleMode
    ? bg.listRecentWorkersForUser(userId)
    : bg.listRecentWorkersForOwner(userId, ownerKey);

  // A worker posting its own milestone note ("Batch 3 done: 200 labeled, ~600
  // left"). It finds its own task via the task_proxy ALS context that
  // spawnWorker established around the run — no id threading needed.
  if (name === 'report_progress') {
    const note = args.note || args.text || args.message;
    if (!note) { yield { type: 'result', text: 'Missing note — describe what just happened (e.g. "200 labeled, ~600 left").' }; return; }
    let tc = null;
    try { const m = await import('../../lib/task-proxy-context.mjs'); tc = m.currentTaskContext?.(); } catch { /* not in a worker */ }
    if (tc?.taskId && bg.recordWorkerProgress(tc.taskId, note)) {
      bg.noteTaskCoordination?.(tc.taskId, String(note).slice(0, 240), {
        appendProgress: false,
        phase: 'milestone',
      });
      yield { type: 'result', text: `Progress recorded: ${String(note).slice(0, 100)}` };
    } else {
      yield { type: 'result', text: 'Noted, but you are not running as a background worker so there is nothing to attach this to.' };
    }
    return;
  }

  if (name === 'check_workers') {
    const workers = liveWorkers();
    const recent = recentWorkers();
    // Background DELEGATIONS (coordinator→specialist tasks) are user-level work
    // tracked separately from owned workers. Surface them here too, so "is Gina
    // still working?" resolves directly — no matter which agent the user asks —
    // instead of an agent re-delegating to find out (the old black hole, where
    // every agent in the chain checked its own empty worker list). Exclude the
    // caller's own delegation session so a running specialist doesn't list itself.
    const delegations       = bg.listActiveDelegationsForUser(userId, callerAgentId);
    const recentDelegations = bg.listRecentDelegationsForUser(userId, callerAgentId);
    if (!workers.length && !recent.length && !delegations.length && !recentDelegations.length) {
      yield { type: 'result', text: 'No background work is running for you right now — no workers and no delegated tasks, and nothing finished in the last little while.' };
      return;
    }
    const ago = s => s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
    const fmtLog = items => (items || []).map(p =>
      p.kind === 'note' ? `    • ${p.text}`
      : p.kind === 'result' ? `    ↳ ${p.tool}: ${p.text}`
      : `    → ${p.tool}`).join('\n');
    const out = [];
    if (workers.length) {
      out.push(`Your workers running (${workers.length}):`);
      for (const w of workers) {
        const head = w.stalled
          ? `⚠ STALLED — no activity for ${ago(w.idleSec)} (was running ${w.currentTool || 'nothing'})`
          : (w.currentTool ? `running ${w.currentTool}` : 'between steps');
        out.push(`• ${w.name} [${w.taskId}] — ${head}; ${w.toolsUsed} tool calls, ${ago(w.elapsedSec)} elapsed. Job: ${w.summary}`);
        if (Array.isArray(w.childTasks) && w.childTasks.length) {
          for (const child of w.childTasks) {
            const claims = Array.isArray(child.claims) && child.claims.length
              ? ` · claims: ${child.claims.filter(c => c?.status === 'active').map(c => c.label).filter(Boolean).join(', ')}`
              : '';
            out.push(`    ↳ ${child.name || 'Worker'} [${child.taskId}] — ${child.currentTool ? `running ${child.currentTool}` : (child.status || 'running')}${claims}${child.lastEvent ? ` · ${child.lastEvent}` : ''}`);
          }
        }
        const log = fmtLog(w.progress);
        if (log) out.push(log);
      }
    }
    if (delegations.length) {
      out.push(`Delegated tasks running (${delegations.length}):`);
      for (const d of delegations) {
        const head = d.stalled
          ? `⚠ STALLED — no activity for ${ago(d.idleSec)}`
          : (d.currentTool ? `running ${d.currentTool}` : 'between steps');
        const ids = [
          d.rootTaskId && d.rootTaskId !== d.taskId ? `root=${d.rootTaskId}` : null,
          d.watcherId ? `watcher=${d.watcherId}` : null,
          d.spanId ? `span=${d.spanId}` : null,
        ].filter(Boolean).join(' · ');
        out.push(`• ${d.name} [${d.taskId}] — ${head}; ${d.toolsUsed} tool calls, ${ago(d.elapsedSec)} elapsed. Job: ${d.summary}${ids ? ` (${ids})` : ''}`);
        if (Array.isArray(d.childTasks) && d.childTasks.length) {
          out.push(`    children: ${d.childTasks.map(c => `${c.name || 'Agent'}=${c.status || 'running'}${c.currentTool ? `/${c.currentTool}` : ''}`).join(', ')}`);
        }
        const log = fmtLog(d.progress);
        if (log) out.push(log);
      }
    }
    if (recent.length) {
      out.push(`Your workers recently finished:`);
      for (const r of recent.slice(0, 5)) {
        const mark = r.outcome === 'done' ? '✓' : (r.outcome === 'stopped' ? '■' : '⚠');
        const verb = r.outcome === 'done' ? 'finished' : (r.outcome === 'stopped' ? 'was stopped' : 'FAILED');
        const ids = [
          r.rootTaskId && r.rootTaskId !== r.taskId ? `root=${r.rootTaskId}` : null,
          r.watcherId ? `watcher=${r.watcherId}` : null,
          r.spanId ? `span=${r.spanId}` : null,
        ].filter(Boolean).join(' · ');
        out.push(`${mark} ${r.name} [${r.taskId}] ${verb} ${ago(r.endedAgoSec)} ago (${r.toolsUsed} tool calls)${ids ? ` (${ids})` : ''} — ${r.finalText || r.summary}`);
      }
    }
    if (recentDelegations.length) {
      out.push(`Delegated tasks recently finished:`);
      for (const r of recentDelegations.slice(0, 5)) {
        const mark = r.outcome === 'done' ? '✓' : (r.outcome === 'stopped' ? '■' : '⚠');
        const verb = r.outcome === 'done' ? 'finished' : (r.outcome === 'stopped' ? 'was stopped' : 'FAILED');
        const ids = [
          r.rootTaskId && r.rootTaskId !== r.taskId ? `root=${r.rootTaskId}` : null,
          r.watcherId ? `watcher=${r.watcherId}` : null,
          r.spanId ? `span=${r.spanId}` : null,
        ].filter(Boolean).join(' · ');
        out.push(`${mark} ${r.name} [${r.taskId}] ${verb} ${ago(r.endedAgoSec)} ago (${r.toolsUsed} tool calls)${ids ? ` (${ids})` : ''} — ${r.finalText || r.summary}`);
      }
    }
    yield { type: 'result', text: out.join('\n') };
    return;
  }

  if (name === 'stop_worker') {
    const id = args.worker_id;
    if (!id) { yield { type: 'result', text: 'Missing worker_id (get it from check_workers).' }; return; }
    const r = bg.stopWorker(userId, id, singleMode ? null : ownerKey);
    yield { type: 'result', text: r.ok ? `Stopping ${r.name} (${id}).` : `Couldn't stop ${id}: ${r.reason}.` };
    return;
  }

  // name === 'spawn_worker' — leaf rule: a worker can't hire workers.
  // An unattended non-scheduled task already has one completion owner and no
  // child barrier. Refuse a second detached owner so the current task returns
  // the real work result instead of a premature worker acknowledgement.
  if (currentTaskContext() && !getScheduledContext()?.originTaskId) {
    yield {
      type: 'result',
      text: 'This unattended task already has a completion owner, so it cannot start another detached worker. Do the job directly with the tools in this task and return the real result.',
    };
    return;
  }
  if (String(callerAgentId || '').startsWith('ephemeral_worker_')) {
    yield { type: 'result', text: 'Workers are individual contributors and cannot hire their own workers. Do the job directly, then report back to whoever assigned it.' };
    return;
  }
  const task = args?.task;
  if (!task) { yield { type: 'result', text: 'Missing task — describe the complete job for the worker.' }; return; }
  const hasWorkerCount = args?.worker_count != null;
  const requestedWorkstreams = hasWorkerCount
    ? _normalizedWorkstreamCount(args.worker_count)
    : null;
  if (hasWorkerCount
      && (requestedWorkstreams === null || requestedWorkstreams > MAX_DECLARED_WORKSTREAMS)) {
    yield {
      type: 'result',
      text: `worker_count must be a whole number from 2 to ${MAX_DECLARED_WORKSTREAMS}. No worker was started; do not silently substitute another count.`,
      isError: true,
    };
    return;
  }

  const ownerAgent = agents.find(a => a.id === ownerKey);
  if (!ownerAgent) { yield { type: 'result', text: `Couldn't resolve your own agent record (${ownerKey}) to staff a worker.` }; return; }

  const capacityMessage = count => `You already have ${count} workers running (max ${MAX_WORKERS_PER_AGENT}). Wait for one to finish or stop one with stop_worker before hiring another.`;

  const label = args.label || (task.length > 56 ? task.slice(0, 56) + '…' : task);
  const workerId = `ephemeral_worker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${ownerKey}`;
  const workerAgent = { ...ownerAgent, id: workerId, ephemeral: true, workerOwnerId: ownerKey };
  if (requestedWorkstreams !== null) {
    workerAgent.requestedWorkstreams = requestedWorkstreams;
  } else {
    // Never leak an earlier detached run's explicit sizing into an adaptive job.
    delete workerAgent.requestedWorkstreams;
  }
  // No human is watching the worker's session. A server-owned fast path may
  // provide execution-only guidance with already-satisfied orchestration
  // removed; model-controlled tool arguments can never set that override.
  const trustedExecutionTask = typeof internalOptions?.executionTask === 'string'
    && internalOptions.executionTask.trim()
    ? internalOptions.executionTask.trim()
    : task;
  const workerTask = `${trustedExecutionTask}\n\n[You are a background worker running detached from the chat. Work autonomously to completion — do NOT ask for confirmation or wait for approval; the user is not watching this session. Use your tools directly. When finished, reply with a short summary of what you did and anything that needs a human.]`;
  const chipOwnerId = `${userId}_${ownerKey}`;   // owner's direct-chat session: chip + completion report land here
  let sourceTurn = null;
  try {
    const trace = await import('../../lib/turn-trace-context.mjs');
    sourceTurn = trace.getTurn?.() || null;
  } catch { /* direct non-turn caller */ }

  const { spawnWorkerIdempotently } = await import('../../lib/worker-spawn-idempotency.mjs');
  let admitted;
  try {
    admitted = await spawnWorkerIdempotently({
      userId, ownerKey, label, task,
      // This runs while the durable admission helper holds its per-user lock,
      // closing the race between concurrent distinct spawn_worker calls. Keep
      // the existing single-mode user-wide quota and ensemble owner quota.
      beforeSpawn: () => {
        const current = liveWorkers().length;
        if (current < MAX_WORKERS_PER_AGENT) return;
        throw Object.assign(new Error(capacityMessage(current)), { code: 'WORKER_CAPACITY' });
      },
      spawn: () => bg.spawnWorker({
        // Keep the user's task as the durable display/idempotency identity;
        // detached-autonomy guidance is only the model execution input.
        workerAgent, task, executionTask: workerTask, userId, chipOwnerId, ownerKey,
        originalTask: task,
        workerName: `${ownerAgent.name} worker`, emoji: ownerAgent.emoji || '🤖',
        rootTaskId: sourceTurn?.rootId || null,
        sourceMessageId: sourceTurn?.messageId || null,
        sourceAttemptId: sourceTurn?.attemptId || null,
        sourceSessionKey: sourceTurn?.sessionKey || null,
        sourceSessionEpoch: sourceTurn?.sessionEpoch || null,
        // Only the server-owned fifth executeSkillTool argument reaches this
        // field. args.completionContract/args.executionTask are ignored.
        completionContract: internalOptions?.completionContract || null,
      }),
    });
  } catch (error) {
    if (error?.code === 'WORKER_CAPACITY') {
      yield { type: 'result', text: error.message };
      return;
    }
    throw error;
  }
  const tid = admitted.taskId;
  if (admitted.duplicate) {
    yield { type: 'result', text: `This job already has a background worker (${tid}). Do NOT call spawn_worker again for this request; reply to the user now and use check_workers later for status.` };
    return;
  }
  const countNote = requestedWorkstreams === null
    ? ''
    : (requestedWorkstreams > MAX_PARALLEL_WORKSTREAMS
      ? ` The request specified ${requestedWorkstreams} child workers; this server's per-outcome safety cap is ${MAX_PARALLEL_WORKSTREAMS}, so the coordinator will use ${MAX_PARALLEL_WORKSTREAMS} and must report that limit visibly.`
      : ` It is required to create exactly ${requestedWorkstreams} child workstreams; the coordinator does not count toward that total.`);
  yield { type: 'result', text: `Hired a background worker (${tid}) on: ${label}.${countNote} It's running now — I can check on it anytime with check_workers, and its report will land here when it's done.` };
}

export async function* executeSkillTool(name, args, userId = 'default', callerAgentId = null, internalOptions = null) {
  if (name === 'parallel_work') {
    yield* _parallelWorkTool(args, userId, callerAgentId, internalOptions);
    return;
  }
  if (name === 'claim_work') {
    yield* _claimWorkTool(args);
    return;
  }
  if (name === 'redirect_worker') {
    yield* _redirectWorkerTool(args, userId, callerAgentId);
    return;
  }
  if (name === 'spawn_worker' || name === 'check_workers' || name === 'stop_worker' || name === 'report_progress') {
    yield* _workerTool(name, args, userId, callerAgentId, internalOptions);
    return;
  }
  if (name !== 'ask_agent') { yield { type: 'result', text: null }; return; }

  const { agent_id, task: rawTask, directive: rawDirective = '', no_confirm = false, _parallel = false } = args;
  // Coordinator-declared forward pipeline: run agent_id, then hand its result
  // (text + any image/file it produced) to `handoff_to`, in this same call.
  // Runtime-orchestrated (the skill runs both stages directly) so it works even
  // when the first agent is a media agent with no tool loop of its own, and is
  // loop-safe by construction — there's no recursion, just two linear stages.
  const handoffTo = typeof args.handoff_to === 'string' ? args.handoff_to.trim() : '';
  const handoffDirective = typeof args.handoff_directive === 'string' ? args.handoff_directive.trim() : '';
  // A declared handoff is terminal by default: the second agent's reply is the
  // user-facing answer and the coordinator runs no wrap-up turn.
  const terminal = handoffTo ? (args.terminal !== false) : false;
  let task = rawTask;
  // Optional routing key: the coordinator's one-line "what the specialist must
  // DO" (e.g. "send an email to X"). Used ONLY to pick the specialist's tools
  // and match/learn its recipe — the full content/recipients/body stay in
  // `task`, which is what the specialist actually works from. Keeps a big pasted
  // payload (briefing, doc) from drowning the send/compose intent. Empty → the
  // router falls back to instructionText(task).
  const directive = typeof rawDirective === 'string' ? rawDirective.trim() : '';
  if (!agent_id || !task) { yield { type: 'result', text: 'Missing agent_id or task.' }; return; }

  // Execution-time policy gate. The schema resolver removes ask_agent in
  // single mode, but a provider can still replay a stale tool call from the
  // preceding ensemble turn (or a direct caller can bypass schema listing).
  // Read the stored account policy before loading any delegation machinery or
  // resolving a target, and fail closed without starting a specialist turn.
  // This is intentionally NOT based on roster size: a one-agent ensemble keeps
  // the normal ask_agent contract.
  const { getOrchestrationPolicy } = await import('../../lib/orchestration-policy.mjs');
  if (getOrchestrationPolicy(userId).mode === 'single') {
    const isWorker = String(callerAgentId || '').startsWith('ephemeral_worker_');
    yield {
      type: 'result',
      text: isWorker
        ? 'You are a background worker and there are no other agents to hand work to. Finish the task yourself with your own tools, then reply with your report — it is delivered to your owner automatically.'
        : 'This deployment runs a single agent (you) — there are no specialists to delegate to. Do the task directly with your own tools. For a long or parallel job, call spawn_worker with a complete, self-contained task: it runs detached, shows a progress chip, and its report lands back in this chat when done. If a tool you need is missing this turn, call request_tools.',
    };
    return;
  }

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
  // The forward pipeline (handoff_to) is the COORDINATOR's to author — it's the
  // one with the global view to declare a producer→consumer chain. A specialist
  // that smuggles handoff_to gets it ignored (it just runs a normal delegation).
  const doHandoff = Boolean(handoffTo) && callerIsCoordinator;
  if (!callerIsCoordinator && agent.skillCategory !== 'coordinator') {
    yield {
      type: 'result',
      text: `Specialists may only escalate to the coordinator (use agent_id="coordinator"). Direct specialist-to-specialist delegation is not allowed — ask the coordinator to route this.`,
    };
    return;
  }
  // 1b. A DELEGATED specialist (depth>=1, i.e. the coordinator already handed it
  //     this task) must NOT escalate back up the chain. That was the infinite
  //     loop: Sydney→Rose→(Rose escalates)→Sydney re-delegates→Rose→... Each cycle
  //     re-woke the TOP-LEVEL coordinator (depth 0) and re-delegated fresh, so the
  //     depth never accumulated and the max-depth guard below never tripped. A
  //     delegate must finish its own part and RETURN its result to its caller;
  //     the coordinator owns the next handoff (e.g. to the email agent).
  //
  //     This is scoped to depth>=1 ON PURPOSE. At depth 0 — the user is chatting
  //     a specialist DIRECTLY, or a watcher fires one standalone — escalation to
  //     the coordinator IS the correct flow and does NOT loop: it runs
  //     Rose→Sydney→Gina (Sydney routes to a DIFFERENT agent, terminating), not
  //     back to Rose. So a directly-asked specialist still does its research and
  //     escalates to its coordinator to arrange a cross-agent step, exactly as
  //     before. Only the delegated (depth>=1) case is the loop, and only it is
  //     blocked here.
  if (currentDepth >= 1 && callerAgent && callerAgent.skillCategory !== 'coordinator') {
    yield {
      type: 'result',
      text: `You're completing a task your coordinator delegated to you — finish your part and return your findings as your reply (partial/uncertain is fine; state plainly what you could not verify or what you'd need another agent for). Do NOT escalate or re-delegate back to the coordinator — that creates a loop. The coordinator will handle the next step, such as routing the result to the email agent. If YOU need to email the user, use email_user directly.`,
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

  // Resolve the handoff target UP FRONT so a typo'd handoff_to fails fast —
  // before any stage-1 work — and the coordinator can immediately re-route,
  // instead of finding out after the producer already ran.
  let handoffTarget = null;
  if (doHandoff) {
    const needle = handoffTo.toLowerCase();
    handoffTarget = agents.find(a => a.id === handoffTo)
      ?? agents.find(a => a.name?.toLowerCase() === needle)
      ?? agents.find(a => a.id.toLowerCase().endsWith('_' + needle))
      ?? agents.find(a => a.role?.toLowerCase() === needle)
      ?? agents.find(a => a.skillCategory?.toLowerCase() === needle);
    if (!handoffTarget) {
      yield { type: 'result', text: `Handoff target '${handoffTo}' not found — no pipeline was started. Pick a valid agent for handoff_to, or delegate normally and route the result yourself.` };
      return;
    }
  }

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
  const FOREGROUND_INTENT_RE = /\b(?:wait(?:ing)?(?:\s+for\s+it)?|while\s+i\s+wait|right\s+here|in\s+this\s+(?:turn|reply|message)|foreground|synchronously|sync|do(?:\s+not|n't)\s+background|no\s+background)\b/i;
  const wantsForeground = args.background === false && FOREGROUND_INTENT_RE.test(`${rawTask || ''}\n${directive || ''}`);
  let background;
  const enclosingTaskOwner = currentTaskContext();
  const scheduledOwner = getScheduledContext();
  const silentScheduledOwner = scheduledOwner?.originTaskId && scheduledOwner?.silent === true;
  const mustAwaitOwnedTask = enclosingTaskOwner != null && !scheduledOwner?.originTaskId;
  if (doHandoff) {
    // A declared forward pipeline is by construction long (produce, then
    // consume) — run it DETACHED by default so the coordinator stays free to
    // keep chatting and delegating while it runs. Both stages execute inside
    // one background task (one chip, one cancel). A foreground override must
    // reflect user-visible wait intent in the delegated task text; otherwise a
    // model's incidental background:false would make identical image prompts
    // flip between sync and async handling.
    background = !wantsForeground;
  } else if (typeof args.background === 'boolean') {
    // Explicit background is honored as-is (owner decision 2026-07-03). The
    // old LONG_TASK_RE veto made background:false nearly dead — "read that
    // file and tell me" produced a chip instead of an answer while the
    // manifest promised FALSE works. Worst case is bounded anyway: a sync
    // tool call that runs past 10s auto-backgrounds into a chip (roles.mjs
    // AUTO_BG_MS net). Declared handoff pipelines keep their own override
    // above — an incidental background:false must not flip identical
    // pipelines between sync and async.
    background = args.background;
  } else if (callerIsCoordinator) {
    background = LONG_TASK_RE.test(rawTask);       // coordinator → specialist: long tasks detach
    if (background) console.log('[delegate] auto-background:true (coordinator→specialist, task-shaped) for', agent_id);
  } else {
    background = false;                            // specialist → coordinator escalation: stream live
  }
  // A non-scheduled task_proxy/MCP/proposal/watcher owner has no scheduled
  // child barrier. Even an explicit background:true or parallel hint must be
  // resolved synchronously inside that owner, otherwise the parent can report
  // success while its admitted child is still running.
  if (mustAwaitOwnedTask) background = false;

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

  // Establish synchronous ownership before any potentially slow hint/document
  // enrichment. roles.mjs can cross its 10-second UX boundary while waiting
  // for this generator's next value; the early progress frame lets it adopt
  // this exact chip instead of creating a duplicate generic watcher.
  const runSynchronously = mustAwaitOwnedTask || (!background && !_parallel);
  const syncAbort = new AbortController();
  const parentTaskCtx = currentTaskContext();
  const syncWatcherTaskId = `deleg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let syncWatcherId = null;
  let syncWatchers = null;
  let syncHandle = null;
  let unlinkParentAbort = null;
  const syncVisibleAgentId = callerAgentId ?? `${userId}_${callerEffectiveId || agent_id}`;
  const syncTaskCtx = {
    taskId: syncWatcherTaskId,
    watcherId: null,
    userId,
    agentId: scopedAgent.id,
    rootTaskId: parentTaskCtx?.rootTaskId || parentTaskCtx?.taskId || syncWatcherTaskId,
    parentTaskId: parentTaskCtx?.taskId || null,
    parentWatcherId: parentTaskCtx?.watcherId || null,
    rootWatcherId: parentTaskCtx?.rootWatcherId || parentTaskCtx?.watcherId || null,
    visibleAgentId: parentTaskCtx?.visibleAgentId || parentTaskCtx?.agentId || syncVisibleAgentId,
    spanId: `${parentTaskCtx?.rootTaskId || parentTaskCtx?.taskId || syncWatcherTaskId}:delegation:${syncWatcherTaskId}`,
  };

  // Single finalization point for the sync chip + registry entry. Define it
  // before the first progress yield so a consumer that closes the generator
  // on that frame cannot strand the owner or its durable journal record.
  let _syncFinished = false;
  const finishSync = (outcome, finalText, finalReportPreview = '') => {
    if (_syncFinished) return;
    _syncFinished = true;
    unlinkParentAbort?.();
    unlinkParentAbort = null;
    if (syncHandle) {
      syncHandle.complete({ outcome, finalText, finalReportPreview });
    } else if (syncWatcherId) {
      const status = (outcome === 'stopped') ? 'cancelled' : (outcome === 'error' ? 'error' : 'done');
      if (finalReportPreview) {
        syncWatchers.pushWatcherStatus(userId, syncWatcherId, finalText, { status, phase: status, currentTool: null, canCancel: false, finalReportPreview });
      }
      syncWatchers.completeWatcher(userId, syncWatcherId, { status, finalText });
    }
  };

  let syncExecutionEntered = false;
  let noConfirmNote = null;
  try {
  if (runSynchronously) {
    const parentSignal = getTurnContext()?.signal || null;
    if (parentSignal) {
      if (parentSignal.aborted) {
        syncAbort.abort(parentSignal.reason);
      } else {
        const onParentAbort = () => syncAbort.abort(parentSignal.reason);
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        unlinkParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
    if (!silentScheduledOwner) {
      try {
        syncWatchers = await import('../../scheduler/watchers.mjs');
        syncWatcherId = syncWatchers.registerWatcher({
          userId,
          agentId: syncVisibleAgentId,
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
            canCancel: true,
          },
          cadenceSec: 30,
          expiresAt: null,
        });
        syncTaskCtx.watcherId = syncWatcherId;
        syncTaskCtx.rootWatcherId = syncTaskCtx.rootWatcherId || syncWatcherId;
        syncWatchers.pushWatcherStatus(userId, syncWatcherId, `Delegating to ${agentName}: ${taskSummary}`, {
          phase: 'queued',
          canCancel: true,
        });
      } catch (e) {
        console.warn('[delegate] sync task_proxy watcher registration failed:', e.message);
      }
    }
    try {
      const bgMod = await import('../../background-tasks.mjs');
      syncHandle = bgMod.registerSyncDelegation({
        taskId: syncWatcherTaskId,
        userId,
        agentId: scopedAgent.id,
        agentName,
        agentEmoji,
        summary: taskSummary,
        watcherId: syncWatcherId,
        visibleAgentId: syncVisibleAgentId,
        abort: () => syncAbort.abort('delegation stopped'),
        rootTaskId: syncTaskCtx.rootTaskId,
        parentTaskId: syncTaskCtx.parentTaskId,
        parentWatcherId: syncTaskCtx.parentWatcherId,
        rootWatcherId: syncTaskCtx.rootWatcherId,
      });
    } catch (e) {
      console.warn('[delegate] sync delegation registration failed:', e.message);
    }
    yield {
      type: 'tool_progress',
      name: 'ask_agent',
      text: `Delegating to ${agentName}`,
      sourceLabel: `${agentEmoji} ${agentName}`,
      delegated: true,
      agentName,
      agentEmoji,
      targetAgentId: scopedAgent.id,
      ...(syncWatcherId ? { chipWatcherId: syncWatcherId } : {}),
      chipTaskId: syncWatcherTaskId,
    };
  }

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

  // Per-call no-confirm: the coordinator can pass no_confirm:true when the
  // user explicitly authorized the action in the triggering message
  // ("just send it", "no need to confirm"). This must apply to both sync and
  // background delegations; scheduled/direct-send tasks commonly detach.
  noConfirmNote = no_confirm
    ? `[DELEGATION OVERRIDE — NO CONFIRM] The coordinator has authorized this delegation as a direct send. The user's original message in the coordinator chat IS the confirmation. Do NOT show a draft, do NOT ask "are you sure?", do NOT wait for "send it" — call the action tool directly with reasonable defaults for anything unspecified, then report what you did. This overrides any "show draft and wait for approval" rule from your role's prompt for this single delegation only.`
    : null;

  // Background mode: fire and forget, return immediately.
  // Triggered either by explicit background:true from the model, or by _parallel:true injected
  // by chat.mjs when multiple ask_agent calls are detected in a single response.
  if (!mustAwaitOwnedTask && (background || _parallel)) {
    const { dispatchBackground } = await import('../../background-tasks.mjs');
    let taskCtx = null;
    try {
      const m = await import('../../lib/task-proxy-context.mjs');
      taskCtx = m.currentTaskContext?.() || null;
    } catch { /* no root task context */ }
    let sourceTurn = null;
    try {
      const m = await import('../../lib/turn-trace-context.mjs');
      sourceTurn = m.getTurn?.() || null;
    } catch { /* direct non-turn caller */ }
    const autoContinue = callerIsCoordinator;
    const handoffName = handoffTarget ? (handoffTarget.name ?? handoffTo) : null;
    // Stage-1 insulation for a backgrounded pipeline — same server-authored
    // note the sync path uses (see stage1Task below): the producer must not
    // attempt the handoff itself, the runtime owns stage 2.
    const bgTask = doHandoff
      ? `${task}\n\n[Pipeline note — from the server, not the user: do ONLY the production work above. When you finish your reply, your output and any file you produced are handed to ${handoffName} AUTOMATICALLY. Do not attempt to send, email, attach, route, or hand off anything yourself, and do not search for saved files. Once the artifact exists, describe it in one line and end your reply.]`
      : task;
    const taskId = dispatchBackground(scopedAgent, bgTask, userId, callerAgentId ?? `${userId}_${agent_id}`, agentName, agentEmoji, {
      autoContinue,
      extraSystemNote: noConfirmNote,
      summary: task,   // chip shows the task, not the server's pipeline note
      routeText: directive || null,
      rootTaskId: taskCtx?.rootTaskId || null,
      parentTaskId: taskCtx?.taskId || null,
      parentWatcherId: taskCtx?.watcherId || null,
      rootWatcherId: taskCtx?.rootWatcherId || taskCtx?.watcherId || null,
      visibleAgentId: taskCtx?.visibleAgentId || taskCtx?.agentId || null,
      // Browser Retry keeps messageId but mints a new attemptId. The detached
      // run must retain both so the durable email authorization ledger allows
      // all sends from the original attempt, then rejects new/changed sends
      // from a replay of that same user message.
      sourceMessageId: sourceTurn?.messageId || null,
      sourceAttemptId: sourceTurn?.attemptId || null,
      sourceSessionKey: sourceTurn?.sessionKey || null,
      sourceSessionEpoch: sourceTurn?.sessionEpoch || null,
      handoff: doHandoff ? {
        agent: handoffTarget,
        name: handoffName,
        emoji: handoffTarget.emoji ?? '🤖',
        directive: handoffDirective,
        depth: newDepth,
      } : null,
    });
    // Turn-trace delegation edge for the backgrounded hop. The bg child runs
    // detached and records its own rootId-linked trace (rootTaskId → trace
    // rootId), so here we only note the edge — there's no sync ms to measure.
    try {
      const { recordDelegation } = await import('../../lib/turn-trace-context.mjs');
      recordDelegation({
        from: callerAgent?.name ?? callerEffectiveId ?? 'coordinator',
        to: doHandoff ? `${agentName} → ${handoffName}` : agentName,
        directive: String(directive || task || '').slice(0, 200),
        background: true,
        taskId,
      });
    } catch { /* trace best-effort */ }
    // Phrase the result as something the calling agent can relay verbatim to the
    // user — not internal jargon — so the user knows what's happening and that a
    // result will follow, without having to watch logs.
    yield {
      type: 'result',
      text: doHandoff
        ? `Started the ${agentName} → ${handoffName} pipeline in the background: ${agentName} is working now, and when it finishes its output (plus any file it produced) is handed to ${handoffName} automatically to finish the job. Live progress shows in the task chip (it can be stopped from there too); the final result will be posted here when ${handoffName} is done. (background task ${taskId})`
        : `Handed this to ${agentName} to work on in the background — the result will be posted here when it's ready. (background task ${taskId}${taskCtx?.rootTaskId ? ` under root ${taskCtx.rootTaskId}` : ''})`,
    };
    return;
  }

  syncExecutionEntered = true;
  } catch (e) {
    if (runSynchronously) finishSync('error', `⚠ ${agentName} failed: ${e?.message || e}`);
    throw e;
  } finally {
    if (runSynchronously && !syncExecutionEntered) {
      finishSync('stopped', `■ ${agentName} interrupted — the turn ended before the delegation started`);
    }
  }

  // Abandonment net. If the consumer tears down this generator mid-yield
  // (turn aborted / Stop / WS teardown — roles.mjs finalizes the skill
  // iterator, which resumes here as a return), none of the exit paths below
  // ever reaches finishSync and the registry entry used to sit "running"
  // until the 24h reaper (check_workers reported a dead delegation as live
  // for a day). finishSync is idempotent, so normal exits are unaffected.
  try {

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
        finishSync('error', `⚠ ${agentName} stayed busy after ${Math.round(waitedMs / 1000)}s`);
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

    // The user may have hit Stop while we were queued behind the busy agent —
    // don't start work that was already cancelled.
    if (syncAbort.signal.aborted) {
      finishSync('stopped', `■ ${agentName} cancelled`);
      yield { type: 'result', text: `The user cancelled the delegation to ${agentName} before it started — stop this line of work and do not retry unless asked.` };
      return;
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
    // Composes with scheduledNote when both apply.
    const combinedNote = [scheduledNote, noConfirmNote].filter(Boolean).join('\n\n') || null;
    const { matchToolPlan } = await import('../../lib/tool-plan-memory.mjs');
    const rememberedToolPlan = matchToolPlan(userId, { agentId: scopedAgent.id, phrase: directive || task });
    // Surface the specialist's prose into the coordinator's chat as a
    // live-streaming tool bubble (rendered by public/chat.js _ensureStreamBubble
    // via the tool_progress event). Without this, the user only sees the small
    // ask_agent pill in the coordinator's chat and has to either expand the
    // pill or switch to the specialist's chat tab to read the actual reply —
    // which defeats the whole point of delegating from the coordinator.
    // We label the stream with the specialist's name + emoji so a 3-way
    // parallel delegation (email + calendar + weather) shows three distinct
    // sub-streams instead of three identical "ask_agent" bubbles.
    // ── Stage runner ──────────────────────────────────────────────────────────
    // Streams ONE agent's work up to the coordinator's chat: emits the same
    // delegated tool_progress/tool_call/tool_result events the inline loop used
    // to, pushes live status into the sync chip, and collects the agent's reply
    // text + any media artifacts (images/videos/audio it produced) into `cap`.
    // Reused for BOTH stages of a forward pipeline, so each shows up as its own
    // labelled sub-stream and the user watches stage 1 then stage 2 in real time.
    // Sentinel for a user-cancelled stage — distinguished from a real error so
    // the exit path below can finalize the chip as cancelled, not failed.
    const CANCELLED = '__delegation_cancelled__';
    async function* runStage(stageAgent, stageTask, sName, sEmoji, sNote, sRouteText, sToolPlan, cap) {
      const sLabel = `${sEmoji} ${sName}`.trim();
      let sCurrentTool = null;
      // chipWatcherId/chipTaskId ride on every delegated event so the auto-bg
      // net (roles.mjs) can ADOPT this delegation's existing chip when the call
      // crosses 10s, instead of registering a second chip for the same work.
      const chipIds = { chipWatcherId: syncWatcherId, chipTaskId: syncWatcherTaskId };
      try {
        // The delegation has its own task_proxy from the first model event.
        // Keep the child model loop in that context even while this generator
        // yields progress to a foreground coordinator. The outer ask_agent
        // call may still cross roles.mjs's 10-second boundary and adopt this
        // one chip; tools *inside* the delegated stage must not detach again.
        const inheritedTurnContext = getTurnContext() || {};
        const ownedStageStream = iterateInTurnContext(
          { ...inheritedTurnContext, signal: syncAbort.signal },
          () => iterateInTaskContext(syncTaskCtx, () => iterateUntilAbort(
            streamChat(
              stageAgent,
              stageTask,
              syncAbort.signal,
              null,
              userId,
              null,
              sNote,
              silentScheduledOwner === true,
              null,
              { toolPlan: sToolPlan, routeText: sRouteText || undefined },
            ),
            syncAbort.signal,
            `${sName} delegation stopped`,
          )),
        );
        for await (const event of ownedStageStream) {
          if (event.type === 'token') {
            cap.fullText += event.text;
            yield { type: 'tool_progress', name: 'ask_agent', text: event.text, sourceLabel: sLabel, delegated: true, agentName: sName, agentEmoji: sEmoji, targetAgentId: stageAgent.id, ...chipIds };
          } else if (event.type === 'replace') {
            cap.fullText = String(event.text || '');
          } else if (event.type === '__content') {
            cap.fullText = String(event.content || '');
          } else if (event.type === 'tool_call' && event.name) {
            cap.toolsUsed++;
            sCurrentTool = event.name;
            syncHandle?.noteToolCall(event.name);
            yield { type: 'tool_call', name: event.name, args: event.args || null, delegated: true, agentName: sName, agentEmoji: sEmoji, targetAgentId: stageAgent.id, ...chipIds };
            if (syncWatcherId) syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${sName} is using ${event.name}`, { phase: 'tool', currentTool: event.name, toolsUsed: cap.toolsUsed });
          } else if (event.type === 'tool_progress' && event.text && syncWatcherId) {
            syncWatchers.pushWatcherStatus(userId, syncWatcherId, String(event.text).slice(-1200), { phase: 'streaming', currentTool: sCurrentTool, toolsUsed: cap.toolsUsed });
          } else if (event.type === 'tool_result' && event.name) {
            const preview = String(event.text || '').split('\n').find(l => l.trim()) || '';
            sCurrentTool = null;
            syncHandle?.noteToolResult(event.name, preview);
            yield { type: 'tool_result', name: event.name, text: event.text || '', preview, delegated: true, agentName: sName, agentEmoji: sEmoji, targetAgentId: stageAgent.id, ...chipIds };
            if (preview && syncWatcherId) syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${event.name}: ${preview.slice(0, 240)}`, { phase: 'result', currentTool: null, toolsUsed: cap.toolsUsed });
          } else if ((event.type === 'image' || event.type === 'video' || event.type === 'audio') && event.filename) {
            // Capture the produced file so a handoff target can attach it. The id
            // format matches what list_profile_files / attachment_doc_ids expect.
            const folder = event.type === 'image' ? 'images' : event.type === 'video' ? 'videos' : 'audio';
            cap.artifacts.push(`${folder}:${event.filename}`);
            if (event.type === 'image' && event.base64) {
              if (!Array.isArray(cap.images)) cap.images = [];
              cap.images.push({ base64: event.base64, mediaType: event.mimeType || event.mediaType || 'image/png' });
            }
            yield { ...event, delegated: true, agentName: sName, agentEmoji: sEmoji, targetAgentId: stageAgent.id, ...chipIds };
            yield { type: 'tool_progress', name: 'ask_agent', text: `\n_[${sName} produced ${event.filename}]_\n`, sourceLabel: sLabel, delegated: true, agentName: sName, agentEmoji: sEmoji, ...chipIds };
            if (syncWatcherId) syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${sName} produced ${event.filename}`, { phase: 'result', currentTool: null, toolsUsed: cap.toolsUsed });
          } else if (event.type === 'error') { cap.errText = `Error from ${sName}: ${event.message}`; break; }
        }
      } catch (err) {
        // Providers may throw (rather than yield an error event) on abort.
        cap.errText = syncAbort.signal.aborted ? CANCELLED : `Error from ${sName}: ${err.message}`;
        return;
      }
      // An abort can also end the stream cleanly — don't let a cancelled stage
      // read as completed (or start the handoff stage).
      if (syncAbort.signal.aborted && !cap.errText) cap.errText = CANCELLED;
    }

    // ── Stage 1: the first (or only) agent ────────────────────────────────────
    const _delegStart = Date.now();
    const stage1 = { fullText: '', toolsUsed: 0, artifacts: [], images: [], errText: null };
    // Stage-1 insulation: when a forward handoff is declared, the producing
    // agent must not attempt the handoff itself — cross-agent routing is blocked
    // for specialists, so a coordinator-authored task that also says "then hand
    // it off / have X email it" sends the producer hunting for a way to comply
    // (the Grand-Canyon loop: generate → search for the file → generate again).
    // The server owns stage 2, so say so inside the task. Server-authored: holds
    // no matter how the coordinator worded the task.
    const stage1Task = doHandoff
      ? `${task}\n\n[Pipeline note — from the server, not the user: do ONLY the production work above. When you finish your reply, your output and any file you produced are handed to ${handoffTarget?.name ?? handoffTo} AUTOMATICALLY. Do not attempt to send, email, attach, route, or hand off anything yourself, and do not search for saved files. Once the artifact exists, describe it in one line and end your reply.]`
      : task;
    try {
      if (syncWatcherId) syncWatchers.pushWatcherStatus(userId, syncWatcherId, `${agentName} started working`, { phase: 'running', currentTool: null });
      yield* runStage(scopedAgent, stage1Task, agentName, agentEmoji, combinedNote, directive, rememberedToolPlan, stage1);
    } finally {
      slot.release();
      try {
        const { recordDelegation } = await import('../../lib/turn-trace-context.mjs');
        recordDelegation({ from: callerAgent?.name ?? callerEffectiveId ?? 'coordinator', to: agentName, directive: String(directive || task || '').slice(0, 200), ms: Date.now() - _delegStart });
      } catch { /* trace best-effort */ }
    }
    fullText = stage1.fullText;
    errText = stage1.errText;

    // ── Stage 2: forward-handoff target (coordinator-declared pipeline) ────────
    // The first agent's reply + any file it produced flow straight into the
    // second agent — no coordinator turn in between. The second agent's reply
    // becomes the user-facing answer (terminal), so the coordinator runs no
    // wrap-up turn either.
    let isTerminal = false;
    let stage2Name = null;
    let finalImages = stage1.images;
    if (!errText && doHandoff) {
      const target2 = handoffTarget;   // resolved (and validated) before stage 1
      {
        stage2Name = target2.name ?? handoffTo;
        const stage2Emoji = target2.emoji ?? '🤖';
        syncHandle?.setStageName(`${agentName} → ${stage2Name}`);
        const artifactNote = stage1.artifacts.length
          ? `\n\nFILES PRODUCED BY ${agentName} — attach these EXACT ids via attachment_doc_ids (do not rename them and do not look them up again): ${JSON.stringify(stage1.artifacts)}`
          : '';
        const stage2Task = `${handoffDirective || 'Continue this task using the result below.'}\n\n[Result from ${agentName}]:\n${stage1.fullText.trim() || '(no text reply)'}${artifactNote}`;
        const deleg2Id = `ephemeral_deleg_d${newDepth}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${target2.id}`;
        const scoped2 = { ...target2, id: deleg2Id, ephemeral: true };
        {
          const now = new Date();
          scoped2.systemPrompt = `${target2.systemPrompt}\n\n## Current Date\nToday: ${now.toISOString().slice(0, 10)}`;
          try {
            const { buildContextHints } = await import('../../lib/context-resolvers.mjs');
            const { hints } = await buildContextHints(userId, stage2Task);
            if (hints) scoped2.systemPrompt += `\n\n## Pre-resolved references\n${hints}`;
          } catch { /* best-effort */ }
        }
        const terminalNote = `[HANDOFF — FINAL STEP] You are the last step of a pipeline the coordinator set up. Act now with your tools — do NOT show a draft and wait, the coordinator already authorized this whole chain. Your reply is delivered to the user verbatim as the final word on this task, so make it a clean, complete summary of what you did.`;
        const stage2Note = [scheduledNote, terminalNote].filter(Boolean).join('\n\n');
        try {
          const { initSession } = await import('../../lib/ephemeral-tool-cache.mjs');
          initSession(deleg2Id, stage2Task);
        } catch { /* best-effort */ }
        const slot2 = markAgentBusy(`${userId}_${target2.id}`);
        const stage2 = { fullText: '', toolsUsed: 0, artifacts: [], images: [], errText: null };
        const _stage2Start = Date.now();
        if (syncWatcherId) syncWatchers.pushWatcherStatus(userId, syncWatcherId, `Handing off to ${stage2Name}`, { phase: 'running', currentTool: null });
        try {
          yield* runStage(scoped2, stage2Task, stage2Name, stage2Emoji, stage2Note, handoffDirective, null, stage2);
        } finally {
          slot2.release();
          try {
            const { recordDelegation } = await import('../../lib/turn-trace-context.mjs');
            recordDelegation({ from: agentName, to: stage2Name, directive: String(handoffDirective || '').slice(0, 200), ms: Date.now() - _stage2Start });
          } catch { /* trace best-effort */ }
        }
        if (stage2.errText) {
          // Don't terminate on a failed handoff — surface it so the coordinator
          // can react (retry, tell the user, route elsewhere).
          errText = stage2.errText;
        } else {
          fullText = stage2.fullText;
          finalImages = stage2.images;
          isTerminal = terminal;
        }
      }
    }

    if (errText) {
      const failName = stage2Name || agentName;
      if (errText === CANCELLED || syncAbort.signal.aborted) {
        finishSync('stopped', `■ ${failName} cancelled`, fullText.trim().slice(0, 800));
        yield { type: 'result', text: `The user cancelled the delegation to ${failName} before it finished — stop this line of work and do not retry unless asked.` };
        return;
      }
      finishSync('error', `⚠ ${failName} failed: ${errText}`, String(errText).slice(0, 800));
      yield { type: 'result', text: errText };
      return;
    }
    const waitNote = waitedMs > 1000
      ? `[Note: waited ${Math.round(waitedMs / 1000)}s for ${agentName} to finish a prior task before delegating.]\n\n`
      : '';
    const finalAgentName = stage2Name || agentName;
    finishSync('done', `✓ ${finalAgentName} replied`, fullText.trim().slice(0, 800));
    // _terminal tells the provider tool-loop to deliver this reply as the turn's
    // final answer and NOT run another coordinator inference (see openai-responses).
    yield {
      type: 'result',
      text: waitNote + (fullText.trim() || `No response from ${finalAgentName}.`),
      ...(finalImages.length ? { _images: finalImages } : {}),
      ...(isTerminal ? { _terminal: true } : {}),
    };
  } catch (e) {
    finishSync('error', `⚠ ${agentName} failed: ${e?.message || e}`);
    throw e;
  } finally {
    finishSync('stopped', `■ ${agentName} interrupted — the turn ended before the delegation finished`);
  }
}

export default executeSkillTool;
