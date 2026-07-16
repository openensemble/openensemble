import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}));

// A stale ask_agent call must be rejected before any delegated/isolated model
// turn begins. The successful ensemble MCP assertion below uses this same spy
// to prove that restoring the setting restores the normal execution path.
vi.mock('./chat.mjs', () => ({ streamChat: mocks.streamChat }));

const { SKILLS_DIR, USERS_DIR } = await import('./lib/paths.mjs');
const { saveUser } = await import('./routes/_helpers.mjs');
const { createCustomAgent, listAgents } = await import('./agents.mjs');
const { loadRoleManifests } = await import('./roles.mjs');
const { getAgentsForUser } = await import('./routes/_helpers/agent-resolver.mjs');
const { getOrchestrationPolicy, setOrchestrationPolicy } = await import('./lib/orchestration-policy.mjs');
const { trimToolsForTurn } = await import('./lib/tool-router.mjs');
const { toolRouterContext } = await import('./lib/tool-router-context.mjs');
const { default: executeCoordinatorTool } = await import('./skills/coordinator/execute.mjs');
const { executeSkillTool } = await import('./skills/delegate/execute.mjs');
const { _forTests: mcpForTests } = await import('./lib/mcp-outbound.mjs');

const USER = 'ask_agent_mode_roundtrip';
let primaryId;

function names(tools) {
  return (tools ?? []).map(tool => tool?.function?.name ?? tool?.name).filter(Boolean);
}

async function collect(iterator) {
  const events = [];
  for await (const event of iterator) events.push(event);
  return events;
}

async function routed(agent) {
  return trimToolsForTurn({
    agent,
    userId: USER,
    // Short input deliberately skips semantic classification. This checks the
    // stable control-plane floor rather than an intent-specific coincidence.
    userText: 'hello',
    source: 'web',
  });
}

beforeAll(() => {
  // roles.mjs reads from the test-isolated SKILLS_DIR. Point it at the shipped
  // manifests so this regression exercises the real coordinator/delegate
  // schemas and request_tools implementation.
  fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
  fs.symlinkSync(path.resolve('skills'), SKILLS_DIR, 'dir');
  loadRoleManifests();

  fs.mkdirSync(path.join(USERS_DIR, USER), { recursive: true });
  saveUser({
    id: USER,
    name: 'Ask Agent Mode Roundtrip',
    role: 'user',
    skills: ['coordinator', 'delegate'],
    skillAssignments: {},
    orchestration: { mode: 'ensemble' },
  });
  primaryId = createCustomAgent({
    name: 'Roundtrip Jarvis',
    emoji: 'R',
    description: 'one-agent ensemble fixture',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'web',
    systemPrompt: 'Roundtrip fixture.',
    ownerId: USER,
  }).id;
  saveUser({
    id: USER,
    name: 'Ask Agent Mode Roundtrip',
    role: 'user',
    skills: ['coordinator', 'delegate'],
    skillAssignments: { coordinator: primaryId },
    orchestration: { mode: 'ensemble', primaryAgentId: primaryId },
  });
});

describe('ask_agent follows the stored orchestration setting', () => {
  it('round-trips one account ensemble -> single -> ensemble across chat, request_tools, routing, execution, and MCP', async () => {
    const tokenRec = {
      id: 'ask-agent-mode-token',
      userId: USER,
      name: 'Ask Agent Mode Token',
      scopes: ['chat'],
      agentId: null,
    };

    // The starting account is explicitly ensemble despite owning one agent.
    // Cardinality must not silently switch off delegation.
    await setOrchestrationPolicy(USER, { mode: 'ensemble', primaryAgentId: primaryId });
    expect(getOrchestrationPolicy(USER).mode).toBe('ensemble');
    expect(listAgents().filter(agent => agent.ownerId === USER)).toHaveLength(1);

    let resolved = getAgentsForUser(USER)[0];
    expect(resolved._rosterSolo).toBe(false);
    expect(names(resolved.tools)).toEqual(expect.arrayContaining([
      'ask_agent', 'request_tools', 'spawn_worker', 'check_workers',
    ]));
    expect(resolved.tools.find(tool => tool.function?.name === 'request_tools')?.function?.description)
      .toContain('ask_agent');
    expect(resolved.systemPrompt).toContain('## Delegate, don\'t answer from training');
    expect(resolved.systemPrompt).toContain('Multiple `ask_agent` delegations');
    let route = await routed(resolved);
    expect(names(route.fullTools)).toContain('ask_agent');
    expect(names(route.trimmedTools)).toContain('ask_agent');

    let mcpRoster = await mcpForTests.loadRoster(USER);
    expect(mcpRoster.orchestrationMode).toBe('ensemble');
    expect(mcpForTests.buildToolDefs(tokenRec, mcpRoster).map(tool => tool.name))
      .toEqual(['ask_coordinator', 'ask_agent', 'list_agents']);

    await setOrchestrationPolicy(USER, { mode: 'single', primaryAgentId: primaryId });
    expect(getOrchestrationPolicy(USER).mode).toBe('single');

    resolved = getAgentsForUser(USER)[0];
    expect(resolved._rosterSolo).toBe(true);
    expect(names(resolved.tools)).not.toContain('ask_agent');
    expect(names(resolved.tools)).toEqual(expect.arrayContaining([
      'request_tools', 'spawn_worker', 'check_workers',
    ]));
    expect(resolved.tools.find(tool => tool.function?.name === 'request_tools')?.function?.description)
      .not.toContain('ask_agent');
    expect(resolved.systemPrompt).toContain('## Single-assistant execution');
    expect(resolved.systemPrompt).not.toContain('## Delegate, don\'t answer from training');
    expect(resolved.systemPrompt).not.toContain('Multiple `ask_agent` delegations');
    route = await routed(resolved);
    expect(names(route.fullTools)).not.toContain('ask_agent');
    expect(names(route.trimmedTools)).not.toContain('ask_agent');

    // Exercise request_tools itself against the single-mode recoverable set.
    // Even an explicit request for the delegate group cannot resurrect the
    // removed named-agent schema; worker controls remain available.
    const routerStore = {
      agent: { ...resolved, tools: route.trimmedTools.slice() },
      fullTools: route.fullTools,
      initiallyIncludedSkills: new Set(),
      keptSkills: route.skillsKept ?? new Set(),
      addedSkills: new Set(),
      recoveryLoads: [],
    };
    await toolRouterContext.run(routerStore, () => collect(executeCoordinatorTool(
      'request_tools',
      { groups: ['delegate'] },
      USER,
      primaryId,
    )));
    expect(names(routerStore.agent.tools)).not.toContain('ask_agent');
    expect(names(routerStore.agent.tools)).toEqual(expect.arrayContaining([
      'spawn_worker', 'check_workers',
    ]));
    const singleNoMatch = await toolRouterContext.run(routerStore, () => collect(executeCoordinatorTool(
      'request_tools',
      { groups: ['not-a-real-skill'] },
      USER,
      primaryId,
    )));
    expect(singleNoMatch.at(-1)?.text).toContain('spawn_worker');
    expect(singleNoMatch.at(-1)?.text).not.toContain('ask_agent');

    // Simulate an in-chat provider replaying a schema it received before the
    // switch. The execution gate must stop before streamChat or background
    // delegation machinery can start.
    const staleChatCall = await collect(executeSkillTool(
      'ask_agent',
      { agent_id: primaryId, task: 'This stale call must not run.' },
      USER,
      `${USER}_${primaryId}`,
    ));
    expect(staleChatCall).toHaveLength(1);
    expect(staleChatCall[0].text).toContain('single agent');
    expect(mocks.streamChat).not.toHaveBeenCalled();

    mcpRoster = await mcpForTests.loadRoster(USER);
    expect(mcpRoster.orchestrationMode).toBe('single');
    const singleMcpDefs = mcpForTests.buildToolDefs(tokenRec, mcpRoster);
    expect(singleMcpDefs.map(tool => tool.name)).toEqual(['ask_coordinator', 'list_agents']);
    expect(singleMcpDefs.find(tool => tool.name === 'ask_coordinator')?.description)
      .toContain('background workers');
    await expect(mcpForTests.callTool({
      tokenRec,
      name: 'ask_agent',
      args: { agent_id: primaryId, message: 'This cached MCP call must not run.' },
    })).rejects.toThrow(/single-agent mode/i);
    expect(mocks.streamChat).not.toHaveBeenCalled();

    // Switch the SAME account back without restating primaryAgentId. D5 keeps
    // that stored assignment, and every named-delegation surface comes back.
    await setOrchestrationPolicy(USER, { mode: 'ensemble' });
    expect(getOrchestrationPolicy(USER)).toEqual({ mode: 'ensemble', primaryAgentId: primaryId });
    resolved = getAgentsForUser(USER)[0];
    expect(resolved._rosterSolo).toBe(false);
    expect(names(resolved.tools)).toContain('ask_agent');
    expect(resolved.tools.find(tool => tool.function?.name === 'request_tools')?.function?.description)
      .toContain('ask_agent');
    expect(resolved.systemPrompt).toContain('## Delegate, don\'t answer from training');
    expect(resolved.systemPrompt).toContain('Multiple `ask_agent` delegations');
    route = await routed(resolved);
    expect(names(route.fullTools)).toContain('ask_agent');
    expect(names(route.trimmedTools)).toContain('ask_agent');
    const ensembleNoMatchStore = {
      agent: { ...resolved, tools: route.trimmedTools.slice() },
      fullTools: route.fullTools,
      initiallyIncludedSkills: new Set(),
      keptSkills: route.skillsKept ?? new Set(),
      addedSkills: new Set(),
      recoveryLoads: [],
    };
    const ensembleNoMatch = await toolRouterContext.run(ensembleNoMatchStore, () => collect(executeCoordinatorTool(
      'request_tools',
      { groups: ['not-a-real-skill'] },
      USER,
      primaryId,
    )));
    expect(ensembleNoMatch.at(-1)?.text).toContain('ask_agent');

    const restoredChatCall = await collect(executeSkillTool(
      'ask_agent',
      { agent_id: 'missing_specialist', task: 'Use the normal resolution ladder.' },
      USER,
      `${USER}_${primaryId}`,
    ));
    expect(restoredChatCall[0].text).toMatch(/not found/i);
    expect(restoredChatCall[0].text).not.toContain('single agent');
    expect(mocks.streamChat).not.toHaveBeenCalled();

    mcpRoster = await mcpForTests.loadRoster(USER);
    expect(mcpRoster.orchestrationMode).toBe('ensemble');
    expect(mcpForTests.buildToolDefs(tokenRec, mcpRoster).map(tool => tool.name))
      .toEqual(['ask_coordinator', 'ask_agent', 'list_agents']);

    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: '__content', content: 'ensemble execution restored' };
    });
    await expect(mcpForTests.callTool({
      tokenRec,
      name: 'ask_agent',
      args: { agent_id: primaryId, message: 'Prove the restored execution path.' },
    })).resolves.toBe('ensemble execution restored');
    expect(mocks.streamChat).toHaveBeenCalledOnce();
  });
});
