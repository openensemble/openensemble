import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  ensureFreshToken: vi.fn(async () => ({ access_token: 'lab-dummy', account_id: null })),
  forceRefreshToken: vi.fn(async () => { throw new Error('must not refresh'); }),
}));

vi.mock('../../lib/openai-codex-auth.mjs', () => auth);
vi.mock('../../roles.mjs', () => ({
  executeToolStreaming: async function* () { yield { type: 'result', text: 'ok' }; },
}));

function codexResponse(events, suffix = '') {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + suffix;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function completedResponse({ includeDone = true } = {}) {
  return codexResponse([{
    type: 'response.completed',
    response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } },
  }], includeDone ? 'data: [DONE]\n\n' : '');
}

function toolCallResponse(index) {
  const args = JSON.stringify({ query: `step ${index}` });
  const item = {
    type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`,
    name: 'web_search', arguments: args,
  };
  return codexResponse([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: args },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { output: [], usage: { input_tokens: 7, output_tokens: 3 } },
    },
  ]);
}

function textCodexResponse(text) {
  return codexResponse([
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: { output: [], usage: { input_tokens: 11, output_tokens: 4 } },
    },
  ]);
}

function functionTool(name) {
  return {
    type: 'function',
    function: { name, description: `${name} test`, parameters: { type: 'object', properties: {} } },
  };
}

async function loadProvider() {
  process.env.OPENENSEMBLE_LAB = '1';
  process.env.OE_LAB_CODEX_RELAY = '1';
  vi.resetModules();
  return import('./openai-responses.mjs');
}

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

afterEach(() => {
  delete process.env.OPENENSEMBLE_LAB;
  delete process.env.OE_LAB_CODEX_RELAY;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('OpenAI Responses isolated access-snapshot relay', () => {
  it('permits three sequential tools plus the fourth final-answer round', async () => {
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      round++;
      return round <= 3 ? toolCallResponse(round) : textCodexResponse('Final report after three tools.');
    }));
    const { streamOpenAIResponses } = await loadProvider();
    const events = await collect(streamOpenAIResponses({
      id: 'jarvis_lab', provider: 'openai-oauth', model: 'gpt-5.4-mini',
      tools: [functionTool('web_search')],
    }, 'system', [{ role: 'user', content: 'run three steps then report' }], AbortSignal.timeout(5_000), 'user_lab'));

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(3);
    expect(events).toContainEqual({ type: '__content', content: 'Final report after three tools.' });
    expect(events).toContainEqual(expect.objectContaining({
      type: '__usage', reqCount: 4, completionCount: 4, usageCount: 4, usageComplete: true,
    }));
  });

  it('accepts Codex clean EOF after one complete terminal record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completedResponse({ includeDone: false })));
    const { streamOpenAIResponses } = await loadProvider();
    const events = await collect(streamOpenAIResponses({
      id: 'jarvis_lab', provider: 'openai-oauth', model: 'gpt-5.4-mini', tools: [],
    }, 'system', [{ role: 'user', content: 'reply once' }], AbortSignal.timeout(5_000), 'user_lab'));

    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: '__usage', usageComplete: true }));
  });

  it('rejects malformed JSON framed after response.completed', async () => {
    const terminal = `data: ${JSON.stringify({
      type: 'response.completed',
      response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } },
    })}\n\ndata: {"type":\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(terminal, { status: 200 })));
    const { streamOpenAIResponses } = await loadProvider();

    await expect(collect(streamOpenAIResponses({
      id: 'jarvis_lab', provider: 'openai-oauth', model: 'gpt-5.4-mini', tools: [],
    }, 'system', [{ role: 'user', content: 'reply once' }], AbortSignal.timeout(5_000), 'user_lab')))
      .rejects.toThrow(/Malformed SSE JSON event/);
  });

  it('rejects a partial trailing SSE record after response.completed', async () => {
    const terminal = `data: ${JSON.stringify({
      type: 'response.completed',
      response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } },
    })}\n\ndata: {"type":`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(terminal, { status: 200 })));
    const { streamOpenAIResponses } = await loadProvider();

    await expect(collect(streamOpenAIResponses({
      id: 'jarvis_lab', provider: 'openai-oauth', model: 'gpt-5.4-mini', tools: [],
    }, 'system', [{ role: 'user', content: 'reply once' }], AbortSignal.timeout(5_000), 'user_lab')))
      .rejects.toThrow(/Truncated SSE event at clean EOF/);
  });

  it('keeps the product endpoint while offering only ordinary OE function tools', async () => {
    let request;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      return completedResponse();
    }));
    const { streamOpenAIResponses } = await loadProvider();
    await collect(streamOpenAIResponses({
      id: 'jarvis_lab', provider: 'openai-oauth', model: 'gpt-5.4-mini',
      tools: [functionTool('web_search'), functionTool('generate_image')],
    }, 'system', [{ role: 'user', content: 'test tools' }], AbortSignal.timeout(5_000), 'user_lab'));

    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(request.body.tools.map(tool => tool.name)).toEqual(['web_search', 'generate_image']);
    expect(request.body.tools.every(tool => tool.type === 'function')).toBe(true);
    expect(request.body).not.toHaveProperty('max_output_tokens');
  });

  it.each([401, 403])('never invokes OAuth refresh when the access-only relay returns %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'token_invalidated' }),
      { status, headers: { 'content-type': 'application/json' } },
    )));
    const { streamOpenAIResponses } = await loadProvider();
    const events = await collect(streamOpenAIResponses({
      id: 'jarvis_lab', provider: 'openai-oauth', model: 'gpt-5.4-mini', tools: [],
    }, 'system', [{ role: 'user', content: 'hello' }], AbortSignal.timeout(5_000), 'user_lab'));

    expect(auth.ensureFreshToken).toHaveBeenCalledTimes(1);
    expect(auth.forceRefreshToken).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: 'The lab provider access snapshot is unavailable or expired.',
    });
  });
});
