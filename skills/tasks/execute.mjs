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

/**
 * Is this agentId running inside a delegation chain? Delegation sessions
 * are wrapped with `ephemeral_deleg_d<N>_<ts>_<rand>_<agentId>` per
 * project_specialist_escalation. When a specialist asks the coordinator to
 * act, the coordinator runs with this session-id shape.
 *
 * Used to gate cross-agent destructive ops: when the coordinator is being
 * called BY a specialist (not by the user directly), destructive watcher
 * ops on watchers owned by other agents stage for user approval instead
 * of executing immediately — fixes the "runaway specialist asks coordinator
 * to cancel everything" escalation that bypasses the owner check.
 */
function isDelegatedCall(agentId, userId) {
  if (!agentId || typeof agentId !== 'string') return false;
  const unscoped = unscopeAgentId(agentId, userId);
  return typeof unscoped === 'string' && unscoped.startsWith('ephemeral_deleg_');
}

/**
 * Is the caller allowed to act on this watcher?
 *
 * **Strict ownership**: the agent that REGISTERED a watcher is the sole
 * authority over it. The coordinator no longer has a universal bypass —
 * even direct-from-user "Sydney, cancel that watcher Trixie set up" goes
 * through ask_agent to Trixie. The only coordinator-side override is the
 * orphan case: when the creating agent has been deleted AND the watcher's
 * skill is currently unassigned, the coordinator can clean it up because
 * there's nobody left to delegate to.
 *
 * Returns { ok: true } to execute, { ok: false, reason } to deny.
 *
 * Legacy watchers without agentId (created before scoping landed) are still
 * permissive so we don't lock users out of cleaning up ancient watchers.
 *
 * @param {any} watcher           the watcher record
 * @param {string} callerAgentId  the agent currently making the tool call
 * @param {string} userId
 * @returns {Promise<{ok:true} | {ok:false, reason:string} | {ok:false, needsApproval:true, watcherLabel:string, watcherOwner:string}>}
 */
async function canActOnWatcher(watcher, callerAgentId, userId) {
  if (!watcher) return { ok: false, reason: 'watcher not found' };

  // Legacy watcher with no recorded owner — be permissive.
  if (!watcher.agentId) return { ok: true };

  // Same-agent ops are always allowed (owner can manage own).
  if (watcher.agentId === callerAgentId) return { ok: true };
  const ownerUnscoped = unscopeAgentId(watcher.agentId, userId);
  const callerUnscoped = unscopeAgentId(callerAgentId, userId);
  if (ownerUnscoped === callerUnscoped) return { ok: true };

  // Non-owner. Two-condition orphan override for the coordinator:
  //   1. The creating agent no longer exists, AND
  //   2. The watcher's owning skill is currently unassigned.
  // If either fails, the caller must defer to the agent who owns the
  // watcher (or who now holds the skill). Sole-authority is the rule.
  let watcherAgentExists = true;
  try {
    const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
    const all = getAgentsForUser(userId);
    watcherAgentExists = all.some(a => a.id === ownerUnscoped || a.id === watcher.agentId);
  } catch { /* lookup failure shouldn't accidentally unlock — keep exists=true */ }

  let skillIsAssigned = false;
  if (watcher.skillId) {
    try {
      const { getRoleAssignments } = await import('../../roles.mjs');
      const assignments = getRoleAssignments(userId);
      skillIsAssigned = !!assignments[watcher.skillId];
    } catch { /* same — keep assigned=true if unknown */ skillIsAssigned = true; }
  }

  let isCoordinator = false;
  try {
    const { getUserCoordinatorAgentId } = await import('../../routes/_helpers.mjs');
    const coordinatorId = getUserCoordinatorAgentId(userId);
    isCoordinator = callerUnscoped === 'coordinator' || callerUnscoped === coordinatorId;
  } catch { /* coordinator lookup failure → not coord */ }

  if (isCoordinator && !watcherAgentExists && !skillIsAssigned) {
    return { ok: true };
  }

  // Deny — point the caller at whoever can act.
  const reason = watcherAgentExists
    ? `Watcher was created by ${ownerUnscoped || 'another agent'}, who is the sole authority over it. Use ask_agent to delegate this change to ${ownerUnscoped || 'them'} — even the coordinator can't mutate a watcher owned by another live agent.`
    : (skillIsAssigned
        ? `Watcher's creating agent (${ownerUnscoped || 'unknown'}) was deleted, but the ${watcher.skillId} skill is now held by another agent. Ask the current skill holder to clean this up.`
        : `Watcher's creating agent (${ownerUnscoped || 'unknown'}) was deleted and the ${watcher.skillId || 'underlying'} skill is unassigned. Only the coordinator can perform the cleanup — escalate via ask_agent to the coordinator.`);
  return { ok: false, reason };
}

// ── Pending cross-agent watcher op (staged for user approval) ──────────────
// Same pattern as expenses' CONFIRM DELETION / email's APPROVE PURGE — a
// destructive op that requires the user to type the magic phrase before
// it actually runs. Key by userId, TTL'd so a stale stage from one session
// doesn't fire when an unrelated approval phrase shows up later.
const _pendingWatcherOps = new Map(); // userId → { action, watcherId, args, requestedBy, ts }
const PENDING_WATCHER_TTL_MS = 5 * 60 * 1000;

export function getPendingWatcherOp(userId) {
  const p = _pendingWatcherOps.get(userId);
  if (!p) return null;
  if (Date.now() - p.ts > PENDING_WATCHER_TTL_MS) {
    _pendingWatcherOps.delete(userId);
    return null;
  }
  return p;
}
export function clearPendingWatcherOp(userId) { _pendingWatcherOps.delete(userId); }

export async function executePendingWatcherOp(userId) {
  const pending = getPendingWatcherOp(userId);
  if (!pending) return 'No pending watcher operation (it may have expired).';
  _pendingWatcherOps.delete(userId);
  const { unregisterWatcher, updateWatcher } = await import('../../scheduler/watchers.mjs');
  if (pending.action === 'cancel') {
    const ok = unregisterWatcher(userId, pending.watcherId, 'cancelled');
    return ok ? `Watch "${pending.watcherLabel}" cancelled.` : `Watch already gone — nothing to cancel.`;
  }
  if (pending.action === 'update') {
    const updated = updateWatcher(userId, pending.watcherId, pending.patch);
    return updated ? `Watch "${updated.label}" updated.` : `Watch not found — nothing updated.`;
  }
  return 'Unknown staged watcher action.';
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

async function execSetReminder({ label, datetime, time, repeat = 'once', voice_device, _alarm }, userId) {
  if (!userId) return 'Error: no user context.';
  if (!label || typeof label !== 'string') return 'Error: label is required.';
  const cleanLabel = label.trim();
  if (!cleanLabel) return 'Error: label is empty.';

  const { addTask, scheduleNewTask } = await import('../../scheduler.mjs');
  const base = { label: cleanLabel, ownerId: userId, type: 'reminder', handler: 'fireReminder' };
  // Alarm-clock style (set via the set_alarm tool wrapper): when the task
  // fires, route to the device-side alarm ring loop instead of the
  // one-shot chime+TTS. server.mjs:fireReminder checks task.alarm to pick
  // the path.
  if (_alarm) base.alarm = true;

  // Per-task voice-device override. Accept either an exact device id or a
  // case-insensitive substring match against device name ("remind me in the
  // kitchen"). Unknown name → fail loud rather than silently dropping the
  // override, since the user explicitly named a target. The override layers on
  // top of the user-wide reminderChannel and forces voice delivery in
  // fireReminder regardless of the configured channel.
  if (voice_device && typeof voice_device === 'string') {
    const { listDevices } = await import('../../lib/voice-devices.mjs');
    const devices = listDevices(userId);
    const needle = voice_device.trim().toLowerCase();
    const match = devices.find(d => d.id === voice_device)
      || devices.find(d => (d.name || '').toLowerCase() === needle)
      || devices.find(d => (d.name || '').toLowerCase().includes(needle));
    if (!match) {
      const names = devices.map(d => d.name || d.id).join(', ') || '(none paired)';
      return `Error: no paired voice device matches "${voice_device}". Paired devices: ${names}.`;
    }
    base.voiceDeviceId = match.id;
  }

  const deviceSuffix = base.voiceDeviceId ? ` (speaking on ${voice_device})` : '';

  if (repeat === 'daily') {
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return 'Error: daily reminder needs a time in HH:MM 24-hour format.';
    const [h, m] = time.split(':').map(Number);
    if (h > 23 || m > 59) return `Error: invalid time "${time}".`;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const task = await addTask({ ...base, repeat: 'daily', time: hhmm });
    scheduleNewTask(task);
    return `Reminder "${task.label}" set daily at ${hhmm}${deviceSuffix}. id=${task.id}`;
  }

  if (!datetime) return 'Error: one-shot reminder needs a `datetime` (ISO 8601).';
  const when = new Date(datetime);
  if (Number.isNaN(when.getTime())) return `Error: could not parse datetime "${datetime}".`;
  if (when.getTime() - Date.now() < 5000) return `Error: datetime ${when.toLocaleString()} is in the past or too soon.`;
  const task = await addTask({ ...base, repeat: 'once', datetime: when.toISOString() });
  scheduleNewTask(task);
  return `Reminder "${task.label}" set for ${when.toLocaleString()}${deviceSuffix}. id=${task.id}`;
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

  // Agent-created exec watchers are a persistent shell-RCE vector if the
  // watcher state survives across restarts. Refuse from the agent path. If a
  // user genuinely needs to poll an exec, expose it through a UI route that
  // can prove human approval (state._userConfirmed = true).
  if (source === 'exec') {
    return 'Error: exec watchers cannot be created from agent context. Use http_jsonpath, file_stat, or event_subscription instead.';
  }

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
    if (!['notify', 'agent', 'email', 'telegram'].includes(on_fire.type)) {
      return `Error: on_fire.type must be 'notify', 'agent', 'email', or 'telegram' (got "${on_fire.type}").`;
    }
    if (on_fire.type === 'agent') {
      onFire = { type: 'agent', prompt: on_fire.prompt ? String(on_fire.prompt) : null };
    } else if (on_fire.type === 'email') {
      onFire = {
        type: 'email',
        ...(on_fire.subject ? { subject: String(on_fire.subject) } : {}),
        ...(on_fire.to ? { to: String(on_fire.to) } : {}),
        ...(on_fire.account ? { account: String(on_fire.account) } : {}),
      };
    } else if (on_fire.type === 'telegram') {
      onFire = {
        type: 'telegram',
        ...(on_fire.prefix ? { prefix: String(on_fire.prefix) } : {}),
      };
    } else {
      onFire = { type: 'notify' };
    }
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
  const fireStr =
    onFire?.type === 'agent' ? ' (will run an agent action on fire)' :
    onFire?.type === 'email' ? ' (will email when it fires)' :
    onFire?.type === 'telegram' ? ' (will send Telegram when it fires)' :
    '';
  return `Watch "${label}" created — ${describeWatch({ kind: source, state })} ${predStr}, every ${cadence}s${expStr}${fireStr}. id=${watcherId}`;
}

function _fmtCadence(sec) {
  if (sec < 60)      return `every ${sec}s`;
  if (sec < 3600)   { const m = Math.round(sec / 60);    return `every ${m} min`; }
  if (sec < 86400)  { const h = Math.round(sec / 3600);  return `every ${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.round(sec / 86400);
  if (d === 7)      return 'weekly';
  return `every ${d} day${d === 1 ? '' : 's'}`;
}
function _fmtRelTime(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const sec = Math.round(diff / 1000);
  if (sec < 60)    return `in ${sec}s`;
  if (sec < 3600) { const m = Math.round(sec / 60);   return `in ${m} min`; }
  if (sec < 86400){ const h = Math.round(sec / 3600); return `in ${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.round(sec / 86400);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}
function _fmtAgo(ms) {
  const diff = Date.now() - ms;
  if (diff <= 0) return 'just now';
  const sec = Math.round(diff / 1000);
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600) { const m = Math.round(sec / 60);   return `${m} min ago`; }
  if (sec < 86400){ const h = Math.round(sec / 3600); return `${h}h ago`; }
  const d = Math.round(sec / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
function _fmtDeliver(onFire) {
  const t = onFire?.type;
  if (t === 'email')    return `delivers by email${onFire.to ? ` to ${onFire.to}` : ''}`;
  if (t === 'telegram') return 'delivers by Telegram';
  if (t === 'agent')    return 'notifies via the coordinator (voice/chat)';
  if (t === 'notify')   return 'status bubble only';
  return 'no delivery configured';
}

async function execListWatches(userId, agentId, args) {
  if (!userId) return 'Error: no user context.';
  const { listWatchers } = await import('../../scheduler/watchers.mjs');
  const { active: allActive, recent: allRecent } = listWatchers(userId);
  // Coordinator sees everything by default (or explicitly via all:true).
  // Specialists see only their own watchers unless they pass all:true, which
  // is interpreted as a request — coordinator allows, specialist gets denied
  // and a note about scoping.
  let active = allActive, recent = allRecent;
  const wantsAll = !!args?.all;
  const { getUserCoordinatorAgentId } = await import('../../routes/_helpers.mjs');
  const coordinatorId = getUserCoordinatorAgentId(userId);
  const callerUnscoped = unscopeAgentId(agentId, userId);
  const isCoordinator = callerUnscoped === 'coordinator' || callerUnscoped === coordinatorId;
  if (!isCoordinator) {
    if (wantsAll) {
      return 'Permission denied: only the coordinator can list all watches across agents. Re-call without all:true to see your own.';
    }
    // Filter to only watchers this agent registered. Legacy watchers without
    // agentId stay hidden from specialists — coordinator/admin can still see
    // them via all:true.
    active = allActive.filter(w => w.agentId && (w.agentId === agentId || unscopeAgentId(w.agentId, userId) === callerUnscoped));
    recent = allRecent.filter(w => w.agentId && (w.agentId === agentId || unscopeAgentId(w.agentId, userId) === callerUnscoped));
  }
  if (!active.length && !recent.length) {
    return isCoordinator ? 'No watches configured.' : 'No watches owned by this agent.';
  }
  const lines = [];
  if (active.length) {
    lines.push('Active:');
    for (const w of active) {
      const cadence = _fmtCadence(w.cadenceSec);
      const lastRanAt = w.lastTickAt || (w.ticks > 0 ? w.lastChangeAt : null);
      const lastRan = lastRanAt ? `, last ran ${_fmtAgo(lastRanAt)}` : ', not yet run';
      const nextTick = w.nextTickAt ? `, next check ${_fmtRelTime(w.nextTickAt)}` : '';
      const deliver = `, ${_fmtDeliver(w.onFire)}`;
      const stuck = (w.stuckAnnounced || w.stuckSinceAt) ? ', marked stuck/backed off' : '';
      const ticks = ` (${w.ticks ?? 0} checks so far${w.failures ? `, ${w.failures} failure${w.failures === 1 ? '' : 's'}` : ''})`;
      const last = w.lastStatusText ? `\n    last: ${w.lastStatusText}` : '';
      const expiry = (w.expiresAt === null) ? '' : `, expires ${_fmtRelTime(w.expiresAt)}`;
      lines.push(`- "${w.label}" [${w.kind}${w.skillId ? ` · ${w.skillId}` : ''}] — ${cadence}${lastRan}${nextTick}${deliver}${expiry}${stuck}${ticks} (id: ${w.id})${last}`);
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

// Resolve a friendly cadence input ("hourly", "every 3 hours", "300", { sec })
// into seconds. Returns null if the input is missing/empty; throws on garbage.
const _CADENCE_PRESETS = { minutely: 60, fast: 300, hourly: 3600, daily: 86400, weekly: 604800 };
function _parseCadenceInput(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return Math.max(5, Math.floor(input));
  if (typeof input === 'object' && typeof input.sec === 'number') return Math.max(5, Math.floor(input.sec));
  const s = String(input).trim().toLowerCase();
  if (_CADENCE_PRESETS[s]) return _CADENCE_PRESETS[s];
  // "300" or "300s"
  const bareNum = s.match(/^(\d+)\s*s?$/);
  if (bareNum) return Math.max(5, parseInt(bareNum[1], 10));
  // "every N <unit>" / "N <unit>" / "N min" / "N hour"
  const m = s.match(/(\d+)\s*(s|sec|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (/^s|sec/.test(unit)) return Math.max(5, n);
    if (/^m|min/.test(unit)) return Math.max(5, n * 60);
    if (/^h/.test(unit))      return n * 3600;
    if (/^d/.test(unit))      return n * 86400;
    if (/^w/.test(unit))      return n * 604800;
  }
  return null;
}

async function execUpdateWatch(args, userId, agentId) {
  if (!userId)  return 'Error: no user context.';
  if (!args?.id) return 'Error: id is required (call list_watches to find it).';

  const { listWatchers, updateWatcher } = await import('../../scheduler/watchers.mjs');
  const existing = (listWatchers(userId)?.active || []).find(w => w.id === args.id);
  if (!existing) return `Error: no active watch with id "${args.id}".`;
  const auth = await canActOnWatcher(existing, agentId, userId);
  // Hard deny (not staging) — return early. Staging branch is checked after
  // the patch is built so the approval captures exactly what would change.
  if (!auth.ok && !('needsApproval' in auth && auth.needsApproval)) {
    return `Permission denied: ${auth.reason}`;
  }

  /** @type {{cadenceSec?: number, label?: string, expiresAt?: number|null, onFire?: object}} */
  const patch = {};
  const changes = [];

  // Cadence
  if (args.cadence !== undefined) {
    const sec = _parseCadenceInput(args.cadence);
    if (sec == null) return `Error: could not parse cadence "${args.cadence}". Try a preset ('hourly', 'daily'), a number of seconds, or "every N hours".`;
    if (sec !== existing.cadenceSec) {
      patch.cadenceSec = sec;
      changes.push(`cadence ${existing.cadenceSec}s → ${sec}s`);
    }
  }

  // Label
  if (args.label && typeof args.label === 'string' && args.label.trim() !== existing.label) {
    patch.label = args.label.trim();
    changes.push(`label "${existing.label}" → "${patch.label}"`);
  }

  // Expiry
  if (args.expires_in_hours !== undefined) {
    if (typeof args.expires_in_hours !== 'number' || args.expires_in_hours <= 0) {
      patch.expiresAt = null;
      changes.push('expiry cleared (indefinite)');
    } else {
      patch.expiresAt = Date.now() + args.expires_in_hours * 3600 * 1000;
      changes.push(`expires in ${args.expires_in_hours}h`);
    }
  }

  // Delivery — only build a new onFire if deliver was passed, otherwise leave alone
  if (args.deliver) {
    let onFire;
    if (args.deliver === 'email') {
      onFire = {
        type: 'email',
        subject: args.email_subject || existing.onFire?.subject || `Monitor: ${existing.label}`,
        ...(args.email_to      ? { to: args.email_to }           : (existing.onFire?.to      ? { to: existing.onFire.to }           : {})),
        ...(args.email_account ? { account: args.email_account } : (existing.onFire?.account ? { account: existing.onFire.account } : {})),
      };
    } else if (args.deliver === 'telegram') {
      onFire = {
        type: 'telegram',
        ...(args.telegram_prefix ? { prefix: args.telegram_prefix } : (existing.onFire?.prefix ? { prefix: existing.onFire.prefix } : {})),
      };
    } else if (args.deliver === 'agent') {
      onFire = {
        type: 'agent',
        prompt: args.agent_prompt || existing.onFire?.prompt || `Your monitor "${existing.label}" fired. Summarize and report.`,
      };
    } else if (args.deliver === 'notify') {
      onFire = { type: 'notify' };
    }
    if (onFire && JSON.stringify(onFire) !== JSON.stringify(existing.onFire || {})) {
      patch.onFire = onFire;
      changes.push(`delivery → ${args.deliver}`);
    }
  }

  if (!Object.keys(patch).length) {
    return `No changes — every requested value matches the current watcher.`;
  }

  // Stage approval-required ops AFTER computing the patch so the approval
  // captures exactly what would change. canActOnWatcher returned needsApproval
  // for cross-agent coordinator-delegated calls; defer until the user echoes.
  if (auth.ok === false && 'needsApproval' in auth && auth.needsApproval) {
    _pendingWatcherOps.set(userId, {
      action: 'update',
      watcherId: args.id,
      watcherLabel: auth.watcherLabel,
      patch,
      changes,
      requestedBy: unscopeAgentId(agentId, userId),
      ts: Date.now(),
    });
    return `⚠️ A specialist has asked me (the coordinator) to update watcher "${auth.watcherLabel}" (${changes.join('; ')}), which was created by a different agent (${auth.watcherOwner}). Because this change didn't come directly from you, I'm staging it. Type **APPROVE WATCHER OP** in the chat to proceed, or say anything else to abandon.`;
  }

  const updated = updateWatcher(userId, args.id, patch);
  if (!updated) return `Error: updateWatcher failed for id "${args.id}".`;
  return `Updated "${updated.label}": ${changes.join('; ')}.`;
}

async function execCancelWatch(id, userId, agentId) {
  if (!userId) return 'Error: no user context.';
  if (!id) return 'Error: id is required.';
  const { listWatchers, unregisterWatcher } = await import('../../scheduler/watchers.mjs');
  const watcher = (listWatchers(userId)?.active || []).find(w => w.id === id);
  if (!watcher) return `No active watch with id "${id}".`;
  const auth = await canActOnWatcher(watcher, agentId, userId);
  if (auth.ok === false && 'needsApproval' in auth && auth.needsApproval) {
    _pendingWatcherOps.set(userId, {
      action: 'cancel',
      watcherId: id,
      watcherLabel: auth.watcherLabel,
      requestedBy: unscopeAgentId(agentId, userId),
      ts: Date.now(),
    });
    return `⚠️ A specialist has asked me (the coordinator) to cancel watcher "${auth.watcherLabel}", which was created by a different agent (${auth.watcherOwner}). Because this cancel didn't come directly from you, I'm staging it. Type **APPROVE WATCHER OP** in the chat to proceed, or say anything else to abandon.`;
  }
  if (!auth.ok) return `Permission denied: ${auth.reason}`;
  const ok = unregisterWatcher(userId, id, 'cancelled');
  return ok ? `Watch ${id} cancelled.` : `No active watch with id "${id}".`;
}

// ── collection-watcher item tools (skill-agnostic) ──────────────────────────
//
// These three reach inside any collection watcher (a watcher whose state.items
// is an array of per-item polled entries) and expose list/update/remove of
// the items themselves — not the watcher record. The underlying framework
// lives in scheduler/watchers.mjs (addCollectionItem / updateCollectionItem /
// removeCollectionItem / listAllCollections). Any skill that registers a
// collection via ctx.collection.ensure is automatically reachable here.

function _humanCadence(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600 * 10) / 10}h`;
  return `${Math.round(sec / 86400 * 10) / 10}d`;
}

async function execListWatchItems(args, userId) {
  if (!userId) return 'Error: no user context.';
  const { listAllCollections } = await import('../../scheduler/watchers.mjs');
  const collections = listAllCollections(userId, args.kind ? { kind: args.kind } : {});
  if (!collections.length) return args.kind ? `No collection watcher of kind "${args.kind}".` : 'No collection watchers active.';
  const lines = [];
  for (const c of collections) {
    lines.push(`### ${c.label} (kind=${c.kind}${c.skillId ? `, skill=${c.skillId}` : ''}) — ${c.items.length} item(s)`);
    if (!c.items.length) { lines.push('  (empty — add items via the owning skill\'s kickoff tool)'); continue; }
    for (const it of c.items) {
      const due = it.nextDueAt && it.nextDueAt > Date.now()
        ? `due in ${_humanCadence(Math.max(0, Math.round((it.nextDueAt - Date.now()) / 1000)))}`
        : 'due now';
      const cad = `every ${_humanCadence(it.cadenceSec || 3600)}`;
      const extra = Object.entries(it)
        .filter(([k]) => !['id', 'cadenceSec', 'nextDueAt', 'addedAt', 'deliver'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60)}`)
        .join(', ');
      lines.push(`  - itemId=\`${it.id}\` ${cad}, ${due}${it.deliver ? `, deliver=${it.deliver}` : ''}${extra ? `\n    ${extra}` : ''}`);
    }
  }
  return lines.join('\n');
}

async function execUpdateWatchItem(args, userId) {
  if (!userId) return 'Error: no user context.';
  const { kind, item_id: itemId, patch } = args || {};
  if (!kind)   return 'Error: kind is required (use list_watch_items to see active kinds).';
  if (!itemId) return 'Error: item_id is required.';
  if (!patch || typeof patch !== 'object') return 'Error: patch must be an object of fields to overwrite.';
  const { listAllCollections, updateCollectionItem } = await import('../../scheduler/watchers.mjs');
  const collections = listAllCollections(userId, { kind });
  if (!collections.length) return `No collection watcher of kind "${kind}".`;
  for (const c of collections) {
    const r = updateCollectionItem(userId, { watcherId: c.watcherId }, itemId, patch);
    if (r.updated) {
      const fields = Object.keys(patch).filter(k => !['id', 'addedAt'].includes(k));
      return `Updated item \`${itemId}\` in ${c.label} (${fields.join(', ') || 'no changes'}).`;
    }
  }
  return `No item with id "${itemId}" in any ${kind} collection.`;
}

async function execRemoveWatchItem(args, userId) {
  if (!userId) return 'Error: no user context.';
  const { kind, item_id: itemId } = args || {};
  if (!kind)   return 'Error: kind is required.';
  if (!itemId) return 'Error: item_id is required.';
  const { listAllCollections, removeCollectionItem } = await import('../../scheduler/watchers.mjs');
  const collections = listAllCollections(userId, { kind });
  if (!collections.length) return `No collection watcher of kind "${kind}".`;
  for (const c of collections) {
    const r = removeCollectionItem(userId, { watcherId: c.watcherId }, itemId);
    if (r.removed) return `Removed item \`${itemId}\` from ${c.label}.`;
  }
  return `No item with id "${itemId}" in any ${kind} collection.`;
}

async function execScheduleTask({ label, prompt, datetime, time, repeat = 'once', interval_minutes, silent = false }, userId, agentId) {
  if (!userId) return 'Error: no user context.';
  if (!label || typeof label !== 'string') return 'Error: label is required.';
  if (!prompt || typeof prompt !== 'string') return 'Error: prompt is required.';
  const { canRunScheduledTaskSilently } = await import('../../lib/autonomy-policy.mjs');
  const silentPolicy = canRunScheduledTaskSilently({ prompt, silent });
  if (!silentPolicy.ok) {
    return `Error: ${silentPolicy.reason}. Schedule it with silent=false so the run is visible to the user.`;
  }
  const rawAgent = unscopeAgentId(agentId, userId);
  if (!rawAgent) return 'Error: no agent context — cannot schedule.';

  const { addTask, scheduleNewTask, formatTaskCadence } = await import('../../scheduler.mjs');
  const base = { label: label.trim(), prompt: prompt.trim(), ownerId: userId, agent: rawAgent, ...(silent && { silent: true }) };
  const silentTag = silent ? ' (silent — no chat output)' : '';

  // Fixed-cadence interval task (every N minutes/hours). Also accept a bare
  // interval_minutes as the interval signal — but ONLY when there's no explicit
  // clock anchor (datetime/time) and the caller didn't ask for daily. Otherwise
  // a stray interval_minutes on a `{datetime, interval_minutes}` call would
  // silently discard the datetime and create the wrong (recurring) task.
  if (repeat === 'interval' || (interval_minutes != null && !datetime && !time && repeat !== 'daily')) {
    const mins = Number(interval_minutes);
    if (!Number.isFinite(mins) || mins < 1) {
      return 'Error: interval task needs interval_minutes >= 1 (e.g. 60 for hourly, 5 for every 5 minutes, 1440 for daily).';
    }
    const intervalMs = Math.round(mins * 60_000);
    const task = await addTask({ ...base, repeat: 'interval', intervalMs });
    scheduleNewTask(task);
    return `Task "${task.label}" scheduled ${formatTaskCadence(task)} via agent ${rawAgent}${silentTag}. id=${task.id}`;
  }

  if (repeat === 'daily') {
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return 'Error: daily task needs a time in HH:MM 24-hour format.';
    const [h, m] = time.split(':').map(Number);
    if (h > 23 || m > 59) return `Error: invalid time "${time}".`;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const task = await addTask({ ...base, repeat: 'daily', time: hhmm });
    scheduleNewTask(task);
    return `Task "${task.label}" scheduled daily at ${hhmm} via agent ${rawAgent}${silentTag}. id=${task.id}`;
  }

  if (!datetime) return 'Error: one-shot task needs a `datetime` (ISO 8601).';
  const when = new Date(datetime);
  if (Number.isNaN(when.getTime())) return `Error: could not parse datetime "${datetime}".`;
  if (when.getTime() - Date.now() < 5000) return `Error: datetime ${when.toLocaleString()} is in the past or too soon.`;
  const task = await addTask({ ...base, repeat: 'once', datetime: when.toISOString() });
  scheduleNewTask(task);
  return `Task "${task.label}" scheduled for ${when.toLocaleString()} via agent ${rawAgent}${silentTag}. id=${task.id}`;
}

async function execAutonomyStatus(userId, agentId) {
  if (!userId) return 'Error: no user context.';
  const { listWatchers } = await import('../../scheduler/watchers.mjs');
  const { listUserProposals } = await import('../../lib/proposals.mjs');
  const { summarizeAutonomyPolicy } = await import('../../lib/autonomy-policy.mjs');
  const watchers = listWatchers(userId);
  const active = watchers.active || [];
  const recent = watchers.recent || [];
  const proposals = listUserProposals(userId, 'pending');
  const policy = summarizeAutonomyPolicy();

  const deliverCounts = active.reduce((acc, w) => {
    const k = w.onFire?.type || 'none';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const stuck = active.filter(w => w.stuckAnnounced || w.stuckSinceAt);
  const owned = agentId
    ? active.filter(w => w.agentId === agentId || unscopeAgentId(w.agentId, userId) === unscopeAgentId(agentId, userId)).length
    : 0;

  const lines = [
    `Autonomy status: ${active.length} active watcher(s), ${recent.length} recent watcher(s), ${proposals.length} pending proposal(s).`,
    `This agent owns ${owned} active watcher(s).`,
    `Delivery: ${Object.entries(deliverCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}.`,
    `Stuck/backed-off: ${stuck.length}.`,
    `Policy: silent tasks — ${policy.silentTasks}; exec watchers — ${policy.execWatchers}; monitor offers — ${policy.monitorOffers}; watcher recovery — ${policy.watcherRecovery}.`,
  ];
  if (stuck.length) {
    lines.push('Needs attention:');
    for (const w of stuck.slice(0, 5)) {
      lines.push(`- "${w.label}" (${w.kind}) last changed ${_fmtAgo(w.lastChangeAt || w.createdAt)}; cadence ${w.cadenceSec}s; id=${w.id}`);
    }
  }
  return lines.join('\n');
}

export default async function execute(name, args, userId, agentId, ctx) {
  if (name === 'set_reminder')    return execSetReminder(args || {}, userId);
  if (name === 'set_alarm')       return execSetReminder({ ...(args || {}), _alarm: true }, userId);
  if (name === 'schedule_task')   return execScheduleTask(args || {}, userId, agentId);
  if (name === 'list_tasks')      return execListTasks(userId);
  if (name === 'delete_task')     return execDeleteTask(args.id, userId);
  if (name === 'list_reminders')  return execListReminders(userId);
  if (name === 'cancel_reminder') return execCancelReminder(args.id, userId);
  if (name === 'create_watch')    return execCreateWatch(args || {}, userId, agentId, ctx);
  if (name === 'list_watches')    return execListWatches(userId, agentId, args || {});
  if (name === 'update_watch')    return execUpdateWatch(args, userId, agentId);
  if (name === 'cancel_watch')    return execCancelWatch(args?.id, userId, agentId);
  if (name === 'list_watch_items')  return execListWatchItems(args || {}, userId);
  if (name === 'update_watch_item') return execUpdateWatchItem(args || {}, userId);
  if (name === 'remove_watch_item') return execRemoveWatchItem(args || {}, userId);
  if (name === 'autonomy_status')    return execAutonomyStatus(userId, agentId);
  return `Unknown tool: ${name}`;
}
