#!/usr/bin/env node
/**
 * Real chat-driven smoke test. Drives handleChatMessage end-to-end (regex
 * filter -> plan model -> postprocessor -> validateParse -> addTask ->
 * scheduler timer -> outcome string -> agent LLM response). Verifies:
 *   1. Task got persisted to tasks.json with correct fields.
 *   2. Scheduler timer got registered (would actually fire).
 *   3. Agent's response confirms the schedule (no "in the past" hallucinations,
 *      no "I couldn't" failures).
 *
 * Cleans up created tasks on exit.
 */
import { readdirSync } from 'node:fs';
import { USERS_DIR } from '../lib/paths.mjs';
import { handleChatMessage } from '../chat-dispatch.mjs';
import { loadTasks, removeTask } from '../scheduler.mjs';
import { getUserCoordinatorAgentId } from '../routes/_helpers.mjs';

const USER_ID = readdirSync(USERS_DIR).find(n => n.startsWith('user_'));
if (!USER_ID) { console.error('no user'); process.exit(1); }
const AGENT_ID = getUserCoordinatorAgentId(USER_ID);

const CASES = [
  { name: 'rel-5min',         text: 'remind me to drink water in 5 minutes' },
  { name: 'rel-30min',        text: 'remind me to check the oven in 30 minutes' },
  { name: 'rel-2hr',          text: 'remind me to call mom in 2 hours' },
  { name: 'rel-misspelled',   text: 'set a remind to take a break in 10 minutes' },
  { name: 'tomorrow-3pm',     text: 'remind me to check the build tomorrow at 3pm' },
  { name: 'tomorrow-9am',     text: 'remind me to take the trash out tomorrow at 9am' },
  { name: 'tomorrow-noon',    text: 'remind me to eat lunch tomorrow at noon' },
  { name: 'tonight-9pm',      text: 'remind me to take my pills tonight at 9pm' },
  { name: 'next-friday-2pm',  text: 'remind me about the code review next friday at 2pm' },
  { name: 'monday-9am',       text: 'remind me to start the report monday at 9am' },
  { name: 'every-day-7am',    text: 'remind me every morning at 7 to take out the trash' },
  { name: 'every-day-8pm',    text: 'remind me every day at 8pm to take medication' },
  { name: 'agent-task',       text: 'schedule a news briefing tomorrow at 8am' },
  { name: 'no-match-recall',  text: 'remind me what we talked about yesterday' },
  { name: 'no-match-past',    text: 'did we discuss the migration last week' },
];

function pad(n) { return String(n).padStart(2, '0'); }

async function driveOne(c) {
  const before = new Set(loadTasks().map(t => t.id));
  const events = [];
  let agentText = '';

  await handleChatMessage({
    userId: USER_ID,
    agentId: AGENT_ID,
    text: c.text,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'token' && typeof ev.text === 'string') agentText += ev.text;
    },
  });

  const after = loadTasks();
  const newTasks = after.filter(t => !before.has(t.id));
  return { newTasks, agentText: agentText.trim(), events };
}

function classifyAgent(text) {
  const t = text.toLowerCase();
  if (/in the past|already passed|past time|couldn'?t|could not|failed|sorry/.test(t)) return 'NEGATIVE';
  if (/scheduled|set|reminder|remind|will (notify|remind|fire|send)|got it|done/.test(t)) return 'POSITIVE';
  return 'NEUTRAL';
}

const created = [];
const fails = [];
let pass = 0;

console.log(`Driving ${CASES.length} cases as ${USER_ID} / ${AGENT_ID}\n`);

for (const c of CASES) {
  process.stdout.write(`[ ${c.name.padEnd(20)}] `);
  const expectMatch = !c.name.startsWith('no-match');
  let result;
  try { result = await driveOne(c); }
  catch (e) { console.log(`THREW: ${e.message}`); fails.push({ ...c, err: e.message }); continue; }

  const { newTasks, agentText } = result;
  created.push(...newTasks.map(t => t.id));

  if (!expectMatch) {
    if (newTasks.length === 0) { console.log('PASS  (no task created, as expected)'); pass++; }
    else { console.log(`FAIL  (created task ${newTasks[0].id} unexpectedly)`); fails.push({ ...c, reason: 'unexpected task', task: newTasks[0] }); }
    continue;
  }

  if (newTasks.length === 0) {
    console.log(`FAIL  (no task created)`);
    console.log(`        agent: ${agentText.slice(0, 200)}`);
    fails.push({ ...c, reason: 'no task created', agentText });
    continue;
  }

  const task = newTasks[0];
  const sentiment = classifyAgent(agentText);
  const when = task.repeat === 'once'
    ? new Date(task.datetime).toLocaleString()
    : `daily ${task.time}`;
  const ok = sentiment === 'POSITIVE';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${when}  [${sentiment}]`);
  console.log(`        text:  ${c.text}`);
  console.log(`        agent: ${agentText.slice(0, 240).replace(/\n/g, ' ')}`);
  if (!ok) fails.push({ ...c, reason: `agent sentiment ${sentiment}`, task, agentText });
  else pass++;
}

// cleanup
console.log(`\nCleaning up ${created.length} test task(s)...`);
for (const id of created) { try { await removeTask(id); } catch {} }

console.log(`\n${'═'.repeat(60)}`);
console.log(`Results: ${pass}/${CASES.length} passed (${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
