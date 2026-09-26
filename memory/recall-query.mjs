// A short request can be complete. Only references to prior conversation
// justify adding history; dates alone are handled by temporal recall.
const NEEDS_CONTEXT_RE = /\b(that|this|it|those|these|there|the same|more about|what we|what you|earlier|last time|as before|like before|again|continue|go on)\b/i;

export async function buildRecallQuery(currentQuery, { isolatedTaskRun = false, loadRecentMessages } = {}) {
  if (isolatedTaskRun || !NEEDS_CONTEXT_RE.test(currentQuery)) return currentQuery;
  const recentMsgs = (await loadRecentMessages())
    .filter(message => message.excludeFromModel !== true).slice(-4);
  const lastUser = recentMsgs.filter(message => message.role === 'user').slice(-1)[0];
  const lastAssistant = recentMsgs.filter(message => message.role === 'assistant').slice(-1)[0];
  const context = [lastUser?.content?.slice(0, 150), lastAssistant?.content?.slice(0, 150)].filter(Boolean);
  return context.length ? `${currentQuery} [context: ${context.join(' ')}]` : currentQuery;
}
