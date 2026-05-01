/**
 * routes/tunnel.mjs — Cloudflare Tunnel control plane.
 *
 * Most endpoints are owner/admin-gated (configuring + starting + stopping a
 * public tunnel is an install-level action). The exception is
 * /api/tunnel/public-url which any authed user may read so the Telegram
 * settings page can autofill the webhook field for them.
 */

import {
  requireAuth, isPrivileged, readBody,
} from './_helpers.mjs';
import {
  getStatus, getPublicUrl, configure, start, stop, setEnabled,
} from '../lib/tunnel.mjs';

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
  return true;
}

export async function handle(req, res) {
  // Public-URL read — any authed user. Used by Telegram autofill.
  if (req.url === '/api/tunnel/public-url' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    return json(res, { publicUrl: getPublicUrl() });
  }

  // Status read — also any authed user (the Settings UI for non-owners shows
  // a read-only banner indicating whether the install is publicly reachable).
  if (req.url === '/api/tunnel/status' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const s = getStatus();
    // Hide token presence from non-privileged users.
    if (!isPrivileged(userId)) delete s.hasToken;
    return json(res, s);
  }

  // Owner/admin-gated mutations.
  if (req.url?.startsWith('/api/tunnel/') && req.method !== 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    if (!isPrivileged(userId)) return json(res, { error: 'Owner or admin only' }, 403);

    if (req.url === '/api/tunnel/configure' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch { return json(res, { error: 'Invalid JSON' }, 400); }
      try {
        const cfg = await configure(body);
        return json(res, { ok: true, config: { mode: cfg.mode, hostname: cfg.hostname, hasToken: !!cfg.token, localPort: cfg.localPort } });
      } catch (e) {
        return json(res, { error: e.message }, 400);
      }
    }

    if (req.url === '/api/tunnel/start' && req.method === 'POST') {
      try {
        await setEnabled(true);
        await start();
        return json(res, { ok: true, status: getStatus() });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    if (req.url === '/api/tunnel/stop' && req.method === 'POST') {
      try {
        await stop({ persistEnabled: false });
        return json(res, { ok: true, status: getStatus() });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }
  }

  return false;
}
