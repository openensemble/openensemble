import { describe, expect, it } from 'vitest';
import { sanitizeBrowserContextUrl } from './lib/browser-url.mjs';
import { __test as image } from './lib/browser-image.mjs';

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
});
