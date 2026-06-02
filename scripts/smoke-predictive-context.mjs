#!/usr/bin/env node
/**
 * Live smoke for the predictive-context layer against the real cortex /
 * LanceDB on this machine. Drives buildAgentContext directly (same call
 * the chat path makes from chat.mjs:streamChat ~line 349) with a battery
 * of test messages and prints what each turn would have injected.
 *
 * Two pieces being validated:
 *   1. shouldSkipRecall  — confirmations / slash / voice-control / short
 *      reactions short-circuit and return an empty context with a
 *      `_meta.skipped` reason. Verified by seeing "skipped: ..." in the
 *      output AND the absence of any embed/recall latency.
 *   2. filterByConfidence — recall results below the threshold are dropped
 *      before formatting. Verified by comparing `_meta.paramsLoaded` (post-
 *      filter count) against the raw recall topK (printed alongside).
 *
 * Reads-only against cortex tables. Does not mutate anything. The recall
 * path does write recall-stats (stability bump on hit), which is the same
 * write the live chat path triggers — not new behavior from this script.
 *
 * Usage:  node scripts/smoke-predictive-context.mjs
 * Env:    OE_USER_ID=user_xxx  (defaults to first user_* in users/)
 *         OE_AGENT_ID=sydney   (defaults to coordinator)
 */

import { readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { USERS_DIR } from '../lib/paths.mjs';
import { buildAgentContext, formatContext } from '../memory/context.mjs';
import { recall } from '../memory/recall.mjs';
import { shouldSkipRecall, DEFAULT_INJECTION_THRESHOLD } from '../memory/predictive-context.mjs';
import { getUserCoordinatorAgentId } from '../routes/_helpers.mjs';

const USER_ID = process.env.OE_USER_ID || readdirSync(USERS_DIR).find(n => n.startsWith('user_'));
if (!USER_ID) { console.error('no user found in', USERS_DIR); process.exit(1); }
const AGENT_ID = process.env.OE_AGENT_ID || getUserCoordinatorAgentId(USER_ID);

console.log(`smoke target: user=${USER_ID}  agent=${AGENT_ID}  threshold=${DEFAULT_INJECTION_THRESHOLD}`);
console.log('─'.repeat(80));

const CASES = [
  // ── Skip-layer cases (no recall expected, no embed latency) ─────────────
  { tag: 'skip-confirm',     msg: 'yes',                                  expect: 'skipped: confirmation' },
  { tag: 'skip-confirm-2',   msg: 'go ahead',                             expect: 'skipped: confirmation' },
  { tag: 'skip-slash',       msg: '/threshold 0.5',                       expect: 'skipped: slash_command' },
  { tag: 'skip-voice',       msg: 'volume up',                            expect: 'skipped: voice_control' },
  { tag: 'skip-reaction',    msg: 'hmm',                                  expect: 'skipped: short_reaction' },
  { tag: 'skip-empty',       msg: '',                                     expect: 'skipped: empty' },

  // ── No-skip cases (recall + filter expected) ────────────────────────────
  { tag: 'real-q-fruit',     msg: 'what fruit do I like?',                expect: 'recalls + filters' },
  { tag: 'real-q-recall',    msg: 'what did we talk about yesterday?',    expect: 'recalls + filters (temporal)' },
  { tag: 'real-q-tools',     msg: 'what tools do you have access to?',    expect: 'recalls + filters' },
  { tag: 'real-q-prefs',     msg: 'what are my preferences?',             expect: 'recalls + filters' },

  // Adversarial: leading reaction word but question follows. Should NOT
  // skip — the trailing "?" hits QUESTION_HINT_RE and falls through.
  { tag: 'real-q-wait-what', msg: 'wait, what was the cortex project about?', expect: 'recalls + filters' },

  // Random off-topic — should recall but likely filter out everything
  // below threshold, producing an empty cortex block.
  { tag: 'real-offtopic',    msg: 'how do quokkas mate in captivity?',    expect: 'recalls; expect mostly filtered out' },
];

const results = [];
for (const c of CASES) {
  const layer1 = shouldSkipRecall(c.msg);

  const t0 = performance.now();
  const ctx = await buildAgentContext(AGENT_ID, c.msg, USER_ID).catch(e => ({ _error: e.message }));
  const dt = (performance.now() - t0).toFixed(1);

  if (ctx._error) {
    console.log(`[${c.tag.padEnd(18)}] msg="${c.msg.slice(0, 40)}"`);
    console.log(`    ERROR: ${ctx._error}`);
    results.push({ tag: c.tag, ok: false, dt });
    continue;
  }

  const block = formatContext(ctx);
  const blockChars = block.length;
  const meta = ctx._meta || {};

  // For non-skip cases also pull a RAW (un-filtered) recall so we can
  // report how many were dropped by the threshold.
  let rawCounts = '';
  if (!layer1.skip) {
    try {
      const rawParams = await recall({ agentId: AGENT_ID, type: 'params', query: c.msg, topK: 10, includeShared: false, userId: USER_ID });
      const rawFacts  = await recall({ agentId: 'shared', type: 'user_facts', query: c.msg, topK: 4, includeShared: false, userId: USER_ID }).catch(() => []);
      const droppedParams = Math.max(0, rawParams.length - meta.paramsLoaded);
      // userFacts post-filter count isn't in _meta, so derive from block text
      // search instead — close enough for the smoke report.
      rawCounts = `raw_params=${rawParams.length} kept=${meta.paramsLoaded} (dropped ${droppedParams})  raw_facts=${rawFacts.length}`;
    } catch (e) {
      rawCounts = `raw-recall-error: ${e.message}`;
    }
  }

  const status = layer1.skip
    ? `SKIPPED reason=${meta.skipped || layer1.reason}`
    : `RECALLED paramsLoaded=${meta.paramsLoaded} episodesLoaded=${meta.episodesLoaded} immortalCount=${meta.immortalCount} blockChars=${blockChars}`;

  console.log(`[${c.tag.padEnd(18)}] msg="${c.msg.slice(0, 48)}"  ${dt}ms`);
  console.log(`    ${status}`);
  if (rawCounts) console.log(`    ${rawCounts}`);
  console.log(`    expect: ${c.expect}`);
  if (!layer1.skip && blockChars > 0) {
    const preview = block.replace(/\n+/g, ' ').slice(0, 180);
    console.log(`    block preview: ${preview}${blockChars > 180 ? '…' : ''}`);
  }
  console.log();

  results.push({ tag: c.tag, ok: true, skipped: layer1.skip, dt, blockChars });
}

// Summary
console.log('─'.repeat(80));
const skips = results.filter(r => r.skipped);
const recalls = results.filter(r => !r.skipped && r.ok);
const skipMs  = skips.reduce((a, r) => a + parseFloat(r.dt), 0).toFixed(1);
const recallMs= recalls.reduce((a, r) => a + parseFloat(r.dt), 0).toFixed(1);
const skipAvg = skips.length ? (parseFloat(skipMs) / skips.length).toFixed(2) : 'n/a';
const recallAvg = recalls.length ? (parseFloat(recallMs) / recalls.length).toFixed(1) : 'n/a';
console.log(`skipped turns: ${skips.length}  avg latency: ${skipAvg}ms  (no embed, no recall)`);
console.log(`recalled turns: ${recalls.length}  avg latency: ${recallAvg}ms  (embed + 3 vector queries + filter)`);
console.log();
console.log('Per the design: skip-layer latency should be <1ms; recall-layer ~20-100ms.');
console.log('If skip-layer turns show >1ms, the early-return path is broken.');
process.exit(0);
