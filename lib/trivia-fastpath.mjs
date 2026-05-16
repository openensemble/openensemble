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
  const t = text.trim().toLowerCase()
    .replace(/[‘’']/g, "'")
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

export function executeTriviaIntent(intent, userId) {
  const tz = getUserTz(userId);
  const now = new Date();
  try {
    if (intent.kind === 'time') {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
      return { text: `It's ${s}.` };
    }
    if (intent.kind === 'date') {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now);
      return { text: `Today is ${s}.` };
    }
    if (intent.kind === 'day') {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).formatToParts(now);
      const weekday = parts.find(p => p.type === 'weekday')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day = parseInt(parts.find(p => p.type === 'day')?.value, 10);
      const v = day % 100;
      const suffix = ['th','st','nd','rd'][(v - 20) % 10] || ['th','st','nd','rd'][v] || 'th';
      return { text: `It's ${weekday}, ${month} ${day}${suffix}.` };
    }
  } catch {}
  return null;
}
