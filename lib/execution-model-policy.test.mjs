import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: { id: 'user_policy', role: 'owner' },
  cfg: {
    enabledProviders: {},
    cortex: { ollamaUrl: 'http://ollama.test/api', lmstudioUrl: 'http://lmstudio.test' },
  },
  connected: true,
  oauthModels: [{ id: 'gpt-live' }],
  keys: {
    anthropic: 'anthropic-key', openrouter: 'openrouter-key', grok: 'grok-key',
    openai: 'openai-key', perplexity: 'perplexity-key',
  },
}));

vi.mock('../routes/_helpers.mjs', () => ({
  getUser: vi.fn(() => state.user),
  loadConfig: vi.fn(() => state.cfg),
}));

vi.mock('../chat/providers/_shared.mjs', () => ({
  OPENAI_COMPAT_PROVIDERS: {
    openai: { baseUrl: 'https://openai.test/v1', keyField: 'openaiApiKey' },
    perplexity: { baseUrl: 'https://perplexity.test', keyField: 'perplexityApiKey' },
  },
  getCompatKey: vi.fn(provider => state.keys[provider] ?? null),
  getAnthropicKey: vi.fn(() => state.keys.anthropic ?? null),
  getOpenRouterKey: vi.fn(() => state.keys.openrouter ?? null),
  getGrokKey: vi.fn(() => state.keys.grok ?? null),
}));

vi.mock('./openai-codex-auth.mjs', () => ({
  isConnected: vi.fn(() => state.connected),
}));

vi.mock('./openai-codex-models.mjs', () => ({
  listOpenAIOAuthModels: vi.fn(async () => state.oauthModels),
}));

import { validateExecutionModelAccess, _internal } from './execution-model-policy.mjs';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

beforeEach(() => {
  state.user = { id: 'user_policy', role: 'owner' };
  state.cfg = {
    enabledProviders: {},
    cortex: { ollamaUrl: 'http://ollama.test/api', lmstudioUrl: 'http://lmstudio.test' },
  };
  state.connected = true;
  state.oauthModels = [{ id: 'gpt-live' }];
  state.keys = {
    anthropic: 'anthropic-key', openrouter: 'openrouter-key', grok: 'grok-key',
    openai: 'openai-key', perplexity: 'perplexity-key',
  };
  _internal.cache.clear();
  vi.stubGlobal('fetch', vi.fn(async url => {
    const value = String(url);
    if (value.includes('anthropic.com')) return jsonResponse({ data: [{ id: 'claude-live' }], has_more: false });
    if (value.includes('openrouter.ai')) return jsonResponse({ data: [{ id: 'router-live', architecture: { modality: 'text->text' } }] });
    if (value.includes('api.x.ai')) return jsonResponse({ models: [{ id: 'grok-live' }] });
    if (value.includes('ollama.test')) return jsonResponse({ models: [{ name: 'ollama-live' }] });
    if (value.includes('lmstudio.test/api/v1/models')) return jsonResponse({ models: [{ key: 'lm-live', type: 'llm' }] });
    if (value.includes('openai.test')) return jsonResponse({ data: [{ id: 'openai-live' }] });
    return jsonResponse({}, 404);
  }));
});

describe('execution model policy', () => {
  it.each([
    ['openai-oauth', 'gpt-live'],
    ['anthropic', 'claude-live'],
    ['openrouter', 'router-live'],
    ['grok', 'grok-live'],
    ['ollama', 'ollama-live'],
    ['lmstudio', 'lm-live'],
    ['openai', 'openai-live'],
    ['perplexity', 'sonar-deep-research'],
  ])('accepts only catalog-listed %s models', async (provider, model) => {
    await expect(validateExecutionModelAccess('user_policy', provider, model, { refreshCatalog: true }))
      .resolves.toMatchObject({ ok: true, reason: 'available' });
    await expect(validateExecutionModelAccess('user_policy', provider, `${model}-forged`, { refreshCatalog: true }))
      .resolves.toMatchObject({ ok: false, reason: 'model-unavailable' });
  });

  it('fails closed for unknown, disabled, disconnected, and account-revoked providers', async () => {
    await expect(validateExecutionModelAccess('user_policy', 'made-up', 'looks-valid'))
      .resolves.toMatchObject({ ok: false, reason: 'unknown-provider' });

    state.cfg.enabledProviders.anthropic = false;
    await expect(validateExecutionModelAccess('user_policy', 'anthropic', 'claude-live'))
      .resolves.toMatchObject({ ok: false, reason: 'provider-disabled' });

    state.connected = false;
    await expect(validateExecutionModelAccess('user_policy', 'openai-oauth', 'gpt-live'))
      .resolves.toMatchObject({ ok: false, reason: 'provider-not-connected' });

    state.connected = true;
    state.user = { id: 'user_policy', role: 'user', allowedOAuthProviders: [], allowedModels: ['gpt-live'] };
    await expect(validateExecutionModelAccess('user_policy', 'openai-oauth', 'gpt-live'))
      .resolves.toMatchObject({ ok: false, reason: 'oauth-provider-not-allowed', status: 403 });
  });

  it('rejects every saved override after its user is removed', async () => {
    state.user = null;
    await expect(validateExecutionModelAccess('deleted', 'openai', 'openai-live'))
      .resolves.toMatchObject({ ok: false, reason: 'user-not-found', status: 404 });
  });
});
