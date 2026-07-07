/**
 * Shared Home Assistant HTTP client.
 *
 * Used by:
 *   - skills/role_home_assistant/execute.mjs (LLM-driven HA calls via Helen)
 *   - lib/ha-cache.mjs (background entity-name index)
 *   - chat-dispatch.mjs HA fast-path (pre-LLM "turn on X" intent execution)
 *   - routes/home-assistant.mjs (admin Test Connection)
 *
 * Uses node:http/https directly so we can honor `allowSelfSigned`
 * (Node's built-in fetch / undici doesn't surface a clean way to skip TLS
 * verification without pulling in the undici package). Follows one redirect
 * hop so reverse-proxy setups that 301 http→https work transparently.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { loadConfig } from '../routes/_helpers.mjs';

export function getHaConfig() {
  const cfg = loadConfig();
  const ha = cfg?.homeAssistant;
  if (!ha || typeof ha !== 'object') return null;
  const url = String(ha.url || '').trim().replace(/\/+$/, '');
  const token = String(ha.token || '').trim();
  if (!url || !token) return null;
  return { url, token, allowSelfSigned: !!ha.allowSelfSigned };
}

// timeoutMs: socket timeout (default 15s, tuned for background/tool calls).
// Callers on a tighter budget (e.g. lib/tv-dashboard.mjs's screensaver
// payload) can pass a shorter value so the underlying request is actually
// destroyed (req.destroy() below, via the 'timeout' listener) instead of
// being raced-and-abandoned by the caller while it keeps running in the
// background for up to the default 15s.
export function haRequest(haCfg, path, method = 'GET', body = null, { timeoutMs = 15_000 } = {}, _hop = 0) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(`${haCfg.url}/api${path}`); }
    catch { return resolve({ __err: `Invalid HA URL: ${haCfg.url}` }); }
    const isHttps = target.protocol === 'https:';
    const opts = {
      method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        Authorization: `Bearer ${haCfg.token}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    };
    if (isHttps && haCfg.allowSelfSigned) opts.rejectUnauthorized = false;
    const lib = isHttps ? https : http;
    const req = lib.request(opts, (res) => {
      // Follow one redirect hop (most often http→https from a reverse proxy).
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && _hop < 1) {
        res.resume();
        let redirected;
        try { redirected = new URL(res.headers.location, `${target.protocol}//${target.host}`); }
        catch { return resolve({ __err: `Bad redirect Location header: ${res.headers.location}` }); }
        const nextBase = `${redirected.protocol}//${redirected.host}`;
        const nextPath = redirected.pathname.replace(/^\/api/, '') + redirected.search;
        return resolve(haRequest({ ...haCfg, url: nextBase }, nextPath, method, body, { timeoutMs }, _hop + 1));
      }
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return resolve({ __err: `${res.statusCode} ${res.statusMessage || ''}`.trim() });
        if (!chunks) return resolve(null);
        try { resolve(JSON.parse(chunks)); }
        catch { resolve(chunks); }
      });
    });
    req.on('error', (e) => resolve({ __err: `Connection failed: ${e.message}` }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Binary variant of haRequest() for endpoints that return raw bytes rather
 * than JSON — currently just `/camera_proxy/<entity_id>` (routes/tv.mjs's
 * Android TV camera-snapshot proxy). haRequest() decodes the response as
 * utf8 text, which would corrupt image bytes, so this keeps the body as a
 * Buffer instead. Same auth header / redirect-follow / self-signed-TLS
 * handling as haRequest(); default timeout is shorter (10s) since callers
 * are synchronous HTTP proxies, not background jobs.
 *
 * @returns {Promise<{statusCode:number, contentType:string, body:Buffer}|{__err:string}>}
 */
export function haRequestBinary(haCfg, path, { timeoutMs = 10_000 } = {}, _hop = 0) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(`${haCfg.url}/api${path}`); }
    catch { return resolve({ __err: `Invalid HA URL: ${haCfg.url}` }); }
    const isHttps = target.protocol === 'https:';
    const opts = {
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: { Authorization: `Bearer ${haCfg.token}` },
      timeout: timeoutMs,
    };
    if (isHttps && haCfg.allowSelfSigned) opts.rejectUnauthorized = false;
    const lib = isHttps ? https : http;
    const req = lib.request(opts, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && _hop < 1) {
        res.resume();
        let redirected;
        try { redirected = new URL(res.headers.location, `${target.protocol}//${target.host}`); }
        catch { return resolve({ __err: `Bad redirect Location header: ${res.headers.location}` }); }
        const nextBase = `${redirected.protocol}//${redirected.host}`;
        const nextPath = redirected.pathname.replace(/^\/api/, '') + redirected.search;
        return resolve(haRequestBinary({ ...haCfg, url: nextBase }, nextPath, { timeoutMs }, _hop + 1));
      }
      // >= 300, not 400: any redirect the branch above didn't follow — a 303,
      // a missing Location header, or a second hop — must be an error, never
      // a 200 whose "image" bytes are the redirect's HTML body.
      if (res.statusCode >= 300) {
        res.resume();
        return resolve({ __err: `${res.statusCode} ${res.statusMessage || ''}`.trim() });
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        contentType: res.headers['content-type'] || 'application/octet-stream',
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', (e) => resolve({ __err: `Connection failed: ${e.message}` }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}
