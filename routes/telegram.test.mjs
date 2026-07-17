import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimTelegramUpdate } from '../lib/telegram-update-ledger.mjs';
import { deliverTelegramChatResponse, sendTelegramApiMessage } from './telegram.mjs';

function unique(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

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

  it('awaits rejected terminal sends and leaves a durable fail-closed tombstone', async () => {
    const userId = unique('telegram_terminal_reject');
    const updateId = Math.floor(Date.now() / 10) + Math.floor(Math.random() * 1_000);
    expect(await claimTelegramUpdate(userId, updateId)).toBe(true);
    const dispatch = async ({ onEvent }) => {
      onEvent({ type: 'token', text: 'answer' });
      onEvent({ type: 'done' });
    };
    const rejectedSend = vi.fn(async () => { throw new Error('provider rejected terminal'); });
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(deliverTelegramChatResponse({
        userId,
        updateId,
        botToken: 'bot-token',
        chatId: 'chat-1',
        agentId: 'jarvis',
        text: 'hello',
        dispatch,
        sendApi: rejectedSend,
      })).rejects.toThrow('provider rejected terminal');
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(rejectedSend).toHaveBeenCalledOnce();
      expect(await claimTelegramUpdate(userId, updateId)).toBe(false);

      const retrySend = vi.fn(async () => [501]);
      await expect(deliverTelegramChatResponse({
        userId,
        updateId,
        botToken: 'bot-token',
        chatId: 'chat-1',
        agentId: 'jarvis',
        text: 'hello',
        dispatch,
        sendApi: retrySend,
      })).rejects.toThrow('prior Telegram dispatch may already have crossed');
      expect(retrySend).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
