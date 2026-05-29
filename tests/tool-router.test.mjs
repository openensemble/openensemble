// Unit tests for the per-turn tool-routing trim logic.
//
// We mock listRoles + classifyByEmbedding so the test doesn't need the real
// manifest cache or the bundled embedder GGUF. The unit under test is the
// keep-set composition: always-on skills always pass; on-demand skills pass
// only when classifyByEmbedding returns a hit.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../roles.mjs', () => {
  const manifests = [
    { id: 'coordinator', tools: [
      { function: { name: 'ask_agent', description: 'd', parameters: {} } },
      { function: { name: 'create_agent', description: 'd', parameters: {} } },
      { function: { name: 'request_tools', description: 'd', parameters: {} } },
    ] },
    { id: 'self-mgmt', tools: [
      { function: { name: 'remember_fact', description: 'd', parameters: {} } },
    ] },
    { id: 'web', tools: [
      { function: { name: 'web_search', description: 'd', parameters: {} } },
    ] },
    { id: 'tasks', tools: [
      { function: { name: 'set_reminder', description: 'd', parameters: {} } },
      { function: { name: 'list_tasks', description: 'd', parameters: {} } },
    ] },
    // On-demand skills.
    { id: 'email', service: true, tools: [
      { function: { name: 'email_list', description: 'd', parameters: {} } },
      { function: { name: 'email_compose', description: 'd', parameters: {} } },
    ] },
    { id: 'role_home_assistant', service: true, tools: [
      { function: { name: 'ha_call_service', description: 'd', parameters: {} } },
      { function: { name: 'ha_get_state', description: 'd', parameters: {} } },
    ] },
    { id: 'oe-admin', service: true, tools: [
      { function: { name: 'install_integration', description: 'd', parameters: {} } },
    ] },
    // Custom user skill — default scope (include) → always-on like other custom.
    { id: 'my_custom_skill', custom: true, tools: [
      { function: { name: 'my_custom_tool', description: 'd', parameters: {} } },
    ] },
    // Custom user skill with coordinator_scope='auto' → only included when
    // intent matches.
    { id: 'kroger_deals', custom: true, coordinator_scope: 'auto',
      intent_examples: ['kroger deals this week', 'snack deals at kroger'],
      tools: [
        { function: { name: 'kroger_check_deals', description: 'd', parameters: {} } },
      ] },
  ];
  return {
    listRoles: vi.fn(() => manifests),
    getRoleManifest: vi.fn((id) => manifests.find(m => m.id === id)),
  };
});

// Mocked classifier — returns whatever the test sets.
let _mockedTop = null;
vi.mock('../lib/specialist-embed-router.mjs', () => ({
  classifyByEmbedding: vi.fn(async () => _mockedTop),
}));

const { trimToolsForTurn, expandToolsByReason } = await import('../lib/tool-router.mjs');

function buildAgent(toolNames) {
  return {
    skillCategory: 'coordinator',
    tools: toolNames.map(n => ({ type: 'function', function: { name: n, description: 'x', parameters: { type: 'object', properties: {} } } })),
  };
}

const ALL_TOOLS = [
  'ask_agent', 'create_agent', 'request_tools',
  'remember_fact', 'web_search',
  'set_reminder', 'list_tasks',
  'email_list', 'email_compose',
  'ha_call_service', 'ha_get_state',
  'install_integration',
  'my_custom_tool',
  'kroger_check_deals',
];

describe('trimToolsForTurn', () => {
  beforeEach(() => { _mockedTop = null; });

  it('keeps always-on tools + default-scoped custom tools when classifier misses', async () => {
    const agent = buildAgent(ALL_TOOLS);
    const r = await trimToolsForTurn({ agent, userText: 'hi there', userId: 'u1' });
    const names = r.trimmedTools.map(t => t.function.name).sort();
    // Always-on built-in + my_custom_tool (default-scope). kroger_check_deals
    // is custom + coordinator_scope='auto', so it's NOT in the always-on set
    // and the classifier missed it on this prompt.
    expect(names).toEqual([
      'ask_agent', 'create_agent', 'list_tasks',
      'my_custom_tool', 'remember_fact', 'request_tools',
      'set_reminder', 'web_search',
    ]);
    expect(names).not.toContain('email_list');
    expect(names).not.toContain('ha_call_service');
    expect(names).not.toContain('install_integration');
    expect(names).not.toContain('kroger_check_deals');
  });

  it('loads custom-auto skill tools when classifier picks the skill', async () => {
    _mockedTop = { skillId: 'kroger_deals', sim: 0.8, agentId: null, name: 'Kroger Deals' };
    const agent = buildAgent(ALL_TOOLS);
    const r = await trimToolsForTurn({ agent, userText: 'are eggs on sale at kroger', userId: 'u1' });
    const names = r.trimmedTools.map(t => t.function.name);
    expect(names).toContain('kroger_check_deals');
    expect(r.initiallyIncludedSkills.has('kroger_deals')).toBe(true);
  });

  it('includes email tools when classifier hits email', async () => {
    _mockedTop = { skillId: 'email', sim: 0.8, agentId: 'email-spec', name: 'Email' };
    const agent = buildAgent(ALL_TOOLS);
    const r = await trimToolsForTurn({ agent, userText: 'check my email', userId: 'u1' });
    const names = r.trimmedTools.map(t => t.function.name);
    expect(names).toContain('email_list');
    expect(names).toContain('email_compose');
    expect(names).not.toContain('ha_call_service');
    expect(r.initiallyIncludedSkills.has('email')).toBe(true);
  });

  it('skips trim for non-coordinator agents', async () => {
    const agent = { skillCategory: 'email', tools: [
      { type: 'function', function: { name: 'email_list', description: 'x', parameters: {} } },
    ] };
    const r = await trimToolsForTurn({ agent, userText: 'hi', userId: 'u1' });
    expect(r.trimmedTools).toBe(agent.tools);
  });

  it('does not mutate the input agent', async () => {
    const agent = buildAgent(ALL_TOOLS);
    const before = agent.tools;
    await trimToolsForTurn({ agent, userText: 'hi', userId: 'u1' });
    expect(agent.tools).toBe(before);
  });

  it('preserves the full set for later expansion', async () => {
    const agent = buildAgent(ALL_TOOLS);
    const r = await trimToolsForTurn({ agent, userText: 'hi', userId: 'u1' });
    expect(r.fullTools.length).toBe(ALL_TOOLS.length);
  });
});

describe('expandToolsByReason', () => {
  beforeEach(() => { _mockedTop = null; });

  it('adds matched on-demand tools to agent.tools (mutates)', async () => {
    _mockedTop = { skillId: 'role_home_assistant', sim: 0.7, agentId: 'ha-spec', name: 'HA' };
    const agent = buildAgent(['ask_agent', 'request_tools']);
    const fullTools = ALL_TOOLS.map(n => ({ type: 'function', function: { name: n, description: 'x', parameters: { type: 'object', properties: {} } } }));
    const r = await expandToolsByReason({
      agent, fullTools, reason: 'turn off the lights', groups: null, userId: 'u1',
      alreadyIncludedSkills: new Set(),
    });
    expect(r.addedToolNames.sort()).toEqual(['ha_call_service', 'ha_get_state']);
    expect(r.addedSkills).toContain('role_home_assistant');
    const finalNames = agent.tools.map(t => t.function.name);
    expect(finalNames).toContain('ha_call_service');
    expect(finalNames).toContain('ask_agent'); // original kept
  });

  it('respects explicit `groups` even when reason is missing', async () => {
    const agent = buildAgent(['ask_agent']);
    const fullTools = ALL_TOOLS.map(n => ({ type: 'function', function: { name: n, description: 'x', parameters: { type: 'object', properties: {} } } }));
    const r = await expandToolsByReason({
      agent, fullTools, reason: null, groups: ['email'], userId: 'u1',
      alreadyIncludedSkills: new Set(),
    });
    expect(r.addedToolNames.sort()).toEqual(['email_compose', 'email_list']);
  });

  it('does not re-add tools that are already present', async () => {
    _mockedTop = { skillId: 'email', sim: 0.9, agentId: 'email-spec', name: 'Email' };
    const agent = buildAgent(['ask_agent', 'email_list']);
    const fullTools = ALL_TOOLS.map(n => ({ type: 'function', function: { name: n, description: 'x', parameters: { type: 'object', properties: {} } } }));
    const r = await expandToolsByReason({
      agent, fullTools, reason: 'check email', groups: null, userId: 'u1',
      alreadyIncludedSkills: new Set(),
    });
    // email_list already present; only email_compose should be added.
    expect(r.addedToolNames).toEqual(['email_compose']);
  });

  it('skips skills already in alreadyIncludedSkills', async () => {
    _mockedTop = { skillId: 'email', sim: 0.9, agentId: 'email-spec', name: 'Email' };
    const agent = buildAgent(['ask_agent']);
    const fullTools = ALL_TOOLS.map(n => ({ type: 'function', function: { name: n, description: 'x', parameters: { type: 'object', properties: {} } } }));
    const r = await expandToolsByReason({
      agent, fullTools, reason: 'check email', groups: null, userId: 'u1',
      alreadyIncludedSkills: new Set(['email']),
    });
    expect(r.addedToolNames).toEqual([]);
  });
});
