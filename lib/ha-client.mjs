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

export function haRequest(haCfg, path, method = 'GET', body = null, _hop = 0) {
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
      timeout: 15_000,
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
        return resolve(haRequest({ ...haCfg, url: nextBase }, nextPath, method, body, _hop + 1));
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
