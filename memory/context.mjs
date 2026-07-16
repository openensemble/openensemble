/**
 * Context builder — retrieves only semantically relevant memories and formats
 * them for system-prompt injection. Never fills the context window: the cortex
 * block stays ~the same size regardless of conversation length.
 */

import { TOKEN_BUDGET } from './shared.mjs';
import { embed } from './embedding.mjs';
import { isChildAccountJailbreak } from './lance.mjs';
import { recall, TEMPORAL_RE, parseTimeAnchor } from './recall.mjs';
import { shouldSkipRecall, filterByConfidence } from './predictive-context.mjs';
import { canonicalPreferenceSubjectKey } from '../lib/personalization/preference-structure.mjs';

const PERSONALIZATION_FACT_SOURCES = new Set(['personalization', 'user_confirmed', 'user_corrected']);
const LEGACY_MODEL_PREFERENCE_SOURCE = 'preference';
const CONFIRMED_PROFILE_PER_TYPE_CAP = 3;

function normalizedConflictValue(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase()
    .replace(/\s+/g, ' ');
}

function preferenceSubject(row) {
  return canonicalPreferenceSubjectKey(
    row?.structure?.subject || row?.subject || row?.statement,
  );
}

function preferenceFacet(row, key) {
  return normalizedConflictValue(row?.structure?.[key] ?? row?.[key]);
}

// A missing facet is a general/wildcard claim. Two explicitly different
// merchants or contexts describe separate preferences and must coexist.
function preferenceFacetsOverlap(left, right) {
  return ['merchant', 'context'].every(key => {
    const a = preferenceFacet(left, key);
    const b = preferenceFacet(right, key);
    return !a || !b || a === b;
  });
}

/**
 * Keep safety/avoidance updates from being undermined by an older compatible
 * positive in the general-agent prompt. The operation is intentionally
 * asymmetric: a later broad "love apples" does not erase an earlier scoped
 * "never buy apples at Publix". Explicitly different merchant/context facets
 * remain independent.
 */
function projectConfirmedPreferences(rows, recencyFor) {
  return rows.filter(row => {
    if (row?.polarity === 'negative') return true;
    const subject = preferenceSubject(row);
    if (!subject) return true;
    const rowRecency = recencyFor(row);
    return !rows.some(negative => negative !== row
      && negative?.polarity === 'negative'
      // Negative safety/avoidance wins an equal-timestamp tie regardless of
      // row-id ordering, matching the skill and opportunity projections.
      && recencyFor(negative) >= rowRecency
      && preferenceSubject(negative) === subject
      && preferenceFacetsOverlap(negative, row));
  });
}

function preferenceStillCurrent(row, now = Date.now()) {
  const expiresAt = row?.structure?.temporary?.expiresAt;
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > now;
}

export async function buildAgentContext(agentId, currentQuery, userId = 'default', opts = {}) {
  // Predictive pre-filter — confirmations, slash commands, voice-control
  // utterances and ultra-short reactions don't benefit from cortex recall.
  // Skip the embed + 3 LanceDB queries entirely. Returns the same empty
  // shape buildAgentContext produces when nothing relevant surfaces, so the
  // caller's `formatContext(ctx) || ''` already drops the block.
  const skip = shouldSkipRecall(currentQuery);
  if (skip.skip) {
    return { systemInstructions: '', episodeHistory: '', userContext: '',
      _meta: { paramsLoaded: 0, episodesLoaded: 0, immortalCount: 0, skipped: skip.reason } };
  }

  // Pre-embed the query once and reuse for all parallel recalls
  const queryVec = await embed(currentQuery);
  const isTemporal = TEMPORAL_RE.test(currentQuery);
  const timeAnchor = isTemporal ? parseTimeAnchor(currentQuery) : null;
  // Temporal mode: pull more episodes, fewer params
  const episodeTopK = isTemporal ? 12 : 6;
  const paramsTopK  = isTemporal ? 5 : 10;

  // Compute the skills this agent is assigned once; used to filter user_facts
  // so a scoped fact (e.g. infra facts tagged "nodes", or youtube facts tagged
  // "youtube-downloader") only lands in the context of agents assigned that
  // skill. Uses assigned skills — service roles AND custom specialist skills —
  // so custom-skill facts route to their specialist, not just service roles.
  let myRoles = [];
  try {
    const { getAgentAssignedSkills } = await import('../roles.mjs');
    myRoles = getAgentAssignedSkills(agentId, userId);
  } catch (e) { /* roles module unavailable in tests — default to unscoped only */ }

  const includeEpisodes = opts?.includeEpisodes !== false;
  const suppressLearning = opts?.suppressLearning === true;
  const [paramsRaw, episodes, userFactsRaw, profileState] = await Promise.all([
    recall({ agentId, type: 'params', query: currentQuery, queryVec, topK: paramsTopK, includeShared: false, userId, suppressLearning }),
    includeEpisodes
      ? recall({ agentId, type: 'episodes', query: currentQuery, queryVec, topK: episodeTopK, includeShared: false, recencyBoost: isTemporal, timeAnchor, userId, suppressLearning })
      : Promise.resolve([]),
    recall({ agentId: 'shared', type: 'user_facts', query: currentQuery, queryVec, topK: 4, includeShared: false, userId, myRoles, suppressLearning })
      .catch(() => []),
    Promise.all([
      import('../lib/personalization/ledger.mjs'),
      import('../lib/personalization/config.mjs'),
    ]).then(async ([ledger, personalizationConfig]) => {
      const [ledgerResult, configResult] = await Promise.allSettled([
        ledger.listLedger(userId, { includeContradicted: false }),
        personalizationConfig.getConfig(userId),
      ]);
      const rows = ledgerResult.status === 'fulfilled' ? ledgerResult.value : [];
      const config = configResult.status === 'fulfilled' ? configResult.value : null;
      return {
        rows,
        // Use personalization-owned Cortex rows only when BOTH the ownership
        // sidecar and the user's current consent config were readable. Rows are
        // still retained when config alone fails so their IDs can be excluded
        // from semantic recall below.
        active: ledgerResult.status === 'fulfilled' && configResult.status === 'fulfilled'
          && config?.enabled === true && config?.setupComplete !== false,
      };
    }).catch(() => ({ rows: [], active: false })),
  ]);

  // Confidence post-filter — drop weak hits before they reach the LLM.
  // Immortal rows pass through unconditionally (filterByConfidence preserves
  // them) so user-pinned preferences are never silently disabled by a
  // tangential query. Episodes intentionally skip the filter: the recency
  // boost in temporal queries depends on the full top-K being available.
  // Before typed personalization existed, the model-classifier path wrote
  // guesses into agent params with source="preference". Params are rendered
  // below as trusted remembered rules, so those historical guesses must not
  // enter the prompt. Confirmed preferences now come from the auditable typed
  // ledger; ordinary user-pinned rules and corrections remain unaffected.
  const params    = filterByConfidence(paramsRaw)
    .filter(row => row.source !== LEGACY_MODEL_PREFERENCE_SOURCE);
  const userFacts = filterByConfidence(userFactsRaw);

  // System instructions: immortal params always included, normal params trimmed if needed
  const immortalParams = params.filter(p => p.immortal);
  const normalParams   = params.filter(p => !p.immortal);
  const immortalText   = immortalParams.map(p => p.text).join('\n');
  const normalText     = normalParams.map(p => p.text).join('\n');
  const immortalTokens = Math.ceil(immortalText.length / 4);
  const normalBudget   = Math.max(0, TOKEN_BUDGET.systemInstructions - immortalTokens);
  const normalTrimmed  = normalText.length / 4 > normalBudget
    ? '[...]\n' + normalText.slice(-(normalBudget * 4)) : normalText;
  const systemInstructions = [immortalText, normalTrimmed].filter(Boolean).join('\n');

  // Episode history — oldest first, individual entries capped at 500 chars
  const rawEpisodes = episodes
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(e => {
      const date = new Date(e.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const body = e.text.length > 500 ? e.text.slice(0, 500) + '...' : e.text;
      return `[${date}] ${body}`;
    })
    .join('\n');
  const episodeHistory = rawEpisodes.length / 4 > TOKEN_BUDGET.episodeHistory
    ? '[...older history in memory...]\n' + rawEpisodes.slice(-(TOKEN_BUDGET.episodeHistory * 4))
    : rawEpisodes;

  // User context — group by category for structured output
  const profileIds = new Set(profileState.rows.map(r => r.id));
  const profileRecency = row => Date.parse(row.updatedAt || row.confirmedAt || row.createdAt || '') || 0;
  const governedConfirmedRows = profileState.active
    ? profileState.rows.filter(r => r.tier === 'confirmed' && r.scope === 'global'
      && (r.type === 'preference' || r.type === 'constraint'))
    : [];
  const profileNow = Date.now();
  const confirmedCandidates = governedConfirmedRows
    .filter(r => preferenceStillCurrent(r, profileNow)
      && !isChildAccountJailbreak(userId, r.statement))
    .sort((a, b) => profileRecency(b) - profileRecency(a) || String(a.id).localeCompare(String(b.id)));
  // Build the always-on confirmed profile first. Semantic recall is filtered
  // after this step so confirmed preference/constraint candidates cannot
  // bypass the cap or conflict projection; other ledger-owned
  // facts/patterns/goals remain retrievable when relevant.
  const userContextParts = [];
  const confirmedProfile = [];
  const semanticFacts = [];
  const userContextCharBudget = Math.max(0, Number(TOKEN_BUDGET.userContext) || 0) * 4;
  let userContextChars = 0;
  const pushPart = text => {
    const separatorCost = userContextParts.length ? 1 : 0;
    if (!text || userContextChars + separatorCost + text.length > userContextCharBudget) return false;
    userContextParts.push(text);
    userContextChars += separatorCost + text.length;
    return true;
  };
  const pushGroup = (label, rows, textFor, selected) => {
    let line = label;
    const accepted = [];
    for (const row of rows) {
      const text = String(textFor(row) || '').trim().slice(0, 300);
      if (!text) continue;
      const candidate = line + (accepted.length ? '; ' : '') + text;
      const separatorCost = userContextParts.length ? 1 : 0;
      if (userContextChars + separatorCost + candidate.length > userContextCharBudget) break;
      line = candidate;
      accepted.push(row);
    }
    if (accepted.length && pushPart(line)) selected.push(...accepted);
  };

  if (confirmedCandidates.length) {
    const globalPrefs = projectConfirmedPreferences(
      confirmedCandidates.filter(r => r.type === 'preference'),
      profileRecency,
    ).slice(0, CONFIRMED_PROFILE_PER_TYPE_CAP);
    const constraints = confirmedCandidates.filter(r => r.type === 'constraint').slice(0, CONFIRMED_PROFILE_PER_TYPE_CAP);
    // Constraints can encode accessibility and safety boundaries. Give them
    // first claim on the shared prompt budget so long preference text cannot
    // silently crowd every constraint out of context.
    pushGroup('Confirmed constraints: ', constraints, row => row.statement, confirmedProfile);
    pushGroup('Confirmed preferences: ', globalPrefs, row => row.statement, confirmedProfile);
  }

  // The master switch controls use as well as collection. When inactive (or
  // config is unreadable), exclude every ledger-owned row and every orphan
  // carrying a personalization source tag. When active, exclude confirmed
  // preference/constraint candidates already governed by the projection above
  // and let other owned memories compete normally in semantic recall.
  // Include expired rows in the governed set so their Cortex copies cannot
  // fall through semantic recall after being excluded from the live profile.
  const projectedProfileCandidateIds = new Set(governedConfirmedRows.map(row => row.id));
  const profileById = new Map(profileState.rows.map(row => [row.id, row]));
  const semanticCandidates = userFacts.filter(f => {
    if (isChildAccountJailbreak(userId, f.text)) return false;
    // The old classifier also duplicated guesses into shared user_facts. They
    // are not attached to the typed ledger and therefore cannot be reviewed;
    // drop them instead of preserving an unmanaged second inference channel.
    if (f.source === LEGACY_MODEL_PREFERENCE_SOURCE && !profileById.has(f.id)) return false;
    if (profileState.active) {
      // A personalization-tagged Cortex row without a ledger owner is a
      // crash orphan: it is invisible to About You controls and must never be
      // injected. Owned rows may flow unless already injected above.
      if (PERSONALIZATION_FACT_SOURCES.has(f.source) && !profileById.has(f.id)) return false;
      return !projectedProfileCandidateIds.has(f.id);
    }
    return !profileIds.has(f.id) && !PERSONALIZATION_FACT_SOURCES.has(f.source);
  });
  const prefs = semanticCandidates.filter(f => f.category === 'preference' || f.text.startsWith('PREFERENCE:'));
  const others = semanticCandidates.filter(f => !prefs.includes(f));
  pushGroup('Possible preferences (unconfirmed): ', prefs,
    fact => fact.text.replace(/^(?:PREFERENCE|INFERRED):\s*/i, ''), semanticFacts);
  for (const fact of others) {
    const text = String(fact.text || '');
    const ownedProfile = profileById.get(fact.id);
    const unconfirmed = text.startsWith('INFERRED:') || fact.source === 'personalization'
      || (ownedProfile && ownedProfile.tier !== 'confirmed');
    const rendered = (unconfirmed
      ? `Possible (unconfirmed): ${text.replace(/^INFERRED:\s*/i, '')}` : text).slice(0, 300);
    if (!pushPart(rendered)) break;
    semanticFacts.push(fact);
  }
  const userContext = userContextParts.join('\n');

  return { systemInstructions, episodeHistory, userContext,
    _meta: {
      paramsLoaded: params.length,
      episodesLoaded: episodes.length,
      userFactsLoaded: semanticFacts.length + confirmedProfile.length,
      immortalCount: immortalParams.length,
      injectedMemoryIds: [
        ...params.map(m => ({ id: m.id, table: `${agentId}_params`, type: 'params', text: m.text?.slice(0, 160) ?? '' })),
        ...episodes.map(m => ({ id: m.id, table: `${agentId}_episodes`, type: 'episodes', text: m.text?.slice(0, 160) ?? '' })),
        ...semanticFacts.map(m => ({ id: m.id, table: 'user_facts', type: 'user_facts', text: m.text?.slice(0, 160) ?? '' })),
        ...confirmedProfile.filter(m => !semanticFacts.some(f => f.id === m.id))
          .map(m => ({ id: m.id, table: 'user_facts', type: 'user_facts', text: m.statement?.slice(0, 160) ?? '' })),
      ],
    } };
}

// Neutralize stored-memory text before it lands inside the <cortex-memory>
// system-prompt block. A stored fact is user/model-supplied and must never be
// able to (a) close the delimiter early with a literal </cortex-memory> tag or
// any other angle-bracket sequence, or (b) forge a trusted "## ..." section
// header to smuggle instructions. We swap angle brackets for lookalikes so no
// tag can form, and strip leading markdown-header markers per line. The genuine
// "## ..." headers below are added AFTER sanitizing, so they're unaffected.
function sanitizeMemoryText(s) {
  if (!s) return s;
  return String(s)
    .replace(/</g, '‹').replace(/>/g, '›')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
}

export function formatContext(ctx) {
  const parts = [];
  const systemInstructions = sanitizeMemoryText(ctx.systemInstructions);
  const userContext        = sanitizeMemoryText(ctx.userContext);
  const episodeHistory     = sanitizeMemoryText(ctx.episodeHistory);
  if (systemInstructions?.trim()) parts.push('## Remembered preferences & rules\n' + systemInstructions);
  if (userContext?.trim())        parts.push('## About you\n' + userContext);
  if (episodeHistory?.trim())     parts.push('## Relevant past conversations\n' + episodeHistory);
  if (!parts.length) return '';
  return `<cortex-memory>\n${parts.join('\n\n')}\n</cortex-memory>`;
}
