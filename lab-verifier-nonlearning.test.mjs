import { afterEach, describe, expect, it, vi } from 'vitest';

const memoryMocks = vi.hoisted(() => ({
  buildAgentContext: vi.fn(async () => ({ memories: [] })),
  formatContext: vi.fn(() => ''),
  addToSessionBuffer: vi.fn(),
  processSignals: vi.fn(async () => ({ remembered: true, factText: 'should not be stored' })),
}));

const signalMocks = vi.hoisted(() => ({
  trackFriction: vi.fn(async () => {}),
}));

const sessionMocks = vi.hoisted(() => ({
  appendToSession: vi.fn(async () => {}),
  loadSession: vi.fn(async () => []),
  loadCrossAgentContext: vi.fn(async () => []),
}));

const providerMocks = vi.hoisted(() => ({
  streamOllama: vi.fn(async function* () {
    yield {
      type: 'tool_call', name: 'read_live_data', args: {},
      toolCallId: 'provider-call-live-391', providerNative: true,
    };
    yield {
      type: 'tool_result', name: 'read_live_data', text: 'live value: 391',
      toolCallId: 'provider-call-live-391', providerNative: true,
    };
    yield { type: 'token', text: '391' };
    yield {
      type: '__usage', inputTokens: 100, outputTokens: 1,
      reqCount: 1, completionCount: 1, usageCount: 1, usageComplete: true,
      provider: 'ollama', model: 'test-model',
    };
    yield { type: '__content', content: '391' };
  }),
}));

const routerMocks = vi.hoisted(() => ({
  trimToolsForTurn: vi.fn(async ({ agent }) => ({
    fullTools: agent.tools,
    trimmedTools: agent.tools,
    initiallyIncludedSkills: new Set(['coordinator']),
    skillsKept: new Set(['coordinator']),
    routerNotes: ['test-router'],
  })),
  recordTurnRouting: vi.fn(async () => {}),
  expandToolsByReason: vi.fn(async () => ({ added: [] })),
  inferMissingToolSkills: vi.fn(async () => []),
  shouldUseProviderHostedImageBackend: vi.fn(() => false),
}));

const toolPlanMocks = vi.hoisted(() => ({
  learnToolPlanFromTurn: vi.fn(() => ({ learned: true })),
}));

vi.mock('./memory.mjs', () => memoryMocks);
vi.mock('./memory/signals.mjs', () => signalMocks);
vi.mock('./sessions.mjs', () => sessionMocks);
vi.mock('./chat/providers/ollama.mjs', () => providerMocks);
vi.mock('./lib/tool-router.mjs', () => routerMocks);
vi.mock('./lib/tool-plan-memory.mjs', () => toolPlanMocks);

const { streamChat } = await import('./chat.mjs');
const { runWithTurnContext } = await import('./lib/turn-abort-context.mjs');
const {
  beginTurn, getTurnLabProviderRequestCap, setTurnLabProviderRequestCap,
  turnTraceContext,
} = await import('./lib/turn-trace-context.mjs');

async function collect(gen) {
  const events = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeAgent() {
  return {
    id: 'jarvis-lab-test',
    name: 'Jarvis Lab Test',
    provider: 'ollama',
    model: 'test-model',
    systemPrompt: 'test',
    tools: [{
      type: 'function',
      function: {
        name: 'read_live_data', description: 'Read live data',
        parameters: { type: 'object', properties: {} },
      },
    }],
    ephemeral: false,
    skillCategory: 'coordinator',
  };
}

describe('lab verifier non-learning contract', () => {
  afterEach(() => {
    delete process.env.OPENENSEMBLE_LAB;
    vi.clearAllMocks();
  });

  it('keeps real memory reads and session durability while suppressing every memory signal', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const emitted = [];
    const agent = makeAgent();

    const events = await runWithTurnContext(
      { suppressLearning: true },
      () => collect(streamChat(
        agent,
        'Verifier tag. What is 17 times 23?',
        null,
        event => emitted.push(event),
        'default',
        null,
        null,
        false,
        null,
        {
          toolPlan: {
            mode: 'auto', source: 'lab-verifier', maxProviderRequests: 2,
          },
        },
      )),
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(sessionMocks.appendToSession).toHaveBeenCalledOnce();
    expect(memoryMocks.buildAgentContext).toHaveBeenCalledOnce();
    expect(memoryMocks.buildAgentContext).toHaveBeenCalledWith(
      'jarvis-lab-test',
      'Verifier tag. What is 17 times 23?',
      'default',
      { includeEpisodes: true, suppressLearning: true },
    );
    expect(routerMocks.trimToolsForTurn).toHaveBeenCalledOnce();
    expect(routerMocks.recordTurnRouting).not.toHaveBeenCalled();
    expect(toolPlanMocks.learnToolPlanFromTurn).not.toHaveBeenCalled();
    expect(memoryMocks.processSignals).not.toHaveBeenCalled();
    expect(memoryMocks.addToSessionBuffer).not.toHaveBeenCalled();
    expect(signalMocks.trackFriction).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_call', name: 'read_live_data' }),
      expect.objectContaining({ type: 'tool_result', name: 'read_live_data', text: 'live value: 391' }),
    ]));
    const persistedAssistant = sessionMocks.appendToSession.mock.calls[0].at(-1);
    expect(persistedAssistant.toolsUsed).toEqual(['read_live_data({})']);
    expect(persistedAssistant.toolResults).toEqual([{
      name: 'read_live_data', text: 'live value: 391',
      toolCallId: 'provider-call-live-391', native: true,
    }]);
    expect(persistedAssistant.toolEvents).toEqual([
      expect.objectContaining({
        name: 'read_live_data', toolCallId: 'provider-call-live-391',
        native: true, status: 'done', resultIndex: 0,
      }),
    ]);
    expect(emitted).toEqual([]);
  });

  it('inherits suppression for a nested stream even when the child uses its own tool-plan source', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const events = await runWithTurnContext(
      { suppressLearning: true },
      () => collect(streamChat(
        makeAgent(),
        'Nested specialist request.',
        null,
        () => {},
        'default',
        null,
        null,
        false,
        null,
        {
          toolPlan: {
            mode: 'auto', source: 'remembered-tool-plan', maxProviderRequests: 2,
          },
        },
      )),
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(memoryMocks.buildAgentContext).toHaveBeenCalledWith(
      'jarvis-lab-test',
      'Nested specialist request.',
      'default',
      { includeEpisodes: true, suppressLearning: true },
    );
    expect(routerMocks.recordTurnRouting).not.toHaveBeenCalled();
    expect(toolPlanMocks.learnToolPlanFromTurn).not.toHaveBeenCalled();
    expect(memoryMocks.processSignals).not.toHaveBeenCalled();
    expect(memoryMocks.addToSessionBuffer).not.toHaveBeenCalled();
    expect(signalMocks.trackFriction).not.toHaveBeenCalled();
  });

  it('does not trust a lab-verifier source string without authenticated ambient context', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const events = await collect(streamChat(
      makeAgent(),
      'Spoofed verifier source.',
      null,
      () => {},
      'default',
      null,
      null,
      false,
      null,
      {
        toolPlan: {
          mode: 'auto', source: 'lab-verifier', maxProviderRequests: 2,
        },
      },
    ));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(routerMocks.recordTurnRouting).toHaveBeenCalledOnce();
    expect(toolPlanMocks.learnToolPlanFromTurn).toHaveBeenCalledOnce();
    expect(memoryMocks.addToSessionBuffer).toHaveBeenCalled();
    expect(signalMocks.trackFriction).toHaveBeenCalledOnce();
    expect(memoryMocks.buildAgentContext).toHaveBeenCalledWith(
      'jarvis-lab-test',
      'Spoofed verifier source.',
      'default',
      { includeEpisodes: true, suppressLearning: false },
    );
  });

  it('does not raise a foreground verifier budget for an inline isolated helper stream', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const foregroundTurn = {
      turnId: 'foreground-cap-test', rootId: 'foreground-cap-test', parentTurnId: null,
      userId: 'default', agentId: 'jarvis-lab-test', source: 'web',
      startedAt: Date.now(), spans: [], delegations: [], errors: [],
    };
    const observedCap = await turnTraceContext.run(foregroundTurn, () => runWithTurnContext(
      { suppressLearning: true },
      async () => {
        await collect(streamChat(
          makeAgent(),
          'Inline isolated helper.',
          null,
          () => {},
          'default',
          null,
          null,
          true,
          null,
          {
            isolatedTaskRun: true,
            toolPlan: {
              mode: 'auto', source: 'lab-verifier', maxProviderRequests: 2,
            },
          },
        ));
        return getTurnLabProviderRequestCap();
      },
    ));

    expect(observedCap).toBe(2);
  });

  it('pins a detached verifier worker-completion request to one provider round', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const observedCap = await runWithTurnContext(
      { suppressLearning: true },
      async () => {
        await collect(streamChat(
          makeAgent(),
          'Author a private completion.',
          null,
          () => {},
          'default',
          null,
          null,
          true,
          null,
          {
            readOnlyTurn: true,
            isolatedTaskRun: true,
            rootTaskId: 'worker-completion-cap',
            traceSource: 'worker-completion',
            toolPlan: {
              mode: 'none', source: 'worker-completion', maxProviderRequests: 1,
            },
          },
        ));
        return getTurnLabProviderRequestCap();
      },
    );

    expect(observedCap).toBe(1);
  });

  it('keeps a shared trace cap monotonic while a fresh detached trace may start at six', async () => {
    const foregroundTurn = {
      turnId: 'foreground-monotonic-cap', rootId: 'foreground-monotonic-cap',
      parentTurnId: null, userId: 'default', agentId: 'jarvis-lab-test',
      source: 'web', startedAt: Date.now(), spans: [], delegations: [], errors: [],
    };

    await turnTraceContext.run(foregroundTurn, async () => {
      expect(setTurnLabProviderRequestCap(2)).toBe(true);
      // An inline child with no authenticated plan resolves to the default
      // four-request proposal. It shares this trace and must not raise it.
      expect(setTurnLabProviderRequestCap(4)).toBe(true);
      expect(getTurnLabProviderRequestCap()).toBe(2);

      const detachedTurn = beginTurn({
        userId: 'default', agentId: 'worker-lab-test', source: 'background',
        rootId: 'detached-monotonic-cap', forceRoot: true,
      });
      expect(detachedTurn).not.toBe(foregroundTurn);
      expect(setTurnLabProviderRequestCap(6)).toBe(true);
      expect(getTurnLabProviderRequestCap()).toBe(6);
    });
  });
});
