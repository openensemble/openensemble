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

export function loadSkillOverrides(userId) {
  if (!userId) return {};
  return readJsonSafe(overridesPath(userId));
}

async function saveSkillOverrides(userId, data) {
  const p = overridesPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
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
