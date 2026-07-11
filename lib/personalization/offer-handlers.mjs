// @ts-check
/**
 * Accept-side handlers for the two personalization proposal kinds, called
 * from lib/proposals.mjs's acceptProposal if-chain (integrator-wired):
 *
 *   } else if (p.kind === 'personalization_offer') {
 *     const m = await import('./personalization/offer-handlers.mjs');
 *     await m.runPersonalizationOffer(p, { persistOutcome, broadcast: _wsBroadcastFn, persistUser });
 *   } else if (p.kind === 'personalization_graduate') { ...runPersonalizationGraduate same shape... }
 *
 * `ph` supplies the three proposals.mjs-scoped helpers we need but don't own:
 * persistOutcome(proposal, status, outcomeText), broadcast(userId, wsMsg),
 * persistUser(userId). We mutate `p` in place (it's the same object held in
 * proposals.mjs's in-memory map) and let ph.persistUser serialize it.
 *
 * Shape copied exactly from runRulePromotion (lib/proposals.mjs:1286-1329):
 * set a terminal status, persistOutcome, broadcast proposal_outcome. Per
 * CONTRACTS v1.2 item 2 the terminal status here is 'done'/'failed' (NOT
 * 'accepted' — that's the rule_promotion / generic-agent-run kinds' choice).
 */
import { randomUUID } from 'crypto';
import { recordOfferOutcome, markKindAutoApproved, resetGraduateOffer, isCanonicalOfferKind } from './graduation.mjs';
import { recordStructuredSignal, suppressObservations } from './recorder.mjs';
import { looksLikeToolError } from '../tool-error.mjs';
import { redactSecretsInText } from './signal-safety.mjs';

function isToolRefusal(text) {
  return /^(?:Unknown tool:|Tool ".+" is not permitted for this account\.|Tool ".+" is from a disabled skill\.|Tool ".+" is hidden by your settings\.)/i.test(String(text || '').trim())
    || /\bis running in the background\b/i.test(String(text || ''));
}

async function recordOfferSignals(p, { choice, succeeded, phase = 'offer' }) {
  if (!p?.userId || !p?.offerKind) return;
  const metadata = {
    phase,
    choice,
    succeeded: !!succeeded,
    offerKind: p.offerKind,
    opportunityId: p.opportunityId || null,
    proposalId: p.id || null,
  };
  await Promise.allSettled([
    recordStructuredSignal({
      userId: p.userId,
      agentId: p.agentId || null,
      type: 'choice',
      statement: `${choice === 'accepted' ? 'Accepted' : 'Dismissed'} personalization ${phase}: ${p.offerKind}`,
      source: 'personalization_offer',
      metadata,
    }),
    recordStructuredSignal({
      userId: p.userId,
      agentId: p.agentId || null,
      type: 'outcome',
      statement: `Personalization ${phase} ${p.offerKind} ${succeeded ? 'succeeded' : 'failed'}`,
      source: 'personalization_offer',
      metadata,
    }),
  ]);
}

/**
 * Drains executeToolStreaming, collecting {type:'result'} text + any error
 * flag. Wrapped in suppressObservations — this IS the personalization
 * system's own automated tool invocation (an accepted offer's action.tool),
 * not user activity, so it must never feed roles.mjs's unconditional
 * recordToolObservation hook and land in the observation log as if the user
 * had done it themselves.
 */
async function _runAction(action, userId, agentId) {
  const { executeToolStreaming } = await import('../../roles.mjs');
  return suppressObservations(async () => {
    let text = '';
    let isError = false;
    let sawResult = false;
    for await (const ev of executeToolStreaming(action.tool, action.args || {}, userId, agentId || null, null)) {
      if (ev?.type === 'result' && typeof ev.text === 'string') {
        sawResult = true;
        if (text.length < 4_000) {
          const separator = text ? '\n' : '';
          text += (separator + ev.text).slice(0, 4_000 - text.length);
        }
        const prefix = ev.text.slice(0, 4_000);
        if (ev.isError || looksLikeToolError(prefix) || isToolRefusal(prefix)) isError = true;
      }
    }
    if (!sawResult) isError = true;
    return { text: text.trim(), isError, sawResult };
  });
}

async function _runGrantedPreferenceAction(action, userId, agentId, expectation) {
  const { executeGrantedRoleToolForSkill } = await import('../../roles.mjs');
  return suppressObservations(async () => {
    const value = await executeGrantedRoleToolForSkill(
      expectation.skillId, action.tool, action.args || {}, userId, agentId || null,
      { executorDigest: expectation.executorDigest, manifestDigest: expectation.manifestDigest },
    );
    let text = '';
    let explicitError = false;
    if (typeof value === 'string') text = value;
    else if (value && typeof value === 'object') {
      if (typeof value.text === 'string') text = value.text;
      else {
        try { text = JSON.stringify(value); } catch { text = '[unserializable result]'; }
      }
      explicitError = value.isError === true || value.error === true;
    }
    text = text.slice(0, 4_000).trim();
    const sawResult = value !== null && value !== undefined;
    return {
      text,
      sawResult,
      isError: !sawResult || explicitError || looksLikeToolError(text) || isToolRefusal(text),
    };
  });
}

/**
 * Offer accept: run action.tool via executeToolStreaming. HTTP-accept
 * context is NOT scheduled context (ADDENDUM C), so tools like set_reminder
 * that need to create a task work fine here — but we still never crash on a
 * tool-side failure (including a hypothetical scheduled-context block error,
 * per ADDENDUM A's "never crash, never bypass hackily" spirit): any failure
 * just becomes a normal 'failed' terminal outcome with a clear message.
 */
export async function runPersonalizationOffer(p, ph) {
  let succeeded = false;
  let outcomeText;
  let activationExpectation = null;
  try {
    // An offer's expiresAt (reflect.mjs's sanitizeOffers) is otherwise never
    // enforced anywhere in the accept path — proposals.mjs's generic TTL
    // sweep only looks at createdAt, and acceptProposal doesn't consult
    // expiresAt at all. Without this check, a time-sensitive offer (e.g. "pack
    // for Tuesday's 9am flight") stays acceptable long after the moment it
    // was for has passed, and accepting it would run set_reminder with a
    // stale/past datetime instead of failing honestly.
    if (p.expiresAt) {
      const expiryMs = Date.parse(p.expiresAt);
      if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
        throw new Error("this offer expired before it was accepted, so it wasn't run");
      }
    }
    if (p.actionContract === 'skill_preference_activation') {
      const { validatePreferenceActivationProposal } = await import('./preference-opportunities.mjs');
      const validated = await validatePreferenceActivationProposal(p.userId, p);
      if (!validated) throw new Error('this preference-based skill activation is no longer authorized');
      activationExpectation = validated;
      p.action = { tool: validated.tool, args: validated.args };
    } else {
      if (p?.action?.tool !== 'set_reminder') throw new Error('offer action is not an allowed reminder');
      if (!p.action.args || typeof p.action.args !== 'object' || Array.isArray(p.action.args)) {
        throw new Error('offer has invalid reminder arguments');
      }
      const allowedArgKeys = new Set(['label', 'repeat', 'datetime', 'time', 'voice_device']);
      if (Object.keys(p.action.args).some(key => !allowedArgKeys.has(key))) {
        throw new Error('offer has unsupported reminder arguments');
      }
      /** @type {'daily'|'once'} */
      const repeat = p.action.args.repeat === 'daily' ? 'daily' : 'once';
      if (p.action.args.repeat != null && !['daily', 'once'].includes(p.action.args.repeat)) {
        throw new Error('offer has an invalid reminder cadence');
      }
      let label = typeof p.action.args.label === 'string' ? p.action.args.label.trim() : '';
      if (!label) label = String(p.message || '').split('\n')[0].trim();
      if (!label) throw new Error('offer has no reminder label');
      /** @type {{label:string, repeat:'daily'|'once', datetime?:string, time?:string, voice_device?:string}} */
      const normalizedArgs = { label: label.slice(0, 100), repeat };
      if (repeat === 'once') {
        const datetime = p.action.args.datetime;
        const reminderMs = typeof datetime === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(datetime)
          ? Date.parse(datetime) : NaN;
        if (!Number.isFinite(reminderMs) || reminderMs <= Date.now()) {
          throw new Error("the reminder time has already passed, so it wasn't run");
        }
        normalizedArgs.datetime = new Date(reminderMs).toISOString();
      } else {
        const time = p.action.args.time;
        if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
          throw new Error('offer has an invalid daily reminder time');
        }
        normalizedArgs.time = time;
      }
      if (typeof p.action.args.voice_device === 'string' && p.action.args.voice_device.trim()) {
        normalizedArgs.voice_device = p.action.args.voice_device.trim().slice(0, 80);
      }
      p.action.args = normalizedArgs;
    }
    let activationNonce = null;
    let actionResult;
    if (activationExpectation) {
      activationNonce = `approved_${randomUUID()}`;
      const { runWithPreferenceSafeAutoContext } = await import('./safe-auto-context.mjs');
      actionResult = await runWithPreferenceSafeAutoContext({
        mode: 'approved',
        activationNonce,
        skillId: activationExpectation.skillId,
        watcherKind: activationExpectation.watcherKind,
        watcherIdentity: activationExpectation.watcherIdentity || activationExpectation.dedupKey,
        offerKind: activationExpectation.offerKind,
        contractFingerprint: activationExpectation.contractFingerprint,
        preferenceMemoryId: activationExpectation.preferenceMemoryId,
        utilityContextKey: activationExpectation.utilityContextKey || 'general',
        executorDigest: activationExpectation.executorDigest,
        manifestDigest: activationExpectation.manifestDigest,
        expectedDelivery: activationExpectation.expectedDelivery,
      }, () => _runGrantedPreferenceAction(
        p.action, p.userId, p.agentId, activationExpectation,
      ));
    } else {
      actionResult = await _runAction(p.action, p.userId, p.agentId);
    }
    const { text, isError, sawResult } = actionResult;
    succeeded = sawResult && !isError;
    let resultText = text;
    if (activationExpectation) {
      const { completeApprovedPreferenceActivation } = await import('./preference-opportunities.mjs');
      const completed = await completeApprovedPreferenceActivation(
        p.userId, p, activationExpectation, activationNonce, { actionSucceeded: succeeded },
      );
      if (!completed.ok) {
        succeeded = false;
        resultText = completed.error || 'The skill did not create exactly the approved monitor.';
      } else {
        p.producedArtifact = completed.artifact;
        p.preferenceReceiptEventId = completed.receipt?.id || null;
      }
    }
    const safeResult = redactSecretsInText(resultText, 200);
    outcomeText = succeeded
      ? (safeResult ? `Done — ${safeResult}` : 'Done.')
      : `Couldn't complete it: ${safeResult || 'unknown error'}`;
  } catch (e) {
    const safeError = redactSecretsInText(String(e?.message || e), 200) || 'unknown error';
    console.warn('[personalization] offer action failed:', safeError);
    outcomeText = `Couldn't complete it: ${safeError}`;
  }

  p.status = succeeded ? 'done' : 'failed';
  p.outcome = outcomeText;
  p.endedAt = Date.now();
  await ph.persistUser(p.userId);
  await ph.persistOutcome(p, p.status, outcomeText);
  ph.broadcast(p.userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: p.status,
    outcome: outcomeText,
  });
  await recordOfferSignals(p, { choice: 'accepted', succeeded, phase: 'offer' });
  if (succeeded && activationExpectation) {
    try {
      const { recordPreferenceProposalOutcome } = await import('./preference-opportunities.mjs');
      await recordPreferenceProposalOutcome(p.userId, p, 'acted');
    } catch (e) {
      console.warn('[personalization] preference proposal outcome capture failed:', e.message);
    }
  }

  // Graduation measures proven-useful executions, not click intent.  A user
  // accepting a broken/unavailable tool must never teach the system to run it
  // unattended in the future.
  if (succeeded && p.offerKind && p.graduateEligible !== false) {
    try {
      const { graduate } = await recordOfferOutcome(p.userId, p.offerKind, 'accept');
      if (graduate) {
        const created = await _proposeGraduate(p);
        if (!created) await resetGraduateOffer(p.userId, p.offerKind);
      }
    } catch (e) {
      console.warn('[personalization] recordOfferOutcome (accept) failed:', e.message);
    }
  }
}

/**
 * Creates the follow-up "Want me to always do this?" proposal once
 * recordOfferOutcome signals graduate:true. Fire-and-forget from the
 * caller's perspective — never throws.
 */
async function _proposeGraduate(p) {
  try {
    const proposalsMod = await import('../proposals.mjs');
    if (typeof proposalsMod.createProposal !== 'function') {
      console.warn('[personalization] lib/proposals.mjs does not export createProposal — cannot create graduate proposal (integrator TODO: export it)');
      return false;
    }
    const label = p.title || String(p.message || '').split('\n')[0].trim() || p.offerKind;
    const created = await proposalsMod.createProposal({
      id: 'prop_' + randomUUID().slice(0, 12),
      userId: p.userId,
      agentId: p.agentId,
      kind: 'personalization_graduate',
      offerKind: p.offerKind,
      message: `You've said yes to "${label}" a couple of times now. Want me to always do this automatically, without asking first?`,
      accept_label: 'Yes, always',
      dismiss_label: 'No, keep asking',
      createdAt: Date.now(),
      status: 'pending',
    });
    return !!created;
  } catch (e) {
    console.warn('[personalization] failed to create graduate proposal:', e.message);
    return false;
  }
}

/**
 * Graduate accept: marks the canonical offer kind auto-approved in
 * outcomes.json so future offers of that kind execute immediately instead of
 * rendering a card. The policy store is the single authority; no free-form
 * model-authored role rule is added.
 */
export async function runPersonalizationGraduate(p, ph) {
  const { userId, offerKind } = p;
  let succeeded = false;
  let outcomeText;
  try {
    if (!userId) throw new Error('graduate proposal has no userId');
    if (!isCanonicalOfferKind(offerKind)) throw new Error('graduate proposal has an invalid offerKind');
    const marked = await markKindAutoApproved(userId, offerKind);
    if (!marked) throw new Error('could not persist automatic behavior policy');
    succeeded = true;
    outcomeText = "Got it — I'll do this automatically from now on.";
    p.producedArtifact = { kind: 'personalization_policy', offerKind };
  } catch (e) {
    console.warn('[personalization] graduate policy write failed:', e.message);
    outcomeText = `Couldn't set that up: ${e.message}`;
  }

  p.status = succeeded ? 'done' : 'failed';
  p.outcome = outcomeText;
  p.endedAt = Date.now();
  await ph.persistUser(userId);
  await ph.persistOutcome(p, p.status, outcomeText);
  ph.broadcast(userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: p.status,
    outcome: outcomeText,
  });
  await recordOfferSignals(p, { choice: 'accepted', succeeded, phase: 'graduation' });
}
