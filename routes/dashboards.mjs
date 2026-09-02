/**
 * Authenticated per-user dashboard storage and Home Assistant renderer APIs.
 * Dashboard ownership is the authenticated user directory, never client data.
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';

import {
  getUser,
  getUserDir,
  isUserTimeBlocked,
  requireAuth,
  withLock,
} from './_helpers.mjs';
import { atomicWriteSync } from './_helpers/io-lock.mjs';
import { getHaConfig, haRequest, haRequestBinary } from '../lib/ha-client.mjs';
import { callHaServiceAndConfirm, listHaStates } from '../lib/ha-service.mjs';
import { getFreshMirror, hasGcalCreds } from '../lib/calendar-mirror.mjs';
import {
  fetchDashboardInbox,
  listDashboardEmailAccounts,
} from './email-accounts.mjs';
import {
  getHaWebSocketStatus,
  isHaWebSocketReady,
  sendHaWebSocketCommand,
} from '../lib/ha-websocket.mjs';
import {
  executeDashboardWidgetForSkill,
  getRoleTools,
  isSkillRuntimeEnabledForUser,
  listRoles,
} from '../roles.mjs';
import { validateSkillDashboardWidgets } from '../lib/dashboard-widgets.mjs';
import { readOnlySkillSandboxAvailable } from '../lib/skill-subprocess.mjs';
import { getNodes } from '../skills/nodes/node-registry.mjs';
import {
  isCameraEntityId,
  isDashboardSlug,
  isWeatherEntityId,
  normalizeCatalog,
  normalizeEntities,
  normalizeEntity,
  normalizeWeatherForecasts,
  resolveControl,
  validateDashboardMetadata,
  validateDashboardRegistry,
  validateLayout,
} from '../lib/dashboard-schema.mjs';

const MAX_DASHBOARDS = 32;
const LAYOUT_MAX_BYTES = 128 * 1024;
const CREATE_MAX_BYTES = LAYOUT_MAX_BYTES + (8 * 1024);
const METADATA_MAX_BYTES = 8 * 1024;
const REGISTRY_MAX_BYTES = 64 * 1024;
const CONTROL_MAX_BYTES = 4 * 1024;
const CAMERA_MAX_BYTES = 25 * 1024 * 1024;
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const WEATHER_ERROR_CACHE_MS = 60 * 1000;
const WEATHER_DAILY_FEATURE = 1;
const MAX_WEATHER_ENTITIES = 32;
const RUNTIME_API_PREFIX = '/api/dashboard-runtime';
const CAMERA_API_PREFIX = `${RUNTIME_API_PREFIX}/camera/`;
const WIDGET_CATALOG_PATH = '/api/dashboard-widgets/catalog';
const WIDGET_RUNTIME_PREFIX = `${RUNTIME_API_PREFIX}/widgets/`;
const MAX_CUSTOM_WIDGET_REFRESHES_PER_USER = 6;
const MAX_CUSTOM_WIDGET_REFRESHES_TOTAL = 16;
const CUSTOM_WIDGET_SANDBOX_UNAVAILABLE =
  'Custom dashboard widgets are unavailable: the local bubblewrap read-only sandbox is missing, or the dedicated skill sandbox runner is configured and read-only runner support is pending.';
const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SKILL_WIDGET_ID = /^skill:([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?):([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const CAMERA_IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const weatherCache = {
  key: null,
  value: null,
  expiresAt: 0,
  inFlight: null,
};
const customWidgetRefreshes = new Map();
const customWidgetRefreshesByUser = new Map();
let customWidgetRefreshesTotal = 0;

class DashboardHttpError extends Error {
  constructor(status, message, headers = null) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function methodNotAllowed(res, allow) {
  sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: allow });
}

function exactObjectKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every(key => typeof key === 'string' && keys.includes(key));
}

function requireJsonContentType(req) {
  const contentType = String(req.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new DashboardHttpError(415, 'Content-Type must be application/json.');
  }
}

function readJsonBody(req, maxBytes, { allowEmpty = false } = {}) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new DashboardHttpError(413, `Request body must be at most ${maxBytes} bytes.`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new DashboardHttpError(413, `Request body must be at most ${maxBytes} bytes.`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        if (allowEmpty) resolve(null);
        else reject(new DashboardHttpError(400, 'Request body must contain JSON.'));
        return;
      }
      try { resolve(JSON.parse(text)); }
      catch { reject(new DashboardHttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new DashboardHttpError(400, 'Unable to read request body.'));
    });
  });
}

function privateMkdir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function privateAtomicWrite(filePath, data) {
  privateMkdir(path.dirname(filePath));
  atomicWriteSync(filePath, data, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

export function dashboardPathsForUser(userId) {
  const root = path.join(getUserDir(userId), 'dashboards');
  return {
    root,
    registryPath: path.join(root, 'index.json'),
    layoutsDir: path.join(root, 'layouts'),
  };
}

function dashboardLayoutPath(paths, slug) {
  return path.join(paths.layoutsDir, `${slug}.json`);
}

function profileLabel(userId) {
  const name = getUser(userId)?.name;
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 100);
  return 'Household';
}

function homeMetadata(owner) {
  return {
    slug: 'home',
    name: 'Home',
    owner,
    description: '',
    theme: 'midnight',
  };
}

function fallbackRegistry(owner) {
  return { version: 1, dashboards: [homeMetadata(owner)] };
}

function checkedMetadata(value) {
  const checked = validateDashboardMetadata(value);
  if (!checked.ok) throw new DashboardHttpError(400, checked.error);
  return checked.dashboard;
}

function checkedLayout(value) {
  const checked = validateLayout(value);
  if (!checked.ok) throw new DashboardHttpError(400, checked.error);
  const serialized = JSON.stringify(checked.layout);
  if (Buffer.byteLength(serialized) > LAYOUT_MAX_BYTES) {
    throw new DashboardHttpError(413, `Layout must be at most ${LAYOUT_MAX_BYTES} bytes.`);
  }
  return { layout: checked.layout, serialized };
}

function loadRegistry(paths, owner) {
  let raw;
  try { raw = fs.readFileSync(paths.registryPath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallbackRegistry(owner);
    throw new DashboardHttpError(503, 'Dashboard metadata is temporarily unavailable.');
  }
  if (Buffer.byteLength(raw) > REGISTRY_MAX_BYTES) {
    throw new DashboardHttpError(503, 'Dashboard metadata is unreadable.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new DashboardHttpError(503, 'Dashboard metadata is unreadable.'); }
  const checked = validateDashboardRegistry(parsed);
  if (!checked.ok) throw new DashboardHttpError(503, 'Dashboard metadata is unreadable.');
  return checked.registry;
}

function registryForWrite(registry, owner) {
  const candidate = {
    version: 1,
    dashboards: registry.dashboards.map(metadata => ({ ...metadata, owner })),
  };
  const checked = validateDashboardRegistry(candidate);
  if (!checked.ok) throw new DashboardHttpError(500, 'Dashboard metadata could not be saved.');
  return checked.registry;
}

function writeRegistry(paths, registry, owner) {
  const checked = registryForWrite(registry, owner);
  privateAtomicWrite(paths.registryPath, JSON.stringify(checked, null, 2));
  return checked;
}

function dashboardMetadata(registry, slug) {
  return registry.dashboards.find(entry => entry.slug === slug) || null;
}

function recoverQuarantinedLayout(paths, slug) {
  const layoutPath = dashboardLayoutPath(paths, slug);
  if (fs.existsSync(layoutPath)) return layoutPath;
  const prefix = `${slug}.json.deleting.`;
  let candidates = [];
  try {
    candidates = fs.readdirSync(paths.layoutsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
      .filter(entry => /^\d+\.[a-f0-9]{12}$/.test(entry.name.slice(prefix.length)))
      .map((entry) => {
        const candidatePath = path.join(paths.layoutsDir, entry.name);
        return { path: candidatePath, mtimeMs: fs.statSync(candidatePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[dashboards] interrupted-delete scan failed:', error.message);
    return layoutPath;
  }
  if (!candidates.length) return layoutPath;
  try { fs.renameSync(candidates[0].path, layoutPath); }
  catch (error) { console.warn(`[dashboards] failed to recover ${slug}:`, error.message); }
  return layoutPath;
}

function loadLayout(paths, metadata) {
  const filePath = recoverQuarantinedLayout(paths, metadata.slug);
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    // An uninitialized Home dashboard intentionally has no saved layout. The
    // renderer uses `null` to build a starter from the user's live HA entities.
    if (error?.code === 'ENOENT') return null;
    throw new DashboardHttpError(503, 'Dashboard layout is temporarily unavailable.');
  }
  if (Buffer.byteLength(raw) > LAYOUT_MAX_BYTES) {
    throw new DashboardHttpError(503, 'Dashboard layout is unreadable.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new DashboardHttpError(503, 'Dashboard layout is unreadable.'); }
  const checked = validateLayout(parsed);
  if (!checked.ok) throw new DashboardHttpError(503, 'Dashboard layout is unreadable.');
  return checked.layout;
}

function layoutEtag(layout) {
  const digest = createHash('sha256').update(JSON.stringify(layout)).digest('hex');
  return `\"layout-${digest}\"`;
}

function ifMatchAllows(header, currentEtag) {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : String(header);
  return value.split(',').map(candidate => candidate.trim())
    .some(candidate => candidate === currentEtag);
}

function cardCount(layout) {
  if (!layout) return 0;
  return layout.sections.reduce((total, section) => total + section.cards.length, 0);
}

function summary(metadata, layout, owner) {
  return {
    slug: metadata.slug,
    name: metadata.name,
    owner,
    description: metadata.description,
    theme: metadata.theme,
    url: `/dashboards/${metadata.slug}`,
    isDefault: metadata.slug === 'home',
    sectionCount: layout?.sections.length || 0,
    cardCount: cardCount(layout),
  };
}

function dashboardRoute(pathname) {
  if (pathname === '/api/dashboards') return { kind: 'collection' };
  if (!pathname.startsWith('/api/dashboards/')) return null;
  const remainder = pathname.slice('/api/dashboards/'.length);
  const segments = remainder.split('/');
  if (segments.length > 2 || (segments.length === 2 && segments[1] !== 'layout')) {
    return { kind: 'not-found' };
  }
  let slug;
  try { slug = decodeURIComponent(segments[0]); }
  catch { throw new DashboardHttpError(400, 'Invalid dashboard slug.'); }
  if (!segments[0] || !isDashboardSlug(slug)) {
    throw new DashboardHttpError(400, 'Invalid dashboard slug.');
  }
  return { kind: segments.length === 2 ? 'layout' : 'item', slug };
}

async function handleDashboardCollection(req, res, paths, owner) {
  if (req.method === 'GET') {
    const payload = await withLock(paths.registryPath, () => {
      const registry = loadRegistry(paths, owner);
      return {
        defaultSlug: 'home',
        dashboards: registry.dashboards.map((metadata) =>
          summary(metadata, loadLayout(paths, metadata), owner)),
      };
    });
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'POST') {
    requireJsonContentType(req);
    const body = await readJsonBody(req, CREATE_MAX_BYTES);
    const keys = ['slug', 'name', 'description', 'theme', 'layout'];
    if (!exactObjectKeys(body, keys)) {
      throw new DashboardHttpError(400, `Dashboard creation must contain exactly ${keys.join(', ')}.`);
    }
    const metadata = checkedMetadata({
      slug: body.slug,
      name: body.name,
      owner,
      description: body.description,
      theme: body.theme,
    });
    const layout = checkedLayout(body.layout);

    const created = await withLock(paths.registryPath, () => {
      let registry = loadRegistry(paths, owner);
      if (dashboardMetadata(registry, metadata.slug)) {
        throw new DashboardHttpError(409, `Dashboard slug already exists: ${metadata.slug}.`);
      }
      if (registry.dashboards.length >= MAX_DASHBOARDS) {
        throw new DashboardHttpError(409, `OpenEnsemble supports at most ${MAX_DASHBOARDS} dashboards per user.`);
      }
      const targetPath = dashboardLayoutPath(paths, metadata.slug);
      if (fs.existsSync(targetPath)) {
        throw new DashboardHttpError(409, `Dashboard storage already exists for slug: ${metadata.slug}.`);
      }
      privateAtomicWrite(targetPath, layout.serialized);
      try {
        registry.dashboards.push(metadata);
        registry = writeRegistry(paths, registry, owner);
      } catch (error) {
        try { fs.unlinkSync(targetPath); } catch {}
        throw error;
      }
      return summary(dashboardMetadata(registry, metadata.slug), layout.layout, owner);
    });
    sendJson(res, 201, { dashboard: created }, {
      Location: `/api/dashboards/${created.slug}`,
      ETag: layoutEtag(layout.layout),
    });
    return;
  }

  methodNotAllowed(res, 'GET, POST');
}

async function handleDashboardItem(req, res, route, paths, owner) {
  if (route.kind === 'layout') {
    if (req.method === 'GET') {
      const layout = await withLock(paths.registryPath, () => {
        const registry = loadRegistry(paths, owner);
        const metadata = dashboardMetadata(registry, route.slug);
        if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
        return loadLayout(paths, metadata);
      });
      sendJson(res, 200, { layout }, { ETag: layoutEtag(layout) });
      return;
    }
    if (req.method === 'PUT') {
      requireJsonContentType(req);
      const body = await readJsonBody(req, LAYOUT_MAX_BYTES + 1024);
      const wrapped = body && typeof body === 'object' && !Array.isArray(body)
        && Object.keys(body).length === 1
        && Object.prototype.hasOwnProperty.call(body, 'layout');
      const incoming = checkedLayout(wrapped ? body.layout : body);
      const result = await withLock(paths.registryPath, () => {
        const registry = loadRegistry(paths, owner);
        const metadata = dashboardMetadata(registry, route.slug);
        if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
        const current = loadLayout(paths, metadata);
        const currentEtag = layoutEtag(current);
        if (req.headers['if-match'] === undefined) {
          throw new DashboardHttpError(
            428,
            'If-Match is required when saving a dashboard layout.',
            { ETag: currentEtag },
          );
        }
        if (!ifMatchAllows(req.headers['if-match'], currentEtag)) {
          return { conflict: true, layout: current, etag: currentEtag };
        }
        if (current?.version === 6 && incoming.layout.version < 6) {
          return {
            conflict: true,
            layout: current,
            etag: currentEtag,
            error: 'This dashboard has custom colors and requires a current OpenEnsemble client.',
          };
        }
        if (current?.version === 5 && incoming.layout.version < 5) {
          return {
            conflict: true,
            layout: current,
            etag: currentEtag,
            error: 'This dashboard has customized page elements and requires a current OpenEnsemble client.',
          };
        }
        if (current?.version === 4 && incoming.layout.version < 4) {
          return {
            conflict: true,
            layout: current,
            etag: currentEtag,
            error: 'This dashboard uses widgets or explicit card types and requires a current OpenEnsemble client.',
          };
        }
        if (current?.version === 3 && incoming.layout.version < 3) {
          return {
            conflict: true,
            layout: current,
            etag: currentEtag,
            error: 'This dashboard uses grouped cards and requires a current OpenEnsemble client.',
          };
        }
        privateAtomicWrite(dashboardLayoutPath(paths, route.slug), incoming.serialized);
        return { conflict: false, layout: incoming.layout, etag: layoutEtag(incoming.layout) };
      });
      if (result.conflict) {
        sendJson(res, 409, {
          error: result.error || 'Layout changed since it was loaded.',
          layout: result.layout,
        }, { ETag: result.etag });
      } else {
        sendJson(res, 200, { ok: true, layout: result.layout }, { ETag: result.etag });
      }
      return;
    }
    methodNotAllowed(res, 'GET, PUT');
    return;
  }

  if (req.method === 'GET') {
    const dashboard = await withLock(paths.registryPath, () => {
      const registry = loadRegistry(paths, owner);
      const metadata = dashboardMetadata(registry, route.slug);
      if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
      return summary(metadata, loadLayout(paths, metadata), owner);
    });
    sendJson(res, 200, { dashboard });
    return;
  }

  if (req.method === 'PATCH') {
    requireJsonContentType(req);
    const body = await readJsonBody(req, METADATA_MAX_BYTES);
    const allowed = new Set(['name', 'description', 'theme']);
    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body)
      : [];
    if (!keys.length || keys.some(key => !allowed.has(key))) {
      throw new DashboardHttpError(400, 'Dashboard update must contain a nonempty subset of name, description, and theme.');
    }
    const dashboard = await withLock(paths.registryPath, () => {
      let registry = loadRegistry(paths, owner);
      const metadata = dashboardMetadata(registry, route.slug);
      if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
      const updated = checkedMetadata({ ...metadata, ...body, owner });
      const index = registry.dashboards.findIndex(entry => entry.slug === route.slug);
      registry.dashboards[index] = updated;
      registry = writeRegistry(paths, registry, owner);
      return summary(updated, loadLayout(paths, updated), owner);
    });
    sendJson(res, 200, { dashboard });
    return;
  }

  if (req.method === 'DELETE') {
    requireJsonContentType(req);
    const body = await readJsonBody(req, METADATA_MAX_BYTES, { allowEmpty: true });
    if (body !== null && !exactObjectKeys(body, [])) {
      throw new DashboardHttpError(400, 'Dashboard deletion does not accept a request body.');
    }
    await withLock(paths.registryPath, () => {
      let registry = loadRegistry(paths, owner);
      const metadata = dashboardMetadata(registry, route.slug);
      if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
      if (route.slug === 'home') {
        throw new DashboardHttpError(409, 'The home dashboard cannot be deleted.');
      }

      const layoutPath = recoverQuarantinedLayout(paths, route.slug);
      const quarantinedPath = `${layoutPath}.deleting.${process.pid}.${randomBytes(6).toString('hex')}`;
      let quarantined = false;
      try {
        fs.renameSync(layoutPath, quarantinedPath);
        quarantined = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new DashboardHttpError(500, 'Unable to remove the dashboard layout safely.');
        }
      }

      registry.dashboards = registry.dashboards.filter(entry => entry.slug !== route.slug);
      try { registry = writeRegistry(paths, registry, owner); }
      catch (error) {
        if (quarantined) {
          try { fs.renameSync(quarantinedPath, layoutPath); }
          catch (restoreError) {
            console.error(`[dashboards] failed to restore ${route.slug}:`, restoreError.message);
          }
        }
        throw error;
      }
      if (quarantined) {
        try { fs.unlinkSync(quarantinedPath); }
        catch (error) { console.warn(`[dashboards] failed to remove ${route.slug} quarantine:`, error.message); }
      }
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  methodNotAllowed(res, 'GET, PATCH, DELETE');
}

const WIDGET_TEXT_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

function widgetText(value, maxLength, fallback = '') {
  const normalized = String(value ?? '')
    .replace(WIDGET_TEXT_CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maxLength);
}

function inboxFeatureAllowed(userId) {
  const user = getUser(userId);
  if (!user) return false;
  return !Array.isArray(user.allowedFeatures) || user.allowedFeatures.includes('inbox');
}

function calendarWidgetAllowed(userId) {
  return !isUserTimeBlocked(userId)
    && isSkillRuntimeEnabledForUser('gcal', userId);
}

function emailWidgetAllowed(userId) {
  return !isUserTimeBlocked(userId)
    && inboxFeatureAllowed(userId)
    && isSkillRuntimeEnabledForUser('email', userId);
}

function nodesWidgetAllowed(userId) {
  const user = getUser(userId);
  return !!user
    && user.role !== 'child'
    && !isUserTimeBlocked(userId)
    && isSkillRuntimeEnabledForUser('nodes', userId);
}

function customWidgetDescriptor(userId, widgetId, { includeDisabled = true } = {}) {
  const parsed = typeof widgetId === 'string' ? widgetId.match(SKILL_WIDGET_ID) : null;
  if (!parsed) throw new DashboardHttpError(404, 'Dashboard widget not found.');
  const [, skillId, widgetKey] = parsed;
  const manifest = listRoles(userId, { includeDisabled }).find(candidate => (
    candidate.id === skillId
    && candidate.custom === true
    && candidate.userScope === userId
  ));
  if (!manifest) throw new DashboardHttpError(404, 'Dashboard widget not found.');
  if (isUserTimeBlocked(userId) || !isSkillRuntimeEnabledForUser(skillId, userId)) {
    throw new DashboardHttpError(403, 'Dashboard widget access is not available for this profile.');
  }
  const checked = validateSkillDashboardWidgets(manifest.dashboardWidgets, manifest.tools ?? []);
  if (!checked.ok) throw new DashboardHttpError(404, 'Dashboard widget not found.');
  const descriptor = checked.widgets.find(candidate => candidate.id === widgetKey);
  if (!descriptor) throw new DashboardHttpError(404, 'Dashboard widget not found.');
  const visibleTools = getRoleTools(skillId, userId);
  if (!visibleTools.some(tool => tool?.function?.name === descriptor.tool
      && tool.readOnly === true && tool.destructive !== true)) {
    throw new DashboardHttpError(403, 'Dashboard widget access is not available for this profile.');
  }
  return { skillId, widgetKey, descriptor, manifest };
}

function requireWidgetAccess(userId, widgetId) {
  if (isUserTimeBlocked(userId)) {
    throw new DashboardHttpError(403, 'Dashboard widget access is not available for this profile.');
  }
  if (widgetId === 'builtin.calendar') {
    if (!calendarWidgetAllowed(userId)) {
      throw new DashboardHttpError(403, 'Calendar access is not available for this profile.');
    }
    return { source: 'calendar' };
  }
  if (widgetId === 'builtin.email') {
    if (!emailWidgetAllowed(userId)) {
      throw new DashboardHttpError(403, 'Email access is not available for this profile.');
    }
    return { source: 'email' };
  }
  if (widgetId === 'builtin.nodes') {
    if (!nodesWidgetAllowed(userId)) {
      throw new DashboardHttpError(403, 'Nodes access is not available for this profile.');
    }
    return { source: 'nodes' };
  }
  return { source: 'skill', ...customWidgetDescriptor(userId, widgetId) };
}

function calendarCatalogOptions(mirror) {
  if (!mirror?.calendars || typeof mirror.calendars !== 'object') return [];
  return Object.entries(mirror.calendars)
    .map(([id, calendar]) => ({
      id: widgetText(id, 512),
      name: widgetText(calendar?.name, 160, 'Calendar'),
    }))
    .filter(calendar => calendar.id)
    .slice(0, 64);
}

function customWidgetCatalog(userId) {
  if (isUserTimeBlocked(userId)) return [];
  const sandboxAvailable = readOnlySkillSandboxAvailable();
  const widgets = [];
  for (const manifest of listRoles(userId)) {
    if (manifest.custom !== true || manifest.userScope !== userId
        || !isSkillRuntimeEnabledForUser(manifest.id, userId)) continue;
    const checked = validateSkillDashboardWidgets(manifest.dashboardWidgets, manifest.tools ?? []);
    if (!checked.ok) continue;
    const visibleTools = new Set(getRoleTools(manifest.id, userId)
      .filter(tool => tool?.readOnly === true && tool?.destructive !== true)
      .map(tool => tool?.function?.name));
    for (const descriptor of checked.widgets) {
      if (!visibleTools.has(descriptor.tool)) continue;
      widgets.push({
        widgetId: `skill:${manifest.id}:${descriptor.id}`,
        source: 'skill',
        title: descriptor.title,
        description: descriptor.description,
        icon: descriptor.icon,
        defaultSize: descriptor.size,
        defaultAccent: descriptor.accent,
        refreshSeconds: descriptor.refreshSeconds,
        available: sandboxAvailable,
        ...(sandboxAvailable ? {} : { reason: CUSTOM_WIDGET_SANDBOX_UNAVAILABLE }),
        defaults: {},
        options: {},
      });
    }
  }
  return widgets;
}

async function handleWidgetCatalog(req, res, userId) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }

  const canCalendar = calendarWidgetAllowed(userId);
  let mirror = null;
  if (canCalendar && hasGcalCreds(userId)) mirror = await getFreshMirror(userId);
  // Permission may change while a fresh mirror is being obtained.
  if (!calendarWidgetAllowed(userId)) mirror = null;

  const canEmail = emailWidgetAllowed(userId);
  const accounts = canEmail ? listDashboardEmailAccounts(userId) : [];
  const canNodes = nodesWidgetAllowed(userId);
  const widgets = [
    {
      widgetId: 'builtin.calendar',
      source: 'builtin',
      title: 'Calendar',
      description: 'Upcoming events from your connected calendars.',
      icon: 'calendar-days',
      defaultSize: 'wide',
      defaultAccent: 'sky',
      refreshSeconds: 300,
      available: canCalendar && !!mirror,
      defaults: { days: 7, maxItems: 10, calendarIds: [], showLocation: false },
      options: { calendars: mirror ? calendarCatalogOptions(mirror) : [] },
    },
    {
      widgetId: 'builtin.email',
      source: 'builtin',
      title: 'Email',
      description: 'A compact, read-only view of a connected inbox.',
      icon: 'mail',
      defaultSize: 'wide',
      defaultAccent: 'violet',
      refreshSeconds: 60,
      available: canEmail && accounts.length > 0,
      defaults: { accountId: accounts[0]?.id ?? '', maxItems: 8, showSnippet: false },
      options: { accounts },
    },
    {
      widgetId: 'builtin.nodes',
      source: 'builtin',
      title: 'Nodes',
      description: 'Read-only connection and health status for your paired remote machines.',
      icon: 'activity',
      defaultSize: 'wide',
      defaultAccent: 'cyan',
      refreshSeconds: 30,
      available: canNodes,
      ...(!canNodes ? {
        reason: 'Nodes access is not available for this profile.',
      } : {}),
      defaults: { maxItems: 8, showDetails: true },
      options: {},
    },
    ...customWidgetCatalog(userId),
  ];
  sendJson(res, 200, { version: 1, widgets });
}

function exactConfig(config, allowed, label) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !allowed.has(key))) {
    throw new DashboardHttpError(400, `${label} widget config contains unsupported fields.`);
  }
}

function calendarWidgetConfig(config) {
  exactConfig(config, new Set(['days', 'maxItems', 'calendarIds', 'showLocation']), 'Calendar');
  const days = config.days ?? 7;
  const maxItems = config.maxItems ?? 10;
  const calendarIds = config.calendarIds ?? [];
  const showLocation = config.showLocation ?? false;
  if (!Number.isSafeInteger(days) || days < 1 || days > 35) {
    throw new DashboardHttpError(400, 'Calendar widget days must be an integer from 1 to 35.');
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 20) {
    throw new DashboardHttpError(400, 'Calendar widget maxItems must be an integer from 1 to 20.');
  }
  if (!Array.isArray(calendarIds) || calendarIds.length > 32
      || calendarIds.some(id => typeof id !== 'string' || !id || id.length > 512)) {
    throw new DashboardHttpError(400, 'Calendar widget calendarIds must be an array of at most 32 calendar ids.');
  }
  if (typeof showLocation !== 'boolean') {
    throw new DashboardHttpError(400, 'Calendar widget showLocation must be a boolean.');
  }
  return { days, maxItems, calendarIds: [...new Set(calendarIds)], showLocation };
}

function emailWidgetConfig(config) {
  exactConfig(config, new Set(['accountId', 'maxItems', 'showSnippet']), 'Email');
  const accountId = config.accountId;
  const maxItems = config.maxItems ?? 8;
  const showSnippet = config.showSnippet ?? false;
  if (typeof accountId !== 'string' || !accountId || accountId.length > 160
      || /[\0\r\n]/.test(accountId)) {
    throw new DashboardHttpError(424, 'The email widget needs a connected account.');
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 20) {
    throw new DashboardHttpError(400, 'Email widget maxItems must be an integer from 1 to 20.');
  }
  if (typeof showSnippet !== 'boolean') {
    throw new DashboardHttpError(400, 'Email widget showSnippet must be a boolean.');
  }
  return { accountId, maxItems, showSnippet };
}

function nodesWidgetConfig(config) {
  exactConfig(config, new Set(['maxItems', 'showDetails']), 'Nodes');
  const maxItems = config.maxItems ?? 8;
  const showDetails = config.showDetails ?? true;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 20) {
    throw new DashboardHttpError(400, 'Nodes widget maxItems must be an integer from 1 to 20.');
  }
  if (typeof showDetails !== 'boolean') {
    throw new DashboardHttpError(400, 'Nodes widget showDetails must be a boolean.');
  }
  return { maxItems, showDetails };
}

function nodeStatus(health) {
  if (health === 'healthy') return 'online';
  if (health === 'recovered') return 'recovered';
  if (health === 'stale') return 'stale';
  if (health === 'disconnected') return 'offline';
  return 'unknown';
}

function nodePlatform(platform) {
  return ({
    linux: 'Linux',
    win32: 'Windows',
    darwin: 'macOS',
  })[String(platform || '').toLowerCase()] || '';
}

function nodesWidgetData(userId, config) {
  const allNodes = getNodes(userId).map(node => ({
    name: widgetText(node.hostname, 160, 'Remote node'),
    status: nodeStatus(node.health),
    ...(config.showDetails ? {
      platform: nodePlatform(node.platform),
    } : {}),
  }));
  const rank = { offline: 0, stale: 1, unknown: 2, recovered: 3, online: 4 };
  allNodes.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  return {
    summary: {
      total: allNodes.length,
      online: allNodes.filter(node => ['online', 'recovered'].includes(node.status)).length,
      attention: allNodes.filter(node => !['online', 'recovered'].includes(node.status)).length,
    },
    nodes: allNodes.slice(0, config.maxItems),
  };
}

function calendarEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return null;
  if (typeof endpoint.dateTime === 'string' && Number.isFinite(Date.parse(endpoint.dateTime))) {
    return { text: endpoint.dateTime.slice(0, 80), ms: Date.parse(endpoint.dateTime), allDay: false };
  }
  if (typeof endpoint.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endpoint.date)) {
    const [year, month, day] = endpoint.date.split('-').map(Number);
    const ms = new Date(year, month - 1, day).getTime();
    if (Number.isFinite(ms)) return { text: endpoint.date, ms, allDay: true };
  }
  return null;
}

function calendarWidgetData(mirror, config) {
  const selected = config.calendarIds.length ? new Set(config.calendarIds) : null;
  const now = Date.now();
  const horizon = now + (config.days * 86_400_000);
  const events = [];
  for (const event of (Array.isArray(mirror?.events) ? mirror.events : [])) {
    const calendarId = widgetText(event?.calId, 512);
    if (!calendarId || (selected && !selected.has(calendarId))) continue;
    const start = calendarEndpoint(event?.start);
    const end = calendarEndpoint(event?.end);
    if (!start || !end || end.ms <= now || start.ms >= horizon) continue;
    const item = {
      id: widgetText(event?.id, 512),
      calendarId,
      calendarName: widgetText(mirror.calendars?.[event.calId]?.name, 160, 'Calendar'),
      title: widgetText(event?.summary, 300, '(no title)'),
      start: start.text,
      end: end.text,
      allDay: start.allDay,
    };
    if (!item.id) continue;
    if (config.showLocation) {
      const location = widgetText(event?.location, 300);
      if (location) item.location = location;
    }
    events.push(item);
    if (events.length >= config.maxItems) break;
  }
  return { events };
}

function persistedWidgetCard(paths, owner, dashboardSlug, cardId) {
  const registry = loadRegistry(paths, owner);
  const metadata = dashboardMetadata(registry, dashboardSlug);
  if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
  const layout = loadLayout(paths, metadata);
  const card = layout?.version >= 4
    ? layout.sections.flatMap(section => section.cards)
      .find(candidate => candidate.id === cardId && candidate.kind === 'widget')
    : null;
  if (!card) throw new DashboardHttpError(404, 'Dashboard widget card not found.');
  return card;
}

function customWidgetRefreshKey(userId, dashboardSlug, cardId, cardSnapshot) {
  const snapshotHash = createHash('sha256').update(cardSnapshot).digest('hex');
  return `${userId}\0${dashboardSlug}\0${cardId}\0${snapshotHash}`;
}

async function coalescedCustomWidgetRefresh(userId, key, execute) {
  const existing = customWidgetRefreshes.get(key);
  if (existing) return existing;
  const activeForUser = customWidgetRefreshesByUser.get(userId) ?? 0;
  if (activeForUser >= MAX_CUSTOM_WIDGET_REFRESHES_PER_USER
      || customWidgetRefreshesTotal >= MAX_CUSTOM_WIDGET_REFRESHES_TOTAL) {
    throw new DashboardHttpError(
      429,
      'Too many dashboard widgets are refreshing. Retry shortly.',
      { 'Retry-After': '1' },
    );
  }
  customWidgetRefreshesByUser.set(userId, activeForUser + 1);
  customWidgetRefreshesTotal += 1;
  const refresh = Promise.resolve().then(execute);
  customWidgetRefreshes.set(key, refresh);
  try { return await refresh; }
  finally {
    if (customWidgetRefreshes.get(key) === refresh) customWidgetRefreshes.delete(key);
    const remaining = (customWidgetRefreshesByUser.get(userId) ?? 1) - 1;
    if (remaining > 0) customWidgetRefreshesByUser.set(userId, remaining);
    else customWidgetRefreshesByUser.delete(userId);
    customWidgetRefreshesTotal = Math.max(0, customWidgetRefreshesTotal - 1);
  }
}

async function handleWidgetRuntime(req, res, userId, url, route) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
  if (url.searchParams.getAll('dashboardSlug').length !== 1
      || [...url.searchParams.keys()].some(key => key !== 'dashboardSlug')) {
    throw new DashboardHttpError(400, 'dashboardSlug is required and must be the only query parameter.');
  }
  const dashboardSlug = url.searchParams.get('dashboardSlug');
  if (!isDashboardSlug(dashboardSlug)) {
    throw new DashboardHttpError(400, 'Invalid dashboard slug.');
  }

  const paths = dashboardPathsForUser(userId);
  const owner = profileLabel(userId);
  const card = await withLock(paths.registryPath, () =>
    persistedWidgetCard(paths, owner, dashboardSlug, route.cardId));
  const cardSnapshot = JSON.stringify(card);
  const access = requireWidgetAccess(userId, card.widgetId);
  let data;
  let fetchedAt = new Date().toISOString();

  if (access.source === 'calendar') {
    const config = calendarWidgetConfig(card.config);
    const mirror = hasGcalCreds(userId) ? await getFreshMirror(userId) : null;
    requireWidgetAccess(userId, card.widgetId);
    if (!mirror || !hasGcalCreds(userId)) {
      throw new DashboardHttpError(424, 'Google Calendar is not connected or could not be refreshed.');
    }
    data = calendarWidgetData(mirror, config);
    if (Number.isFinite(mirror.fetchedAt)) fetchedAt = new Date(mirror.fetchedAt).toISOString();
  } else if (access.source === 'email') {
    const config = emailWidgetConfig(card.config);
    try {
      data = await fetchDashboardInbox(userId, config);
    } catch (error) {
      requireWidgetAccess(userId, card.widgetId);
      if (error?.code === 'DASHBOARD_EMAIL_ACCOUNT_REQUIRED'
          || error?.code === 'DASHBOARD_EMAIL_ACCOUNT_NOT_FOUND') {
        throw new DashboardHttpError(424, 'The selected email account is not connected.');
      }
      console.warn('[dashboards] email widget refresh failed:', error?.message || error);
      throw new DashboardHttpError(502, 'Email could not be refreshed.');
    }
    requireWidgetAccess(userId, card.widgetId);
    if (!listDashboardEmailAccounts(userId).some(account => account.id === config.accountId)) {
      throw new DashboardHttpError(424, 'The selected email account is not connected.');
    }
  } else if (access.source === 'nodes') {
    const config = nodesWidgetConfig(card.config);
    data = nodesWidgetData(userId, config);
    requireWidgetAccess(userId, card.widgetId);
  } else {
    if (!readOnlySkillSandboxAvailable()) {
      throw new DashboardHttpError(503, CUSTOM_WIDGET_SANDBOX_UNAVAILABLE);
    }
    try {
      const refreshKey = customWidgetRefreshKey(
        userId,
        dashboardSlug,
        route.cardId,
        cardSnapshot,
      );
      const result = await coalescedCustomWidgetRefresh(userId, refreshKey, () =>
        executeDashboardWidgetForSkill(
          access.skillId,
          access.widgetKey,
          card.config,
          userId,
        ));
      data = result.data;
    } catch (error) {
      if (error instanceof DashboardHttpError) throw error;
      // Surface a concurrent revocation as access loss, not an upstream error.
      requireWidgetAccess(userId, card.widgetId);
      console.warn('[dashboards] custom widget refresh failed:', error?.message || error);
      throw new DashboardHttpError(502, 'Custom dashboard widget could not be refreshed.');
    }
    requireWidgetAccess(userId, card.widgetId);
  }

  const latestCard = await withLock(paths.registryPath, () =>
    persistedWidgetCard(paths, owner, dashboardSlug, route.cardId));
  if (JSON.stringify(latestCard) !== cardSnapshot) {
    throw new DashboardHttpError(409, 'Dashboard widget changed while it was refreshing.');
  }
  requireWidgetAccess(userId, latestCard.widgetId);
  sendJson(res, 200, {
    version: 1,
    widgetId: latestCard.widgetId,
    cardId: latestCard.id,
    fetchedAt,
    stale: false,
    data,
  });
}

function configuredHa() {
  const config = getHaConfig();
  if (!config) throw new DashboardHttpError(503, 'Home Assistant is not configured.');
  return config;
}

function safeHaError(error, fallback = 'Unable to reach Home Assistant.') {
  const message = typeof error === 'string'
    ? error
    : (error?.__err || error?.message || '');
  if (/\b401\b|unauthorized|rejected.*token/i.test(message)) {
    return 'Home Assistant rejected the configured access token.';
  }
  if (/\b403\b|forbidden|not permitted/i.test(message)) {
    return 'The configured Home Assistant account is not permitted to perform this action.';
  }
  if (/\b404\b/.test(message)) return 'The requested Home Assistant resource was not found.';
  if (/\b429\b/.test(message)) return 'Home Assistant is busy. Try again shortly.';
  if (/timeout|timed out/i.test(message)) return 'Home Assistant did not respond in time.';
  return fallback;
}

function haFailure(value, fallback) {
  if (value?.__err) throw new DashboardHttpError(502, safeHaError(value, fallback));
  return value;
}

async function handleStatus(req, res, userId) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
  const config = getHaConfig();
  const canAccess = hasRuntimeAccess(userId);
  if (!canAccess) {
    sendJson(res, 200, {
      mode: 'home-assistant', configured: !!config, connected: false, demo: false,
      canView: false,
      canControl: false,
      error: 'Home Assistant access is not available for this profile.',
    });
    return;
  }
  if (!config) {
    sendJson(res, 200, {
      mode: 'home-assistant', configured: false, connected: false, demo: false,
      canView: true,
      canControl: true,
      error: 'Home Assistant is not configured.',
    });
    return;
  }
  const stream = getHaWebSocketStatus();
  if (stream.ready) {
    sendJson(res, 200, {
      mode: 'home-assistant', configured: true, connected: true, demo: false, error: null,
      canView: true,
      canControl: true,
    });
    return;
  }
  const result = await haRequest(config, '/', 'GET', null, { timeoutMs: 8_000 });
  sendJson(res, 200, {
    mode: 'home-assistant',
    configured: true,
    connected: !result?.__err,
    demo: false,
    canView: true,
    canControl: true,
    error: result?.__err ? safeHaError(result) : null,
  });
}

async function handleEntities(req, res) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
  const config = configuredHa();
  const raw = haFailure(await listHaStates(config), 'Unable to refresh Home Assistant entities.');
  if (!Array.isArray(raw)) {
    throw new DashboardHttpError(502, 'Home Assistant returned an invalid entity list.');
  }
  sendJson(res, 200, {
    mode: 'home-assistant', connected: true, entities: normalizeEntities(raw),
  });
}

async function handleCatalog(req, res) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
  configuredHa();
  if (!isHaWebSocketReady()) {
    throw new DashboardHttpError(503, 'Home Assistant device catalog is still connecting.');
  }
  let raw;
  try {
    const [areas, devices, entities] = await Promise.all([
      sendHaWebSocketCommand('config/area_registry/list'),
      sendHaWebSocketCommand('config/device_registry/list'),
      sendHaWebSocketCommand('config/entity_registry/list'),
    ]);
    raw = { areas, devices, entities };
  } catch (error) {
    throw new DashboardHttpError(502, safeHaError(error, 'Unable to refresh the Home Assistant device catalog.'));
  }
  sendJson(res, 200, {
    mode: 'home-assistant', connected: true, ...normalizeCatalog(raw),
  });
}

function weatherEntries(rawStates) {
  const entries = [];
  const seen = new Set();
  for (const raw of (Array.isArray(rawStates) ? rawStates : [])) {
    const entityId = raw?.entity_id ?? raw?.entityId;
    if (!isWeatherEntityId(entityId) || seen.has(entityId)) continue;
    const entity = normalizeEntity(raw);
    if (!entity) continue;
    seen.add(entityId);
    entries.push({ entity, raw });
    if (entries.length >= MAX_WEATHER_ENTITIES) break;
  }
  return entries;
}

function legacyWeatherResponse(entries) {
  const response = Object.create(null);
  for (const { entity, raw } of entries) {
    if (Array.isArray(raw?.attributes?.forecast)) {
      response[entity.entityId] = { forecast: raw.attributes.forecast };
    }
  }
  return response;
}

function mergeForecasts(entityIds, primary, fallback) {
  const preferred = new Map(primary.map(item => [item.entityId, item.forecast]));
  const secondary = new Map(fallback.map(item => [item.entityId, item.forecast]));
  return entityIds.map((entityId) => ({
    entityId,
    forecast: (preferred.get(entityId) || []).length
      ? preferred.get(entityId)
      : (secondary.get(entityId) || []),
  }));
}

function hasForecast(payload) {
  return payload?.forecasts?.some(item => Array.isArray(item.forecast) && item.forecast.length);
}

async function refreshWeather(config) {
  const rawStates = haFailure(await listHaStates(config), 'Unable to refresh Home Assistant weather.');
  if (!Array.isArray(rawStates)) {
    throw new DashboardHttpError(502, 'Home Assistant returned an invalid weather response.');
  }
  const entries = weatherEntries(rawStates);
  const entityIds = entries.map(entry => entry.entity.entityId);
  const legacy = normalizeWeatherForecasts(legacyWeatherResponse(entries), entityIds);
  const base = {
    mode: 'home-assistant', connected: true, type: 'daily', forecasts: legacy,
    stale: false, error: null,
  };
  const dailyEntityIds = entries
    .filter(entry => (Number(entry.entity.attributes.supported_features) & WEATHER_DAILY_FEATURE) !== 0)
    .map(entry => entry.entity.entityId);
  if (!dailyEntityIds.length) return base;

  const response = await haRequest(
    config,
    '/services/weather/get_forecasts?return_response',
    'POST',
    {
      entity_id: dailyEntityIds.length === 1 ? dailyEntityIds[0] : dailyEntityIds,
      type: 'daily',
    },
  );
  if (response?.__err) {
    const missing = legacy.some(item => !item.forecast.length);
    return { ...base, error: missing ? safeHaError(response, 'A daily weather forecast is not available.') : null };
  }
  const serviceResponse = response?.service_response;
  if (!serviceResponse || typeof serviceResponse !== 'object' || Array.isArray(serviceResponse)) {
    const missing = legacy.some(item => !item.forecast.length);
    return { ...base, error: missing ? 'Home Assistant returned an invalid weather forecast.' : null };
  }
  const official = normalizeWeatherForecasts(serviceResponse, dailyEntityIds);
  return { ...base, forecasts: mergeForecasts(entityIds, official, legacy) };
}

function weatherConfigKey(config) {
  return createHash('sha256')
    .update(`${config.url}\0${config.token}\0${config.allowSelfSigned ? '1' : '0'}`)
    .digest('hex');
}

async function cachedWeather(config) {
  const key = weatherConfigKey(config);
  const now = Date.now();
  if (weatherCache.key === key && weatherCache.value && weatherCache.expiresAt > now) {
    return weatherCache.value;
  }
  if (weatherCache.key === key && weatherCache.inFlight) return weatherCache.inFlight;
  const previous = weatherCache.key === key ? weatherCache.value : null;
  weatherCache.key = key;
  const refresh = (async () => {
    try {
      let payload = await refreshWeather(config);
      if (payload.error && hasForecast(previous)) {
        payload = { ...previous, connected: true, stale: true, error: payload.error };
      }
      if (weatherCache.key === key) {
        weatherCache.value = payload;
        weatherCache.expiresAt = Date.now()
          + (payload.error ? WEATHER_ERROR_CACHE_MS : WEATHER_CACHE_MS);
      }
      return payload;
    } catch (error) {
      if (hasForecast(previous)) {
        const payload = {
          ...previous,
          connected: false,
          stale: true,
          error: safeHaError(error, 'Unable to refresh Home Assistant weather.'),
        };
        if (weatherCache.key === key) {
          weatherCache.value = payload;
          weatherCache.expiresAt = Date.now() + WEATHER_ERROR_CACHE_MS;
        }
        return payload;
      }
      throw error;
    }
  })();
  weatherCache.inFlight = refresh;
  try { return await refresh; }
  finally { if (weatherCache.inFlight === refresh) weatherCache.inFlight = null; }
}

async function handleWeather(req, res) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
  const config = configuredHa();
  sendJson(res, 200, await cachedWeather(config));
}

function hasRuntimeAccess(userId) {
  if (isUserTimeBlocked(userId)) return false;
  const role = getUser(userId)?.role;
  return role === 'owner'
    || role === 'admin'
    || isSkillRuntimeEnabledForUser('role_home_assistant', userId);
}

function requireRuntimeAccess(userId) {
  if (!hasRuntimeAccess(userId)) {
    throw new DashboardHttpError(403, 'Home Assistant access is not available for this profile.');
  }
}

async function handleControl(req, res, userId) {
  if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return; }
  requireJsonContentType(req);
  const body = await readJsonBody(req, CONTROL_MAX_BYTES);
  const keys = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body)
    : [];
  if (!keys.includes('dashboardSlug')
    || keys.some(key => !['dashboardSlug', 'entityId', 'action', 'value'].includes(key))) {
    throw new DashboardHttpError(
      400,
      'Control body may contain only dashboardSlug, entityId, action, and optional value.',
    );
  }
  if (!isDashboardSlug(body.dashboardSlug)) {
    throw new DashboardHttpError(400, 'Control dashboardSlug is invalid.');
  }
  const mapping = resolveControl({
    entityId: body.entityId,
    action: body.action,
    ...(Object.prototype.hasOwnProperty.call(body, 'value') ? { value: body.value } : {}),
  });
  if (!mapping.ok) throw new DashboardHttpError(400, mapping.error);

  const paths = dashboardPathsForUser(userId);
  const owner = profileLabel(userId);
  await withLock(paths.registryPath, () => {
    // The body read and lock acquisition are asynchronous: recheck here so a
    // role revocation or newly-active curfew cannot race a slow client upload.
    requireRuntimeAccess(userId);
    const registry = loadRegistry(paths, owner);
    const metadata = dashboardMetadata(registry, body.dashboardSlug);
    if (!metadata) throw new DashboardHttpError(404, 'Dashboard not found.');
  });

  const config = configuredHa();
  const result = await callHaServiceAndConfirm({
    haCfg: config,
    domain: mapping.domain,
    service: mapping.service,
    entityId: mapping.entityId,
    data: mapping.data,
  });
  if (!result.accepted) {
    throw new DashboardHttpError(502, safeHaError(result.error, 'Home Assistant did not accept the command.'));
  }
  sendJson(res, 200, {
    ok: true,
    accepted: true,
    confirmed: result.confirmed,
    pending: result.pending,
    state: normalizeEntity(result.state),
  });
}

async function handleCamera(req, res, pathname) {
  if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
  const encodedEntityId = pathname.slice(CAMERA_API_PREFIX.length);
  let entityId;
  try { entityId = decodeURIComponent(encodedEntityId); }
  catch { throw new DashboardHttpError(400, 'Invalid camera entity ID.'); }
  if (!encodedEntityId || encodedEntityId.includes('/') || !isCameraEntityId(entityId)) {
    throw new DashboardHttpError(400, 'Invalid camera entity ID.');
  }
  const config = configuredHa();
  const image = await haRequestBinary(
    config,
    `/camera_proxy/${encodeURIComponent(entityId)}`,
    {
      timeoutMs: 10_000,
      maxBytes: CAMERA_MAX_BYTES,
      accept: 'image/jpeg, image/png, image/webp, image/gif',
    },
  );
  if (image?.__err) {
    throw new DashboardHttpError(502, safeHaError(image, 'Unable to load the Home Assistant camera image.'));
  }
  const contentType = String(image?.contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (!Buffer.isBuffer(image?.body) || image.body.length === 0 || !CAMERA_IMAGE_TYPES.has(contentType)) {
    throw new DashboardHttpError(502, 'Home Assistant returned an invalid camera image.');
  }
  if (image.body.length > CAMERA_MAX_BYTES) {
    throw new DashboardHttpError(502, 'Home Assistant camera image is too large.');
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': image.body.length,
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(image.body);
}

function matchingRoute(pathname) {
  if (pathname === WIDGET_CATALOG_PATH) return { kind: 'widget-catalog' };
  if (pathname.startsWith(WIDGET_RUNTIME_PREFIX)) {
    const encodedCardId = pathname.slice(WIDGET_RUNTIME_PREFIX.length);
    let cardId;
    try { cardId = decodeURIComponent(encodedCardId); }
    catch { throw new DashboardHttpError(400, 'Invalid dashboard widget card id.'); }
    if (!encodedCardId || encodedCardId.includes('/') || !SAFE_CARD_ID.test(cardId)) {
      throw new DashboardHttpError(400, 'Invalid dashboard widget card id.');
    }
    return { kind: 'widget-runtime', cardId };
  }
  if (pathname === `${RUNTIME_API_PREFIX}/status`) return 'status';
  if (pathname === `${RUNTIME_API_PREFIX}/entities`) return 'entities';
  if (pathname === `${RUNTIME_API_PREFIX}/catalog`) return 'catalog';
  if (pathname === `${RUNTIME_API_PREFIX}/weather`) return 'weather';
  if (pathname === `${RUNTIME_API_PREFIX}/control`) return 'control';
  if (pathname.startsWith(CAMERA_API_PREFIX)) return 'camera';
  return dashboardRoute(pathname);
}

export async function handle(req, res) {
  let url;
  let pathname;
  try {
    url = new URL(req.url || '/', 'http://localhost');
    pathname = url.pathname;
  }
  catch { return false; }

  let route;
  let routeError = null;
  try { route = matchingRoute(pathname); }
  catch (error) {
    if (!(error instanceof DashboardHttpError)) throw error;
    route = { kind: 'route-error' };
    routeError = error;
  }
  if (!route) return false;

  const userId = requireAuth(req, res, { allowMediaToken: false });
  if (!userId) return true;

  try {
    if (routeError) throw routeError;
    if (route === 'status') await handleStatus(req, res, userId);
    else if (typeof route === 'string') {
      requireRuntimeAccess(userId);
      if (route === 'entities') await handleEntities(req, res);
      else if (route === 'catalog') await handleCatalog(req, res);
      else if (route === 'weather') await handleWeather(req, res);
      else if (route === 'control') await handleControl(req, res, userId);
      else if (route === 'camera') await handleCamera(req, res, pathname);
    }
    else if (route.kind === 'widget-catalog') await handleWidgetCatalog(req, res, userId);
    else if (route.kind === 'widget-runtime') await handleWidgetRuntime(req, res, userId, url, route);
    else if (route.kind === 'not-found') sendJson(res, 404, { error: 'API endpoint not found.' });
    else {
      const paths = dashboardPathsForUser(userId);
      const owner = profileLabel(userId);
      if (route.kind === 'collection') {
        await handleDashboardCollection(req, res, paths, owner);
      } else {
        await handleDashboardItem(req, res, route, paths, owner);
      }
    }
  } catch (error) {
    if (error instanceof DashboardHttpError) {
      sendJson(res, error.status, { error: error.message }, error.headers || {});
    } else {
      console.error('[dashboards] request failed:', error);
      sendJson(res, 500, { error: 'Internal error' });
    }
  }
  return true;
}
