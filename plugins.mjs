/**
 * OpenEnsemble Drawer System
 * Loads drawers from plugins/ directory — each drawer has a manifest.json and optional server.mjs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { mayImportCustomCodeInProcess } from './lib/custom-code-policy.mjs';
import {
  deriveDrawerApiPrefixes,
  dispatchCustomDrawerRequest,
  stopAllDrawerWorkers,
  stopDrawerWorker,
  validateDrawerServerModule,
} from './lib/drawer-worker-runtime.mjs';

export {
  deriveDrawerApiPrefixes,
  stopAllDrawerWorkers,
  validateDrawerServerModule,
};

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
export const PLUGINS_DIR = path.join(__dirname, 'plugins');
export const DRAWER_TRANSACTION_COMMIT_FILE = '.drawer-transaction-committed.json';

const _manifests = new Map(); // id -> manifest
const _handlers  = new Map(); // id -> handleRequest fn | null

function readDrawerTransactionMarker(pluginDir) {
  const markerPath = path.join(pluginDir, DRAWER_TRANSACTION_COMMIT_FILE);
  try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch { return null; }
}

/**
 * Recover the only non-atomic window in a directory swap:
 *   live -> .rollback, then .stage -> live.
 *
 * A commit marker is written only after the new manifest is registered. If OE
 * dies before that marker, restore the rollback copy. If it dies after the
 * marker but before cleanup, retain the committed live copy and discard the
 * rollback. Staging/deletion tombstones remain ignored and can never become
 * live merely because OE restarted.
 */
function recoverDrawerTransactions() {
  if (!existsSync(PLUGINS_DIR)) return;
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^\.(.+)\.rollback-(\d+-[a-f0-9]+)$/.exec(entry.name);
    if (!match) continue;
    const [, pluginId, nonce] = match;
    const rollbackDir = path.join(PLUGINS_DIR, entry.name);
    let rollbackManifest;
    try {
      rollbackManifest = JSON.parse(
        fs.readFileSync(path.join(rollbackDir, 'manifest.json'), 'utf8'),
      );
    } catch (e) {
      console.error(`[drawers] Cannot recover ${entry.name}: ${e.message}`);
      continue;
    }
    if (rollbackManifest?.id !== pluginId) {
      console.error(`[drawers] Refusing rollback ${entry.name}: manifest.id mismatch`);
      continue;
    }
    const group = groups.get(pluginId) ?? [];
    group.push({
      nonce,
      rollbackDir,
      rollbackManifest,
      mtimeMs: fs.statSync(rollbackDir).mtimeMs,
    });
    groups.set(pluginId, group);
  }

  for (const [pluginId, records] of groups) {
    const liveDir = path.join(PLUGINS_DIR, pluginId);
    const marker = existsSync(liveDir) ? readDrawerTransactionMarker(liveDir) : null;
    const committed = marker?.pluginId === pluginId
      && records.some(record => record.nonce === marker.nonce);
    try {
      stopDrawerWorker(pluginId);
      if (committed) {
        // A current commit marker supersedes every older rollback artifact for
        // this plugin, not merely the immediately matching one. Otherwise a
        // stale older copy could roll a later update backward on the next boot.
        for (const record of records) {
          fs.rmSync(record.rollbackDir, { recursive: true, force: true });
        }
        fs.rmSync(path.join(liveDir, DRAWER_TRANSACTION_COMMIT_FILE), { force: true });
        console.warn(`[drawers] Recovered committed drawer transaction ${pluginId}`);
        continue;
      }

      if (records.length > 1 && existsSync(liveDir)) {
        // Without a commit marker there is no safe way to order multiple old
        // copies against a canonical live tree. Fail closed: keep the live
        // drawer and all recovery evidence instead of guessing destructively.
        console.error(
          `[drawers] Ambiguous rollback set for ${pluginId}; retaining live drawer and ${records.length} recovery copies`,
        );
        continue;
      }

      records.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const [chosen, ...older] = records;
      if (!existsSync(liveDir)) {
        fs.renameSync(chosen.rollbackDir, liveDir);
        for (const record of older) {
          fs.rmSync(record.rollbackDir, { recursive: true, force: true });
        }
        console.warn(`[drawers] Restored interrupted drawer transaction ${pluginId}`);
        continue;
      }

      const discardDir = path.join(
        PLUGINS_DIR,
        `.${pluginId}.recovery-discard-${process.pid}-${Date.now()}`,
      );
      fs.renameSync(liveDir, discardDir);
      try {
        fs.renameSync(chosen.rollbackDir, liveDir);
        fs.rmSync(discardDir, { recursive: true, force: true });
        console.warn(`[drawers] Rolled back uncommitted drawer transaction ${pluginId}`);
      } catch (e) {
        if (!existsSync(liveDir) && existsSync(discardDir)) {
          fs.renameSync(discardDir, liveDir);
        }
        throw e;
      }
    } catch (e) {
      console.error(`[drawers] Transaction recovery failed (${pluginId}): ${e.message}`);
    }
  }

  // A committed create has no prior directory and therefore no rollback
  // group. Its marker is only a crash breadcrumb; the canonical tree is the
  // authoritative committed copy.
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || groups.has(entry.name)) continue;
    const markerPath = path.join(PLUGINS_DIR, entry.name, DRAWER_TRANSACTION_COMMIT_FILE);
    if (existsSync(markerPath)) {
      try { fs.rmSync(markerPath, { force: true }); } catch {}
    }
  }
}

export function loadDrawerManifests() {
  if (!existsSync(PLUGINS_DIR)) return;
  recoverDrawerTransactions();
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Skill-builder stages atomic drawer transactions in dot-prefixed sibling
    // directories. A crash must never make one of those candidates live.
    if (entry.name.startsWith('.')) continue;
    const mpath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
    if (!existsSync(mpath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
      if (m?.id !== entry.name) {
        console.error(`[drawers] Refusing ${entry.name}: manifest.id must match its directory name`);
        continue;
      }
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
  if (typeof manifest.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(manifest.id)) {
    throw new Error('Drawer manifest id contains unsupported characters');
  }
  stopDrawerWorker(manifest.id);
  _manifests.set(manifest.id, { ...manifest });
  // Bust any previously cached handler so a fresh server.mjs gets re-imported.
  _handlers.delete(manifest.id);
}

/** Remove a drawer manifest and its cached handler. */
export function unregisterDrawerManifest(id) {
  stopDrawerWorker(id);
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
//
// Custom (skill-builder) drawers are scoped to their creator: their handler
// only runs if the request's authenticated user matches `createdBy`. Without
// this scope, user A's drawer manifest could intercept user B's HTTP requests
// because every drawer is consulted for every URL. Built-in / non-custom
// drawers (news, markets, tutor-today) remain global.
export async function delegateDrawerRequest(req, res, cfg) {
  const reqUserId = cfg?.userId ?? null;
  for (const [id, manifest] of _manifests) {
    if (manifest?.custom === true) {
      // A custom drawer without a valid owner is never globally reachable.
      // Re-check on every request (including cache hits) so revocation or an
      // account-role change immediately prevents both import and execution.
      if (!manifest.createdBy
          || !mayImportCustomCodeInProcess(manifest.createdBy, manifest.skillId)) {
        _handlers.delete(id);
        stopDrawerWorker(id);
        continue;
      }
      // A request for another account is merely out of scope; it must not tear
      // down the creator's live worker and disrupt that user's in-flight work.
      if (manifest.createdBy !== reqUserId) continue;

      // Custom modules never enter the OE process. Prefix-checking, body caps,
      // timeouts, and response capture all happen in the worker runtime.
      try {
        const hpath = path.join(PLUGINS_DIR, id, 'server.mjs');
        const handled = await dispatchCustomDrawerRequest(manifest, hpath, req, res, cfg);
        if (handled) return true;
      } catch (e) {
        // The worker runtime is designed to return a captured 5xx itself, but
        // keep this final containment boundary so a custom drawer can never
        // reject through the main HTTP route dispatcher.
        console.error(`[drawers] Worker dispatch error (${id}): ${e.message}`);
        if (!res.headersSent) {
          try {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Custom drawer server failed' }));
          } catch {}
        } else {
          try { res.end(); } catch {}
        }
        return true;
      }
      continue;
    }
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
