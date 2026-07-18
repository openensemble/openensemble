// @ts-check
/**
 * Collection-watcher item CRUD. Bound to persistence via bindCollectionDeps().
 */
/** @type {any} */
let loadUserWatchers = () => null;
/** @type {any} */
let persistUser = () => false;
/** @type {any} */
let unregisterWatcher = () => false;

export function bindCollectionDeps(deps) {
  loadUserWatchers = deps.loadUserWatchers;
  persistUser = deps.persistUser;
  unregisterWatcher = deps.unregisterWatcher;
}

// ── collection-watcher item operations ───────────────────────────────────────
//
// Collection watchers store a flat `state.items` array of `{ id, cadenceSec,
// nextDueAt, ... }` objects. The parent watcher ticks at COLLECTION_TICK_SEC
// (60s); the handler filters items by `nextDueAt <= now`, processes due ones
// in bounded-concurrency parallel (via helpers.mapItems), and writes back
// `nextDueAt = now + cadenceSec * 1000`.
//
// These exports let the owning skill — or the generic list/update/remove tools
// in skills/tasks — mutate the items array without re-registering the parent
// watcher. The cadence floor (60s) lives here so changes via update_watch_item
// can't drop below what the supervisor sweep can deliver.
export const COLLECTION_TICK_SEC = 60;
export const ITEM_MIN_CADENCE_SEC = 60;

export function _findCollectionWatcher(userId, { watcherId, skillId, kind }) {
  // Use loadUserWatchers so out-of-process callers (CLI scripts, isolated
  // test harnesses) — and the in-process supervisor — get the same view.
  // _byUser starts empty in fresh processes; loadUserWatchers hydrates it
  // from disk on first read.
  const data = loadUserWatchers(userId);
  if (!data) return null;
  if (watcherId) return data.active.find(w => w.id === watcherId) ?? null;
  // (skillId, kind) is the natural key — there's one collection per pair.
  return data.active.find(w =>
    (w.skillId || null) === (skillId || null) && w.kind === kind && Array.isArray(w?.state?.items),
  ) ?? null;
}

export function _normalizeCadence(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < ITEM_MIN_CADENCE_SEC) return ITEM_MIN_CADENCE_SEC;
  return Math.floor(n);
}

/**
 * Append an item to a collection watcher's `state.items`. Pass
 * `{ requirePersist: true }` for standing grants or other mutations that must
 * roll back instead of reporting success when the disk write fails. Returns
 * { added: bool, item } — `added: false` means an item with the same `id` was
 * already present (the existing item is left untouched). Persists on add.
 */
export function addCollectionItem(userId, ref, item, opts = {}) {
  if (!item || typeof item !== 'object' || !item.id) {
    throw new Error('addCollectionItem: item.id required');
  }
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { added: false, item: null, error: 'collection watcher not found' };
  const items = w.state.items ||= [];
  if (items.some(x => x.id === item.id)) {
    return { added: false, item: items.find(x => x.id === item.id) };
  }
  const normalized = {
    ...item,
    cadenceSec: _normalizeCadence(item.cadenceSec),
    // First tick: due immediately so the user sees feedback on the next sweep
    // instead of waiting a full cadence period for the first poll.
    nextDueAt: 0,
    addedAt: Date.now(),
  };
  items.push(normalized);
  if (!persistUser(userId) && opts.requirePersist === true) {
    items.pop();
    return { added: false, item: null, error: 'collection watcher update could not be persisted' };
  }
  return { added: true, item: normalized };
}

/**
 * Remove an item by id. If the collection becomes empty, the parent watcher
 * is left in place (skill may add more later). Pass `{ finalizeIfEmpty: true }`
 * to instead cancel the parent on empty.
 */
export function removeCollectionItem(userId, ref, itemId, opts = {}) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { removed: false, error: 'collection watcher not found' };
  const items = w.state.items || [];
  const idx = items.findIndex(x => x.id === itemId);
  if (idx < 0) return { removed: false };
  items.splice(idx, 1);
  persistUser(userId);
  if (opts.finalizeIfEmpty && !items.length) {
    unregisterWatcher(userId, w.id, 'cancelled');
  }
  return { removed: true };
}

/**
 * Patch an item in place. `patch` is shallow-merged; passing `cadenceSec`
 * resets `nextDueAt = now` so the new cadence applies on the very next
 * supervisor sweep instead of waiting out the old cadence. Reserved fields
 * (`id`, `addedAt`) are ignored. `{ requirePersist: true }` makes the mutation
 * transactional with respect to the on-disk watcher envelope.
 */
export function updateCollectionItem(userId, ref, itemId, patch, opts = {}) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { updated: false, error: 'collection watcher not found' };
  const items = w.state.items || [];
  const it = items.find(x => x.id === itemId);
  if (!it) return { updated: false };
  const previous = opts.requirePersist === true ? JSON.parse(JSON.stringify(it)) : null;
  const { id: _ignore1, addedAt: _ignore2, ...rest } = patch || {};
  Object.assign(it, rest);
  if (Object.prototype.hasOwnProperty.call(rest, 'cadenceSec')) {
    it.cadenceSec = _normalizeCadence(it.cadenceSec);
    it.nextDueAt = 0;
  }
  if (!persistUser(userId) && opts.requirePersist === true) {
    const idx = items.indexOf(it);
    if (idx >= 0) items[idx] = previous;
    return { updated: false, error: 'collection watcher update could not be persisted' };
  }
  return { updated: true, item: it };
}

/**
 * Return the full items array (or null if no collection watcher found).
 * Caller treats result as read-only — mutating returned objects bypasses
 * persistence.
 */
export function listCollectionItems(userId, ref) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return null;
  return [...(w.state.items || [])];
}

export function getCollectionItem(userId, ref, itemId) {
  const items = listCollectionItems(userId, ref);
  if (!items) return null;
  return items.find(x => x.id === itemId) ?? null;
}

/**
 * Enumerate every collection watcher for this user, optionally filtered by
 * (skillId, kind). Returns `[{ watcherId, skillId, kind, label, items }, …]`.
 * Used by the generic `list_watch_items` tool.
 */
export function listAllCollections(userId, filter = {}) {
  const data = loadUserWatchers(userId);
  if (!data) return [];
  return data.active
    .filter(w =>
      Array.isArray(w?.state?.items) &&
      (!filter.skillId || (w.skillId || null) === filter.skillId) &&
      (!filter.kind || w.kind === filter.kind),
    )
    .map(w => ({
      watcherId: w.id,
      skillId: w.skillId || null,
      kind: w.kind,
      label: w.label,
      items: [...(w.state.items || [])],
    }));
}
