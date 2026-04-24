/**
 * OpenEnsemble Scheduler
 * Runs tasks at set times, saves results to agent sessions.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { getAgent } from './agents.mjs';
import { streamChat } from './chat.mjs';
import { appendToSession } from './sessions.mjs';
import { withLock, getAgentsForUser, getUser, isUserTimeBlocked } from './routes/_helpers.mjs';
import { BASE_DIR, USERS_DIR } from './lib/paths.mjs';
import { log } from './logger.mjs';

const TASKS_DIR      = path.join(BASE_DIR, 'tasks'); // legacy fallback
const TASKS_LOCK_KEY = path.join(BASE_DIR, 'tasks.lock');

// ── Task storage ──────────────────────────────────────────────────────────────

function taskPath(ownerId) {
  // User-owned tasks live in the user's directory; system tasks in legacy tasks/ dir
  if (ownerId && ownerId.startsWith('user_')) return path.join(USERS_DIR, ownerId, 'tasks.json');
  return path.join(TASKS_DIR, `${ownerId}.json`);
}

export function loadTasks() {
  const all = [];
  // Load from user directories
  if (existsSync(USERS_DIR)) {
    try {
      for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(USERS_DIR, entry.name, 'tasks.json');
        try { if (existsSync(p)) all.push(...JSON.parse(readFileSync(p, 'utf8'))); } catch {}
      }
    } catch (e) { console.warn('[scheduler] Failed to read user tasks:', e.message); }
  }
  // Load system tasks from legacy tasks/ dir
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
  const data = loadTasks();
  const result = fn(data);
  saveTasks(data);
  return result;
});

export async function addTask(task) {
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
async function runTask(task, broadcast) {
  console.log(`[scheduler] Running task "${task.label}"`);
  const startedAt = Date.now();
  log.info('scheduler', 'task start', { taskId: task.id, label: task.label, ownerId: task.ownerId, type: task.type });

  try {
    // Honor accessSchedule: a task scheduled during allowed hours that fires during
    // blocked hours is skipped. Daily tasks will try again at the next occurrence;
    // one-time tasks are logged and not rescheduled.
    if (task.ownerId && isUserTimeBlocked(task.ownerId)) {
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
      if (task.repeat === 'once') await removeTask(task.id);
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

    // Write a visible task header into the session before running
    appendToSession(sessionKey, {
      role: 'system',
      content: task.label || task.prompt,
      scheduled: true,
      taskId: task.id,
      ts: Date.now(),
    });

    // Drain the stream with retries — cloud models can return empty on transient failures
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 30_000;
    let succeeded = false;

    const runAttempt = async (attempt) => {
      let failed = false;
      for await (const event of streamChat(scopedAgent, task.prompt, new AbortController().signal, null, userId)) {
        if (event.type === 'error') {
          console.error(`[scheduler] Task "${task.label}" attempt ${attempt}/${MAX_ATTEMPTS} error:`, event.message);
          failed = true;
          break;
        }
      }
      if (!failed) return true;
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[scheduler] Retrying "${task.label}" in ${RETRY_DELAY_MS / 1000}s…`);
        return new Promise(resolve => setTimeout(() => resolve(runAttempt(attempt + 1)), RETRY_DELAY_MS));
      }
      return false;
    };

    succeeded = await runAttempt(1);
    if (!succeeded) console.error(`[scheduler] Task "${task.label}" failed after ${MAX_ATTEMPTS} attempts`);
    else console.log(`[scheduler] Task "${task.label}" complete`);
    const durationMs = Date.now() - startedAt;
    if (succeeded) log.info('scheduler', 'task complete', { taskId: task.id, label: task.label, durationMs });
    else           log.error('scheduler', 'task failed', { taskId: task.id, label: task.label, durationMs, attempts: MAX_ATTEMPTS });

    // One-shot tasks vanish after firing; recurring ones just stamp lastRun.
    if (task.repeat === 'once') await removeTask(task.id);
    else await updateTask(task.id, { lastRun: new Date().toISOString() });

    // Notify any connected WebSocket clients to reload this agent's session
    if (broadcast) broadcast({ type: 'task_complete', taskId: task.id, agent: task.agent });
  } catch (e) {
    console.error(`[scheduler] Task "${task.label}" threw:`, e.message);
    log.error('scheduler', 'task threw', { taskId: task.id, label: task.label, err: e.message });
  }
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
  } else {
    const { hour, minute } = parseTime(task.time);
    delay = msUntilNext(hour, minute, task.timezone ?? null);
    const hhmm = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    label = task.timezone ? `${hhmm} daily (${task.timezone})` : `${hhmm} daily`;
  }

  const eta = new Date(Date.now() + delay);
  console.log(`[scheduler] "${task.label}" scheduled for ${label} (runs at: ${eta.toLocaleString()})`);

  const timerId = setTimeout(async () => {
    _timers.delete(task.id);
    if (!_schedulerRunning) return;
    const current = loadTasks().find(t => t.id === task.id);
    if (current?.enabled) await runTask(current, broadcast);
    // Reschedule only for daily tasks
    if (task.repeat !== 'once') {
      const fresh = loadTasks().find(t => t.id === task.id);
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
  const tasks = loadTasks();
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
