/**
 * Scheduler-intent interceptor.
 *
 * Runs before the LLM on every chat message. If the message looks like a
 * task-creation request, we parse it with the fine-tuned plan model and
 * create a task directly — bypassing tool-calling latency and making
 * scheduling work uniformly across every agent regardless of skill assignments.
 *
 * Two-stage detection:
 *   1. Regex pre-filter: positive signals (schedule/remind me to/every day/
 *      at HH:MM/in N minutes) with explicit negative overrides for memory
 *      recall ("remind me what we talked about yesterday").
 *   2. Plan-model parse: confirms the regex hit is a real schedule by
 *      returning a structured record with a concrete future time.
 *
 * Returns a human-readable outcome line that the caller prepends to the
 * user's message so the agent naturally narrates what happened.
 */
import { planGenerate } from '../scheduler/builtin-plan.mjs';
import { postprocessSchedule } from '../scheduler/time-postprocess.mjs';
import { addTask, scheduleNewTask, loadTasks, removeTask, updateTask } from '../scheduler.mjs';
import { getAgentsForUser, getUserCoordinatorAgentId } from '../routes/_helpers.mjs';
import { polishTask } from './task-label.mjs';

// Regex pre-filter. Positive signals first, negative overrides second.
// Negatives win: "remind me what we talked about yesterday" has "remind me"
// but the following "what...yesterday" flips it back to a memory recall.
export function isTaskIntent(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (!t) return false;

  // Negative: memory recall with "remind me" wrapper
  if (/\bremind me (what|when|where|who|why|how|which|if|about (that|what|when|the time))\b/.test(t)) return false;
  // Negative: explicit past-tense framing
  if (/\b(yesterday|last (week|month|year|time|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|earlier today|a (few|couple) (hours|days|weeks) ago)\b/.test(t)) return false;
  if (/\b(did we|did you|did i|what was|what did|what were|have we|have you|have i)\b/.test(t)) return false;
  if (/^(?:i (?:prefer|like|love|hate|enjoy|always|never|usually|tend to|wish|hope)\b|i'?m\b|my (?:preference|preferred|favorite)\b)/i.test(t)) return false;

  // Positive: explicit scheduling verbs
  if (/\b(schedule|reschedule)\b/.test(t)) return true;
  if (/\bremind me (to|about|at|in|on|every|tomorrow|tonight|next)\b/.test(t)) return true;
  if (/\b(set|add|create|make) (a |an )?(reminder|task|alarm|timer|appointment)\b/.test(t)) return true;
  // Positive: recurrence words
  if (/\bevery (day|morning|afternoon|evening|night|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|\d+\s*(minute|hour|day))\b/.test(t)) return true;
  if (/\b(daily|weekly|hourly)\b/.test(t)) return true;
  // Positive: relative future time
  if (/\bin \d+\s*(second|minute|hour|day|week|month)s?\b/.test(t)) return true;
  // Positive: absolute future time-of-day with an action verb
  if (/\bat \d{1,2}(:\d{2})?\s*(am|pm)?\b/.test(t) && /\b(do|run|check|call|send|email|text|buy|get|pick|fetch|ping|message|meet|attend|review|post|pay|book|start|stop|wake|go)\b/.test(t)) return true;
  // Positive: explicit future day words
  if (/\b(tomorrow|tonight|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/.test(t)) return true;

  return false;
}

// "remind me to X" is a notification-only reminder (banner + chime via
// fireReminder). "schedule X" / "run X at 5pm" / "send Y tomorrow" is an
// agent task (chat prompt fires in an agent session). Same firing path in
// scheduler.mjs but different task shape — reminders have type:'reminder'
// + handler:'fireReminder' and don't need an agent or prompt.
function isReminderIntent(text) {
  const t = (text || '').trim().toLowerCase();
  if (/^remind me\b/.test(t)) return true;
  if (/\b(set|add|create|make) (a |an )?(reminder|alarm)\b/.test(t)) return true;
  return false;
}

// Strip the scheduling scaffolding the plan model sometimes leaks back into
// `intent`. "Schedule daily news briefing at 1am" becomes "daily news briefing"
// — otherwise the verbatim phrase gets sent to the agent at fire time and it
// tries to re-schedule itself instead of acting on the underlying request.
function cleanIntent(intent) {
  if (!intent) return '';
  const orig = String(intent).trim();
  if (!orig) return '';
  let s = orig;
  // Strip leading scheduling wrappers — but ONLY the scheduling-verb ones.
  // "Make dinner" vs "Make a reminder to have dinner" — don't touch the first.
  s = s.replace(/^(please\s+)?(schedule|reschedule)\s+(me\s+)?(an?\s+|the\s+)?/i, '');
  s = s.replace(/^(please\s+)?(set\s+up|set|create|make|add|arrange)\s+(an?\s+|the\s+)?(reminder|task|alarm|timer|appointment|notification)\s+(to|about|for|that)\s+/i, '');
  s = s.replace(/^remind\s+me\s+(to|about)\s+/i, '');
  // Strip trailing temporal qualifiers — time is already in schedule fields.
  s = s.replace(/\s+(at|every|tomorrow|tonight|next|on|this|by)\s+\S.*$/i, '');
  s = s.replace(/\s+in\s+\d+\s*(second|minute|hour|day|week|month)s?\s*(from\s+now)?\s*$/i, '');
  s = s.trim();
  if (!s) return orig;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Coerce known plan-model schema confusions before validation. SmolLM2-135M
// fine-tune leaks across mode/recurrence pairings the training data never
// showed — most commonly mode="recurring" with no cron BUT populated window
// fields, which is just a window task with the wrong label. Reinterpret it
// as a window task instead of rejecting.
function coerceSchedule(parsed, originalText) {
  const s = parsed?.schedule;
  if (!s || typeof s !== 'object') return parsed;

  const txt = (originalText || '').toLowerCase();
  const looksRecurring = /\b(every|daily|weekly|hourly|each)\b/.test(txt);
  const looksOneShot = /\b(tomorrow|tonight|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+\s*(second|minute|hour|day|week)s?)\b/.test(txt);
  const hasCron = !!(s.recurrence && typeof s.recurrence === 'string');
  const hasWindow = !!(s.earliest || s.latest || s.preferred);

  // Case 1: model said "recurring" but emitted no cron AND populated window
  // fields, AND the request doesn't read like a recurring one. Coerce to window.
  if (s.mode === 'recurring' && !hasCron && hasWindow && !looksRecurring) {
    s.mode = 'window';
  }

  // Case 2: request IS recurring (e.g. "every morning at 7") and model
  // populated window fields with no cron — synthesize cron from preferred.
  if (s.mode === 'recurring' && !hasCron && hasWindow && looksRecurring) {
    const iso = s.preferred || s.earliest;
    const d = iso ? new Date(iso) : null;
    if (d && !Number.isNaN(d.getTime())) {
      const m = d.getMinutes();
      const h = d.getHours();
      s.recurrence = `${m} ${h} * * *`;
      s.earliest = null; s.latest = null; s.preferred = null;
    }
  }

  // Case 3: model emitted recurring + cron BUT request is clearly a one-shot
  // ("tomorrow at 9am", "next friday at 2pm"). Convert cron back to a window
  // task at the next occurrence of that hh:mm.
  if (s.mode === 'recurring' && hasCron && looksOneShot && !looksRecurring) {
    const m = String(s.recurrence).trim().match(/^(\d{1,2})\s+(\d{1,2})\s+/);
    if (m) {
      const minute = Number(m[1]);
      const hour = Number(m[2]);
      const now = new Date();
      const target = new Date(now);
      target.setSeconds(0, 0);
      target.setHours(hour, minute);
      // If hh:mm is in the past today, push to tomorrow (or matching weekday)
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      // If user named a specific weekday, advance to it
      const dowMatch = txt.match(/\b(?:next |on |this )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
      if (dowMatch) {
        const DOW = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
        const wantDow = DOW[dowMatch[1]];
        const isNext = /\bnext\b/.test(txt);
        let delta = (wantDow - target.getDay() + 7) % 7;
        if (delta === 0 && isNext) delta = 7;
        target.setDate(target.getDate() + delta);
      } else if (/\btomorrow\b/.test(txt)) {
        // ensure we land tomorrow (model may have set today)
        const tom = new Date(now);
        tom.setDate(tom.getDate() + 1);
        tom.setHours(hour, minute, 0, 0);
        target.setTime(tom.getTime());
      } else if (/\btonight\b/.test(txt)) {
        // tonight = today's evening at the target hh:mm; if hour < 12 force +12
        const t = new Date(now);
        t.setHours(hour < 12 ? hour + 12 : hour, minute, 0, 0);
        if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
        target.setTime(t.getTime());
      }
      s.mode = 'window';
      s.preferred = target.toISOString();
      s.earliest = target.toISOString();
      s.latest = new Date(target.getTime() + 5 * 60_000).toISOString();
      s.recurrence = null;
    }
  }

  return parsed;
}

// Validate and coerce the plan-model's parse output into a task record.
// Returns { ok: true, task } or { ok: false, error } — error is human-readable.
function validateParse(parsed, userId, currentAgentId, originalText) {
  const asReminder = isReminderIntent(originalText);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'plan model did not return a usable schedule' };
  }
  const _bareFragmentRe = /^(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?$|^(?:tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$|^in\s+\d+\s*(?:min(?:ute)?|hour|day|week|month)s?$|^(?:next|this)\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$|^(?:(?:next|this)\s+)?(?:tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/i;
  if (_bareFragmentRe.test((originalText || '').trim())) {
    return { ok: false, error: 'message is a time fragment with no task content — ask the user what the reminder is for' };
  }
  parsed = coerceSchedule(parsed, originalText);
  const schedule = parsed.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return { ok: false, error: 'schedule missing from parse output' };
  }

  // Resolve target agent — only needed for non-reminder tasks. Reminders
  // fire via the fireReminder builtin and have no agent/prompt.
  const roster = getAgentsForUser(userId);
  let agentId = currentAgentId;
  if (parsed.target?.agent) {
    const named = String(parsed.target.agent).toLowerCase();
    const hit = roster.find(a =>
      a.id === parsed.target.agent ||
      a.id.toLowerCase().includes(named) ||
      (a.name && a.name.toLowerCase() === named)
    );
    if (hit) agentId = hit.id;
  }
  if (!agentId) agentId = getUserCoordinatorAgentId(userId);
  if (!asReminder && !agentId) return { ok: false, error: 'no target agent available for this user' };

  const cleaned = cleanIntent(parsed.intent);
  const label = cleaned || (asReminder ? 'Reminder' : 'Scheduled task');
  // Default fire-time prompt: the user's original raw text. polishTask
  // overrides this in interceptScheduling with an LLM-rewritten "do it
  // now" instruction (trigger phrase removed, content preserved). If the
  // LLM call fails we fall back to originalText and rely on the
  // [SCHEDULED RUN] systemNote to keep the agent on track.
  const prompt = (originalText || '').trim() || cleaned || label;

  // Recurring path — needs a cron expression we can translate to HH:MM.
  // The existing scheduler only supports daily-at-HH:MM, so we accept the
  // common cases and reject exotic cron patterns explicitly instead of
  // silently creating a task that never fires.
  if (schedule.mode === 'recurring') {
    const cron = schedule.recurrence;
    if (!cron || typeof cron !== 'string') {
      return { ok: false, error: 'recurring task without a recurrence pattern' };
    }
    // Accept "M H * * *" (every day) and "M H * * X" (weekday-restricted: 1-5,
    // 0,6, etc). Day-of-month and month restrictions still aren't supported.
    const m = cron.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([\d,*-]+)$/);
    if (!m) {
      return { ok: false, error: `recurrence pattern "${cron}" is not a simple daily schedule; only "M H * * X" is supported right now` };
    }
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    if (hour > 23 || minute > 59) {
      return { ok: false, error: `invalid time in recurrence "${cron}"` };
    }
    const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const dowField = m[3];
    const base = { label, repeat: 'daily', time: hhmm, ownerId: userId };
    if (dowField !== '*') base.dow = dowField;
    if (dowField === '1-5')                            base.weekdaysOnly = true;
    else if (dowField === '0,6' || dowField === '6,0') base.weekendsOnly = true;
    return {
      ok: true,
      task: asReminder
        ? { ...base, type: 'reminder', handler: 'fireReminder' }
        : { ...base, agent: agentId, prompt },
    };
  }

  // One-time path — pick the most specific of preferred / earliest / latest
  // and require the resolved time to be at least five seconds in the future.
  // A past time almost always means the parse misfired on something that
  // wasn't really a scheduling request.
  const iso = schedule.preferred || schedule.earliest || schedule.latest;
  if (!iso) return { ok: false, error: 'no concrete time found in the request' };
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: `could not parse time "${iso}"` };
  if (when.getTime() - Date.now() < 5000) {
    return { ok: false, error: `requested time ${when.toLocaleString()} is in the past` };
  }
  const _t = (originalText || '').toLowerCase();
  const _hasClockAnchor = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\bnoon\b|\bmidnight\b|\b(morning|afternoon|evening|night|tonight|breakfast|lunch(time)?|dinner(time)?)\b|\bat\s+\d{1,2}\b/i.test(_t);
  // Pure relative offsets ("in 30 minutes") are self-clocked — no anchor needed.
  const _hasPureRelative = /\bin\s+\d+\s*(second|minute|hour|min|hr)s?\b/i.test(_t);
  if (!_hasClockAnchor && !_hasPureRelative) {
    return { ok: false, error: 'no time-of-day was specified — ask the user what time they want, then they can answer with just the time and the scheduler will fill it in' };
  }

  const base = { label, repeat: 'once', datetime: when.toISOString(), ownerId: userId };
  return {
    ok: true,
    task: asReminder
      ? { ...base, type: 'reminder', handler: 'fireReminder' }
      : { ...base, agent: agentId, prompt },
  };
}

const CANCEL_INTENT_RE = /^(?:(?:please\s+)?(?:actually\s+)?(?:never\s*mind|nvm|cancel(?:\s+(?:that|it|the\s+(?:last|previous|recent)\s+(?:reminder|task)))?|delete\s+(?:that|it|the\s+(?:last|previous|recent)\s+(?:reminder|task))|forget\s+(?:that|it|about\s+(?:that|it))|don'?t\s+(?:do|set)\s+(?:that|it)|undo\s+(?:that|it)?|scratch\s+(?:that|it)))[\s.!]*$/i;
function tryCancelLastTask(userId, text) {
  if (!CANCEL_INTENT_RE.test((text || '').trim())) return null;
  const mine = loadTasks().filter(t => t.ownerId === userId);
  if (!mine.length) return null;
  // Pick the most recently created — id format: task_<unixms>...
  const newest = mine
    .map(t => ({ t, ts: Number((t.id || '').match(/_(\d{10,13})/)?.[1] || 0) }))
    .sort((a, b) => b.ts - a.ts)[0]?.t;
  if (!newest) return null;
  // Only auto-cancel things created in the last 10 minutes — anything older
  // is likely an established schedule the user wouldn't want zapped by a
  // stray "never mind".
  const age = Date.now() - Number((newest.id || '').match(/_(\d{10,13})/)?.[1] || 0);
  if (age > 10 * 60_000) return null;
  removeTask(newest.id);
  return newest;
}

const RESCHEDULE_INTENT_RE = /^(?:(?:please\s+)?(?:actually\s+)?(?:make\s+(?:it|that)|change\s+(?:it|that)\s+to|move\s+(?:it|that)\s+to|set\s+(?:it|that)\s+(?:to|for)|reschedule\s+(?:it|that)\s+(?:to|for)))\s+/i;
async function tryRescheduleLastTask(userId, text, postprocessFn, parseClockFn) {
  if (!RESCHEDULE_INTENT_RE.test((text || '').trim())) return null;
  const mine = loadTasks().filter(t => t.ownerId === userId && t.enabled !== false);
  if (!mine.length) return null;
  const newest = mine
    .map(t => ({ t, ts: Number((t.id || '').match(/_(\d{10,13})/)?.[1] || 0) }))
    .sort((a, b) => b.ts - a.ts)[0]?.t;
  if (!newest) return null;
  const age = Date.now() - Number((newest.id || '').match(/_(\d{10,13})/)?.[1] || 0);
  if (age > 10 * 60_000) return null;
  // Postprocess just the user's reschedule phrase to extract a new time.
  // We start from a stub parsed object (mode=window, all times null) so the
  // postprocessor only fills what the text contains.
  const stub = { intent: '', schedule: { mode: 'window', earliest: null, latest: null, preferred: null, recurrence: null } };
  const out = postprocessFn(stub, text, new Date());
  const iso = out?.schedule?.preferred || out?.schedule?.earliest || out?.schedule?.latest;
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime()) || when.getTime() - Date.now() < 5000) return null;
  // For one-shot tasks we patch datetime; for daily tasks we patch HH:MM.
  if (newest.repeat === 'once') {
    await updateTask(newest.id, { datetime: when.toISOString(), enabled: true, lastRun: null });
  } else {
    const hh = String(when.getHours()).padStart(2, '0');
    const mm = String(when.getMinutes()).padStart(2, '0');
    await updateTask(newest.id, { time: `${hh}:${mm}`, enabled: true });
  }
  const fresh = loadTasks().find(t => t.id === newest.id);
  if (fresh) scheduleNewTask(fresh);
  return fresh;
}

function tryStitchClarification(text, history) {
  if (!history || !Array.isArray(history) || history.length < 2) return null;
  const cur = (text || '').trim();
  if (!cur) return null;

  const fragmentRe = /^(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)?$|^(tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$|^in\s+\d+\s*(min(ute)?|hour|day|week|month)s?$|^(next|this)\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$|^\d{1,2}\/\d{1,2}(\/\d{2,4})?$|^(?:(?:next|this)\s+)?(?:tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)$|^(?:at\s+)?(?:[01]\d|2[0-3])[0-5]\d(?:\s*(?:hrs?|hours?))?$/i;
  if (cur.split(/\s+/).length > 6) return null;
  if (!fragmentRe.test(cur)) return null;

  const clarRe = /(what time\b|when (would|do|should) you want\b|which day\b|how often\b|what day\b|at what time\b|on which day\b)/i;
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant' || !clarRe.test(last.content || '')) return null;

  // Walk back over assistant clarifications + short user fragments to find
  // the upstream user turn that started the schedule request.
  for (let i = history.length - 2; i >= 0 && i >= history.length - 6; i--) {
    const m = history[i];
    if (!m || m.role !== 'user') continue;
    if (isTaskIntent(m.content || '')) {
      return `${m.content.trim()} ${cur}`;
    }
    // If we hit a non-fragment user turn that isn't a scheduling intent, abort.
    if ((m.content || '').split(/\s+/).length > 4) return null;
  }
  return null;
}

/**
 * Main entry point. Runs the filter + parse + addTask pipeline.
 *
 * @param {{ userId: string, agentId: string, text: string, history?: Array }} args
 * @returns {Promise<{ matched: boolean, outcome?: string }>}
 *   - matched=false: regex said no, caller should proceed with normal LLM flow unchanged
 *   - matched=true: caller should prepend `outcome` to the user message as a
 *     system-level note so the agent can narrate the result
 */
export async function interceptScheduling({ userId, agentId, text, history, force = false }) {
  const cancelled = tryCancelLastTask(userId, text);
  if (cancelled) {
    const whenStr = cancelled.repeat === 'once'
      ? new Date(cancelled.datetime).toLocaleString()
      : `${cancelled.time} daily`;
    return {
      matched: true,
      outcome: `[scheduler] Cancelled task "${cancelled.label}" (was set for ${whenStr}). Confirm to the user in one short sentence.`,
    };
  }

  const rescheduled = await tryRescheduleLastTask(userId, text, postprocessSchedule);
  if (rescheduled) {
    const whenStr = rescheduled.repeat === 'once'
      ? new Date(rescheduled.datetime).toLocaleString()
      : `${rescheduled.time} daily`;
    return {
      matched: true,
      outcome: `[scheduler] Rescheduled task "${rescheduled.label}" to ${whenStr}. Confirm to the user in one short sentence.`,
    };
  }

  let effectiveText = text;
  const stitched = tryStitchClarification(text, history);
  if (stitched) {
    if (process.env.OE_PLAN_DEBUG) console.log('[scheduler-intent] stitched:', JSON.stringify(stitched));
    effectiveText = stitched;
    force = true;
  }
  if (!force && !isTaskIntent(effectiveText)) return { matched: false };

  // Match the exact training format: "Current time: <ISO>\nRequest: \"<text>\"".
  // Without this the model has no temporal grounding — "tomorrow" gets
  // resolved to whatever date happened to anchor the training examples it
  // most closely matches, producing wildly wrong ISO stamps.
  const now = new Date();
  const tzOffMin = -now.getTimezoneOffset();
  const sign = tzOffMin >= 0 ? '+' : '-';
  const offH = String(Math.floor(Math.abs(tzOffMin) / 60)).padStart(2, '0');
  const offM = String(Math.abs(tzOffMin) % 60).padStart(2, '0');
  const localIso =
    now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + 'T' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0') +
    sign + offH + ':' + offM;
  const groundedPrompt = `Current time: ${localIso}\nRequest: "${effectiveText.replace(/"/g, '\\"')}"`;
  if (process.env.OE_PLAN_DEBUG) console.log('[scheduler-intent] >> parse prompt:\n' + groundedPrompt);

  let raw;
  try {
    raw = await planGenerate({ task: 'parse', user: groundedPrompt });
    if (process.env.OE_PLAN_DEBUG) console.log('[scheduler-intent] << raw output:\n' + raw);
  } catch (e) {
    // Plan model unavailable (weights missing, node-llama-cpp bad). The
    // regex already said this is scheduling intent and there's no tool
    // fallback anymore, so fail loud instead of letting the coordinator
    // silently invent a time.
    console.warn('[scheduler-intent] plan model failed:', e.message);
    return {
      matched: true,
      outcome: `[scheduler] Plan model is unavailable (${e.message}). Tell the user scheduling is offline and they should try again shortly.`,
    };
  }
  if (!raw) {
    return {
      matched: true,
      outcome: `[scheduler] Plan model returned no output. Tell the user scheduling briefly failed and to try rephrasing.`,
    };
  }

  let parsed;
  try {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    parsed = JSON.parse(first >= 0 && last > first ? raw.slice(first, last + 1) : raw);
  } catch {
    // The regex said "scheduling" but the model produced unparseable JSON.
    // Most likely a borderline phrase the regex caught too eagerly — let
    // the normal LLM flow handle it rather than blocking the conversation.
    return { matched: false };
  }

  // Deterministic JS math on the request overrides the model's timestamp
  // guesses for anything the postprocessor can recognize ("tomorrow at 9am",
  // "next monday at 2pm", "in 10 minutes", "every morning at 7"). The model
  // still contributes intent + target + conditions; the postprocessor just
  // nails the schedule fields since a 360M LoRA can't reliably do weekday
  // arithmetic or 12→24-hour conversion.
  parsed = postprocessSchedule(parsed, effectiveText, now);
  if (process.env.OE_PLAN_DEBUG) console.log('[scheduler-intent] << postprocessed:\n' + JSON.stringify(parsed));

  // Parse returned a record with every schedule field null: the model
  // itself said "this isn't a schedule". Fall through.
  const s = parsed?.schedule;
  const hasAnySchedule = s && (s.earliest || s.latest || s.preferred || s.recurrence);
  if (!hasAnySchedule) return { matched: false };

  const v = validateParse(parsed, userId, agentId, effectiveText);
  if (!v.ok) {
    return {
      matched: true,
      outcome: `[scheduler] Did not schedule a task: ${v.error}. Explain this to the user and ask what they want to do.`,
    };
  }

  // Single LLM pass produces both the display title and the fire-time
  // instruction (trigger phrase stripped, content preserved). Failure → keep
  // cleaned-intent label and original-text prompt; the systemNote at fire
  // time still tells the agent "trigger already fired, just do the job".
  // Reminders skip the prompt — fireReminder doesn't use it.
  const polished = await polishTask(effectiveText, userId);
  if (polished?.title) v.task.label = polished.title;
  if (polished?.instruction && v.task.prompt) v.task.prompt = polished.instruction;

  let task;
  try {
    task = await addTask(v.task);
    scheduleNewTask(task);
  } catch (e) {
    return {
      matched: true,
      outcome: `[scheduler] Failed to create task: ${e.message}. Tell the user the scheduler errored and apologize.`,
    };
  }

  const whenStr = task.repeat === 'once'
    ? new Date(task.datetime).toLocaleString()
    : `${task.time} daily`;
  const kind = task.type === 'reminder' ? 'Reminder' : 'Task';
  const agentStr = task.type === 'reminder'
    ? `will fire a notification (chime + banner + browser notification)`
    : `will run as agent ${task.agent}`;
  return {
    matched: true,
    outcome:
      `[scheduler] ${kind} created successfully. label="${task.label}" id=${task.id} when=${whenStr} — ${agentStr}. ` +
      `Confirm this to the user in a natural sentence — include the name and the time — and do not call any scheduling tools.`,
  };
}
