import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendToSession: vi.fn(async () => {}),
  failPendingTurn: vi.fn(async () => {}),
  trimToolsForTurn: vi.fn(),
  spawnCalls: [],
  spawnImplementation: null,
  manifests: new Map(),
}));

vi.mock('../sessions.mjs', () => ({
  appendToSession: mocks.appendToSession,
  failPendingTurn: mocks.failPendingTurn,
}));

vi.mock('../roles.mjs', () => ({
  listRoles: vi.fn(() => [...mocks.manifests.values()].map(({ id }) => ({ id }))),
  getRoleManifest: vi.fn(id => mocks.manifests.get(id) || null),
}));

vi.mock('../lib/tool-router.mjs', () => ({
  trimToolsForTurn: mocks.trimToolsForTurn,
}));

vi.mock('../skills/delegate/execute.mjs', () => ({
  executeSkillTool: vi.fn(async function* (...args) {
    mocks.spawnCalls.push(args);
    if (typeof mocks.spawnImplementation === 'function') {
      yield* mocks.spawnImplementation(...args);
      return;
    }
    yield { type: 'result', text: 'Hired a background worker (wkr_1784150000000_abcde). It is running.' };
  }),
}));

const { trySingletonCompoundBackground } = await import('./compound-background.mjs');

function tool(name, description, extra = {}) {
  return {
    ...extra,
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: name === 'email_user'
          ? {
              subject: { type: 'string' },
              attachment_doc_ids: { type: 'array', items: { type: 'string' } },
              to: { type: 'string', description: 'Recipient email address.' },
            }
          : {},
      },
    },
  };
}

const prompt = 'make me an image of a cute cat, then check the weather. send me an email of the cat and the current weather.';

function routedTrim() {
  const conditionsTool = mocks.manifests.get('personal-conditions')?.tools?.[0];
  const emailTool = mocks.manifests.get('direct-delivery')?.tools?.[0];
  return {
    trimmedTools: [conditionsTool, emailTool],
    fullTools: [conditionsTool, emailTool],
    skillsKept: new Set(['visual-maker', 'personal-conditions', 'direct-delivery']),
    initiallyIncludedSkills: new Set(),
  };
}

beforeEach(() => {
  mocks.appendToSession.mockClear();
  mocks.failPendingTurn.mockClear();
  mocks.trimToolsForTurn.mockReset();
  mocks.spawnCalls.length = 0;
  mocks.spawnImplementation = null;
  mocks.manifests.clear();

  mocks.manifests.set('visual-maker', {
    id: 'visual-maker', name: 'Visual Maker', category: 'image',
    description: 'Generate images from text.',
    intent_examples: ['make an image of a cat', 'draw a landscape picture'],
    // No local function: provider-hosted image_generation is the only usable
    // image tool for this model/configuration.
    tools: [],
  });
  const conditionsTool = tool(
    'conditions_now',
    'Get current local weather conditions and forecast from a live remote service.',
    { readOnly: true },
  );
  mocks.manifests.set('personal-conditions', {
    id: 'personal-conditions', name: 'Personal Conditions', category: 'utility',
    description: 'Gets current local weather and forecast.',
    intent_examples: ['check the weather', 'what is the forecast'],
    tools: [conditionsTool],
  });
  const emailTool = tool(
    'email_user',
    'Send and deliver an email directly to a recipient with optional file attachments.',
  );
  mocks.manifests.set('direct-delivery', {
    id: 'direct-delivery', name: 'Direct Delivery', category: 'utility',
    description: 'Send an email directly.', tools: [emailTool],
  });
  mocks.trimToolsForTurn.mockResolvedValue(routedTrim());
});

function singletonAgent() {
  return {
    id: 'jarvis_lab', name: 'Jarvis', emoji: 'J',
    provider: 'openai-oauth', model: 'gpt-5.4-mini',
    skillCategory: 'coordinator', _rosterSolo: true,
    tools: [tool('spawn_worker', 'Hire one detached background worker.')],
  };
}

describe('deterministic singleton compound background fast path', () => {
  it('starts one worker and returns a durable foreground acknowledgement without a local image tool', async () => {
    const events = [];
    const result = await trySingletonCompoundBackground({
      userId: 'user_test', agentId: 'jarvis_lab', agent: singletonAgent(),
      userText: prompt, source: 'web', onEvent: event => events.push(event),
    });

    expect(result).toMatchObject({
      handled: true,
      taskId: 'wkr_1784150000000_abcde',
      decision: { shouldBackground: true, capabilityCount: 3 },
    });
    expect(result.decision.matchedSteps.map(step => step.toolName)).toEqual([
      'image_generation', 'conditions_now', 'email_user',
    ]);
    expect(mocks.spawnCalls).toHaveLength(1);
    expect(mocks.spawnCalls[0][0]).toBe('spawn_worker');
    expect(mocks.spawnCalls[0][1]).toEqual({
      task: prompt,
      label: 'Complete 3-step workflow',
    });
    expect(mocks.spawnCalls[0][2]).toBe('user_test');
    expect(mocks.spawnCalls[0][3]).toBe('user_test_jarvis_lab');
    expect(mocks.spawnCalls[0][4]).toEqual({
      completionContract: expect.objectContaining({
        version: 1,
        source: 'singleton-compound',
        steps: [
          expect.objectContaining({ index: 0, toolName: 'image_generation' }),
          expect.objectContaining({ index: 1, toolName: 'conditions_now' }),
          expect.objectContaining({ index: 2, toolName: 'email_user', delivery: true }),
        ],
      }),
    });
    expect(Object.isFrozen(mocks.spawnCalls[0][4].completionContract)).toBe(true);
    expect(Object.isFrozen(mocks.spawnCalls[0][4].completionContract.steps)).toBe(true);
    expect(mocks.spawnCalls[0][1]).not.toHaveProperty('completionContract');
    expect(mocks.appendToSession).toHaveBeenCalledOnce();
    expect(mocks.appendToSession.mock.calls[0][0]).toBe('user_test_jarvis_lab');
    expect(mocks.appendToSession.mock.calls[0][1]).toMatchObject({ role: 'user', content: prompt });
    expect(mocks.appendToSession.mock.calls[0][2]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('You can keep chatting'),
    });
    expect(events.map(event => event.type)).toEqual([
      'tool_call', 'tool_result', 'token', 'done',
    ]);
  });

  it('gives an already-admitted worker only the underlying execution task', async () => {
    const metaPrompt = 'Use spawn_worker exactly once to do this in the background: make me an image of a cute cat, then check the weather, then email me the cat and weather. Do not change any files. Return immediately after starting the worker so I can keep chatting.';
    const result = await trySingletonCompoundBackground({
      userId: 'user_test', agentId: 'jarvis_lab', agent: singletonAgent(),
      userText: metaPrompt, source: 'web', onEvent: () => {},
    });

    expect(result).toMatchObject({ handled: true, admitted: true });
    expect(mocks.spawnCalls).toHaveLength(1);
    expect(mocks.spawnCalls[0][1].task).toBe(metaPrompt);
    expect(mocks.spawnCalls[0][4].completionContract.steps.map(step => step.toolName)).toEqual([
      'image_generation', 'conditions_now', 'email_user',
    ]);
    expect(mocks.spawnCalls[0][4].completionContract.steps[0].exactlyOnce).toBe(false);
    const executionTask = mocks.spawnCalls[0][4].executionTask;
    expect(executionTask).toContain('Do not call spawn_worker');
    expect(executionTask).toContain('make me an image of a cute cat');
    expect(executionTask).toContain('Do not change any files');
    expect(executionTask).not.toContain('Use spawn_worker exactly once');
    expect(executionTask).not.toContain('Return immediately after starting the worker');
  });

  it('does not fast-path a single lookup plus negative email/change constraints', async () => {
    const exactPrompt = 'Use spawn_worker exactly once to do this in the background: find from the official Node.js website the currently listed Active LTS major release, then report one concise sentence with its official URL. Do not use email and do not make any changes. Return immediately after starting the worker so I can keep chatting.';
    const listWatches = tool(
      'list_watches',
      'List active watch monitors and report their current status.',
    );
    const webSearch = tool(
      'web_search',
      'Find current facts on an official website with web search.',
      { readOnly: true },
    );
    mocks.manifests.set('tasks', {
      id: 'tasks', name: 'Task Scheduler', category: 'utility',
      description: 'Schedule tasks and list active watches.',
      intent_examples: ['list my watches', 'show active monitors'],
      tools: [listWatches],
    });
    mocks.manifests.set('web', {
      id: 'web', name: 'Web Search', category: 'utility',
      description: 'Find facts on official websites.',
      intent_examples: ['find a fact on an official website', 'search the web'],
      tools: [webSearch],
    });
    const emailUser = mocks.manifests.get('direct-delivery').tools[0];
    mocks.trimToolsForTurn.mockResolvedValueOnce({
      trimmedTools: [listWatches, emailUser, webSearch],
      fullTools: [listWatches, emailUser, webSearch],
      skillsKept: new Set(['tasks', 'direct-delivery', 'web']),
      initiallyIncludedSkills: new Set(),
    });

    const result = await trySingletonCompoundBackground({
      userId: 'user_test', agentId: 'jarvis_lab', agent: singletonAgent(),
      userText: exactPrompt, source: 'web', onEvent: () => {},
    });

    expect(result).toBeNull();
    expect(mocks.spawnCalls).toHaveLength(0);
    expect(mocks.appendToSession).not.toHaveBeenCalled();
  });

  it('does not auto-detach workers, multi-agent coordinators, selected plans, or attachment turns', async () => {
    for (const overrides of [
      { agent: { ...singletonAgent(), ephemeral: true } },
      { agent: { ...singletonAgent(), _rosterSolo: false } },
      { agent: singletonAgent(), toolPlan: { mode: 'selected' } },
      { agent: singletonAgent(), toolPlan: { mode: 'none' } },
      { agent: singletonAgent(), attachments: [{ name: 'source.png' }] },
      { agent: singletonAgent(), backgroundContinuation: true },
    ]) {
      const result = await trySingletonCompoundBackground({
        userId: 'user_test', agentId: 'jarvis_lab', userText: prompt,
        source: 'web', onEvent: () => {}, ...overrides,
      });
      expect(result).toBeNull();
    }
    expect(mocks.spawnCalls).toHaveLength(0);
  });

  it('handles an abort that lands during schema trim without admitting or falling through', async () => {
    const ac = new AbortController();
    const events = [];
    mocks.trimToolsForTurn.mockImplementationOnce(async () => {
      ac.abort('stopped while routing');
      return routedTrim();
    });

    const result = await trySingletonCompoundBackground({
      userId: 'user_test', agentId: 'jarvis_lab', agent: singletonAgent(),
      userText: prompt, source: 'web', signal: ac.signal,
      onEvent: event => events.push(event),
    });

    expect(result).toMatchObject({
      handled: true, aborted: true, admitted: false, admissionStarted: false,
    });
    expect(mocks.spawnCalls).toHaveLength(0);
    expect(mocks.appendToSession).not.toHaveBeenCalled();
    expect(mocks.failPendingTurn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('keeps one admitted worker detached when the foreground aborts during admission', async () => {
    const ac = new AbortController();
    const events = [];
    mocks.spawnImplementation = async function* () {
      // executeSkillTool has entered its admission path. The canonical id is
      // still returned, but the foreground turn is stopped before any ack.
      ac.abort('barge-in during admission');
      yield { type: 'result', text: 'Hired a background worker (wkr_1784150000000_race1). It is running.' };
    };

    const result = await trySingletonCompoundBackground({
      userId: 'user_test', agentId: 'jarvis_lab', agent: singletonAgent(),
      userText: prompt, source: 'web', signal: ac.signal,
      onEvent: event => events.push(event),
    });

    expect(result).toMatchObject({
      handled: true,
      aborted: true,
      admitted: true,
      admissionStarted: true,
      taskId: 'wkr_1784150000000_race1',
    });
    expect(mocks.spawnCalls).toHaveLength(1);
    expect(mocks.appendToSession).not.toHaveBeenCalled();
    expect(mocks.failPendingTurn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
