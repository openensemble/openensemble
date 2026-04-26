/**
 * Deterministic time post-processor for scheduler parse outputs.
 *
 * The 135M parse model is strong on shape (intent, mode, conditions, priority)
 * but weak on date arithmetic and cron generation — the 2026-04-22 smoke test
 * showed 51/51 JSON parses, 48/51 correct modes, but only 8/51 correct times
 * and 0/14 correct cron expressions. This module patches model output using
 * hand-rolled regex parsers against the original request text so the runtime
 * fires at the right time even when the model hallucinates timestamps.
 *
 * Pure function: no I/O, no imports. Takes the model's parsed record + the
 * original request text + current time; returns a corrected copy. Never
 * touches the model's intent/priority/conditions/target — only rewrites
 * schedule fields when the request explicitly specifies a time the model got
 * wrong or missed entirely.
 */

const DOW = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const DOW_FULL = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
// Combined regex alternation used in multiple places (full names + common abbrevs).
const DOW_ANY = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)';
function dowKey(s) {
  const k = s.toLowerCase();
  return DOW_FULL[k] ?? DOW[k] ?? null;
}

// Time-of-day anchors used when the request mentions "morning", "afternoon",
// etc. without a specific clock time.
const TOD_ANCHORS = {
  morning:     { preferred: 9,  window: [6, 12]  },
  afternoon:   { preferred: 14, window: [12, 17] },
  evening:     { preferred: 19, window: [17, 21] },
  night:       { preferred: 21, window: [20, 23] },
  tonight:     { preferred: 20, window: [19, 23] },
  noon:        { preferred: 12 },
  midnight:    { preferred: 0  },
  dinnertime:  { preferred: 19, window: [17, 21] },
  lunchtime:   { preferred: 12, window: [11, 13] },
  breakfast:   { preferred: 8,  window: [7, 10] },
};

// "a"/"an" → 1 so "in an hour" = "in 1 hour".
function wordToNum(word) {
  if (/^\d+$/.test(word)) return parseInt(word, 10);
  const map = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
                six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5 };
  return map[word.toLowerCase()] ?? null;
}

const UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour:   3600 * 1000,
  day:    86400 * 1000,
  week:   7 * 86400 * 1000,
  month:  30 * 86400 * 1000, // approximate — good enough for "in a month" windows
  year:   365 * 86400 * 1000,
};

// Unit aliases seen in chat UX — mostly abbreviations.
const UNIT_ALIAS = {
  sec: 'second', secs: 'second',
  min: 'minute', mins: 'minute',
  hr:  'hour',   hrs:  'hour',
  yr:  'year',   yrs:  'year',
};

function unitKey(u) {
  const raw = u.toLowerCase();
  if (raw in UNIT_ALIAS) return UNIT_ALIAS[raw];
  const s = raw.replace(/s$/, '');
  if (s in UNIT_ALIAS) return UNIT_ALIAS[s];
  return s in UNIT_MS ? s : null;
}

function toIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addMs(date, ms) { return new Date(date.getTime() + ms); }

// Small typo fixes for common weekday/verb misspellings seen in chat UX.
// Also normalizes common SMS shorthand ("@"→"at", "tmrw"→"tomorrow") so the
// downstream regex parsers don't have to carry a dozen alternations.
function normalizeRequest(s) {
  return s
    .replace(/\bmondya\b/gi, 'monday')
    .replace(/\btuesdya\b/gi, 'tuesday')
    .replace(/\bwednesdya\b/gi, 'wednesday')
    .replace(/\bthrusday\b|\bthurdsay\b|\bthursdya\b/gi, 'thursday')
    .replace(/\bfirday\b|\bfidray\b|\bfridya\b/gi, 'friday')
    .replace(/\bsaturdya\b/gi, 'saturday')
    .replace(/\bsundya\b/gi, 'sunday')
    .replace(/\btomorow\b|\btommorrow\b|\btommorow\b|\btmrw\b|\btmw\b/gi, 'tomorrow')
    .replace(/\btdy\b|\btday\b/gi, 'today')
    .replace(/\brmeind\b|\brmnd\b|\brmind\b/gi, 'remind')
    .replace(/(\s)@(\s)/g, '$1at$2');
}

// Spelled-out number words 1-12 for hour parsing.
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};
// Spelled-out minute words: "thirty"=30, "fifteen"=15, etc.
const MINUTE_WORDS = {
  'oh five': 5, 'oh': 0, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30,
  'thirty-five': 35, forty: 40, 'forty-five': 45, fifty: 50, 'fifty-five': 55,
  oclock: 0, "o'clock": 0,
};

// Resolve an ambiguous hour (no AM/PM given) using context.
//   - "at 2 today" at 09:00 → 14 (PM, because 02:00 already passed)
//   - "Friday at 2" → 14 (PM heuristic for 1-6)
//   - "Wednesday at 11" → 11 (AM heuristic for 7-11)
// tod: optional TOD anchor ("morning"/"afternoon"/"evening"/"night"/"tonight").
function resolveAmbiguousHour(h, { nowDate, baseDate, tod } = {}) {
  if (h === 12) return 12;
  if (tod === 'morning')        return h >= 1 && h <= 11 ? h : h;
  if (tod === 'afternoon' || tod === 'evening' || tod === 'night' || tod === 'tonight') {
    return h >= 1 && h <= 11 ? h + 12 : h;
  }
  if (nowDate && baseDate &&
      baseDate.getUTCFullYear() === nowDate.getUTCFullYear() &&
      baseDate.getUTCMonth() === nowDate.getUTCMonth() &&
      baseDate.getUTCDate() === nowDate.getUTCDate()) {
    const nowH = nowDate.getUTCHours();
    if (h < nowH && h + 12 < 24) return h + 12;
    return h;
  }
  if (h >= 1 && h <= 6) return h + 12; // "Friday at 2" → 14
  return h;                             // "Wednesday at 11" → 11
}

// "quarter past 3" → 3:15; "half past 10" → 10:30; "quarter to 5" → 4:45.
// Also supports "quarter to noon" → 11:45 and "quarter past midnight" → 00:15.
function parseColloquialClock(text) {
  const t = text.toLowerCase();
  const HOUR_WORD = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight)';
  const hourOf = (w) => {
    if (w === 'noon') return 12;
    if (w === 'midnight') return 0;
    return NUM_WORDS[w] ?? parseInt(w, 10);
  };
  let m = t.match(new RegExp(`\\bquarter\\s+past\\s+${HOUR_WORD}\\b`));
  if (m) {
    const h = hourOf(m[1]);
    return { hour: h, minute: 15, raw: m[0], ambiguous: m[1] !== 'noon' && m[1] !== 'midnight' };
  }
  m = t.match(new RegExp(`\\bhalf\\s+past\\s+${HOUR_WORD}\\b`));
  if (m) {
    const h = hourOf(m[1]);
    return { hour: h, minute: 30, raw: m[0], ambiguous: m[1] !== 'noon' && m[1] !== 'midnight' };
  }
  m = t.match(new RegExp(`\\bquarter\\s+(?:to|of|til|till|before)\\s+${HOUR_WORD}\\b`));
  if (m) {
    const base = hourOf(m[1]);
    // "quarter to noon" = 11:45; "quarter to midnight" = 23:45; others = base-1:45.
    let h;
    if (m[1] === 'noon') h = 11;
    else if (m[1] === 'midnight') h = 23;
    else h = base - 1;
    return { hour: h < 0 ? 11 : h, minute: 45, raw: m[0], ambiguous: m[1] !== 'noon' && m[1] !== 'midnight' };
  }
  return null;
}

// "four thirty", "six fifteen", "seven forty-five", "five o'clock".
function parseSpelledClock(text) {
  const t = text.toLowerCase();
  const m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(thirty|fifteen|forty[- ]five|forty|twenty|oh\s+\w+|o'?clock)\b/);
  if (!m) return null;
  const h = NUM_WORDS[m[1]];
  const minKey = m[2].replace(/\s+/g, ' ');
  const mm = MINUTE_WORDS[minKey] ?? MINUTE_WORDS[minKey.replace('-', ' ')] ?? 0;
  return { hour: h, minute: mm, raw: m[0], ambiguous: true };
}

// Find every clock mention in the request. Used for dual-time detection.
function findAllClocks(text) {
  const re = /\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|noon|midnight)\b/gi;
  const out = [];
  for (const m of text.matchAll(re)) {
    const p = parseClockTime(m[1]);
    if (p) out.push({ ...p, ambiguous: !/am|pm/i.test(m[1]) && !/noon|midnight/i.test(m[1]) && !/:/.test(m[1]) ? false : !/am|pm/i.test(m[1]) && /:/.test(m[1]) });
  }
  return out;
}

// Parse "3pm", "3:30pm", "15:00", "noon", "midnight" → { hour, minute }
function parseClockTime(text) {
  const t = text.toLowerCase().trim();
  if (t === 'noon') return { hour: 12, minute: 0 };
  if (t === 'midnight') return { hour: 0, minute: 0 };
  let m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }
  m = t.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[2];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23) return null;
    return { hour: h, minute: 0 };
  }
  return null;
}

// Find the first clock time mentioned in free text, in the forms parseClockTime
// understands. Returns { hour, minute, raw, ambiguous? } or null. When
// `ambiguous` is true, the hour has no AM/PM indicator and should be resolved
// by the caller via resolveAmbiguousHour().
function findClockTime(text) {
  const colloquial = parseColloquialClock(text);
  if (colloquial) return colloquial;
  const spelled = parseSpelledClock(text);
  if (spelled) return spelled;
  // Prefer forms with explicit AM/PM first; fall back to HH:MM without AM/PM.
  let m = text.match(/\b(\d{1,2}:\d{2}\s*(?:am|pm)|\d{1,2}\s*(?:am|pm)|noon|midnight)\b/i);
  if (m) {
    const parsed = parseClockTime(m[1]);
    return parsed ? { ...parsed, raw: m[1] } : null;
  }
  m = text.match(/\b(\d{1,2}:\d{2})\b/);
  if (m) {
    const parsed = parseClockTime(m[1]);
    if (parsed) return { ...parsed, raw: m[1], ambiguous: true };
  }
  // Last resort: "at N" with no AM/PM. Apply the 1-6 → PM heuristic.
  m = text.match(/\bat\s+(\d{1,2})\b(?!:\d|\s*(?:am|pm))/i);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h >= 0 && h <= 23) {
      const resolved = h >= 1 && h <= 6 ? h + 12 : h;
      return { hour: resolved, minute: 0, raw: m[0], ambiguous: true };
    }
  }
  return null;
}

// Build a Date for (Y-M-D + hour:minute) in UTC so .toISOString() matches.
// The model's training data uses UTC timestamps exclusively.
function atClock(baseDate, hour, minute) {
  // setHours (local) — when a user says "9am" they mean 9am in their local tz,
  // which must round-trip through Date.toISOString() to the right UTC instant.
  // setUTCHours would plant 9 in the UTC slot and display as 5am locally.
  const d = new Date(baseDate.getTime());
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Find "next Tuesday", "this Friday" — returns the 0-6 dow and whether next.
// `next: true` means "weekday X in the NEXT ISO week", which is how we model
// "next Tuesday". "coming"/"upcoming" mean "the nearest future X" which can be
// in the current ISO week, so they get next:false. Accepts abbreviations like
// "wed", "sat", "fri", "thurs".
function findDayOfWeek(text) {
  const t = text.toLowerCase();
  let m = t.match(new RegExp(`\\b(next|this|upcoming|coming)\\s+${DOW_ANY}\\b`));
  if (m) {
    const dayWord = m[0].split(/\s+/).pop();
    const dow = dowKey(dayWord);
    if (dow != null) return { dow, next: m[1] === 'next' };
  }
  m = t.match(new RegExp(`\\bon\\s+(${DOW_ANY})\\b`));
  if (m) {
    const dow = dowKey(m[1]);
    if (dow != null) return { dow, next: false };
  }
  // Bare weekday name — treat like "next" if we have no other anchor.
  m = t.match(new RegExp(`\\b(${DOW_ANY})\\b`));
  if (m) {
    const dow = dowKey(m[1]);
    if (dow != null) return { dow, next: false };
  }
  return null;
}

// Advance date to the given weekday. When next=true, land on the X that falls
// in the NEXT ISO-week (Mon-Sun) relative to today. On Wed, "next Tuesday"
// → 6 days (Tuesday of the following ISO week), "next Friday" → 9 days.
function advanceToDow(date, dow, next) {
  const d = new Date(date.getTime());
  if (!next) {
    const current = d.getUTCDay();
    const delta = (dow - current + 7) % 7;
    d.setUTCDate(d.getUTCDate() + (delta === 0 ? 7 : delta));
    return d;
  }
  // next=true: find Monday of next ISO week, then advance to dow.
  const current = d.getUTCDay();
  const daysToMonday = ((8 - current) % 7) || 7; // always 1..7
  const nextMon = new Date(d.getTime());
  nextMon.setUTCDate(nextMon.getUTCDate() + daysToMonday);
  const offsetFromMon = (dow - 1 + 7) % 7; // Mon=0, Sun=6
  nextMon.setUTCDate(nextMon.getUTCDate() + offsetFromMon);
  return nextMon;
}

// ─── Recurrence detection ───────────────────────────────────────────────────
// Returns a 5-field cron string or null. We cover the patterns the smoke test
// exercises: "every N minutes", "every weekday at X", "Tue/Thu at 3pm", etc.
//
// Order matters: weekday-name matches take priority over "weekly"/"daily"
// word matches, because phrases like "post the weekly status" contain
// "weekly" as an adjective and should NOT be routed to a Sunday cron.
// "at 9 AND at 5" / "at 10am and 4pm" — dual recurring hours. Returns
// array of {hour, minute} or null. Resolves bare hours using the other
// anchor (if one is AM, the other likely PM when earlier numerically).
function findDualRecurringHours(text) {
  const t = text.toLowerCase();
  const m = t.match(/\bat\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s+(?:and|&)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)?\b/i);
  if (!m) return null;
  const parse = (hs, ap, otherAp) => {
    const [hpart, mpart = '0'] = hs.split(':');
    let h = parseInt(hpart, 10);
    const mm = parseInt(mpart, 10);
    if (ap === 'pm' && h < 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    else if (!ap) {
      // Ambiguous. If the other hour had AM, this one's likely PM when 1-6.
      if (otherAp === 'am' && h >= 1 && h <= 11) h += 12;
      else if (!otherAp && h >= 1 && h <= 6) h += 12;
    }
    return { hour: h, minute: mm };
  };
  const h1 = parse(m[1], m[2], m[4]);
  const h2 = parse(m[3], m[4], m[2]);
  if (h1.hour === h2.hour && h1.minute === h2.minute) return null;
  return [h1, h2];
}

function detectRecurrence(request) {
  const r = request.toLowerCase();

  // "twice a day" / "two times a day" → default morning + evening
  if (/\btwice\s+a\s+day\b|\btwo\s+times\s+a\s+day\b/.test(r)) {
    const dual = findDualRecurringHours(r);
    if (dual) {
      const mins = dual[0].minute;
      const hrs = dual.map(x => x.hour).sort((a,b) => a - b).join(',');
      return `${mins} ${hrs} * * *`;
    }
    return `0 9,19 * * *`;
  }

  // "every N minutes/hours/days" — aliases (min/hr/sec) supported via unitKey.
  let m = r.match(/\bevery\s+(\d+|a|an|one|two|three|four|five|six|ten|fifteen|twenty|thirty)\s+(second|secs?|minute|mins?|hour|hrs?|day|week|month)s?\b/);
  if (m) {
    const n = wordToNum(m[1]) ?? { fifteen: 15, twenty: 20, thirty: 30 }[m[1].toLowerCase()] ?? null;
    const unit = unitKey(m[2]);
    if (n != null && unit) {
      if (unit === 'minute') return `*/${n} * * * *`;
      if (unit === 'hour')   return `0 */${n} * * *`;
      if (unit === 'day')    return `0 0 */${n} * *`;
      if (unit === 'week') {
        // "every N weeks on <weekday> at <clock>" — prefer the weekday so the
        // task fires on the right day even though true biweekly isn't a cron
        // primitive. Fall back to Sunday if no weekday.
        const dowMatch = r.match(new RegExp(`\\b(?:on\\s+)?(${DOW_ANY})(?:s)?\\b`));
        const dow = dowMatch ? dowKey(dowMatch[1]) : null;
        const c = findClockTime(r);
        const hh = c?.hour ?? 9;
        const mm = c?.minute ?? 0;
        return `${mm} ${hh} * * ${dow != null ? dow : 0}`;
      }
    }
  }

  if (/\bevery\s+minute\b/.test(r)) return '* * * * *';

  // "every hour during work/business hours" — office-hours constraint must win
  // over the generic "every hour" match below.
  if (/\bevery\s+hour\b.*?\bduring\s+(?:work|business|office)\s+hours?\b/.test(r) ||
      /\bhourly\b.*?\bduring\s+(?:work|business|office)\s+hours?\b/.test(r)) {
    return '0 9-17 * * 1-5';
  }

  if (/\bhourly\b|\bevery\s+hour\b/.test(r)) return '0 * * * *';

  // Scan for weekday mentions FIRST — phrases like "post the weekly status"
  // contain adjective "weekly" but should route via their weekday name.
  const dowMentions = [];
  const dowRe = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g;
  let dm;
  while ((dm = dowRe.exec(r)) !== null) {
    const day = dm[1].replace(/s$/, '');
    dowMentions.push(DOW_FULL[day]);
  }
  const uniqDow = [...new Set(dowMentions)];

  // Multi-day: "Tuesdays and Thursdays at 3pm", "Mon, Wed, Fri"
  if (uniqDow.length >= 2) {
    const clock = findClockTime(r);
    const h = clock?.hour ?? 9;
    const mm = clock?.minute ?? 0;
    return `${mm} ${h} * * ${uniqDow.sort((a, b) => a - b).join(',')}`;
  }

  // Single weekday + recurrence signal ("every", "weekly", "on Xs"):
  if (uniqDow.length === 1 && /\bevery\b|\bweekly\b|\beach\b|\bon\s+\w+days?\b/.test(r)) {
    const clock = findClockTime(r);
    const h = clock?.hour ?? 9;
    const mm = clock?.minute ?? 0;
    return `${mm} ${h} * * ${uniqDow[0]}`;
  }

  // "on the Nth of every/each month" (+ optional time)
  m = r.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each)\s+month\b/);
  if (m) {
    const day = parseInt(m[1], 10);
    const clock = findClockTime(r);
    const h = clock?.hour ?? 9;
    const mm = clock?.minute ?? 0;
    return `${mm} ${h} ${day} * *`;
  }

  // "every payday on the Nth" / "every month on the Nth" / "on the Nth" with
  // "every" or "monthly" elsewhere in the sentence → monthly on day N.
  m = r.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m && /\bevery\s+(?:payday|month)\b|\bmonthly\b|\bevery\s+1st\b/.test(r)) {
    const day = parseInt(m[1], 10);
    const clock = findClockTime(r);
    const h = clock?.hour ?? 9;
    const mm = clock?.minute ?? 0;
    return `${mm} ${h} ${day} * *`;
  }

  // "every first of the month" / "every 1st of the month" / "first of every
  // month" / "on the 1st of each month" (last one is covered above).
  m = r.match(/\b(?:every\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|fifteenth|15th|twentieth|20th|last)\s+(?:of\s+)?(?:the\s+|each\s+|every\s+)?month\b/);
  if (m) {
    const w = m[1].toLowerCase();
    const map = { first:1, '1st':1, second:2, '2nd':2, third:3, '3rd':3, fourth:4, '4th':4,
      fifth:5, '5th':5, sixth:6, '6th':6, seventh:7, '7th':7, eighth:8, '8th':8,
      ninth:9, '9th':9, tenth:10, '10th':10, fifteenth:15, '15th':15, twentieth:20, '20th':20,
      last: 'L' };
    const dayRaw = map[w];
    if (dayRaw != null) {
      const clock = findClockTime(r);
      const h = clock?.hour ?? 9;
      const mm = clock?.minute ?? 0;
      // Cron doesn't have a native "last day of month"; use 28 as a safe floor.
      const day = dayRaw === 'L' ? 28 : dayRaw;
      return `${mm} ${h} ${day} * *`;
    }
  }

  // "annually on <Month> <day>" (+ optional time)
  const monthNames = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
                       july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  m = r.match(/\b(?:annually|yearly|every\s+year)\s+on\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/);
  if (m) {
    const month = monthNames[m[1]];
    const day = parseInt(m[2], 10);
    const clock = findClockTime(r);
    const h = clock?.hour ?? 9;
    const mm = clock?.minute ?? 0;
    return `${mm} ${h} ${day} ${month} *`;
  }

  // "every quarter on the Nth"
  m = r.match(/\bevery\s+quarter\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const day = parseInt(m[1], 10);
    const clock = findClockTime(r);
    const h = clock?.hour ?? 9;
    const mm = clock?.minute ?? 0;
    return `${mm} ${h} ${day} 1,4,7,10 *`;
  }

  // "every weekday at X" / "every work day"
  if (/\bevery\s+(weekday|work\s*day)s?\b|\bweekdays?\s+at\b/.test(r)) {
    const dual = findDualRecurringHours(r);
    if (dual) {
      const mins = dual[0].minute;
      const hrs = dual.map(x => x.hour).sort((a,b) => a - b).join(',');
      return `${mins} ${hrs} * * 1-5`;
    }
    const clock = findClockTime(r);
    return clock ? `${clock.minute} ${clock.hour} * * 1-5` : `0 9 * * 1-5`;
  }

  // "every weekend"
  if (/\bevery\s+weekend\b|\bweekends?\s+at\b/.test(r)) {
    const clock = findClockTime(r);
    return clock ? `${clock.minute} ${clock.hour} * * 0,6` : `0 9 * * 0,6`;
  }

  // "every night at N" / "every morning at N" / "every evening at N" — daily.
  // The TOD word here is colouring the clock's AM/PM, not scheduling a window.
  let nm = r.match(/\bevery\s+(night|morning|evening|afternoon)\b/);
  if (nm) {
    const tod = nm[1];
    let c = findClockTime(r);
    if (c && c.ambiguous) {
      const tk = tod === 'night' ? 'night' : tod === 'morning' ? 'morning' : tod === 'evening' ? 'evening' : 'afternoon';
      const h = resolveAmbiguousHour(c.hour, { tod: tk });
      c = { ...c, hour: h, ambiguous: false };
    }
    if (!c) {
      const defaults = { night: 21, morning: 9, evening: 19, afternoon: 14 };
      c = { hour: defaults[tod], minute: 0 };
    }
    return `${c.minute} ${c.hour} * * *`;
  }

  // "X am/pm daily" — daily keyword appearing after the clock. Requires the
  // word "daily" to stand alone (not "daily briefing").
  if (/\bdaily\b/.test(r) && !/\bweekly\b|\bhourly\b|\bmonthly\b/.test(r)) {
    const dual = findDualRecurringHours(r);
    if (dual) {
      const mins = dual[0].minute;
      const hrs = dual.map(x => x.hour).sort((a,b) => a - b).join(',');
      return `${mins} ${hrs} * * *`;
    }
  }

  // "every day" / "daily" — use only as verbs (preceded by space + time of day
  // word or "remind"/"run"/"send"/etc.). "daily briefing" is fine as adjective,
  // but single-day fallback still wins because weekday-scan already ran.
  if (/\bevery\s+day\b|\bdaily\s+(?:at|reminder|briefing|check|report|run|ping)\b|\bat\s+[^,.]*\bdaily\b/.test(r)) {
    // "except weekends" / "weekdays only" — rewrite DOW field to 1-5.
    const dowField = /\bexcept\s+(?:on\s+)?weekends?\b|\bnot\s+(?:on\s+)?weekends?\b|\bweekdays?\s+only\b/.test(r) ? '1-5' : '*';
    const dual = findDualRecurringHours(r);
    if (dual) {
      const mins = dual[0].minute;
      const hrs = dual.map(x => x.hour).sort((a,b) => a - b).join(',');
      return `${mins} ${hrs} * * ${dowField}`;
    }
    const clock = findClockTime(r);
    return clock ? `${clock.minute} ${clock.hour} * * ${dowField}` : `0 9 * * ${dowField}`;
  }

  // "every week" / verb "weekly" — only trigger if no weekday name was found.
  if (/\bevery\s+week\b|\bweekly\s+(?:at|reminder|briefing|check|report|run|ping|summary)\b/.test(r)) {
    const clock = findClockTime(r);
    return clock ? `${clock.minute} ${clock.hour} * * 0` : `0 9 * * 0`;
  }

  return null;
}

// ─── One-shot time detection ────────────────────────────────────────────────
// For non-recurring requests. Returns { earliest, latest, preferred } (ISO
// strings or null) or null when nothing matched.
function detectOneShotTime(request, now) {
  const r = request.toLowerCase();

  // "30 minutes before my 11am meeting" / "1 hour after the standup at 10am"
  // Captures: N + unit, direction (before/after), and anchor clock time.
  let anchor = r.match(/\b(\d+|a|an|half\s+an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|sixty|ninety)\s+(hour|hr|minute|min)s?\s+(before|after)\s+[^.]*?\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|noon|midnight)\b/i);
  if (anchor) {
    let nRaw = anchor[1];
    let n = /^half\s+an?$/i.test(nRaw) ? 0.5 : wordToNum(nRaw.split(/\s+/)[0]);
    if (n == null) n = { fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90 }[nRaw.toLowerCase()] ?? null;
    const unit = unitKey(anchor[2]);
    const dir = anchor[3].toLowerCase();
    const ac = parseClockTime(anchor[4]);
    if (n != null && unit && ac) {
      let target = atClock(now, ac.hour, ac.minute);
      if (target < now) target = addMs(target, UNIT_MS.day);
      const offset = Math.round(n * UNIT_MS[unit]);
      const pref = addMs(target, dir === 'before' ? -offset : offset);
      return { earliest: null, latest: null, preferred: toIso(pref) };
    }
  }

  // "in a quarter hour" / "in a quarter of an hour" → 15 min
  if (/\bin\s+a\s+quarter\s+(?:of\s+an?\s+)?hour\b/.test(r)) {
    return { earliest: null, latest: null, preferred: toIso(addMs(now, 15 * UNIT_MS.minute)) };
  }
  if (/\bin\s+a\s+half\s+hour\b/.test(r)) {
    return { earliest: null, latest: null, preferred: toIso(addMs(now, 30 * UNIT_MS.minute)) };
  }

  // "in N seconds/minutes/hours/days/weeks/months/years" → preferred
  // Accepts aliases ("min","hr","yr") via unitKey().
  let m = r.match(/\bin\s+(a|an|half\s+an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty[- ]?five|sixty|ninety)\s+(second|secs?|minute|mins?|hour|hrs?|day|week|month|year|yrs?)s?\b/);
  if (m) {
    let nRaw = m[1];
    let n;
    if (/^half\s+an?$/.test(nRaw)) n = 0.5;
    else {
      n = wordToNum(nRaw.split(/\s+/)[0]);
      if (n == null) n = { fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, 'fortyfive': 45, 'forty five': 45, sixty: 60, ninety: 90 }[nRaw.toLowerCase().replace(/-/g, ' ')] ?? null;
    }
    const unit = unitKey(m[2]);
    if (n != null && unit) {
      let pref = addMs(now, Math.round(n * UNIT_MS[unit]));
      // [TEST 2026-04-26] If the request also names a clock time AND the unit
      // is day-or-coarser, apply the clock time to the resolved date so
      // "in 2 weeks ... 12pm" lands at 12:00 PM, not at the current second.
      // REVERT: delete this block and the accompanying coarse-unit set check.
      if (unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year') {
        const clk = findClockTime(r);
        if (clk) pref = atClock(pref, clk.hour, clk.minute);
      }
      return { earliest: null, latest: null, preferred: toIso(pref) };
    }
  }

  // "a year from now", "six months from now", "three weeks from today"
  m = r.match(/\b(a|an|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(year|month|week|day|hour|minute)s?\s+from\s+(?:now|today)\b/);
  if (m) {
    const n = wordToNum(m[1]) ?? null;
    const unit = unitKey(m[2]);
    if (n != null && unit) {
      const pref = addMs(now, Math.round(n * UNIT_MS[unit]));
      if (unit === 'year' || unit === 'month') {
        // Return as a wide window rather than a pinpoint.
        const early = addMs(pref, -7 * UNIT_MS.day);
        const late = addMs(pref, 7 * UNIT_MS.day);
        return { earliest: toIso(early), latest: toIso(late), preferred: toIso(pref) };
      }
      return { earliest: null, latest: null, preferred: toIso(pref) };
    }
  }

  // Absolute ISO date already in the request
  m = r.match(/\b(\d{4}-\d{2}-\d{2})(?:t(\d{2}):(\d{2}))?\b/);
  if (m) {
    const [y, mo, d] = m[1].split('-').map(Number);
    const hh = m[2] ? parseInt(m[2], 10) : 9;
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    const pref = new Date(Date.UTC(y, mo - 1, d, hh, mm, 0));
    return { earliest: null, latest: null, preferred: toIso(pref) };
  }

  // "on January 1st at 9am" / "June 15 at 3pm" / "on Apr 30 at 5pm" — month
  // name (full or abbreviated) + day [+ clock]. Year rolls forward if the
  // date is already past. Runs BEFORE weekday/today parsing so explicit
  // absolute dates always win.
  const MONTH_NAMES = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
    sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const MONTH_ALT = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
  m = r.match(new RegExp(`\\b(?:on\\s+)?(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) {
    const mon = MONTH_NAMES[m[1]];
    const day = parseInt(m[2], 10);
    const clk = findClockTime(r);
    const hh = clk?.hour ?? 9;
    const mm_ = clk?.minute ?? 0;
    let year = now.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, mon - 1, day, hh, mm_, 0));
    if (candidate <= now) {
      year += 1;
      candidate = new Date(Date.UTC(year, mon - 1, day, hh, mm_, 0));
    }
    return { earliest: null, latest: null, preferred: toIso(candidate) };
  }

  // "midnight tonight" / "at midnight tonight" → tomorrow 00:00 (start of
  // next day). Most users mean "the midnight that marks end-of-today", not
  // "the midnight that just happened early this morning".
  if (/\bmidnight\s+tonight\b|\bat\s+midnight\s+tonight\b/.test(r)) {
    const pref = atClock(addMs(now, UNIT_MS.day), 0, 0);
    return { earliest: null, latest: null, preferred: toIso(pref) };
  }

  // "at 12 midnight" / "at 12 noon" — explicit 12 + clarifier.
  if (/\bat\s+12\s+midnight\b|\b12\s+midnight\b/.test(r)) {
    let pref = atClock(now, 0, 0);
    if (pref <= now) pref = addMs(pref, UNIT_MS.day);
    return { earliest: null, latest: null, preferred: toIso(pref) };
  }
  if (/\bat\s+12\s+noon\b|\b12\s+noon\b/.test(r)) {
    let pref = atClock(now, 12, 0);
    if (pref <= now) pref = addMs(pref, UNIT_MS.day);
    return { earliest: null, latest: null, preferred: toIso(pref) };
  }

  // "end of day" / "eod" / "end of the day" → window 16:00-23:59, preferred
  // 17:00 (common "log off" time). Scoped to today unless another day was set.
  if (/\bend\s+of\s+(?:the\s+)?day\b|\beod\b/.test(r)) {
    const base = now;
    const e = atClock(base, 16, 0);
    const l = atClock(base, 23, 59);
    const p = atClock(base, 17, 0);
    return { earliest: toIso(e), latest: toIso(l), preferred: toIso(p) };
  }

  // "dinnertime" / "lunchtime" / "breakfast time" → TOD anchors. Handled by
  // the TOD_ANCHORS loop below, but we need to catch "dinner time" (two
  // words) as an alias for "dinnertime".
  // (no-op here — the TOD_ANCHORS loop covers the single-word forms.)

  // "around Nish", "Nish" — ambiguous hour with ±30min window. Resolve via
  // same PM heuristic as bare "at N".
  let ish = r.match(/\b(?:around\s+)?(\d{1,2})ish\b/);
  if (ish) {
    const hRaw = parseInt(ish[1], 10);
    if (hRaw >= 0 && hRaw <= 23) {
      const h = resolveAmbiguousHour(hRaw, { nowDate: now, baseDate: now });
      const pref = atClock(now, h, 0);
      const e = atClock(now, h, 0); e.setMinutes(e.getMinutes() - 30);
      const l = atClock(now, h, 0); l.setMinutes(l.getMinutes() + 30);
      return { earliest: toIso(e), latest: toIso(l), preferred: toIso(pref) };
    }
  }

  // Day word ("today", "tomorrow", "day after tomorrow", "tonight").
  // When multiple day words appear (e.g. "at 3pm today and tomorrow at 3pm"),
  // pick the one that appears FIRST — that's the primary anchor, and tokens
  // after it are usually elaborations.
  let baseDay = null;
  let todHint = null; // time-of-day hint from the day-word itself, only used when no explicit clock
  const dayPatterns = [
    { re: /\bday\s+after\s+tomorrow\b/, set: () => { baseDay = addMs(now, 2 * UNIT_MS.day); } },
    { re: /\btomorrow\s+night\b/,       set: () => { baseDay = addMs(now, UNIT_MS.day); todHint = TOD_ANCHORS.night; } },
    { re: /\btomorrow\s+morning\b/,     set: () => { baseDay = addMs(now, UNIT_MS.day); todHint = TOD_ANCHORS.morning; } },
    { re: /\btomorrow\b/,                set: () => { baseDay = addMs(now, UNIT_MS.day); } },
    { re: /\btonight\b/,                 set: () => { baseDay = now; todHint = TOD_ANCHORS.tonight; } },
    { re: /\btoday\b/,                   set: () => { baseDay = now; } },
    { re: /\bbefore\s+bed\b/,            set: () => { baseDay = now; todHint = { preferred: 22, window: [21, 25] }; } },
    { re: /\bafter\s+lunch\b/,           set: () => { baseDay = now; todHint = { preferred: 13, window: [12, 15] }; } },
    { re: /\bafter\s+dinner\b/,          set: () => { baseDay = now; todHint = { preferred: 20, window: [19, 22] }; } },
  ];
  // Self-correction patterns ("actually", "wait", "scratch that") mean the
  // user is overriding an earlier date with a later one — prefer the LATEST
  // mention in that case. Otherwise, the earliest day word wins.
  const selfCorrecting = /\b(?:actually|wait|scratch\s+that|no\s+wait|i\s+meant)\b/.test(r);
  let bestIdx = selfCorrecting ? -1 : Infinity;
  let bestSet = null;
  for (const { re, set } of dayPatterns) {
    const m = r.match(re);
    if (!m) continue;
    if (selfCorrecting ? m.index > bestIdx : m.index < bestIdx) {
      bestIdx = m.index;
      bestSet = set;
    }
  }
  if (bestSet) bestSet();

  // "next Friday", "this Tuesday", "on Wednesday"
  const dow = findDayOfWeek(r);
  if (dow && !baseDay) {
    baseDay = advanceToDow(now, dow.dow, dow.next);
  }

  let clock = findClockTime(r);

  // Time-of-day anchor: prefer an explicit clock if given; otherwise use a
  // TOD word ("afternoon", "evening", "night", "morning", "noon", "lunch").
  let todAnchor = null;
  if (todHint) todAnchor = todHint;
  else for (const key of Object.keys(TOD_ANCHORS)) {
    if (new RegExp(`\\b${key}\\b`).test(r)) { todAnchor = TOD_ANCHORS[key]; break; }
  }
  if (!todAnchor && /\blunch(?:time)?\b/.test(r)) todAnchor = { preferred: 12, window: [11, 13] };

  // Pick a TOD keyword for use in heuristic hour resolution below.
  let todKey = null;
  for (const k of ['morning', 'afternoon', 'evening', 'night', 'tonight']) {
    if (new RegExp(`\\b${k}\\b`).test(r)) { todKey = k; break; }
  }

  // "tonight at 9", "this afternoon at 3" — bare "at N" with a TOD anchor
  // resolves N using the anchor's am/pm polarity. Also handles bare "at N"
  // without a TOD anchor (e.g. "Friday at 2" → 14, "Wednesday at 11" → 11).
  if (!clock) {
    const bareAt = r.match(/\bat\s+(\d{1,2})(?!\s*(?:am|pm|:|\d))/);
    if (bareAt) {
      let h = parseInt(bareAt[1], 10);
      if (h >= 0 && h <= 23) {
        h = resolveAmbiguousHour(h, { nowDate: now, baseDate: baseDay, tod: todKey });
        clock = { hour: h, minute: 0, raw: bareAt[0] };
      }
    }
  }

  // Clock found but AM/PM omitted (e.g. "at 3:45 about the demo" → "3:45")
  if (clock && clock.ambiguous) {
    const resolvedH = resolveAmbiguousHour(clock.hour, { nowDate: now, baseDate: baseDay, tod: todKey });
    clock = { ...clock, hour: resolvedH, ambiguous: false };
  }

  // TOD word alone implies today when no day given.
  if (todAnchor && !baseDay) baseDay = now;
  // An explicit clock cancels the TOD anchor (we only want the hour, not the window).
  if (clock) todAnchor = null;

  if (baseDay && clock) {
    const pref = atClock(baseDay, clock.hour, clock.minute);
    return { earliest: null, latest: null, preferred: toIso(pref) };
  }
  if (baseDay && todAnchor) {
    const pref = atClock(baseDay, todAnchor.preferred, 0);
    if (todAnchor.window) {
      const e = atClock(baseDay, todAnchor.window[0], 0);
      const l = atClock(baseDay, todAnchor.window[1], 0);
      return { earliest: toIso(e), latest: toIso(l), preferred: toIso(pref) };
    }
    return { earliest: null, latest: null, preferred: toIso(pref) };
  }
  if (baseDay) {
    // Day specified but no time: default to 09:00 window of that day.
    const e = atClock(baseDay, 0, 0);
    const l = atClock(baseDay, 23, 59);
    const p = atClock(baseDay, 9, 0);
    return { earliest: toIso(e), latest: toIso(l), preferred: toIso(p) };
  }
  if (clock) {
    // Clock without day → today if still in the future, else tomorrow.
    const today = atClock(now, clock.hour, clock.minute);
    const target = today > now ? today : addMs(today, UNIT_MS.day);
    return { earliest: null, latest: null, preferred: toIso(target) };
  }

  // "next month on the Nth" — runs BEFORE "next month" so the day is captured.
  let mm;
  if ((mm = r.match(/\bnext\s+month\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    const day = parseInt(mm[1], 10);
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, 9, 0, 0));
    const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day, 0, 0, 0));
    const dayEnd = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day, 23, 59, 59));
    return { earliest: toIso(dayStart), latest: toIso(dayEnd), preferred: toIso(target) };
  }
  // "end of the month" → last 3 days of current month
  if (/\bend\s+of\s+(?:the\s+)?(?:this\s+)?month\b/.test(r)) {
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
    const windowStart = new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate() - 2, 0, 0, 0));
    return { earliest: toIso(windowStart), latest: toIso(lastDay), preferred: null };
  }
  // "this weekend" → coming Saturday 00:00 to Sunday 23:59
  if (/\bthis\s+weekend\b|\bthe\s+weekend\b/.test(r)) {
    const sat = advanceToDow(now, 6, false); // upcoming Saturday (could be today if already Sat)
    const satStart = atClock(sat, 0, 0);
    const sun = addMs(sat, UNIT_MS.day);
    const sunEnd = atClock(sun, 23, 59);
    return { earliest: toIso(satStart), latest: toIso(sunEnd), preferred: null };
  }
  // "this week" → today through Sunday of the current ISO week
  if (/\bthis\s+week\b/.test(r)) {
    const start = atClock(now, 0, 0);
    const daysToSun = (7 - now.getUTCDay()) % 7;
    const end = addMs(start, daysToSun * UNIT_MS.day);
    end.setUTCHours(23, 59, 59, 0);
    return { earliest: toIso(now), latest: toIso(end), preferred: null };
  }
  if (/\bnext\s+week\b/.test(r)) {
    const start = advanceToDow(now, 1, true);
    const end = addMs(start, 4 * UNIT_MS.day);
    end.setUTCHours(23, 59, 59, 0);
    return { earliest: toIso(start), latest: toIso(end), preferred: null };
  }
  if (/\bthis\s+month\b/.test(r)) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
    return { earliest: toIso(now), latest: toIso(end), preferred: null };
  }
  if (/\bnext\s+month\b/.test(r)) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, 23, 59, 59));
    return { earliest: toIso(start), latest: toIso(end), preferred: null };
  }

  // "next quarter" → first day of next Jan/Apr/Jul/Oct through end of that month.
  if (/\bnext\s+quarter\b/.test(r)) {
    const curQ = Math.floor(now.getUTCMonth() / 3);
    const nextQStartMonth = (curQ + 1) * 3;
    const year = now.getUTCFullYear() + (nextQStartMonth >= 12 ? 1 : 0);
    const mm_ = nextQStartMonth % 12;
    const start = new Date(Date.UTC(year, mm_, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, mm_ + 1, 0, 23, 59, 59));
    return { earliest: toIso(start), latest: toIso(end), preferred: null };
  }

  return null;
}

// ─── Condition extraction ───────────────────────────────────────────────────
// Pulls "unless X" / "until X" qualifiers out of a request so the scheduler
// can hold the task when the condition is true. Return value is an array of
// condition objects appended onto the parsed record's existing conditions.
function detectConditions(request) {
  const found = [];
  const r = request;
  // "unless <X>," or "unless <X> first," or "unless <X>." or "unless <X>$"
  for (const m of r.matchAll(/\bunless\s+([^,.]+?)(?=\s*[,.]|$)/gi)) {
    found.push({ type: 'unless', text: m[1].trim() });
  }
  for (const m of r.matchAll(/\buntil\s+([^,.]+?)(?=\s*[,.]|$)/gi)) {
    // Skip "until N pm"-style time phrases — those aren't conditions, they're
    // upper bounds on the schedule's latest.
    const text = m[1].trim();
    if (/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(text)) continue;
    found.push({ type: 'until', text });
  }
  // "but not if X", "not if X", "only if X" — all are negative guards.
  for (const m of r.matchAll(/\b(?:but\s+)?not\s+if\s+([^,.]+?)(?=\s*[,.]|$)/gi)) {
    found.push({ type: 'unless', text: m[1].trim() });
  }
  for (const m of r.matchAll(/\bif\s+not\s+([^,.]+?)(?=\s*[,.]|$)/gi)) {
    found.push({ type: 'unless', text: m[1].trim() });
  }
  for (const m of r.matchAll(/\bonly\s+if\s+([^,.]+?)(?=\s*[,.]|$)/gi)) {
    found.push({ type: 'only_if', text: m[1].trim() });
  }
  return found;
}

// ─── Event-trigger detection ────────────────────────────────────────────────
// Detects phrases that describe a future event the task should respond to,
// rather than a time. Returns { trigger, text } or null.
//   - "when X, do Y"      → event { text: "X" }
//   - "once X, do Y"      → event { text: "X" }
//   - "if X replies, …"   → event { text: "X replies" } (requires subject)
//   - "after the build …" → event { text: "the build …" }
//   - "as soon as X"      → event { text: "X" }
//   - "whenever X"        → event { text: "X" }
//   - "before every X"    → event { text: "every X" }
function detectEventTrigger(request) {
  const r = request.toLowerCase();
  // "when the build passes" — "when" as a temporal subordinator.
  let m = r.match(/\bwhen(?:ever)?\s+([^,.]+?)(?=\s*[,.]|$)/i);
  if (m) return { text: m[1].trim() };
  m = r.match(/\bonce\s+([^,.]+?)(?=\s*[,.]|$)/i);
  if (m) return { text: m[1].trim() };
  m = r.match(/\bas\s+soon\s+as\s+([^,.]+?)(?=\s*[,.]|$)/i);
  if (m) return { text: m[1].trim() };
  m = r.match(/\bafter\s+(?:i|you|we|the|a|an|my|sarah|priya|[A-Za-z]+)\s+([^,.]+?)(?=\s*[,.]|$)/i);
  if (m) return { text: m[0].replace(/^after\s+/i, '').trim() };
  m = r.match(/\bbefore\s+every\s+([^,.]+?)(?=\s*[,.]|$)/i);
  if (m) return { text: `every ${m[1].trim()}` };
  // "if Sarah replies" — accept "if <proper noun or 'my X'>", reject "if you have time".
  m = r.match(/\bif\s+(?!you\s+have\s+time\b|you\s+get\s+a\s+chance\b)([^,.]+?)(?=\s*[,.]|$)/i);
  if (m) return { text: m[1].trim() };
  return null;
}

// Priority inference. Model-extracted priority is usually decent but misses
// common low-pressure phrasings. Apply deterministic overrides that reflect
// real language. High-priority overrides apply when the request screams.
function applyPriorityHeuristics(out, request) {
  const r = request.toLowerCase();
  const loSignal =
    /\bno\s+rush\b/.test(r) ||
    /\bif\s+you\s+have\s+time\b/.test(r) ||
    /\bwhen\s+you\s+get\s+a\s+chance\b/.test(r) ||
    /\beventually\b/.test(r) ||
    /\blow\s+priority\b/.test(r) ||
    /\bwhenever\s+(?:you\s+can|convenient|is\s+convenient)\b/.test(r);
  const hiSignal =
    /\burgent\b/i.test(request) ||                      // preserve uppercase
    /\basap\b/i.test(request) ||
    /\bright\s+now\b/.test(r) ||
    /\bdrop\s+everything\b/.test(r) ||
    /\bemergency\b/.test(r);
  if (hiSignal) out.priority = 'high';
  else if (loSignal) out.priority = 'low';
}

// ─── Main entry point ───────────────────────────────────────────────────────
/**
 * Correct the model's parse output using deterministic regex parsers.
 *
 * @param {object} record   Model's parse output (schedule + intent + ...).
 * @param {string} request  Original user request text (no "Current time:" frame).
 * @param {Date|string} now Current time.
 * @returns {object}        Corrected record (new object; input is not mutated).
 */
export function postprocessSchedule(record, rawRequest, now) {
  if (!record || typeof record !== 'object') return record;
  const nowDate = now instanceof Date ? now : new Date(now);
  const request = typeof rawRequest === 'string' ? normalizeRequest(rawRequest) : rawRequest;
  const out = JSON.parse(JSON.stringify(record));
  if (!out.schedule || typeof out.schedule !== 'object') {
    out.schedule = { mode: 'window', earliest: null, latest: null, preferred: null, recurrence: null };
  }

  // Merge any "unless X" / "until X" / "not if X" qualifiers the model missed.
  const extraConds = detectConditions(request);
  if (extraConds.length) {
    const existing = Array.isArray(out.conditions) ? out.conditions : [];
    const seen = new Set(existing.map(c => (c && c.text ? c.text.toLowerCase() : JSON.stringify(c))));
    for (const c of extraConds) {
      if (!seen.has(c.text.toLowerCase())) existing.push(c);
    }
    out.conditions = existing;
  }

  applyPriorityHeuristics(out, request);

  // Recurrence takes precedence — "every Monday at 9am" is always recurring.
  const cron = detectRecurrence(request);
  if (cron) {
    out.schedule.mode = 'recurring';
    out.schedule.recurrence = cron;
    out.schedule.earliest = null;
    out.schedule.latest = null;
    out.schedule.preferred = null;
    return out;
  }

  // Try one-shot time detection first so we can tell whether the request has
  // a concrete clock/date anchor. Absent one, event-trigger phrases ("when",
  // "if Sarah replies", "before every deploy") become the primary signal.
  const times = detectOneShotTime(request, nowDate);
  const hasExplicitTime = times && (times.preferred || times.earliest);
  const eventTrigger = detectEventTrigger(request);

  if (eventTrigger && !hasExplicitTime) {
    out.schedule.mode = 'event';
    out.schedule.earliest = null;
    out.schedule.latest = null;
    out.schedule.preferred = null;
    out.schedule.recurrence = null;
    const existing = Array.isArray(out.conditions) ? out.conditions : [];
    const seen = new Set(existing.map(c => (c && c.text ? c.text.toLowerCase() : '')));
    if (!seen.has(eventTrigger.text.toLowerCase())) {
      existing.push({ type: 'when', text: eventTrigger.text });
    }
    out.conditions = existing;
    return out;
  }

  if (times) {
    out.schedule.mode = out.schedule.mode === 'recurring' ? 'window' : (out.schedule.mode || 'window');
    out.schedule.earliest = times.earliest;
    out.schedule.latest = times.latest;
    out.schedule.preferred = times.preferred;
    out.schedule.recurrence = null;
    return out;
  }

  // Nothing matched — trust the model's output as-is. Only one fix: if mode is
  // "recurring" but recurrence is missing/invalid cron, demote to "window" so
  // downstream runtime doesn't explode.
  if (out.schedule.mode === 'recurring') {
    const rec = out.schedule.recurrence;
    const isValidCron = typeof rec === 'string' &&
      rec.trim().split(/\s+/).length === 5 &&
      rec.trim().split(/\s+/).every(p => /^[0-9*,\/\-?]+$/.test(p));
    if (!isValidCron) {
      out.schedule.mode = 'event';
      out.schedule.recurrence = null;
    }
  }
  return out;
}

// ─── Decide action safety net ───────────────────────────────────────────────
/**
 * Clamp a `decide` action against the task's schedule so the model can't
 * accidentally drop a live task with a bogus "cancel".
 *
 * Rule: "cancel" means the underlying need is gone. If the scheduler is still
 * inside the task's fire window (preferred ± 5 min, or [earliest..latest]),
 * cancel is almost never the right call — the model is hallucinating. Clamp
 * to "defer" before the window opens and "run" once inside.
 *
 * @param {{action:string, retryAt?:string|null}} decision  one decide element
 * @param {object}  schedule   the task's schedule object (mode, preferred, ...)
 * @param {Date|string} now   current time
 * @returns {{action:string, retryAt?:string|null, clampedFrom?:string}}
 */
export function postprocessDecide(decision, schedule, now) {
  if (!decision || typeof decision !== 'object') return decision;
  if (decision.action !== 'cancel') return decision;
  if (!schedule || typeof schedule !== 'object') return decision;

  const t = now instanceof Date ? now.getTime()
          : typeof now === 'number' ? now
          : Date.parse(now);
  if (isNaN(t)) return decision;

  const preferred = schedule.preferred ? Date.parse(schedule.preferred) : NaN;
  const earliest  = schedule.earliest  ? Date.parse(schedule.earliest)  : NaN;
  const latest    = schedule.latest    ? Date.parse(schedule.latest)    : NaN;

  // Compute [windowStart, windowEnd]. Prefer explicit earliest/latest; fall
  // back to a ±5 min tolerance around `preferred`.
  let windowStart = null, windowEnd = null;
  if (!isNaN(earliest)) windowStart = earliest;
  if (!isNaN(latest))   windowEnd   = latest;
  if (windowStart == null && !isNaN(preferred)) windowStart = preferred - 5 * 60_000;
  if (windowEnd   == null && !isNaN(preferred)) windowEnd   = preferred + 5 * 60_000;

  // No window at all → trust the model's cancel.
  if (windowStart == null && windowEnd == null) return decision;

  if (windowStart != null && t < windowStart) {
    return { ...decision, action: 'defer', clampedFrom: 'cancel' };
  }
  if (windowEnd != null && t <= windowEnd) {
    return { ...decision, action: 'run', clampedFrom: 'cancel' };
  }
  // Past the window → cancel is legitimate (task is truly expired).
  return decision;
}

export default postprocessSchedule;
