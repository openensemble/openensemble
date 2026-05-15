/**
 * Per-IP rate limiting for /api/* endpoints.
 * Leaf module — no deps.
 */

const _rateBuckets = new Map(); // ip → { count, resetAt }
const RATE_WINDOW  = 60_000;    // 1 minute
// Bumped from 120 → 300 (2026-05-12). The Voice devices drawer alone
// fires 5 GETs per open (devices + incoming-slots + wakewords + tts/info
// + users), and per-slot tweaks add PATCH bursts. A dev iterating quickly
// can hit 120 in seconds without doing anything abusive. 300 still bounds
// a misbehaving client to one request every ~200 ms, which is plenty.
const RATE_MAX_API = 300;       // general API: 300 req/min per IP
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
