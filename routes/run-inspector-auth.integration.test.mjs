import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handle } from './run-inspector.mjs';
import { clearRunTraces, recordRunTrace } from '../lib/run-inspector.mjs';
import { createMediaToken, createSession } from './_helpers.mjs';

const USER_A = 'user_run_inspector_auth_a';
const USER_B = 'user_run_inspector_auth_b';
let traceA;
let sessionA;
let sessionB;
let mediaA;

function response() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(body = '') { this.body = String(body); },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function request(method, url, token = null) {
  return {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

beforeAll(() => {
  clearRunTraces(USER_A);
  clearRunTraces(USER_B);
  traceA = recordRunTrace(USER_A, {
    agentId: 'primary-a', modelExpected: false, modelCalls: [],
    input: 'private user A input', output: 'private user A output',
  });
  recordRunTrace(USER_B, {
    agentId: 'primary-b', modelExpected: false, modelCalls: [],
    input: 'private user B input', output: 'private user B output',
  });
  sessionA = createSession(USER_A, { kind: 'browser' });
  sessionB = createSession(USER_B, { kind: 'browser' });
  mediaA = createMediaToken(USER_A).token;
});

afterAll(() => {
  clearRunTraces(USER_A);
  clearRunTraces(USER_B);
});

describe('run inspector real authentication isolation', () => {
  it('rejects a minted media token for list, detail, and delete', async () => {
    for (const [method, url, bearer] of [
      ['GET', `/api/run-inspector?token=${mediaA}`, null],
      ['GET', `/api/run-inspector/${encodeURIComponent(traceA.id)}?token=${mediaA}`, null],
      ['DELETE', '/api/run-inspector', mediaA],
    ]) {
      const res = response();
      await handle(request(method, url, bearer), res);
      expect(res.statusCode).toBe(401);
    }
  });

  it('does not let another authenticated user read a trace by id', async () => {
    const foreign = response();
    await handle(request('GET', `/api/run-inspector/${encodeURIComponent(traceA.id)}`, sessionB), foreign);
    expect(foreign.statusCode).toBe(404);

    const owner = response();
    await handle(request('GET', `/api/run-inspector/${encodeURIComponent(traceA.id)}`, sessionA), owner);
    expect(owner.statusCode).toBe(200);
    expect(owner.json().inputPreview).toContain('private user A');
    expect(owner.headers['Cache-Control']).toBe('no-store');
  });

  it('lists only the authenticated user and disables response caching', async () => {
    const res = response();
    await handle(request('GET', '/api/run-inspector', sessionB), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.json().traces).toHaveLength(1);
    expect(res.json().traces[0].inputPreview).toContain('private user B');
    expect(res.body).not.toContain('private user A');
  });
});
