/**
 * Context builder — retrieves only semantically relevant memories and formats
 * them for system-prompt injection. Never fills the context window: the cortex
 * block stays ~the same size regardless of conversation length.
 */

import { TOKEN_BUDGET } from './shared.mjs';
import { embed } from './embedding.mjs';
import { recall, TEMPORAL_RE, parseTimeAnchor } from './recall.mjs';
import { shouldSkipRecall, filterByConfidence } from './predictive-context.mjs';

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
  const [paramsRaw, episodes, userFactsRaw] = await Promise.all([
    recall({ agentId, type: 'params', query: currentQuery, queryVec, topK: paramsTopK, includeShared: false, userId }),
    includeEpisodes
      ? recall({ agentId, type: 'episodes', query: currentQuery, queryVec, topK: episodeTopK, includeShared: false, recencyBoost: isTemporal, timeAnchor, userId })
      : Promise.resolve([]),
    recall({ agentId: 'shared', type: 'user_facts', query: currentQuery, queryVec, topK: 4, includeShared: false, userId, myRoles })
      .catch(() => []),
  ]);

  // Confidence post-filter — drop weak hits before they reach the LLM.
  // Immortal rows pass through unconditionally (filterByConfidence preserves
  // them) so user-pinned preferences are never silently disabled by a
  // tangential query. Episodes intentionally skip the filter: the recency
  // boost in temporal queries depends on the full top-K being available.
  const params    = filterByConfidence(paramsRaw);
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
  const prefs = userFacts.filter(f => f.category === 'preference' || f.text.startsWith('PREFERENCE:'));
  const others = userFacts.filter(f => !prefs.includes(f));
  const userContextParts = [];
  if (prefs.length) userContextParts.push('Preferences: ' + prefs.map(f => f.text.replace(/^PREFERENCE:\s*/i, '')).join('; '));
  if (others.length) userContextParts.push(others.map(f => f.text).join('\n'));
  const userContext = userContextParts.join('\n');

  return { systemInstructions, episodeHistory, userContext,
    _meta: {
      paramsLoaded: params.length,
      episodesLoaded: episodes.length,
      userFactsLoaded: userFacts.length,
      immortalCount: immortalParams.length,
      injectedMemoryIds: [
        ...params.map(m => ({ id: m.id, table: `${agentId}_params`, type: 'params', text: m.text?.slice(0, 160) ?? '' })),
        ...episodes.map(m => ({ id: m.id, table: `${agentId}_episodes`, type: 'episodes', text: m.text?.slice(0, 160) ?? '' })),
        ...userFacts.map(m => ({ id: m.id, table: 'user_facts', type: 'user_facts', text: m.text?.slice(0, 160) ?? '' })),
      ],
    } };
}

export function formatContext(ctx) {
  const parts = [];
  if (ctx.systemInstructions?.trim()) parts.push('## Remembered preferences & rules\n' + ctx.systemInstructions);
  if (ctx.userContext?.trim())        parts.push('## About you\n' + ctx.userContext);
  if (ctx.episodeHistory?.trim())     parts.push('## Relevant past conversations\n' + ctx.episodeHistory);
  if (!parts.length) return '';
  return `<cortex-memory>\n${parts.join('\n\n')}\n</cortex-memory>`;
}
