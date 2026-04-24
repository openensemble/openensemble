import { describe, it, expect } from 'vitest';
import path from 'path';
import { safeId, getUserDir, safeError } from '../routes/_helpers.mjs';
import { USERS_DIR } from '../lib/paths.mjs';

describe('path traversal prevention', () => {
  it('safeId blocks directory traversal in user IDs', () => {
    const malicious = ['../../../etc/passwd', '..%2f..%2fetc', '..\\..\\windows', 'user/../admin'];
    for (const id of malicious) {
      const safe = safeId(id);
      const resolved = path.resolve(path.join(USERS_DIR, safe));
      expect(resolved.startsWith(USERS_DIR)).toBe(true);
    }
  });

  it('getUserDir stays within USERS_DIR for sanitized IDs', () => {
    const dir = getUserDir(safeId('user_abc123'));
    expect(path.resolve(dir).startsWith(USERS_DIR)).toBe(true);
  });

  it('getUserDir with unsanitized traversal attempt resolves outside', () => {
    // This is why we always safeId() first — raw input can escape
    const dir = getUserDir('../../../etc');
    const resolved = path.resolve(dir);
    expect(resolved.startsWith(USERS_DIR)).toBe(false);
  });
});

describe('safeError', () => {
  it('logs error and sends generic message to client', () => {
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args);

    let writtenStatus = null;
    let writtenBody = null;
    const res = {
      headersSent: false,
      writeHead(status) { writtenStatus = status; },
      end(body) { writtenBody = body; },
    };

    const sensitiveError = new Error('API key sk-ant-12345 at /home/user/.openensemble/config.json');
    safeError(res, sensitiveError, 500);

    // Client should NOT see the sensitive message
    expect(writtenBody).not.toContain('sk-ant');
    expect(writtenBody).not.toContain('/home/user');
    expect(JSON.parse(writtenBody).error).toBe('Internal error');
    expect(writtenStatus).toBe(500);

    // Server-side log SHOULD have the full error
    expect(logged.length).toBeGreaterThan(0);

    console.error = originalError;
  });
});
