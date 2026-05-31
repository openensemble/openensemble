/**
 * Core chat loop for OpenEnsemble.
 *
 * This file is a public facade — provider streaming logic lives in chat/:
 *   chat/preview.mjs                — tool-result previews, drainToolResult
 *   chat/compress.mjs               — LoopGuard + context compression
 *   chat/providers/_shared.mjs      — URLs, API keys, SSE/NDJSON readers, strip helpers
 *   chat/providers/anthropic.mjs    — streamAnthropic (with prompt caching)
 *   chat/providers/lmstudio.mjs     — streamLMStudio + streamLMStudioCompat
 *   chat/providers/openrouter.mjs   — streamOpenRouter
 *   chat/providers/openai-compat.mjs    — streamOpenAICompat (OpenAI/DeepSeek/Groq/etc.)
 *   chat/providers/openai-responses.mjs — streamOpenAIResponses (ChatGPT OAuth)
 *   chat/providers/ollama.mjs       — streamOllama
 *
 * streamChat is the top-level dispatcher: it builds memory context, handles
 * Grok/Fireworks image/video branches, picks the right provider stream, and
 * persists the session + runs memory signals.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { buildAgentContext, formatContext, addToSessionBuffer, processSignals } from './memory.mjs';
import { trackFriction } from './memory/signals.mjs';
import { loadSession, appendToSession, loadCrossAgentContext } from './sessions.mjs';
import { getUserFilesDir } from './lib/paths.mjs';
import { log } from './logger.mjs';
import { trimToolsForTurn, recordTurnRouting } from './lib/tool-router.mjs';
import { toolRouterContext } from './lib/tool-router-context.mjs';
import { voiceContext } from './lib/voice-context.mjs';
import { composeSkillSpaBlock } from './lib/skill-prompt-composer.mjs';

import {
  OPENAI_COMPAT_PROVIDERS, FIREWORKS_BASE,
  getGrokKey, getFireworksKey,
} from './chat/providers/_shared.mjs';
import { streamAnthropic }        from './chat/providers/anthropic.mjs';
import { streamLMStudio }         from './chat/providers/lmstudio.mjs';
import { streamOpenRouter }       from './chat/providers/openrouter.mjs';
import { streamOpenAICompat }     from './chat/providers/openai-compat.mjs';
import { streamOpenAIResponses }  from './chat/providers/openai-responses.mjs';
import { streamOllama }           from './chat/providers/ollama.mjs';

// Re-export for external consumers (e.g. routes/agents.mjs)
export { OPENAI_COMPAT_PROVIDERS };

// ── Session persistence + memory signal dispatch ─────────────────────────────
// Shared across every provider branch. `withSignalWordsGate` matches the
// Anthropic-only gate that skips signal detection on orchestrator agents
// unless the message actually contains preference/correction wording.
const SIGNAL_WORDS_RE = /prefer|like|love|hate|want|don'?t like|remember|decided|will use|choose|chose|my name|i am|i'm|my \w+ is|call me|always|never|make sure|correction/i;

function persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, { withSignalWordsGate = false, toolsUsed = [], voiceCtx = null } = {}) {
  // Record a compact summary of which tools fired this turn so future loads
  // of this session can show the assistant what it actually did, not just
  // what it said. Without this, short follow-ups ("send", "again", "do that
  // for the other one too") land on a model that sees only its own prose
  // and has no record of which side-effects happened. We keep only the
  // name + a short args preview — full tool_result bodies stay out of the
  // session log to keep file size bounded.
  const toolsSummary = toolsUsed.length
    ? toolsUsed.map(t => {
        const args = t.args ? JSON.stringify(t.args).slice(0, 120) : '';
        return args ? `${t.name}(${args})` : t.name;
      })
    : null;
  appendToSession(agent.id,
    { role: 'user', content: sessionText, ts: Date.now() },
    toolsSummary
      ? { role: 'assistant', content: assistantContent, ts: Date.now(), toolsUsed: toolsSummary }
      : { role: 'assistant', content: assistantContent, ts: Date.now() });

  // Friction tracking runs UNCONDITIONALLY — before skipSignals, before
  // toolsUsed, before any other gate. It's about repeat-detection, not
  // preference inference, so the existing signal-suppression rules don't
  // apply. Powers friction-as-proposer (lib/proposals.mjs): a user who
  // repeats "remind me to clean my desk at 5pm" three times triggers a
  // proposal even though every repeat fires schedule_task and even though
  // scheduler-intent intercepted the message before the agent saw it.
  trackFriction({ agentId: agent.id, userMessage: sessionText, userId })
    .catch(e => console.warn('[cortex] Friction tracking failed:', e.message));

  // Auto-skill proposer — Hermes-style: a turn that used several real tools
  // is a candidate for bundling into a reusable user skill. Runs in parallel
  // with friction tracking; declines internally on rate-limit, destructive
  // verbs, mutation-only tool sets, etc. Skip ephemeral one-shots.
  if (!agent.ephemeral) {
    import('./lib/skill-proposer.mjs')
      .then(m => m.maybeProposeSkill({
        userId, agentId: agent.id, agentName: agent.name,
        userMessage: sessionText, assistantContent, toolsUsed,
      }))
      .catch(e => console.warn('[skill-proposer] failed:', e.message));
  }

  // Routine proposer — runs on EVERY turn (including ephemeral specialist
  // runs), unlike skill-proposer which skips ephemerals. The whole point is
  // to catch the case where Helen runs as an ephemeral router delegate and
  // resolves an ambiguous "turn off X" via ha_call_service — that turn is
  // exactly the alias-learning signal we want. Keyed by userId because the
  // FLUSH happens on Sydney's next turn (different agentId).
  import('./lib/routine-proposer.mjs')
    .then(m => m.maybeProposeRoutine({
      userId, agentId: agent.id, agentName: agent.name,
      userMessage: sessionText, toolsUsed, voiceCtx,
    }))
    .catch(e => console.warn('[routine-proposer] failed:', e.message));

  // Location-fact proposer — when a node_exec probe failed on a hard-coded
  // path and a later call in the same turn found the real one, stash a
  // candidate. Defer-one-turn like skill-proposer; drops on corrective next
  // turn. Cheap heuristic, no LLM. Same broad gating as routine-proposer
  // (runs even for ephemerals, since ops work often routes through them).
  if (!agent.ephemeral) {
    import('./lib/location-fact-proposer.mjs')
      .then(m => m.maybeProposeLocationFact({
        userId, agentId: agent.id, agentName: agent.name,
        userMessage: sessionText, toolsUsed,
      }))
      .catch(e => console.warn('[location-fact-proposer] failed:', e.message));
  }

  if (!agent.ephemeral) {

    // Per-skill telemetry — bump invocation counters for any user-created
    // skill tools that fired this turn. Pairs with recordCorrection in
    // memory/signals.mjs to compute correction-rate per skill and propose
    // deprecation when the ratio crosses threshold.
    import('./lib/skill-telemetry.mjs')
      .then(m => m.recordToolInvocations({ userId, toolsUsed }))
      .catch(e => console.warn('[skill-telemetry] record failed:', e.message));

    // Trigger learning — when a user-skill tool fires, the userText that
    // triggered it becomes a new natural-language example for that skill's
    // triggers.json. The agent-resolver injects these as system-prompt
    // examples, biasing the LLM toward existing skills for similar requests.
    // appendTrigger dedups by lowercase phrase and caps the list — safe to
    // call on every invocation.
    (async () => {
      try {
        const { userSkillsDir } = await import('./lib/paths.mjs');
        const fs = (await import('fs')).default;
        const path = (await import('path')).default;
        const dir = userSkillsDir(userId);
        if (!fs.existsSync(dir)) return;
        // Cheap tool→skill index: scan once.
        const idx = {};
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const mp = path.join(dir, entry.name, 'manifest.json');
          if (!fs.existsSync(mp)) continue;
          try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            for (const t of m.tools || []) {
              const n = t?.function?.name;
              if (n) idx[n] = entry.name;
            }
          } catch { /* skip */ }
        }
        const skillIds = new Set();
        for (const t of toolsUsed) {
          const sid = idx[t?.name];
          if (sid) skillIds.add(sid);
        }
        if (skillIds.size === 0) return;
        const { appendTrigger } = await import('./lib/skill-triggers.mjs');
        for (const sid of skillIds) appendTrigger(userId, sid, sessionText);
      } catch (e) {
        console.warn('[skill-triggers] append failed:', e.message);
      }
    })();
  }

  if (skipSignals) return;

  // Explicit memory-mutating tools — agent already recorded its intent.
  // Emit per-tool badges (both can fire when the agent does a forget+remember
  // swap), then skip processSignals: running the LLM signal head here would
  // re-create the topic the user just deleted, because the user message
  // naturally contains the offending phrase. Use tool result text to skip
  // toasts on no-op outcomes (dedup hit, no-match forget) so the badge
  // reflects what actually changed in the DB.
  //
  // role_add_rule / role_remove_rule write to users/<uid>/role-rules/<id>.md
  // rather than cortex tables, but from the user's POV they're the same kind
  // of mutation ("you saved this" / "you forgot that") — reuse the same WS
  // events so the existing client-side ✦ pill fires uniformly.
  const forgets   = toolsUsed.filter(t => t.name === 'forget_fact' || t.name === 'role_remove_rule');
  const remembers = toolsUsed.filter(t => t.name === 'remember_fact' || t.name === 'role_add_rule');
  if (forgets.length || remembers.length) {
    const wroteForget   = forgets.some(t =>
      /^Forgot \d+ memor/i.test(t.text) ||      // forget_fact success
      /^Removed rule:/i.test(t.text));          // role_remove_rule success
    const wroteRemember = remembers.some(t =>
      /^Pinned fact/i.test(t.text) ||           // remember_fact success
      /^Rule added to /i.test(t.text));         // role_add_rule success
    if (emit) {
      if (wroteForget)   emit({ type: 'memory_forgotten' });
      if (wroteRemember) emit({ type: 'memory_stored' });
    }
    return;
  }

  if (!skipEpisodes) {
    addToSessionBuffer(agent.id, 'user', sessionText, userId);
    addToSessionBuffer(agent.id, 'assistant', assistantContent, userId);
  }
  // (trackFriction is called at the top of persist, before any skipSignals
  // or toolsUsed gate — see comment block at the top of this function.)

  // Action-tool turns (set_reminder, schedule_task, send_telegram_message,
  // web search, email send, etc.) are imperative actions, not preference
  // statements. Running the signals head on the user message would routinely
  // misclassify "i need to drink water in 5 minutes" or "send X to telegram"
  // as a durable fact/preference. Episodes still write above for context recall.
  if (toolsUsed.length) return;
  const runSignals = withSignalWordsGate
    ? (!skipEpisodes || SIGNAL_WORDS_RE.test(sessionText))
    : true;
  if (runSignals) {
    processSignals({ agentId: agent.id, userMessage: sessionText, agentLastResponse: assistantContent, userId })
      .then(r => {
        if (!emit) return;
        if (r.forgot) emit({ type: 'memory_forgotten' });
        else if (r.remembered) emit({ type: 'memory_stored', fact: r.factText });
        else if (r.correction || r.preference) emit({ type: 'memory_stored' });
      })
      .catch(e => console.warn('[cortex] Signal processing failed:', e.message));
  }
}

// Consume a provider stream: forward every event except __content (captured), and
// bail out on error. Returns the final assistantContent string (or '' on error/empty)
// plus the list of tool invocations (name + result text) — used by persist() to
// gate signal detection and pick the right UI badge for memory-mutating tools.
async function* consumeProvider(providerGen) {
  let assistantContent = '';
  let errored = false;
  const toolsUsed = [];
  // Latest tool_call args by name, attached to the matching tool_result so
  // downstream proposers (routine-proposer) can inspect what the LLM passed.
  let _lastCallArgsByName = Object.create(null);
  for await (const event of providerGen) {
    if (event.type === '__content') { assistantContent = event.content; continue; }
    if (event.type === 'tool_call' && event.name) {
      _lastCallArgsByName[event.name] = event.args ?? null;
    }
    if (event.type === 'tool_result' && event.name) {
      toolsUsed.push({ name: event.name, text: event.text || '', args: _lastCallArgsByName[event.name] ?? null });
      delete _lastCallArgsByName[event.name];
    }
    yield event;
    if (event.type === 'error') { errored = true; break; }
  }
  return errored ? { assistantContent: '', errored: true, toolsUsed } : { assistantContent, errored: false, toolsUsed };
}

// ── Main chat generator ───────────────────────────────────────────────────────
export async function* streamChat(agent, userText, signal, emit, userId = 'default', attachment = null, systemNote = null, silent = false, voiceCtx = null) {
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
  /** @type {{agent: any, fullTools: any[], initiallyIncludedSkills: Set<string>, addedSkills: Set<string>} | null} */
  let _routerStore = null;
  if (agent.skillCategory === 'coordinator' && Array.isArray(agent.tools) && agent.tools.length > 0) {
    try {
      const trim = await trimToolsForTurn({ agent, userText, userId });
      agent.tools = trim.trimmedTools;
      _routerStore = {
        agent, fullTools: trim.fullTools,
        initiallyIncludedSkills: trim.initiallyIncludedSkills,
        addedSkills: new Set(),
      };
      toolRouterContext.enterWith(_routerStore);
      // Recompose the SPA portion of the system prompt against the trimmed
      // tool set. Without this, SPAs for skills whose tools just got dropped
      // (e.g. the ~10 KB profiles SPA) keep shipping. The "shell" was
      // stashed on the agent record in agent-resolver with %%SKILL_SPAS%%
      // marking where the SPAs live.
      if (agent._systemPromptShell && agent._composerInputs) {
        const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
        agent.systemPrompt = agent._systemPromptShell.replace('%%SKILL_SPAS%%', newSpa);
      }
      log.info('chat', 'tool-router trim', { userId, agentId: agent.id, kept: trim.trimmedTools.length, full: trim.fullTools.length, notes: trim.routerNotes, spChars: agent.systemPrompt.length });
    } catch (e) {
      console.warn('[chat] tool-router trim failed, shipping full toolset:', e.message);
    }
  }
  // Flush any deferred skill-proposal candidate from the prior turn. The
  // proposer stashes after qualifying multi-tool turns and only emits on the
  // next turn — so we can drop the candidate if the user's current message
  // is corrective. Fire-and-forget; failures here must never block chat.
  if (!agent.ephemeral && !silent) {
    import('./lib/skill-proposer.mjs')
      .then(m => m.flushPendingSkillCandidate({ agentId: agent.id, currentUserMessage: userText }))
      .catch(e => console.warn('[skill-proposer] flush failed:', e.message));
  }
  // Routine-proposer flush runs on EVERY non-silent turn — including
  // ephemeral specialist-router runs (Helen). On voice-device pipelines
  // every user turn lands in Helen ephemerally, so gating on !ephemeral
  // would mean the flush never fires for voice-only users. Keyed by userId.
  if (!silent) {
    import('./lib/routine-proposer.mjs')
      .then(m => m.flushPendingRoutineCandidate({ userId, currentUserMessage: userText }))
      .catch(e => console.warn('[routine-proposer] flush failed:', e.message));
  }

  // Location-fact-proposer flush — same shape as skill-proposer: drop the
  // pending candidate if the new turn looks corrective, otherwise emit the
  // host-fact proposal bubble.
  if (!agent.ephemeral && !silent) {
    import('./lib/location-fact-proposer.mjs')
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
  const skipSignals = schedulerFired || agent.ephemeral || agent.skillCategory === 'finance' || agent.skillCategory === 'expenses' || agent.skillCategory === 'email';
  // General/manager agents: skip episode storage (task requests aren't useful memories)
  // but still run processSignals to capture genuine preferences/corrections
  const skipEpisodes = schedulerFired || agent.ephemeral || agent.skillCategory === 'general';
  // 1. Build rich cortex context (relevant memories, preferences, past episodes)
  // Expand deictic/pronominal queries ("tell me more about that") with recent context
  const NEEDS_CONTEXT_RE = /\b(that|this|it|those|these|there|the same|more about|what we|what you|yesterday|earlier|last time|before|again|continue|go on)\b/i;
  let recallQuery = userText;
  if (userText.length < 50 || NEEDS_CONTEXT_RE.test(userText)) {
    const recentMsgs = loadSession(agent.id, 4);
    if (recentMsgs.length) {
      const lastUser = recentMsgs.filter(m => m.role === 'user').slice(-1)[0];
      const lastAsst = recentMsgs.filter(m => m.role === 'assistant').slice(-1)[0];
      const ctx_parts = [lastUser?.content?.slice(0, 150), lastAsst?.content?.slice(0, 150)].filter(Boolean);
      if (ctx_parts.length) recallQuery = `${userText} [context: ${ctx_parts.join(' ')}]`;
    }
  }
  // Ephemeral agents (deep_research_parallel workers, etc.) skip cortex loads
  // — they're pure stateless one-shots and shouldn't read the user's memory.
  const ctx = agent.ephemeral
    ? null
    : await buildAgentContext(agent.id, recallQuery, userId).catch(() => null);
  const memBlock = ctx ? formatContext(ctx) : '';

  // Per-turn user-skill trigger nudge. Embedding-ranked when cortex is up
  // (top-K skills by cosine similarity to userText), all-triggers fallback
  // when not. Empty string for ephemeral agents and for users with no custom
  // skills — buildTriggerNudgeBlock handles both. Concatenated into the
  // system prompt below alongside memBlock.
  let skillTriggersBlock = '';
  if (!agent.ephemeral && userId && userId !== 'default') {
    try {
      const { buildTriggerNudgeBlock } = await import('./lib/skill-triggers.mjs');
      skillTriggersBlock = await buildTriggerNudgeBlock(userId, userText);
    } catch (e) {
      console.debug('[skill-triggers] nudge build failed:', e.message);
    }
  }

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
      const userPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'users', userId, 'profile.json');
      if (existsSync(userPath)) {
        const user = JSON.parse(readFileSync(userPath, 'utf8'));
        if (user?.email) userEmailBlock = `\n\nUser's email address: ${user.email}`;
      }
    } catch { /* ignore */ }
  }
  // 1b. Cross-agent context — let this agent see recent messages from other agents.
  // Skip for ephemeral agents: "ephemeral" means a hermetic run with no carried-over
  // context, and crossAgentRead would silently leak another agent's history.
  let crossAgentBlock = '';
  if (!agent.ephemeral && agent.crossAgentRead?.length && userId && userId !== 'default') {
    const parts = [];
    for (const otherId of agent.crossAgentRead) {
      const recent = loadCrossAgentContext(userId, otherId, 3);
      // Filter to only user/assistant messages (skip notifications, system)
      const useful = recent.filter(m => m.role === 'user' || m.role === 'assistant');
      if (useful.length) {
        const lines = useful.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n');
        parts.push(`### ${otherId}\n${lines}`);
      }
    }
    if (parts.length) crossAgentBlock = `\n\n## Recent activity from other agents\n${parts.join('\n\n')}`;
  }

  // systemNote: one-shot directive from the dispatcher (e.g. scheduler-intent
  // outcome). Goes into the system prompt — not userText — so the UI doesn't
  // render it and the session doesn't persist it into history.
  const noteBlock = systemNote ? `\n\n${systemNote}` : '';
  const triggerSuffix = skillTriggersBlock ? `\n\n${skillTriggersBlock}` : '';

  // Monitorable-intent classifier — embedding-based judge that fires when
  // the user's message looks like "any new X from Y?", "what's on sale at Z?",
  // "is the item back in stock?", etc. On a hit, append a one-line system
  // note telling the LLM to ask the user (after answering) if they'd like
  // automatic monitoring set up. Stateless — re-runs every turn; if the user
  // ignores the offer once, the next topic-relevant turn will offer again.
  // Skipped for ephemeral agents (no value in one-shot research) and slash
  // commands. ~5-10ms when the cortex embedder is warm.
  let monitorableBlock = '';
  if (!agent.ephemeral && userId && userId !== 'default' && userText && !userText.trim().startsWith('/')) {
    try {
      const { classifyMonitorable, buildMonitorableSystemNote } = await import('./lib/monitorable-classifier.mjs');
      const hit = await classifyMonitorable(userText);
      if (hit.monitorable) {
        monitorableBlock = buildMonitorableSystemNote(hit);
        log.info('chat', 'monitorable intent detected', { userId, score: hit.score.toFixed(3), matched: hit.matched });
      }
    } catch (e) {
      console.debug('[monitorable-classifier] failed:', e.message);
    }
  }
  const systemPrompt = memBlock
    ? `${basePrompt}${userIdBlock}${userEmailBlock}\n\n${memBlock}${crossAgentBlock}${triggerSuffix}${noteBlock}${monitorableBlock}`
    : `${basePrompt}${userIdBlock}${userEmailBlock}${crossAgentBlock}${triggerSuffix}${noteBlock}${monitorableBlock}`;

  // 2. Build message history (strip ts field — Ollama doesn't want it).
  // Filter out UI-only role types — `status` (watcher progress bubbles),
  // `proposal` and `proposal_outcome` (friction-as-proposer bubbles),
  // `notification`. Providers (OpenAI especially) reject unknown roles with
  // a 400, and these entries carry no LLM-actionable content anyway.
  //
  // Assistant entries persisted with `toolsUsed: [...]` (from persist()
  // above) get a compact "[tools: …]" suffix so the next turn's LLM can
  // see which side-effects happened in the prior turn, not just the prose
  // it wrote. Same idea for `via:` on router-routed turns — the coordinator
  // needs to know the prior reply came from a specialist, not its own run.
  const LLM_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
  const history = loadSession(agent.id)
    .filter(m => LLM_ROLES.has(m.role))
    .map(({ role, content, name, toolsUsed, via, viaName }) => {
      let body = content;
      if (role === 'assistant' && via) {
        body = `${body || ''}\n[note: this reply was produced by the ${viaName ?? via} specialist via the pre-LLM router — you (the coordinator) did not run a turn]`;
      }
      if (role === 'assistant' && Array.isArray(toolsUsed) && toolsUsed.length) {
        body = `${body || ''}\n[tools used this turn: ${toolsUsed.join(', ')}]`;
      }
      return name ? { role, content: body, name } : { role, content: body };
    });

  // For session storage, store text only (no base64 — too large and not replayable)
  const sessionText = attachment ? `[Attached: ${attachment.name}]\n${userText}`.trim() : userText;

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
  const ctxWindow  = agent.contextSize ?? 32768;
  const toolsBytes = JSON.stringify(agent.tools ?? []).length;
  const toolTokens = Math.ceil(toolsBytes / 4);
  const TOKEN_BUDGET = Math.max(1000, Math.floor(ctxWindow * 0.55) - toolTokens);
  let trimmed = [...history];
  let approxTokens = (systemPrompt.length + userText.length) / 4;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    approxTokens += (trimmed[i].content?.length ?? 0) / 4;
    if (approxTokens > TOKEN_BUDGET) { trimmed = trimmed.slice(i + 1); break; }
  }

  // Pre-LLM size snapshot — measurement-only, surfaced on the
  // "llm turn complete" log line so we can audit prompt/tools/history
  // bloat without re-running the request. Cheap (no JSON.stringify in the
  // hot tool loop, just at turn boundaries).
  const _sizes = {
    spChars: systemPrompt.length,
    toolsBytes,
    toolCount: agent.tools?.length ?? 0,
    historyMsgs: trimmed.length,
    historyBytes: trimmed.reduce((n, m) => n + (m.content?.length ?? 0), 0),
    droppedFromHistory: Math.max(0, history.length - trimmed.length),
    userTextChars: userText.length,
  };

  // Build the current user turn — include image data if attachment present
  let currentUserTurn;
  if (attachment?.base64) {
    if (agent.provider === 'anthropic') {
      currentUserTurn = { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.base64 } },
        { type: 'text', text: userText || 'What is in this image?' },
      ]};
    } else if (agent.provider === 'ollama') {
      currentUserTurn = { role: 'user', content: userText || 'What is in this image?', images: [attachment.base64] };
    } else if (OPENAI_COMPAT_PROVIDERS[agent.provider === 'grok' ? 'xai' : agent.provider] || agent.provider === 'openrouter' || agent.provider === 'openai-oauth') {
      // OpenAI vision schema: image_url with base64 data URL.
      // For openai-oauth (Responses API), toResponsesInput() translates this
      // shape into { type: 'input_image', image_url: '...' } parts.
      currentUserTurn = { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.base64}` } },
        { type: 'text', text: userText || 'What is in this image?' },
      ]};
    } else {
      // LM Studio / other: fall back to text description
      currentUserTurn = { role: 'user', content: userText };
    }
  } else {
    currentUserTurn = { role: 'user', content: userText };
  }

  const working = [...trimmed, currentUserTurn];

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
      try {
        const videoSaveDir = getUserFilesDir(userId, 'videos');
        const vidRes = await fetch(videoUrl, { signal });
        writeFileSync(path.join(videoSaveDir, filename), Buffer.from(await vidRes.arrayBuffer()));
        savedPath = path.join(videoSaveDir, filename);
      } catch (e) {
        console.warn('[grok-video] Failed to save video:', e.message);
      }

      if (!silent) appendToSession(agent.id,
        { role: 'user', content: userText, ts: Date.now() },
        { role: 'assistant', video: { url: videoUrl, filename }, content: `[Video: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
      );
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
    try {
      const grokImgDir = getUserFilesDir(userId, 'images');
      writeFileSync(path.join(grokImgDir, filename), Buffer.from(base64, 'base64'));
      savedPath = path.join(grokImgDir, filename);
    } catch (e) {
      console.warn('[grok] Failed to save image:', e.message);
    }

    if (!silent) appendToSession(agent.id,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', image: { base64, mimeType, filename }, content: `[Image: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
    );
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
      // Async: flux-kontext-pro / flux-kontext-max
      const body = { prompt };
      if (attachment?.base64) body.input_image = `data:${attachment.mimeType};base64,${attachment.base64}`;
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
    try {
      const fwImgDir = getUserFilesDir(userId, 'images');
      writeFileSync(path.join(fwImgDir, filename), Buffer.from(base64, 'base64'));
      savedPath = path.join(fwImgDir, filename);
    } catch (e) {
      console.warn('[fireworks] Failed to save image:', e.message);
    }

    if (!silent) appendToSession(agent.id,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', image: { base64, mimeType, filename }, content: `[Image: ${filename}]${savedPath ? `\nSaved to: ${savedPath}` : ''}`, ts: Date.now() }
    );
    yield { type: 'image', base64, mimeType, prompt, filename, savedPath };
    yield { type: 'done' };
    return;
  }

  // ── Chat-provider dispatch ──────────────────────────────────────────────────
  // Each branch forwards events via consumeProvider, captures __content, then
  // persists + runs memory signals through persist().
  const compatProviderKey = agent.provider === 'grok' ? 'xai' : agent.provider;

  let providerGen;
  let withSignalWordsGate = false;
  if (agent.provider === 'anthropic') {
    providerGen = streamAnthropic(agent, systemPrompt, working, signal, userId);
    withSignalWordsGate = true;
  } else if (agent.provider === 'openrouter') {
    providerGen = streamOpenRouter(agent, systemPrompt, working, signal, userId);
  } else if (agent.provider === 'openai-oauth') {
    providerGen = streamOpenAIResponses(agent, systemPrompt, working, signal, userId);
  } else if (OPENAI_COMPAT_PROVIDERS[compatProviderKey]) {
    providerGen = streamOpenAICompat(compatProviderKey, agent, systemPrompt, working, signal, userId);
  } else if (agent.provider === 'lmstudio') {
    // LM Studio's native path takes `userText` (string), not full message history
    providerGen = streamLMStudio(agent, systemPrompt, userText, agent.id, signal, userId);
  } else {
    // Default: Ollama
    providerGen = streamOllama(agent, systemPrompt, working, signal, userId);
  }

  const _llmStart = Date.now();
  const { assistantContent, errored, toolsUsed } = yield* consumeProvider(providerGen);
  const _llmMeta = {
    userId,
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model,
    durationMs: Date.now() - _llmStart,
    bytes: assistantContent ? (typeof assistantContent === 'string' ? assistantContent.length : JSON.stringify(assistantContent).length) : 0,
    // Pre-LLM payload composition (chars; ÷4 ≈ tokens). Lets us audit
    // prompt/tool/history bloat from app.log without re-running the turn.
    spChars: _sizes.spChars,
    toolsBytes: _sizes.toolsBytes,
    toolCount: _sizes.toolCount,
    historyMsgs: _sizes.historyMsgs,
    historyBytes: _sizes.historyBytes,
    droppedFromHistory: _sizes.droppedFromHistory,
    userTextChars: _sizes.userTextChars,
    toolNamesUsed: toolsUsed.map(t => t.name),
  };
  if (errored) {
    log.error('chat', 'llm turn errored', _llmMeta);
    return;
  }
  log.info('chat', 'llm turn complete', _llmMeta);
  if (_routerStore) {
    // Telemetry: fire-and-forget, feeds the future learning loop that uses
    // prior {prompt → skill} pairs as extra intent examples. Never blocks.
    recordTurnRouting({
      userId, userText,
      initiallyIncludedSkills: _routerStore.initiallyIncludedSkills,
      addedSkills: _routerStore.addedSkills,
      usedToolNames: toolsUsed.map(t => t.name),
    }).catch(() => {});
  }
  if (assistantContent) {
    if (!silent) persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, { withSignalWordsGate, toolsUsed, voiceCtx });
    yield { type: '__content', content: assistantContent };
  }
  yield { type: 'done' };
}
