// @ts-check
/**
 * Parent-side lifecycle and IPC boundary for custom drawer server modules.
 *
 * Custom server.mjs files are imported only by drawer-worker-host.mjs. Built-in
 * drawer plugins continue to use the in-process loader in plugins.mjs.
 */

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_PATH = path.join(__dirname, 'drawer-worker-host.mjs');

export const DRAWER_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const DRAWER_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const DRAWER_WORKER_START_TIMEOUT_MS = 5_000;
export const DRAWER_REQUEST_TIMEOUT_MS = 20_000;
export const DRAWER_WORKER_MAX_OLD_SPACE_MB = 192;

const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'if-modified-since',
  'if-none-match',
  'origin',
  'range',
  'referer',
  'user-agent',
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function safeErrorText(error) {
  return String(error?.message || error || 'Unknown drawer worker error').slice(0, 2000);
}

/** @returns {Error & {code:string, detail?:any}} */
function workerError(message, code, detail = null) {
  const error = /** @type {Error & {code:string, detail?:any}} */ (new Error(message));
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

function killProcessGroup(child) {
  if (!child) return;
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The child may already have exited or may not own a process group.
    }
  }
  try { child.kill('SIGKILL'); } catch {}
}

function childEnvironment() {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    NODE_ENV: process.env.NODE_ENV || 'production',
    OE_DRAWER_RESPONSE_MAX_BYTES: String(DRAWER_RESPONSE_MAX_BYTES),
    OPENENSEMBLE_ROOT: process.env.OPENENSEMBLE_ROOT || path.resolve(__dirname, '..'),
  };
  return env;
}

class DrawerWorker {
  constructor(pluginId, serverPath, {
    startTimeoutMs = DRAWER_WORKER_START_TIMEOUT_MS,
    requestTimeoutMs = DRAWER_REQUEST_TIMEOUT_MS,
    validateOnly = false,
  } = {}) {
    this.pluginId = pluginId;
    this.serverPath = serverPath;
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.validateOnly = validateOnly;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stopped = false;
    this.stderr = '';
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) {
      return Promise.reject(workerError('Drawer worker has been stopped', 'DRAWER_WORKER_STOPPED'));
    }

    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const child = fork(
        HOST_PATH,
        [this.serverPath, this.validateOnly ? 'validate' : 'serve'],
        {
          cwd: path.dirname(this.serverPath),
          detached: process.platform !== 'win32',
          env: childEnvironment(),
          // Never inherit `--input-type`, test-runner loaders, or inspector
          // flags from OE's parent invocation. The worker always executes a
          // real .mjs entry file and needs an independent Node runtime.
          execArgv: [`--max-old-space-size=${DRAWER_WORKER_MAX_OLD_SPACE_MB}`],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          serialization: 'json',
        },
      );
      this.child = child;

      const finishStart = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        fn(value);
      };
      const failStart = (message, code = 'DRAWER_WORKER_START_FAILED') => {
        const suffix = this.stderr ? ` (${this.stderr.slice(-500)})` : '';
        finishStart(reject, workerError(`${message}${suffix}`, code));
        this.stop();
      };

      const startTimer = setTimeout(() => {
        failStart(
          `Drawer worker did not become ready within ${this.startTimeoutMs}ms`,
          'DRAWER_WORKER_START_TIMEOUT',
        );
      }, this.startTimeoutMs);
      startTimer.unref?.();

      child.stderr?.on('data', chunk => {
        this.stderr = (this.stderr + String(chunk || '')).slice(-16_384);
      });
      child.on('message', rawMessage => {
        const message = /** @type {any} */ (rawMessage);
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready') {
          finishStart(resolve, undefined);
          return;
        }
        if (message.type === 'init-error') {
          failStart(
            safeErrorText(message.error || 'Drawer server failed to initialize'),
            'DRAWER_WORKER_INIT_ERROR',
          );
          return;
        }
        if (message.type === 'response') this._handleResponse(message);
      });
      child.on('error', error => {
        if (!settled) failStart(safeErrorText(error));
        else this._failPending(workerError(safeErrorText(error), 'DRAWER_WORKER_CRASH'));
      });
      child.on('exit', (code, signal) => {
        const detail = `exit=${code ?? 'null'} signal=${signal ?? 'none'}`;
        const error = workerError(`Drawer worker exited unexpectedly (${detail})`, 'DRAWER_WORKER_CRASH');
        if (!settled) failStart(error.message, error.code);
        // The module may have spawned descendants before exiting itself.
        // Kill by the original process-group id even when the leader is gone.
        killProcessGroup(child);
        this.stopped = true;
        this._failPending(error);
        this.child = null;
      });
    });
    return this.startPromise;
  }

  async request(request, cfg, { timeoutMs = this.requestTimeoutMs } = {}) {
    await this.start();
    if (this.validateOnly) {
      throw workerError('Validation workers do not handle requests', 'DRAWER_WORKER_VALIDATE_ONLY');
    }
    const child = this.child;
    if (!child?.connected || this.stopped) {
      throw workerError('Drawer worker is not connected', 'DRAWER_WORKER_CRASH');
    }

    const id = `${process.pid}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = workerError(
          `Drawer request timed out after ${timeoutMs}ms`,
          'DRAWER_REQUEST_TIMEOUT',
        );
        reject(error);
        this.stop(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });

      try {
        child.send({ type: 'request', id, request, cfg }, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(workerError(safeErrorText(error), 'DRAWER_WORKER_IPC_ERROR'));
          this.stop(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(workerError(safeErrorText(error), 'DRAWER_WORKER_IPC_ERROR'));
        this.stop(error);
      }
    });
  }

  _handleResponse(message) {
    const id = String(message.id || '');
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (!message.ok) {
      const error = workerError(
        safeErrorText(message.error || 'Custom drawer handler failed'),
        String(message.code || 'DRAWER_HANDLER_ERROR'),
      );
      pending.reject(error);
      this.stop(error);
      return;
    }
    pending.resolve(message);
  }

  _failPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  stop(reason = null) {
    if (this.stopped) return;
    this.stopped = true;
    const error = reason instanceof Error
      ? reason
      : workerError('Drawer worker stopped', 'DRAWER_WORKER_STOPPED');
    this._failPending(error);
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.removeAllListeners('message'); } catch {}
      killProcessGroup(child);
    }
  }
}

const workers = new Map();
const workerEpochs = new Map();

function workerEpoch(pluginId) {
  return workerEpochs.get(String(pluginId || '')) ?? 0;
}

function validPathSegment(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
}

function addPrefix(out, value) {
  if (typeof value !== 'string') return;
  let prefix = value.trim();
  if (!prefix.startsWith('/api/') || prefix.includes('\\') || prefix.includes('..')
      || prefix.includes('?') || prefix.includes('#') || prefix.length > 240) {
    return;
  }
  prefix = prefix.replace(/\/+$/, '') + '/';
  if (/^\/api\/[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*\/$/.test(prefix)) out.add(prefix);
}

/**
 * Route namespaces a custom drawer is allowed to receive. Explicit prefixes
 * augment, but cannot escape, the drawer/skill-derived namespace set.
 */
export function deriveDrawerApiPrefixes(manifest) {
  const out = new Set();
  const skillId = validPathSegment(manifest?.skillId) ? manifest.skillId : null;
  const pluginId = validPathSegment(manifest?.id) ? manifest.id : null;
  if (skillId) {
    const underscore = skillId.replaceAll('-', '_');
    addPrefix(out, `/api/usr_${skillId}/`);
    if (underscore !== skillId) {
      addPrefix(out, `/api/usr_${underscore}/`);
    }
  }
  if (pluginId) addPrefix(out, `/api/${pluginId}/`);

  const derivedRoots = [...out].map(prefix => prefix.slice(0, -1));
  for (const explicit of Array.isArray(manifest?.apiPrefixes) ? manifest.apiPrefixes : []) {
    const before = out.size;
    addPrefix(out, explicit);
    if (out.size === before) continue;
    const added = [...out].at(-1);
    if (!derivedRoots.some(root => added === `${root}/` || added.startsWith(`${root}/`))) {
      out.delete(added);
    }
  }
  return [...out];
}

export function drawerRequestMatches(manifest, reqUrl) {
  let pathname;
  try { pathname = new URL(String(reqUrl || ''), 'http://drawer.local').pathname; }
  catch { return false; }
  return deriveDrawerApiPrefixes(manifest).some(prefix =>
    pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function requestHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(name)) continue;
    if (Array.isArray(value)) out[name] = value.map(v => String(v).slice(0, 8192)).slice(0, 20);
    else if (value !== undefined && value !== null) out[name] = String(value).slice(0, 8192);
  }
  return out;
}

async function readRequestBody(req, maxBytes = DRAWER_REQUEST_MAX_BYTES) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return Buffer.alloc(0);
  const declared = Number(req?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw workerError(`Drawer request body exceeds ${maxBytes} bytes`, 'DRAWER_REQUEST_TOO_LARGE');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw workerError(`Drawer request body exceeds ${maxBytes} bytes`, 'DRAWER_REQUEST_TOO_LARGE');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

function scopedConfig(manifest, cfg, apiPrefixes) {
  return {
    userId: cfg?.userId ?? null,
    pluginId: manifest.id,
    drawerId: manifest.id,
    skillId: manifest.skillId ?? null,
    apiPrefixes,
    settings: manifest.defaultSettings && typeof manifest.defaultSettings === 'object'
      ? manifest.defaultSettings
      : {},
  };
}

function workerFor(manifest, serverPath, expectedEpoch) {
  const id = String(manifest.id);
  if (workerEpoch(id) !== expectedEpoch) {
    throw workerError('Drawer changed while the request was being prepared', 'DRAWER_WORKER_STALE');
  }
  const current = workers.get(id);
  if (current && !current.stopped && current.serverPath === serverPath) return current;
  if (current) current.stop();
  const worker = new DrawerWorker(id, serverPath);
  workers.set(id, worker);
  return worker;
}

function responseHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.has(name)) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (++count > 80) break;
    if (Array.isArray(value)) out[name] = value.map(v => String(v).slice(0, 8192)).slice(0, 20);
    else if (value !== undefined && value !== null) out[name] = String(value).slice(0, 8192);
  }
  return out;
}

function sendFailure(res, error) {
  const status = error?.code === 'DRAWER_REQUEST_TOO_LARGE'
    ? 413
    : error?.code === 'DRAWER_REQUEST_TIMEOUT'
      ? 504
      : 502;
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    error: status === 413 ? 'Drawer request body too large' : 'Custom drawer server failed',
  }));
}

/**
 * Dispatch one already-authenticated request to a persistent custom worker.
 * Returns false without reading the body when the URL is outside its prefixes.
 */
export async function dispatchCustomDrawerRequest(
  manifest,
  serverPath,
  req,
  res,
  cfg,
  { timeoutMs = DRAWER_REQUEST_TIMEOUT_MS } = {},
) {
  const apiPrefixes = deriveDrawerApiPrefixes(manifest);
  if (!apiPrefixes.length || !drawerRequestMatches(manifest, req?.url)) return false;
  if (!fs.existsSync(serverPath)) return false;
  const expectedEpoch = workerEpoch(manifest?.id);

  try {
    const body = await readRequestBody(req);
    const worker = workerFor(manifest, serverPath, expectedEpoch);
    const result = await worker.request({
      method: String(req?.method || 'GET').toUpperCase(),
      url: String(req?.url || '/'),
      headers: requestHeaders(req?.headers),
      body: body.toString('base64'),
    }, scopedConfig(manifest, cfg, apiPrefixes), { timeoutMs });

    if (!result.handled) return false;
    const wire = result.response || {};
    const status = Number(wire.statusCode);
    const statusCode = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200;
    const responseBody = wire.body ? Buffer.from(String(wire.body), 'base64') : Buffer.alloc(0);
    if (responseBody.length > DRAWER_RESPONSE_MAX_BYTES) {
      throw workerError('Drawer response exceeded the parent cap', 'DRAWER_RESPONSE_TOO_LARGE');
    }
    res.writeHead(statusCode, responseHeaders(wire.headers));
    res.end(responseBody);
    return true;
  } catch (error) {
    console.error(`[drawers] Custom worker error (${manifest?.id || 'unknown'}): ${safeErrorText(error)}`);
    stopDrawerWorker(manifest?.id);
    sendFailure(res, error);
    return true;
  }
}

export function stopDrawerWorker(pluginId) {
  const id = String(pluginId || '');
  workerEpochs.set(id, workerEpoch(id) + 1);
  const worker = workers.get(id);
  if (!worker) return false;
  workers.delete(id);
  worker.stop();
  return true;
}

export function stopAllDrawerWorkers() {
  const count = workers.size;
  for (const [id, worker] of workers) {
    workerEpochs.set(id, workerEpoch(id) + 1);
    worker.stop();
  }
  workers.clear();
  return count;
}

/**
 * Import a staged server module in a disposable child and validate its export.
 * Candidate errors are returned as data so skill-builder can preserve the live
 * drawer without a try/catch ladder.
 */
export async function validateDrawerServerModule(
  serverPath,
  { timeoutMs = DRAWER_WORKER_START_TIMEOUT_MS } = {},
) {
  const resolved = path.resolve(String(serverPath || ''));
  if (!fs.existsSync(resolved)) return { ok: false, error: 'Drawer server file not found' };
  const worker = new DrawerWorker(`validate-${process.pid}-${Date.now()}`, resolved, {
    startTimeoutMs: timeoutMs,
    validateOnly: true,
  });
  try {
    await worker.start();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeErrorText(error) };
  } finally {
    worker.stop();
  }
}
