// @ts-check
/**
 * Per-user profile.json reader (skill authorization ceiling).
 * Extracted from roles.mjs — pure move.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';

export function _readUserProfile(userId) {
  if (!userId) return null;
  try {
    const p = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(p)) return null;
    const profile = JSON.parse(readFileSync(p, 'utf8'));
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    if (profile.id !== userId || !['owner', 'admin', 'user', 'child'].includes(profile.role)) return null;
    return profile;
  } catch { return null; }
}
