import { getGmailAuthHeader } from './google-auth.mjs';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_READ_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;
const readers = new Map();

export class GmailReadError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'GmailReadError';
    this.status = status;
  }
}

// Share the limit across drawer refreshes, message bodies, and dashboard cards.
async function withReadSlot(key, read) {
  let state = readers.get(key);
  if (!state) readers.set(key, state = { active: 0, waiting: [] });
  if (state.active >= GMAIL_READ_CONCURRENCY) {
    await new Promise(resolve => state.waiting.push(resolve));
  } else {
    state.active++;
  }
  try {
    return await read();
  } finally {
    const next = state.waiting.shift();
    if (next) next(); // Transfer this slot directly to the next waiting reader.
    else if (--state.active === 0) readers.delete(key);
  }
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers.get('retry-after');
  const serverDelay = retryAfter
    ? (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())
    : 0;
  return Math.max(1000 * 2 ** attempt + Math.floor(Math.random() * 250), serverDelay || 0);
}

async function readJson(endpoint, headers) {
  for (let attempt = 0; ; attempt++) {
    let response, data;
    try {
      response = await fetch(`${GMAIL_BASE}${endpoint}`, { headers, signal: AbortSignal.timeout(10_000) });
      data = await response.json().catch(() => null);
    } catch {
      // Network failures and timeouts are safe to retry: this helper only reads.
    }
    if (response?.ok && data && typeof data === 'object' && !Array.isArray(data) && !data.error) return data;

    const status = response && !response.ok ? response.status : Number(data?.error?.code) || 502;
    const rateLimited = status === 429 || (status === 403 && data?.error?.errors?.some(error =>
      error.reason === 'rateLimitExceeded' || error.reason === 'userRateLimitExceeded'));
    const retryable = rateLimited || status >= 500;
    const message = rateLimited ? 'Gmail is busy. Please try again shortly.'
      : status === 401 ? 'Gmail connection expired. Reconnect this account in Settings.'
      : status === 403 ? 'Gmail denied access. Check this account in Settings.'
      : status === 404 ? 'This email is no longer available.'
      : 'Gmail could not load your email. Please try again.';
    const delay = retryDelay(response, attempt);
    // A long provider cooldown should become a visible error, not a hung drawer
    // or an early retry that ignores Retry-After.
    if (!retryable || attempt >= MAX_RETRIES || delay > MAX_RETRY_DELAY_MS) {
      throw new GmailReadError(message, status);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/** An authenticated, read-only Gmail client with bounded retries. */
export async function createGmailReader(userId, accountId) {
  const headers = await getGmailAuthHeader(userId, accountId);
  const key = JSON.stringify([userId ?? null, accountId ?? null]);
  return endpoint => withReadSlot(key, () => readJson(endpoint, headers));
}
