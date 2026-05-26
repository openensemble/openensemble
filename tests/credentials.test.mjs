import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  storeCredential, getCredentialValue, listCredentials, deleteCredential,
  registerRedaction, unregisterRedaction, applyRedactions, redactSecret,
  _resetForTests,
} from '../lib/credentials.mjs';
import { getUserDir } from '../routes/_helpers/paths.mjs';

const TEST_USER = 'test_user_oe_admin';

function cleanupUser() {
  try { fs.rmSync(getUserDir(TEST_USER), { recursive: true, force: true }); } catch {}
}

describe('credentials at-rest store', () => {
  beforeEach(() => { cleanupUser(); _resetForTests(); });
  afterEach(() => { cleanupUser(); _resetForTests(); });

  it('round-trips encrypted credentials', async () => {
    await storeCredential(TEST_USER, { id: 'my_key', label: 'My Key', kind: 'api_key', value: 'sk-abc-123' });
    expect(getCredentialValue(TEST_USER, 'my_key')).toBe('sk-abc-123');
  });

  it('on-disk record never contains plaintext', async () => {
    await storeCredential(TEST_USER, { id: 'my_key', label: 'My Key', kind: 'api_key', value: 'sk-very-secret-value-9876' });
    const file = path.join(getUserDir(TEST_USER), 'credentials', 'my_key.json');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-very-secret-value-9876');
    expect(raw).toContain('encrypted');
  });

  it('listCredentials hides the value', async () => {
    await storeCredential(TEST_USER, { id: 'a', label: 'A', kind: 'api_key', value: 'AAA' });
    await storeCredential(TEST_USER, { id: 'b', label: 'B', kind: 'api_key', value: 'BBB' });
    const list = listCredentials(TEST_USER);
    expect(list.map(c => c.id).sort()).toEqual(['a', 'b']);
    for (const c of list) expect(c).not.toHaveProperty('value');
  });

  it('deleteCredential removes the file', async () => {
    await storeCredential(TEST_USER, { id: 'x', label: 'X', kind: 'api_key', value: 'xxx' });
    expect(deleteCredential(TEST_USER, 'x')).toBe(true);
    expect(getCredentialValue(TEST_USER, 'x')).toBeNull();
  });

  it('returns null for unknown id', () => {
    expect(getCredentialValue(TEST_USER, 'nope')).toBeNull();
  });

  it('rejects invalid ids', async () => {
    await expect(storeCredential(TEST_USER, { id: '../foo', value: 'x' })).rejects.toThrow(/invalid id/);
  });
});

describe('redaction registry', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('scrubs a registered value from a string', () => {
    registerRedaction('hunter2');
    expect(applyRedactions('the password is hunter2 OK')).toBe('the password is [REDACTED] OK');
  });

  it('is a no-op when nothing is registered', () => {
    expect(applyRedactions('the password is hunter2')).toBe('the password is hunter2');
  });

  it('handles regex metacharacters in the secret', () => {
    registerRedaction('a.b*c+');
    expect(applyRedactions('xx a.b*c+ yy')).toBe('xx [REDACTED] yy');
  });

  it('redactSecret one-shot helper', () => {
    expect(redactSecret('hello WORLD', 'WORLD')).toBe('hello [REDACTED]');
    expect(redactSecret('', 'WORLD')).toBe('');
    expect(redactSecret('hello', '')).toBe('hello');
  });

  it('unregister removes from set', () => {
    registerRedaction('topsecret');
    expect(applyRedactions('contains topsecret here')).toBe('contains [REDACTED] here');
    unregisterRedaction('topsecret');
    expect(applyRedactions('contains topsecret here')).toBe('contains topsecret here');
  });

  it('does not register very short values (4-char min)', () => {
    registerRedaction('abc');
    expect(applyRedactions('contains abc')).toBe('contains abc');
  });
});
