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

const _proposals = new Map();          // proposalId -> record
const _dismissedPatterns = new Map();  // userId -> Map(patternKey -> dismissedAt)
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

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
  const data = {
    proposals: recs,
    dismissedPatterns: dismissed ? Object.fromEntries(dismissed) : {},
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
      _proposals.set(rec.id, rec);
    }
    if (data.dismissedPatterns) {
      const map = new Map();
      for (const [k, v] of Object.entries(data.dismissedPatterns)) map.set(k, v);
      _dismissedPatterns.set(uid, map);
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
// still create a destructive recurring task explicitly via Sydney; we just
// won't escalate repetition into one. Legitimate cases ("delete old logs
// every Sunday") need explicit creation.
const DESTRUCTIVE_VERB_RE = /\b(?:delete|remove|wipe|drop|format|destroy|erase|rm|uninstall|purge|trash|unlink|truncate|shred|overwrite|kill|reset|clear)\b/i;
function isDestructive(message) {
  return DESTRUCTIVE_VERB_RE.test(message || '');
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
  return patternKey(record?.message);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Shared helper — writes the proposal to the in-memory map, persists to disk,
// stubs into the agent session jsonl, and pushes the live WS bubble. Both
// maybePropose (friction) and proposeRulePromotion (corrections) call this
// after they've decided what kind of proposal to emit.
async function createProposal(record) {
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
  // Destructive intent never auto-escalates. See DESTRUCTIVE_VERB_RE comment.
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
    accept_label: `Refine ${skillId}`,
    dismiss_label: 'No, leave it alone',
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
  return [..._proposals.values()].filter(p => p.userId === userId && (!status || p.status === status));
}

export async function acceptProposal(id) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  p.status = 'running';
  p.acceptedAt = Date.now();
  await persistUser(p.userId);

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

export async function dismissProposal(id) {
  const p = _proposals.get(id);
  if (!p) return { ok: false, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  p.status = 'dismissed';
  p.dismissedAt = Date.now();

  if (!_dismissedPatterns.has(p.userId)) _dismissedPatterns.set(p.userId, new Map());
  _dismissedPatterns.get(p.userId).set(cooldownKey(p), p.dismissedAt);
  await persistUser(p.userId);
  await persistOutcome(p, 'dismissed', null);
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

  // Refresh the chat with Sydney's new assistant turn — same task_complete
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
