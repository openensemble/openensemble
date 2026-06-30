// @ts-check
/**
 * Turn metrics aggregator — the "local-first wins" dashboard slice. Reads
 * recent turn trees from lib/turn-trace-reader.mjs and rolls them into the
 * headline numbers an owner cares about: how many turns OE handled locally
 * (no cloud LLM call), latency percentiles, token totals by provider, and the
 * slowest agents.
 *
 * Aggregate-only and metadata-only: the underlying `tag:"turn"` records never
 * carry prompts, message bodies, or raw tool arguments, so neither does this.
 *
 * Classification per turn (kept deliberately honest — we do NOT inflate the
 * local count when we can't tell):
 *   - routing.llmAvoided === true            → 'llmAvoided' (a fast-path / local
 *                                              intent handled it; no LLM ran)
 *   - an LLM ran, every span provider local  → 'localLlm'
 *   - an LLM ran, any span provider cloud    → 'cloud'
 *   - an LLM ran but no provider recorded    → 'unknown'
 * "Cloud calls avoided" = llmAvoided + localLlm. Unknown is reported separately
 * rather than silently credited to either side.
 *
 * Prompt-cache hit rate and tool-router savings ARE reported (cache read tokens
 * captured per provider, tool-router full/kept/dropped rolled up from spans).
 * Cost/$ estimation is deliberately OUT — a maintained per-model pricing table
 * isn't worth it, and on flat-fee plans a dollar figure is fiction. The
 * cache/tool-router numbers stand on their own as latency/efficiency signals.
 */
import { listTurnTrees } from './turn-trace-reader.mjs';

// Self-hosted / on-box inference. Everything NOT in this set (anthropic,
// openrouter, openai, groq, deepseek, …) is treated as a billed cloud call —
// unknown providers default to cloud so we never over-credit local savings.
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llama', 'llamacpp', 'llama-cpp', 'local']);

const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const DEFAULT_RANGE = '24h';

/** @param {string|null|undefined} p */
function isCloudProvider(p) {
  if (!p) return false;
  const s = String(p).toLowerCase();
  if (LOCAL_PROVIDERS.has(s)) return false;
  if (/(localhost|127\.0\.0\.1|::1|local)/.test(s)) return false;
  return true;
}

/** Nearest-rank percentile over an ascending-sorted array. */
function pct(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * Aggregate recent turns into local-first metrics for a time window.
 * @param {{ range?: string, now?: number, userId?: string|null }} [opts]
 */
export function computeTurnMetrics({ range = DEFAULT_RANGE, now = Date.now(), userId = null } = {}) {
  const windowMs = RANGE_MS[range] ?? RANGE_MS[DEFAULT_RANGE];
  const since = now - windowMs;
  // Scan generously; `since` trims to the window. A single-user day of turns is
  // well under this, and listTurnTrees caps the log read internally.
  const trees = listTurnTrees({ tail: 50000, since, userId, limit: 100000 });

  let llmAvoided = 0, localLlm = 0, cloud = 0, unknown = 0;
  let inTok = 0, outTok = 0, errors = 0;
  let cachedTok = 0, cacheCreateTok = 0;
  let trFull = 0, trKept = 0, trDropped = 0, trDroppedBytes = 0, trTurns = 0, trRecoveries = 0;
  /** @type {number[]} */
  const latencies = [];
  /** @type {Map<string, { agent: string, turns: number, totalMs: number }>} */
  const byAgent = new Map();
  /** @type {Map<string, { provider: string, turns: number, inTok: number, outTok: number, cachedTok: number }>} */
  const byProvider = new Map();
  /** @type {Map<string, number>} */
  const byLocalHandler = new Map();

  for (const t of trees) {
    const r = t.routing || {};
    const providers = t.providers || [];

    if (r.llmAvoided === true) {
      llmAvoided++;
      const h = r.localHandler || r.fastPath || r.mode || 'local';
      byLocalHandler.set(h, (byLocalHandler.get(h) || 0) + 1);
    } else if (providers.length === 0) {
      unknown++;
    } else if (providers.some(isCloudProvider)) {
      cloud++;
    } else {
      localLlm++;
    }

    inTok += t.inTok || 0;
    outTok += t.outTok || 0;
    cachedTok += t.cachedTok || 0;
    cacheCreateTok += t.cacheCreateTok || 0;
    errors += t.errorCount || 0;
    if (t.durationMs) latencies.push(t.durationMs);

    const tr = t.toolRouter;
    if (tr) {
      trTurns++;
      trFull += tr.full || 0; trKept += tr.kept || 0;
      trDropped += tr.dropped || 0; trDroppedBytes += tr.droppedBytes || 0;
      if (tr.recovered) trRecoveries++;
    }

    for (const a of (t.agents || [])) {
      const cur = byAgent.get(a) || { agent: a, turns: 0, totalMs: 0 };
      cur.turns++; cur.totalMs += t.durationMs || 0;
      byAgent.set(a, cur);
    }
    for (const p of providers) {
      const cur = byProvider.get(p) || { provider: p, turns: 0, inTok: 0, outTok: 0, cachedTok: 0 };
      cur.turns++; cur.inTok += t.inTok || 0; cur.outTok += t.outTok || 0; cur.cachedTok += t.cachedTok || 0;
      byProvider.set(p, cur);
    }
  }

  latencies.sort((a, b) => a - b);
  const totalTurns = trees.length;
  const cloudCallsAvoided = llmAvoided + localLlm;

  // Provider-aware cache hit rate. OpenAI's prompt_tokens already INCLUDES cache
  // hits, so its presented input is inTok. Anthropic reports input_tokens as the
  // UNCACHED remainder with cache reads counted separately, so its presented
  // input is inTok + cachedTok. Normalizing keeps hit% honest across a window
  // that mixes both — without it Anthropic would read far too high.
  const presentedInput = (provider, inT, cacheT) =>
    String(provider || '').toLowerCase().includes('anthropic') ? inT + cacheT : inT;
  const providerRows = [...byProvider.values()]
    .map(r => {
      const tot = presentedInput(r.provider, r.inTok, r.cachedTok);
      return { ...r, cacheHitPct: tot ? Math.round((r.cachedTok / tot) * 100) : 0 };
    })
    .sort((a, b) => b.turns - a.turns);
  const presentedInTok = [...byProvider.values()]
    .reduce((n, r) => n + presentedInput(r.provider, r.inTok, r.cachedTok), 0);

  return {
    range,
    sinceIso: new Date(since).toISOString(),
    generatedAtIso: new Date(now).toISOString(),
    totals: {
      turns: totalTurns,
      llmAvoidedTurns: llmAvoided,
      localLlmTurns: localLlm,
      cloudTurns: cloud,
      unknownTurns: unknown,
      cloudCallsAvoided,
      cloudCallsAvoidedPct: totalTurns ? Math.round((cloudCallsAvoided / totalTurns) * 100) : 0,
    },
    tokens: { inTok, outTok },
    cache: {
      cacheReadTok: cachedTok,
      cacheCreateTok,
      presentedInTok,
      hitPct: presentedInTok ? Math.round((cachedTok / presentedInTok) * 100) : 0,
    },
    toolRouter: {
      turns: trTurns,
      fullTools: trFull,
      keptTools: trKept,
      droppedTools: trDropped,
      droppedBytes: trDroppedBytes,
      trimmedPct: trFull ? Math.round((trDropped / trFull) * 100) : 0,
      recoveries: trRecoveries,
    },
    latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: latencies[latencies.length - 1] || 0 },
    byLocalHandler: [...byLocalHandler.entries()]
      .map(([handler, turns]) => ({ handler, turns }))
      .sort((a, b) => b.turns - a.turns),
    byProvider: providerRows,
    slowestAgents: [...byAgent.values()]
      .map(a => ({ agent: a.agent, turns: a.turns, avgMs: a.turns ? Math.round(a.totalMs / a.turns) : 0, totalMs: a.totalMs }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, 10),
    errors,
  };
}
