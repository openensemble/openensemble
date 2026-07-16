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
});
