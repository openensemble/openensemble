/**
 * Voice-device countdown timer fast-path. Runs pre-LLM on voice-device chat
 * text — when the user says "set a 5 minute timer", regex matches, we
 * schedule a one-shot reminder targeted at the originating device, and the
 * normal chime + TTS reminder pipeline handles the "ding" when it fires.
 *
 * Scope deliberately narrow:
 *   - Creation only (cancellation is a known follow-up).
 *   - Digits + small number-words (one through ten, plus "a/an" for 1).
 *   - second / minute / hour units, singular/plural, common abbreviations.
 *   - Allows compound durations: "1 hour 30 minutes", "5 minutes 30 seconds".
 *
 * Phrasings supported (case-insensitive, trailing punctuation tolerated):
 *   "set a timer for 5 minutes"        → 300s
 *   "set a 5 minute timer"             → 300s
 *   "5 minute timer"                   → 300s
 *   "timer for 5 minutes"              → 300s
 *   "start a timer for 1 hour"         → 3600s
 *   "set a timer for 1 hour 30 minutes"→ 5400s
 *
 * Off-scope (falls through to LLM):
 *   - "remind me in 5 minutes to X"    (that's a labeled reminder, not a timer)
 *   - bare "set a timer" with no duration (ambiguous, ask the LLM)
 */
import { addTask, scheduleNewTask, loadTasksForOwner, removeTask, updateTask } from '../scheduler.mjs';

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

const UNIT_SEC = {
  second: 1, seconds: 1, sec: 1, secs: 1,
  minute: 60, minutes: 60, min: 60, mins: 60,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
};

// Words that show up inside a duration phrase but carry no quantity. "give
// me 2 more minutes" → "2 more minutes" gets captured; we want to read
// that as 2 minutes, not bail on the unknown token "more".
const NOISE_WORDS = new Set(['more', 'another', 'extra', 'just', 'about', 'around', 'roughly']);

// Tokenize a duration phrase into seconds. Returns 0 on parse failure so the
// caller treats it as "no match" and falls through. Accepts compound phrases
// like "1 hour 30 minutes" and "1 hour and 30 minutes".
function parseDuration(phrase) {
  if (typeof phrase !== 'string') return 0;
  const t = phrase.toLowerCase().replace(/[,.!?]+$/, '').trim();
  if (!t) return 0;
  // Split on whitespace and the connector "and" so "1 hour and 30 minutes"
  // parses identically to "1 hour 30 minutes".
  const toks = t.split(/\s+|\band\b/i).filter(Boolean);
  let total = 0;
  let pendingNum = null;
  for (const tok of toks) {
    if (NOISE_WORDS.has(tok)) continue;
    if (NUM_WORDS[tok] != null) {
      pendingNum = (pendingNum ?? 0) + NUM_WORDS[tok];
      continue;
    }
    if (/^\d+$/.test(tok)) {
      pendingNum = (pendingNum ?? 0) + Number(tok);
      continue;
    }
    if (UNIT_SEC[tok] != null) {
      if (pendingNum == null) return 0;  // unit without number → bail
      total += pendingNum * UNIT_SEC[tok];
      pendingNum = null;
      continue;
    }
    // Unknown token → not a clean duration phrase
    return 0;
  }
  if (pendingNum != null) return 0;  // trailing number with no unit
  return total;
}

// Format seconds back into a natural spoken phrase. Two forms because
// English collapses plurals when a duration modifies another noun:
//   formatDuration(300)    → "5 minutes"   (standalone: "added 5 minutes")
//   formatDurationAdj(300) → "5 minute"    (adjective: "5 minute timer")
// Compound durations follow the same rule: "1 hour 30 minutes" standalone
// vs "1 hour 30 minute timer" as an adjective.
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export function formatDurationAdj(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h} hour`);
  if (m) parts.push(`${m} minute`);
  if (s) parts.push(`${s} second`);
  return parts.join(' ');
}

// Match the timer phrase and extract the duration substring. Two shapes:
//   "(set/start a) timer for <duration>"
//   "(set a) <duration> timer"
// Returns { seconds, spoken } on match, or null.
//
// The article-strip in X_TIMER_RE uses a lookahead so it only fires when "a"
// / "an" precede an explicit quantity ("a 5 minute timer" → strip "a"). For
// phrases like "an hour timer" the "an" IS the quantity (= 1) so we leave it
// in the capture; parseDuration treats it as a number-word.
const QUANT_LOOKAHEAD = '(?=\\d|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)';
const TIMER_FOR_RE = /^(?:please\s+)?(?:can\s+you\s+)?(?:set|start|begin|create|make|add|put)?\s*(?:a\s+|an\s+|the\s+)?(?:new\s+)?timer\s+(?:for|of)\s+(.+?)$/i;
const X_TIMER_RE   = new RegExp(`^(?:please\\s+)?(?:can\\s+you\\s+)?(?:set|start|begin|create|make|add|put)?\\s*(?:(?:a|an|the)\\s+${QUANT_LOOKAHEAD})?(.+?)\\s+timer$`, 'i');

export function classifyTimerIntent(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/[.!?]+$/, '');
  if (!t) return null;

  let m = t.match(TIMER_FOR_RE);
  if (!m) m = t.match(X_TIMER_RE);
  if (!m) return null;

  const seconds = parseDuration(m[1]);
  if (!seconds) return null;
  // Sanity cap: 24h. A "365 day timer" almost always means the parser
  // misfired, and `scheduleNewTask` already supports anything via datetime so
  // longer is technically possible — but voice timers above a day are
  // weird enough that we'd rather fall through to the LLM where a regular
  // reminder is the better answer.
  if (seconds > 24 * 3600) return null;
  return { seconds, spoken: formatDuration(seconds) };
}

/**
 * Create a one-shot reminder that fires at now + seconds on the given device.
 * Returns the spoken confirmation text the caller emits as a token+done.
 *
 * The reminder rides the existing voice-channel path: when fireReminder runs
 * it sees `voiceDeviceId`, forces the voice branch, and speakReminder
 * synthesizes "Reminder: <label>" with the standard chime prefix.
 */
export async function createVoiceTimer({ userId, deviceId, seconds }) {
  if (!userId || !deviceId || !seconds) {
    throw new Error('createVoiceTimer: userId, deviceId, seconds required');
  }
  const when = new Date(Date.now() + seconds * 1000);
  const adj = formatDurationAdj(seconds);
  const label = `Your ${adj} timer is done`;
  const task = await addTask({
    label,
    ownerId: userId,
    type: 'reminder',
    handler: 'fireReminder',
    repeat: 'once',
    datetime: when.toISOString(),
    voiceDeviceId: deviceId,
    // Marker for the cancel fast-path. Without this we'd have to match
    // generic reminders by label pattern, which is brittle if a user creates
    // a regular reminder named "Your 5 minute timer is done".
    voiceTimer: true,
    // Original duration in seconds. Used by cancelVoiceTimer to match
    // "cancel my 5 minute timer" against a specific timer instead of just
    // grabbing the most-recent.
    voiceTimerSeconds: seconds,
  });
  scheduleNewTask(task);
  return `Okay, ${adj} timer started.`;
}

// "cancel the timer" / "stop my timer" / "cancel all timers" / "cancel my 5
// minute timer" — must include the word "timer" so it doesn't collide with
// the generic 'stop' barge-in intent in classifyVoiceIntent.
//
// Capture groups:
//   1. "all (the|my)? (active )?" → user wants every timer
//   2. middle text between determiner and "timer(s)" → possibly a duration
//      ("5 minute") for matching a specific timer
const CANCEL_TIMER_RE = /^(?:please\s+)?(?:cancel|stop|end|delete|kill|remove|disable)\s+(all\s+(?:the\s+|my\s+)?(?:active\s+)?)?(?:the\s+|my\s+|that\s+)?(.+?\s+)?timers?$/i;

export function classifyTimerCancelIntent(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/[.!?]+$/, '');
  if (!t) return null;
  const m = t.match(CANCEL_TIMER_RE);
  if (!m) return null;
  const all = !!m[1];
  const middle = (m[2] || '').trim();
  // If the middle parses to a valid duration, the user named a specific
  // timer to cancel. Otherwise it's filler (or empty) and we treat as
  // "cancel the timer" with no duration hint.
  const seconds = middle ? parseDuration(middle) : 0;
  return { all, seconds: seconds || null };
}

// Per-device pending "which timer?" prompts. When cancel/extend is ambiguous
// we stash the candidate set + the action the user was trying to do, then
// accept a bare duration ("5 minute" / "the 5 minute one") on the next chat
// turn as the user's pick. 30s window matches a normal "uh, let me think"
// hesitation; older pending state is dropped so the user doesn't get burned
// by a stale follow-up matching a timer they didn't intend.
//
// Shape: { action: 'cancel' | 'extend', addSeconds?: number,
//          candidates: [{ id, seconds }], expiresAt: ms }
const PENDING_DISAMBIG = new Map();
const DISAMBIG_TTL_MS = 30_000;

function clearPending(deviceId) {
  PENDING_DISAMBIG.delete(deviceId);
}

function setPendingDisambig(deviceId, { action, addSeconds, candidates }) {
  PENDING_DISAMBIG.set(deviceId, {
    action,
    addSeconds: addSeconds ?? null,
    candidates,
    expiresAt: Date.now() + DISAMBIG_TTL_MS,
  });
}

// Promote an adjective-form duration to a capitalized phrase for sentence-
// initial use: "5 minute timer cancelled."
function capDurationAdj(seconds) {
  const p = formatDurationAdj(seconds);
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : '';
}

/**
 * Cancel active voice timer(s) for this user. Resolution order:
 *   - `all` true: remove every active timer.
 *   - `seconds` provided: match against stored voiceTimerSeconds and remove
 *     that one. Speaks "No N minute timer running." if no match.
 *   - One timer active: remove it.
 *   - Multiple timers, no duration: stash candidates and speak a "which one,
 *     the 5 or the 10 minute one?" question. No removal until the user
 *     replies (handled by classifyTimerDisambigResponse + this function
 *     re-called by chat-dispatch).
 *
 * Looks across the user's timers regardless of device — "cancel the timer"
 * in the bedroom can clear the kitchen-timer that's about to ring.
 */
export function cancelVoiceTimer({ userId, deviceId, all = false, seconds = null }) {
  if (!userId) throw new Error('cancelVoiceTimer: userId required');
  const tasks = loadTasksForOwner(userId).filter(t => t.voiceTimer && t.enabled !== false);
  if (!tasks.length) {
    clearPending(deviceId);
    return 'No active timer to cancel.';
  }

  if (all) {
    for (const t of tasks) removeTask(t.id);
    clearPending(deviceId);
    return tasks.length === 1
      ? 'Timer cancelled.'
      : `${tasks.length} timers cancelled.`;
  }

  if (seconds) {
    const match = tasks.find(t => t.voiceTimerSeconds === seconds);
    if (!match) {
      clearPending(deviceId);
      return `No ${formatDurationAdj(seconds)} timer running.`;
    }
    removeTask(match.id);
    clearPending(deviceId);
    return `${capDurationAdj(seconds)} timer cancelled.`;
  }

  if (tasks.length === 1) {
    removeTask(tasks[0].id);
    clearPending(deviceId);
    return 'Timer cancelled.';
  }

  // Multiple timers, no specific one named — ask. Stash the candidate set
  // so a bare "5 minute" response can resolve without re-issuing the verb.
  const candidates = tasks.map(t => ({ id: t.id, seconds: t.voiceTimerSeconds }));
  setPendingDisambig(deviceId, { action: 'cancel', candidates });
  return askWhichOne(tasks);
}

// "You have multiple timers running. Which one — the 5 minute timer or the
// 10 minute timer?" — shared between cancel and extend prompts so the
// phrasing stays consistent. Repeats "timer" after each duration so the
// sentence reads naturally; "the 5 minute or the 10 minute" alone sounds
// truncated.
function askWhichOne(tasks) {
  const phrases = tasks.map(t => `the ${formatDurationAdj(t.voiceTimerSeconds)} timer`);
  const list = phrases.length === 2
    ? `${phrases[0]} or ${phrases[1]}`
    : phrases.slice(0, -1).join(', ') + `, or ${phrases[phrases.length - 1]}`;
  return `You have multiple timers running. Which one — ${list}?`;
}

// "add 2 minutes to the timer" / "add 30 seconds to the 5 minute timer"
const ADD_TO_RE = /^(?:please\s+)?(?:add|put|tack\s+on)\s+(.+?)\s+(?:more\s+)?(?:to|on|onto)\s+(?:the\s+|my\s+|that\s+)?(.+?\s+)?timers?$/i;
// "extend the timer by 2 minutes" / "extend the 5 minute timer by 30 seconds"
const EXTEND_BY_RE = /^(?:please\s+)?(?:extend|lengthen|increase|push)\s+(?:the\s+|my\s+|that\s+)?(.+?\s+)?timers?\s+(?:by|with|for)\s+(.+?)$/i;
// "give me 2 more minutes" / "i need an extra 30 seconds on the timer" — the
// duration phrase can include noise words ("more", "another", "extra"); the
// parser ignores them. Optional " on/in/to the [N unit] timer" tail names
// a specific timer when multiple are running.
const GIVE_MORE_RE = /^(?:please\s+)?(?:give\s+me|i\s+need|gimme)\s+(.+?)(?:\s+(?:on|in|to)\s+(?:the\s+|my\s+|that\s+)?(.+?\s+)?timers?)?$/i;

/**
 * Match an "extend the timer" intent. Returns:
 *   { addSeconds, targetSeconds: number|null }
 *
 * `targetSeconds` is populated when the user names a specific timer
 * ("the 5 minute timer"); null when ambiguous so the caller can disambig.
 */
export function classifyTimerExtendIntent(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/[.!?]+$/, '');
  if (!t) return null;

  let addPhrase, targetPhrase;
  let m = t.match(ADD_TO_RE);
  if (m) { addPhrase = m[1]; targetPhrase = m[2]; }
  else if ((m = t.match(EXTEND_BY_RE))) { targetPhrase = m[1]; addPhrase = m[2]; }
  else if ((m = t.match(GIVE_MORE_RE))) { addPhrase = m[1]; targetPhrase = m[2]; }
  else return null;

  const addSeconds = parseDuration(addPhrase || '');
  if (!addSeconds) return null;
  if (addSeconds > 24 * 3600) return null;  // same sanity cap as creation

  const targetSeconds = targetPhrase ? parseDuration(targetPhrase.trim()) : 0;
  return { addSeconds, targetSeconds: targetSeconds || null };
}

/**
 * Extend an active voice timer by addSeconds. Resolution mirrors
 * cancelVoiceTimer:
 *   - `targetSeconds` set: match by stored voiceTimerSeconds.
 *   - One timer active: extend it.
 *   - Multiple timers, no target: speak the disambig question, stash an
 *     'extend' pending state with addSeconds so the user's pick fires the
 *     extend (not a cancel) on the chosen candidate.
 *
 * Extension semantics: new fire time = old fire time + addSeconds. We do NOT
 * touch voiceTimerSeconds — the timer keeps its original "identity" so
 * "cancel the 5 minute timer" still matches after a 2-minute extension.
 * Internally this is an `updateTask({datetime})` plus a `scheduleNewTask`,
 * which scheduleTask uses as a re-schedule (it clears the existing
 * _timers.get(id) setTimeout before queuing the new one).
 */
export async function extendVoiceTimer({ userId, deviceId, addSeconds, targetSeconds = null }) {
  if (!userId || !deviceId || !addSeconds) {
    throw new Error('extendVoiceTimer: userId, deviceId, addSeconds required');
  }
  const tasks = loadTasksForOwner(userId).filter(t => t.voiceTimer && t.enabled !== false);
  if (!tasks.length) {
    clearPending(deviceId);
    return 'No active timer to extend.';
  }

  if (targetSeconds) {
    const match = tasks.find(t => t.voiceTimerSeconds === targetSeconds);
    if (!match) {
      clearPending(deviceId);
      return `No ${formatDurationAdj(targetSeconds)} timer running.`;
    }
    return applyExtend(match, addSeconds);
  }

  if (tasks.length === 1) {
    clearPending(deviceId);
    return applyExtend(tasks[0], addSeconds);
  }

  const candidates = tasks.map(t => ({ id: t.id, seconds: t.voiceTimerSeconds }));
  setPendingDisambig(deviceId, { action: 'extend', addSeconds, candidates });
  return askWhichOne(tasks);
}

async function applyExtend(task, addSeconds) {
  const newDt = new Date(new Date(task.datetime).getTime() + addSeconds * 1000).toISOString();
  await updateTask(task.id, { datetime: newDt });
  // scheduleTask sees the existing timer for this id and clears it before
  // queuing the new setTimeout, so this safely reschedules in place.
  scheduleNewTask({ ...task, datetime: newDt });
  // "Added X" uses standalone plural ("Added 2 minutes"); "your X timer"
  // uses adjective singular ("your 5 minute timer").
  return `Added ${formatDuration(addSeconds)} to your ${formatDurationAdj(task.voiceTimerSeconds)} timer.`;
}

/**
 * Single entry point for "the user is replying to a disambig prompt".
 * Looks up the pending action for this device, parses the user's reply as
 * a duration that matches one of the candidates, performs the stored action
 * against that candidate, and returns the spoken confirmation.
 *
 * Returns null if there's no pending state, the prompt expired, or the
 * reply doesn't parse to a candidate's duration — in which case the
 * caller falls through to the normal regex paths (so explicit verbs like
 * "set a 5 minute timer" still win over a stale disambig).
 */
export async function resolveTimerDisambig(text, { deviceId }) {
  if (typeof text !== 'string' || !deviceId) return null;
  const pending = PENDING_DISAMBIG.get(deviceId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    clearPending(deviceId);
    return null;
  }
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!t) return null;
  // Strip "the ... one/timer" wrappers: "the 5 minute one" → "5 minute".
  const stripped = t.replace(/^(the\s+)/, '').replace(/\s+(one|timer)$/, '').trim();
  const seconds = parseDuration(stripped);
  if (!seconds) return null;
  const cand = pending.candidates.find(c => c.seconds === seconds);
  if (!cand) return null;

  clearPending(deviceId);
  if (pending.action === 'extend') {
    // The candidate's id is enough — applyExtend takes a full task object,
    // so we refetch from disk (the task may have already fired during the
    // 30s disambig window).
    return { confirmation: await extendCandidateById(cand.id, pending.addSeconds) };
  }
  removeTask(cand.id);
  return { confirmation: `${capDurationAdj(cand.seconds)} timer cancelled.` };
}

// Look up a candidate task fresh from disk (it may have moved or fired
// during the 30s disambig window) and extend it. Returns the spoken
// confirmation. We have to scan all owners' tasks because we lost the
// userId context — manageable since voice-timer task counts are tiny.
async function extendCandidateById(taskId, addSeconds) {
  // loadAllTasksForScheduler isn't exported; use loadTasksForOwner across
  // owners we know about. Cheap shortcut: the candidate was on a user this
  // device belongs to. But since we don't have that wired down here,
  // dynamic-import the scheduler full loader.
  const { loadAllTasksForScheduler } = await import('../scheduler.mjs');
  const all = loadAllTasksForScheduler();
  const task = all.find(t => t.id === taskId && t.voiceTimer);
  if (!task) return 'That timer is no longer running.';
  return applyExtend(task, addSeconds);
}
