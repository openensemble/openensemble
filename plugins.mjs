/**
 * OpenEnsemble Drawer System
 * Loads drawers from plugins/ directory — each drawer has a manifest.json and optional server.mjs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
export const PLUGINS_DIR = path.join(__dirname, 'plugins');

const _manifests = new Map(); // id -> manifest
const _handlers  = new Map(); // id -> handleRequest fn | null

export function loadDrawerManifests() {
  if (!existsSync(PLUGINS_DIR)) return;
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mpath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
    if (!existsSync(mpath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
      _manifests.set(m.id, { ...m });
    } catch (e) {
      console.error(`[drawers] Failed to load ${entry.name}: ${e.message}`);
    }
  }
  if (_manifests.size) console.log(`[drawers] Loaded: ${[..._manifests.keys()].join(', ')}`);
}

export function listDrawers() {
  return [..._manifests.values()];
}

export function getDrawer(id) {
  return _manifests.get(id) ?? null;
}

/** Register (or replace) a drawer manifest at runtime. Used by skill-builder. */
export function registerDrawerManifest(manifest) {
  if (!manifest?.id) throw new Error('Drawer manifest must have an id');
  _manifests.set(manifest.id, { ...manifest });
  // Bust any previously cached handler so a fresh server.mjs gets re-imported.
  _handlers.delete(manifest.id);
}

/** Remove a drawer manifest and its cached handler. */
export function unregisterDrawerManifest(id) {
  _manifests.delete(id);
  _handlers.delete(id);
}

// Built-in drawers that are not file-based plugins but still gated by allowedFeatures
const BUILTIN_FEATURES = [
  { id: 'inbox',    name: 'Inbox',        icon: '📧', drawer: true, drawerId: 'drawerInbox',    btnId: 'sbtnInbox',    builtin: true },
  { id: 'notes',    name: 'Shared Notes', icon: '📝', drawer: true, drawerId: 'drawerNotes',    btnId: 'sbtnNotes',    builtin: true },
  { id: 'expenses', name: 'Expenses',     icon: '💰', drawer: true, drawerId: 'drawerExpenses', btnId: 'sbtnExpenses', builtin: true },
  { id: 'tasks',    name: 'Tasks',        icon: '✅', drawer: true, drawerId: 'drawerTasks',    btnId: 'sbtnTasks',    builtin: true },
];

// Merge drawer defaults with per-user overrides stored in user.pluginPrefs
export function getDrawerPrefsForUser(user, drawerId) {
  const plugin = _manifests.get(drawerId);
  if (!plugin) return null;
  const saved   = user?.pluginPrefs?.[drawerId] ?? {};
  const enabled  = saved.enabled  ?? plugin.enabled_by_default ?? true;
  const settings = { ...(plugin.defaultSettings ?? {}), ...(saved.settings ?? {}) };
  // Backwards-compat: sync defaultTopic from legacy user.newsDefaultTopic
  if (drawerId === 'news' && typeof user?.newsDefaultTopic === 'number' && saved.settings?.defaultTopic === undefined) {
    settings.defaultTopic = user.newsDefaultTopic;
  }
  return { enabled, settings };
}

// All features (built-ins + drawers) with user-specific enabled state merged in.
// user.allowedFeatures:  null = unrestricted (owner/admin default)
//                        []   = nothing enabled (new user default)
//                        ['expenses','notes',...] = only these enabled
export function getDrawersForUser(user) {
  const allowed = user?.allowedFeatures ?? null; // null = no restriction
  const builtins = BUILTIN_FEATURES.map(p => {
    const adminBlocked = allowed !== null && !allowed.includes(p.id);
    return { ...p, enabled: !adminBlocked, adminBlocked };
  });
  const fileDrawers = listDrawers()
    // Custom (skill-builder) drawers are visible only to their creator.
    .filter(p => !p.custom || p.createdBy === user?.id)
    .map(p => {
      const prefs = getDrawerPrefsForUser(user, p.id);
      const adminBlocked = allowed !== null && !allowed.includes(p.id);
      if (adminBlocked) prefs.enabled = false;
      return { ...p, ...prefs, adminBlocked };
    });
  return [...builtins, ...fileDrawers];
}

// Route an incoming HTTP request to the matching drawer handler.
// Returns true if a drawer handled it, false otherwise.
export async function delegateDrawerRequest(req, res, cfg) {
  for (const [id] of _manifests) {
    // Lazy-load each plugin's server.mjs handler
    if (!_handlers.has(id)) {
      const hpath = path.join(PLUGINS_DIR, id, 'server.mjs');
      if (existsSync(hpath)) {
        try {
          // Cachebust on each fresh load so skill-builder hot-reloads work.
          const url = pathToFileURL(hpath).href + `?t=${Date.now()}`;
          const mod = await import(url);
          _handlers.set(id, mod.handleRequest ?? null);
        } catch (e) {
          console.error(`[drawers] Handler load error (${id}): ${e.message}`);
          _handlers.set(id, null);
        }
      } else {
        _handlers.set(id, null);
      }
    }
    const handler = _handlers.get(id);
    if (!handler) continue;
    const handled = await handler(req, res, cfg);
    if (handled) return true;
  }
  return false;
}
