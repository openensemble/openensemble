import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const oauthSource = fs.readFileSync(new URL('./oauth.js', import.meta.url), 'utf8');
function loadFormatter() {
  const sandbox = { window: {}, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(oauthSource, sandbox, { filename: 'public/oauth.js' });
  return sandbox.formatOpenAIOAuthConnectionStatus;
}

describe('OpenAI OAuth connection status wording', () => {
  it('presents a refresh-capable login as auto-renewing', () => {
    const rendered = loadFormatter()({
      connected: true, accountId: 'abcdefgh1234', plan: 'plus',
      expiresAt: 1_786_000_000_000, autoRenews: true,
    }, () => 'July 15, 2026');
    expect(rendered.text).toBe('Connected (plus) · account abcdefgh… · auto-renews.');
    expect(rendered.title).toContain('refreshes it automatically');
  });

  it('retains expiry wording for a non-refreshable login', () => {
    expect(loadFormatter()({
      connected: true, expiresAt: 1_786_000_000_000, autoRenews: false,
    }, () => 'July 15, 2026')).toEqual({
      text: 'Connected · access token valid until July 15, 2026.', title: '',
    });
  });
});
