// @ts-check
/**
 * Deterministic negative feedback for proactive behavior.
 *
 * This module intentionally does not learn a new preference. It resolves a
 * narrow, deictic user reaction ("don't do that again", "not useful", …) to
 * an already-visible, user-owned proactive source and then uses that source's
 * existing durable stop control:
 *
 *   - automatic-personalization receipt -> suppress that offer kind
 *   - lead-hit receipt                 -> dismiss that one-shot lead
 *   - watcher status                   -> unregister that exact watcher
 *
 * An explicit UI/source hint wins. Otherwise exact context text wins, then a
 * uniquely recent source. Any ambiguity is a no-op; callers should not ask a
 * follow-up or reinterpret the reaction as a preference/correction.
 */

const RECENT_SOURCE_MS = 15 * 60_000;
const MIN_LATEST_SEPARATION_MS = 10_000;
const CANONICAL_KIND_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_KIND_LEN = 60;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Recognize only standalone feedback phrases. Anchoring is important: a turn
 * such as "don't do that again; send an email instead" remains an ordinary
 * action request and is never consumed here.
 *
 * @param {string} text
 * @returns {{ kind: 'behavior'|'updates', phrase: string } | null}
 */
export function detectProactiveNegativeFeedback(text) {
  const phrase = normalizeText(text);
  if (!phrase || phrase.length > 100) return null;

  if (/^(?:please )?stop (?:sending |showing )?(?:these|those|the|this) updates?$/.test(phrase)
    || /^(?:please )?(?:don't|do not) send (?:me )?(?:these|those|the|this) updates?(?: again)?$/.test(phrase)
    || /^(?:no more|enough with) (?:these|those|the|this) updates?$/.test(phrase)
    || /^(?:these|those) updates? (?:are|were) not useful(?: to me)?$/.test(phrase)
    || /^(?:these|those) updates? (?:aren't|weren't) useful(?: to me)?$/.test(phrase)) {
    return { kind: 'updates', phrase };
  }

  if (/^(?:please )?(?:don't|do not) do (?:that|this)(?: again)?$/.test(phrase)
    || /^(?:please )?(?:don't|do not) (?:send|show) (?:me )?(?:that|this)(?: again)?$/.test(phrase)
    || /^(?:please )?never do (?:that|this) again$/.test(phrase)
    || /^(?:not useful|unhelpful)(?: to me)?$/.test(phrase)
    || /^(?:that|this|it) (?:is|was) not useful(?: to me)?$/.test(phrase)
    || /^(?:that|this|it) (?:isn't|wasn't) useful(?: to me)?$/.test(phrase)) {
    return { kind: 'behavior', phrase };
  }

  return null;
}

function dateMs(...values) {
  let latest = NaN;
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Date.parse(value || '');
    if (Number.isFinite(parsed) && (!Number.isFinite(latest) || parsed > latest)) latest = parsed;
  }
  return latest;
}

function canonicalKind(kind) {
  return typeof kind === 'string' && kind.length > 0 && kind.length <= MAX_KIND_LEN
    && CANONICAL_KIND_RE.test(kind);
}

function agentMatches(recordAgentId, agentId, userId) {
  if (!agentId || !recordAgentId) return true;
  return recordAgentId === agentId
    || recordAgentId === `${userId}_${agentId}`
    || agentId === `${userId}_${recordAgentId}`;
}

function contextMatches(candidate, contextText) {
  const context = normalizeText(contextText);
  if (!context) return false;
  for (const value of candidate.contextTexts || []) {
    const target = normalizeText(value);
    if (!target) continue;
    if (target.length >= 4 && context === target) return true;
    if (target.length >= 12 && context.includes(target)) return true;
  }
  return false;
}

function collapseTargets(candidates) {
  const byTarget = new Map();
  for (const candidate of candidates) {
    const prior = byTarget.get(candidate.targetKey);
    if (!prior) {
      byTarget.set(candidate.targetKey, candidate);
      continue;
    }
    // A safe-activation receipt owns the complete rollback contract for its
    // watcher (stop watcher + suppress exact offer policy + receipt state).
    // Prefer it over the raw watcher candidate even when the watcher emitted a
    // slightly newer line, while retaining both pieces of visible context.
    const preferred = candidate.targetType === 'safe_activation' && prior.targetType !== 'safe_activation'
      ? candidate
      : (prior.targetType === 'safe_activation' && candidate.targetType !== 'safe_activation'
        ? prior
        : (candidate.at > prior.at ? candidate : prior));
    preferred.at = Math.max(prior.at, candidate.at);
    preferred.visible = prior.visible === true || candidate.visible === true;
    preferred.aliases = [...new Set([...(prior.aliases || []), ...(candidate.aliases || [])])];
    preferred.contextTexts = [...new Set([...(prior.contextTexts || []), ...(candidate.contextTexts || [])])];
    byTarget.set(candidate.targetKey, preferred);
  }
  return [...byTarget.values()];
}

async function collectCandidates({ userId, agentId }) {
  const [inbox, watchers] = await Promise.all([
    import('./proactive-inbox.mjs'),
    import('../../scheduler/watchers.mjs'),
  ]);

  // The explicit-hint path may point at an older visible receipt, so read the
  // bounded full inbox history. Recency filtering happens only at selection.
  const [events, watcherGroups] = await Promise.all([
    inbox.listProactiveEvents(userId, { limit: 500 }),
    Promise.resolve(watchers.listWatchers(userId)),
  ]);

  const candidates = [];
  for (const event of events) {
    if (!['pending', 'delivered', 'read'].includes(event?.status)) continue;
    const visible = event.status === 'delivered' || event.status === 'read';
    // Pending succeeded receipts may be shown in the authenticated inbox UI
    // and are therefore valid only through an explicit eventId. They must
    // never participate in natural-language latest/context inference.
    const at = visible
      ? dateMs(event.readAt, event.deliveredAt)
      : dateMs(event.updatedAt, event.createdAt);
    if (!Number.isFinite(at)) continue;

    if (event.kind === 'personalization_auto_offer') {
      const kind = event.metadata?.offerKind;
      const succeeded = !!event.metadata?.executedAt || event.metadata?.executionState === 'succeeded';
      if (!succeeded || !canonicalKind(kind)) continue;
      candidates.push({
        sourceType: 'receipt', targetType: 'offer_policy', targetKey: `offer:${kind}`,
        eventId: event.id, offerKind: kind, at, visible,
        aliases: [event.id, event.sourceId, event.sourceId ? `offer_${event.sourceId}` : null].filter(Boolean),
        contextTexts: [event.text],
      });
      continue;
    }

    if (event.kind === 'preference_monitor_activation') {
      const artifact = event.metadata?.control?.artifact;
      const offerKind = event.metadata?.offerKind;
      const succeeded = !!event.metadata?.executedAt || event.metadata?.executionState === 'succeeded';
      // The controller performs its own full authorization/fingerprint check;
      // this validation merely keeps malformed receipts out of NL targeting.
      if (!succeeded || event.metadata?.actionContract !== 'skill_preference_activation'
        || artifact?.kind !== 'preference_monitor'
        || typeof artifact.watcherId !== 'string' || !artifact.watcherId
        || !canonicalKind(offerKind) || artifact.offerKind !== offerKind
        || typeof artifact.contractFingerprint !== 'string' || !artifact.contractFingerprint
        || event.metadata?.contractFingerprint !== artifact.contractFingerprint) continue;
      candidates.push({
        sourceType: 'activation', targetType: 'safe_activation',
        targetKey: `watcher:${artifact.watcherId}`,
        eventId: event.id, watcherId: artifact.watcherId, offerKind, at, visible,
        aliases: [event.id, artifact.watcherId], contextTexts: [event.text],
      });
      continue;
    }

    if (event.kind === 'lead_hit') {
      const leadId = event.metadata?.leadId || event.sourceId;
      if (typeof leadId !== 'string' || !leadId) continue;
      candidates.push({
        sourceType: 'lead', targetType: 'lead', targetKey: `lead:${leadId}`,
        eventId: event.id, leadId, at, visible,
        aliases: [event.id, leadId, `lead_${leadId}`],
        contextTexts: [event.text],
      });
    }
  }

  for (const watcher of watcherGroups?.active || []) {
    // Task-proxy bubbles are user-requested work in progress, not proactive
    // personalization. A terse reaction to an assistant turn must never
    // silently cancel one of those jobs.
    if (!watcher?.id || watcher.kind === 'task_proxy' || !watcher.lastStatusText) continue;
    if (!agentMatches(watcher.agentId, agentId, userId)) continue;
    const full = watchers.getWatcher(userId, watcher.id);
    if (!full || full.status !== 'active' || (full.userId && full.userId !== userId)) continue;
    const tailTs = Array.isArray(full.history) ? full.history.at(-1)?.ts : null;
    const at = dateMs(tailTs, full.lastChangeAt);
    if (!Number.isFinite(at)) continue;
    candidates.push({
      sourceType: 'watcher', targetType: 'watcher', targetKey: `watcher:${full.id}`,
      watcherId: full.id, at, visible: true, aliases: [full.id], contextTexts: [full.lastStatusText],
    });
  }

  return candidates;
}

function selectCandidate(candidates, { feedback, contextText, context, now }) {
  // An authenticated ID or exact visible text is stronger than the wording
  // heuristic: "stop these updates" on an explicit auto-action receipt must
  // still stop that receipt's exact policy. Source-type narrowing applies only
  // to the deictic latest-source fallback.
  const allTargets = collapseTargets(candidates);

  const hintedIds = [context?.proactiveEventId, context?.watcherId]
    .filter(value => typeof value === 'string' && value);
  if (hintedIds.length) {
    const hinted = allTargets.filter(candidate => hintedIds.some(id => candidate.aliases?.includes(id)));
    return hinted.length === 1
      ? { candidate: hinted[0], reason: 'explicit-context' }
      : { candidate: null, reason: hinted.length ? 'ambiguous' : 'no-target' };
  }

  if (contextText) {
    const contextual = allTargets.filter(candidate => candidate.visible && contextMatches(candidate, contextText));
    if (contextual.length === 1) return { candidate: contextual[0], reason: 'text-context' };
    if (contextual.length > 1) return { candidate: null, reason: 'ambiguous' };
  }

  const allowed = feedback.kind === 'updates'
    ? allTargets.filter(candidate => candidate.sourceType === 'watcher'
      || candidate.sourceType === 'lead' || candidate.sourceType === 'activation')
    : allTargets;
  const recent = allowed
    .filter(candidate => candidate.visible && Number.isFinite(candidate.at)
      && candidate.at <= now && now - candidate.at <= RECENT_SOURCE_MS)
    .sort((a, b) => b.at - a.at);
  if (!recent.length) return { candidate: null, reason: 'no-target' };
  if (recent.length === 1) return { candidate: recent[0], reason: 'recent' };
  if (recent[0].at - recent[1].at < MIN_LATEST_SEPARATION_MS) {
    return { candidate: null, reason: 'ambiguous' };
  }
  return { candidate: recent[0], reason: 'latest' };
}

async function applyCandidate(userId, candidate) {
  if (candidate.targetType === 'safe_activation') {
    const { controlPreferenceAutomationReceipt } = await import('./preference-opportunities.mjs');
    if (typeof controlPreferenceAutomationReceipt !== 'function') return null;
    const controlled = await controlPreferenceAutomationReceipt(userId, candidate.eventId, 'stop');
    if (controlled?.ok !== true) return null;
    return {
      action: 'preference-automation-stopped',
      target: { type: 'preference_monitor_activation', eventId: candidate.eventId, watcherId: candidate.watcherId, kind: candidate.offerKind },
    };
  }

  if (candidate.targetType === 'offer_policy') {
    const { setKindSuppressed } = await import('./graduation.mjs');
    await setKindSuppressed(userId, candidate.offerKind, true);
    return { action: 'offer-kind-suppressed', target: { type: 'offer_policy', kind: candidate.offerKind } };
  }

  if (candidate.targetType === 'lead') {
    const { dismissLead } = await import('./leads.mjs');
    const dismissed = await dismissLead(userId, candidate.leadId);
    return dismissed
      ? { action: 'lead-dismissed', target: { type: 'lead', id: candidate.leadId } }
      : null;
  }

  if (candidate.targetType === 'watcher') {
    const { getWatcher, unregisterWatcher } = await import('../../scheduler/watchers.mjs');
    const watcher = getWatcher(userId, candidate.watcherId);
    if (!watcher || watcher.status !== 'active' || (watcher.userId && watcher.userId !== userId)) return null;
    const stopped = unregisterWatcher(userId, candidate.watcherId, 'cancelled');
    return stopped
      ? { action: 'watcher-stopped', target: { type: 'watcher', id: candidate.watcherId } }
      : null;
  }

  return null;
}

/**
 * Resolve and apply a terse natural-language rejection of proactive behavior.
 *
 * `context` is the preferred integration point for a UI reply/control. Both
 * IDs are re-resolved through user-scoped stores; callers cannot use the hint
 * to act on another user's receipt or watcher. Synthetic websocket IDs such
 * as `offer_<opportunityId>` / `lead_<leadId>` are accepted too.
 *
 * @param {{
 *   userId: string,
 *   agentId?: string,
 *   userMessage: string,
 *   contextText?: string|null,
 *   context?: { proactiveEventId?: string|null, watcherId?: string|null }|null,
 *   eventId?: string|null,
 *   now?: number|Date,
 * }} input
 */
export async function handleProactiveNegativeFeedback({
  userId, agentId = '', userMessage, contextText = '', context = null, eventId = null, now = Date.now(),
}) {
  const feedback = detectProactiveNegativeFeedback(userMessage);
  if (!feedback) return { recognized: false, handled: false, reason: 'not-feedback' };
  if (!userId) return { recognized: true, handled: false, reason: 'no-target' };

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return { recognized: true, handled: false, reason: 'no-target' };

  let candidates;
  try {
    candidates = await collectCandidates({ userId, agentId });
  } catch (e) {
    console.warn(`[personalization] proactive feedback context unavailable: ${e?.message || e}`);
    return { recognized: true, handled: false, reason: 'context-unavailable' };
  }

  const selected = selectCandidate(candidates, {
    feedback, contextText,
    context: eventId ? { ...(context || {}), proactiveEventId: eventId } : context,
    now: nowMs,
  });
  if (!selected.candidate) return { recognized: true, handled: false, reason: selected.reason };

  try {
    const applied = await applyCandidate(userId, selected.candidate);
    if (!applied) return { recognized: true, handled: false, reason: 'stale-target' };
    return { recognized: true, handled: true, reason: selected.reason, ...applied };
  } catch (e) {
    console.warn(`[personalization] proactive feedback could not be applied: ${e?.message || e}`);
    return { recognized: true, handled: false, reason: 'apply-failed' };
  }
}
