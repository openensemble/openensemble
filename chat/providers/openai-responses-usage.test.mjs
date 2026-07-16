import { createHash } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setTurnLabProviderRequestCap, turnTraceContext,
} from '../../lib/turn-trace-context.mjs';
import { runWithTurnContext } from '../../lib/turn-abort-context.mjs';

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

function indexedToolResponse(index, { input = 5, output = 2 } = {}) {
  const item = {
    type: 'function_call',
    id: `fc_usage_${index}`,
    call_id: `call_usage_${index}`,
    name: 'test_tool',
    arguments: JSON.stringify({ value: index }),
  };
  return responseSse([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    completion({ input, output }),
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
    delete process.env.OPENENSEMBLE_LAB;
    delete process.env.OE_LAB_CODEX_RELAY;
    delete process.env.OE_LAB_VERIFIER_LEASE_PATH;
    roleMocks.executeToolStreaming.mockClear();
    authMocks.ensureFreshToken.mockClear();
    authMocks.forceRefreshToken.mockClear();
  });

  afterEach(() => {
    delete process.env.GROK_API_KEY;
    delete process.env.OPENENSEMBLE_LAB;
    delete process.env.OE_LAB_CODEX_RELAY;
    delete process.env.OE_LAB_VERIFIER_LEASE_PATH;
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

  it('never automatically retries a request that offers the paid hosted image tool', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const generateImageTool = {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'authorized image capability',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
      },
    };

    const events = await collect(streamOpenAIResponses(
      agent({
        provider: 'openai-oauth',
        model: 'gpt-5.4',
        tools: [generateImageTool],
        _providerHostedImageBackend: true,
      }),
      'test prompt',
      [{ role: 'user', content: 'generate an image' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).tools).toContainEqual({ type: 'image_generation' });
    expect(usageEvent(events)).toMatchObject({ reqCount: 1, usageComplete: false });
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/fetch failed/i) });
  });

  it('never executes a call that lacks its output_item.done event', async () => {
    const item = {
      type: 'function_call', id: 'fc_not_done', call_id: 'call_not_done',
      name: 'test_tool', arguments: JSON.stringify({ value: 1 }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_item.added', output_index: 0, item },
      completion(),
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(), 'test prompt', [{ role: 'user', content: 'use the tool' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    expect(roleMocks.executeToolStreaming).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'tool_call')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error', message: expect.stringMatching(/invalid tool call/i),
    });
  });

  it('rejects malformed completed tool arguments without partially executing a batch', async () => {
    const valid = {
      type: 'function_call', id: 'fc_valid', call_id: 'call_valid',
      name: 'test_tool', arguments: JSON.stringify({ value: 1 }),
    };
    const invalid = {
      type: 'function_call', id: 'fc_invalid', call_id: 'call_invalid',
      name: 'test_tool', arguments: '{"value":',
    };
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_item.added', output_index: 0, item: valid },
      { type: 'response.output_item.done', output_index: 0, item: valid },
      { type: 'response.output_item.added', output_index: 1, item: invalid },
      { type: 'response.output_item.done', output_index: 1, item: invalid },
      completion(),
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(), 'test prompt', [{ role: 'user', content: 'use both tools' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    expect(roleMocks.executeToolStreaming).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'tool_call')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error', message: expect.stringMatching(/invalid tool call/i),
    });
  });

  it('keeps public-compatible lab output request and provider-loop bounds', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    let request = 0;
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      request++;
      return request < 4 ? indexedToolResponse(request) : textResponse('bounded final');
    }));

    const events = await collect(streamOpenAIResponses(
      agent({ maxToolLoops: 20 }), 'test prompt',
      [{ role: 'user', content: 'run three steps then answer' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(bodies.every(body => body.max_output_tokens === 4_096)).toBe(true);
    expect(events).toContainEqual({ type: '__content', content: 'bounded final' });
    expect(usageEvent(events)).toMatchObject({
      reqCount: 4, completionCount: 4, usageCount: 4, usageComplete: true,
    });
  });

  it('allows an authenticated detached worker six bounded rounds and retains its final answer', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    let request = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      request++;
      return request < 6 ? indexedToolResponse(request) : textResponse('worker evidence');
    }));

    const workerTurn = {
      turnId: 'worker-cap-turn', rootId: 'worker-cap-turn', parentTurnId: null,
      userId: 'responses-usage-user', agentId: 'responses-usage-agent',
      source: 'background', startedAt: Date.now(), spans: [], delegations: [], errors: [],
    };
    const events = await turnTraceContext.run(workerTurn, async () => {
      expect(setTurnLabProviderRequestCap(6)).toBe(true);
      return collect(streamOpenAIResponses(
        agent({ maxToolLoops: 20 }), 'test prompt',
        [{ role: 'user', content: 'run five steps then report' }],
        AbortSignal.timeout(5_000), 'responses-usage-user',
      ));
    });

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual({ type: '__content', content: 'worker evidence' });
    expect(usageEvent(events)).toMatchObject({
      reqCount: 6, completionCount: 6, usageCount: 6, usageComplete: true,
    });
  });

  it('revalidates a verifier capability at the provider-attempt edge before fetch', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-provider-lease-'));
    const leasePath = path.join(dir, 'lease.json');
    const token = 'f'.repeat(64);
    process.env.OE_LAB_VERIFIER_LEASE_PATH = leasePath;
    const fetchSpy = vi.fn(async () => textResponse('authorized'));
    vi.stubGlobal('fetch', fetchSpy);
    const run = leaseToken => runWithTurnContext({
      suppressLearning: true,
      verifierLeaseRequired: true,
      verifierLeaseToken: leaseToken,
    }, () => collect(streamOpenAIResponses(
      agent(), 'test prompt', [{ role: 'user', content: 'answer once' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    )));

    try {
      const absent = await run(token);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(absent.at(-1)).toMatchObject({ type: 'error' });

      fs.writeFileSync(leasePath, JSON.stringify({
        version: 1,
        runTag: 'real_router_1700000000000_aaaaaaaa',
        token,
        expiresAt: Date.now() + 60_000,
      }), { mode: 0o600 });
      fs.chmodSync(leasePath, 0o600);
      const mismatch = await run('0'.repeat(64));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mismatch.at(-1)).toMatchObject({ type: 'error' });

      const ordinary = await collect(streamOpenAIResponses(
        agent(), 'test prompt', [{ role: 'user', content: 'ordinary direct call' }],
        AbortSignal.timeout(5_000), 'responses-usage-user',
      ));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ordinary.at(-1)).toMatchObject({ type: 'error' });

      const authorized = await run(token);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(authorized).toContainEqual({ type: '__content', content: 'authorized' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a second provider round when the lease disappears after the first fetch starts', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-provider-round-lease-'));
    const leasePath = path.join(dir, 'lease.json');
    const token = '1'.repeat(64);
    process.env.OE_LAB_VERIFIER_LEASE_PATH = leasePath;
    fs.writeFileSync(leasePath, JSON.stringify({
      version: 1,
      runTag: 'real_router_1700000000000_aaaaaaaa',
      token,
      expiresAt: Date.now() + 60_000,
    }), { mode: 0o600 });
    fs.chmodSync(leasePath, 0o600);
    const fetchSpy = vi.fn(async () => {
      fs.rmSync(leasePath, { force: true });
      return toolResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const events = await runWithTurnContext({
        suppressLearning: true,
        verifierLeaseRequired: true,
        verifierLeaseToken: token,
      }, () => collect(streamOpenAIResponses(
        agent(), 'test prompt', [{ role: 'user', content: 'use one tool then answer' }],
        AbortSignal.timeout(5_000), 'responses-usage-user',
      )));

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(events.some(event => event.type === '__content')).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'error' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects excessive reported lab output before executing a completed tool call', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    const item = {
      type: 'function_call', id: 'fc_over_budget', call_id: 'call_over_budget',
      name: 'test_tool', arguments: JSON.stringify({ value: 1 }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      completion({ input: 5, output: 4_097 }),
    ])));

    const events = await collect(streamOpenAIResponses(
      agent(), 'test prompt', [{ role: 'user', content: 'use the tool' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    expect(roleMocks.executeToolStreaming).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'tool_call')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error', message: expect.stringMatching(/output-token acceptance cap/i),
    });
  });

  it('clears transient text instead of retaining an over-budget lab response', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('transient answer', {
      input: 5, output: 4_097,
    })));

    const events = await collect(streamOpenAIResponses(
      agent(), 'test prompt', [{ role: 'user', content: 'answer once' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    const tokenIndex = events.findIndex(event => event.type === 'token');
    const replaceIndex = events.findIndex(event => event.type === 'replace' && event.text === '');
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(replaceIndex).toBeGreaterThan(tokenIndex);
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('omits the unsupported output-token field for the ChatGPT Codex lab relay', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.OE_LAB_CODEX_RELAY = '1';
    let body;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return textResponse('done');
    }));

    const events = await collect(streamOpenAIResponses(
      agent({ provider: 'openai-oauth', model: 'gpt-5.4-mini' }),
      'test prompt', [{ role: 'user', content: 'answer once' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(events).toContainEqual({ type: '__content', content: 'done' });
  });

  it('does not retry an unrelated Codex unsupported-parameter response as reasoning', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.OE_LAB_CODEX_RELAY = '1';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Unsupported parameter: max_output_tokens' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    const events = await collect(streamOpenAIResponses(
      agent({ provider: 'openai-oauth', model: 'gpt-5.4-mini' }),
      'test prompt', [{ role: 'user', content: 'answer once' }],
      AbortSignal.timeout(5_000), 'responses-usage-user',
    ));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(String(events.at(-1).message)).toContain('max_output_tokens');
    expect(usageEvent(events)).toMatchObject({
      reqCount: 1, completionCount: 0, usageCount: 0, usageComplete: false,
    });
  });

  it('shares the four-request lab ceiling across fresh provider generators in one turn', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('done')));
    const sharedTurn = {
      turnId: 'usage-shared-cap', rootId: 'usage-shared-cap', parentTurnId: null,
      userId: 'responses-usage-user', agentId: 'responses-usage-agent', source: 'web',
      messageId: 'usage-message', attemptId: 'usage-shared-cap',
      startedAt: Date.now(), spans: [], delegations: [], errors: [],
    };
    const runs = await turnTraceContext.run(sharedTurn, async () => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        out.push(await collect(streamOpenAIResponses(
          agent(), 'test prompt', [{ role: 'user', content: `answer ${i}` }],
          AbortSignal.timeout(5_000), 'responses-usage-user',
        )));
      }
      return out;
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    for (const events of runs.slice(0, 4)) {
      expect(usageEvent(events)).toMatchObject({
        reqCount: 1, completionCount: 1, usageCount: 1, usageComplete: true,
      });
    }
    expect(runs[4].some(event => event.type === 'error'
      && /request cap/i.test(String(event.message || '')))).toBe(true);
    expect(usageEvent(runs[4])).toMatchObject({
      reqCount: 0, completionCount: 0, usageCount: 0, usageComplete: false,
    });
  });

  it.each([
    ['malformed', Buffer.from('not an image').toString('base64')],
    ['oversized', 'A'.repeat(28_000_000)],
  ])('fails the turn when a completed hosted image artifact is %s', async (_label, result) => {
    const item = { type: 'image_generation_call', id: `image_${_label}`, result };
    const terminal = completion({ input: 9, output: 2 });
    terminal.response.output = [item];
    vi.stubGlobal('fetch', vi.fn(async () => responseSse([
      { type: 'response.output_item.done', output_index: 0, item },
      terminal,
    ])));
    const generateImageTool = {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'authorized image capability',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
      },
    };

    const events = await collect(streamOpenAIResponses(
      agent({
        provider: 'openai-oauth',
        model: 'gpt-5.4',
        tools: [generateImageTool],
        _providerHostedImageBackend: true,
      }),
      'test prompt',
      [{ role: 'user', content: 'generate an image' }],
      AbortSignal.timeout(5_000),
      'responses-usage-user',
    ));

    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/completed without a valid bounded image artifact/i),
    });
    expect(usageEvent(events)).toMatchObject({ reqCount: 1, completionCount: 1, usageCount: 1 });
  });
});
