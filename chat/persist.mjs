/**
 * Session persistence + desktop artifact helpers for chat turns.
 */
import { buildAgentContext, formatContext, addToSessionBuffer, processSignals } from '../memory.mjs';
import { trackFriction } from '../memory/signals.mjs';
import { loadSession, appendToSession } from '../sessions.mjs';
import {
  detectProactiveNegativeFeedback,
  handleProactiveNegativeFeedback,
} from '../lib/personalization/negative-feedback.mjs';
import { log } from '../logger.mjs';
import { getTurn, recordError } from '../lib/turn-trace-context.mjs';
import { learnToolPlanFromTurn } from '../lib/tool-plan-memory.mjs';
import { listRoles } from '../roles.mjs';
import { recordRunTrace, redactArgsForTrace, redactTextForTrace } from '../lib/run-inspector.mjs';
import { applyRedactions } from '../lib/credentials.mjs';
import { listDesktops, sendDesktopCommand } from '../lib/desktop-bus.mjs';
import {
  compactDocumentFallback,
  compactDocumentToolArgs,
  compactDocumentToolPreview,
  compactDocumentToolResult,
  findDocumentMutation,
  normalizeDocumentRequest,
} from '../lib/document-artifacts.mjs';
import { getUserFilesDir, USERS_DIR } from '../lib/paths.mjs';
import {
  compactToolIdentityAnomaly,
  toolIdentityDurabilityWarning,
  MAX_TOOL_IDENTITY_ANOMALIES,
  isProviderCallOrdinal,
} from './provider-consumer.mjs';

// ── Session persistence + memory signal dispatch ─────────────────────────────
// Shared across every provider branch. `withSignalWordsGate` matches the
// Anthropic-only gate that skips signal detection on orchestrator agents
// unless the message actually contains preference/correction wording.
export const SIGNAL_WORDS_RE = /prefer|like|love|hate|want|don'?t like|remember|decided|will use|choose|chose|my name|i am|i'm|my \w+ is|call me|always|never|make sure|correction/i;

export function _desktopToolText(data) {
  const item = Array.isArray(data?.content) ? data.content.find(p => p?.type === 'text') : null;
  return item?.text ? String(item.text) : '';
}

export function _desktopSavedPath(data) {
  const text = _desktopToolText(data);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

export async function saveDesktopArtifact(userId, { source, sandbox, filename, base64, url, timeoutMs = 60_000 } = {}) {
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

export function buildDesktopFoldersBlock(userId, source) {
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
export function _modelContextWindow(model) {
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

export function documentArtifactContent(request, artifact, fallback = '') {
  if (!artifact) return request ? compactDocumentFallback(fallback) : fallback;
  return `[Document ${artifact.action}: ${artifact.filename || request?.filename || 'document'}${artifact.version ? ` (v${artifact.version})` : ''}]`;
}

export async function persist(agent, sessionText, assistantContent, userId, emit, skipSignals, skipEpisodes, { withSignalWordsGate = false, toolsUsed = [], toolEvents = [], toolIdentityAnomalies = [], voiceCtx = null, hideTurn = false, hideTaskId = null, hiddenUser = false, excludeHiddenUserFromModel = false, turnImages = [], attachments = [], documentRequest = null, readOnlyTurn = false, suppressLearning = false, workerLeafRun = false } = {}) {
  // Detached task workers are deliberately non-learning. Their completed
  // report is persisted by the owner-continuation path; writing a second
  // ephemeral session here is unnecessary, and proceeding below would also
  // feed friction/routine proposals or Cortex learning from an internal task
  // prompt. Operational run traces are recorded outside persist() and remain.
  if (workerLeafRun) return;
  const safeDocumentRequest = normalizeDocumentRequest(documentRequest);
  const documentArtifact = safeDocumentRequest ? findDocumentMutation(toolsUsed) : null;
  const compactToolIdentityAnomalies = (Array.isArray(toolIdentityAnomalies) ? toolIdentityAnomalies : [])
    .slice(0, MAX_TOOL_IDENTITY_ANOMALIES)
    .map(compactToolIdentityAnomaly);
  const identityDurabilityWarning = toolIdentityDurabilityWarning(compactToolIdentityAnomalies);
  const baseAssistantContent = documentArtifactContent(safeDocumentRequest, documentArtifact, assistantContent);
  const persistedAssistantContent = identityDurabilityWarning
    ? [baseAssistantContent, identityDurabilityWarning].filter(Boolean).join('\n\n')
    : baseAssistantContent;
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
  // mapper below as a structured tool result paired with its original call.
  // Doesn't render in the chat UI (only the assistant content does).
  const toolResults = toolsUsed.length
    ? toolsUsed.map(t => ({
        name: t.name,
        text: compactDocumentToolResult(t.name, t.text),
        ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
        ...(t.native === true ? { native: true } : {}),
      }))
        .filter(r => r.text.length > 0)
    : null;
  const resultCursorByName = new Map();
  const claimedToolResultIndexes = new Set();
  const nextToolResultIndex = (name, toolCallId = null) => {
    if (!toolResults?.length) return null;
    if (toolCallId) {
      const exactIndex = toolResults.findIndex((result, index) =>
        !claimedToolResultIndexes.has(index)
        && result?.name === name
        && result?.toolCallId === toolCallId);
      if (exactIndex < 0) return null;
      claimedToolResultIndexes.add(exactIndex);
      return exactIndex;
    }
    const start = resultCursorByName.get(name) ?? 0;
    for (let i = start; i < toolResults.length; i++) {
      if (toolResults[i]?.name === name && !claimedToolResultIndexes.has(i)) {
        resultCursorByName.set(name, i + 1);
        claimedToolResultIndexes.add(i);
        return i;
      }
    }
    return null;
  };
  const compactToolEvents = Array.isArray(toolEvents) && toolEvents.length
    ? toolEvents.map(t => {
        const resultIndex = t.text ? nextToolResultIndex(t.name, t.toolCallId) : null;
        return {
          name: t.name,
          ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
          ...(isProviderCallOrdinal(t.providerCallOrdinal)
            ? { providerCallOrdinal: t.providerCallOrdinal }
            : {}),
          ...(t.native === true ? { native: true } : {}),
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
  const assistantEntry = {
    role: 'assistant', content: persistedAssistantContent, ts: Date.now(),
    ...(toolsSummary ? { toolsUsed: toolsSummary } : {}),
    ...(toolResults && toolResults.length ? { toolResults } : {}),
    ...((toolsSummary || compactToolIdentityAnomalies.length)
        && compactToolEvents && compactToolEvents.length
      ? { toolEvents: compactToolEvents }
      : {}),
    ...(compactToolIdentityAnomalies.length
      ? { toolIdentityAnomalies: compactToolIdentityAnomalies }
      : {}),
  };
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
          // A filename is only a label; without a durable savedPath the inline
          // bytes remain the sole renderable copy after reload.
          ...(img.base64 && !img.savedPath ? { base64: img.base64 } : {}),
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
      ...(hiddenUser && excludeHiddenUserFromModel ? { excludeFromModel: true } : {}),
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
    import('../lib/skill-proposer.mjs')
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
  import('../lib/routine-proposer.mjs')
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
    import('../lib/location-fact-proposer.mjs')
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
    import('../lib/skill-telemetry.mjs')
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
        const { userSkillsDir } = await import('../lib/paths.mjs');
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
        const { appendTrigger } = await import('../lib/skill-triggers.mjs');
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
  if (toolsUsed.length || compactToolIdentityAnomalies.length) return;
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
