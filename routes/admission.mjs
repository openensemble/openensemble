/**
 * Device admission queue — HTTP surface.
 *
 * The front door for devices (nodes today; see lib/device-admission.mjs for
 * how other kinds slot in later) to request a session without an admin
 * pre-minting a pairing code. Mounted under /api/* (see server.mjs) so the
 * shared edge middleware (IP rate limit, body cap, CSRF-ish origin check)
 * applies — deliberately not a bare path like /mcp.
 *
 * Endpoints:
 *   POST /api/admission/request        — unauthenticated; device asks to join
 *   GET  /api/admission/:id/status     — unauthenticated but claimSecret-gated
 *   GET  /api/admission/pending        — requirePrivileged; dashboard queue
 *   POST /api/admission/:id/approve    — requirePrivileged
 *   POST /api/admission/:id/deny       — requirePrivileged
 *
 * Approval is a front door onto the EXISTING redeem machinery: the claim step
 * mints a session via the same createSession() the classic pairing-code
 * redeem endpoints use (routes/nodes/pairing.mjs, routes/devices/pairing.mjs)
 * — no parallel auth system, no new token shape.
 */

import path from 'path';
import { mkdirSync, appendFileSync } from 'fs';
import { BASE_DIR } from '../lib/paths.mjs';
import {
  requirePrivileged, readBody, getUser, loadUsers, broadcastToUsers, createSession, getClientIp,
} from './_helpers.mjs';
import { uaFromReq } from './_helpers/auth-sessions.mjs';
import {
  isGlobalRedeemLocked, noteGlobalFail,
  isAdmissionLockedOut, recordAdmissionFailure, clearAdmissionFailures,
} from './_helpers/pairing-ratelimit.mjs';
import {
  createRequest, getPublicList, approveRequest, denyRequest, verifyClaim,
  markClaimed, getClaimResult, setAdmissionEventHandler,
} from '../lib/device-admission.mjs';
import { log } from '../logger.mjs';

// ── Audit trail ───────────────────────────────────────────────────────────
// Events with a known owning user (approve, claim) append to the SAME
// per-user log the classic node pairing-code flow uses (see
// skills/nodes/execute.mjs `_auditPairing`) — one place to look for "how did
// this node get its token". Events with no owner yet (request, deny) go
// through the structured app logger instead.
function auditToUserLog(userId, event, data) {
  try {
    const dir = path.join(BASE_DIR, 'users', userId);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n';
    appendFileSync(path.join(dir, 'agent-pairings.log'), line);
  } catch (e) {
    console.warn('[admission] audit log write failed:', e.message);
  }
}

function privilegedUserIds() {
  return loadUsers().filter(u => u.role === 'owner' || u.role === 'admin').map(u => u.id);
}

// Wire the lib's request/resolved events into a privileged-only WS broadcast.
// Set once at module load — cheap, idempotent if this module is imported more
// than once (ESM caches the module so this only really runs once).
setAdmissionEventHandler((event, record) => {
  const ids = privilegedUserIds();
  if (!ids.length) return;
  broadcastToUsers(ids, { type: event, ...record });
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!p.startsWith('/api/admission/')) return false;

  // ── POST /api/admission/request — unauthenticated join request ──────────
  if (p === '/api/admission/request' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (isGlobalRedeemLocked() || isAdmissionLockedOut(ip)) {
      sendJson(res, 429, { error: 'Too many requests. Try again later.' });
      return true;
    }
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }

    const kind = typeof body.kind === 'string' ? body.kind : 'node';
    const name = typeof body.name === 'string' ? body.name : (body.metadata?.hostname || null);
    const result = createRequest({ kind, name, metadata: body.metadata, ip });

    if (!result.ok) {
      // A cap rejection (429) is NOT counted as a per-IP rate-limit failure:
      // the per-IP and total pending caps in createRequest already bound how
      // much any one IP can queue, and the global-total cap ("queue full") is
      // system backpressure, not this IP's fault — counting it would let a
      // full queue lock innocent devices out of their own status polls. The
      // failure counter is reserved for the real abuse signal: wrong
      // claimSecrets on the status endpoint below.
      sendJson(res, result.capped ? 429 : 400, { error: result.error });
      return true;
    }

    log.info('admission', 'device requested admission', {
      requestId: result.requestId, kind, name: name || null, ip,
    });
    sendJson(res, 200, {
      requestId: result.requestId,
      claimSecret: result.claimSecret,
      sas: result.sas,
      pollInterval: result.pollInterval,
      expiresIn: result.expiresIn,
    });
    return true;
  }

  // ── GET /api/admission/pending — dashboard queue ─────────────────────────
  if (p === '/api/admission/pending' && req.method === 'GET') {
    const userId = requirePrivileged(req, res);
    if (!userId) return true;
    sendJson(res, 200, getPublicList());
    return true;
  }

  // ── POST /api/admission/:id/approve ──────────────────────────────────────
  const approveMatch = p.match(/^\/api\/admission\/([^/]+)\/approve$/);
  if (approveMatch && req.method === 'POST') {
    const approverId = requirePrivileged(req, res);
    if (!approverId) return true;
    const requestId = decodeURIComponent(approveMatch[1]);

    let body = {};
    try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }

    const ownerUserId = typeof body.ownerUserId === 'string' && body.ownerUserId ? body.ownerUserId : approverId;
    const owner = getUser(ownerUserId);
    if (!owner) { sendJson(res, 400, { error: 'Unknown user' }); return true; }
    // Child accounts can't own a node — the node WS handler hard-blocks them
    // (routes/nodes/websocket.mjs), so a node bound to a child would connect
    // and immediately be refused. Reject the assignment up front instead.
    if (owner.role === 'child') {
      sendJson(res, 400, { error: 'Cannot assign a device to a child account.' });
      return true;
    }

    const record = approveRequest(requestId, { ownerUserId, approvedBy: approverId });
    if (!record) { sendJson(res, 404, { error: 'Request not found or no longer pending' }); return true; }

    auditToUserLog(ownerUserId, 'admission_approved', { requestId, kind: record.kind, approvedBy: approverId });
    log.info('admission', 'request approved', { requestId, ownerUserId, approvedBy: approverId });
    sendJson(res, 200, record);
    return true;
  }

  // ── POST /api/admission/:id/deny ─────────────────────────────────────────
  const denyMatch = p.match(/^\/api\/admission\/([^/]+)\/deny$/);
  if (denyMatch && req.method === 'POST') {
    const deniedBy = requirePrivileged(req, res);
    if (!deniedBy) return true;
    const requestId = decodeURIComponent(denyMatch[1]);

    const record = denyRequest(requestId, { deniedBy });
    if (!record) { sendJson(res, 404, { error: 'Request not found or no longer pending' }); return true; }

    log.info('admission', 'request denied', { requestId, deniedBy });
    sendJson(res, 200, record);
    return true;
  }

  // ── GET /api/admission/:id/status — device poll, claimSecret-gated ──────
  const statusMatch = p.match(/^\/api\/admission\/([^/]+)\/status$/);
  if (statusMatch && req.method === 'GET') {
    const ip = getClientIp(req);
    const requestId = decodeURIComponent(statusMatch[1]);
    const auth = req.headers.authorization || '';
    const claimSecret = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    const claim = verifyClaim(requestId, claimSecret);
    if (!claim) {
      // Wrong/missing secret and "no such request" are indistinguishable on
      // purpose — a 404 here must not leak whether a requestId exists. This
      // is the one real abuse signal on the admission surface, so count it
      // toward the per-IP + shared-global limiter — but stop once this IP has
      // already latched its per-IP lockout, so a single IP can't run the
      // shared global counter up without bound (which would DoS every pairing
      // endpoint server-wide). Note: the failure count is NEVER cleared by a
      // mere poll (see the terminal-claim branch) — only an actual successful
      // claim clears it, so an attacker can't reset the counter by polling a
      // request they created themselves.
      if (!isAdmissionLockedOut(ip)) {
        recordAdmissionFailure(ip);
        noteGlobalFail();
      }
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }

    // A valid claimSecret proves the caller is the legitimate device that made
    // this request — it is NEVER subject to the IP lockout. That lockout is
    // keyed on IP, so gating a valid holder on it would strand an approved
    // device that happens to share a NAT egress with an unrelated spammer
    // (the device's approval would silently lapse on the unclaimed TTL).
    if (claim.status === 'pending') { sendJson(res, 200, { status: 'pending' }); return true; }
    if (claim.status === 'denied')  { sendJson(res, 200, { status: 'denied' });  return true; }
    if (claim.status === 'expired') { sendJson(res, 200, { status: 'expired' }); return true; }

    if (claim.status === 'claimed') {
      // Already claimed. Within the same process the minted token is stashed
      // in memory → replay it (idempotent retry). If it's gone (the mint
      // happened before a restart; tokens are never persisted), do NOT mint a
      // second session for the same approval — tell the device to start over.
      const prior = getClaimResult(requestId);
      if (prior) sendJson(res, 200, { status: 'approved', token: prior.token, userId: prior.userId });
      else       sendJson(res, 200, { status: 'expired' });
      return true;
    }

    // status === 'approved' — the first successful claim. Mint exactly one
    // session, then flip the request to 'claimed' (persisted) so no later poll
    // can mint another. Clearing failures here is safe: unlike a poll, a claim
    // is a one-shot terminal event.
    const token = createSession(claim.ownerUserId, { kind: claim.kind, ua: uaFromReq(req) });
    markClaimed(requestId, { token, userId: claim.ownerUserId });
    clearAdmissionFailures(ip);
    auditToUserLog(claim.ownerUserId, 'admission_claimed', { requestId, kind: claim.kind, ip });
    log.info('admission', 'request claimed', { requestId, userId: claim.ownerUserId });
    sendJson(res, 200, { status: 'approved', token, userId: claim.ownerUserId });
    return true;
  }

  return false;
}
