import { existsSync, rmSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_DIR } from '../../lib/paths.mjs';

const mocks = vi.hoisted(() => ({
  dispatchEphemeral: vi.fn(),
  getAgentsForUser: vi.fn(() => [{
    id: 'coordinator',
    name: 'Coordinator',
    provider: 'test',
    model: 'test-model',
    contextSize: 16_000,
  }]),
  getUser: vi.fn(() => ({})),
  isUrlSafe: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../background-tasks.mjs', () => ({
  dispatchEphemeral: mocks.dispatchEphemeral,
}));

vi.mock('../../roles.mjs', () => ({
  getRoleManifest: () => ({
    tools: [
      { function: { name: 'research_search' } },
      { function: { name: 'web_search' } },
      { function: { name: 'fetch_url' } },
    ],
  }),
  getRoleTools: () => [
    { function: { name: 'research_search' } },
    { function: { name: 'web_search' } },
    { function: { name: 'fetch_url' } },
  ],
  loadRoleManifests: vi.fn(),
}));

vi.mock('../../routes/_helpers.mjs', () => ({
  getAgentsForUser: mocks.getAgentsForUser,
  getUser: mocks.getUser,
}));

vi.mock('../../lib/url-guard.mjs', () => ({
  isUrlSafe: mocks.isUrlSafe,
}));

vi.mock('../../lib/execution-model-policy.mjs', () => ({
  validateExecutionModelAccess: vi.fn(async () => ({ ok: true, reason: 'available', status: 200 })),
}));

vi.mock('../../routes/_helpers/broadcast.mjs', () => ({
  broadcastToUsers: vi.fn(),
}));

import execute from './execute.mjs';

const cleanupDirs = new Set();

function cancellation(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function researchDir(userId) {
  const dir = path.join(BASE_DIR, 'users', userId, 'research');
  cleanupDirs.add(path.join(BASE_DIR, 'users', userId));
  return dir;
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function drainThrough(iterator, text) {
  const chunks = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error(`iterator ended before emitting ${text}`);
    chunks.push(next.value);
    if (String(next.value?.text || '').includes(text)) return chunks;
  }
}

function plannerAngles() {
  return JSON.stringify({ angles: [
    { title: 'One', query: 'question one' },
    { title: 'Two', query: 'question two' },
    { title: 'Three', query: 'question three' },
  ] });
}

afterEach(() => {
  mocks.dispatchEphemeral.mockReset();
  mocks.getAgentsForUser.mockClear();
  mocks.getUser.mockClear();
  mocks.isUrlSafe.mockReset();
  mocks.isUrlSafe.mockResolvedValue({ ok: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('deep research cancellation', () => {
  it('removes queued Brave searches and does not start more requests after cancellation', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'test-key');
    const signals = [];
    const fetchMock = vi.fn((_url, options) => {
      signals.push(options.signal);
      return waitForAbort(options.signal);
    });
    vi.stubGlobal('fetch', fetchMock);

    const owner = new AbortController();
    const reason = cancellation('cancel Brave queue');
    const iterator = execute(
      'research_search',
      { topic: 'bounded search cancellation', depth: 'standard', urls: [] },
      'cancel_brave_queue',
      'coordinator',
      { signal: owner.signal },
    );

    const first = await iterator.next();
    expect(first.value?.text).toContain('Searching in parallel');
    const pending = iterator.next();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    owner.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await new Promise(resolve => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('aborts a provided-page fetch without emitting fetch results or starting search', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'test-key');
    const fetchMock = vi.fn((_url, options) => waitForAbort(options.signal));
    vi.stubGlobal('fetch', fetchMock);

    const owner = new AbortController();
    const reason = cancellation('cancel page fetch');
    const iterator = execute(
      'research_search',
      { topic: 'page cancellation', depth: 'quick', urls: ['https://example.com/article'] },
      'cancel_page_fetch',
      'coordinator',
      { signal: owner.signal },
    );

    const first = await iterator.next();
    expect(first.value?.text).toContain('Fetching 1 provided URL');
    const pending = iterator.next();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('propagates planner cancellation before any worker output or save', async () => {
    const userId = 'cancel_deep_planner';
    mocks.dispatchEphemeral.mockImplementation((_agent, _task, _userId, options) => (
      waitForAbort(options.signal)
    ));

    const owner = new AbortController();
    const reason = cancellation('cancel planner');
    const iterator = execute(
      'deep_research_parallel',
      { topic: 'planner cancellation', depth: 'deep' },
      userId,
      'coordinator',
      { signal: owner.signal },
    );

    const chunks = await drainThrough(iterator, 'Planning research angles');
    const pending = iterator.next();
    await vi.waitFor(() => expect(mocks.dispatchEphemeral).toHaveBeenCalledTimes(1));
    owner.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(mocks.dispatchEphemeral.mock.calls[0][0].name).toBe('Planner');
    expect(chunks.map(chunk => chunk.text).join('')).not.toContain('Spawning');
    expect(existsSync(researchDir(userId))).toBe(false);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('propagates worker cancellation without entering synthesis or saving', async () => {
    const userId = 'cancel_deep_workers';
    mocks.dispatchEphemeral.mockImplementation((agent, _task, _userId, options) => {
      if (agent.name === 'Planner') return Promise.resolve(plannerAngles());
      return waitForAbort(options.signal);
    });

    const owner = new AbortController();
    const reason = cancellation('cancel workers');
    const iterator = execute(
      'deep_research_parallel',
      { topic: 'worker cancellation', depth: 'deep' },
      userId,
      'coordinator',
      { signal: owner.signal },
    );

    const chunks = await drainThrough(iterator, 'Spawning 3 research workers');
    const pending = iterator.next();
    await vi.waitFor(() => {
      const researchers = mocks.dispatchEphemeral.mock.calls
        .filter(call => call[0].name.startsWith('Researcher'));
      expect(researchers).toHaveLength(3);
    });
    owner.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(mocks.dispatchEphemeral.mock.calls.some(call => call[0].name === 'Synthesizer')).toBe(false);
    expect(chunks.map(chunk => chunk.text).join('')).not.toContain('Synthesizing 3 sub-reports');
    expect(existsSync(researchDir(userId))).toBe(false);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('propagates synthesizer cancellation without completion output or save', async () => {
    const userId = 'cancel_deep_synth';
    mocks.dispatchEphemeral.mockImplementation((agent, _task, _userId, options) => {
      if (agent.name === 'Planner') return Promise.resolve(plannerAngles());
      if (agent.name === 'Synthesizer') return waitForAbort(options.signal);
      return Promise.resolve('## Findings\nWorker result\n\n## Sources\n- https://example.com');
    });

    const owner = new AbortController();
    const reason = cancellation('cancel synthesis');
    const iterator = execute(
      'deep_research_parallel',
      { topic: 'synthesis cancellation', depth: 'deep' },
      userId,
      'coordinator',
      { signal: owner.signal },
    );

    const chunks = await drainThrough(iterator, 'Synthesizing 3 sub-reports');
    const pending = iterator.next();
    await vi.waitFor(() => {
      expect(mocks.dispatchEphemeral.mock.calls.some(call => call[0].name === 'Synthesizer')).toBe(true);
    });
    owner.abort(reason);

    await expect(pending).rejects.toBe(reason);
    const output = chunks.map(chunk => chunk.text).join('');
    expect(output).not.toContain('Saved as');
    expect(output).not.toContain('Deep research complete');
    expect(existsSync(researchDir(userId))).toBe(false);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('checks cancellation after a non-cooperative synthesizer and before auto-save', async () => {
    const userId = 'cancel_deep_save_boundary';
    const owner = new AbortController();
    const reason = cancellation('cancel before save');
    mocks.dispatchEphemeral.mockImplementation(async agent => {
      if (agent.name === 'Planner') return plannerAngles();
      if (agent.name === 'Synthesizer') {
        owner.abort(reason);
        return '# Abandoned synthesized result';
      }
      return '## Findings\nWorker result\n\n## Sources\n- https://example.com';
    });

    const run = (async () => {
      for await (const _chunk of execute(
        'deep_research_parallel',
        { topic: 'no abandoned saves', depth: 'deep' },
        userId,
        'coordinator',
        { signal: owner.signal },
      )) {}
    })();

    await expect(run).rejects.toBe(reason);
    expect(existsSync(researchDir(userId))).toBe(false);
    expect(mocks.dispatchEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Synthesizer' }),
      expect.any(String),
      userId,
      expect.objectContaining({ signal: owner.signal }),
    );
  });
});
