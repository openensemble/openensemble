// @ts-check
/** One-shot PDF validation and text extraction for OE Bridge. */

import fs from 'fs';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { fetchBrowserPublicResource } from './browser-image.mjs';

// Browser WebSocket frames are capped at 2 MiB. 1.2 MB of PDF expands to
// roughly 1.6 MB base64, leaving room for the JSON envelope.
const MAX_PDF_BYTES = 1_200_000;
const MAX_PDF_TEXT = 100_000;
const PDF_TIMEOUT_MS = 20_000;

function decodePdf(base64) {
  const raw = String(base64 || '');
  if (!raw || raw.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('PDF payload was invalid or too large');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('PDF payload was invalid or too large');
  }
  return bytes;
}

function runPdftotext(bytes) {
  return new Promise((resolve, reject) => {
    const required = ['/usr/bin/systemd-run', '/usr/bin/pdftotext'];
    if (required.some(binary => !fs.existsSync(binary))) {
      reject(new Error('Sandboxed PDF extraction is unavailable on this server'));
      return;
    }
    // Poppler parses attacker-controlled bytes. Run it as a transient user
    // service with no network, no home access, a read-only filesystem, and
    // hard time/memory/task ceilings. There is deliberately no unsandboxed
    // fallback when the host cannot provide this boundary.
    const unit = `oe-browser-pdf-${process.pid}-${randomBytes(4).toString('hex')}`;
    const child = spawn('/usr/bin/systemd-run', [
      '--user', '--pipe', '--wait', '--quiet', '--collect', `--unit=${unit}`,
      '--property=PrivateNetwork=yes',
      '--property=NoNewPrivileges=yes',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=yes',
      '--property=PrivateTmp=yes',
      '--property=MemoryMax=268435456',
      '--property=TasksMax=16',
      '--property=RuntimeMaxSec=15s',
      '--property=RestrictAddressFamilies=AF_UNIX',
      '--', '/usr/bin/pdftotext', '-', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('PDF text extraction timed out'));
    }, PDF_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_PDF_TEXT * 2) {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error('PDF contains too much text'));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2_000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) finish(new Error(`PDF text extraction failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      else finish(null, stdout);
    });
    child.stdin.on('error', error => finish(error));
    child.stdin.end(bytes);
  });
}

/**
 * Convert an explicitly shared, bounded PDF into untrusted plain text.
 * The raw document is never persisted and the normal one-shot turn remains
 * tool-free.
 */
/**
 * @param {{base64?:unknown,name?:unknown}} [document]
 * @param {{convert?:(bytes:Buffer)=>Promise<unknown>}} [options]
 */
export async function extractBrowserPdf({ base64, name } = {}, { convert = runPdftotext } = {}) {
  const bytes = decodePdf(base64);
  const rawText = await convert(bytes);
  const text = String(rawText || '').replace(/\0/g, '').trim().slice(0, MAX_PDF_TEXT);
  if (!text) throw new Error('No readable text was found in this PDF');
  const safeName = String(name || 'browser-document.pdf')
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 120) || 'browser-document.pdf';
  return { name: safeName, text, byteLength: bytes.length, truncated: String(rawText || '').length > MAX_PDF_TEXT };
}

/** Fetch a public, cookie-free PDF with DNS pinning, then extract it. */
export async function fetchAndExtractBrowserPdf(url, options = {}) {
  const resource = await fetchBrowserPublicResource(url, {
    maxBytes: MAX_PDF_BYTES,
    mimePattern: /^application\/pdf$/,
    label: 'PDF',
    accept: 'application/pdf',
  }, options.fetch || {});
  return extractBrowserPdf({
    base64: resource.bytes.toString('base64'),
    name: resource.name,
  }, options.extract || {});
}

export const BROWSER_PDF_LIMITS = Object.freeze({ maxBytes: MAX_PDF_BYTES, maxText: MAX_PDF_TEXT });
export const __test = Object.freeze({ decodePdf });
