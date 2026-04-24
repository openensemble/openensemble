#!/usr/bin/env node
/**
 * Bench the smart-scheduler reasoning surface against fixture cases.
 *
 * Phase 1 reality check: Phase-1 `planGenerate` routes through the cortex
 * model, which was NOT trained on scheduler prompts. This script prints
 * input/output pairs and a loose format check so we can judge whether the
 * base model is usable as-is or whether we need to train a dedicated plan
 * model. Output quality, not pass/fail, is the signal.
 *
 * Run: `node scripts/bench-plan.mjs`
 * Safe to run repeatedly — touches no state.
 */

import { planGenerate, planTasks } from '../scheduler/builtin-plan.mjs';

const NOW = '2026-04-21T14:00:00Z';

const CASES = [
  {
    task: 'parse',
    label: 'concrete time',
    user: `Current time: ${NOW}\nRequest: "remind me to call Alice tomorrow at 3pm"`,
    expectShape: ['intent', 'schedule', 'conditions', 'priority', 'target'],
  },
  {
    task: 'parse',
    label: 'fuzzy window + condition',
    user:
      `Current time: ${NOW}\n` +
      `Request: "nudge me about the Jones email next Tuesday afternoon, unless they reply first"`,
    expectShape: ['intent', 'schedule', 'conditions'],
  },
  {
    task: 'parse',
    label: 'recurring',
    user: `Current time: ${NOW}\nRequest: "every weekday at 9am, summarize my unread emails"`,
    expectShape: ['intent', 'schedule'],
  },
  {
    task: 'decide',
    label: 'busy user, low-priority ping',
    user:
      `Current time: ${NOW}\n` +
      `Context: user is actively chatting with their coordinator (last message 12 seconds ago). ` +
      `Candidates: [\n` +
      `  { "taskId":"t1","label":"daily news digest","priority":"low" },\n` +
      `  { "taskId":"t2","label":"reminder: prescription refill due tomorrow","priority":"normal" }\n` +
      `]`,
    expectShape: ['array'],
  },
  {
    task: 'decide',
    label: 'stale reminder, condition resolved',
    user:
      `Current time: ${NOW}\n` +
      `Context: user replied to the Jones email 4 hours ago. ` +
      `Candidates: [\n` +
      `  { "taskId":"t9","label":"follow up on Jones email","condition":"only if no reply sent" }\n` +
      `]`,
    expectShape: ['array'],
  },
  {
    task: 'decompose',
    label: 'goal with hard deadline',
    user:
      `Current time: ${NOW}\n` +
      `Goal: "ship the invoice-generator feature by Friday 2026-04-24 end of day".`,
    expectShape: ['array'],
  },
  {
    task: 'classify',
    label: 'urgent signal',
    user:
      `Event: new email from boss subject "NEED THIS BEFORE 5PM TODAY" received at ${NOW}.`,
    expectShape: ['urgency', 'interruptable'],
  },
];

function looseFormatCheck(task, output, expectShape) {
  if (!output) return { ok: false, note: 'null output' };
  const trimmed = output.trim();
  // Try to locate JSON. Some models pad with prose; accept first JSON block.
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) return { ok: false, note: 'no JSON found' };
  const candidate = trimmed.slice(start);
  // Best-effort balanced parse: try parsing progressively shrinking tails.
  let parsed = null;
  for (let end = candidate.length; end > 0; end--) {
    try {
      parsed = JSON.parse(candidate.slice(0, end));
      break;
    } catch {}
  }
  if (parsed === null) return { ok: false, note: 'JSON did not parse' };
  if (expectShape.includes('array')) {
    if (!Array.isArray(parsed)) return { ok: false, note: 'expected array' };
    return { ok: true, note: `array of ${parsed.length}` };
  }
  if (typeof parsed !== 'object') return { ok: false, note: 'expected object' };
  const missing = expectShape.filter(k => !(k in parsed));
  if (missing.length) return { ok: false, note: `missing fields: ${missing.join(',')}` };
  return { ok: true, note: 'shape ok' };
}

async function main() {
  console.log(`\n== bench-plan.mjs (tasks: ${planTasks().join(', ')}) ==\n`);
  const results = [];
  for (const c of CASES) {
    const startedAt = Date.now();
    const out = await planGenerate({ task: c.task, user: c.user });
    const ms = Date.now() - startedAt;
    const check = looseFormatCheck(c.task, out, c.expectShape);
    results.push({ ...c, output: out, ms, check });

    console.log(`── [${c.task}] ${c.label}  (${ms} ms)  ${check.ok ? 'OK' : 'FAIL'} — ${check.note}`);
    console.log(`   input:  ${c.user.replace(/\n/g, '\n           ')}`);
    console.log(`   output: ${(out ?? '<null>').replace(/\n/g, '\n           ')}`);
    console.log();
  }

  const okCount = results.filter(r => r.check.ok).length;
  const avgMs = Math.round(
    results.reduce((a, b) => a + b.ms, 0) / Math.max(results.length, 1),
  );
  console.log(`\n== summary: ${okCount}/${results.length} shape-ok, avg ${avgMs} ms/call ==\n`);
  process.exit(0);
}

main().catch(e => {
  console.error('[bench-plan] crashed:', e);
  process.exit(1);
});
