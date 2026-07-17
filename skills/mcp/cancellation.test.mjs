import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  getServerById: vi.fn(),
}));

vi.mock('../../lib/mcp-config.mjs', () => ({ getServerById: mocks.getServerById }));
vi.mock('../../lib/mcp-client.mjs', () => ({ callTool: mocks.callTool }));

const { executeSkillTool } = await import('./execute.mjs');

describe('MCP tool cancellation ownership', () => {
  beforeEach(() => {
    mocks.callTool.mockReset();
    mocks.getServerById.mockReset().mockReturnValue({ id: 'files', transport: 'stdio' });
  });

  it('passes the server-owned tool signal into the MCP SDK call', async () => {
    const controller = new AbortController();
    mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const events = [];
    for await (const event of executeSkillTool(
      'mcp_files__read_file',
      { path: '/tmp/example' },
      'user_test',
      'agent_test',
      { signal: controller.signal },
    )) events.push(event);

    expect(mocks.callTool).toHaveBeenCalledWith(
      'user_test',
      expect.objectContaining({ id: 'files' }),
      'read_file',
      { path: '/tmp/example' },
      { signal: controller.signal },
    );
    expect(events).toEqual([{ type: 'result', text: 'ok' }]);
  });

  it('rethrows cancellation instead of converting it into a normal tool result', async () => {
    const controller = new AbortController();
    const reason = new Error('stop MCP work');
    reason.name = 'AbortError';
    controller.abort(reason);
    mocks.callTool.mockRejectedValue(reason);

    const events = executeSkillTool(
      'mcp_files__read_file', {}, 'user_test', 'agent_test',
      { signal: controller.signal },
    );
    await expect(events.next()).rejects.toBe(reason);
  });
});
