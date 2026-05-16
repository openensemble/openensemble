/**
 * routes/home-assistant.mjs
 *
 * Household-level Home Assistant integration. One connection per OE install,
 * configured by an admin/owner in Settings → Providers. Every user who enables
 * the `role_home_assistant` role on an agent gets to use it — same model as
 * a shared smart-speaker hub.
 *
 * Storage: config.json.homeAssistant = { url, token, allowSelfSigned }
 *   - `token` is added to SECRET_PATHS in lib/config-secrets.mjs so it's
 *     encrypted at rest. loadConfig returns a decrypted view.
 *
 * Endpoints:
 *   GET  /api/home-assistant         — { url, allowSelfSigned, hasToken, configured }  (auth-required, no token leak)
 *   PUT  /api/home-assistant         — admin-only; save url/token/allowSelfSigned
 *   POST /api/home-assistant/test    — admin-only; probe HA /api/ with the saved (or supplied) creds
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  requireAuth, requirePrivileged, readBody,
  loadConfig, modifyConfig,
} from './_helpers.mjs';
import { invalidateCache as invalidateHaCache } from '../lib/ha-cache.mjs';

function probeHa({ url, token, allowSelfSigned }, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(`${String(url).replace(/\/+$/, '')}/api/`); }
    catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    const isHttps = target.protocol === 'https:';
    const opts = {
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
    };
    if (isHttps && allowSelfSigned) opts.rejectUnauthorized = false;
    const lib = isHttps ? https : http;
    const req = lib.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          // HA's /api/ returns {"message":"API running."}
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          return resolve({ ok: true, message: parsed?.message || 'Connected.' });
        }
        if (res.statusCode === 401) return resolve({ ok: false, error: 'Unauthorized — check the access token.' });
        if (res.statusCode === 404) return resolve({ ok: false, error: '404 — the URL points somewhere, but not at Home Assistant.' });
        resolve({ ok: false, error: `HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim() });
      });
    });
    req.on('error', (e) => {
      let hint = '';
      if (e.code === 'ECONNREFUSED') hint = ' (is HA reachable on that host/port?)';
      else if (e.code === 'ENOTFOUND') hint = ' (DNS lookup failed)';
      else if (e.code === 'CERT_HAS_EXPIRED' || e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
        hint = ' — enable "Allow self-signed certificate" if this is a local cert.';
      }
      resolve({ ok: false, error: `${e.message}${hint}` });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

export async function handle(req, res) {
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
  };

  if (req.url === '/api/home-assistant' && req.method === 'GET') {
    if (!requireAuth(req, res)) return true;
    const cfg = loadConfig();
    const ha = cfg.homeAssistant || {};
    return json({
      url: ha.url || '',
      allowSelfSigned: !!ha.allowSelfSigned,
      hasToken: !!(ha.token && String(ha.token).length > 0),
      configured: !!(ha.url && ha.token),
    });
  }

  if (req.url === '/api/home-assistant' && req.method === 'PUT') {
    if (!requirePrivileged(req, res)) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json({ error: 'Invalid JSON' }, 400); }
    const url = body.url == null ? null : String(body.url).trim();
    // Empty url + empty token = clear the integration.
    if (url === '' && (body.token == null || body.token === '')) {
      modifyConfig((c) => { delete c.homeAssistant; });
      invalidateHaCache();
      return json({ ok: true, cleared: true });
    }
    if (url != null) {
      if (!url) return json({ error: 'URL is required.' }, 400);
      if (!/^https?:\/\//.test(url)) return json({ error: 'URL must start with http:// or https://' }, 400);
    }
    modifyConfig((c) => {
      const cur = c.homeAssistant || {};
      const next = { ...cur };
      if (url != null) next.url = url.replace(/\/+$/, '');
      // Only overwrite token if a non-empty value was provided. The UI sends
      // an empty string when the admin doesn't want to change the saved token.
      if (typeof body.token === 'string' && body.token.length > 0) next.token = body.token;
      if (typeof body.allowSelfSigned === 'boolean') next.allowSelfSigned = body.allowSelfSigned;
      c.homeAssistant = next;
    });
    invalidateHaCache();
    return json({ ok: true });
  }

  if (req.url === '/api/home-assistant/test' && req.method === 'POST') {
    if (!requirePrivileged(req, res)) return true;
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    // Fall back to saved values for any field the caller omits — lets the
    // admin click Test without re-entering the token after a save.
    const saved = loadConfig().homeAssistant || {};
    const url = (typeof body.url === 'string' && body.url) ? body.url : saved.url;
    const token = (typeof body.token === 'string' && body.token) ? body.token : saved.token;
    const allowSelfSigned = typeof body.allowSelfSigned === 'boolean'
      ? body.allowSelfSigned
      : !!saved.allowSelfSigned;
    if (!url || !token) return json({ ok: false, error: 'URL and access token are both required to test.' });
    if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: 'URL must start with http:// or https://' });
    const result = await probeHa({ url, token, allowSelfSigned });
    return json(result);
  }

  return false;
}
