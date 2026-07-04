// @ts-check
/**
 * lib/local-intent-audit.mjs — authoring-time checks for a skill's
 * `localIntents` block (the local cognition tier, lib/local-label.mjs).
 *
 * Field lesson (2026-07-04, localweather): a skill declared TWO intents that
 * bound the SAME zero-argument tool, split by paraphrase ("today" vs
 * "tomorrow" phrasings). The dispatcher's anti-guessing rule rejects any
 * utterance scoring within EMBED_GAP (0.05) of two intents — so the split
 * made most real utterances unmatchable ("What's the weather right now?"
 * scored 0.900 vs 0.876 → ambiguous → fell through to a 12s LLM turn) even
 * though either intent would have run the identical tool call.
 *
 * Two checks, run when the skill-builder writes a manifest:
 *   1. mergeDuplicateToolIntents — deterministic: intents that bind the same
 *      tool with the same slots and confirm flag differ only in phrasing, so
 *      they are merged into one (pure win — removes self-ambiguity).
 *   2. auditIntentAmbiguity — embedding check across the REMAINING intents:
 *      pairs whose utterance sets overlap semantically get a warning naming
 *      the closest phrasings, so the authoring LLM can differentiate them.
 *
 * Warnings never block the write — matching the skill-builder's gate style.
 */

import { embed } from '../memory/embedding.mjs';
import { BUILTIN_DOMAIN_ANCHORS } from './local-label.mjs';

/**
 * Cross-intent similarity above this predicts gap-zone rejections: with the
 * dispatch gap at 0.05, example sets this close leave most real utterances
 * scoring near both intents. (localweather field data: the today/tomorrow
 * split had cross-sim 0.89-0.93 and rejected nearly everything.)
 */
const AMBIGUITY_SIM_THRESHOLD = 0.85;

const sortedKey = (arr) => [...(arr || [])].sort().join(',');

/**
 * Merge intents that bind the same tool with identical slots + confirm flag —
 * their split is purely by paraphrase and can only hurt matching. Utterances
 * and patterns concatenate (deduped, first intent's id kept).
 *
 * @param {Array<{id: string, tool: string, utterances?: string[], patterns?: string[], slots?: string[], confirm?: boolean}>} intents
 * @returns {{ intents: any[], notes: string[] }}
 */
export function mergeDuplicateToolIntents(intents) {
  if (!Array.isArray(intents) || intents.length < 2) {
    return { intents: intents ?? [], notes: [] };
  }
  const byKey = new Map();
  const out = [];
  const notes = [];
  for (const li of intents) {
    const key = `${li.tool}|${sortedKey(li.slots)}|${li.confirm === true}`;
    const prior = byKey.get(key);
    if (!prior) {
      const copy = { ...li, utterances: [...(li.utterances || [])], patterns: [...(li.patterns || [])] };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    for (const u of li.utterances || []) if (!prior.utterances.includes(u)) prior.utterances.push(u);
    for (const p of li.patterns || []) if (!prior.patterns.includes(p)) prior.patterns.push(p);
    notes.push(
      `Merged intent "${li.id}" into "${prior.id}": both bind ${li.tool} with identical slots, so they differ only in phrasing — ` +
      `split intents like this reject each other's utterances as ambiguous (dispatch gap rule). All phrasings now live under one intent.`
    );
  }
  return { intents: out, notes };
}

/**
 * Embedding audit across DIFFERENT intents: warn when two intents' utterance
 * sets overlap enough that real utterances will land within the dispatch gap
 * of both and be rejected. Warn-only — the author may want to differentiate
 * phrasings, or merge if the intents genuinely do the same thing.
 *
 * Also warns when an intent's utterances sit close to a BUILT-IN domain
 * anchor (lib/local-label.mjs BUILTIN_DOMAIN_ANCHORS) — the dispatcher will
 * veto matches inside the gap of an anchor at runtime, so phrasings this
 * close to reminders/calendar/email/etc. silently lose their fast-path.
 *
 * @param {Array<{id: string, tool: string, utterances?: string[]}>} intents
 * @returns {Promise<string[]>} warnings (empty when clean or on embed failure)
 */
export async function auditIntentAmbiguity(intents) {
  if (!Array.isArray(intents) || intents.length < 1) return [];
  try {
    const embedded = [];
    for (const li of intents) {
      const utts = (li.utterances || []).slice(0, 16);
      const vecs = [];
      for (const u of utts) {
        const v = await embed(u);
        if (Array.isArray(v) && v.length) vecs.push({ u, v });
      }
      embedded.push({ id: li.id, tool: li.tool, vecs });
    }
    const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
    const warnings = [];
    // Built-in anchor collisions first — these bite even a single-intent
    // skill. One warning per intent×domain, naming the closest pair.
    for (const anchor of BUILTIN_DOMAIN_ANCHORS) {
      const anchorVecs = [];
      for (const au of anchor.utterances) {
        const av = await embed(au);
        if (Array.isArray(av) && av.length) anchorVecs.push({ au, av });
      }
      for (const e of embedded) {
        let worst = { sim: -1, u: '', au: '' };
        for (const { u, v } of e.vecs) {
          for (const { au, av } of anchorVecs) {
            const sim = dot(v, av);
            if (sim > worst.sim) worst = { sim, u, au };
          }
        }
        if (worst.sim >= AMBIGUITY_SIM_THRESHOLD) {
          warnings.push(
            `Intent "${e.id}" utterance "${worst.u}" is semantically close to the built-in ${anchor.domain} domain ` +
            `("${worst.au}", similarity ${worst.sim.toFixed(2)}). Real requests phrased between the two will be vetoed at ` +
            `dispatch and fall through to the LLM — prefer phrasings that name the skill's own subject.`
          );
        }
      }
    }
    for (let i = 0; i < embedded.length; i++) {
      for (let j = i + 1; j < embedded.length; j++) {
        let best = { sim: -1, a: '', b: '' };
        for (const { u: ua, v: va } of embedded[i].vecs) {
          for (const { u: ub, v: vb } of embedded[j].vecs) {
            const sim = dot(va, vb);
            if (sim > best.sim) best = { sim, a: ua, b: ub };
          }
        }
        if (best.sim >= AMBIGUITY_SIM_THRESHOLD) {
          warnings.push(
            `Intents "${embedded[i].id}" and "${embedded[j].id}" have semantically overlapping utterances ` +
            `(closest: "${best.a}" vs "${best.b}", similarity ${best.sim.toFixed(2)}). Utterances scoring near both will be ` +
            `REJECTED as ambiguous and fall through to the LLM. Differentiate the phrasings` +
            (embedded[i].tool === embedded[j].tool ? `, or merge them — they bind the same tool (${embedded[i].tool}).` : '.')
          );
        }
      }
    }
    return warnings;
  } catch (e) {
    console.warn('[local-intent-audit] ambiguity audit failed:', e?.message);
    return [];
  }
}
