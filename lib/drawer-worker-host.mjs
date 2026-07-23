// @ts-check
/**
 * Child-process host for one custom drawer server module.
 *
 * The parent process owns authentication, route-prefix checks, request caps,
 * timeouts, and the real ServerResponse. This process imports user-authored
 * server.mjs and exposes only a small request/response-shaped IPC protocol.
 */

import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const RESPONSE_MAX_BYTES = Number(process.env.OE_DRAWER_RESPONSE_MAX_BYTES) || (4 * 1024 * 1024);
const serverPath = process.argv[2];
const validateOnly = process.argv[3] === 'validate';
const sendToParent = typeof process.send === 'function' ? process.send.bind(process) : null;
// Do not let an imported module forge `ready` / `response` protocol frames.
// The host retains a private bound sender for its own messages.
try {
  Object.defineProperty(process, 'send', {
    value: undefined,
    configurable: false,
    enumerable: false,
    writable: false,
  });
} catch {
  try { process.send = undefined; } catch {}
}

// A normal update/delete is terminated explicitly by the parent. If the OE
// process itself dies abruptly, the IPC channel closes; kill this detached
// process group so top-level timers or spawned grandchildren cannot outlive it.
process.once('disconnect', () => {
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  }
  process.exit(0);
});

function safeMessage(error) {
  return String(error?.message || error || 'Unknown drawer worker error').slice(0, 2000);
}

function send(message) {
  if (!sendToParent || !process.connected) return false;
  try {
    sendToParent(message);
    return true;
  } catch {
    return false;
  }
}

function normalizeHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (Array.isArray(value)) {
      out[name.toLowerCase()] = value.map(v => String(v).slice(0, 8192)).slice(0, 20);
    } else if (value !== undefined && value !== null) {
      out[name.toLowerCase()] = String(value).slice(0, 8192);
    }
  }
  return out;
}

class CapturedResponse {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this._headers = new Map();
    this._chunks = [];
    this._bytes = 0;
  }

  setHeader(name, value) {
    if (this.headersSent) throw new Error('Headers already sent');
    this._headers.set(String(name).toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    return this._headers.get(String(name).toLowerCase());
  }

  getHeaders() {
    return Object.fromEntries(this._headers);
  }

  removeHeader(name) {
    if (!this.headersSent) this._headers.delete(String(name).toLowerCase());
  }

  writeHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    const status = Number(statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error(`Invalid response status: ${statusCode}`);
    }
    this.statusCode = status;
    const headers = (
      statusMessageOrHeaders && typeof statusMessageOrHeaders === 'object'
        ? statusMessageOrHeaders
        : maybeHeaders
    );
    if (headers && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.headersSent = true;
    return this;
  }

  write(chunk, encoding) {
    if (this.writableEnded) throw new Error('Response already ended');
    if (!this.headersSent) this.headersSent = true;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), encoding);
    this._bytes += buf.length;
    if (this._bytes > this.maxBytes) {
      const error = /** @type {Error & {code?: string}} */ (
        new Error(`Drawer response exceeds ${this.maxBytes} bytes`)
      );
      error.code = 'DRAWER_RESPONSE_TOO_LARGE';
      throw error;
    }
    if (buf.length) this._chunks.push(buf);
    return true;
  }

  end(chunk, encoding) {
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    else if (!this.headersSent) this.headersSent = true;
    this.writableEnded = true;
    return this;
  }

  toWire() {
    return {
      statusCode: this.statusCode,
      headers: normalizeHeaders(Object.fromEntries(this._headers)),
      body: Buffer.concat(this._chunks).toString('base64'),
    };
  }
}

function requestFromWire(wire) {
  const body = wire?.body ? Buffer.from(String(wire.body), 'base64') : Buffer.alloc(0);
  const req = /** @type {any} */ (Readable.from(body.length ? [body] : []));
  req.method = typeof wire?.method === 'string' ? wire.method : 'GET';
  req.url = typeof wire?.url === 'string' ? wire.url : '/';
  req.headers = normalizeHeaders(wire?.headers);
  req.httpVersion = '1.1';
  req.complete = true;
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  return req;
}

async function refreshPersistedSessions() {
  // Compatibility for legacy custom handlers that call requireAuth(req, res).
  // The parent already authenticated and owner-scoped the request; refreshing
  // here only lets that redundant check recognize recently-created sessions.
  try {
    const { loadPersistedSessions } = await import('../routes/_helpers/auth-sessions.mjs');
    loadPersistedSessions();
  } catch {
    // A modern handler uses cfg.userId and needs no app-internal auth import.
  }
}

async function main() {
  if (!serverPath) {
    send({ type: 'init-error', error: 'Drawer server path is required' });
    process.exitCode = 1;
    return;
  }

  let mod;
  try {
    const url = `${pathToFileURL(serverPath).href}?drawer_worker=${process.pid}_${Date.now()}`;
    mod = await import(url);
  } catch (error) {
    send({ type: 'init-error', error: `Drawer server failed to load: ${safeMessage(error)}` });
    process.exitCode = 1;
    return;
  }

  if (typeof mod?.handleRequest !== 'function') {
    send({ type: 'init-error', error: 'Drawer server must export a function named handleRequest' });
    process.exitCode = 1;
    return;
  }

  if (!send({ type: 'ready' })) {
    process.exitCode = 1;
    return;
  }
  if (validateOnly) return;

  process.on('message', async rawMessage => {
    const message = /** @type {any} */ (rawMessage);
    if (!message || typeof message !== 'object' || message.type !== 'request') return;
    const id = String(message.id || '');
    if (!id) return;

    try {
      await refreshPersistedSessions();
      const req = requestFromWire(message.request);
      const res = new CapturedResponse(RESPONSE_MAX_BYTES);
      const handled = await mod.handleRequest(req, res, message.cfg || {});
      if (handled !== true && handled !== false) {
        throw new Error('handleRequest must return true or false');
      }
      send({
        type: 'response',
        id,
        ok: true,
        handled,
        ...(handled ? { response: res.toWire() } : {}),
      });
    } catch (error) {
      send({
        type: 'response',
        id,
        ok: false,
        code: error?.code || 'DRAWER_HANDLER_ERROR',
        error: safeMessage(error),
      });
    }
  });
}

main().catch(error => {
  send({ type: 'init-error', error: safeMessage(error) });
  process.exitCode = 1;
});
