import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/mcp-tools.mjs', () => ({
  getCachedMcpToolDefsForAgent: vi.fn(() => []),
  getCachedMcpToolDefsForAgents: vi.fn(() => []),
}));

import { consumeProvider } from './chat.mjs';
import { streamOpenAIResponses } from './chat/providers/openai-responses.mjs';
import { USERS_DIR } from './lib/paths.mjs';
import { getRunTrace, listRunTraces, recordRunTrace } from './lib/run-inspector.mjs';

const createdUsers = [];

function uniqueUser(label) {
  const id = `responses_trace_${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  createdUsers.push(id);
  return id;
}

function responseSse(text, { inputTokens, outputTokens }) {
  const body = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        output: [],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collectWithReturn(generator) {
  const events = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function inspectorUsage(usage) {
  return {
    inputTokens: usage.inTok,
    outputTokens: usage.outTok,
    cachedTokens: usage.cachedTok,
    cacheCreatedTokens: usage.cacheCreateTok,
    requestCount: usage.reqCount,
    completionCount: usage.completionCount,
    usageRecordCount: usage.usageCount,
    usageComplete: usage.usageComplete,
  };
}

const traceTool = {
  type: 'function',
  function: {
    name: 'trace_probe',
    description: 'Provider trace integration fixture.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  },
};

function agent(tools) {
  return {
    id: 'responses-trace-agent',
    provider: 'grok',
    model: 'grok-4-fast-non-reasoning',
    maxToolLoops: 2,
    tools,
  };
}

describe('Responses request body to run-inspector evidence', () => {
  beforeEach(() => {
    process.env.GROK_API_KEY = 'responses-trace-integration-key';
  });

  afterEach(() => {
    delete process.env.GROK_API_KEY;
    vi.unstubAllGlobals();
    for (const userId of createdUsers.splice(0)) {
      fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
    }
  });

  it('preserves exact present-versus-omitted tool schemas and 1:1:1 usage cardinality', async () => {
    const requestBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      const ordinal = requestBodies.length;
      return responseSse(`answer-${ordinal}`, {
        inputTokens: 10 + ordinal,
        outputTokens: 2 + ordinal,
      });
    }));

    const cases = [
      { label: 'present', tools: [traceTool], toolsPresent: true },
      { label: 'omitted', tools: [], toolsPresent: false },
    ];
    const evidence = [];

    for (const testCase of cases) {
      const userId = uniqueUser(testCase.label);
      const provider = streamOpenAIResponses(
        agent(testCase.tools),
        'System prompt.',
        [{ role: 'user', content: 'Trace this request.' }],
        AbortSignal.timeout(5_000),
        userId,
      );
      const consumed = await collectWithReturn(consumeProvider(provider));
      expect(consumed.result).toMatchObject({ errored: false });
      expect(consumed.events.some(event => event.type === '__model_call')).toBe(false);

      const saved = recordRunTrace(userId, {
        turnId: `turn-${testCase.label}`,
        agentId: 'responses-trace-agent',
        provider: 'grok',
        model: 'grok-4-fast-non-reasoning',
        modelCalls: consumed.result.modelCalls,
        usage: inspectorUsage(consumed.result.usage),
      });
      evidence.push({
        ...testCase,
        body: requestBodies.at(-1),
        trace: getRunTrace(userId, saved.id),
        summary: listRunTraces(userId, { limit: 1 })[0],
      });
    }

    const present = evidence[0];
    expect(present.body).toHaveProperty('tools');
    const presentJson = JSON.stringify(present.body.tools);
    const presentBytes = Buffer.byteLength(presentJson, 'utf8');
    expect(present.trace).toMatchObject({
      modelCallTraceComplete: true,
      usageTotalsComplete: true,
      usageCardinalityComplete: true,
      usage: {
        requestCount: 1,
        completionCount: 1,
        usageRecordCount: 1,
        usageComplete: true,
      },
      modelCalls: [{
        toolsPresent: true,
        toolCount: 1,
        toolSchemaBytes: presentBytes,
        schemaTokEst: Math.ceil(presentBytes / 4),
        schemaHash: createHash('sha256').update(presentJson).digest('hex'),
      }],
      modelSchemaBundles: [{
        toolsPresent: true,
        toolNames: ['trace_probe'],
        toolCount: 1,
        toolSchemaBytes: presentBytes,
        schemaTokEst: Math.ceil(presentBytes / 4),
        schemaHash: createHash('sha256').update(presentJson).digest('hex'),
      }],
    });
    expect(present.summary).toMatchObject({
      modelCallCount: 1,
      requestCount: 1,
      modelCallTraceComplete: true,
      usageCardinalityComplete: true,
    });

    const omitted = evidence[1];
    expect(omitted.body).not.toHaveProperty('tools');
    const emptyHash = createHash('sha256').update('').digest('hex');
    expect(omitted.trace).toMatchObject({
      modelCallTraceComplete: true,
      usageTotalsComplete: true,
      usageCardinalityComplete: true,
      usage: {
        requestCount: 1,
        completionCount: 1,
        usageRecordCount: 1,
        usageComplete: true,
      },
      modelCalls: [{
        toolsPresent: false,
        toolCount: 0,
        toolSchemaBytes: 0,
        schemaTokEst: 0,
        schemaHash: emptyHash,
      }],
      modelSchemaBundles: [{
        toolsPresent: false,
        toolNames: [],
        toolCount: 0,
        toolSchemaBytes: 0,
        schemaTokEst: 0,
        schemaHash: emptyHash,
      }],
    });
    expect(omitted.summary).toMatchObject({
      modelCallCount: 1,
      requestCount: 1,
      modelCallTraceComplete: true,
      usageCardinalityComplete: true,
    });
  });
});
