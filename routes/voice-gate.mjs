/**
 * Authenticated direct-LAN ingress for voice-device wake verification.
 *
 * The Python verifier remains loopback-only. Devices authenticate here with
 * their existing OE voice-device session; this route derives the canonical
 * device id, rebuilds the multipart body, and forwards no bearer/cookie data.
 */

import busboy from 'busboy';
import { randomBytes } from 'crypto';
import { isIP } from 'node:net';
import {
  getSessionMeta, loadConfig,
} from './_helpers.mjs';
import { getDevice } from '../lib/voice-devices.mjs';

export const VOICE_GATE_PATH = '/api/voice-gate/v1/verify';
export const INTERNAL_VERIFY_PATH = '/v1/verify';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_ACTIVE_UPSTREAM = 2;
const MAX_ACTIVE_INGRESS = 8;
const MAX_DEVICE_INGRESS = 2;
const MAX_DEVICE_REQUESTS_PER_MINUTE = 20;
const UPSTREAM_TIMEOUT_MS = 1_500;
const INGRESS_BODY_TIMEOUT_MS = 1_000;

const activeByKey = new Map();
const activeDevice = new Map();
const ingressByDevice = new Map();
const deviceRate = new Map();
let activeUpstream = 0;
let activeIngress = 0;

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
  return true;
}

function noControls(value, maxBytes) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function getVoiceDeviceBearer(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization);
  return match ? match[1] : null;
}

export function isPrivateLanAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  if (address.startsWith('::ffff:')) address = address.slice(7);

  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 127;
  }
  if (isIP(address) !== 6) return false;
  if (address === '::1') return true;
  const first = Number.parseInt(address.split(':', 1)[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * HTTP is permitted only as a direct private-LAN hop. Forwarding headers mean
 * a proxy has obscured the true device peer and are therefore refused.
 */
export function isDirectPrivateLanRequest(req) {
  const proxyMarker = Object.keys(req.headers || {}).some(name => {
    const lower = name.toLowerCase();
    return lower === 'forwarded'
      || lower === 'via'
      || lower === 'x-real-ip'
      || lower === 'true-client-ip'
      || lower === 'cdn-loop'
      || lower.startsWith('x-forwarded-')
      || lower.startsWith('cf-');
  });
  if (proxyMarker) return false;
  return isPrivateLanAddress(req.socket?.remoteAddress);
}

/**
 * The private verifier must never be an arbitrary network target. Requiring a
 * numeric loopback literal avoids DNS rebinding and accidental LAN exposure.
 */
export function normalizeLoopbackGateUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:') return '';
    if (host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    const path = url.pathname.replace(/\/+$/, '');
    if (path && path !== INTERNAL_VERIFY_PATH) return '';
    url.pathname = INTERNAL_VERIFY_PATH;
    return url.toString();
  } catch {
    return '';
  }
}

export function voiceGateConfigured(config = {}) {
  return config.verifyGateEnabled === true;
}

function gateProxyConfig(config) {
  const url = normalizeLoopbackGateUrl(config.verifyGateUpstreamUrl);
  const secret = typeof config.verifyGateClientSecret === 'string'
    ? config.verifyGateClientSecret
    : '';
  const secretBytes = Buffer.byteLength(secret, 'utf8');
  if (!url || secretBytes < 32 || secretBytes > 512
      || /[\x00-\x20\x7f]/.test(secret)) return null;
  return { url, secret };
}

function parseVerifyMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_FILE_BYTES,
          files: 1,
          fields: 6,
          fieldSize: 2 * 1024,
          parts: 7,
        },
      });
    } catch (error) {
      reject(error);
      return;
    }

    const allowedFields = new Set([
      'session_id', 'device_id', 'wake_words', 'detector_score', 'fired_at',
    ]);
    const fields = {};
    const fileChunks = [];
    let fileBytes = 0;
    let sawFile = false;
    let settled = false;
    let timer;

    const onRequestAborted = () => fail(new Error('request aborted'));
    const onRequestError = error => fail(error);
    const onRequestClose = () => {
      if (!req.complete) fail(new Error('request closed before body completed'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      req.off('aborted', onRequestAborted);
      req.off('error', onRequestError);
      req.off('close', onRequestClose);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.unpipe(bb);
      req.resume();
      if (!bb.destroyed) bb.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    req.once('aborted', onRequestAborted);
    req.once('error', onRequestError);
    req.once('close', onRequestClose);
    timer = setTimeout(
      () => fail(new Error('request body timeout')),
      INGRESS_BODY_TIMEOUT_MS,
    );
    timer.unref?.();

    bb.on('field', (name, value, info) => {
      if (!allowedFields.has(name) || Object.hasOwn(fields, name)) {
        fail(new Error('unexpected or duplicate field'));
        return;
      }
      if (info?.valueTruncated) {
        fail(new Error('field too large'));
        return;
      }
      fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || sawFile) {
        stream.resume();
        fail(new Error('unexpected or duplicate file'));
        return;
      }
      sawFile = true;
      if (info?.mimeType !== 'audio/wav' && info?.mimeType !== 'audio/x-wav') {
        stream.resume();
        fail(new Error('file must be audio/wav'));
        return;
      }
      stream.on('limit', () => fail(new Error('file too large')));
      stream.on('data', chunk => {
        if (settled) return;
        fileBytes += chunk.length;
        if (fileBytes > MAX_FILE_BYTES) {
          fail(new Error('file too large'));
          return;
        }
        fileChunks.push(chunk);
      });
      stream.on('error', fail);
    });

    bb.on('filesLimit', () => fail(new Error('too many files')));
    bb.on('fieldsLimit', () => fail(new Error('too many fields')));
    bb.on('partsLimit', () => fail(new Error('too many parts')));
    bb.on('error', fail);
    bb.on('close', () => {
      if (settled) return;
      const file = Buffer.concat(fileChunks);
      if (!sawFile || file.length === 0) {
        fail(new Error('missing file'));
        return;
      }
      if (!noControls(fields.session_id, 64)) {
        fail(new Error('invalid session_id'));
        return;
      }

      let wakeWords;
      try {
        wakeWords = JSON.parse(fields.wake_words);
      } catch {
        fail(new Error('invalid wake_words'));
        return;
      }
      if (!Array.isArray(wakeWords) || wakeWords.length === 0
          || wakeWords.length > 8
          || wakeWords.some(word => !noControls(word, 128))) {
        fail(new Error('invalid wake_words'));
        return;
      }

      let detectorScore = null;
      if (fields.detector_score != null && fields.detector_score !== '') {
        detectorScore = Number(fields.detector_score);
        if (!Number.isFinite(detectorScore)
            || detectorScore < 0 || detectorScore > 1) {
          fail(new Error('invalid detector_score'));
          return;
        }
      }
      if (fields.fired_at != null && fields.fired_at !== ''
          && !noControls(fields.fired_at, 64)) {
        fail(new Error('invalid fired_at'));
        return;
      }

      succeed({
        file,
        sessionId: fields.session_id,
        wakeWords: JSON.stringify(wakeWords),
        detectorScore,
        firedAt: fields.fired_at || '',
      });
    });

    req.pipe(bb);
  });
}

function buildInternalMultipart(deviceId, parsed) {
  const boundary = `----oevoicegate${randomBytes(24).toString('hex')}`;
  const chunks = [];
  const addField = (name, value) => {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      + `${value}\r\n`,
      'utf8',
    ));
  };

  addField('session_id', parsed.sessionId);
  addField('device_id', deviceId);
  addField('wake_words', parsed.wakeWords);
  if (parsed.detectorScore != null) {
    addField('detector_score', String(parsed.detectorScore));
  }
  if (parsed.firedAt) addField('fired_at', parsed.firedAt);
  chunks.push(Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Disposition: form-data; name="file"; filename="wake.wav"\r\n'
    + 'Content-Type: audio/wav\r\n\r\n',
    'utf8',
  ));
  chunks.push(parsed.file);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function takeDeviceRate(deviceId) {
  const now = Date.now();
  let entry = deviceRate.get(deviceId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    deviceRate.set(deviceId, entry);
  }
  entry.count += 1;
  return entry.count <= MAX_DEVICE_REQUESTS_PER_MINUTE
    ? null
    : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

function sanitizeGateResponse(value, deviceId, sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.device_id !== deviceId || value.session_id !== sessionId) return null;
  if (value.verdict !== 'accept' && value.verdict !== 'reject') return null;
  if (value.effective !== 'accept' && value.effective !== 'reject') return null;
  if (value.mode !== 'shadow' && value.mode !== 'enforce') return null;
  const expectedEffective = value.mode === 'shadow' ? 'accept' : value.verdict;
  if (value.effective !== expectedEffective) return null;
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter(v => typeof v === 'string').slice(0, 16)
    : [];
  return {
    device_id: deviceId,
    session_id: sessionId,
    verdict: value.verdict,
    effective: value.effective,
    matched_variant: typeof value.matched_variant === 'string'
      ? value.matched_variant.slice(0, 128)
      : null,
    match_method: typeof value.match_method === 'string'
      ? value.match_method.slice(0, 32)
      : null,
    mode: value.mode,
    latency_ms: Number.isFinite(value.latency_ms) ? value.latency_ms : null,
    reasons,
  };
}

async function callInternalGate(config, deviceId, parsed) {
  const proxy = gateProxyConfig(config);
  if (!proxy) return { status: 503, body: { error: 'Wake verification unavailable' } };
  const multipart = buildInternalMultipart(deviceId, parsed);

  let response;
  try {
    response = await fetch(proxy.url, {
      method: 'POST',
      headers: {
        'Content-Type': multipart.contentType,
        'Content-Length': String(multipart.body.length),
        'X-OE-Gate-Secret': proxy.secret,
        'X-OE-Device-ID': deviceId,
      },
      body: multipart.body,
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { status: 503, body: { error: 'Wake verification unavailable' } };
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return { status: 502, body: { error: 'Invalid verifier response' } };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status === 429 ? 429 : 503;
    return { status, body: { error: 'Wake verification unavailable' } };
  }
  if (!/^application\/json(?:;|$)/i.test(
    response.headers.get('content-type') || '',
  )) {
    await response.body?.cancel().catch(() => {});
    return { status: 502, body: { error: 'Invalid verifier response' } };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { status: 502, body: { error: 'Invalid verifier response' } };
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { status: 502, body: { error: 'Invalid verifier response' } };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { status: 502, body: { error: 'Invalid verifier response' } };
  }
  const bytes = Buffer.concat(chunks, total);
  let decoded;
  try {
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { status: 502, body: { error: 'Invalid verifier response' } };
  }
  const clean = sanitizeGateResponse(decoded, deviceId, parsed.sessionId);
  return clean
    ? { status: 200, body: clean }
    : { status: 502, body: { error: 'Invalid verifier response' } };
}

async function runBounded(config, deviceId, parsed) {
  const key = `${deviceId}\0${parsed.sessionId}`;
  const duplicate = activeByKey.get(key);
  if (duplicate) return duplicate;
  if (activeDevice.has(deviceId)) {
    return { status: 429, body: { error: 'Device verification already active' } };
  }
  if (activeUpstream >= MAX_ACTIVE_UPSTREAM) {
    return { status: 503, body: { error: 'Wake verifier busy' } };
  }

  activeUpstream += 1;
  activeDevice.set(deviceId, key);
  const promise = callInternalGate(config, deviceId, parsed);
  activeByKey.set(key, promise);
  try {
    return await promise;
  } finally {
    activeByKey.delete(key);
    if (activeDevice.get(deviceId) === key) activeDevice.delete(deviceId);
    activeUpstream -= 1;
  }
}

export async function handle(req, res) {
  const path = String(req.url || '').split('?', 1)[0];
  if (path !== VOICE_GATE_PATH) return false;
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }
  if (!isDirectPrivateLanRequest(req)) {
    return json(res, 403, { error: 'Direct private-LAN connection required' });
  }

  // This device endpoint accepts only its explicit bearer header. Browser
  // cookies must neither authorize it nor shadow a valid device bearer.
  const meta = getSessionMeta(getVoiceDeviceBearer(req));
  if (!meta) return json(res, 401, { error: 'Unauthorized' });
  if (meta.kind !== 'voice-device' || !meta.deviceId
      || !getDevice(meta.userId, meta.deviceId)) {
    return json(res, 403, { error: 'Voice-device session required' });
  }

  const config = loadConfig();
  if (!voiceGateConfigured(config)) {
    return json(res, 503, { error: 'Wake verification unavailable' });
  }
  if (!gateProxyConfig(config)) {
    return json(res, 503, { error: 'Wake verification unavailable' });
  }

  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    return json(res, 415, { error: 'Expected multipart/form-data' });
  }
  if (req.headers['transfer-encoding']) {
    return json(res, 411, { error: 'Content-Length required' });
  }
  const rawLength = String(req.headers['content-length'] || '');
  if (!/^[1-9]\d*$/.test(rawLength)) {
    return json(res, 411, { error: 'Content-Length required' });
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_REQUEST_BYTES) {
    return json(res, 413, { error: 'Request body too large' });
  }

  const retryAfter = takeDeviceRate(meta.deviceId);
  if (retryAfter) {
    return json(res, 429, { error: 'Too many wake verifications' }, {
      'Retry-After': String(retryAfter),
    });
  }

  if (activeIngress >= MAX_ACTIVE_INGRESS) {
    return json(res, 503, { error: 'Wake verifier busy' }, {
      'Retry-After': '1',
    });
  }
  const deviceIngress = ingressByDevice.get(meta.deviceId) || 0;
  if (deviceIngress >= MAX_DEVICE_INGRESS) {
    return json(res, 429, { error: 'Device verification already active' }, {
      'Retry-After': '1',
    });
  }

  activeIngress += 1;
  ingressByDevice.set(meta.deviceId, deviceIngress + 1);
  try {
    let parsed;
    try {
      parsed = await parseVerifyMultipart(req);
    } catch (error) {
      const message = error?.message || '';
      const tooLarge = /too (?:large|many)/i.test(message);
      const incomplete = /(?:timeout|aborted|closed)/i.test(message);
      return json(
        res,
        tooLarge ? 413 : incomplete ? 408 : 400,
        { error: 'Invalid verification request' },
        incomplete ? { Connection: 'close' } : {},
      );
    }

    const result = await runBounded(config, meta.deviceId, parsed);
    return json(res, result.status, result.body);
  } finally {
    activeIngress -= 1;
    const remaining = (ingressByDevice.get(meta.deviceId) || 1) - 1;
    if (remaining > 0) ingressByDevice.set(meta.deviceId, remaining);
    else ingressByDevice.delete(meta.deviceId);
  }
}

export function resetVoiceGateStateForTests() {
  activeByKey.clear();
  activeDevice.clear();
  ingressByDevice.clear();
  deviceRate.clear();
  activeUpstream = 0;
  activeIngress = 0;
}
