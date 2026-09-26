/** Explicit memory reads are planned locally, before calling the chat model. */
const SEARCH_WORDS = ['preferences', 'preference', 'memories', 'memory', 'remember'];
const ORDINARY_WORDS = new Set(['reference', 'references', 'memoir', 'memoirs']);

function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length <= b.length) j++;
    if (a.length >= b.length) i++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

export function normalizeMemoryQuery(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim()
    .replace(/[’]/g, "'").replace(/[a-z]+/g, word => {
      if (word.length < 6 || SEARCH_WORDS.includes(word) || ORDINARY_WORDS.has(word)) return word;
      return SEARCH_WORDS.find(target => oneEditApart(word, target)) || word;
    }).replace(/\s+/g, ' ').slice(0, 500);
}

export function memorySearchIntent(value) {
  const text = normalizeMemoryQuery(value).replace(/^(?:please|can you|could you|would you)\s+/, '').replace(/[?.!]+$/, '');
  const overview = /^(?:what (?:do you|have you) (?:know|remember|learned|saved) about (?:me|myself)|(?:tell me|show me|list) (?:some )?facts about (?:me|myself))$/.test(text);
  const inventory = /^(?:show|list|browse|search|find)(?: me)? (?:(?:all|of|my|the|saved|stored)\s+)*(?:memories|memory|facts|preferences)$/.test(text);
  if (overview || inventory) return { query: inventory && /\bpreferences$/.test(text) ? 'preferences' : '', type: 'profile', browse: true, explicit: true };
  const personalLikes = text.match(/^what (.{1,100}?) do i (?:like|prefer|enjoy|dislike|avoid)$/);
  if (personalLikes) return { query: `${personalLikes[1]} preferences`, type: 'profile', browse: false, explicit: true };
  // Only read-shaped requests qualify. Saving/deleting a preference, discussing
  // how memory works, and quoted memory commands must not trigger a read.
  if (!/^(?:show|list|find|search|look up|tell me|what (?:do you|have you|are my|are all my))\b/.test(text)) return null;
  if (/^(?:show|list|find|search)(?: me)? (?:(?:my|the) )?memory (?:usage|leaks?|allocation|settings|management|address)\b/.test(text)) return null;
  if (!/\b(?:memories|memory|preferences|remember|know about me|saved about)\b/.test(text)) return null;
  let query = text.replace(/^(?:show|list|find|search|look up|tell)(?: me)?\s+/, '')
    .replace(/^what (?:do you|have you) (?:remember|know|saved|learned)(?: about)?\s*/, '')
    .replace(/^what are (?:all )?my\s+/, '')
    .replace(/^(?:in |through )?(?:my |our |the )?(?:saved |stored )?(?:memories|memory)(?: for| about| of)?\s*/, '')
    .replace(/^(?:all |of |my |our |the |about )+/, '').trim();
  const type = /\bpreferences\b/.test(query) ? 'profile' : 'all';
  return { query, type, browse: !query, explicit: true };
}
