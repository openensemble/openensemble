/**
 * Drawer routes: /api/drawers*, drawer delegation
 */

import {
  requireAuth, getAuthToken, getSessionUserId, getUser,
  loadUsers, loadConfig, modifyUsers, modifyUser, readBody,
} from './_helpers.mjs';
import { getDrawer, getDrawersForUser, delegateDrawerRequest } from '../plugins.mjs';

export async function handle(req, res) {
  if (req.url === '/api/drawers' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const user = getUser(authId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getDrawersForUser(user)));
    return true;
  }

  if (req.url === '/api/drawers/toggle' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { pluginId, enabled } = JSON.parse(await readBody(req));
      if (!getDrawer(pluginId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Drawer not found' })); return true; }
      const user = getUser(authId);
      const isPriv = user?.role === 'owner' || user?.role === 'admin';
      if (!isPriv && enabled && user?.allowedFeatures != null && !user.allowedFeatures.includes(pluginId)) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'That drawer is not permitted for your account' })); return true;
      }
      await modifyUser(authId, u => {
        u.pluginPrefs = u.pluginPrefs ?? {};
        u.pluginPrefs[pluginId] = { ...(u.pluginPrefs[pluginId] ?? {}), enabled };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const drawerSettingsMatch = req.url.match(/^\/api\/drawers\/([^/]+)\/settings$/);
  if (drawerSettingsMatch && req.method === 'PATCH') {
    const authId   = requireAuth(req, res); if (!authId) return true;
    const drawerId = drawerSettingsMatch[1];
    if (!getDrawer(drawerId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Drawer not found' })); return true; }
    try {
      const settings = JSON.parse(await readBody(req));
      await modifyUser(authId, u => {
        u.pluginPrefs = u.pluginPrefs ?? {};
        u.pluginPrefs[drawerId] = u.pluginPrefs[drawerId] ?? {};
        u.pluginPrefs[drawerId].settings = { ...(u.pluginPrefs[drawerId].settings ?? {}), ...settings };
        if (drawerId === 'news' && typeof settings.defaultTopic === 'number') {
          u.newsDefaultTopic = settings.defaultTopic;
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Delegate to drawer route handlers (e.g. /api/news → plugins/news/server.mjs)
  if (req.url.startsWith('/api/')) {
    const authId = getSessionUserId(getAuthToken(req));
    const cfg = { ...loadConfig(), ...(authId ? { userId: authId } : {}) };
    const handled = await delegateDrawerRequest(req, res, cfg);
    if (handled) return true;
  }

  return false;
}
