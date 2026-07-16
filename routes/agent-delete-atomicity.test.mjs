import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { USERS_DIR } from '../lib/paths.mjs';

const failures = vi.hoisted(() => ({
  deleteAgentId: null,
  clearAssignmentsAgentId: null,
}));

vi.mock('../agents.mjs', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    async deleteCustomAgent(id) {
      if (failures.deleteAgentId === id) throw new Error('injected durable delete failure');
      return actual.deleteCustomAgent(id);
    },
  };
});

vi.mock('../roles.mjs', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    clearRoleAssignmentsForAgent(agentId, userId) {
      if (failures.clearAssignmentsAgentId === agentId) {
        throw new Error('injected assignment cleanup failure');
      }
      return actual.clearRoleAssignmentsForAgent(agentId, userId);
    },
  };
});

const { handle: handleAgentRoute } = await import('./agents.mjs');
const {
  getUser,
  invalidateUsersCache,
  saveUser,
} = await import('./_helpers.mjs');
const {
  createSession,
  deleteSession,
} = await import('./_helpers/auth-sessions.mjs');
const {
  createCustomAgent,
  deleteCustomAgent,
  loadCustomAgents,
} = await import('../agents.mjs');
const { getOrchestrationPolicy } = await import('../lib/orchestration-policy.mjs');
const { setRoleAssignment } = await import('../roles.mjs');
const { getUserTopologyState } = await import('../chat-dispatch/slot-registry.mjs');

const touchedUsers = new Set();
const touchedSessions = new Set();

function request(method, url, headers = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = {
    remoteAddress: '198.51.100.53',
    localPort: 3737,
    encrypted: false,
  };
  return req;
}

function response() {
  return {
    statusCode: null,
    body: '',
    writeHead(status) { this.statusCode = status; return this; },
    end(chunk = '') { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function createFixture(userId, name) {
  touchedUsers.add(userId);
  saveUser({
    id: userId,
    name,
    role: 'user',
    skills: [],
    skillAssignments: {},
    orchestration: { mode: 'ensemble' },
  });
  const agent = createCustomAgent({
    name: `${name} Agent`,
    emoji: 'A',
    description: 'agent deletion transaction fixture',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'web',
    ownerId: userId,
  });
  const token = createSession(userId);
  touchedSessions.add(token);
  return { agent, token };
}

afterEach(async () => {
  failures.deleteAgentId = null;
  failures.clearAssignmentsAgentId = null;
  for (const token of touchedSessions) deleteSession(token);
  touchedSessions.clear();
  for (const userId of touchedUsers) {
    for (const agent of loadCustomAgents().filter(candidate => candidate.ownerId === userId)) {
      await deleteCustomAgent(agent.id);
    }
    fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
  }
  touchedUsers.clear();
  invalidateUsersCache();
});

describe('DELETE /api/agents/:id commit ordering', () => {
  it('does not rewrite orchestration when durable deletion fails', async () => {
    const userId = 'user_delete_atomic_failure';
    const { agent, token } = createFixture(userId, 'Delete Failure');
    saveUser({
      ...getUser(userId),
      orchestration: { mode: 'single', primaryAgentId: agent.id },
    });
    failures.deleteAgentId = agent.id;

    const res = response();
    await handleAgentRoute(request('DELETE', `/api/agents/${agent.id}`, {
      authorization: `Bearer ${token}`,
    }), res);

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/durable delete failure/i);
    expect(loadCustomAgents().some(candidate => candidate.id === agent.id && candidate.ownerId === userId)).toBe(true);
    expect(getUser(userId).orchestration).toEqual({ mode: 'single', primaryAgentId: agent.id });
    expect(getOrchestrationPolicy(userId)).toEqual({ mode: 'single', primaryAgentId: agent.id });
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('reports success with a warning when cleanup fails after durable deletion', async () => {
    const userId = 'user_delete_cleanup_failure';
    const { agent, token } = createFixture(userId, 'Cleanup Failure');
    setRoleAssignment('coordinator', agent.id, userId);
    saveUser({
      ...getUser(userId),
      orchestration: { mode: 'single', primaryAgentId: agent.id },
    });
    failures.clearAssignmentsAgentId = agent.id;

    const res = response();
    await handleAgentRoute(request('DELETE', `/api/agents/${agent.id}`, {
      authorization: `Bearer ${token}`,
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json().warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/role-assignment cleanup.*injected assignment cleanup failure/i),
    ]));
    expect(loadCustomAgents().some(candidate => candidate.id === agent.id && candidate.ownerId === userId)).toBe(false);
    expect(getUser(userId).orchestration).toEqual({ mode: 'ensemble' });
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });
});
