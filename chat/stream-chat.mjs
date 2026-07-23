/**
 * Main multi-provider chat generator (streamChat).
 * Extracted from chat.mjs — pure move.
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { buildAgentContext, formatContext, addToSessionBuffer } from '../memory.mjs';
import { loadSession, appendToSession, loadCrossAgentContext } from '../sessions.mjs';
import { getUserFilesDir, USERS_DIR } from '../lib/paths.mjs';
import { log } from '../logger.mjs';
import { trimToolsForTurn, recordTurnRouting, expandToolsByReason, inferMissingToolSkills, shouldUseProviderHostedImageBackend } from '../lib/tool-router.mjs';
import { bindToolRouterContext, toolRouterContext } from '../lib/tool-router-context.mjs';
import { beginMemoryScope } from '../lib/memory-scope-context.mjs';
import { getTurnContext } from '../lib/turn-abort-context.mjs';
import { filterToolsForMcpPolicy, getMcpToolPolicy } from '../lib/mcp-tool-policy.mjs';
import {
  getTurn, beginTurn, recordSpan, recordError, finishTurn,
  setTurnLabProviderRequestCap,
} from '../lib/turn-trace-context.mjs';
import { listRoles } from '../roles.mjs';
import { resolveValidatedSkillExecutionForTurn } from '../lib/skill-execution.mjs';
import { voiceContext } from '../lib/voice-context.mjs';
import { composeSkillSpaBlock } from '../lib/skill-prompt-composer.mjs';
import { learnToolPlanFromTurn } from '../lib/tool-plan-memory.mjs';
import { recordRunTrace, redactArgsForTrace, redactTextForTrace } from '../lib/run-inspector.mjs';
import {
  buildWorkerStandingMemoryContext,
  filterWorkerLeafTools,
  workerStandingMemoryOwner,
} from '../lib/worker-memory-policy.mjs';
import {
  compactDocumentToolArgs,
  compactDocumentFallback,
  compactDocumentToolPreview,
  compactDocumentToolResult,
  findDocumentMutation,
  normalizeDocumentRequest,
} from '../lib/document-artifacts.mjs';
import {
  OPENAI_COMPAT_PROVIDERS, FIREWORKS_BASE,
  getGrokKey, getFireworksKey, normalizeAttachments,
} from './providers/_shared.mjs';
import { streamAnthropic } from './providers/anthropic.mjs';
import { streamLMStudio } from './providers/lmstudio.mjs';
import { streamOpenRouter } from './providers/openrouter.mjs';
import { streamOpenAICompat } from './providers/openai-compat.mjs';
import { streamOpenAIResponses } from './providers/openai-responses.mjs';
import { streamOllama } from './providers/ollama.mjs';
import {
  consumeProvider,
  mergeProviderUsage,
  compactToolIdentityAnomaly,
  toolIdentityDurabilityWarning,
  isProviderCallOrdinal,
} from './provider-consumer.mjs';
import {
  buildLlmHistory,
  adaptLlmHistoryForProvider,
  historyMessageChars,
} from './history.mjs';
import {
  applyUserToolPlan,
  buildUserToolPlanSystemBlock,
  buildCurrentUserTurn,
  skillExecutionTraceSummary,
  userAllowedExecutionModels,
  recomposeAgentPromptForTools,
  executionSkillsForSelectedTools,
} from './tool-plan.mjs';
import {
  persist,
  buildDesktopFoldersBlock,
  saveDesktopArtifact,
  _modelContextWindow,
  documentArtifactContent,
} from './persist.mjs';
import {
  MISSING_TOOL_REPLY_RE,
  IN_PROGRESS_REPLY_RE,
  MISSING_TOOL_NOTICE,
  IN_PROGRESS_NOTICE,
  withRetryNote,
  RECOVERY_NOTE_EXCLUDED_TOOLS,
  AUTONOMOUS_TASK_CREATION_TOOLS,
} from './recovery.mjs';

export async function* streamChat(agent, userText, signal, emit, userId = 'default', attachment = null, systemNote = null, silent = false, voiceCtx = null, turnOpts = {}) {
  // Every nested MCP delegation/worker inherits a dedicated capability store.
  // Trim its provider schema on entry, while the final dispatcher gate remains
  // authoritative against cached schemas or model-invented tool calls.
  const mcpToolPolicy = getMcpToolPolicy();
  if (mcpToolPolicy && Array.isArray(agent?.tools)) {
    agent = { ...agent, tools: filterToolsForMcpPolicy(agent.tools, mcpToolPolicy) };
  }
  // `attachment` is a legacy name kept for the many positional callers that
  // still pass a single object or null (background-tasks, skills/delegate,
  // lib/mcp-outbound, lib/run-agent-with-retry) — none of those carry more
  // than one file today. chat-dispatch/llm-loop.mjs (the composer's tray)
  // passes the full array here instead. normalizeAttachments (chat/providers/
  // _shared.mjs — the same normalizer chat-dispatch.mjs uses at the wire
  // entry point) accepts either shape, so this is a defensive second pass,
  // not a duplicate of that one. attachment0 is every single-file code path
  // below (Grok/Fireworks image-edit input, the run-inspector trace summary)
  // that only ever made sense for one file.
  const attachments = normalizeAttachments(Array.isArray(attachment) ? attachment : null, Array.isArray(attachment) ? null : attachment);
  const attachment0 = attachments[0] ?? null;
  const isolatedTaskRun = turnOpts?.isolatedTaskRun === true;
  const detachedTaskRun = !!(turnOpts?.rootTaskId || turnOpts?.traceSource);
  const readOnlyTurn = turnOpts?.readOnlyTurn === true;
  // Only the public dispatcher may authenticate a verifier lease. Nested
  // streams inherit the resulting non-learning boundary through ambient turn
  // context; a direct caller cannot self-authorize with a plan source string.
  const inheritedLabVerifierTurn = process.env.OPENENSEMBLE_LAB === '1'
    && getTurnContext()?.suppressLearning === true;
  const labVerifierTurn = inheritedLabVerifierTurn;
  const suppressLearning = readOnlyTurn || labVerifierTurn;
  // Foreground verifier turns honor the dispatcher-authenticated 1..4 cap.
  // Detached verifier work gets two bounded extra rounds so a multi-step task
  // can correct one lookup and still produce a final answer.
  const requestedForegroundCap = labVerifierTurn
    && Number.isSafeInteger(turnOpts?.toolPlan?.maxProviderRequests)
    && turnOpts.toolPlan.maxProviderRequests >= 1
    && turnOpts.toolPlan.maxProviderRequests <= 4
    ? turnOpts.toolPlan.maxProviderRequests
    : 4;
  const verifierWorkerCompletion = labVerifierTurn
    && isolatedTaskRun
    && detachedTaskRun
    && readOnlyTurn
    && turnOpts?.toolPlan?.mode === 'none'
    && turnOpts.toolPlan.source === 'worker-completion'
    && turnOpts.toolPlan.maxProviderRequests === 1;
  const labProviderRequestCap = verifierWorkerCompletion
    ? 1
    : (labVerifierTurn && isolatedTaskRun && detachedTaskRun ? 6 : requestedForegroundCap);
  const workerMemoryOwnerId = workerStandingMemoryOwner(agent, turnOpts);
  const sessionUserText = typeof turnOpts?.sessionUserText === 'string'
    ? turnOpts.sessionUserText
    : userText;
  // Per-turn memory-scope tracker: records which service-role skills' tools run
  // this turn so a fact remembered mid-turn scopes to the skill that produced
  // it (see lib/memory-scope-context.mjs). enterWith here propagates through the
  // provider tool-loop to executeToolStreaming, same as toolRouterContext.
  beginMemoryScope();
  // Turn trace: interactive turns + inline delegation (ask_agent, specialist-
  // router) already have a store established by chat-dispatch / a parent
  // streamChat, which we inherit via ALS — this run just adds its span to it.
  // Direct callers that bypass the dispatcher (background tasks, scheduler,
  // run-agent-with-retry) have no store, so we lazily begin one here, seeding
  // rootId from the caller's rootTaskId so bg children join their originating
  // turn tree. We own (and must flush) the trace only when WE begin it.
  let _ownsTurnTrace = false;
  const _streamChatStart = Date.now();
  // A detached run (background/scheduled/ephemeral — signalled by rootTaskId or
  // traceSource in turnOpts) inherited the spawning turn's store via ALS, but it
  // must own a fresh root keyed on its task id. An inline run (specialist-router,
  // ask_agent) shares the dispatcher's async tree, so getTurn() returns the live
  // turn and we just add our span to it.
  const _detachedRun = detachedTaskRun;
  if (_detachedRun || !getTurn()) {
    beginTurn({
      userId,
      agentId: agent?.id ?? agent?.name ?? null,
      source: turnOpts?.traceSource || (voiceCtx?.source === 'voice-device' ? 'voice-device' : 'background'),
      rootId: turnOpts?.rootTaskId || null,
      forceRoot: _detachedRun,
      messageId: turnOpts?.messageId || null,
      attemptId: turnOpts?.attemptId || null,
      sessionKey: turnOpts?.sessionKey || null,
      sessionEpoch: turnOpts?.sessionEpoch || null,
    });
    _ownsTurnTrace = true;
  }
  // Async provider generators may resume outside the tool-router context. Pin
  // the authenticated spend ceiling to the turn trace before creating one.
  if (process.env.OPENENSEMBLE_LAB === '1') {
    setTurnLabProviderRequestCap(labProviderRequestCap);
  }
  // Routing/recipe key: when a delegation supplies an explicit `directive` (the
  // short "what the specialist must DO"), route + recover + learn on that rather
  // than the full task body riding along with it (a pasted briefing, doc, list).
  // Falls back to the user message; the scorer + recipe layer apply
  // instructionText() to whichever it gets.
  const routeText = (typeof turnOpts?.routeText === 'string' && turnOpts.routeText.trim())
    ? turnOpts.routeText.trim()
    : sessionUserText;
  // Per-turn tool routing: trim the coordinator's outbound tool list to the
  // always-on subset + on-demand skills whose intent_examples match this
  // user message. Other agents (specialists) are already tightly scoped and
  // skip the trim. The full pre-trim list is stashed on toolRouterContext so
  // the request_tools meta-tool can pull additional tools mid-turn when the
  // classifier missed. enterWith sets the AsyncLocalStorage for THIS async
  // context (and downstream awaits / tool dispatches), so the executor in
  // skills/coordinator/execute.mjs can reach it without us threading agent
  // refs through every provider's tool-loop call site.
  // Voice-device source/deviceId — exposed to skill executors via ALS so
  // verbose tools (email_list, email_read, …) can compact their output for
  // voice replies. Set even when voiceCtx fields are null so executors can
  // tell "called from a voice path" vs "called from web".
  if (voiceCtx) {
    voiceContext.enterWith({ source: voiceCtx.source ?? null, deviceId: voiceCtx.deviceId ?? null });
  }
  /** @type {{agent: any, fullTools: any[], initiallyIncludedSkills: Set<string>, keptSkills?: Set<string>, matchedSkills?: Set<string>, addedSkills: Set<string>, recoveryLoads?: any[], initialToolNames?: Set<string>, labVerifierForeground?: boolean, labProviderRequestCap?: number} | null} */
  let _routerStore = null;
  let _executionResolution = null;
  // A task must never create a task. On any autonomous run strip the task /
  // reminder / alarm creators BEFORE tool routing, so they're absent from the
  // recoverable set too (request_tools can't pull them back, and the reaction
  // prompt's "scheduled task" framing can't lead the model to a duplicate).
  if (isolatedTaskRun && Array.isArray(agent.tools)) {
    const before = agent.tools.length;
    agent.tools = agent.tools.filter(t => !AUTONOMOUS_TASK_CREATION_TOOLS.has(t.function?.name));
    agent.tools = filterWorkerLeafTools(agent.tools, agent, turnOpts);
    if (agent.tools.length !== before) {
      recomposeAgentPromptForTools(agent);
      log.info('chat', 'stripped autonomous/control-plane tools on isolated run', { agentId: agent.id, removed: before - agent.tools.length });
    }
  }
  const userToolPlanResult = applyUserToolPlan(agent, turnOpts?.toolPlan, userId);
  if (userToolPlanResult) {
    recomposeAgentPromptForTools(agent);
    // Populate the router store for ANY agent that still carries request_tools
    // under a plan — not just coordinators. Without this, a plan-constrained
    // specialist (e.g. an email agent pinned by a remembered sort/label recipe)
    // has no fullTools to recover from: request_tools dead-ends with "nothing to
    // add" and the missing-tool backstop never arms. fullTools holds the
    // pre-plan toolset, so recovery can pull a dropped compose/send tool back.
    if (agent.tools.some(t => t.function?.name === 'request_tools')) {
      const matchedSkills = new Set(executionSkillsForSelectedTools(userId, userToolPlanResult.selected));
      _routerStore = {
        agent,
        fullTools: userToolPlanResult.fullTools,
        initiallyIncludedSkills: new Set(),
        keptSkills: new Set(),
        matchedSkills,
        addedSkills: new Set(),
        recoveryLoads: [],
        initialToolNames: new Set((agent.tools ?? []).map(t => t.function?.name).filter(Boolean)),
        labVerifierForeground: labVerifierTurn,
        labProviderRequestCap,
      };
      toolRouterContext.enterWith(_routerStore);
    }
    log.info('chat', 'user tool plan applied', {
      userId, agentId: agent.id,
      mode: userToolPlanResult.mode,
      before: userToolPlanResult.before,
      after: userToolPlanResult.after,
      selected: userToolPlanResult.selected,
    });
  }
  // Per-turn tool routing runs for EVERY agent now — coordinators get the
  // skill-level gate + the tool-level pass; specialists get the tool-level pass
  // on their (already skill-scoped) set so e.g. an email agent asked to
  // "summarize" doesn't ship its labeling tools. trimToolsForTurn is a no-op
  // when the tool-level flag is off and the agent isn't a coordinator, so this
  // is safe to call unconditionally.
  // Kicked off here, consumed just below — the trim (embedding call) runs
  // concurrently with the other independent pre-LLM lookups (cortex recall,
  // trigger nudge, cross-agent reads, monitorable classify) started next.
  // The bookkeeping (agent.tools mutation, recompose, enterWith) happens at
  // the await point in THIS async context so the ALS store propagates to the
  // provider dispatch.
  const _trimPromise = (!userToolPlanResult && Array.isArray(agent.tools) && agent.tools.length > 0)
    ? trimToolsForTurn({ agent, userText: routeText, userId, source: voiceCtx?.source ?? null })
        .catch(e => { console.warn('[chat] tool-router trim failed, shipping full toolset:', e.message); return null; })
    : null;
  // Flush any deferred skill-proposal candidate from the prior turn. The
  // proposer stashes after qualifying multi-tool turns and only emits on the
  // next turn — so we can drop the candidate if the user's current message
  // is corrective. Fire-and-forget; failures here must never block chat.
  if (!suppressLearning && !agent.ephemeral && !silent) {
    import('../lib/skill-proposer.mjs')
      .then(m => m.flushPendingSkillCandidate({ agentId: agent.id, currentUserMessage: userText }))
      .catch(e => console.warn('[skill-proposer] flush failed:', e.message));
  }
  // Routine-proposer flush runs on EVERY non-silent turn — including
  // ephemeral specialist-router runs (Helen). On voice-device pipelines
  // every user turn lands in Helen ephemerally, so gating on !ephemeral
  // would mean the flush never fires for voice-only users. Keyed by userId.
  if (!suppressLearning && !silent && !workerMemoryOwnerId) {
    import('../lib/routine-proposer.mjs')
      .then(m => m.flushPendingRoutineCandidate({ userId, currentUserMessage: userText }))
      .catch(e => console.warn('[routine-proposer] flush failed:', e.message));
  }

  // Location-fact-proposer flush — same shape as skill-proposer: drop the
  // pending candidate if the new turn looks corrective, otherwise emit the
  // host-fact proposal bubble.
  if (!suppressLearning && !agent.ephemeral && !silent) {
    import('../lib/location-fact-proposer.mjs')
      .then(m => m.flushPendingLocationFact({ userId, agentId: agent.id, currentUserMessage: userText }))
      .catch(e => console.warn('[location-fact-proposer] flush failed:', e.message));
  }

  // Finance/email agents handle transactions and actions — skip memory signal processing.
  // Ephemeral agents (deep_research_parallel workers) are stateless one-shots — skip all memory ops.
  // Scheduler intercepts: when chat-dispatch.mjs's interceptScheduling fired and
  // produced a scheduler_result note, the user's turn was a scheduling request —
  // the scheduler DB owns that state, so don't duplicate it as a memory. Users
  // who want a behavior preference captured can state it in a separate turn.
  const schedulerFired = (systemNote ?? '').includes('<scheduler_result>');
  const skipSignals = suppressLearning || schedulerFired || agent.ephemeral || agent.skillCategory === 'finance' || agent.skillCategory === 'expenses' || agent.skillCategory === 'email';
  // General/manager agents: skip episode storage (task requests aren't useful memories)
  // but still run processSignals to capture genuine preferences/corrections
  const skipEpisodes = suppressLearning || schedulerFired || agent.ephemeral || agent.skillCategory === 'general';
  // ── Concurrent pre-LLM lookups ────────────────────────────────────────
  // Cortex recall, trigger nudge, cross-agent reads, and the monitorable
  // classifier are mutually independent and don't read agent.tools or
  // agent.systemPrompt — so they run concurrently with each other AND with
  // the tool-router trim kicked off above. Each catches internally so a
  // failure degrades to its previous behavior (empty block / null ctx).
  // Awaited below in the original consumption order; the awaits all sit
  // before the tier assembly, so prompt bytes are unchanged.

  // 1. Build rich cortex context (relevant memories, preferences, past episodes)
  // Expand deictic/pronominal queries ("tell me more about that") with recent context.
  // Generic ephemerals skip Cortex entirely. A detached worker may opt into
  // the narrower standing-memory contract only when its explicit stable owner
  // marker matches the request; episodes/history/cross-agent reads stay off.
  const NEEDS_CONTEXT_RE = /\b(that|this|it|those|these|there|the same|more about|what we|what you|yesterday|earlier|last time|before|again|continue|go on)\b/i;
  const _ctxPromise = (readOnlyTurn || (agent.ephemeral && !workerMemoryOwnerId)) ? Promise.resolve(null) : (async () => {
    let recallQuery = sessionUserText;
    if (!isolatedTaskRun && (sessionUserText.length < 50 || NEEDS_CONTEXT_RE.test(sessionUserText))) {
      const recentMsgs = (await loadSession(agent.id, 6)).filter(m => m.excludeFromModel !== true).slice(-4);
      if (recentMsgs.length) {
        const lastUser = recentMsgs.filter(m => m.role === 'user').slice(-1)[0];
        const lastAsst = recentMsgs.filter(m => m.role === 'assistant').slice(-1)[0];
        const ctx_parts = [lastUser?.content?.slice(0, 150), lastAsst?.content?.slice(0, 150)].filter(Boolean);
        if (ctx_parts.length) recallQuery = `${sessionUserText} [context: ${ctx_parts.join(' ')}]`;
      }
    }
    if (workerMemoryOwnerId) {
      return buildWorkerStandingMemoryContext({
        agent,
        turnOpts,
        userId,
        query: recallQuery,
        resolveOwnedAgent: async (ownerId, ownerUserId) => {
          const { getAgentForUser } = await import('../routes/_helpers.mjs');
          return getAgentForUser(ownerId, ownerUserId);
        },
        buildContext: buildAgentContext,
      }).catch(() => null);
    }
    return buildAgentContext(agent.id, recallQuery, userId, {
      includeEpisodes: !isolatedTaskRun,
      suppressLearning,
    }).catch(() => null);
  })();

  // Per-turn user-skill trigger nudge. Embedding-ranked when cortex is up
  // (top-K skills by cosine similarity to userText), all-triggers fallback
  // when not. Empty string for ephemeral agents and for users with no custom
  // skills — buildTriggerNudgeBlock handles both. Concatenated into the
  // system prompt below alongside memBlock.
  const _triggersPromise = (!suppressLearning && !agent.ephemeral && userId && userId !== 'default')
    ? (async () => {
        try {
          const { buildTriggerNudgeBlock } = await import('../lib/skill-triggers.mjs');
          return (await buildTriggerNudgeBlock(userId, sessionUserText)) || '';
        } catch (e) {
          console.debug('[skill-triggers] nudge build failed:', e.message);
          return '';
        }
      })()
    : Promise.resolve('');

  // Cross-agent context — let this agent see recent messages from other agents.
  // Skip for ephemeral agents: "ephemeral" means a hermetic run with no carried-over
  // context, and crossAgentRead would silently leak another agent's history.
  const _crossAgentPromise = (!readOnlyTurn && !isolatedTaskRun && !agent.ephemeral && agent.crossAgentRead?.length && userId && userId !== 'default')
    ? (async () => {
        const parts = [];
        for (const otherId of agent.crossAgentRead) {
          const recent = await loadCrossAgentContext(userId, otherId, 3);
          // Filter to only user/assistant messages (skip notifications, system)
          const useful = recent.filter(m => m.role === 'user' || m.role === 'assistant');
          if (useful.length) {
            const lines = useful.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n');
            parts.push(`### ${otherId}\n${lines}`);
          }
        }
        return parts.length ? `\n\n## Recent activity from other agents\n${parts.join('\n\n')}` : '';
      })().catch(e => { console.warn('[chat] cross-agent context failed:', e.message); return ''; })
    : Promise.resolve('');

  // Monitorable-intent classifier — embedding-based judge that fires when
  // the user's message looks like "any new X from Y?", "what's on sale at Z?",
  // "is the item back in stock?", etc. On a hit, a small per-user ledger
  // decides whether to ask once, suppress during cooldown, or escalate a
  // repeated topic into a proposal bubble.
  // Skipped for ephemeral agents (no value in one-shot research) and slash
  // commands. ~5-10ms when the cortex embedder is warm.
  // Only on genuine interactive human turns. Scheduled/background re-injection
  // turns (silent, isolated, or hidden-user) carry system payloads — e.g. the
  // scheduler's "Background work from your scheduled task has completed …
  // <scheduled_task>…</scheduled_task>" result block — which the embedding
  // judge would otherwise mistake for "a changing source the user keeps asking
  // about," escalating a giant internal prompt into a watch proposal. There is
  // also no human in the loop to see (let alone accept) the offer on these turns.
  const interactiveMonitorTurn = !suppressLearning && !silent && !isolatedTaskRun && turnOpts?.hiddenUser !== true;
  const _monitorablePromise = (interactiveMonitorTurn && !agent.ephemeral && userId && userId !== 'default' && sessionUserText && !sessionUserText.trim().startsWith('/'))
    ? (async () => {
        try {
          const { classifyMonitorable, buildMonitorableSystemNote, recordMonitorableHit } = await import('../lib/monitorable-classifier.mjs');
          const hit = await classifyMonitorable(sessionUserText);
          if (hit.monitorable) {
            const offer = await recordMonitorableHit({ userId, agentId: agent.id, userText: sessionUserText, hit });
            log.info('chat', 'monitorable intent detected', { userId, score: hit.score.toFixed(3), matched: hit.matched, action: offer.action, count: offer.count });
            if (offer.action === 'ask') return buildMonitorableSystemNote(hit);
          }
        } catch (e) {
          console.debug('[monitorable-classifier] failed:', e.message);
        }
        return '';
      })()
    : Promise.resolve('');

  // Now consume the trim. The bookkeeping runs HERE (not inside the promise)
  // so toolRouterContext.enterWith lands in streamChat's own async context and
  // propagates to the provider tool-loop. Must complete before basePrompt is
  // read below — recompose rewrites agent.systemPrompt.
  const _trimResult = _trimPromise ? await _trimPromise : null;
  // The pre-router filter is the primary boundary. Reapply it to both router
  // outputs as a fail-closed invariant so request_tools can never recover a
  // control-plane schema through fullTools after a router refactor or plugin
  // implementation returns a broader set than the agent it was given.
  const _trim = (_trimResult && workerMemoryOwnerId)
    ? {
        ..._trimResult,
        trimmedTools: filterWorkerLeafTools(_trimResult.trimmedTools, agent, turnOpts),
        fullTools: filterWorkerLeafTools(_trimResult.fullTools, agent, turnOpts),
      }
    : _trimResult;
  if (_trim) {
    const changed = _trim.trimmedTools.length !== _trim.fullTools.length;
    agent.tools = _trim.trimmedTools;
    // Stash the pre-trim set so request_tools can recover dropped tools — for
    // every agent, not just coordinators (specialists are trimmed too, so
    // they need the same recovery net). Only meaningful when the agent
    // actually carries request_tools, but harmless otherwise.
    _routerStore = {
      agent, fullTools: _trim.fullTools,
      // Empty by design when the tool-level pass applies, so request_tools can
      // recover a dropped tool from an otherwise-kept skill (recovery gate).
      initiallyIncludedSkills: _trim.initiallyIncludedSkills,
      // The skills actually kept this turn — for telemetry/learning, which
      // must NOT see the deliberately-empty recovery set above.
      keptSkills: _trim.skillsKept || _trim.initiallyIncludedSkills,
      // Execution profiles activate from positive intent, not merely from a
      // skill being always-on or shipped with this agent.
      matchedSkills: _trim.matchedSkills || new Set(),
      addedSkills: new Set(),
      recoveryLoads: [],
      initialToolNames: new Set((agent.tools ?? []).map(t => t.function?.name).filter(Boolean)),
      labVerifierForeground: labVerifierTurn,
      labProviderRequestCap,
    };
    toolRouterContext.enterWith(_routerStore);
    // Recompose the SPA portion of the system prompt against the trimmed
    // tool set only when the set actually changed — avoids needless work on
    // specialist turns the router left untouched. Three-tier path keeps the
    // stable tier byte-identical so Anthropic's cache marker keeps hitting.
    if (changed) recomposeAgentPromptForTools(agent);
    // Trimmed agents must ASK for a missing tool, not conclude the capability
    // doesn't exist (the failure mode behind the escalate-and-bounce loop).
    // Constant line appended after the SPA so the cached prefix stays stable.
    if (changed && (agent.tools ?? []).some(t => t.function?.name === 'request_tools')) {
      agent.systemPrompt += '\n\nTool visibility: you hold more tools than are shown this turn. If a tool you need is missing, call request_tools to load it — do not conclude a capability is unavailable, and do not delegate to another agent just to reach a tool you likely own.';
    }
    log.info('chat', 'tool-router trim', { userId, agentId: agent.id, category: agent.skillCategory, kept: _trim.trimmedTools.length, full: _trim.fullTools.length, notes: _trim.routerNotes, spChars: agent.systemPrompt.length });
  }

  // Freeze one provider/model/effort profile after routing. Later
  // request_tools recovery may add schemas, but never changes models midway
  // through a provider continuation.
  try {
    const planExecutionSkills = userToolPlanResult?.mode === 'selected'
      ? executionSkillsForSelectedTools(userId, userToolPlanResult.selected)
      : [];
    const executionSkillIds = [...new Set([
      ...(_routerStore?.matchedSkills ?? _trim?.matchedSkills ?? []),
      ...planExecutionSkills,
    ])];
    if (agent.skillCategory && agent.skillCategory !== 'general'
        && !executionSkillIds.includes(agent.skillCategory)) {
      executionSkillIds.push(agent.skillCategory);
    }
    _executionResolution = await resolveValidatedSkillExecutionForTurn({
      userId,
      baseAgent: agent,
      selectedSkillIds: executionSkillIds,
      allowedModels: userAllowedExecutionModels(userId),
      // Worker and foreground turns both pass the user-facing job text here so
      // task-shape effort priors apply when no skill supplies effort.
      routeText: typeof routeText === 'string' ? routeText : (typeof userText === 'string' ? userText : null),
    });
    if (_executionResolution.applied) {
      const providerOrModelChanged = _executionResolution.effective.provider !== agent.provider
        || _executionResolution.effective.model !== agent.model;
      agent = {
        ...agent,
        provider: _executionResolution.effective.provider,
        model: _executionResolution.effective.model,
        ...(Object.hasOwn(_executionResolution.effective, 'reasoningEffort')
          ? { reasoningEffort: _executionResolution.effective.reasoningEffort }
          : {}),
        ...(providerOrModelChanged ? { contextSize: null } : {}),
        _skillExecutionApplied: true,
        _skillExecutionSource: _executionResolution.sourceKinds || null,
      };
      if (_routerStore) _routerStore.agent = agent;
      log.info('chat', 'skill execution profile applied', {
        userId,
        agentId: agent.id,
        selectedSkills: executionSkillIds,
        modelSkill: _executionResolution.sourceSkillIds.model,
        effortSkill: _executionResolution.sourceSkillIds.reasoningEffort,
        modelSource: _executionResolution.sourceKinds?.model || null,
        effortSource: _executionResolution.sourceKinds?.reasoningEffort || null,
        reason: _executionResolution.reason,
        provider: agent.provider,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort ?? 'auto',
      });
    }
  } catch (error) {
    log.warn('chat', 'skill execution override resolution failed; using agent defaults', {
      userId, agentId: agent.id, error: error?.message || String(error),
    });
  }

  // Provider-hosted image generation is an implementation swap, never an
  // ambient capability grant. The Responses adapter additionally requires the
  // current (possibly tool-plan constrained or request_tools-expanded) surface
  // to contain generate_image before it injects the hosted tool.
  agent._providerHostedImageBackend = shouldUseProviderHostedImageBackend(agent, userId);

  const ctx = await _ctxPromise;
  const memBlock = ctx ? formatContext(ctx) : '';
  const skillTriggersBlock = await _triggersPromise;

  // Inject current name so renaming takes effect in the LLM's self-awareness.
  // Anthropic models are trained to always identify as Claude — skip for them.
  const nameHeader = agent.provider !== 'anthropic'
    ? `Your name is ${agent.name}. You are ${agent.name}. Always refer to yourself as ${agent.name}, never by any other name.\n\n`
    : '';
  const basePrompt = `${nameHeader}${agent.systemPrompt}`;
  const userIdBlock = (agent.skillCategory === 'finance' || agent.skillCategory === 'expenses') && userId && userId !== 'default'
    ? `\n\nCurrent user ID: ${userId}` : '';
  let userEmailBlock = '';
  if (agent.skillCategory === 'email' && userId && userId !== 'default') {
    try {
      const userPath = path.join(USERS_DIR, userId, 'profile.json');
      if (existsSync(userPath)) {
        const user = JSON.parse(readFileSync(userPath, 'utf8'));
        if (user?.email) userEmailBlock = `\n\nUser's email address: ${user.email}`;
      }
    } catch { /* ignore */ }
  }
  // 1b. Cross-agent context — kicked off above, awaited here.
  const crossAgentBlock = await _crossAgentPromise;

  // systemNote: one-shot directive from the dispatcher (e.g. scheduler-intent
  // outcome). Goes into the system prompt — not userText — so the UI doesn't
  // render it and the session doesn't persist it into history.
  const noteBlock = systemNote ? `\n\n${systemNote}` : '';
  const userToolPlanBlock = buildUserToolPlanSystemBlock(agent, userToolPlanResult);
  const desktopFoldersBlock = buildDesktopFoldersBlock(userId, voiceCtx?.source);
  const triggerSuffix = skillTriggersBlock ? `\n\n${skillTriggersBlock}` : '';

  // Monitorable-intent classifier — kicked off above, awaited here.
  const monitorableBlock = await _monitorablePromise;
  // Three-tier assembly for cache_control-aware providers (Anthropic).
  // Other providers concatenate the same three strings into systemPrompt
  // and ignore the tiers field — byte-identical to the legacy path.
  //
  //   stable    — agent persona + guidance + nameHeader + per-agent-type
  //               appendages (userId/email/finance/voice). Reused across
  //               all turns within a session unless agent metadata changes.
  //   context   — SPA block (recomposes when the tool-router trims). Sits
  //               between stable and volatile so the stable cache marker
  //               keeps hitting when context shifts.
  //   volatile  — date block (seeded in chat-dispatch.mjs) + per-turn
  //               additions: cortex recall, cross-agent activity, skill
  //               triggers, scheduler/resolved note, monitorable hint.
  //               Never cacheable.
  const _tiers = agent._promptTiers;
  // Per-agent-type stable appendages — these don't change per turn so they
  // belong in the stable tier when the tier path is available.
  const stableAppend = `${userIdBlock}${userEmailBlock}`;
  // Per-turn volatile additions — order matches the legacy concatenation
  // so the byte sequence under non-Anthropic providers is unchanged.
  // (memBlock previously inserted between userEmail and crossAgent with a
  // leading "\n\n"; preserve that boundary in the volatile string.)
  const _volatileFromTurn = `${memBlock ? '\n\n' + memBlock : ''}${crossAgentBlock}${triggerSuffix}${noteBlock}${userToolPlanBlock}${desktopFoldersBlock}${monitorableBlock}`;
  let systemPrompt;
  if (_tiers) {
    // The agent.systemPrompt that chat-dispatch built already includes
    // stable + context + volatile-seed concatenated. To rebuild from
    // tiers we need each part standalone — pull from _tiers directly.
    // Volatile = the seed (date block) + this-turn additions.
    const stableTier = `${nameHeader}${_tiers.stable}${stableAppend}`;
    const contextTier = _tiers.context || '';
    const volatileTier = `${_tiers.volatile || ''}${_volatileFromTurn}`;
    // Stash on agent so the provider can read them after streamChat
    // dispatches into provider.mjs. Underscored = internal.
    agent._promptTiersAssembled = { stable: stableTier, context: contextTier, volatile: volatileTier };
    systemPrompt = [stableTier, contextTier, volatileTier].filter(Boolean).join('\n\n');
  } else {
    systemPrompt = memBlock
      ? `${basePrompt}${userIdBlock}${userEmailBlock}\n\n${memBlock}${crossAgentBlock}${triggerSuffix}${noteBlock}${userToolPlanBlock}${desktopFoldersBlock}${monitorableBlock}`
      : `${basePrompt}${userIdBlock}${userEmailBlock}${crossAgentBlock}${triggerSuffix}${noteBlock}${userToolPlanBlock}${desktopFoldersBlock}${monitorableBlock}`;
  }

  // 2. Build message history (strip ts field — Ollama doesn't want it).
  // Filter out UI-only role types — `status` (watcher progress bubbles),
  // `proposal` and `proposal_outcome` (friction-as-proposer bubbles),
  // `notification`. Providers (OpenAI especially) reject unknown roles with
  // a 400, and these entries carry no LLM-actionable content anyway.
  //
  // Assistant entries persisted with tool metadata are reconstructed as real
  // protocol messages by buildLlmHistory(): assistant tool_calls, matching
  // tool outputs, then the visible answer. This keeps provenance out of
  // ordinary assistant prose while retaining handles needed by follow-ups.
  // `via:` remains a coordinator-routing note because it is not a tool call.
  const LLM_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
  const _histSrc = isolatedTaskRun ? [] : (await loadSession(agent.id)).filter(m =>
    LLM_ROLES.has(m.role) && m.excludeFromModel !== true);
  const history = buildLlmHistory(_histSrc);

  // For session storage, store text only (no base64 — too large and not replayable).
  // For audio/video attachments, also surface the on-disk path so the LLM's
  // transcribe_file tool can act on the file without first calling
  // list_profile_files to look up the doc id. Images/PDFs/CSVs continue
  // through their existing inline-text / inline-vision paths above. One note
  // per attachment, in upload order — a multi-file turn (e.g. two receipts
  // and a photo) gets a note for each rather than only the first.
  let getProfileFilePathForNotes = null;
  const attachmentNotes = [];
  for (const a of attachments) {
    let note = `[Attached: ${a.name}]`;
    if (a?.file_id && typeof a.mimeType === 'string') {
      const mime = a.mimeType.toLowerCase();
      if (mime.startsWith('audio/') || mime.startsWith('video/')) {
        if (!getProfileFilePathForNotes) ({ getProfileFilePath: getProfileFilePathForNotes } = await import('../lib/profile-files.mjs'));
        const filePath = getProfileFilePathForNotes(userId, a.file_id);
        if (filePath) {
          const kind = mime.startsWith('audio/') ? 'audio' : 'video';
          note = `[Attached ${kind} "${a.name}" saved at ${filePath} — call transcribe_file with that path to read it]`;
        }
      }
    }
    attachmentNotes.push(note);
  }
  const sessionText = attachmentNotes.length ? `${attachmentNotes.join('\n')}\n${sessionUserText}`.trim() : sessionUserText;

  // Working copy for the tool loop (no ts fields).
  // Trim history if it gets too long — rough token estimate: 1 token ≈ 4 chars.
  // Budget = 55% of the agent's context window minus tool schema overhead,
  // leaving the rest for system prompt, current turn, tools, and model response.
  //
  // Tool size: real per-turn measurement of the coordinator showed ~735 bytes
  // per tool (≈ 184 tokens), not the 60 tokens this calc used to assume.
  // Underestimating by 3× pushed every coordinator turn over budget and
  // caused trimmed-history to drop to zero. Compute from the actual schema
  // bytes — one JSON.stringify at turn boundary, not in the tool loop.
  // Resolve the model's actual context window. agent.contextSize wins when
  // explicitly set; otherwise fall back to a model-name lookup; otherwise
  // a conservative 128k modern-model floor (the old 32k default was a
  // pre-128k-default assumption and now drops history entirely for
  // tool-heavy specialists: with 103 tools ≈ 19k tool tokens,
  // 32k×0.55 − 19k = NEGATIVE, so the budget clamps to 1000 and everything
  // in history gets trimmed.).
  const ctxWindow  = agent.contextSize ?? _modelContextWindow(agent.model) ?? 131072;
  const toolsBytes = JSON.stringify(agent.tools ?? []).length;
  const toolTokens = Math.ceil(toolsBytes / 4);
  const TOKEN_BUDGET = Math.max(1000, Math.floor(ctxWindow * 0.55) - toolTokens);
  let trimmed = [...history];
  let approxTokens = (systemPrompt.length + userText.length) / 4;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    approxTokens += historyMessageChars(trimmed[i]) / 4;
    if (approxTokens > TOKEN_BUDGET) { trimmed = trimmed.slice(i + 1); break; }
  }
  // Anthropic requires the first message to be role:user; an arbitrary trim
  // index can leave an assistant (or orphaned partial) message first, which
  // 400s the request exactly when the conversation gets long. Drop leading
  // non-user entries after a trim.
  if (trimmed.length < history.length) {
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  }
  const droppedFromHistory = Math.max(0, history.length - trimmed.length);
  // Canonical OpenAI-style messages keep trimming pair-safe (`tool` can never
  // become a leading user turn). Adapt only after trimming: Anthropic uses a
  // user/tool_result block and Ollama requires object-valued arguments.
  trimmed = adaptLlmHistoryForProvider(trimmed, agent.provider);

  // Pre-LLM size snapshot — measurement-only, surfaced on the
  // "llm turn complete" log line so we can audit prompt/tools/history
  // bloat without re-running the request. Cheap (no JSON.stringify in the
  // hot tool loop, just at turn boundaries).
  const _sizes = {
    spChars: systemPrompt.length,
    toolsBytes,
    toolCount: agent.tools?.length ?? 0,
    historyMsgs: trimmed.length,
    historyBytes: trimmed.reduce((n, m) => n + historyMessageChars(m), 0),
    droppedFromHistory,
    userTextChars: userText.length,
  };

  // Build the current user turn — include image data for every attachment
  // that carries inline base64 (images only; see /api/chat-upload, base64 is
  // populated exclusively for isImage uploads).
  const currentUserTurn = buildCurrentUserTurn(agent, userText, attachments);

  const working = [...trimmed, currentUserTurn];

  const buildProviderGen = (agentObj, prompt, messages) => {
    const compatProviderKey = agentObj.provider === 'grok' ? 'xai' : agentObj.provider;
    if (agentObj.provider === 'anthropic') {
      return { providerGen: streamAnthropic(agentObj, prompt, messages, signal, userId), withSignalWordsGate: true };
    }
    if (agentObj.provider === 'openrouter') {
      return { providerGen: streamOpenRouter(agentObj, prompt, messages, signal, userId), withSignalWordsGate: false };
    }
    // grok native web search lives ONLY on xAI's Responses API (/v1/responses),
    // not /chat/completions. When a grok agent holds web_search, route it to the
    // shared Responses adapter (same one Codex uses; it switches on provider) so
    // the search runs server-side in one round-trip. grok agents WITHOUT
    // web_search stay on the /chat/completions (openai-compat) path below.
    const grokNativeSearch = (agentObj.provider === 'grok' || agentObj.provider === 'xai')
      && agentObj.tools?.some(t => (t.function?.name ?? t.name) === 'web_search');
    // SuperGrok OAuth always uses the Responses adapter (CLI chat proxy).
    // API-key Grok only switches when native web_search is needed.
    if (agentObj.provider === 'openai-oauth' || agentObj.provider === 'xai-oauth' || grokNativeSearch) {
      return { providerGen: streamOpenAIResponses(agentObj, prompt, messages, signal, userId), withSignalWordsGate: false };
    }
    if (OPENAI_COMPAT_PROVIDERS[compatProviderKey]) {
      return { providerGen: streamOpenAICompat(compatProviderKey, agentObj, prompt, messages, signal, userId), withSignalWordsGate: false };
    }
    if (agentObj.provider === 'lmstudio') {
      // Same (messages) signature as the other providers so the prepared vision
      // turn + trimmed history reach LM Studio; the adapter keeps the stateful
      // native path only for the no-tools/no-attachment case.
      return { providerGen: streamLMStudio(agentObj, prompt, messages, signal, userId), withSignalWordsGate: false };
    }
    return { providerGen: streamOllama(agentObj, prompt, messages, signal, userId), withSignalWordsGate: false };
  };

  const recomposeSystemPromptForCurrentTools = () => {
    if (agent._promptTiers && agent._composerInputs) {
      const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
      agent._promptTiers = { ...agent._promptTiers, context: newSpa || '' };
      const stableTier = `${nameHeader}${agent._promptTiers.stable}${stableAppend}`;
      const contextTier = agent._promptTiers.context || '';
      const volatileTier = `${agent._promptTiers.volatile || ''}${_volatileFromTurn}`;
      agent._promptTiersAssembled = { stable: stableTier, context: contextTier, volatile: volatileTier };
      systemPrompt = [stableTier, contextTier, volatileTier].filter(Boolean).join('\n\n');
    } else if (agent._systemPromptShell && agent._composerInputs) {
      const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
      agent.systemPrompt = agent._systemPromptShell.replace('%%SKILL_SPAS%%', newSpa);
      systemPrompt = `${nameHeader}${agent.systemPrompt}${stableAppend}${_volatileFromTurn}`;
    }
  };

  // ── Grok video/image generation branch ──────────────────────────────────────
  // Only routes to the media endpoints if the model name indicates image/video
  // generation. Chat models (grok-4, grok-3, etc.) fall through to the generic
  // OpenAI-compat dispatcher under the 'xai' provider alias below.
  const grokModelLower = (agent.model ?? '').toLowerCase();
  const isGrokMedia = agent.provider === 'grok' && (grokModelLower.includes('image') || grokModelLower.includes('video') || grokModelLower.includes('imagine'));
  if (isGrokMedia) {
    const key = getGrokKey();
    if (!key) { yield { type: 'error', message: 'Grok API key not configured. Add it in Settings → Providers.' }; return; }

    // ── Video generation ───────────────────────────────────────────────────
    if (agent.model?.toLowerCase().includes('video')) {
      const model  = agent.model;
      const prompt = userText || 'A beautiful scene';

      yield { type: 'token', text: 'Generating video…' };

      const initRes = await fetch('https://api.x.ai/v1/videos/generations', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ model, prompt }),
      });
      if (!initRes.ok) { yield { type: 'error', message: `Grok error ${initRes.status}: ${await initRes.text()}` }; return; }
      const initData = await initRes.json();
      console.log('[grok-video] init response:', JSON.stringify(initData));
      const request_id = initData.id ?? initData.request_id;
      if (!request_id) { yield { type: 'error', message: `Grok returned no request ID. Response: ${JSON.stringify(initData)}` }; return; }

      // Poll until done (up to 10 minutes), reporting progress
      let videoUrl = null;
      let lastProgress = -1;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 5000));
        const pollRes = await fetch(`https://api.x.ai/v1/videos/${request_id}`, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal,
        });
        if (!pollRes.ok) {
          const errText = await pollRes.text();
          console.log('[grok-video] poll error:', pollRes.status, errText);
          yield { type: 'error', message: `Grok poll error ${pollRes.status}: ${errText}` }; return;
        }
        const pollData = await pollRes.json();
        if (pollData.error) { yield { type: 'error', message: `Video generation failed: ${pollData.error.message}` }; return; }
        if (pollData.progress != null && pollData.progress !== lastProgress) {
          yield { type: 'replace', text: `Generating video… ${pollData.progress}%` };
          lastProgress = pollData.progress;
        }
        if (pollData.status === 'done') {
          videoUrl = pollData.video?.url ?? null;
          if (!videoUrl) { yield { type: 'error', message: 'Video generation blocked by moderation.' }; return; }
          break;
        }
      }
      if (!videoUrl) { yield { type: 'error', message: 'Video generation timed out.' }; return; }

      const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
      const filename = `${slug || 'video'}_${Date.now()}.mp4`;

      let savedPath = null;
      let serverSavedPath = null;
      try {
        const videoSaveDir = getUserFilesDir(userId, 'videos');
        const vidRes = await fetch(videoUrl, { signal });
        serverSavedPath = path.join(videoSaveDir, filename);
        writeFileSync(serverSavedPath, Buffer.from(await vidRes.arrayBuffer()));
        savedPath = serverSavedPath;
      } catch (e) {
        console.warn('[grok-video] Failed to save video:', e.message);
      }
      const desktopSavedPath = await saveDesktopArtifact(userId, {
        source: voiceCtx?.source,
        sandbox: 'videos',
        filename,
        url: videoUrl,
        timeoutMs: 300_000,
      });
      if (desktopSavedPath) {
        if (serverSavedPath) {
          try { unlinkSync(serverSavedPath); } catch {}
        }
        savedPath = desktopSavedPath;
      }

      if (!silent) {
        try {
          await appendToSession(agent.id,
            { role: 'user', content: userText, ts: Date.now() },
            { role: 'assistant', video: { url: videoUrl, filename }, content: `[Video: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
          );
        } catch (e) {
          console.warn('[chat] video persist failed:', e.message);
          yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'The video was generated, but the chat turn could not be saved. Reload before trying again.' };
          return;
        }
      }
      yield { type: 'video', url: videoUrl, filename, savedPath, prompt };
      yield { type: 'done' };
      return;
    }

    // ── Image generation ───────────────────────────────────────────────────
    const model  = agent.model ?? 'grok-imagine-image';
    const prompt = userText || 'A beautiful image';

    const r = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json' }),
    });
    if (!r.ok) { yield { type: 'error', message: `Grok error ${r.status}: ${await r.text()}` }; return; }
    const data = await r.json();
    let base64 = data.data?.[0]?.b64_json;
    if (!base64) { yield { type: 'error', message: 'Grok returned no image data.' }; return; }
    if (base64.includes(',')) base64 = base64.split(',')[1];
    const mimeType = 'image/jpeg';

    const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
    const filename = `${slug || 'image'}_${Date.now()}.jpg`;

    let savedPath = null;
    let serverSavedPath = null;
    try {
      const grokImgDir = getUserFilesDir(userId, 'images');
      serverSavedPath = path.join(grokImgDir, filename);
      writeFileSync(serverSavedPath, Buffer.from(base64, 'base64'));
      savedPath = serverSavedPath;
    } catch (e) {
      console.warn('[grok] Failed to save image:', e.message);
    }
    const desktopSavedPath = await saveDesktopArtifact(userId, {
      source: voiceCtx?.source,
      sandbox: 'images',
      filename,
      base64,
    });
    if (desktopSavedPath) {
      if (serverSavedPath) {
        try { unlinkSync(serverSavedPath); } catch {}
      }
      savedPath = desktopSavedPath;
    }

    if (!silent) {
      try {
        await appendToSession(agent.id,
          { role: 'user', content: userText, ts: Date.now() },
          { role: 'assistant', image: { base64, mimeType, filename }, content: `[Image: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
        );
      } catch (e) {
        console.warn('[chat] image persist failed:', e.message);
        yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'The image was generated, but the chat turn could not be saved. Reload before trying again.' };
        return;
      }
    }
    yield { type: 'image', base64, mimeType, prompt, filename, savedPath };
    yield { type: 'done' };
    return;
  }

  // ── Fireworks image generation branch ───────────────────────────────────────
  if (agent.provider === 'fireworks') {
    const key = getFireworksKey();
    if (!key) { yield { type: 'error', message: 'Fireworks API key not configured. Add it in Settings → Providers.' }; return; }

    const model  = agent.model ?? 'flux-1-schnell-fp8';
    const prompt = userText || 'A beautiful image';
    const isFlux  = model.startsWith('flux');
    const isAsync = model.includes('kontext');
    let base64, mimeType = 'image/jpeg';

    if (!isFlux) {
      // SD/Playground/Segmind: /inference/v1/image_generation/... returns binary image directly
      const url = `https://api.fireworks.ai/inference/v1/image_generation/accounts/fireworks/models/${model}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'image/jpeg' },
        signal,
        body: JSON.stringify({ prompt, num_inference_steps: 30, guidance_scale: 7, width: 1024, height: 1024 }),
      });
      if (!r.ok) { yield { type: 'error', message: `Fireworks error ${r.status}: ${await r.text()}` }; return; }
      mimeType = r.headers.get('content-type') ?? 'image/jpeg';
      const buf = await r.arrayBuffer();
      base64 = Buffer.from(buf).toString('base64');
    } else if (!isAsync) {
      // Synchronous Flux: flux-1-schnell-fp8, flux-1-dev-fp8
      mimeType = 'image/png';
      const r = await fetch(`${FIREWORKS_BASE}/${model}/text_to_image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        signal,
        body: JSON.stringify({ prompt, aspect_ratio: agent.aspectRatio ?? '1:1' }),
      });
      if (!r.ok) { yield { type: 'error', message: `Fireworks error ${r.status}: ${await r.text()}` }; return; }
      const data = await r.json();
      base64 = Array.isArray(data.base64) ? data.base64[0] : data.base64;
      if (!base64) { yield { type: 'error', message: 'Fireworks returned no image data.' }; return; }
    } else {
      // Async: flux-kontext-pro / flux-kontext-max — image-edit takes exactly
      // one base image, so a multi-attachment turn uses only the first.
      const body = { prompt };
      if (attachment0?.base64) body.input_image = `data:${attachment0.mimeType};base64,${attachment0.base64}`;
      const r = await fetch(`${FIREWORKS_BASE}/${model}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body),
      });
      if (!r.ok) { yield { type: 'error', message: `Fireworks error ${r.status}: ${await r.text()}` }; return; }
      const { request_id } = await r.json();
      if (!request_id) { yield { type: 'error', message: 'Fireworks did not return a request ID.' }; return; }

      // Poll get_result until ready (max ~5 min, 3s interval)
      // "Task not found" is normal while the job queues — keep retrying for the full duration
      const pollUrl = `${FIREWORKS_BASE}/${model}/get_result`;
      let result = null;
      for (let i = 0; i < 100; i++) {
        await new Promise(res => setTimeout(res, 3000));
        if (signal?.aborted) return;
        const pr = await fetch(pollUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: request_id }),
        });
        const st = await pr.json();
        console.log(`[fireworks] poll ${i + 1}: status=${st.status ?? JSON.stringify(st).slice(0, 80)}`);
        if (st.status === 'Ready') { result = st.result; break; }
        if (st.status === 'Task not found') continue; // still queuing
        if (['Error', 'Request Moderated', 'Content Moderated'].includes(st.status)) {
          yield { type: 'error', message: `Fireworks: ${st.status}` }; return;
        }
      }
      if (!result) { yield { type: 'error', message: 'Fireworks image generation timed out after 5 minutes.' }; return; }

      // result may be a URL string, base64 string, { base64: [...] }, or Kontext-style { sample: url, ... }
      const sampleUrl = result?.sample ?? (typeof result === 'string' && result.startsWith('http') ? result : null);
      if (sampleUrl) {
        const imgRes = await fetch(sampleUrl);
        if (!imgRes.ok) { yield { type: 'error', message: `Fireworks: failed to fetch image (${imgRes.status})` }; return; }
        const buf = await imgRes.arrayBuffer();
        base64 = Buffer.from(buf).toString('base64');
        mimeType = imgRes.headers.get('content-type') ?? 'image/jpeg';
      } else if (typeof result === 'string') {
        base64 = result.includes(',') ? result.split(',')[1] : result;
      } else {
        base64 = Array.isArray(result?.base64) ? result.base64[0] : result?.base64;
        if (!base64) { yield { type: 'error', message: 'Fireworks: unexpected result format — no image URL or base64 found.' }; return; }
      }
    }

    // Strip any data-URL prefix that may have leaked through
    if (typeof base64 === 'string' && base64.includes(',')) base64 = base64.split(',')[1];

    const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
    const filename = `${slug || 'image'}_${Date.now()}.png`;

    let savedPath = null;
    let serverSavedPath = null;
    try {
      const fwImgDir = getUserFilesDir(userId, 'images');
      serverSavedPath = path.join(fwImgDir, filename);
      writeFileSync(serverSavedPath, Buffer.from(base64, 'base64'));
      savedPath = serverSavedPath;
    } catch (e) {
      console.warn('[fireworks] Failed to save image:', e.message);
    }
    const desktopSavedPath = await saveDesktopArtifact(userId, {
      source: voiceCtx?.source,
      sandbox: 'images',
      filename,
      base64,
    });
    if (desktopSavedPath) {
      if (serverSavedPath) {
        try { unlinkSync(serverSavedPath); } catch {}
      }
      savedPath = desktopSavedPath;
    }

    if (!silent) {
      try {
        await appendToSession(agent.id,
          { role: 'user', content: userText, ts: Date.now() },
          { role: 'assistant', image: { base64, mimeType, filename }, content: `[Image: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
        );
      } catch (e) {
        console.warn('[chat] image persist failed:', e.message);
        yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'The image was generated, but the chat turn could not be saved. Reload before trying again.' };
        return;
      }
    }
    yield { type: 'image', base64, mimeType, prompt, filename, savedPath };
    yield { type: 'done' };
    return;
  }

  // ── Chat-provider dispatch ──────────────────────────────────────────────────
  // Each branch forwards events via consumeProvider, captures __content, then
  // persists + runs memory signals through persist().
  let { providerGen, withSignalWordsGate } = buildProviderGen(agent, systemPrompt, working);

  const _llmStart = Date.now();
  // Stream the first draft live (previously buffered until end-of-turn). If a
  // recovery fires below, the live draft is wiped with a short honest notice and
  // replaced with the corrected reply. `canRecover` only gates whether the
  // recovery passes run — it no longer suppresses streaming.
  const canRecover = Boolean(_routerStore);
  let { assistantContent, errored, toolsUsed, toolEvents, toolIdentityAnomalies, modelCalls, hideTurn, hideTaskId, usage, turnImages } = yield* bindToolRouterContext(
    consumeProvider(providerGen, { suppressText: false }),
    _routerStore,
  );
  let recoveredMissingTools = false;
  if (!errored && canRecover && !hideTurn && toolsUsed.length === 0 && MISSING_TOOL_REPLY_RE.test(assistantContent || '')) {
    const missingSkills = inferMissingToolSkills({ userText: routeText, assistantText: assistantContent, userId });
    for (const skillId of [...missingSkills]) {
      if (_routerStore.initiallyIncludedSkills.has(skillId) || _routerStore.addedSkills.has(skillId)) missingSkills.delete(skillId);
    }
    if (missingSkills.size) {
      const { addedToolNames, addedSkills } = await expandToolsByReason({
        agent,
        fullTools: _routerStore.fullTools,
        reason: `Recover from missing-tool reply for: ${routeText}`,
        groups: [...missingSkills],
        userId,
        alreadyIncludedSkills: _routerStore.initiallyIncludedSkills,
      });
      for (const s of addedSkills) _routerStore.addedSkills.add(s);
      _routerStore.recoveryLoads?.push({
        source: 'automatic_missing_reply',
        requestedGroups: [...missingSkills],
        addedSkills: [...addedSkills],
        addedToolNames: [...addedToolNames],
      });
      const availableActionToolNames = (agent.tools ?? [])
        .map(t => t.function?.name)
        .filter(n => n && !RECOVERY_NOTE_EXCLUDED_TOOLS.has(n) && n !== 'ask_agent');
      if (addedToolNames.length || availableActionToolNames.length) {
        recoveredMissingTools = true;
        if (addedToolNames.length) recomposeSystemPromptForCurrentTools();
        const retryToolNames = addedToolNames.length ? addedToolNames : availableActionToolNames.slice(0, 12);
        log.info('chat', 'tool-miss recovery retry', {
          userId, agentId: agent.id, skills: addedSkills.length ? addedSkills : [...missingSkills], tools: retryToolNames,
          originalReply: String(assistantContent || '').slice(0, 240),
        });
        const retryNote = `\n\n[System note: Your prior draft said you lacked a tool. The server has verified these tools are available for this same user request: ${retryToolNames.join(', ')}. Use the appropriate tool now if needed; do not repeat the missing-tool apology unless the tool call actually fails.]`;
        const recoveryMessages = [...trimmed, withRetryNote(currentUserTurn, retryNote)];
        // Emit the notice as a TOKEN, not a replace: voice devices TTS only
        // token/done events (ws-handler.mjs:1021), so a replace would be silent
        // on voice. As a token it reaches both surfaces — the browser renders it,
        // the device speaks it — then the corrected reply streams live after it.
        yield { type: 'token', text: `\n\n${MISSING_TOOL_NOTICE}\n\n` };
        ({ providerGen, withSignalWordsGate } = buildProviderGen(agent, systemPrompt, recoveryMessages));
        {
          const _priorUsage = usage;
          const _priorModelCalls = modelCalls;
          const _priorToolIdentityAnomalies = toolIdentityAnomalies;
          const _r = yield* bindToolRouterContext(consumeProvider(providerGen, {
            suppressText: false,
            providerCallOrdinalOffset: _priorModelCalls?.length ?? 0,
          }), _routerStore);
          ({ assistantContent, errored, toolsUsed, toolEvents, toolIdentityAnomalies, hideTurn, hideTaskId } = _r);
          usage = mergeProviderUsage(_priorUsage, _r.usage);
          modelCalls = [...(_priorModelCalls || []), ...(_r.modelCalls || [])];
          turnImages = [...(turnImages || []), ...(_r.turnImages || [])];
          toolIdentityAnomalies = [
            ...(_priorToolIdentityAnomalies || []),
            ...(toolIdentityAnomalies || []),
          ];
        }
      }
    }
  }
  // Truthfulness gate for background-work status claims. After a restart kills
  // an in-flight delegation, the coordinator's session still contains its own
  // "I'll let you know when it's done" promise — and it will re-assert
  // "already in progress" from that memory without ever calling check_workers.
  // If a buffered draft claims work is pending and NO status-bearing tool ran
  // this turn, don't just nudge it to check: the ground truth is in-process,
  // so inject the server-verified status and re-run once. Skipped for
  // isolatedTaskRun — a specialist reporting on its own in-flight work
  // mid-delegation is not making a checkable claim about background tasks.
  let recoveredProgressClaim = false;
  // Gate on toolsUsed.length === 0 (mirroring the missing-tool recovery above):
  // re-running the turn re-executes any tool the first draft already called, so
  // a "Sent — I'll let you know" reply after email_send would re-send the email.
  // Zero tools on the first attempt means the claim came purely from memory and
  // a re-run is side-effect-free. (This also subsumes the old background-status
  // exemption: any status tool would make length > 0 and skip the recovery.)
  if (!errored && canRecover && !recoveredMissingTools && !hideTurn && !isolatedTaskRun
      && IN_PROGRESS_REPLY_RE.test(assistantContent || '')
      && toolsUsed.length === 0) {
    try {
      const { describeBackgroundWorkForSession } = await import('../background-tasks.mjs');
      const verified = describeBackgroundWorkForSession(userId, agent.id);
      log.info('chat', 'in-progress claim recovery retry', {
        userId, agentId: agent.id, verified: verified.slice(0, 240),
        originalReply: String(assistantContent || '').slice(0, 240),
      });
      const retryNote = `\n\n[System note: Your prior draft claimed background work was in progress (or promised a follow-up), but no status tool was called this turn. The server checked directly. Verified background-work status: ${verified}\nAnswer from ONLY this verified status. If a task is not listed as running, it is NOT running — a server restart cancels in-flight tasks; if that happened, say so plainly and offer to start it again. If your claim was about something other than delegated/background tasks, disregard this note and answer as before.]`;
      const recoveryMessages = [...trimmed, withRetryNote(currentUserTurn, retryNote)];
      // Token, not replace — voice devices only TTS token/done (see above), so
      // the notice + corrected reply both stream as tokens to reach voice + text.
      yield { type: 'token', text: `\n\n${IN_PROGRESS_NOTICE}\n\n` };
      ({ providerGen, withSignalWordsGate } = buildProviderGen(agent, systemPrompt, recoveryMessages));
      // Preserve the first attempt's tool events/uses so persist() records them
      // (the destructure would otherwise replace them with the recovery run's).
      const _priorToolsUsed = toolsUsed;
      const _priorToolEvents = toolEvents;
      const _priorToolIdentityAnomalies = toolIdentityAnomalies;
      const _priorUsage = usage;
      const _priorModelCalls = modelCalls;
      {
        const _r = yield* bindToolRouterContext(consumeProvider(providerGen, {
          suppressText: false,
          providerCallOrdinalOffset: _priorModelCalls?.length ?? 0,
        }), _routerStore);
        ({ assistantContent, errored, toolsUsed, toolEvents, toolIdentityAnomalies, hideTurn, hideTaskId } = _r);
        usage = mergeProviderUsage(_priorUsage, _r.usage);
        modelCalls = [...(_priorModelCalls || []), ...(_r.modelCalls || [])];
        turnImages = [...(turnImages || []), ...(_r.turnImages || [])];
        toolsUsed = [...(_priorToolsUsed || []), ...(toolsUsed || [])];
        toolEvents = [...(_priorToolEvents || []), ...(toolEvents || [])];
        toolIdentityAnomalies = [
          ...(_priorToolIdentityAnomalies || []),
          ...(toolIdentityAnomalies || []),
        ];
      }
      recoveredProgressClaim = true;
    } catch (e) {
      log.warn('chat', 'in-progress claim recovery failed', { err: e.message });
    }
  }
  // (The first draft already streamed live; recovery paths above emit their own
  // replace(). Nothing more to flush here.)
  // Turn-trace span for this agent run — metadata only (tool names, counts,
  // timing, token counts), never prompt/message bodies. recordSpan attaches to
  // the dispatcher's per-turn store (or our own lazily-begun one); we flush the
  // whole trace here only when this run owns it (direct background/scheduled
  // callers). See lib/turn-trace-context.mjs.
  const _modelCallTrace = (modelCalls || []).map((call, index) => ({
    ...call,
    // Provider-local counters restart when chat-level recovery creates a new
    // generator. This ordinal is canonical across the whole agent span.
    ordinal: index + 1,
  }));
  const _firstModelCall = _modelCallTrace[0] ?? null;
  // `toolCount` below means the provider-native surface actually attested for
  // the first logical request. Never substitute the local schema count when
  // wire evidence is absent or malformed: hosted tools can make those counts
  // differ, and an unknown provider surface must remain visibly unknown.
  const _providerShippedToolCount = _firstModelCall
    && _firstModelCall.traceError !== true
    && _firstModelCall.phase === 'dispatch_planned'
    && Array.isArray(_firstModelCall.toolNames)
    && Number.isSafeInteger(_firstModelCall.toolCount)
    && _firstModelCall.toolCount >= 0
    && _firstModelCall.toolCount === _firstModelCall.toolNames.length
    ? _firstModelCall.toolCount
    : null;
  const _emitTurnTrace = (errInfo = null) => {
    try {
      const selectedTools = _routerStore?.initialToolNames
        ? [...(_routerStore.initialToolNames)]
        : (agent.tools ?? []).map(t => t.function?.name).filter(Boolean);
      // Tool-router savings: full set (pre-trim/pre-plan) vs the set actually
      // shipped this turn. Bytes are exact (the dropped defs JSON-stringified),
      // not estimated — a real prompt-size signal independent of any pricing.
      let toolRouter = null;
      const _fullTools = _routerStore?.fullTools;
      const _keptNames = _routerStore?.initialToolNames;
      if (Array.isArray(_fullTools) && _keptNames) {
        const dropped = _fullTools.filter(t => !_keptNames.has(t.function?.name));
        toolRouter = {
          full: _fullTools.length,
          kept: _keptNames.size,
          dropped: dropped.length,
          droppedBytes: dropped.length ? JSON.stringify(dropped).length : 0,
          recovered: recoveredMissingTools === true,
        };
      }
      recordSpan({
        agent: agent.name ?? agent.id ?? null,
        agentId: agent.id ?? null,
        provider: usage?.provider ?? agent.provider ?? null,
        model: usage?.model ?? agent.model ?? null,
        // Keep only bounded summaries in the global log; complete ordered
        // names live in the authenticated per-user run inspector.
        tools: selectedTools.slice(0, 50),
        toolCount: selectedTools.length,
        modelCalls: _modelCallTrace.map(({ toolNames, recoveryLoads, selectedSkills, addedSkills, ...summary }) => ({
          ...summary,
          selectedSkillCount: selectedSkills?.length ?? 0,
          addedSkillCount: addedSkills?.length ?? 0,
          recoveryLoads: (recoveryLoads || []).map(load => ({
            source: load.source ?? null,
            requestedGroupCount: load.requestedGroups?.length ?? 0,
            addedSkillCount: load.addedSkills?.length ?? 0,
            addedToolCount: load.addedToolNames?.length ?? 0,
          })),
        })),
        toolCalls: (toolEvents ?? []).map(t => ({
          name: t.name,
          ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
          ...(t.native === true ? { providerNative: true } : {}),
          ok: t.status === 'done',
          ms: t.durationMs ?? null,
          ...(t.delegated ? { delegated: true } : {}),
        })),
        inTok: usage?.inTok ?? null,
        outTok: usage?.outTok ?? null,
        cachedTok: usage?.cachedTok ?? null,
        cacheCreateTok: usage?.cacheCreateTok ?? null,
        reqCount: usage?.reqCount ?? null,
        completionCount: usage?.completionCount ?? null,
        usageCount: usage?.usageCount ?? null,
        usageComplete: usage?.usageComplete ?? null,
        toolRouter,
        ms: Date.now() - _streamChatStart,
        error: errInfo,
      });
      if (errInfo) recordError(errInfo);
      if (_ownsTurnTrace) {
        const trace = finishTurn();
        if (trace) log.info('turn', 'summary', trace);
      }
    } catch { /* a trace bug must never break a chat turn */ }
  };
  const _documentArtifact = turnOpts?.documentRequest ? findDocumentMutation(toolsUsed) : null;
  const _observableAssistantContent = documentArtifactContent(
    normalizeDocumentRequest(turnOpts?.documentRequest),
    _documentArtifact,
    assistantContent,
  );
  const _llmMeta = {
    userId,
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? 'auto',
    executionProfile: _executionResolution?.applied ? {
      modelSkill: _executionResolution.sourceSkillIds?.model ?? null,
      effortSkill: _executionResolution.sourceSkillIds?.reasoningEffort ?? null,
    } : null,
    durationMs: Date.now() - _llmStart,
    // Time from streamChat entry to first provider dispatch — the serial
    // pre-LLM assembly cost (router trim, cortex recall, trigger nudge,
    // cross-agent reads, monitorable classify, history build). Watch this
    // to catch regressions in the concurrent pre-LLM kickoff above.
    preLlmMs: _llmStart - _streamChatStart,
    bytes: assistantContent ? (typeof assistantContent === 'string' ? assistantContent.length : JSON.stringify(assistantContent).length) : 0,
    // Pre-LLM payload composition (chars; ÷4 ≈ tokens). Lets us audit
    // prompt/tool/history bloat from app.log without re-running the turn.
    spChars: _sizes.spChars,
    toolsBytes: _sizes.toolsBytes,
    toolCount: _providerShippedToolCount,
    localToolCount: _sizes.toolCount,
    historyMsgs: _sizes.historyMsgs,
    historyBytes: _sizes.historyBytes,
    droppedFromHistory: _sizes.droppedFromHistory,
    userTextChars: _sizes.userTextChars,
    toolNamesUsed: toolsUsed.map(t => t.name),
    reqCount: usage?.reqCount ?? null,
    completionCount: usage?.completionCount ?? null,
    usageCount: usage?.usageCount ?? null,
    usageComplete: usage?.usageComplete ?? null,
  };
  const _turnIdentity = getTurn();
  const _traceBase = {
    turnId: _turnIdentity?.turnId ?? null,
    rootId: _turnIdentity?.rootId ?? null,
    parentTurnId: _turnIdentity?.parentTurnId ?? null,
    messageId: _turnIdentity?.messageId ?? null,
    attemptId: _turnIdentity?.attemptId ?? null,
    agentId: agent.id,
    agentName: agent.name ?? null,
    skillCategory: agent.skillCategory ?? null,
    provider: agent.provider,
    model: agent.model,
    modelExpected: true,
    // Detached workers and scheduled runs mint an authoritative turn source.
    // Prefer it to the optional voice context so background work cannot be
    // mislabeled as an ordinary web or inherited voice turn.
    source: _turnIdentity?.source ?? voiceCtx?.source ?? 'web',
    durationMs: _llmMeta.durationMs,
    input: sessionUserText,
    output: _observableAssistantContent,
    // Trace summary stays single-item (run-inspector's shape, read by
    // public/run-inspector.js — not owned by this change) even on a
    // multi-attachment turn; it's a debug breadcrumb, not the LLM payload.
    attachment: attachment0 ? {
      name: attachment0.name ?? null,
      mimeType: attachment0.mimeType ?? null,
      file_id: attachment0.file_id ?? null,
      hasInlineData: Boolean(attachment0.base64),
    } : null,
    routing: _routerStore ? {
      initialSkills: [...(_routerStore.keptSkills ?? _routerStore.initiallyIncludedSkills)],
      matchedSkills: [...(_routerStore.matchedSkills ?? [])],
      addedSkills: [..._routerStore.addedSkills],
      recoveredMissingTools,
      fullToolCount: _routerStore.fullTools?.length ?? null,
      recoveryLoads: _routerStore.recoveryLoads ?? [],
    } : null,
    modelCalls: _modelCallTrace,
    usage: {
      inputTokens: usage?.inTok ?? null,
      outputTokens: usage?.outTok ?? null,
      cachedTokens: usage?.cachedTok ?? null,
      cacheCreatedTokens: usage?.cacheCreateTok ?? null,
      estimated: usage?.estimated === true,
      requestCount: usage?.reqCount ?? null,
      completionCount: usage?.completionCount ?? null,
      usageRecordCount: usage?.usageCount ?? null,
      usageComplete: usage?.usageComplete ?? null,
    },
    sizes: {
      systemPromptChars: _sizes.spChars,
      toolsBytes: _sizes.toolsBytes,
      toolCount: _providerShippedToolCount,
      localToolCount: _sizes.toolCount,
      historyMessages: _sizes.historyMsgs,
      historyBytes: _sizes.historyBytes,
      droppedFromHistory: _sizes.droppedFromHistory,
      userTextChars: _sizes.userTextChars,
      contextWindow: ctxWindow,
      tokenBudget: TOKEN_BUDGET,
    },
    tools: {
      usedNames: toolsUsed.map(t => t.name),
      used: toolsUsed.map(t => ({
        name: t.name,
        ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
        ...(t.native === true ? { providerNative: true } : {}),
        argsPreview: t.args
          ? JSON.stringify(compactDocumentToolArgs(t.name, redactArgsForTrace(t.args))).slice(0, 500)
          : '',
        resultPreview: redactTextForTrace(compactDocumentToolResult(t.name, t.text)).slice(0, 500),
      })),
      events: toolEvents.map(t => ({
        name: t.name,
        ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
        ...(t.native === true ? { providerNative: true } : {}),
        status: t.status,
        durationMs: t.durationMs ?? null,
        preview: redactTextForTrace(compactDocumentToolPreview(t.name, t.preview ?? t.progressPreview)).slice(0, 500),
      })),
      identityAnomalies: (toolIdentityAnomalies || []).map(compactToolIdentityAnomaly),
    },
    meta: {
      silent,
      ephemeral: Boolean(agent.ephemeral),
      execution: skillExecutionTraceSummary(_executionResolution),
      hideTurn: Boolean(hideTurn),
      hideTaskId: hideTaskId ?? null,
      skippedSignals: Boolean(skipSignals),
      skippedEpisodes: Boolean(skipEpisodes),
      memory: ctx?._meta ?? null,
    },
  };
  if (errored) {
    log.error('chat', 'llm turn errored', _llmMeta);
    const baseTraceError = turnOpts?.documentRequest
      ? (compactDocumentFallback(assistantContent) || 'Provider turn errored')
      : (assistantContent || 'Provider turn errored');
    const identityDurabilityWarning = toolIdentityDurabilityWarning(toolIdentityAnomalies);
    const traceError = identityDurabilityWarning
      ? `${baseTraceError} ${identityDurabilityWarning}`
      : baseTraceError;
    _emitTurnTrace(traceError);
    // A provider can fail after a tool already committed a side effect or
    // emitted media. Persist every completed tool result and collected image
    // even without final narration. The durable result tells a later retry
    // what already happened so it cannot blindly repeat the effect.
    const hasDurableEffects = toolsUsed.length > 0
      || (turnImages?.length ?? 0) > 0
      || (toolIdentityAnomalies?.length ?? 0) > 0;
    let persistenceError = null;
    if (!silent && hasDurableEffects) {
      try {
        await persist(agent, sessionText, '', userId, emit, skipSignals, skipEpisodes, {
          withSignalWordsGate, toolsUsed, toolEvents, toolIdentityAnomalies, voiceCtx, hideTurn, hideTaskId,
          hiddenUser: turnOpts?.hiddenUser === true, turnImages, attachments,
          excludeHiddenUserFromModel: turnOpts?.excludeHiddenUserFromModel === true,
          readOnlyTurn,
          suppressLearning,
          workerLeafRun: Boolean(workerMemoryOwnerId),
          documentRequest: turnOpts.documentRequest,
        });
      } catch (e) {
        console.warn('[chat] error-path persist failed:', e.message);
        persistenceError = `Session persistence failed: ${String(e?.message || e || 'unknown error').slice(0, 500)}`;
      }
    }
    recordRunTrace(userId, {
      ..._traceBase,
      status: 'error',
      error: persistenceError ? `${traceError}; ${persistenceError}` : traceError,
    });
    if (persistenceError) {
      yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'A tool or media action may have completed, but its chat record could not be saved. Do not retry automatically.' };
    }
    return;
  }
  log.info('chat', 'llm turn complete', _llmMeta);
  if (_routerStore && !workerMemoryOwnerId && !suppressLearning) {
    // Hosted provider tools are execution telemetry, not local tools the
    // router can select on a future turn.
    const learnableToolsUsed = toolsUsed.filter(tool => tool.native !== true);
    const learnableToolEvents = toolEvents.filter(event => event.native !== true);
    // Telemetry: fire-and-forget, feeds the future learning loop that uses
    // prior {prompt → skill} pairs as extra intent examples. Never blocks.
    recordTurnRouting({
      userId, userText,
      initiallyIncludedSkills: _routerStore.keptSkills ?? _routerStore.initiallyIncludedSkills,
      addedSkills: _routerStore.addedSkills,
      usedToolNames: toolsUsed.map(t => t.name),
    }).catch(() => {});
    const selectedPlanSource = turnOpts?.toolPlan?.source || null;
    if (selectedPlanSource !== 'server-remembered') {
      try {
        const learned = learnToolPlanFromTurn(userId, {
          agentId: agent.id,
          phrase: routeText,
          usedToolNames: learnableToolsUsed.map(t => t.name),
          initiallyAvailableToolNames: [...(_routerStore.initialToolNames || [])],
          fullToolNames: (_routerStore.fullTools || []).map(t => t.function?.name).filter(Boolean),
          recoveredMissingTools,
          addedSkills: [...(_routerStore.addedSkills || [])],
          toolEvents: learnableToolEvents,
          // Don't learn a recipe from a turn that failed at its job: a specialist
          // (non-coordinator) that ended by calling ask_agent punted the work, and
          // an inability/handoff message in the reply means it couldn't finish.
          // For a coordinator, ask_agent is normal delegation, so it's not a punt.
          escalated: agent.skillCategory !== 'coordinator' && learnableToolsUsed.some(t => t.name === 'ask_agent'),
          outcomeText: _observableAssistantContent,
          source: silent ? 'auto-scheduled-turn' : 'auto-turn',
        });
        if (learned?.learned) {
          log.info('tool-plan', 'learned plan from turn', {
            userId,
            agentId: agent.id,
            recipeId: learned.recipe?.id,
            tools: learned.recipe?.selectedTools,
            recovered: learned.recovered,
          });
        }
      } catch (e) {
        log.warn('tool-plan', 'turn learning failed', { err: e.message });
      }
    }
  }
  // Every successful visible turn gets a completed assistant row, including
  // tool-only/empty narration. Otherwise `done` would leave the pending user
  // row looking permanently in-flight after reload.
  if (!silent) {
    // Awaited so `done` below means "this turn is on disk" — a reload landing
    // between the reply and a fire-and-forget write used to show only the
    // pending user row and lose the assistant reply. A failed write terminates
    // with a non-retryable storage error; the dispatcher then records failure.
    try {
      await persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, {
        withSignalWordsGate, toolsUsed, toolEvents, toolIdentityAnomalies, voiceCtx, hideTurn, hideTaskId,
        hiddenUser: turnOpts?.hiddenUser === true, turnImages, attachments,
        excludeHiddenUserFromModel: turnOpts?.excludeHiddenUserFromModel === true,
        readOnlyTurn,
        suppressLearning,
        workerLeafRun: Boolean(workerMemoryOwnerId),
        documentRequest: turnOpts?.documentRequest ?? null,
      });
    } catch (e) {
      console.warn('[chat] persist failed:', e.message);
      recordRunTrace(userId, {
        ..._traceBase,
        status: 'error',
        error: `Session persistence failed: ${String(e?.message || e || 'unknown error').slice(0, 500)}`,
      });
      yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'The reply finished, but the chat turn could not be saved. Reload before trying again.' };
      return;
    }
  }
  // A completed Run Inspector record is a durable claim that the visible turn
  // committed. Write it only after the awaited session append succeeds; a
  // storage failure above records an error instead of leaving a false green.
  recordRunTrace(userId, { ..._traceBase, status: 'complete' });
  // Phase-14 chip-replaces-turn: emit __content only when we're NOT hiding
  // the turn. Silent/internal consumers retain the pre-existing event shape.
  if ((assistantContent || turnOpts?.documentRequest) && !hideTurn) {
    yield { type: '__content', content: _observableAssistantContent };
  } else if (hideTurn) {
    yield { type: 'hide_turn', taskId: hideTaskId };
  }
  _emitTurnTrace(null);
  yield { type: 'done' };
}
