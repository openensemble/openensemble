// Snapshot cancellation ownership before an abort callback can retire records.
export function taskCancellationScope(taskId, userId, activeTasks, rootTaskGraphs) {
  const selected = activeTasks.get(taskId);
  if (!selected || selected.userId !== userId) return [];
  const targets = new Set([taskId]);
  const parents = new Map();
  for (const [id, rec] of activeTasks) {
    if (rec.userId === userId && rec.parentTaskId) parents.set(id, rec.parentTaskId);
  }
  for (const root of rootTaskGraphs.values()) {
    if (root.userId && root.userId !== userId) continue;
    const ownsRoot = root.rootTaskId === taskId
      || (selected.watcherId && root.rootTaskId === selected.watcherId)
      || root.completionOwnerTaskId === taskId;
    for (const [id, child] of root.children || []) {
      if (activeTasks.get(id)?.userId !== userId) continue;
      if (ownsRoot) targets.add(id);
      if (!parents.has(id) && child.parentTaskId) parents.set(id, child.parentTaskId);
    }
  }
  // A child owns only its descendants. Sharing a root does not make siblings
  // part of that child's cancellation scope. Set membership also bounds cycles.
  let added;
  do {
    added = false;
    for (const [id, parentId] of parents) {
      if (!targets.has(id) && targets.has(parentId)) {
        targets.add(id);
        added = true;
      }
    }
  } while (added);
  return [...targets];
}
