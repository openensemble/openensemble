import fs from 'node:fs';
import path from 'node:path';
import http2 from 'node:http2';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { USERS_DIR } from './paths.mjs';
import { getUserKey, aesGcmEncrypt, aesGcmDecrypt } from './crypto.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { getSessionUserId } from '../routes/_helpers/auth-sessions.mjs';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const tokenHash = value => createHash('sha256').update(value).digest('hex');
let cachedJWT = null;
const recentEvents = new Map();

function settings() {
  return {
    team: process.env.OE_APNS_TEAM_ID || '', keyId: process.env.OE_APNS_KEY_ID || '',
    bundle: process.env.OE_APNS_BUNDLE_ID || '', keyPath: process.env.OE_APNS_PRIVATE_KEY_PATH || '',
  };
}

export function mobilePushStatus() {
  const cfg = settings();
  const configured = Object.values(cfg).every(Boolean) && fs.existsSync(cfg.keyPath);
  return { configured, reason: configured ? null : 'OE server push notifications are not configured.' };
}

function storePath(userId) {
  if (!identifier.test(userId)) throw new Error('Invalid user');
  return path.join(USERS_DIR, userId, 'mobile-devices.json');
}

export function readMobileDevices(userId) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(userId), 'utf8'));
    if (!Array.isArray(data)) throw new Error('Invalid mobile device store');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function saveDevices(userId, devices) {
  atomicWriteSync(storePath(userId), JSON.stringify(devices, null, 2), { mode: 0o600 });
}

export function registerMobileDevice(userId, sessionToken, body) {
  if (!body || body.platform !== 'ios' || !/^[a-fA-F0-9]{64,512}$/.test(body.apnsToken || '')
      || !/^[A-Za-z0-9_-]{16,100}$/.test(body.installationId || '')
      || !['development', 'production'].includes(body.environment)) {
    throw new Error('Invalid iOS device registration');
  }
  const cfg = settings();
  if (body.bundleId !== cfg.bundle) throw new Error('The app bundle does not match OE push configuration');
  const apnsToken = body.apnsToken.toLowerCase();
  const hash = tokenHash(apnsToken);
  const current = readMobileDevices(userId);
  const sessionHash = tokenHash(sessionToken);
  const prior = current.find(d => d.installationId === body.installationId && d.tokenHash === hash
    && d.sessionHash === sessionHash && d.environment === body.environment);
  const existing = current.filter(d => d.installationId !== body.installationId && d.tokenHash !== hash);
  if (existing.length >= 10) throw new Error('Too many registered phones for this account');
  // A token belongs to one active account. Switching profiles removes its old
  // registration, including when an earlier logout happened while offline.
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === userId || !identifier.test(entry.name)) continue;
    const devices = readMobileDevices(entry.name);
    const kept = devices.filter(d => d.tokenHash !== hash || d.environment !== body.environment);
    if (kept.length !== devices.length) saveDevices(entry.name, kept);
  }
  const device = {
    id: prior?.id || randomUUID(), installationId: body.installationId, tokenHash: hash, sessionHash,
    environment: body.environment, bundleId: cfg.bundle,
    deviceName: String(body.deviceName || 'iPhone').slice(0, 100),
    updatedAt: Date.now(),
    secrets: aesGcmEncrypt(getUserKey(userId), JSON.stringify({ apnsToken, sessionToken })),
  };
  saveDevices(userId, [...existing, device]);
  return { deviceId: device.id, userId };
}

export function unregisterMobileDevice(userId, deviceId) {
  const devices = readMobileDevices(userId);
  const kept = devices.filter(d => d.id !== deviceId);
  if (kept.length !== devices.length) saveDevices(userId, kept);
}

function authorization(cfg) {
  const fingerprint = JSON.stringify(cfg) + fs.statSync(cfg.keyPath).mtimeMs;
  if (cachedJWT?.fingerprint === fingerprint && Date.now() - cachedJWT.created < 45 * 60_000) return cachedJWT.value;
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encoded({ alg: 'ES256', kid: cfg.keyId })}.${encoded({ iss: cfg.team, iat: Math.floor(Date.now() / 1000) })}`;
  const key = createPrivateKey(fs.readFileSync(cfg.keyPath));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs requires an EC P-256 signing key');
  }
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  cachedJWT = { fingerprint, created: Date.now(), value: `${unsigned}.${signature}` };
  return cachedJWT.value;
}

export async function sendAPNs(device, apnsToken, payload) {
  const cfg = settings();
  if (!mobilePushStatus().configured) throw new Error('Push is not configured');
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 4096) throw new Error('Push payload is too large');
  const auth = authorization(cfg);
  const origin = device.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    let request, settled = false, status = 0, response = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.close();
      client.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('APNs request timed out')), 10_000);
    client.on('error', error => finish(error));
    client.on('close', () => { if (!settled) finish(new Error('APNs connection closed')); });
    client.on('connect', () => {
      if (settled) return;
      try {
      request = client.request({
        ':method': 'POST', ':path': `/3/device/${apnsToken}`,
        authorization: `bearer ${auth}`, 'apns-topic': cfg.bundle,
        'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'content-type': 'application/json',
      });
      request.on('response', headers => { status = Number(headers[':status']); });
      request.on('data', chunk => { if (response.length < 8192) response += chunk.toString(); });
      request.on('error', error => finish(error));
      request.on('end', () => {
        let reason = null;
        try { reason = JSON.parse(response).reason || null; } catch {}
        finish(null, { ok: status === 200, status, reason });
      });
      request.end(body);
      } catch (error) { finish(error); }
    });
  });
}

export function notificationForEvent(userId, event) {
  if (!event || !['done', 'assistant_notification'].includes(event.type) || event.silent || event.aborted) return null;
  const eventId = event.attempt_id || event.turn_id || event.notification_id;
  if (typeof eventId !== 'string' || !eventId || !event.agent) return null;
  const agentId = String(event.agent).replace(new RegExp(`^${userId}_`), '');
  if (!identifier.test(agentId)) return null;
  const target = { userId, agentId };
  for (const key of ['projectId', 'chatId']) {
    if (event[key] && identifier.test(event[key])) target[key] = event[key];
  }
  return {
    eventKey: JSON.stringify([userId, target.projectId, target.chatId, agentId, eventId]),
    payload: {
      aps: { alert: { title: 'OpenEnsemble', body: event.type === 'done' ? 'Your reply is ready.' : 'Your agent has an update.' }, sound: 'default' },
      action: 'conversation', ...target,
    },
  };
}

export async function deliverMobilePush(userId, payload, { deviceId = null, send = sendAPNs } = {}) {
  const results = [];
  for (const device of readMobileDevices(userId)) {
    if (deviceId && device.id !== deviceId) continue;
    let secrets;
    try { secrets = JSON.parse(aesGcmDecrypt(getUserKey(userId), device.secrets)); }
    catch { unregisterMobileDevice(userId, device.id); continue; }
    if (getSessionUserId(secrets.sessionToken) !== userId) {
      unregisterMobileDevice(userId, device.id);
      continue;
    }
    if (device.bundleId !== settings().bundle) continue;
    try {
      const result = await send(device, secrets.apnsToken, { ...payload, deviceId: device.id });
      if ([410].includes(result.status) || ['BadDeviceToken', 'Unregistered'].includes(result.reason)) {
        unregisterMobileDevice(userId, device.id);
      }
      results.push({ deviceId: device.id, ...result });
    } catch { results.push({ deviceId: device.id, ok: false, reason: 'Push delivery failed' }); }
  }
  return results;
}

export function notifyMobileEvent(userId, event) {
  if (!mobilePushStatus().configured) return;
  const notification = notificationForEvent(userId, event);
  if (!notification) return;
  const now = Date.now();
  for (const [key, ts] of recentEvents) if (now - ts > 600_000) recentEvents.delete(key);
  if (recentEvents.has(notification.eventKey)) return;
  if (recentEvents.size >= 2000) recentEvents.delete(recentEvents.keys().next().value);
  recentEvents.set(notification.eventKey, now);
  // Push failures must not delay or fail the user's actual chat reply.
  deliverMobilePush(userId, notification.payload).catch(() => console.warn('[mobile-push] Delivery could not complete'));
}
