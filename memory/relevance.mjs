/** Topic relevance is independent of importance, retention, and pinning. */
export const CONTEXT_SIMILARITY_THRESHOLD = 0.60;
export const CONTEXT_CANDIDATE_THRESHOLD = 0.30;
// The generative classifier needs agreement from the embedding model. This
// cutoff preserves 97.5% of the broad gate's positives on development data.
export const CORTEX_RELEVANCE_SIMILARITY_THRESHOLD = 0.40;

// Older sessions stored orchestration envelopes as episodes. These contain
// execution instructions, not user history. Keep them available to explicit
// archive search, but never automatically replay them into a new turn.
export function isOrchestrationEnvelope(row) {
  return /^(?:A background (?:operation|delegation)|Background work from your scheduled task|\[SCHEDULED RUN\]|<scheduled_(?:task|note)\b)/i
    .test(String(row.text || '').trim());
}

export function cosineSimilarity(left, right) {
  // LanceDB returns Apache Arrow vectors, whose elements use get()/toArray()
  // rather than numeric property access. Embedders return arrays/typed arrays.
  if (typeof left?.toArray === 'function') left = left.toArray();
  if (typeof right?.toArray === 'function') right = right.toArray();
  if (!left?.length || left.length !== right?.length) return null;
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) return null;
    dot += left[i] * right[i];
    a += left[i] * left[i];
    b += right[i] * right[i];
  }
  return a > 0 && b > 0 ? Math.max(-1, Math.min(1, dot / Math.sqrt(a * b))) : null;
}

// Pinning protects storage. Always-on behavior requires a separate, explicit
// category; legacy topic-specific pins must never acquire it automatically.
export function isStandingInstruction(row) {
  return row?.immortal === true && row.source === 'user_stated'
    && row.category === 'standing_instruction';
}

export function selectContextCandidates(rows, queryVec, {
  topK = 6, threshold = CONTEXT_SIMILARITY_THRESHOLD, rerank = false,
} = {}) {
  const seen = new Set();
  return rows.flatMap(row => {
    if (isOrchestrationEnvelope(row)) return [];
    // Old free-form summaries can invent events. Preserve them for explicit
    // history search, but do not treat them as trusted automatic context.
    if (row.source === 'summary' && row.category !== 'quoted-exchanges-v1') return [];
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    const standing = isStandingInstruction(row);
    const similarity = cosineSimilarity(queryVec, row.vector);
    // Broad user-approved preferences can use different words from a query.
    // With a trained second stage, consider those even below the embedding
    // cutoff, but they still need an affirmative relevance decision.
    const userApproved = row.immortal === true || row.tier === 'confirmed';
    if (!standing && (similarity == null
      || (similarity < threshold && !(rerank && userApproved)))) return [];
    return [{ ...row, semantic_score: similarity,
      final_score: standing ? 1 : similarity,
      selectionReason: standing ? 'Standing instruction' : 'Topic match' }];
  }).sort((a, b) => Number(isStandingInstruction(b)) - Number(isStandingInstruction(a))
    || b.final_score - a.final_score)
    .slice(0, Math.max(0, topK));
}

/** Optional trained relevance task. V3 cannot perform this task; opt in only
 * after validating a model that advertises the new task in its release notes. */
export async function filterContextRelevance(query, rows, { userId, agentId, budgetMs = 1500, limit = Infinity } = {}) {
  const { getCortexConfig, generateCombined, safeParseJSON } = await import('./shared.mjs');
  const config = getCortexConfig();
  if (!config.relevanceTask) return rows.slice(0, limit);
  const clean = text => String(text || '').replace(/"/g, "'");
  const selected = [];
  const deadline = Date.now() + budgetMs;
  let unavailable = 0;
  for (const [index, row] of rows.entries()) {
    if (selected.length >= limit) break;
    if (isStandingInstruction(row)) { selected.push(row); continue; }
    // Pins and confirmed preferences still need topical evidence. A single
    // affirmative generation cannot rescue a weak or missing query match.
    if (!Number.isFinite(row.semantic_score)
      || row.semantic_score < CORTEX_RELEVANCE_SIMILARITY_THRESHOLD) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { unavailable += rows.length - index; break; }
    const body = `Query: "${clean(query).slice(0, 500)}" Memory: "${clean(row.text || row.statement).slice(0, 1000)}"`;
    const controller = new AbortController();
    let timer;
    let raw;
    try {
      raw = await Promise.race([
        generateCombined('', body, { caller: 'relevance', userId, agentId,
          timeoutMs: remaining, signal: controller.signal }),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining); }),
      ]);
    } catch { raw = null; }
    finally { clearTimeout(timer); controller.abort(); }
    const result = safeParseJSON(raw);
    // No valid decision means no extra prompt context. Do not reinterpret a
    // parse failure or a different model's schema as approval to inject.
    if (result?.relevant === true) {
      selected.push({ ...row, selectionReason: 'Relevant to this request' });
    } else if (result?.relevant !== false) unavailable++;
  }
  if (unavailable) console.warn(`[cortex] Relevance check unavailable for ${unavailable} candidates (deadline or invalid response); omitted from context.`);
  return selected;
}
