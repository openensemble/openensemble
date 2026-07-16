import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));

vi.mock('./_helpers.mjs', () => ({
  requireAuth: mocks.requireAuth,
  safeError: vi.fn(),
}));
vi.mock('../lib/run-inspector.mjs', () => ({
  listRunTraces: vi.fn(() => []),
  getRunTrace: vi.fn(() => null),
  clearRunTraces: vi.fn(() => true),
}));

import { handle } from './run-inspector.mjs';

function response() {
  return { writeHead: vi.fn(), end: vi.fn() };
}

describe('run inspector authentication boundary', () => {
  beforeEach(() => mocks.requireAuth.mockReset().mockReturnValue(null));

  it('disables media-token authentication for list and detail reads', async () => {
    const listReq = { method: 'GET', url: '/api/run-inspector?token=media' };
    const detailReq = { method: 'GET', url: '/api/run-inspector/run_1?token=media' };
    await handle(listReq, response());
    await handle(detailReq, response());
    expect(mocks.requireAuth).toHaveBeenNthCalledWith(1, listReq, expect.anything(), { allowMediaToken: false });
    expect(mocks.requireAuth).toHaveBeenNthCalledWith(2, detailReq, expect.anything(), { allowMediaToken: false });
  });

  it('uses the same strict boundary for deletion', async () => {
    const req = { method: 'DELETE', url: '/api/run-inspector' };
    await handle(req, response());
    expect(mocks.requireAuth).toHaveBeenCalledWith(req, expect.anything(), { allowMediaToken: false });
  });
});
