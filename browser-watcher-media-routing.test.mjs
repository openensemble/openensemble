import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const websocketSource = fs.readFileSync(new URL('./public/websocket.js', import.meta.url), 'utf8');
const mediaCasesStart = websocketSource.indexOf("    case 'image':");
const mediaCasesEnd = websocketSource.indexOf("    case 'error':", mediaCasesStart);
const chatSource = fs.readFileSync(new URL('./public/chat.js', import.meta.url), 'utf8');
const authVideoStart = chatSource.indexOf('function authenticatedVideoUrl(rawUrl) {');
const authVideoEnd = chatSource.indexOf('\nfunction appendStreamingBubble()', authVideoStart);

if (mediaCasesStart < 0 || mediaCasesEnd < 0 || authVideoStart < 0 || authVideoEnd < 0) {
  throw new Error('Unable to locate watcher media browser handlers');
}

const mediaCases = websocketSource.slice(mediaCasesStart, mediaCasesEnd);
const videoBubbleSource = chatSource.slice(authVideoStart, authVideoEnd);

function makeMediaHandler() {
  const sessions = {};
  const appendImageBubble = vi.fn();
  const appendVideoBubble = vi.fn();
  const setTyping = vi.fn();
  const factory = new Function('deps', [
    "const activeAgent = 'primary';",
    'const sessions = deps.sessions;',
    "const clientSessionAgentId = agent => agent === 'user_fixture_primary' ? 'primary' : agent;",
    'const appendImageBubble = deps.appendImageBubble;',
    'const appendVideoBubble = deps.appendVideoBubble;',
    'const setTyping = deps.setTyping;',
    `return msg => { switch (msg.type) {\n${mediaCases}\n default: break; } };`,
  ].join('\n'));
  return {
    handle: factory({ sessions, appendImageBubble, appendVideoBubble, setTyping }),
    sessions,
    appendImageBubble,
    appendVideoBubble,
  };
}

describe('watcher media browser routing', () => {
  it.each([
    ['image', 'watcher.png'],
    ['video', 'watcher.mp4'],
  ])('normalizes a scoped watcher %s event to the raw active session', (type, filename) => {
    const renderer = makeMediaHandler();
    renderer.handle({
      type,
      agent: 'user_fixture_primary',
      filename,
      base64: type === 'image' ? 'aW1hZ2U=' : undefined,
      mimeType: type === 'image' ? 'image/png' : undefined,
      url: type === 'video' ? '/api/desktop/videos/watcher.mp4' : undefined,
      savedPath: `${type === 'image' ? 'images' : 'videos'}:${filename}`,
    });

    expect(renderer.sessions.primary).toHaveLength(1);
    expect(renderer.sessions.user_fixture_primary).toBeUndefined();
    if (type === 'image') expect(renderer.appendImageBubble).toHaveBeenCalledOnce();
    else expect(renderer.appendVideoBubble).toHaveBeenCalledOnce();
  });

  it('mints a fresh media token when a persisted local video is rendered', () => {
    const bubble = { appendChild: vi.fn() };
    const row = { querySelector: () => bubble };
    const created = [];
    const factory = new Function('deps', [
      "const getMediaTokenSync = () => 'fresh token';",
      'const URLSearchParams = globalThis.URLSearchParams;',
      "const msgEl = () => deps.row;",
      'const document = { createElement: tag => { const node = { tag, style: {}, appendChild: () => {} }; deps.created.push(node); return node; } };',
      "const icon = () => '';",
      'const escHtml = value => String(value);',
      'const addTimestamp = () => {};',
      'const insertBefore = () => {};',
      'const scrollToBottom = () => {};',
      videoBubbleSource,
      'return appendVideoBubble;',
    ].join('\n'));
    const appendVideoBubble = factory({ row, created });

    appendVideoBubble({
      url: '/api/desktop/videos/watcher.mp4?token=stale',
      filename: 'watcher.mp4',
    }, Date.now(), false);

    const video = created.find(node => node.tag === 'video');
    const download = created.find(node => node.tag === 'a');
    expect(video.src).toBe('/api/desktop/videos/watcher.mp4?token=fresh+token');
    expect(download.href).toBe(video.src);
  });
});
