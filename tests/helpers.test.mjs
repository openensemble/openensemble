import { describe, it, expect } from 'vitest';
import {
  safeId, validatePassword, hashPassword, verifyPassword,
  createSession, getSessionUserId, deleteSession, clearUserSessions,
  getAuthToken, setSessionCookie, clearSessionCookie,
  parseMultipart,
} from '../routes/_helpers.mjs';

describe('safeId', () => {
  it('strips path traversal characters', () => {
    expect(safeId('../../etc/passwd')).toBe('______etc_passwd');
  });

  it('preserves valid IDs', () => {
    expect(safeId('user_abc123')).toBe('user_abc123');
  });

  it('handles null/undefined', () => {
    expect(safeId(null)).toBe('');
    expect(safeId(undefined)).toBe('');
  });

  it('strips spaces and special chars', () => {
    expect(safeId('hello world!')).toBe('hello_world_');
  });
});

describe('validatePassword', () => {
  it('rejects empty passwords', () => {
    expect(validatePassword('')).toBeTruthy();
    expect(validatePassword(null)).toBeTruthy();
    expect(validatePassword(undefined)).toBeTruthy();
  });

  it('rejects short passwords', () => {
    expect(validatePassword('abc')).toMatch(/at least/);
  });

  it('accepts valid passwords', () => {
    expect(validatePassword('longpassword123')).toBeNull();
  });
});

describe('password hashing', () => {
  it('hashes and verifies correctly', async () => {
    const hash = await hashPassword('testpassword');
    expect(hash).toContain(':');
    expect(await verifyPassword('testpassword', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('testpassword');
    expect(await verifyPassword('wrongpassword', hash)).toBe(false);
  });

  it('rejects malformed stored hash', async () => {
    expect(await verifyPassword('test', '')).toBe(false);
    expect(await verifyPassword('test', 'nocolon')).toBe(false);
  });
});

describe('session management', () => {
  it('creates and validates sessions', () => {
    const token = createSession('user_test1');
    expect(token).toHaveLength(64);
    expect(getSessionUserId(token)).toBe('user_test1');
  });

  it('returns null for invalid tokens', () => {
    expect(getSessionUserId(null)).toBeNull();
    expect(getSessionUserId('')).toBeNull();
    expect(getSessionUserId('nonexistent')).toBeNull();
  });

  it('deletes sessions', () => {
    const token = createSession('user_test2');
    expect(getSessionUserId(token)).toBe('user_test2');
    deleteSession(token);
    expect(getSessionUserId(token)).toBeNull();
  });

  it('clears all sessions for a user', () => {
    const t1 = createSession('user_test3');
    const t2 = createSession('user_test3');
    const t3 = createSession('user_other');
    clearUserSessions('user_test3');
    expect(getSessionUserId(t1)).toBeNull();
    expect(getSessionUserId(t2)).toBeNull();
    expect(getSessionUserId(t3)).toBe('user_other');
    deleteSession(t3); // cleanup
  });
});

describe('cookie session auth', () => {
  // Minimal req/res shims — enough surface for the helpers under test.
  const makeReq = (cookieHeader, opts = {}) => ({
    headers: cookieHeader ? { cookie: cookieHeader, ...(opts.headers ?? {}) } : (opts.headers ?? {}),
    socket: { encrypted: !!opts.https },
  });
  const makeRes = () => {
    const headers = {};
    return {
      headers,
      setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
    };
  };

  it('reads a session token from the oe_session cookie', () => {
    const tok = createSession('user_cookie1');
    const req = makeReq(`oe_session=${tok}`);
    expect(getAuthToken(req)).toBe(tok);
    expect(getSessionUserId(getAuthToken(req))).toBe('user_cookie1');
    deleteSession(tok);
  });

  it('falls back to Authorization: Bearer when no cookie is present', () => {
    const tok = createSession('user_bearer1');
    const req = { headers: { authorization: `Bearer ${tok}` }, socket: {} };
    expect(getAuthToken(req)).toBe(tok);
    deleteSession(tok);
  });

  it('cookie takes precedence over a stale Authorization header', () => {
    const cookieTok = createSession('user_cookie2');
    const headerTok = createSession('user_bearer2');
    const req = makeReq(`oe_session=${cookieTok}`, {
      headers: { authorization: `Bearer ${headerTok}` },
    });
    expect(getAuthToken(req)).toBe(cookieTok);
    deleteSession(cookieTok); deleteSession(headerTok);
  });

  it('setSessionCookie emits HttpOnly + SameSite=Lax + Max-Age', () => {
    const req = makeReq();
    const res = makeRes();
    setSessionCookie(req, res, 'tok-123');
    const cookie = res.headers['Set-Cookie'];
    expect(cookie).toMatch(/^oe_session=tok-123/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toMatch(/Secure/); // http request → no Secure
  });

  it('setSessionCookie emits Secure on https requests', () => {
    const req = makeReq(undefined, { https: true });
    const res = makeRes();
    setSessionCookie(req, res, 'tok-https');
    expect(res.headers['Set-Cookie']).toMatch(/Secure/);
  });

  it('setSessionCookie respects X-Forwarded-Proto: https', () => {
    const req = makeReq(undefined, { headers: { 'x-forwarded-proto': 'https' } });
    const res = makeRes();
    setSessionCookie(req, res, 'tok-xfp');
    expect(res.headers['Set-Cookie']).toMatch(/Secure/);
  });

  it('clearSessionCookie sets Max-Age=0', () => {
    const res = makeRes();
    clearSessionCookie(makeReq(), res, 'tok-clr');
    expect(res.headers['Set-Cookie']).toMatch(/^oe_session=;/);
    expect(res.headers['Set-Cookie']).toMatch(/Max-Age=0/);
  });

  it('coexists with an existing Set-Cookie header', () => {
    const res = makeRes();
    res.setHeader('Set-Cookie', 'other=value; Path=/');
    setSessionCookie(makeReq(), res, 'tok-coexist');
    const cookies = res.headers['Set-Cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^other=value/);
    expect(cookies[1]).toMatch(/^oe_session=tok-coexist/);
  });
});

describe('parseMultipart', () => {
  it('parses a simple file upload', () => {
    const boundary = 'test-boundary';
    const body = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="test.txt"\r\n',
      'Content-Type: text/plain\r\n',
      '\r\n',
      'hello world\r\n',
      `--${boundary}--\r\n`,
    ].join('');

    const result = parseMultipart(Buffer.from(body), boundary);
    expect(result).not.toBeNull();
    expect(result.fileName).toBe('test.txt');
    expect(result.mimeType).toBe('text/plain');
  });

  it('returns null for no file', () => {
    const boundary = 'test-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nvalue\r\n--${boundary}--\r\n`;
    expect(parseMultipart(Buffer.from(body), boundary)).toBeNull();
  });
});
