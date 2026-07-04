/**
 * Background agent task dispatcher.
 * Fires ask_agent calls without blocking the coordinator's turn.
 * Live progress surfaces via the task_proxy watcher chip in chat; on
 * completion a notification is injected into the coordinator's session
 * and a task-backed agent_report is broadcast so the UI can update the chip.
 */

import { getTurnContext } from './lib/turn-abort-context.mjs';
import fs from 'fs';
import path from 'path';
import { registerWatcher, pushWatcherStatus, completeWatcher } from './scheduler/watchers.mjs';
import { runInTaskContext } from './lib/task-proxy-context.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';
import { learnToolPlanFromToolEvents, matchToolPlan } from './lib/tool-plan-memory.mjs';
import { registerScheduledChild, completeScheduledChild } from './lib/scheduled-child-barrier.mjs';
import { appendTaskOutcome, loadTaskOutcomes } from './lib/task-outcomes.mjs';
import { BASE_DIR, USERS_DIR } from './lib/paths.mjs';

let _broadcast = null;
export function setBackgroundBroadcastFn(fn) { _broadcast = fn; }

// Voice-device origin of the CURRENT turn (ALS), stamped onto task records at
// registration so completions can announce themselves on the device speaker.
function _voiceOrigin() {
  try {
    const tc = getTurnContext();
    return { voiceDeviceId: tc?.deviceId ?? null, voiceConversation: !!tc?.conversationMode };
  } catch { return { voiceDeviceId: null, voiceConversation: false }; }
}

// in-flight task registry: taskId -> { agentId, userId, agentName, startedAt }
const activeTasks = new Map();

// ── restart journal ───────────────────────────────────────────────────────────
// activeTasks / rootTaskGraphs / the recent* rings are all in-memory, so a
// server restart used to erase every trace that a delegation or worker ever
// existed: the chip stayed "running" until the 1h watcher boot-reap,
// check_workers reported ambiguous silence ("no background work"), and nobody
// was told — which is how the coordinator ends up answering "already in
// progress" from its own stale session promise. The journal is a tiny on-disk
// mirror of in-flight tasks: entry added at dispatch, removed on completion.
// Anything still present at boot was killed by the restart, by definition —
// bootRecoverInterruptedTasks marks each one cancelled everywhere the truth is
// consumed: the recent rings (check_workers), the watcher chip (UI), and the
// owning chat session (the coordinator's next turn).
const JOURNAL_PATH = path.join(BASE_DIR, 'background-task-journal.json');

function _journalLoad() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')) || {}; }
  catch { return {}; }
}

function _journalSave(entries) {
  try { fs.writeFileSync(JOURNAL_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 }); }
  catch (e) { console.warn('[background-tasks] journal write failed:', e.message); }
}

function _journalAdd(taskId) {
  const rec = activeTasks.get(taskId);
  if (!rec) return;
  const entries = _journalLoad();
  entries[taskId] = {
    userId: rec.userId,
    kind: rec.isWorker ? 'worker' : 'delegation',
    agentId: rec.agentId,
    agentName: rec.agentName,
    agentEmoji: rec.agentEmoji || '🤖',
    summary: rec.summary || '',
    watcherId: rec.watcherId || null,
    rootWatcherId: rec.rootWatcherId || null,
    rootTaskId: rec.rootTaskId || taskId,
    ownerKey: rec.ownerKey || null,
    coordinatorAgentId: rec.coordinatorAgentId || null,
    visibleAgentId: rec.visibleAgentId || null,
    startedAt: rec.startedAt,
  };
  _journalSave(entries);
}

function _journalRemove(taskId) {
  const entries = _journalLoad();
  if (!(taskId in entries)) return;
  delete entries[taskId];
  _journalSave(entries);
}

/**
 * Restart recovery — called once from server boot, AFTER startWatcherSupervisor
 * (completeWatcher only sees watcher files already loaded into memory). Every
 * journal entry at this point is a task the restart killed mid-flight; mark it
 * cancelled + notify, do NOT auto-resume: silently re-running a side-effectful
 * task ("send the email") after a restart is worse than asking again.
 */
export async function bootRecoverInterruptedTasks() {
  const entries = _journalLoad();
  const ids = Object.keys(entries);
  if (!ids.length) return 0;
  const now = Date.now();
  for (const [taskId, e] of Object.entries(entries)) {
    const name = e.agentName || 'Agent';
    const interruptNote = 'Interrupted by a server restart — did not finish.';

    // 1. Terminal fact for check_workers (the rings are in-memory, also lost).
    if (e.kind === 'worker') {
      recentWorkers.unshift({
        taskId, ownerKey: e.ownerKey, userId: e.userId,
        name, summary: e.summary, outcome: 'stopped',
        finalText: interruptNote, toolsUsed: 0,
        startedAt: e.startedAt, endedAt: now,
      });
      if (recentWorkers.length > RECENT_CAP) recentWorkers.length = RECENT_CAP;
    } else {
      recentDelegations.unshift({
        taskId, userId: e.userId, agentId: e.agentId,
        rootTaskId: e.rootTaskId || taskId,
        parentTaskId: null, spanId: null,
        watcherId: e.watcherId || null, rootWatcherId: null,
        visibleAgentId: e.visibleAgentId || null,
        name, summary: e.summary, outcome: 'stopped',
        finalText: interruptNote, toolsUsed: 0,
        startedAt: e.startedAt, endedAt: now,
      });
      if (recentDelegations.length > RECENT_CAP) recentDelegations.length = RECENT_CAP;
    }

    // 2. Finalize the chip now instead of waiting out the 1h watcher boot-reap.
    //    completeWatcher no-ops if the reap already moved it to recent.
    if (e.watcherId) {
      try {
        completeWatcher(e.userId, e.watcherId, {
          status: 'error',
          finalText: `⚠ ${name} interrupted by server restart`,
        });
      } catch (err) {
        console.warn('[background-tasks] restart chip finalize failed:', err.message);
      }
    }

    // 3. Session notice — same agent_report shape _onComplete injects — so the
    //    owning chat's LLM reads the interruption as conversation fact on its
    //    next turn. This is what kills the "already in progress" fabrication:
    //    the session that holds the old promise now also holds the cancellation.
    const reportAgentId = e.visibleAgentId || e.coordinatorAgentId;
    const content = `[${name}'s background task was interrupted — re: "${e.summary}"]\nThe server restarted while ${name} was working on this. The task was cancelled and did NOT finish. If it is still wanted, it must be started again.`;
    const displayContent = `The server restarted while ${name} was working on this. The task was cancelled and did not finish. If it is still wanted, it must be started again.`;
    const reportId = e.spanId || taskId;
    if (reportAgentId) {
      try {
        const { appendToSession } = await import('./sessions.mjs');
        await appendToSession(reportAgentId, {
          role: 'assistant',
          kind: 'agent_report',
          reportId,
          agentName: name, agentEmoji: e.agentEmoji || '🤖',
          content,
          displayContent,
          toolEvents: [],
          targetAgentId: e.agentId || null,
          originalTask: e.summary || '',
          taskId,
          rootTaskId: e.rootTaskId || taskId,
          watcherId: e.watcherId || null,
          rootWatcherId: e.rootWatcherId || e.watcherId || null,
          spanId: e.spanId || null,
          status: 'error',
          ts: now,
        });
      } catch (err) {
        console.warn('[background-tasks] restart-notice inject failed:', err.message);
      }
    }

    // 4. Best-effort UI card (usually nobody is connected mid-restart; the
    //    session notice above is the durable copy).
    _broadcast?.({
      type: 'agent_report',
      agent: reportAgentId,
      reportId,
      agentName: name, agentEmoji: e.agentEmoji || '🤖',
      content,
      displayContent,
      toolEvents: [],
      targetAgentId: e.agentId || null,
      originalTask: e.summary || '',
      taskId,
      rootTaskId: e.rootTaskId || taskId,
      watcherId: e.watcherId || null,
      rootWatcherId: e.rootWatcherId || e.watcherId || null,
      spanId: e.spanId || null,
      status: 'error',
      ts: now,
    });
  }
  _journalSave({});
  console.log(`[background-tasks] boot: marked ${ids.length} restart-interrupted task(s) cancelled and notified owners`);
  return ids.length;
}

// Root task graph for nested delegation. Existing ids remain intact:
// - watcher UUIDs are still the user-visible chip ids
// - bg_/deleg_/ephemeral ids remain internal runtime ids
// This graph links them so status lookups can resolve "root -> child agent"
// and a root chip does not finish while child delegations are still running.
const rootTaskGraphs = new Map(); // rootTaskId -> { userId, rootWatcherId, visibleAgentId, children, pendingCompletion }

function _slug(s) {
  return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function _rootChildSnapshot(root) {
  if (!root?.children?.size) return [];
  return [...root.children.values()].map(c => ({
    taskId: c.taskId,
    watcherId: c.watcherId || null,
    spanId: c.spanId || null,
    name: c.name || 'Agent',
    summary: c.summary || '',
    status: c.status || 'running',
    currentTool: c.currentTool || null,
    startedAt: c.startedAt || null,
    lastActivityAt: c.lastActivityAt || null,
  }));
}

function _ensureRootGraph({ userId, rootTaskId, rootWatcherId = null, visibleAgentId = null, summary = '' }) {
  if (!rootTaskId) return null;
  let root = rootTaskGraphs.get(rootTaskId);
  if (!root) {
    root = {
      userId,
      rootTaskId,
      rootWatcherId: rootWatcherId || null,
      visibleAgentId: visibleAgentId || null,
      summary: summary || '',
      children: new Map(),
      pendingCompletion: null,
    };
    rootTaskGraphs.set(rootTaskId, root);
  } else {
    if (rootWatcherId && !root.rootWatcherId) root.rootWatcherId = rootWatcherId;
    if (visibleAgentId && !root.visibleAgentId) root.visibleAgentId = visibleAgentId;
    if (summary && !root.summary) root.summary = summary;
  }
  return root;
}

/** @param {{ userId?: string, rootTaskId?: string, rootWatcherId?: string|null, visibleAgentId?: string|null, summary?: string }} [opts] */
export function registerTaskRoot({ userId, rootTaskId, rootWatcherId, visibleAgentId = null, summary = '' } = {}) {
  return !!_ensureRootGraph({ userId, rootTaskId, rootWatcherId, visibleAgentId, summary });
}

function _attachRootChild(taskId, rec) {
  if (!rec?.rootTaskId || rec.rootTaskId === taskId) return;
  const root = _ensureRootGraph({
    userId: rec.userId,
    rootTaskId: rec.rootTaskId,
    rootWatcherId: rec.rootWatcherId || rec.parentWatcherId || null,
    visibleAgentId: rec.visibleAgentId || null,
  });
  if (!root) return;
  root.children.set(taskId, {
    taskId,
    watcherId: rec.watcherId || null,
    spanId: rec.spanId || null,
    name: rec.agentName,
    summary: rec.summary,
    status: rec.status || 'running',
    currentTool: rec.currentTool || null,
    startedAt: rec.startedAt,
    lastActivityAt: Date.now(),
  });
  if (root.rootWatcherId) {
    const names = _rootChildSnapshot(root).map(c => c.name).filter(Boolean).join(', ');
    pushWatcherStatus(rec.userId, root.rootWatcherId, `Delegated child task running: ${names || rec.agentName}`, {
      rootTaskId: rec.rootTaskId,
      phase: 'child_running',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      lastActivityAt: Date.now(),
    });
  }
}

function _updateRootChildProgress(rec, extra = {}) {
  if (!rec?.rootTaskId || rec.rootTaskId === rec.taskId) return;
  const root = rootTaskGraphs.get(rec.rootTaskId);
  const child = root?.children?.get(rec.taskId);
  if (!root || !child) return;
  Object.assign(child, {
    status: rec.status || child.status || 'running',
    currentTool: rec.currentTool || null,
    lastActivityAt: Date.now(),
    ...extra,
  });
  if (root.rootWatcherId && rec.watcherId !== root.rootWatcherId) {
    const action = rec.currentTool ? `running ${rec.currentTool}` : (extra.status || child.status || 'running');
    pushWatcherStatus(rec.userId, root.rootWatcherId, `${rec.agentName || 'Agent'}: ${action}`, {
      rootTaskId: rec.rootTaskId,
      phase: 'child_progress',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      lastActivityAt: Date.now(),
    });
  }
}

export function hasActiveTaskChildren(rootTaskId) {
  const root = rootTaskGraphs.get(rootTaskId);
  return !!(root?.children?.size);
}

export function clearTaskRoot(rootTaskId) {
  if (!rootTaskId) return false;
  return rootTaskGraphs.delete(rootTaskId);
}

/** @param {{ userId?: string, rootTaskId?: string, rootWatcherId?: string|null, status?: string, finalText?: string, finalReportPreview?: string }} [opts] */
export function deferRootCompletion({ userId, rootTaskId, rootWatcherId = null, status = 'done', finalText = '', finalReportPreview = '' } = {}) {
  const root = rootTaskGraphs.get(rootTaskId);
  if (!root?.children?.size) return false;
  if (rootWatcherId && !root.rootWatcherId) root.rootWatcherId = rootWatcherId;
  root.pendingCompletion = {
    status,
    finalText,
    finalReportPreview,
    at: Date.now(),
  };
  const names = _rootChildSnapshot(root).map(c => c.name).filter(Boolean).join(', ');
  if (root.rootWatcherId) {
    pushWatcherStatus(userId || root.userId, root.rootWatcherId, `Waiting on delegated task(s): ${names || 'child task'}`, {
      rootTaskId,
      phase: 'waiting_children',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      finalReportPreview,
      lastActivityAt: Date.now(),
    });
  }
  return true;
}

// Fire the voice completion a deferred root stashed on its pendingCompletion
// (see _onComplete's deferChip branch), exactly once, at TRUE tree completion
// — i.e. right before the pendingCompletion is consumed/the root graph is
// torn down below. `_voiceReleased` guards re-entry the same way
// `_waitHintReleased` guards the non-deferred, immediate path in _onComplete;
// the two paths are mutually exclusive per task but this keeps the invariant
// enforced even if this ever runs twice for the same pendingCompletion object
// (e.g. a duplicate final-child event racing in).
function _fireDeferredVoiceCompletion(pending) {
  if (!pending?.voiceDeviceId || pending._voiceReleased) return;
  pending._voiceReleased = true;
  const { voiceDeviceId, voiceAgentName, voiceResultText, voiceSummary, status } = pending;
  const agentLabel = voiceAgentName || 'The agent';
  import('./lib/voice-announcements.mjs')
    .then(({ enqueueVoiceAnnouncement, announcementLine }) => {
      const line = status && status !== 'done'
        ? `${agentLabel} hit a problem with the background task.`
        : announcementLine(agentLabel, voiceResultText || '', voiceSummary || '');
      enqueueVoiceAnnouncement(voiceDeviceId, line, { kind: 'background' });
    })
    .catch(() => {});
  import('./ws-handler.mjs')
    .then(m => m.noteDeviceBackgroundWork(voiceDeviceId, -1))
    .catch(() => {});
}

function _completeRootChild(taskId, rec, status, finalReportPreview) {
  if (!rec?.rootTaskId || rec.rootTaskId === taskId) return;
  const root = rootTaskGraphs.get(rec.rootTaskId);
  if (!root) return;
  const child = root.children.get(taskId);
  if (child) {
    child.status = status;
    child.currentTool = null;
    child.lastActivityAt = Date.now();
    child.finalReportPreview = finalReportPreview;
  }
  root.children.delete(taskId);
  if (!root.rootWatcherId) {
    if (root.children.size === 0 && root.pendingCompletion) {
      _fireDeferredVoiceCompletion(root.pendingCompletion);
      rootTaskGraphs.delete(rec.rootTaskId);
    }
    return;
  }
  if (root.pendingCompletion && status !== 'done') {
    root.pendingCompletion.status = status;
    root.pendingCompletion.finalText = finalReportPreview || `${rec.agentName || 'Child task'} ${status}`;
    root.pendingCompletion.finalReportPreview = finalReportPreview;
  }

  if (root.children.size > 0) {
    const names = _rootChildSnapshot(root).map(c => c.name).filter(Boolean).join(', ');
    pushWatcherStatus(rec.userId, root.rootWatcherId, `${rec.agentName || 'Agent'} finished; waiting on ${names || 'remaining child task(s)'}`, {
      rootTaskId: rec.rootTaskId,
      phase: 'waiting_children',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      lastActivityAt: Date.now(),
    });
    return;
  }

  if (root.pendingCompletion) {
    const finalStatus = root.pendingCompletion.status || 'done';
    const finalText = root.pendingCompletion.finalText || (finalStatus === 'done'
      ? '✓ Delegated task tree done'
      : `Delegated task tree ${finalStatus}`);
    pushWatcherStatus(rec.userId, root.rootWatcherId, finalText, {
      rootTaskId: rec.rootTaskId,
      status: finalStatus,
      phase: finalStatus,
      childTasks: [],
      canCancel: false,
      currentTool: null,
      finalReportPreview: root.pendingCompletion.finalReportPreview || finalReportPreview,
      lastActivityAt: Date.now(),
    });
    completeWatcher(rec.userId, root.rootWatcherId, {
      status: finalStatus,
      finalText,
    });
    _fireDeferredVoiceCompletion(root.pendingCompletion);
    rootTaskGraphs.delete(rec.rootTaskId);
  }
}

function taskLabel(agentEmoji, agentName, summary) {
  const taskText = `${summary || ''}`.trim();
  return `${agentEmoji || '🤖'} ${agentName || 'Agent'}${taskText ? `: ${taskText.slice(0, 60)}${taskText.length > 60 ? '…' : ''}` : ''}`;
}

function taskState(taskId, extra = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec) return null;
  return {
    taskId,
    rootTaskId: rec.rootTaskId || taskId,
    parentTaskId: rec.parentTaskId || null,
    parentWatcherId: rec.parentWatcherId || null,
    rootWatcherId: rec.rootWatcherId || rec.watcherId || null,
    spanId: rec.spanId || null,
    visibleAgentId: rec.visibleAgentId || rec.coordinatorAgentId || null,
    aliases: rec.aliases || [],
    status: rec.status || 'running',
    targetAgentId: rec.agentId,
    targetAgentName: rec.agentName,
    targetAgentEmoji: rec.agentEmoji,
    summary: rec.summary || '',
    startedAt: rec.startedAt,
    lastActivityAt: Date.now(),
    toolsUsed: rec.toolsUsed || 0,
    currentTool: rec.currentTool || null,
    phase: rec.phase || 'running',
    ownerKey: rec.ownerKey || null,
    isWorker: !!rec.isWorker,
    continuation: rec.autoContinue ? { enabled: true, parentAgentId: rec.coordinatorAgentId || null } : null,
    canCancel: typeof rec.abort === 'function' && rec.status !== 'cancelling',
    cancelling: rec.status === 'cancelling',
    ...extra,
  };
}

function pushTaskProgress(taskId, text, extra = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec?.watcherId || !text) return false;
  rec.lastActivityAt = Date.now();
  rec.phase = extra.phase || rec.phase || 'running';
  const pushed = pushWatcherStatus(rec.userId, rec.watcherId, text, taskState(taskId, extra));
  _updateRootChildProgress({ ...rec, taskId }, { status: extra.phase || rec.phase || 'running' });
  return pushed;
}

function trackToolEvent(events, ev, agentId = null) {
  if (!Array.isArray(events) || !ev?.name) return;
  if (ev.type === 'tool_call') {
    events.push({
      name: ev.name,
      args: ev.args || null,
      startedAt: Date.now(),
      status: 'running',
      agentId: ev.agentId || agentId || null,
    });
    return;
  }
  const rec = [...events].reverse().find(e => e.name === ev.name && e.status !== 'done');
  if (ev.type === 'tool_progress' && rec) {
    rec.progressPreview = String(ev.text || '').slice(-1000);
    return;
  }
  // Provider-hosted web search never emits a local tool_call — only a transient
  // tool_progress with no preceding record (openai-responses.mjs). Without a
  // synthetic record here the recipe learner never sees web_search on
  // native-search models, so learned recipes chronically omit the agent's only
  // path to the web. web_search ONLY — other hosted progress (image_generation)
  // must not fabricate recipe entries.
  if (ev.type === 'tool_progress' && ev.name === 'web_search' && !rec) {
    const aid = ev.agentId || agentId || null;
    if (!events.some(e => e.name === 'web_search' && e.native && e.agentId === aid)) {
      events.push({
        name: 'web_search', args: null, startedAt: Date.now(), endedAt: Date.now(),
        durationMs: 0, status: 'done', native: true, agentId: aid,
        preview: 'provider-hosted web search',
      });
    }
    return;
  }
  if (ev.type === 'tool_result') {
    const target = rec || { name: ev.name, args: null, startedAt: Date.now(), status: 'running' };
    if (!rec) events.push(target);
    target.endedAt = Date.now();
    target.durationMs = target.endedAt - target.startedAt;
    target.status = 'done';
    target.preview = ev.preview || String(ev.text || '').split('\n').find(l => l.trim()) || '';
    target.text = String(ev.text || '').slice(0, 10000);
  }
}

function reportImageFromEvent(ev) {
  if (ev?.type !== 'image' || !ev.filename) return null;
  const out = {
    filename: ev.filename,
    mimeType: ev.mimeType || ev.mediaType || 'image/png',
  };
  if (ev.savedPath) out.savedPath = ev.savedPath;
  if (ev.base64) out.base64 = ev.base64;
  return out;
}

function imageMimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function reportImagesFromText(userId, text) {
  if (!userId || !text) return [];
  const userImageDir = path.join(USERS_DIR, userId, 'images');
  const userImageDirResolved = path.resolve(userImageDir);
  const out = [];
  const re = /\[Image:\s*([^\]\r\n]+)\](?:[ \t]*(?:\r?\n|[ \t]+)[ \t]*Saved to:\s*([^\r\n]+))?/gi;
  for (const match of String(text).matchAll(re)) {
    const filename = path.basename(String(match[1] || '').trim());
    if (!filename) continue;
    const expectedPath = path.join(userImageDir, filename);
    if (!fs.existsSync(expectedPath)) continue;
    const savedRaw = String(match[2] || '').trim();
    let savedPath = expectedPath;
    if (savedRaw && path.basename(savedRaw) === filename) {
      const resolved = path.resolve(savedRaw);
      if (resolved === expectedPath || resolved.startsWith(`${userImageDirResolved}${path.sep}`)) {
        savedPath = savedRaw;
      }
    }
    out.push({ filename, mimeType: imageMimeFromFilename(filename), savedPath });
  }
  return out;
}

function mergeReportImages(images) {
  const out = [];
  const seen = new Set();
  for (const image of Array.isArray(images) ? images : []) {
    if (!image) continue;
    const key = image.filename || image.savedPath || image.base64?.slice?.(0, 64);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(image);
  }
  return out;
}

export function persistedReportImage(img) {
  if (!img?.filename && !img?.base64) return null;
  const out = {
    ...(img.filename ? { filename: img.filename } : {}),
    mimeType: img.mimeType || img.mediaType || 'image/png',
    ...(img.savedPath ? { savedPath: img.savedPath } : {}),
  };
  // Avoid bloating durable session rows when the generated file already has a
  // stable saved filename/path. For transient image-only payloads, base64 is
  // the only renderable copy, so keep it.
  if (img.base64 && !img.savedPath && !img.filename) out.base64 = img.base64;
  return out;
}

// Doc ids PRODUCED by a pipeline stage — from doc-PRODUCING tools only.
// Deliberately NOT a generic id regex over every tool result: list_research /
// list_profile_files output OLD doc ids, and harvesting those would whitelist
// exactly the stale documents the handoff guard exists to block.
const DOC_PRODUCING_TOOLS = new Set(['save_research', 'update_research', 'deep_research_parallel']);
function extractProducedBodyDocIds(ev) {
  if (ev?.type !== 'tool_result' || !DOC_PRODUCING_TOOLS.has(ev.name)) return [];
  const text = String(ev.text || '');
  const ids = new Set();
  if (ev.name === 'save_research' || ev.name === 'update_research') {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.id) ids.add(`research:${parsed.id}`);
    } catch { /* not JSON — fall through to the pattern below */ }
  }
  // deep_research_parallel: "… synthesized into document doc_xxxxxxxx."
  for (const m of text.matchAll(/\bdocument\s+(doc_[a-f0-9]{6,})\b/ig)) ids.add(`research:${m[1]}`);
  return [...ids];
}

// Only the doc-handoff phrasings — NOT generic "email the briefing", which
// legitimately emails the handed-off TEXT with no document involved.
function handoffExpectsProducedDoc(directive = '') {
  return /\bbody_doc_id\b|\b(?:saved|produced|generated) document\b|\bsaves?d?\b.{0,40}\bas a document\b|\bdocument (?:it|she|he|they) (?:saved|produced)\b/i
    .test(String(directive));
}

// Real email intent only — deliberately NOT generic "send", which would catch
// Telegram, push notifications, "send to calendar", etc. Used to arm the
// body-doc handoff guard and to decide whether a failed scheduled run owes the
// user a failure email.
function impliesEmailDelivery(text = '') {
  return /\b(?:e-?mail\w*|mail(?:ed|ing)?|body_doc_id|email_compose|email_user)\b/i.test(String(text));
}

// A scheduled run whose whole point was emailing the user must not fail
// SILENTLY — the user reads "no email arrived" as "my install is down". This
// is a deterministic system notice from the failure path; never model-written
// content, never a stale document substitute. One notice per scheduled task
// per day.
const _failureEmailSentKeys = new Set();
async function sendScheduledFailureEmail({ userId, taskId, originScheduledTaskId, pipeName, originalTask, reason }) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${originScheduledTaskId || taskId}:${day}`;
  if (_failureEmailSentKeys.has(key)) return;
  _failureEmailSentKeys.add(key);
  const subject = `Scheduled task failed - ${day}`;
  const body = [
    'OpenEnsemble ran a scheduled task, but the run failed before the requested email could be produced.',
    '',
    `Task: ${String(originalTask || '(unknown)').slice(0, 300)}`,
    `Pipeline: ${pipeName}`,
    `Task ID: ${taskId}`,
    `Reason: ${String(reason || 'unknown').slice(0, 500)}`,
    '',
    'No older saved document or stale content was substituted.',
    'OpenEnsemble itself is running — this was a task failure, not an installation outage.',
  ].join('\n');
  try {
    const mod = await import('./skills/email-send/execute.mjs');
    const res = await mod.default('email_user', { subject, body }, userId);
    console.log('[background-tasks] scheduled failure notice emailed:', String(res).slice(0, 120));
  } catch (e) {
    console.warn('[background-tasks] scheduled failure email failed:', e.message);
  }
}

// Safety net: if a worker hangs forever (stuck upstream stream, etc.) the task
// would stay in activeTasks forever. Sweep every hour, reap anything older
// than 24h so /health + UI don't accumulate ghosts.
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [taskId, info] of activeTasks) {
    if (info.startedAt && (now - info.startedAt) > TASK_TTL_MS) {
      console.warn('[background-tasks] Reaping stale task:', taskId, 'agent:', info.agentName);
      activeTasks.delete(taskId);
      _journalRemove(taskId);
    }
  }
}, 60 * 60 * 1000).unref();

/**
 * Fire a background agent task. Returns a taskId immediately.
 * @param {object} scopedAgent - agent object with scoped id
 * @param {string} task - enriched task text
 * @param {string} userId
 * @param {string} coordinatorAgentId - scoped id of the coordinator
 * @param {string} agentName - display name for notifications
 * @param {string} agentEmoji - emoji icon (e.g. "📧")
 * @param {{autoContinue?: boolean, extraSystemNote?: string | null, routeText?: string | null}} [opts]
 */
export function dispatchBackground(scopedAgent, task, userId, coordinatorAgentId, agentName, agentEmoji = '🤖', opts = {}) {
  const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // opts.summary lets the caller keep server-authored task suffixes (e.g. the
  // pipeline insulation note) out of the user-visible chip label.
  const summary = (opts?.summary || task || '').slice(0, 120);
  const ac = new AbortController();
  const scheduledCtx = getScheduledContext();
  // Coordinator-declared forward pipeline (produce → hand off → consume): both
  // stages run inside this ONE background task — one chip, one journal entry,
  // one AbortController covering the whole chain. `handoff.agent` is the real
  // (unscoped) second-stage agent record, resolved by the delegate skill.
  const handoff = (opts?.handoff && opts.handoff.agent) ? opts.handoff : null;
  const pipeName = handoff ? `${agentName} → ${handoff.name || handoff.agent.name || 'Agent'}` : agentName;
  const rootTaskId = opts?.rootTaskId || taskId;
  const parentTaskId = opts?.parentTaskId || null;
  const parentWatcherId = opts?.parentWatcherId || null;
  const visibleAgentId = opts?.visibleAgentId || coordinatorAgentId;
  const rootWatcherId = opts?.rootWatcherId || (rootTaskId === taskId ? null : parentWatcherId);
  const spanId = opts?.spanId || `${rootTaskId}:${_slug(agentName)}:${taskId}`;
  activeTasks.set(taskId, {
    agentId: scopedAgent.id, userId, agentName: pipeName, agentEmoji,
    startedAt: Date.now(), summary, phase: 'queued', status: 'running',
    originalTask: task,
    coordinatorAgentId,
    visibleAgentId,
    rootTaskId,
    parentTaskId,
    parentWatcherId,
    rootWatcherId,
    spanId,
    aliases: [taskId, scopedAgent.id].filter(Boolean),
    // Mark this as a coordinator→specialist DELEGATION (distinct from a worker
    // and from a research ephemeral). This is what lets check_workers surface it
    // as user-level background work — so "is the specialist still working?" resolves no
    // matter which agent the user happens to ask. See listActiveDelegationsForUser.
    isDelegation: true,
    abort: () => ac.abort(),
    autoContinue: opts?.autoContinue === true,
    originScheduledTaskId: opts?.originScheduledTaskId || scheduledCtx?.originTaskId || null,
    originScheduledTaskOwnerId: opts?.originScheduledTaskOwnerId || scheduledCtx?.originTaskOwnerId || userId || null,
    originScheduledTaskAgent: opts?.originScheduledTaskAgent || scheduledCtx?.originTaskAgent || null,
    originScheduledRunId: scheduledCtx?.runId || null, // barrier per-fire nonce — completion must rejoin the SAME fire's group
    originScheduledNote: scheduledCtx?.scheduledNote || null,
    ...(_voiceOrigin()),
  });
  // Voice-origin work lights the device's WAITING ring for the duration —
  // paired decrement in _onComplete (every terminal path funnels through it).
  {
    const rec = activeTasks.get(taskId);
    if (rec?.voiceDeviceId) {
      import('./ws-handler.mjs')
        .then(m => m.noteDeviceBackgroundWork(rec.voiceDeviceId, +1))
        .catch(() => {});
    }
  }
  if (scheduledCtx?.originTaskId) {
    registerScheduledChild({
      userId,
      scheduledCtx,
      childId: taskId,
      label: `${agentName || 'Agent'}: ${summary}`,
      kind: 'delegate',
    });
  }

  // Phase 14: register a task_proxy watcher so the task surfaces as a chat
  // chip + becomes inspectable via list_watches. The watcher's history
  // accumulates progress events; on completion completeWatcher transitions
  // it to done/error. The activeTasks record gets the watcherId so progress
  // callbacks can update the same watcher.
  let watcherId = null;
  try {
    watcherId = registerWatcher({
      userId,
      agentId: visibleAgentId,       // chip lives in the user's visible chat
      kind: 'task_proxy',
      label: taskLabel(agentEmoji, pipeName, summary),
      state: taskState(taskId, { phase: 'queued' }),
      cadenceSec: 30,
      expiresAt: null,   // indefinite — task runs as long as it takes
      // No skillId: system-handler (registered via _systemHandlers in watchers.mjs)
    });
    const rec = activeTasks.get(taskId);
    if (rec) {
      rec.watcherId = watcherId;
      rec.rootWatcherId = rec.rootWatcherId || watcherId;
      rec.aliases = [...new Set([...(rec.aliases || []), watcherId, rec.rootWatcherId, rec.parentWatcherId].filter(Boolean))];
      if (rec.rootTaskId === taskId) {
        registerTaskRoot({ userId, rootTaskId: rec.rootTaskId, rootWatcherId: watcherId, visibleAgentId, summary });
      } else {
        _attachRootChild(taskId, rec);
      }
    }
    pushTaskProgress(taskId, `Delegated to ${agentName}: ${summary}`, { phase: 'queued' });
  } catch (e) {
    console.warn('[background-tasks] task_proxy watcher registration failed:', e.message);
  }
  _journalAdd(taskId);

  // Fire and forget — do not await
  (async () => {
    // Honor accessSchedule: a user whose curfew started mid-conversation cannot
    // launch new delegations. The coordinator will see the decline in its session.
    const { isUserTimeBlocked } = await import('./routes/_helpers.mjs');
    if (isUserTimeBlocked(userId)) {
      await _onComplete(taskId, userId, coordinatorAgentId, pipeName, agentEmoji, null,
        'Access is restricted at this time — delegation refused.');
      return;
    }
    // Declared out here (not inside the try) so the catch below can read it for
    // the scheduled-failure email without a ReferenceError. Stays null if the
    // turn throws before it's assigned.
    let scheduledNote = null;
    try {
      const { streamChat } = await import('./chat.mjs');
      const { getScheduledNote } = await import('./lib/scheduled-context.mjs');
      // ALS propagates through this detached IIFE because dispatchBackground
      // was called from within scheduledContext.run(...). null in non-scheduled chats.
      scheduledNote = getScheduledNote();
      const combinedNote = [scheduledNote, opts?.extraSystemNote].filter(Boolean).join('\n\n') || null;
      let toolsUsed = 0;
      let currentTool = null;
      const toolEvents = [];
      // Phase-14b: wrap the streamChat loop in a task_proxy context so
      // ask_user_via_task (called inside the agent's tool chain) can find
      // this run's watcherId without any extra parameter threading.
      const rec = activeTasks.get(taskId);
      const taskCtx = {
        taskId,
        watcherId,
        userId,
        agentId: scopedAgent.id,
        rootTaskId: rec?.rootTaskId || taskId,
        parentTaskId: rec?.parentTaskId || null,
        parentWatcherId: rec?.parentWatcherId || null,
        rootWatcherId: rec?.rootWatcherId || watcherId,
        visibleAgentId: rec?.visibleAgentId || visibleAgentId,
        spanId: rec?.spanId || taskId,
      };
      // Streams ONE agent's work into this task's chip/progress state and
      // returns its reply text + any media artifacts it produced. Runs once
      // for a plain delegation, twice for a forward pipeline.
      const runBgStage = async (stageAgent, stageTask, stageName, stageNote, stageRoute, stagePlan) => {
        let text = '';
        const artifacts = [];
        const images = [];
        const bodyDocIds = [];
        for await (const ev of streamChat(stageAgent, stageTask, ac.signal, null, userId, null, stageNote, false, null, { toolPlan: stagePlan, routeText: stageRoute, isolatedTaskRun: true, rootTaskId: taskCtx.rootTaskId, traceSource: scheduledNote ? 'scheduled' : 'background' })) {
          if (ev.type === 'token') text += ev.text;
          // Tag with the stage agent so completion-time recipe learning can
          // attribute per stage — a forward pipeline shares this ONE array
          // across both stages, and learning a downstream agent's calls into
          // an upstream agent's recipe causes future routing mistakes.
          trackToolEvent(toolEvents, ev, stageAgent.id);
          // Track in-flight tool calls so list_active_agents can report e.g.
          // "the coder is currently running coder_edit_file" instead of just
          // an opaque spinner.
          if (ev.type === 'tool_call' && ev.name) {
            toolsUsed++;
            currentTool = ev.name;
            const r = activeTasks.get(taskId);
            if (r) {
              r.toolsUsed = toolsUsed;
              r.currentTool = ev.name;
              r.lastUpdateAt = Date.now();
            }
            // Rolling progress log so check_workers can replay what this delegation
            // has actually done (same surface workers use).
            pushWorkerProgress(taskId, { kind: 'tool', tool: ev.name });
            // Push to the watcher chip — the chip is the user-visible surface.
            // History accumulates each tool call so list_watches/get_task_log
            // can replay what happened.
            if (r?.watcherId) {
              pushTaskProgress(taskId, `${stageName} is using ${ev.name}`, { currentTool: ev.name, toolsUsed, phase: 'tool' });
            }
          }
          if (ev.type === 'tool_progress' && ev.text) {
            pushTaskProgress(taskId, String(ev.text).slice(-1200), {
              currentTool,
              toolsUsed,
              phase: 'streaming',
            });
          }
          if (ev.type === 'tool_result' && ev.name) {
            for (const id of extractProducedBodyDocIds(ev)) bodyDocIds.push(id);
            const r = activeTasks.get(taskId);
            const preview = String(ev.text || '').split('\n').find(l => l.trim()) || '';
            currentTool = null;
            if (r) {
              r.currentTool = null;
              r.lastResultPreview = preview.slice(0, 160);
              r.lastUpdateAt = Date.now();
            }
            // First non-empty result line usually carries the domain number
            // ("Event created…", "56 events added") — keep it for status reports.
            pushWorkerProgress(taskId, { kind: 'result', tool: ev.name, text: preview.slice(0, 160) });
            if (preview) {
              pushTaskProgress(taskId, `${ev.name}: ${preview.slice(0, 240)}`, { currentTool: null, phase: 'result' });
            }
          }
          // Capture produced files so a handoff stage can attach them — the id
          // format matches list_profile_files / attachment_doc_ids.
          if ((ev.type === 'image' || ev.type === 'video' || ev.type === 'audio') && ev.filename) {
            const folder = ev.type === 'image' ? 'images' : ev.type === 'video' ? 'videos' : 'audio';
            artifacts.push(`${folder}:${ev.filename}`);
            const image = reportImageFromEvent(ev);
            if (image) images.push(image);
            pushWorkerProgress(taskId, { kind: 'result', tool: ev.type, text: `produced ${ev.filename}` });
            pushTaskProgress(taskId, `${stageName} produced ${ev.filename}`, { currentTool: null, phase: 'result' });
          }
          if (ev.type === 'error') throw new Error(ev.message);
        }
        // An abort can end the provider stream without an error event — don't
        // let a cancelled run masquerade as a completed one (or start stage 2).
        if (ac.signal.aborted) throw new Error('cancelled');
        return { text, artifacts, images, bodyDocIds: [...new Set(bodyDocIds)] };
      };

      const routeText = (typeof opts?.routeText === 'string' && opts.routeText.trim()) ? opts.routeText.trim() : task;
      const rememberedPlan = matchToolPlan(userId, { agentId: scopedAgent.id, phrase: routeText });
      pushTaskProgress(taskId, `${agentName} started working`, { phase: 'running' });
      let finalText = '';
      const reportImages = [];
      await runInTaskContext(taskCtx, async () => {
        const stage1 = await runBgStage(scopedAgent, task, agentName, combinedNote, routeText, rememberedPlan);
        finalText = stage1.text;
        if (stage1.images?.length) reportImages.push(...stage1.images);
        if (handoff) {
          const stage2Name = handoff.name || handoff.agent.name || 'Agent';
          pushTaskProgress(taskId, `✓ ${agentName} finished — handing off to ${stage2Name}`, { phase: 'handoff', currentTool: null });
          const artifactNote = stage1.artifacts.length
            ? `\n\nFILES PRODUCED BY ${agentName} — attach these EXACT ids via attachment_doc_ids (do not rename them and do not look them up again): ${JSON.stringify(stage1.artifacts)}`
            : '';
          // Pipeline-bound doc handoff: stage 2 may only email documents stage 1
          // actually produced THIS run. If the directive promised a produced
          // document and there is none, fail closed — never let the consumer
          // stage hunt old files and mail a stale doc as a substitute
          // (2026-07-02 daily-briefing failure). resolveBodyDoc enforces
          // allowedBodyDocIds deterministically; the note below is just steering.
          const producedDocIds = stage1.bodyDocIds || [];
          if (handoffExpectsProducedDoc(handoff.directive) && !producedDocIds.length) {
            throw new Error(`${agentName} did not produce a saved document this run, so the ${stage2Name} handoff was stopped instead of emailing an older file.`);
          }
          // Arm the guard for ANY email handoff — including with an EMPTY
          // allowlist when nothing was produced. Otherwise a text-based email
          // handoff leaves body_doc_id unguarded and the consumer can still
          // substitute an old file; with the guard armed it must inline the
          // handed-off text via `body` instead (the resolver error says so).
          if (producedDocIds.length || impliesEmailDelivery(handoff.directive)) {
            taskCtx.allowedBodyDocIds = producedDocIds;
          }
          const bodyDocNote = producedDocIds.length
            ? `\n\nDOCUMENT HANDOFF — for body_doc_id use ONLY one of these exact ids (produced this run): ${JSON.stringify(producedDocIds)}. Do not call list_profile_files or list_research to find a substitute.`
            : '';
          const stage2Task = `${handoff.directive || 'Continue this task using the result below.'}\n\n[Result from ${agentName}]:\n${stage1.text.trim() || '(no text reply)'}${artifactNote}${bodyDocNote}`;
          const deleg2Id = `ephemeral_deleg_d${handoff.depth || 1}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${handoff.agent.id}`;
          const scoped2 = { ...handoff.agent, id: deleg2Id, ephemeral: true };
          scoped2.systemPrompt = `${handoff.agent.systemPrompt}\n\n## Current Date\nToday: ${new Date().toISOString().slice(0, 10)}`;
          try {
            const { buildContextHints } = await import('./lib/context-resolvers.mjs');
            const { hints } = await buildContextHints(userId, stage2Task);
            if (hints) scoped2.systemPrompt += `\n\n## Pre-resolved references\n${hints}`;
          } catch { /* best-effort */ }
          try {
            const { initSession } = await import('./lib/ephemeral-tool-cache.mjs');
            initSession(deleg2Id, stage2Task);
          } catch { /* best-effort */ }
          const r = activeTasks.get(taskId);
          // Alias the stage-2 ephemeral session onto this task so check_workers
          // called from INSIDE stage 2 doesn't list the agent's own pipeline.
          if (r) r.aliases = [...new Set([...(r.aliases || []), deleg2Id])];
          const terminalNote = `[HANDOFF — FINAL STEP] You are the last step of a pipeline the coordinator set up. Act now with your tools — do NOT show a draft and wait, the coordinator already authorized this whole chain. Your reply is delivered to the user verbatim as the final word on this task, so make it a clean, complete summary of what you did.`;
          const stage2Note = [scheduledNote, terminalNote].filter(Boolean).join('\n\n');
          const stage2 = await runBgStage(scoped2, stage2Task, stage2Name, stage2Note, handoff.directive || undefined, null);
          finalText = stage2.text;
          if (stage2.images?.length) reportImages.push(...stage2.images);
        }
      });
      await _onComplete(taskId, userId, coordinatorAgentId, pipeName, agentEmoji, finalText.trim() || `${pipeName} completed the task.`, null, null, toolEvents, scopedAgent.id, task, { images: reportImages });
    } catch (err) {
      console.error('[background-tasks] error in task', taskId, err.message);
      const failMsg = ac.signal.aborted ? 'Task cancelled by user.' : err.message;
      // Scheduled run that was supposed to end in an email → deterministic
      // failure notice so the user knows OE is alive and the run failed.
      if (!ac.signal.aborted && scheduledNote
          && impliesEmailDelivery(`${handoff?.directive || ''} ${task || ''}`)) {
        await sendScheduledFailureEmail({
          userId, taskId,
          originScheduledTaskId: activeTasks.get(taskId)?.originScheduledTaskId,
          pipeName, originalTask: task, reason: failMsg,
        });
      }
      await _onComplete(taskId, userId, coordinatorAgentId, pipeName, agentEmoji, null,
        failMsg,
        ac.signal.aborted ? 'cancelled' : 'error');
    }
  })();

  return taskId;
}

function _coordinatorAgentIdFromSessionKey(sessionKey, userId) {
  const raw = String(sessionKey || '');
  const prefix = `${userId}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

async function _runContinuation({ taskId, userId, coordinatorAgentId, targetAgentId, agentName, result, errorMsg, originalTask, scheduledCtx = null }) {
  if (errorMsg || !result) return;
  const agentId = _coordinatorAgentIdFromSessionKey(coordinatorAgentId, userId);
  if (!agentId) return;
  const prompt = [
    'A background delegation you started has completed. Continue the original user workflow for THIS completed task only. The task id and original_task below are authoritative; do not infer from the latest visible chat message.',
    '',
    `<background_task id="${taskId}" agent="${agentName}" target_agent_id="${targetAgentId || ''}">`,
    `<original_task>${originalTask || ''}</original_task>`,
    `<result>${result}</result>`,
    '</background_task>',
    '',
    'If the original user request required a next step using this result, do it now. For example, if the task returned a briefing so it could be emailed, delegate to the email agent with this exact briefing. If there is no remaining action, give the user a concise completion update. Do not act on any other background task.',
  ].join('\n');
  const { handleChatMessage } = await import('./chat-dispatch.mjs');
  const { sendToUser } = await import('./ws-handler.mjs');
  const run = () => handleChatMessage({
    userId,
    agentId,
    text: prompt,
    attachment: null,
    source: 'web',
    onEvent: (e) => sendToUser(userId, e),
    onBroadcast: () => {},
    onNotify: () => {},
    _hiddenUser: true,
    _isBackgroundContinuation: true,
    _isolatedTaskRun: !!scheduledCtx?.originTaskId,
  });
  if (scheduledCtx?.originTaskId) {
    const { scheduledContext } = await import('./lib/scheduled-context.mjs');
    await scheduledContext.run(scheduledCtx, run);
  } else {
    await run();
  }
}

async function _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, result, errorMsg = null, finalStatus = null, toolEvents = [], targetAgentId = null, originalTask = '', media = null) {
  const rec = activeTasks.get(taskId);
  const status = finalStatus || (errorMsg ? 'error' : 'done');
  const finalReportPreview = String(errorMsg ?? result ?? '').slice(0, 800);
  // Best-effort — this must never block core finalization below (activeTasks
  // cleanup, journal removal, watcher completion). A throw here used to leak
  // the whole task: chip stuck "running", journal entry surviving into the
  // next boot as a false "interrupted by restart", and (for voice-origin
  // tasks) the WAITING-ring hold never released.
  let reportImages = [];
  let persistedImages = [];
  try {
    reportImages = mergeReportImages([
      ...(Array.isArray(media?.images) ? media.images.filter(Boolean) : []),
      ...reportImagesFromText(userId, result),
    ]);
    persistedImages = reportImages.map(persistedReportImage).filter(Boolean);
  } catch (e) {
    console.warn('[background-tasks] report-image extraction failed, continuing with no images:', e.message);
  }
  if (rec) {
    rec.status = status;
    rec.phase = status;
    rec.currentTool = null;
  }
  // When this root delegation finishes but still has child delegations in
  // flight, deliver its result NOW (report + broadcast + continuation, below)
  // and keep only the CHIP alive in a "waiting on children" state — it
  // finalizes from _completeRootChild once the last child drains. This used to
  // early-return here, which silently dropped the root's agent_report AND its
  // autoContinue wake, stranding the coordinator. Only the visual chip waits;
  // the result and the coordinator's reaction must not.
  const deferChip = rec?.rootTaskId === taskId && hasActiveTaskChildren(taskId) && !rec?.originScheduledTaskId;
  if (deferChip) {
    deferRootCompletion({
      userId,
      rootTaskId: taskId,
      rootWatcherId: rec.rootWatcherId || rec.watcherId || null,
      status,
      finalText: status === 'done' ? `✓ ${agentName} done` : finalReportPreview,
      finalReportPreview,
    });
    // Voice-origin root: ITS turn is done but the task tree is still running
    // (children in flight). Announcing "done" and releasing the WAITING ring
    // now (below, at ~voice block) would go dark and speak the result while
    // the tree keeps working, then say nothing when it actually finishes
    // (07-04 field bug). Hand both off onto the root graph's pendingCompletion
    // instead — _completeRootChild fires them exactly once, when the whole
    // tree actually drains. Flip _waitHintReleased here too so a late/duplicate
    // _onComplete for this same task can never independently announce/release
    // again (same guard the non-deferred path below uses).
    if (rec.voiceDeviceId && !rec._waitHintReleased) {
      rec._waitHintReleased = true;
      const root = rootTaskGraphs.get(taskId);
      if (root?.pendingCompletion) {
        root.pendingCompletion.voiceDeviceId = rec.voiceDeviceId;
        root.pendingCompletion.voiceAgentName = agentName;
        root.pendingCompletion.voiceResultText = errorMsg ? '' : (result || '');
        root.pendingCompletion.voiceSummary = rec.summary || '';
      }
    }
  }
  // Retire a finished delegation into the recent ring so check_workers can still
  // show its terminal outcome briefly. (Workers are retired separately via
  // _retire from spawnWorker; this is the delegation analogue.)
  if (rec?.isDelegation) {
    const delegOutcome = status === 'done' ? 'done' : (status === 'cancelled' ? 'stopped' : 'error');
    recentDelegations.unshift({
      taskId, userId: rec.userId, agentId: rec.agentId,
      rootTaskId: rec.rootTaskId || taskId,
      parentTaskId: rec.parentTaskId || null,
      spanId: rec.spanId || null,
      watcherId: rec.watcherId || null,
      rootWatcherId: rec.rootWatcherId || null,
      visibleAgentId: rec.visibleAgentId || null,
      name: rec.agentName, summary: rec.summary,
      outcome: delegOutcome,
      finalText: finalReportPreview.slice(0, 240),
      toolsUsed: rec.toolsUsed || 0,
      startedAt: rec.startedAt, endedAt: Date.now(),
    });
    if (recentDelegations.length > RECENT_CAP) recentDelegations.length = RECENT_CAP;
    // Durable mirror (7d JSONL) so this terminal outcome survives a restart
    // and ring eviction by another busy user — fire-and-forget, must never
    // affect the ring push or anything below it. appendTaskOutcome already
    // try/catches internally; the .catch() here is belt-and-suspenders.
    appendTaskOutcome(rec.userId, {
      taskId, kind: 'delegation', agentId: rec.agentId,
      agentName: rec.agentName, status: delegOutcome,
      summary: finalReportPreview || rec.summary,
      durationMs: Date.now() - (rec.startedAt || Date.now()),
      error: errorMsg || null,
    }).catch(e => console.warn('[background-tasks] delegation task-outcome append failed:', e.message));
  }
  _completeRootChild(taskId, rec, status, finalReportPreview);
  activeTasks.delete(taskId);
  _journalRemove(taskId);
  // When deferring the chip, keep the root graph (it holds pendingCompletion +
  // the child set) so the last child can finalize the chip via _completeRootChild.
  if (rec?.rootTaskId === taskId && !deferChip) clearTaskRoot(taskId);

  // Phase 14: finalize the task_proxy watcher (chip) so it shows done/error
  // and slides into the "recent" pile. Lives independently of the activity-
  // panel broadcast below — the chip is the user's primary visible surface.
  // Skip when deferChip: the chip stays in "waiting on children" (set by
  // deferRootCompletion above) and finalizes from _completeRootChild instead.
  if (rec?.watcherId && !deferChip) {
    try {
      const finalText = status === 'cancelled'
        ? `■ ${agentName} cancelled`
        : errorMsg
          ? `⚠ ${agentName} failed: ${errorMsg}`
          : `✓ ${agentName} done`;
      pushWatcherStatus(userId, rec.watcherId, finalText, {
        taskId,
        status,
        phase: status,
        canCancel: false,
        cancelling: false,
        currentTool: null,
        lastActivityAt: Date.now(),
        finalReportPreview,
      });
      completeWatcher(userId, rec.watcherId, {
        status,
        finalText,
      });
    } catch (e) {
      console.warn('[background-tasks] watcher complete failed:', e.message);
    }
  }

  const content = errorMsg ?? result;

  if (!errorMsg && Array.isArray(toolEvents) && toolEvents.length) {
    try {
      // Learn ONLY from the target agent's own tool calls. A forward pipeline
      // accumulates both stages into one toolEvents array; banking stage-2's
      // calls into the upstream agent's recipe poisons the
      // recipe for every future match. Untagged events (legacy shape) pass
      // through so plain delegations keep learning as before.
      const learnAgentId = targetAgentId || rec?.agentId;
      const ownEvents = toolEvents.filter(e => !e?.agentId || e.agentId === learnAgentId);
      const learned = learnToolPlanFromToolEvents(userId, {
        agentId: learnAgentId,
        phrase: originalTask || rec?.originalTask || rec?.summary || '',
        toolEvents: ownEvents,
        // The completion text. A non-exception failure ("I hit a tooling
        // limitation…", "handed it to…") reads as success to !errorMsg, so scan
        // the result so those runs aren't memorized as recipes.
        resultText: result || '',
        source: rec?.isWorker ? 'auto-worker-complete' : 'auto-background-complete',
      }).filter(r => r?.learned);
      if (learned.length) {
        console.log('[tool-plan] learned from background completion:', learned.map(r => `${r.recipe?.id}:${(r.recipe?.selectedTools || []).join(',')}`).join(' | '));
      }
    } catch (e) {
      console.warn('[tool-plan] background learning failed:', e.message);
    }
  }

  // 1. Inject into coordinator's session so it has context on next user message.
  //    Include the original task summary so the user (and the LLM on its next
  //    turn) can see WHICH task the specialist is replying to — important when
  //    multiple background tasks are in flight at once.
  try {
    const { appendToSession } = await import('./sessions.mjs');
    const reportAgentId = rec?.visibleAgentId || coordinatorAgentId;
    const taskSummary = rec?.summary || '';
    const taskRef = taskSummary
      ? ` — re: "${taskSummary.length > 80 ? taskSummary.slice(0, 80) + '…' : taskSummary}"`
      : '';
    const notice = errorMsg
      ? `[${agentName} ran into a problem${taskRef}]\n${errorMsg}`
      : `[${agentName} replied${taskRef}]\n${result}`;
    const reportTs = Date.now();
    const reportId = rec?.spanId || taskId;
    // Keep role:'assistant' so the LLM reads this as part of the
    // conversation on its next turn (it needs to know what the specialist
    // reported back). Add kind:'agent_report' so the browser knows to
    // render it with the fancier sender-tagged bubble on reload — same
    // visual as the live broadcast that fires immediately on completion.
    await appendToSession(reportAgentId, {
      role: 'assistant',
      kind: 'agent_report',
      reportId,
      agentName, agentEmoji,
      content: notice,
      displayContent: content,
      toolEvents,
      ...(persistedImages.length ? { images: persistedImages } : {}),
      targetAgentId: targetAgentId || rec?.agentId || null,
      originalTask: originalTask || rec?.summary || '',
      taskId,
      rootTaskId: rec?.rootTaskId || taskId,
      parentTaskId: rec?.parentTaskId || null,
      watcherId: rec?.watcherId || null,
      rootWatcherId: rec?.rootWatcherId || rec?.watcherId || null,
      spanId: rec?.spanId || null,
      status,
      ts: reportTs,
    });
    // 2. Agent report card: render directly in the user's visible chat as a
    // notification from the agent. Use the same report id + timestamp as the
    // persisted row so session reloads can dedupe the live and saved copies.
    _broadcast?.({
      type:       'agent_report',
      agent:      reportAgentId,
      reportId,
      agentName,
      agentEmoji,
      content:    notice,
      displayContent: content,
      toolEvents,
      ...(reportImages.length ? { images: reportImages } : {}),
      targetAgentId: targetAgentId || rec?.agentId || null,
      originalTask: originalTask || rec?.summary || '',
      taskId,
      rootTaskId: rec?.rootTaskId || taskId,
      parentTaskId: rec?.parentTaskId || null,
      watcherId: rec?.watcherId || null,
      rootWatcherId: rec?.rootWatcherId || rec?.watcherId || null,
      spanId: rec?.spanId || null,
      status,
      ts: reportTs,
    });
  } catch (e) {
    console.error('[background-tasks] failed to inject session notice:', e.message);
  }

  // Speak the completion on the originating voice device (idle-gated queue;
  // ducks any ambient/AirPlay bed on fw >= 0.2.68). Errors announce too —
  // a silent failure is how work gets "lost". deferChip roots already handed
  // this off to the root graph's pendingCompletion above — _completeRootChild
  // fires it once the whole tree actually drains, not here.
  if (rec?.voiceDeviceId && !deferChip) {
    try {
      const { enqueueVoiceAnnouncement, announcementLine } = await import('./lib/voice-announcements.mjs');
      const line = errorMsg
        ? `${agentName} hit a problem with the background task.`
        : announcementLine(agentName, result, rec?.summary || '');
      enqueueVoiceAnnouncement(rec.voiceDeviceId, line, { kind: 'background' });
    } catch (e) { console.warn('[background-tasks] voice announce enqueue failed:', e.message); }
    // Release this task's WAITING-ring hold (pairs the +1 at dispatch). Flag
    // guards the rare double-_onComplete so the count can't underflow another
    // task's hold.
    if (!rec._waitHintReleased) {
      rec._waitHintReleased = true;
      import('./ws-handler.mjs')
        .then(m => m.noteDeviceBackgroundWork(rec.voiceDeviceId, -1))
        .catch(() => {});
    }
  }

  // For a scheduled run, record this delegation's completion in the barrier
  // AFTER the report has been persisted+broadcast. Otherwise the barrier's
  // reaction turn can race ahead and land in chat before the child report.
  if (rec?.originScheduledTaskId) {
    completeScheduledChild({
      userId,
      scheduledCtx: {
        originTaskId: rec.originScheduledTaskId,
        originTaskOwnerId: rec.originScheduledTaskOwnerId,
        originTaskAgent: rec.originScheduledTaskAgent,
        runId: rec.originScheduledRunId || null,
      },
      childId: taskId,
      resultText: result || `${agentName} completed the task.`,
      errorMsg,
    });
  }

  // Direct (non-scheduled) delegations get the coordinator's inline react step.
  // Scheduled runs react+finalize via the barrier (scheduler.runScheduledReaction),
  // so they skip this — otherwise the task would get a duplicate reaction turn.
  if (rec?.autoContinue && !rec?.originScheduledTaskId) {
    _runContinuation({
      taskId,
      userId,
      coordinatorAgentId,
      targetAgentId: targetAgentId || rec?.agentId || null,
      agentName,
      result,
      errorMsg,
      originalTask: rec?.originalTask || originalTask || rec?.summary || '',
    }).catch(e => console.error('[background-tasks] continuation failed:', e?.stack ?? e?.message ?? e));
  }
}

export function cancelTask(userId, id, reason = 'cancelled') {
  for (const [taskId, info] of activeTasks) {
    if (info.userId !== userId) continue;
    if (taskId !== id && info.watcherId !== id) continue;
    if (typeof info.abort !== 'function') return { ok: false, reason: 'not cancellable' };
    if (info.status === 'cancelling') return { ok: true, taskId, watcherId: info.watcherId, alreadyCancelling: true };
    info.status = 'cancelling';
    info.phase = 'cancelling';
    info.currentTool = null;
    pushTaskProgress(taskId, `Cancelling ${info.agentName || 'task'}...`, {
      status: 'cancelling',
      phase: 'cancelling',
      canCancel: false,
      cancelling: true,
      currentTool: null,
    });
    try { info.abort(reason); } catch { /* already stopping */ }
    // Cancelling a root cancels its still-running children too. Children share
    // the root's rootTaskId but have their own AbortControllers, so aborting
    // only the root would leave orphaned child delegations running (and
    // reporting) with no visible chip left to stop them from.
    // The graph may be keyed by this task's own id, by its rootTaskId, or by
    // its watcher id (auto-bg ADOPTS the sync delegation's chip as the root
    // key) — check all three or the cascade silently misses the children.
    const root = rootTaskGraphs.get(taskId)
      || (info.rootTaskId && rootTaskGraphs.get(info.rootTaskId))
      || (info.watcherId && rootTaskGraphs.get(info.watcherId))
      || null;
    if (root?.children?.size) {
      for (const childId of root.children.keys()) {
        if (childId === taskId) continue;
        const child = activeTasks.get(childId);
        if (!child || child.status === 'cancelling' || typeof child.abort !== 'function') continue;
        child.status = 'cancelling';
        child.phase = 'cancelling';
        child.currentTool = null;
        pushTaskProgress(childId, `Cancelling ${child.agentName || 'task'}...`, {
          status: 'cancelling',
          phase: 'cancelling',
          canCancel: false,
          cancelling: true,
          currentTool: null,
        });
        try { child.abort(reason); } catch { /* already stopping */ }
      }
    }
    return { ok: true, taskId, watcherId: info.watcherId };
  }
  return { ok: false, reason: 'not found' };
}

export function getActiveTasks() {
  return [...activeTasks.entries()].map(([taskId, info]) => ({ taskId, ...info }));
}

// Liveness probe for the task_proxy silence reaper (scheduler/watchers.mjs):
// a task still registered here is running, however long its current tool has
// been silent. Dynamic-imported there to avoid a static import cycle.
export function isTaskActive(taskId) {
  return activeTasks.has(taskId);
}

// ── Sync (in-turn) delegation tracking ───────────────────────────────────────
// A sync delegation streams into the caller's open turn, but it is still real
// background-shaped work: it can outlive the visible turn (the auto-bg net
// detaches it at 10s), the user may want to cancel it, and check_workers
// should see it. Registering it in the SAME activeTasks registry buys all of
// that at once: cancelTask finds it by taskId or watcherId (chip Stop button),
// listActiveDelegationsForUser lists it, the restart journal covers it, and
// it can join a root task graph like any dispatched child.
//
// The delegate skill drives the record through the returned handle. Completion
// does NOT inject an agent_report — the sync result returns inline in the
// caller's turn (or via the auto-bg drain once the turn detached).

/**
 * Complete a sync delegation: retire it to the recent ring, drop it from the
 * registry + journal, and finalize its chip. Children-aware: when the auto-bg
 * net ADOPTED this delegation's chip as a root (roles.mjs keys the root graph
 * by the watcherId), a chip with still-running child delegations defers to
 * deferRootCompletion instead of reading "done" under them.
 */
export function completeSyncDelegation(taskId, { outcome = 'done', finalText = '', finalReportPreview = '' } = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec || !rec.isSync) return false;
  const status = (outcome === 'stopped' || outcome === 'cancelled') ? 'cancelled' : (outcome === 'error' ? 'error' : 'done');
  const syncOutcome = status === 'done' ? 'done' : (status === 'cancelled' ? 'stopped' : 'error');
  rec.status = status;
  rec.phase = status;
  rec.currentTool = null;
  const syncEndedAt = Date.now();
  recentDelegations.unshift({
    taskId, userId: rec.userId, agentId: rec.agentId,
    rootTaskId: rec.rootTaskId || taskId,
    parentTaskId: rec.parentTaskId || null,
    spanId: rec.spanId || null,
    watcherId: rec.watcherId || null,
    rootWatcherId: rec.rootWatcherId || null,
    visibleAgentId: rec.visibleAgentId || null,
    name: rec.agentName, summary: rec.summary,
    outcome: syncOutcome,
    finalText: String(finalReportPreview || finalText || '').slice(0, 240),
    toolsUsed: rec.toolsUsed || 0,
    startedAt: rec.startedAt, endedAt: syncEndedAt,
  });
  if (recentDelegations.length > RECENT_CAP) recentDelegations.length = RECENT_CAP;
  // Durable mirror — sync (in-turn) delegations retire through this function
  // instead of _onComplete, so this is the other delegation-retire point that
  // needs the same 7d JSONL durability. Fire-and-forget, never blocks.
  appendTaskOutcome(rec.userId, {
    taskId, kind: 'delegation', agentId: rec.agentId,
    agentName: rec.agentName, status: syncOutcome,
    summary: String(finalReportPreview || finalText || rec.summary || ''),
    durationMs: syncEndedAt - (rec.startedAt || syncEndedAt),
    error: status === 'error' ? String(finalText || finalReportPreview || '') : null,
  }).catch(e => console.warn('[background-tasks] sync delegation task-outcome append failed:', e.message));
  _completeRootChild(taskId, rec, status, String(finalReportPreview || finalText || '').slice(0, 800));
  activeTasks.delete(taskId);
  _journalRemove(taskId);

  if (rec.watcherId) {
    const rootKey = [taskId, rec.rootTaskId, rec.watcherId].find(k => k && rootTaskGraphs.get(k)?.children?.size);
    if (rootKey) {
      deferRootCompletion({ userId: rec.userId, rootTaskId: rootKey, rootWatcherId: rec.watcherId, status, finalText, finalReportPreview });
    } else {
      if (finalText) {
        pushWatcherStatus(rec.userId, rec.watcherId, finalText, {
          taskId, status, phase: status,
          canCancel: false, cancelling: false, currentTool: null,
          lastActivityAt: Date.now(), finalReportPreview,
        });
      }
      completeWatcher(rec.userId, rec.watcherId, { status, finalText });
      for (const k of [taskId, rec.rootTaskId, rec.watcherId]) {
        const g = k && rootTaskGraphs.get(k);
        if (g && !g.children.size) rootTaskGraphs.delete(k);
      }
    }
  }
  return true;
}

/**
 * Register a sync delegation. Returns a small handle the delegate skill uses
 * to keep the record honest while it streams, or null on bad input.
 */
export function registerSyncDelegation({ taskId, userId, agentId, agentName, agentEmoji = '🤖', summary = '', watcherId = null, visibleAgentId = null, abort = null, rootTaskId = null, parentTaskId = null, parentWatcherId = null, rootWatcherId = null }) {
  if (!taskId || !userId) return null;
  const rTask = rootTaskId || taskId;
  activeTasks.set(taskId, {
    agentId, userId, agentName, agentEmoji,
    startedAt: Date.now(), summary: String(summary || '').slice(0, 120),
    phase: 'running', status: 'running',
    watcherId: watcherId || null,
    visibleAgentId: visibleAgentId || null,
    rootTaskId: rTask,
    parentTaskId: parentTaskId || null,
    parentWatcherId: parentWatcherId || null,
    rootWatcherId: rootWatcherId || watcherId || null,
    spanId: `${rTask}:${_slug(agentName)}:${taskId}`,
    aliases: [taskId, agentId, watcherId].filter(Boolean),
    isDelegation: true,
    isSync: true,
    abort: typeof abort === 'function' ? abort : null,
  });
  const rec = activeTasks.get(taskId);
  if (rec.rootTaskId !== taskId) _attachRootChild(taskId, rec);
  _journalAdd(taskId);
  return {
    taskId,
    noteToolCall(name) {
      const r = activeTasks.get(taskId);
      if (!r || !name) return;
      r.toolsUsed = (r.toolsUsed || 0) + 1;
      r.currentTool = name;
      r.lastUpdateAt = Date.now();
      pushWorkerProgress(taskId, { kind: 'tool', tool: name });
      _updateRootChildProgress({ ...r, taskId });
    },
    noteToolResult(name, preview) {
      const r = activeTasks.get(taskId);
      if (!r || !name) return;
      r.currentTool = null;
      r.lastResultPreview = String(preview || '').slice(0, 160);
      r.lastUpdateAt = Date.now();
      pushWorkerProgress(taskId, { kind: 'result', tool: name, text: String(preview || '').slice(0, 160) });
    },
    // Pipeline stage transition — updates what check_workers + the chip header
    // call this delegation (for example, "agent" -> "agent -> specialist").
    setStageName(name) {
      const r = activeTasks.get(taskId);
      if (r && name) r.agentName = name;
    },
    isCancelling() {
      const r = activeTasks.get(taskId);
      return !!r && r.status === 'cancelling';
    },
    complete(o) { return completeSyncDelegation(taskId, o); },
  };
}

/**
 * Run an ephemeral agent synchronously (awaitable) and return its final text.
 * Differs from dispatchBackground in that:
 *   - Returns a Promise resolving to the result string (not a taskId)
 *   - Does NOT inject a completion notice into any coordinator session
 *   - Does NOT append to the worker's session (ephemeral agents are stateless)
 * Used by deep_research_parallel to fan out research sub-queries.
 *
 * @param {object} agent - ephemeral agent object (must have ephemeral:true, id prefixed "ephemeral_")
 * @param {string} task - prompt for this worker
 * @param {string} userId
 * @param {object} [opts]
 * @param {(tokenText:string)=>void} [opts.onProgress] - per-token callback (for UI streaming)
 * @param {string} [opts.agentEmoji] - icon (default 🔎)
 * @returns {Promise<string>} final concatenated text
 */
export async function dispatchEphemeral(agent, task, userId, opts = {}) {
  const taskId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = agent.name ?? 'Worker';
  const agentEmoji = opts.agentEmoji ?? '🔎';
  activeTasks.set(taskId, { agentId: agent.id, userId, agentName, startedAt: Date.now() });

  try {
    const { streamChat } = await import('./chat.mjs');
    let out = '';
    for await (const ev of streamChat(agent, task, null, null, userId, null, null, false, null, { rootTaskId: taskId, traceSource: 'background' })) {
      if (ev.type === 'token') {
        out += ev.text;
        opts.onProgress?.(ev.text);
      }
      if (ev.type === 'error') throw new Error(ev.message);
    }
    activeTasks.delete(taskId);
    return out.trim();
  } catch (err) {
    activeTasks.delete(taskId);
    throw err;
  }
}

// ── Agent-owned background workers (manager/employee model) ──────────────────
// Generic capability: ANY agent can hire a background worker it OWNS, watch it,
// and report on it. Differs from dispatchBackground (coordinator→specialist
// delegation) in three ways:
//   1. ownerKey is the STABLE id of the owning agent (e.g. the email
//      specialist), derived by the delegate skill from the caller's session.
//      The owner sees its workers from ANY session — its direct chat OR an
//      ephemeral delegation (e.g. the coordinator asking it for status) — so
//      "how's it going" resolves the same workers either way.
//   2. The run is abortable, so stop_worker can cancel it.
//   3. The chip + completion report land in the OWNER's chat (chipOwnerId),
//      not the coordinator's. Completion bubbles up to whoever owns the worker.

// Recently-finished workers (ring buffer) so check_workers can report a TERMINAL
// outcome ("failed at 04:04") instead of silently showing nothing — the #1 cause
// of an agent telling the user "still running" when the worker actually died.
const recentWorkers = [];
const RECENT_CAP = 12;
// Cap for the MERGED read (in-memory ring + durable JSONL tail) returned by
// listRecentWorkersForOwner / listRecentDelegationsForUser. Larger than
// RECENT_CAP because the durable tail can surface history the ring already
// evicted (another user's flurry of tasks, or a restart).
const RECENT_READ_CAP = 25;

// Same idea for coordinator→specialist DELEGATIONS (dispatchBackground). Lets
// check_workers report a terminal outcome ("specialist finished - 56 events added")
// for a moment after the task ends, instead of the task simply vanishing the
// instant it completes and leaving the next "is it done?" with nothing to show.
const recentDelegations = [];

function _retire(taskId, outcome, finalText) {
  const info = activeTasks.get(taskId);
  if (!info || !info.isWorker) return;
  const endedAt = Date.now();
  recentWorkers.unshift({
    taskId, ownerKey: info.ownerKey, userId: info.userId,
    name: info.agentName, summary: info.summary,
    outcome,                                   // 'done' | 'error' | 'stopped'
    finalText: (finalText || '').slice(0, 240),
    toolsUsed: info.toolsUsed || 0,
    startedAt: info.startedAt, endedAt,
  });
  if (recentWorkers.length > RECENT_CAP) recentWorkers.length = RECENT_CAP;
  // Durable mirror (7d JSONL) — same fire-and-forget philosophy as the
  // delegation retire point in _onComplete: this must never affect the ring
  // push above or the caller's completion flow (spawnWorker's async IIFE
  // calls _retire synchronously right before awaiting _onComplete).
  appendTaskOutcome(info.userId, {
    taskId, kind: 'worker', ownerKey: info.ownerKey, agentId: info.agentId,
    agentName: info.agentName, status: outcome,
    summary: finalText || info.summary,
    durationMs: endedAt - (info.startedAt || endedAt),
    error: outcome === 'error' ? finalText : null,
  }).catch(e => console.warn('[background-tasks] worker task-outcome append failed:', e.message));
}

// Append an entry to a worker's rolling progress log (cap 20). Tool results carry
// the real domain numbers (email tools return "Labeled 200…", "619 match…"), so
// this is what lets a manager report actual progress, not just "running a tool".
function pushWorkerProgress(taskId, entry) {
  const rec = activeTasks.get(taskId);
  if (!rec) return false;
  rec.progress = rec.progress || [];
  rec.progress.push({ ...entry, ts: Date.now() });
  if (rec.progress.length > 20) rec.progress.shift();
  rec.lastActivityAt = Date.now();
  return true;
}

/** Record an explicit milestone note from inside a worker (the report_progress tool). */
export function recordWorkerProgress(taskId, note) {
  const rec = activeTasks.get(taskId);
  if (!rec) return false;
  pushWorkerProgress(taskId, { kind: 'note', text: String(note || '').slice(0, 240) });
  if (rec.watcherId) { try { pushWatcherStatus(rec.userId, rec.watcherId, `• ${String(note || '').slice(0, 80)}`); } catch { /* chip gone */ } }
  return true;
}

/**
 * Hire a background worker owned by a specific agent.
 * @param {object} a
 * @param {object} a.workerAgent  - ephemeral agent (clone of the owner's role)
 * @param {string} a.task         - self-contained job for the worker
 * @param {string} a.userId
 * @param {string} a.chipOwnerId  - scoped session id of the owner's chat (chip + report target)
 * @param {string} a.ownerKey     - stable agent id of the owner (for check_workers lookup)
 * @param {string} a.workerName
 * @param {string} a.emoji
 * @returns {string} taskId
 */
export function spawnWorker({ workerAgent, task, userId, chipOwnerId, ownerKey, workerName = 'Worker', emoji = '🤖' }) {
  const taskId = `wkr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const summary = (task || '').slice(0, 120);
  const ac = new AbortController();
  // Scheduled-task barrier linkage — read the SAME AsyncLocalStorage signal
  // dispatchBackground uses (getScheduledContext()). spawn_worker is invoked
  // synchronously from inside the tool-dispatch loop that runAgentWithRetry
  // wraps in scheduledContext.run(...) for a scheduled run (scheduler.mjs ->
  // run-agent-with-retry.mjs -> streamChat -> executeSkillTool -> here), so
  // this is ambient — no explicit threading through skills/delegate/execute.mjs
  // is needed. Falls back to null for an interactive (non-scheduled) worker,
  // which must NOT link to any barrier group.
  const scheduledCtx = getScheduledContext();
  activeTasks.set(taskId, {
    agentId: workerAgent.id, userId, agentName: workerName, agentEmoji: emoji,
    startedAt: Date.now(), summary, ownerKey, isWorker: true, phase: 'queued',
    // chipOwnerId doubles as the report target on completion (_onComplete gets
    // it as a parameter) — keep it on the record too so the restart journal
    // knows which chat to notify when this worker dies with the process.
    visibleAgentId: chipOwnerId,
    status: 'running', abort: () => ac.abort(),
    originScheduledTaskId: scheduledCtx?.originTaskId || null,
    originScheduledTaskOwnerId: scheduledCtx?.originTaskOwnerId || userId || null,
    originScheduledTaskAgent: scheduledCtx?.originTaskAgent || null,
    originScheduledRunId: scheduledCtx?.runId || null, // barrier per-fire nonce — must rejoin the SAME fire's group
  });
  if (scheduledCtx?.originTaskId) {
    // _onComplete's existing generic completion block (gated on
    // rec.originScheduledTaskId, shared by both delegations and workers)
    // reports this child's completion back to the barrier — no separate
    // completeScheduledChild call is needed here.
    registerScheduledChild({
      userId,
      scheduledCtx,
      childId: taskId,
      label: `${workerName}: ${summary}`,
      kind: 'worker',
    });
  }

  let watcherId = null;
  try {
    watcherId = registerWatcher({
      userId,
      agentId: chipOwnerId,   // chip lives in the OWNER's chat
      kind: 'task_proxy',
      label: taskLabel(emoji, workerName, summary),
      state: taskState(taskId, { phase: 'queued' }),
      cadenceSec: 30,
      expiresAt: null,
    });
    const rec = activeTasks.get(taskId);
    if (rec) rec.watcherId = watcherId;
    pushTaskProgress(taskId, `Started ${workerName}: ${summary}`, { phase: 'queued' });
  } catch (e) {
    console.warn('[workers] task_proxy watcher registration failed:', e.message);
  }
  _journalAdd(taskId);

  (async () => {
    const { isUserTimeBlocked } = await import('./routes/_helpers.mjs');
    if (isUserTimeBlocked(userId)) {
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, null, 'Access is restricted at this time — worker not started.');
      return;
    }
    try {
      const { streamChat } = await import('./chat.mjs');
      const { getScheduledNote } = await import('./lib/scheduled-context.mjs');
      const scheduledNote = getScheduledNote();
      let fullText = '';
      const toolEvents = [];
      const reportImages = [];
      const rememberedPlan = matchToolPlan(userId, { agentId: workerAgent.id, phrase: task });
      const taskCtx = { taskId, watcherId, userId, agentId: workerAgent.id };
      pushTaskProgress(taskId, `${workerName} started working`, { phase: 'running' });
      await runInTaskContext(taskCtx, async () => {
        for await (const ev of streamChat(workerAgent, task, ac.signal, null, userId, null, scheduledNote, false, null, { toolPlan: rememberedPlan, isolatedTaskRun: true, rootTaskId: taskId, traceSource: scheduledNote ? 'scheduled' : 'background' })) {
          if (ev.type === 'token') fullText += ev.text;
          trackToolEvent(toolEvents, ev, workerAgent.id);
          if (ev.type === 'tool_call' && ev.name) {
            const rec = activeTasks.get(taskId);
            if (rec) { rec.toolsUsed = (rec.toolsUsed || 0) + 1; rec.currentTool = ev.name; rec.lastUpdateAt = Date.now(); }
            pushWorkerProgress(taskId, { kind: 'tool', tool: ev.name });
            if (rec?.watcherId) pushTaskProgress(taskId, `${workerName} is using ${ev.name}`, { currentTool: ev.name, toolsUsed: rec.toolsUsed, phase: 'tool' });
          }
          if (ev.type === 'tool_progress' && ev.text) {
            const rec = activeTasks.get(taskId);
            pushTaskProgress(taskId, String(ev.text).slice(-1200), {
              currentTool: rec?.currentTool || null,
              toolsUsed: rec?.toolsUsed || 0,
              phase: 'streaming',
            });
          }
          if (ev.type === 'tool_result' && ev.name) {
            const rec = activeTasks.get(taskId);
            if (rec) { rec.currentTool = null; rec.lastResultPreview = (ev.text || '').slice(0, 80); rec.lastUpdateAt = Date.now(); }
            // Richer preview — the first non-empty line of the result usually holds
            // the domain number ("Labeled 200…", "619 email(s) match…"), giving the
            // manager real progress to report instead of just the tool name.
            const firstLine = String(ev.text || '').split('\n').find(l => l.trim()) || '';
            pushWorkerProgress(taskId, { kind: 'result', tool: ev.name, text: firstLine.slice(0, 160) });
            if (firstLine) pushTaskProgress(taskId, `${ev.name}: ${firstLine.slice(0, 240)}`, { currentTool: null, phase: 'result' });
          }
          if (ev.type === 'image' && ev.filename) {
            const image = reportImageFromEvent(ev);
            if (image) reportImages.push(image);
            pushWorkerProgress(taskId, { kind: 'result', tool: ev.type, text: `produced ${ev.filename}` });
            pushTaskProgress(taskId, `${workerName} produced ${ev.filename}`, { currentTool: null, phase: 'result' });
          }
          if (ev.type === 'error') throw new Error(ev.message);
        }
      });
      _retire(taskId, 'done', fullText.trim());
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, fullText.trim() || `${workerName} finished the job.`, null, null, toolEvents, workerAgent.id, task, { images: reportImages });
    } catch (err) {
      const stopped = ac.signal.aborted;
      _retire(taskId, stopped ? 'stopped' : 'error', stopped ? 'Stopped by its manager.' : err.message);
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, null,
        stopped ? 'Worker stopped by its manager.' : err.message,
        stopped ? 'cancelled' : 'error');
    }
  })();

  return taskId;
}

/** Live status of the workers owned by `ownerKey` (for check_workers / "how's it going"). */
export function listWorkersForOwner(userId, ownerKey) {
  const now = Date.now();
  return [...activeTasks.entries()]
    .filter(([, info]) => info.isWorker && info.userId === userId && info.ownerKey === ownerKey)
    .map(([taskId, info]) => {
      const lastAt = info.lastActivityAt || info.lastUpdateAt || info.startedAt;
      return {
        taskId,
        rootTaskId: info.rootTaskId || taskId,
        parentTaskId: info.parentTaskId || null,
        parentWatcherId: info.parentWatcherId || null,
        rootWatcherId: info.rootWatcherId || info.watcherId || null,
        spanId: info.spanId || null,
        watcherId: info.watcherId || null,
        visibleAgentId: info.visibleAgentId || null,
        name: info.agentName,
        summary: info.summary,
        currentTool: info.currentTool || null,
        toolsUsed: info.toolsUsed || 0,
        elapsedSec: Math.round((now - info.startedAt) / 1000),
        idleSec: Math.round((now - lastAt) / 1000),
        stalled: (now - lastAt) > 120000,         // no tool activity for >2min
        progress: (info.progress || []).slice(-8), // recent log w/ domain numbers
      };
    });
}

// Reshape a durable task-outcomes.jsonl row back into the recent-ring shape
// (taskId/name/summary/outcome/finalText/toolsUsed/startedAt/endedAt) so
// callers (check_workers, describeBackgroundWorkForSession) can treat a
// durable-only row exactly like a ring entry. Rows written after a ring
// eviction or a restart won't have the ring's richer routing fields
// (watcherId/spanId/rootTaskId — the chip is long gone by then), which is
// fine: every consumer already treats those as optional.
function _outcomeRowToRecent(row, userId) {
  return {
    taskId: row.taskId,
    userId,
    ownerKey: row.ownerKey || null,
    agentId: row.agentId || null,
    name: row.agentName || 'Agent',
    summary: row.summary || '',
    outcome: row.status,   // already normalized to 'done'|'stopped'|'error' at write time
    finalText: (row.error || row.summary || '').slice(0, 240),
    toolsUsed: 0,
    startedAt: Number.isFinite(row.durationMs) ? row.ts - row.durationMs : row.ts,
    endedAt: row.ts,
  };
}

// Merge the hot in-memory ring with the durable JSONL tail: ring entries win
// on taskId collisions (they carry the richer live-routing fields), durable
// rows fill in anything the ring already evicted or lost on restart.
function _mergeRecentWithDurable(ringItems, durableRows, userId, cap) {
  const seen = new Set(ringItems.map(r => r.taskId));
  const merged = ringItems.slice();
  for (const row of durableRows) {
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    merged.push(_outcomeRowToRecent(row, userId));
  }
  merged.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  return cap ? merged.slice(0, cap) : merged;
}

/** Recently-finished workers for an owner — so check_workers can report terminal outcomes. */
export function listRecentWorkersForOwner(userId, ownerKey) {
  const now = Date.now();
  const ring = recentWorkers.filter(r => r.userId === userId && r.ownerKey === ownerKey);
  let durable = [];
  try {
    durable = loadTaskOutcomes(userId, { kind: 'worker' }).filter(r => (r.ownerKey || null) === ownerKey);
  } catch (e) { console.warn('[background-tasks] durable worker outcomes read failed:', e.message); }
  return _mergeRecentWithDurable(ring, durable, userId, RECENT_READ_CAP)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/**
 * Live status of coordinator→specialist DELEGATIONS in flight for a user.
 *
 * Unlike workers, delegations are NOT scoped to an ownerKey: a delegation is
 * user-level background work (the coordinator handed a job to a specialist on
 * the user's behalf), so ANY agent the user asks — the specialist they're
 * chatting with, the coordinator, anyone — should be able to surface it. This
 * is the fix for the "is the specialist still working?" black hole: the job was always
 * live in activeTasks, but check_workers only ever looked at isWorker records.
 *
 * `excludeAgentId` drops the caller's own delegation session so a running
 * specialist doesn't list itself back as a separate task.
 */
export function listActiveDelegationsForUser(userId, excludeAgentId = null) {
  const now = Date.now();
  return [...activeTasks.entries()]
    .filter(([, info]) => info.isDelegation && info.userId === userId && info.agentId !== excludeAgentId
      && !(excludeAgentId && (info.aliases || []).includes(excludeAgentId)))
    .map(([taskId, info]) => {
      const lastAt = info.lastActivityAt || info.lastUpdateAt || info.startedAt;
      return {
        taskId,
        rootTaskId: info.rootTaskId || taskId,
        parentTaskId: info.parentTaskId || null,
        parentWatcherId: info.parentWatcherId || null,
        rootWatcherId: info.rootWatcherId || info.watcherId || null,
        spanId: info.spanId || null,
        watcherId: info.watcherId || null,
        visibleAgentId: info.visibleAgentId || null,
        name: info.agentName,
        summary: info.summary,
        currentTool: info.currentTool || null,
        toolsUsed: info.toolsUsed || 0,
        elapsedSec: Math.round((now - info.startedAt) / 1000),
        idleSec: Math.round((now - lastAt) / 1000),
        stalled: (now - lastAt) > 120000,         // no tool activity for >2min
        status: info.status || 'running',
        childTasks: info.rootTaskId ? _rootChildSnapshot(rootTaskGraphs.get(info.rootTaskId)) : [],
        progress: (info.progress || []).slice(-8),
      };
    });
}

/** Recently-finished delegations for a user — terminal outcomes for check_workers. */
export function listRecentDelegationsForUser(userId, excludeAgentId = null) {
  const now = Date.now();
  const ring = recentDelegations.filter(r => r.userId === userId && r.agentId !== excludeAgentId);
  let durable = [];
  try {
    durable = loadTaskOutcomes(userId, { kind: 'delegation' }).filter(r => (r.agentId || null) !== excludeAgentId);
  } catch (e) { console.warn('[background-tasks] durable delegation outcomes read failed:', e.message); }
  return _mergeRecentWithDurable(ring, durable, userId, RECENT_READ_CAP)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/**
 * One-line ground-truth summary of a user's background work — the server-side
 * equivalent of check_workers, for chat.mjs's "already in progress" truthfulness
 * gate. The gate injects this into a retry note so the model answers from
 * verified status instead of its own stale promises in session memory.
 */
export function describeBackgroundWorkForSession(userId, sessionAgentId = null) {
  // Session ids arrive wrapped (`user_<uid>_<agentId>` or `ephemeral_deleg_…`) —
  // unwrap to the stable agent id for the worker-owner lookup. Keep in sync
  // with _parseCallerSession in skills/delegate/execute.mjs.
  const raw = String(sessionAgentId || '');
  const m = raw.match(/^ephemeral_deleg_d\d+_\d+_[a-z0-9]+_(.+)$/)
    || raw.match(/^ephemeral_deleg_\d+_[a-z0-9]+_(.+)$/)
    || raw.match(/^user_[a-z0-9]+_(.+)$/);
  const ownerKey = m ? m[1] : (raw || null);
  const ago = s => s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
  const lines = [];
  for (const d of listActiveDelegationsForUser(userId, sessionAgentId)) {
    lines.push(`RUNNING: ${d.name} — "${d.summary}" (${d.toolsUsed} tool calls, started ${ago(d.elapsedSec)} ago${d.stalled ? ', STALLED' : ''})`);
  }
  for (const w of (ownerKey ? listWorkersForOwner(userId, ownerKey) : [])) {
    lines.push(`RUNNING worker: ${w.name} — "${w.summary}" (${w.toolsUsed} tool calls, started ${ago(w.elapsedSec)} ago${w.stalled ? ', STALLED' : ''})`);
  }
  const recent = [
    ...listRecentDelegationsForUser(userId, sessionAgentId),
    ...(ownerKey ? listRecentWorkersForOwner(userId, ownerKey) : []),
  ].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 5);
  for (const r of recent) {
    const verb = r.outcome === 'done' ? 'FINISHED' : (r.outcome === 'stopped' ? 'STOPPED' : 'FAILED');
    lines.push(`${verb} ${ago(r.endedAgoSec)} ago: ${r.name} — ${r.finalText || r.summary}`);
  }
  if (!lines.length) return 'NONE — no delegations or background workers are running for this user, and none finished recently.';
  return lines.join(' | ');
}

/**
 * Stop a worker OR a delegated background task by id. Workers are owner-scoped
 * (ownerKey must match — you can only stop your own); delegations are
 * user-level work (any agent the user asks may stop them, mirroring how
 * check_workers surfaces them to every agent).
 */
export function stopWorker(userId, taskId, ownerKey = null) {
  const info = activeTasks.get(taskId);
  if (!info || info.userId !== userId) return { ok: false, reason: 'not found' };
  if (info.isWorker) {
    if (ownerKey && info.ownerKey !== ownerKey) return { ok: false, reason: 'that worker belongs to a different agent' };
  } else if (!info.isDelegation) {
    return { ok: false, reason: 'not a worker or delegated task' };
  }
  const r = cancelTask(userId, taskId, 'stopped_by_manager');
  return r.ok ? { ok: true, name: info.agentName } : { ok: false, reason: r.reason || 'not cancellable' };
}
