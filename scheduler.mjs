/**
 * OpenEnsemble Scheduler
 * Runs tasks at set times, saves results to agent sessions.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { getAgent } from './agents.mjs';
import { streamChat } from './chat.mjs';
import { appendToSession } from './sessions.mjs';
import { withLock, getAgentsForUser, getUser, isUserTimeBlocked, loadConfig } from './routes/_helpers.mjs';
import { BASE_DIR, USERS_DIR } from './lib/paths.mjs';
import { log } from './logger.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';

const TASKS_DIR      = path.join(BASE_DIR, 'tasks'); // legacy fallback
const TASKS_LOCK_KEY = path.join(BASE_DIR, 'tasks.lock');

// Auto-disable a recurring task after this many consecutive failed fires.
// Each fire already retries MAX_ATTEMPTS=3 times internally, so 5 consecutive
// failures = 15 attempts before we stop. Tasks are re-enabled by the user
// from the tasks drawer once they've fixed whatever was wrong.
const MAX_CONSECUTIVE_FAILURES = 5;

// ── Task storage ──────────────────────────────────────────────────────────────

function taskPath(ownerId) {
  // User-owned tasks live in the user's directory; system tasks in legacy tasks/ dir
  if (ownerId && ownerId.startsWith('user_')) return path.join(USERS_DIR, ownerId, 'tasks.json');
  return path.join(TASKS_DIR, `${ownerId}.json`);
}

// Read every task across every owner. The only legitimate callers are the
// scheduler tick (rehydrating timers on boot, daily-reschedule loop) and
// internal save plumbing — anything user-facing should use loadTasksForOwner
// or findTaskById to keep cross-user pollution structural. Renamed in
// 2026-04-27 after a fake `_test` user dir leaked into the admin UI.
export function loadAllTasksForScheduler() {
  const all = [];
  if (existsSync(USERS_DIR)) {
    try {
      for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(USERS_DIR, entry.name, 'tasks.json');
        try { if (existsSync(p)) all.push(...JSON.parse(readFileSync(p, 'utf8'))); } catch {}
      }
    } catch (e) { console.warn('[scheduler] Failed to read user tasks:', e.message); }
  }
  if (existsSync(TASKS_DIR)) {
    try {
      for (const f of readdirSync(TASKS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try { all.push(...JSON.parse(readFileSync(path.join(TASKS_DIR, f), 'utf8'))); } catch {}
      }
    } catch {}
  }
  return all;
}

// Per-owner read: returns only the tasks stored under this ownerId. Default
// for routes, skills, scheduler-intent — if a caller doesn't know an owner,
// they probably shouldn't be reading tasks.
export function loadTasksForOwner(ownerId) {
  if (!ownerId) return [];
  const p = taskPath(ownerId);
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); } catch {}
  return [];
}

// Owner-scoped lookup by id. Returns null if the task doesn't exist OR
// belongs to a different owner — fails closed so a route handler can't
// accidentally act on someone else's task by id.
export function findTaskById(id, ownerId) {
  if (!id || !ownerId) return null;
  return loadTasksForOwner(ownerId).find(t => t.id === id) ?? null;
}

export function saveTasks(tasks) {
  const byOwner = new Map();
  for (const task of tasks) {
    const key = task.ownerId ?? 'system';
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(task);
  }
  for (const [owner, ownerTasks] of byOwner) {
    const p = taskPath(owner);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(ownerTasks, null, 2));
  }
  // Remove task files for owners with no remaining tasks
  if (existsSync(USERS_DIR)) {
    try {
      for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!byOwner.has(entry.name)) {
          const p = path.join(USERS_DIR, entry.name, 'tasks.json');
          if (existsSync(p)) try { unlinkSync(p); } catch {}
        }
      }
    } catch {}
  }
  if (existsSync(TASKS_DIR)) {
    try {
      for (const f of readdirSync(TASKS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const owner = f.slice(0, -5);
        if (!byOwner.has(owner)) try { unlinkSync(path.join(TASKS_DIR, f)); } catch {}
      }
    } catch {}
  }
}

const modifyTasks = fn => withLock(TASKS_LOCK_KEY, () => {
  const data = loadAllTasksForScheduler();
  const result = fn(data);
  saveTasks(data);
  return result;
});

export async function addTask(task) {
  // INVARIANT: a task must never create a task. If we're executing inside a
  // scheduled run (main turn, barrier reaction, continuation, or ANY delegate /
  // sub-agent it spawned — the ALS context propagates to all of them), refuse.
  // This is the single chokepoint that enforces the rule regardless of which
  // path attempts it: the LLM `schedule_task` tool, the scheduler-intent
  // interceptor, or anything else. Interactive turns (no scheduled context) are
  // unaffected, so "remind me at 5pm" still works.
  if (getScheduledContext()) {
    log.warn('scheduler', 'blocked task creation from within a scheduled run', { label: task?.label, agent: task?.agent });
    throw new Error('A running scheduled task cannot create another task.');
  }
  const id = `task_${Date.now()}`;
  const entry = { id, enabled: true, ...task };
  // modifyTasks goes through withLock and is async — must await or callers
  // get a Promise where they expect a task object (then `task.enabled` is
  // undefined, scheduleTask bails, and chat outcomes show "label=undefined").
  const saved = await modifyTasks(tasks => { tasks.push(entry); return entry; });
  if (_broadcast) {
    _broadcast({ type: 'task_created', task: saved, ownerId: saved.ownerId ?? null });
  }
  return saved;
}

export function removeTask(id) {
  return modifyTasks(tasks => { const i = tasks.findIndex(t => t.id === id); if (i !== -1) tasks.splice(i, 1); });
}

export function updateTask(id, patch) {
  return modifyTasks(tasks => { const i = tasks.findIndex(t => t.id === id); if (i !== -1) Object.assign(tasks[i], patch); });
}

// ── Scheduling ────────────────────────────────────────────────────────────────

// Parse "HH:MM" → { hour, minute }
function parseTime(str) {
  const [h, m] = str.split(':').map(Number);
  return { hour: h, minute: m };
}

// Floor for interval tasks. Each fire wakes an agent/LLM, so a 1-minute minimum
// keeps a runaway "every few seconds" request from hammering the provider.
export const MIN_INTERVAL_MS = 60_000;

// Parse "every N minutes/hours/days", "hourly", "every hour", "every half hour"
// from free text → interval in ms (clamped to MIN_INTERVAL_MS), or null.
// Deliberately does NOT match bare "every day" / "daily" / "every morning" —
// those are clock-anchored daily tasks handled by the HH:MM path, not intervals.
export function parseIntervalPhrase(text) {
  const t = String(text || '').toLowerCase();
  let ms = null, m;
  if ((m = t.match(/\bevery\s+(\d+)\s*(?:minutes?|mins?)\b/)))      ms = Number(m[1]) * 60_000;
  else if (/\bevery\s+(?:a\s+)?minute\b/.test(t))                    ms = 60_000;
  else if ((m = t.match(/\bevery\s+(\d+)\s*(?:hours?|hrs?)\b/)))      ms = Number(m[1]) * 3_600_000;
  else if (/\bevery\s+half\s+(?:an?\s+)?hour\b/.test(t))             ms = 30 * 60_000;
  else if (/\b(?:hourly|every\s+(?:an?\s+)?hour)\b/.test(t))         ms = 3_600_000;
  else if ((m = t.match(/\bevery\s+(\d+)\s*days?\b/)))               ms = Number(m[1]) * 86_400_000;
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(ms, MIN_INTERVAL_MS);
}

// Human-readable interval, e.g. "5 min", "1 hour", "2 hours", "1h 30m", "2 days".
function formatInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '?';
  const totalMin = Math.max(1, Math.round(n / 60_000));
  if (totalMin < 60) return `${totalMin} min`;
  if (totalMin % 60 === 0) {
    const h = totalMin / 60;
    if (h % 24 === 0) { const d = h / 24; return `${d} day${d > 1 ? 's' : ''}`; }
    return `${h} hour${h > 1 ? 's' : ''}`;
  }
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

// Render a task's recurrence cadence for human display. Knows about the dow
// field so multi-weekday schedules render as "Mon/Wed/Fri" instead of being
// misreported as "daily" — same misread that surfaced the Take My Vitamins
// regression in 2026-04. Single-weekday and weekday/weekend ranges get their
// natural names; arbitrary day sets are joined as short names.
const _DOW_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function formatTaskCadence(task) {
  if (!task) return '';
  if (task.repeat === 'once') {
    return task.datetime ? new Date(task.datetime).toLocaleString() : '?';
  }
  if (task.repeat === 'interval') {
    return `every ${formatInterval(task.intervalMs)}`;
  }
  const time = task.time || '?';
  const dow = task.dow;
  if (dow && dow !== '*') {
    if (dow === '1-5') return `${time} weekdays`;
    if (dow === '0,6' || dow === '6,0') return `${time} weekends`;
    const days = parseCronDow(dow);
    if (days && days.size) {
      const ordered = [...days].sort((a, b) => a - b).map(d => _DOW_NAMES_SHORT[d]);
      return `${time} ${ordered.join('/')}`;
    }
  }
  if (task.weekdaysOnly) return `${time} weekdays`;
  if (task.weekendsOnly) return `${time} weekends`;
  return `${time} daily`;
}

function parseCronDow(spec) {
  if (!spec || spec === '*') return null;
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const range = part.trim().match(/^(\d)-(\d)$/);
    if (range) {
      const a = +range[1], b = +range[2];
      if (a >= 0 && b >= 0 && a <= 7 && b <= 7) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let d = lo; d <= hi; d++) out.add(d % 7);
      }
      continue;
    }
    if (/^\d$/.test(part.trim())) out.add(+part.trim() % 7);
  }
  return out.size ? out : new Set();
}

// Ms until next occurrence of HH:MM (daily).
// If `tz` (IANA string, e.g. 'America/New_York') is given, compute the next
// firing in that timezone so DST transitions don't silently shift the reminder.
function msUntilNext(hour, minute, tz = null) {
  const now = new Date();
  if (!tz) {
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
  // Build the timestamp for (today, HH:MM) in the user's local time, then roll
  // forward a day if already past. We compare wall-clock hour/minute in `tz`
  // against the target and advance conservatively — no fancy offset math.
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const nowH = parseInt(parts.hour);
    const nowM = parseInt(parts.minute);
    const nowTotal = nowH * 60 + nowM;
    const targetTotal = hour * 60 + minute;
    // Minutes until the next occurrence
    const deltaMin = targetTotal > nowTotal ? (targetTotal - nowTotal) : (targetTotal - nowTotal + 24 * 60);
    return deltaMin * 60_000;
  } catch (e) {
    console.warn(`[scheduler] Invalid tz "${tz}", falling back to server-local:`, e.message);
    return msUntilNext(hour, minute, null);
  }
}

// Ms until a specific ISO datetime (one-time)
function msUntilDatetime(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(ms, 0);
}

// ── Builtin task handlers ─────────────────────────────────────────────────────

const _builtins = {};

export function registerBuiltin(name, fn) {
  _builtins[name] = fn;
}

// Run a task: builtin handler OR agent chat stream
async function runTask(task, broadcast, opts = {}) {
  // manual: a user pressed "Run now". Bypass day-of-week + access-curfew gating
  // (they asked for it explicitly), never delete a one-shot, and don't touch the
  // consecutive-failure streak — a test fire must not consume or disable a task.
  const manual = opts.manual === true;
  console.log(`[scheduler] Running task "${task.label}"${manual ? ' (manual)' : ''}`);
  const startedAt = Date.now();
  log.info('scheduler', 'task start', { taskId: task.id, label: task.label, ownerId: task.ownerId, type: task.type, manual });

  try {
    if (!manual && task.repeat !== 'once') {
      const day = new Date().getDay();
      const allowed = parseCronDow(task.dow);
      if (allowed && !allowed.has(day)) {
        const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day];
        console.log(`[scheduler] Task "${task.label}" skipped — dow="${task.dow}", today is ${dayName}`);
        await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: `Skipped: ${dayName} not in dow=${task.dow}` });
        return;
      }
      // Legacy boolean fallback for tasks created before the dow field was added.
      if (!task.dow) {
        if (task.weekdaysOnly && (day === 0 || day === 6)) {
          console.log(`[scheduler] Task "${task.label}" skipped — weekdaysOnly, today is ${day === 0 ? 'Sunday' : 'Saturday'}`);
          await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: 'Skipped: weekend (weekdaysOnly)' });
          return;
        }
        if (task.weekendsOnly && day >= 1 && day <= 5) {
          console.log(`[scheduler] Task "${task.label}" skipped — weekendsOnly, today is a weekday`);
          await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: 'Skipped: weekday (weekendsOnly)' });
          return;
        }
      }
    }

    // Honor accessSchedule: a task scheduled during allowed hours that fires during
    // blocked hours is skipped. Daily tasks will try again at the next occurrence;
    // one-time tasks are logged and not rescheduled.
    if (!manual && task.ownerId && isUserTimeBlocked(task.ownerId)) {
      console.log(`[scheduler] Task "${task.label}" skipped — owner ${task.ownerId} is in scheduled blocked hours.`);
      log.info('scheduler', 'task skipped (time-blocked)', { taskId: task.id, label: task.label, ownerId: task.ownerId });
      // One-shot tasks vanish after firing (or being skipped); daily tasks
      // keep their lastRun/lastOutput so the user can see they ran.
      if (task.repeat === 'once') await removeTask(task.id);
      else await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: 'Skipped: access restricted at this time' });
      return;
    }

    if (task.type === 'builtin' || task.type === 'reminder') {
      const handler = _builtins[task.handler];
      if (!handler) {
        console.error(`[scheduler] No builtin handler "${task.handler}" for task "${task.id}"`);
        await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: `Error: no handler "${task.handler}"`, enabled: false });
        return;
      }
      const output = await handler(task);
      console.log(`[scheduler] Task "${task.label}" complete: ${output}`);
      log.info('scheduler', 'builtin task complete', { taskId: task.id, label: task.label, handler: task.handler, durationMs: Date.now() - startedAt });
      if (task.repeat === 'once' && !manual) await removeTask(task.id);
      else await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: output });
      if (broadcast) broadcast({ type: 'task_complete', taskId: task.id, agent: task.agent ?? 'system' });
      return;
    }

    const userId = task.ownerId ?? 'default';

    // Resolve agent the same way the interactive path does — includes tools and overrides.
    // Children have no registry fallback: task.agent must resolve against their own roster or fail.
    const isChild = getUser(userId)?.role === 'child';
    const resolved = getAgentsForUser(userId).find(a => a.id === task.agent)
      ?? (isChild ? null : getAgent(task.agent));
    if (!resolved) {
      console.error(`[scheduler] Unknown agent "${task.agent}" for task "${task.id}"`);
      return;
    }

    // Scope agent ID to user session, matching the interactive chat path
    const sessionKey = `${userId}_${resolved.id}`;
    const scopedAgent = { ...resolved, id: sessionKey };

    // Write a visible task header into the session before running. Silent
    // tasks skip this — they leave no chat trail at all; the user sees
    // confirmation as a "Last run" line in the tasks drawer instead.
    if (!task.silent) {
      appendToSession(sessionKey, {
        role: 'system',
        content: task.label || task.prompt,
        scheduled: true,
        taskId: task.id,
        ts: Date.now(),
      });
    }

    // The agent is firing on a schedule with no human present. Without this
    // note, "send me an email" makes the agent ask "what address?" or show a
    // draft and wait for "send it" — the email skill's default safety rule.
    // Resolves "me" to the user's own email and overrides the draft-first
    // rule for this run so the action actually happens.
    const ownerProfile = task.ownerId ? getUser(task.ownerId) : null;
    const userEmailLine = ownerProfile?.email
      ? `\nThe user's own email address is ${ownerProfile.email} — if the request says "send me an email" / "email myself", that is the recipient.`
      : '';
    const scheduledNote =
      `[SCHEDULED RUN] You are executing a previously-scheduled task right now. ` +
      `The user is NOT present and cannot answer follow-up questions. ` +
      `Any "in N minutes" / "tomorrow" / "at HH:MM" phrases in the request are the trigger time that has already arrived — do not try to re-schedule. ` +
      `The user's original scheduling message IS the confirmation: execute every action directly and do NOT show drafts, ask "are you sure?", or wait for "send it"/"confirm" — there is no one here to answer. ` +
      `This overrides any "show draft and wait for approval" rule from skill prompts (email, finance, etc) for this run. ` +
      `Use reasonable defaults for anything unspecified, complete the task, and report in your final message what you did (including a Message ID if a tool returned one).` +
      userEmailLine;

    // Run with shared retry helper. Failure shapes handled there:
    //   1. streamChat yields {type:'error', message}
    //   2. streamChat throws (fetch failed at network layer)
    // Original gap that left an orphan header for "Check Proxmox Zpool"
    // 2026-05-06 was the un-caught throw; the helper try/catches it.
    const { runAgentWithRetry } = await import('./lib/run-agent-with-retry.mjs');
    const { registerScheduledMain, completeScheduledMain } = await import('./lib/scheduled-child-barrier.mjs');
    const MAX_ATTEMPTS = 3;

    // The main turn may delegate / auto-background work that outlives it. Track
    // the main run as a barrier child BEFORE it starts so the group can't drain
    // (and finalize) early; finalization is handed to the barrier below and
    // happens exactly once — now if nothing backgrounded, or later when the
    // last background child drains. Returning promptly here keeps recurring /
    // interval re-arm from blocking on slow background work.
    const scheduledCtx = {
      originTaskId: task.id,
      originTaskOwnerId: userId,
      originTaskAgent: task.agent,
      scheduledNote,
      manual,
    };
    // DIAGNOSTIC TOGGLE: config.scheduler.childBarrier === false bypasses the
    // barrier entirely (no child tracking, no reaction turn) and finalizes
    // directly after the main turn — the pre-barrier behavior. Read fresh so it
    // flips between Run-now fires without a restart.
    const useChildBarrier = loadConfig()?.scheduler?.childBarrier !== false;
    if (useChildBarrier) registerScheduledMain({ userId, scheduledCtx, label: task.label || 'scheduled run' });
    else log.warn('scheduler', 'CHILD BARRIER DISABLED (diagnostic)', { taskId: task.id });

    const { succeeded, lastError, assistantContent } = await runAgentWithRetry({
      scopedAgent, userText: task.prompt, systemNote: scheduledNote, userId, streamChat,
      maxAttempts: MAX_ATTEMPTS,
      context: 'scheduler',
      silent: !!task.silent,
      originTaskId: task.id,
      originTaskOwnerId: userId,
      originTaskAgent: task.agent,
    });

    if (!succeeded) console.error(`[scheduler] Task "${task.label}" main turn failed after ${MAX_ATTEMPTS} attempts`);
    else console.log(`[scheduler] Task "${task.label}" main turn complete`);
    const durationMs = Date.now() - startedAt;
    if (succeeded) log.info('scheduler', 'task main complete', { taskId: task.id, label: task.label, durationMs });
    else           log.error('scheduler', 'task failed', { taskId: task.id, label: task.label, durationMs, attempts: MAX_ATTEMPTS, err: lastError });

    // Hand finalization to the barrier. `onContinue` reacts to background
    // results (no-op when nothing backgrounded); `onFinalize` stamps the task
    // exactly once when the group truly drains. A scheduled task "succeeded"
    // only if the main turn succeeded AND no background child errored.
    if (useChildBarrier) {
      completeScheduledMain({
        userId,
        scheduledCtx,
        resultText: assistantContent || '',
        errorMsg: succeeded ? null : (lastError || 'unknown'),
        meta: { manual },
        onContinue: (aggregate) => runScheduledReaction({ task, scheduledCtx, userId, aggregate }),
        onFinalize: (aggregate, info = {}) => finalizeScheduledTask(task, {
          succeeded: succeeded && (info.errorCount || 0) === 0,
          output: (aggregate && aggregate.trim()) ? aggregate : assistantContent,
          lastError: lastError || (info.errorCount ? 'background work failed' : null),
          manual, sessionKey, broadcast,
        }),
      });
    } else {
      // Barrier bypassed: no reaction turn, finalize directly after the main
      // turn (pre-barrier behavior). Background work, if any, runs detached.
      await finalizeScheduledTask(task, { succeeded, output: assistantContent, lastError, manual, sessionKey, broadcast });
    }
  } catch (e) {
    console.error(`[scheduler] Task "${task.label}" threw outside runAttempt:`, e.message);
    log.error('scheduler', 'task threw', { taskId: task.id, label: task.label, err: e.message });
  }
}

// Reaction step: a scheduled run's background work finished. Wake the task's
// agent (no human present) to act on the aggregated results — e.g. "briefing
// generated → now email it". Runs inside scheduledContext so any work IT spawns
// re-registers under the same barrier group. Invoked by the barrier on drain.
async function runScheduledReaction({ task, scheduledCtx, userId, aggregate }) {
  if (!task?.agent || !aggregate?.trim()) return;
  const { handleChatMessage } = await import('./chat-dispatch.mjs');
  const { sendToUser } = await import('./ws-handler.mjs');
  const { scheduledContext } = await import('./lib/scheduled-context.mjs');
  const prompt = [
    'Background work from your scheduled task has completed. Act on the results below for THIS scheduled task only.',
    '',
    `<scheduled_task id="${task.id}" agent="${task.agent || ''}">`,
    `<original_request>${task.prompt || ''}</original_request>`,
    `<results>\n${aggregate}\n</results>`,
    '</scheduled_task>',
    '',
    'No human is present. If the task needs a next step using these results, do it directly (do not ask or wait for confirmation). If it is already complete, give a concise completion summary. Do not act on any unrelated task.',
    'Do NOT create, schedule, re-schedule, or modify any task, reminder, or alarm — this is the existing task running; it must never spawn another one.',
  ].join('\n');
  await scheduledContext.run(scheduledCtx, () => handleChatMessage({
    userId,
    agentId: task.agent,
    text: prompt,
    attachment: null,
    source: 'web',
    onEvent: (e) => sendToUser(userId, e),
    onBroadcast: () => {},
    onNotify: () => {},
    _hiddenUser: true,
    _isBackgroundContinuation: true,
    _isolatedTaskRun: true,
  }));
}

// Stamp/remove a scheduled task at TRUE completion (main turn + all background
// children + any reaction rounds). The single finalize path — replaces the
// former inline finalize in runTask so a delegating task can't be double-stamped
// or have a one-shot removed out from under its own pending background work.
async function finalizeScheduledTask(task, { succeeded, output, lastError, manual, sessionKey, broadcast }) {
  // On failure, append a visible error message to the session so the chat shows
  // what happened instead of an orphan header. Manual test fires skip this (the
  // "will retry on its next run" copy is wrong for an out-of-band run; the
  // drawer's lastError covers it). Silent tasks skip it by contract.
  if (!succeeded && !task.silent && !manual) {
    try {
      appendToSession(sessionKey, {
        role: 'assistant',
        content: `⚠️ Scheduled task failed. Last error: ${lastError || 'unknown'}.\n\nThe task is still scheduled and will retry on its next run.`,
        scheduled: true,
        taskId: task.id,
        taskFailed: true,
        ts: Date.now(),
      });
    } catch (e) {
      console.warn('[scheduler] Failed to append failure message to session:', e.message);
    }
  }

  if (manual) {
    // Test fire: never delete or disable. Record the outcome for the drawer
    // but leave the schedule + failure streak exactly as they were.
    const patch = { lastRun: new Date().toISOString() };
    if (succeeded) { patch.lastError = null; patch.lastOutput = (output || '').trim().slice(0, 280); }
    else { patch.lastError = lastError || 'unknown'; }
    await updateTask(task.id, patch);
  } else if (task.repeat === 'once') {
    // One-shot tasks vanish after firing.
    await removeTask(task.id);
  } else {
    const patch = { lastRun: new Date().toISOString() };
    // Cross-fire failure tracking. Per-fire retry (MAX_ATTEMPTS) handles
    // transient blips; this counter handles the broken-forever case — a cron
    // task whose handler can never succeed shouldn't keep burning tokens every
    // cycle. Resets to 0 on any successful fire.
    const prevStreak = Number(task.consecutiveFailures) || 0;
    if (!succeeded) {
      patch.lastError = lastError || 'unknown';
      patch.consecutiveFailures = prevStreak + 1;
      if (patch.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        patch.enabled = false;
        patch.disabledReason = `auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failed fires; last error: ${lastError || 'unknown'}`;
        if (!task.silent) {
          try {
            appendToSession(sessionKey, {
              role: 'assistant',
              content: `⛔ Scheduled task "${task.label}" auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failed fires. Last error: ${lastError || 'unknown'}.\n\nRe-enable it from the tasks drawer once the underlying issue is fixed.`,
              scheduled: true,
              taskId: task.id,
              taskAutoDisabled: true,
              ts: Date.now(),
            });
          } catch (e) {
            console.warn('[scheduler] Failed to append auto-disable message:', e.message);
          }
        }
        log.warn('scheduler', 'task auto-disabled', { taskId: task.id, label: task.label, streak: patch.consecutiveFailures, lastError });
      }
    } else {
      patch.lastError = null; // clear stale error on next success
      if (prevStreak) patch.consecutiveFailures = 0;
      // Capture the final reply as lastOutput so the tasks drawer can show what
      // happened — the only feedback channel for silent runs.
      patch.lastOutput = (output || '').trim().slice(0, 280);
    }
    await updateTask(task.id, patch);
  }

  if (broadcast) broadcast({ type: 'task_complete', taskId: task.id, agent: task.agent });
}

// Track pending timers so we can cancel them on shutdown
const _timers = new Map(); // taskId -> timeoutId

// Schedule a single task (schedules → runs → reschedules daily, or runs once)
function scheduleTask(task, broadcast) {
  if (!task.enabled) return;

  // Clear any existing timer for this task before scheduling a new one
  if (_timers.has(task.id)) { clearTimeout(_timers.get(task.id)); _timers.delete(task.id); }

  let delay, label;
  if (task.repeat === 'once') {
    if (!task.datetime) return;
    delay = msUntilDatetime(task.datetime);
    label = new Date(task.datetime).toLocaleString();
  } else if (task.repeat === 'interval') {
    // Fixed-cadence tasks: fire one interval from now, then re-arm after each
    // run (handled by the reschedule below, same as daily). A missing/invalid
    // intervalMs means a malformed task — skip rather than spin every minute.
    const raw = Number(task.intervalMs);
    if (!Number.isFinite(raw) || raw <= 0) {
      console.warn(`[scheduler] Task "${task.label}" has invalid intervalMs=${task.intervalMs}; not scheduled.`);
      return;
    }
    delay = Math.max(raw, MIN_INTERVAL_MS);
    label = `every ${formatInterval(delay)}`;
  } else {
    const { hour, minute } = parseTime(task.time);
    delay = msUntilNext(hour, minute, task.timezone ?? null);
    const hhmm = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    const cadence = formatTaskCadence({ ...task, time: hhmm }).replace(/^\S+\s+/, '');
    label = task.timezone ? `${hhmm} ${cadence} (${task.timezone})` : `${hhmm} ${cadence}`;
  }

  const eta = new Date(Date.now() + delay);
  console.log(`[scheduler] "${task.label}" scheduled for ${label} (runs at: ${eta.toLocaleString()})`);

  const timerId = setTimeout(async () => {
    _timers.delete(task.id);
    if (!_schedulerRunning) return;
    const current = task.ownerId ? findTaskById(task.id, task.ownerId)
                                 : loadAllTasksForScheduler().find(t => t.id === task.id);
    if (current?.enabled) await runTask(current, broadcast);
    if (task.repeat !== 'once') {
      const fresh = task.ownerId ? findTaskById(task.id, task.ownerId)
                                 : loadAllTasksForScheduler().find(t => t.id === task.id);
      if (fresh) scheduleTask(fresh, broadcast);
    }
  }, delay);
  _timers.set(task.id, timerId);
}

// ── Public API ────────────────────────────────────────────────────────────────

let _broadcast = null;

let _schedulerRunning = false;

export function startScheduler(broadcast) {
  _broadcast = broadcast;
  _schedulerRunning = true;
  const tasks = loadAllTasksForScheduler();
  if (!tasks.length) {
    console.log('[scheduler] No tasks configured.');
    return;
  }
  for (const task of tasks) scheduleTask(task, broadcast);
}

export function isSchedulerRunning() { return _schedulerRunning; }

export function stopScheduler() {
  _schedulerRunning = false;
  for (const [id, timerId] of _timers) clearTimeout(timerId);
  _timers.clear();
  console.log('[scheduler] Stopped — all pending tasks cancelled');
}

// Schedule a newly-added task immediately (called after addTask)
export function scheduleNewTask(task) {
  scheduleTask(task, _broadcast);
}

// Run a task NOW, out of band, without disturbing its schedule. Used by the
// "Run now" button to test a task immediately. Bypasses day/curfew gating,
// never deletes a one-shot, and never touches the failure streak (see runTask's
// `manual` flag). Returns the runTask promise so callers can await completion.
export async function runTaskNow(id, ownerId) {
  const task = findTaskById(id, ownerId);
  if (!task) throw new Error(`Task ${id} not found`);
  return runTask(task, _broadcast, { manual: true });
}
