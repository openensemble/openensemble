/**
 * Shared rate-limit primitives for pairing-code redeem endpoints, plus the
 * device-admission request/claim endpoints (routes/admission.mjs).
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
 *
 * Admission carve-out: admission's unauthenticated POST /request (rejected
 * for being over the pending-request cap) and GET /:id/status (wrong/missing
 * claimSecret) are a DIFFERENT attack surface from code-redeem, but a
 * legitimate node could easily share a source IP with someone spamming
 * admission requests (NAT, VPN egress, a shared office uplink) — folding them
 * into the SAME per-IP bucket as redeem would let admission spam lock a
 * legitimate node out of re-pairing via a pairing code from that address.
 * So per-IP failures are tracked in a NAMESPACED bucket (own Map per
 * namespace); the global botnet ceiling below stays namespace-agnostic on
 * purpose — a distributed attacker rotating between admission and redeem
 * must not get 2x the shared budget.
 */

const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_MAX_FAILURES = 10;
const REDEEM_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const REDEEM_GLOBAL_MAX_FAILURES = 200;

const _failureBuckets = new Map(); // namespace → Map(ip → { count, firstFail })
function bucketFor(namespace) {
  let b = _failureBuckets.get(namespace);
  if (!b) { b = new Map(); _failureBuckets.set(namespace, b); }
  return b;
}

let _redeemGlobalFails = 0;
let _redeemGlobalWindowStart = Date.now();

setInterval(() => {
  const cutoff = Date.now() - REDEEM_WINDOW_MS;
  for (const bucket of _failureBuckets.values()) {
    for (const [k, v] of bucket) if (v.firstFail < cutoff) bucket.delete(k);
  }
}, 60_000).unref?.();

function isLockedOut(namespace, ip) {
  const bucket = bucketFor(namespace);
  const entry = bucket.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstFail > REDEEM_WINDOW_MS) { bucket.delete(ip); return false; }
  return entry.count >= REDEEM_MAX_FAILURES;
}

function recordFailure(namespace, ip) {
  const bucket = bucketFor(namespace);
  const now = Date.now();
  const entry = bucket.get(ip);
  if (!entry || now - entry.firstFail > REDEEM_WINDOW_MS) bucket.set(ip, { count: 1, firstFail: now });
  else entry.count++;
}

function clearFailures(namespace, ip) {
  bucketFor(namespace).delete(ip);
}

export function isRedeemLockedOut(ip) { return isLockedOut('redeem', ip); }
export function recordRedeemFailure(ip) { recordFailure('redeem', ip); }
export function clearRedeemFailures(ip) { clearFailures('redeem', ip); }

// Admission namespace — see the module-level comment above for why this is
// separate from the redeem bucket. Same per-IP window/threshold as redeem;
// only the bucket identity differs.
export function isAdmissionLockedOut(ip) { return isLockedOut('admission', ip); }
export function recordAdmissionFailure(ip) { recordFailure('admission', ip); }
export function clearAdmissionFailures(ip) { clearFailures('admission', ip); }

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
