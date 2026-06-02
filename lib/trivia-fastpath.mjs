/**
 * Trivia fast-path — answers "what time/date/day is it" without an LLM.
 *
 * Strict regex set: only the bare forms match. Any trailing qualifier
 * ("in tokyo", "at noon", "tomorrow", "in UTC") fails the end-anchor and
 * falls through to the normal LLM/agent pipeline so disambiguation still
 * works for non-trivial clock questions.
 */

import { getUserTz } from './tutor-stats.mjs';

const PATTERNS = [
  /^what(?:'?s| is)?\s+(?:the\s+)?(time|date|day)\??$/,
  /^what(?:'?s| is)?\s+(?:the\s+)?(time|date|day)\s+is\s+it\??$/,
  /^what(?:'?s| is)?\s+(?:the\s+)?(time|date|day)\s+is\s+it\s+today\??$/,
  /^what(?:'?s| is)?\s+(?:the\s+)?(time|date|day)\s+today\??$/,
  /^what(?:'?s| is)?\s+today'?s?\s+(date|day)\??$/,
  /^what(?:'?s| is)?\s+the\s+(date|day)\s+today\??$/,
  /^what\s+day\s+of\s+the\s+week(?:\s+is\s+it)?\??$/,
  /^do\s+you\s+(?:know|have)\s+the\s+(time|date)\??$/,
];

export function classifyTriviaIntent(text) {
  if (typeof text !== 'string') return null;
  // Strip trailing sentence punctuation before matching — Faster-Whisper STT
  // emits "What time is it." with a period that would otherwise kill the
  // \??$ anchor in every pattern below.
  const t = text.trim().toLowerCase()
    .replace(/[‘’']/g, "'")
    .replace(/[.,!?]+$/, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  for (const re of PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    let kind = m[1] || 'day';
    if (re.source.includes('day of the week')) kind = 'day';
    return { kind };
  }
  return null;
}

// 0..59 → spoken English. Used to spell out clock minutes and ordinal days
// so TTS doesn't read "2:15" as "two colon fifteen" or "2nd" as "two N D".
const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS = ['', '', 'twenty','thirty','forty','fifty'];
function numToWords(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

// 1..31 day-of-month → ordinal in words ("first", "twenty-second", "thirty-first").
const ORDINAL_ONES = ['', 'first','second','third','fourth','fifth','sixth','seventh','eighth','ninth',
  'tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth',
  'twentieth'];
const ORDINAL_TENS_SUFFIX = { 0: 'tieth', 1: 'first', 2: 'second', 3: 'third', 4: 'fourth',
  5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth' };
function dayOrdinalWords(d) {
  if (d <= 20) return ORDINAL_ONES[d];
  const t = Math.floor(d / 10), o = d % 10;
  if (o === 0) return `${TENS[t].slice(0, -1)}tieth`;  // 30 → "thirtieth"
  return `${TENS[t]}-${ORDINAL_TENS_SUFFIX[o]}`;
}

function spokenTime(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value, 10);
  const ampm = parts.find(p => p.type === 'dayPeriod')?.value || '';
  // Periods between the letters give TTS a stronger "say as letters" hint
  // and read uniformly across Piper / KittenTTS / cloud voices.
  const ap = /am/i.test(ampm) ? 'A.M.' : 'P.M.';
  const hh = numToWords(hour);
  let mm;
  if (minute === 0) return `${hh} ${ap}`;
  if (minute < 10)  mm = `oh ${numToWords(minute)}`;
  else              mm = numToWords(minute);
  return `${hh} ${mm} ${ap}`;
}

/**
 * @param {{kind:string}} intent     returned by classifyTriviaIntent (time|date|day)
 * @param {string} userId
 * @param {{voice?: boolean}} [opts]   voice=true reformats numerals for TTS
 */
export function executeTriviaIntent(intent, userId, opts = {}) {
  const voice = !!opts.voice;
  const tz = getUserTz(userId);
  const now = new Date();
  try {
    if (intent.kind === 'time') {
      if (voice) return { text: `It's ${spokenTime(now, tz)}` };  // spokenTime ends in "A.M."/"P.M."
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
      return { text: `It's ${s}.` };
    }
    if (intent.kind === 'date') {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).formatToParts(now);
      const weekday = parts.find(p => p.type === 'weekday')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day = parseInt(parts.find(p => p.type === 'day')?.value, 10);
      const year = parts.find(p => p.type === 'year')?.value;
      if (voice) return { text: `Today is ${weekday}, ${month} ${dayOrdinalWords(day)}, ${year}.` };
      return { text: `Today is ${weekday}, ${month} ${day}, ${year}.` };
    }
    if (intent.kind === 'day') {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).formatToParts(now);
      const weekday = parts.find(p => p.type === 'weekday')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day = parseInt(parts.find(p => p.type === 'day')?.value, 10);
      if (voice) return { text: `It's ${weekday}, ${month} ${dayOrdinalWords(day)}.` };
      const v = day % 100;
      const suffix = ['th','st','nd','rd'][(v - 20) % 10] || ['th','st','nd','rd'][v] || 'th';
      return { text: `It's ${weekday}, ${month} ${day}${suffix}.` };
    }
  } catch {}
  return null;
}
