/** Account-scoped retrieval. Database/keyword search and Nomic run locally;
 * Cortex only judges a bounded shortlist. No remote model receives the store. */
import { getDb } from './lance.mjs';
import { builtinEmbed } from './builtin-embed.mjs';
import { generateCombined, getCortexConfig, safeParseJSON } from './shared.mjs';
import { normalizeMemoryQuery, memorySearchIntent } from './search-intent.mjs';
import { isOrchestrationEnvelope } from './relevance.mjs';
import { memoryExcerpt } from './search-budget.mjs';

const CANDIDATE_LIMIT = 24;
const SEARCH_TOPIC_THRESHOLD = 0.45;
const STOP = new Set('a an the i me my our you your user about what do does did have has know remember saved stored memory memories preferences preference favorite favourite please show list find search tell all for in of and to is are'.split(' '));
const PERSONALIZATION_SOURCES = new Set(['personalization', 'user_confirmed', 'user_corrected']);
const CONFIRMED_SOURCES = new Set(['user_stated', 'user_confirmed', 'user_corrected', 'user_edited', 'correction']);

function terms(text) {
  return [...new Set((String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_@.+-]+/gu) || [])
    .map(word => word.replace(/^[.+-]+|[.+-]+$/g, '')))].filter(word => word && !STOP.has(word));
}

function lexicalWord(word) {
  if (/[@.\d]/.test(word)) return word;
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function eligible(row, ledger, profileEnabled) {
  if (!row.text?.trim() || row.forgotten || row.id === '_init' || row.id?.startsWith('_init_')
    || row.status === 'contradicted' || isOrchestrationEnvelope(row)) return false;
  const owned = ledger.get(row.id);
  if ((owned || PERSONALIZATION_SOURCES.has(row.source)) && (!profileEnabled || !owned)) return false;
  if (owned && owned.status !== 'active') return false;
  const expiry = owned?.structure?.temporary?.expiresAt;
  if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) return false;
  return true;
}

function decorate(row, table, ledger) {
  const owned = ledger.get(row.id);
  const type = table.endsWith('_episodes') ? 'episodes' : 'profile';
  const confirmed = owned ? owned.tier === 'confirmed' : CONFIRMED_SOURCES.has(row.source);
  const label = type === 'episodes' ? 'past conversation'
    : confirmed && !/^INFERRED:/i.test(row.text) ? 'saved fact' : 'unconfirmed';
  return { id: row.id, table, type, text: row.text, created_at: row.created_at,
    source: row.source, label, confirmed, category: owned?.type || row.category,
    semantic: Number.isFinite(row._distance) ? 1 - row._distance : 0, lexical: 0 };
}

function preferenceStatement(row) {
  return ['preference', 'constraint'].includes(row.category)
    || /\b(?:prefer\w*|like[sd]?|love[sd]?|hate[sd]?|dislike[sd]?|enjoy\w*|favou?rite|allerg\w*|avoid\w*|want\w*|need\w*|cannot|can't|must|never)\b/i.test(row.text)
    || /\b(?:i|user)\s+(?:follow|choose|eat|drink|wear|use|listen|read)\w*\b/i.test(row.text)
    || /\b(?:i am|i'm|user is|do not|don't|does not|doesn't)\b/i.test(row.text);
}

export async function searchMemories({ userId, query = '', type = 'auto', limit = 10, offset = 0, budgetMs = 3500 } = {}) {
  if (!userId || userId === 'default' || !/^[a-zA-Z0-9_-]{1,120}$/.test(userId)) throw new Error('Authenticated memory owner required');
  const intent = memorySearchIntent(query);
  query = intent?.query ?? normalizeMemoryQuery(query);
  type = ['profile', 'episodes', 'all'].includes(type) ? type : (intent?.type || 'all');
  if (!query && type === 'all') type = 'profile';
  limit = Math.max(1, Math.min(10, Math.floor(Number(limit) || 10)));
  offset = Math.max(0, Math.min(5000, Math.floor(Number(offset) || 0)));
  const queryTerms = terms(query);
  const browse = !queryTerms.length;
  const identifierQuery = queryTerms.length === 1 && /@|\d+(?:\.\d+){2,}/.test(queryTerms[0]);
  const preferencesOnly = /\b(?:preferences?|favou?rite)\b/.test(query);
  const counts = { profile: 0, episodes: 0 };
  const candidates = new Map();
  let partial = false;
  const [{ listLedger }, { getConfig }] = await Promise.all([
    import('../lib/personalization/ledger.mjs'), import('../lib/personalization/config.mjs'),
  ]);
  const [ledgerResult, configResult] = await Promise.allSettled([listLedger(userId), getConfig(userId)]);
  const ledger = new Map((ledgerResult.status === 'fulfilled' ? ledgerResult.value : []).map(row => [row.id, row]));
  const profileEnabled = configResult.status === 'fulfilled' && configResult.value.enabled === true
    && configResult.value.setupComplete !== false && ledgerResult.status === 'fulfilled';
  if (ledgerResult.status === 'rejected' || configResult.status === 'rejected') partial = true;
  let vector = null;
  if (!browse) {
    // Direct builtin call prevents a configured cloud embedder from receiving
    // even the search query. Existing document vectors are reused as-is.
    try { vector = await builtinEmbed(queryTerms.join(' '), { purpose: 'query' }); } catch { partial = true; }
    if (!vector?.length || vector.some(v => !Number.isFinite(v)) || vector.every(v => v === 0)) vector = null;
  }
  const db = await getDb(userId);
  const selectedTables = (await db.tableNames()).filter(name => name === 'user_facts' || /_(?:params|episodes)$/.test(name)).sort();
  const compare = browse
    ? (a, b) => Number(b.confirmed) - Number(a.confirmed) || String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id)
    : (a, b) => (b.lexical * 0.5 + b.semantic) - (a.lexical * 0.5 + a.semantic) || a.id.localeCompare(b.id);
  const retain = row => {
    const key = `${row.table}:${row.id}`;
    const previous = candidates.get(key);
    if (previous) { row.semantic = Math.max(previous.semantic, row.semantic); row.lexical = Math.max(previous.lexical, row.lexical); }
    candidates.set(key, row);
    const max = browse ? offset + limit + 1 : CANDIDATE_LIMIT;
    if (candidates.size > max * 2) {
      const top = [...candidates.values()].sort(compare).slice(0, max);
      candidates.clear(); top.forEach(item => candidates.set(`${item.table}:${item.id}`, item));
    }
  };
  for (const name of selectedTables) {
    try {
      // Opening an existing table avoids schema writes/migrations during search.
      const table = await db.openTable(name);
      const columns = (await table.schema()).fields.map(field => field.name).filter(field => field !== 'vector');
      const matchesType = type === 'all' || (name.endsWith('_episodes') ? type === 'episodes' : type === 'profile');
      for await (const batch of table.query().where('forgotten = false').select(columns)) {
        for (const row of batch.toArray()) {
          if (!eligible(row, ledger, profileEnabled)) continue;
          const item = decorate(row, name, ledger);
          counts[item.type]++;
          if (!matchesType || (preferencesOnly && !preferenceStatement(item))) continue;
          const words = new Set(terms(row.text).map(lexicalWord));
          item.lexical = queryTerms.length ? queryTerms.filter(word => words.has(lexicalWord(word))).length / queryTerms.length : 0;
          if (browse || item.lexical > 0) retain(item);
        }
      }
      if (matchesType && vector) {
        const rows = await table.vectorSearch(vector).distanceType('cosine').where('forgotten = false').limit(12).select([...columns, '_distance']).toArray();
        for (const row of rows) {
          if (!eligible(row, ledger, profileEnabled)) continue;
          const item = decorate(row, name, ledger);
          if (preferencesOnly && !preferenceStatement(item)) continue;
          if (item.semantic >= 0.35) retain(item);
        }
      }
    } catch { partial = true; }
  }
  const seen = new Set();
  const ranked = [...candidates.values()].sort(compare).filter(row => {
    const key = normalizeMemoryQuery(row.text);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  let matching = ranked;
  if (!browse) {
    matching = [];
    const cfg = getCortexConfig();
    // A clear leading topic must not be padded with weak generic matches.
    const topicFloor = Math.max(SEARCH_TOPIC_THRESHOLD, Math.max(0, ...ranked.map(row => row.semantic)) * 0.8);
    const deadline = Date.now() + Math.max(0, Math.min(5000, budgetMs));
    for (const row of ranked.slice(0, CANDIDATE_LIMIT)) {
      // Exact identifiers must not turn into nearby people/addresses. Generic
      // preference language is stripped from embedding queries, so agreeing
      // on "prefers" alone cannot make food and flight preferences match.
      if (identifierQuery) { if (row.lexical === 1) matching.push(row); continue; }
      if (row.lexical === 1) { matching.push(row); continue; }
      if (row.semantic < topicFloor) continue;
      if (!cfg.relevanceTask || Date.now() >= deadline) {
        partial = true; continue;
      }
      const clean = value => String(value).replace(/"/g, "'");
      const excerpt = memoryExcerpt(row.text, queryTerms.join(' '), 1000).text;
      const output = await generateCombined('', `Query: "${clean(queryTerms.join(' '))}" Memory: "${clean(excerpt)}"`,
        { caller: 'relevance', userId, localOnly: true, timeoutMs: Math.max(1, deadline - Date.now()) });
      const result = safeParseJSON(output);
      if (result?.relevant === true) matching.push(row);
      else if (result?.relevant !== false) {
        partial = true;
      }
      if (matching.length >= offset + limit + 1) break;
    }
  }
  return { query, type, offset, rows: matching.slice(offset, offset + limit), counts,
    partial: partial || (!browse && ranked.length >= CANDIDATE_LIMIT),
    hasMore: matching.length > offset + limit,
    nextOffset: offset + Math.min(limit, Math.max(0, matching.length - offset)) };
}
