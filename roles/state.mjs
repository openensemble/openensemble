// @ts-check
/**
 * Shared skill registry maps + key helpers.
 */


// Wrapper shape: { manifest, userId, dir }
//   userId: null for global, userId string for per-user
//   dir:    absolute path to the skill directory on disk
export const _manifests    = new Map();  // internalKey -> wrapper
export const _executors    = new Map();  // internalKey -> execute function
export const _executorBust = new Map();  // internalKey -> bust timestamp

export const globalKey = id => `global:${id}`;
export const userKey   = (uid, id) => `user:${uid}:${id}`;

// Try resolving an id in the user's scope first, then globally. Returns internalKey or null.
export function resolveKey(id, userId) {
  if (userId) {
    const uk = userKey(userId, id);
    if (_manifests.has(uk)) return uk;
  }
  const gk = globalKey(id);
  if (_manifests.has(gk)) return gk;
  return null;
}

// Iterate entries visible to a given caller: globals + that user's own skills.
// Used by execution paths so a user can never reach another user's tool.
export function* visibleEntries(userId) {
  for (const [key, wrap] of _manifests) {
    if (wrap.userId === null || wrap.userId === userId) yield [key, wrap];
  }
}

