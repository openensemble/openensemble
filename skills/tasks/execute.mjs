// `set_reminder` / `schedule_task` are fallback paths for when the server-side
// interceptor in lib/scheduler-intent.mjs misses (regex doesn't match, plan
// model fails). The interceptor still handles the common cases pre-LLM; these
// tools let the agent's own model handle phrasings the interceptor doesn't
// recognize ("i need to X in five minutes", "ping me at 3", etc).

function unscopeAgentId(agentId, userId) {
  if (!agentId || !userId) return agentId;
  return typeof agentId === 'string' && agentId.startsWith(`${userId}_`)
    ? agentId.slice(userId.length + 1)
    : agentId;
}

async function execListTasks(userId) {
  const { loadTasksForOwner, formatTaskCadence } = await import('../../scheduler.mjs');
  const tasks = loadTasksForOwner(userId);
  if (!tasks.length) return 'No scheduled tasks.';
  return tasks.map(t => {
    const schedStr = t.repeat === 'once'
      ? `once at ${formatTaskCadence(t)}`
      : formatTaskCadence(t);
    const status = t.repeat === 'once' && !t.enabled ? 'DONE' : (t.enabled ? 'ON' : 'OFF');
    return `- [${status}] "${t.label}" — ${schedStr} via ${t.agent} (id: ${t.id})`;
  }).join('\n');
}

async function execDeleteTask(id, userId) {
  const { findTaskById, removeTask } = await import('../../scheduler.mjs');
  const task = findTaskById(id, userId);
  if (!task) return `No task found with ID "${id}".`;
  removeTask(id);
  return `Task "${task.label}" deleted.`;
}

async function execListReminders(userId) {
  const { loadTasksForOwner, formatTaskCadence } = await import('../../scheduler.mjs');
  const reminders = loadTasksForOwner(userId).filter(t => t.type === 'reminder');
  if (!reminders.length) return 'No active reminders.';
  return reminders.map(r => {
    const sched = r.repeat === 'once'
      ? `once at ${formatTaskCadence(r)}`
      : formatTaskCadence(r);
    const status = r.repeat === 'once' && !r.enabled ? 'DONE' : (r.enabled ? 'ON' : 'OFF');
    return `- [${status}] "${r.label}" — ${sched} (id: ${r.id})`;
  }).join('\n');
}

async function execCancelReminder(id, userId) {
  const { findTaskById, removeTask } = await import('../../scheduler.mjs');
  const task = findTaskById(id, userId);
  if (!task) return `No reminder found with ID "${id}".`;
  if (task.type !== 'reminder') return `"${id}" is a scheduled task, not a reminder. Use delete_task instead.`;
  removeTask(id);
  return `Reminder "${task.label}" cancelled.`;
}

async function execSetReminder({ label, datetime, time, repeat = 'once' }, userId) {
  if (!userId) return 'Error: no user context.';
  if (!label || typeof label !== 'string') return 'Error: label is required.';
  const cleanLabel = label.trim();
  if (!cleanLabel) return 'Error: label is empty.';

  const { addTask, scheduleNewTask } = await import('../../scheduler.mjs');
  const base = { label: cleanLabel, ownerId: userId, type: 'reminder', handler: 'fireReminder' };

  if (repeat === 'daily') {
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return 'Error: daily reminder needs a time in HH:MM 24-hour format.';
    const [h, m] = time.split(':').map(Number);
    if (h > 23 || m > 59) return `Error: invalid time "${time}".`;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const task = await addTask({ ...base, repeat: 'daily', time: hhmm });
    scheduleNewTask(task);
    return `Reminder "${task.label}" set daily at ${hhmm}. id=${task.id}`;
  }

  if (!datetime) return 'Error: one-shot reminder needs a `datetime` (ISO 8601).';
  const when = new Date(datetime);
  if (Number.isNaN(when.getTime())) return `Error: could not parse datetime "${datetime}".`;
  if (when.getTime() - Date.now() < 5000) return `Error: datetime ${when.toLocaleString()} is in the past or too soon.`;
  const task = await addTask({ ...base, repeat: 'once', datetime: when.toISOString() });
  scheduleNewTask(task);
  return `Reminder "${task.label}" set for ${when.toLocaleString()}. id=${task.id}`;
}

// ── Watch tasks (condition-triggered monitors) ───────────────────────────────
//
// Watchers live in users/<uid>/watchers.json (separate from tasks.json) and
// tick on their own supervisor in scheduler/watchers.mjs. We register against
// the system handlers in scheduler/watch-handlers.mjs by passing skillId:null
// so the supervisor resolves via _systemHandlers.

const VALID_SOURCES = new Set(['http_jsonpath', 'exec', 'file_stat', 'event_subscription']);
const VALID_COMPARATORS = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'matches', 'contains', 'changed']);

// Map { source, params, comparator, target } from the LLM into the flat
// `state` shape the system handler expects. Each handler reads its own keys
// off state — we fan params out at the boundary so handlers stay simple.
// Accept common LLM mis-shapings: params.jsonpath / params.jsonPath /
// params.path / params.event are aliased; if the LLM put the source-specific
// value in `target` instead of nested under `params`, recover it. Each LLM
// model has slightly different conventions and we'd rather succeed than
// reject on a known-recoverable shape.
function pickParam(params, ...keys) {
  for (const k of keys) if (params?.[k] !== undefined) return params[k];
  return undefined;
}

function buildWatcherState({ source, params = {}, comparator, target }) {
  const base = { comparator, target };
  if (source === 'http_jsonpath') {
    return {
      ...base,
      url: pickParam(params, 'url', 'URL'),
      jsonPath: pickParam(params, 'json_path', 'jsonPath', 'jsonpath') || '$',
      headers: params.headers || {},
    };
  }
  if (source === 'exec') {
    return {
      ...base,
      command: pickParam(params, 'command', 'cmd'),
      parse: params.parse || 'string',
    };
  }
  if (source === 'file_stat') {
    // Recovery: if params.path is missing but target looks like a filesystem
    // path, treat it as the path. Same for the legacy "target = filename"
    // shape some LLMs reach for.
    let path = pickParam(params, 'path', 'file', 'filePath', 'file_path');
    if (!path && typeof target === 'string' && (target.startsWith('/') || target.startsWith('~'))) {
      path = target;
    }
    return { ...base, path, attribute: params.attribute || 'exists' };
  }
  if (source === 'event_subscription') {
    // Predicate is optional. If present, normalise its keys to what the
    // built-in event handler expects (jsonPath, not json_path).
    let predicate = null;
    if (params.predicate && typeof params.predicate === 'object') {
      predicate = {
        jsonPath: pickParam(params.predicate, 'json_path', 'jsonPath', 'jsonpath') || '$',
        comparator: params.predicate.comparator,
        target: params.predicate.target,
      };
    }
    // Recovery: if params.event missing, accept target as event name.
    let event = pickParam(params, 'event', 'event_name', 'eventName', 'name');
    if (!event && typeof target === 'string') event = target;
    return { event, predicate };
  }
  throw new Error(`unknown source "${source}"`);
}

function describeWatch(rec) {
  const s = rec.state || {};
  if (rec.kind === 'http_jsonpath')       return `${s.jsonPath || '$'} from ${s.url}`;
  if (rec.kind === 'exec')                return `\`${(s.command || '').slice(0, 60)}\``;
  if (rec.kind === 'file_stat')           return `${s.attribute || 'exists'} of ${s.path}`;
  if (rec.kind === 'event_subscription')  return `event "${s.event}"`;
  return rec.kind;
}

async function execCreateWatch(args, userId, agentId, ctx) {
  if (!userId) return 'Error: no user context.';
  if (!agentId) return 'Error: no agent context — cannot register watch.';
  const { label, source, comparator, target, cadence_sec, expires_at, on_fire } = args || {};
  // Accept `params` missing entirely — buildWatcherState below tries to
  // recover the source-specific value from `target` for the LLMs that
  // routinely flatten the call shape (most do).
  const params = args?.params && typeof args.params === 'object' ? args.params : {};
  if (!label || typeof label !== 'string') return 'Error: label is required.';
  if (!source || !VALID_SOURCES.has(source)) return `Error: source must be one of ${[...VALID_SOURCES].join(', ')}.`;

  // file_stat with attribute=exists is the one shape that legitimately has no
  // comparator (fires on appearance/disappearance). event_subscription has
  // its own optional predicate object; comparator/target at the top level
  // don't apply. Everything else needs one.
  const isExistsCheck = source === 'file_stat' && (params.attribute === 'exists' || !params.attribute);
  const isEventSub    = source === 'event_subscription';
  if (!isExistsCheck && !isEventSub) {
    if (!comparator) return 'Error: comparator is required.';
    if (!VALID_COMPARATORS.has(comparator)) return `Error: comparator must be one of ${[...VALID_COMPARATORS].join(', ')}.`;
    if (comparator !== 'changed' && (target === undefined || target === null || target === '')) {
      return `Error: target is required for comparator "${comparator}".`;
    }
  }

  // Build state first (which does best-effort recovery for common LLM
  // mis-shapings — see pickParam in buildWatcherState), then validate the
  // recovered state. This makes us forgiving about params.jsonpath vs
  // params.json_path, target-instead-of-params.path, etc.
  let state;
  try { state = buildWatcherState({ source, params, comparator, target }); }
  catch (e) { return `Error: ${e.message}`; }

  if (source === 'http_jsonpath'      && !state.url)     return 'Error: params.url is required for http_jsonpath.';
  if (source === 'exec'               && !state.command) return 'Error: params.command is required for exec.';
  if (source === 'file_stat'          && !state.path)    return 'Error: params.path is required for file_stat.';
  if (source === 'event_subscription' && !state.event)   return 'Error: params.event is required for event_subscription.';

  let resolvedExpires = null;
  if (expires_at) {
    const t = new Date(expires_at).getTime();
    if (Number.isNaN(t)) return `Error: could not parse expires_at "${expires_at}".`;
    if (t <= Date.now() + 60_000) return 'Error: expires_at must be at least a minute in the future.';
    resolvedExpires = t;
  }

  // Validate on_fire shape if present. Default to notify-only.
  let onFire = null;
  if (on_fire) {
    if (typeof on_fire !== 'object') return 'Error: on_fire must be an object.';
    if (on_fire.type !== 'notify' && on_fire.type !== 'agent') {
      return `Error: on_fire.type must be 'notify' or 'agent' (got "${on_fire.type}").`;
    }
    onFire = on_fire.type === 'agent'
      ? { type: 'agent', prompt: on_fire.prompt ? String(on_fire.prompt) : null }
      : { type: 'notify' };
  }

  const cadence = Math.max(5, Number(cadence_sec) || 60);
  const watcherId = await ctx?.watch?.({
    kind: source,
    state,
    cadenceSec: cadence,
    expiresAt: resolvedExpires,
    label: label.trim(),
    onFire,
  });
  if (!watcherId) return 'Error: failed to register watcher (per-user cap reached, or watch system offline).';

  const expStr = resolvedExpires ? ` until ${new Date(resolvedExpires).toLocaleString()}` : '';
  let predStr;
  if (source === 'event_subscription') {
    predStr = state.predicate
      ? `when payload ${state.predicate.comparator} ${state.predicate.target}`
      : 'when fired';
  } else if (comparator === 'changed') {
    predStr = 'on any change';
  } else if (isExistsCheck) {
    predStr = `${target === false ? 'disappears' : 'appears'}`;
  } else {
    predStr = `when ${comparator} ${target}`;
  }
  const fireStr = onFire?.type === 'agent' ? ' (will run an agent action on fire)' : '';
  return `Watch "${label}" created — ${describeWatch({ kind: source, state })} ${predStr}, every ${cadence}s${expStr}${fireStr}. id=${watcherId}`;
}

async function execListWatches(userId) {
  if (!userId) return 'Error: no user context.';
  const { listWatchers } = await import('../../scheduler/watchers.mjs');
  const { active, recent } = listWatchers(userId);
  if (!active.length && !recent.length) return 'No watches configured.';
  const lines = [];
  if (active.length) {
    lines.push('Active:');
    for (const w of active) {
      const last = w.lastStatusText ? ` — ${w.lastStatusText}` : '';
      lines.push(`- "${w.label}" [${w.kind}] every ${w.cadenceSec}s (id: ${w.id})${last}`);
    }
  }
  if (recent.length) {
    lines.push('Recent (last hour):');
    for (const w of recent) {
      lines.push(`- "${w.label}" [${w.status}] — ${w.lastStatusText || '(no output)'}`);
    }
  }
  return lines.join('\n');
}

async function execCancelWatch(id, userId) {
  if (!userId) return 'Error: no user context.';
  if (!id) return 'Error: id is required.';
  const { unregisterWatcher } = await import('../../scheduler/watchers.mjs');
  const ok = unregisterWatcher(userId, id, 'cancelled');
  return ok ? `Watch ${id} cancelled.` : `No active watch with id "${id}".`;
}

async function execScheduleTask({ label, prompt, datetime, time, repeat = 'once' }, userId, agentId) {
  if (!userId) return 'Error: no user context.';
  if (!label || typeof label !== 'string') return 'Error: label is required.';
  if (!prompt || typeof prompt !== 'string') return 'Error: prompt is required.';
  const rawAgent = unscopeAgentId(agentId, userId);
  if (!rawAgent) return 'Error: no agent context — cannot schedule.';

  const { addTask, scheduleNewTask } = await import('../../scheduler.mjs');
  const base = { label: label.trim(), prompt: prompt.trim(), ownerId: userId, agent: rawAgent };

  if (repeat === 'daily') {
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return 'Error: daily task needs a time in HH:MM 24-hour format.';
    const [h, m] = time.split(':').map(Number);
    if (h > 23 || m > 59) return `Error: invalid time "${time}".`;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const task = await addTask({ ...base, repeat: 'daily', time: hhmm });
    scheduleNewTask(task);
    return `Task "${task.label}" scheduled daily at ${hhmm} via agent ${rawAgent}. id=${task.id}`;
  }

  if (!datetime) return 'Error: one-shot task needs a `datetime` (ISO 8601).';
  const when = new Date(datetime);
  if (Number.isNaN(when.getTime())) return `Error: could not parse datetime "${datetime}".`;
  if (when.getTime() - Date.now() < 5000) return `Error: datetime ${when.toLocaleString()} is in the past or too soon.`;
  const task = await addTask({ ...base, repeat: 'once', datetime: when.toISOString() });
  scheduleNewTask(task);
  return `Task "${task.label}" scheduled for ${when.toLocaleString()} via agent ${rawAgent}. id=${task.id}`;
}

export default async function execute(name, args, userId, agentId, ctx) {
  if (name === 'set_reminder')    return execSetReminder(args || {}, userId);
  if (name === 'schedule_task')   return execScheduleTask(args || {}, userId, agentId);
  if (name === 'list_tasks')      return execListTasks(userId);
  if (name === 'delete_task')     return execDeleteTask(args.id, userId);
  if (name === 'list_reminders')  return execListReminders(userId);
  if (name === 'cancel_reminder') return execCancelReminder(args.id, userId);
  if (name === 'create_watch')    return execCreateWatch(args || {}, userId, agentId, ctx);
  if (name === 'list_watches')    return execListWatches(userId);
  if (name === 'cancel_watch')    return execCancelWatch(args?.id, userId);
  return `Unknown tool: ${name}`;
}
