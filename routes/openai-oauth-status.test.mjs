import { describe, expect, it } from 'vitest';
import { buildOpenAIOAuthStatus } from './openai-oauth.mjs';

describe('OpenAI OAuth public status metadata', () => {
  it('reports automatic renewal without exposing either token', () => {
    const status = buildOpenAIOAuthStatus({
      access_token: 'access-secret-canary',
      refresh_token: 'refresh-secret-canary',
      account_id: 'acct_123',
      plan_type: 'plus',
      expires_at: 1_786_000_000_000,
    }, true);
    expect(status).toEqual({
      connected: true,
      accountId: 'acct_123',
      plan: 'plus',
      expiresAt: 1_786_000_000_000,
      autoRenews: true,
    });
    expect(JSON.stringify(status)).not.toContain('secret-canary');
  });

  it('does not claim renewal without a stored refresh token', () => {
    expect(buildOpenAIOAuthStatus({ access_token: 'secret', expires_at: 123 }, true))
      .toEqual({ connected: true, accountId: null, plan: null, expiresAt: 123, autoRenews: false });
  });
});
