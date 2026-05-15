/**
 * Shared rate-limit primitives for pairing-code redeem endpoints.
 *
 * Both /api/nodes/redeem and /api/devices/redeem accept an unauthenticated
 * 8-char code in exchange for a session token, so they share the same attack
 * surface: a distributed attacker brute-forcing the 32-bit code keyspace. We
 * deliberately fold them into one limiter rather than per-endpoint counters,
 * so a botnet can't trivially double the budget by alternating endpoints.
 *
 * Two layers:
 *  - per-IP: caps one IP at REDEEM_MAX_FAILURES wrong codes per window.
 *  - global: caps total failures across all IPs per window — a botnet
 *    rotating addresses still has to fit under one shared ceiling.
 */

const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_MAX_FAILURES = 10;
const REDEEM_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const REDEEM_GLOBAL_MAX_FAILURES = 200;

const _redeemFailures = new Map(); // ip → { count, firstFail }
let _redeemGlobalFails = 0;
let _redeemGlobalWindowStart = Date.now();

setInterval(() => {
  const cutoff = Date.now() - REDEEM_WINDOW_MS;
  for (const [k, v] of _redeemFailures) if (v.firstFail < cutoff) _redeemFailures.delete(k);
}, 60_000).unref?.();

export function getRedeemIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

export function isRedeemLockedOut(ip) {
  const entry = _redeemFailures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstFail > REDEEM_WINDOW_MS) { _redeemFailures.delete(ip); return false; }
  return entry.count >= REDEEM_MAX_FAILURES;
}

export function recordRedeemFailure(ip) {
  const now = Date.now();
  const entry = _redeemFailures.get(ip);
  if (!entry || now - entry.firstFail > REDEEM_WINDOW_MS) _redeemFailures.set(ip, { count: 1, firstFail: now });
  else entry.count++;
}

export function clearRedeemFailures(ip) {
  _redeemFailures.delete(ip);
}

export function noteGlobalFail() {
  const now = Date.now();
  if (now - _redeemGlobalWindowStart > REDEEM_GLOBAL_WINDOW_MS) {
    _redeemGlobalWindowStart = now;
    _redeemGlobalFails = 0;
  }
  _redeemGlobalFails++;
}

export function isGlobalRedeemLocked() {
  const now = Date.now();
  if (now - _redeemGlobalWindowStart > REDEEM_GLOBAL_WINDOW_MS) {
    _redeemGlobalWindowStart = now;
    _redeemGlobalFails = 0;
    return false;
  }
  return _redeemGlobalFails >= REDEEM_GLOBAL_MAX_FAILURES;
}
