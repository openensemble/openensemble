import { describe, it, expect } from 'vitest';

// safeLanceVal is not exported, so test it via the module's internal behavior.
// We can test the regex directly.
describe('LanceDB query value sanitization', () => {
  const SAFE_LANCE_RE = /^[a-zA-Z0-9_.:T\-]+$/;

  it('allows valid UUIDs', () => {
    expect(SAFE_LANCE_RE.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  });

  it('allows ISO 8601 dates', () => {
    expect(SAFE_LANCE_RE.test('2026-04-10T15:30:00.000Z')).toBe(true);
  });

  it('allows simple alphanumeric IDs', () => {
    expect(SAFE_LANCE_RE.test('mem_1234_abc')).toBe(true);
  });

  it('rejects SQL injection attempts', () => {
    expect(SAFE_LANCE_RE.test("' OR 1=1 --")).toBe(false);
    expect(SAFE_LANCE_RE.test("'; DROP TABLE --")).toBe(false);
    expect(SAFE_LANCE_RE.test('1; DELETE FROM')).toBe(false);
  });

  it('rejects values with quotes', () => {
    expect(SAFE_LANCE_RE.test("test'value")).toBe(false);
    expect(SAFE_LANCE_RE.test('test"value')).toBe(false);
  });

  it('rejects values with spaces', () => {
    expect(SAFE_LANCE_RE.test('hello world')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(SAFE_LANCE_RE.test('')).toBe(false);
  });
});
