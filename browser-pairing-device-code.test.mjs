/**
 * Browser extension device-code pairing: persisted public-key credentials,
 * HTTP request/approve/claim flow, and one-time ES256 WebSocket challenges.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { webcrypto } from 'crypto';
import { BASE_DIR, USERS_DIR } from './lib/paths.mjs';
import { saveUser, createSession } from './routes/_helpers.mjs';
import {
  createBrowserPairingRequest, approveByUserCode, claimBrowserPairingRequest,
  createBrowserAuthChallenge, verifyBrowserAuthResponse, browserAuthPayload,
  getBrowserCredential, listBrowserCredentials, revokeBrowserCredential,
  _resetBrowserPairingForTests, BROWSER_PAIRING_CONSTANTS,
} from './lib/browser-pairing.mjs';
import { handle } from './routes/browser-pairing.mjs';
import {
  recordBadBrowserClaim, isBrowserClaimLocked,
  _resetBrowserPairingRateLimitsForTests,
} from './routes/_helpers/browser-pairing-ratelimit.mjs';
import { registerBrowser, disconnectBrowserCredential, listBrowsers } from './lib/browser-bus.mjs';

const STORE_PATH = path.join(BASE_DIR, 'browser-pairing.json');
const USER_A = 'user_browserpair_a';
const USER_B = 'user_browserpair_b';

let keyPair;
let publicKeyJwk;

async function makeKey() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  return { pair, jwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey) };
}

async function signChallenge(pair, credentialId, challenge) {
  const payload = browserAuthPayload({
    credentialId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
  });
  const raw = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(payload),
  );
  return Buffer.from(raw).toString('base64url');
}

function reset() {
  _resetBrowserPairingForTests({ removeDisk: true });
  _resetBrowserPairingRateLimitsForTests();
}

beforeEach(async () => {
  reset();
  ({ pair: keyPair, jwk: publicKeyJwk } = await makeKey());
  saveUser({ id: USER_A, name: 'Alex', role: 'owner' });
  saveUser({ id: USER_B, name: 'Taylor', role: 'user' });
});

afterEach(() => vi.useRealTimers());

afterAll(() => {
  reset();
  for (const id of [USER_A, USER_B]) {
    try { fs.rmSync(path.join(USERS_DIR, id), { recursive: true, force: true }); } catch {}
  }
});

function newRequest(overrides = {}) {
  return createBrowserPairingRequest({
    publicKeyJwk,
    browserName: 'Vivaldi on Workshop PC',
    extensionVersion: '0.4.0',
    sharedProfile: false,
    ip: '192.0.2.10',
    ...overrides,
  });
}

function fakeRes() {
  return {
    statusCode: null, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); return this; },
    end(chunk) { if (chunk) this.body += chunk; },
    json() { return JSON.parse(this.body || '{}'); },
  };
}

function fakeReq({ method = 'GET', url, headers = {}, body = null, ip = '192.0.2.10' } = {}) {
  return {
    method, url,
    headers: { host: 'oe.example.test', ...headers },
    socket: { remoteAddress: ip, encrypted: true },
    on(event, cb) {
      if (event === 'data' && body != null) cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      if (event === 'end') cb();
    },
  };
}

function authHeader(token) { return { authorization: `Bearer ${token}` }; }
const EXT_ORIGIN = { origin: 'chrome-extension://abcdefghijklmnop' };

describe('lib/browser-pairing — persisted pairing and credentials', () => {
  it('creates a strong human-code request and persists hashes, never raw secrets', () => {
    const request = newRequest();
    expect(request.ok).toBe(true);
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(request.claimSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(request.pollIntervalMs).toBe(2_000);

    const diskText = fs.readFileSync(STORE_PATH, 'utf8');
    const disk = JSON.parse(diskText);
    const record = disk.requests[request.requestId];
    expect(record.claimSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.userCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(diskText).not.toContain(request.claimSecret);
    expect(diskText).not.toContain(request.userCode);
    expect(record.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(fs.statSync(STORE_PATH).mode & 0o777).toBe(0o600);
  });

  it('rejects the wrong curve and malformed P-256 coordinates', async () => {
    const ed = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const edJwk = await webcrypto.subtle.exportKey('jwk', ed.publicKey);
    expect(() => newRequest({ publicKeyJwk: edJwk })).toThrow(/P-256/);
    expect(() => newRequest({ publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })).toThrow(/coordinates/);
  });

  it('binds approval to the supplied current user and claims without minting a bearer token', () => {
    const request = newRequest();
    expect(claimBrowserPairingRequest(request)).toMatchObject({ ok: true, status: 'pending' });
    expect(approveByUserCode(USER_A, request)).toMatchObject({ ok: true, userId: USER_A });
    // A different logged-in member cannot take over an already-approved code.
    expect(approveByUserCode(USER_B, request)).toEqual({ ok: false, error: 'not_found' });

    const claim = claimBrowserPairingRequest(request);
    expect(claim).toMatchObject({ ok: true, status: 'approved', userId: USER_A });
    expect(claim.credentialId).toMatch(/^oeb_[A-Za-z0-9_-]{22}$/);
    expect(claim.token).toBeUndefined();
    expect(getBrowserCredential(claim.credentialId)).toMatchObject({
      userId: USER_A, browserName: 'Vivaldi on Workshop PC', extensionVersion: '0.4.0',
    });
    // Claim retries are durable and idempotent.
    expect(claimBrowserPairingRequest(request)).toMatchObject({
      status: 'approved', credentialId: claim.credentialId,
    });
  });

  it('survives a restart with only public-key credentials and hashed pairing values', () => {
    const request = newRequest();
    const approved = approveByUserCode(USER_A, request);
    _resetBrowserPairingForTests();
    const claim = claimBrowserPairingRequest(request);
    expect(claim).toMatchObject({ status: 'approved', credentialId: approved.credentialId, userId: USER_A });
    expect(getBrowserCredential(approved.credentialId).publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });

  it('fails closed on a corrupt credential store without overwriting its bytes', () => {
    const corrupt = '{"version":1,"credentials":';
    fs.writeFileSync(STORE_PATH, corrupt, { mode: 0o600 });
    _resetBrowserPairingForTests();
    expect(() => listBrowserCredentials(USER_A)).toThrow(/malformed; refusing/i);
    expect(() => newRequest()).toThrow(/malformed; refusing/i);
    expect(fs.readFileSync(STORE_PATH, 'utf8')).toBe(corrupt);
    reset();
  });

  it('expires an unclaimed approval and removes its live credential', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const request = newRequest();
    const approved = approveByUserCode(USER_A, request);
    expect(getBrowserCredential(approved.credentialId)).not.toBeNull();
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
    expect(claimBrowserPairingRequest(request)).toMatchObject({ status: 'expired' });
    expect(getBrowserCredential(approved.credentialId)).toBeNull();
  });

  it('enforces pending caps per IP', () => {
    for (let i = 0; i < 3; i++) {
      expect(newRequest({ ip: '192.0.2.50', browserName: `Browser ${i}` }).ok).toBe(true);
    }
    expect(newRequest({ ip: '192.0.2.50' })).toMatchObject({ ok: false, capped: true });
  });

  it('refuses shared browser profiles because they cannot isolate household identity', () => {
    expect(newRequest({ sharedProfile: true })).toMatchObject({
      ok: false,
      sharedProfileUnsupported: true,
      error: expect.stringMatching(/separate browser profile/i),
    });
    expect(fs.existsSync(STORE_PATH)).toBe(false);
  });

  it('lists only a user’s credentials and enforces owner-only revocation', () => {
    const a = newRequest({ ip: '192.0.2.1' });
    const b = newRequest({ ip: '192.0.2.2' });
    const ac = approveByUserCode(USER_A, a).credentialId;
    const bc = approveByUserCode(USER_B, b).credentialId;
    expect(listBrowserCredentials(USER_A).map(c => c.credentialId)).toEqual([ac]);
    expect(listBrowserCredentials(USER_A)[0].publicKeyJwk).toBeUndefined();
    expect(revokeBrowserCredential(USER_B, ac)).toBe(false);
    expect(revokeBrowserCredential(USER_A, ac)).toBe(true);
    expect(getBrowserCredential(ac)).toBeNull();
    expect(getBrowserCredential(bc)).not.toBeNull();
  });

  it('can synchronously disconnect sockets authenticated by one revoked credential', () => {
    const wsA = { send() {}, close: vi.fn(), terminate: vi.fn() };
    const wsB = { send() {}, close: vi.fn(), terminate: vi.fn() };
    registerBrowser(wsA, { userId: USER_A, name: 'A', version: '1', credentialId: 'oeb_a' });
    registerBrowser(wsB, { userId: USER_A, name: 'B', version: '1', credentialId: 'oeb_b' });
    expect(disconnectBrowserCredential(USER_A, 'oeb_a')).toBe(1);
    expect(wsA.close).toHaveBeenCalledWith(4004, 'browser credential revoked');
    expect(wsB.close).not.toHaveBeenCalled();
    expect(listBrowsers(USER_A)).toHaveLength(1);
    disconnectBrowserCredential(USER_A, 'oeb_b');
  });
});

describe('lib/browser-pairing — server challenge proof', () => {
  function pairedCredential() {
    const request = newRequest();
    const { credentialId } = approveByUserCode(USER_A, request);
    claimBrowserPairingRequest(request);
    return credentialId;
  }

  it('verifies a Chromium/WebCrypto raw ECDSA signature and consumes the challenge', async () => {
    const credentialId = pairedCredential();
    const challenge = createBrowserAuthChallenge(credentialId);
    const signature = await signChallenge(keyPair, credentialId, challenge);
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    expect(verifyBrowserAuthResponse({ credentialId, challengeId: challenge.challengeId, signature }))
      .toMatchObject({ credentialId, userId: USER_A });
    // One-time means a byte-identical replay fails.
    expect(verifyBrowserAuthResponse({ credentialId, challengeId: challenge.challengeId, signature })).toBeNull();
  });

  it('consumes a challenge even when the signature is bad', async () => {
    const credentialId = pairedCredential();
    const challenge = createBrowserAuthChallenge(credentialId);
    const signature = await signChallenge(keyPair, credentialId, challenge);
    const corrupted = Buffer.from(signature, 'base64url');
    corrupted[0] ^= 0xff;
    expect(verifyBrowserAuthResponse({
      credentialId, challengeId: challenge.challengeId, signature: corrupted.toString('base64url'),
    })).toBeNull();
    expect(verifyBrowserAuthResponse({ credentialId, challengeId: challenge.challengeId, signature })).toBeNull();
  });

  it('rejects an expired challenge and an unknown credential', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const credentialId = pairedCredential();
    const challenge = createBrowserAuthChallenge(credentialId);
    const signature = await signChallenge(keyPair, credentialId, challenge);
    vi.setSystemTime(Date.now() + BROWSER_PAIRING_CONSTANTS.challengeTtlMs + 1);
    expect(verifyBrowserAuthResponse({ credentialId, challengeId: challenge.challengeId, signature })).toBeNull();
    expect(createBrowserAuthChallenge('oeb_does_not_exist')).toBeNull();
  });
});

describe('routes/browser-pairing — HTTP contract', () => {
  it('advertises the stable discovery contract', async () => {
    const res = fakeRes();
    expect(await handle(fakeReq({ url: '/api/browser/pairing/info', headers: EXT_ORIGIN }), res)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      service: 'openensemble-browser-pairing', version: 1, algorithm: 'ES256',
      requestPath: '/api/browser/pairing/requests',
      claimPath: '/api/browser/pairing/claims',
      approvalPath: '/api/browser/pairing/approvals',
    });
    expect(res.headers['Access-Control-Allow-Origin']).toBe(EXT_ORIGIN.origin);
  });

  it('runs request -> current-user approval -> claim with the locked response fields', async () => {
    const reqRes = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/requests', headers: EXT_ORIGIN,
      body: { publicKeyJwk, browserName: 'Vivaldi', extensionVersion: '0.4.0', sharedProfile: false },
    }), reqRes);
    expect(reqRes.statusCode).toBe(200);
    const pairing = reqRes.json();
    expect(pairing).toMatchObject({ pollIntervalMs: 2_000 });
    expect(pairing.userCode).toMatch(/^....-....$/);
    expect(new Date(pairing.expiresAt).toString()).not.toBe('Invalid Date');
    expect(pairing.approvalUrl).toBe(`https://oe.example.test/?browser-pairing=${pairing.requestId}`);

    const pending = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/claims', headers: EXT_ORIGIN,
      body: { requestId: pairing.requestId, claimSecret: pairing.claimSecret },
    }), pending);
    expect(pending.json()).toEqual({ status: 'pending' });

    const token = createSession(USER_A, { kind: 'browser' });
    const approve = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/approvals', headers: authHeader(token),
      // ownerUserId is ignored by design; approval always binds current user.
      body: { requestId: pairing.requestId, userCode: pairing.userCode, ownerUserId: USER_B },
    }), approve);
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ status: 'approved', userId: USER_A, userName: 'Alex' });

    const claim = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/claims', headers: EXT_ORIGIN,
      body: { requestId: pairing.requestId, claimSecret: pairing.claimSecret },
    }), claim);
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ status: 'approved', userId: USER_A, userName: 'Alex' });
    expect(claim.json().credentialId).toMatch(/^oeb_/);
    expect(claim.json().token).toBeUndefined();
  });

  it('rate-limits requests and bad claims but never strands a valid NAT-shared claim', async () => {
    const ip = '192.0.2.88';
    const pairing = newRequest({ ip });
    approveByUserCode(USER_A, pairing);

    for (let i = 0; i < 10; i++) recordBadBrowserClaim(ip);
    expect(isBrowserClaimLocked(ip)).toBe(true);
    const valid = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/claims', ip, headers: EXT_ORIGIN,
      body: { requestId: pairing.requestId, claimSecret: pairing.claimSecret },
    }), valid);
    expect(valid.statusCode).toBe(200);
    expect(valid.json().status).toBe('approved');

    const wrong = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/claims', ip, headers: EXT_ORIGIN,
      body: { requestId: pairing.requestId, claimSecret: 'wrong' },
    }), wrong);
    // The successful terminal claim clears this IP's bad-claim bucket.
    expect(wrong.statusCode).toBe(404);
  });

  it('requires authentication to approve and does not expose credentials across users', async () => {
    const pairing = newRequest();
    const noAuth = fakeRes();
    await handle(fakeReq({
      method: 'POST', url: '/api/browser/pairing/approvals',
      body: { requestId: pairing.requestId, userCode: pairing.userCode },
    }), noAuth);
    expect(noAuth.statusCode).toBe(401);

    approveByUserCode(USER_A, pairing);
    const tokenB = createSession(USER_B, { kind: 'browser' });
    const list = fakeRes();
    await handle(fakeReq({ url: '/api/browser/pairing/credentials', headers: authHeader(tokenB) }), list);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
  });
});
