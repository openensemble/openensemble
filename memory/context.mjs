/**
 * Context builder — retrieves only semantically relevant memories and formats
 * them for system-prompt injection. Never fills the context window: the cortex
 * block stays ~the same size regardless of conversation length.
 */

import { TOKEN_BUDGET } from './shared.mjs';
import { embed } from './embedding.mjs';
import { recall, TEMPORAL_RE, parseTimeAnchor } from './recall.mjs';

export async function buildAgentContext(agentId, currentQuery, userId = 'default') {
  // Pre-embed the query once and reuse for all parallel recalls
  const queryVec = await embed(currentQuery);
  const isTemporal = TEMPORAL_RE.test(currentQuery);
  const timeAnchor = isTemporal ? parseTimeAnchor(currentQuery) : null;
  // Temporal mode: pull more episodes, fewer params
  const episodeTopK = isTemporal ? 12 : 6;
  const paramsTopK  = isTemporal ? 5 : 10;

  // Compute this agent's service roles once; used to filter user_facts so that
  // role-scoped facts (e.g. infra facts tagged "nodes") only land in the
  // context of agents that actually hold that role.
  let myRoles = [];
  try {
    const { getAgentRoles } = await import('../roles.mjs');
    myRoles = getAgentRoles(agentId, userId);
  } catch (e) { /* roles module unavailable in tests — default to unscoped only */ }

  const [params, episodes, userFacts] = await Promise.all([
    recall({ agentId, type: 'params', query: currentQuery, queryVec, topK: paramsTopK, includeShared: false, userId }),
    recall({ agentId, type: 'episodes', query: currentQuery, queryVec, topK: episodeTopK, includeShared: false, recencyBoost: isTemporal, timeAnchor, userId }),
    recall({ agentId: 'shared', type: 'user_facts', query: currentQuery, queryVec, topK: 4, includeShared: false, userId, myRoles })
      .catch(() => []),
  ]);

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
    _meta: { paramsLoaded: params.length, episodesLoaded: episodes.length, immortalCount: immortalParams.length } };
}

export function formatContext(ctx) {
  const parts = [];
  if (ctx.systemInstructions?.trim()) parts.push('## Remembered preferences & rules\n' + ctx.systemInstructions);
  if (ctx.userContext?.trim())        parts.push('## About you\n' + ctx.userContext);
  if (ctx.episodeHistory?.trim())     parts.push('## Relevant past conversations\n' + ctx.episodeHistory);
  if (!parts.length) return '';
  return `<cortex-memory>\n${parts.join('\n\n')}\n</cortex-memory>`;
}
