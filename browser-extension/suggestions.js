// Pure local matcher helpers for OE's generic project-suggestion badge.
// This module never receives project names or page bodies.

const STOP = new Set(['about', 'after', 'from', 'have', 'page', 'price', 'product', 'review', 'that', 'this', 'with', 'your']);

function pageTokens(value) {
  return new Set(String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4 && word.length <= 28 && !STOP.has(word)));
}

function hostOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch { return null; }
}

export function normalizeSuggestionMatchers(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).flatMap(raw => {
    const id = String(raw?.id || '').slice(0, 100);
    if (!/^bsm_[A-Za-z0-9_-]{8,80}$/.test(id)) return [];
    const domains = [...new Set((Array.isArray(raw.domains) ? raw.domains : [])
      .map(value => String(value || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, ''))
      .filter(value => /^[a-z0-9.-]{1,253}$/.test(value) && value.includes('.')))]
      .slice(0, 6);
    const keywords = [...new Set((Array.isArray(raw.keywords) ? raw.keywords : [])
      .map(value => String(value || '').toLowerCase())
      .filter(value => /^[a-z0-9]{4,28}$/.test(value)))]
      .slice(0, 12);
    const excludedDomains = [...new Set((Array.isArray(raw.excludedDomains) ? raw.excludedDomains : [])
      .map(value => String(value || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, ''))
      .filter(value => /^[a-z0-9.-]{1,253}$/.test(value) && value.includes('.')))]
      .slice(0, 20);
    if (!domains.length && !keywords.length) return [];
    return [{
      id, domains, excludedDomains, keywords,
      minKeywordMatches: Math.max(1, Math.min(4, Number(raw.minKeywordMatches) || 1)),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null,
    }];
  });
}

/** Return only an opaque matcher id and score; labels stay on the server. */
export function matchSuggestionForPage(matchers, { url, title } = {}) {
  const host = hostOf(url);
  if (!host) return null;
  const words = pageTokens(`${title || ''} ${host.replace(/\./g, ' ')}`);
  let best = null;
  for (const matcher of normalizeSuggestionMatchers(matchers)) {
    if (matcher.excludedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) continue;
    const domainMatch = matcher.domains.some(domain => host === domain || host.endsWith(`.${domain}`));
    const hits = matcher.keywords.filter(keyword => words.has(keyword));
    if (!domainMatch && hits.length < matcher.minKeywordMatches) continue;
    const score = (domainMatch ? 10 : 0) + hits.length;
    if (!best || score > best.score) best = { matcherId: matcher.id, score };
  }
  return best;
}

export const __test = Object.freeze({ hostOf, pageTokens });
