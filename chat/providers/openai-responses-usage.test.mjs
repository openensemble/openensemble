import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roleMocks = vi.hoisted(() => ({
  executeToolStreaming: vi.fn(async function* (_name, args) {
    yield { type: 'result', text: `ok:${JSON.stringify(args)}` };
  }),
}));
const authMocks = vi.hoisted(() => ({
  ensureFreshToken: vi.fn(async () => ({ access_token: 'codex-test-token', account_id: 'codex-test-account' })),
  forceRefreshToken: vi.fn(async () => ({ access_token: 'codex-refreshed-token', account_id: 'codex-test-account' })),
}));

vi.mock('../../roles.mjs', () => roleMocks);
vi.mock('../../lib/openai-codex-auth.mjs', () => authMocks);
vi.mock('../../routes/_helpers.mjs', () => ({
  loadConfig: vi.fn(() => ({ grokApiKey: process.env.GROK_API_KEY })),
}));

const { streamOpenAIResponses } = await import('./openai-responses.mjs');

function responseSse(events) {
  const body = [
    ...events.map(event => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function responseSseWithoutDone(events) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function completion({ input = 5, output = 2, cached = 0, usage = true } = {}) {
  return {
    type: 'response.completed',
    response: {
      output: [],
      ...(usage ? {
        usage: {
          input_tokens: input,
          output_tokens: output,
          input_tokens_details: { cached_tokens: cached },
        },
      } : {}),
    },
  };
}

function textResponse(text, completionOptions) {
  return responseSse([
    { type: 'response.output_text.delta', delta: text },
    completion(completionOptions),
  ]);
}

function toolResponse() {
  const item = {
    type: 'function_call',
    id: 'fc_usage',
    call_id: 'call_usage',
    name: 'test_tool',
    arguments: JSON.stringify({ value: 1 }),
  };
  return responseSse([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    completion(),
  ]);
}

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

const tool = {
  type: 'function',
  function: {
    name: 'test_tool',
    description: 'test only',
    parameters: {
      type: 'object',
      properties: { value: { type: 'number' } },
    },
  },
};

function agent(overrides = {}) {
  return {
    id: 'responses-usage-agent',
    provider: 'grok',
    model: 'grok-4-fast-non-reasoning',
    maxToolLoops: 4,
    tools: [tool],
    ...overrides,
  };
}

function usageEvent(events) {
  const usage = events.filter(event => event.type === '__usage');
  expect(usage).toHaveLength(1);
  return usage[0];
}

describe('Responses provider usage cardinality', () => {
  beforeEach(() => {
    process.env.GROK_API_KEY = 'responses-usage-test-key';
    roleMocks.executeToolStreaming.mockClear();
    authMocks.ensureFreshToken.mockClear();
    authMocks.forceRefreshToken.mockClear();
  });

  afterEach(() => {
    delete process.env.GROK_API_KEY;
    vi.unstubAllGlobals();
  });

  it('emits exact request-schema evidence and complete one-to-one usage', async () => {
    let requestBody;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return textResponse('done', { input: 11, output: 3, cached: 7 });
    }));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    const serializedTools = JSON.stringify(requestBody.tools);
    expect(events.filter(event => event.type === '__model_call')).toEqual([
      expect.objectContaining({
        provider: 'grok',
        model: 'grok-4-fast-non-reasoning',
        phase: 'dispatch_planned',
        round: 1,
        toolNames: ['test_tool'],
        toolCount: 1,
        toolSchemaBytes: Buffer.byteLength(serializedTools),
        schemaTokEst: Math.ceil(Buffer.byteLength(serializedTools) / 4),
        schemaHash: createHash('sha256').update(serializedTools).digest('hex'),
      }),
    ]);
    expect(usageEvent(events)).toMatchObject({
      inputTokens: 11,
      outputTokens: 3,
      cachedTokens: 7,
      reqCount: 1,
      completionCount: 1,
      usageCount: 1,
      usageComplete: true,
    });
  });

  it('accepts direct Codex clean EOF after one complete terminal record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSseWithoutDone([
      { type: 'response.output_text.delta', delta: 'done' },
      completion({ input: 7, output: 2 }),
    ])));

    const events = await collect(streamOpenAIResponses(
      agent({ provider: 'openai-oauth', model: 'gpt-test' }),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(authMocks.ensureFreshToken).toHaveBeenCalledWith('responses-usage-user');
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: '__content', content: 'done' });
    expect(usageEvent(events)).toMatchObject({
      inputTokens: 7, outputTokens: 2,
      reqCount: 1, completionCount: 1, usageCount: 1, usageComplete: true,
    });
  });

  it('rejects non-Codex clean EOF even after response.completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSseWithoutDone([
      { type: 'response.output_text.delta', delta: 'transient' },
      completion(),
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events).toContainEqual({ type: 'replace', text: '' });
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid response stream/i) });
    expect(usageEvent(events).usageComplete).toBe(false);
  });

  it('rejects direct Codex clean EOF without a response terminal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSseWithoutDone([
      { type: 'response.output_text.delta', delta: 'partial' },
    ])));

    const events = await collect(streamOpenAIResponses(
      agent({ provider: 'openai-oauth', model: 'gpt-test' }),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events).toContainEqual({ type: 'replace', text: '' });
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid response stream/i) });
    expect(usageEvent(events)).toMatchObject({
      reqCount: 1, completionCount: 0, usageCount: 0, usageComplete: false,
    });
  });

  it('fails closed when a later tool-loop completion omits usage', async () => {
    let request = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      request++;
      return request === 1 ? toolResponse() : textResponse('done', { usage: false });
    }));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'use the tool, then answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === '__model_call')).toHaveLength(2);
    expect(usageEvent(events)).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      reqCount: 2,
      completionCount: 2,
      usageCount: 1,
      usageComplete: false,
    });
  });

  it('fails closed on duplicate terminal and usage records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_text.delta', delta: 'done' },
      completion(),
      completion(),
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(usageEvent(events)).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      reqCount: 1,
      completionCount: 2,
      usageCount: 2,
      usageComplete: false,
    });
    expect(events).toContainEqual({ type: 'replace', text: '' });
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid response stream/i) });
  });

  it('fails closed when a text stream lacks a terminal record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_text.delta', delta: 'partial' },
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events).toContainEqual({ type: 'replace', text: '' });
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid response stream/i) });
    expect(usageEvent(events)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      reqCount: 1,
      completionCount: 0,
      usageCount: 0,
      usageComplete: false,
    });
  });

  it('never executes a completed tool item without a response terminal', async () => {
    const item = {
      type: 'function_call', id: 'fc_unterminated', call_id: 'call_unterminated',
      name: 'test_tool', arguments: JSON.stringify({ value: 1 }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'use the tool' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(roleMocks.executeToolStreaming).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'tool_call')).toBe(false);
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid response stream/i) });
  });

  it('rejects response.incomplete and clears transient text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events).toContainEqual({ type: 'replace', text: '' });
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error', message: expect.stringMatching(/incomplete.*max_output_tokens/i),
    });
    expect(usageEvent(events).usageComplete).toBe(false);
  });

  it('rejects parsed events after response.completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_text.delta', delta: 'transient' },
      completion(),
      { type: 'response.in_progress', response: { id: 'late_event' } },
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events).toContainEqual({ type: 'replace', text: '' });
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid response stream/i) });
    expect(usageEvent(events).usageComplete).toBe(false);
  });

  it('counts a rejected wire request and emits usage before its error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream failed', { status: 500 })));

    const events = await collect(streamOpenAIResponses(
      agent(),
      'test prompt',
      [{ role: 'user', content: 'answer' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events.at(-2)).toMatchObject({
      type: '__usage',
      reqCount: 1,
      completionCount: 0,
      usageCount: 0,
      usageComplete: false,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('500') });
  });
});
