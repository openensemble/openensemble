import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTelegramApiMessage } from './telegram.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('Telegram outbound delivery', () => {
  it('returns provider message ids only after every chunk is confirmed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const ids = await sendTelegramApiMessage('bot-token', 'chat-1', 'a'.repeat(4_097));
    expect(ids).toEqual([41, 42]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when Telegram rejects a send instead of reporting false success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, description: 'chat not found',
    }), { status: 400, headers: { 'content-type': 'application/json' } })));
    await expect(sendTelegramApiMessage('bot-token', 'chat-1', 'hello'))
      .rejects.toThrow('Telegram sendMessage failed: chat not found');
  });

  it('rejects a nominal success that lacks the durable provider message id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(sendTelegramApiMessage('bot-token', 'chat-1', 'hello'))
      .rejects.toThrow('without a message id');
  });
});
