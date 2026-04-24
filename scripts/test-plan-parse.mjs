#!/usr/bin/env node
/**
 * Direct test harness for the plan model's parse task. Bypasses chat so we
 * can see exactly what the model returns for a given phrase with full
 * temporal grounding — used to diagnose mis-parsed times ("tomorrow at 3pm"
 * coming back as today).
 *
 * Usage:
 *   node scripts/test-plan-parse.mjs "remind me to check the build tomorrow at 3pm"
 *   node scripts/test-plan-parse.mjs        # runs a small built-in battery
 */
import { planGenerate } from '../scheduler/builtin-plan.mjs';

function nowGrounded() {
  const now = new Date();
  const tzOffMin = -now.getTimezoneOffset();
  const sign = tzOffMin >= 0 ? '+' : '-';
  const offH = String(Math.floor(Math.abs(tzOffMin) / 60)).padStart(2, '0');
  const offM = String(Math.abs(tzOffMin) % 60).padStart(2, '0');
  return (
    now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + 'T' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0') +
    sign + offH + ':' + offM
  );
}

async function parseOne(text) {
  const grounded = `Current time: ${nowGrounded()}\nRequest: "${text.replace(/"/g, '\\"')}"`;
  console.log('─'.repeat(70));
  console.log('INPUT:', text);
  console.log('PROMPT:\n' + grounded);
  const raw = await planGenerate({ task: 'parse', user: grounded });
  console.log('RAW:\n' + raw);
  try {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    const parsed = JSON.parse(first >= 0 && last > first ? raw.slice(first, last + 1) : raw);
    const iso = parsed?.schedule?.preferred || parsed?.schedule?.earliest || parsed?.schedule?.latest;
    console.log('PARSED.schedule:', JSON.stringify(parsed.schedule));
    if (iso) {
      const d = new Date(iso);
      console.log('RESOLVED:', d.toString(), '(delta:', Math.round((d - Date.now()) / 60000), 'min from now)');
    }
  } catch (e) {
    console.log('JSON parse failed:', e.message);
  }
}

const args = process.argv.slice(2);
const battery = args.length
  ? args
  : [
      'remind me to check the build tomorrow at 3pm',
      'remind me to call mom in 20 minutes',
      'remind me every morning at 7 to take out the trash',
      'schedule a code review for friday at 2pm',
      'remind me what we talked about yesterday',
    ];

for (const t of battery) {
  await parseOne(t);
}
process.exit(0);
