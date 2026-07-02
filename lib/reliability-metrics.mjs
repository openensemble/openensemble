// @ts-check
/**
 * Reliability metrics aggregator — the failure-rate dashboard slice. Reads raw
 * turn metas from lib/turn-trace-reader.mjs and rolls the honest per-tool
 * status (ok/ms, trustworthy since the trace-honesty fix in lib/tool-error.mjs)
 * into failure rates by tool, skill, provider, and agent, plus a recent-errors
 * feed — the surface the trace-honesty work was collected for.
 *
 * Aggregate-only and metadata-only, same contract as lib/turn-metrics.mjs: the
 * underlying `tag:"turn"` records never carry prompts or raw tool args, and the
 * turn-level error strings are already truncated at record time.
 *
 * Counting rules:
 *   - toolCall failure  = `ok !== true` on a span toolCall. Calls flagged
 *     `delegated` are SKIPPED: an inline-delegated tool event streams through
 *     the parent span AND is recorded on the delegate's own span — counting
 *     both would double every delegated call.
 *   - provider error    = span.error set (the whole LLM run errored).
 *   - skill attribution = manifest tool name → skill id via buildToolSkillMap;
 *     `mcp_<serverId>__<tool>` names fall back to `mcp:<serverId>`, anything
 *     else to '(other)' (provider-native tools, control-plane, etc.).
 */
import { listTurns } from './turn-trace-reader.mjs';

const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const DEFAULT_RANGE = '24h';

// Turn-level tool-error strings are written as `tool <name>: <message>`
// (chat.mjs tool_result handler) — parse them back out for per-tool samples.
const TOOL_ERR_RE = /^tool ([\w.-]+): ?(.*)$/s;

/**
 * Map every manifest tool name to its owning skill id. First manifest wins on
 * duplicate tool names — listAllRoles() yields globals before user-scoped
 * customs, so a global skill's claim beats a same-named custom tool.
 * @param {Array<{ id?: string, tools?: Array<{ function?: { name?: string } }> }>} manifests
 */
export function buildToolSkillMap(manifests) {
  const map = new Map();
  for (const m of manifests || []) {
    if (!m?.id) continue;
    for (const t of m.tools || []) {
      const name = t?.function?.name;
      if (name && !map.has(name)) map.set(name, m.id);
    }
  }
  return map;
}

/**
 * Aggregate recent turns into reliability metrics for a time window.
 * @param {{ range?: string, now?: number, userId?: string|null,
 *           turns?: Array<any>|null, toolSkillMap?: Map<string,string>|null }} [opts]
 *   `turns` injects a pre-loaded turn list (tests); when set, the range window
 *   is not re-applied. `toolSkillMap` comes from buildToolSkillMap.
 */
export function computeReliabilityMetrics({ range = DEFAULT_RANGE, now = Date.now(), userId = null, turns = null, toolSkillMap = null } = {}) {
  const windowMs = RANGE_MS[range] ?? RANGE_MS[DEFAULT_RANGE];
  const since = now - windowMs;
  const list = turns ?? listTurns({ tail: 50000, since, userId });

  /** @param {string} tool */
  const skillOf = (tool) => {
    const mapped = toolSkillMap?.get(tool);
    if (mapped) return mapped;
    const mcp = /^mcp_(.+?)__/.exec(tool);
    return mcp ? `mcp:${mcp[1]}` : '(other)';
  };

  let spans = 0, toolCalls = 0, toolFailures = 0, providerErrors = 0, turnsWithErrors = 0;
  /** @type {Map<string, { tool: string, skill: string, calls: number, failures: number, totalMs: number, msCount: number, lastError: string|null }>} */
  const byTool = new Map();
  /** @type {Map<string, { provider: string, spans: number, providerErrors: number, toolCalls: number, toolFailures: number }>} */
  const byProvider = new Map();
  /** @type {Map<string, { agent: string, spans: number, toolCalls: number, toolFailures: number, providerErrors: number }>} */
  const byAgent = new Map();
  /** @type {Array<{ at: number|null, atIso: string|null, agent: string|null, source: string|null, error: string }>} */
  const recentErrors = [];

  for (const t of list) {
    const errs = Array.isArray(t?.errors) ? t.errors : [];
    if (errs.length) turnsWithErrors++;

    for (const s of t?.spans || []) {
      spans++;
      const provider = s?.provider || '(none)';
      let p = byProvider.get(provider);
      if (!p) byProvider.set(provider, p = { provider, spans: 0, providerErrors: 0, toolCalls: 0, toolFailures: 0 });
      p.spans++;
      const agent = s?.agent || s?.agentId || '(unknown)';
      let a = byAgent.get(agent);
      if (!a) byAgent.set(agent, a = { agent, spans: 0, toolCalls: 0, toolFailures: 0, providerErrors: 0 });
      a.spans++;
      if (s?.error) { providerErrors++; p.providerErrors++; a.providerErrors++; }

      for (const c of s?.toolCalls || []) {
        if (!c?.name || c.delegated === true) continue;
        toolCalls++; p.toolCalls++; a.toolCalls++;
        let rec = byTool.get(c.name);
        if (!rec) byTool.set(c.name, rec = { tool: c.name, skill: skillOf(c.name), calls: 0, failures: 0, totalMs: 0, msCount: 0, lastError: null });
        rec.calls++;
        if (typeof c.ms === 'number') { rec.totalMs += c.ms; rec.msCount++; }
        if (c.ok !== true) { toolFailures++; rec.failures++; p.toolFailures++; a.toolFailures++; }
      }
    }

    for (const e of errs) {
      const msg = String(e);
      recentErrors.push({
        at: t.startedAt ?? null,
        atIso: t.startedAt ? new Date(t.startedAt).toISOString() : null,
        agent: t.spans?.[0]?.agent || t.agentId || null,
        source: t.source || null,
        error: msg.slice(0, 200),
      });
      // Turns arrive chronological, so overwriting keeps the newest sample.
      const m = TOOL_ERR_RE.exec(msg);
      const rec = m && byTool.get(m[1]);
      if (rec) rec.lastError = m[2].slice(0, 160) || null;
    }
  }

  const pctOf = (part, whole) => whole ? Math.round((part / whole) * 100) : 0;

  /** @type {Map<string, { skill: string, tools: number, calls: number, failures: number }>} */
  const bySkill = new Map();
  for (const r of byTool.values()) {
    let sk = bySkill.get(r.skill);
    if (!sk) bySkill.set(r.skill, sk = { skill: r.skill, tools: 0, calls: 0, failures: 0 });
    sk.tools++; sk.calls += r.calls; sk.failures += r.failures;
  }

  const worstFirst = (x, y) => (y.failures - x.failures) || (y.calls - x.calls);

  return {
    range,
    sinceIso: new Date(since).toISOString(),
    generatedAtIso: new Date(now).toISOString(),
    totals: {
      turns: list.length,
      turnsWithErrors,
      spans,
      toolCalls,
      toolFailures,
      toolFailurePct: pctOf(toolFailures, toolCalls),
      toolSuccessPct: toolCalls ? 100 - pctOf(toolFailures, toolCalls) : 100,
      providerErrors,
    },
    byTool: [...byTool.values()]
      .map(({ totalMs, msCount, ...r }) => ({ ...r, failPct: pctOf(r.failures, r.calls), avgMs: msCount ? Math.round(totalMs / msCount) : null }))
      .sort(worstFirst)
      .slice(0, 30),
    bySkill: [...bySkill.values()]
      .map(r => ({ ...r, failPct: pctOf(r.failures, r.calls) }))
      .sort(worstFirst),
    byProvider: [...byProvider.values()]
      .map(r => ({ ...r, toolFailPct: pctOf(r.toolFailures, r.toolCalls) }))
      .sort((x, y) => (y.providerErrors + y.toolFailures) - (x.providerErrors + x.toolFailures) || y.spans - x.spans),
    byAgent: [...byAgent.values()]
      .map(r => ({ ...r, toolFailPct: pctOf(r.toolFailures, r.toolCalls) }))
      .sort((x, y) => (y.providerErrors + y.toolFailures) - (x.providerErrors + x.toolFailures) || y.toolCalls - x.toolCalls)
      .slice(0, 10),
    recentErrors: recentErrors
      .sort((x, y) => (y.at || 0) - (x.at || 0))
      .slice(0, 20),
  };
}
