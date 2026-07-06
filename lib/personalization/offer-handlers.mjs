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
import fs from 'fs';
import { randomUUID } from 'crypto';
import { userRoleRulesDir, userRoleRulesPath } from '../paths.mjs';
import { recordOfferOutcome, markKindAutoApproved } from './graduation.mjs';
import { suppressObservations } from './recorder.mjs';

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
    const texts = [];
    let isError = false;
    for await (const ev of executeToolStreaming(action.tool, action.args || {}, userId, agentId || null, null)) {
      if (ev?.type === 'result' && typeof ev.text === 'string') {
        texts.push(ev.text);
        if (ev.isError) isError = true;
      }
    }
    return { text: texts.join('\n').trim(), isError };
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
  try {
    if (!p?.action?.tool) throw new Error('offer has no action.tool');
    // An offer's expiresAt (reflect.mjs's sanitizeOffers) is otherwise never
    // enforced anywhere in the accept path — proposals.mjs's generic TTL
    // sweep only looks at createdAt, and acceptProposal doesn't consult
    // expiresAt at all. Without this check, a time-sensitive offer (e.g. "pack
    // for Tuesday's 9am flight") stays acceptable long after the moment it
    // was for has passed, and accepting it would run set_reminder with a
    // stale/past datetime instead of failing honestly.
    if (p.expiresAt && Date.parse(p.expiresAt) < Date.now()) {
      throw new Error("this offer expired before it was accepted, so it wasn't run");
    }
    // Backfill required set_reminder args the reflection model sometimes
    // omits: label falls back to the offer's title (first line of message).
    if (p.action.tool === 'set_reminder') {
      p.action.args = p.action.args || {};
      if (!p.action.args.label) {
        const title = String(p.message || '').split('\n')[0].trim();
        if (title) p.action.args.label = title.slice(0, 80);
      }
    }
    const { text, isError } = await _runAction(p.action, p.userId, p.agentId);
    succeeded = !isError;
    outcomeText = succeeded
      ? (text ? `Done — ${text.split('\n')[0].slice(0, 200)}` : 'Done.')
      : `Couldn't complete it: ${text || 'unknown error'}`;
  } catch (e) {
    console.warn('[personalization] offer action failed:', e.message);
    outcomeText = `Couldn't complete it: ${e.message}`;
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

  // Telemetry + graduation check. The user accepted regardless of whether
  // the underlying tool run itself succeeded, so this always counts as an
  // 'accept' for the graduation/suppression counters.
  if (p.offerKind) {
    try {
      const { graduate } = await recordOfferOutcome(p.userId, p.offerKind, 'accept');
      if (graduate) await _proposeGraduate(p);
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
      return;
    }
    // roleId is not part of the documented personalization_offer extra
    // fields (offerKind/action/graduate) — fall back to skillId, then the
    // coordinator role, so a rule always has somewhere to land.
    const roleId = p.roleId || p.skillId || 'coordinator';
    const label = p.title || p.offerKind;
    const ruleText = `Automatically ${String(label).replace(/^[A-Z]/, c => c.toLowerCase())} without asking first.`;
    await proposalsMod.createProposal({
      id: 'prop_' + randomUUID().slice(0, 12),
      userId: p.userId,
      agentId: p.agentId,
      kind: 'personalization_graduate',
      offerKind: p.offerKind,
      ruleText,
      roleId,
      message: `You've said yes to "${label}" a couple of times now. Want me to always do this automatically, without asking first?`,
      accept_label: 'Yes, always',
      dismiss_label: 'No, keep asking',
      createdAt: Date.now(),
      status: 'pending',
    });
  } catch (e) {
    console.warn('[personalization] failed to create graduate proposal:', e.message);
  }
}

/**
 * Graduate accept: appends "- <ruleText>" to the user's per-role rules.md
 * (identical shape to runRulePromotion, lib/proposals.mjs:1295-1305) and
 * marks the offerKind auto-approved in outcomes.json so future offers of
 * that kind execute immediately instead of rendering a card.
 */
export async function runPersonalizationGraduate(p, ph) {
  const { userId, roleId, ruleText, offerKind } = p;
  let succeeded = false;
  let outcomeText;
  try {
    if (!ruleText) throw new Error('graduate proposal has no ruleText');
    const dir = userRoleRulesDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const rp = userRoleRulesPath(userId, roleId || 'coordinator');

    // Append, don't overwrite — matches the `- ${rule}` line format
    // role_add_rule / runRulePromotion write, so files stay interchangeable.
    const existing = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : '';
    const lines = existing.split('\n').map(l => l.trim()).filter(Boolean);
    const newLine = `- ${ruleText.trim()}`;
    if (!lines.includes(newLine)) {
      lines.push(newLine);
      fs.writeFileSync(rp, lines.join('\n') + '\n', 'utf8');
    }

    if (offerKind) await markKindAutoApproved(userId, offerKind);
    succeeded = true;
    outcomeText = "Got it — I'll do this automatically from now on.";
    p.producedArtifact = { kind: 'rule', roleId: roleId || 'coordinator', ruleText: ruleText.trim() };
  } catch (e) {
    console.warn('[personalization] graduate rule write failed:', e.message);
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
}
