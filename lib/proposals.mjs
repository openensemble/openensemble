/**
 * Friction-as-proposer (cortex automation TODO #1).
 *
 * The friction tracker (memory/signals.mjs) historically auto-pinned the
 * literal user message after 3 repetitions — over-promoting one-off commands
 * (`[AUTO-PINNED]` cleanup history). This module replaces that path with a
 * proposal system: when the third repeat lands, instead of pinning, we emit
 * a chat bubble offering to set up the appropriate automation (recurring
 * task, watch, etc.) with accept/dismiss buttons.
 *
 * Disk-backed at users/<uid>/proposals.json so a server restart doesn't
 * strand running accepts (the bubble would otherwise show "Setting it up…"
 * forever after a restart). On boot, any 'running' proposal is reaped to
 * 'failed' with a "server restarted" outcome — better than leaving the user
 * unable to act.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { isDefaultArgNoise, isDestructiveText, isLearnableAliasPhrase } from './learning-safety.mjs';
import { evaluateLearningProposal, relatedFeedbackKeys } from './learning-policy.mjs';

const _proposals = new Map();          // proposalId -> record
const _dismissedPatterns = new Map();  // userId -> Map(patternKey -> dismissedAt)
const _blockedPatterns   = new Map();  // userId -> Set(patternKey) — permanent "don't propose again"
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

let _wsBroadcastFn = null;

// Wired from server.mjs at boot — same pattern as the watcher supervisor.
// sendStatus(userId, msg) pushes a WS event to the user's connected clients.
export function setProposalBroadcastFn(fn) { _wsBroadcastFn = fn; }

// ── Persistence ──────────────────────────────────────────────────────────────
// Per-user JSON file under users/<uid>/proposals.json. Format:
//   { proposals: [record, ...], dismissedPatterns: { key: ts, ... } }
// Records carry the same shape as the in-memory map values.

function proposalsPath(userId) {
  return path.join(USERS_DIR, userId, 'proposals.json');
}

async function persistUser(userId) {
  const recs = [..._proposals.values()].filter(p => p.userId === userId);
  const dismissed = _dismissedPatterns.get(userId);
  const blocked   = _blockedPatterns.get(userId);
  const data = {
    proposals: recs,
    dismissedPatterns: dismissed ? Object.fromEntries(dismissed) : {},
    blockedPatterns: blocked ? [...blocked] : [],
  };
  const p = proposalsPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
}

function loadAllUsersFromDisk() {
  if (!fs.existsSync(USERS_DIR)) return;
  let stranded = 0;
  const usersWithReap = new Set();
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    const p = proposalsPath(uid);
    if (!fs.existsSync(p)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    for (const rec of (data.proposals || [])) {
      // Reap stranded 'running' proposals from a previous server crash. The
      // user is otherwise stuck — bubble shows "Setting it up…" forever and
      // there's no in-memory record to accept/dismiss against.
      if (rec.status === 'running') {
        rec.status = 'failed';
        rec.outcome = 'Server restarted before the action completed.';
        rec.endedAt = Date.now();
        // Best-effort persist the failure outcome to the agent's session
        // jsonl so the bubble updates on reload. Fire-and-forget.
        persistOutcome(rec, 'failed', rec.outcome).catch(() => {});
        stranded++;
        usersWithReap.add(uid);
      }
      // Wake snoozed proposals whose wake-time has elapsed. Done here at boot
      // (and re-checked on listUserProposals) so restarts don't strand the
      // user with a permanently-hidden inbox item.
      if (rec.status === 'snoozed' && rec.wakeAt && Date.now() >= rec.wakeAt) {
        rec.status = 'pending';
        rec.wakeAt = null;
        usersWithReap.add(uid);
      }
      if (rec.status === 'pending' || rec.status === 'snoozed') {
        const policy = evaluateLearningProposal(rec);
        if (!policy.allow) {
          rec.status = 'failed';
          rec.outcome = `Blocked by learning policy: ${policy.reason}`;
          rec.endedAt = Date.now();
          rec.policy = {
            risk: policy.risk,
            confidence: policy.confidence ?? null,
            evidenceCount: policy.evidenceCount ?? null,
            minEvidence: policy.minEvidence ?? null,
            preview: policy.preview ?? null,
            decision: policy.reason,
            evaluatedAt: Date.now(),
          };
          persistOutcome(rec, 'failed', rec.outcome).catch(() => {});
          usersWithReap.add(uid);
        }
      }
      _proposals.set(rec.id, rec);
    }
    if (data.dismissedPatterns) {
      const map = new Map();
      for (const [k, v] of Object.entries(data.dismissedPatterns)) map.set(k, v);
      _dismissedPatterns.set(uid, map);
    }
    if (Array.isArray(data.blockedPatterns) && data.blockedPatterns.length) {
      _blockedPatterns.set(uid, new Set(data.blockedPatterns));
    }
  }
  // Write back the reaped state so a subsequent restart doesn't re-reap.
  for (const uid of usersWithReap) {
    persistUser(uid).catch(e => console.warn('[proposals] post-reap persist failed:', e.message));
  }
  if (stranded) console.log(`[proposals] reaped ${stranded} stranded 'running' proposal(s) on boot`);
}

// Called from server.mjs boot. Idempotent — safe to invoke twice.
let _bootLoaded = false;
export function bootLoadProposals() {
  if (_bootLoaded) return;
  _bootLoaded = true;
  try { loadAllUsersFromDisk(); } catch (e) { console.warn('[proposals] boot load failed:', e.message); }
}

// ── Pattern detection ────────────────────────────────────────────────────────

// By the time we reach maybePropose, the cortex friction head has already
// confirmed the user repeated themselves 3 times — so the bar for "is this
// proposable" is lower than scheduler-intent's tight regex (which is gating
// real task creation). We accept anything with a time anchor OR a recurrence
// cue OR a scheduling verb. Mistakes are cheap (user dismisses the bubble);
// false negatives are expensive (no proposal at all).
const TIME_ANCHOR_RE = /\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|in\s+\d+\s*(?:second|minute|hour|day|week|month)s?|tomorrow|tonight|next (?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|noon|midnight|\d{1,2}:\d{2})\b/i;
const RECURRENCE_RE  = /\b(?:every (?:day|morning|afternoon|evening|night|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|weekday|weekend|\d+\s*(?:minute|hour|day)s?)|daily|weekly|hourly|each (?:day|morning|night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const SCHED_VERB_RE  = /\b(?:remind me|schedule|reschedule|set (?:a |an )?(?:reminder|alarm|timer)|i need to|have to|gotta|got to|make sure i|don'?t let me forget)\b/i;
function isTaskShaped(message) {
  const m = (message || '').toLowerCase();
  if (!m) return false;
  return TIME_ANCHOR_RE.test(m) || RECURRENCE_RE.test(m) || SCHED_VERB_RE.test(m);
}

// Watch-shaped: condition-triggered phrasings. Explicit "tell me when X" /
// "let me know when X" / "alert me if X" shapes that aren't time-bound.
const WATCH_RE = /\b(tell me when|let me know when|let me know if|alert me when|alert me if|ping me when|ping me if|notify me when|notify me if|wake me up when|when (?:does|will|can|is) .* (?:happen|come|arrive|change|drop|hit|reach|exceed))\b/i;
function isWatchShaped(message) {
  return WATCH_RE.test(message || '');
}

// Destructive-verb gate. The cortex same-instruction head will happily say
// "delete x.img" / "delete y.img" / "delete z.img" are the same instruction
// (similar structure), and maybePropose would otherwise wrap the latest
// message as a daily recurring task — turning ad-hoc deletes into a daily
// auto-delete of whatever target the user named last. That's a catastrophic
// false positive (lost data > lost convenience). Gate: any message
// containing a destructive verb is logged but never proposed. The user can
// still create a destructive recurring task explicitly via their coordinator; we just
// won't escalate repetition into one. Legitimate cases ("delete old logs
// every Sunday") need explicit creation.
function isDestructive(message) {
  return isDestructiveText(message);
}

function patternKey(message) {
  return (message || '').trim().toLowerCase().slice(0, 100);
}

// rule_promotion proposals carry a long preamble in `message` whose first
// 100 chars are constant ("you've corrected this twice…"); patternKey on
// that would over-collide. Key those off the underlying ruleText instead.
// skill_proposal proposals share a preamble too ("That turn used N tools…") —
// key them off the sorted tool-set hash so a re-fire of the same workflow
// pattern is suppressed even though the message preamble matches every other
// skill proposal we've ever emitted.
function cooldownKey(record) {
  if (record?.kind === 'rule_promotion' && record.ruleText) return patternKey(record.ruleText);
  if (record?.kind === 'skill_proposal' && record.toolsKey) return `tools:${record.toolsKey}`;
  if (record?.kind === 'skill_deprecation' && record.skillId) return `deprecate:${record.skillId}`;
  if (record?.kind === 'skill_refine' && record.skillId) return `refine:${record.skillId}`;
  if (record?.kind === 'routine_proposal' && record.trigger) return `routine:${record.trigger}`;
  if (record?.kind === 'alias_proposal' && record.phrase) return `alias:${record.phrase}`;
  if (record?.kind === 'location_fact' && record.hostname && record.foundPath) return `locfact:${record.hostname}:${record.foundPath}`;
  if (record?.kind === 'default_arg' && record.tool && record.arg) return `default:${record.tool}.${record.arg}`;
  if (record?.kind === 'tool_failure' && record.tool) return `failure:${record.tool}`;
  if (record?.kind === 'routing_override' && record.correctedAgent && record.pattern) return `routing:${record.correctedAgent}:${record.pattern}`;
  if (record?.kind === 'learned_intent' && record.skillId && record.intentId) return `learned:${record.skillId}:${record.intentId}`;
  return patternKey(record?.message);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Shared helper — writes the proposal to the in-memory map, persists to disk,
// stubs into the agent session jsonl, and pushes the live WS bubble. Both
// maybePropose (friction) and proposeRulePromotion (corrections) call this
// after they've decided what kind of proposal to emit.
async function createProposal(record) {
  const policy = evaluateLearningProposal(record);
  if (!policy.allow) {
    console.log(`[proposals] skipped ${record?.kind || 'unknown'} by learning policy: ${policy.reason}`);
    return null;
  }
  record.policy = {
    risk: policy.risk,
    confidence: policy.confidence ?? null,
    evidenceCount: policy.evidenceCount ?? null,
    minEvidence: policy.minEvidence ?? null,
    preview: policy.preview ?? null,
    decision: policy.reason,
    evaluatedAt: Date.now(),
  };

  // Dedup: if an identical-pattern proposal is already pending for this user,
  // don't stack another (this is what let "Keep responses brief" pile up 4×).
  // Keyed the same way as the dismiss cooldown, so "the same thing" is defined
  // consistently across propose / dismiss / block.
  // skill_refine manages its own re-proposal lifecycle via resetAfterRefine, so
  // the blunt pending-dedup must not block it from firing again after a reset.
  if (record.kind !== 'skill_refine') {
    const newKey = cooldownKey(record);
    for (const existing of _proposals.values()) {
      if (existing.userId === record.userId && existing.status === 'pending' && cooldownKey(existing) === newKey) {
        return null;
      }
    }
  }

  for (const key of relatedFeedbackKeys(record)) {
    if (isDismissedRecentlyByKey(record.userId, key)) return null;
  }

  // Phase-7 salience gate: per-kind feedback loop. If recent outcomes for
  // this kind have been bad enough, we PAUSE emission until the user
  // manually resets. Detector still trips; the proposal just doesn't land.
  try {
    const { getKindStatus } = await import('./proposal-salience.mjs');
    const verdict = getKindStatus(record.userId, record.kind);
    if (!verdict.allow) {
      console.log(`[proposals] skipped ${record.kind} (${verdict.reason}, rate=${verdict.rate?.toFixed?.(2) ?? 'n/a'}, measured=${verdict.measured})`);
      return null;
    }
  } catch (e) {
    // Salience failures must NEVER block proposals — fail open.
    console.warn('[proposals] salience gate threw, proceeding:', e.message);
  }

  _proposals.set(record.id, record);
  await persistUser(record.userId);

  try {
    const { appendToSession } = await import('../sessions.mjs');
    const sessionKey = record.agentId.startsWith(`${record.userId}_`)
      ? record.agentId : `${record.userId}_${record.agentId}`;
    appendToSession(sessionKey, {
      role: 'proposal',
      proposalId: record.id,
      kind: record.kind,
      message: record.message,
      accept_label: record.accept_label,
      dismiss_label: record.dismiss_label,
      ts: record.createdAt,
    });
  } catch (e) {
    console.warn('[proposals] failed to persist to session:', e.message);
  }

  _wsBroadcastFn?.(record.userId, {
    type: 'proposal',
    proposalId: record.id,
    agent: record.agentId,
    kind: record.kind,
    message: record.message,
    accept_label: record.accept_label,
    dismiss_label: record.dismiss_label,
    ts: record.createdAt,
  });
  return record;
}

/**
 * Friction tracker calls this on the third repeat. Returns the proposal
 * record if one was created, null if the message wasn't actionable or if
 * the same pattern was recently dismissed.
 */
export async function maybePropose({ userId, agentId, message }) {
  if (!userId || !message) return null;
  if (isDismissedRecently(userId, message)) return null;
  // Destructive intent never auto-escalates. See learning-safety.mjs.
  if (isDestructive(message)) {
    console.log(`[proposals] declined (destructive verb): "${(message || '').slice(0, 80)}"`);
    return null;
  }

  let kind, accept_label;
  if (isWatchShaped(message)) {
    kind = 'watch';
    accept_label = 'Set up the watch';
  } else if (isTaskShaped(message)) {
    kind = 'recurring_task';
    accept_label = 'Schedule daily';
  } else {
    // Not actionable — silently drop. This is the strict improvement over
    // the previous auto-pin: one-off commands and idle questions stop
    // polluting cortex memory.
    return null;
  }

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId, kind, message,
    accept_label,
    dismiss_label: 'No, just this once',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Cortex correction tracker calls this when the user has corrected the same
 * thing twice (vector-similarity match across stored CORRECTION rows in the
 * agent's _params table) and the agent holds exactly one service role. The
 * proposal asks the user to promote the correction into a per-user standing
 * rule on that role — bypassing cortex recall flakiness for a permanent
 * system-prompt injection.
 *
 * Returns the proposal record, or null if dismissed recently.
 */
export async function proposeRulePromotion({ userId, agentId, roleId, roleName, ruleText, sourceCorrectionIds = [] }) {
  if (!userId || !agentId || !roleId || !ruleText) return null;
  // Reuse the dismissed-pattern cooldown — if the user already said no to
  // promoting "never use semicolons" once today, don't re-ask. cooldownKey
  // routes rule_promotion through ruleText so the constant message preamble
  // doesn't collide unrelated rule promotions.
  if (isDismissedRecentlyByKey(userId, patternKey(ruleText))) return null;

  const message = `You've corrected this twice. Want me to make it a permanent rule for your ${roleName} agent?\n\n> ${ruleText}`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId,
    kind: 'rule_promotion',
    message,
    ruleText,
    roleId,
    roleName,
    sourceCorrectionIds,
    evidenceCount: Math.max(sourceCorrectionIds.length, 2),
    accept_label: `Add as a rule for ${roleName}`,
    dismiss_label: 'No, keep correcting case-by-case',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Skill proposer (Hermes-inspired learning loop) calls this when an agent
 * turn uses MIN_TOOLS+ "interesting" tool calls without obvious failure.
 * The bubble offers to bundle the workflow into a reusable user skill via
 * skill-builder on accept. Cooldown is keyed by the sorted tool-set hash —
 * see cooldownKey().
 *
 * Returns the proposal record or null if the same tool-set was dismissed
 * recently.
 */
export async function proposeSkill({
  userId, agentId, agentName, userTrigger, agentSummary, toolNames, toolsKey, message,
}) {
  if (!userId || !agentId || !Array.isArray(toolNames) || toolNames.length === 0) return null;
  if (toolsKey && isDismissedRecentlyByKey(userId, `tools:${toolsKey}`)) return null;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId,
    kind: 'skill_proposal',
    message,
    agentName: agentName ?? '',
    userTrigger: userTrigger ?? '',
    agentSummary: agentSummary ?? '',
    toolNames,
    toolsKey: toolsKey ?? '',
    evidenceCount: toolNames.length,
    accept_label: 'Build this into a skill',
    dismiss_label: 'No, leave it ad-hoc',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Skill telemetry calls this when a user-created skill has been corrected
 * by the user at least DEPRECATION_THRESHOLD of its invocations. Offers
 * to delete the skill outright — the skill clearly isn't behaving as the
 * user expects and continuing to nudge the LLM toward it (via the
 * triggers-injection prompt block) is making things worse, not better.
 */
export async function proposeSkillDeprecation({
  userId, agentId, skillId, invocations, corrections,
}) {
  if (!userId || !skillId) return null;
  if (isDismissedRecentlyByKey(userId, `deprecate:${skillId}`)) return null;

  const ratio = invocations > 0 ? Math.round((corrections / invocations) * 100) : 0;
  const message =
    `Your skill \`${skillId}\` has been corrected on ${corrections} of its last ${invocations} runs (${ratio}%). ` +
    `Want me to delete it? You can always rebuild a better one later.`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId: agentId ?? '',
    kind: 'skill_deprecation',
    message,
    skillId,
    invocations, corrections,
    evidenceCount: invocations,
    accept_label: `Delete ${skillId}`,
    dismiss_label: 'No, keep it',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Skill telemetry calls this when a user-created skill enters the mid-zone:
 * correction-rate between REFINE_LOWER and DEPRECATION_THRESHOLD with ≥3
 * invocations. Offers to patch the skill based on recent corrections — the
 * "almost right, fix it" path that fills the gap between fine and deletable.
 */
export async function proposeSkillRefine({
  userId, agentId, skillId, invocations, corrections, recentCorrections,
}) {
  if (!userId || !skillId) return null;
  if (isDismissedRecentlyByKey(userId, `refine:${skillId}`)) return null;

  const ratio = invocations > 0 ? Math.round((corrections / invocations) * 100) : 0;
  const correctionList = (recentCorrections || [])
    .slice(-3)
    .map(t => `  - "${t.replace(/"/g, "'").slice(0, 140)}"`)
    .join('\n');
  const message =
    `Your skill \`${skillId}\` has been corrected on ${corrections} of its last ${invocations} runs (${ratio}%). ` +
    `Want me to refine it based on these recent corrections?\n\n${correctionList}`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId: agentId ?? '',
    kind: 'skill_refine',
    message,
    skillId,
    invocations, corrections,
    recentCorrections: recentCorrections || [],
    evidenceCount: corrections,
    accept_label: `Refine ${skillId}`,
    dismiss_label: 'No, leave it alone',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Routine proposer (lib/routine-proposer.mjs) calls this when a Helen turn
 * resolved an ambiguous "turn X" command via the LLM — exactly the kind of
 * round-trip that should turn into a deterministic ~200ms routine fast-path
 * next time. The bubble offers to bind the user's phrase to a single-action
 * routine that fires the same HA service against the same entity.
 *
 * Cooldown is keyed by the normalized trigger phrase so dismissing one
 * routine proposal doesn't silence unrelated ones.
 */
export async function proposeRoutine({
  userId, agentId, agentName, trigger, entityId, service, originalPhrase,
}) {
  if (!userId || !agentId || !trigger || !entityId || !service) return null;
  if (isDismissedRecentlyByKey(userId, `routine:${trigger}`)) return null;

  const verbLabel = service === 'turn_off' ? 'turn off' :
                    service === 'turn_on'  ? 'turn on'  :
                    service === 'toggle'   ? 'toggle'   : service;
  const message =
    `I noticed you said "${originalPhrase || trigger}" and I had to figure out you meant \`${entityId}\`. ` +
    `Want me to remember that — bind "${trigger}" to ${verbLabel} \`${entityId}\` directly so next time it fires instantly?`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId,
    kind: 'routine_proposal',
    message,
    agentName: agentName ?? '',
    trigger,
    entityId,
    service,
    originalPhrase: originalPhrase || trigger,
    evidenceCount: 1,
    accept_label: 'Yes, bind it',
    dismiss_label: 'No, keep asking each time',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * HA alias proposer — bind a noun ("kitchen") to an entity_id so the HA
 * fast-path resolves it for ANY verb (turn on/off/toggle/set N%/etc) without
 * an LLM round-trip. One alias replaces N per-verb routines.
 */
export async function proposeAlias({
  userId, agentId, agentName, phrase, entityId, originalPhrase, existingAlias,
}) {
  if (!userId || !agentId || !phrase || !entityId) return null;
  if (!isLearnableAliasPhrase(phrase)) return null;
  if (isDismissedRecentlyByKey(userId, `alias:${phrase}`)) return null;

  const change = existingAlias
    ? `change "${phrase}" from \`${existingAlias}\` to \`${entityId}\``
    : `bind "${phrase}" to \`${entityId}\``;
  const message =
    `I noticed you said "${originalPhrase || phrase}" and I resolved it to \`${entityId}\`. ` +
    `Want me to ${change}? After that any command ("turn off ${phrase}", "set ${phrase} to 50%", "toggle ${phrase}") will fire instantly.`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId,
    kind: 'alias_proposal',
    message,
    agentName: agentName ?? '',
    phrase,
    entityId,
    originalPhrase: originalPhrase || phrase,
    existingAlias: existingAlias || null,
    evidenceCount: 1,
    accept_label: 'Yes, remember it',
    dismiss_label: 'No, keep asking each time',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Location-fact proposer (lib/location-fact-proposer.mjs) calls this when an
 * agent turn probed a dead path on a remote node and a later call in the same
 * turn discovered the real one. The bubble offers to pin a host-scoped fact
 * so the next session can skip the dead-end probe.
 *
 * Cooldown key is hostname + found path so the same accidental
 * re-discovery on the same host doesn't re-prompt within the dismiss window.
 */
export async function proposeLocationFact({
  userId, agentId, agentName, hostname, failedPath, foundPath, userTrigger,
}) {
  if (!userId || !agentId || !hostname || !foundPath) return null;
  if (isDismissedRecentlyByKey(userId, `locfact:${hostname}:${foundPath}`)) return null;

  const triggerHint = userTrigger ? `\n\n> ${userTrigger}` : '';
  const message =
    `On **${hostname}**, \`${failedPath}\` doesn't exist but I found content at \`${foundPath}\`. ` +
    `Want me to remember that so I skip the dead-end probe next time?${triggerHint}`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId,
    kind: 'location_fact',
    message,
    agentName: agentName ?? '',
    hostname,
    failedPath: failedPath || '',
    foundPath,
    userTrigger: userTrigger || '',
    evidenceCount: 1,
    accept_label: 'Yes, remember it',
    dismiss_label: 'No, this was a one-off',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Default-arg pinner — the tool dispatcher (roles.mjs executeToolStreaming)
 * counts identical arg values per (user, tool, arg) and calls this on the
 * 3rd occurrence within a 7d window. On accept we pin the value as a default
 * that gets merged into future calls before invocation; user-passed args
 * always win.
 */
export async function proposeDefaultArg({ userId, agentId, tool, arg, value, count }) {
  if (!userId || !tool || !arg) return null;
  if (isDefaultArgNoise(tool, arg, value)) {
    console.log(`[proposals] default_arg suppressed (never-default arg/value): ${tool}.${arg}`);
    return null;
  }
  if (isDismissedRecentlyByKey(userId, `default:${tool}.${arg}`)) return null;

  const valueDisplay = typeof value === 'string'
    ? `"${value.length > 60 ? value.slice(0, 60) + '…' : value}"`
    : String(value);
  const message =
    `You've called \`${tool}\` with \`${arg} = ${valueDisplay}\` ${count} times recently. ` +
    `Want me to make that the default? You can always pass a different value to override it.`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId: agentId || '',
    kind: 'default_arg',
    message,
    tool, arg, value,
    count: count || 0,
    evidenceCount: count || 0,
    accept_label: `Pin ${arg} = ${valueDisplay}`,
    dismiss_label: 'No, keep passing it each time',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Tool-failure proposer — roles.mjs dispatcher calls this after a tool has
 * failed 3 times with at least 3 distinct error prefixes in a 7d window.
 * For a user-created skill we offer to refine it (LLM reads code +
 * captured errors). For a built-in we offer a diagnostic write-up the user
 * can read and act on.
 */
export async function proposeToolFailure({ userId, agentId, tool, skillId, recentErrors, count }) {
  if (!userId || !tool) return null;
  if (isDismissedRecentlyByKey(userId, `failure:${tool}`)) return null;

  const isUserSkill = await _isUserCreatedSkill(userId, skillId);
  const errorList = (recentErrors || [])
    .slice(0, 3)
    .map(e => `  - ${(e || '').slice(0, 100)}`)
    .join('\n');
  const message = isUserSkill
    ? `Your tool \`${tool}\` (skill \`${skillId}\`) has failed ${count} times recently with these errors:\n\n${errorList}\n\nWant me to refine the skill based on these failures?`
    : `Tool \`${tool}\` has failed ${count} times recently:\n\n${errorList}\n\nWant me to write a diagnostic report you can read?`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId: agentId || '',
    kind: 'tool_failure',
    message,
    tool,
    skillId: skillId || null,
    isUserSkill,
    recentErrors: recentErrors || [],
    count: count || 0,
    evidenceCount: count || 0,
    accept_label: isUserSkill ? `Refine ${skillId}` : 'Write diagnostic',
    dismiss_label: 'Ignore — I\'ll handle it',
    createdAt: Date.now(),
    status: 'pending',
  });
}

// Detect whether a skill id resolves to a user-created skill
// (users/<id>/skills/<skillId>/manifest.json with createdBy === userId).
// Built-in skills live in skills/<skillId>/ — those don't have createdBy.
async function _isUserCreatedSkill(userId, skillId) {
  if (!userId || !skillId) return false;
  try {
    const fs2 = await import('fs');
    const path2 = await import('path');
    const { userSkillsDir } = await import('./paths.mjs');
    const p = path2.join(userSkillsDir(userId), skillId, 'manifest.json');
    if (!fs2.existsSync(p)) return false;
    const m = JSON.parse(fs2.readFileSync(p, 'utf8'));
    return m?.createdBy === userId || m?.custom === true;
  } catch { return false; }
}

/**
 * Routing-override proposer — chat-dispatch's redirect-detection helper calls
 * this when ≥2 router-mistake events accumulate with the same correctedAgent
 * and a meaningful word overlap on the previous messages. On accept we write
 * a contains-pattern override that routes future matching messages directly
 * to the corrected agent.
 */
export async function proposeRoutingOverride({ userId, agentId, correctedAgent, correctedAgentName, pattern, examples }) {
  if (!userId || !correctedAgent || !pattern) return null;
  const cooldownK = `routing:${correctedAgent}:${pattern}`;
  if (isDismissedRecentlyByKey(userId, cooldownK)) return null;

  const exampleList = (examples || [])
    .slice(0, 3)
    .map(e => `  - "${String(e || '').slice(0, 100)}"`)
    .join('\n');
  const message =
    `I noticed you've redirected ${examples?.length || 0}+ similar messages to **${correctedAgentName}** recently. ` +
    `Want me to send messages matching "${pattern}" straight to ${correctedAgentName}?\n\n${exampleList}`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId: agentId || '',
    kind: 'routing_override',
    message,
    correctedAgent,
    correctedAgentName: correctedAgentName || correctedAgent,
    pattern,
    examples: examples || [],
    evidenceCount: Array.isArray(examples) ? examples.length : 0,
    accept_label: `Always route "${pattern}" to ${correctedAgentName}`,
    dismiss_label: 'No, keep classifying each time',
    createdAt: Date.now(),
    status: 'pending',
  });
}

/**
 * Phase-3 local-tier learning. The on-device tier missed these phrasings but the
 * cloud LLM proved the right tool by calling it. Offer to teach the tier so the
 * same phrasings dispatch locally (no cloud) next time. utterance→TOOL analogue
 * of proposeRoutingOverride (utterance→agent).
 */
export async function proposeLearnedIntent({ userId, agentId, skillId, intentId, tool, utterances, confirm }) {
  confirm = confirm === true;
  if (!userId || !skillId || !intentId || !Array.isArray(utterances) || !utterances.length) return null;
  const cooldownK = `learned:${skillId}:${intentId}`;
  if (isDismissedRecentlyByKey(userId, cooldownK)) return null;

  const exampleList = utterances.slice(0, 5).map(u => `  - "${String(u || '').slice(0, 100)}"`).join('\n');
  const message =
    `The on-device tier missed these phrasings, but \`${tool}\` ran anyway (handled in the cloud). ` +
    `Want me to teach the local tier so they run instantly next time — no cloud round-trip?\n\n${exampleList}\n\n` +
    `(If \`${tool}\` is a confirm-first action, it'll still ask before running.)`;

  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId: agentId || '',
    kind: 'learned_intent',
    message,
    skillId, intentId, tool: tool || null, confirm,
    utterances: utterances.slice(0, 10),
    evidenceCount: utterances.length,
    accept_label: 'Yes, learn these locally',
    dismiss_label: 'No, keep using the cloud',
    createdAt: Date.now(),
    status: 'pending',
  });
}

export function getProposal(id) {
  const p = _proposals.get(id);
  if (!p) return null;
  // Light TTL sweep on access — keeps the Map from growing forever in long
  // server runs without a separate timer.
  if (Date.now() - p.createdAt > PROPOSAL_TTL_MS && p.status === 'pending') {
    p.status = 'expired';
  }
  return p;
}

export function listUserProposals(userId, status = 'pending') {
  // Live wake any snoozed records whose wake-time has elapsed so a long-
  // running server doesn't leave them hidden forever between boot sweeps.
  const now = Date.now();
  for (const p of _proposals.values()) {
    if (p.userId === userId && p.status === 'snoozed' && p.wakeAt && now >= p.wakeAt) {
      p.status = 'pending';
      p.wakeAt = null;
    }
    if (p.userId === userId && (p.status === 'pending' || p.status === 'snoozed')) {
      const policy = evaluateLearningProposal(p);
      if (!policy.allow) {
        p.status = 'failed';
        p.outcome = `Blocked by learning policy: ${policy.reason}`;
        p.endedAt = Date.now();
        p.policy = {
          risk: policy.risk,
          confidence: policy.confidence ?? null,
          evidenceCount: policy.evidenceCount ?? null,
          minEvidence: policy.minEvidence ?? null,
          preview: policy.preview ?? null,
          decision: policy.reason,
          evaluatedAt: Date.now(),
        };
        persistUser(userId).catch(() => {});
        persistOutcome(p, 'failed', p.outcome).catch(() => {});
      }
    }
  }
  return [..._proposals.values()].filter(p => p.userId === userId && (!status || p.status === status));
}

export async function acceptProposal(id) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  const policy = evaluateLearningProposal(p);
  if (!policy.allow) {
    p.status = 'failed';
    p.outcome = `Blocked by learning policy: ${policy.reason}`;
    p.endedAt = Date.now();
    p.policy = {
      risk: policy.risk,
      confidence: policy.confidence ?? null,
      evidenceCount: policy.evidenceCount ?? null,
      minEvidence: policy.minEvidence ?? null,
      preview: policy.preview ?? null,
      decision: policy.reason,
      evaluatedAt: Date.now(),
    };
    await persistUser(p.userId);
    await persistOutcome(p, 'failed', p.outcome);
    _wsBroadcastFn?.(p.userId, {
      type: 'proposal_outcome',
      proposalId: p.id,
      agent: p.agentId,
      status: 'failed',
      outcome: p.outcome,
    });
    return { ok: false, error: policy.reason, proposal: p };
  }
  p.status = 'running';
  p.acceptedAt = Date.now();
  await persistUser(p.userId);

  // Phase-4: record the pre-accept friction snapshot. Fire-and-forget; we
  // don't want a slow outcomes-file write to delay the user-visible bubble
  // transitioning to "Setting it up…". The post-check is computed lazily on
  // first read after acceptedAt + 7d.
  import('./proposal-outcomes.mjs').then(m => m.recordPreAcceptSnapshot(p))
    .catch(e => console.warn('[proposals] outcome pre-snapshot failed:', e.message));

  // Surface the "running" state immediately so the bubble transitions on
  // click. The final outcome arrives as a second proposal_outcome entry
  // when the underlying work finishes (rule write or agent run).
  await persistOutcome(p, 'running', 'Setting it up…');
  _wsBroadcastFn?.(p.userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: 'running',
    outcome: 'Setting it up…',
  });

  // rule_promotion is a direct file write — no agent round-trip needed. The
  // agent doesn't decide whether the rule is right; the user already said yes.
  // Fire-and-forget; runRulePromotion catches its own errors.
  if (p.kind === 'rule_promotion') {
    runRulePromotion(p).catch(e => {
      console.warn('[proposals] rule promotion threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // skill_proposal needs an agent with skill_create wired in — typically
  // the user's coder agent. runSkillProposal handles the lookup; if no
  // skill-builder-enabled agent exists for this user, it marks failed.
  if (p.kind === 'skill_proposal') {
    runSkillProposal(p).catch(e => {
      console.warn('[proposals] skill proposal threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // skill_deprecation is a direct disk operation — no agent round-trip. The
  // user already confirmed they want the skill gone; bouncing through an LLM
  // to call skill_delete just adds latency and a failure surface.
  if (p.kind === 'skill_deprecation') {
    runSkillDeprecation(p).catch(e => {
      console.warn('[proposals] skill deprecation threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // routine_proposal — direct routines.json write, no LLM round-trip.
  // The user already confirmed by accepting; bouncing through an LLM just to
  // call create_routine would slow the UX and risk model drift.
  if (p.kind === 'routine_proposal') {
    runRoutineProposal(p).catch(e => {
      console.warn('[proposals] routine proposal threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // alias_proposal — direct ha-aliases.json write. The user confirmed the
  // noun→entity mapping; next HA command using that noun goes straight to
  // the entity without LLM resolution.
  if (p.kind === 'alias_proposal') {
    runAliasProposal(p).catch(e => {
      console.warn('[proposals] alias proposal threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // location_fact — direct write to shared user_facts via pinLocationFact.
  // No LLM involved; the user already confirmed the host + path mapping.
  if (p.kind === 'location_fact') {
    runLocationFactProposal(p).catch(e => {
      console.warn('[proposals] location fact threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // default_arg — direct write to users/<id>/tool-defaults.json. User
  // already confirmed the value to pin; the dispatcher merges it in on the
  // next matching tool call without restart.
  if (p.kind === 'default_arg') {
    runDefaultArgPin(p).catch(e => {
      console.warn('[proposals] default-arg pin threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // tool_failure — user-created skill: route through skill_refine path with
  // the captured error messages playing the role of "corrections." Built-in:
  // write a diagnostic markdown the user can read.
  if (p.kind === 'tool_failure') {
    runToolFailureRemedy(p).catch(e => {
      console.warn('[proposals] tool-failure remedy threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // routing_override — direct write to users/<id>/routing-overrides.json.
  // The dispatcher consults overrides before the specialist classifier on the
  // next matching message; no restart needed.
  if (p.kind === 'routing_override') {
    runRoutingOverride(p).catch(e => {
      console.warn('[proposals] routing-override threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // learned_intent — direct write to users/<id>/learned-intents.json. The local
  // tier merges these into Tier-2 on the next dispatch; no restart needed.
  if (p.kind === 'learned_intent') {
    runLearnedIntent(p).catch(e => {
      console.warn('[proposals] learned-intent threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // skill_refine needs the LLM — coder reads the current skill code, reads
  // the captured corrections, and decides what to patch via skill_patch_code.
  // We can't shortcut around the LLM here the way deprecation does.
  if (p.kind === 'skill_refine') {
    runSkillRefine(p).catch(e => {
      console.warn('[proposals] skill refine threw outside its handler:', e.message);
    });
    return { ok: true, status: 'running', proposal: p };
  }

  // Other kinds (watch, recurring_task) need the agent to call its own tools.
  runAcceptedAgent(p).catch(e => {
    console.warn('[proposals] accept run threw outside its own handler:', e.message);
  });

  return { ok: true, status: 'running', proposal: p };
}

export async function snoozeProposal(id, snoozeMs = SNOOZE_MS) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  p.status = 'snoozed';
  p.snoozedAt = Date.now();
  p.wakeAt = Date.now() + snoozeMs;
  await persistUser(p.userId);
  await persistOutcome(p, 'snoozed', `Snoozed — back in ${Math.round(snoozeMs / 86400000)}d.`);
  _wsBroadcastFn?.(p.userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: 'snoozed',
    outcome: `Snoozed — back in ${Math.round(snoozeMs / 86400000)}d.`,
  });
  return { ok: true, proposal: p };
}

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Phase-13 undo. Reverses an accepted proposal's effect within 24h by
 * routing producedArtifact (stashed by each accept handler) to the matching
 * revoke helper. After the window expires, undo refuses — the user has to
 * use the revoke endpoints on the Learn panel.
 */
export async function undoProposal(id) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'accepted') return { ok: false, error: `cannot undo ${p.status}` };
  if (!p.producedArtifact) return { ok: false, error: 'no recorded artifact' };
  if (!p.acceptedAt || Date.now() - p.acceptedAt > UNDO_WINDOW_MS) {
    return { ok: false, error: 'undo window expired' };
  }

  const art = p.producedArtifact;
  let result;
  try {
    if (art.kind === 'rule') {
      // Rule undo: re-read role-rules file, find matching ruleText line, remove it
      const fs2 = await import('fs');
      const { userRoleRulesPath } = await import('./paths.mjs');
      const rpath = userRoleRulesPath(p.userId, art.roleId);
      if (!fs2.existsSync(rpath)) { result = { ok: false, error: 'rule file gone' }; }
      else {
        const lines = fs2.readFileSync(rpath, 'utf8').split('\n');
        const match = `- ${art.ruleText}`;
        const idx = lines.findIndex(l => l.trim() === match);
        if (idx < 0) { result = { ok: false, error: 'rule line not found' }; }
        else {
          const { revokeRule } = await import('./learnings.mjs');
          // Map back to the index revokeRule expects (filtered to "- " lines).
          let filteredIdx = -1, count = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('- ')) count++;
            if (i === idx) { filteredIdx = count; break; }
          }
          result = revokeRule(p.userId, art.roleId, filteredIdx);
        }
      }
    } else if (art.kind === 'alias') {
      const { revokeAlias } = await import('./learnings.mjs');
      result = await revokeAlias(p.userId, art.phrase);
    } else if (art.kind === 'routine') {
      const { revokeRoutine } = await import('./learnings.mjs');
      result = await revokeRoutine(p.userId, art.routineId);
    } else if (art.kind === 'pin') {
      const { revokeDefault } = await import('./learnings.mjs');
      result = await revokeDefault(p.userId, art.tool, art.arg);
    } else if (art.kind === 'override') {
      const { revokeRoutingOverride } = await import('./learnings.mjs');
      result = await revokeRoutingOverride(p.userId, art.overrideId);
    } else if (art.kind === 'learned_intent') {
      const { revokeLearnedIntent } = await import('./learnings.mjs');
      result = await revokeLearnedIntent(p.userId, art.skillId, art.intentId, art.utterances);
    } else {
      result = { ok: false, error: `unsupported artifact kind: ${art.kind}` };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  if (result?.ok) {
    p.status = 'undone';
    p.undoneAt = Date.now();
    await persistUser(p.userId);
    await persistOutcome(p, 'undone', 'Reverted by user.');
    _wsBroadcastFn?.(p.userId, {
      type: 'proposal_outcome',
      proposalId: p.id,
      agent: p.agentId,
      status: 'undone',
      outcome: 'Reverted by user.',
    });
  }
  return result;
}

function normalizeFeedbackReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return null;
  if (['unsafe', 'noisy', 'wrong_target', 'not_useful', 'one_off'].includes(r)) return r;
  return 'other';
}

export async function dismissProposal(id, opts = {}) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  p.status = 'dismissed';
  p.dismissedAt = Date.now();
  p.dismissReason = normalizeFeedbackReason(typeof opts === 'string' ? opts : opts.reason);

  if (!_dismissedPatterns.has(p.userId)) _dismissedPatterns.set(p.userId, new Map());
  const dismissed = _dismissedPatterns.get(p.userId);
  dismissed.set(cooldownKey(p), p.dismissedAt);
  for (const key of relatedFeedbackKeys(p)) dismissed.set(key, p.dismissedAt);
  await persistUser(p.userId);
  await persistOutcome(p, 'dismissed', p.dismissReason ? `Dismissed: ${p.dismissReason}` : null);
  // Cross-tab consistency: broadcast so other open tabs see the dismissal
  // even though the originating tab applied it locally.
  _wsBroadcastFn?.(p.userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: 'dismissed',
    outcome: null,
  });
  return { ok: true, proposal: p };
}

// Like dismiss, but PERMANENT: records the proposal's cooldown key in the
// never-expiring block set so this pattern is never proposed again (vs. the 24h
// snooze a normal dismiss applies). Backs the "Don't propose again" action.
export async function blockProposal(id, opts = {}) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  p.status = 'dismissed';
  p.dismissedAt = Date.now();
  p.blocked = true;
  p.dismissReason = normalizeFeedbackReason(typeof opts === 'string' ? opts : opts.reason) || 'not_useful';

  const key = cooldownKey(p);
  if (!_blockedPatterns.has(p.userId)) _blockedPatterns.set(p.userId, new Set());
  const blocked = _blockedPatterns.get(p.userId);
  blocked.add(key);
  for (const related of relatedFeedbackKeys(p)) blocked.add(related);
  // Clear any stale 24h-cooldown entry for the same key (the block supersedes it).
  _dismissedPatterns.get(p.userId)?.delete(key);
  for (const related of relatedFeedbackKeys(p)) _dismissedPatterns.get(p.userId)?.delete(related);

  await persistUser(p.userId);
  await persistOutcome(p, 'dismissed', "Blocked — won't propose this again");
  _wsBroadcastFn?.(p.userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: 'dismissed',
    outcome: "Won't propose this again",
  });
  return { ok: true, proposal: p };
}

// Append an outcome event to the proposal's session jsonl. The session
// renderer combines the original `role:'proposal'` entry with this
// `role:'proposal_outcome'` entry to produce the final resolved bubble on
// reload.
async function persistOutcome(proposal, status, outcomeText) {
  try {
    const { appendToSession } = await import('../sessions.mjs');
    const sessionKey = proposal.agentId.startsWith(`${proposal.userId}_`)
      ? proposal.agentId
      : `${proposal.userId}_${proposal.agentId}`;
    appendToSession(sessionKey, {
      role: 'proposal_outcome',
      proposalId: proposal.id,
      status,
      outcome: outcomeText || '',
      ts: Date.now(),
    });
  } catch (e) {
    console.warn('[proposals] failed to persist outcome:', e.message);
  }
}

function isDismissedRecently(userId, message) {
  return isDismissedRecentlyByKey(userId, patternKey(message));
}

function isDismissedRecentlyByKey(userId, key) {
  // Permanent "don't propose again" wins over the 24h cooldown — never expires.
  if (_blockedPatterns.get(userId)?.has(key)) return true;
  const userMap = _dismissedPatterns.get(userId);
  if (!userMap) return false;
  const t = userMap.get(key);
  if (!t) return false;
  if (Date.now() - t > DISMISS_COOLDOWN_MS) {
    userMap.delete(key);
    return false;
  }
  return true;
}

// ── Accept execution ─────────────────────────────────────────────────────────
//
// On accept, run the agent the proposal belongs to with a prompt that
// instructs it to set up the requested automation. The agent already has
// schedule_task / set_reminder / create_watch — proposals don't reach into
// those tools directly; they steer the agent toward calling them. Same
// reasoning as on_fire in the watcher supervisor.

async function runAcceptedAgent(proposal) {
  const { userId, agentId, kind, message } = proposal;
  const { getAgent } = await import('../agents.mjs');
  const { streamChat } = await import('../chat.mjs');
  const { getAgentsForUser, getUser } = await import('../routes/_helpers.mjs');
  const { runAgentWithRetry } = await import('./run-agent-with-retry.mjs');

  const isChild = getUser(userId)?.role === 'child';
  const rawAgentId = agentId.startsWith(`${userId}_`) ? agentId.slice(userId.length + 1) : agentId;
  const resolved = getAgentsForUser(userId).find(a => a.id === rawAgentId)
    ?? (isChild ? null : getAgent(rawAgentId));
  if (!resolved) throw new Error(`agent ${rawAgentId} not resolvable for user`);

  const sessionKey = `${userId}_${resolved.id}`;
  const scopedAgent = { ...resolved, id: sessionKey };

  const taskHint = kind === 'watch'
    ? `Use create_watch to set up a monitor for: "${message}". Pick a sensible source (http_jsonpath / exec / file_stat) and a reasonable cadence.`
    : `Use schedule_task or set_reminder to set this up as a recurring action: "${message}". Pick sensible defaults (daily at the time mentioned, or 09:00 if no time was specified) and act without asking follow-ups.`;

  const note =
    `[PROPOSAL ACCEPTED] The user just accepted a friction-tracker proposal — they confirmed they want this automated. ` +
    `${taskHint} ` +
    `Do NOT ask follow-up questions; complete the action with reasonable defaults and report what you did. ` +
    `If the user-provided phrasing is ambiguous, pick the most useful interpretation rather than asking.`;

  const { succeeded, assistantContent: assistantBuf, lastError } = await runAgentWithRetry({
    scopedAgent, userText: message, systemNote: note, userId, streamChat,
    context: 'proposals',
  });

  // Update in-memory record + persist final outcome to session jsonl. On
  // reload the renderer sees this 'accepted' or 'failed' entry after the
  // earlier 'running' entry and applies whichever comes last.
  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = succeeded ? (assistantBuf || 'accepted') : `Failed: ${lastError || 'unknown'}`;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  const finalStatus = succeeded ? 'accepted' : 'failed';
  const finalText   = succeeded ? 'I’ll set this up.' : `Couldn’t set it up: ${lastError || 'unknown'}`;
  await persistOutcome(proposal, finalStatus, finalText);

  // Push the outcome bubble update so the live chat mutates without reload.
  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: finalStatus,
    outcome: finalText,
  });

  // Refresh the chat with the coordinator's new assistant turn — same task_complete
  // broadcast scheduled tasks use. Skip on failure (no useful new content).
  if (succeeded) {
    _wsBroadcastFn?.(userId, { type: 'task_complete', taskId: `proposal_${proposal.id}`, agent: resolved.id });
  }
}

// ── Rule-promotion accept handler ────────────────────────────────────────────
//
// Direct write to the user's per-user rules.md for the role (no agent run).
// The user already confirmed by clicking accept; bouncing through an LLM round
// trip just to call a tool would slow the UX and risk the agent doing
// something unexpected. The corrections that triggered this are LEFT in place
// — they remain useful for recall context even after promotion, and removing
// them would break the spaced-repetition stability of related memories.
async function runRulePromotion(proposal) {
  const { userId, roleId, ruleText, roleName } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    const fs = await import('fs');
    const { userRoleRulesDir, userRoleRulesPath } = await import('./paths.mjs');
    const dir = userRoleRulesDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const p = userRoleRulesPath(userId, roleId);

    // Append, don't overwrite — rules accumulate. Match the format
    // role_add_rule writes (`- ${rule}` per line) so the two paths produce
    // identical files.
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const lines = existing.split('\n').map(l => l.trim()).filter(Boolean);
    const newLine = `- ${ruleText.trim()}`;
    if (!lines.includes(newLine)) {
      lines.push(newLine);
      fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    }
    succeeded = true;
    outcomeText = `Added to your ${roleName} standing rules. It'll apply to that role from your next conversation.`;
    // Phase-13: stash what was created for the 24h undo path.
    proposal.producedArtifact = { kind: 'rule', roleId, ruleText: ruleText.trim() };
  } catch (e) {
    console.warn('[proposals] rule promotion write failed:', e.message);
    outcomeText = `Couldn't add the rule: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Alias-proposal accept handler ──────────────────────────────────────────
//
// Direct write to users/<id>/ha-aliases.json. The HA fast-path consults this
// before its multi-match cache lookup, so the alias takes effect on the next
// command without needing a server restart or any other refresh.
async function runAliasProposal(proposal) {
  const { userId, phrase, entityId } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    if (!isLearnableAliasPhrase(phrase)) throw new Error('alias phrase is too generic to learn');
    const { setAlias } = await import('./ha-aliases.mjs');
    setAlias(userId, phrase, entityId);
    succeeded = true;
    outcomeText = `Saved. "${phrase}" = \`${entityId}\`. Any command using "${phrase}" will fire instantly.`;
    proposal.producedArtifact = { kind: 'alias', phrase };
  } catch (e) {
    console.warn('[proposals] alias write failed:', e.message);
    outcomeText = `Couldn't save the alias: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Location-fact accept handler ───────────────────────────────────────────
//
// Writes a host-scoped FACT to shared user_facts via pinLocationFact. The
// fact text names the host inline so vector search can surface it even
// before any explicit host_scope filtering is wired into recall.
async function runLocationFactProposal(proposal) {
  const { userId, hostname, failedPath, foundPath, userTrigger } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    const { pinLocationFact } = await import('../memory/signals.mjs');
    const triggerSuffix = userTrigger ? ` (originally probed for: ${userTrigger.slice(0, 80)})` : '';
    const factText = failedPath
      ? `On ${hostname}, ${foundPath} is the relevant location; ${failedPath} does not exist${triggerSuffix}.`
      : `On ${hostname}, ${foundPath} is the relevant location${triggerSuffix}.`;
    const rec = await pinLocationFact({ text: factText, userId, hostScope: hostname });
    if (rec) {
      succeeded = true;
      outcomeText = `Saved. Next session I'll go straight to \`${foundPath}\` on ${hostname}.`;
    } else {
      outcomeText = `Couldn't save the fact (cortex returned no record).`;
    }
  } catch (e) {
    console.warn('[proposals] location fact write failed:', e.message);
    outcomeText = `Couldn't save the fact: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Routing-override accept handler ─────────────────────────────────────────
//
// Direct write to users/<id>/routing-overrides.json via addOverride. The
// dispatcher checks overrides BEFORE the specialist classifier on the next
// matching message, so the new override fires without restart. The outcome
// record is also patched with the new overrideId so the routing_override
// measurer can count fast-path fires for THIS override in the 7d post window.
async function runRoutingOverride(proposal) {
  const { userId, correctedAgent, correctedAgentName, pattern, examples } = proposal;
  let succeeded = false;
  let outcomeText;
  let overrideId = null;
  try {
    const { addOverride } = await import('./routing-overrides.mjs');
    const result = await addOverride(userId, {
      pattern, forcedAgent: correctedAgent, mode: 'contains',
      addedBy: 'proposal', examples: (examples || []).slice(0, 5),
    });
    if (result.ok) {
      succeeded = true;
      overrideId = result.id;
      proposal.overrideId = overrideId;
      try {
        const { updateOutcomePayload } = await import('./proposal-outcomes.mjs');
        await updateOutcomePayload(userId, proposal.id, { overrideId });
      } catch (e) {
        console.warn('[proposals] outcome payload patch failed:', e.message);
      }
      outcomeText = `Saved. Messages containing "${pattern}" will now route directly to ${correctedAgentName || correctedAgent}.`;
      proposal.producedArtifact = { kind: 'override', overrideId };
    } else {
      outcomeText = `Couldn't save the override: ${result.error || 'unknown'}`;
    }
  } catch (e) {
    console.warn('[proposals] routing-override write failed:', e.message);
    outcomeText = `Couldn't save the override: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Learned-intent accept handler ───────────────────────────────────────────
//
// Direct write, no LLM: persist each missed phrasing to learned-intents.json.
// collectLocalIntents merges them into Tier-2 on the next dispatch.
async function runLearnedIntent(proposal) {
  const { userId, skillId, intentId, tool, utterances } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    const { addLearnedUtterance } = await import('./learned-intents.mjs');
    for (const u of (utterances || [])) {
      await addLearnedUtterance(userId, { skillId, intentId, tool, utterance: u });
    }
    succeeded = true;
    proposal.producedArtifact = { kind: 'learned_intent', skillId, intentId, utterances: utterances || [] };
    outcomeText = 'Learned. Phrasings like these now run on-device — no cloud call.';
  } catch (e) {
    console.warn('[proposals] learned-intent write failed:', e.message);
    outcomeText = `Couldn't save the learning: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Tool-failure remedy accept handler ──────────────────────────────────────
//
// Splits on whether the failing tool belongs to a user-created skill:
//   - user skill   → delegate to skill_refine via the coder agent (LLM reads
//                    the captured errors + skill code, patches). Same handler
//                    shape as runSkillRefine but seeded with errors, not
//                    user corrections.
//   - built-in     → write a diagnostic doc to the user's documents folder.
//                    The user can read it and decide; there's no automatic
//                    remedy for code we don't own.
async function runToolFailureRemedy(proposal) {
  const { userId, tool, skillId, isUserSkill, recentErrors, count } = proposal;
  let succeeded = false;
  let outcomeText;

  if (isUserSkill && skillId) {
    let builderAgent = null;
    try {
      const { getAgentsForUser } = await import('../routes/_helpers.mjs');
      const userAgents = getAgentsForUser(userId) ?? [];
      builderAgent = userAgents.find(a =>
        Array.isArray(a.tools) && a.tools.some(t => t?.function?.name === 'skill_patch_code')
      );
      if (!builderAgent) {
        throw new Error('no agent with skill-builder enabled — enable skill-builder on your coder agent and try again');
      }

      const { streamChat } = await import('../chat.mjs');
      const { runAgentWithRetry } = await import('./run-agent-with-retry.mjs');

      const sessionKey = `${userId}_${builderAgent.id}`;
      const scopedAgent = { ...builderAgent, id: sessionKey };

      const errorList = (recentErrors || [])
        .map((e, i) => `${i + 1}. ${(e || '').slice(0, 200)}`)
        .join('\n');
      const userText =
        `Tool \`${tool}\` in skill \`${skillId}\` has failed ${count} times recently with these errors:\n\n${errorList}\n\n` +
        `Steps: (1) call skill_read_code on \`${skillId}\` to see the current implementation; ` +
        `(2) identify the pattern producing these errors — pick the single biggest fix; ` +
        `(3) call skill_patch_code with focused edits to address the failure mode.`;
      const note =
        `[PROPOSAL ACCEPTED — TOOL FAILURE REMEDY] The user accepted a proposal to refine a failing skill. ` +
        `Do not ask follow-ups; read the code, identify the failure pattern, and patch it. ` +
        `Report briefly what you changed.`;

      const result = await runAgentWithRetry({
        scopedAgent, userText, systemNote: note, userId, streamChat,
        context: 'proposals',
      });
      succeeded = !!result.succeeded;
      outcomeText = succeeded
        ? `Refined \`${skillId}\` based on the failure patterns. Try the tool again.`
        : `Couldn't refine the skill: ${result.lastError || 'unknown error'}`;
    } catch (e) {
      console.warn('[proposals] tool-failure refine path failed:', e.message);
      outcomeText = `Couldn't refine the skill: ${e.message}`;
    }
  } else {
    // Built-in: write a diagnostic doc the user can read.
    try {
      const fs2 = await import('fs');
      const path2 = await import('path');
      const { getUserFilesDir } = await import('./paths.mjs');
      const dir = getUserFilesDir(userId, 'documents');
      const fname = `tool-failure-${tool}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
      const fpath = path2.join(dir, fname);
      const body = [
        `# Tool failure diagnostic: \`${tool}\``,
        ``,
        `Captured ${count} failure(s) in the last 7 days.`,
        ``,
        `## Recent unique errors`,
        ``,
        ...(recentErrors || []).map((e, i) => `${i + 1}. \`${(e || '').replace(/`/g, '\\`')}\``),
        ``,
        `## What to check`,
        ``,
        `- If this is a network-bound tool, look for upstream API changes or auth/key issues.`,
        `- If it depends on a local binary (ffmpeg, piper, etc.), check that the binary is on PATH and the right version.`,
        `- If errors changed shape recently, look at the most recent code change touching the owning skill.`,
        `- If the same error repeats forever, the tool may need a manifest or arg-schema update.`,
        ``,
        `## Skill`,
        ``,
        `Owning skill: \`${skillId || '(built-in or unknown)'}\``,
        ``,
      ].join('\n');
      fs2.writeFileSync(fpath, body, 'utf8');
      succeeded = true;
      outcomeText = `Wrote diagnostic to \`documents/${fname}\`. Open it from the Docs drawer.`;
    } catch (e) {
      console.warn('[proposals] tool-failure diagnostic write failed:', e.message);
      outcomeText = `Couldn't write the diagnostic: ${e.message}`;
    }
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Default-arg pin accept handler ──────────────────────────────────────────
//
// Direct write to users/<id>/tool-defaults.json via pinDefault(). The
// dispatcher (roles.mjs executeToolStreaming) merges these into incoming
// tool args before invocation, so the next matching call picks up the pin
// without any restart or session reload.
async function runDefaultArgPin(proposal) {
  const { userId, tool, arg, value } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    const { pinDefault } = await import('./tool-defaults.mjs');
    const result = await pinDefault(userId, tool, arg, value);
    if (result.ok) {
      succeeded = true;
      const display = typeof value === 'string' ? `"${value}"` : String(value);
      outcomeText = `Pinned. \`${tool}\` now defaults \`${arg} = ${display}\` when you don't specify it.`;
      proposal.producedArtifact = { kind: 'pin', tool, arg };
    } else {
      outcomeText = `Couldn't pin: ${result.error || 'unknown'}`;
    }
  } catch (e) {
    console.warn('[proposals] default-arg pin write failed:', e.message);
    outcomeText = `Couldn't pin the default: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Routine-proposal accept handler ─────────────────────────────────────────
//
// Direct write to users/<id>/routines.json. No LLM involved — the user already
// confirmed and the proposal already has the entity_id + service the matching
// turn called against. The newly-saved routine fires via classifyRoutineIntent
// in chat-dispatch.mjs on the very next matching utterance.
async function runRoutineProposal(proposal) {
  const { userId, trigger, entityId, service, originalPhrase } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    const { loadRoutines, saveRoutines } = await import('./routines.mjs');
    const { routines } = loadRoutines(userId);
    // Derive a stable id from the trigger so re-proposals of the same phrase
    // upsert rather than collide. trigger is already normalized.
    const id = `auto_${trigger.replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`;
    const next = {
      id,
      trigger,
      aliases: originalPhrase && originalPhrase !== trigger ? [originalPhrase] : [],
      actions: [{ type: 'ha_scene', scene_id: entityId, verb: service }],
    };
    const filtered = routines.filter(r => r.id !== id);
    filtered.push(next);
    const saved = saveRoutines(userId, filtered);
    if (!saved.routines.some(r => r.id === id)) {
      throw new Error('routine failed validation on save');
    }
    succeeded = true;
    // Phase-5: patch the outcome record with the created routineId so the
    // routine_proposal measurer can count fast-path fires for this exact
    // routine in the 7d post-accept window.
    try {
      const { updateOutcomePayload } = await import('./proposal-outcomes.mjs');
      await updateOutcomePayload(userId, proposal.id, { routineId: id });
    } catch (e) {
      console.warn('[proposals] outcome payload patch failed:', e.message);
    }
    const verbLabel = service === 'turn_off' ? 'turn off' :
                      service === 'turn_on'  ? 'turn on'  :
                      service === 'toggle'   ? 'toggle'   : service;
    outcomeText = `Saved. "${trigger}" → ${verbLabel} \`${entityId}\` will fire instantly next time.`;
    proposal.producedArtifact = { kind: 'routine', routineId: id };
  } catch (e) {
    console.warn('[proposals] routine proposal write failed:', e.message);
    outcomeText = `Couldn't save the routine: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Skill-proposal accept handler ────────────────────────────────────────────
//
// On accept, we need to actually create a user skill — that requires an agent
// with skill_create in its toolset. The proposer agent may not have
// skill-builder enabled, so we look across the user's agents for one that
// resolves a skill_create tool and run that one. The bubble outcome is posted
// back against the original proposer's agentId so the chat that emitted the
// proposal also sees the result.
async function runSkillProposal(proposal) {
  const { userId, agentId, userTrigger, agentSummary, toolNames } = proposal;
  let succeeded = false;
  let outcomeText;
  let builderAgent = null;
  try {
    const { getAgentsForUser } = await import('../routes/_helpers.mjs');
    const userAgents = getAgentsForUser(userId) ?? [];
    builderAgent = userAgents.find(a =>
      Array.isArray(a.tools) && a.tools.some(t => t?.function?.name === 'skill_create')
    );
    if (!builderAgent) {
      throw new Error('no agent with skill-builder enabled — enable skill-builder on your coder agent and try again');
    }

    const { streamChat } = await import('../chat.mjs');
    const { runAgentWithRetry } = await import('./run-agent-with-retry.mjs');

    const sessionKey = `${userId}_${builderAgent.id}`;
    const scopedAgent = { ...builderAgent, id: sessionKey };

    const toolList = (toolNames || []).join(', ');
    const userText =
      `Build a reusable skill from this multi-tool workflow.\n\n` +
      `Original user request that triggered it:\n"${(userTrigger || '').slice(0, 600)}"\n\n` +
      `Tools that were used: ${toolList || '(none captured)'}\n\n` +
      `What the assistant produced (excerpt):\n${(agentSummary || '').slice(0, 600)}\n\n` +
      `Create a single-tool custom skill that takes the user's natural-language phrasing for this kind of request and runs the same sequence end-to-end. Pick a short skill id derived from the trigger phrase, a sensible name, and one tool. Read the blueprint first.`;
    const note =
      `[PROPOSAL ACCEPTED — SKILL CREATION] Do not ask follow-ups. Read the blueprint, then call skill_create with a complete scaffold. ` +
      `Tool count: keep to one user-facing tool that accepts the natural-language request as a parameter. ` +
      `Report briefly what you created (skill id + tool name) when done.`;

    const startTime = Date.now();
    const result = await runAgentWithRetry({
      scopedAgent, userText, systemNote: note, userId, streamChat,
      context: 'proposals',
    });
    succeeded = !!result.succeeded;
    if (succeeded) {
      outcomeText = 'Built it — your new skill is loaded and available on the next turn.';
      // Seed triggers.json on the just-created skill with the original
      // userTrigger so the prompt-nudge block (in agent-resolver) starts
      // biasing the LLM toward this skill from the next turn forward.
      // findNewestSkillSince is a mtime scan — fine for the rare-event
      // accept path; not on the hot path.
      try {
        const { findNewestSkillSince, appendTrigger } = await import('./skill-triggers.mjs');
        const newSkillId = findNewestSkillSince(userId, startTime);
        if (newSkillId && userTrigger) appendTrigger(userId, newSkillId, userTrigger);
        // Phase-5: stash on the proposal AND patch the outcome record so the
        // skill_proposal outcome measurer can count post-accept invocations of
        // THIS specific skill. The outcome record was snapshotted at accept
        // time and doesn't yet know the newSkillId.
        if (newSkillId) {
          proposal.newSkillId = newSkillId;
          try {
            const { updateOutcomePayload } = await import('./proposal-outcomes.mjs');
            await updateOutcomePayload(userId, proposal.id, { newSkillId });
          } catch (e) {
            console.warn('[proposals] outcome payload patch failed:', e.message);
          }
        }
      } catch (e) {
        console.warn('[proposals] trigger seed failed:', e.message);
      }
    } else {
      outcomeText = `Couldn't create the skill: ${result.lastError || 'unknown error'}`;
    }
  } catch (e) {
    console.warn('[proposals] skill proposal accept failed:', e.message);
    outcomeText = `Couldn't create the skill: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
  if (succeeded && builderAgent) {
    _wsBroadcastFn?.(userId, { type: 'task_complete', taskId: `proposal_${proposal.id}`, agent: builderAgent.id });
  }
}

// ── Skill-deprecation accept handler ─────────────────────────────────────────
//
// Direct call into skill-builder's executeSkillTool('skill_delete', ...). No
// agent round-trip — the user already confirmed by clicking accept, and
// bouncing through an LLM round-trip just to invoke skill_delete would risk
// the agent doing something else with the news. Same shape as
// runRulePromotion.
async function runSkillDeprecation(proposal) {
  const { userId, skillId } = proposal;
  let succeeded = false;
  let outcomeText;
  try {
    const { default: executeSkillBuilder } = await import('../skills/skill-builder/execute.mjs');
    const result = await executeSkillBuilder('skill_delete', { id: skillId }, userId, proposal.agentId || 'system');
    if (typeof result === 'string' && /deleted/i.test(result)) {
      succeeded = true;
      outcomeText = `Deleted \`${skillId}\`. It's gone from your session.`;
    } else {
      outcomeText = `Couldn't delete the skill: ${result}`;
    }
  } catch (e) {
    console.warn('[proposals] skill deprecation delete failed:', e.message);
    outcomeText = `Couldn't delete the skill: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
}

// ── Skill-refine accept handler ──────────────────────────────────────────────
//
// LLM-driven: coder needs to read the skill's current code, look at the
// captured corrections, and decide what to patch. Same agent-lookup pattern
// as runSkillProposal — we need an agent with skill_patch_code in scope.
// On success we reset the skill's correction-rate clock so the refined
// version gets a fair re-eval (otherwise the old counts would tip it into
// deprecation territory on its very next correction).
async function runSkillRefine(proposal) {
  const { userId, skillId, invocations, corrections, recentCorrections } = proposal;
  let succeeded = false;
  let outcomeText;
  let builderAgent = null;
  try {
    const { getAgentsForUser } = await import('../routes/_helpers.mjs');
    const userAgents = getAgentsForUser(userId) ?? [];
    builderAgent = userAgents.find(a =>
      Array.isArray(a.tools) && a.tools.some(t => t?.function?.name === 'skill_patch_code')
    );
    if (!builderAgent) {
      throw new Error('no agent with skill-builder enabled — enable skill-builder on your coder agent and try again');
    }

    const { streamChat } = await import('../chat.mjs');
    const { runAgentWithRetry } = await import('./run-agent-with-retry.mjs');

    const sessionKey = `${userId}_${builderAgent.id}`;
    const scopedAgent = { ...builderAgent, id: sessionKey };

    const correctionsList = (recentCorrections || [])
      .map((t, i) => `${i + 1}. "${(t || '').slice(0, 500)}"`)
      .join('\n');
    const userText =
      `Refine skill \`${skillId}\` based on recent corrections from the user.\n\n` +
      `Stats: ${corrections} corrections out of ${invocations} invocations.\n\n` +
      `Recent corrections:\n${correctionsList || '(none captured)'}\n\n` +
      `Steps: (1) call skill_read_code on \`${skillId}\` to see the current implementation; ` +
      `(2) decide what pattern is failing across the corrections — pick the single biggest fix, not many small ones; ` +
      `(3) call skill_patch_code with focused find/replace edits to address that pattern. ` +
      `Do not rewrite the whole file (use skill_update_code only if the change is too structural for patch).`;
    const note =
      `[PROPOSAL ACCEPTED — SKILL REFINE] Do not ask follow-ups. Read the skill code, identify the failure pattern in the corrections, and patch it. ` +
      `Report briefly what you changed and which correction pattern you fixed.`;

    const result = await runAgentWithRetry({
      scopedAgent, userText, systemNote: note, userId, streamChat,
      context: 'proposals',
    });
    succeeded = !!result.succeeded;
    if (succeeded) {
      outcomeText = `Refined \`${skillId}\`. Its correction counter has been reset — it'll get a fair re-eval next time you use it.`;
      try {
        const { resetAfterRefine } = await import('./skill-telemetry.mjs');
        await resetAfterRefine({ userId, skillId });
      } catch (e) {
        console.warn('[proposals] refine reset failed:', e.message);
      }
    } else {
      outcomeText = `Couldn't refine the skill: ${result.lastError || 'unknown error'}`;
    }
  } catch (e) {
    console.warn('[proposals] skill refine failed:', e.message);
    outcomeText = `Couldn't refine the skill: ${e.message}`;
  }

  proposal.status = succeeded ? 'accepted' : 'failed';
  proposal.outcome = outcomeText;
  proposal.endedAt = Date.now();
  await persistUser(userId);
  await persistOutcome(proposal, proposal.status, outcomeText);

  _wsBroadcastFn?.(userId, {
    type: 'proposal_outcome',
    proposalId: proposal.id,
    agent: proposal.agentId,
    status: proposal.status,
    outcome: outcomeText,
  });
  if (succeeded && builderAgent) {
    _wsBroadcastFn?.(userId, { type: 'task_complete', taskId: `proposal_${proposal.id}`, agent: builderAgent.id });
  }
}
