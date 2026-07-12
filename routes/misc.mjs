/**
 * Misc routes: /api/notes, /api/history/:id, /api/tasks, /api/dashboard
 */

import fs from 'fs';
import path from 'path';
import {
  requireAuth, getAuthToken, getSessionUserId, getUser, getUserRole, isPrivileged,
  loadUsers, loadNotes, saveNotes, withLock, NOTES_PATH, readBody, safeId, BASE_DIR, getUserDir,
  broadcastToUsers, getUserSessions, revokeSessionByPrefix, getAgentsForUser,
  clearUserSessionsExcept, clearUserVoiceDeviceSessions, clearUserNodeSessions,
} from './_helpers.mjs';

const MESSAGES_PATH = path.join(BASE_DIR, 'messages.json');
function loadMessages() {
  try { return JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8')); } catch { return []; }
}
async function saveMessages(msgs) {
  await withLock(MESSAGES_PATH, () => fs.writeFileSync(MESSAGES_PATH, JSON.stringify(msgs, null, 2)));
}

const THREADS_PATH = path.join(BASE_DIR, 'threads.json');
function loadThreads() {
  try { return JSON.parse(fs.readFileSync(THREADS_PATH, 'utf8')); } catch { return []; }
}
async function saveThreads(threads) {
  await withLock(THREADS_PATH, () => fs.writeFileSync(THREADS_PATH, JSON.stringify(threads, null, 2)));
}
import { loadSession } from '../sessions.mjs';
import { loadTasksForOwner, findTaskById, addTask, removeTask, updateTask, scheduleNewTask } from '../scheduler.mjs';
import { listWatchers, unregisterWatcher, patchWatcher, getWatcher, emitEvent, registerWatcher } from '../scheduler/watchers.mjs';
import { cancelTask } from '../background-tasks.mjs';
import { profileHealthSignalDetails } from '../lib/watcher-health-details.mjs';
import { acceptProposal, dismissProposal, blockProposal, snoozeProposal, undoProposal, getProposal, listUserProposals } from '../lib/proposals.mjs';
import { readLearnings, revokeRule, revokeAlias, revokeRoutine, revokeDefault, revokeRoutingOverride, revokeLearnedIntent, resetSalienceKind, applySkillOverride, revokeSkillOverride, applyLearningKindPolicy, revokeLearningKindPolicy, applyLearningPolicy, revokeLearningPolicy } from '../lib/learnings.mjs';
import { maybeRunSweep, forceRun as forceWeek1Sweep, getSweepStatus } from '../lib/week1-sweep.mjs';
import { interceptScheduling } from '../lib/scheduler-intent.mjs';
import { getMemoryStats } from '../memory.mjs';
import { getGmailAuthHeader } from './gmail.mjs';

// Translate the 5-field cron shapes the scheduler can actually run into its
// native {repeat, time, dow, intervalMs} fields. Returns null for anything
// unsupported (day-of-month / month restrictions, step hours, etc.) so the
// POST /api/tasks route can reject instead of persisting a dead task.
function cronToTaskFields(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const everyN = min.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { repeat: 'interval', intervalMs: Math.max(1, parseInt(everyN[1], 10)) * 60_000 };
  }
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  if (+min > 59 || +hour > 23) return null;
  if (dom !== '*' || mon !== '*') return null;
  if (dow !== '*' && !/^[\d,-]+$/.test(dow)) return null;
  const time = `${String(+hour).padStart(2, '0')}:${String(+min).padStart(2, '0')}`;
  return { repeat: 'daily', time, ...(dow !== '*' ? { dow } : {}) };
}

async function getEmailUnreadCount(userId) {
  // Load user's email accounts
  const acctPath = path.join(getUserDir(userId), 'email-accounts.json');
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(acctPath, 'utf8')); } catch (_) {}
  const gmailAcct = accounts.find(a => a.provider === 'gmail');
  if (!gmailAcct) return null;
  try {
    const authHdr = await getGmailAuthHeader(userId, gmailAcct.id);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX', { headers: authHdr });
    const data = await r.json();
    return data.messagesUnread ?? 0;
  } catch (_) { return null; }
}

export async function handle(req, res) {
  // ── Browser extension status (lists connected extensions for this user) ─
  if (req.url === '/api/browser/status' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const { listBrowsers, getBrowserCount } = await import('../lib/browser-bus.mjs');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ connected: listBrowsers(authId), globalCount: getBrowserCount() }));
    return true;
  }

  // ── Conversation search ──────────────────────────────────────────────────
  if (req.url.startsWith('/api/search') && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const params = new URL(req.url, 'http://x').searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    if (!q || q.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query must be at least 2 characters' }));
      return true;
    }
    const sessDir = path.join(getUserDir(authId), 'sessions');
    const results = [];
    const MAX_RESULTS = 50;
    try {
      if (fs.existsSync(sessDir)) {
        for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
          const agentLocalId = file.replace('.jsonl', '');
          const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').trim().split('\n').filter(Boolean);
          for (const line of lines) {
            if (results.length >= MAX_RESULTS) break;
            try {
              const msg = JSON.parse(line);
              const content = typeof msg.content === 'string' ? msg.content : '';
              if (content.toLowerCase().includes(q)) {
                results.push({ agent: agentLocalId, role: msg.role, content: content.slice(0, 300), ts: msg.ts });
              }
            } catch {}
          }
          if (results.length >= MAX_RESULTS) break;
        }
      }
    } catch (e) { console.warn('[search]', e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results, total: results.length }));
    return true;
  }

  // ── Active session management ────────────────────────────────────────────
  // Matched on pathname (not exact req.url) so `?includeDevices=1` doesn't
  // break the match — req.url includes the query string.
  if ((req.url === '/api/sessions' || req.url.startsWith('/api/sessions?')) && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const currentToken = getAuthToken(req);
    const includeDevices = new URL(req.url, 'http://x').searchParams.get('includeDevices') === '1';
    // Cheap display-name resolution for voice-device sessions: they carry
    // deviceId (bound at pair time), so a single listDevices() lookup gets
    // exact names. Node sessions carry no such id on the session record —
    // the node registry (skills/nodes/node-registry.mjs) associates a token
    // with a node via a hashed-token comparison instead, so resolving a name
    // means walking this user's node-session tokens through
    // findNodeByToken(). getUserSessions() only ever returns redacted
    // tokenPrefix, so getUserNodeSessionTokens() (auth-sessions.mjs,
    // internal-only) supplies the full tokens for this lookup — they never
    // leave this handler or reach the JSON response.
    let deviceNameById = new Map();
    let nodeNameByPrefix = new Map();
    if (includeDevices) {
      try {
        const { listDevices } = await import('../lib/voice-devices.mjs');
        deviceNameById = new Map(listDevices(authId).map(d => [d.id, d.name || null]));
      } catch (e) { console.warn('[sessions] device name lookup failed:', e.message); }
      try {
        const { getUserNodeSessionTokens } = await import('./_helpers/auth-sessions.mjs');
        const { findNodeByToken } = await import('../skills/nodes/node-registry.mjs');
        for (const token of getUserNodeSessionTokens(authId)) {
          const node = findNodeByToken(token);
          if (node && node.userId === authId) {
            nodeNameByPrefix.set(token.slice(0, 8) + '…', node.hostname || null);
          }
        }
      } catch (e) { console.warn('[sessions] node name lookup failed:', e.message); }
    }
    // Persistent-device tokens (nodes, voice devices) represent long-lived
    // hardware registrations, normally managed by their own Settings pages —
    // revoking one from the Profile page would silently break the device.
    // ?includeDevices=1 opts into seeing them here too (read-only; see the
    // settings.js UI, which intentionally does not offer a per-row revoke
    // for these — that must go through the device/node removal flow so an
    // auto-revive can't resurrect a bare session revoke).
    const sessions = getUserSessions(authId)
      .filter(s => includeDevices || (s.kind !== 'node' && s.kind !== 'voice-device'))
      .map(s => ({
        ...s,
        current: currentToken?.startsWith(s.tokenPrefix.replace('…', '')) ?? false,
        deviceName: s.kind === 'voice-device' && s.deviceId
          ? (deviceNameById.get(s.deviceId) ?? null)
          : s.kind === 'node'
            ? (nodeNameByPrefix.get(s.tokenPrefix) ?? null)
            : null,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return true;
  }

  if (req.url === '/api/sessions/revoke' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { tokenPrefix } = JSON.parse(await readBody(req));
      if (!tokenPrefix || tokenPrefix.length < 8) throw new Error('Invalid token prefix');
      const prefix = tokenPrefix.replace('…', '');
      // Prevent revoking your own current session
      const currentToken = getAuthToken(req);
      if (currentToken?.startsWith(prefix)) throw new Error('Cannot revoke your current session');
      const ok = revokeSessionByPrefix(authId, prefix);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Session not found' }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // ── POST /api/sessions/revoke-all { includeHardware } ───────────────────
  // "Log out everywhere." Always revokes every OTHER browser session (the
  // caller's own current session is preserved via clearUserSessionsExcept,
  // same as the self-service password-change flow in routes/users.mjs).
  //
  // When includeHardware is true, additionally wipes voice devices + nodes.
  // ORDERING MATTERS: ws-handler.mjs auto-revives an expired/deleted
  // voice-device session by matching the presented token's hash against the
  // device record still sitting in voice-devices.json (see project note
  // "Voice token auto-recover"). A revoke that only clears the session table
  // is silently undone the next time the device reconnects. So for each
  // device/node we remove the REGISTRY ENTRY FIRST (removeDevice / removeNode
  // — this also revokes the node's/device's own tokenHash-based re-admission
  // path and, for nodes, records a revocation so re-registration is refused
  // outright), and only then bulk-clear the session-table entries for that
  // kind. By the time a reconnect could happen, there is no registry entry
  // left for auto-revive to match against.
  if (req.url === '/api/sessions/revoke-all' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    let includeHardware = false;
    try {
      const raw = await readBody(req);
      if (raw) includeHardware = JSON.parse(raw)?.includeHardware === true;
    } catch { /* malformed/empty body — treat as includeHardware:false */ }

    const currentToken = getAuthToken(req);
    const browsers = clearUserSessionsExcept(authId, currentToken);

    let devices = 0, nodes = 0;
    if (includeHardware) {
      try {
        const { listDevices, removeDevice } = await import('../lib/voice-devices.mjs');
        const deviceList = listDevices(authId);
        for (const d of deviceList) removeDevice(authId, d.id); // registry entry gone BEFORE session revoke
        devices = deviceList.length;
        clearUserVoiceDeviceSessions(authId);
      } catch (e) { console.warn('[sessions] revoke-all: voice-device cleanup failed:', e.message); }
      try {
        const { getNodes, removeNode, pushUninstall } = await import('../skills/nodes/node-registry.mjs');
        const nodeList = getNodes(authId);
        for (const n of nodeList) {
          try { pushUninstall(n.nodeId, authId); } catch { /* best-effort; offline nodes just get revoked */ }
          removeNode(n.nodeId, authId); // records revocation + closes any live WS BEFORE session revoke
        }
        nodes = nodeList.length;
        clearUserNodeSessions(authId);
      } catch (e) { console.warn('[sessions] revoke-all: node cleanup failed:', e.message); }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, browsers, devices, nodes }));
    return true;
  }

  // Session history for an agent
  const histMatch = req.url.match(/^\/api\/history\/(\w+)$/);
  if (histMatch) {
    const authId = requireAuth(req, res); if (!authId) return true;
    const sessionId = `${authId}_${histMatch[1]}`;
    const messages = await loadSession(sessionId, 60);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
    return true;
  }

  // Watchers (per-user polls registered by skills via ctx.watch). Surfaced
  // alongside tasks in the tasks drawer but they're a distinct concept:
  //   tasks    = scheduled fire-and-complete actions
  //   watchers = long-running monitors with progress updates
  if (req.url === '/api/watchers' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listWatchers(authId)));
    return true;
  }

  // Human-confirmed exec watcher creation. Agent tool calls deliberately
  // cannot create persisted shell watches; this route is the explicit user
  // approval path. Body:
  // { label, command, comparator, target, parse?, cadenceSec?, expiresAt?,
  //   agent?, confirm:"CREATE EXEC WATCH" }
  if (req.url === '/api/watchers/exec' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    // Exec watchers run an arbitrary shell command on a repeating cadence as the
    // OE process owner — admin-only. The client-supplied confirm phrase is a
    // speed-bump, not an authorization control.
    if (!isPrivileged(authId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'exec watchers are admin-only' }));
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req));
      if (body.confirm !== 'CREATE EXEC WATCH') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'confirmation phrase required: CREATE EXEC WATCH' }));
        return true;
      }
      if (!body.label || !body.command || !body.comparator) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'label, command, and comparator are required' }));
        return true;
      }
      const valid = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'matches', 'contains', 'changed']);
      if (!valid.has(body.comparator)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid comparator' }));
        return true;
      }
      const expiresAt = body.expiresAt === null || body.expiresAt === undefined
        ? null
        : new Date(body.expiresAt).getTime();
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expiresAt must be null/omitted or at least one minute in the future' }));
        return true;
      }
      const rawAgent = body.agent ? safeId(String(body.agent)) : 'coordinator';
      const watcherId = registerWatcher({
        userId: authId,
        agentId: `${authId}_${rawAgent}`,
        kind: 'exec',
        label: String(body.label).slice(0, 200),
        cadenceSec: Math.max(5, Number(body.cadenceSec) || 60),
        expiresAt,
        skillId: null,
        state: {
          command: String(body.command),
          parse: body.parse || 'string',
          comparator: body.comparator,
          target: body.target,
          _userConfirmed: true,
        },
        onFire: body.onFire && typeof body.onFire === 'object' ? body.onFire : { type: 'notify' },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, watcherId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  const wMatch = req.url.match(/^\/api\/watchers\/([^?/]+)/);
  if (wMatch && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const w = getWatcher(authId, wMatch[1]);
    if (!w) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: w.id, kind: w.kind, label: w.label, status: w.status,
      createdAt: w.createdAt, endedAt: w.endedAt || null,
      cadenceSec: w.cadenceSec, expiresAt: w.expiresAt,
      ticks: w.ticks, failures: w.failures,
      state: w.state || {},
      lastStatusText: w.lastStatusText || null,
      history: Array.isArray(w.history) ? w.history : [],
      profileHealth: profileHealthSignalDetails(authId, w),
    }));
    return true;
  }
  if (wMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const w = getWatcher(authId, wMatch[1]);
    if (w?.kind === 'task_proxy' && w.status === 'active') {
      const cancelled = cancelTask(authId, wMatch[1], 'cancelled');
      if (cancelled.ok) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cancelled: true, taskId: cancelled.taskId }));
        return true;
      }
      if (cancelled.reason === 'not cancellable') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not cancellable' }));
        return true;
      }
    }
    const ok = unregisterWatcher(authId, wMatch[1], 'cancelled');
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return true;
  }
  if (wMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const ok = patchWatcher(authId, wMatch[1], body);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Phase-14b: reply to a task_proxy watcher's awaiting_input prompt.
  // First-write-wins (multi-tab dedup). Resolves the in-process awaitUserReply
  // promise that the agent's tool is blocked on.
  const replyMatch = req.url.match(/^\/api\/watchers\/([^/?]+)\/reply$/);
  if (replyMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const watcher = getWatcher(authId, replyMatch[1]);
      if (!watcher) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'watcher not found' }));
        return true;
      }
      if (watcher.userId !== authId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return true;
      }
      const { submitReply } = await import('../lib/task-proxy-context.mjs');
      const result = submitReply(replyMatch[1], body?.reply || '');
      const status = result.ok && result.accepted ? 200 : (result.ok ? 409 : 404);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // Friction-as-proposer endpoints — accept/dismiss proposals surfaced by
  // the cortex friction tracker. Proposals are in-memory; ownership check
  // matches the proposal's userId against the auth cookie.
  if (req.url === '/api/proposals' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    let pending = listUserProposals(authId, 'pending');
    try {
      const { listLedger } = await import('../lib/personalization/ledger.mjs');
      const rows = new Map((await listLedger(authId, { includeContradicted: false }))
        .filter(row => row?.tier === 'confirmed' && row?.status === 'active')
        .map(row => [row.id, row]));
      // Resolve explanations only in this authenticated response. Proposal
      // history retains the opaque id, never a second copy of preference prose.
      pending = pending.map(proposal => {
        if (proposal?.actionContract !== 'skill_preference_activation'
          || typeof proposal.preferenceMemoryId !== 'string') return proposal;
        const row = rows.get(proposal.preferenceMemoryId);
        if (!row) return proposal;
        return {
          ...proposal,
          personalizationWhy: `Because you confirmed: ${String(row.statement || '').slice(0, 300)}`,
          editPreferenceId: row.id,
        };
      });
    } catch { /* fail closed to the ordinary proposal projection */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending }));
    return true;
  }
  // Bulk endpoints (must match before the single-id regex)
  if ((req.url === '/api/proposals/bulk/accept' || req.url === '/api/proposals/bulk/dismiss') && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const isAccept = req.url.endsWith('/accept');
      const reason = typeof body?.reason === 'string' ? body.reason : null;
      const results = [];
      for (const id of ids) {
        const existing = getProposal(id);
        if (!existing || existing.userId !== authId) { results.push({ id, ok: false, error: 'not found or forbidden' }); continue; }
        const r = isAccept ? await acceptProposal(id) : await dismissProposal(id, { reason });
        results.push({ id, ...r });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  const propMatch = req.url.match(/^\/api\/proposals\/([^/?]+)\/(accept|dismiss|snooze|undo|never)$/);
  if (propMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const id = propMatch[1];
    const action = propMatch[2];
    const existing = getProposal(id);
    if (!existing) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return true; }
    if (existing.userId !== authId) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return true; }
    let body = {};
    if (action === 'dismiss' || action === 'never') {
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
    }
    const result = action === 'accept'  ? await acceptProposal(id)
                 : action === 'snooze'  ? await snoozeProposal(id)
                 : action === 'undo'    ? await undoProposal(id)
                 : action === 'never'   ? await blockProposal(id, { reason: body?.reason })
                                        : await dismissProposal(id, { reason: body?.reason });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // Learn drawer — aggregated read of everything OE has learned about the
  // user (rules, aliases, routines, custom skills, recent accepted proposals).
  // Revokes happen via DELETE on kind-specific paths.
  if (req.url === '/api/learnings' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    // Phase-8: fire-and-forget lazy sweep. After day 7, this runs detectors
    // against accumulated signals once and emits a batch of proposals.
    // Never blocks the response — sweep result will surface in the NEXT GET.
    maybeRunSweep(authId).catch(e => console.warn('[week1-sweep] hook failed:', e.message));
    const learnings = readLearnings(authId);
    learnings.week1Sweep = getSweepStatus(authId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(learnings));
    return true;
  }
  if (req.url === '/api/learnings/sweep/run' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const result = await forceWeek1Sweep(authId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const revokeRuleMatch = req.url.match(/^\/api\/learnings\/rules\/([^/?]+)\/(\d+)$/);
  if (revokeRuleMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const roleId = revokeRuleMatch[1];
    const idx = Number(revokeRuleMatch[2]);
    const result = revokeRule(authId, roleId, idx);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const revokeAliasMatch = req.url.match(/^\/api\/learnings\/aliases\/([^?]+)$/);
  if (revokeAliasMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const phrase = decodeURIComponent(revokeAliasMatch[1]);
    const result = await revokeAlias(authId, phrase);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const revokeRoutineMatch = req.url.match(/^\/api\/learnings\/routines\/([^/?]+)$/);
  if (revokeRoutineMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const result = await revokeRoutine(authId, revokeRoutineMatch[1]);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const revokeDefaultMatch = req.url.match(/^\/api\/learnings\/defaults\/([^/?]+)\/([^/?]+)$/);
  if (revokeDefaultMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const tool = decodeURIComponent(revokeDefaultMatch[1]);
    const arg  = decodeURIComponent(revokeDefaultMatch[2]);
    const result = await revokeDefault(authId, tool, arg);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  if (req.url === '/api/learnings/routing-overrides' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      if (!body?.pattern || !body?.forcedAgent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pattern and forcedAgent required' }));
        return true;
      }
      const { addOverride } = await import('../lib/routing-overrides.mjs');
      const result = await addOverride(authId, {
        pattern: body.pattern,
        forcedAgent: body.forcedAgent,
        mode: body.mode === 'regex' ? 'regex' : 'contains',
        addedBy: 'manual',
        examples: [],
      });
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  const revokeRoutingMatch = req.url.match(/^\/api\/learnings\/routing-overrides\/([^/?]+)$/);
  if (revokeRoutingMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const result = await revokeRoutingOverride(authId, revokeRoutingMatch[1]);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const revokeLearnedMatch = req.url.match(/^\/api\/learnings\/learned-intents\/([^/?]+)\/([^/?]+)$/);
  if (revokeLearnedMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const skillId = decodeURIComponent(revokeLearnedMatch[1]);
    const intentId = decodeURIComponent(revokeLearnedMatch[2]);
    const result = await revokeLearnedIntent(authId, skillId, intentId);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const resetSalienceMatch = req.url.match(/^\/api\/learnings\/salience\/([^/?]+)\/reset$/);
  if (resetSalienceMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const kind = decodeURIComponent(resetSalienceMatch[1]);
    const result = await resetSalienceKind(authId, kind);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  if (req.url === '/api/learnings/policy' && req.method === 'PUT') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const result = await applyLearningPolicy(authId, body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  if (req.url === '/api/learnings/policy' && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const result = await revokeLearningPolicy(authId);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const learningPolicyMatch = req.url.match(/^\/api\/learnings\/policy\/([^/?]+)$/);
  if (learningPolicyMatch && req.method === 'PUT') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const kind = decodeURIComponent(learningPolicyMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const result = await applyLearningKindPolicy(authId, kind, body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  if (learningPolicyMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const kind = decodeURIComponent(learningPolicyMatch[1]);
    const result = await revokeLearningKindPolicy(authId, kind);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }
  const skillOverrideMatch = req.url.match(/^\/api\/learnings\/skill-overrides\/([^/?]+)$/);
  if (skillOverrideMatch && req.method === 'PUT') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const skillId = decodeURIComponent(skillOverrideMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const result = await applySkillOverride(authId, skillId, body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  if (skillOverrideMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const skillId = decodeURIComponent(skillOverrideMatch[1]);
    const result = await revokeSkillOverride(authId, skillId);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // Webhook: fire an arbitrary named event for the authenticated user. Any
  // watcher with kind='event_subscription' and state.event matching is woken
  // for the next supervisor tick. POST /api/watchers/event
  // body: { event: string, payload?: any }
  if (req.url === '/api/watchers/event' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.event) { res.writeHead(400); res.end(JSON.stringify({ error: 'event name required' })); return true; }
      const matched = emitEvent(authId, String(body.event), body.payload ?? {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, matched }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Tasks
  if (req.url === '/api/tasks' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    // Privileged users (install owner) also see install-level system tasks
    // — cleanUploads, etc. — but never another user's personal tasks. System
    // tasks live under tasks/system.json, never in users/<id>/tasks.json.
    const own = loadTasksForOwner(authId);
    const all = isPrivileged(authId) ? [...own, ...loadTasksForOwner('system')] : own;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(all));
    return true;
  }

  if (req.url === '/api/tasks' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) {
      const user = getUser(authId);
      if (Array.isArray(user?.allowedFeatures) && !user.allowedFeatures.includes('tasks')) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Task scheduling not enabled for your account' })); return true;
      }
    }
    try {
      const body = JSON.parse(await readBody(req));
      const { label, agent, cron, prompt, timezone, enabled, repeat, time, dow, intervalMs, datetime } = body;
      // Per-user task cap — prevents a misbehaving account from scheduling
      // thousands of frequent-cron jobs that would swamp the scheduler.
      const MAX_TASKS_PER_USER = 100;
      const existing = loadTasksForOwner(authId).length;
      if (existing >= MAX_TASKS_PER_USER) {
        res.writeHead(429); res.end(JSON.stringify({ error: `Task limit reached (${MAX_TASKS_PER_USER}). Delete some before adding more.` })); return true;
      }
      // The scheduler runs {repeat, time, dow, intervalMs, datetime} — it
      // never reads `cron`. Translate the supported 5-field shapes so this
      // route can't park an unschedulable task (which used to sit "enabled"
      // forever and, pre-guard, crashed the boot arm loop via parseTime).
      let fields = { repeat, time, dow, intervalMs, datetime };
      for (const k of Object.keys(fields)) if (fields[k] == null) delete fields[k];
      if (cron != null && !fields.time && !fields.intervalMs && !fields.datetime) {
        const translated = cronToTaskFields(cron);
        if (!translated) {
          res.writeHead(400); res.end(JSON.stringify({ error: `Unsupported cron expression "${cron}" — supported: "M H * * dow" (daily/weekly) or "*/N * * * *" (interval)` })); return true;
        }
        fields = { ...fields, ...translated };
      }
      const schedulable = Number(fields.intervalMs) > 0 || typeof fields.datetime === 'string'
        || (typeof fields.time === 'string' && /^\d{1,2}:\d{1,2}$/.test(fields.time.trim()));
      if (!schedulable) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Task needs a schedulable shape: time ("HH:MM"), intervalMs, datetime, or a supported cron' })); return true;
      }
      const task = await addTask({ label, agent, ...(cron != null ? { cron } : {}), ...fields, prompt, timezone, enabled, ownerId: authId });
      scheduleNewTask(task);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Natural-language task creation: form sends {agent, text}, plan model
  // turns it into a fully-shaped task. Same pipeline the chat path uses, but
  // forced past the regex filter since the user is explicitly in the create
  // form. Returns the new task on success, or {error} when parsing fails.
  if (req.url === '/api/tasks/parse' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) {
      const user = getUser(authId);
      if (Array.isArray(user?.allowedFeatures) && !user.allowedFeatures.includes('tasks')) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Task scheduling not enabled for your account' })); return true;
      }
    }
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || '').trim();
      const agent = String(body.agent || '').trim();
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'Empty prompt' })); return true; }
      const MAX_TASKS_PER_USER = 100;
      const existing = loadTasksForOwner(authId).length;
      if (existing >= MAX_TASKS_PER_USER) {
        res.writeHead(429); res.end(JSON.stringify({ error: `Task limit reached (${MAX_TASKS_PER_USER}). Delete some before adding more.` })); return true;
      }
      const before = new Set(loadTasksForOwner(authId).map(t => t.id));
      const result = await interceptScheduling({ userId: authId, agentId: agent || null, text, force: true });
      const created = loadTasksForOwner(authId).find(t => !before.has(t.id));
      if (created) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(created));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result?.outcome || 'Could not parse a schedule from that prompt. Try including a time, e.g. "in 5 minutes" or "every day at 9am".' }));
      }
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const taskMatch = req.url.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const t = findTaskById(taskMatch[1], authId);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    await removeTask(taskMatch[1]);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }
  if (taskMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const t = findTaskById(taskMatch[1], authId);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    try {
      const patch = JSON.parse(await readBody(req));
      // Re-enabling a task that was auto-disabled by the consecutive-failure
      // counter must clear the streak — otherwise the very next failure
      // bumps it from 5 to 6 and auto-disables again immediately. The user's
      // re-enable gesture says "I fixed it, try again," which is the same
      // semantic as a successful fire from the counter's perspective.
      if (patch.enabled === true && (t.consecutiveFailures || t.disabledReason)) {
        patch.consecutiveFailures = 0;
        patch.disabledReason = null;
      }
      await updateTask(taskMatch[1], patch);
      // Any field that affects firing needs the timer re-registered. For a
      // once-task that already ran, revising the datetime should also reopen
      // it — flip enabled and wipe lastRun unless the caller specified them.
      const touchesSchedule = 'datetime' in patch || 'time' in patch || 'cron' in patch || 'intervalMs' in patch;
      if (touchesSchedule && t.repeat === 'once' && t.lastRun && !('enabled' in patch)) {
        await updateTask(taskMatch[1], { enabled: true, lastRun: null });
      }
      if (touchesSchedule || 'enabled' in patch) {
        const updated = findTaskById(taskMatch[1], authId);
        if (updated) scheduleNewTask(updated);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // ── GET /api/tasks/:id/runs — per-task fire history (ok/error/skipped/late) ─
  // Owner-scoped via findTaskById (same fail-closed lookup the other task
  // routes use) so one user can't read another's run history by id-guessing.
  const taskRunsMatch = req.url.match(/^\/api\/tasks\/([^/?]+)\/runs$/);
  if (taskRunsMatch && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const id = decodeURIComponent(taskRunsMatch[1]);
    const t = findTaskById(id, authId);
    if (!t) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    const { loadTaskRuns } = await import('../lib/task-runs.mjs');
    const runs = loadTaskRuns(authId, id).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 200);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runs));
    return true;
  }

  // ── POST /api/tasks/:id/run — run a task NOW (manual test fire) ────────────
  // Manual flag: does NOT delete a one-shot or touch the consecutive-failure
  // counter, so testing a task can't disable or consume it. Streams to chat.
  const taskRunMatch = req.url?.match(/^\/api\/tasks\/([^/?]+)\/run$/);
  if (taskRunMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const t = findTaskById(decodeURIComponent(taskRunMatch[1]), authId);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    try {
      const { runTaskNow } = await import('../scheduler.mjs');
      // Fire-and-forget: the run streams into the agent's session over WS like a
      // scheduled fire. Respond immediately so the UI button doesn't hang on a
      // long agent turn.
      runTaskNow(t.id, authId).catch(e => console.warn('[tasks] manual run failed:', e?.message || e));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true, taskId: t.id }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // ── POST /api/tool-routing/preview — what the router would send ───────────
  // Inspect the per-turn tool trim for an agent + a sample message WITHOUT
  // running a turn. Used to verify/tune the tool-level router during testing.
  if (req.url === '/api/tool-routing/preview' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body?.text ?? '').slice(0, 2000);
      const agentId = String(body?.agentId ?? '');
      const agent = getAgentsForUser(authId).find(a => a.id === agentId);
      if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: `Unknown agent "${agentId}"` })); return true; }
      const { trimToolsForTurn } = await import('../lib/tool-router.mjs');
      const source = typeof body?.source === 'string' ? body.source : null;
      const trim = await trimToolsForTurn({ agent: { ...agent }, userText: text, userId: authId, source });
      const keptNames = (trim.trimmedTools ?? []).map(t => t.function?.name).filter(Boolean);
      const fullNames = (trim.fullTools ?? []).map(t => t.function?.name).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agentId, category: agent.skillCategory ?? null,
        fullCount: fullNames.length, keptCount: keptNames.length,
        kept: keptNames,
        dropped: fullNames.filter(n => !keptNames.includes(n)),
        decisions: trim.toolDecisions ?? null,
        notes: trim.routerNotes ?? [],
      }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Dashboard
  if (req.url === '/api/dashboard' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const [memoryCount, emailUnread] = await Promise.all([
      getMemoryStats(authId).catch(() => 0),
      getEmailUnreadCount(authId).catch(() => null),
    ]);
    const messagesUnread = loadThreads()
      .filter(t => t.participants.includes(authId) &&
        (t.messages ?? []).some(m => m.from !== authId && !(m.readBy ?? []).includes(authId)))
      .length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ memoryCount, emailUnread, messagesUnread }));
    return true;
  }

  // Notes — owner/admin share global file; user/child get per-user files
  function resolveNotesPath(userId) {
    const role = getUserRole(userId);
    if (role === 'owner' || role === 'admin') return NOTES_PATH;
    return path.join(getUserDir(userId), 'shared-notes.json');
  }
  function loadNotesForUser(userId) {
    const p = resolveNotesPath(userId);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    return { content: '', updatedAt: null, updatedBy: null };
  }
  function saveNotesForUser(userId, notes) {
    fs.writeFileSync(resolveNotesPath(userId), JSON.stringify(notes, null, 2));
  }

  if (req.url === '/api/notes' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const notes = loadNotesForUser(authId);
    const updaterName = notes.updatedBy ? (loadUsers().find(u => u.id === notes.updatedBy)?.name ?? notes.updatedBy) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...notes, updatedByName: updaterName }));
    return true;
  }

  if (req.url === '/api/notes' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string') throw new Error('content required');
      if (content.length > 65536) throw new Error('Notes too large (max 64KB)');
      const notes = { content, updatedAt: new Date().toISOString(), updatedBy: authId };
      const notesPath = resolveNotesPath(authId);
      await withLock(notesPath, () => saveNotesForUser(authId, notes));
      const updaterName = loadUsers().find(u => u.id === authId)?.name ?? authId;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...notes, updatedByName: updaterName }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // ── Threads (iMessage-style conversations) ────────────────────────────────────
  const threadBase = req.url === '/api/threads';

  if (threadBase && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const users = loadUsers();
    const getName  = id => users.find(u => u.id === id)?.name  ?? id;
    const getEmoji = id => users.find(u => u.id === id)?.emoji ?? '🧑';
    const result = loadThreads()
      .filter(t => t.participants.includes(authId))
      .map(t => {
        const msgs = t.messages ?? [];
        const last = msgs[msgs.length - 1] ?? null;
        const unread = msgs.filter(m => m.from !== authId && !(m.readBy ?? []).includes(authId)).length;
        const others = t.participants.filter(id => id !== authId);
        return {
          id: t.id,
          participants: t.participants,
          name: t.name,
          displayName: t.name ?? (others.length === 1 ? getName(others[0]) : others.map(getName).join(', ')),
          displayEmoji: others.length === 1 ? getEmoji(others[0]) : '👥',
          isGroup: t.participants.length > 2,
          lastMessage: last ? { from: last.from, fromName: getName(last.from), content: last.content, sentAt: last.sentAt } : null,
          unread,
          createdAt: t.createdAt,
        };
      })
      .sort((a, b) => (b.lastMessage?.sentAt ?? b.createdAt).localeCompare(a.lastMessage?.sentAt ?? a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (threadBase && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { participants, name, message } = JSON.parse(await readBody(req));
      if (!Array.isArray(participants) || participants.length === 0) throw new Error('participants required');
      const users = loadUsers();
      const validIds = new Set(users.map(u => u.id));
      const others = [...new Set(participants)].filter(id => id !== authId && validIds.has(id));
      if (others.length === 0) throw new Error('No valid participants');
      const allP = [authId, ...others].sort();
      const threads = loadThreads();
      let thread;
      if (others.length === 1 && !name) {
        thread = threads.find(t => t.participants.length === 2 && allP.every(id => t.participants.includes(id)));
      }
      if (!thread) {
        thread = { id: `thread_${Date.now()}`, participants: allP, name: name?.trim() || null, createdAt: new Date().toISOString(), createdBy: authId, messages: [] };
        threads.push(thread);
      }
      if (message?.trim()) {
        thread.messages.push({ id: `tmsg_${Date.now()}`, from: authId, content: message.trim(), sentAt: new Date().toISOString(), readBy: [authId] });
      }
      await saveThreads(threads);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: thread.id }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const threadMsgsMatch = req.url.match(/^\/api\/threads\/(thread_[\w]+)\/messages$/);
  if (threadMsgsMatch && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const threads = loadThreads();
    const t = threads.find(t => t.id === threadMsgsMatch[1]);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (!t.participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    const users = loadUsers();
    const getName = id => users.find(u => u.id === id)?.name ?? id;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify((t.messages ?? []).map(m => ({ ...m, fromName: getName(m.from), isMine: m.from === authId }))));
    return true;
  }

  if (threadMsgsMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string' || !content.trim()) throw new Error('content required');
      if (content.length > 10240) throw new Error('Message too large');
      const threads = loadThreads();
      const idx = threads.findIndex(t => t.id === threadMsgsMatch[1]);
      if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
      if (!threads[idx].participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
      const msg = { id: `tmsg_${Date.now()}`, from: authId, content: content.trim(), sentAt: new Date().toISOString(), readBy: [authId] };
      if (!threads[idx].messages) threads[idx].messages = [];
      threads[idx].messages.push(msg);
      await saveThreads(threads);
      const users = loadUsers();
      const fromName = users.find(u => u.id === authId)?.name ?? authId;
      const recipients = threads[idx].participants.filter(id => id !== authId);
      // Push to all other participants via WebSocket
      broadcastToUsers(recipients, {
        type: 'new_thread_message',
        threadId: threads[idx].id,
        message: { ...msg, fromName, isMine: false },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...msg, fromName, isMine: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const threadDeleteMatch = req.url.match(/^\/api\/threads\/(thread_[\w]+)$/);
  if (threadDeleteMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const threads = loadThreads();
    const idx = threads.findIndex(t => t.id === threadDeleteMatch[1]);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (!threads[idx].participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    threads[idx].participants = threads[idx].participants.filter(id => id !== authId);
    if (threads[idx].participants.length === 0) {
      threads.splice(idx, 1);
    }
    await saveThreads(threads);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }

  const threadReadMatch = req.url.match(/^\/api\/threads\/(thread_[\w]+)\/read$/);
  if (threadReadMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const threads = loadThreads();
    const idx = threads.findIndex(t => t.id === threadReadMatch[1]);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (!threads[idx].participants.includes(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    (threads[idx].messages ?? []).forEach(m => {
      if (!m.readBy) m.readBy = [];
      if (!m.readBy.includes(authId)) m.readBy.push(authId);
    });
    await saveThreads(threads);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }

  return false;
}
