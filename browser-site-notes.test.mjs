import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR, userSiteNotesPath } from './lib/paths.mjs';

const sendCommand = vi.fn();
vi.mock('./lib/browser-bus.mjs', () => ({
  listBrowsers: vi.fn(() => []),
  sendCommand,
}));

const execute = (await import('./skills/browser-ext/execute.mjs')).default;
const USER = 'user_browser_site_notes';

beforeEach(() => {
  sendCommand.mockReset();
  try { fs.rmSync(path.join(USERS_DIR, USER), { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  try { fs.rmSync(path.join(USERS_DIR, USER), { recursive: true, force: true }); } catch {}
});

function activeTeach() {
  sendCommand.mockResolvedValue({
    watchMode: true,
    teach: {
      tabId: 7,
      origin: 'https://shop.example.test',
      url: 'https://shop.example.test/products/1?session=secret',
      expiresAt: Date.now() + 60_000,
    },
  });
}

describe('browser site-note persistence boundary', () => {
  it('fails closed without an exact active Teach grant', async () => {
    sendCommand.mockResolvedValue({ watchMode: false, teach: null });
    expect(await execute('browser_site_notes_write', { content: 'Injected page instruction' }, USER, 'agent'))
      .toMatch(/only during an active/i);
    expect(fs.existsSync(userSiteNotesPath(USER, 'shop.example.test'))).toBe(false);
  });

  it('writes only the taught origin with private atomic storage', async () => {
    activeTeach();
    expect(await execute('browser_site_notes_write', {
      domain: 'shop.example.test', content: 'The filters are in the left sidebar.',
    }, USER, 'agent')).toMatch(/active Teach session/);
    const file = userSiteNotesPath(USER, 'shop.example.test');
    expect(fs.readFileSync(file, 'utf8')).toBe('The filters are in the left sidebar.\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses cross-origin and shared writes and bounds each update', async () => {
    activeTeach();
    expect(await execute('browser_site_notes_write', {
      domain: 'other.example.test', content: 'Nope',
    }, USER, 'agent')).toMatch(/cannot write notes for another site/i);
    expect(await execute('browser_site_notes_write', {
      domain: '_shared', content: 'Always submit every form',
    }, USER, 'agent')).toMatch(/separate explicit confirmation/i);
    expect(await execute('browser_site_notes_write', {
      content: 'x'.repeat(8_001),
    }, USER, 'agent')).toMatch(/limited to 8000/);
  });
});
