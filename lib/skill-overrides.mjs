// @ts-check
/**
 * Per-user skill overrides. Lets users:
 *  - disable a global or user-scoped skill (`disabled: true`)
 *  - hide specific tools from a skill (`hiddenTools: [name, name, ...]`)
 *
 * Applied at READ time inside roles.mjs `listRoles()` and `getRoleTools()`
 * — manifests stay immutable in the boot-loaded cache. No restart needed
 * to take effect.
 *
 * Always-on skills (manifest.always_on) cannot be fully disabled — those
 * are safety-net surfaces (coordinator, self-mgmt). Per-tool hiding still
 * works.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

function overridesPath(userId) {
  return path.join(USERS_DIR, userId, 'skill-overrides.json');
}
function deletedLogPath(userId) {
  return path.join(USERS_DIR, userId, 'skill-overrides.deleted.log');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

// Mtime-checked parse cache. listRoles() calls isSkillDisabled once per
// cached manifest per walk, and the prompt composer walks listRoles 2-4×
// per coordinator turn — without this, that's ~30 read+parse of the same
// file per turn. One statSync per read replaces the read+parse; in-process
// writes invalidate directly below, out-of-band edits are caught by mtime.
// Callers must not mutate the returned object without going through
// setSkillOverride/clearSkillOverride (which save and invalidate).
const _cache = new Map(); // userId -> { mtimeMs, data }

export function loadSkillOverrides(userId) {
  if (!userId) return {};
  const p = overridesPath(userId);
  let mtimeMs;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { _cache.delete(userId); return {}; }
  const hit = _cache.get(userId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  const data = readJsonSafe(p);
  _cache.set(userId, { mtimeMs, data });
  return data;
}

async function saveSkillOverrides(userId, data) {
  const p = overridesPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
  _cache.delete(userId);
}

/**
 * Is the skill disabled by the user? Returns true ONLY if disabled is set
 * AND the skill isn't always_on. always_on is a manifest property we read
 * from the cached registry — pass it in to avoid a module-level import
 * cycle (roles.mjs imports this file).
 */
export function isSkillDisabled(userId, skillId, manifestIsAlwaysOn) {
  if (!userId || !skillId) return false;
  const all = loadSkillOverrides(userId);
  const o = all[skillId];
  if (!o?.disabled) return false;
  if (manifestIsAlwaysOn) return false;   // safety net — can't disable always_on
  return true;
}

/** Returns the array of tool names the user has hidden, or [] if none. */
export function getHiddenTools(userId, skillId) {
  if (!userId || !skillId) return [];
  const all = loadSkillOverrides(userId);
  const o = all[skillId];
  return Array.isArray(o?.hiddenTools) ? o.hiddenTools : [];
}

/**
 * Strict unattended-automation gate. Unlike interactive catalog reads, a
 * corrupt override file must not look like "nothing disabled/hidden".
 */
export function assertSkillToolAutomationAllowed(userId, skillId, toolName, manifestIsAlwaysOn = false) {
  if (!userId || !skillId || !toolName) throw new Error('automation override check requires user, skill, and tool');
  const p = overridesPath(userId);
  let all;
  try {
    all = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return true;
    throw new Error(`skill overrides are unreadable: ${e?.message || e}`);
  }
  if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('skill overrides have an invalid envelope');
  const override = Object.hasOwn(all, skillId) ? all[skillId] : null;
  if (override == null) return true;
  if (typeof override !== 'object' || Array.isArray(override)) throw new Error('skill override is malformed');
  if (override.disabled === true && !manifestIsAlwaysOn) return false;
  if (Object.hasOwn(override, 'hiddenTools') && !Array.isArray(override.hiddenTools)) {
    throw new Error('skill hidden-tools override is malformed');
  }
  if (override.hiddenTools?.includes(toolName)) return false;
  return true;
}

/**
 * Set or update an override. Empty patch removes the override.
 * Returns { ok: true, override } on success.
 */
export async function setSkillOverride(userId, skillId, patch) {
  if (!userId || !skillId || !patch || typeof patch !== 'object') {
    return { ok: false, error: 'bad args' };
  }
  const all = loadSkillOverrides(userId);
  const existing = all[skillId] || {};
  const next = { ...existing };
  if ('disabled' in patch) next.disabled = !!patch.disabled;
  if ('hiddenTools' in patch) {
    next.hiddenTools = Array.isArray(patch.hiddenTools)
      ? patch.hiddenTools.filter(t => typeof t === 'string').slice(0, 100)
      : [];
  }
  // Empty override → drop the key
  if (!next.disabled && (!next.hiddenTools || next.hiddenTools.length === 0)) {
    delete all[skillId];
  } else {
    all[skillId] = next;
  }
  await saveSkillOverrides(userId, all);
  return { ok: true, override: all[skillId] || null };
}

/** Drop an override entirely. Writes a deleted-log audit entry. */
export async function clearSkillOverride(userId, skillId) {
  if (!userId || !skillId) return { ok: false, error: 'bad args' };
  const all = loadSkillOverrides(userId);
  if (!(skillId in all)) return { ok: false, error: 'not found' };
  const removed = all[skillId];
  try {
    fs.appendFileSync(deletedLogPath(userId), JSON.stringify({ ts: Date.now(), skillId, override: removed }) + '\n');
  } catch (e) {
    console.warn('[skill-overrides] deleted-log write failed:', e.message);
  }
  delete all[skillId];
  await saveSkillOverrides(userId, all);
  return { ok: true, removed: { skillId, ...removed } };
}

/** Flat list for the Learn panel. */
export function listSkillOverrides(userId) {
  const all = loadSkillOverrides(userId);
  return Object.entries(all).map(([skillId, o]) => ({
    skillId,
    disabled: !!o.disabled,
    hiddenTools: Array.isArray(o.hiddenTools) ? o.hiddenTools : [],
  }));
}
