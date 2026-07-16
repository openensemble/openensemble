// @ts-check
/**
 * Small, dependency-free authorization boundary for custom code paths that
 * cannot use roles.mjs without creating an import cycle (skill smoke and
 * drawer plugins).  This is deliberately fail closed: an absent or malformed
 * profile must never turn into permission to import user-authored code in the
 * OE process.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

/**
 * Whether user-authored code for `skillId` may be imported in the main OE
 * process. Children always remain isolated, even when a parent has allowed the
 * skill itself. For an ordinary managed account, both its active-skill list
 * and explicit allowlist remain ceilings. Owner/admin accounts are trusted.
 *
 * @param {string|null|undefined} userId
 * @param {string|null|undefined} skillId
 */
export function mayImportCustomCodeInProcess(userId, skillId) {
  if (!userId) return false;

  /** @type {any} */
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(path.join(USERS_DIR, userId, 'profile.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!profile || typeof profile !== 'object' || profile.id !== userId) return false;
  if (profile.role === 'owner' || profile.role === 'admin') return true;
  if (profile.role === 'child') return false;

  // Explicit account restrictions remain authoritative for regular users.
  // Null/missing fields are the legacy unrestricted adult shape.
  if (profile.allowedSkills != null) {
    if (!Array.isArray(profile.allowedSkills)) return false;
    if (!skillId || !profile.allowedSkills.includes(skillId)) return false;
  }
  if (Array.isArray(profile.skills) && skillId && !profile.skills.includes(skillId)) return false;
  return true;
}
