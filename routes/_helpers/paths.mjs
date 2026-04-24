/**
 * Path constants and ID helpers.
 *
 * Leaf module — imports nothing from _helpers.mjs, so extracted submodules
 * can safely depend on these values at top-level without circular-import TDZ.
 */

import path from 'path';
import { BASE_DIR as _BASE_DIR } from '../../lib/paths.mjs';

// Sourced from lib/paths.mjs so the vitest-aware tmp redirect applies here too.
export const BASE_DIR = _BASE_DIR;

export { APP_NAME, BASE_DIR as APP_BASE_DIR } from '../../lib/paths.mjs';

/** Sanitize an ID for safe filesystem use. */
export function safeId(id) { return (id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_'); }

export const CFG_PATH          = path.join(BASE_DIR, 'config.json');
export const USERS_PATH        = path.join(BASE_DIR, 'users.json'); // kept for legacy backup compat
export const USERS_DIR         = path.join(BASE_DIR, 'users');
export const ACTIVITY_DIR      = path.join(BASE_DIR, 'activity'); // legacy — kept for migration compat

/** Returns the per-user data directory: ~/.openensemble/users/{userId}/ */
export function getUserDir(userId) {
  return path.join(BASE_DIR, 'users', userId);
}
export const NOTES_PATH        = path.join(BASE_DIR, 'shared-notes.json');
export const INVITES_PATH      = path.join(BASE_DIR, 'invites.json');
export const SESSIONS_PATH     = path.join(BASE_DIR, 'active-sessions.json');
export const EXPENSES_DB       = path.join(BASE_DIR, 'expenses/transactions.json');
export const EXPENSES_UPLOADS  = path.join(BASE_DIR, 'expenses/uploads');
export const EXPENSE_GROUPS_PATH = path.join(BASE_DIR, 'expenses/groups.json');
export const EXPENSE_BOOKS_PATH  = path.join(BASE_DIR, 'expenses/books.json');
export const BODY_LIMIT        = 1024 * 512; // 512 KB
