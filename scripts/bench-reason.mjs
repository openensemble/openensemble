#!/usr/bin/env node
// CPU latency bench using the actual caller-shaped prompts (not ad-hoc inputs).
// Mirrors how embedding.mjs / signals.mjs / session-buffer.mjs call the model so
// the timings AND output shapes reflect production behavior.

import { initBuiltinReason, builtinGenerate, getBuiltinReasonModelPath } from '../memory/builtin-reason.mjs';
import os from 'os';

const SALIENCE_SYS =
  'Output JSON only. No explanation.\n' +
  'Example: {"emotional_weight":0.5,"decision_weight":0.7,"uniqueness":0.3}\n\n' +
  'Rate 0.0-1.0:\n' +
  'emotional_weight = how emotionally significant\n' +
  'decision_weight = how much this affects future behavior\n' +
  'uniqueness = how novel or surprising';

const SIGNALS_SYS =
  'Analyze this conversation turn for memory signals. Output JSON only.\n' +
  'Format: {"is_correction":bool,"correction":str|null,"is_preference":bool,' +
  '"preference":str|null,"preference_strength":"strong"|"moderate"|"weak"|null,' +
  '"is_forget":bool,"forget_subject":str|null}\n' +
  'preference_strength guide:\n' +
  '- "strong": explicit demand, absolute language (always/never/must/hate/love), emotional emphasis\n' +
  '- "moderate": clear preference with some flexibility (prefer/usually/like/dislike)\n' +
  '- "weak": mild suggestion, one-time mention, hedged language (maybe/sometimes/kind of)';

const SUMMARY_SYS =
  'Summarize this conversation in 1-3 concise sentences. Focus on: decisions made, ' +
  'topics discussed, preferences expressed, problems solved, and action items. ' +
  'Skip greetings, filler, and meta-commentary. Output plain text only, no JSON.';

const cases = [
  {
    task: 'salience',
    system: SALIENCE_SYS,
    user: 'Text: "My new address is 742 Evergreen Terrace, Portland OR."',
  },
  {
    task: 'contradiction',
    // contradiction caller does NOT pass a system prompt — the whole instruction
    // is embedded in `user` via the single-arg generate() path.
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
    system: SIGNALS_SYS,
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
    system: SUMMARY_SYS,
    user:
      'user: Hey, can you triage my inbox?\n' +
      'assistant: Sure, I found 12 promos and trashed them, and flagged 2 invoices for your review.\n' +
      'user: Great, forward the invoices to accounting@example.com\n' +
      'assistant: Done — forwarded both.',
  },
];

function pct(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.floor((p / 100) * a.length));
  return a[i];
}

console.log(`cpu:     ${os.cpus()[0].model.trim()}  (${os.cpus().length} threads)`);
console.log(`memory:  ${(os.totalmem() / 1e9).toFixed(1)} GB`);
console.log(`model:   ${getBuiltinReasonModelPath()}`);

console.log('\nloading model…');
const tLoad = Date.now();
await initBuiltinReason();
console.log(`loaded in ${Date.now() - tLoad} ms\n`);

const timings = [];
for (const c of cases) {
  // warm
  await builtinGenerate({ system: c.system, user: c.user, task: c.task, maxTokens: 160 });
  const runs = [];
  let preview = '';
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const out = await builtinGenerate({ system: c.system, user: c.user, task: c.task, maxTokens: 160 });
    const dt = Date.now() - t0;
    runs.push(dt); timings.push(dt);
    if (i === 1) preview = (out ?? '').replace(/\s+/g, ' ').slice(0, 100);
  }
  console.log(`${c.task.padEnd(14)} ${String(runs[0]).padStart(5)}ms  ${String(runs[1]).padStart(5)}ms   out="${preview}"`);
}

console.log(`\noverall  p50=${pct(timings, 50)}ms  p95=${pct(timings, 95)}ms  min=${Math.min(...timings)}ms  max=${Math.max(...timings)}ms  n=${timings.length}`);
process.exit(0);
