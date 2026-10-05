/**
 * Drawer routes: /api/drawers*, drawer delegation
 */

import {
  requireAuth, getAuthToken, getSessionUserId, getUser,
  loadUsers, loadConfig, modifyUsers, modifyUser, readBody,
} from './_helpers.mjs';
import { getDrawer, getDrawersForUser, delegateDrawerRequest } from '../plugins.mjs';
import { createHash } from 'node:crypto';
import { mayImportCustomCodeInProcess } from '../lib/custom-code-policy.mjs';

function drawerInitUrl(drawer) {
  const version = createHash('sha256').update(drawer.initJs).digest('hex');
  return `/api/drawers/${encodeURIComponent(drawer.id)}/init?v=${version}`;
}

export async function handle(req, res) {
  if (req.url === '/api/drawers' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const user = getUser(authId);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(getDrawersForUser(user).map(drawer => (
      drawer.custom && drawer.drawer && drawer.initJs
        ? { ...drawer, initUrl: drawerInitUrl(drawer) }
        : drawer
    ))));
    return true;
  }

  // Serve trusted custom init bodies as authenticated modules. The browser's
  // script-src 'self' policy permits these without enabling string evaluation.
  const url = new URL(req.url, 'http://localhost');
  const initMatch = url.pathname.match(/^\/api\/drawers\/([^/]+)\/init$/);
  if (initMatch && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const drawer = getDrawersForUser(getUser(authId)).find(p =>
      encodeURIComponent(p.id) === initMatch[1] && p.custom && p.drawer
      && p.createdBy === authId && p.enabled && p.initJs);
    const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/javascript; charset=utf-8' };
    if (!drawer || !mayImportCustomCodeInProcess(authId, drawer.skillId)) {
      res.writeHead(404, headers);
      res.end('// Drawer unavailable');
      return true;
    }
    if (drawerInitUrl(drawer) !== `${url.pathname}?v=${url.searchParams.get('v')}`) {
      res.writeHead(409, headers);
      res.end('// Drawer changed; reload the catalog');
      return true;
    }
    res.writeHead(200, headers);
    res.end(`export default async function(signal, drawerId) {\n${drawer.initJs}\n}\n`);
    return true;
  }

  if (req.url === '/api/drawers/toggle' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { pluginId, enabled } = JSON.parse(await readBody(req));
      if (!getDrawer(pluginId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, note: 'plugin not currently loaded; preference saved' }));
        await modifyUser(authId, u => {
          u.pluginPrefs = u.pluginPrefs ?? {};
          u.pluginPrefs[pluginId] = { ...(u.pluginPrefs[pluginId] ?? {}), enabled };
        });
        return true;
      }
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
