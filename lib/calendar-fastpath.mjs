// @ts-check
/**
 * Calendar fast-path — answers closed-form calendar questions from the local
 * mirror (lib/calendar-mirror.mjs) with zero LLM round-trips.
 *
 * Scope is deliberately tight, same philosophy as lib/trivia-fastpath.mjs:
 * only bare "what's on my calendar (today|tomorrow|<weekday>|this week)"-class
 * asks match; anything with extra qualifiers ("am I free at 3pm", "when can I
 * fit a 2h ride next week") fails the end anchor and falls through to the
 * LLM, which now has the calendar_snapshot tool for one-call answers.
 *
 * Freshness comes from getFreshMirror's check-on-ask: a sync-token pull runs
 * before answering whenever the mirror is older than ~2 min, so a morning
 * mirror never answers an afternoon question after events changed. Any miss
 * (no creds, sync failure) returns null → normal LLM+gcal path.
 */

import { getFreshMirror, eventStartMs } from './calendar-mirror.mjs';
import { getUserTz } from './tutor-stats.mjs';

// ── Classification ────────────────────────────────────────────────────────────
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WHEN = '(today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|this week|the rest of the week|next week|this weekend|the weekend)';

const PATTERNS = [
  // "what's on my calendar [for] today" / "what's on the schedule"
  new RegExp(`^what(?:'s| is)?(?: there)? (?:on|in) (?:my |the )?(?:calendar|schedule|agenda)(?: (?:for|on))?(?: ${WHEN})?$`),
  // "what's my schedule [for] tomorrow" / "what's my calendar today"
  new RegExp(`^what(?:'s| is) (?:my |the )(?:calendar|schedule|agenda)(?: (?:for|on))?(?: ${WHEN})?$`),
  // "what does my day/week/schedule look like [today]"
  new RegExp(`^what does (?:my |the )?(day|week|calendar|schedule|agenda) look like(?: ${WHEN})?$`),
  // "do i have anything [going on] [tomorrow]" / "do i have any meetings friday"
  new RegExp(`^do i have (?:anything|any (?:meetings?|events?|appointments?|calls?|plans?))(?: (?:going on|scheduled|planned|happening))?(?: (?:for|on))?(?: ${WHEN})?$`),
  // "anything on my calendar [today]" / "is there anything on the schedule"
  new RegExp(`^(?:is there )?anything (?:on|in) (?:my |the )?(?:calendar|schedule|agenda)(?: (?:for|on))?(?: ${WHEN})?$`),
  // "what am i doing tomorrow"
  new RegExp(`^what am i doing(?: (?:for|on))? ${WHEN}$`),
];

const NEXT_RE = /^(?:what|when)(?:'s| is) (?:my |the )?next (meeting|event|appointment|call|thing)(?: on my calendar| on the calendar| on my schedule)?$/;

const WHEN_SET = new Set(['today', 'tonight', 'tomorrow', ...WEEKDAYS,
  'this week', 'the rest of the week', 'next week', 'this weekend', 'the weekend']);

const FOLLOWUP_RE = new RegExp(`^(?:(?:and|what about|how about)\\s+)?(?:on\\s+|for\\s+)?${WHEN}\\??$`);

/**
 * Follow-up classifier — "what about friday", "and tomorrow?", "how about
 * next week", or a bare "saturday?". Only meaningful when the PREVIOUS turn
 * was a calendar fast-path hit (the caller enforces that); on its own this
 * shape is far too generic to route. The WHEN token is REQUIRED — "what
 * about my email" has no day phrase and can never match, which is the
 * guardrail against calendar context hijacking unrelated follow-ups.
 *
 * @param {string} text
 * @returns {{kind: 'agenda', when: string} | null}
 */
export function classifyCalendarFollowup(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase()
    .replace(/[‘’']/g, "'")
    .replace(/[.,!?]+$/, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const m = t.match(FOLLOWUP_RE);
  if (!m) return null;
  let when = null;
  for (let i = m.length - 1; i >= 1; i--) {
    if (m[i] && WHEN_SET.has(m[i])) { when = m[i]; break; }
  }
  if (!when) return null;
  if (when === 'tonight') when = 'today';
  if (when === 'the rest of the week') when = 'this week';
  if (when === 'the weekend') when = 'this weekend';
  return { kind: 'agenda', when };
}

/**
 * @param {string} text
 * @returns {{kind: 'agenda', when: string} | {kind: 'next', noun: string} | null}
 */
export function classifyCalendarIntent(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase()
    .replace(/[‘’']/g, "'")
    .replace(/[.,!?]+$/, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const nm = t.match(NEXT_RE);
  if (nm) return { kind: 'next', noun: nm[1] };
  for (const re of PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    // The captured WHEN (if any) is the last group holding a known phrase.
    // The "look like" pattern also captures day|week|schedule|… as group 1 —
    // only "week" carries meaning there ("what does my week look like").
    let when = null;
    for (let i = m.length - 1; i >= 1; i--) {
      if (m[i] && WHEN_SET.has(m[i])) { when = m[i]; break; }
    }
    if (!when && m[1] === 'week') when = 'this week';
    if (!when || when === 'tonight') when = 'today';
    if (when === 'the rest of the week') when = 'this week';
    if (when === 'the weekend') when = 'this weekend';
    return { kind: 'agenda', when };
  }
  return null;
}

// ── Date resolution (user-local tz; events keep their OWN tz) ─────────────────
function todayStr(tz, now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Add days to a YYYY-MM-DD string. UTC-noon anchor sidesteps DST edges. */
export function addDays(dstr, n) {
  const [y, m, d] = dstr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12) + n * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(dstr) {
  const [y, m, d] = dstr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * Resolve a WHEN phrase to an inclusive local-date range.
 * @returns {{start: string, end: string, label: string}}
 */
export function resolveCalendarRange(when, tz, now = new Date()) {
  const d0 = todayStr(tz, now);
  const w0 = weekdayOf(d0);
  if (when === 'today')    return { start: d0, end: d0, label: 'today' };
  if (when === 'tomorrow') { const d = addDays(d0, 1); return { start: d, end: d, label: 'tomorrow' }; }
  const wIdx = WEEKDAYS.indexOf(when);
  if (wIdx >= 0) {
    const delta = (wIdx - w0 + 7) % 7; // 0 → they mean today
    const d = addDays(d0, delta);
    const cap = when[0].toUpperCase() + when.slice(1);
    return { start: d, end: d, label: delta === 0 ? 'today' : `on ${cap}` };
  }
  if (when === 'this week') {
    const toSunday = w0 === 0 ? 0 : 7 - w0;
    return { start: d0, end: addDays(d0, toSunday), label: 'this week' };
  }
  if (when === 'next week') {
    const toNextMonday = ((8 - w0) % 7) || 7;
    const start = addDays(d0, toNextMonday);
    return { start, end: addDays(start, 6), label: 'next week' };
  }
  if (when === 'this weekend') {
    const toSat = (6 - w0 + 7) % 7;
    const start = w0 === 0 ? d0 : addDays(d0, toSat);          // Sunday → just today
    const end = w0 === 0 ? d0 : addDays(start, 1);
    return { start, end, label: 'this weekend' };
  }
  return { start: d0, end: d0, label: 'today' };
}

// ── Event bucketing ───────────────────────────────────────────────────────────
function isAllDay(ev) { return !!ev.start?.date; }

/** Local dates (YYYY-MM-DD, inclusive) an event occupies, in the user's tz. */
export function eventDays(ev, tz) {
  if (isAllDay(ev)) {
    const days = [];
    // API end dates are exclusive.
    for (let d = ev.start.date; d < ev.end?.date; d = addDays(d, 1)) {
      days.push(d);
      if (days.length > 60) break; // corrupt-data guard
    }
    return days.length ? days : [ev.start.date];
  }
  if (ev.start?.dateTime) return [new Date(ev.start.dateTime).toLocaleDateString('en-CA', { timeZone: tz })];
  return [];
}

function eventsOnDay(events, dstr, tz) {
  return events.filter(ev => eventDays(ev, tz).includes(dstr));
}

// ── Time/date formatting ──────────────────────────────────────────────────────
function timeParts(iso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return { h: get('hour'), m: get('minute'), period: get('dayPeriod').toUpperCase() };
}

/** "5 to 8 AM" / "9:30 AM to 1 PM" — digits; the TTS sanitizer naturalizes further. */
export function spokenTimeRange(ev, tz) {
  if (isAllDay(ev)) return 'all day';
  const s = timeParts(ev.start.dateTime, tz);
  const e = ev.end?.dateTime ? timeParts(ev.end.dateTime, tz) : null;
  const fmt = p => p.m === '00' ? p.h : `${p.h}:${p.m}`;
  if (!e) return `at ${fmt(s)} ${s.period}`;
  if (s.period === e.period) return `${fmt(s)} to ${fmt(e)} ${e.period}`;
  return `${fmt(s)} ${s.period} to ${fmt(e)} ${e.period}`;
}

/** "5:00–8:00 AM" / "9:30 AM–1:00 PM" for chat. */
export function chatTimeRange(ev, tz) {
  if (isAllDay(ev)) return 'All day';
  const s = timeParts(ev.start.dateTime, tz);
  const e = ev.end?.dateTime ? timeParts(ev.end.dateTime, tz) : null;
  const fmt = p => `${p.h}:${p.m}`;
  if (!e) return `${fmt(s)} ${s.period}`;
  if (s.period === e.period) return `${fmt(s)}–${fmt(e)} ${e.period}`;
  return `${fmt(s)} ${s.period}–${fmt(e)} ${e.period}`;
}

function dayHeading(dstr, tz, now = new Date()) {
  const d0 = todayStr(tz, now);
  const [y, m, d] = dstr.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const pretty = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(noon);
  if (dstr === d0) return `Today — ${pretty}`;
  if (dstr === addDays(d0, 1)) return `Tomorrow — ${pretty}`;
  return pretty;
}

function spokenDayPhrase(dstr, tz, now = new Date()) {
  const d0 = todayStr(tz, now);
  if (dstr === d0) return 'today';
  if (dstr === addDays(d0, 1)) return 'tomorrow';
  const [y, m, d] = dstr.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const within6 = dstr > d0 && dstr <= addDays(d0, 6);
  const opts = within6 ? { weekday: 'long' } : { weekday: 'long', month: 'long', day: 'numeric' };
  return 'on ' + new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', .../** @type {any} */(opts) }).format(noon);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const VOICE_EVENT_CAP = 8;

function calName(mirror, calId) { return mirror.calendars?.[calId]?.name || 'calendar'; }
/** "your Work calendar" but "your Family Calendar" — no doubled suffix. */
function spokenCalPhrase(mirror, calId) {
  const name = calName(mirror, calId);
  return /calendar$/i.test(name) ? `your ${name}` : `your ${name} calendar`;
}
function multiCal(dayEvs) { return new Set(dayEvs.map(e => e.calId)).size > 1; }

function renderVoiceDay(mirror, evs, label, tz) {
  if (!evs.length) return `Nothing on your calendar ${label}.`;
  const capped = evs.slice(0, VOICE_EVENT_CAP);
  const more = evs.length - capped.length;
  let text;
  if (multiCal(capped)) {
    const byCal = new Map();
    for (const ev of capped) {
      if (!byCal.has(ev.calId)) byCal.set(ev.calId, []);
      byCal.get(ev.calId).push(ev);
    }
    const parts = [];
    for (const [calId, group] of byCal) {
      const items = group.map(ev => `${ev.summary}, ${spokenTimeRange(ev, tz)}`).join('; ');
      parts.push(`On ${spokenCalPhrase(mirror, calId)}: ${items}.`);
    }
    text = parts.join(' ');
  } else {
    const items = capped.map(ev => `${ev.summary}, ${spokenTimeRange(ev, tz)}`).join('; ');
    text = capped.length === 1
      ? `One thing ${label}: ${items}.`
      : `You have ${capped.length} things ${label}: ${items}.`;
  }
  if (more > 0) text += ` And ${more} more.`;
  return text;
}

function renderVoiceRange(mirror, events, range, tz, now) {
  const days = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(d);
  const withEvents = days.map(d => ({ d, evs: eventsOnDay(events, d, tz) })).filter(x => x.evs.length);
  if (!withEvents.length) return `Nothing on your calendar ${range.label}.`;
  let spoken = 0;
  const parts = [];
  for (const { d, evs } of withEvents) {
    if (spoken >= VOICE_EVENT_CAP) break;
    const take = evs.slice(0, VOICE_EVENT_CAP - spoken);
    spoken += take.length;
    const dayName = spokenDayPhrase(d, tz, now).replace(/^on /, '');
    parts.push(`${dayName[0].toUpperCase() + dayName.slice(1)}: ${take.map(ev => `${ev.summary}, ${spokenTimeRange(ev, tz)}`).join('; ')}.`);
  }
  const total = withEvents.reduce((n, x) => n + x.evs.length, 0);
  let text = parts.join(' ');
  if (total > spoken) text += ` And ${total - spoken} more ${range.label}.`;
  return text;
}

function renderChatDay(mirror, evs, dstr, tz, now) {
  const lines = [`**${dayHeading(dstr, tz, now)}**`, ''];
  if (!evs.length) { lines.push('Nothing scheduled.'); return lines.join('\n'); }
  const showCal = multiCal(evs);
  for (const ev of evs) {
    let line = `- ${chatTimeRange(ev, tz)} — ${ev.summary}`;
    if (ev.location) line += ` · ${ev.location}`;
    if (showCal) line += ` _(${calName(mirror, ev.calId)})_`;
    lines.push(line);
  }
  return lines.join('\n');
}

function renderChatRange(mirror, events, range, tz, now) {
  const sections = [];
  let any = false;
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
    const evs = eventsOnDay(events, d, tz);
    if (!evs.length) continue;
    any = true;
    sections.push(renderChatDay(mirror, evs, d, tz, now));
  }
  if (!any) return `Nothing on your calendar ${range.label}.`;
  return sections.join('\n\n');
}

function renderNext(mirror, tz, { voice, noun }, now = new Date()) {
  const d0 = todayStr(tz, now);
  // "next meeting/appointment/call" means a TIMED event — an all-day holiday
  // or PTO block must not answer for it. "next event/thing" takes anything.
  const wantsTimed = noun === 'meeting' || noun === 'appointment' || noun === 'call';
  const upcoming = mirror.events
    .filter(ev => {
      if (wantsTimed && isAllDay(ev)) return false;
      return isAllDay(ev) ? ev.start.date > d0 : eventStartMs(ev) > now.getTime();
    })
    .sort((a, b) => eventStartMs(a) - eventStartMs(b));
  const ev = upcoming[0];
  if (!ev) {
    return wantsTimed
      ? `I don't see any upcoming ${noun}s on your calendar in the next month.`
      : 'Nothing coming up on your calendar in the next month.';
  }
  const day = eventDays(ev, tz)[0];
  const dayPhrase = spokenDayPhrase(day, tz, now);
  const showCal = Object.keys(mirror.calendars || {}).length > 1;
  const calSuffix = showCal ? ` on ${spokenCalPhrase(mirror, ev.calId)}` : '';
  if (voice) {
    const time = isAllDay(ev) ? 'all day' : spokenTimeRange(ev, tz);
    return `Your next event is ${ev.summary}, ${dayPhrase}, ${time}${calSuffix}.`;
  }
  let line = `Your next event is **${ev.summary}** — ${dayHeading(day, tz, now)}, ${chatTimeRange(ev, tz)}`;
  if (ev.location) line += ` · ${ev.location}`;
  if (showCal) line += ` _(${calName(mirror, ev.calId)})_`;
  return line + '.';
}

/**
 * Execute a classified calendar intent against the fresh mirror.
 * Returns { text } or null (no creds / sync failed → caller falls through
 * to the live LLM+gcal path — never answer from stale data silently).
 *
 * @param {{kind: string, when?: string, noun?: string}} intent
 * @param {string} userId
 * @param {{voice?: boolean}} [opts]
 */
export async function executeCalendarIntent(intent, userId, opts = {}) {
  const mirror = await getFreshMirror(userId);
  if (!mirror?.events) return null;
  const tz = getUserTz(userId);
  const now = new Date();
  if (intent.kind === 'next') return { text: renderNext(mirror, tz, { voice: !!opts.voice, noun: intent.noun }, now) };
  const range = resolveCalendarRange(intent.when, tz, now);
  if (opts.voice) {
    const text = range.start === range.end
      ? renderVoiceDay(mirror, eventsOnDay(mirror.events, range.start, tz), range.label, tz)
      : renderVoiceRange(mirror, mirror.events, range, tz, now);
    return { text };
  }
  const text = range.start === range.end
    ? (eventsOnDay(mirror.events, range.start, tz).length
        ? renderChatDay(mirror, eventsOnDay(mirror.events, range.start, tz), range.start, tz, now)
        : `Nothing on your calendar ${range.label}.`)
    : renderChatRange(mirror, mirror.events, range, tz, now);
  return { text };
}
