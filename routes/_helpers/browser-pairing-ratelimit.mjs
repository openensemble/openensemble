/**
 * Narrow rate limits for the unauthenticated browser-pairing surface.
 *
 * The server-wide /api limiter still applies. These counters additionally
 * bound pairing requests and bad claim-secret guesses even when the route is
 * mounted outside the full server in tests or reused by another HTTP entry.
 * A valid claim is never blocked by an IP lockout: legitimate clients behind
 * a shared NAT must not be stranded by somebody else's bad guesses.
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
const MAX_BAD_CLAIMS_PER_IP = 10;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const MAX_GLOBAL_BAD_CLAIMS = 500;

const requestBuckets = new Map();
const claimBuckets = new Map();
let globalBadClaims = 0;
let globalWindowStartedAt = Date.now();

function consume(bucket, key, limit, now = Date.now()) {
  const current = bucket.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    bucket.set(key, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= limit) return false;
  current.count++;
  return true;
}

function isLocked(bucket, key, limit, now = Date.now()) {
  const current = bucket.get(key);
  if (!current) return false;
  if (now - current.startedAt >= WINDOW_MS) {
    bucket.delete(key);
    return false;
  }
  return current.count >= limit;
}

function resetGlobalIfNeeded(now = Date.now()) {
  if (now - globalWindowStartedAt >= GLOBAL_WINDOW_MS) {
    globalWindowStartedAt = now;
    globalBadClaims = 0;
  }
}

export function consumeBrowserPairingRequest(ip) {
  return consume(requestBuckets, String(ip || 'unknown'), MAX_REQUESTS_PER_IP);
}

export function isBrowserClaimLocked(ip) {
  resetGlobalIfNeeded();
  return globalBadClaims >= MAX_GLOBAL_BAD_CLAIMS
    || isLocked(claimBuckets, String(ip || 'unknown'), MAX_BAD_CLAIMS_PER_IP);
}

export function recordBadBrowserClaim(ip) {
  resetGlobalIfNeeded();
  consume(claimBuckets, String(ip || 'unknown'), MAX_BAD_CLAIMS_PER_IP);
  globalBadClaims++;
}

export function clearBadBrowserClaims(ip) {
  claimBuckets.delete(String(ip || 'unknown'));
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const bucket of [requestBuckets, claimBuckets]) {
    for (const [key, entry] of bucket) {
      if (entry.startedAt <= cutoff) bucket.delete(key);
    }
  }
  resetGlobalIfNeeded();
}, 60_000).unref?.();

export function _resetBrowserPairingRateLimitsForTests() {
  requestBuckets.clear();
  claimBuckets.clear();
  globalBadClaims = 0;
  globalWindowStartedAt = Date.now();
}

