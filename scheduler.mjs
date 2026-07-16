/**
 * OpenEnsemble Scheduler
 * Runs tasks at set times, saves results to agent sessions.
 */

import { readFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { streamChat } from './chat.mjs';
import { appendToSession, appendSessionReportOnce } from './sessions.mjs';
import { withLock, atomicWriteSync, resolveRuntimeAgentForUser, getUser, isUserTimeBlocked, loadConfig } from './routes/_helpers.mjs';
import { BASE_DIR, USERS_DIR } from './lib/paths.mjs';
import { log } from './logger.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';
import { appendTaskRun } from './lib/task-runs.mjs';
import { tryAcquireUserTurnLease } from './chat-dispatch/slot-registry.mjs';

// Run-history is only meaningful for user-owned tasks — system tasks (owned
// by the 'system' pseudo-owner) live outside any user's directory and have
// no per-user drawer to read this back from.
function recordTaskRun(task, row) {
  if (!task?.ownerId || !String(task.ownerId).startsWith('user_')) return;
  appendTaskRun(task.ownerId, { taskId: task.id, taskName: task.label, ...row })
    .catch(e => console.warn('[scheduler] appendTaskRun failed:', e.message));
}

const TASKS_DIR      = path.join(BASE_DIR, 'tasks'); // legacy fallback
const TASKS_LOCK_KEY = path.join(BASE_DIR, 'tasks.lock');

// Auto-disable a recurring task after this many consecutive failed fires.
// Each fire already retries MAX_ATTEMPTS=3 times internally, so 5 consecutive
// failures = 15 attempts before we stop. Tasks are re-enabled by the user
// from the tasks drawer once they've fixed whatever was wrong.
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Correlate one hidden scheduled reaction with its durable occurrence while
 * still minting a fresh execution attempt. If the same occurrence is replayed
 * after an ambiguous provider boundary, email's scope ledger sees the stable
 * root plus a different attempt and fails closed on a changed resend.
 */
export function scheduledReactionTraceOptions(scheduledCtx) {
  const rootTaskId = String(scheduledCtx?.runId || '').trim() || null;
  return {
    _rootTaskId: rootTaskId,
    _sideEffectAttemptId: `scheduled_reaction_${randomUUID().replaceAll('-', '')}`,
  };
}

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

// A task file is only safe to DELETE (as "this owner has no tasks now") if we
// can actually read it. An unparseable file was silently skipped by
// loadAllTasksForScheduler, so its owner being absent from byOwner means "we
// failed to read them", not "they have no tasks" — deleting would turn a
// transient/corrupt read into permanent task loss.
function taskFileParses(p) {
  try { JSON.parse(readFileSync(p, 'utf8')); return true; } catch { return false; }
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
    // Atomic (temp-file + rename) so a crash mid-write can't leave a truncated
    // tasks.json that the next load skips and this function then deletes.
    atomicWriteSync(p, JSON.stringify(ownerTasks, null, 2));
  }
  // Remove task files for owners with no remaining tasks — but only files we can
  // parse (see taskFileParses), so a corrupt file is preserved for recovery.
  if (existsSync(USERS_DIR)) {
    try {
      for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!byOwner.has(entry.name)) {
          const p = path.join(USERS_DIR, entry.name, 'tasks.json');
          if (existsSync(p) && taskFileParses(p)) try { unlinkSync(p); } catch {}
        }
      }
    } catch {}
  }
  if (existsSync(TASKS_DIR)) {
    try {
      for (const f of readdirSync(TASKS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const owner = f.slice(0, -5);
        const p = path.join(TASKS_DIR, f);
        if (!byOwner.has(owner) && taskFileParses(p)) try { unlinkSync(p); } catch {}
      }
    } catch {}
  }
}

// Save ONE owner's task list (no lock — callers hold TASKS_LOCK_KEY).
// Atomic write; an empty list removes the file (only if it parses, matching
// saveTasks' corrupt-file preservation rule).
function saveOwnerTasks(ownerKey, tasks) {
  const p = taskPath(ownerKey);
  if (!tasks.length) {
    if (existsSync(p) && taskFileParses(p)) try { unlinkSync(p); } catch {}
    return;
  }
  mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(tasks, null, 2));
}

// Which owner file holds this task id? Read-only scan, first hit wins —
// mirrors loadAllTasksForScheduler's sources without concatenating them.
function findOwnerKeyForTask(id) {
  if (existsSync(USERS_DIR)) {
    try {
      for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(USERS_DIR, entry.name, 'tasks.json');
        try {
          if (existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).some(t => t?.id === id)) return entry.name;
        } catch {}
      }
    } catch {}
  }
  if (existsSync(TASKS_DIR)) {
    try {
      for (const f of readdirSync(TASKS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          if (JSON.parse(readFileSync(path.join(TASKS_DIR, f), 'utf8')).some(t => t?.id === id)) return f.slice(0, -5);
        } catch {}
      }
    } catch {}
  }
  return null;
}

// Per-owner mutation. The old modifyTasks was load-ALL + save-ALL: every
// lastRun stamp re-serialized every owner's tasks.json and swept every
// owner's file for deletion. The owner is always derivable (task.ownerId on
// create, id→owner scan on update/remove), so mutations now touch exactly
// one file. Same lock key, so concurrent mutations still serialize.
const modifyTasksForOwner = (ownerKey, fn) => withLock(TASKS_LOCK_KEY, () => {
  const tasks = loadTasksForOwner(ownerKey);
  const result = fn(tasks);
  saveOwnerTasks(ownerKey, tasks);
  return result;
});

// `ownerHint` (the caller's task.ownerId) lets a mutation skip the O(users)
// findOwnerKeyForTask scan when the owner is already known — the hot path (every
// lastRun stamp, every nextRunAt persist). Falls back to the scan when the hint
// is absent (legacy ownerless callers) or wrong (id not in that file), so
// correctness never depends on the hint.
const modifyTaskById = (id, fn, ownerHint = null) => withLock(TASKS_LOCK_KEY, () => {
  if (ownerHint != null) {
    const tasks = loadTasksForOwner(ownerHint);
    if (tasks.some(t => t?.id === id)) {
      const result = fn(tasks);
      saveOwnerTasks(ownerHint, tasks);
      return result;
    }
  }
  const ownerKey = findOwnerKeyForTask(id);
  if (ownerKey === null) return undefined;
  const tasks = loadTasksForOwner(ownerKey);
  const result = fn(tasks);
  saveOwnerTasks(ownerKey, tasks);
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
  // Random suffix, not just Date.now(): rebuildTutorTasks (and similar) create
  // several tasks in a tight await loop where sub-millisecond atomic writes can
  // collide on a bare timestamp id. Since these tasks are now armed
  // (scheduleNewTask), a collision would overwrite one task's timer and fire
  // the wrong config. Ids are opaque (nothing parses the numeric part).
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = { id, enabled: true, ...task };
  // modifyTasksForOwner goes through withLock and is async — must await or callers
  // get a Promise where they expect a task object (then `task.enabled` is
  // undefined, scheduleTask bails, and chat outcomes show "label=undefined").
  const saved = await modifyTasksForOwner(entry.ownerId ?? 'system', tasks => { tasks.push(entry); return entry; });
  if (_broadcast) {
    _broadcast({ type: 'task_created', task: saved, ownerId: saved.ownerId ?? null });
  }
  return saved;
}

export function removeTask(id, ownerId = null) {
  _lastIntervalFireAt.delete(id); // drop the interval fire-history entry (bounded leak fix)
  return modifyTaskById(id, tasks => { const i = tasks.findIndex(t => t.id === id); if (i !== -1) tasks.splice(i, 1); }, ownerId);
}

export function updateTask(id, patch, ownerId = null) {
  // ownerId is pinned at creation — a patch can't migrate a task to another
  // owner's file (route PATCH bodies pass through here verbatim, and the old
  // load-all/save-all path would silently re-home the record).
  const { ownerId: _pinned, ...rest } = patch ?? {};
  // Prefer the caller-supplied owner as the fast-path hint; fall back to a
  // pinned ownerId in the patch, else the O(users) scan inside modifyTaskById.
  return modifyTaskById(id, tasks => { const i = tasks.findIndex(t => t.id === id); if (i !== -1) Object.assign(tasks[i], rest); }, ownerId ?? _pinned ?? null);
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
    const nowTotal = (nowH % 24) * 60 + nowM;
    const targetTotal = hour * 60 + minute;
    // Minutes until the next occurrence
    const deltaMin = targetTotal > nowTotal ? (targetTotal - nowTotal) : (targetTotal - nowTotal + 24 * 60);
    // The wall-clock delta assumes a fixed UTC offset — across a DST
    // transition night it's 1h off. Verify the candidate instant's wall clock
    // in tz and nudge by the residual error (bounded: at most two passes).
    let candidate = now.getTime() + deltaMin * 60_000;
    for (let i = 0; i < 2; i++) {
      const p2 = Object.fromEntries(fmt.formatToParts(new Date(candidate)).map(p => [p.type, p.value]));
      const gotTotal = (parseInt(p2.hour) % 24) * 60 + parseInt(p2.minute);
      let err = targetTotal - gotTotal;
      if (err > 720) err -= 1440;
      if (err < -720) err += 1440;
      if (err === 0) break;
      candidate += err * 60_000;
    }
    // Never 0/negative (spring-forward can make the target wall time not
    // exist) — floor at one minute so the timer can't spin-fire.
    return Math.max(candidate - now.getTime(), 60_000);
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
  // One stable identity per authorized occurrence. Provider retries and any
  // nested agent/tool work must reuse it so durable side-effect guards cannot
  // interpret a replay as a fresh send. Timer-fired callers pass the logical
  // due time (stable across an in-process retry and scheduler rehydration);
  // each explicit Run-now click is intentionally a new authorization.
  const occurrenceId = String(opts.occurrenceId || (manual
    ? `manual_${startedAt}_${Math.random().toString(36).slice(2, 8)}`
    : task.datetime || task.nextRunAt || `fire_${startedAt}`));
  const scheduledRunRootId = `scheduled:${task.id}:${occurrenceId}`;
  let topologyLease = null;
  log.info('scheduler', 'task start', { taskId: task.id, label: task.label, ownerId: task.ownerId, type: task.type, manual });

  try {
    if (!manual && task.repeat !== 'once') {
      // Evaluate "what day is it" in the TASK's timezone when it has one —
      // the server-local day is wrong for tz tasks near local midnight.
      let day = new Date().getDay();
      if (task.timezone) {
        try {
          const wd = new Intl.DateTimeFormat('en-US', { timeZone: task.timezone, weekday: 'short' }).format(new Date());
          const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
          if (idx >= 0) day = idx;
        } catch { /* invalid tz — keep server-local day */ }
      }
      const allowed = parseCronDow(task.dow);
      if (allowed && !allowed.has(day)) {
        const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day];
        console.log(`[scheduler] Task "${task.label}" skipped — dow="${task.dow}", today is ${dayName}`);
        await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: `Skipped: ${dayName} not in dow=${task.dow}` }, task.ownerId);
        recordTaskRun(task, { scheduledFor: task.time ?? null, status: 'skipped', error: `Skipped: ${dayName} not in dow=${task.dow}` });
        return;
      }
      // Legacy boolean fallback for tasks created before the dow field was added.
      if (!task.dow) {
        if (task.weekdaysOnly && (day === 0 || day === 6)) {
          console.log(`[scheduler] Task "${task.label}" skipped — weekdaysOnly, today is ${day === 0 ? 'Sunday' : 'Saturday'}`);
          await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: 'Skipped: weekend (weekdaysOnly)' }, task.ownerId);
          recordTaskRun(task, { scheduledFor: task.time ?? null, status: 'skipped', error: 'Skipped: weekend (weekdaysOnly)' });
          return;
        }
        if (task.weekendsOnly && day >= 1 && day <= 5) {
          console.log(`[scheduler] Task "${task.label}" skipped — weekendsOnly, today is a weekday`);
          await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: 'Skipped: weekday (weekendsOnly)' }, task.ownerId);
          recordTaskRun(task, { scheduledFor: task.time ?? null, status: 'skipped', error: 'Skipped: weekday (weekendsOnly)' });
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
      recordTaskRun(task, { scheduledFor: task.datetime ?? task.time ?? null, status: 'skipped', error: 'Skipped: access restricted at this time' });
      // One-shot tasks vanish after firing (or being skipped); daily tasks
      // keep their lastRun/lastOutput so the user can see they ran.
      if (task.repeat === 'once') await removeTask(task.id, task.ownerId);
      else await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: 'Skipped: access restricted at this time' }, task.ownerId);
      return;
    }

    if (task.type === 'builtin' || task.type === 'reminder') {
      const handler = _builtins[task.handler];
      if (!handler) {
        console.error(`[scheduler] No builtin handler "${task.handler}" for task "${task.id}"`);
        await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: `Error: no handler "${task.handler}"`, enabled: false }, task.ownerId);
        return;
      }
      // Builtins can perform real-world side effects without going through an
      // agent turn. Give them the same stable per-occurrence identity used by
      // scheduled agent retries so they can bind those effects durably before
      // provider dispatch. Existing one-argument handlers ignore this object.
      const output = await handler(task, { occurrenceId, scheduledRunRootId, manual });
      console.log(`[scheduler] Task "${task.label}" complete: ${output}`);
      log.info('scheduler', 'builtin task complete', { taskId: task.id, label: task.label, handler: task.handler, durationMs: Date.now() - startedAt });
      if (task.repeat === 'once' && !manual) await removeTask(task.id, task.ownerId);
      else await updateTask(task.id, { lastRun: new Date().toISOString(), lastOutput: output }, task.ownerId);
      if (broadcast) broadcast({ type: 'task_complete', taskId: task.id, agent: task.agent ?? 'system' });
      return;
    }

    const userId = task.ownerId ?? 'default';

    // Scheduled agent runs are topology readers. A brief settings/deletion
    // writer wins admission; retry locally so a timer fire is not lost merely
    // because the user changed mode at the same instant.
    for (let attempt = 0; attempt < 80 && !topologyLease; attempt++) {
      topologyLease = tryAcquireUserTurnLease(userId, { label: `scheduled:${task.id}` });
      if (!topologyLease) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!topologyLease) {
      throw new Error('Account setup is changing; scheduled run could not acquire a stable agent roster.');
    }

    // Resolve only through the user's owned runtime roster. In single mode a
    // real parked id redirects to the primary; stale/foreign ids never fall
    // through to the global registry.
    const resolved = resolveRuntimeAgentForUser(userId, task.agent);
    if (!resolved) {
      // Stamp + disable instead of silently returning — the task used to
      // stay "enabled" forever with no lastRun/lastError (a zombie the user
      // couldn't see failing). An agent that no longer exists can never
      // succeed, so this mirrors the consecutive-failures auto-disable.
      console.error(`[scheduler] Unknown agent "${task.agent}" for task "${task.id}" — disabling`);
      log.error('scheduler', 'task agent unresolvable', { taskId: task.id, label: task.label, agent: task.agent });
      await updateTask(task.id, {
        lastRun: new Date().toISOString(),
        lastError: `Agent "${task.agent}" not found — re-assign the task to an existing agent and re-enable it.`,
        enabled: false,
        disabledReason: `agent "${task.agent}" not found`,
      }, task.ownerId);
      if (broadcast) broadcast({ type: 'task_complete', taskId: task.id, agent: task.agent });
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
    // Personalization: append compact insights + pending-offer summary for
    // tasks explicitly marked as briefings. Keep the text check only as a
    // compatibility bridge for tasks created before `meta.briefing` existed;
    // new callers no longer have to rely on an English keyword in a label.
    let briefingNote = '';
    let briefingAcknowledgements = [];
    const isBriefingTask = task.meta?.briefing === true
      || /brief/i.test(task.label || '')
      || /brief/i.test(task.prompt || '');
    if (isBriefingTask) {
      try {
        const { getBriefingSection } = await import('./lib/personalization/reflect.mjs');
        const section = await getBriefingSection(userId);
        if (section?.text) {
          briefingNote = `\n\n[PERSONALIZATION]\n${section.text}`;
          briefingAcknowledgements = Array.isArray(section.acknowledgements) ? section.acknowledgements : [];
        }
      } catch (e) {
        console.warn('[scheduler] personalization briefing section failed:', e.message);
      }
    }
    const scheduledNote =
      `[SCHEDULED RUN] You are executing a previously-scheduled task right now. ` +
      `The user is NOT present and cannot answer follow-up questions. ` +
      `Any "in N minutes" / "tomorrow" / "at HH:MM" phrases in the request are the trigger time that has already arrived — do not try to re-schedule. ` +
      `The user's original scheduling message IS the confirmation: execute every action directly and do NOT show drafts, ask "are you sure?", or wait for "send it"/"confirm" — there is no one here to answer. ` +
      `This overrides any "show draft and wait for approval" rule from skill prompts (email, finance, etc) for this run. ` +
      `Use reasonable defaults for anything unspecified, complete the task, and report in your final message what you did (including a Message ID if a tool returned one).` +
      userEmailLine + briefingNote;

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
      // Per-fire nonce for the child barrier — overlapping fires of the same
      // recurring task must not share a barrier group (see keyFor).
      runId: scheduledRunRootId,
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
      originTaskRunId: scheduledCtx.runId,
      rootTaskId: scheduledCtx.runId,
      traceSource: 'scheduled',
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
          manual, sessionKey, broadcast, briefingAcknowledgements, briefingUserId: userId,
          runId: scheduledCtx.runId,
        }),
      });
    } else {
      // Barrier bypassed: no reaction turn, finalize directly after the main
      // turn (pre-barrier behavior). Background work, if any, runs detached.
      await finalizeScheduledTask(task, {
        succeeded, output: assistantContent, lastError, manual, sessionKey, broadcast,
        briefingAcknowledgements, briefingUserId: userId,
      });
    }
  } catch (e) {
    const errMsg = e?.message || String(e);
    console.error(`[scheduler] Task "${task.label}" threw outside runAttempt:`, errMsg);
    log.error('scheduler', 'task threw', { taskId: task.id, label: task.label, err: errMsg });
    // Stamp the failure. Without this, a throwing builtin/reminder handler (or
    // any throw before the agent path hands finalization to the barrier) never
    // recorded lastRun/lastError/consecutiveFailures — auto-disable could never
    // trigger, and an interval task hot-looped with zero backoff. Mirrors
    // finalizeScheduledTask's failure branch (minus the session append, which
    // needs a resolved agent we may not have here). Best-effort: a stamp failure
    // must not mask the original throw.
    try {
      recordTaskRun(task, {
        scheduledFor: task.datetime ?? task.time ?? null,
        status: 'error',
        error: errMsg,
        ...(manual ? { manual: true } : {}),
      });
      if (manual) {
        await updateTask(task.id, { lastRun: new Date().toISOString(), lastError: errMsg }, task.ownerId);
      } else if (task.repeat === 'once') {
        await removeTask(task.id, task.ownerId);
      } else {
        const patch = {
          lastRun: new Date().toISOString(),
          lastError: errMsg,
          consecutiveFailures: (Number(task.consecutiveFailures) || 0) + 1,
        };
        if (patch.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          patch.enabled = false;
          patch.disabledReason = `auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failed fires; last error: ${errMsg}`;
          log.warn('scheduler', 'task auto-disabled (threw)', { taskId: task.id, label: task.label, streak: patch.consecutiveFailures, err: errMsg });
        }
        await updateTask(task.id, patch, task.ownerId);
      }
    } catch (stampErr) {
      console.warn('[scheduler] Failed to stamp task failure after throw:', stampErr?.message || stampErr);
    }
  } finally {
    topologyLease?.release();
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
    ...scheduledReactionTraceOptions(scheduledCtx),
  }));
}

// Stamp/remove a scheduled task at TRUE completion (main turn + all background
// children + any reaction rounds). The single finalize path — replaces the
// former inline finalize in runTask so a delegating task can't be double-stamped
// or have a one-shot removed out from under its own pending background work.
async function finalizeScheduledTask(task, {
  succeeded, output, lastError, manual, sessionKey, broadcast,
  briefingAcknowledgements = [], briefingUserId = task.ownerId, runId = null,
}) {
  const completionUserId = task.ownerId ?? 'default';
  const completionAgent = resolveRuntimeAgentForUser(completionUserId, task.agent)?.id ?? task.agent;
  const completionSessionKey = completionAgent
    ? `${completionUserId}_${completionAgent}`
    : sessionKey;
  if (succeeded && briefingAcknowledgements.length) {
    try {
      const { acknowledgeBriefingSection } = await import('./lib/personalization/reflect.mjs');
      await acknowledgeBriefingSection(briefingUserId, briefingAcknowledgements);
    } catch (e) {
      // Leave rows pending for a later at-least-once briefing retry.
      console.warn('[scheduler] personalization briefing acknowledgement failed:', e.message);
    }
  }
  // On failure, append a visible error message to the session so the chat shows
  // what happened instead of an orphan header. Manual test fires skip this (the
  // "will retry on its next run" copy is wrong for an out-of-band run; the
  // drawer's lastError covers it). Silent tasks skip it by contract.
  if (!succeeded && !task.silent && !manual) {
    try {
      const failureRow = {
        role: 'assistant',
        content: `⚠️ Scheduled task failed. Last error: ${lastError || 'unknown'}.\n\nThe task is still scheduled and will retry on its next run.`,
        scheduled: true,
        taskId: task.id,
        taskFailed: true,
        ts: Date.now(),
      };
      if (runId) await appendSessionReportOnce(completionSessionKey, {
        ...failureRow,
        reportId: `scheduled:${runId}:failure`,
      });
      else await appendToSession(completionSessionKey, failureRow);
    } catch (e) {
      console.warn('[scheduler] Failed to append failure message to session:', e.message);
    }
  }

  recordTaskRun(task, {
    ...(runId ? { runId } : {}),
    scheduledFor: task.datetime ?? task.time ?? null,
    status: succeeded ? 'ok' : 'error',
    ...(succeeded ? {} : { error: lastError || 'unknown' }),
    ...(manual ? { manual: true } : {}),
  });

  if (manual) {
    // Test fire: never delete or disable. Record the outcome for the drawer
    // but leave the schedule + failure streak exactly as they were.
    const patch = { lastRun: new Date().toISOString(), ...(runId ? { lastFinalizedRunId: runId } : {}) };
    if (succeeded) { patch.lastError = null; patch.lastOutput = (output || '').trim().slice(0, 280); }
    else { patch.lastError = lastError || 'unknown'; }
    await updateTask(task.id, patch, task.ownerId);
  } else if (task.repeat === 'once') {
    // One-shot tasks vanish after firing.
    await removeTask(task.id, task.ownerId);
  } else {
    const patch = { lastRun: new Date().toISOString(), ...(runId ? { lastFinalizedRunId: runId } : {}) };
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
            const disabledRow = {
              role: 'assistant',
              content: `⛔ Scheduled task "${task.label}" auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failed fires. Last error: ${lastError || 'unknown'}.\n\nRe-enable it from the tasks drawer once the underlying issue is fixed.`,
              scheduled: true,
              taskId: task.id,
              taskAutoDisabled: true,
              ts: Date.now(),
            };
            if (runId) await appendSessionReportOnce(completionSessionKey, {
              ...disabledRow,
              reportId: `scheduled:${runId}:auto-disabled`,
            });
            else await appendToSession(completionSessionKey, disabledRow);
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
    await updateTask(task.id, patch, task.ownerId);
  }

  if (broadcast) broadcast({ type: 'task_complete', taskId: task.id, agent: completionAgent });
}

/**
 * Crash recovery for a scheduled run whose producer was journaled but whose
 * in-memory child barrier never durably acknowledged finalization. Replaying
 * the continuation could repeat an external side effect, so recovery fails the
 * occurrence honestly, preserves its producer result in chat, and stamps the
 * schedule exactly once using the run id tombstone.
 */
export async function recoverInterruptedScheduledBackground({
  userId,
  originTaskId,
  originTaskOwnerId = null,
  originScheduledRunId = null,
  manual = false,
  aggregate = '',
}) {
  const ownerId = originTaskOwnerId || userId;
  const task = findTaskById(originTaskId, ownerId);
  if (!task) return { ok: true, alreadyFinalized: true };
  if (originScheduledRunId && task.lastFinalizedRunId === originScheduledRunId) {
    return { ok: true, alreadyFinalized: true };
  }
  const reason = 'Server restarted after background work finished but before the scheduled continuation was durably finalized. The producer was not rerun; its result was preserved for review.';
  await finalizeScheduledTask(task, {
    succeeded: false,
    output: aggregate,
    lastError: reason,
    manual: manual === true,
    sessionKey: task.agent ? `${userId}_${task.agent}` : null,
    broadcast: _broadcast,
    runId: originScheduledRunId || `recovery_${originTaskId}`,
  });
  return { ok: true, recoveredAsFailure: true };
}

// Track pending timers so we can cancel them on shutdown
const _timers = new Map(); // taskId -> timeoutId

// Last time each interval task ACTUALLY fired (in-memory, timer-path only —
// manual "Run now" fires don't touch it). Used to (a) anchor the re-arm to the
// real fire time when the child barrier hasn't stamped lastRun yet, and (b)
// guard against a spurious early re-fire computing delay≈0.
const _lastIntervalFireAt = new Map(); // taskId -> ms
// setTimeout jitter / clock slack tolerated before an early interval tick is
// treated as spurious. Well below MIN_INTERVAL_MS so a legit fire never trips it.
const INTERVAL_FIRE_SLACK_MS = 5_000;

// setTimeout clamps any delay above ~24.86 days (2^31-1 ms) down to 1ms and
// fires immediately. Count long delays down in max-sized chunks so far-future
// one-shots ("remind me in 2 months") and long intervals ("every 30 days") fire
// on schedule instead of the instant they're armed.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
function scheduleLongTimeout(taskId, delay, onFire) {
  let remaining = Math.max(0, delay);
  const step = () => {
    if (remaining > MAX_TIMEOUT_MS) {
      remaining -= MAX_TIMEOUT_MS;
      _timers.set(taskId, setTimeout(step, MAX_TIMEOUT_MS));
    } else {
      _timers.set(taskId, setTimeout(onFire, remaining));
    }
  };
  step();
}

function findFreshScheduledTask(task) {
  return task.ownerId ? findTaskById(task.id, task.ownerId)
                      : loadAllTasksForScheduler().find(t => t.id === task.id);
}

// Schedule a single task (schedules → runs → reschedules daily, or runs once).
// `fireAnchorTs` (interval tasks only) overrides task.lastRun when computing the
// next delay — passed by the re-arm below so the cadence anchors to the actual
// fire time even before the child barrier stamps lastRun.
function scheduleTask(task, broadcast, fireAnchorTs = null) {
  if (!task.enabled) {
    // A disabled task has no armed timer, so any nextRunAt left over from
    // before it was disabled is stale — clear it so the drawer doesn't show
    // a "next run" time that will never happen.
    if (task.nextRunAt) updateTask(task.id, { nextRunAt: null }, task.ownerId).catch(() => {});
    return;
  }

  // Clear any existing timer for this task before scheduling a new one
  if (_timers.has(task.id)) { clearTimeout(_timers.get(task.id)); _timers.delete(task.id); }

  let delay, label, occurrenceAt;
  let isLateOnce = false, lateByMs = 0;
  if (task.repeat === 'once') {
    if (!task.datetime) return;
    // msUntilDatetime clamps a past-due datetime to 0 so the timer fires on
    // the next tick — correct behavior (a one-shot is never silently
    // dropped), but pre-this-change nothing recorded that it was late (e.g.
    // the server was down through the requested time). Capture the raw
    // (possibly negative) delay here, at arm time, so the fire callback below
    // can log + record it without changing when it actually fires.
    const rawDelay = new Date(task.datetime).getTime() - Date.now();
    delay = Math.max(rawDelay, 0);
    occurrenceAt = new Date(task.datetime).toISOString();
    isLateOnce = rawDelay < 0;
    lateByMs = isLateOnce ? -rawDelay : 0;
    label = new Date(task.datetime).toLocaleString();
  } else if (task.repeat === 'interval') {
    // Fixed-cadence tasks: anchored to lastRun, not to boot. Arming a full
    // interval from every boot meant a task whose interval never elapsed
    // between OE's frequent restarts NEVER fired while showing enabled
    // ("every 2 days" on a box that restarts daily). An overdue task fires
    // promptly once, then re-arms normally (lastRun is stamped per fire).
    // A missing/invalid intervalMs means a malformed task — skip rather than
    // spin every minute.
    const raw = Number(task.intervalMs);
    if (!Number.isFinite(raw) || raw <= 0) {
      console.warn(`[scheduler] Task "${task.label}" has invalid intervalMs=${task.intervalMs}; not scheduled.`);
      return;
    }
    const interval = Math.max(raw, MIN_INTERVAL_MS);
    // Anchor to the ACTUAL last fire. On re-arm the caller passes fireAnchorTs
    // because the child barrier stamps lastRun asynchronously — reading
    // task.lastRun here would still hold the PREVIOUS fire's time, yielding
    // delay≈0 and a double-fire every cycle. Boot/PATCH callers pass nothing
    // and fall back to the persisted lastRun.
    const anchor = Number.isFinite(fireAnchorTs) ? fireAnchorTs : (Date.parse(task.lastRun || '') || 0);
    const dueAt = anchor ? anchor + interval : Date.now() + interval;
    delay = Math.max(0, dueAt - Date.now());
    occurrenceAt = new Date(dueAt).toISOString();
    label = `every ${formatInterval(interval)}`;
  } else {
    // Guard, don't throw: a task with a missing/malformed time must not kill
    // the caller (startScheduler's arm loop schedules every other task after
    // this one).
    if (typeof task.time !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(task.time.trim())) {
      console.warn(`[scheduler] Task "${task.label}" has no valid time (time=${JSON.stringify(task.time)}); not scheduled.`);
      return;
    }
    const { hour, minute } = parseTime(task.time);
    delay = msUntilNext(hour, minute, task.timezone ?? null);
    const hhmm = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    const cadence = formatTaskCadence({ ...task, time: hhmm }).replace(/^\S+\s+/, '');
    label = task.timezone ? `${hhmm} ${cadence} (${task.timezone})` : `${hhmm} ${cadence}`;
  }

  const eta = new Date(Date.now() + delay);
  occurrenceAt ||= eta.toISOString();
  console.log(`[scheduler] "${task.label}" scheduled for ${label} (runs at: ${eta.toLocaleString()})`);
  // Persist so the drawer / API can show "next run" instead of only the
  // console log. Fire-and-forget: scheduleTask is called synchronously from
  // hot paths (boot arm loop, every re-arm after a fire, every PATCH), and a
  // slow write here must not delay arming the next task's timer.
  updateTask(task.id, { nextRunAt: eta.toISOString() }, task.ownerId).catch(e =>
    console.warn(`[scheduler] Failed to persist nextRunAt for "${task.label}":`, e.message));

  scheduleLongTimeout(task.id, delay, async () => {
    _timers.delete(task.id);
    if (!_schedulerRunning) return;
    const firedAt = Date.now();
    // Interval re-arm anchors to the actual fire time (barrier stamps lastRun
    // asynchronously). On a skipped spurious tick we anchor to the prior real
    // fire instead so the cadence stays correct.
    let reArmAnchor = firedAt;
    try {
      const current = findFreshScheduledTask(task);
      if (current?.enabled) {
        if (current.repeat === 'interval') {
          const iv = Math.max(Number(current.intervalMs) || 0, MIN_INTERVAL_MS);
          const prevFire = _lastIntervalFireAt.get(task.id);
          // Due-time guard: a fire less than one interval after the previous one
          // is a spurious early tick (e.g. a stale re-arm computing delay≈0).
          // Skip the run and re-arm to the correct time so it can't double-fire.
          if (prevFire != null && (firedAt - prevFire) < iv - INTERVAL_FIRE_SLACK_MS) {
            reArmAnchor = prevFire;
            log.warn('scheduler', 'interval task fired early — skipping spurious tick', { taskId: task.id, label: task.label, sinceLastMs: firedAt - prevFire, intervalMs: iv });
            return; // finally re-arms anchored to prevFire
          }
          _lastIntervalFireAt.set(task.id, firedAt);
        }
        if (isLateOnce) {
          log.warn('scheduler', 'one-shot task armed past its due time — firing immediately', { taskId: task.id, label: task.label, lateByMs });
          recordTaskRun(current, { scheduledFor: current.datetime ?? null, firedAt, status: 'late', lateByMs });
        }
        await runTask(current, broadcast, { occurrenceId: occurrenceAt });
      }
    } catch (e) {
      const err = e?.message || String(e);
      console.error(`[scheduler] Task timer for "${task.label}" failed:`, err);
      log.error('scheduler', 'task timer failed', { taskId: task.id, label: task.label, err });
    } finally {
      if (!_schedulerRunning || task.repeat === 'once') return;
      try {
        const fresh = findFreshScheduledTask(task);
        // Anchor interval re-arm to the fire timestamp (barrier may not have
        // stamped lastRun yet); non-interval re-arms ignore the anchor.
        if (fresh?.enabled) scheduleTask(fresh, broadcast, fresh.repeat === 'interval' ? reArmAnchor : null);
      } catch (e) {
        const err = e?.message || String(e);
        console.error(`[scheduler] Failed to re-arm task "${task.label}":`, err);
        log.error('scheduler', 'task rearm failed', { taskId: task.id, label: task.label, err });
      }
    }
  });
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
  for (const task of tasks) {
    // Per-task isolation: one malformed task must not abort the arm loop and
    // leave every task after it unscheduled.
    try { scheduleTask(task, broadcast); }
    catch (e) {
      console.error(`[scheduler] Failed to schedule "${task.label || task.id}":`, e.message);
      log.error('scheduler', 'task arm failed', { taskId: task.id, label: task.label, err: e.message });
    }
  }
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
