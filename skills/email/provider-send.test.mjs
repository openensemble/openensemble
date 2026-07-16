import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getAccessToken: vi.fn() }));

vi.mock('../../lib/google-auth.mjs', () => ({
  getAccessToken: mocks.getAccessToken,
}));

import { gmailComposeWithAttachments, gmailReply } from './execute.mjs';

beforeEach(() => {
  mocks.getAccessToken.mockReset();
  mocks.getAccessToken.mockResolvedValue('test-token');
  vi.unstubAllGlobals();
});

describe('Gmail outbound dispatch boundary', () => {
  it('marks immediately before the compose send request', async () => {
    const events = [];
    const fetch = vi.fn(async () => {
      events.push('send');
      return new Response(JSON.stringify({ id: 'sent-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const result = await gmailComposeWithAttachments({
      to: 'person@example.test',
      subject: 'Test',
      body: 'Body',
    }, 'user_test', 'account_test', () => events.push('mark'));

    expect(events).toEqual(['mark', 'send']);
    expect(result).toContain('Email sent');
    const [, request] = fetch.mock.calls[0];
    const raw = Buffer.from(JSON.parse(request.body).raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: person@example.test');
    expect(raw).toContain('\r\n\r\nBody');
  });

  it('preflights reply metadata before marking and sending', async () => {
    const events = [];
    const fetch = vi.fn()
      .mockImplementationOnce(async () => {
        events.push('metadata');
        return new Response(JSON.stringify({
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'From', value: 'Sender <sender@example.test>' },
              { name: 'Subject', value: 'Original' },
              { name: 'Message-ID', value: '<original@example.test>' },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      })
      .mockImplementationOnce(async () => {
        events.push('send');
        return new Response(JSON.stringify({ id: 'reply-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
    vi.stubGlobal('fetch', fetch);

    const result = await gmailReply({ messageId: 'message-1', body: 'Reply body' },
      'user_test', 'account_test', () => events.push('mark'));

    expect(events).toEqual(['metadata', 'mark', 'send']);
    expect(result).toContain('Reply sent');
    const [, request] = fetch.mock.calls[1];
    const payload = JSON.parse(request.body);
    expect(payload.threadId).toBe('thread-1');
    const raw = Buffer.from(payload.raw, 'base64url').toString('utf8');
    expect(raw).toContain('In-Reply-To: <original@example.test>');
    expect(raw).toContain('\r\n\r\nReply body');
  });

  it('does not mark or send when reply metadata preflight fails', async () => {
    const mark = vi.fn();
    const fetch = vi.fn(async () => new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetch);

    await expect(gmailReply({ messageId: 'missing', body: 'Reply body' },
      'user_test', 'account_test', mark)).rejects.toThrow('Gmail API error 404');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mark).not.toHaveBeenCalled();
  });
});
