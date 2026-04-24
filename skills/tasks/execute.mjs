// Task-creation paths (schedule_task, set_reminder) moved out of the tool
// surface and into lib/scheduler-intent.mjs, which runs pre-LLM on every
// chat regardless of which agent is active. This file now only handles the
// query + cleanup tools (list/delete/cancel), which benefit from being
// model-callable because the coordinator picks the right ID from context.

async function execListTasks() {
  const { loadTasks } = await import('../../scheduler.mjs');
  const tasks = loadTasks();
  if (!tasks.length) return 'No scheduled tasks.';
  return tasks.map(t => {
    const schedStr = t.repeat === 'once'
      ? `once at ${t.datetime ? new Date(t.datetime).toLocaleString() : '?'}`
      : `${t.time} daily`;
    const status = t.repeat === 'once' && !t.enabled ? 'DONE' : (t.enabled ? 'ON' : 'OFF');
    return `- [${status}] "${t.label}" — ${schedStr} via ${t.agent} (id: ${t.id})`;
  }).join('\n');
}

async function execDeleteTask(id) {
  const { removeTask } = await import('../../scheduler.mjs');
  removeTask(id);
  return `Task ${id} deleted.`;
}

async function execListReminders(userId) {
  const { loadTasks } = await import('../../scheduler.mjs');
  const reminders = loadTasks().filter(t => t.type === 'reminder' && t.ownerId === userId);
  if (!reminders.length) return 'No active reminders.';
  return reminders.map(r => {
    const sched = r.repeat === 'once'
      ? `once at ${r.datetime ? new Date(r.datetime).toLocaleString() : '?'}`
      : `${r.time} ${r.weekdaysOnly ? 'weekdays' : 'daily'}`;
    const status = r.repeat === 'once' && !r.enabled ? 'DONE' : (r.enabled ? 'ON' : 'OFF');
    return `- [${status}] "${r.label}" — ${sched} (id: ${r.id})`;
  }).join('\n');
}

async function execCancelReminder(id, userId) {
  const { loadTasks, removeTask } = await import('../../scheduler.mjs');
  const task = loadTasks().find(t => t.id === id);
  if (!task) return `No reminder found with ID "${id}".`;
  if (task.type !== 'reminder') return `"${id}" is a scheduled task, not a reminder. Use delete_task instead.`;
  if (task.ownerId !== userId) return `That reminder belongs to another user.`;
  removeTask(id);
  return `Reminder "${task.label}" cancelled.`;
}

export default async function execute(name, args, userId) {
  if (name === 'list_tasks')     return execListTasks();
  if (name === 'delete_task')    return execDeleteTask(args.id);
  if (name === 'list_reminders') return execListReminders(userId);
  if (name === 'cancel_reminder') return execCancelReminder(args.id, userId);
  return `Unknown tool: ${name}`;
}
