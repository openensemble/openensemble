#!/usr/bin/env node
/**
 * End-to-end task-creation test harness.
 *
 * Drives `interceptScheduling()` (the same code path the chat dispatcher
 * uses) with a battery of natural-language reminder/task phrases and grades
 * each one against an expected schedule. Prints per-case PASS/FAIL with
 * captured plan-model output for failures, and a summary at the end.
 *
 * Created tasks are removed at the end so tasks.json stays clean. Failures
 * are also written to scripts/test-task-creation.failures.jsonl so they can
 * be triaged into new training rows for the parse task.
 *
 * Usage:
 *   node scripts/test-task-creation.mjs                 # run full battery
 *   node scripts/test-task-creation.mjs --keep          # don't delete created tasks
 *   node scripts/test-task-creation.mjs --user <userId> # default: first user found
 *   node scripts/test-task-creation.mjs --only "tomorrow"   # filter cases by substring
 */
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USERS_DIR } from '../lib/paths.mjs';
import { interceptScheduling } from '../lib/scheduler-intent.mjs';
import { loadTasks, removeTask } from '../scheduler.mjs';
import { getUserCoordinatorAgentId } from '../routes/_helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function firstUserId() {
  try {
    return readdirSync(USERS_DIR).find((n) => n.startsWith('user_')) ?? null;
  } catch { return null; }
}

// ── arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const KEEP    = flag('--keep');
const USER_ID = argVal('--user') || firstUserId();
if (!USER_ID) {
  console.error('no user found — pass --user <userId> or create a user first');
  process.exit(1);
}
const ONLY    = argVal('--only');

// ── test case definitions ────────────────────────────────────────────────────
// `expect` shapes:
//   { kind: 'no-match' }                                  → expects regex/parse to NOT create a task
//   { kind: 'reminder', offsetMinutes: N, tolerance: M }  → relative offset (±M min)
//   { kind: 'reminder', dayOffset: N, hour: H, minute: M, tolerance: T } → absolute future time
//   { kind: 'reminder', dailyTime: 'HH:MM' }              → recurring daily
//   { kind: 'agent-task', ... }                           → same as reminder but task has agent+prompt
const CASES = [
  // ── relative offsets ──
  {
    name: 'relative-short-minutes',
    text: 'remind me to drink water in 10 minutes',
    expect: { kind: 'reminder', offsetMinutes: 10, tolerance: 2 },
  },
  {
    name: 'relative-hour',
    text: 'remind me to call mom in 2 hours',
    expect: { kind: 'reminder', offsetMinutes: 120, tolerance: 5 },
  },
  {
    name: 'relative-five-min',
    text: 'remind me to check the oven in 5 minutes',
    expect: { kind: 'reminder', offsetMinutes: 5, tolerance: 2 },
  },

  // ── tomorrow-at ──
  {
    name: 'tomorrow-at-3pm',
    text: 'remind me to check the build tomorrow at 3pm',
    expect: { kind: 'reminder', dayOffset: 1, hour: 15, minute: 0, tolerance: 5 },
  },
  {
    name: 'tomorrow-at-9am',
    text: 'remind me to take the trash out tomorrow at 9am',
    expect: { kind: 'reminder', dayOffset: 1, hour: 9, minute: 0, tolerance: 5 },
  },
  {
    name: 'tomorrow-at-noon',
    text: 'remind me to eat lunch tomorrow at noon',
    expect: { kind: 'reminder', dayOffset: 1, hour: 12, minute: 0, tolerance: 10 },
  },

  // ── tonight ──
  {
    name: 'tonight-at-9',
    text: 'remind me to take my pills tonight at 9pm',
    expect: { kind: 'reminder', dayOffset: 0, hour: 21, minute: 0, tolerance: 10 },
  },

  // ── weekday-at ──
  {
    name: 'next-friday-at-2pm',
    text: 'remind me about the code review next friday at 2pm',
    expect: { kind: 'reminder', dayName: 'friday', hour: 14, minute: 0, tolerance: 10, allowSameWeekday: false },
  },
  {
    name: 'monday-at-9am',
    text: 'remind me to start the report monday at 9am',
    expect: { kind: 'reminder', dayName: 'monday', hour: 9, minute: 0, tolerance: 10, allowSameWeekday: true },
  },

  // ── recurring daily ──
  {
    name: 'every-morning-at-7',
    text: 'remind me every morning at 7 to take out the trash',
    expect: { kind: 'reminder', dailyTime: '07:00' },
  },
  {
    name: 'every-day-at-8pm',
    text: 'remind me every day at 8pm to take medication',
    expect: { kind: 'reminder', dailyTime: '20:00' },
  },

  // ── agent task (not a reminder) ──
  {
    name: 'schedule-news-tomorrow',
    text: 'schedule a news briefing tomorrow at 8am',
    expect: { kind: 'agent-task', dayOffset: 1, hour: 8, minute: 0, tolerance: 10 },
  },

  // ── negative cases (should NOT create a task) ──
  {
    name: 'memory-recall-yesterday',
    text: 'remind me what we talked about yesterday',
    expect: { kind: 'no-match' },
  },
  {
    name: 'memory-recall-the-time',
    text: 'remind me about that time we went hiking',
    expect: { kind: 'no-match' },
  },
  {
    name: 'past-tense-question',
    text: 'did we discuss the migration last week',
    expect: { kind: 'no-match' },
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function describeOutcome(expect) {
  if (expect.kind === 'no-match') return 'no task created';
  if (expect.dailyTime) return `daily @ ${expect.dailyTime}`;
  if (expect.dayName) return `next ${expect.dayName} ${pad(expect.hour)}:${pad(expect.minute)}`;
  if (expect.dayOffset != null) return `${expect.dayOffset === 0 ? 'today' : expect.dayOffset === 1 ? 'tomorrow' : `+${expect.dayOffset}d`} ${pad(expect.hour)}:${pad(expect.minute)}`;
  if (expect.offsetMinutes != null) return `+${expect.offsetMinutes} min`;
  return JSON.stringify(expect);
}
function pad(n) { return String(n).padStart(2, '0'); }

function gradeTask(task, expect, anchor) {
  if (expect.kind === 'no-match') {
    if (!task) return { ok: true, msg: 'no task created (as expected)' };
    return { ok: false, msg: `unexpected task created: ${task.repeat === 'once' ? task.datetime : `daily @ ${task.time}`}` };
  }
  if (!task) return { ok: false, msg: 'no task created' };

  // Reminder vs agent task shape
  const isReminder = task.type === 'reminder';
  if (expect.kind === 'reminder' && !isReminder) {
    return { ok: false, msg: `created agent task, expected reminder (label=${task.label})` };
  }
  if (expect.kind === 'agent-task' && isReminder) {
    return { ok: false, msg: `created reminder, expected agent task` };
  }

  // Recurrence
  if (expect.dailyTime) {
    if (task.repeat !== 'daily') return { ok: false, msg: `expected daily, got repeat=${task.repeat}` };
    if (task.time !== expect.dailyTime) return { ok: false, msg: `daily time wrong: got ${task.time}, expected ${expect.dailyTime}` };
    return { ok: true, msg: `daily @ ${task.time}` };
  }

  // One-shot — must have datetime
  if (task.repeat !== 'once') return { ok: false, msg: `expected one-shot, got repeat=${task.repeat}` };
  if (!task.datetime) return { ok: false, msg: 'one-shot task has no datetime' };
  const fired = new Date(task.datetime);
  if (Number.isNaN(fired.getTime())) return { ok: false, msg: `invalid datetime: ${task.datetime}` };

  // Relative offset
  if (expect.offsetMinutes != null) {
    const actualMin = (fired - anchor) / 60000;
    const delta = Math.abs(actualMin - expect.offsetMinutes);
    if (delta > expect.tolerance) {
      return { ok: false, msg: `wrong offset: got ${Math.round(actualMin)} min, expected ${expect.offsetMinutes} ±${expect.tolerance} (delta ${delta.toFixed(1)})` };
    }
    return { ok: true, msg: `+${Math.round(actualMin)} min (target ${expect.offsetMinutes})` };
  }

  // Day-name (next weekday)
  if (expect.dayName) {
    const wantDow = DAYS.indexOf(expect.dayName);
    if (fired.getDay() !== wantDow) {
      return { ok: false, msg: `wrong weekday: got ${DAYS[fired.getDay()]}, expected ${expect.dayName}` };
    }
    return checkHourMinute(fired, expect, `${DAYS[fired.getDay()]} ${pad(fired.getHours())}:${pad(fired.getMinutes())}`);
  }

  // dayOffset + hour/minute
  if (expect.dayOffset != null) {
    const expectedDay = new Date(anchor);
    expectedDay.setDate(expectedDay.getDate() + expect.dayOffset);
    if (fired.getDate() !== expectedDay.getDate() || fired.getMonth() !== expectedDay.getMonth()) {
      return { ok: false, msg: `wrong date: got ${fired.toDateString()}, expected ${expectedDay.toDateString()}` };
    }
    return checkHourMinute(fired, expect, `${fired.toDateString()} ${pad(fired.getHours())}:${pad(fired.getMinutes())}`);
  }

  return { ok: false, msg: 'no grading rule matched' };
}

function checkHourMinute(fired, expect, friendly) {
  const got = fired.getHours() * 60 + fired.getMinutes();
  const want = expect.hour * 60 + expect.minute;
  const delta = Math.abs(got - want);
  if (delta > expect.tolerance) {
    return { ok: false, msg: `wrong time of day: got ${pad(fired.getHours())}:${pad(fired.getMinutes())}, expected ${pad(expect.hour)}:${pad(expect.minute)} (±${expect.tolerance} min)` };
  }
  return { ok: true, msg: friendly };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const agentId = getUserCoordinatorAgentId(USER_ID);
  if (!agentId) {
    console.error(`No coordinator agent found for ${USER_ID} — is the user set up?`);
    process.exit(2);
  }
  console.log(`Running ${CASES.length} cases as ${USER_ID} / ${agentId}\n`);

  const cases = ONLY ? CASES.filter(c => c.name.includes(ONLY) || c.text.toLowerCase().includes(ONLY.toLowerCase())) : CASES;
  if (!cases.length) {
    console.error(`No cases match --only "${ONLY}"`);
    process.exit(2);
  }

  const createdIds = [];
  const failures = [];
  let pass = 0;

  for (const c of cases) {
    const anchor = new Date();
    const before = new Set(loadTasks().map(t => t.id));
    let outcome, error;
    try {
      outcome = await interceptScheduling({ userId: USER_ID, agentId, text: c.text });
    } catch (e) {
      error = e;
    }
    // Find the newly-created task (if any)
    const after = loadTasks();
    const newTasks = after.filter(t => !before.has(t.id));
    if (newTasks.length) createdIds.push(...newTasks.map(t => t.id));
    const newTask = newTasks[0] || null;

    const grade = error
      ? { ok: false, msg: `threw: ${error.message}` }
      : gradeTask(newTask, c.expect, anchor);

    const expectedStr = describeOutcome(c.expect);
    const tag = grade.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`[${tag}] ${c.name.padEnd(28)} ${c.text}`);
    console.log(`         expected: ${expectedStr}`);
    console.log(`         actual:   ${grade.msg}`);
    if (!grade.ok) {
      console.log(`         outcome:  ${outcome?.outcome || '(no outcome)'}`);
      if (newTask) console.log(`         task:     ${JSON.stringify({ label: newTask.label, datetime: newTask.datetime, time: newTask.time, repeat: newTask.repeat, type: newTask.type })}`);
      failures.push({ ...c, anchorIso: anchor.toISOString(), outcome: outcome?.outcome, task: newTask, gradeMsg: grade.msg });
    } else {
      pass++;
    }
    console.log('');
  }

  // ── cleanup ──
  if (!KEEP && createdIds.length) {
    console.log(`Cleaning up ${createdIds.length} test task(s)...`);
    for (const id of createdIds) removeTask(id);
  } else if (KEEP) {
    console.log(`--keep flag set; left ${createdIds.length} test task(s) in tasks.json`);
  }

  // ── summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Results: ${pass}/${cases.length} passed (${cases.length - pass} failed)`);
  if (failures.length) {
    const failPath = path.join(__dirname, 'test-task-creation.failures.jsonl');
    writeFileSync(failPath, failures.map(f => JSON.stringify(f)).join('\n') + '\n');
    console.log(`Failure details written to: ${failPath}`);
    console.log(`These are candidates for new training rows in training/plan/data/parse.jsonl`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
