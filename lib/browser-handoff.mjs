// @ts-check
/**
 * Deterministic browser-context handoff to devices the authenticated user owns.
 *
 * This module deliberately exposes only operations the current device clients
 * implement:
 *   - `display` on Android TVs: a short text card via the existing `show`
 *     tv_command.
 *   - `read_aloud` on voice devices: a bounded spoken excerpt via the existing
 *     token/done announcement path.
 *
 * It does not pretend the TV can open a URL. The Android client has no such
 * command today; a future implementation must add that capability on both
 * sides before it is advertised here.
 */

import { listDevices } from './voice-devices.mjs';
import { isUrlSafe } from './url-guard.mjs';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE_CHARS = 180;
const MAX_TV_BODY_CHARS = 1_600;
const MAX_SPOKEN_CHARS = 1_200;
const MAX_SOURCE_CHARS = 900;

export const HANDOFF_MODES = Object.freeze({
  DISPLAY: 'display',
  READ_ALOUD: 'read_aloud',
});

export class BrowserHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserHandoffError';
    this.code = code;
  }
}

function assertUserId(userId) {
  const value = String(userId || '');
  if (!USER_ID_RE.test(value)) {
    throw new BrowserHandoffError('INVALID_USER', 'A valid authenticated user is required.');
  }
  return value;
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function boundedText(value, maxChars) {
  const text = normalizedText(value);
  if (text.length <= maxChars) return text;
  const prefix = text.slice(0, Math.max(1, maxChars - 1));
  const boundary = Math.max(
    prefix.lastIndexOf('. '),
    prefix.lastIndexOf('! '),
    prefix.lastIndexOf('? '),
    prefix.lastIndexOf(' '),
  );
  const cut = boundary >= Math.floor(maxChars * 0.55) ? prefix.slice(0, boundary + 1).trim() : prefix.trim();
  return `${cut}…`;
}

function isTv(device) {
  return device?.platform === 'android-tv'
    || (Array.isArray(device?.caps) && device.caps.includes('tv_commands'));
}

function targetForWire(device, online) {
  const tv = isTv(device);
  return {
    id: device.id,
    name: device.name || (tv ? 'TV' : 'Voice device'),
    kind: tv ? 'tv' : 'speaker',
    online,
    capabilities: tv
      ? [{ mode: HANDOFF_MODES.DISPLAY, label: 'Display on TV' }]
      : [{ mode: HANDOFF_MODES.READ_ALOUD, label: 'Read aloud' }],
  };
}

/**
 * List handoff targets owned by `userId`. Paired-but-offline devices stay in
 * the result so the UI can explain why they cannot currently be selected.
 */
export async function listHandoffTargets(userId) {
  const ownerId = assertUserId(userId);
  const { isDeviceOnline } = await import('../ws-handler.mjs');
  return listDevices(ownerId).map(device => targetForWire(device, isDeviceOnline(device.id)));
}

async function validateCapture(capture) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    throw new BrowserHandoffError('INVALID_CAPTURE', 'Browser context is required.');
  }

  const rawUrl = String(capture.url || '').trim();
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new BrowserHandoffError('INVALID_URL', 'The page URL is invalid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserHandoffError('INVALID_URL', 'Only http and https pages can be handed off.');
  }

  // Credentials and fragments are never useful to the receiving device and
  // can carry secrets. Keep the query for the safety check but never render it
  // on a TV or speak it aloud.
  url.username = '';
  url.password = '';
  url.hash = '';
  const checked = await isUrlSafe(url.href);
  if (!checked.ok) {
    throw new BrowserHandoffError('UNSAFE_URL', `This page cannot be sent to a device: ${checked.reason}.`);
  }

  const displayUrl = `${url.origin}${url.pathname}`;
  return {
    url: url.href,
    displayUrl: boundedText(displayUrl, 500),
    hostname: url.hostname,
    title: boundedText(capture.title || url.hostname, MAX_TITLE_CHARS),
    summary: boundedText(capture.summary, MAX_SOURCE_CHARS),
    selection: boundedText(capture.selection, MAX_SOURCE_CHARS),
    // Raw page text is admitted only as a small deterministic excerpt. The
    // full snapshot is never put on the device wire.
    excerpt: boundedText(capture.text, MAX_SOURCE_CHARS),
  };
}

function contentExcerpt(capture) {
  return capture.summary || capture.selection || capture.excerpt || '';
}

function tvCard(capture) {
  const excerpt = contentExcerpt(capture);
  const parts = [];
  if (excerpt) parts.push(excerpt);
  parts.push(`Source: ${capture.displayUrl}`);
  return {
    kind: 'text',
    title: capture.title,
    body: boundedText(parts.join('\n\n'), MAX_TV_BODY_CHARS),
    duration_ms: 30_000,
  };
}

function spokenExcerpt(capture) {
  const excerpt = contentExcerpt(capture);
  const parts = [capture.title];
  if (excerpt) parts.push(excerpt);
  else parts.push(`This page is from ${capture.hostname}. Open it in OE to hear more.`);
  return boundedText(parts.join('. '), MAX_SPOKEN_CHARS);
}

/**
 * Hand browser context to one owned paired device.
 *
 * @param {string} userId
 * @param {{targetId?:string, mode?:'display'|'read_aloud', capture?:object}} [request]
 * @returns {Promise<{ok:true,targetId:string,targetName:string,targetKind:'tv'|'speaker',mode:string}>}
 */
export async function handoffBrowserContext(userId, { targetId, mode, capture } = {}) {
  const ownerId = assertUserId(userId);
  const id = String(targetId || '').trim();
  if (!id) throw new BrowserHandoffError('INVALID_TARGET', 'Choose a device first.');

  // Ownership is established exclusively through this user's registry. Never
  // resolve a target globally by id or accept caller-supplied device metadata.
  const device = listDevices(ownerId).find(candidate => candidate.id === id);
  if (!device) {
    throw new BrowserHandoffError('TARGET_NOT_FOUND', 'That device is not paired to this account.');
  }

  const tv = isTv(device);
  const requiredMode = tv ? HANDOFF_MODES.DISPLAY : HANDOFF_MODES.READ_ALOUD;
  if (mode !== requiredMode) {
    throw new BrowserHandoffError(
      'UNSUPPORTED_MODE',
      tv ? 'This TV supports Display on TV.' : 'This voice device supports Read aloud.',
    );
  }

  const safeCapture = await validateCapture(capture);
  const { isDeviceOnline, sendToDevice } = await import('../ws-handler.mjs');
  if (!isDeviceOnline(device.id)) {
    throw new BrowserHandoffError('TARGET_OFFLINE', `${device.name || 'That device'} is offline.`);
  }

  if (tv) {
    const { sendTvCommand } = await import('./tv-commands.mjs');
    let result;
    try {
      result = await sendTvCommand(device.id, 'show', tvCard(safeCapture));
    } catch (error) {
      const code = error?.code === 'OFFLINE' ? 'TARGET_OFFLINE' : 'DELIVERY_FAILED';
      throw new BrowserHandoffError(code, `Could not display that page on ${device.name || 'the TV'}.`);
    }
    if (!result?.ok) {
      throw new BrowserHandoffError('DELIVERY_FAILED', `Could not display that page on ${device.name || 'the TV'}.`);
    }
  } else {
    const text = spokenExcerpt(safeCapture);
    const first = sendToDevice(device.id, { type: 'token', text, agent: 'system' });
    const second = first ? sendToDevice(device.id, { type: 'done', agent: 'system' }) : 0;
    if (!first || !second) {
      throw new BrowserHandoffError('DELIVERY_FAILED', `Could not read that page on ${device.name || 'the voice device'}.`);
    }
  }

  return {
    ok: true,
    targetId: device.id,
    targetName: device.name || (tv ? 'TV' : 'Voice device'),
    targetKind: tv ? 'tv' : 'speaker',
    mode,
  };
}
