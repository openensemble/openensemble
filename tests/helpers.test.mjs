import { describe, it, expect } from 'vitest';
import {
  safeId, validatePassword, hashPassword, verifyPassword,
  createSession, getSessionUserId, deleteSession, clearUserSessions,
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
