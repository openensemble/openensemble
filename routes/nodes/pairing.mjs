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
import { createSession, requireAuth, readBody } from '../_helpers.mjs';
import { getLanAddress } from '../../discovery.mjs';

const _pairingCodes = new Map(); // code → { userId, createdAt, nodeId? }
const PAIRING_TTL = 10 * 60 * 1000; // 10 minutes

// Per-IP lockout for /api/nodes/redeem. Global API rate-limit caps total
// request rate, but a distributed attacker could still scan the 16.7M-code
// keyspace across many IPs. This adds a per-IP failure cap as a second layer:
// if one IP racks up N wrong codes in the window, it gets 429 until reset.
const _redeemFailures = new Map(); // ip → { count, firstFail }
const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_MAX_FAILURES = 10;

setInterval(() => {
  const cutoff = Date.now() - REDEEM_WINDOW_MS;
  for (const [k, v] of _redeemFailures) if (v.firstFail < cutoff) _redeemFailures.delete(k);
}, 60_000).unref?.();

function getRedeemIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function isRedeemLockedOut(ip) {
  const entry = _redeemFailures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstFail > REDEEM_WINDOW_MS) { _redeemFailures.delete(ip); return false; }
  return entry.count >= REDEEM_MAX_FAILURES;
}

function recordRedeemFailure(ip) {
  const now = Date.now();
  const entry = _redeemFailures.get(ip);
  if (!entry || now - entry.firstFail > REDEEM_WINDOW_MS) _redeemFailures.set(ip, { count: 1, firstFail: now });
  else entry.count++;
}

export function generatePairingCode(userId) {
  // Clean expired codes
  const now = Date.now();
  for (const [code, entry] of _pairingCodes) {
    if (now - entry.createdAt > PAIRING_TTL) _pairingCodes.delete(code);
  }
  const code = randomBytes(3).toString('hex').toUpperCase(); // 6-char hex
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
    const ip = getRedeemIp(req);
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
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired pairing code' }));
      return true;
    }
    _redeemFailures.delete(ip);
    const token = createSession(entry.userId, { kind: 'node' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, userId: entry.userId }));
    return true;
  }

  return false;
}
