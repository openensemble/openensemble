/**
 * Pairing codes for voice devices (XVF3800 + ESP32-S3 family).
 *
 * Parallel to routes/nodes/pairing.mjs but slimmer — no install.sh equivalent
 * (flashing is offline), and redeem mints a `kind: 'voice-device'` session
 * which gets the same sliding-expiry treatment as node-agent sessions.
 *
 * Used by:
 *  - POST /api/devices/pair    — issue a code for an authenticated user
 *  - POST /api/devices/redeem  — exchange a valid code for a session token
 *
 * Forked rather than parameterized from nodes/pairing so we keep a clean ACL
 * surface for future device-only policies (e.g. require a physical
 * confirm-tap before redeem) and a typed audit trail.
 */

import { randomBytes } from 'crypto';
import { createSession, readBody, requireAuth } from '../_helpers.mjs';
import { setSessionDeviceId } from '../_helpers/auth-sessions.mjs';
import { getLanAddress } from '../../discovery.mjs';
import {
  getRedeemIp,
  isRedeemLockedOut,
  recordRedeemFailure,
  clearRedeemFailures,
  noteGlobalFail,
  isGlobalRedeemLocked,
} from '../_helpers/pairing-ratelimit.mjs';
import { registerDevice } from '../../lib/voice-devices.mjs';

const _pairingCodes = new Map(); // code → { userId, createdAt, redeemed? }
const PAIRING_TTL = 10 * 60 * 1000;

function generatePairingCode(userId) {
  const now = Date.now();
  for (const [code, entry] of _pairingCodes) {
    if (now - entry.createdAt > PAIRING_TTL) _pairingCodes.delete(code);
  }
  const code = randomBytes(4).toString('hex').toUpperCase(); // 8-char hex
  _pairingCodes.set(code, { userId, createdAt: now });
  return code;
}

function redeemPairingCode(code) {
  const key = String(code || '').toUpperCase();
  const entry = _pairingCodes.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PAIRING_TTL) {
    _pairingCodes.delete(key);
    return null;
  }
  return { key, entry };
}

function canonicalServerHint(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (!host) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`.replace(/\/+$/, '');
}

export const PAIRING_CODE_TTL_SECONDS = PAIRING_TTL / 1000;

/** Returns true if it handled the request. */
export async function handlePairingRoutes(req, res, pathname) {
  if (pathname === '/api/devices/pair' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const code = generatePairingCode(userId);
    // Devices need a host:port to reach this server. Same logic as nodes/pairing:
    // prefer the Host header unless it's localhost, in which case fall back to LAN IP.
    const hostHeader = req.headers.host || '';
    const isLocalhost = /^(localhost|127\.|0\.0\.0\.0)/.test(hostHeader.split(':')[0]);
    const port = hostHeader.split(':')[1] || '3737';
    const serverHost = isLocalhost ? `${getLanAddress()}:${port}` : hostHeader;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, expiresIn: PAIRING_TTL / 1000, serverHost }));
    return true;
  }

  if (pathname === '/api/devices/redeem' && req.method === 'POST') {
    const ip = getRedeemIp(req);
    if (isGlobalRedeemLocked()) {
      console.warn('[device-pairing] Global redeem lockout active — refusing redeem');
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
    const redeem = redeemPairingCode(body.code);
    if (!redeem) {
      recordRedeemFailure(ip);
      noteGlobalFail();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired pairing code' }));
      return true;
    }
    clearRedeemFailures(ip);
    const { entry } = redeem;
    if (entry.redeemed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entry.redeemed));
      return true;
    }
    const token = createSession(entry.userId, { kind: 'voice-device' });
    // Field-name compat: the XVF3800 firmware (and older clients) send
    // `device_name`; some 3rd-party clients send `name`. Accept either —
    // both map to the same registry slot.
    const submittedName = typeof body.name === 'string' ? body.name
                       : typeof body.device_name === 'string' ? body.device_name
                       : undefined;
    const device = registerDevice(entry.userId, {
      token,
      info: {
        name: submittedName,
        fw_version: typeof body.fw_version === 'string' ? body.fw_version : undefined,
      },
    });
    // Bind deviceId back into the session so the WS handler can resolve
    // slot_agent_map without a per-message token-prefix lookup.
    setSessionDeviceId(token, device.id);
    entry.redeemed = {
      token,
      userId: entry.userId,
      deviceId: device.id,
      server_hint: canonicalServerHint(req),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entry.redeemed));
    return true;
  }

  return false;
}
