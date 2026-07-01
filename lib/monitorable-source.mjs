// @ts-check

const VAGUE_SOURCE_WORDS = new Set([
  'it', 'they', 'them', 'this', 'that', 'these', 'those', 'there',
  'thing', 'things', 'item', 'product', 'source', 'site', 'page',
  'server', 'service', 'system', 'status', 'one', 'stuff',
]);

function cleanLabel(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^[\s"'`([{]+|[\s"'`)\]}.,!?]+$/g, '')
    .replace(/^(?:the|a|an|my|our)\s+/i, '')
    .replace(/\s+(?:this|next|last)\s+(?:morning|afternoon|evening|week|month|year|season)$/i, '')
    .replace(/\s+(?:today|tonight|tomorrow|now|again|yet|please|pls)$/i, '')
    .replace(/\s+(?:back\s+)?(?:up|down|online|offline|available|in\s+stock|sold\s+out)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceKey(label) {
  return cleanLabel(label).toLowerCase()
    .replace(/[^a-z0-9@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function rejectReason(label) {
  const cleaned = cleanLabel(label);
  if (cleaned.length < 3) return 'too-short';
  if (cleaned.length > 100) return 'too-long';
  if (/\bseems?\s+to\s+be\b/i.test(cleaned)) return 'state-phrase';
  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 'empty';
  if (words.length > 8) return 'too-many-words';
  if (VAGUE_SOURCE_WORDS.has(words[0])) return 'vague-source';
  if (words.every(w => VAGUE_SOURCE_WORDS.has(w))) return 'vague-source';
  if (/^(?:is|are|was|were|do|does|did|has|have|will|can|could|should)\b/i.test(cleaned)) return 'question-fragment';
  return null;
}

function accept(label, kind = 'phrase') {
  const cleaned = cleanLabel(label);
  const reason = rejectReason(cleaned);
  if (reason) return null;
  const key = sourceKey(cleaned);
  if (!key) return null;
  return { ok: true, label: cleaned, key, kind };
}

export function extractMonitorableSource(userText) {
  const text = String(userText || '').trim();
  if (!text) return { ok: false, reason: 'empty', label: '', key: '' };

  const url = text.match(/https?:\/\/[^\s)"']+/i)?.[0];
  if (url) {
    try {
      const u = new URL(url);
      const label = `${u.hostname}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
      return { ok: true, label, key: sourceKey(label), kind: 'url' };
    } catch {
      return { ok: true, label: url, key: sourceKey(url), kind: 'url' };
    }
  }

  const handle = text.match(/@[a-z0-9_.-]{2,}/i)?.[0];
  if (handle) return { ok: true, label: handle, key: sourceKey(handle), kind: 'handle' };

  const patterns = [
    /\b(?:from|at|on)\s+(.+?)(?:\s+(?:this|next|last)\s+(?:morning|afternoon|evening|week|month|year|season)\b|\s+(?:today|tonight|tomorrow|now|again|yet)\b|[?.!,]|$)/i,
    /\bfor\s+(.+?)(?:\s+(?:this|next|last)\s+(?:morning|afternoon|evening|week|month|year|season)\b|\s+(?:today|tonight|tomorrow|now|again|yet)\b|[?.!,]|$)/i,
    /\bdid\s+(.+?)\s+(?:post|upload|release|publish|drop)\b/i,
    /\bhas\s+(.+?)\s+(?:posted|uploaded|released|published|dropped|changed)\b/i,
    /\bis\s+(.+?)\s+(?:back\s+)?(?:in\s+stock|available|up|down|online|offline|sold\s+out)\b/i,
    /\bare\s+(.+?)\s+(?:back\s+)?(?:in\s+stock|available|up|down|online|offline|sold\s+out)\b/i,
    /\bprice\s+of\s+(.+?)(?:\s+(?:today|now|again|yet)\b|[?.!,]|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const candidate = m?.[1] && accept(m[1]);
    if (candidate) return candidate;
  }

  return { ok: false, reason: 'no-nameable-source', label: '', key: '' };
}
