// User-facing evidence for delegated work, projected from the owning chat.
// Completed reports already belong to session retention, project checkpoints,
// backups and deletion. Do not create a second, orphaned history store.
import { loadSession, getSessionEpoch } from '../sessions.mjs';
import { activeTasks } from '../background-tasks/state.mjs';
import { getJobCheckpoint, checkpointToolEvents } from '../background-tasks/checkpoints.mjs';
import { redactArgsForTrace, redactTextForTrace } from './run-inspector.mjs';
import { compactDocumentToolArgs, compactDocumentToolResult } from './document-artifacts.mjs';

const TERMINAL = new Set(['done', 'complete', 'completed', 'error', 'failed', 'cancelled', 'canceled', 'stopped', 'interrupted']);
const MAX_ACTIONS = 256;
const MAX_TEXT = 100_000;
const time = value => Number.isFinite(value) && value > 0 ? value : null;
const clean = (value, limit = MAX_TEXT) => redactTextForTrace(typeof value === 'string' ? value : '').slice(0, limit);
const fail = (status, message) => Object.assign(new Error(message), { status });

function actionEvidence(event, index, terminal) {
  const name = clean(event?.name, 160);
  const args = event?.args && typeof event.args === 'object'
    ? JSON.stringify(redactArgsForTrace(compactDocumentToolArgs(name, event.args)), null, 2) : '';
  const rawResult = String(event?.text ?? event?.preview ?? '');
  const result = compactDocumentToolResult(name, rawResult);
  const status = clean(event?.status, 40) || 'unknown';
  return {
    id: clean(event?.toolCallId, 512) || `action_${index}`,
    name,
    status: terminal && ['running', 'pending'].includes(status) ? 'unconfirmed' : status,
    startedAt: time(event?.startedAt), endedAt: time(event?.endedAt),
    durationMs: Number.isFinite(event?.durationMs) ? event.durationMs : null,
    args: clean(args, 10_000), result: clean(result, 10_000),
    argsTruncated: args.length > 10_000,
    resultTruncated: event?.resultTruncated === true || rawResult.length >= 10_000,
    providerReported: event?.syntheticHosted === true,
  };
}

export function projectAgentWork(record, { live = false, details = false } = {}) {
  const status = clean(record.status, 40) || (live ? 'running' : 'unknown');
  const events = Array.isArray(record.toolEvents) ? record.toolEvents : [];
  const progress = Array.isArray(record.workProgress) ? record.workProgress
    : Array.isArray(record.progress) ? record.progress : [];
  const conclusion = live ? '' : String(record.displayContent ?? record.content ?? '');
  const result = {
    taskId: clean(record.taskId, 200), rootTaskId: clean(record.rootTaskId, 200) || null,
    parentTaskId: clean(record.parentTaskId, 200) || null,
    name: clean(record.agentName, 160) || 'Agent',
    assignment: clean(record.originalTask || record.summary, details ? MAX_TEXT : 600),
    status, active: live && !TERMINAL.has(status), phase: clean(record.phase, 60) || status,
    provider: clean(record.runtimeProvider || record.provider, 100) || null,
    model: clean(record.runtimeModel || record.model, 300) || null,
    modelSource: record.runtimeModel ? 'runtime' : record.model ? 'configured' : 'unknown',
    startedAt: time(record.startedAt) || time(events[0]?.startedAt),
    endedAt: live ? null : time(record.endedAt || record.ts),
    currentTool: live ? clean(record.currentTool, 160) || null : null,
    actionCount: events.length || Math.max(0, Number(record.toolsUsed) || 0),
    latestProgress: clean(progress.at(-1)?.text, 400),
    conclusionPreview: clean(conclusion, 240),
  };
  if (!details) return result;
  return {
    ...result,
    assignmentTruncated: String(record.originalTask || record.summary || '').length > MAX_TEXT,
    conclusion: clean(conclusion), conclusionTruncated: conclusion.length > MAX_TEXT,
    actions: events.slice(0, MAX_ACTIONS).map((event, index) => actionEvidence(event, index, !result.active)),
    omittedActions: Math.max(0, events.length - MAX_ACTIONS),
    progress: progress.slice(-200).map(entry => ({
      ts: time(entry?.ts), kind: clean(entry?.kind, 40),
      text: clean(entry?.text, 1200), tool: clean(entry?.tool, 160),
    })),
    omittedProgress: Math.max(0, Number(record.workProgressDropped) || 0) + Math.max(0, progress.length - 200),
    artifacts: (Array.isArray(record.images) ? record.images : []).slice(0, 32)
      .map(item => ({ filename: clean(item?.filename, 300), mimeType: clean(item?.mimeType, 100) }))
      .filter(item => item.filename),
  };
}

/** All data must belong to the authenticated conversation, including its epoch. */
export async function readAgentWork(userId, sessionKey, { taskId = null, epoch = null, offset = 0, limit = 50 } = {}) {
  if (!/^user_[a-zA-Z0-9]+$/.test(userId || '') || !sessionKey?.startsWith(`${userId}_`)) {
    throw fail(404, 'Conversation not found.');
  }
  const currentEpoch = getSessionEpoch(sessionKey);
  if (epoch && epoch !== currentEpoch) throw fail(409, 'The conversation changed. Reopen Agents to refresh.');
  // Snapshot live references before reading history: a concurrent completion
  // can then replace its live row, without disappearing between the two reads.
  const live = [...activeTasks.entries()].filter(([, rec]) => rec.userId === userId
    && rec.sourceSessionKey === sessionKey && rec.sourceSessionEpoch === currentEpoch
    && !rec.originScheduledTaskId && !rec.originScheduledSilent);
  const messages = await loadSession(sessionKey, Number.MAX_SAFE_INTEGER);
  if (getSessionEpoch(sessionKey) !== currentEpoch) throw fail(409, 'The conversation changed. Reopen Agents to refresh.');
  const records = new Map();
  for (const row of messages) {
    if (row?.kind !== 'agent_report' || typeof row.taskId !== 'string') continue;
    if (!records.has(row.taskId)) records.set(row.taskId, { record: row, live: false });
  }
  for (const [id, rec] of live) {
    // A report is authoritative once the live task has left the registry.
    if (records.has(id) && !activeTasks.has(id)) continue;
    let events = rec.auditToolEvents;
    if (taskId === id && !Array.isArray(events)) {
      const checkpoint = getJobCheckpoint(userId, id)?.checkpoint;
      if (checkpoint) events = checkpointToolEvents(checkpoint);
    }
    records.set(id, { record: { ...rec, taskId: id, toolEvents: events }, live: true });
  }
  if (taskId) {
    const entry = records.get(taskId);
    if (!entry) throw fail(404, 'No saved work details are available for this task in this conversation.');
    return { epoch: currentEpoch, task: projectAgentWork(entry.record, { live: entry.live, details: true }) };
  }
  const tasks = [...records.values()].map(entry => projectAgentWork(entry.record, { live: entry.live }))
    .sort((a, b) => Number(b.active) - Number(a.active)
      || (b.startedAt || b.endedAt || 0) - (a.startedAt || a.endedAt || 0));
  return { epoch: currentEpoch, tasks: tasks.slice(offset, offset + limit), total: tasks.length,
    nextOffset: offset + limit < tasks.length ? offset + limit : null };
}
