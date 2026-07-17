import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { USERS_DIR } from './paths.mjs';
import { getRunTrace, listRunTraces, recordRunTrace } from './run-inspector.mjs';

const createdUsers = [];
function uniqueUser() {
  const id = `run_trace_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  createdUsers.push(id);
  return id;
}

function modelCall(hash = 'a'.repeat(64), overrides = {}) {
  return {
    provider: 'openai-oauth', model: 'gpt-test', providerRound: 1,
    toolsPresent: true, toolNames: [], toolCount: 0, toolSchemaBytes: 2, schemaTokEst: 1,
    schemaHash: hash,
    ...overrides,
  };
}

afterEach(() => {
  for (const userId of createdUsers.splice(0)) {
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
});

describe('run inspector model-call evidence', () => {
  it('retains the complete ordered 4x tool surface with turn correlation', () => {
    const userId = uniqueUser();
    const toolNames = Array.from({ length: 1008 }, (_, i) => `tool_${String(i).padStart(4, '0')}`);
    const saved = recordRunTrace(userId, {
      turnId: 'turn_exact', rootId: 'root_exact', messageId: 'message_exact', attemptId: 'attempt_exact',
      agentId: 'jarvis', status: 'complete',
      routing: { initialSkills: ['email'], matchedSkills: ['email'], addedSkills: [] },
      modelCalls: [modelCall('a'.repeat(64), {
        ordinal: 1, selectedSkills: ['email'], toolNames, toolCount: toolNames.length,
        requestedReasoningEffort: 'high', wireReasoningEffort: 'high',
        toolSchemaBytes: 123456, schemaTokEst: 30864,
      })],
    });

    const trace = getRunTrace(userId, saved.id);
    expect(trace).toMatchObject({
      turnId: 'turn_exact', rootId: 'root_exact', messageId: 'message_exact', attemptId: 'attempt_exact',
      modelCallTraceComplete: true,
    });
    expect(trace.modelSchemaBundles).toEqual([expect.objectContaining({
      schemaHash: 'a'.repeat(64), toolNames,
    })]);
    expect(trace.modelCalls[0]).toMatchObject({
      requestedReasoningEffort: 'high', wireReasoningEffort: 'high',
    });
    expect(trace.routing.matchedSkills).toEqual(['email']);
    expect(listRunTraces(userId, { limit: 1 })[0]).toMatchObject({
      turnId: 'turn_exact', rootId: 'root_exact', modelCallCount: 1,
      schemaTokEst: 30864, modelCallTraceComplete: true,
      routing: { initialSkills: ['email'], matchedSkills: ['email'], addedSkills: [] },
    });
    expect(fs.statSync(path.join(USERS_DIR, userId, 'run-inspector.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('marks bounded or missing schema evidence incomplete', () => {
    const userId = uniqueUser();
    const toolNames = Array.from({ length: 4097 }, (_, i) => `tool_${i}`);
    const over = recordRunTrace(userId, {
      agentId: 'jarvis',
      modelCalls: [modelCall('b'.repeat(64), { toolNames, toolCount: toolNames.length })],
    });
    const missing = recordRunTrace(userId, { agentId: 'jarvis', modelExpected: true, modelCalls: [] });
    expect(getRunTrace(userId, over.id).modelCallTraceComplete).toBe(false);
    expect(getRunTrace(userId, over.id).modelSchemaBundles[0].toolNames).toHaveLength(4096);
    expect(getRunTrace(userId, missing.id).modelCallTraceComplete).toBe(false);
  });

  it('accepts a real zero-model path but rejects contradictory fast-path evidence', () => {
    const userId = uniqueUser();
    const fast = recordRunTrace(userId, { agentId: 'jarvis', modelExpected: false, modelCalls: [] });
    const calls = recordRunTrace(userId, {
      agentId: 'jarvis', modelExpected: false, modelCalls: [modelCall()],
    });
    const usage = recordRunTrace(userId, {
      agentId: 'jarvis', modelExpected: false, modelCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, requestCount: 1, completionCount: 1, usageRecordCount: 1, usageComplete: true },
    });
    expect(getRunTrace(userId, fast.id)).toMatchObject({
      modelCallTraceComplete: true, usageTotalsComplete: true, usageCardinalityComplete: true,
    });
    expect(getRunTrace(userId, calls.id).modelCallTraceComplete).toBe(false);
    expect(getRunTrace(userId, usage.id)).toMatchObject({
      usageTotalsComplete: false, usageCardinalityComplete: false,
    });
  });

  it('persists complete usage only when wire and logical-call counts agree', () => {
    const userId = uniqueUser();
    const saved = recordRunTrace(userId, {
      agentId: 'jarvis',
      modelCalls: [modelCall('c'.repeat(64)), modelCall('d'.repeat(64), { providerRound: 2 })],
      usage: {
        inputTokens: 1200, outputTokens: 80, cachedTokens: 900,
        cacheCreatedTokens: 0, requestCount: 2, completionCount: 2,
        usageRecordCount: 2, usageComplete: true,
      },
    });
    expect(getRunTrace(userId, saved.id)).toMatchObject({
      usageTotalsComplete: true, usageCardinalityComplete: true,
      usage: { inputTokens: 1200, outputTokens: 80, requestCount: 2 },
    });

    const mismatch = recordRunTrace(userId, {
      agentId: 'jarvis', modelCalls: [modelCall('e'.repeat(64))],
      usage: {
        inputTokens: 20, outputTokens: 5, requestCount: 2,
        completionCount: 2, usageRecordCount: 2, usageComplete: true,
      },
    });
    expect(getRunTrace(userId, mismatch.id).usageCardinalityComplete).toBe(false);
  });

  it('never awards exact cost evidence to estimated usage', () => {
    const userId = uniqueUser();
    const saved = recordRunTrace(userId, {
      agentId: 'jarvis', modelCalls: [modelCall('f'.repeat(64))],
      usage: {
        inputTokens: 20, outputTokens: 5, estimated: true,
        requestCount: 1, completionCount: 1, usageRecordCount: 1, usageComplete: true,
      },
    });
    expect(getRunTrace(userId, saved.id)).toMatchObject({
      usageTotalsComplete: false,
      usageCardinalityComplete: true,
      usage: { estimated: true },
    });
  });

  it('redacts credential-shaped input, output, tool results, and metadata', () => {
    const userId = uniqueUser();
    const secret = 'sk-proj-abcdefghijklmnop';
    const saved = recordRunTrace(userId, {
      agentId: 'jarvis', modelExpected: false, modelCalls: [],
      input: `api_key=${secret}`,
      output: `Authorization: Bearer abcdefghijklmnop`,
      tools: {
        usedNames: ['unsafe_tool'],
        used: [{ name: 'unsafe_tool', argsPreview: '{"password":"hunter2"}', resultPreview: `token=${secret}` }],
        events: [{ name: 'unsafe_tool', status: 'done', preview: `Bearer abcdefghijklmnop` }],
      },
      meta: { memory: { access_token: secret, passwordNumber: 123456, text: `secret=${secret}` } },
    });
    const raw = JSON.stringify(getRunTrace(userId, saved.id));
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('123456');
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).toContain('REDACTED');
  });

  it('retains bounded tool-call identities and provider-native flags', () => {
    const userId = uniqueUser();
    const overlongId = `call-${'x'.repeat(600)}`;
    const secretShapedId = 'sk-proj-abcdefghijklmnop';
    const saved = recordRunTrace(userId, {
      agentId: 'jarvis', modelExpected: false, modelCalls: [],
      tools: {
        usedNames: ['image_generation'],
        used: [{
          name: 'image_generation', toolCallId: overlongId, providerNative: true,
          argsPreview: '', resultPreview: 'images:test.png',
        }],
        events: [{
          name: 'image_generation', toolCallId: 'call-image-1', providerNative: true,
          status: 'done', durationMs: 12, preview: 'generated',
        }],
        identityAnomalies: [{
          kind: 'tool_result_identity_anomaly', name: 'email_send',
          reason: 'unknown_result_identity', toolCallId: secretShapedId,
          identityType: 'string', identityLength: secretShapedId.length,
          resultPreview: 'token=sk-proj-abcdefghijklmnop', observedAt: 123,
        }],
      },
    });

    const trace = getRunTrace(userId, saved.id);
    expect(trace.tools.used[0]).toMatchObject({
      name: 'image_generation', providerNative: true,
    });
    expect(trace.tools.used[0].toolCallId).toBe(overlongId.slice(0, 512));
    expect(trace.tools.events[0]).toMatchObject({
      name: 'image_generation', toolCallId: 'call-image-1', providerNative: true,
    });
    expect(trace.tools.identityAnomalies[0]).toMatchObject({
      kind: 'tool_result_identity_anomaly', name: 'email_send',
      reason: 'unknown_result_identity', toolCallId: '[REDACTED]',
      identityType: 'string', identityLength: secretShapedId.length, observedAt: 123,
    });
    expect(JSON.stringify(trace.tools.identityAnomalies[0])).not.toContain(secretShapedId);
    expect(trace.tools.identityAnomalies[0].resultPreview).toContain('REDACTED');
    expect(trace.tools.identityAnomalies[0].resultPreview).not.toContain('abcdefghijklmnop');
  });
});
