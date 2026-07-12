// @ts-check
/**
 * Browser-extension device-code pairing and long-lived public-key credentials.
 *
 * Security properties:
 *  - Pairing requests carry a high-entropy claim secret and a human-entered
 *    Crockford Base32 code. Only SHA-256 hashes of those values are persisted.
 *  - An approval binds the submitted P-256 public key to the CURRENT OE user;
 *    no OE bearer/session token is ever handed to the extension.
 *  - The credential store contains public keys only. WebSocket authentication
 *    uses a short-lived, one-time server challenge and an ES256 signature.
 *  - Pending requests and unclaimed approvals expire. Credentials created by
 *    an approval that was never claimed are removed when the request expires.
 *
 * All state is held in one atomically-written file so an approval cannot leave
 * the credential store and request state out of sync after a crash.
 */

import fs from 'fs';
import path from 'path';
import {
  createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature,
} from 'crypto';
import { BASE_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const STORE_PATH = path.join(BASE_DIR, 'browser-pairing.json');

const REQUEST_TTL_MS = 10 * 60 * 1000;
const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000;
const AUTH_CHALLENGE_TTL_MS = 30 * 1000;
const POLL_INTERVAL_MS = 2_000;
const MAX_PENDING_TOTAL = 30;
const MAX_PENDING_PER_IP = 3;
const MAX_CHALLENGES = 4_096;
const MAX_CHALLENGES_PER_CREDENTIAL = 8;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** @typedef {{kty:'EC',crv:'P-256',x:string,y:string,ext:true,key_ops:['verify']}} BrowserPublicJwk */

/**
 * @typedef {object} BrowserPairingRequest
 * @property {string} requestId
 * @property {string} claimSecretHash
 * @property {string} userCodeHash
 * @property {BrowserPublicJwk=} publicKeyJwk
 * @property {string} browserName
 * @property {string|null} extensionVersion
 * @property {boolean} sharedProfile
 * @property {string} ip
 * @property {'pending'|'approved'|'claimed'|'expired'} status
 * @property {number} requestedAt
 * @property {number} expiresAt
 * @property {number|null} approvedAt
 * @property {number|null} claimedAt
 * @property {string|null} userId
 * @property {string|null} credentialId
 */

/**
 * @typedef {object} BrowserCredential
 * @property {string} credentialId
 * @property {string} userId
 * @property {BrowserPublicJwk} publicKeyJwk
 * @property {string} browserName
 * @property {string|null} extensionVersion
 * @property {boolean} sharedProfile
 * @property {number} createdAt
 * @property {number|null} lastUsedAt
 */

/** @type {{version:1,requests:Record<string,BrowserPairingRequest>,credentials:Record<string,BrowserCredential>}|null} */
let _store = null;

/** @type {Map<string,{challengeId:string,credentialId:string,nonce:string,expiresAt:number,createdAt:number}>} */
const _challenges = new Map();
const _lastUsedWrites = new Map();

function emptyStore() {
  return { version: /** @type {const} */ (1), requests: {}, credentials: {} };
}

function loadStore() {
  if (_store) return _store;
  if (!fs.existsSync(STORE_PATH)) {
    _store = emptyStore();
    return _store;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (parsed?.version !== 1
        || !parsed.requests || typeof parsed.requests !== 'object' || Array.isArray(parsed.requests)
        || !parsed.credentials || typeof parsed.credentials !== 'object' || Array.isArray(parsed.credentials)) {
      throw new Error('unsupported or malformed schema');
    }
    _store = { version: 1, requests: parsed.requests, credentials: parsed.credentials };
    return _store;
  } catch (e) {
    // This file is the revocation and ownership boundary. Treating corruption
    // as an empty registry would revive nothing immediately, but the next
    // write would destroy the only recoverable copy and could silently change
    // credential state. Fail closed and leave the bytes untouched.
    _store = null;
    throw new Error(`browser pairing store is malformed; refusing to continue: ${e.message}`);
  }
}

function persist() {
  const store = loadStore();
  atomicWriteSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE_PATH, 0o600); } catch {}
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}

function hashHex(value) {
  return sha256(value).toString('hex');
}

function safeHashEquals(raw, expectedHex) {
  if (typeof raw !== 'string' || typeof expectedHex !== 'string') return false;
  let expected;
  try { expected = Buffer.from(expectedHex, 'hex'); } catch { return false; }
  const actual = sha256(raw);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeUserCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function generateUserCode() {
  // 8 Crockford characters = 40 bits. randomBytes maps exactly onto a
  // 32-character alphabet, so there is no modulo bias.
  const bytes = randomBytes(8);
  let raw = '';
  for (const byte of bytes) raw += CROCKFORD[byte & 31];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function generateUniqueUserCode(store) {
  for (let i = 0; i < 20; i++) {
    const code = generateUserCode();
    const hash = hashHex(normalizeUserCode(code));
    const collision = Object.values(store.requests).some(r =>
      (r.status === 'pending' || r.status === 'approved') && r.userCodeHash === hash);
    if (!collision) return { code, hash };
  }
  throw new Error('Unable to allocate a unique browser pairing code');
}

function cleanString(value, max, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, max);
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try { return Buffer.from(value, 'base64url'); } catch { return null; }
}

/** Validate and canonicalize a WebCrypto P-256 public JWK. */
export function normalizeBrowserPublicKeyJwk(value) {
  if (!value || typeof value !== 'object') throw new Error('publicKeyJwk is required');
  const { kty, crv, x, y } = value;
  if (kty !== 'EC' || crv !== 'P-256') throw new Error('publicKeyJwk must be an EC P-256 key');
  const xb = decodeBase64Url(x);
  const yb = decodeBase64Url(y);
  if (!xb || !yb || xb.length !== 32 || yb.length !== 32) {
    throw new Error('publicKeyJwk has invalid P-256 coordinates');
  }
  /** @type {BrowserPublicJwk} */
  const jwk = { kty: 'EC', crv: 'P-256', x, y, ext: true, key_ops: ['verify'] };
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('wrong curve');
    }
  } catch {
    throw new Error('publicKeyJwk is not a valid P-256 public key');
  }
  return jwk;
}

function expireAndPrune(now = Date.now()) {
  const store = loadStore();
  let changed = false;
  for (const request of Object.values(store.requests)) {
    if ((request.status === 'pending' || request.status === 'approved') && now >= request.expiresAt) {
      // An approved credential is not usable by the extension until it learns
      // the credentialId through a valid claim. Remove never-claimed records
      // so abandoned approvals do not accumulate live credentials.
      if (request.status === 'approved' && request.credentialId) {
        delete store.credentials[request.credentialId];
      }
      request.status = 'expired';
      request.publicKeyJwk = undefined;
      changed = true;
    }
  }
  for (const [requestId, request] of Object.entries(store.requests)) {
    const resolvedAt = request.claimedAt || request.approvedAt || request.expiresAt;
    if ((request.status === 'claimed' || request.status === 'expired') && now - resolvedAt > RESOLVED_RETENTION_MS) {
      delete store.requests[requestId];
      changed = true;
    }
  }
  if (changed) persist();
  return store;
}

/**
 * Create an unauthenticated device-code request.
 * @param {{publicKeyJwk?:unknown,browserName?:unknown,extensionVersion?:unknown,sharedProfile?:boolean,ip?:string}} [input]
 */
export function createBrowserPairingRequest({
  publicKeyJwk, browserName, extensionVersion, sharedProfile = false, ip = 'unknown',
} = {}) {
  // A browser credential carries the approving member's browser capabilities.
  // Encryption cannot distinguish people sharing one unlocked profile, so do
  // not imply isolation we cannot enforce. Shared household computers must use
  // separate browser profiles before pairing OE Bridge.
  if (sharedProfile === true) {
    return {
      ok: false,
      sharedProfileUnsupported: true,
      error: 'OE Bridge requires a separate browser profile for each household member.',
    };
  }
  const store = expireAndPrune();
  const key = normalizeBrowserPublicKeyJwk(publicKeyJwk);
  const pending = Object.values(store.requests).filter(r => r.status === 'pending' || r.status === 'approved');
  if (pending.length >= MAX_PENDING_TOTAL) {
    return { ok: false, capped: true, error: 'Too many browser pairing requests. Try again shortly.' };
  }
  if (pending.filter(r => r.ip === ip).length >= MAX_PENDING_PER_IP) {
    return { ok: false, capped: true, error: 'Too many pending browser pairing requests from this address.' };
  }

  const requestId = randomBytes(16).toString('base64url');
  const claimSecret = randomBytes(32).toString('base64url');
  const { code: userCode, hash: userCodeHash } = generateUniqueUserCode(store);
  const now = Date.now();
  /** @type {BrowserPairingRequest} */
  const record = {
    requestId,
    claimSecretHash: hashHex(claimSecret),
    userCodeHash,
    publicKeyJwk: key,
    browserName: cleanString(browserName, 80, 'OE Bridge'),
    extensionVersion: cleanString(extensionVersion, 32),
    sharedProfile: false,
    ip: cleanString(ip, 100, 'unknown'),
    status: 'pending',
    requestedAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    approvedAt: null,
    claimedAt: null,
    userId: null,
    credentialId: null,
  };
  store.requests[requestId] = record;
  persist();
  return {
    ok: true,
    requestId,
    claimSecret,
    userCode,
    expiresAt: record.expiresAt,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

/**
 * Authenticated approval primitive, also exported for a future chat fastpath.
 * The supplied userId is always the credential owner; callers cannot nominate
 * another household member in the request body.
 * @param {string} userId
 * @param {{requestId?:unknown,userCode?:unknown}} [input]
 */
export function approveByUserCode(userId, { requestId, userCode } = {}) {
  if (!userId) throw new Error('userId is required');
  const store = expireAndPrune();
  const request = store.requests[String(requestId || '')];
  const normalized = normalizeUserCode(userCode);
  if (!request || !normalized || !safeHashEquals(normalized, request.userCodeHash)) {
    return { ok: false, error: 'not_found' };
  }
  if (request.status === 'expired') return { ok: false, error: 'expired' };
  if (request.status === 'claimed' || request.status === 'approved') {
    if (request.userId !== userId) return { ok: false, error: 'not_found' };
    return { ok: true, status: 'approved', requestId: request.requestId, credentialId: request.credentialId, userId };
  }
  if (request.status !== 'pending' || !request.publicKeyJwk) return { ok: false, error: 'not_found' };

  const credentialId = `oeb_${randomBytes(16).toString('base64url')}`;
  const now = Date.now();
  /** @type {BrowserCredential} */
  const credential = {
    credentialId,
    userId,
    publicKeyJwk: request.publicKeyJwk,
    browserName: request.browserName,
    extensionVersion: request.extensionVersion,
    sharedProfile: request.sharedProfile,
    createdAt: now,
    lastUsedAt: null,
  };
  store.credentials[credentialId] = credential;
  request.status = 'approved';
  request.approvedAt = now;
  request.userId = userId;
  request.credentialId = credentialId;
  request.publicKeyJwk = undefined;
  persist();
  return { ok: true, status: 'approved', requestId: request.requestId, credentialId, userId };
}

/**
 * Verify the claim secret and return status. Raw secrets never leave here.
 * @param {{requestId?:unknown,claimSecret?:unknown}} [input]
 */
export function claimBrowserPairingRequest({ requestId, claimSecret } = {}) {
  const store = expireAndPrune();
  const request = store.requests[String(requestId || '')];
  if (!request || !safeHashEquals(String(claimSecret || ''), request.claimSecretHash)) {
    return { ok: false, error: 'not_found' };
  }
  if (request.status === 'pending') return { ok: true, status: 'pending' };
  if (request.status === 'expired') return { ok: true, status: 'expired' };
  if (request.status !== 'approved' && request.status !== 'claimed') {
    return { ok: true, status: request.status };
  }
  const credential = request.credentialId ? store.credentials[request.credentialId] : null;
  if (!credential || credential.userId !== request.userId) {
    return { ok: true, status: 'expired' };
  }
  if (request.status === 'approved') {
    request.status = 'claimed';
    request.claimedAt = Date.now();
    persist();
  }
  return {
    ok: true,
    status: 'approved',
    credentialId: credential.credentialId,
    userId: credential.userId,
  };
}

function publicCredential(record) {
  if (!record) return null;
  const { publicKeyJwk, ...safe } = record;
  return safe;
}

/** Return a credential for server-internal authentication, public key included. */
export function getBrowserCredential(credentialId) {
  const record = expireAndPrune().credentials[String(credentialId || '')];
  return record ? { ...record, publicKeyJwk: { ...record.publicKeyJwk } } : null;
}

export function listBrowserCredentials(userId) {
  return Object.values(expireAndPrune().credentials)
    .filter(c => c.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicCredential);
}

export function revokeBrowserCredential(userId, credentialId) {
  const store = expireAndPrune();
  const record = store.credentials[String(credentialId || '')];
  if (!record || record.userId !== userId) return false;
  delete store.credentials[record.credentialId];
  for (const [id, challenge] of _challenges) {
    if (challenge.credentialId === record.credentialId) _challenges.delete(id);
  }
  persist();
  return true;
}

function sweepChallenges(now = Date.now()) {
  for (const [id, challenge] of _challenges) {
    if (challenge.expiresAt <= now) _challenges.delete(id);
  }
  if (_challenges.size <= MAX_CHALLENGES) return;
  const oldest = [..._challenges.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < oldest.length - MAX_CHALLENGES; i++) _challenges.delete(oldest[i].challengeId);
}

/**
 * Create a short-lived one-time challenge for /ws/browser-ext.
 * Returns null for an unknown/revoked credential.
 */
export function createBrowserAuthChallenge(credentialId) {
  const credential = getBrowserCredential(credentialId);
  if (!credential) return null;
  const now = Date.now();
  sweepChallenges(now);
  const forCredential = [..._challenges.values()]
    .filter(c => c.credentialId === credential.credentialId)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (forCredential.length >= MAX_CHALLENGES_PER_CREDENTIAL) {
    _challenges.delete(forCredential.shift().challengeId);
  }
  const challenge = {
    challengeId: randomBytes(16).toString('base64url'),
    credentialId: credential.credentialId,
    nonce: randomBytes(32).toString('base64url'),
    expiresAt: now + AUTH_CHALLENGE_TTL_MS,
    createdAt: now,
  };
  _challenges.set(challenge.challengeId, challenge);
  return { challengeId: challenge.challengeId, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
}

/** Exact bytes the extension signs with ECDSA P-256/SHA-256. */
export function browserAuthPayload({ credentialId, challengeId, nonce }) {
  return `oe-browser-v1\n${credentialId}\n${challengeId}\n${nonce}`;
}

/**
 * Consume and verify a browser auth response. A found challenge is deleted
 * BEFORE signature verification, so even a bad signature cannot be retried.
 * Chromium WebCrypto returns ECDSA signatures as raw r||s (IEEE-P1363).
 * @param {{credentialId?:unknown,challengeId?:unknown,signature?:unknown}} [input]
 */
export function verifyBrowserAuthResponse({ credentialId, challengeId, signature } = {}) {
  sweepChallenges();
  const challenge = _challenges.get(String(challengeId || ''));
  if (!challenge) return null;
  _challenges.delete(challenge.challengeId);
  if (challenge.expiresAt <= Date.now() || challenge.credentialId !== credentialId) return null;

  const sig = decodeBase64Url(signature);
  if (!sig || sig.length !== 64) return null;
  const store = expireAndPrune();
  const credential = store.credentials[String(credentialId || '')];
  if (!credential) return null;
  const payload = browserAuthPayload({
    credentialId: credential.credentialId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
  });
  let verified = false;
  try {
    const key = createPublicKey({ key: credential.publicKeyJwk, format: 'jwk' });
    verified = verifySignature(
      'sha256', Buffer.from(payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig,
    );
  } catch { return null; }
  if (!verified) return null;

  const now = Date.now();
  if (now - (_lastUsedWrites.get(credential.credentialId) || 0) >= LAST_USED_WRITE_INTERVAL_MS) {
    _lastUsedWrites.set(credential.credentialId, now);
    credential.lastUsedAt = now;
    try { persist(); } catch (e) { console.warn('[browser-pairing] failed to update lastUsedAt:', e.message); }
  }
  return publicCredential(credential);
}

export const BROWSER_PAIRING_CONSTANTS = Object.freeze({
  requestTtlMs: REQUEST_TTL_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  challengeTtlMs: AUTH_CHALLENGE_TTL_MS,
});

// Test-only reset: defaults to simulating a restart (disk remains). Tests that
// need a blank store pass {removeDisk:true}.
export function _resetBrowserPairingForTests({ removeDisk = false } = {}) {
  _store = null;
  _challenges.clear();
  _lastUsedWrites.clear();
  if (removeDisk) {
    try { fs.rmSync(STORE_PATH); } catch {}
  }
}
