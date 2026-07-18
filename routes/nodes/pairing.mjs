/**
 * Pairing codes for node agents.
 *
 * Short-lived codes that let a node agent obtain a session token without the
 * user manually copying one. Generated in the UI, valid for 10 minutes.
 *
 * Used by:
 *  - POST /api/nodes/pair    — issue a code for an authenticated user
 *  - POST /api/nodes/redeem  — exchange a valid code for a session token
 */

import { randomBytes } from 'crypto';
import { createSession, getClientIp, requireAuth, readBody } from '../_helpers.mjs';
// uaFromReq isn't re-exported by the ._helpers.mjs aggregator yet — import
// straight from the submodule (see routes/_helpers/auth-sessions.mjs).
import { uaFromReq } from '../_helpers/auth-sessions.mjs';
import { getLanAddress } from '../../discovery.mjs';
import {
  isRedeemLockedOut,
  recordRedeemFailure,
  clearRedeemFailures,
  noteGlobalFail,
  isGlobalRedeemLocked,
} from '../_helpers/pairing-ratelimit.mjs';

const _pairingCodes = new Map(); // code → { userId, createdAt, nodeId? }
const PAIRING_TTL = 10 * 60 * 1000; // 10 minutes

export function generatePairingCode(userId) {
  // Clean expired codes
  const now = Date.now();
  for (const [code, entry] of _pairingCodes) {
    if (now - entry.createdAt > PAIRING_TTL) _pairingCodes.delete(code);
  }
  // 32-bit keyspace (4.3B codes). Earlier 24-bit (3 bytes / 6 hex chars) was
  // brute-forceable across a botnet within a single 10-min TTL — bumping to
  // 8 hex chars makes scanning the live keyspace infeasible without
  // sustaining ~2M req/s, well above any rate-limit threshold.
  const code = randomBytes(4).toString('hex').toUpperCase(); // 8-char hex
  _pairingCodes.set(code, { userId, createdAt: now });
  return code;
}

export const PAIRING_CODE_TTL_SECONDS = PAIRING_TTL / 1000;

function redeemPairingCode(code) {
  const entry = _pairingCodes.get(code.toUpperCase());
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PAIRING_TTL) {
    _pairingCodes.delete(code.toUpperCase());
    return null;
  }
  _pairingCodes.delete(code.toUpperCase());
  return entry;
}

/** Handle /api/nodes/pair and /api/nodes/redeem. Returns true if handled. */
export async function handlePairingRoutes(req, res, pathname) {
  // POST /api/nodes/pair — generate a pairing code (authenticated)
  if (pathname === '/api/nodes/pair' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const code = generatePairingCode(userId);
    // Compute the URL a remote machine should use to reach this server.
    // Prefer the Host header if it's not localhost; fall back to LAN IP.
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const hostHeader = req.headers.host || '';
    const isLocalhost = /^(localhost|127\.|0\.0\.0\.0)/.test(hostHeader.split(':')[0]);
    const port = hostHeader.split(':')[1] || '3737';
    const serverHost = isLocalhost ? `${getLanAddress()}:${port}` : hostHeader;
    const installUrl = `${proto}://${serverHost}/nodes/install.sh`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, expiresIn: PAIRING_TTL / 1000, installUrl, serverHost }));
    return true;
  }

  // POST /api/nodes/redeem — redeem a code for a session token (unauthenticated;
  // called by the node agent during setup).
  if (pathname === '/api/nodes/redeem' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (isGlobalRedeemLocked()) {
      console.warn('[pairing] Global redeem lockout active — refusing redeem');
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pairing temporarily disabled due to suspicious activity. Try again in an hour.' }));
      return true;
    }
    if (isRedeemLockedOut(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many failed attempts. Try again later.' }));
      return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body.code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'code is required' }));
      return true;
    }
    const entry = redeemPairingCode(body.code);
    if (!entry) {
      recordRedeemFailure(ip);
      noteGlobalFail();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired pairing code' }));
      return true;
    }
    clearRedeemFailures(ip);
    // The redeeming client here is the node-agent's HTTP client (not a
    // browser), so this UA is whatever that script sends — still useful as
    // a session label (e.g. distinguishing curl/install-script runs).
    const token = createSession(entry.userId, { kind: 'node', ua: uaFromReq(req) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, userId: entry.userId }));
    return true;
  }

  return false;
}
