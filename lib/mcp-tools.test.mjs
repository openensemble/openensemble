import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const fixtures = vi.hoisted(() => ({
  serversByAgent: new Map(),
  serversByUser: new Map(),
  serverById: new Map(),
  toolsByServer: new Map(),
  runtimeAllowed: new Map(),
  listTools: vi.fn(),
  disconnect: vi.fn(),
  usersDir: `/tmp/oe-mcp-tools-test-${process.pid}`,
}));

vi.mock('./mcp-config.mjs', () => ({
  getServersAssignedToAgent: (userId, agentId) =>
    fixtures.serversByAgent.get(`${userId}::${agentId}`) ?? [],
  getServersForUser: userId => fixtures.serversByUser.get(userId) ?? [],
  getServerById: (userId, serverId) => fixtures.serverById.get(`${userId}::${serverId}`) ?? null,
}));

vi.mock('./mcp-client.mjs', () => ({
  listTools: fixtures.listTools,
  disconnect: fixtures.disconnect,
}));

vi.mock('../roles.mjs', () => ({
  isSkillRuntimeEnabledForUser: (skillId, userId) =>
    skillId === 'mcp' && (fixtures.runtimeAllowed.get(userId) ?? true),
}));

vi.mock('./paths.mjs', () => ({ USERS_DIR: fixtures.usersDir }));

import {
  getCachedMcpToolDefsForAgent,
  getCachedMcpToolDefsForAgents,
  reconnectServer,
  refreshAgentMcpTools,
  refreshUserMcpTools,
  warmAllUsersAtBoot,
} from './mcp-tools.mjs';

describe('single-agent MCP cache projection', () => {
  beforeEach(() => {
    fixtures.serversByAgent.clear();
    fixtures.serversByUser.clear();
    fixtures.serverById.clear();
    fixtures.toolsByServer.clear();
    fixtures.runtimeAllowed.clear();
    fixtures.listTools.mockReset();
    fixtures.listTools.mockImplementation(async (_userId, server) => fixtures.toolsByServer.get(server.id) ?? []);
    fixtures.disconnect.mockReset();
    fs.rmSync(fixtures.usersDir, { recursive: true, force: true });
    fs.mkdirSync(fixtures.usersDir, { recursive: true });
  });

  afterAll(() => fs.rmSync(fixtures.usersDir, { recursive: true, force: true }));

  it('unions current owned-agent caches, dedupes shared schemas, and excludes stale agents', async () => {
    const userId = `mcp_projection_${Date.now()}`;
    const shared = { id: 'shared' };
    const specialist = { id: 'specialist' };
    const stale = { id: 'stale' };
    fixtures.serversByAgent.set(`${userId}::primary`, [shared]);
    fixtures.serversByAgent.set(`${userId}::parked`, [shared, specialist]);
    fixtures.serversByAgent.set(`${userId}::deleted`, [stale]);
    fixtures.toolsByServer.set('shared', [{
      name: 'lookup',
      description: 'Shared lookup.',
      inputSchema: { type: 'object', properties: {} },
    }]);
    fixtures.toolsByServer.set('specialist', [{
      name: 'inspect',
      description: 'Specialist inspection.',
      inputSchema: { type: 'object', properties: {} },
    }]);
    fixtures.toolsByServer.set('stale', [{
      name: 'secret',
      description: 'Deleted-agent tool.',
      inputSchema: { type: 'object', properties: {} },
    }]);

    await refreshAgentMcpTools(userId, 'primary');
    await refreshAgentMcpTools(userId, 'parked');
    await refreshAgentMcpTools(userId, 'deleted');

    const names = getCachedMcpToolDefsForAgents(userId, ['primary', 'parked'])
      .map(tool => tool.function.name);
    expect(names).toEqual(['mcp_shared__lookup', 'mcp_specialist__inspect']);
    expect(names).not.toContain('mcp_stale__secret');
  });

  it('revokes cached schemas and disconnects servers before a denied agent refresh can list tools', async () => {
    const userId = `user_mcp_denied_agent_${Date.now()}`;
    const server = { id: 'private', assignedToAgents: ['primary'] };
    fixtures.serversByAgent.set(`${userId}::primary`, [server]);
    fixtures.serversByUser.set(userId, [server]);
    fixtures.toolsByServer.set(server.id, [{ name: 'secret_lookup' }]);

    fixtures.runtimeAllowed.set(userId, true);
    await refreshAgentMcpTools(userId, 'primary');
    expect(getCachedMcpToolDefsForAgent(userId, 'primary')).toHaveLength(1);

    fixtures.listTools.mockClear();
    fixtures.runtimeAllowed.set(userId, false);
    await expect(refreshAgentMcpTools(userId, 'primary')).resolves.toBe(false);

    expect(fixtures.listTools).not.toHaveBeenCalled();
    expect(fixtures.disconnect).toHaveBeenCalledWith(userId, server.id);
    expect(getCachedMcpToolDefsForAgent(userId, 'primary')).toEqual([]);
  });

  it('does not list tools during denied user refresh or reconnect', async () => {
    const userId = `user_mcp_denied_refresh_${Date.now()}`;
    const server = { id: 'private', assignedToAgents: ['primary'] };
    fixtures.serversByUser.set(userId, [server]);
    fixtures.serverById.set(`${userId}::${server.id}`, server);
    fixtures.runtimeAllowed.set(userId, false);

    await expect(refreshUserMcpTools(userId)).resolves.toBe(false);
    await expect(reconnectServer(userId, server.id)).resolves.toBe(false);

    expect(fixtures.listTools).not.toHaveBeenCalled();
    expect(fixtures.disconnect).toHaveBeenCalledWith(userId, server.id);
  });

  it('does not warm a denied user MCP config at boot', async () => {
    const userId = `user_mcp_denied_boot_${Date.now()}`;
    const server = { id: 'boot-private', assignedToAgents: ['primary'] };
    fixtures.serversByUser.set(userId, [server]);
    fixtures.runtimeAllowed.set(userId, false);
    const userDir = path.join(fixtures.usersDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'mcp.json'), '{}');

    await warmAllUsersAtBoot();

    expect(fixtures.listTools).not.toHaveBeenCalled();
    expect(fixtures.disconnect).toHaveBeenCalledWith(userId, server.id);
  });
});
