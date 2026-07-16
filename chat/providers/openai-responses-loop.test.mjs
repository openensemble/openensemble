import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roleMocks = vi.hoisted(() => ({
  executeToolStreaming: vi.fn(async function* (_name, args) {
    yield { type: 'result', text: `ok:${JSON.stringify(args)}` };
  }),
}));

vi.mock('../../roles.mjs', () => roleMocks);
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

function completed() {
  return {
    type: 'response.completed',
    response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } },
  };
}

function toolResponse(index) {
  const item = {
    type: 'function_call',
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: 'test_tool',
    arguments: JSON.stringify({ index }),
  };
  return responseSse([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    completed(),
  ]);
}

function textResponse(text) {
  return responseSse([
    { type: 'response.output_text.delta', delta: text },
    completed(),
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
    parameters: { type: 'object', properties: { index: { type: 'number' } } },
  },
};

function agent(maxToolLoops) {
  return {
    id: 'responses-loop-test-agent',
    provider: 'grok',
    model: 'grok-4-fast-non-reasoning',
    maxToolLoops,
    tools: [tool],
  };
}

describe('Responses provider bounded tool loops', () => {
  beforeEach(() => {
    process.env.GROK_API_KEY = 'responses-loop-test-key';
    roleMocks.executeToolStreaming.mockClear();
  });

  afterEach(() => {
    delete process.env.GROK_API_KEY;
    vi.unstubAllGlobals();
  });

  it('emits an explicit error when the final permitted round ends in a tool call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => toolResponse(1)));

    const events = await collect(streamOpenAIResponses(
      agent(1),
      'test prompt',
      [{ role: 'user', content: 'use the tool' }],
      AbortSignal.timeout(5_000),
      'responses-loop-test-user',
    ));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(roleMocks.executeToolStreaming).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.at(-1).message).toMatch(/budget ended before a final answer/i);
  });

  it('retains the final answer produced on the exact last permitted round', async () => {
    let request = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      request++;
      return request === 1 ? toolResponse(request) : textResponse('canonical final answer');
    }));

    const events = await collect(streamOpenAIResponses(
      agent(2),
      'test prompt',
      [{ role: 'user', content: 'use the tool, then answer' }],
      AbortSignal.timeout(5_000),
      'responses-loop-test-user',
    ));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: '__content', content: 'canonical final answer' });
  });
});
