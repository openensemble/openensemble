// Task-creation paths (schedule_task, set_reminder) moved out of the tool
// surface and into lib/scheduler-intent.mjs, which runs pre-LLM on every
// chat regardless of which agent is active. This file now only handles the
// query + cleanup tools (list/delete/cancel), which benefit from being
// model-callable because the coordinator picks the right ID from context.

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

export default async function execute(name, args, userId) {
  if (name === 'list_tasks')     return execListTasks(userId);
  if (name === 'delete_task')    return execDeleteTask(args.id, userId);
  if (name === 'list_reminders') return execListReminders(userId);
  if (name === 'cancel_reminder') return execCancelReminder(args.id, userId);
  return `Unknown tool: ${name}`;
}
