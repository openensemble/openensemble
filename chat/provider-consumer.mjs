/**
 * Provider stream consumer + tool-call identity / usage merge helpers.
 *
 * Extracted from chat.mjs (facade re-exports public symbols). Pure move —
 * behavior is unchanged. streamChat and persist stay in chat.mjs.
 */

import { looksLikeToolError } from '../lib/tool-error.mjs';
import { recordError } from '../lib/turn-trace-context.mjs';
import { toolRouterContext } from '../lib/tool-router-context.mjs';
import { redactTextForTrace } from '../lib/run-inspector.mjs';
import {
  compactDocumentToolResult,
  sanitizeDocumentToolEvent,
} from '../lib/document-artifacts.mjs';

const TOOL_IDENTITY_ANOMALY_REASONS = new Set([
  'invalid_result_identity',
  'unknown_result_identity',
  'duplicate_result_identity',
]);
export const MAX_TOOL_IDENTITY_ANOMALIES = 32;

export function compactToolIdentityAnomaly(value) {
  const rawName = String(value?.name ?? 'unknown_tool')
    .replace(/[\r\n\0]/g, ' ')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_');
  const toolCallId = typeof value?.toolCallId === 'string'
      && value.toolCallId
      && value.toolCallId === value.toolCallId.trim()
      && value.toolCallId.length <= 512
      && !/[\r\n\0]/.test(value.toolCallId)
    ? value.toolCallId
    : null;
  const identityLength = Number.isSafeInteger(value?.identityLength) && value.identityLength >= 0
    ? value.identityLength
    : null;
  return {
    kind: 'tool_result_identity_anomaly',
    name: (rawName || 'unknown_tool').slice(0, 80),
    reason: TOOL_IDENTITY_ANOMALY_REASONS.has(value?.reason)
      ? value.reason
      : 'unknown_result_identity',
    ...(toolCallId ? { toolCallId } : {}),
    identityType: String(value?.identityType ?? 'unknown').slice(0, 40),
    ...(identityLength != null ? { identityLength } : {}),
    ...(value?.providerNative === true ? { providerNative: true } : {}),
    ...(value?.delegated === true ? { delegated: true } : {}),
    resultPreview: redactTextForTrace(value?.resultPreview ?? '').slice(0, 500),
    observedAt: Number.isFinite(value?.observedAt) ? value.observedAt : Date.now(),
  };
}

export function toolIdentityDurabilityWarning(anomalies) {
  const compact = (Array.isArray(anomalies) ? anomalies : [])
    .slice(0, MAX_TOOL_IDENTITY_ANOMALIES)
    .map(compactToolIdentityAnomaly);
  if (!compact.length) return '';
  const names = [...new Set(compact.map(item => item.name))].slice(0, 4);
  const subject = names.length === 1
    ? `tool "${names[0]}"`
    : `tools ${names.map(name => `"${name}"`).join(', ')}`;
  return `[Server durability warning: The action may already have completed. Do not automatically retry it. Completion evidence from ${subject} could not be matched to a verified provider tool-call identity; verify the outcome first or ask the user before trying again.]`;
}

// async since the durability fix: the session write is awaited so callers can
// hold the terminal `done` until the turn is actually on disk. Everything
// after the write (friction/proposers/signals) stays fire-and-forget on normal
// turns. An authenticated verifier preserves the real session/tool path but
// stops here before any delayed learning work can cross the terminal boundary.


function optionalSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isProviderCallOrdinal(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalProviderToolCallId(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
      || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error('provider supplied an invalid tool call identity');
  }
  return value;
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
export async function* consumeProvider(providerGen, {
  suppressText = false,
  providerCallOrdinalOffset = 0,
} = {}) {
  let assistantContent = '';
  let errored = false;
  // Phase-14 chip-replaces-turn: tools may yield `__hide_turn` to indicate
  // their result is a backgrounded task with a live chat chip — the
  // assistant's text reply for this turn is redundant and should be hidden.
  let hideTurn = false;
  let hideTaskId = null;
  const toolsUsed = [];
  const toolEvents = [];
  const toolIdentityAnomalies = [];
  const modelCalls = [];
  const turnImages = [];
  // One synthetic web_search record per turn when the provider's hosted search
  // runs (it emits only tool_progress, never a local tool_call/result pair).
  let _nativeSearchRecorded = false;
  // Latest tool_call args by name, attached to the matching tool_result so
  // downstream proposers (routine-proposer) can inspect what the LLM passed.
  let _lastCallArgsByName = Object.create(null);
  let _pendingToolEventsByName = Object.create(null);
  const _providerToolCallsById = new Map();
  // Each provider generator starts its own round counter. Chat-level recovery
  // can create a second generator for the same durable turn, so callers pass
  // the number of model calls already observed and we continue the canonical,
  // turn-wide ordinal instead of colliding with the first attempt's rounds.
  const _providerCallOffset = Number.isSafeInteger(providerCallOrdinalOffset)
    && providerCallOrdinalOffset >= 0
    ? providerCallOrdinalOffset
    : 0;
  let _providerCallCount = 0;
  let _providerCallOrdinal = null;
  const quarantineToolResultIdentity = (event, reason, providerToolCallId = null) => {
    const suppliedIdentity = event?.toolCallId;
    toolIdentityAnomalies.push(compactToolIdentityAnomaly({
      name: event?.name,
      reason,
      ...(providerToolCallId ? { toolCallId: providerToolCallId } : {}),
      identityType: typeof suppliedIdentity,
      ...(typeof suppliedIdentity === 'string' ? { identityLength: suppliedIdentity.length } : {}),
      providerNative: event?.providerNative === true || event?.native === true,
      delegated: event?.delegated === true,
      resultPreview: compactDocumentToolResult(event?.name, event?.text ?? ''),
      observedAt: Date.now(),
    }));
  };
  // Capture the provider's end-of-turn token usage for the turn trace. The
  // event is still yielded onward (llm-loop records it for billing); we just
  // also stash it so streamChat can attach it to its span without re-plumbing
  // usage through every streamChat consumer. inTok/outTok avoid logger.mjs's
  // /token/ redact key (see lib/turn-trace-context.mjs).
  let usage = null;
  try {
  for await (const event of providerGen) {
    let providerToolCallId = null;
    if (event?.toolCallId != null) {
      try {
        providerToolCallId = canonicalProviderToolCallId(event.toolCallId);
      } catch (error) {
        if (event?.type === 'tool_result') {
          quarantineToolResultIdentity(event, 'invalid_result_identity');
        }
        throw error;
      }
    }
    if (event.type === '__content') { assistantContent = event.content; continue; }
    if (event.type === '__model_call') {
      _providerCallCount += 1;
      const nextOrdinal = _providerCallOffset + _providerCallCount;
      _providerCallOrdinal = isProviderCallOrdinal(nextOrdinal) ? nextOrdinal : null;
      const router = toolRouterContext.getStore();
      modelCalls.push({
        ...(_providerCallOrdinal ? { ordinal: _providerCallOrdinal } : {}),
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
      if (providerToolCallId) {
        const priorName = _providerToolCallsById.get(providerToolCallId);
        if (priorName) {
          throw new Error(`provider repeated tool call identity ${providerToolCallId} for ${event.name} (already used by ${priorName})`);
        }
        _providerToolCallsById.set(providerToolCallId, event.name);
      }
      _lastCallArgsByName[event.name] = event.args ?? null;
      const rec = {
        name: event.name,
        ...(providerToolCallId ? { toolCallId: providerToolCallId } : {}),
        ...(_providerCallOrdinal ? { providerCallOrdinal: _providerCallOrdinal } : {}),
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
      const pendingForName = _pendingToolEventsByName[event.name] ?? [];
      const pending = providerToolCallId
        ? pendingForName.find(item => item.toolCallId === providerToolCallId)
        : pendingForName[0];
      if (providerToolCallId && !pending) {
        throw new Error(`tool progress carried an unknown call identity for ${event.name}`);
      }
      if (pending) {
        const clean = String(event.text ?? '').slice(-1200);
        pending.progressPreview = clean;
        pending.updatedAt = Date.now();
        if (event.providerNative === true || event.native === true) pending.native = true;
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
        toolEvents.push({
          name: 'web_search',
          ...(_providerCallOrdinal ? { providerCallOrdinal: _providerCallOrdinal } : {}),
          args: null,
          startedAt: now,
          endedAt: now,
          durationMs: 0,
          status: 'done',
          native: true,
        });
      }
    }
    if (event.type === 'tool_result' && event.name) {
      // Match canonical provider identities when available. Legacy providers
      // that omit identities retain FIFO-by-name correlation.
      const pendingForName = _pendingToolEventsByName[event.name] ?? [];
      const exactMatchIndex = providerToolCallId
        ? pendingForName.findIndex(item => item.toolCallId === providerToolCallId)
        : -1;
      if (providerToolCallId && exactMatchIndex < 0) {
        const priorName = _providerToolCallsById.get(providerToolCallId);
        quarantineToolResultIdentity(
          event,
          priorName === event.name ? 'duplicate_result_identity' : 'unknown_result_identity',
          providerToolCallId,
        );
        throw new Error(`tool result carried an unknown or duplicate call identity for ${event.name}`);
      }
      const matchedIndex = providerToolCallId
        ? exactMatchIndex
        : (pendingForName.length ? 0 : -1);
      const _matched = matchedIndex >= 0 ? pendingForName[matchedIndex] : null;
      const _providerNative = _matched?.native === true
        || event.providerNative === true
        || event.native === true;
      toolsUsed.push({
        name: event.name,
        text: event.text || '',
        args: (_matched?.args ?? _lastCallArgsByName[event.name]) ?? null,
        ...(providerToolCallId ? { toolCallId: providerToolCallId } : {}),
        ...(_providerNative ? { native: true } : {}),
      });
      // A tool that caught its own error and returned an error string (or one
      // the dispatcher caught and emitted as "Tool error (…)") completes the
      // tool loop normally — without this it would record status:'done' and the
      // span's ok:true, masking the failure in read_turns/Lois. See
      // lib/tool-error.mjs.
      const _toolErrored = looksLikeToolError(event.text);
      const _toolStatus = _toolErrored ? 'error' : 'done';
      const pending = matchedIndex >= 0
        ? _pendingToolEventsByName[event.name]?.splice(matchedIndex, 1)?.[0]
        : null;
      if (pending) {
        pending.status = _toolStatus;
        pending.endedAt = Date.now();
        pending.durationMs = pending.endedAt - pending.startedAt;
        pending.preview = event.preview ?? '';
        pending.text = event.text || '';
        pending.delegated = pending.delegated || event.delegated === true;
        pending.agentName = pending.agentName || event.agentName || null;
        pending.targetAgentId = pending.targetAgentId || event.targetAgentId || null;
        if (_providerNative) pending.native = true;
      } else {
        toolEvents.push({
          name: event.name,
          ...(providerToolCallId ? { toolCallId: providerToolCallId } : {}),
          ...(_providerCallOrdinal ? { providerCallOrdinal: _providerCallOrdinal } : {}),
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
    ? { assistantContent: '', errored: true, toolsUsed, toolEvents, toolIdentityAnomalies, modelCalls, hideTurn: false, hideTaskId: null, usage, turnImages }
    : { assistantContent, errored: false, toolsUsed, toolEvents, toolIdentityAnomalies, modelCalls, hideTurn, hideTaskId, usage, turnImages };
}

