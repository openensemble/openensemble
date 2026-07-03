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
import { invalidateCache as invalidateHaCache, ensureCache as ensureHaCache } from '../lib/ha-cache.mjs';
import { getHaConfig, haRequest } from '../lib/ha-client.mjs';

// In-process cache for the HA service catalog. Same 5-min TTL as the entity
// cache — service definitions change rarely (only when integrations are
// added/removed/configured) and the catalog is small but not tiny (HA returns
// every service from every loaded integration, easily 100-300 domains).
const SERVICES_TTL_MS = 5 * 60 * 1000;
let _servicesCache = null;   // { domain: [serviceName, ...] }
let _servicesAt = 0;
let _servicesInflight = null;

function invalidateServicesCache() {
  _servicesCache = null;
  _servicesAt = 0;
}

async function ensureServicesCache(force = false) {
  if (!force && _servicesCache && (Date.now() - _servicesAt) < SERVICES_TTL_MS) return _servicesCache;
  if (_servicesInflight) return _servicesInflight;
  _servicesInflight = (async () => {
    try {
      const cfg = getHaConfig();
      if (!cfg) return null;
      const data = await haRequest(cfg, '/services');
      if (!Array.isArray(data)) return null;
      const out = {};
      for (const entry of data) {
        const domain = typeof entry?.domain === 'string' ? entry.domain : null;
        if (!domain) continue;
        // HA returns `services` either as a {name: {...}} object (modern) or
        // as a [name, ...] array (older builds). Accept both.
        let names = [];
        if (entry.services && typeof entry.services === 'object' && !Array.isArray(entry.services)) {
          names = Object.keys(entry.services);
        } else if (Array.isArray(entry.services)) {
          names = entry.services.filter(s => typeof s === 'string');
        }
        names = names.filter(n => /^[a-z0-9_]{1,64}$/i.test(n)).sort();
        if (names.length) out[domain] = names;
      }
      _servicesCache = out;
      _servicesAt = Date.now();
      return out;
    } finally {
      _servicesInflight = null;
    }
  })();
  return _servicesInflight;
}

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
      await modifyConfig((c) => { delete c.homeAssistant; });
      invalidateHaCache();
      invalidateServicesCache();
      return json({ ok: true, cleared: true });
    }
    if (url != null) {
      if (!url) return json({ error: 'URL is required.' }, 400);
      if (!/^https?:\/\//.test(url)) return json({ error: 'URL must start with http:// or https://' }, 400);
    }
    // AWAIT the write: modifyConfig is async — replying "ok" before it
    // commits let a racing cache refresh re-cache the OLD credentials, so a
    // rotated HA token kept "working" against the revoked value.
    await modifyConfig((c) => {
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
    invalidateServicesCache();
    return json({ ok: true });
  }

  // List Home Assistant scenes + scripts + groups so the Routines UI can
  // populate a dropdown instead of making users hand-type entity ids. Pulls
  // from the 5-min ha-cache. Filter optional: ?domain=scene,script,group
  // (default scene,script). When `group` is requested, ANY entity flagged
  // isGroup is included regardless of its domain — that covers modern HA
  // helper groups that surface under light.*/switch.* instead of group.*.
  if (req.url.startsWith('/api/home-assistant/entities') && req.method === 'GET') {
    if (!requireAuth(req, res)) return true;
    const u = new URL(req.url, 'http://x');
    const wantDomains = new Set((u.searchParams.get('domain') || 'scene,script')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const wantsGroups = wantDomains.has('group');
    const idx = await ensureHaCache().catch(() => null);
    if (!idx) return json({ entities: [], configured: false });
    const entities = [];
    for (const [, v] of idx) {
      const match = wantDomains.has(v.domain) || (wantsGroups && v.isGroup);
      if (!match) continue;
      // Normalize so the UI can group "this is a group" consistently —
      // legacy group.* and modern light.kitchen_lights (a group helper)
      // both come back with domain='group' for the UI's optgroup logic,
      // while preserving the real entity_id for HA calls.
      entities.push({
        entity_id: v.entity_id,
        domain:    v.isGroup ? 'group' : v.domain,
        friendly_name: v.friendly_name,
      });
    }
    entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    return json({ entities, configured: true });
  }

  // Force the HA entity cache to refresh now. Used by the Routines UI's
  // refresh button so newly-added scenes/groups/scripts show up without
  // waiting for the 5-min background tick. Also bumps the service catalog
  // so cascading domain/service dropdowns in the ha_call editor pick up
  // newly-installed integrations.
  if (req.url === '/api/home-assistant/refresh' && req.method === 'POST') {
    if (!requireAuth(req, res)) return true;
    invalidateHaCache();
    invalidateServicesCache();
    const [idx, services] = await Promise.all([
      ensureHaCache(true).catch(() => null),
      ensureServicesCache(true).catch(() => null),
    ]);
    return json({
      ok: !!idx,
      count: idx ? idx.size : 0,
      serviceDomains: services ? Object.keys(services).length : 0,
    });
  }

  // Return the HA service catalog ({domain: [serviceName, ...]}) so the
  // Routines UI can populate cascading domain + service dropdowns for the
  // ha_call action. Pulls from the 5-min cache.
  if (req.url === '/api/home-assistant/services' && req.method === 'GET') {
    if (!requireAuth(req, res)) return true;
    const services = await ensureServicesCache().catch(() => null);
    if (!services) return json({ services: {}, configured: false });
    return json({ services, configured: true });
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
