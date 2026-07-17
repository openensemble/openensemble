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

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { buildAgentContext, formatContext, addToSessionBuffer, processSignals } from './memory.mjs';
import { trackFriction } from './memory/signals.mjs';
import { loadSession, appendToSession, loadCrossAgentContext } from './sessions.mjs';
import { getUserFilesDir, USERS_DIR } from './lib/paths.mjs';
import {
  detectProactiveNegativeFeedback,
  handleProactiveNegativeFeedback,
} from './lib/personalization/negative-feedback.mjs';
import { log } from './logger.mjs';
import { trimToolsForTurn, recordTurnRouting, expandToolsByReason, inferMissingToolSkills, shouldUseProviderHostedImageBackend } from './lib/tool-router.mjs';
import { bindToolRouterContext, toolRouterContext } from './lib/tool-router-context.mjs';
import { beginMemoryScope } from './lib/memory-scope-context.mjs';
import { getTurnContext } from './lib/turn-abort-context.mjs';
import {
  getTurn, beginTurn, recordSpan, recordError, finishTurn,
  setTurnLabProviderRequestCap,
} from './lib/turn-trace-context.mjs';
import { looksLikeToolError } from './lib/tool-error.mjs';
import { learnToolPlanFromTurn } from './lib/tool-plan-memory.mjs';
import { getSelectedPlanKeepTools, listRoles } from './roles.mjs';
import { resolveValidatedSkillExecutionForTurn } from './lib/skill-execution.mjs';
import { voiceContext } from './lib/voice-context.mjs';
import { composeSkillSpaBlock } from './lib/skill-prompt-composer.mjs';
import { recordRunTrace, redactArgsForTrace, redactTextForTrace } from './lib/run-inspector.mjs';
import { listDesktops, sendDesktopCommand } from './lib/desktop-bus.mjs';
import {
  buildWorkerStandingMemoryContext,
  filterWorkerLeafTools,
  workerStandingMemoryOwner,
} from './lib/worker-memory-policy.mjs';
import {
  compactDocumentToolArgs,
  compactDocumentFallback,
  compactDocumentToolPreview,
  compactDocumentToolResult,
  findDocumentMutation,
  normalizeDocumentRequest,
  sanitizeDocumentToolEvent,
} from './lib/document-artifacts.mjs';

import {
  OPENAI_COMPAT_PROVIDERS, FIREWORKS_BASE,
  getGrokKey, getFireworksKey, buildImageUserMessage, normalizeAttachments,
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

function _desktopToolText(data) {
  const item = Array.isArray(data?.content) ? data.content.find(p => p?.type === 'text') : null;
  return item?.text ? String(item.text) : '';
}

function _desktopSavedPath(data) {
  const text = _desktopToolText(data);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

async function saveDesktopArtifact(userId, { source, sandbox, filename, base64, url, timeoutMs = 60_000 } = {}) {
  if (source !== 'desktop-app' || !userId || !sandbox || !filename) return null;
  const connected = listDesktops(userId);
  if (!connected.length) return null;
  try {
    const data = base64
      ? await sendDesktopCommand(userId, 'desktop_save_file', { sandbox, path: filename, content: base64, encoding: 'base64' }, { timeoutMs })
      : await sendDesktopCommand(userId, 'desktop_download_url', { sandbox, path: filename, url }, { timeoutMs });
    return _desktopSavedPath(data);
  } catch (e) {
    console.warn(`[desktop-artifact] failed to save ${sandbox}/${filename}:`, e.message);
    return null;
  }
}

function buildDesktopFoldersBlock(userId, source) {
  if (source !== 'desktop-app' || !userId) return '';
  const clients = listDesktops(userId);
  const active = clients[0];
  if (!active) {
    return '\n\n## Desktop Local Folders\nThis turn came from the OpenEnsemble Desktop app, but no desktop bridge is currently connected. Do not claim generated/downloaded files were saved locally unless a desktop_* tool call succeeds.';
  }
  const sandboxes = Array.isArray(active.sandboxes) ? active.sandboxes : [];
  const lines = sandboxes
    .filter(s => s?.name && s?.path)
    .map(s => `- ${s.name}: ${s.path}`);
  return [
    '\n\n## Desktop Local Folders',
    'This turn came from the OpenEnsemble Desktop app. User-visible artifacts should go to the connected desktop sandboxes instead of the server .openensemble user folder.',
    lines.length ? `Available local sandboxes:\n${lines.join('\n')}` : 'No sandbox folder list was reported by the desktop client.',
    'Use desktop_* tools for files, downloads, generated assets, and code output when those tools are available. Prefer images for generated images, videos for generated videos, downloads for downloaded files, documents for documents, research for research outputs, and coder for source code.',
  ].join('\n');
}

/**
 * Map a known model name to its context-window size in tokens. Returns null
 * for unknown models so the caller can fall through to the modern-default
 * floor (128k). Numbers are conservative — pick the smaller end of each
 * family's range so the budget math doesn't overshoot the actual limit.
 */
function _modelContextWindow(model) {
  if (typeof model !== 'string' || !model) return null;
  const m = model.toLowerCase();
  // OpenAI: gpt-5.x family ships at 200k+; gpt-4.1/4o-class at 128k; old 3.5 at 16k
  if (/^gpt-5/.test(m))                     return 272000;
  if (/^gpt-4o/.test(m) || /^gpt-4\.1/.test(m) || /^gpt-4\.5/.test(m) || /^gpt-4-turbo/.test(m)) return 128000;
  if (/^gpt-4/.test(m))                     return 8192;
  if (/^gpt-3\.5/.test(m))                  return 16385;
  if (/^o\d/.test(m))                       return 200000;          // o1 / o3 family
  // Anthropic
  if (/claude.*opus.*4.*1m/.test(m))        return 1000000;          // explicit 1M opt-in
  if (/claude.*4/.test(m))                  return 200000;
  if (/claude.*3\.5|claude.*3\.7/.test(m))  return 200000;
  if (/claude.*3/.test(m))                  return 200000;
  // Google
  if (/gemini.*2/.test(m))                  return 1000000;
  if (/gemini.*1\.5/.test(m))               return 1000000;
  // Open-source
  if (/llama.*3\.\d/.test(m))               return 128000;
  if (/llama.*70b|llama.*8b/.test(m))       return 128000;
  if (/mistral/.test(m))                    return 32000;
  if (/qwen/.test(m))                       return 128000;
  if (/deepseek/.test(m))                   return 128000;
  return null;
}

function documentArtifactContent(request, artifact, fallback = '') {
  if (!artifact) return request ? compactDocumentFallback(fallback) : fallback;
  return `[Document ${artifact.action}: ${artifact.filename || request?.filename || 'document'}${artifact.version ? ` (v${artifact.version})` : ''}]`;
}

// async since the durability fix: the session write is awaited so callers can
// hold the terminal `done` until the turn is actually on disk. Everything
// after the write (friction/proposers/signals) stays fire-and-forget on normal
// turns. An authenticated verifier preserves the real session/tool path but
// stops here before any delayed learning work can cross the terminal boundary.
async function persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, { withSignalWordsGate = false, toolsUsed = [], toolEvents = [], voiceCtx = null, hideTurn = false, hideTaskId = null, hiddenUser = false, turnImages = [], attachments = [], documentRequest = null, readOnlyTurn = false, suppressLearning = false, workerLeafRun = false } = {}) {
  // Detached task workers are deliberately non-learning. Their completed
  // report is persisted by the owner-continuation path; writing a second
  // ephemeral session here is unnecessary, and proceeding below would also
  // feed friction/routine proposals or Cortex learning from an internal task
  // prompt. Operational run traces are recorded outside persist() and remain.
  if (workerLeafRun) return;
  const safeDocumentRequest = normalizeDocumentRequest(documentRequest);
  const documentArtifact = safeDocumentRequest ? findDocumentMutation(toolsUsed) : null;
  const persistedAssistantContent = documentArtifactContent(safeDocumentRequest, documentArtifact, assistantContent);
  // From here on, tool data is headed to durable/observational stores. The raw
  // document body stays only inside the provider's current tool loop.
  toolsUsed = toolsUsed.map(t => ({
    ...t,
    args: compactDocumentToolArgs(t.name, t.args),
    text: compactDocumentToolResult(t.name, t.text),
  }));
  // Record a compact summary of which tools fired this turn so future loads
  // of this session can show the assistant what it actually did, not just
  // what it said. Without this, short follow-ups ("send", "again", "do that
  // for the other one too") land on a model that sees only its own prose
  // and has no record of which side-effects happened. We keep only the
  // name + a short args preview — full tool_result bodies stay out of the
  // session log to keep file size bounded.
  const toolsSummary = toolsUsed.length
    ? toolsUsed.map(t => {
        const safeArgs = t.args
          ? compactDocumentToolArgs(t.name, redactArgsForTrace(t.args))
          : null;
        const args = safeArgs ? JSON.stringify(safeArgs).slice(0, 120) : '';
        return args ? `${t.name}(${args})` : t.name;
      })
    : null;
  // Save the raw tool result body for each call (capped at 10 KB/result) so
  // the next turn's LLM can act on follow-ups like "delete it" / "reply to
  // that" / "open the second one" — those need to read message ids / file
  // paths / urls from the prior tool return, which the assistant's prose
  // summary doesn't usually echo. The 10 KB cap + session prune keep
  // long-term file size bounded. Loaded back to the LLM via the history
  // mapper below as `[prior-turn tool results]` appended to the assistant
  // body. Doesn't render in the chat UI (only the assistant content does).
  const toolResults = toolsUsed.length
    ? toolsUsed.map(t => ({ name: t.name, text: compactDocumentToolResult(t.name, t.text) }))
        .filter(r => r.text.length > 0)
    : null;
  const resultCursorByName = new Map();
  const nextToolResultIndex = (name) => {
    if (!toolResults?.length) return null;
    const start = resultCursorByName.get(name) ?? 0;
    for (let i = start; i < toolResults.length; i++) {
      if (toolResults[i]?.name === name) {
        resultCursorByName.set(name, i + 1);
        return i;
      }
    }
    return null;
  };
  const compactToolEvents = Array.isArray(toolEvents) && toolEvents.length
    ? toolEvents.map(t => {
        const resultIndex = t.text ? nextToolResultIndex(t.name) : null;
        return {
          name: t.name,
          args: t.args ? compactDocumentToolArgs(t.name, redactArgsForTrace(t.args)) : null,
          status: t.status ?? 'done',
          startedAt: t.startedAt ?? null,
          endedAt: t.endedAt ?? null,
          durationMs: t.durationMs ?? null,
          preview: compactDocumentToolPreview(t.name, t.preview),
          progressPreview: String(t.progressPreview ?? '').slice(-1200),
          delegated: t.delegated === true,
          agentName: t.agentName || null,
          targetAgentId: t.targetAgentId || null,
          ...(resultIndex != null ? { resultIndex } : {}),
        };
      })
    : null;
  // Phase-14 chip-replaces-turn: when the turn dispatched a backgrounded
  // tool whose chip IS the visible reply, mark the assistant entry as
  // hidden so renderSession skips it on reload. The chip's own session
  // entry (status role) remains visible.
  const assistantEntry = toolsSummary
    ? {
        role: 'assistant', content: persistedAssistantContent, ts: Date.now(),
        toolsUsed: toolsSummary,
        ...(toolResults && toolResults.length ? { toolResults } : {}),
        ...(compactToolEvents && compactToolEvents.length ? { toolEvents: compactToolEvents } : {}),
      }
    : { role: 'assistant', content: persistedAssistantContent, ts: Date.now() };
  if (hideTurn) assistantEntry.hidden = true;
  if (hideTaskId) assistantEntry.hideTaskId = hideTaskId;
  if (safeDocumentRequest?.requestId) assistantEntry.documentRequestId = safeDocumentRequest.requestId;
  if (documentArtifact) {
    assistantEntry.documentArtifact = documentArtifact;
    assistantEntry.documentRequest = safeDocumentRequest;
  }
  // Tool-produced images persist as their own rows on VISIBLE turns so they
  // survive a reload (base64 stripped when a saved file exists — same policy
  // as persistedReportImage). Hidden turns skip: the chip/agent_report owns
  // that surface and persists its own copy.
  const imageEntries = (!hideTurn && Array.isArray(turnImages) && turnImages.length)
    ? turnImages.map(img => ({
        role: 'assistant',
        image: {
          mimeType: img.mimeType || 'image/png',
          ...(img.filename ? { filename: img.filename } : {}),
          ...(img.savedPath ? { savedPath: img.savedPath } : {}),
          ...(img.base64 && !img.savedPath && !img.filename ? { base64: img.base64 } : {}),
        },
        content: `[Image: ${img.filename || 'generated image'}]`,
        ts: Date.now(),
      }))
    : [];
  // Attachment metadata rides alongside the user turn so a reload (session_
  // loaded) can re-render the tray without re-embedding inline data — no
  // base64 here, same reasoning as sessionText itself (see the comment
  // above sessionText's assembly): a 500 MB upload cap makes storing the
  // bytes in the JSONL session log a non-starter. isImage-only reload
  // rendering therefore degrades to a filename badge (public/chat.js
  // appendUserBubble) once the in-memory base64 from the live send is gone.
  // Omitted entirely when there were no attachments so every pre-existing
  // session row (and every test fixture) is byte-for-byte unchanged.
  const attachmentEntries = attachments.length
    ? { attachments: attachments.map(a => ({
        name: a?.name ?? null, mimeType: a?.mimeType ?? null,
        isImage: Boolean(a?.isImage), file_id: a?.file_id ?? null,
      })) }
    : {};
  await appendToSession(agent.id,
    {
      role: 'user', content: sessionText, ts: Date.now(),
      ...(hiddenUser ? { hidden: true } : {}),
      ...(safeDocumentRequest ? { documentRequest: safeDocumentRequest } : {}),
      ...attachmentEntries,
    },
    ...imageEntries,
    assistantEntry);

  // One-shot browser snapshots are deliberately non-learning turns. Persist
  // the human question + answer for continuity, then stop before friction,
  // proposals, telemetry, trigger learning, feedback intercepts, episodes,
  // or memory signals can treat hostile page text as user intent.
  if (readOnlyTurn || suppressLearning) return;

  // Friction tracking runs UNCONDITIONALLY — before skipSignals, before
  // toolsUsed, before any other gate. It's about repeat-detection, not
  // preference inference, so the existing signal-suppression rules don't
  // apply. Powers friction-as-proposer (lib/proposals.mjs): a user who
  // repeats "remind me to clean my desk at 5pm" three times triggers a
  // proposal even though every repeat fires schedule_task and even though
  // scheduler-intent intercepted the message before the agent saw it.
  if (!readOnlyTurn) {
    trackFriction({ agentId: agent.id, userMessage: sessionText, userId })
      .catch(e => console.warn('[cortex] Friction tracking failed:', e.message));
  }

  // Auto-skill proposer — Hermes-style: a turn that used several real tools
  // is a candidate for bundling into a reusable user skill. Runs in parallel
  // with friction tracking; declines internally on rate-limit, destructive
  // verbs, mutation-only tool sets, etc. Skip ephemeral one-shots.
  if (!readOnlyTurn && !agent.ephemeral) {
    import('./lib/skill-proposer.mjs')
      .then(m => m.maybeProposeSkill({
        userId, agentId: agent.id, agentName: agent.name,
        userMessage: sessionText, assistantContent: persistedAssistantContent, toolsUsed,
      }))
      .catch(e => console.warn('[skill-proposer] failed:', e.message));
  }

  // Routine proposer — runs on EVERY turn (including ephemeral specialist
  // runs), unlike skill-proposer which skips ephemerals. The whole point is
  // to catch the case where Helen runs as an ephemeral router delegate and
  // resolves an ambiguous "turn off X" via ha_call_service — that turn is
  // exactly the alias-learning signal we want. Keyed by userId because the
  // FLUSH happens on the coordinator's next turn (different agentId).
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

  // Proactive stop feedback is an explicit control command, not memory
  // inference. Run it before the finance/email/scheduler signal gate and the
  // tools-used gate so provider choice or an assistant-side tool call cannot
  // make "stop these updates" a no-op. Ephemeral worker turns have no stable
  // user-facing proactive context, so they remain excluded.
  if (!agent.ephemeral && detectProactiveNegativeFeedback(sessionText)) {
    handleProactiveNegativeFeedback({
      userId, agentId: agent.id, userMessage: sessionText,
      contextText: persistedAssistantContent,
    }).catch(e => console.warn('[personalization] Proactive feedback failed:', e.message));
    return;
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
  // skill_add_rule / skill_remove_rule write to users/<uid>/role-rules/<id>.md
  // rather than cortex tables, but from the user's POV they're the same kind
  // of mutation ("you saved this" / "you forgot that") — reuse the same WS
  // events so the existing client-side ✦ pill fires uniformly. The old
  // role_* names still route through the same handlers (back-compat alias),
  // so detect them here too.
  const forgets   = toolsUsed.filter(t =>
    t.name === 'forget_fact' || t.name === 'skill_remove_rule' || t.name === 'role_remove_rule');
  const remembers = toolsUsed.filter(t =>
    t.name === 'remember_fact' || t.name === 'skill_add_rule' || t.name === 'role_add_rule');
  if (forgets.length || remembers.length) {
    const wroteForget   = forgets.some(t =>
      /^Forgot \d+ memor/i.test(t.text) ||      // forget_fact success
      /^Removed rule:/i.test(t.text));          // skill_remove_rule success
    const wroteRemember = remembers.some(t =>
      /^Pinned fact/i.test(t.text) ||           // remember_fact success
      /^Rule added to /i.test(t.text));         // skill_add_rule success
    if (emit) {
      if (wroteForget)   emit({ type: 'memory_forgotten' });
      if (wroteRemember) emit({ type: 'memory_stored' });
    }
    return;
  }

  if (!skipEpisodes) {
    addToSessionBuffer(agent.id, 'user', sessionText, userId);
    addToSessionBuffer(agent.id, 'assistant', persistedAssistantContent, userId);
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
    processSignals({ agentId: agent.id, userMessage: sessionText, agentLastResponse: persistedAssistantContent, userId })
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
function optionalSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sumKnown(a, b) {
  const values = [a, b].filter(value => Number.isSafeInteger(value) && value >= 0);
  if (!values.length) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function hasUsageCardinality(usage) {
  return usage && (
    Number.isSafeInteger(usage.reqCount)
    || Number.isSafeInteger(usage.completionCount)
    || Number.isSafeInteger(usage.usageCount)
    || typeof usage.usageComplete === 'boolean'
  );
}

function hasCompleteUsageCardinality(usage) {
  return usage
    && Number.isSafeInteger(usage.inTok) && usage.inTok > 0
    && Number.isSafeInteger(usage.outTok) && usage.outTok > 0
    && Number.isSafeInteger(usage.reqCount) && usage.reqCount > 0
    && Number.isSafeInteger(usage.completionCount) && usage.completionCount >= 0
    && Number.isSafeInteger(usage.usageCount) && usage.usageCount >= 0
    && usage.reqCount === usage.completionCount
    && usage.reqCount === usage.usageCount
    && typeof usage.usageComplete === 'boolean';
}

/** Preserve usage evidence across chat-level recovery provider generators. */
export function mergeProviderUsage(first, second) {
  if (!first && !second) return null;
  const a = first || null;
  const b = second || null;
  const cardinalitySeen = hasUsageCardinality(a) || hasUsageCardinality(b);
  const reqCount = sumKnown(a?.reqCount, b?.reqCount);
  const completionCount = sumKnown(a?.completionCount, b?.completionCount);
  const usageCount = sumKnown(a?.usageCount, b?.usageCount);
  const inTok = sumKnown(a?.inTok, b?.inTok);
  const outTok = sumKnown(a?.outTok, b?.outTok);
  const aggregateCountsValid = Number.isSafeInteger(reqCount) && reqCount > 0
    && Number.isSafeInteger(completionCount)
    && Number.isSafeInteger(usageCount)
    && reqCount === completionCount
    && reqCount === usageCount;
  const aggregateTokensValid = Number.isSafeInteger(inTok) && inTok > 0
    && Number.isSafeInteger(outTok) && outTok > 0;
  return {
    inTok,
    outTok,
    cachedTok: sumKnown(a?.cachedTok, b?.cachedTok),
    cacheCreateTok: sumKnown(a?.cacheCreateTok, b?.cacheCreateTok),
    provider: b?.provider ?? a?.provider ?? null,
    model: b?.model ?? a?.model ?? null,
    estimated: a?.estimated === true || b?.estimated === true,
    reqCount,
    completionCount,
    usageCount,
    usageComplete: cardinalitySeen
      ? Boolean(a && b
        && hasCompleteUsageCardinality(a) && hasCompleteUsageCardinality(b)
        && a.usageComplete === true && b.usageComplete === true
        && aggregateCountsValid && aggregateTokensValid)
      : null,
  };
}

// Exported so internal event retention can be tested without a live provider.
export async function* consumeProvider(providerGen, { suppressText = false } = {}) {
  let assistantContent = '';
  let errored = false;
  // Phase-14 chip-replaces-turn: tools may yield `__hide_turn` to indicate
  // their result is a backgrounded task with a live chat chip — the
  // assistant's text reply for this turn is redundant and should be hidden.
  let hideTurn = false;
  let hideTaskId = null;
  const toolsUsed = [];
  const toolEvents = [];
  const modelCalls = [];
  const turnImages = [];
  // One synthetic web_search record per turn when the provider's hosted search
  // runs (it emits only tool_progress, never a local tool_call/result pair).
  let _nativeSearchRecorded = false;
  // Latest tool_call args by name, attached to the matching tool_result so
  // downstream proposers (routine-proposer) can inspect what the LLM passed.
  let _lastCallArgsByName = Object.create(null);
  let _pendingToolEventsByName = Object.create(null);
  // Capture the provider's end-of-turn token usage for the turn trace. The
  // event is still yielded onward (llm-loop records it for billing); we just
  // also stash it so streamChat can attach it to its span without re-plumbing
  // usage through every streamChat consumer. inTok/outTok avoid logger.mjs's
  // /token/ redact key (see lib/turn-trace-context.mjs).
  let usage = null;
  try {
  for await (const event of providerGen) {
    if (event.type === '__content') { assistantContent = event.content; continue; }
    if (event.type === '__model_call') {
      const router = toolRouterContext.getStore();
      modelCalls.push({
        provider: event.provider ?? null,
        model: event.model ?? null,
        requestedReasoningEffort: event.requestedReasoningEffort ?? null,
        wireReasoningEffort: event.wireReasoningEffort ?? null,
        estimated: event.estimated === true,
        phase: event.phase === 'dispatch_planned' ? event.phase : 'unknown',
        providerRound: Number.isSafeInteger(event.round) ? event.round : null,
        toolsPresent: event.toolsPresent === true,
        toolNames: Array.isArray(event.toolNames) ? [...event.toolNames] : [],
        toolCount: Number.isSafeInteger(event.toolCount) ? event.toolCount : null,
        toolSchemaBytes: Number.isSafeInteger(event.toolSchemaBytes) ? event.toolSchemaBytes : null,
        schemaTokEst: Number.isSafeInteger(event.schemaTokEst) ? event.schemaTokEst : null,
        schemaHash: typeof event.schemaHash === 'string' ? event.schemaHash : null,
        selectedSkills: [...(router?.keptSkills ?? router?.initiallyIncludedSkills ?? [])].sort(),
        addedSkills: [...(router?.addedSkills ?? [])].sort(),
        recoveryLoads: Array.isArray(router?.recoveryLoads)
          ? router.recoveryLoads.map(load => ({
              source: load?.source ?? null,
              requestedGroups: Array.isArray(load?.requestedGroups) ? [...load.requestedGroups] : [],
              addedSkills: Array.isArray(load?.addedSkills) ? [...load.addedSkills] : [],
              addedToolNames: Array.isArray(load?.addedToolNames) ? [...load.addedToolNames] : [],
            }))
          : [],
        ...(event.traceError === true ? { traceError: true } : {}),
      });
      continue;
    }
    if (event.type === '__usage') {
      const inTok = optionalSafeCount(event.inputTokens);
      const outTok = optionalSafeCount(event.outputTokens);
      const reqCount = optionalSafeCount(event.reqCount);
      const completionCount = optionalSafeCount(event.completionCount);
      const usageCount = optionalSafeCount(event.usageCount);
      const completeCounts = Number.isSafeInteger(reqCount) && reqCount > 0
        && Number.isSafeInteger(completionCount)
        && Number.isSafeInteger(usageCount)
        && reqCount === completionCount
        && reqCount === usageCount;
      const completeTokens = Number.isSafeInteger(inTok) && inTok > 0
        && Number.isSafeInteger(outTok) && outTok > 0;
      usage = {
        inTok,
        outTok,
        // Prompt-cache read hits (OpenAI cached_tokens / Anthropic cache_read) and
        // Anthropic cache-creation tokens. Named *Tok (not *Tokens) so logger.mjs's
        // /token/i redact key doesn't blank them on the way to the turn trace.
        cachedTok: optionalSafeCount(event.cachedTokens),
        cacheCreateTok: optionalSafeCount(event.cacheCreatedTokens),
        provider: event.provider ?? null,
        model: event.model ?? null,
        estimated: event.estimated === true,
        reqCount,
        completionCount,
        usageCount,
        usageComplete: typeof event.usageComplete === 'boolean'
          ? event.usageComplete === true && completeCounts && completeTokens
          : null,
      };
    }
    if (event.type === '__hide_turn') { hideTurn = true; hideTaskId = event.taskId || null; continue; }
    // Tool-produced images: collect for turn persistence (sync delegations'
    // image bubbles used to vanish on reload — nothing wrote them to the
    // session). Hidden turns skip persisting them (the chip/agent_report owns
    // that surface; persisting both double-rendered on reload).
    if (event.type === 'image' && (event.filename || event.base64)) {
      turnImages.push({
        base64: event.base64 || null,
        mimeType: event.mimeType || event.mediaType || 'image/png',
        filename: event.filename || null,
        savedPath: event.savedPath || null,
      });
    }
    if (event.type === 'tool_call' && event.name) {
      _lastCallArgsByName[event.name] = event.args ?? null;
      const rec = {
        name: event.name,
        args: event.args ?? null,
        startedAt: Date.now(),
        status: 'running',
        ...((event.providerNative === true || event.native === true) ? { native: true } : {}),
        delegated: event.delegated === true,
        agentName: event.agentName || null,
        targetAgentId: event.targetAgentId || null,
      };
      if (!_pendingToolEventsByName[event.name]) _pendingToolEventsByName[event.name] = [];
      _pendingToolEventsByName[event.name].push(rec);
      toolEvents.push(rec);
    }
    if (event.type === 'tool_progress' && event.name) {
      const pending = _pendingToolEventsByName[event.name]?.[0];
      if (pending) {
        const clean = String(event.text ?? '').slice(-1200);
        pending.progressPreview = clean;
        pending.updatedAt = Date.now();
      } else if (event.name === 'web_search' && !_nativeSearchRecorded) {
        // Provider-hosted web search emits ONLY this progress event — no local
        // tool_call/tool_result pair — so without a synthetic record hosted
        // searches are invisible to toolsUsed/toolEvents: recipe learning
        // omits the agent's only path to the web and turn traces under-report
        // the turn. Once per turn, web_search only — other hosted progress
        // (image_generation) must not fabricate tool records.
        _nativeSearchRecorded = true;
        const now = Date.now();
        toolsUsed.push({ name: 'web_search', text: 'provider-hosted web search', args: null, native: true });
        toolEvents.push({ name: 'web_search', args: null, startedAt: now, endedAt: now, durationMs: 0, status: 'done', native: true });
      }
    }
    if (event.type === 'tool_result' && event.name) {
      // Take args from the matching pending record (FIFO per name), not the
      // by-name map — parallel same-name calls clobbered the map, so the
      // first result carried the SECOND call's args in traces/recipes.
      const _matched = _pendingToolEventsByName[event.name]?.[0] ?? null;
      toolsUsed.push({
        name: event.name,
        text: event.text || '',
        args: (_matched?.args ?? _lastCallArgsByName[event.name]) ?? null,
        ...((_matched?.native === true || event.providerNative === true || event.native === true) ? { native: true } : {}),
      });
      // A tool that caught its own error and returned an error string (or one
      // the dispatcher caught and emitted as "Tool error (…)") completes the
      // tool loop normally — without this it would record status:'done' and the
      // span's ok:true, masking the failure in read_turns/Lois. See
      // lib/tool-error.mjs.
      const _toolErrored = looksLikeToolError(event.text);
      const _toolStatus = _toolErrored ? 'error' : 'done';
      const pending = _pendingToolEventsByName[event.name]?.shift();
      if (pending) {
        pending.status = _toolStatus;
        pending.endedAt = Date.now();
        pending.durationMs = pending.endedAt - pending.startedAt;
        pending.preview = event.preview ?? '';
        pending.text = event.text || '';
        pending.delegated = pending.delegated || event.delegated === true;
        pending.agentName = pending.agentName || event.agentName || null;
        pending.targetAgentId = pending.targetAgentId || event.targetAgentId || null;
      } else {
        toolEvents.push({
          name: event.name,
          args: _lastCallArgsByName[event.name] ?? null,
          status: _toolStatus,
          startedAt: Date.now(),
          endedAt: Date.now(),
          durationMs: 0,
          preview: event.preview ?? '',
          text: event.text || '',
          ...((event.providerNative === true || event.native === true) ? { native: true } : {}),
          delegated: event.delegated === true,
          agentName: event.agentName || null,
          targetAgentId: event.targetAgentId || null,
        });
      }
      // Surface the failed tool at the turn level so listTurnTrees' errorCount
      // (and Lois) reflect it instead of reporting "no errors".
      if (_toolErrored) { try { recordError(`tool ${event.name}: ${(event.text || '').trim().slice(0, 160)}`); } catch { /* never throw */ } }
      delete _lastCallArgsByName[event.name];
    }
    const isVisibleText = event.type === 'token' || event.type === 'replace';
    // Auto-backgrounded tools use a task chip plus completion report as the
    // visible surface. The provider may still synthesize a stale "I'll check..."
    // answer after seeing the synthetic background result; suppress those
    // tokens so the completed task report remains the final user-facing update.
    if (!(isVisibleText && (suppressText || hideTurn))) {
      yield sanitizeDocumentToolEvent(event);
    }
    if (event.type === 'error') { errored = true; break; }
  }
  } catch (e) {
    errored = true;
    if (e?.name !== 'AbortError') {
      yield { type: 'error', message: String(e?.message || e || 'Provider stream failed').slice(0, 500) };
    }
  }
  return errored
    ? { assistantContent: '', errored: true, toolsUsed, toolEvents, modelCalls, hideTurn: false, hideTaskId: null, usage, turnImages }
    : { assistantContent, errored: false, toolsUsed, toolEvents, modelCalls, hideTurn, hideTaskId, usage, turnImages };
}

const MISSING_TOOL_REPLY_RE = /\b(?:i\s+(?:can(?:not|'t)|do\s+not|don't)\s+(?:have|see|access|use)|i\s+(?:can(?:not|'t))\s+(?:do|access|read|open|control|check)|no\s+(?:tool|access|browser|permission)|(?:not|isn't)\s+available\s+to\s+me|i\s+don'?t\s+have\s+access)\b/i;

// A reply asserting background work is pending/in-flight, or promising a
// follow-up when it lands. Paired with the status-tool check below: making
// either claim WITHOUT having checked (or started) anything this turn is the
// fabricated-status failure — the coordinator re-asserting its own stale
// "I'll let you know when it's done" promise after a restart killed the run.
const IN_PROGRESS_REPLY_RE = /\b(?:already\s+(?:in\s+progress|under\s?way|working|running|on\s+it)|still\s+(?:working|running|in\s+progress|going)|(?:is|are|['’]s)\s+(?:currently\s+)?working\s+on\s+(?:it|that|this)|(?:i|we)(?:['’]ll|\s+will)\s+(?:let\s+you\s+know|update\s+you|report\s+back|ping\s+you|follow\s+up)\s+(?:when|once|as\s+soon\s+as)|(?:hasn['’]?t|haven['’]?t)\s+(?:finished|completed)\s+yet|not\s+(?:done|finished)\s+yet)\b/i;
// Short, honest interstitials shown when a recovery fires: the live draft is
// wiped and replaced with one of these before the corrected reply drops in.
const MISSING_TOOL_NOTICE = 'Sorry, I misspoke — let me do that now.';
const IN_PROGRESS_NOTICE  = 'One moment — let me check the actual status.';

// Append a [System note: …] to the (possibly multi-part) user turn — used by
// the buffered-recovery retries to re-run the turn with server guidance.
function withRetryNote(userTurn, retryNote) {
  return Array.isArray(userTurn.content)
    ? {
        ...userTurn,
        content: userTurn.content.map((part, idx, arr) =>
          idx === arr.length - 1 && part?.type === 'text'
            ? { ...part, text: `${part.text || ''}${retryNote}` }
            : part
        ),
      }
    : { ...userTurn, content: `${String(userTurn.content || '')}${retryNote}` };
}
// Tools a remembered/pinned recipe can never drop — the recipe-pin counterpart of
// tool-router's ALWAYS_TOOL_NAMES. A stale recipe that omits web_search would
// otherwise strip a research agent's only path to the web (and, on native-search
// models, the trigger for the model's hosted search). Kept only if the agent
// already has it — the filter below never adds a tool the agent lacked.
// This hardcoded set is the provider/meta base ONLY. Skill-critical tools
// (e.g. deep_research's save_research) are declared by each skill's manifest
// via `"selected_plan_keep": [...]` and unioned in at apply time — add new
// protections THERE, not here (getSelectedPlanKeepTools in roles.mjs).
const SELECTED_PLAN_CONTROL_TOOLS = new Set(['request_tools', 'web_search', 'email_user']);

// Tools omitted from the missing-tool recovery retry note's FALLBACK list —
// deliberately not the same set as SELECTED_PLAN_CONTROL_TOOLS: plan
// preservation and recovery naming are different jobs. save_research is
// plan-preserved above AND nameable in recovery — a model claiming "I don't
// have a save tool" should be told save_research is right there.
const RECOVERY_NOTE_EXCLUDED_TOOLS = new Set(['request_tools', 'web_search', 'email_user']);

// Tools that create standing scheduled work (schedule_task / set_reminder /
// set_alarm all call addTask). Stripped on autonomous runs so a scheduled task,
// its barrier reaction, or any background/continuation/worker turn can't spawn
// NEW tasks — "a task must never create a task." Interactive turns (a human is
// present) keep them, so "remind me at 5pm" still works.
const AUTONOMOUS_TASK_CREATION_TOOLS = new Set(['schedule_task', 'set_reminder', 'set_alarm']);

function sanitizeToolPlanForStream(plan) {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.mode === 'none') return { mode: 'none', selectedTools: [], source: plan.source || null };
  if (plan.mode !== 'selected') return null;
  const selectedTools = Array.isArray(plan.selectedTools)
    ? [...new Set(plan.selectedTools.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()))]
    : [];
  if (!selectedTools.length) return null;
  return { mode: 'selected', selectedTools, source: plan.source || null };
}

function recomposeAgentPromptForTools(agent) {
  if (agent._promptTiers && agent._composerInputs) {
    const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
    agent._promptTiers = { ...agent._promptTiers, context: newSpa || '' };
    agent.systemPrompt = [agent._promptTiers.stable, agent._promptTiers.context, agent._promptTiers.volatile].filter(Boolean).join('\n\n');
  } else if (agent._systemPromptShell && agent._composerInputs) {
    const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
    agent.systemPrompt = agent._systemPromptShell.replace('%%SKILL_SPAS%%', newSpa);
  }
}

export function applyUserToolPlan(agent, plan, userId = null) {
  const clean = sanitizeToolPlanForStream(plan);
  if (!clean || !Array.isArray(agent.tools)) return null;
  const before = agent.tools.length;
  const fullTools = agent.tools.slice();
  if (clean.mode === 'none') {
    agent.tools = [];
    return { mode: 'none', before, after: 0, selected: [], fullTools };
  }
  // A cached or hand-crafted client plan can name a tool that the current
  // orchestration policy no longer exposes. Intersect with the live resolved
  // surface before filtering and before reporting the plan back into prompts,
  // telemetry, or recipe learning; never describe a removed tool as selected.
  const availableNames = new Set(fullTools.map(tool => tool?.function?.name).filter(Boolean));
  const effectiveSelected = clean.selectedTools.filter(name => availableNames.has(name));
  const selected = new Set(effectiveSelected);
  const controlTools = new Set(SELECTED_PLAN_CONTROL_TOOLS);
  try {
    const manifestKeeps = agent._rosterSolo === true
      ? getSelectedPlanKeepTools(selected, userId)
      : getSelectedPlanKeepTools(null, userId);
    for (const t of manifestKeeps) controlTools.add(t);
  } catch { /* registry not loaded yet — base set still applies */ }
  if ((agent.skillCategory === 'coordinator' || selected.size === 0)
      && agent._rosterSolo !== true) controlTools.add('ask_agent');
  agent.tools = agent.tools.filter(t => {
    const name = t.function?.name;
    return selected.has(name) || controlTools.has(name);
  });
  return { mode: 'selected', before, after: agent.tools.length, selected: effectiveSelected, fullTools };
}

function executionSkillsForSelectedTools(userId, toolNames) {
  const selected = new Set(Array.isArray(toolNames) ? toolNames : []);
  if (!selected.size) return [];
  const out = [];
  try {
    for (const manifest of listRoles(userId)) {
      if ((manifest.tools ?? []).some(tool => selected.has(tool?.function?.name ?? tool?.name))) {
        out.push(manifest.id);
      }
    }
  } catch { /* routing remains on the agent default if the registry is unavailable */ }
  return out;
}

function userAllowedExecutionModels(userId) {
  if (!userId || userId === 'default') return null;
  try {
    const profile = JSON.parse(readFileSync(path.join(USERS_DIR, userId, 'profile.json'), 'utf8'));
    return Array.isArray(profile?.allowedModels) ? profile.allowedModels : null;
  } catch {
    // Missing/corrupt account policy must not unlock a restricted override.
    return [];
  }
}

function skillExecutionTraceSummary(resolution) {
  if (!resolution) return null;
  const shape = value => ({
    provider: value?.provider ?? null,
    model: value?.model ?? null,
    reasoningEffort: value?.reasoningEffort ?? null,
  });
  return {
    applied: resolution.applied === true,
    reason: resolution.reason ?? null,
    baseline: shape(resolution.baseline),
    effective: shape(resolution.effective),
    sourceSkillIds: {
      model: resolution.sourceSkillIds?.model ?? null,
      reasoningEffort: resolution.sourceSkillIds?.reasoningEffort ?? null,
    },
    reasoningEffortInherited: resolution.reasoningEffortInherited === true,
    contenders: (resolution.contenders ?? []).slice(0, 32).map(candidate => ({
      skillId: candidate.skillId ?? null,
      provider: candidate.provider ?? null,
      model: candidate.model ?? null,
      reasoningEffort: candidate.reasoningEffort ?? null,
      eligible: candidate.eligible === true,
      reason: candidate.reason ?? null,
    })),
  };
}

export function buildUserToolPlanSystemBlock(agent, userToolPlanResult) {
  if (!userToolPlanResult) return '';
  const rosterSolo = agent?._rosterSolo === true;
  const selectedNames = (Array.isArray(userToolPlanResult.selected) ? userToolPlanResult.selected : [])
    .filter(name => !(rosterSolo && name === 'ask_agent'));
  const selectedNote = rosterSolo
    ? (selectedNames.length
        ? ` These selected action tools are available this turn: ${selectedNames.join(', ')}. Control-plane tools such as request_tools may also be available so you can recover from an incomplete selected set and continue the task yourself. Do not claim unrelated tools are unavailable; request tools, answer, use a background worker for long or parallel work, or ask a concise follow-up if the selected set is insufficient.`
        : ' None of the requested action tools are available in single-assistant mode. Use request_tools to recover a needed capability, continue without tools, or ask a concise follow-up.')
    : ` These selected action tools are available this turn: ${userToolPlanResult.selected.join(', ')}. Control-plane tools such as ask_agent/request_tools may also be available so you can delegate or recover from an incomplete selected set. Do not claim unrelated tools are unavailable; delegate, request tools, answer, or ask a concise follow-up if the selected set is insufficient.`;
  return `\n\n## User-selected tool plan\nThe user selected tool mode "${userToolPlanResult.mode}" before sending this message.${userToolPlanResult.mode === 'selected'
    ? selectedNote
    : ' No tools are available this turn; answer without tool calls or ask a concise follow-up if live action is required.'}`;
}

/**
 * Build the current-turn user message from an already-normalized attachments
 * array. Images (base64 present) go through buildImageUserMessage — the same
 * per-provider vision-content builder that reinjects N tool-produced images
 * into the NEXT model turn (see chat/providers/_shared.mjs and every
 * provider's `working.push(buildImageUserMessage(...))` call after a tool
 * returns `_images`). Reusing it here means a multi-file upload gets the
 * identical Anthropic / Ollama / OpenAI-compat+Responses / LM Studio content
 * shapes instead of a second hand-rolled per-provider branch, and any future
 * provider only needs to teach buildImageUserMessage its shape once.
 *
 * No image attachments (none at all, or only audio/video/pdf/csv/etc — see
 * attachmentNotes above, which fold each one's path/extraction note into
 * userText/sessionText separately) → a plain text turn.
 *
 * Exported for tests (mirrors tests/provider-tool-images.test.mjs style —
 * asserting N image parts from N attachments rather than driving a full
 * streamChat turn through a mocked provider).
 */
export function buildCurrentUserTurn(agent, userText, attachments) {
  const imageParts = (attachments || [])
    .filter(a => a?.base64)
    .map(a => ({ base64: a.base64, mediaType: a.mimeType }));
  if (!imageParts.length) return { role: 'user', content: userText };
  return buildImageUserMessage(agent.provider, imageParts, userText || 'What is in this image?');
}

// ── Main chat generator ───────────────────────────────────────────────────────
export async function* streamChat(agent, userText, signal, emit, userId = 'default', attachment = null, systemNote = null, silent = false, voiceCtx = null, turnOpts = {}) {
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
    import('./lib/skill-proposer.mjs')
      .then(m => m.flushPendingSkillCandidate({ agentId: agent.id, currentUserMessage: userText }))
      .catch(e => console.warn('[skill-proposer] flush failed:', e.message));
  }
  // Routine-proposer flush runs on EVERY non-silent turn — including
  // ephemeral specialist-router runs (Helen). On voice-device pipelines
  // every user turn lands in Helen ephemerally, so gating on !ephemeral
  // would mean the flush never fires for voice-only users. Keyed by userId.
  if (!suppressLearning && !silent && !workerMemoryOwnerId) {
    import('./lib/routine-proposer.mjs')
      .then(m => m.flushPendingRoutineCandidate({ userId, currentUserMessage: userText }))
      .catch(e => console.warn('[routine-proposer] flush failed:', e.message));
  }

  // Location-fact-proposer flush — same shape as skill-proposer: drop the
  // pending candidate if the new turn looks corrective, otherwise emit the
  // host-fact proposal bubble.
  if (!suppressLearning && !agent.ephemeral && !silent) {
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
          const { getAgentForUser } = await import('./routes/_helpers.mjs');
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
          const { buildTriggerNudgeBlock } = await import('./lib/skill-triggers.mjs');
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
          const { classifyMonitorable, buildMonitorableSystemNote, recordMonitorableHit } = await import('./lib/monitorable-classifier.mjs');
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
      };
      if (_routerStore) _routerStore.agent = agent;
      log.info('chat', 'skill execution override applied', {
        userId,
        agentId: agent.id,
        selectedSkills: executionSkillIds,
        modelSkill: _executionResolution.sourceSkillIds.model,
        effortSkill: _executionResolution.sourceSkillIds.reasoningEffort,
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
      const userPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'users', userId, 'profile.json');
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
  // Assistant entries persisted with `toolsUsed: [...]` (from persist()
  // above) get a compact "[tools: …]" suffix so the next turn's LLM can
  // see which side-effects happened in the prior turn, not just the prose
  // it wrote. Same idea for `via:` on router-routed turns — the coordinator
  // needs to know the prior reply came from a specialist, not its own run.
  const LLM_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
  const _histSrc = isolatedTaskRun ? [] : (await loadSession(agent.id)).filter(m =>
    LLM_ROLES.has(m.role) && m.excludeFromModel !== true);
  // Full tool-result bodies are inlined ONLY for the last two assistant
  // turns that carry them. Follow-ups ("delete it", "reply to that", "open
  // the second one") reference recent handles — while re-inflating EVERY
  // older turn's results (up to 10 KB per tool) freights the whole history
  // window with stale payloads, evicts real conversation at the trim, and
  // churns the provider prompt cache. Older turns keep the compact
  // "[tools used this turn: …]" suffix.
  const _fullResultIdx = new Set();
  for (let i = _histSrc.length - 1; i >= 0 && _fullResultIdx.size < 2; i--) {
    const m = _histSrc[i];
    if (m.role === 'assistant' && Array.isArray(m.toolResults) && m.toolResults.length) _fullResultIdx.add(i);
  }
  const history = _histSrc
    .map(({ role, content, name, toolsUsed, toolResults, via, viaName }, _idx) => {
      let body = content;
      if (role === 'assistant' && via) {
        body = `${body || ''}\n[note: this reply was produced by the ${viaName ?? via} specialist via the pre-LLM router — you (the coordinator) did not run a turn]`;
      }
      if (role === 'assistant' && Array.isArray(toolsUsed) && toolsUsed.length) {
        body = `${body || ''}\n[tools used this turn: ${toolsUsed.join(', ')}]`;
      }
      // Append the raw tool result bodies persisted by chat.mjs:persist()
      // (capped at 10 KB each at save time). Lets the LLM read message ids,
      // file paths, urls, etc. from prior tool returns — required for
      // follow-ups like "delete it" / "reply to that" / "open the second
      // one" to work without the assistant's user-facing prose having to
      // echo those handles back to the user. Recent-turns-only, see above.
      if (role === 'assistant' && _fullResultIdx.has(_idx) && Array.isArray(toolResults) && toolResults.length) {
        const formatted = toolResults
          .map(r => `${r.name} →\n${r.text}`)
          .join('\n\n---\n\n');
        body = `${body || ''}\n\n[prior-turn tool results]\n${formatted}`;
      }
      return name ? { role, content: body, name } : { role, content: body };
    });

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
        if (!getProfileFilePathForNotes) ({ getProfileFilePath: getProfileFilePathForNotes } = await import('./lib/profile-files.mjs'));
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
    approxTokens += (trimmed[i].content?.length ?? 0) / 4;
    if (approxTokens > TOKEN_BUDGET) { trimmed = trimmed.slice(i + 1); break; }
  }
  // Anthropic requires the first message to be role:user; an arbitrary trim
  // index can leave an assistant (or orphaned partial) message first, which
  // 400s the request exactly when the conversation gets long. Drop leading
  // non-user entries after a trim.
  if (trimmed.length < history.length) {
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
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
    if (agentObj.provider === 'openai-oauth' || grokNativeSearch) {
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
  let { assistantContent, errored, toolsUsed, toolEvents, modelCalls, hideTurn, hideTaskId, usage, turnImages } = yield* bindToolRouterContext(
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
        { const _priorUsage = usage, _priorModelCalls = modelCalls; const _r = yield* bindToolRouterContext(consumeProvider(providerGen, { suppressText: false }), _routerStore); ({ assistantContent, errored, toolsUsed, toolEvents, hideTurn, hideTaskId } = _r); usage = mergeProviderUsage(_priorUsage, _r.usage); modelCalls = [...(_priorModelCalls || []), ...(_r.modelCalls || [])]; turnImages = [...(turnImages || []), ...(_r.turnImages || [])]; }
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
      const { describeBackgroundWorkForSession } = await import('./background-tasks.mjs');
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
      const _priorToolsUsed = toolsUsed, _priorToolEvents = toolEvents, _priorUsage = usage, _priorModelCalls = modelCalls;
      { const _r = yield* bindToolRouterContext(consumeProvider(providerGen, { suppressText: false }), _routerStore); ({ assistantContent, errored, toolsUsed, toolEvents, hideTurn, hideTaskId } = _r); usage = mergeProviderUsage(_priorUsage, _r.usage); modelCalls = [...(_priorModelCalls || []), ...(_r.modelCalls || [])]; turnImages = [...(turnImages || []), ...(_r.turnImages || [])]; toolsUsed = [...(_priorToolsUsed || []), ...(toolsUsed || [])]; toolEvents = [...(_priorToolEvents || []), ...(toolEvents || [])]; }
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
    toolCount: _sizes.toolCount,
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
    source: voiceCtx?.source ?? 'web',
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
      toolCount: _sizes.toolCount,
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
        argsPreview: t.args
          ? JSON.stringify(compactDocumentToolArgs(t.name, redactArgsForTrace(t.args))).slice(0, 500)
          : '',
        resultPreview: redactTextForTrace(compactDocumentToolResult(t.name, t.text)).slice(0, 500),
      })),
      events: toolEvents.map(t => ({
        name: t.name,
        ...(t.native === true ? { providerNative: true } : {}),
        status: t.status,
        durationMs: t.durationMs ?? null,
        preview: redactTextForTrace(compactDocumentToolPreview(t.name, t.preview ?? t.progressPreview)).slice(0, 500),
      })),
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
    const traceError = turnOpts?.documentRequest
      ? (compactDocumentFallback(assistantContent) || 'Provider turn errored')
      : (assistantContent || 'Provider turn errored');
    recordRunTrace(userId, { ..._traceBase, status: 'error', error: traceError });
    _emitTurnTrace(traceError);
    // A provider can fail after update_document already committed. Preserve the
    // successful artifact even though there is no final narration to persist.
    if (!silent && turnOpts?.documentRequest && findDocumentMutation(toolsUsed)) {
      try {
        await persist(agent, sessionText, '', userId, emit, skipSignals, skipEpisodes, {
          withSignalWordsGate, toolsUsed, toolEvents, voiceCtx, hideTurn, hideTaskId,
          hiddenUser: turnOpts?.hiddenUser === true, turnImages, attachments,
          readOnlyTurn,
          suppressLearning,
          workerLeafRun: Boolean(workerMemoryOwnerId),
          documentRequest: turnOpts.documentRequest,
        });
      } catch (e) {
        console.warn('[chat] error-path persist failed:', e.message);
        yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'The document action may have completed, but its chat record could not be saved. Do not retry automatically.' };
      }
    }
    return;
  }
  log.info('chat', 'llm turn complete', _llmMeta);
  recordRunTrace(userId, { ..._traceBase, status: 'complete' });
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
        withSignalWordsGate, toolsUsed, toolEvents, voiceCtx, hideTurn, hideTaskId,
        hiddenUser: turnOpts?.hiddenUser === true, turnImages, attachments,
        readOnlyTurn,
        suppressLearning,
        workerLeafRun: Boolean(workerMemoryOwnerId),
        documentRequest: turnOpts?.documentRequest ?? null,
      });
    } catch (e) {
      console.warn('[chat] persist failed:', e.message);
      yield { type: 'error', code: 'persistence_failed', retryable: false, message: 'The reply finished, but the chat turn could not be saved. Reload before trying again.' };
      return;
    }
  }
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
