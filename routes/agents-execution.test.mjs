import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { id: 'user_test', role: 'owner' },
  execution: null,
  requireAuth: vi.fn(() => 'user_test'),
  setSkillExecutionOverride: vi.fn(async (_userId, _skillId, execution) => {
    mocks.execution = execution;
    return { ok: true };
  }),
}));

vi.mock('./_helpers.mjs', () => ({
  requireAuth: mocks.requireAuth,
  requirePrivileged: mocks.requireAuth,
  getAuthToken: vi.fn(),
  getSessionUserId: vi.fn(),
  getUser: vi.fn(() => mocks.user),
  isPrivileged: vi.fn(() => mocks.user.role === 'owner' || mocks.user.role === 'admin'),
  loadUsers: vi.fn(() => [mocks.user]),
  loadConfig: vi.fn(() => ({ enabledProviders: {} })),
  modifyUsers: vi.fn(),
  modifyUser: vi.fn(),
  modifyConfig: vi.fn(),
  agentToWire: vi.fn(value => value),
  readBody: vi.fn(async req => req.body || '{}'),
  getAgentsForUser: vi.fn(() => [{
    id: 'jarvis', provider: 'openai-oauth', model: 'gpt-5.4-mini', reasoningEffort: 'auto',
  }]),
  getUserEnabledSkills: vi.fn(() => ['coder']),
  saveUserAgentOverride: vi.fn(),
  broadcastAgentList: vi.fn(),
  getAgent: vi.fn(),
  loadCustomAgents: vi.fn(() => []),
  updateAgentMeta: vi.fn(),
  invalidateModelOverridesCache: vi.fn(),
  listRoles: vi.fn(() => [{
    id: 'coder', name: 'Coder', service: true, hidden: false, tools: [],
  }]),
  BASE_DIR: '/tmp/openensemble-agents-execution-test',
}));

vi.mock('../agents.mjs', () => ({
  createCustomAgent: vi.fn(), deleteCustomAgent: vi.fn(), updateCustomAgent: vi.fn(),
}));

vi.mock('../roles.mjs', () => ({
  onRoleEnabled: vi.fn(),
  getRoleAssignments: vi.fn(() => ({ coordinator: 'jarvis', coder: 'jarvis' })),
  setRoleAssignment: vi.fn(),
  getRoleManifest: vi.fn(),
  addRoleManifest: vi.fn(),
  removeRoleManifest: vi.fn(),
  getRoleTools: vi.fn(() => []),
}));

vi.mock('../lib/skill-overrides.mjs', () => ({
  clearSkillOverride: vi.fn(),
  getSkillExecutionOverride: vi.fn(() => mocks.execution),
  setSkillExecutionOverride: mocks.setSkillExecutionOverride,
}));

vi.mock('../lib/skill-execution.mjs', () => ({
  isExecutionTextModel: vi.fn(() => true),
}));

vi.mock('../lib/execution-model-policy.mjs', () => ({
  validateExecutionModelAccess: vi.fn(async (_userId, _provider, model) => {
    if (model === 'forged-model') {
      return { ok: false, status: 400, error: `Model "${model}" is not available from provider` };
    }
    if (Array.isArray(mocks.user.allowedModels) && !mocks.user.allowedModels.includes(model)) {
      return { ok: false, status: 403, error: `Model "${model}" is not available for this account` };
    }
    return { ok: true, status: 200 };
  }),
}));

import { handle } from './agents.mjs';

function response() {
  return { writeHead: vi.fn(), end: vi.fn() };
}

function jsonBody(res) {
  return JSON.parse(res.end.mock.calls.at(-1)?.[0] || '{}');
}

beforeEach(() => {
  mocks.user = { id: 'user_test', role: 'owner' };
  mocks.execution = null;
  mocks.requireAuth.mockClear().mockReturnValue('user_test');
  mocks.setSkillExecutionOverride.mockClear();
});

describe('role and skill execution settings API', () => {
  it('returns the per-user execution setting with each visible role', async () => {
    mocks.execution = {
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    };
    const res = response();
    expect(await handle({ method: 'GET', url: '/api/roles' }, res)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(jsonBody(res)[0]).toMatchObject({ id: 'coder', execution: mocks.execution });
  });

  it('saves an atomic model pair and supports an effort-only inherited-model setting', async () => {
    const full = response();
    await handle({
      method: 'PATCH', url: '/api/roles/coder/execution',
      body: JSON.stringify({
        provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
      }),
    }, full);
    expect(full.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(jsonBody(full).execution).toEqual({
      provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });

    const effortOnly = response();
    await handle({
      method: 'PATCH', url: '/api/roles/coder/execution',
      body: JSON.stringify({ provider: null, model: null, reasoningEffort: 'low' }),
    }, effortOnly);
    expect(jsonBody(effortOnly).execution).toEqual({ reasoningEffort: 'low' });
  });

  it('rejects a model outside the account allowlist without persisting it', async () => {
    mocks.user = { id: 'user_test', role: 'user', allowedModels: ['gpt-5.4-mini'], allowedOAuthProviders: ['openai-oauth'] };
    const res = response();
    await handle({
      method: 'PATCH', url: '/api/roles/coder/execution',
      body: JSON.stringify({ provider: 'openai-oauth', model: 'gpt-5.6-sol', reasoningEffort: 'high' }),
    }, res);
    expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
    expect(jsonBody(res).error).toMatch(/not available/);
    expect(mocks.setSkillExecutionOverride).not.toHaveBeenCalled();
  });

  it('rejects a structurally valid non-OAuth pair absent from its provider catalog', async () => {
    const res = response();
    await handle({
      method: 'PATCH', url: '/api/roles/coder/execution',
      body: JSON.stringify({ provider: 'anthropic', model: 'forged-model', reasoningEffort: 'high' }),
    }, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(jsonBody(res).error).toMatch(/not available from provider/);
    expect(mocks.setSkillExecutionOverride).not.toHaveBeenCalled();
  });
});
