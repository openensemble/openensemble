import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { USERS_DIR } from '../lib/paths.mjs';
import { INVITES_PATH } from './_helpers/paths.mjs';

const { handle: handleAdminRoute } = await import('./admin.mjs');
const { handle: handleAgentRoute } = await import('./agents.mjs');
const {
  getUser,
  invalidateUsersCache,
  loadInvites,
  saveInvites,
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
const { isSkillAllowedForUser } = await import('../roles.mjs');

const touchedUsers = new Set();
const touchedSessions = new Set();
const legacyAgentFiles = new Set();

function request(method, url, body = null, headers = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = {
    remoteAddress: '198.51.100.42',
    localPort: 3737,
    encrypted: false,
  };
  return req;
}

function response() {
  const headers = new Map();
  return {
    statusCode: null,
    body: '',
    writeHead(status, nextHeaders = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(nextHeaders)) headers.set(name.toLowerCase(), value);
      return this;
    },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(chunk = '') {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

afterEach(async () => {
  saveInvites([]);
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
  for (const file of legacyAgentFiles) fs.rmSync(file, { force: true });
  legacyAgentFiles.clear();
  fs.rmSync(INVITES_PATH, { force: true });
});

describe('invite redemption authorization storage', () => {
  it('preserves an invited regular user\'s explicit allowedSkills: []', async () => {
    const token = 'a'.repeat(64);
    const creatorId = 'user_route_invite_creator';
    saveInvites([{
      token,
      role: 'user',
      allowedSkills: [],
      createdBy: creatorId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }]);

    const req = request('POST', `/api/invite/${token}`, {
      name: 'Restricted Invitee',
      password: 'Passw0rd!',
    });
    const res = response();

    expect(await handleAdminRoute(req, res)).toBe(true);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    touchedUsers.add(payload.user.id);
    touchedSessions.add(payload.token);
    legacyAgentFiles.add(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'agents', `${payload.user.id}.json`));

    expect(Object.prototype.hasOwnProperty.call(payload.user, 'allowedSkills')).toBe(true);
    expect(payload.user.allowedSkills).toEqual([]);
    const stored = getUser(payload.user.id);
    expect(Object.prototype.hasOwnProperty.call(stored, 'allowedSkills')).toBe(true);
    expect(stored.allowedSkills).toEqual([]);
    expect(stored.parentId).toBe(creatorId);
    expect(isSkillAllowedForUser('coordinator', payload.user.id)).toBe(false);
    expect(loadInvites()).toEqual([]);
  });
});

describe('child primary deletion protection', () => {
  it('blocks deletion of the remembered primary while effective mode is ensemble', async () => {
    const childId = 'user_route_child_remembered_primary';
    touchedUsers.add(childId);
    saveUser({
      id: childId,
      name: 'Managed Child',
      role: 'child',
      skills: [],
      allowedSkills: [],
      skillAssignments: {},
      orchestration: { mode: 'ensemble' },
    });
    const primary = createCustomAgent({
      name: 'Remembered Primary',
      emoji: 'P',
      description: 'child deletion regression fixture',
      provider: 'openai',
      model: 'gpt-4',
      toolSet: 'web',
      ownerId: childId,
    });
    saveUser({
      ...getUser(childId),
      orchestration: { mode: 'ensemble', primaryAgentId: primary.id },
    });
    expect(getOrchestrationPolicy(childId)).toEqual({
      mode: 'ensemble',
      primaryAgentId: primary.id,
    });

    const session = createSession(childId);
    touchedSessions.add(session);
    const req = request('DELETE', `/api/agents/${primary.id}`, null, {
      authorization: `Bearer ${session}`,
    });
    const res = response();

    expect(await handleAgentRoute(req, res)).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/managed by your parent or administrator/i);
    expect(loadCustomAgents().some(agent => agent.id === primary.id && agent.ownerId === childId)).toBe(true);
    expect(getUser(childId).orchestration).toEqual({
      mode: 'ensemble',
      primaryAgentId: primary.id,
    });
  });
});
