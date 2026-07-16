import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  providerTools: [],
  recoverableTools: [],
  trimInputTools: [],
  buildAgentContext: vi.fn(async () => ({
    systemInstructions: 'standing owner rule',
    userContext: 'standing owner preference',
    episodeHistory: '',
  })),
  formatContext: vi.fn(() => 'standing context'),
  addToSessionBuffer: vi.fn(),
  processSignals: vi.fn(async () => ({})),
  appendToSession: vi.fn(async () => {}),
  trackFriction: vi.fn(async () => {}),
  recordTurnRouting: vi.fn(async () => {}),
  learnToolPlanFromTurn: vi.fn(() => ({ learned: true })),
  routineFlush: vi.fn(async () => {}),
  routinePropose: vi.fn(async () => {}),
  recordRunTrace: vi.fn(),
  turn: null,
}));

const tool = name => ({
  type: 'function',
  function: { name, description: `${name} test tool`, parameters: { type: 'object', properties: {} } },
});

vi.mock('./memory.mjs', () => ({
  buildAgentContext: state.buildAgentContext,
  formatContext: state.formatContext,
  addToSessionBuffer: state.addToSessionBuffer,
  processSignals: state.processSignals,
}));

vi.mock('./memory/signals.mjs', () => ({ trackFriction: state.trackFriction }));

vi.mock('./sessions.mjs', () => ({
  loadSession: vi.fn(async () => []),
  appendToSession: state.appendToSession,
  loadCrossAgentContext: vi.fn(async () => []),
}));

vi.mock('./lib/tool-router.mjs', () => ({
  trimToolsForTurn: vi.fn(async ({ agent }) => {
    state.trimInputTools = agent.tools.map(t => t.function.name);
    // Simulate a future/router plugin accidentally returning broader sets.
    // streamChat must reapply the worker boundary to both arrays.
    return {
      trimmedTools: [...agent.tools, tool('remember_fact')],
      fullTools: [...agent.tools, tool('remember_fact'), tool('create_agent'), tool('mcp_add_server')],
      initiallyIncludedSkills: new Set(['coordinator']),
      skillsKept: new Set(['coordinator']),
      routerNotes: [],
    };
  }),
  recordTurnRouting: state.recordTurnRouting,
  expandToolsByReason: vi.fn(async () => ({ addedToolNames: [], addedSkills: [] })),
  inferMissingToolSkills: vi.fn(() => new Set()),
  shouldUseProviderHostedImageBackend: vi.fn(() => false),
}));

vi.mock('./lib/tool-plan-memory.mjs', () => ({
  learnToolPlanFromTurn: state.learnToolPlanFromTurn,
}));

vi.mock('./lib/routine-proposer.mjs', () => ({
  flushPendingRoutineCandidate: state.routineFlush,
  maybeProposeRoutine: state.routinePropose,
}));

vi.mock('./lib/run-inspector.mjs', async importOriginal => ({
  ...(await importOriginal()),
  recordRunTrace: state.recordRunTrace,
}));

vi.mock('./lib/turn-trace-context.mjs', () => ({
  getTurn: vi.fn(() => state.turn),
  beginTurn: vi.fn(input => { state.turn = { turnId: 'worker-turn', rootId: input.rootId }; }),
  recordSpan: vi.fn(),
  recordError: vi.fn(),
  finishTurn: vi.fn(() => { state.turn = null; return null; }),
}));

vi.mock('./routes/_helpers.mjs', () => ({
  getAgentForUser: vi.fn(async (agentId, userId) => ({ id: agentId, ownerId: userId })),
}));

vi.mock('./roles.mjs', () => ({ getSelectedPlanKeepTools: vi.fn(() => []) }));

vi.mock('./chat/providers/ollama.mjs', () => ({
  streamOllama: vi.fn(async function* (agent) {
    state.providerTools = agent.tools.map(t => t.function.name);
    const { getToolRouterContext } = await import('./lib/tool-router-context.mjs');
    state.recoverableTools = (getToolRouterContext()?.fullTools ?? []).map(t => t.function.name);
    yield { type: 'token', text: 'worker complete' };
    yield { type: '__content', content: 'worker complete' };
  }),
}));

const { streamChat } = await import('./chat.mjs');
const { WORKER_LEAF_FORBIDDEN_TOOL_NAMES } = await import('./lib/worker-memory-policy.mjs');

async function collect(gen) {
  const events = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('validated worker stream contract', () => {
  beforeEach(() => {
    state.providerTools = [];
    state.recoverableTools = [];
    state.trimInputTools = [];
    state.turn = null;
    for (const value of Object.values(state)) {
      if (typeof value?.mockClear === 'function') value.mockClear();
    }
  });

  it('ships and recovers only task tools, reads standing owner context, and performs no learning writes', async () => {
    const retained = ['report_progress', 'request_tools', 'recall_facts', 'email_send', 'create_document'];
    const agent = {
      id: 'ephemeral_worker_contract_test',
      workerOwnerId: 'jarvis',
      ephemeral: true,
      name: 'Task Worker',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'Complete only the assigned task.',
      tools: [...WORKER_LEAF_FORBIDDEN_TOOL_NAMES, ...retained].map(tool),
    };
    const turnOpts = {
      isolatedTaskRun: true,
      workerMemoryAgentId: 'jarvis',
      rootTaskId: 'worker-contract-root',
      traceSource: 'background',
    };

    const events = await collect(streamChat(
      agent,
      'Complete the bounded task.',
      null,
      null,
      'worker-contract-user',
      null,
      null,
      false,
      null,
      turnOpts,
    ));

    expect(state.trimInputTools).toEqual(retained);
    expect(state.providerTools).toEqual(retained);
    expect(state.recoverableTools).toEqual(retained);
    for (const forbidden of WORKER_LEAF_FORBIDDEN_TOOL_NAMES) {
      expect(state.providerTools).not.toContain(forbidden);
      expect(state.recoverableTools).not.toContain(forbidden);
    }
    expect(state.buildAgentContext).toHaveBeenCalledWith(
      'jarvis',
      'Complete the bounded task.',
      'worker-contract-user',
      { includeEpisodes: false },
    );
    expect(events).toEqual(expect.arrayContaining([
      { type: 'token', text: 'worker complete' },
      { type: '__content', content: 'worker complete' },
      { type: 'done' },
    ]));

    // Operational traces remain, but no worker session, Cortex, proposal, or
    // routing-recipe state may be written from this detached prompt.
    expect(state.recordRunTrace).toHaveBeenCalledOnce();
    expect(state.appendToSession).not.toHaveBeenCalled();
    expect(state.trackFriction).not.toHaveBeenCalled();
    expect(state.routineFlush).not.toHaveBeenCalled();
    expect(state.routinePropose).not.toHaveBeenCalled();
    expect(state.addToSessionBuffer).not.toHaveBeenCalled();
    expect(state.processSignals).not.toHaveBeenCalled();
    expect(state.recordTurnRouting).not.toHaveBeenCalled();
    expect(state.learnToolPlanFromTurn).not.toHaveBeenCalled();
  });
});
