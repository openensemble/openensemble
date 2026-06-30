// @ts-check
/**
 * Turn-trace reader (Phase 3 surfacing). Reconstructs turns from the
 * `tag:"turn"` records the spine writes to logs/app.log (see
 * lib/turn-trace-context.mjs), groups them by rootId into trees, and joins the
 * per-user telemetry streams (invocation / router-mistake / correction events)
 * that now carry a `turnId`. Read-only; shared by the admin route
 * (GET /api/admin/turns) and the logs skill (read_turns) so both agree.
 *
 * Records are metadata-only and small (well under app.log's redaction limits),
 * so a tail scan + in-memory group is plenty — no separate index needed.
 */
import { readLog } from '../logger.mjs';
import { loadInvocationEvents } from './invocation-events.mjs';
import { loadMistakes } from './router-mistakes.mjs';
import { loadCorrectionEvents } from './correction-events.mjs';

const DEFAULT_TAIL = 4000;

/**
 * Pull turn-trace metadata objects from app.log (readLog returns newest-last).
 * @param {{ tail?: number, since?: number }} [opts]
 */
function loadTurns({ tail = DEFAULT_TAIL, since } = {}) {
  const { entries } = readLog({ file: 'app', tail, since });
  return entries
    .filter(e => e.tag === 'turn' && e.meta && e.meta.turnId)
    .map(e => e.meta);
}

function sumTok(spans, key) {
  return spans.reduce((n, s) => n + (Number(s?.[key]) || 0), 0);
}

/**
 * Group recent turns into per-rootId trees, newest tree first. Each tree
 * summary rolls up agents, delegation edges, tool calls, token totals, errors
 * and wall time across all turns sharing a rootId.
 * @param {{ tail?: number, since?: number, userId?: string|null, limit?: number }} [opts]
 */
export function listTurnTrees({ tail, since, userId = null, limit = 50 } = {}) {
  let turns = loadTurns({ tail, since });
  if (userId) turns = turns.filter(t => t.userId === userId);

  const byRoot = new Map();
  for (const t of turns) {
    const k = t.rootId || t.turnId;
    if (!byRoot.has(k)) byRoot.set(k, []);
    byRoot.get(k).push(t);
  }

  const trees = [...byRoot.entries()].map(([rootId, ts]) => {
    ts.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const spans = ts.flatMap(t => t.spans || []);
    const delegations = ts.flatMap(t => t.delegations || []);
    const errors = ts.flatMap(t => t.errors || []);
    return {
      rootId,
      startedAt: ts[0]?.startedAt ?? null,
      startedAtIso: ts[0]?.startedAt ? new Date(ts[0].startedAt).toISOString() : null,
      userId: ts[0]?.userId ?? null,
      source: ts[0]?.source ?? null,
      routing: ts[0]?.routing ?? null,
      turnCount: ts.length,
      turnIds: ts.map(t => t.turnId),
      agents: [...new Set(spans.map(s => s.agent).filter(Boolean))],
      providers: [...new Set(spans.map(s => s.provider).filter(Boolean))],
      spanCount: spans.length,
      delegations: delegations.map(d => `${d.from} → ${d.to}${d.background ? ' (bg)' : ''}`),
      toolCalls: spans.flatMap(s => (s.toolCalls || []).map(c => c.name)),
      inTok: sumTok(spans, 'inTok'),
      outTok: sumTok(spans, 'outTok'),
      errorCount: errors.length,
      durationMs: Math.max(0, ...ts.map(t => t.durationMs || 0)),
    };
  });

  trees.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return trees.slice(0, Math.max(1, limit));
}

/** Per-user telemetry records (now turnId-stamped) that belong to this turn set. */
function joinTelemetry(userId, turnIdSet) {
  const pick = (arr) => (Array.isArray(arr) ? arr.filter(r => r && turnIdSet.has(r.turnId)) : []);
  try {
    return {
      invocations: pick(loadInvocationEvents(userId)),
      routerMistakes: pick(loadMistakes(userId)),
      corrections: pick(loadCorrectionEvents(userId)),
    };
  } catch (e) {
    return { invocations: [], routerMistakes: [], corrections: [], joinError: e.message };
  }
}

/**
 * Full detail for one turnId OR rootId: every turn in that tree (chronological)
 * plus the joined telemetry. Returns null if the id isn't found in the scanned
 * window. `join:false` skips the telemetry lookup.
 */
export function getTurnDetail(id, { tail = DEFAULT_TAIL, join = true } = {}) {
  if (!id) return null;
  const turns = loadTurns({ tail });
  // Tolerate a prefix-less id (e.g. "ab12…" for "t_ab12…") — a caller/LLM may
  // echo back the id without the t_ prefix.
  const norm = String(id).trim();
  const cands = norm.startsWith('t_') ? [norm] : [norm, 't_' + norm];
  const exact = turns.find(t => cands.includes(t.turnId));
  const rootId = exact?.rootId
    || turns.find(t => cands.includes(t.rootId || t.turnId))?.rootId
    || cands[cands.length - 1];
  // A backgrounded delegation detaches its child into a separate trace whose
  // rootId === the bg taskId recorded on the parent's delegation edge. Walk
  // those links (BFS, multi-level) so one detail view shows the whole tree —
  // the parent turn AND its backgrounded children — not just the rootId group.
  const rootIds = new Set([rootId]);
  for (let added = true; added; ) {
    added = false;
    for (const t of turns) {
      if (!rootIds.has(t.rootId || t.turnId)) continue;
      for (const d of (t.delegations || [])) {
        if (d.taskId && !rootIds.has(d.taskId)) { rootIds.add(d.taskId); added = true; }
      }
    }
  }
  const tree = turns.filter(t => rootIds.has(t.rootId || t.turnId));
  if (!tree.length) return null;
  tree.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const userId = tree[0]?.userId ?? exact?.userId ?? null;
  const turnIdSet = new Set(tree.map(t => t.turnId));
  return {
    rootId,
    userId,
    matched: exact ? 'turnId' : 'rootId',
    turns: tree,
    joined: join && userId ? joinTelemetry(userId, turnIdSet) : null,
  };
}
