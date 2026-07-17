import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_ID,
  SCOPES,
  GROK_CLI_PROXY_BASE,
  GROK_CLI_HEADERS,
  requestDeviceCode,
  pollDeviceToken,
  refreshTokens,
} from './xai-oauth-auth.mjs';

describe('xai-oauth-auth constants', () => {
  it('uses the public Grok CLI client and CLI proxy', () => {
    expect(CLIENT_ID).toMatch(/^[0-9a-f-]{36}$/i);
    expect(SCOPES).toContain('grok-cli:access');
    expect(SCOPES).toContain('offline_access');
    expect(GROK_CLI_PROXY_BASE).toBe('https://cli-chat-proxy.grok.com/v1');
    expect(GROK_CLI_HEADERS['x-xai-token-auth']).toBe('xai-grok-cli');
  });
});

describe('xai-oauth-auth network helpers', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requestDeviceCode posts client_id + scope', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        device_code: 'dc',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://accounts.x.ai/oauth2/device',
        verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      }),
    });
    const d = await requestDeviceCode();
    expect(d.user_code).toBe('ABCD-EFGH');
    expect(d.device_code).toBe('dc');
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/oauth2/device/code');
    expect(opts.method).toBe('POST');
    expect(String(opts.body)).toContain(`client_id=${CLIENT_ID}`);
    expect(String(opts.body)).toContain('scope=');
  });

  it('pollDeviceToken maps authorization_pending', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'authorization_pending' }),
    });
    const r = await pollDeviceToken('dc');
    expect(r.status).toBe('pending');
  });

  it('pollDeviceToken returns tokens on success', async () => {
    // Minimal JWT with exp far in the future
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'a@b.c' })).toString('base64url');
    const access = `hdr.${payload}.sig`;
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: access,
        refresh_token: 'rt-1',
        id_token: access,
      }),
    });
    const r = await pollDeviceToken('dc');
    expect(r.status).toBe('ok');
    expect(r.token.access_token).toBe(access);
    expect(r.token.refresh_token).toBe('rt-1');
    expect(r.token.email).toBe('a@b.c');
  });

  it('refreshTokens requires a rotated refresh_token', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'new-at' }),
    });
    await expect(refreshTokens('old-rt')).rejects.toThrow(/refresh_token/);
  });

  it('refreshTokens marks 403 as entitlement', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'forbidden',
    });
    try {
      await refreshTokens('rt');
      expect.unreachable();
    } catch (e) {
      expect(e.entitlement).toBe(true);
      expect(e.status).toBe(403);
    }
  });
});
