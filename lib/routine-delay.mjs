// Wait actions use the regular durable scheduler, so pending continuations
// survive restart and can be canceled from Tasks like any other one-shot.
import { addTask, scheduleNewTask } from '../scheduler.mjs';
import { executeRoutineOutOfBand, validateRoutineDelay } from './routines.mjs';
import { listDevices } from './voice-devices.mjs';

export async function scheduleRoutineContinuation(routine, ctx, seconds) {
  validateRoutineDelay(seconds);
  if (!ctx.userId) throw new Error('A routine wait requires a user.');
  const resumeAt = new Date(Date.now() + seconds * 1000).toISOString();
  const task = await addTask({
    label: `Continue routine: ${routine.trigger}`,
    ownerId: ctx.userId,
    type: 'builtin',
    handler: 'resumeRoutine',
    agent: ctx.agentId || 'coordinator',
    repeat: 'once',
    datetime: resumeAt,
    voiceDeviceId: ctx.deviceId || null,
    // Snapshot only the remaining actions, never the webhook capability.
    routineContinuation: JSON.parse(JSON.stringify({
      id: routine.id, trigger: routine.trigger, actions: routine.actions,
    })),
  });
  scheduleNewTask(task);
  return { taskId: task.id, resumeAt };
}

async function runDelayedPrompt(task, runContext, prompt) {
  const { resolveRuntimeAgentForUser } = await import('../routes/_helpers.mjs');
  const agent = resolveRuntimeAgentForUser(task.ownerId, task.agent);
  if (!agent) throw new Error('No agent is available for this routine prompt.');
  const { streamChat } = await import('../chat.mjs');
  const { runAgentWithRetry } = await import('./run-agent-with-retry.mjs');
  const rootTaskId = runContext.scheduledRunRootId || task.id;
  const result = await runAgentWithRetry({
    scopedAgent: { ...agent, id: `${task.ownerId}_${agent.id}` },
    userText: prompt,
    systemNote: '[SCHEDULED RUN] Continue the user\'s saved voice routine now. Its wait has finished. Execute this prompt now; do not schedule it again.',
    userId: task.ownerId,
    streamChat,
    silent: true,
    maxAttempts: 1,
    context: 'routine',
    rootTaskId,
    traceSource: 'scheduled',
    originTaskId: task.id,
    originTaskOwnerId: task.ownerId,
    originTaskAgent: agent.id,
    originTaskRunId: rootTaskId,
    originTaskManual: runContext.manual === true,
    taskContext: { taskId: task.id, rootTaskId, watcherId: null, rootWatcherId: null },
  });
  if (!result.succeeded) throw new Error(result.lastError || 'Routine prompt failed.');
  return result.assistantContent || '';
}

export async function resumeRoutine(task, runContext = {}) {
  const saved = task.routineContinuation;
  if (!task.ownerId || !saved?.id || !Array.isArray(saved.actions)) {
    throw new Error('Invalid saved routine continuation.');
  }
  // A device may have been unpaired or transferred during the wait.
  const deviceId = task.voiceDeviceId && listDevices(task.ownerId).some(d => d.id === task.voiceDeviceId)
    ? task.voiceDeviceId : null;
  const result = await executeRoutineOutOfBand({
    ...saved, aliases: [], device_id: null, webhook_token: '',
  }, {
    userId: task.ownerId, deviceId, agentId: task.agent,
    continuation: true,
    runPrompt: prompt => runDelayedPrompt(task, runContext, prompt),
  });
  if (result.errors.length) throw new Error(result.errors.map(e => `${e.type}: ${e.message}`).join('; '));
  return result.scheduled
    ? `Routine waiting until ${result.scheduled.resumeAt}`
    : result.text || `Routine "${saved.trigger}" completed.`;
}
