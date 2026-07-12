import { beforeEach, describe, expect, it, vi } from 'vitest';

const devices = [
  { id: 'tv_owned', name: 'Living room TV', platform: 'android-tv', caps: ['tv_commands'] },
  { id: 'speaker_owned', name: 'Kitchen speaker', platform: null, caps: [] },
];

const isDeviceOnline = vi.fn(() => true);
const sendToDevice = vi.fn(() => 1);
const sendTvCommand = vi.fn(async () => ({ ok: true, data: null, error: null }));
const isUrlSafe = vi.fn(async () => ({ ok: true }));

vi.mock('./voice-devices.mjs', () => ({
  listDevices: vi.fn(userId => userId === 'user_owner' ? devices : []),
}));
vi.mock('./url-guard.mjs', () => ({ isUrlSafe }));
vi.mock('../ws-handler.mjs', () => ({ isDeviceOnline, sendToDevice }));
vi.mock('./tv-commands.mjs', () => ({ sendTvCommand }));

const {
  BrowserHandoffError,
  handoffBrowserContext,
  listHandoffTargets,
} = await import('./browser-handoff.mjs');

describe('browser handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDeviceOnline.mockReturnValue(true);
    sendToDevice.mockReturnValue(1);
    sendTvCommand.mockResolvedValue({ ok: true, data: null, error: null });
    isUrlSafe.mockResolvedValue({ ok: true });
  });

  it('lists only the user-owned devices with truthful capabilities', async () => {
    await expect(listHandoffTargets('user_owner')).resolves.toEqual([
      {
        id: 'tv_owned',
        name: 'Living room TV',
        kind: 'tv',
        online: true,
        capabilities: [{ mode: 'display', label: 'Display on TV' }],
      },
      {
        id: 'speaker_owned',
        name: 'Kitchen speaker',
        kind: 'speaker',
        online: true,
        capabilities: [{ mode: 'read_aloud', label: 'Read aloud' }],
      },
    ]);
    await expect(listHandoffTargets('user_other')).resolves.toEqual([]);
  });

  it('displays a bounded text card on an owned TV', async () => {
    const result = await handoffBrowserContext('user_owner', {
      targetId: 'tv_owned',
      mode: 'display',
      capture: {
        url: 'https://shop.example/product?session=secret#reviews',
        title: 'A useful product',
        text: 'Details '.repeat(500),
      },
    });

    expect(result).toMatchObject({ ok: true, targetKind: 'tv', mode: 'display' });
    expect(sendTvCommand).toHaveBeenCalledTimes(1);
    const [deviceId, action, payload] = sendTvCommand.mock.calls[0];
    expect(deviceId).toBe('tv_owned');
    expect(action).toBe('show');
    expect(payload).toMatchObject({ kind: 'text', title: 'A useful product' });
    expect(payload.body.length).toBeLessThanOrEqual(1_600);
    expect(payload.body).toContain('https://shop.example/product');
    expect(payload.body).not.toContain('session=secret');
  });

  it('reads only a bounded excerpt on an owned speaker', async () => {
    await handoffBrowserContext('user_owner', {
      targetId: 'speaker_owned',
      mode: 'read_aloud',
      capture: {
        url: 'https://example.com/long-article',
        title: 'Long article',
        text: 'paragraph '.repeat(2_000),
      },
    });

    expect(sendToDevice).toHaveBeenCalledTimes(2);
    const token = sendToDevice.mock.calls[0][1];
    expect(token).toMatchObject({ type: 'token', agent: 'system' });
    expect(token.text.length).toBeLessThanOrEqual(1_200);
    expect(token.text.length).toBeLessThan('paragraph '.repeat(2_000).length);
    expect(sendToDevice.mock.calls[1][1]).toMatchObject({ type: 'done', agent: 'system' });
  });

  it('rejects unowned targets before attempting delivery', async () => {
    await expect(handoffBrowserContext('user_owner', {
      targetId: 'tv_someone_elses',
      mode: 'display',
      capture: { url: 'https://example.com', title: 'Nope' },
    })).rejects.toMatchObject({ name: 'BrowserHandoffError', code: 'TARGET_NOT_FOUND' });
    expect(isUrlSafe).not.toHaveBeenCalled();
    expect(sendTvCommand).not.toHaveBeenCalled();
    expect(sendToDevice).not.toHaveBeenCalled();
  });

  it('rejects private-network URLs and unsupported modes', async () => {
    isUrlSafe.mockResolvedValueOnce({ ok: false, reason: 'blocked IP 127.0.0.1' });
    await expect(handoffBrowserContext('user_owner', {
      targetId: 'speaker_owned',
      mode: 'read_aloud',
      capture: { url: 'http://127.0.0.1/admin', title: 'Router' },
    })).rejects.toMatchObject({ code: 'UNSAFE_URL' });

    await expect(handoffBrowserContext('user_owner', {
      targetId: 'speaker_owned',
      mode: 'display',
      capture: { url: 'https://example.com', title: 'Wrong mode' },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_MODE' });
  });

  it('fails closed when a target is offline or delivery drops', async () => {
    isDeviceOnline.mockReturnValueOnce(false);
    await expect(handoffBrowserContext('user_owner', {
      targetId: 'tv_owned',
      mode: 'display',
      capture: { url: 'https://example.com', title: 'Offline' },
    })).rejects.toMatchObject({ code: 'TARGET_OFFLINE' });

    sendToDevice.mockReturnValueOnce(1).mockReturnValueOnce(0);
    await expect(handoffBrowserContext('user_owner', {
      targetId: 'speaker_owned',
      mode: 'read_aloud',
      capture: { url: 'https://example.com', title: 'Dropped' },
    })).rejects.toBeInstanceOf(BrowserHandoffError);
  });
});

