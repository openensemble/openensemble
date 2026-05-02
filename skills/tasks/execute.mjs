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

export default async function execute(name, args, userId, agentId) {
  if (name === 'set_reminder')   return execSetReminder(args || {}, userId);
  if (name === 'schedule_task')  return execScheduleTask(args || {}, userId, agentId);
  if (name === 'list_tasks')     return execListTasks(userId);
  if (name === 'delete_task')    return execDeleteTask(args.id, userId);
  if (name === 'list_reminders') return execListReminders(userId);
  if (name === 'cancel_reminder') return execCancelReminder(args.id, userId);
  return `Unknown tool: ${name}`;
}
