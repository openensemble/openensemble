#!/usr/bin/env node
/**
 * CPU benchmark — `oe bench`.
 *
 * Loads the bundled memory (reason) and plan GGUF models, runs a handful of
 * representative prompts against each, and reports how fast this CPU will
 * resolve the LLM calls that happen during chat turns and scheduling.
 *
 * Output is human-friendly and ends with a verdict + tuning hint. Touches
 * no state — safe to run while the server is also running, though the
 * second model load may briefly spike memory.
 */

import os from 'os';
import fs from 'fs';
import {
  initBuiltinReason,
  builtinGenerate,
  getBuiltinReasonModelPath,
  getBuiltinReasonModelId,
} from '../memory/builtin-reason.mjs';
import {
  initBuiltinPlan,
  planGenerate,
  getBuiltinPlanModelPath,
  getBuiltinPlanModelId,
} from '../scheduler/builtin-plan.mjs';

const NOW = '2026-04-21T14:00:00Z';

// Reason (memory) cases — mirror the prompts cortex uses on every chat turn.
// Pulled from scripts/bench-reason.mjs so the timings reflect production shape.
const REASON_CASES = [
  {
    task: 'salience',
    system:
      'Output JSON only. No explanation.\n' +
      'Example: {"emotional_weight":0.5,"decision_weight":0.7,"uniqueness":0.3}\n\n' +
      'Rate 0.0-1.0:\n' +
      'emotional_weight = how emotionally significant\n' +
      'decision_weight = how much this affects future behavior\n' +
      'uniqueness = how novel or surprising',
    user: 'Text: "My new address is 742 Evergreen Terrace, Portland OR."',
  },
  {
    task: 'contradiction',
    system: null,
    user:
      'Output JSON only.\n' +
      'Do A and B directly contradict each other? Only yes if they clearly disagree.\n\n' +
      'A: "I prefer dark mode"\n' +
      'B: "I like light mode now"\n\n' +
      '{"contradicts":true} or {"contradicts":false}',
  },
  {
    task: 'signals',
    system:
      'Analyze this conversation turn for memory signals. Output JSON only.\n' +
      'Format: {"is_correction":bool,"correction":str|null,"is_preference":bool,' +
      '"preference":str|null,"preference_strength":"strong"|"moderate"|"weak"|null,' +
      '"is_forget":bool,"forget_subject":str|null}',
    user:
      'User: "No, I meant the 3pm meeting should be at 4pm — always move it when there is a conflict"\n' +
      'Agent: ""',
  },
  {
    task: 'friction',
    system: null,
    user:
      'Output JSON only.\n' +
      'Are A and B asking for the same thing, even if worded differently?\n\n' +
      'A: "Can you send short emails?"\n' +
      'B: "Keep your replies brief"\n\n' +
      '{"same_instruction":true} or {"same_instruction":false}',
  },
  {
    task: 'summary',
    system:
      'Summarize this conversation in 1-3 concise sentences. Focus on: decisions made, ' +
      'topics discussed, preferences expressed, problems solved, and action items. ' +
      'Output plain text only, no JSON.',
    user:
      'user: Hey, can you triage my inbox?\n' +
      'assistant: Sure, I found 12 promos and trashed them, and flagged 2 invoices for your review.\n' +
      'user: Great, forward the invoices to accounting@example.com\n' +
      'assistant: Done — forwarded both.',
  },
];

// Plan (scheduler) cases — same shape callers feed builtin-plan in production.
const PLAN_CASES = [
  {
    task: 'parse',
    user: `Current time: ${NOW}\nRequest: "remind me to call Alice tomorrow at 3pm"`,
  },
  {
    task: 'classify',
    user: `Event: new email from boss subject "NEED THIS BEFORE 5PM TODAY" received at ${NOW}.`,
  },
  {
    task: 'decide',
    user:
      `Current time: ${NOW}\n` +
      `Context: user is actively chatting with their coordinator (last message 12 seconds ago). ` +
      `Candidates: [{"taskId":"t1","label":"daily news digest","priority":"low"}]`,
  },
];

const C = {
  bold:  s => `\x1b[1m${s}\x1b[0m`,
  dim:   s => `\x1b[2m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow:s => `\x1b[33m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
};

function median(arr) {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function fmtMs(n) {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

async function timeOnce(fn) {
  const t0 = Date.now();
  const out = await fn();
  return { ms: Date.now() - t0, out };
}

async function benchModel(label, cases, run) {
  console.log(C.bold(`\n${label}`));
  console.log(C.dim('  task            run 1    run 2    median'));
  const allTimings = [];
  const perTask = [];
  for (const c of cases) {
    // Warmup so the first timed run isn't paying for cold caches.
    await run(c);
    const r1 = await timeOnce(() => run(c));
    const r2 = await timeOnce(() => run(c));
    const med = median([r1.ms, r2.ms]);
    perTask.push({ task: c.task, median: med });
    allTimings.push(r1.ms, r2.ms);
    console.log(
      `  ${c.task.padEnd(14)}  ${String(r1.ms).padStart(5)}ms  ` +
      `${String(r2.ms).padStart(5)}ms   ${C.cyan(String(med).padStart(5) + 'ms')}`,
    );
  }
  return { perTask, allTimings };
}

function verdict(memoryTurnMs, planMedianMs) {
  // Memory pipeline fires 5 tasks serially through the cortex queue per chat
  // turn (some critical, some background) — sum of medians is the realistic
  // turn budget. Plan median is the parse-class call that gates scheduling.
  if (memoryTurnMs < 1500 && planMedianMs < 400) {
    return {
      tier: C.green('Snappy'),
      msg: 'Your CPU keeps up comfortably with both pipelines.',
    };
  }
  if (memoryTurnMs < 3000 && planMedianMs < 800) {
    return {
      tier: C.green('Comfortable'),
      msg: 'Chat turns will feel responsive; scheduling is quick.',
    };
  }
  if (memoryTurnMs < 6000 && planMedianMs < 1500) {
    return {
      tier: C.yellow('Noticeable'),
      msg:
        'Chat turns add a visible pause for memory work. Consider pointing\n' +
        '  the memory/plan provider at Ollama or LM Studio on a faster machine\n' +
        '  (Settings → Cortex Model / Scheduler Model).',
    };
  }
  return {
    tier: C.red('Slow'),
    msg:
      'Chat turns will feel laggy. Recommended: install Ollama on a machine\n' +
      '  with a discrete GPU and switch the memory + plan providers to it\n' +
      '  (Settings → Cortex Model / Scheduler Model).',
  };
}

async function main() {
  console.log(C.bold('OpenEnsemble CPU benchmark'));
  console.log();
  const cpu = os.cpus()[0]?.model?.trim() || 'unknown';
  const threads = os.cpus().length;
  console.log(`  CPU:     ${cpu}  (${threads} threads)`);
  console.log(`  Memory:  ${(os.totalmem() / 1e9).toFixed(1)} GB total`);

  const reasonPath = getBuiltinReasonModelPath();
  const planPath = getBuiltinPlanModelPath();
  const reasonExists = fs.existsSync(reasonPath);
  const planExists = fs.existsSync(planPath);

  console.log(`  Memory model:  ${reasonExists ? getBuiltinReasonModelId() : C.red('missing')}`);
  console.log(`  Plan model:    ${planExists ? getBuiltinPlanModelId() : C.red('missing')}`);

  if (!reasonExists || !planExists) {
    console.log();
    console.log(C.red('Models missing — run `node scripts/fetch-models.mjs` first.'));
    process.exit(1);
  }

  console.log();
  console.log('Loading memory model...');
  const tReason = Date.now();
  await initBuiltinReason();
  console.log(C.dim(`  loaded in ${Date.now() - tReason} ms`));

  console.log('Loading plan model...');
  const tPlan = Date.now();
  await initBuiltinPlan();
  console.log(C.dim(`  loaded in ${Date.now() - tPlan} ms`));

  const reason = await benchModel(
    'Memory tasks (run during every chat turn)',
    REASON_CASES,
    c => builtinGenerate({ system: c.system, user: c.user, task: c.task, maxTokens: 160 }),
  );
  const plan = await benchModel(
    'Plan tasks (run when scheduling / triaging)',
    PLAN_CASES,
    c => planGenerate({ task: c.task, user: c.user, maxTokens: 256 }),
  );

  // Realistic per-turn cost: all 5 memory tasks fire (queued serially through
  // the same llama.cpp context). Plan side is dominated by the parse call.
  const memoryTurnMs = reason.perTask.reduce((a, b) => a + b.median, 0);
  const planMedian = plan.perTask.find(t => t.task === 'parse')?.median
    ?? median(plan.perTask.map(t => t.median));

  console.log();
  console.log(C.bold('Estimated per-call latency on this CPU'));
  console.log(`  Memory pipeline:  ~${fmtMs(memoryTurnMs)} per chat turn (5 tasks combined)`);
  console.log(`  Plan call:        ~${fmtMs(planMedian)} median (parse)`);

  const v = verdict(memoryTurnMs, planMedian);
  console.log();
  console.log(`${C.bold('Verdict:')} ${v.tier} — ${v.msg}`);
  console.log();

  process.exit(0);
}

main().catch(e => {
  console.error(C.red('\nbench failed:'), e?.message || e);
  process.exit(1);
});
