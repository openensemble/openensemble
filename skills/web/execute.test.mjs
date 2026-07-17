import { afterEach, describe, expect, it, vi } from 'vitest';
import execute from './execute.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('web skill cancellation', () => {
  it('rethrows owner cancellation instead of returning a search error', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_, reject) => {
      const onAbort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    })));

    const owner = new AbortController();
    const pending = execute(
      'web_search',
      { query: 'cancelled search' },
      'user_test',
      'agent_test',
      { signal: owner.signal },
    );
    const reason = new Error('worker stopped');
    reason.name = 'AbortError';
    owner.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('does not start work for an already-cancelled owner', async () => {
    const owner = new AbortController();
    const reason = new Error('already stopped');
    reason.name = 'AbortError';
    owner.abort(reason);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(execute(
      'fetch_url',
      { url: 'https://example.com' },
      'user_test',
      'agent_test',
      { signal: owner.signal },
    )).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
