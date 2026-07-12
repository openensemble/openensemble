import { describe, expect, it, vi } from 'vitest';
import { extractBrowserPdf, BROWSER_PDF_LIMITS } from './lib/browser-pdf.mjs';

function pdfBase64(body = 'test') {
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF`).toString('base64');
}

describe('one-shot browser PDF extraction', () => {
  it('validates PDF bytes, bounds text, and sanitizes the display name', async () => {
    const convert = vi.fn(async bytes => {
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      return ` First page\0\n\nSecond page ${'x'.repeat(BROWSER_PDF_LIMITS.maxText)} `;
    });
    const result = await extractBrowserPdf({
      base64: pdfBase64(), name: '../statement.pdf\0',
    }, { convert });
    expect(result.name).toBe('.. statement.pdf');
    expect(result.text).toMatch(/^First page/);
    expect(result.text.length).toBe(BROWSER_PDF_LIMITS.maxText);
    expect(result.truncated).toBe(true);
  });

  it('rejects non-PDF, malformed, oversized, and empty-text payloads', async () => {
    await expect(extractBrowserPdf({ base64: Buffer.from('hello').toString('base64') }, { convert: async () => 'x' }))
      .rejects.toThrow(/invalid|too large/i);
    await expect(extractBrowserPdf({ base64: '!!!' }, { convert: async () => 'x' }))
      .rejects.toThrow(/invalid/i);
    const oversized = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(BROWSER_PDF_LIMITS.maxBytes)]).toString('base64');
    await expect(extractBrowserPdf({ base64: oversized }, { convert: async () => 'x' }))
      .rejects.toThrow(/too large/i);
    await expect(extractBrowserPdf({ base64: pdfBase64() }, { convert: async () => '   ' }))
      .rejects.toThrow(/No readable text/);
  });
});
