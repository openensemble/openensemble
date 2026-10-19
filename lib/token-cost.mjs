// These are the same estimates used by activity accounting, not provider bills.
export function tokenPricing(provider, model, config = {}) {
  if (['ollama-local', 'lmstudio', 'builtin'].includes(provider)) return { input: 0, output: 0, source: 'local inference; excludes infrastructure' };
  const configured = config.openrouterPricing?.[model];
  if (provider === 'openrouter' && configured && [configured.input, configured.output].every(n => Number.isFinite(n) && n >= 0)) {
    return { input: configured.input, output: configured.output, source: 'cached OpenRouter model pricing' };
  }
  const legacy = { anthropic: [3, 15], fireworks: [3, 15], grok: [5, 15], xai: [5, 15] }[provider];
  return legacy ? { input: legacy[0], output: legacy[1], source: 'legacy provider-wide estimate; model rates may differ' } : null;
}

export function tokenCost(pricing, input, output) {
  return pricing ? Math.round((input * pricing.input + output * pricing.output) * 1e3) / 1e9 : null;
}
