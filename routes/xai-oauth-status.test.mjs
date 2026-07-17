import { describe, it, expect } from 'vitest';
import { buildXaiOAuthStatus } from './xai-oauth.mjs';

describe('buildXaiOAuthStatus', () => {
  it('reports disconnected when no token', () => {
    expect(buildXaiOAuthStatus(null, false)).toEqual({
      connected: false,
      email: null,
      name: null,
      sub: null,
      expiresAt: null,
      autoRenews: false,
    });
  });

  it('exposes secret-free connection metadata', () => {
    const status = buildXaiOAuthStatus({
      access_token: 'secret',
      refresh_token: 'also-secret',
      email: 'user@x.ai',
      name: 'Ada',
      sub: 'sub-1',
      expires_at: 1_700_000_000_000,
    }, true);
    expect(status).toEqual({
      connected: true,
      email: 'user@x.ai',
      name: 'Ada',
      sub: 'sub-1',
      expiresAt: 1_700_000_000_000,
      autoRenews: true,
    });
    expect(JSON.stringify(status)).not.toMatch(/secret/);
  });
});
