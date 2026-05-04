#!/usr/bin/env node
/**
 * Bench the plan model running through Ollama. Hits Ollama's /api/generate
 * directly so we measure the same path the production server uses (since
 * scheduler.planProvider="ollama" routes through Ollama).
 *
 * Usage:
 *   node scripts/bench-plan-ollama.mjs                          # bench the active tag
 *   TAGS=openensemble-plan:360-v6,openensemble-plan:360-v1 node scripts/bench-plan-ollama.mjs
 *   N=5 node scripts/bench-plan-ollama.mjs                      # iterations per case
 */
const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const TAGS = (process.env.TAGS || 'openensemble-plan:360-v6').split(',').map((s) => s.trim()).filter(Boolean);
const N = parseInt(process.env.N || '3', 10);

const SYSTEM = 'You are a scheduler reasoning assistant. Given a task-prefix token, parse scheduling requests, decide whether pending tasks should run, break goals into checkpoints, or classify event urgency. Output ONLY valid JSON unless the task explicitly asks for prose.';

const NOW = '2026-04-28T10:30:00-04:00';

const CASES = [
  { label: 'parse: concrete 12h', task: 'parse', user: `Current time: ${NOW}\nRequest: "remind me to call Alice tomorrow at 3pm"` },
  { label: 'parse: HHMM 4-digit', task: 'parse', user: `Current time: ${NOW}\nRequest: "wake me at 0530"` },
  { label: 'parse: recurring multi-DOW', task: 'parse', user: `Current time: ${NOW}\nRequest: "every Mon, Wed, Fri at 9am call grandma"` },
  { label: 'parse: anchored offset', task: 'parse', user: `Current time: ${NOW}\nRequest: "30 min before my 11am meeting remind me to prep"` },
  { label: 'parse: relative', task: 'parse', user: `Current time: ${NOW}\nRequest: "in 15 minutes remind me to check the oven"` },
  { label: 'parse: natural language', task: 'parse', user: `Current time: ${NOW}\nRequest: "I need to take my medicine at five am tomorrow"` },
  { label: 'parse: multi-day weekend', task: 'parse', user: `Current time: ${NOW}\nRequest: "friday, sat, and sunday at 12 I need to meditate"` },
  { label: 'split: 3 intents', task: 'split', user: `Current time: ${NOW}\nRequest: "in 5 minutes email me, then at 3pm call mom, then at 8pm lock the door"` },
  { label: 'split: pseudo-compound', task: 'split', user: `Current time: ${NOW}\nRequest: "call mom and dad at 5pm"` },
];

function buildPrompt(task, user) {
  return `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n<${task}>\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

// CPU=1 → num_gpu:0 (forces all layers to CPU for comparison)
const CPU = !!process.env.CPU;
const NUM_CTX = parseInt(process.env.NUM_CTX || '2048', 10);

async function generate(tag, prompt) {
  const t0 = performance.now();
  const options = { temperature: 0.01, num_predict: 512, num_ctx: NUM_CTX };
  if (CPU) options.num_gpu = 0;
  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: tag,
      prompt,
      raw: true,        // we provide the chat-template tokens already
      stream: false,    // single response with timing fields
      options,
      keep_alive: '24h',
    }),
  });
  const elapsedClient = performance.now() - t0;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  return {
    response: j.response,
    elapsedClient,
    // Ollama returns nanoseconds in these fields (see /api/generate docs)
    totalNs: j.total_duration ?? 0,
    loadNs: j.load_duration ?? 0,
    promptEvalNs: j.prompt_eval_duration ?? 0,
    evalNs: j.eval_duration ?? 0,
    promptEvalCount: j.prompt_eval_count ?? 0,
    evalCount: j.eval_count ?? 0,
  };
}

const fmtMs = (ns) => (ns / 1e6).toFixed(0).padStart(5);
const fmtTps = (count, ns) => ns > 0 ? (count / (ns / 1e9)).toFixed(1).padStart(5) : '   --';

for (const tag of TAGS) {
  console.log(`\n=== ${tag} (${N} iters per case, ${CPU ? 'CPU-ONLY' : 'GPU'}, num_ctx=${NUM_CTX}) ===`);

  // Warmup — first request loads the model.
  console.log(`  warmup…`);
  await generate(tag, buildPrompt('parse', `Current time: ${NOW}\nRequest: "warmup"`));

  console.log(`  case                                  | total | load  | pp(ms,tok,t/s)        | eval(ms,tok,t/s)`);
  console.log(`  ${'─'.repeat(110)}`);

  const aggr = { total: 0, load: 0, ppMs: 0, ppTok: 0, evalMs: 0, evalTok: 0 };
  let runs = 0;

  for (const c of CASES) {
    const prompt = buildPrompt(c.task, c.user);
    const samples = [];
    for (let i = 0; i < N; i++) samples.push(await generate(tag, prompt));

    // average across iters
    const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
    const total = avg('totalNs');
    const load  = avg('loadNs');
    const ppNs  = avg('promptEvalNs');
    const evalNs = avg('evalNs');
    const ppCount = avg('promptEvalCount');
    const evalCount = avg('evalCount');

    console.log(`  ${c.label.padEnd(38)} | ${fmtMs(total)} | ${fmtMs(load)} | ${fmtMs(ppNs)} ${String(ppCount.toFixed(0)).padStart(4)} ${fmtTps(ppCount, ppNs)}     | ${fmtMs(evalNs)} ${String(evalCount.toFixed(0)).padStart(4)} ${fmtTps(evalCount, evalNs)}`);

    aggr.total += total;
    aggr.load += load;
    aggr.ppMs += ppNs;
    aggr.ppTok += ppCount;
    aggr.evalMs += evalNs;
    aggr.evalTok += evalCount;
    runs++;
  }

  console.log(`  ${'─'.repeat(110)}`);
  console.log(`  AVG (${runs} cases × ${N} iters) — total=${(aggr.total/runs/1e6).toFixed(0)}ms, prompt-eval=${(aggr.ppTok/runs).toFixed(0)} tok @ ${(aggr.ppTok / (aggr.ppMs/1e9)).toFixed(1)} t/s, gen=${(aggr.evalTok/runs).toFixed(0)} tok @ ${(aggr.evalTok / (aggr.evalMs/1e9)).toFixed(1)} t/s`);
}
