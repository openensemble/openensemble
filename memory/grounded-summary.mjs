/** Bounded, attributed excerpts. No generated prose becomes a memory fact. */
import { isOrchestrationEnvelope } from './relevance.mjs';

const PHATIC = /^(?:hi|hello|hey|thanks|thank you|ok|okay|great|cool|bye|you(?:'re| are) welcome)[\s!.]*$/i;
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const HEADER = '[Session excerpts]';
const MAX_CHARS = 480; // Fits the existing 500-character episode rendering cap.

function excerpt(text, budget) {
  const value = String(text || '').trim();
  if (JSON.stringify(value).length <= budget) return [value];
  // Keep a contiguous suffix of complete sentences. Combining the beginning
  // and end could revive an earlier success while skipping a later failure.
  const sentences = Array.from(segmenter.segment(value));
  let result = '';
  for (const sentence of sentences.reverse()) {
    const tail = value.slice(sentence.index).trim();
    if (JSON.stringify(tail).length > budget) break;
    result = tail;
  }
  return result ? [result] : [];
}

export function buildGroundedSummary(messages) {
  const groups = [];
  let current = null;
  for (const [index, message] of messages.entries()) {
    if (!['user', 'assistant'].includes(message.role)) continue;
    const text = String(message.text ?? message.content ?? '').trim();
    if (!text || isOrchestrationEnvelope({ text })) {
      if (message.role === 'user') current = null;
      continue;
    }
    if (message.role === 'user') {
      current = { user: { text, index }, replies: [] };
      groups.push(current);
    } else if (current) current.replies.push({ text, index });
  }
  const meaningful = groups.filter(g => !PHATIC.test(g.user.text)
    || g.replies.some(r => !PHATIC.test(r.text)));
  // An unanswered correction or cancellation may supersede an earlier result.
  if (!meaningful.at(-1)?.replies.length) return null;
  const kept = [];
  let used = HEADER.length + 1;
  for (const group of meaningful.reverse()) {
    if (!group.replies.length) continue;
    // Include the final assistant status with its request, or include neither.
    const reply = group.replies.at(-1);
    const remaining = MAX_CHARS - used;
    const userQuotes = excerpt(group.user.text, Math.min(170, Math.floor((remaining - 35) * .4)));
    if (!userQuotes.length) {
      if (!kept.length) return null;
      continue;
    }
    const userLine = `User said: ${userQuotes.map(q => JSON.stringify(q)).join(' … ')}`;
    const assistantQuotes = excerpt(reply.text, remaining - userLine.length - 19);
    if (!assistantQuotes.length) {
      // Do not fall back to an older success when the latest status cannot fit.
      if (!kept.length) return null;
      continue;
    }
    const assistantLine = `Assistant said: ${assistantQuotes.map(q => JSON.stringify(q)).join(' … ')}`;
    const text = `${userLine}\n${assistantLine}`;
    if (used + text.length + 1 > MAX_CHARS) continue;
    kept.push({ text, evidence: [
      { turn: group.user.index, role: 'user', quotes: userQuotes },
      { turn: reply.index, role: 'assistant', quotes: assistantQuotes },
    ] });
    used += text.length + 1;
    if (kept.length >= 2) break;
  }
  if (!kept.length) return null;
  kept.reverse();
  return { text: `${HEADER}\n${kept.map(x => x.text).join('\n')}`,
    evidence: kept.flatMap(x => x.evidence), format: 'quoted-exchanges-v1' };
}
