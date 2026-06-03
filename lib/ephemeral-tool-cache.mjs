/**
 * lib/ephemeral-tool-cache.mjs
 *
 * Per-ephemeral-session state for delegated agents (agentId begins with
 * `ephemeral_deleg_`). Two complementary token-savers wired into the tool
 * dispatcher in roles.mjs:executeToolStreaming:
 *
 *   1. Memoization for read-only tool calls within the same delegation.
 *      Same (toolName, args) → return prior result, skip the round-trip
 *      AND the LLM turn that would have parsed it.
 *
 *   2. Embedder-based re-ranking of list-style tool results (list_files,
 *      search_files, grep). Items are scored against the delegation's task
 *      text and surfaced top-K-first with a ★ prefix, so the agent picks
 *      the most-relevant entries on the first try instead of wandering.
 *
 * State is in-memory only — matches the in-memory nature of ephemeral
 * delegations per project_delegation_ephemeral. Auto-GCs after 1h idle so
 * a forgotten session can't pin memory indefinitely.
 */

import { createHash } from 'crypto';
import { embed } from '../memory/embedding.mjs';

const IDLE_TTL_MS = 60 * 60 * 1000;          // drop entire session after 1h of no touches
const MAX_CACHE_ENTRIES_PER_SESSION = 200;   // FIFO evict beyond this
const RERANK_MIN_ITEMS = 12;                 // skip ranking shorter lists (no benefit)
const RERANK_MAX_EMBEDS = 60;                // hard cap on per-result embed cost
const RERANK_TOP_FRACTION = 0.3;             // mark top-30% with ★
const RERANK_TOP_MAX = 25;

/**
 * Tools whose results are pure functions of their args + filesystem state.
 * Memoizing them within one short-lived session is safe — same args mean
 * same content unless something mutated, and the kinds of mutations a
 * delegation can cause come from non-listed tools (write/run_command).
 * Conservative on purpose; expand only when proven safe.
 */
const READ_ONLY_TOOLS = new Set([
  'coder_read_file',
  'coder_list_files',
  'coder_list_projects',
  'coder_search_files',
  'coder_grep',
  'skill_list',
  'list_roles',
  'ha_list_devices',
  'ha_list_areas',
  'ha_list_services',
  'ha_get_state',
]);

/**
 * Tools whose typical output is a flat list of items (paths, search hits,
 * grep matches). Only these benefit from embedder ranking — re-ordering
 * the output of a single-file read makes no sense.
 */
const LIST_STYLE_TOOLS = new Set([
  'coder_list_files',
  'coder_search_files',
  'coder_grep',
]);

const _sessions = new Map();   // delegId -> { task, taskEmbedding?, cache: Map, touchedAt, hits, misses }

function _now() { return Date.now(); }

function _hashArgs(args) {
  try { return createHash('sha1').update(JSON.stringify(args ?? null)).digest('hex').slice(0, 16); }
  catch { return String(args ?? '').slice(0, 32); }
}

function _gc() {
  const cutoff = _now() - IDLE_TTL_MS;
  for (const [id, s] of _sessions) if (s.touchedAt < cutoff) _sessions.delete(id);
}

function _touch(delegId) {
  const s = _sessions.get(delegId);
  if (s) s.touchedAt = _now();
  return s;
}

export function isEphemeralAgentId(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('ephemeral_deleg_');
}

/**
 * Called by skills/delegate/execute.mjs when a fresh ephemeral delegation
 * starts. Snapshots the task text so the embedder ranker can score tool
 * results against it without round-tripping through message history.
 */
export function initSession(delegId, task) {
  _gc();
  if (!isEphemeralAgentId(delegId)) return;
  _sessions.set(delegId, {
    task: String(task ?? '').slice(0, 4000),
    taskEmbedding: null,
    cache: new Map(),
    touchedAt: _now(),
    hits: 0,
    misses: 0,
  });
}

/**
 * Look up a memoized result. Returns null if not cached, the tool isn't on
 * the read-only whitelist, or the session doesn't exist (non-ephemeral).
 */
export function cacheGet(delegId, toolName, args) {
  if (!READ_ONLY_TOOLS.has(toolName)) return null;
  const s = _touch(delegId);
  if (!s) return null;
  const hit = s.cache.get(`${toolName}:${_hashArgs(args)}`);
  if (hit) s.hits++;
  return hit ?? null;
}

/**
 * Store a result for future memoization. Silently no-ops for non-whitelisted
 * tools or non-ephemeral sessions. FIFO-evicts when the per-session cap is
 * hit so a long-running delegation can't exhaust memory.
 */
export function cacheSet(delegId, toolName, args, text) {
  if (!READ_ONLY_TOOLS.has(toolName)) return;
  const s = _touch(delegId);
  if (!s) return;
  s.misses++;
  if (s.cache.size >= MAX_CACHE_ENTRIES_PER_SESSION) {
    s.cache.delete(s.cache.keys().next().value);
  }
  s.cache.set(`${toolName}:${_hashArgs(args)}`, { text, ts: _now() });
}

export function isListStyleTool(toolName) {
  return LIST_STYLE_TOOLS.has(toolName);
}

function _dot(a, b) {
  let s = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? s / denom : 0;
}

/**
 * Re-rank items in a list-style tool result against the session's task.
 * Heuristic: split by newlines, score every substantive line via embedder
 * cosine similarity, prefix the top-K-most-similar with ★ so they catch
 * the LLM's eye first. Items past the top-K stay in original order — we
 * NEVER drop entries; this is purely a "look here first" hint.
 *
 * Best-effort: returns the original text unchanged on any failure (embedder
 * down, no session, list too short to bother). Bounded by RERANK_MAX_EMBEDS
 * so a 5000-line grep can't trigger 5000 embed calls.
 */
export async function rerankListResult(delegId, toolName, resultText) {
  if (!isListStyleTool(toolName)) return resultText;
  const s = _touch(delegId);
  if (!s || !s.task) return resultText;
  const text = String(resultText ?? '');
  const lines = text.split(/\r?\n/);
  const substantive = lines.filter(l => {
    const t = l.trim();
    return t.length >= 4 && !/^-{3,}|^={3,}|^#+\s/.test(t);
  });
  if (substantive.length < RERANK_MIN_ITEMS) return resultText;

  try {
    if (!s.taskEmbedding) {
      s.taskEmbedding = await embed(s.task).catch(() => null);
      if (!s.taskEmbedding) return resultText;
    }
    // Score substantive lines, bounded.
    const toEmbed = lines
      .map((line, i) => ({ i, line, trimmed: line.trim() }))
      .filter(x => x.trimmed.length >= 4 && !/^-{3,}|^={3,}|^#+\s/.test(x.trimmed))
      .slice(0, RERANK_MAX_EMBEDS);
    const embeddings = await Promise.all(
      toEmbed.map(x => embed(x.trimmed).catch(() => null))
    );
    const scored = toEmbed.map((x, k) => ({
      i: x.i,
      score: embeddings[k] ? _dot(s.taskEmbedding, embeddings[k]) : -1,
    })).filter(x => x.score >= 0);
    if (scored.length < 8) return resultText;   // insufficient signal

    scored.sort((a, b) => b.score - a.score);
    const topK = Math.min(Math.ceil(scored.length * RERANK_TOP_FRACTION), RERANK_TOP_MAX);
    const topIdx = new Set(scored.slice(0, topK).map(x => x.i));

    const top = [];
    const rest = [];
    for (let i = 0; i < lines.length; i++) {
      if (topIdx.has(i)) top.push(`★ ${lines[i]}`);
      else rest.push(lines[i]);
    }
    return [
      '★ = top-relevance match against your task (embedder-ranked, ordering hint only)',
      ...top,
      '— remaining items below (original order):',
      ...rest,
    ].join('\n');
  } catch {
    return resultText;
  }
}

/**
 * Diagnostic snapshot for logging. Drops to the chat tag so we can see
 * cache-hit rates per delegation in app.log.
 */
export function sessionStats(delegId) {
  const s = _sessions.get(delegId);
  if (!s) return null;
  return { hits: s.hits, misses: s.misses, entries: s.cache.size };
}
