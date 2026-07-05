/**
 * Device admission queue — the front door for devices (nodes today; the
 * `kind` field is designed so 'voice-device' / 'tv' / 'mobile' slot in later
 * without a schema change) to request a session without an admin
 * pre-minting a pairing code first. Flow:
 *
 *   1. Device POSTs a request (routes/admission.mjs `POST /api/admission/request`)
 *      → gets back a requestId + claimSecret + a 3-digit human-check code (sas).
 *   2. The dashboard shows the pending request (hostname/platform/ip/sas) to
 *      an owner/admin, who approves (picking the owning user) or denies it.
 *   3. The device polls `GET /api/admission/:id/status` presenting its
 *      claimSecret. Once approved, the ROUTE (not this module) mints the
 *      actual session via routes/_helpers/auth-sessions.mjs createSession —
 *      this module only tracks queue state and stashes the minted result in
 *      memory so a repeated poll is idempotent.
 *
 * This is a front door onto the EXISTING redeem machinery, not a parallel
 * auth system — see handoffs/DEVICE-DISCOVERY-ADMISSION-PLAN.md. Approval
 * still ends in the same createSession() call the classic pairing-code
 * redeem endpoints use; tokens, hash recovery, and revocation need zero
 * changes.
 *
 * Persistence: admission-requests.json in the data dir (BASE_DIR from
 * lib/paths.mjs — MANDATORY, never derive your own base dir; see
 * feedback_loadusers_no_empty_cache-style incidents in project memory).
 * claimSecret is stored ONLY as a sha256 hash (claimSecretHash); the raw
 * claimSecret and any minted session token are NEVER written to disk — the
 * minted-token stash (`_claimResult`) lives only on the in-memory record and
 * is stripped before every write (see `toDiskRecord`).
 */

import fs from 'fs';
import path from 'path';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'crypto';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const STORE_PATH = path.join(BASE_DIR, 'admission-requests.json');

// Device kinds accepted today. Only 'node' is wired end-to-end in Phase 1;
// the others are reserved so future phases (voice-device pairing, the TV
// app, mobile apps) can add themselves here plus a claim-time registration
// branch in routes/admission.mjs without touching this module's shape.
export const ADMISSION_KINDS = ['node', 'voice-device', 'tv', 'mobile'];
const SUPPORTED_KINDS = ['node']; // Phase 1

const PENDING_TTL_MS  = 15 * 60 * 1000; // pending request TTL
const APPROVED_TTL_MS = 10 * 60 * 1000; // approved-but-unclaimed TTL
const MAX_PENDING_TOTAL   = 20;
const MAX_PENDING_PER_IP  = 3;
const POLL_INTERVAL_SECONDS = 3;
// Resolved (denied/expired/claimed) records are kept around briefly for
// idempotent re-polls and dashboard "just resolved" flashes, then pruned so
// the store doesn't grow unbounded over months of uptime.
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

let _requests = new Map(); // requestId -> record
let _loaded = false;

// Injected by routes/admission.mjs so this module never has to know about
// WS broadcast plumbing or user roles. fn(event, publicRecord) — event is
// 'admission_request' | 'admission_resolved'.
let _onEvent = null;
export function setAdmissionEventHandler(fn) { _onEvent = typeof fn === 'function' ? fn : null; }
function emit(event, rec) {
  if (!_onEvent) return;
  try { _onEvent(event, publicView(rec)); }
  catch (e) { console.warn('[device-admission] event handler failed:', e.message); }
}

function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

// 3-digit human-check code (Bluetooth-numeric-comparison / Chromecast
// pattern) — shown on both the device and the dashboard so the approving
// admin visually matches the physical device instead of trusting whichever
// request happened to land first.
function genSas() {
  return String(randomInt(0, 1000)).padStart(3, '0');
}

function ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      for (const rec of Object.values(raw)) {
        if (rec && rec.requestId) _requests.set(rec.requestId, rec);
      }
    }
  } catch (e) {
    console.warn('[device-admission] Failed to load admission-requests.json:', e.message);
  }
}

function toDiskRecord(rec) {
  // Strip the in-memory-only claim stash before writing — the minted
  // session token must never touch disk.
  const { _claimResult, ...onDisk } = rec;
  return onDisk;
}

function persist() {
  const obj = {};
  for (const [id, rec] of _requests) obj[id] = toDiskRecord(rec);
  try {
    atomicWriteSync(STORE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('[device-admission] Failed to persist admission-requests.json:', e.message);
  }
}

// Wire-safe view — never includes claimSecretHash or the in-memory claim
// stash. Safe to hand to the dashboard (GET /pending) or a WS broadcast.
function publicView(rec) {
  return {
    requestId: rec.requestId,
    kind: rec.kind,
    name: rec.name,
    metadata: rec.metadata,
    ip: rec.ip,
    sas: rec.sas,
    status: rec.status,
    requestedAt: rec.requestedAt,
    approvedAt: rec.approvedAt ?? null,
    approvedBy: rec.approvedBy ?? null,
    ownerUserId: rec.ownerUserId ?? null,
    deniedAt: rec.deniedAt ?? null,
  };
}

function sweepExpired() {
  ensureLoaded();
  const now = Date.now();
  let changed = false;

  for (const rec of _requests.values()) {
    if (rec.status === 'pending' && now - rec.requestedAt > PENDING_TTL_MS) {
      rec.status = 'expired';
      changed = true;
      emit('admission_resolved', rec);
    } else if (
      rec.status === 'approved' &&
      !rec._claimResult &&
      rec.approvedAt &&
      now - rec.approvedAt > APPROVED_TTL_MS
    ) {
      rec.status = 'expired';
      changed = true;
      emit('admission_resolved', rec);
    }
  }

  // Bounded retention for resolved records — see PRUNE_AFTER_MS above.
  for (const [id, rec] of _requests) {
    if (rec.status === 'denied' && rec.deniedAt && now - rec.deniedAt > PRUNE_AFTER_MS) {
      _requests.delete(id); changed = true;
    } else if (rec.status === 'expired' && now - rec.requestedAt > PRUNE_AFTER_MS) {
      _requests.delete(id); changed = true;
    } else if (rec.status === 'claimed' && rec.claimedAt && now - rec.claimedAt > PRUNE_AFTER_MS) {
      _requests.delete(id); changed = true;
    }
  }

  if (changed) persist();
}

// Periodic sweep so an abandoned request (nobody ever polls status again)
// still transitions to expired and fires admission_resolved for any open
// dashboard, not just on next access. Mirrors the unref'd interval pattern
// in routes/_helpers/pairing-ratelimit.mjs and auth-sessions.mjs.
setInterval(() => {
  try { sweepExpired(); } catch (e) { console.warn('[device-admission] periodic sweep failed:', e.message); }
}, 60_000).unref?.();

// Cap metadata to a small allowlist of short strings — this is unauthenticated
// input written to disk and later rendered in the dashboard.
const METADATA_FIELDS = ['hostname', 'platform', 'arch', 'agentVersion'];
function sanitizeMetadata(metadata) {
  const out = {};
  if (!metadata || typeof metadata !== 'object') return out;
  for (const key of METADATA_FIELDS) {
    const v = metadata[key];
    if (typeof v === 'string' && v.length) out[key] = v.slice(0, 200);
  }
  return out;
}

/**
 * Create a new pending admission request. Returns:
 *   { ok: true, requestId, claimSecret, sas, pollInterval, expiresIn }
 *   { ok: false, error }   — over cap, or unsupported kind
 */
export function createRequest({ kind, name, metadata, ip } = {}) {
  sweepExpired();

  const safeKind = SUPPORTED_KINDS.includes(kind) ? kind : null;
  if (!safeKind) {
    return { ok: false, error: `Unsupported device kind "${kind}". Supported: ${SUPPORTED_KINDS.join(', ')}.` };
  }

  const pending = [..._requests.values()].filter(r => r.status === 'pending');
  if (pending.length >= MAX_PENDING_TOTAL) {
    return { ok: false, error: 'Too many pending device requests right now. Try again shortly, or ask an admin to review the queue.', capped: true };
  }
  const pendingForIp = pending.filter(r => r.ip === ip).length;
  if (pendingForIp >= MAX_PENDING_PER_IP) {
    return { ok: false, error: 'Too many pending requests from this address. Wait for an existing request to be approved, denied, or expire.', capped: true };
  }

  const requestId = randomBytes(8).toString('hex');
  const claimSecret = randomBytes(24).toString('hex');
  const rec = {
    requestId,
    kind: safeKind,
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : 'Unnamed device',
    metadata: sanitizeMetadata(metadata),
    ip: ip || 'unknown',
    sas: genSas(),
    claimSecretHash: hashSecret(claimSecret),
    status: 'pending',
    requestedAt: Date.now(),
    approvedAt: null,
    approvedBy: null,
    ownerUserId: null,
    deniedAt: null,
  };
  _requests.set(requestId, rec);
  persist();
  emit('admission_request', rec);

  return {
    ok: true,
    requestId,
    claimSecret,
    sas: rec.sas,
    pollInterval: POLL_INTERVAL_SECONDS,
    expiresIn: Math.floor(PENDING_TTL_MS / 1000),
  };
}

/** Pending requests for the dashboard — never includes claimSecretHash. */
export function getPublicList() {
  sweepExpired();
  return [..._requests.values()]
    .filter(r => r.status === 'pending')
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map(publicView);
}

/**
 * Approve a pending request, binding it to an owning user. Returns the
 * public record, or null if the request doesn't exist or isn't pending.
 */
export function approveRequest(requestId, { ownerUserId, approvedBy } = {}) {
  sweepExpired();
  const rec = _requests.get(requestId);
  if (!rec || rec.status !== 'pending') return null;
  rec.status = 'approved';
  rec.approvedAt = Date.now();
  rec.approvedBy = approvedBy || null;
  rec.ownerUserId = ownerUserId || null;
  persist();
  emit('admission_resolved', rec);
  return publicView(rec);
}

/** Deny a pending request. Returns the public record, or null if not found/not pending. */
export function denyRequest(requestId, { deniedBy } = {}) {
  sweepExpired();
  const rec = _requests.get(requestId);
  if (!rec || rec.status !== 'pending') return null;
  rec.status = 'denied';
  rec.deniedAt = Date.now();
  rec.deniedBy = deniedBy || null;
  persist();
  emit('admission_resolved', rec);
  return publicView(rec);
}

/**
 * Verify a device's claimSecret against a request. Returns a minimal shape
 * safe to pass around ({ requestId, kind, status, ownerUserId }) — NEVER the
 * raw record — or null if the request doesn't exist or the secret is wrong.
 * Callers must treat null uniformly (404, don't distinguish "wrong secret"
 * from "no such request") and count it as a rate-limit failure.
 */
export function verifyClaim(requestId, claimSecret) {
  sweepExpired();
  if (!requestId || !claimSecret || typeof claimSecret !== 'string') return null;
  const rec = _requests.get(requestId);
  if (!rec) return null;
  let a, b;
  try {
    a = Buffer.from(hashSecret(claimSecret), 'hex');
    b = Buffer.from(rec.claimSecretHash, 'hex');
  } catch { return null; }
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { requestId: rec.requestId, kind: rec.kind, status: rec.status, ownerUserId: rec.ownerUserId };
}

/**
 * Mark a request claimed: stash the minted result (token + userId) in memory
 * for idempotent re-polls within THIS process, and flip the on-disk status to
 * 'claimed' with a claimedAt timestamp. The token itself is never persisted
 * (toDiskRecord strips _claimResult) — but the persisted 'claimed' status is
 * what prevents a second session from being minted for the same approval after
 * a restart: a post-restart poll finds status 'claimed' with no in-memory
 * result and is told to start over rather than re-minting (see
 * routes/admission.mjs status handler).
 */
export function markClaimed(requestId, result) {
  const rec = _requests.get(requestId);
  if (!rec) return;
  rec._claimResult = result;
  rec.status = 'claimed';
  rec.claimedAt = Date.now();
  persist();
}

/** Read back a previously-stashed claim result, or null if not yet claimed. */
export function getClaimResult(requestId) {
  return _requests.get(requestId)?._claimResult ?? null;
}

// ── Test-only helpers ────────────────────────────────────────────────────────
/** Drop all in-memory state and force the next access to re-read from disk —
 *  simulates a process restart without needing ESM re-import gymnastics. */
export function _resetForTests() {
  _requests = new Map();
  _loaded = false;
}
