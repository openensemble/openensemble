/**
 * HTTP surface for OE Bridge device-code pairing.
 *
 * Public, rate-limited extension endpoints:
 *   GET  /api/browser/pairing/info
 *   POST /api/browser/pairing/requests
 *   POST /api/browser/pairing/claims
 *
 * Authenticated, same-origin user endpoints:
 *   POST   /api/browser/pairing/approvals
 *   GET    /api/browser/pairing/credentials
 *   DELETE /api/browser/pairing/credentials/:credentialId
 */

import {
  readBody, requireAuth, getClientIp, getUser,
} from './_helpers.mjs';
import {
  createBrowserPairingRequest, approveByUserCode, claimBrowserPairingRequest,
  listBrowserCredentials, revokeBrowserCredential,
} from '../lib/browser-pairing.mjs';
import {
  consumeBrowserPairingRequest, isBrowserClaimLocked, recordBadBrowserClaim,
  clearBadBrowserClaims,
} from './_helpers/browser-pairing-ratelimit.mjs';
import { log } from '../logger.mjs';

const INFO = Object.freeze({
  service: 'openensemble-browser-pairing',
  version: 1,
  algorithm: 'ES256',
  requestPath: '/api/browser/pairing/requests',
  claimPath: '/api/browser/pairing/claims',
  approvalPath: '/api/browser/pairing/approvals',
  websocketPath: '/ws/browser-ext',
});

function extensionOrigin(req) {
  const origin = String(req.headers?.origin || '');
  return /^(?:chrome|moz)-extension:\/\/[a-z0-9_-]+$/i.test(origin) ? origin : null;
}

function sendJson(req, res, status, body, { publicExtension = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const origin = publicExtension ? extensionOrigin(req) : null;
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function jsonBody(req) {
  const raw = await readBody(req);
  return raw?.length ? JSON.parse(raw.toString()) : {};
}

function publicServerOrigin(req) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto === 'https' || req.socket?.encrypted ? 'https' : 'http';
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost:3737')
    .split(',')[0].trim().slice(0, 255);
  return `${proto}://${host}`;
}

function friendlyName(userId) {
  const user = getUser(userId);
  const raw = user?.displayName || user?.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/browser/pairing/')) return false;

  // Extension-origin preflight. The state-changing server edge guard allows
  // only these two unauthenticated pairing paths; approval is intentionally
  // absent and remains same-origin + authenticated.
  if (req.method === 'OPTIONS' && (
    pathname === INFO.requestPath || pathname === INFO.claimPath
  )) {
    const origin = extensionOrigin(req);
    if (!origin) { sendJson(req, res, 403, { error: 'Extension origin required' }); return true; }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    });
    res.end();
    return true;
  }

  if (pathname === INFO.requestPath.replace('/requests', '/info') && req.method === 'GET') {
    sendJson(req, res, 200, INFO, { publicExtension: true });
    return true;
  }

  if (pathname === INFO.requestPath && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!consumeBrowserPairingRequest(ip)) {
      sendJson(req, res, 429, { error: 'Too many pairing requests. Try again later.' }, { publicExtension: true });
      return true;
    }
    let body;
    try { body = await jsonBody(req); }
    catch { sendJson(req, res, 400, { error: 'Invalid JSON' }, { publicExtension: true }); return true; }
    let result;
    try {
      result = createBrowserPairingRequest({
        publicKeyJwk: body.publicKeyJwk,
        browserName: body.browserName,
        extensionVersion: body.extensionVersion,
        sharedProfile: body.sharedProfile,
        ip,
      });
    } catch (e) {
      sendJson(req, res, 400, { error: e?.message || 'Invalid pairing request' }, { publicExtension: true });
      return true;
    }
    if (!result.ok) {
      sendJson(req, res, result.capped ? 429 : 400, { error: result.error }, { publicExtension: true });
      return true;
    }
    const approvalUrl = `${publicServerOrigin(req)}/?browser-pairing=${encodeURIComponent(result.requestId)}`;
    log.info('browser-pairing', 'browser requested pairing', {
      requestId: result.requestId, browserName: body.browserName || null, ip,
    });
    sendJson(req, res, 200, {
      requestId: result.requestId,
      claimSecret: result.claimSecret,
      userCode: result.userCode,
      expiresAt: new Date(result.expiresAt).toISOString(),
      pollIntervalMs: result.pollIntervalMs,
      approvalUrl,
    }, { publicExtension: true });
    return true;
  }

  if (pathname === INFO.claimPath && req.method === 'POST') {
    const ip = getClientIp(req);
    let body;
    try { body = await jsonBody(req); }
    catch { sendJson(req, res, 400, { error: 'Invalid JSON' }, { publicExtension: true }); return true; }

    // Verify first. A caller holding the real 256-bit claim secret is served
    // even when its NAT-shared IP has been locked by somebody else's guesses.
    const claim = claimBrowserPairingRequest({ requestId: body.requestId, claimSecret: body.claimSecret });
    if (!claim.ok) {
      if (isBrowserClaimLocked(ip)) {
        sendJson(req, res, 429, { error: 'Too many failed claims. Try again later.' }, { publicExtension: true });
        return true;
      }
      recordBadBrowserClaim(ip);
      // Wrong secret and unknown request are deliberately indistinguishable.
      sendJson(req, res, 404, { error: 'Pairing request not found' }, { publicExtension: true });
      return true;
    }

    if (claim.status === 'approved') {
      clearBadBrowserClaims(ip);
      sendJson(req, res, 200, {
        status: 'approved',
        credentialId: claim.credentialId,
        userId: claim.userId,
        userName: friendlyName(claim.userId),
      }, { publicExtension: true });
      return true;
    }
    sendJson(req, res, 200, { status: claim.status }, { publicExtension: true });
    return true;
  }

  if (pathname === INFO.approvalPath && req.method === 'POST') {
    const userId = requireAuth(req, res, { allowMediaToken: false });
    if (!userId) return true;
    let body;
    try { body = await jsonBody(req); }
    catch { sendJson(req, res, 400, { error: 'Invalid JSON' }); return true; }
    const approved = approveByUserCode(userId, {
      requestId: body.requestId,
      userCode: body.userCode,
    });
    if (!approved.ok) {
      const status = approved.error === 'expired' ? 410 : 404;
      sendJson(req, res, status, { error: approved.error === 'expired' ? 'Pairing request expired' : 'Pairing request not found' });
      return true;
    }
    log.info('browser-pairing', 'browser pairing approved', {
      requestId: approved.requestId, credentialId: approved.credentialId, userId,
    });
    sendJson(req, res, 200, {
      status: 'approved',
      requestId: approved.requestId,
      credentialId: approved.credentialId,
      userId,
      userName: friendlyName(userId),
    });
    return true;
  }

  if (pathname === '/api/browser/pairing/credentials' && req.method === 'GET') {
    const userId = requireAuth(req, res, { allowMediaToken: false });
    if (!userId) return true;
    sendJson(req, res, 200, listBrowserCredentials(userId));
    return true;
  }

  const revokeMatch = pathname.match(/^\/api\/browser\/pairing\/credentials\/([^/]+)$/);
  if (revokeMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res, { allowMediaToken: false });
    if (!userId) return true;
    const credentialId = decodeURIComponent(revokeMatch[1]);
    if (!revokeBrowserCredential(userId, credentialId)) {
      sendJson(req, res, 404, { error: 'Browser credential not found' });
      return true;
    }
    const { disconnectBrowserCredential } = await import('../lib/browser-bus.mjs');
    const disconnected = disconnectBrowserCredential(userId, credentialId);
    log.info('browser-pairing', 'browser credential revoked', { credentialId, userId, disconnected });
    sendJson(req, res, 200, { ok: true, disconnected });
    return true;
  }

  return false;
}
