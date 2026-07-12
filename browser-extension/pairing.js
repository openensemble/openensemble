// Browser-only device pairing helpers. This module deliberately has no
// dependency on background.js, so a legacy connection remains untouched until
// a newly approved browser credential is ready for challenge-response.

export const PAIRING_PROTOCOL_VERSION = 1;
export const PAIRING_INFO_PATH = '/api/browser/pairing/info';
export const PAIRING_REQUEST_PATH = '/api/browser/pairing/requests';
export const PAIRING_CLAIM_PATH = '/api/browser/pairing/claims';

export class PairingError extends Error {
  constructor(message, { code = 'pairing_error', status = null } = {}) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeServerOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function buildDiscoveryCandidates({ explicitUrl, activeTabUrl, configuredUrl } = {}) {
  const candidates = [];
  const add = (value) => {
    const origin = normalizeServerOrigin(value);
    if (origin && !candidates.includes(origin)) candidates.push(origin);
  };
  add(explicitUrl);
  add(activeTabUrl);
  add(configuredUrl);
  add('http://localhost:3737');
  add('http://127.0.0.1:3737');
  return candidates;
}

function normalizePath(value, fallback) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

function withTimeout(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchJson(url, options, { fetchImpl, timeoutMs = 5000, signal } = {}) {
  const timed = withTimeout(timeoutMs, signal);
  try {
    const response = await fetchImpl(url, { ...options, signal: timed.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.error || body?.message || `HTTP ${response.status}`;
      throw new PairingError(detail, { code: 'http_error', status: response.status });
    }
    if (!body || typeof body !== 'object') {
      throw new PairingError('OE returned an invalid pairing response.', { code: 'invalid_response' });
    }
    return body;
  } catch (error) {
    if (error instanceof PairingError) throw error;
    if (timed.signal.aborted) throw new PairingError('OE did not respond in time.', { code: 'timeout' });
    throw new PairingError(error?.message || 'Could not reach OE.', { code: 'network_error' });
  } finally {
    timed.dispose();
  }
}

export async function discoverPairingService({
  candidates,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new PairingError('Browser fetch is unavailable.');
  const tried = [];
  for (const candidate of candidates || []) {
    const serverUrl = normalizeServerOrigin(candidate);
    if (!serverUrl || tried.includes(serverUrl)) continue;
    tried.push(serverUrl);
    try {
      const info = await fetchJson(serverUrl + PAIRING_INFO_PATH, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      }, { fetchImpl, timeoutMs, signal });
      if (info.service !== 'openensemble-browser-pairing' || Number(info.version) !== PAIRING_PROTOCOL_VERSION) continue;
      return {
        serverUrl,
        requestPath: normalizePath(info.requestPath, PAIRING_REQUEST_PATH),
        claimPath: normalizePath(info.claimPath, PAIRING_CLAIM_PATH),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      // A failed candidate is normal during discovery; continue probing.
    }
  }
  throw new PairingError(
    tried.length
      ? `Couldn't find an OE server that supports secure browser pairing. Tried: ${tried.join(', ')}.`
      : 'No valid OE server address was available.',
    { code: 'not_found' },
  );
}

function assertPublicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new PairingError('Could not create a valid browser identity key.', { code: 'invalid_key' });
  }
}

export async function generatePairingKeypair({ subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw new PairingError('Secure browser cryptography is unavailable.', { code: 'crypto_unavailable' });
  const keypair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    subtle.exportKey('jwk', keypair.publicKey),
    subtle.exportKey('jwk', keypair.privateKey),
  ]);
  assertPublicJwk(publicKeyJwk);
  if (!privateKeyJwk?.d) throw new PairingError('Could not export the browser identity key.', { code: 'invalid_key' });
  return { publicKeyJwk, privateKeyJwk };
}

function resolveEndpoint(serverUrl, path, fallback) {
  const origin = normalizeServerOrigin(serverUrl);
  if (!origin) throw new PairingError('The OE server address is invalid.', { code: 'invalid_server_url' });
  return origin + normalizePath(path, fallback);
}

export async function requestBrowserPairing({
  serverUrl,
  requestPath,
  publicKeyJwk,
  browserName,
  extensionVersion,
  sharedProfile,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  signal,
} = {}) {
  assertPublicJwk(publicKeyJwk);
  const body = await fetchJson(resolveEndpoint(serverUrl, requestPath, PAIRING_REQUEST_PATH), {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKeyJwk,
      browserName: String(browserName || '').trim().slice(0, 120),
      extensionVersion: String(extensionVersion || '').trim().slice(0, 32),
      sharedProfile: Boolean(sharedProfile),
    }),
  }, { fetchImpl, timeoutMs, signal });
  if (!body.requestId || !body.claimSecret || !body.userCode || !body.expiresAt) {
    throw new PairingError('OE returned an incomplete pairing request.', { code: 'invalid_response' });
  }
  const expiresAt = new Date(body.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new PairingError('OE returned an expired pairing request.', { code: 'invalid_response' });
  }
  let approvalUrl = null;
  if (body.approvalUrl) {
    try {
      const serverOrigin = normalizeServerOrigin(serverUrl);
      const parsed = new URL(body.approvalUrl, serverOrigin);
      // Discovery can begin from an arbitrary active tab. Never let a server
      // that merely imitates the discovery marker turn this button into an
      // off-origin phishing link.
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === serverOrigin) {
        approvalUrl = parsed.href;
      }
    } catch { /* optional */ }
  }
  return {
    requestId: String(body.requestId),
    claimSecret: String(body.claimSecret),
    userCode: String(body.userCode),
    expiresAt,
    pollIntervalMs: Math.min(10_000, Math.max(1_000, Number(body.pollIntervalMs) || 2_000)),
    approvalUrl,
  };
}

export async function claimBrowserPairing({
  serverUrl,
  claimPath,
  requestId,
  claimSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  signal,
} = {}) {
  if (!requestId || !claimSecret) {
    throw new PairingError('The pending pairing request is incomplete.', { code: 'invalid_pending_request' });
  }
  const body = await fetchJson(resolveEndpoint(serverUrl, claimPath, PAIRING_CLAIM_PATH), {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, claimSecret }),
  }, { fetchImpl, timeoutMs, signal });
  const status = String(body.status || '');
  if (!['pending', 'approved', 'denied', 'expired'].includes(status)) {
    throw new PairingError('OE returned an unknown pairing status.', { code: 'invalid_response' });
  }
  if (status === 'approved' && !body.credentialId) {
    throw new PairingError('OE approved pairing without issuing a browser credential.', { code: 'invalid_response' });
  }
  return {
    status,
    credentialId: body.credentialId ? String(body.credentialId) : null,
    userName: typeof body.userName === 'string' ? body.userName.trim() : '',
    expiresAt: body.expiresAt ? new Date(body.expiresAt).getTime() : null,
    pollIntervalMs: body.pollIntervalMs
      ? Math.min(10_000, Math.max(1_000, Number(body.pollIntervalMs)))
      : null,
  };
}
