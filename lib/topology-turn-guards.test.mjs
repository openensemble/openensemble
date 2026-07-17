import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentsForUser: vi.fn(),
  getUser: vi.fn(),
  resolveRuntimeAgentForUser: vi.fn(),
  runAgentWithRetry: vi.fn(),
  streamChat: vi.fn(),
  appendToSession: vi.fn(),
}));

vi.mock('../routes/_helpers.mjs', () => ({
  getAgentsForUser: mocks.getAgentsForUser,
  getUser: mocks.getUser,
  getUserCoordinatorAgentId: vi.fn(() => 'primary'),
  resolveRuntimeAgentForUser: mocks.resolveRuntimeAgentForUser,
}));

vi.mock('../chat.mjs', () => ({ streamChat: mocks.streamChat }));
vi.mock('./run-agent-with-retry.mjs', () => ({
  runAgentWithRetry: mocks.runAgentWithRetry,
}));
vi.mock('../sessions.mjs', () => ({ appendToSession: mocks.appendToSession }));

import { _topologyForTests as proposalRunners } from './proposals.mjs';
import { _forTests as mcpForTests } from './mcp-outbound.mjs';
import {
  finishUserTopologyTransition,
  getCurrentUserTopologyLease,
  getUserTopologyState,
  tryAcquireUserTopologyTransition,
} from '../chat-dispatch/slot-registry.mjs';
import { getTurnContext } from './turn-abort-context.mjs';
import { currentTaskContext } from './task-proxy-context.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const builder = {
  id: 'primary',
  name: 'Primary',
  tools: [
    { function: { name: 'skill_create' } },
    { function: { name: 'skill_patch_code' } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentsForUser.mockReturnValue([builder]);
  mocks.getUser.mockReturnValue({ id: 'test-user', name: 'Test User' });
  mocks.resolveRuntimeAgentForUser.mockImplementation((_userId, agentId) => ({
    ...builder,
    id: agentId === 'parked' ? 'primary' : agentId,
  }));
});

describe('proposal autonomous turns hold topology read leases', () => {
  const cases = [
    {
      name: 'accepted agent',
      slug: 'accepted',
      run: proposalRunners.runAcceptedAgent,
      record: userId => ({
        id: `accepted-${userId}`,
        userId,
        agentId: 'primary',
        kind: 'recurring_task',
        message: 'run this daily',
      }),
    },
    {
      name: 'tool-failure remedy',
      slug: 'remedy',
      run: proposalRunners.runToolFailureRemedy,
      record: userId => ({
        id: `remedy-${userId}`,
        userId,
        agentId: 'primary',
        tool: 'custom_tool',
        skillId: 'custom_skill',
        isUserSkill: true,
        recentErrors: ['boom'],
        count: 3,
      }),
    },
    {
      name: 'skill proposal',
      slug: 'create',
      run: proposalRunners.runSkillProposal,
      record: userId => ({
        id: `create-${userId}`,
        userId,
        agentId: 'primary',
        userTrigger: 'do the workflow',
        agentSummary: 'done',
        toolNames: ['one', 'two'],
      }),
    },
    {
      name: 'skill refine',
      slug: 'refine',
      run: proposalRunners.runSkillRefine,
      record: userId => ({
        id: `refine-${userId}`,
        userId,
        agentId: 'primary',
        skillId: 'custom_skill',
        invocations: 5,
        corrections: 2,
        recentCorrections: ['use a shorter answer'],
      }),
    },
  ];

  it.each(cases)('blocks a topology writer for the full $name LLM run', async ({ run, record, slug }) => {
    const userId = `proposal-topology-${slug}`;
    const llm = deferred();
    mocks.runAgentWithRetry.mockReturnValueOnce(llm.promise);

    const pending = run(record(userId));
    await vi.waitFor(() => expect(mocks.runAgentWithRetry).toHaveBeenCalledOnce());

    expect(getUserTopologyState(userId)).toEqual({ readers: 1, writer: false });
    expect(getCurrentUserTopologyLease()).toBeNull();
    expect(tryAcquireUserTopologyTransition(userId)).toBeNull();

    llm.resolve({ succeeded: false, lastError: 'expected test stop' });
    await pending;
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('waits for an in-progress writer before starting a proposal LLM run', async () => {
    const userId = 'proposal-topology-retry';
    const writer = tryAcquireUserTopologyTransition(userId);
    expect(writer).toBeTruthy();
    mocks.runAgentWithRetry.mockResolvedValueOnce({ succeeded: false, lastError: 'expected test stop' });

    const pending = proposalRunners.runAcceptedAgent({
      id: 'accepted-retry', userId, agentId: 'primary',
      kind: 'recurring_task', message: 'run this daily',
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(mocks.runAgentWithRetry).not.toHaveBeenCalled();

    finishUserTopologyTransition(writer);
    await pending;
    expect(mocks.runAgentWithRetry).toHaveBeenCalledOnce();
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });
});

describe('external MCP isolated turns hold topology read leases', () => {
  it('binds a task-owned abort signal and releases a noncooperative stream on disconnect', async () => {
    const userId = 'mcp-client-disconnect';
    const started = deferred();
    let observed = null;
    mocks.streamChat.mockImplementationOnce(async function* (_agent, _message, signal) {
      observed = {
        signal,
        ambientSignal: getTurnContext()?.signal,
        task: currentTaskContext(),
      };
      started.resolve();
      await new Promise(() => {});
    });
    const client = new AbortController();
    const pending = mcpForTests.runIsolatedTurn({
      agent: builder,
      userId,
      message: 'wait until the client leaves',
      clientSignal: client.signal,
    });

    await started.promise;
    expect(observed.signal).toBe(observed.ambientSignal);
    expect(observed.task).toMatchObject({
      userId,
      agentId: `${userId}_primary`,
      visibleAgentId: `${userId}_primary`,
    });
    expect(observed.task.taskId).toMatch(/^mcp_turn_/);
    expect(getUserTopologyState(userId)).toEqual({ readers: 1, writer: false });

    client.abort('test disconnect');
    await expect(pending).rejects.toThrow('Client disconnected; agent turn aborted');
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('fails closed when an agent-bound token points at a parked specialist', async () => {
    const userId = 'mcp-bound-parked';
    const roster = await mcpForTests.loadRoster(userId, 'parked');
    expect(roster.effectiveBoundAgentId).toBeNull();
    const names = mcpForTests.buildToolDefs({
      id: 'token-bound', userId, name: 'Bound token', scopes: ['chat'], agentId: 'parked',
    }, roster).map(tool => tool.name);
    expect(names).toEqual(['list_agents']);
  });

  it('reloads the roster only after a topology writer releases', async () => {
    const userId = 'mcp-call-live-roster';
    const writer = tryAcquireUserTopologyTransition(userId);
    expect(writer).toBeTruthy();
    mocks.getAgentsForUser.mockClear();
    mocks.getAgentsForUser.mockReturnValue([{ ...builder, id: 'after-transition' }]);

    const pending = mcpForTests.callTool({
      tokenRec: { id: 'token-live', userId, name: 'Live token', scopes: ['chat'], agentId: null },
      name: 'list_agents',
      args: {},
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(mocks.getAgentsForUser).not.toHaveBeenCalled();

    finishUserTopologyTransition(writer);
    const result = JSON.parse(await pending);
    expect(result.map(agent => agent.id)).toEqual(['after-transition']);
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('does not reinterpret a bound-agent call after the bound agent is parked', async () => {
    const userId = 'mcp-bound-transition';
    const writer = tryAcquireUserTopologyTransition(userId);
    expect(writer).toBeTruthy();
    mocks.getAgentsForUser.mockReturnValue([{ ...builder, id: 'new-primary' }]);

    const pending = mcpForTests.callTool({
      tokenRec: { id: 'token-parked', userId, name: 'Parked token', scopes: ['chat'], agentId: 'parked' },
      name: 'ask_coordinator',
      args: { message: 'do something privileged' },
    });
    finishUserTopologyTransition(writer);

    await expect(pending).rejects.toThrow(/bound agent is no longer available/i);
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('re-resolves a parked agent under the lease and blocks writers until the stream ends', async () => {
    const userId = 'mcp-topology-parked';
    const streamStarted = deferred();
    const finishStream = deferred();
    let streamedAgent = null;
    let resolverLease = null;
    mocks.resolveRuntimeAgentForUser.mockImplementationOnce((_userId, agentId) => {
      resolverLease = getCurrentUserTopologyLease();
      return { ...builder, id: agentId === 'parked' ? 'primary' : agentId };
    });
    mocks.streamChat.mockImplementationOnce(async function* (agent) {
      streamedAgent = agent;
      streamStarted.resolve();
      await finishStream.promise;
      yield { type: '__content', content: 'done' };
    });

    const pending = mcpForTests.runIsolatedTurn({
      agent: { ...builder, id: 'parked' },
      userId,
      message: 'hello',
    });
    await streamStarted.promise;

    expect(resolverLease).toMatchObject({ userId, mode: 'read', label: 'external-mcp-turn' });
    expect(mocks.resolveRuntimeAgentForUser).toHaveBeenCalledWith(userId, 'parked');
    expect(streamedAgent.id).toBe(`${userId}_primary`);
    expect(getUserTopologyState(userId)).toEqual({ readers: 1, writer: false });
    expect(tryAcquireUserTopologyTransition(userId)).toBeNull();

    finishStream.resolve();
    await expect(pending).resolves.toBe('done');
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('waits for an in-progress writer before resolving or streaming an MCP agent', async () => {
    const userId = 'mcp-topology-retry';
    const writer = tryAcquireUserTopologyTransition(userId);
    expect(writer).toBeTruthy();
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: '__content', content: 'done after transition' };
    });

    const pending = mcpForTests.runIsolatedTurn({
      agent: { ...builder, id: 'parked' },
      userId,
      message: 'hello',
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(mocks.resolveRuntimeAgentForUser).not.toHaveBeenCalled();
    expect(mocks.streamChat).not.toHaveBeenCalled();

    finishUserTopologyTransition(writer);
    await expect(pending).resolves.toBe('done after transition');
    expect(mocks.resolveRuntimeAgentForUser).toHaveBeenCalledWith(userId, 'parked');
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });
});
