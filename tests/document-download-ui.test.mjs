import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const docsSource = fs.readFileSync(new URL('../public/docs.js', import.meta.url), 'utf8');

function downloadHarness(token = 'short lived token') {
  const anchors = [];
  const body = { appendChild: vi.fn() };
  const document = {
    body,
    addEventListener: vi.fn(),
    createElement: vi.fn(tag => {
      expect(tag).toBe('a');
      const anchor = { style: {}, click: vi.fn(), remove: vi.fn() };
      anchors.push(anchor);
      return anchor;
    }),
  };
  const context = vm.createContext({
    console,
    document,
    fetch: vi.fn(),
    getMediaTokenSync: vi.fn(() => token),
    setTimeout,
    clearTimeout,
    URL,
    Blob,
  });
  vm.runInContext(docsSource, context, { filename: 'public/docs.js' });
  return {
    anchors,
    body,
    context,
    run: code => vm.runInContext(code, context),
  };
}

describe('Documents browser downloads', () => {
  it('starts generated-video downloads through the streaming attachment route', () => {
    const { anchors, body, context, run } = downloadHarness();
    const filename = 'TWICE tour [clip] 특별.mp4';

    run(`downloadAiFile('videos', ${JSON.stringify(filename)})`);

    expect(context.fetch).not.toHaveBeenCalled();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].href).toBe(
      `/api/files/videos/${encodeURIComponent(filename)}?token=short%20lived%20token`,
    );
    expect(anchors[0].download).toBe(filename);
    expect(body.appendChild).toHaveBeenCalledWith(anchors[0]);
    expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(anchors[0].remove).toHaveBeenCalledOnce();
    expect(body.appendChild.mock.invocationCallOrder[0]).toBeLessThan(anchors[0].click.mock.invocationCallOrder[0]);
    expect(anchors[0].click.mock.invocationCallOrder[0]).toBeLessThan(anchors[0].remove.mock.invocationCallOrder[0]);
  });

  it('does not blob-buffer uploaded document downloads', () => {
    const { anchors, context, run } = downloadHarness();

    run(`downloadDoc('doc/video 1', 'uploaded-video.mp4')`);

    expect(context.fetch).not.toHaveBeenCalled();
    expect(anchors[0].href).toBe(
      '/api/shared-docs/doc%2Fvideo%201/download?token=short%20lived%20token',
    );
    expect(anchors[0].download).toBe('uploaded-video.mp4');
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });
});
