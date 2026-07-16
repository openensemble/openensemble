import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { sanitizeBrowserContextUrl } from './lib/browser-url.mjs';
import { __test as image, fetchBrowserPublicResource } from './lib/browser-image.mjs';

describe('browser one-shot URL boundaries', () => {
  it('removes credentials, queries, and fragments before model/provider use', () => {
    expect(sanitizeBrowserContextUrl('https://user:pass@example.test/path/item?token=secret#account'))
      .toBe('https://example.test/path/item');
    expect(() => sanitizeBrowserContextUrl('file:///etc/passwd')).toThrow(/http/);
  });

  it('rejects credentialed and non-web selected-image URLs', () => {
    expect(() => image.validateUrl('http://user:pass@example.test/image.png')).toThrow(/not allowed/);
    expect(() => image.validateUrl('data:image/png;base64,AAAA')).toThrow(/not allowed/);
    expect(image.validateUrl('https://example.test/image.png').hostname).toBe('example.test');
  });

  it('blocks literal-private generated URLs and HTTPS redirects that downgrade toward them', async () => {
    expect(() => image.validateUrl('https://127.0.0.1/private.png', { requireHttps: true }))
      .toThrow(/private or unsafe/);
    expect(() => image.validateUrl('http://example.test/image.png', { requireHttps: true }))
      .toThrow(/HTTPS/);

    const redirect = Readable.from([]);
    redirect.statusCode = 302;
    redirect.headers = { location: 'http://127.0.0.1/internal.png' };
    const requestHttps = (_options, callback) => {
      queueMicrotask(() => callback(redirect));
      return { on() { return this; }, end() {}, destroy() {} };
    };
    await expect(fetchBrowserPublicResource('https://cdn.example.test/image.png', {
      maxBytes: 1024,
      mimePattern: /^image\/png$/,
      label: 'generated image',
      requireHttps: true,
    }, { requestHttps })).rejects.toThrow(/HTTPS|private or unsafe/);
  });

  it('propagates cancellation through the bounded generated-image request signal', async () => {
    const controller = new AbortController();
    let combinedSignal = null;
    let errorHandler = null;
    const requestHttps = (options) => {
      combinedSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        const error = new Error('generated image request cancelled');
        error.name = 'AbortError';
        queueMicrotask(() => errorHandler?.(error));
      }, { once: true });
      return {
        on(event, handler) { if (event === 'error') errorHandler = handler; return this; },
        end() {},
        destroy(error) { errorHandler?.(error); },
      };
    };
    const pending = fetchBrowserPublicResource('https://cdn.example.test/image.png', {
      maxBytes: 1024,
      mimePattern: /^image\/png$/,
      label: 'generated image',
      requireHttps: true,
      signal: controller.signal,
    }, { requestHttps });

    controller.abort(new Error('turn cancelled'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(combinedSignal?.aborted).toBe(true);
  });
});
