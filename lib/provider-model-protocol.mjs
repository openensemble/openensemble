// @ts-check

export function isGrokMultiAgentModel(model) {
  return /^grok-4\.20(?:-[a-z0-9.]+)*-multi-agent(?:$|[-:])/i.test(String(model || ''));
}

export function requiresResponsesTransport(provider, model) {
  const id = String(provider || '').toLowerCase();
  // Perplexity's /v1/models catalog is the Agent API catalog. Its canonical
  // ids are provider-qualified (for example openai/... or anthropic/...) and
  // execute through the OpenAI-compatible Responses endpoint. Keep legacy
  // bare sonar-* durable agents on their existing Chat Completions adapter.
  if (id === 'perplexity' && String(model || '').includes('/')) return true;
  return (id === 'grok' || id === 'xai' || id === 'xai-oauth')
    && isGrokMultiAgentModel(model);
}
