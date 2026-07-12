import { afterEach, describe, expect, it } from 'vitest';
import {
  dropBrowser,
  handleResult,
  listBrowsers,
  registerBrowser,
  sendCommand,
} from './browser-bus.mjs';

const sockets = [];

function fakeSocket(onFrame = null) {
  const ws = {
    sent: [],
    send(raw) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      onFrame?.(frame);
    },
  };
  sockets.push(ws);
  return ws;
}

afterEach(() => {
  for (const ws of sockets.splice(0)) dropBrowser(ws);
});

describe('browser bus privacy boundaries', () => {
  it('never stores tab inventory supplied during registration', () => {
    const ws = fakeSocket();
    registerBrowser(ws, {
      userId: 'user_browser_test',
      name: 'Test Browser',
      version: '1.0.0',
      tabs: [{ tabId: 7, url: 'https://private.example/', title: 'Should not persist' }],
    });

    expect(listBrowsers('user_browser_test')).toEqual([
      expect.objectContaining({ name: 'Test Browser', version: '1.0.0' }),
    ]);
    expect(listBrowsers('user_browser_test')[0]).not.toHaveProperty('tabs');
    expect(listBrowsers('user_browser_test')[0]).not.toHaveProperty('tabCount');
  });

  it('fetches gated state through an exact connection command', async () => {
    let ws;
    ws = fakeSocket(frame => {
      queueMicrotask(() => handleResult({
        type: 'result',
        cmdId: frame.cmdId,
        ok: true,
        data: [{ tabId: 1, url: 'https://example.com/', active: true }],
      }));
    });
    const extId = registerBrowser(ws, { userId: 'user_browser_test', name: 'A', version: '1' });

    await expect(sendCommand('user_browser_test', 'list_tabs', {}, { extId })).resolves.toEqual([
      { tabId: 1, url: 'https://example.com/', active: true },
    ]);
    expect(ws.sent[0]).toMatchObject({ type: 'cmd', action: 'list_tabs', args: {} });
  });

  it('never retargets a stale extId to another browser profile', async () => {
    const first = fakeSocket();
    const second = fakeSocket();
    const staleId = registerBrowser(first, { userId: 'user_browser_test', name: 'A', version: '1' });
    registerBrowser(second, { userId: 'user_browser_test', name: 'B', version: '1' });
    dropBrowser(first);

    await expect(sendCommand('user_browser_test', 'list_tabs', {}, { extId: staleId }))
      .rejects.toThrow(/no longer connected/i);
    expect(second.sent).toEqual([]);
  });
});
