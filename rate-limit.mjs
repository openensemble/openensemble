/**
 * Per-IP rate limiting for /api/* endpoints.
 * Leaf module — no deps.
 */

const _rateBuckets = new Map(); // ip → { count, resetAt }
const RATE_WINDOW  = 60_000;    // 1 minute
const RATE_MAX_API = 120;       // general API: 120 req/min per IP
const RATE_MAX_UPLOAD = 20;     // upload endpoints: 20 req/min per IP

export function getRateLimit(ip, isUpload) {
  const max = isUpload ? RATE_MAX_UPLOAD : RATE_MAX_API;
  const key = isUpload ? `upload:${ip}` : ip;
  const now = Date.now();
  let bucket = _rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW };
    _rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return { limited: bucket.count > max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

// Prune expired buckets every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _rateBuckets) {
    if (now > bucket.resetAt) _rateBuckets.delete(key);
  }
}, 60_000).unref?.();
