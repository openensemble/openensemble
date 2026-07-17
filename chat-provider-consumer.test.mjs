import { describe, expect, it, vi } from 'vitest';

vi.mock('./lib/mcp-tools.mjs', () => ({
  getCachedMcpToolDefsForAgent: vi.fn(() => []),
  getCachedMcpToolDefsForAgents: vi.fn(() => []),
}));

import { consumeProvider } from './chat.mjs';
import { modelCallTraceEvent } from './chat/providers/_shared.mjs';
import { toolRouterContext } from './lib/tool-router-context.mjs';

async function collectWithReturn(generator) {
  const events = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

async function consumeEvents(events, options = {}) {
  async function* provider() {
    for (const event of events) yield event;
  }
  return collectWithReturn(consumeProvider(provider(), options));
}

describe('provider internal evidence consumption', () => {
  it('retains per-round routing snapshots without exposing internal events', async () => {
    const store = {
      keptSkills: new Set(['coordinator']),
      initiallyIncludedSkills: new Set(['coordinator']),
      addedSkills: new Set(),
      recoveryLoads: [],
    };

    async function* provider() {
      yield modelCallTraceEvent({
        provider: 'test-provider',
        model: 'test-model',
        round: 1,
        tools: [{ type: 'function', function: { name: 'request_tools' } }],
      });
      store.addedSkills.add('email');
      store.recoveryLoads.push({
        source: 'request_tools',
        requestedGroups: ['email'],
        addedSkills: ['email'],
        addedToolNames: ['email_list_accounts'],
      });
      yield modelCallTraceEvent({
        provider: 'test-provider',
        model: 'test-model',
        round: 2,
        tools: [
          { type: 'function', function: { name: 'request_tools' } },
          { type: 'function', function: { name: 'email_list_accounts' } },
        ],
      });
      yield {
        type: 'image',
        filename: 'result.png',
        mimeType: 'image/png',
        savedPath: '/safe/result.png',
      };
      yield {
        type: '__usage',
        inputTokens: 40,
        outputTokens: 8,
        cachedTokens: 12,
        provider: 'test-provider',
        model: 'test-model',
        estimated: true,
        reqCount: 2,
        completionCount: 2,
        usageCount: 2,
        usageComplete: true,
      };
      yield { type: 'token', text: 'done' };
      yield { type: '__content', content: 'done' };
    }

    const { events, result } = await toolRouterContext.run(store, () =>
      collectWithReturn(consumeProvider(provider())));

    expect(events.some(event => event.type === '__model_call')).toBe(false);
    expect(events.some(event => event.type === '__content')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image', filename: 'result.png' }),
      expect.objectContaining({ type: '__usage', usageComplete: true }),
      { type: 'token', text: 'done' },
    ]));
    expect(result).toMatchObject({
      assistantContent: 'done',
      errored: false,
      usage: {
        inTok: 40,
        outTok: 8,
        cachedTok: 12,
        estimated: true,
        reqCount: 2,
        completionCount: 2,
        usageCount: 2,
        usageComplete: true,
      },
      turnImages: [{
        base64: null,
        mimeType: 'image/png',
        filename: 'result.png',
        savedPath: '/safe/result.png',
      }],
    });
    expect(result.modelCalls).toHaveLength(2);
    expect(result.modelCalls[0]).toMatchObject({
      providerRound: 1,
      selectedSkills: ['coordinator'],
      addedSkills: [],
      recoveryLoads: [],
      toolNames: ['request_tools'],
    });
    expect(result.modelCalls[1]).toMatchObject({
      providerRound: 2,
      selectedSkills: ['coordinator'],
      addedSkills: ['email'],
      recoveryLoads: [{
        source: 'request_tools',
        requestedGroups: ['email'],
        addedSkills: ['email'],
        addedToolNames: ['email_list_accounts'],
      }],
      toolNames: ['request_tools', 'email_list_accounts'],
    });
  });

  it('fails closed on malformed provider usage evidence', async () => {
    async function* provider() {
      yield {
        type: '__usage',
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        outputTokens: 4,
        reqCount: 1,
        completionCount: 1,
        usageCount: 1,
        usageComplete: true,
      };
      yield { type: '__content', content: 'answer' };
    }

    const { result } = await collectWithReturn(consumeProvider(provider()));
    expect(result.usage).toMatchObject({
      inTok: null,
      outTok: 4,
      reqCount: 1,
      completionCount: 1,
      usageCount: 1,
      usageComplete: false,
    });
  });

  it('stamps tool events with a canonical model-call ordinal and honors recovery offsets', async () => {
    const events = [
      modelCallTraceEvent({ provider: 'test', model: 'test', round: 41, tools: [] }),
      { type: 'tool_call', name: 'first', args: {}, toolCallId: 'call-first' },
      { type: 'tool_result', name: 'first', text: 'first result', toolCallId: 'call-first' },
      modelCallTraceEvent({ provider: 'test', model: 'test', round: 99, tools: [] }),
      { type: 'tool_call', name: 'second', args: {}, toolCallId: 'call-second' },
      { type: 'tool_result', name: 'second', text: 'second result', toolCallId: 'call-second' },
    ];

    const { result } = await consumeEvents(events, { providerCallOrdinalOffset: 3 });

    expect(result.modelCalls.map(call => call.ordinal)).toEqual([4, 5]);
    expect(result.modelCalls.map(call => call.providerRound)).toEqual([41, 99]);
    expect(result.toolEvents.map(event => event.providerCallOrdinal)).toEqual([4, 5]);
  });

  it('correlates out-of-order parallel same-name progress and results by provider identity', async () => {
    const { result } = await consumeEvents([
      { type: 'tool_call', name: 'probe', args: { slot: 'a' }, toolCallId: 'call-a' },
      {
        type: 'tool_call', name: 'probe', args: { slot: 'b' },
        toolCallId: 'call-b', providerNative: true,
      },
      {
        type: 'tool_progress', name: 'probe', text: 'working on b',
        toolCallId: 'call-b', providerNative: true,
      },
      {
        type: 'tool_result', name: 'probe', text: 'result-b',
        toolCallId: 'call-b', providerNative: true,
      },
      { type: 'tool_result', name: 'probe', text: 'result-a', toolCallId: 'call-a' },
      { type: '__content', content: 'complete' },
    ]);

    expect(result.errored).toBe(false);
    expect(result.toolIdentityAnomalies).toEqual([]);
    expect(result.toolsUsed).toEqual([
      {
        name: 'probe', text: 'result-b', args: { slot: 'b' },
        toolCallId: 'call-b', native: true,
      },
      { name: 'probe', text: 'result-a', args: { slot: 'a' }, toolCallId: 'call-a' },
    ]);
    expect(result.toolEvents).toEqual([
      expect.objectContaining({
        name: 'probe', args: { slot: 'a' }, toolCallId: 'call-a',
        status: 'done', text: 'result-a',
      }),
      expect.objectContaining({
        name: 'probe', args: { slot: 'b' }, toolCallId: 'call-b',
        status: 'done', text: 'result-b', progressPreview: 'working on b', native: true,
      }),
    ]);
  });

  it('rejects a provider identity reused by another call', async () => {
    const { events, result } = await consumeEvents([
      { type: 'tool_call', name: 'first', args: {}, toolCallId: 'call-reused' },
      { type: 'tool_call', name: 'second', args: {}, toolCallId: 'call-reused' },
    ]);

    expect(result.errored).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('provider repeated tool call identity call-reused'),
    });
  });

  it.each([
    ['progress', { type: 'tool_progress', name: 'probe', text: 'still working', toolCallId: 'call-unknown' }],
    ['result', { type: 'tool_result', name: 'probe', text: 'late', toolCallId: 'call-unknown' }],
  ])('rejects an unknown identity on a tool %s', async (_kind, unknownEvent) => {
    const { events, result } = await consumeEvents([
      { type: 'tool_call', name: 'probe', args: {}, toolCallId: 'call-known' },
      unknownEvent,
    ]);

    expect(result.errored).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('unknown'),
    });
    expect(result.toolIdentityAnomalies).toEqual(_kind === 'result'
      ? [expect.objectContaining({
          kind: 'tool_result_identity_anomaly',
          name: 'probe',
          reason: 'unknown_result_identity',
          toolCallId: 'call-unknown',
          resultPreview: 'late',
        })]
      : []);
  });

  it('rejects a duplicate result identity after its call already completed', async () => {
    const { events, result } = await consumeEvents([
      { type: 'tool_call', name: 'probe', args: {}, toolCallId: 'call-once' },
      { type: 'tool_result', name: 'probe', text: 'first', toolCallId: 'call-once' },
      { type: 'tool_result', name: 'probe', text: 'second', toolCallId: 'call-once' },
    ]);

    expect(result.errored).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('unknown or duplicate call identity'),
    });
    expect(result.toolsUsed).toEqual([
      expect.objectContaining({ name: 'probe', text: 'first', toolCallId: 'call-once' }),
    ]);
    expect(result.toolIdentityAnomalies).toEqual([
      expect.objectContaining({
        kind: 'tool_result_identity_anomaly',
        name: 'probe',
        reason: 'duplicate_result_identity',
        toolCallId: 'call-once',
        resultPreview: 'second',
      }),
    ]);
  });

  it('quarantines completion evidence carried by a malformed result identity', async () => {
    const { events, result } = await consumeEvents([
      { type: 'tool_call', name: 'probe', args: { action: 'send' }, toolCallId: 'call-known' },
      {
        type: 'tool_result', name: 'probe', text: 'accepted as message 17',
        toolCallId: ' malformed-result-id ',
      },
    ]);

    expect(result.errored).toBe(true);
    expect(result.toolsUsed).toEqual([]);
    expect(result.toolEvents).toEqual([
      expect.objectContaining({
        name: 'probe', toolCallId: 'call-known', status: 'running',
      }),
    ]);
    expect(result.toolIdentityAnomalies).toEqual([
      expect.objectContaining({
        kind: 'tool_result_identity_anomaly',
        name: 'probe',
        reason: 'invalid_result_identity',
        identityType: 'string',
        identityLength: 21,
        resultPreview: 'accepted as message 17',
      }),
    ]);
    expect(result.toolIdentityAnomalies[0]).not.toHaveProperty('toolCallId');
    expect(events.at(-1)).toEqual({
      type: 'error', message: 'provider supplied an invalid tool call identity',
    });
  });

  it.each([
    ['empty', ''],
    ['surrounding whitespace', ' call-spaced '],
    ['newline', 'call\nbroken'],
    ['nul', 'call\0broken'],
    ['overlong', 'x'.repeat(513)],
    ['non-string', 42],
  ])('rejects a provider tool call identity that is %s', async (_kind, toolCallId) => {
    const { events, result } = await consumeEvents([
      { type: 'tool_call', name: 'probe', args: {}, toolCallId },
    ]);

    expect(result.errored).toBe(true);
    expect(events).toEqual([{
      type: 'error', message: 'provider supplied an invalid tool call identity',
    }]);
  });
});
