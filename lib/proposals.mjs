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

// ── Public API ───────────────────────────────────────────────────────────────

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

  const record = {
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId, kind, message,
    accept_label,
    dismiss_label: 'No, just this once',
    createdAt: Date.now(),
    status: 'pending',
  };
  _proposals.set(record.id, record);
  await persistUser(userId);

  // Persist a stub into the agent's session jsonl so the bubble survives a
  // page refresh. The full state lives in this in-memory map; on reload the
  // client re-fetches /api/proposals/:id to resolve current status (still
  // pending vs accepted vs dismissed) and renders accordingly.
  try {
    const { appendToSession } = await import('../sessions.mjs');
    const sessionKey = agentId.startsWith(`${userId}_`) ? agentId : `${userId}_${agentId}`;
    appendToSession(sessionKey, {
      role: 'proposal',
      proposalId: record.id,
      kind,
      message,
      accept_label,
      dismiss_label: record.dismiss_label,
      ts: record.createdAt,
    });
  } catch (e) {
    console.warn('[proposals] failed to persist to session:', e.message);
  }

  // Push the bubble live. The agent field carries the (scoped) session key
  // so the client can route to the right chat tab.
  _wsBroadcastFn?.(userId, {
    type: 'proposal',
    proposalId: record.id,
    agent: agentId,
    kind,
    message,
    accept_label,
    dismiss_label: record.dismiss_label,
    ts: record.createdAt,
  });
  return record;
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
  // click (no 5-90s frozen UI on transient retries). Both the session-jsonl
  // persistence and the WS push fire now; the final outcome is delivered
  // by runAcceptedAgent below as a second proposal_outcome entry +
  // broadcast when the agent run finishes.
  await persistOutcome(p, 'running', 'Setting it up…');
  _wsBroadcastFn?.(p.userId, {
    type: 'proposal_outcome',
    proposalId: p.id,
    agent: p.agentId,
    status: 'running',
    outcome: 'Setting it up…',
  });

  // Kick off the agent run asynchronously. Errors are caught inside
  // runAcceptedAgent so they reach the user as a 'failed' outcome bubble
  // instead of crashing the response. The route returns immediately.
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
  _dismissedPatterns.get(p.userId).set(patternKey(p.message), p.dismissedAt);
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
  const userMap = _dismissedPatterns.get(userId);
  if (!userMap) return false;
  const t = userMap.get(patternKey(message));
  if (!t) return false;
  if (Date.now() - t > DISMISS_COOLDOWN_MS) {
    userMap.delete(patternKey(message));
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
