import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock roles.mjs's executeToolStreaming BEFORE importing preview.mjs (which imports it).
vi.mock('../roles.mjs', () => ({
  executeToolStreaming: vi.fn(),
}));

const { drainToolWithEvents } = await import('../chat/preview.mjs');
const { executeToolStreaming } = await import('../roles.mjs');

// Helper: build an async generator that yields events then a final result.
function mockTool(events, resultText, delayMs = 0) {
  return async function* () {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    for (const ev of events) yield ev;
    yield { type: 'result', text: resultText };
  };
}

describe('drainToolWithEvents', () => {
  beforeEach(() => {
    executeToolStreaming.mockReset();
  });

  it('collects final text from a plain tool', async () => {
    executeToolStreaming.mockReturnValueOnce(mockTool([], 'hello world')());
    const out = await drainToolWithEvents('test_tool', {}, 'u1', 'a1');
    expect(out.text).toBe('hello world');
    expect(out.events).toEqual([]);
  });

  it('buffers permission_request and nested tool_call/tool_result events', async () => {
    executeToolStreaming.mockReturnValueOnce(mockTool([
      { type: 'permission_request', requestId: 'r1' },
      { type: 'tool_call', name: 'nested', args: { x: 1 } },
      { type: 'tool_result', name: 'nested', text: 'nested-result' },
    ], 'final')());
    const out = await drainToolWithEvents('outer_tool', {}, 'u1', 'a1');
    expect(out.text).toBe('final');
    expect(out.events).toHaveLength(3);
    expect(out.events[0].type).toBe('permission_request');
    expect(out.events[1].type).toBe('tool_call');
    expect(out.events[1].name).toBe('nested');
    expect(out.events[2].type).toBe('tool_result');
    expect(out.events[2].name).toBe('nested');
    expect(out.events[2].preview).toBeTruthy(); // preview must be generated
  });

  it('concatenates token chunks into final text when no result event', async () => {
    executeToolStreaming.mockReturnValueOnce((async function* () {
      yield { type: 'token', text: 'part1 ' };
      yield { type: 'token', text: 'part2' };
    })());
    const out = await drainToolWithEvents('streaming_tool', {}, 'u1', 'a1');
    expect(out.text).toBe('part1 part2');
  });

  it('returns error text when the tool throws', async () => {
    executeToolStreaming.mockReturnValueOnce((async function* () {
      throw new Error('boom');
    })());
    const out = await drainToolWithEvents('broken_tool', {}, 'u1', 'a1');
    expect(out.text).toMatch(/Tool error: boom/);
  });

  it('runs multiple tools in parallel (Promise.all faster than sum of delays)', async () => {
    // Two tools each take 200ms. Parallel = ~200ms; sequential = ~400ms.
    executeToolStreaming
      .mockReturnValueOnce(mockTool([], 'A done', 200)())
      .mockReturnValueOnce(mockTool([], 'B done', 200)());

    const t0 = Date.now();
    const [a, b] = await Promise.all([
      drainToolWithEvents('tool_a', {}, 'u1', 'a1'),
      drainToolWithEvents('tool_b', {}, 'u1', 'a1'),
    ]);
    const elapsed = Date.now() - t0;

    expect(a.text).toBe('A done');
    expect(b.text).toBe('B done');
    // Generous ceiling — parallel should be ~200ms, sequential would be ~400ms.
    // Failing here means Promise.all is not actually parallelizing.
    expect(elapsed).toBeLessThan(350);
  });
});
