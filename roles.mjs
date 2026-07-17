// @ts-check
/**
 * OpenEnsemble Roles Registry
 *
 * Discovers and loads skill modules from two locations:
 *   - /skills/{skillId}/           → global skills, visible to every user
 *   - /users/{userId}/skills/{id}/ → per-user custom skills, visible only to their creator
 *
 * Each skill has a manifest.json (metadata + tool schemas) and execute.mjs (executor).
 *
 * Internal keying:
 *   - Global skills:  key = "global:{skillId}"
 *   - User skills:    key = "user:{userId}:{skillId}"
 * This is invisible to callers — public functions take (id, userId?) and resolve internally.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync, cpSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import { SKILLS_DIR, CFG_PATH, USERS_DIR, userSkillsDir, getUserFilesDir, readConfig } from './lib/paths.mjs';
import { buildSkillCredentials } from './lib/credentials.mjs';
import { skillDeclaresNetwork } from './lib/skill-net-policy.mjs';
import { buildProposeMonitor, buildCollectionHelpers } from './lib/monitor-helper.mjs';
import { buildBrowserHelpers } from './lib/browser-helper.mjs';
import { buildDeviceHelpers, _registerVoiceContextResolver } from './lib/device-helper.mjs';
import { buildSkillLogger } from './lib/skill-logger.mjs';
import { recordDomainSkill } from './lib/memory-scope-context.mjs';
import { recordToolExecution } from './lib/tool-exec-log.mjs';
import { recordToolObservation } from './lib/personalization/recorder.mjs';
import { buildRegisterLead } from './lib/personalization/lead-helper.mjs';
import { buildSkillPersonalizationHelpers } from './lib/personalization/skill-helper.mjs';
import { getVoiceContext } from './lib/voice-context.mjs';
import { listDesktops, sendDesktopCommand } from './lib/desktop-bus.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';
import { registerScheduledChild, completeScheduledChild } from './lib/scheduled-child-barrier.mjs';
// One-time: hand the voice-context getter to device-helper so ctx.device.id()
// can resolve the current device sync.
_registerVoiceContextResolver(getVoiceContext);
import { mergeDefaults, recordPinUsage } from './lib/tool-defaults.mjs';
import { normalizeToolResult, toolError } from './lib/tool-error.mjs';
import { hasPendingPrompt } from './lib/credentials.mjs';
import { recordToolFailure } from './lib/tool-failures.mjs';
import { isSkillDisabled, getHiddenTools } from './lib/skill-overrides.mjs';
import {
  isEphemeralAgentId as _isEphem,
  cacheGet as _ephemCacheGet,
  cacheSet as _ephemCacheSet,
  rerankListResult as _ephemRerank,
  isListStyleTool as _ephemIsListTool,
} from './lib/ephemeral-tool-cache.mjs';
import { log } from './logger.mjs';
import { listAgents } from './agents.mjs';
import { normalizeOrchestrationPolicy } from './lib/orchestration-policy-core.mjs';
import { getTurnContext } from './lib/turn-abort-context.mjs';
import { currentTaskContext, runInTaskContext } from './lib/task-proxy-context.mjs';
import {
  abortError,
  createLinkedAbortController,
  isAbortError,
  raceWithAbort,
} from './lib/abort-utils.mjs';

// Resolve the agent id we should attribute background-task surfaces to
// (chip, session injection) when the caller didn't pass one. Uses the
// user's configured coordinator agent — works regardless of what each
// user named their coordinator. Falls back to userId only if the user has
// no coordinator assigned (edge case during onboarding).
async function _resolveAttributionAgent(userId, agentId) {
  if (agentId) return agentId;
  try {
    const { getUserCoordinatorAgentId } = await import('./routes/_helpers.mjs');
    const coordId = getUserCoordinatorAgentId(userId);
    return coordId ? `${userId}_${coordId}` : userId;
  } catch { return userId; }
}

function _agentIdFromSessionKey(sessionKey, userId) {
  const raw = String(sessionKey || '');
  const prefix = `${userId}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

async function _emitAutoBgNotify(userId, agentId, notify) {
  if (!userId || !agentId || !notify) return;
  try {
    const { emitAgentNotification } = await import('./ws-handler.mjs');
    emitAgentNotification(userId, _agentIdFromSessionKey(agentId, userId), notify);
  } catch (_) { /* best-effort */ }
}

// Drain an async iterator after executeToolStreaming has already read the
// event that crossed the foreground -> background threshold. The boundary
// value belongs to the detached sink just as much as every later value; losing
// it is especially damaging when it is the terminal result (and therefore the
// only carrier for structured artifacts such as `_images`).
export async function drainIteratorIncludingBoundary(iter, boundaryValue, visit) {
  await visit(boundaryValue);
  while (true) {
    const next = await iter.next();
    if (next.done) return;
    await visit(next.value);
  }
}

// Tools whose background completion warrants waking the owning agent with a
// concise report-back turn. Most auto-backgrounded tools just drop their
// result into the task chip + agent_report bubble — the user already sees it,
// so a second LLM turn would be redundant and costly. The tools here are the
// long-running shell/command ones whose raw output the agent must interpret to
// continue its workflow (run tests → read failures → fix; apt upgrade → human
// go/no-go) — without this the agent in a DIRECT chat silently stalls mid-task
// when the command crosses the auto-bg threshold. Add a tool here only when its
// result genuinely needs the agent to react. Domain-specific behavior (how to
// summarize, what to ask) belongs in the owning skill's systemPromptAddition,
// NOT the continuation prompt below.
const BG_REPORT_TOOLS = new Set(['node_exec', 'coder_run_command', 'desktop_run_command']);

async function _runAutoBgToolContinuation({ userId, agentId, toolName, args, resultText, errorMsg = null }) {
  if (!userId || !agentId) return;
  if (_isEphem(agentId)) return;
  if (!BG_REPORT_TOOLS.has(toolName)) return;
  const targetAgentId = _agentIdFromSessionKey(agentId, userId);
  if (!targetAgentId) return;
  const prompt = [
    'A background tool call you started has completed. Continue the original user workflow for THIS completed tool only.',
    '',
    `<background_tool name="${toolName}">`,
    `<args>${JSON.stringify(args ?? {})}</args>`,
    errorMsg ? `<error>${errorMsg}</error>` : `<result>${resultText || ''}</result>`,
    '</background_tool>',
    '',
    'Give the user a concise completion update based on this result, following any guidance in your system instructions for this kind of task. Do not take further actions or make changes unless the user explicitly confirms.',
  ].join('\n');
  try {
    const { handleChatMessage } = await import('./chat-dispatch.mjs');
    const { sendToUser } = await import('./ws-handler.mjs');
    await handleChatMessage({
      userId,
      agentId: targetAgentId,
      text: prompt,
      attachment: null,
      source: /** @type {'voice-device'|'web'|'telegram'|'desktop-app'} */ (getVoiceContext()?.source || 'web'),
      onEvent: (e) => sendToUser(userId, e),
      onBroadcast: () => {},
      onNotify: () => {},
      _hiddenUser: true,
      _isBackgroundContinuation: true,
      // This turn exists only to interpret already-finished command output.
      // Enforce the prompt's "do not take further actions" rule structurally
      // so a model cannot turn a report-back into an uncorrelated side effect.
      toolPlan: { mode: 'none' },
      _readOnlyTurn: true,
    });
  } catch (e) {
    log.warn('tool', 'auto-bg continuation failed', { tool: toolName, userId, agentId: targetAgentId, err: e?.message || String(e) });
  }
}

function _autoBgChildId(watcherId) {
  return watcherId ? `autobg_${watcherId}` : null;
}

/**
 * Race one (and only one) async-iterator read against an auto-background
 * boundary. A timeout returns the original promise so ownership can move to a
 * detached drain without issuing a second iter.next().
 */
export async function racePendingIteratorNext(pendingNext, timeoutMs, signal = null) {
  let timeoutId;
  try {
    return await raceWithAbort(
      Promise.race([
        pendingNext.then(
          next => ({ kind: 'next', next }),
          error => ({ kind: 'error', error }),
        ),
        new Promise(resolve => {
          timeoutId = setTimeout(() => resolve({ kind: 'timeout', pendingNext }), Math.max(0, timeoutMs));
        }),
      ]),
      signal,
      'Tool execution cancelled',
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Do not detach a tool a second time when a durable task already owns it. */
export function autoBackgroundToolsInCurrentContext() {
  return currentTaskContext() == null
    && getTurnContext()?.awaitSlowTools !== true;
}

let _autoBackgroundDelayForTest = null;

/** Narrow deterministic seam for slow-tool ownership tests. */
export function setAutoBackgroundDelayForTest(delayMs = null) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('auto-background delay test seam is unavailable');
  }
  _autoBackgroundDelayForTest = delayMs == null
    ? null
    : Math.max(1, Number(delayMs) || 1);
}

function _autoBackgroundDelayMs(suppressLearning) {
  if (_autoBackgroundDelayForTest != null) return _autoBackgroundDelayForTest;
  return suppressLearning ? 600_000 : 10_000;
}

const AUTO_BG_REPORT_TEXT_MAX = 4_000;
const AUTO_BG_WATCHER_TEXT_MAX = 1_200;

/**
 * Classify a detached completion once so every durable and live surface uses
 * the same terminal status. In particular, ctx.toolError() and legacy
 * `Error: ...` results must never be journaled or displayed as success.
 */
export function normalizeAutoBgCompletion(value, displayName = 'Tool') {
  const structured = value && typeof value === 'object' && typeof value.text === 'string';
  const normalized = normalizeToolResult(structured ? value.text : String(value ?? ''));
  const isError = value?.isError === true || normalized.isError;
  const text = String(normalized.text ?? '').slice(0, AUTO_BG_REPORT_TEXT_MAX);
  const content = text || (isError ? 'Tool error: Tool failed' : `${displayName} completed.`);
  const status = isError ? 'error' : 'done';
  return {
    text,
    content,
    isError,
    status,
    watcherFinalText: isError
      ? `⚠ ${displayName} failed: ${content.slice(0, AUTO_BG_WATCHER_TEXT_MAX)}`
      : `✓ ${displayName} done${text ? `: ${text.slice(-AUTO_BG_WATCHER_TEXT_MAX)}` : ''}`,
    observation: { resultText: text, ok: !isError },
    report: { content, status },
    scheduled: {
      resultText: isError ? '' : content,
      errorMsg: isError ? content : null,
    },
    continuation: {
      resultText: isError ? '' : content,
      errorMsg: isError ? content : null,
    },
    images: structured && Array.isArray(value._images) ? value._images : null,
    notify: structured && value._notify ? value._notify : null,
  };
}

function _registerScheduledAutoBgChild({ scheduledCtx, userId, watcherId, label, kind = 'tool', cancel = null }) {
  if (!scheduledCtx?.originTaskId || !watcherId) return null;
  return registerScheduledChild({
    userId,
    scheduledCtx,
    childId: _autoBgChildId(watcherId),
    label,
    kind,
    cancel,
  });
}

// Mark an auto-backgrounded tool's barrier child done. The scheduled-task
// reaction + finalize are driven by the barrier (see scheduler.runTask), so
// this just records completion; it's a no-op outside a scheduled run.
function _completeScheduledAutoBgChild({ scheduledCtx, userId, watcherId, resultText, errorMsg = null }) {
  if (!scheduledCtx?.originTaskId || !watcherId) return;
  completeScheduledChild({
    userId,
    scheduledCtx,
    childId: _autoBgChildId(watcherId),
    resultText,
    errorMsg,
  });
}

async function _emitAutoBgToolReport({
  userId,
  agentId,
  toolName,
  displayName = null,
  displayEmoji = '⏵',
  watcherId,
  rootWatcherId = null,
  targetAgentId = null,
  content,
  status = 'done',
  images = null,
  notify = null,
}) {
  if (!userId || !watcherId) return;
  const name = displayName || toolName || 'Tool';
  const body = String(content || `${name} completed.`).slice(0, 4000);
  const key = agentId
    ? (String(agentId).startsWith(`${userId}_`) ? String(agentId) : `${userId}_${agentId}`)
    : null;
  const ts = Date.now();
  const report = {
    role: 'assistant',
    kind: 'agent_report',
    agentName: name,
    agentEmoji: displayEmoji || '⏵',
    ...(targetAgentId ? { targetAgentId } : {}),
    content: body,
    taskId: `autobg_${watcherId}`,
    watcherId,
    rootWatcherId: rootWatcherId || watcherId,
    tool: toolName,
    status,
    ...(images ? { images } : {}),
    ...(notify ? { notify } : {}),
    ts,
  };
  if (key) {
    try {
      const { appendToSession } = await import('./sessions.mjs');
      await appendToSession(key, report);
    } catch (_) { /* best-effort */ }
  }
  try {
    const { sendToUser } = await import('./ws-handler.mjs');
    sendToUser(userId, {
      type: 'agent_report',
      agent: key || agentId || null,
      agentName: report.agentName,
      agentEmoji: report.agentEmoji,
      ...(targetAgentId ? { targetAgentId } : {}),
      content: body,
      ...(images ? { images } : {}),
      ...(notify ? { notify } : {}),
      taskId: report.taskId,
      watcherId,
      rootWatcherId: report.rootWatcherId,
      tool: toolName,
      status,
      ts,
    });
  } catch (_) { /* best-effort */ }
  await _emitAutoBgNotify(userId, key || agentId, notify);
}

// Wrapper shape: { manifest, userId, dir }
//   userId: null for global, userId string for per-user
//   dir:    absolute path to the skill directory on disk
const _manifests    = new Map();  // internalKey -> wrapper
const _executors    = new Map();  // internalKey -> execute function
const _executorBust = new Map();  // internalKey -> bust timestamp

const globalKey = id => `global:${id}`;
const userKey   = (uid, id) => `user:${uid}:${id}`;

// Try resolving an id in the user's scope first, then globally. Returns internalKey or null.
function resolveKey(id, userId) {
  if (userId) {
    const uk = userKey(userId, id);
    if (_manifests.has(uk)) return uk;
  }
  const gk = globalKey(id);
  if (_manifests.has(gk)) return gk;
  return null;
}

// Iterate entries visible to a given caller: globals + that user's own skills.
// Used by execution paths so a user can never reach another user's tool.
function* visibleEntries(userId) {
  for (const [key, wrap] of _manifests) {
    if (wrap.userId === null || wrap.userId === userId) yield [key, wrap];
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

// Load all manifests synchronously — called once at startup from server.mjs.
// Isolated lab copies are read-only fixtures: skip every startup migration so
// verifier boot cannot rewrite copied profiles, assignments, or config.
export function loadRoleManifests({
  runMigrations = process.env.OPENENSEMBLE_LAB !== '1',
} = {}) {
  _manifests.clear();

  // Pass 1: global skills
  if (existsSync(SKILLS_DIR)) {
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(SKILLS_DIR, entry.name);
      const mPath = path.join(dir, 'manifest.json');
      if (!existsSync(mPath)) continue;
      try {
        const m = JSON.parse(readFileSync(mPath, 'utf8'));
        const id = m.id ?? entry.name;
        _manifests.set(globalKey(id), { manifest: m, userId: null, dir });
      } catch (e) {
        console.warn(`[roles] Failed to load global manifest for ${entry.name}:`, e.message);
      }
    }
  }

  // Migration runs between the two passes: globals are loaded (needed for the
  // profile-cleanup logic to recognize global ids), then any legacy /skills/usr_*
  // entries get moved into /users/{createdBy}/skills/{slug} before Pass 2 picks them up.
  if (runMigrations) {
    try { migrateLegacyUserSkills(); }
    catch (e) { console.warn('[migrate] Legacy user skill migration failed:', e.message); }
  }

  // Pass 2: per-user custom skills
  if (existsSync(USERS_DIR)) {
    for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const uid = entry.name;
      // Skip junk / validation directories that have no profile.json
      if (!existsSync(path.join(USERS_DIR, uid, 'profile.json'))) continue;
      const skillRoot = userSkillsDir(uid);
      if (!existsSync(skillRoot)) continue;
      for (const sEntry of readdirSync(skillRoot, { withFileTypes: true })) {
        if (!sEntry.isDirectory()) continue;
        const dir = path.join(skillRoot, sEntry.name);
        const mPath = path.join(dir, 'manifest.json');
        if (!existsSync(mPath)) continue;
        try {
          const m = JSON.parse(readFileSync(mPath, 'utf8'));
          const id = m.id ?? sEntry.name;
          if (!m.createdBy) m.createdBy = uid;  // stamp ownership if missing
          _manifests.set(userKey(uid, id), { manifest: m, userId: uid, dir });
        } catch (e) {
          console.warn(`[roles] Failed to load user manifest for ${uid}/${sEntry.name}:`, e.message);
        }
      }
    }
  }

  // Alias-framework: scan every loaded manifest for an `alias_catalog` block
  // and register a resolver for each. Done after both passes so user-skill
  // declarations are picked up alongside global ones. Lazy-imports the
  // framework so installs without it (none today) still boot cleanly.
  try {
    import('./lib/skill-alias-framework.mjs').then(async (fw) => {
      const allManifests = [..._manifests.values()]
        .map(v => ({ ...v.manifest, userScope: v.userId }));
      const importerFor = (skillId, declaredScope, catalogUserId) => {
        const entry = declaredScope
          ? _manifests.get(userKey(declaredScope, skillId))
          : _manifests.get(globalKey(skillId));
        if (!entry) return Promise.resolve({});
        return importAliasCatalogModule(entry, catalogUserId);
      };
      fw.registerFromManifests(allManifests, importerFor);

      // Lockdown migration (one-shot per user): every CUSTOM skill that
      // currently has no entry in the user's skillAssignments gets pinned
      // to that user's coordinator. Preserves today's effective behavior —
      // coordinators see the user's custom skills as before — while shutting
      // off the auto-bypass to specialists that was added in agent-resolver
      // (commit "lockdown specialist toolset"). After this runs once,
      // newly-created skills go through skill-builder's `assign_to` flow,
      // and existing skills can be reassigned via setRoleAssignment.
      if (runMigrations) try {
        const { getUserCoordinatorAgentId } = await import('./routes/_helpers.mjs');
        const seenUsers = new Set();
        for (const wrap of _manifests.values()) {
          const m = wrap.manifest;
          if (!m?.custom || !wrap.userId) continue;
          if (seenUsers.has(wrap.userId + ':' + m.id)) continue;
          seenUsers.add(wrap.userId + ':' + m.id);
          const assignments = getRoleAssignments(wrap.userId) || {};
          if (assignments[m.id]) continue;  // already assigned somewhere
          const coordId = getUserCoordinatorAgentId(wrap.userId);
          if (!coordId) continue;
          setRoleAssignment(m.id, coordId, wrap.userId);
          console.log(`[roles] lockdown-migration: assigned custom skill "${m.id}" to coordinator "${coordId}" for user ${wrap.userId}`);
        }
      } catch (e) { console.warn('[roles] lockdown-migration failed:', e.message); }

      // Cleanup: an earlier iteration tried to make active-agents and
      // skill-builder user-assignable (with a Settings UI dropdown). That
      // was the wrong model — they're inherent to the coordinator and coder
      // roles, not separately-assignable. The current design uses
      // `bundled_with_role` in the manifest (see resolveAgentTools). Strip
      // any leftover skillAssignments entries so they don't ghost in the UI.
      if (runMigrations) try {
        const { loadUsers, modifyUser } = await import('./routes/_helpers.mjs');
        const stale = ['active-agents', 'skill-builder'];
        // Owner / admin scoped assignments live in config.json.
        try {
          const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
          let dirty = false;
          for (const skillId of stale) {
            if (cfg.skillAssignments?.[skillId]) {
              delete cfg.skillAssignments[skillId];
              dirty = true;
              console.log(`[roles] cleanup: removed stale skillAssignments["${skillId}"] from config.json`);
            }
          }
          if (dirty) writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
        } catch (e) { console.debug('[roles] cleanup: config.json read/write skipped:', e.message); }
        // Plain-user scoped assignments live in users/<id>/profile.json.
        for (const u of loadUsers()) {
          if (!u.skillAssignments) continue;
          const needsClean = stale.some(k => u.skillAssignments[k]);
          if (!needsClean) continue;
          modifyUser(u.id, p => {
            for (const skillId of stale) delete p.skillAssignments?.[skillId];
          });
          console.log(`[roles] cleanup: removed stale scoped-tool assignments for user ${u.id}`);
        }
      } catch (e) { console.warn('[roles] scoped-tools-cleanup failed:', e.message); }

      // System-level "agent" catalog — no skill manifest owns agents, so
      // we register a runtime spec with an inline function that calls
      // getAgentsForUser. Same shape as a manifest-declared catalog but
      // the listEntries is a JS function, not a config-file path.
      try {
        const { getAgentsForUser } = await import('./routes/_helpers/agent-resolver.mjs');
        fw.registerAliasCatalog({
          entity_kind:   'agent',
          noun_singular: 'agent',
          noun_plural:   'agents',
          extra_phrase_patterns: [
            "\\bask\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\b",
            "\\btalk\\s+to\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\b",
            "\\btell\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\s+to\\b",
            "\\bdelegate\\s+(?:this\\s+)?to\\s+([A-Za-z][A-Za-z0-9 _-]{1,30})\\b",
          ],
          catalog_source: {
            type: 'inline_function',
            fn: (userId) => {
              const agents = getAgentsForUser(userId) || [];
              return agents.map(a => ({
                id: a.id,
                name: a.name || a.id,
                role: a.role || a.skillCategory || 'specialist',
                description: a.description || '',
              }));
            },
          },
          id_field:     'id',
          name_fields:  ['name', 'id'],
          id_arg_names: ['agent_id', 'agentId'],
          cascade_on_tools: [],
        }, null);
      } catch (e) { console.warn('[roles] agent-alias system register failed:', e.message); }
    }).catch(e => console.warn('[roles] alias-framework boot register failed:', e.message));
  } catch (e) { /* framework optional */ }
}

// ── Legacy migration: /skills/usr_* → /users/{createdBy}/skills/{slug} ────────

function migrateLegacyUserSkills() {
  if (!existsSync(SKILLS_DIR)) return;
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('usr_')) continue;
    const oldDir = path.join(SKILLS_DIR, entry.name);
    const manifestPath = path.join(oldDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (e) { console.warn(`[migrate] Failed to read ${manifestPath}:`, e.message); continue; }
    const createdBy = manifest.createdBy;
    if (!createdBy) {
      console.warn(`[migrate] ⚠️  /skills/${entry.name}: no createdBy field — leaving in place`);
      continue;
    }
    if (!existsSync(path.join(USERS_DIR, createdBy))) {
      console.warn(`[migrate] ⚠️  /skills/${entry.name}: createdBy=${createdBy} but /users/${createdBy} not found — leaving in place`);
      continue;
    }
    const slug = entry.name.replace(/^usr_/, '');
    const newParent = userSkillsDir(createdBy);
    const newDir = path.join(newParent, slug);
    if (existsSync(newDir)) {
      console.warn(`[migrate] ⏭  /users/${createdBy}/skills/${slug} already exists — skipping /skills/${entry.name}`);
      continue;
    }
    try {
      mkdirSync(newParent, { recursive: true });
      try { renameSync(oldDir, newDir); }
      catch (e) {
        if (e.code === 'EXDEV') {
          cpSync(oldDir, newDir, { recursive: true });
          rmSync(oldDir, { recursive: true, force: true });
        } else throw e;
      }
      // Rewrite manifest with stripped id so on-disk id matches the new slug
      const newManifest = { ...manifest, id: slug };
      writeFileSync(path.join(newDir, 'manifest.json'), JSON.stringify(newManifest, null, 2));
      // Drop the stale entry from the global manifests map (it was loaded in Pass 1)
      _manifests.delete(globalKey(entry.name));
      console.log(`[migrate] /skills/${entry.name} → /users/${createdBy}/skills/${slug}`);
    } catch (e) {
      console.warn(`[migrate] Failed to migrate /skills/${entry.name}:`, e.message);
    }
  }

  // Cross-user profile cleanup: drop stale usr_* references and rewrite self-owned to new slug.
  // Guarded per-user by a .migrated marker file so it only runs once.
  if (!existsSync(USERS_DIR)) return;
  for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    const profilePath = path.join(USERS_DIR, uid, 'profile.json');
    if (!existsSync(profilePath)) continue;
    const skillRoot = userSkillsDir(uid);
    const marker = path.join(skillRoot, '.migrated');
    if (existsSync(marker)) continue;
    try {
      const user = JSON.parse(readFileSync(profilePath, 'utf8'));
      const ownedIds = existsSync(skillRoot)
        ? readdirSync(skillRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        : [];
      const ownedSet = new Set(ownedIds);
      const isGlobal = id => _manifests.has(globalKey(id));

      const before = Array.isArray(user.skills) ? [...user.skills] : null;
      if (before) {
        user.skills = before
          .map(s => s.startsWith('usr_') ? s.replace(/^usr_/, '') : s)
          .filter(s => isGlobal(s) || ownedSet.has(s));
      }

      if (user.skillAssignments && typeof user.skillAssignments === 'object') {
        const next = {};
        for (const [sid, agent] of Object.entries(user.skillAssignments)) {
          const key = sid.startsWith('usr_') ? sid.replace(/^usr_/, '') : sid;
          if (isGlobal(key) || ownedSet.has(key)) next[key] = agent;
        }
        user.skillAssignments = next;
      }

      if (before) {
        const after = user.skills ?? [];
        const removed = before.filter(s => {
          const rewritten = s.startsWith('usr_') ? s.replace(/^usr_/, '') : s;
          return !after.includes(rewritten);
        });
        if (removed.length) console.log(`[migrate] ${uid}: cleaned user.skills (removed: ${removed.join(', ')})`);
      }
      writeFileSync(profilePath, JSON.stringify(user, null, 2));
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    } catch (e) {
      console.warn(`[migrate] Failed to clean profile for ${uid}:`, e.message);
    }
  }
}

// ── Public registry API ───────────────────────────────────────────────────────

/**
 * Tools a remembered "selected" tool plan may never drop, as declared by skill
 * manifests (`"selected_plan_keep": ["save_research", ...]`). Lets a skill
 * protect its role-critical tools from stale recipes without a chat.mjs edit.
 *
 * When `selectedToolNames` is supplied, only declarations from manifests that
 * own at least one selected tool are returned. That distinction matters for a
 * singleton coordinator: it holds every user's tools, so a global union would
 * preserve unrelated actions on every remembered plan. Traditional scoped
 * agents retain the legacy all-manifest union by omitting the first argument.
 */
export function getSelectedPlanKeepTools(selectedToolNames = null, userId = null) {
  const selected = selectedToolNames == null
    ? null
    : new Set(Array.from(selectedToolNames).filter(t => typeof t === 'string' && t));
  const visible = [..._manifests.values()]
    .filter(wrap => !userId || wrap?.userId === null || wrap?.userId === userId);
  // Execution and schema assembly resolve duplicate names by registry order.
  // Mirror that first-owner rule so a later custom manifest cannot expand the
  // retained terminal surface merely by repeating a selected tool name.
  const eligible = selected
    ? [...selected].map(name => visible.find(wrap =>
        (Array.isArray(wrap?.manifest?.tools) ? wrap.manifest.tools : [])
          .some(tool => (tool?.function?.name ?? tool?.name) === name)))
        .filter(Boolean)
    : visible;
  const keep = new Set();
  for (const wrap of new Set(eligible)) {
    const manifest = wrap?.manifest;
    const manifestToolNames = new Set((Array.isArray(manifest?.tools) ? manifest.tools : [])
      .map(tool => tool?.function?.name ?? tool?.name).filter(Boolean));
    const arr = manifest?.selected_plan_keep;
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (typeof t === 'string' && t && manifestToolNames.has(t)) keep.add(t);
      }
    }
  }
  return keep;
}

/** Return all skill manifests visible to `userId` — globals + that user's own skills. */
export function listRoles(userId = null) {
  const out = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId === null || wrap.userId === userId) {
      if (userId && !isSkillAllowedForUser(wrap.manifest.id, userId)) continue;
      // Phase-10: user can disable any non-always_on skill. The override is
      // read at runtime from disk — manifests stay immutable in the cache.
      if (userId && isSkillDisabled(userId, wrap.manifest.id, !!wrap.manifest.always_on)) continue;
      // userScope: null = global skill, <userId> = user-scoped custom skill.
      // Surfaced so admin UIs can filter out user-scoped skills when rendering
      // cross-user permission grids — granting another user access to a
      // user-scoped skill is a no-op since the registry won't yield it to them.
      out.push({ ...wrap.manifest, userScope: wrap.userId });
    }
  }
  return out;
}

/** Return every manifest in the registry regardless of ownership. For admin/debug use only. */
export function listAllRoles() {
  return [..._manifests.values()].map(w => w.manifest);
}

/** Look up a manifest by id. Tries the user scope first, then globals. */
export function getRoleManifest(id, userId = null) {
  const key = resolveKey(id, userId);
  return key ? _manifests.get(key).manifest : null;
}

/** Add or replace a manifest. If `userId` is given, stores as a per-user skill. */
export function addRoleManifest(manifest, userId = null) {
  const id = manifest.id;
  const key = userId ? userKey(userId, id) : globalKey(id);
  const previousAliasKind = _manifests.get(key)?.manifest?.alias_catalog?.entity_kind ?? null;
  let dir;
  if (userId) {
    dir = path.join(userSkillsDir(userId), id);
    _manifests.set(key, { manifest, userId, dir });
  } else {
    dir = path.join(SKILLS_DIR, id);
    _manifests.set(key, { manifest, userId: null, dir });
  }
  // Register the alias catalog if this manifest declares one. Mirrors the
  // boot-time registration in loadRoleManifests so newly-created skills
  // (via skill-builder skill_create) pick up alias support immediately.
  if (previousAliasKind || manifest.alias_catalog) {
    import('./lib/skill-alias-framework.mjs').then(fw => {
      const wrap = _manifests.get(key);
      const importer = (catalogUserId) => importAliasCatalogModule(wrap, catalogUserId);
      // Remove the old registration before considering the replacement. An
      // update may change entity_kind or remove alias_catalog entirely.
      if (previousAliasKind) {
        try { fw.unregisterAliasCatalog(previousAliasKind, userId); } catch {}
      }
      if (manifest.alias_catalog) {
        try { fw.unregisterAliasCatalog(manifest.alias_catalog.entity_kind, userId); } catch {}
        fw.registerAliasCatalog(manifest.alias_catalog, importer, { userScope: userId, skillId: id });
      }
    }).catch(e => console.warn('[roles] alias-framework register failed:', e.message));
  }
}

/** Remove a manifest from the registry. Pass `userId` to target a per-user skill. */
export function removeRoleManifest(id, userId = null) {
  const key = userId ? userKey(userId, id) : globalKey(id);
  const entry = _manifests.get(key);
  // Drop the alias-framework registration BEFORE clearing the manifest so we
  // can read the entity_kind off the about-to-be-removed entry. Without this,
  // a deleted skill's alias resolver keeps trying to load its catalog on
  // every chat turn and logs a noisy file-not-found.
  if (entry?.manifest?.alias_catalog?.entity_kind) {
    import('./lib/skill-alias-framework.mjs')
      .then(fw => fw.unregisterAliasCatalog(entry.manifest.alias_catalog.entity_kind, userId))
      .catch(() => {});
  }
  _manifests.delete(key);
  _executors.delete(key);
  _executorBust.delete(key);
}

/** Clear an executor cache entry so the next call re-imports fresh code. */
export function clearExecutorCache(skillId, userId = null) {
  const key = resolveKey(skillId, userId);
  if (!key) return;
  _executors.delete(key);
  _executorBust.set(key, Date.now());
}

export function getRoleTools(id, userId = null) {
  if (userId && !isSkillAllowedForUser(id, userId)) return [];
  const manifest = getRoleManifest(id, userId);
  if (userId && manifest && isSkillDisabled(userId, id, !!manifest.always_on)) return [];
  const tools = manifest?.tools ?? [];
  // Phase-10: per-user hidden-tools filter. Removes any tool whose
  // function.name appears in users/<id>/skill-overrides.json[id].hiddenTools.
  if (userId && tools.length) {
    const hidden = getHiddenTools(userId, id);
    if (hidden.length) {
      const set = new Set(hidden);
      return tools.filter(t => !set.has(t?.function?.name));
    }
  }
  return tools;
}

export function getToolsForRoleIds(roleIds, userId = null) {
  return roleIds.flatMap(id => getRoleTools(id, userId));
}

// ── Role Assignments ──────────────────────────────────────────────────────────
// The installation owner keeps the legacy global assignment map in config.json.
// Every other account is per-profile. Admins created by older builds may still
// rely on the global map, so reads merge it as a fallback until that admin has
// its own overrides; new writes always go to the admin profile. This prevents
// one admin's first-assistant onboarding from replacing the owner's coordinator.
function _isOwnerRole(role) { return role === 'owner'; }

function _readGlobalAssignments() {
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf8')).skillAssignments ?? {}; }
  catch { return {}; }
}

// null = unrestricted; Set = the complete account-level capability ceiling.
// Missing/unreadable profiles are fail-closed. Children require an explicit
// array. Regular users retain legacy unrestricted behavior only when the field
// is null/absent; once an array is present it is authoritative, including [].
function _allowedSkillIdsForProfile(user) {
  if (!user) return new Set();
  if (user.role === 'owner' || user.role === 'admin') return null;
  if (Array.isArray(user.allowedSkills)) return new Set(user.allowedSkills);
  if (user.role === 'child') return new Set();
  return user.allowedSkills == null ? null : new Set();
}

export function getRoleAssignments(userId) {
  const user = userId ? _readUserProfile(userId) : null;
  let raw;
  if (_isOwnerRole(user?.role) || !userId) {
    raw = _readGlobalAssignments();
  } else if (user?.role === 'admin') {
    raw = { ..._readGlobalAssignments(), ...(user.skillAssignments ?? {}) };
  } else {
    raw = user?.skillAssignments ?? {};
  }
  const allowed = userId ? _allowedSkillIdsForProfile(user) : null;
  if (allowed) {
    // An assignment is ownership metadata, never a second capability grant.
    // Keep the coordinator pointer solely for routing; tool resolution still
    // requires the coordinator skill itself before exposing its schemas.
    raw = Object.fromEntries(Object.entries(raw).filter(([skillId]) =>
      skillId === 'coordinator' || allowed.has(skillId)));
  }
  return _projectAssignmentsForOrchestration(user, raw);
}

// Stored assignment lookup with account authorization but WITHOUT single-mode
// projection. Durable background work uses this to follow its real specialist
// when an ensemble is restored, while ordinary runtime consumers continue to
// use getRoleAssignments() above.
export function getDurableRoleAssignment(roleId, userId) {
  const user = userId ? _readUserProfile(userId) : null;
  let raw;
  if (_isOwnerRole(user?.role) || !userId) raw = _readGlobalAssignments();
  else if (user?.role === 'admin') raw = { ..._readGlobalAssignments(), ...(user.skillAssignments ?? {}) };
  else raw = user?.skillAssignments ?? {};
  const allowed = userId ? _allowedSkillIdsForProfile(user) : null;
  if (allowed && roleId !== 'coordinator' && !allowed.has(roleId)) return null;
  return typeof raw?.[roleId] === 'string' && raw[roleId] ? raw[roleId] : null;
}

/**
 * Choose the durable owner stored on a newly-created watcher. While single
 * mode is active, the executor is running under the projected primary even
 * when the enclosing skill is still assigned to a parked specialist. Store
 * that raw specialist target so switching back to ensemble restores the
 * intended owner without rewriting watcher records. Generic/non-skill work
 * follows the symbolic coordinator target instead.
 */
export async function resolveWatcherRegistrationAgentId(userId, currentAgentId, skillId = null) {
  const { getOrchestrationPolicy } = await import('./lib/orchestration-policy.mjs');
  if (getOrchestrationPolicy(userId).mode !== 'single') return currentAgentId;
  if (skillId) {
    const durableOwner = getDurableRoleAssignment(skillId, userId);
    const validOwner = durableOwner && listAgents().some(agent =>
      agent?.ownerId === userId && agent?.id === durableOwner);
    if (validOwner) return `${userId}_${durableOwner}`;
  }
  return `${userId}_coordinator`;
}

/**
 * Read-time orchestration projection (single-agent-mode plan §3.1/D5): when a
 * user's stored policy is single mode, every consumer of role assignments —
 * tool resolution, memory scoping (getAgentAssignedSkills), fastpath rights,
 * coordinator lookup — sees every assigned AND enabled skill as belonging to
 * the primary agent. The stored assignments are never rewritten, so switching
 * back to ensemble restores the exact previous layout.
 *
 * Policy semantics (missing/malformed → no projection) mirror
 * lib/orchestration-policy.mjs, which is canonical. Duplicated inline rather
 * than imported because this is a hot synchronous path already holding the
 * parsed profile, and roles.mjs sits below that module in the import graph.
 */
function _projectAssignmentsForOrchestration(user, raw) {
  const ownedAgents = user?.id ? listAgents().filter(agent => agent.ownerId === user.id) : [];
  const orch = normalizeOrchestrationPolicy(user?.orchestration, ownedAgents);
  const primary = orch.primaryAgentId;
  if (orch.mode !== 'single' || !primary) return raw;
  const projected = {};
  // A child profile's allowedSkills is the permission boundary, including for
  // stale/admin-written assignments. An assignment describes ownership; it is
  // not a second way to grant a capability. Keep the synthetic coordinator
  // assignment below for internal routing, but tool resolution independently
  // requires the coordinator skill itself to be allowed before exposing any of
  // its schemas.
  const allowed = _allowedSkillIdsForProfile(user);
  for (const skillId of Object.keys(raw)) {
    if (skillId !== 'coordinator' && (!allowed || allowed.has(skillId))) projected[skillId] = primary;
  }
  // Enabled skills expand onto the primary, but never beyond the account's
  // allowedSkills scope. enabled_by_default skills are backfilled into
  // `skills` for everyone, and without this intersection a restricted
  // account's primary would receive schemas that no ensemble agent carried.
  const enabledSkills = new Set([
    ...getDefaultRoles(),
    ...(Array.isArray(user.skills) ? user.skills : []),
  ]);
  for (const skillId of enabledSkills) {
    const manifest = getRoleManifest(skillId, user?.id);
    const runtimeEnabled = !manifest || isSkillRuntimeEnabledForUser(skillId, user?.id);
    if (runtimeEnabled && (!allowed || allowed.has(skillId))) projected[skillId] = primary;
  }
  projected.coordinator = primary;
  return projected;
}

export function getRoleAssignment(roleId, userId) {
  return getRoleAssignments(userId)[roleId] ?? null;
}

/**
 * Return all service role ids currently held by a given agent for this user.
 * Accepts either a scoped agent id ("user_XYZ_coder") or a bare one ("coder").
 * Only `service: true` roles are returned — delegate/system roles are skipped.
 */
export function getAgentRoles(agentId, userId) {
  if (!agentId) return [];
  const bare = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const assignments = getRoleAssignments(userId);
  const out = [];
  for (const [roleId, assignedAgentId] of Object.entries(assignments)) {
    if (assignedAgentId !== bare) continue;
    const manifest = getRoleManifest(roleId, userId);
    if (manifest?.service && isSkillRuntimeEnabledForUser(roleId, userId)) out.push(roleId);
  }
  return out;
}

/**
 * Every skill assigned to a given agent — service roles AND custom specialist
 * skills (youtube-downloader, pokemon-etb, …). This is the memory-scope
 * universe: an agent sees facts scoped to any skill it's assigned, so a fact
 * scoped to a custom skill reaches its specialist (and only it). Broader than
 * getAgentRoles (service-only) — kept separate so role-display logic that wants
 * just service roles is unaffected.
 */
export function getAgentAssignedSkills(agentId, userId) {
  if (!agentId) return [];
  const bare = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const assignments = getRoleAssignments(userId);
  return Object.entries(assignments)
    .filter(([id, assigned]) => {
      if (assigned !== bare) return false;
      // Preserve legacy/dangling custom scopes for reversible storage, but a
      // known disabled skill must not grant memory or fastpath authority.
      return !getRoleManifest(id, userId) || isSkillRuntimeEnabledForUser(id, userId);
    })
    .map(([id]) => id);
}

/**
 * May this agent run the pre-LLM fast-path for `skillId` (skip the LLM and
 * execute the skill's intent directly)? The coordinator may fast-path ANY
 * skill — it owns every cross-agent handoff. A specialist may fast-path only
 * the skills it's actually assigned (for example, specialist -> email).
 * A non-owner specialist (e.g. the deep-research agent) is denied, so a
 * paraphrase like "give me the latest US news" can't fire email_list — it
 * falls through to the agent's LLM, which escalates to the coordinator.
 * Voice turns resolve to the coordinator by default, so they stay allowed.
 */
export function agentCanFastpathSkill(agentId, skillId, userId) {
  if (!agentId || !skillId) return false;
  const bare = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const coordinatorId = getRoleAssignment('coordinator', userId);
  if (coordinatorId && bare === coordinatorId) return true;
  return getAgentAssignedSkills(agentId, userId).includes(skillId);
}

/**
 * Is this skill a worthwhile memory scope? True for service roles, and for any
 * skill assigned to a specific agent (custom specialist skills). Global/utility
 * skills (web, self-mgmt, delegate, tasks) aren't assigned to anyone, so facts
 * from them stay shared — which is correct, since recall can only route a fact
 * to an agent that's assigned its scope.
 */
export function isScopableSkill(skillId, userId) {
  if (!skillId) return false;
  const manifest = getRoleManifest(skillId, userId);
  if (manifest && !isSkillRuntimeEnabledForUser(skillId, userId)) return false;
  if (manifest?.service) return true;
  return Object.prototype.hasOwnProperty.call(getRoleAssignments(userId), skillId);
}

// Role → drawer-plugin pairs that should auto-enable on assignment.
const ROLE_DRAWER_AUTO_ENABLE = {
  role_tutor: 'tutor-today',
};

function syncDrawerForRoleAssignment(userId, roleId, agentId) {
  if (!userId) return;
  const drawerId = ROLE_DRAWER_AUTO_ENABLE[roleId];
  if (!drawerId || !agentId) return;
  try {
    const userPath = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(userPath)) return;
    const user = JSON.parse(readFileSync(userPath, 'utf8'));
    let dirty = false;
    user.pluginPrefs = user.pluginPrefs ?? {};
    user.pluginPrefs[drawerId] = user.pluginPrefs[drawerId] ?? {};
    if (user.pluginPrefs[drawerId].enabled !== true) {
      user.pluginPrefs[drawerId].enabled = true;
      dirty = true;
    }
    if (Array.isArray(user.allowedFeatures) && !user.allowedFeatures.includes(drawerId)) {
      user.allowedFeatures = [...user.allowedFeatures, drawerId];
      dirty = true;
    }
    if (dirty) writeFileSync(userPath, JSON.stringify(user, null, 2));
  } catch {}
}

export function setRoleAssignment(roleId, agentId, userId) {
  if (userId) {
    // A caller that names an account is asking to mutate that account. Never
    // turn an unreadable/malformed profile into an installation-wide write:
    // doing so lets a transient profile failure overwrite the owner's legacy
    // assignments. Only a positively identified owner may use the global map.
    const user = _readUserProfile(userId);
    if (!user) {
      throw new Error(`Cannot update role assignment for unknown or unreadable user: ${userId}`);
    }
    if (!_isOwnerRole(user.role)) {
      const userPath = path.join(USERS_DIR, userId, 'profile.json');
      user.skillAssignments = user.skillAssignments ?? {};
      if (agentId) user.skillAssignments[roleId] = agentId;
      else delete user.skillAssignments[roleId];
      writeFileSync(userPath, JSON.stringify(user, null, 2));
      syncDrawerForRoleAssignment(userId, roleId, agentId);
      return;
    }
  }
  let cfg = {};
  if (existsSync(CFG_PATH)) cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Cannot update role assignment: invalid global configuration');
  }
  cfg.skillAssignments = cfg.skillAssignments ?? {};
  if (agentId) cfg.skillAssignments[roleId] = agentId;
  else delete cfg.skillAssignments[roleId];
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  // Privileged users (owner/admin) also get per-user pluginPrefs synced so the
  // drawer toggle reflects the role they just assigned.
  syncDrawerForRoleAssignment(userId, roleId, agentId);
}

/**
 * Remove every stored assignment that points at a deleted agent. This reads
 * the unprojected storage record deliberately: using getRoleAssignments in
 * single mode would make every projected skill appear to belong to the
 * primary and destructively erase the user's parked ensemble layout.
 */
export function clearRoleAssignmentsForAgent(agentId, userId) {
  if (!agentId) return 0;

  /** Remove exact references from one persisted assignment container. */
  const clearContainer = (container, targetPath) => {
    const assignments = container.skillAssignments ?? {};
    let removed = 0;
    for (const [skillId, assignedAgentId] of Object.entries(assignments)) {
      if (assignedAgentId !== agentId) continue;
      delete assignments[skillId];
      removed++;
    }
    if (removed) {
      container.skillAssignments = assignments;
      writeFileSync(targetPath, JSON.stringify(container, null, 2));
    }
    return removed;
  };

  const clearGlobal = () => {
    let cfg = {};
    if (existsSync(CFG_PATH)) cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw new Error('Cannot clear role assignments: invalid global configuration');
    }
    return clearContainer(cfg, CFG_PATH);
  };

  if (!userId) return clearGlobal();

  const user = _readUserProfile(userId);
  if (!user) {
    throw new Error(`Cannot clear role assignments for unknown or unreadable user: ${userId}`);
  }
  if (_isOwnerRole(user.role)) return clearGlobal();

  const userPath = path.join(USERS_DIR, userId, 'profile.json');
  const profileRemoved = clearContainer(user, userPath);
  // Older admins could have stored their assignments in the legacy global
  // map. Clean both locations during deletion while regular users remain
  // strictly profile-local.
  return profileRemoved + (user.role === 'admin' ? clearGlobal() : 0);
}

/**
 * One-shot backfill: walk every user and enable role-paired drawers for any
 * role they already have assigned. Safe to call at startup; idempotent.
 */
export function reconcileRoleDrawers() {
  if (!existsSync(USERS_DIR)) return;
  let globalCfg = {};
  try { globalCfg = JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch {}
  const globalAssignments = globalCfg.skillAssignments ?? {};
  for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const userPath = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(userPath)) continue;
    let user;
    try { user = JSON.parse(readFileSync(userPath, 'utf8')); } catch { continue; }
    const assignments = _isOwnerRole(user?.role)
      ? globalAssignments
      : (user?.role === 'admin'
          ? { ...globalAssignments, ...(user?.skillAssignments ?? {}) }
          : (user?.skillAssignments ?? {}));
    for (const [roleId, agentId] of Object.entries(assignments)) {
      if (ROLE_DRAWER_AUTO_ENABLE[roleId] && agentId) {
        syncDrawerForRoleAssignment(userId, roleId, agentId);
      }
    }
  }
}

// ── Tool resolution ───────────────────────────────────────────────────────────

/**
 * Account-level skill authorization. Restricted accounts are fail-closed and
 * an explicit allowedSkills array is authoritative for regular users too.
 * Owner/admin accounts remain unrestricted. Missing/unreadable profiles deny.
 */
export function isSkillAllowedForUser(skillId, userId) {
  if (!skillId || !userId) return true;
  const profile = _readUserProfile(userId);
  const allowed = _allowedSkillIdsForProfile(profile);
  return allowed === null || allowed.has(skillId);
}

/**
 * Runtime authorization shared by tool, alias, lifecycle, and watcher seams.
 * `profile.skills` is one activation source, not the only one: hidden
 * delegate tools are orchestration infrastructure, role bundles ride with an
 * enabled parent role, and an agent's primary role remains its capability.
 */
export function isSkillRuntimeEnabledForUser(skillId, userId, agentId = null) {
  if (!skillId || !userId || !isSkillAllowedForUser(skillId, userId)) return false;
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap) return false;
  if (isSkillDisabled(userId, skillId, !!wrap.manifest?.always_on)) return false;
  if (wrap.manifest?.always_on === true) return true;
  const profile = _readUserProfile(userId);
  if (!profile) return false;
  const enabled = new Set([
    ...getDefaultRoles(),
    ...(Array.isArray(profile.skills) ? profile.skills : []),
    ...(!Array.isArray(profile.skills) && profile.emailProvider === 'gmail' ? ['gmail'] : []),
  ]);
  if (enabled.has(skillId)) return true;
  if (wrap.manifest?.category === 'delegate') return true;
  if (wrap.manifest?.bundled_with_role && enabled.has(wrap.manifest.bundled_with_role)) return true;
  if (agentId) {
    const prefix = `${userId}_`;
    const bare = String(agentId).startsWith(prefix) ? String(agentId).slice(prefix.length) : String(agentId);
    const agent = listAgents().find(candidate => candidate.ownerId === userId && candidate.id === bare);
    if (agent?.skillCategory === skillId) return true;
  }
  return false;
}

function accountAllowedSkillIds(userId) {
  if (!userId) return null;
  const profile = _readUserProfile(userId);
  return _allowedSkillIdsForProfile(profile);
}

// Tools from always_on skills — injected into every agent regardless of category.
// Intentionally global-only: a user's custom always_on: true skill should NOT leak
// into other users' sessions. This is an isolation tradeoff — user custom skills
// must be explicitly enabled via user.skills rather than auto-injected.
function getAlwaysOnTools(allowedSkillIds = null) {
  const tools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (allowedSkillIds && !allowedSkillIds.has(wrap.manifest.id)) continue;
    if (wrap.manifest.always_on) tools.push(...(wrap.manifest.tools ?? []));
  }
  return tools;
}

// Tools that ride along with owned roles — e.g. active-agents is "the
// coordinator's job" and skill-builder is "the coder's job". In the
// single-coordinator shape one agent can own several service roles, so looking
// only at its primary skillCategory silently drops bundles for every secondary
// role. Treat every assigned role as owned; bundles remain inherent to their
// role rather than separately assignable (and stay hidden in Settings).
function getBundledRoleTools(roleIds, allowedSkillIds = null, userId = null) {
  const owned = new Set(Array.isArray(roleIds) ? roleIds : [roleIds].filter(Boolean));
  if (!owned.size) return [];
  const tools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (allowedSkillIds && !allowedSkillIds.has(wrap.manifest.id)) continue;
    if (userId && isSkillDisabled(userId, wrap.manifest.id, !!wrap.manifest.always_on)) continue;
    if (owned.has(wrap.manifest.bundled_with_role)) {
      tools.push(...(wrap.manifest.tools ?? []));
    }
  }
  return tools;
}

// Resolve what tools an agent gets based on its skillCategory and the user's enabled roles
export function resolveAgentTools(skillCategory, userSkills, agentId = null, userId = null) {
  const allowedSkillIds = accountAllowedSkillIds(userId);
  // getUserEnabledSkills backfills enabled_by_default skills for historical
  // profiles. For a child that storage convenience must never widen the
  // runtime capability surface beyond the parent-managed allowedSkills list.
  userSkills = Array.isArray(userSkills)
    ? userSkills.filter(skillId => !allowedSkillIds || allowedSkillIds.has(skillId))
    : [];
  const assignments = getRoleAssignments(userId);
  const coordinatorId = assignments['coordinator'] ?? null;
  const alwaysOn = getAlwaysOnTools(allowedSkillIds);

  // Resolve assignment: supports literal agent IDs and the special "coordinator" alias
  function isAssignedTo(skillId) {
    const owner = assignments[skillId];
    if (!owner) return false;
    if (owner === agentId) return true;
    // "coordinator" alias: assign to whoever owns the coordinator skill
    if (owner === 'coordinator' && coordinatorId && coordinatorId === agentId) return true;
    return false;
  }

  // Utility roles: unassigned → all agents; assigned → only their agent
  const utilityTools = userSkills.filter(s => {
    const m = getRoleManifest(s, userId);
    if (m?.category !== 'utility') return false;
    const owner = assignments[s];
    return owner ? isAssignedTo(s) : true;
  }).flatMap(id => getRoleTools(id, userId));

  // Service roles (email, finance, etc.): assignment-based only — no implicit category lock
  const assignedTools = userSkills.filter(s => {
    const m = getRoleManifest(s, userId);
    if (!m || m.category === 'utility' || m.category === 'delegate') return false;
    return isAssignedTo(s);
  }).flatMap(id => getRoleTools(id, userId));

  // Always include the agent's primary role tools (even if not in userSkills).
  // Primary role is always a global skill category (coder, email, etc.).
  const primaryTools = skillCategory && (!allowedSkillIds || allowedSkillIds.has(skillCategory))
    ? getRoleTools(skillCategory, userId)
    : [];

  // Bundles follow every role this agent owns, not only its primary role.
  // This matters when one Jarvis coordinator owns coordinator + coder + email
  // and the coder role's hidden skill-builder bundle must remain available.
  // Secondary assignments still have to be enabled for this user; a stale
  // assignment must not resurrect a bundle after an admin revokes its role.
  const enabledSkills = new Set(userSkills);
  const ownedRoleIds = [
    skillCategory,
    ...Object.keys(assignments).filter(roleId => enabledSkills.has(roleId) && isAssignedTo(roleId)),
  ].filter(Boolean);
  const bundledTools = getBundledRoleTools(ownedRoleIds, allowedSkillIds, userId);

  const dedup = tools => {
    const seen = new Set();
    return tools.filter(t => {
      const name = t.function?.name ?? t.name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  };

  // Delegate tools (ask_agent etc.) flow to EVERY agent now — not just the
  // coordinator. Specialists can escalate to the coordinator when they hit
  // a wall (no email tool, no skill-edit tool, etc.). The actual restriction
  // ("specialists may only target the coordinator") and the depth cap are
  // enforced inside skills/delegate/execute.mjs at call time.
  const delegateTools = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId !== null) continue;
    if (allowedSkillIds && !allowedSkillIds.has(wrap.manifest.id)) continue;
    if (wrap.manifest.category === 'delegate') delegateTools.push(...(wrap.manifest.tools ?? []));
  }
  if (skillCategory === 'general' || skillCategory === 'web') {
    return dedup([...alwaysOn, ...utilityTools, ...assignedTools, ...delegateTools, ...bundledTools]);
  }
  return dedup([...alwaysOn, ...utilityTools, ...assignedTools, ...primaryTools, ...bundledTools, ...delegateTools]);
}

// Get default role IDs for new users — globals only.
export function getDefaultRoles() {
  const out = [];
  for (const wrap of _manifests.values()) {
    if (wrap.userId === null && wrap.manifest.enabled_by_default) out.push(wrap.manifest.id);
  }
  return out;
}

// ── Executor loading ──────────────────────────────────────────────────────────

// Cache the full module per skill so we can read named exports
// (watcherHandlers, etc.) in addition to the default executor function.
const _modules = new Map(); // internalKey -> imported module

async function importAliasCatalogModule(wrap, catalogUserId) {
  if (!wrap?.manifest?.id || !catalogUserId) return {};
  const skillId = wrap.manifest.id;
  if (wrap.userId && wrap.userId !== catalogUserId) return {};
  // Alias resolution runs before an agent/tool is selected, so it needs its
  // own account boundary. Denied or disabled skills return an empty module
  // without evaluating execute.mjs.
  if (!isSkillRuntimeEnabledForUser(skillId, catalogUserId)) return {};

  const functionName = wrap.manifest.alias_catalog?.catalog_source?.function;
  if (wrap.userId && shouldSandboxSkill(wrap)) {
    if (!functionName) return {};
    return {
      [functionName]: async () => {
        const { runCustomSkillExportedFunctionSandboxed } = await import('./lib/skill-subprocess.mjs');
        return runCustomSkillExportedFunctionSandboxed({
          userId: catalogUserId,
          skillId,
          functionName,
          net: skillDeclaresNetwork(catalogUserId, skillId),
        });
      },
    };
  }

  const key = wrap.userId ? userKey(wrap.userId, skillId) : globalKey(skillId);
  const filePath = path.join(wrap.dir, 'execute.mjs');
  return import(pathToFileURL(filePath).href + `?bust=${_executorBust.get(key) || 0}`)
    .catch(() => ({}));
}

// Load executor lazily. `internalKey` identifies the wrapper; `dir` comes from it.
async function getExecutorByKey(internalKey) {
  if (_executors.has(internalKey)) return _executors.get(internalKey);
  const wrap = _manifests.get(internalKey);
  if (!wrap) return null;
  const execPath = path.join(wrap.dir, 'execute.mjs');
  if (!existsSync(execPath)) return null;
  try {
    const bust = _executorBust.get(internalKey);
    const url = pathToFileURL(execPath).href + (bust ? `?v=${bust}` : '');
    const mod = await import(url);
    const fn = mod.default ?? mod.executeSkillTool ?? mod.execute ?? null;
    _executors.set(internalKey, fn);
    _modules.set(internalKey, mod);
    return fn;
  } catch (e) {
    console.warn(`[skills] Failed to load executor for ${internalKey}:`, e.message);
    return null;
  }
}

/**
 * Return a watcher handler from the named skill, or null if not present.
 * Used by the watcher supervisor to look up handlers lazily.
 */
export async function getWatcherHandler(skillId, userId, kind) {
  const key = resolveKey(skillId, userId);
  if (!key) return null;
  const wrap = _manifests.get(key);
  if (!isSkillRuntimeEnabledForUser(skillId, userId) || shouldSandboxSkill(wrap)) return null;
  // Trigger lazy load to populate _modules.
  await getExecutorByKey(key);
  const mod = _modules.get(key);
  return mod?.watcherHandlers?.[kind] || null;
}

// Validate that every manifest tool name is actually handled by its executor.
// Runs at startup; mismatches are logged as warnings. Safe: a thrown error (bad args)
// still means the name was recognised — only null means "not handled".
export async function validateSkills() {
  for (const [internalKey, wrap] of _manifests) {
    const { manifest } = wrap;

    // Validate optional `localIntents` (skill-agnostic local cognition tier).
    // Warnings only — lib/local-label.mjs defensively skips anything invalid at
    // runtime, so a bad entry never breaks chat; this just surfaces authoring
    // bugs (unknown tool, slot that isn't a tool parameter, uncompilable regex).
    if (Array.isArray(manifest.localIntents)) {
      const label = wrap.userId ? `${wrap.userId}/${manifest.id}` : manifest.id;
      for (const li of manifest.localIntents) {
        if (!li?.id || !li?.tool) { console.warn(`[skills] ⚠️  ${label}: localIntent missing id/tool`); continue; }
        const tool = (manifest.tools ?? []).find(t => t.function?.name === li.tool);
        if (!tool) { console.warn(`[skills] ⚠️  ${label}: localIntent '${li.id}' binds unknown tool '${li.tool}'`); continue; }
        const props = tool.function?.parameters?.properties ?? {};
        for (const slot of (Array.isArray(li.slots) ? li.slots : [])) {
          if (!(slot in props)) console.warn(`[skills] ⚠️  ${label}: localIntent '${li.id}' slot '${slot}' is not a parameter of '${li.tool}'`);
        }
        for (const pat of (Array.isArray(li.patterns) ? li.patterns : [])) {
          try { new RegExp(pat, 'i'); } catch (e) { console.warn(`[skills] ⚠️  ${label}: localIntent '${li.id}' bad regex /${pat}/: ${e.message}`); }
        }
      }
    }

    const execPath = path.join(wrap.dir, 'execute.mjs');
    if (!existsSync(execPath)) continue;
    // Sandboxed custom skills never load in-process — not even here. This
    // loop used to import() every user-authored execute.mjs at boot (its
    // top-level code ran unjailed, with the server's env and fs) and invoke
    // each tool with {__validate:true}. The authoring-time smoke test (which
    // runs in the bwrap jail) covers custom skills; the boot probe keeps its
    // value for global (repo-shipped, first-party) skills only.
    if (wrap.userId !== null) continue;
    const exec = await getExecutorByKey(internalKey);
    if (!exec) continue;
    const toolNames = (manifest.tools ?? []).map(t => t.function?.name).filter(Boolean);
    if (toolNames.length === 0) continue;
    const unhandled = [];
    for (const toolName of toolNames) {
      try {
        const result = await exec(toolName, { __validate: true }, null, null);
        if (result === null) unhandled.push(toolName);
      } catch {
        // threw on bad args but the name was recognised — that's fine
      }
    }
    if (unhandled.length > 0) {
      const label = wrap.userId ? `${wrap.userId}/${manifest.id}` : manifest.id;
      console.warn(`[skills] ⚠️  ${label}: executor does not handle tool(s): ${unhandled.join(', ')}`);
      console.warn(`[skills]    Manifest tools: ${toolNames.join(', ')}`);
    }
  }
}

// Call a role's onEnable hook if it exports one — fire and forget from the caller
export async function onRoleEnabled(roleId, userId) {
  const key = resolveKey(roleId, userId);
  if (!key) return;
  const wrap = _manifests.get(key);
  if (!isSkillRuntimeEnabledForUser(roleId, userId)) return;
  // Custom lifecycle hooks are not part of the sandbox RPC contract. Refuse
  // them instead of importing user-authored code into the server process;
  // repo-shipped global hooks retain the existing behavior.
  if (wrap.userId !== null) return;
  const execPath = path.join(wrap.dir, 'execute.mjs');
  if (!existsSync(execPath)) return;
  try {
    const mod = await import(pathToFileURL(execPath).href);
    if (typeof mod.onEnable === 'function') await mod.onEnable(userId);
  } catch (e) {
    console.warn(`[roles] onEnable error for ${roleId}:`, e.message);
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────

// Lazy ws-handler import — avoids the chat-dispatch ↔ roles ↔ ws-handler cycle.
let _wsMod = null;
async function _wsHandler() {
  if (_wsMod === null) {
    try { _wsMod = await import('./ws-handler.mjs'); }
    catch { _wsMod = false; }
  }
  return _wsMod || null;
}

function _desktopToolText(data) {
  const item = Array.isArray(data?.content) ? data.content.find(p => p?.type === 'text') : null;
  return item?.text ? String(item.text) : '';
}

function _desktopSavedPath(data) {
  const text = _desktopToolText(data);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} userId
 * @param {{sandbox?: string, filename?: string, base64?: string, url?: string, timeoutMs?: number}} [opts]
 */
async function saveDesktopArtifact(userId, { sandbox, filename, base64, url, timeoutMs = 60_000 } = {}) {
  if (getVoiceContext()?.source !== 'desktop-app' || !userId || !sandbox || !filename) return null;
  if (!listDesktops(userId).length) return null;
  try {
    const data = base64
      ? await sendDesktopCommand(userId, 'desktop_save_file', { sandbox, path: filename, content: base64, encoding: 'base64' }, { timeoutMs })
      : await sendDesktopCommand(userId, 'desktop_download_url', { sandbox, path: filename, url }, { timeoutMs });
    return _desktopSavedPath(data);
  } catch (e) {
    console.warn(`[desktop-artifact] failed to save ${sandbox}/${filename}:`, e.message);
    return null;
  }
}

// Build the per-call context object passed to skill executors as the 5th arg.
// Skills that don't accept it (4-param signature) ignore it transparently.
async function buildCtx(userId, agentId, skillId = null, signal = getTurnContext()?.signal ?? null) {
  // Providers pass the scoped `${userId}_${rawAgentId}` here, but the dashboard
  // matches inbound bubbles against the raw agent id. Strip the prefix so
  // ctx.showImage/showVideo land in the right chat thread.
  const wsAgentId = (userId && typeof agentId === 'string' && agentId.startsWith(`${userId}_`))
    ? agentId.slice(userId.length + 1)
    : agentId;
  const suppressLearning = getTurnContext()?.suppressLearning === true;
  const ctx = {
    userId,
    agentId,
    signal,
    throwIfAborted() {
      if (signal?.aborted) throw abortError(signal, 'Tool execution cancelled');
    },
  };
  // Structured failure signal: `return ctx.toolError('…')` records the tool call
  // as a failure (trace ok:false, flaky-tool proposals, not learned as a recipe)
  // instead of the legacy `return `Error: …`` string the trace can't read. See
  // lib/tool-error.mjs + SKILL_BLUEPRINT.md → "Signaling failure".
  ctx.toolError = (message) => toolError(message);
  ctx.showImage = /** @param {{base64?: string, mimeType?: string, filename?: string, savedPath?: string, prompt?: string}} [opts] */ async ({ base64, mimeType = 'image/png', filename, savedPath, prompt } = {}) => {
    if (!wsAgentId || !base64 || !filename) return 0;
    const desktopSavedPath = await saveDesktopArtifact(userId, {
      sandbox: 'images',
      filename,
      base64,
    });
    if (desktopSavedPath) savedPath = desktopSavedPath;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'image', agent: wsAgentId, base64, mimeType, filename, savedPath, prompt });
  };
  ctx.showVideo = /** @param {{url?: string, filename?: string, savedPath?: string}} [opts] */ async ({ url, filename, savedPath } = {}) => {
    if (!wsAgentId || !url || !filename) return 0;
    const desktopSavedPath = await saveDesktopArtifact(userId, {
      sandbox: 'videos',
      filename,
      url,
      timeoutMs: 300_000,
    });
    if (desktopSavedPath) savedPath = desktopSavedPath;
    const mod = await _wsHandler();
    if (!mod?.sendToUser) return 0;
    return mod.sendToUser(userId, { type: 'video', agent: wsAgentId, url, filename, savedPath });
  };

  // Register a long-running poll/watcher. Supervisor in scheduler/watchers.mjs
  // ticks each watcher's handler (defined via the skill's watcherHandlers
  // export) on its cadence. Status updates land as muted/italic chat bubbles
  // distinct from agent assistant turns.
  //
  // opts: { kind, state?, cadenceSec?, expiresAt, label?, skillId? }
  // Returns the watcherId (string) or null if registration was rejected
  // (per-user cap, missing fields).
  //
  // expiresAt should be set explicitly by the caller based on a realistic
  // estimate of how long the work takes. Pass `null` for indefinite watchers
  // (price alerts, "tell me when X" — supervisor never auto-reaps these,
  // user must dismiss them from the tasks drawer).
  ctx.watch = /** @param {{kind?: string, state?: any, cadenceSec?: number, expiresAt?: number|null, skillId?: string, label?: string, onFire?: any, followDurableSkillOwner?: boolean, requirePersist?: boolean}} [opts] */ async (opts = {}) => {
    try {
      const watchers = await import('./scheduler/watchers.mjs');
      const { followDurableSkillOwner, ...watcherOpts } = opts;
      void followDurableSkillOwner; // legacy option; ownership is now automatic
      const effectiveSkillId = opts.skillId || skillId || null;
      const watcherAgentId = await resolveWatcherRegistrationAgentId(
        userId,
        wsAgentId,
        effectiveSkillId,
      );
      return watchers.registerWatcher(/** @type {any} */ ({
        ...watcherOpts,
        userId,
        agentId: watcherAgentId,
        // If the caller didn't specify which skill owns this watcher, try to
        // infer it. The agent in this ctx might not be a skill; an explicit
        // skillId is best-effort and required only if the handler is not in
        // the system registry.
        skillId: effectiveSkillId,
      }));
    } catch (e) { console.warn('[ctx.watch]', e.message); return null; }
  };
  ctx.unwatch = async (watcherId) => {
    try {
      const { getPreferenceSafeAutoContext } = await import('./lib/personalization/safe-auto-context.mjs');
      if (getPreferenceSafeAutoContext()?.activationNonce) {
        throw new Error('unwatch is unavailable while committing a preference monitor activation');
      }
      const watchers = await import('./scheduler/watchers.mjs');
      return watchers.unregisterWatcher(userId, watcherId);
    } catch (e) { console.warn('[ctx.unwatch]', e.message); return false; }
  };
  // Bulk-cancel watchers matching a predicate. Used by skills that tear down
  // a resource a watcher polls (e.g. terminating a pod that has a render
  // watcher attached) so we don't keep showing stale progress bubbles.
  // predicate is a sync function (record) -> bool, evaluated in-process.
  ctx.unwatchMatching = async (predicate) => {
    try {
      const { getPreferenceSafeAutoContext } = await import('./lib/personalization/safe-auto-context.mjs');
      if (getPreferenceSafeAutoContext()?.activationNonce) {
        throw new Error('unwatchMatching is unavailable while committing a preference monitor activation');
      }
      const watchers = await import('./scheduler/watchers.mjs');
      return watchers.unregisterMatchingWatchers(userId, predicate);
    } catch (e) { console.warn('[ctx.unwatchMatching]', e.message); return 0; }
  };
  // proposeMonitor: high-level wrapper around ctx.watch that handles cadence
  // presets ('daily', 'weekly', …), default expiresAt=null for open-ended
  // monitors, default onFire shape, and dedup so "propose after N uses"
  // heuristics don't stack N copies of the same watcher. Lives in
  // lib/monitor-helper.mjs so skill-builder can teach the LLM a single
  // call shape for "ping me when X changes" instead of forcing every skill
  // to re-learn registerWatcher's arg layout.
  ctx.proposeMonitor = buildProposeMonitor({ userId, agentId: wsAgentId });

  // ctx.registerLead — personalization "open lead" registration: stores a
  // tool+args re-run for later (silent) follow-up when an answer isn't
  // available yet ("is this back in stock"). See lib/personalization/lead-helper.mjs.
  ctx.registerLead = suppressLearning
    ? async () => ({
        ok: false,
        announce: 'Automatic follow-up registration is disabled during this verification run.',
      })
    : buildRegisterLead({ userId, agentId: wsAgentId });

  // Read-only, master-switch-gated confirmed preferences scoped to the
  // owning skill's declared preferenceOpportunities keywords.
  ctx.personalization = buildSkillPersonalizationHelpers({ userId, skillId });

  // ctx.collection — group many similar items under ONE watcher record with
  // per-item cadence. Use when a skill needs to monitor N peers (channels,
  // retailers, stores, products) that share the same handler logic. Each
  // item polls at its own cadenceSec; the parent watcher ticks at 60s and
  // the handler iterates due items via helpers.mapItems. See
  // lib/monitor-helper.mjs:buildCollectionHelpers JSDoc for the full API.
  // skillIdHint is bound late — skills pass their own SKILL_ID through the
  // `ensure({ skillId })` arg if they need cross-skill isolation, otherwise
  // the helpers fall back to the (kind) key alone.
  ctx.collection = buildCollectionHelpers({ userId, agentId: wsAgentId });

  // ctx.browser — primitive surface for skills that want to use the user's
  // connected OE Bridge browser extension. Phase 1 is read-only: list /
  // openTab / readPage + the Tier 1.5 mediaControl (next/previous/playpause)
  // because media keys are a tiny, bounded surface that doesn't need the
  // full per-site permission model. ctx.browser.click / fill / select land
  // with Phase 2 (Tier 1 writes + permission UX).
  ctx.browser = buildBrowserHelpers({ userId, agentId: wsAgentId });

  // ctx.device — primitive surface for skills that want to drive the user's
  // voice device(s). Mirrors ctx.browser's shape — bounded operations
  // (playStream/stop/speak/notify) that hide the marker-cache, ffmpeg, and
  // WS plumbing. v1 covers the YouTube-Music streaming use case; multi-turn
  // handoff, LED, recording, quiet hours etc are tracked in
  // project_voice_device_skill_api_todo.md.
  ctx.device = buildDeviceHelpers({ userId });

  // ctx.log — per-skill structured logging that ALSO lands in OE's app.log
  // tagged `skill:<id>`. Skills should prefer this over console.log because
  // (a) entries are queryable via skill_read_logs, and (b) the agent that
  // owns the skill can read its own runtime log to diagnose failures.
  // Bound to the calling skill — when buildCtx is called from a skill
  // executor we have the skillId; for non-skill ctx callers (chat hot paths)
  // ctx.log falls back to logging under skill='unknown'. SkillId is
  // populated below from the agentId's owning skill registry lookup if
  // available; for now bind to the agentId as the skill key so logs are at
  // least segregated per agent.
  // skillId is passed in by the dispatcher (executeRoleTool / the generator
  // at the bottom of this file) and identifies the SKILL that owns the tool
  // being executed — not the agent calling it. That matters for log routing:
  // The coordinator calling a skill's tool should write entries to
  // users/<id>/skills/<skill>/runtime.log, not the coordinator's runtime.log.
  // Falls back to wsAgentId only when buildCtx is reached from a non-skill
  // path (rare; mostly chat-side direct ctx usage).
  ctx.log = buildSkillLogger({ userId, skillId: skillId || wsAgentId || 'unknown', agentId: wsAgentId });

  // Encrypted credential primitive — wraps lib/credentials.mjs so user skills
  // don't have to know the install-root-relative import depth (four-up from
  // users/<id>/skills/<id>/execute.mjs, two-up from built-in skills/<id>/
  // execute.mjs — easy to miscount). Plaintext values from requestCredential
  // never enter the LLM message history; the chat-providers substitute a
  // placeholder when the tool result is flagged { isCredential: true }.
  //
  //   const key = await ctx.getCredential('myskill_api_key')
  //              ?? await ctx.requestCredential({
  //                   id: 'myskill_api_key',
  //                   label: 'My Service API key',
  //                   kind: 'api_key', persist: true,
  //                 });
  ctx.getCredential = async (id) => {
    try {
      const m = await import('./lib/credentials.mjs');
      return m.getCredentialValue(userId, id);
    } catch (e) { console.warn('[ctx.getCredential]', e.message); return null; }
  };
  ctx.requestCredential = async (opts = {}) => {
    try {
      const m = await import('./lib/credentials.mjs');
      return m.requestCredential({ ...opts, userId });
    } catch (e) { console.warn('[ctx.requestCredential]', e.message); return null; }
  };
  ctx.storeCredential = async (opts = /** @type {any} */ ({})) => {
    try {
      const m = await import('./lib/credentials.mjs');
      return m.storeCredential(userId, opts);
    } catch (e) { console.warn('[ctx.storeCredential]', e.message); return null; }
  };

  // ── External-runtime provisioning + sandbox ────────────────────────────────
  // A skill OWNS its external binaries under <skillDir>/bin (so deleting things
  // elsewhere can't brick it), provisions them with explicit per-download user
  // consent (NO allowlist — the user approves the exact URL), and RUNS them
  // sandboxed via bubblewrap so a third-party binary can't read credentials or
  // other users' data. See SKILL_BLUEPRINT.md → "Skills that need an external
  // runtime". (This sandboxes the spawned binary, not the skill's own JS — see
  // the multi-tenant isolation note.)
  const _skillDir = (() => {
    if (!skillId) return null;
    const ud = path.join(userSkillsDir(userId), skillId);
    if (existsSync(ud)) return ud;
    const bd = path.join(SKILLS_DIR, skillId);
    return existsSync(bd) ? bd : null;
  })();
  /** @param {{ name?: string, url?: string, sha256?: string|null, label?: string|null, confirmTtlMs?: number }} [opts] */
  ctx.ensureRuntime = async ({ name, url, sha256 = null, label = null, confirmTtlMs = 5 * 60 * 1000 } = {}) => {
    if (!_skillDir) throw new Error('ctx.ensureRuntime: skill directory unknown');
    if (!name || !url) throw new Error('ctx.ensureRuntime: { name, url } required');
    const rt = await import('./lib/skill-runtime.mjs');
    const existing = rt.resolveSkillBinary(_skillDir, name);
    if (existing) return existing;                       // self-heal / already provisioned
    // Consent: explicit, per-download, reusing the wired 'confirm' prompt. The
    // user sees the exact URL; Cancel/timeout rejects and we abort.
    const m = await import('./lib/credentials.mjs');
    try {
      await m.requestCredential({
        userId, kind: 'confirm', ttlMs: confirmTtlMs,
        label: label || `Download ${name}?`,
        description: `The "${skillId}" skill needs to download an external program:\n\n  ${name}\n  from ${url}\n\nI can't guarantee this binary is safe. It will run sandboxed — its filesystem access is limited to the skill's own folder plus any output folder. Type "${name}" to approve, or Cancel to decline.`,
      });
    } catch {
      throw new Error(`Download of ${name} was declined or timed out — cannot continue without it.`);
    }
    return rt.provisionBinary({ skillDir: _skillDir, name, url, sha256 });
  };
  ctx.runSandboxed = async (bin, binArgs = [], opts = {}) => {
    const sb = await import('./lib/skill-sandbox.mjs');
    const roDirs = [_skillDir, ...(opts.roDirs || [])].filter(Boolean);
    return sb.runSandboxed(bin, binArgs, {
      ...opts,
      signal: opts.signal ?? signal,
      roDirs,
    });
  };
  // Per-user output dir for a skill (creates it). e.g. ctx.userFilesDir('videos').
  ctx.userFilesDir = (sub) => getUserFilesDir(userId, sub);

  // ctx.credentials — per-skill encrypted secret store, namespaced by skillId.
  // Same accessor the sandbox broker exposes, so a secret set in-process reads
  // back identically when the skill later runs jailed. Only when we know the
  // owning skill (non-skill ctx callers don't get it).
  if (skillId) ctx.credentials = buildSkillCredentials(userId, skillId);

  return ctx;
}

// Regression seam for the context-bound watcher ownership contract. It lets
// tests exercise a skill that calls ctx.watch without redundantly passing its
// own skillId, while production execution continues through buildCtx above.
export async function buildSkillExecutionContextForTest(userId, agentId, skillId = null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('skill execution context test seam is unavailable');
  return buildCtx(userId, agentId, skillId);
}

// ── Custom-skill sandbox routing (multi-tenant isolation) ────────────────────
// Custom (user-authored) skills run their execute.mjs in a bwrap jail via
// lib/skill-subprocess.mjs so they can't read other users' data, token files, or
// the master key. Trusted global skills (wrap.userId === null) stay in-process.
// Flag-gated (config.skillSandbox.enabled, default off) until exercised live.
function shouldSandboxSkill(wrap) {
  if (!wrap || wrap.userId == null) return false; // global = first-party = trusted
  const ownerProfile = _readUserProfile(wrap.userId);
  // Missing/unreadable ownership data and child-owned custom code are always
  // isolated. A manifest is untrusted input and cannot opt itself out of the
  // account boundary.
  if (!ownerProfile || ownerProfile.role === 'child') return true;
  // Manifest self-declaration (set by skill_create): the portable default — new custom
  // skills ship with sandbox.isolate:true and travel sandboxed without a config edit.
  // Explicit isolate:false is a trust opt-out, still overridable by the operator config.
  if (wrap.manifest?.sandbox?.isolate === true) return true;
  try {
    const sb = readConfig()?.skillSandbox || {};
    if (sb.enabled === true) return true;                                   // all custom skills
    if (Array.isArray(sb.skills) && sb.skills.includes(wrap.manifest?.id)) return true; // per-skill trial
    return false;
  } catch { return false; }
}

// Public form for callers that only have (skillId, userId) — e.g. the watcher
// supervisor deciding whether to fire a handler in the jail.
export function isSandboxedSkill(skillId, userId) {
  const key = resolveKey(skillId, userId);
  return shouldSandboxSkill(key ? _manifests.get(key) : null);
}

// Run a custom skill's tool in the sandbox, returning a plain value that matches
// the in-process executor contract so both dispatch seams stay unchanged.
// Streaming yields are folded into result text for now (live streaming through
// the jail is a follow-up); failures throw so the normal tool-failure path runs.
async function runCustomSkillValue({
  userId, agentId, skillId, name, args, execSnapshotPath = null,
  signal = getTurnContext()?.signal ?? null,
}) {
  const { runCustomSkillSandboxed } = await import('./lib/skill-subprocess.mjs');
  // Default-deny egress: the jail only gets network if the skill's manifest declares
  // `sandbox.network`. An undeclared (or rogue) skill runs with --unshare-net so it
  // can't exfiltrate anything it can read. See lib/skill-net-policy.mjs.
  const net = skillDeclaresNetwork(userId, skillId);
  const r = await runCustomSkillSandboxed({
    userId, agentId, skillId, toolName: name, args, net, execSnapshotPath, signal,
  });
  if (signal?.aborted) throw abortError(signal, `custom skill ${skillId}.${name} cancelled`);
  if (!r.ok) throw new Error(/** @type {any} */ (r).error || `custom skill ${skillId}.${name} failed`);
  if (Array.isArray(r.events) && r.events.length) {
    const text = r.events.filter(e => e?.type === 'token').map(e => e.text).join('');
    if (text) return { type: 'result', text };
  }
  return r.result;
}

/**
 * Execute a tool only from one exact owning skill. Safe automation uses this
 * instead of the global name-first resolver so a legacy/manual manifest with
 * a colliding tool name cannot intercept another skill's validated contract.
 */
async function executeRoleToolForSkillInternal(
  skillId, name, args, userId = 'default', agentId = null,
  { execSnapshotPath = null, requireSandbox = false } = {},
) {
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap || wrap.manifest.id !== skillId
    || !wrap.manifest.tools?.some(tool => tool.function?.name === name)) {
    return `Tool "${name}" is not declared by skill "${skillId}".`;
  }
  if (userId) {
    if (!isSkillAllowedForUser(skillId, userId)) {
      return `Tool "${name}" is not permitted for this account.`;
    }
    if (!isSkillRuntimeEnabledForUser(skillId, userId, agentId)) {
      return `Tool "${name}" is from a disabled skill.`;
    }
    if (getHiddenTools(userId, skillId).includes(name)) {
      return `Tool "${name}" is hidden by your settings.`;
    }
  }
  if (execSnapshotPath || requireSandbox) {
    if (!shouldSandboxSkill(wrap) || !execSnapshotPath) {
      throw new Error(`reviewed safe-auto execution requires a sandboxed immutable snapshot for "${skillId}"`);
    }
    return runCustomSkillValue({ userId, agentId, skillId, name, args, execSnapshotPath });
  }
  if (shouldSandboxSkill(wrap)) return runCustomSkillValue({ userId, agentId, skillId, name, args });
  const exec = await getExecutorByKey(key);
  if (!exec) return `Tool "${name}" could not load from skill "${skillId}".`;
  return exec(name, args, userId, agentId, await buildCtx(userId, agentId, skillId));
}

export async function executeRoleToolForSkill(skillId, name, args, userId = 'default', agentId = null) {
  return executeRoleToolForSkillInternal(skillId, name, args, userId, agentId);
}

/**
 * Safe-auto-only exact dispatcher. It reads and hashes reviewed bytes once,
 * overlays that private snapshot at the canonical execute.mjs path inside a
 * mandatory sandbox, and cleans it up only after the child exits. Mutable disk
 * code and in-process executor caches are never used by this seam.
 */
export async function executeReviewedRoleToolForSkill(
  skillId, name, args, userId = 'default', agentId = null, expectedDigest = '',
) {
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap || wrap.manifest.id !== skillId || !shouldSandboxSkill(wrap)) {
    throw new Error(`reviewed safe-auto skill "${skillId}" is unavailable or not sandboxed`);
  }
  const { materializeReviewedInformationalSnapshot } = await import('./lib/personalization/reviewed-informational-skills.mjs');
  const snapshot = materializeReviewedInformationalSnapshot(
    userId, { ...wrap.manifest, userScope: wrap.userId }, expectedDigest,
  );
  if (!snapshot) throw new Error(`reviewed safe-auto snapshot for "${skillId}" could not be verified`);
  try {
    return await executeRoleToolForSkillInternal(skillId, name, args, userId, agentId, {
      execSnapshotPath: snapshot.execPath,
      requireSandbox: true,
    });
  } finally {
    snapshot.cleanup();
  }
}

/** Exact immutable-snapshot dispatcher for a user-approved preference grant. */
export async function executeGrantedRoleToolForSkill(
  skillId, name, args, userId = 'default', agentId = null, expectedIdentity = {},
) {
  const key = resolveKey(skillId, userId);
  const wrap = key ? _manifests.get(key) : null;
  if (!wrap || wrap.manifest.id !== skillId || !shouldSandboxSkill(wrap)) {
    throw new Error(`approved preference skill "${skillId}" is unavailable or not sandboxed`);
  }
  const grants = await import('./lib/personalization/skill-preference-grants.mjs');
  const manifest = { ...wrap.manifest, userScope: wrap.userId };
  const snapshot = grants.materializeGrantedSkillSnapshot(userId, manifest, expectedIdentity);
  if (!snapshot) throw new Error(`approved preference snapshot for "${skillId}" could not be verified`);
  try {
    return await executeRoleToolForSkillInternal(skillId, name, args, userId, agentId, {
      execSnapshotPath: snapshot.execPath,
      requireSandbox: true,
    });
  } finally {
    snapshot.cleanup();
  }
}

// Execute a tool — routes to the skill that owns it, scoped to what `userId` can see.
export async function executeRoleTool(name, args, userId = 'default', agentId = null) {
  for (const [key, wrap] of visibleEntries(userId)) {
    if (wrap.manifest.tools?.some(t => t.function?.name === name)) {
      const skillId = wrap.manifest.id;
      // Same last-line gates executeToolStreaming enforces. This entry point
      // (the local-intent fast-path via runIntent, and executeTool callers
      // like /api/email/action) used to skip all three — a child whose phrase
      // matched a localIntent of a non-allowed skill ran the tool ungated,
      // and disabled-skill / hidden-tool overrides didn't apply here.
      if (userId) {
        if (!isSkillAllowedForUser(skillId, userId)) {
          return `Tool "${name}" is not permitted for this account.`;
        }
        if (!isSkillRuntimeEnabledForUser(skillId, userId, agentId)) {
          return `Tool "${name}" is from a disabled skill.`;
        }
        if (getHiddenTools(userId, skillId).includes(name)) {
          return `Tool "${name}" is hidden by your settings.`;
        }
      }
      if (shouldSandboxSkill(wrap)) return runCustomSkillValue({ userId, agentId, skillId, name, args });
      const exec = await getExecutorByKey(key);
      if (exec) return exec(name, args, userId, agentId, await buildCtx(userId, agentId, skillId));
      break;
    }
  }
  return null; // not handled by any skill
}

// Convenience alias — resolves tool to role and executes, with "Unknown tool" fallback
export async function executeTool(name, args, userId = 'default', agentId = null) {
  const result = await executeRoleTool(name, args, userId, agentId);
  if (result !== null) return result;
  return `Unknown tool: ${name}`;
}

// Tool name aliases — models sometimes call a bare name instead of the prefixed one.
const TOOL_ALIASES = {
  'todo_write':       'coder_todo_write',
  'todo_read':        'coder_todo_read',
  'write_file':       'coder_write_file',
  'read_file':        'coder_read_file',
  'edit_file':        'coder_edit_file',
  'run_command':      'coder_run_command',
  'list_files':       'coder_list_files',
  'search':           'coder_search',
  'create_project':   'coder_create_project',
  'switch_project':   'coder_switch_project',
  'start_server':     'coder_start_server',
  'stop_server':      'coder_stop_server',
  'server_status':    'coder_server_status',
};

// Explicit self-management/Cortex mutations that an authenticated verifier
// must never execute. Ordinary task side effects remain live so the harness
// still exercises the production tools it is validating.
const NON_LEARNING_BLOCKED_TOOLS = new Set([
  'skill_add_rule', 'role_add_rule',
  'skill_remove_rule', 'role_remove_rule',
  'set_email_send_without_confirm',
  'claim_role',
  'remember_fact', 'forget_fact',
  'teach_fastpath_phrase', 'forget_fastpath_phrase',
]);

// Read a user's profile directly without going through routes/_helpers.mjs
// (which would create a circular import). Used only for the child-account
// tool gate below — a tight, read-only, non-cached path.
function _readUserProfile(userId) {
  if (!userId) return null;
  try {
    const p = path.join(USERS_DIR, userId, 'profile.json');
    if (!existsSync(p)) return null;
    const profile = JSON.parse(readFileSync(p, 'utf8'));
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    if (profile.id !== userId || !['owner', 'admin', 'user', 'child'].includes(profile.role)) return null;
    return profile;
  } catch { return null; }
}

// Streaming variant — if the skill's executor returns an async generator, streams it.
// Otherwise wraps the promise result in a single { type: 'result' } yield.
// Yields: { type: 'token', text } | { type: 'tool_call', name, args }
//         | { type: 'tool_result', name, text } | { type: 'result', text }
//
// allowedTools: optional array of tool names (from agent.tools resolution).
// When provided, any tool call outside that set is refused — defends against
// LLM hallucinated calls and prompt-injected JSON tool_calls that try to
// reach destructive tools (node_exec, dispatch_op, send_email, etc.) outside
// the agent's declared toolset. Caller is responsible for resolving alias
// names before passing the list (we re-check post-alias below).
export async function* executeToolStreaming(name, args, userId = 'default', agentId = null, allowedTools = null) {
  const turnContext = getTurnContext();
  const suppressLearning = turnContext?.suppressLearning === true;
  // Resolve alias before lookup so models that drop the skill prefix still work.
  const resolvedName = TOOL_ALIASES[name] ?? name;

  // The dispatcher authenticates the verifier lease and binds the ambient
  // turn to the exact case allowlist. Enforce it before manifest lookup or
  // executor invocation. An empty verifier list deliberately allows no tool.
  if (Array.isArray(turnContext?.verifierAllowedTools)) {
    const verifierAllow = new Set(turnContext.verifierAllowedTools
      .flatMap(tool => [tool, TOOL_ALIASES[tool] ?? tool]));
    if (!verifierAllow.has(resolvedName)) {
      log.warn('tool', 'lab verifier blocked out-of-case tool', {
        tool: resolvedName, userId, agentId,
      });
      yield {
        type: 'result',
        text: `Tool "${name}" is outside this verification case.`,
        isError: true,
      };
      return;
    }
  }

  if (suppressLearning && NON_LEARNING_BLOCKED_TOOLS.has(resolvedName)) {
    yield {
      type: 'result',
      text: `Tool "${resolvedName}" is unavailable during this non-learning verification turn.`,
      isError: true,
    };
    return;
  }

  // Per-agent allowlist enforcement. Reject with a generic "Unknown tool"
  // message so a probing model can't enumerate which tools exist on the box.
  // `null` means the legacy caller supplied no per-turn schema boundary.
  // An explicit empty array means the current turn has zero allowed tools and
  // must fail closed; treating [] like null lets a model-emitted tool call
  // bypass an intentionally empty worker/child schema.
  if (Array.isArray(allowedTools)) {
    const allow = new Set(allowedTools.flatMap(n => [n, TOOL_ALIASES[n] ?? n]));
    if (!allow.has(resolvedName)) {
      log.warn('tool', 'tool call outside agent allowlist', { tool: resolvedName, userId, agentId });
      yield { type: 'result', text: `Unknown tool: ${name}` };
      return;
    }
  }

  let owningKey = null;
  let owningSkillId = null;
  let owningWrap = null;
  // MCP-namespaced server tools (mcp_<server>__<tool>) route to skills/mcp/.
  // Detected by the `__` namespace separator — NOT just the `mcp_` prefix,
  // because the mcp-admin skill's tools (mcp_list_servers, mcp_add_server,
  // mcp_remove_server, mcp_assign_server, mcp_unassign_server, mcp_refresh)
  // share the prefix but live in a static manifest and resolve normally
  // through the manifest scan below. The double-underscore is the
  // unambiguous marker that this tool came from a third-party MCP server.
  if (resolvedName.startsWith('mcp_') && resolvedName.includes('__')) {
    for (const [key, wrap] of visibleEntries(userId)) {
      if (wrap.manifest.id === 'mcp') {
        owningKey = key;
        owningSkillId = 'mcp';
        owningWrap = wrap;
        break;
      }
    }
  }
  if (!owningWrap) {
    for (const [key, wrap] of visibleEntries(userId)) {
      if (wrap.manifest.tools?.some(t => t.function?.name === resolvedName)) {
        owningKey = key;
        owningSkillId = wrap.manifest.id;
        owningWrap = wrap;
        break;
      }
    }
  }

  if (!owningWrap || !owningKey || !owningSkillId) {
    yield { type: 'result', text: `Unknown tool: ${name}` };
    return;
  }

  // Child-account allowedSkills enforcement — blocks tool calls that the model
  // hallucinated or that arrived via a delegation/prompt-injection path where
  // tool schema wasn't normally offered. Authorization happens before executor
  // loading: importing a custom execute.mjs evaluates its top-level code, so a
  // denied skill must never reach getExecutorByKey in the first place.
  if (!isSkillAllowedForUser(owningSkillId, userId)) {
    yield { type: 'result', text: `Tool "${name}" is not permitted for this account.` };
    return;
  }

  // Phase-10: defense-in-depth. listRoles/getRoleTools already filter the
  // catalog the LLM sees, but if a tool name leaks via aliasing, manual
  // request_tools, or a delegated turn that pre-resolved its toolset, we
  // still want disabled-skill/hidden-tool overrides to win at the gate.
  if (userId && owningSkillId) {
    if (!isSkillRuntimeEnabledForUser(owningSkillId, userId, agentId)) {
      yield { type: 'result', text: `Tool "${name}" is from a disabled skill.` };
      return;
    }
    if (getHiddenTools(userId, owningSkillId).includes(resolvedName)) {
      yield { type: 'result', text: `Tool "${name}" is hidden by your settings.` };
      return;
    }
  }

  // Choose the isolation path before loading any executor code. Sandboxed
  // custom skills are never imported into the OE process; their execute.mjs is
  // evaluated only by the jailed subprocess. Trusted/global executors load
  // in-process after all account and per-tool authorization gates pass.
  let skillExec = null;
  if (shouldSandboxSkill(owningWrap)) {
    const sandboxedSkillId = owningSkillId;
    skillExec = (n, a, _u, _a, ctx) => runCustomSkillValue({
      userId,
      agentId,
      skillId: sandboxedSkillId,
      name: n,
      args: a,
      signal: ctx?.signal ?? getTurnContext()?.signal ?? null,
    });
  } else {
    skillExec = await getExecutorByKey(owningKey);
  }
  if (!skillExec) { yield { type: 'result', text: `Unknown tool: ${name}` }; return; }

  // Memory scoping is recorded only after authorization succeeds. Scopable =
  // service roles + custom specialist skills assigned to an agent; utility
  // skills (self-mgmt, web, delegate, tasks…) stay shared.
  if (!suppressLearning) {
    try { if (isScopableSkill(owningSkillId, userId)) recordDomainSkill(owningSkillId); }
    catch { /* lookup best-effort */ }
  }
  // Use resolvedName for actual execution
  name = resolvedName;

  // SECURITY: strip internal underscore-prefixed keys from model-supplied args
  // before they reach any skill executor. Several skills implement confirmation
  // gates keyed off a server-set flag (email purge/trash → `_userApproved`,
  // profile trust-state → `_userApproved`); without this, a model (or a
  // prompt-injected turn) could forge approval by emitting `_userApproved:true`
  // in its tool call. The INTERNAL approval re-dispatch does NOT go through this
  // function — skills call their own execute()/handler directly (e.g.
  // executePendingEmail, executePendingProven from chat-dispatch), so stripping
  // here only blocks the model-provided path and leaves real approval working.
  // Underscore keys are never part of a tool's public schema, so this is inert
  // for every legitimate call.
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    let _stripped = null;
    for (const k of Object.keys(args)) {
      if (k.charCodeAt(0) === 0x5f /* '_' */) {
        if (!_stripped) _stripped = { ...args };
        delete _stripped[k];
      }
    }
    if (_stripped) args = _stripped;
  }

  // Phase-2: merge accepted default-arg pins before invocation. User-provided
  // args win over pins — mergeDefaults only fills keys absent from `args`.
  // Sync read (small JSON, cached at OS level) so we don't add an await before
  // the LLM-visible dispatch yield.
  const mergedArgs = (args && typeof args === 'object') ? mergeDefaults(userId, name, args) : args;

  // Ephemeral-delegation memoization: same (toolName, args) within one
  // delegated session returns the prior result, skipping skill execution +
  // the LLM turn that would parse the round-trip. Only fires for the small
  // read-only whitelist defined in lib/ephemeral-tool-cache.mjs — anything
  // that can mutate state is never memoized. Cache initialized by
  // skills/delegate/execute.mjs at delegation entry.
  if (_isEphem(agentId)) {
    const hit = _ephemCacheGet(agentId, name, mergedArgs);
    if (hit) {
      log.info('tool', 'ephemeral cache hit', { tool: name, agentId });
      yield { type: 'result', text: `[cached from earlier ${name} this session]\n${hit.text}` };
      return;
    }
  }

  // Phase-4.5: record fill/reaffirm/override events for the default_arg
  // outcome measurer. Fire-and-forget — never blocks dispatch.
  if (!suppressLearning && args && typeof args === 'object') {
    recordPinUsage(userId, name, args)
      .catch(e => console.warn('[tool-defaults] pin-usage record failed:', e.message));
  }

  const _toolStart = Date.now();
  // Phase-14e: any tool taking longer than this auto-backgrounds. The
  // network/promise stays alive — events just get redirected to a
  // task_proxy chip instead of yielding up to the LLM. The coordinator's turn
  // finishes immediately with a "still running, see chip" synthetic result.
  // A verifier-owned tool must remain inside its correlated turn. A generous
  // foreground deadline prevents the normal UX auto-background path from
  // detaching learning/report work beyond the terminal frame.
  const AUTO_BG_MS = _autoBackgroundDelayMs(suppressLearning);
  const AUTO_BG_ENABLED = autoBackgroundToolsInCurrentContext();

  // Ephemeral-delegation post-processor for the final `{type:'result'}` yield.
  // Two things happen here, only when agentId is an ephemeral_deleg_* session:
  //   (a) For list-style tools (list_files, search_files, grep), the result
  //       text is run through the embedder ranker so the most task-relevant
  //       lines surface first with a ★ prefix. Ordering hint only — never
  //       drops items, falls back to original text on any embed failure.
  //   (b) The (possibly-reranked) text is memoized under (toolName, args).
  //       Future identical calls within the same session short-circuit at
  //       the cache check above this function in the dispatcher.
  // A skill that catches its own error and RETURNS an error string (the legacy
  // `return `Error: …`` convention, or `ctx.toolError(...)`) otherwise looks
  // identical to success. These flags, set in _postProcessResult below, route it
  // through the failure path at the bottom of this function.
  let _resultWasError = false;
  let _lastErrText = '';
  let _lastResultText = ''; // personalization: last post-processed result text, read at the completion site below
  const _postProcessResult = async (value) => {
    // Tool-error tagging — runs for ALL agents (not just ephemeral). Tag the
    // result so the trace reads ok:false and the bottom counts a failure.
    if (value?.type === 'result' && typeof value.text === 'string') {
      const norm = normalizeToolResult(value.text);
      if (norm.isError) {
        _resultWasError = true;
        _lastErrText = norm.text;
        value = { ...value, text: norm.text, isError: true };
      }
    }
    if (value?.type === 'result' && typeof value.text === 'string') _lastResultText = value.text;
    if (!_isEphem(agentId)) return value;
    if (value?.type !== 'result' || typeof value.text !== 'string') return value;
    let outText = value.text;
    if (_ephemIsListTool(name)) {
      try { outText = await _ephemRerank(agentId, name, outText); }
      catch { /* embedder error → keep original */ }
    }
    _ephemCacheSet(agentId, name, mergedArgs, outText);
    return outText === value.text ? value : { ...value, text: outText };
  };
  // Count a tool failure (threshold-gated tool_failure proposal). Shared by the
  // throw path (catch below) and the caught-and-returned-error path.
  const _reportToolFailure = (message) => {
    if (suppressLearning) return;
    recordToolFailure(userId, name, message).then(async signal => {
      if (signal?.proposed) {
        try {
          const { proposeToolFailure } = await import('./lib/proposals.mjs');
          await proposeToolFailure({
            userId, agentId: agentId || '',
            tool: signal.tool,
            skillId: owningSkillId,
            recentErrors: signal.recentErrors,
            count: signal.count,
          });
        } catch (err) {
          console.warn('[tool-failures] propose failed:', err.message);
        }
      }
    }).catch(err => console.warn('[tool-failures] record failed:', err.message));
  };
  // Every invocation owns a distinct controller. The surrounding worker,
  // delegation, scheduled run, or foreground turn is the parent owner; aborting
  // it reaches the skill immediately through ctx.signal. A distinct controller
  // also gives an execution that is later transferred to a task_proxy a stable
  // per-tool cancellation identity.
  const toolAbort = createLinkedAbortController(
    turnContext?.signal ?? null,
    `Tool ${name} cancelled by its owner`,
  );
  let toolExecutionSettled = false;
  let toolExecutionTransferred = false;
  try {
    if (toolAbort.signal.aborted) throw abortError(toolAbort.signal, `Tool ${name} cancelled`);
    const result = skillExec(
      name,
      mergedArgs,
      userId,
      agentId,
      await buildCtx(userId, agentId, owningSkillId, toolAbort.signal),
    );

    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      // ── Streaming path ──────────────────────────────────────────────────
      const iter = result[Symbol.asyncIterator]();
      const startedAt = Date.now();
      let backgrounded = false;
      let watcherId = null;
      let watchersMod = null;
      /** @type {{agentName?: string, agentEmoji?: string, targetAgentId?: string, chipWatcherId?: string, chipTaskId?: string} | null} */
      let delegatedMeta = null;

      const rememberDelegationMeta = (value) => {
        if (!value || typeof value !== 'object') return;
        if (!value.delegated && !value.agentName && !value.targetAgentId && !value.sourceLabel) return;
        const sourceLabel = typeof value.sourceLabel === 'string' ? value.sourceLabel.trim() : '';
        let agentName = typeof value.agentName === 'string' ? value.agentName.trim() : '';
        let agentEmoji = typeof value.agentEmoji === 'string' ? value.agentEmoji.trim() : '';
        if (!agentName && sourceLabel) agentName = sourceLabel;
        if (sourceLabel && agentName && sourceLabel !== agentName && sourceLabel.endsWith(agentName)) {
          const maybeEmoji = sourceLabel.slice(0, -agentName.length).trim();
          if (maybeEmoji && !agentEmoji) agentEmoji = maybeEmoji;
        }
        delegatedMeta = {
          ...(delegatedMeta || {}),
          ...(agentName ? { agentName } : {}),
          ...(agentEmoji ? { agentEmoji } : {}),
          ...(value.targetAgentId ? { targetAgentId: value.targetAgentId } : {}),
          // The delegate skill already runs a task_proxy chip + registry entry
          // for this delegation — remember them so the auto-bg crossing below
          // ADOPTS that chip instead of registering a duplicate.
          ...(value.chipWatcherId ? { chipWatcherId: value.chipWatcherId } : {}),
          ...(value.chipTaskId ? { chipTaskId: value.chipTaskId } : {}),
        };
      };

      let iterFinished = false;
      /**
       * Keep exactly one iterator read in flight. If the 10-second boundary
       * wins, this same promise is transferred to the detached drain; calling
       * iter.next() again there would skip a boundary value (or strand its
       * rejection as an unhandled promise).
       * @type {Promise<IteratorResult<any>> | null}
       */
      let pendingNext = null;
      let autoBgDeadline = startedAt + AUTO_BG_MS;
      try {
      while (true) {
        if (!pendingNext) pendingNext = Promise.resolve().then(() => iter.next());
        const timeoutMs = Math.max(0, autoBgDeadline - Date.now());
        // A detached task_proxy must retain ownership until its tool really
        // settles. Only foreground turns race the read against the UX timer.
        const outcome = AUTO_BG_ENABLED
          ? await racePendingIteratorNext(pendingNext, timeoutMs, toolAbort.signal)
          : await raceWithAbort(
              pendingNext.then(
                next => ({ kind: 'next', next }),
                error => ({ kind: 'error', error }),
              ),
              toolAbort.signal,
              `Tool ${name} cancelled`,
            );

        let value;
        const boundaryTimedOut = outcome.kind === 'timeout';
        if (!boundaryTimedOut) {
          // The pending promise settled in the foreground. Clear it only now;
          // on a timeout the detached path must inherit this exact read.
          pendingNext = null;
          if (outcome.kind === 'error') {
            // Tool threw during iteration — bubble up. The outer catch handles
            // background-mode errors separately once ownership is detached.
            iterFinished = true;
            toolExecutionSettled = true;
            throw outcome.error;
          }
          const next = outcome.next;
          if (next.done) {
            iterFinished = true;
            toolExecutionSettled = true;
            break;
          }
          if (toolAbort.signal.aborted) throw abortError(toolAbort.signal, `Tool ${name} cancelled`);
          value = next.value;
          rememberDelegationMeta(value);
        } else if (hasPendingPrompt(userId)) {
          // Consent/credential prompts remain foreground-owned. Keep the same
          // pending iterator read and re-arm the boundary without busy-looping.
          autoBgDeadline = Date.now() + AUTO_BG_MS;
          continue;
        }

        // First time crossing 10s: register chip, yield deferred result, and
        // hand the still-pending iterator read to a detached worker. Racing
        // the read itself is essential for a stream that emits nothing for
        // longer than the boundary; checking elapsed time only after next()
        // resolves leaves that stream stuck in the foreground indefinitely.
        if (!backgrounded && boundaryTimedOut) {
          const displayName = delegatedMeta?.agentName || name;
          const displayEmoji = delegatedMeta?.agentEmoji || (delegatedMeta ? '' : '⏵');
          const label = `${displayEmoji || '⏵'} ${displayName}`.trim();
          const adoptedChipId = delegatedMeta?.chipWatcherId || null;
          const freshTaskId = adoptedChipId
            ? null
            : `autobg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          let freshOwnerRegistered = false;
          let cancelBackgroundOwner = null;
          try {
            watchersMod = await import('./scheduler/watchers.mjs');
            const taskGraph = await import('./background-tasks.mjs');
            const rootAgentId = await _resolveAttributionAgent(userId, agentId);
            if (adoptedChipId) {
              // The delegate skill already registered a task_proxy chip for
              // this delegation — ADOPT it instead of creating a second one.
              // (The old behavior double-chipped every sync delegation that
              // crossed 10s: one chip from the skill, one from this net.)
              watcherId = adoptedChipId;
            } else {
              watcherId = watchersMod.registerWatcher({
                userId,
                agentId: rootAgentId,
                kind: 'task_proxy',
                label,
                state: {
                  taskId: freshTaskId,
                  status: 'running',
                  targetAgentName: displayName,
                  targetAgentEmoji: displayEmoji || '⏵',
                  ...(delegatedMeta?.targetAgentId ? { targetAgentId: delegatedMeta.targetAgentId } : {}),
                  tool: name,
                  phase: 'backgrounded',
                  summary: `${displayName} is still running`,
                  startedAt,
                  lastActivityAt: Date.now(),
                  canCancel: true,
                },
                cadenceSec: 30,
                expiresAt: null,
              });
              if (!taskGraph.registerAutoBackgroundTool({
                taskId: freshTaskId,
                userId,
                agentId: rootAgentId,
                toolName: name,
                watcherId,
                startedAt,
                abort: reason => toolAbort.abort(reason),
              })) {
                throw new Error('slow-tool owner registration failed');
              }
              freshOwnerRegistered = true;
            }
            backgrounded = true;
            cancelBackgroundOwner = reason => taskGraph.cancelTask(
              userId,
              freshTaskId || delegatedMeta?.chipTaskId || watcherId,
              reason,
            );
            taskGraph.registerTaskRoot({
              userId,
              rootTaskId: watcherId,
              rootWatcherId: watcherId,
              visibleAgentId: rootAgentId,
              summary: `${displayName} is still running`,
            });
            watchersMod.pushWatcherStatus(userId, watcherId, `${displayName} is still running in the background`, {
              rootTaskId: watcherId,
              phase: 'backgrounded',
              currentTool: name,
              canCancel: true,
            });
          } catch (e) {
            console.warn('[auto-bg] watcher register failed; staying foreground:', e.message);
            if (!adoptedChipId && watcherId) {
              if (freshOwnerRegistered) {
                try {
                  const bg = await import('./background-tasks.mjs');
                  bg.markAutoBackgroundToolTerminal(freshTaskId, {
                    status: 'error', error: 'Slow-tool ownership handoff failed.',
                  });
                  bg.retireAutoBackgroundTool(freshTaskId);
                  bg.clearTaskRoot(watcherId);
                } catch { /* foreground still owns the exact pending iterator read */ }
                freshOwnerRegistered = false;
              }
              try { watchersMod?.unregisterWatcher?.(userId, watcherId, 'handoff_failed'); }
              catch { /* foreground still owns the exact pending iterator read */ }
              watcherId = null;
            }
            // Keep ownership of the SAME pending read and retry the boundary
            // later instead of spinning or issuing a concurrent iter.next().
          }

          if (backgrounded) {
            // Inform the coordinator's LLM the tool was backgrounded — its turn
            // ends gracefully with this message in place of the real result.
            yield { type: 'result', text: `${displayName} is running in the background (task ${watcherId}). The result will be delivered to you automatically when it finishes. If the user asks about it before then, call list_active_agents to find this task and get_task_log to read its live progress and partial results — never tell the user you have no information about it.` };
            yield { type: '__hide_turn', reason: 'bg_chip', taskId: watcherId };

            // Detached worker: continue draining iter, push to chip, finalize
            // when done. The tool's network/promise stays alive — we just
            // route its output to a different sink.
            const captured = {
              name,
              watcherId,
              userId,
              agentId: await _resolveAttributionAgent(userId, agentId),
              owningSkillId,
              startedAt,
              displayName,
              displayEmoji,
              targetAgentId: delegatedMeta?.targetAgentId || null,
              adopted: !!adoptedChipId,
              chipTaskId: delegatedMeta?.chipTaskId || null,
              taskId: freshTaskId,
              args: mergedArgs,
              pendingNext,
              toolSignal: toolAbort.signal,
              disposeToolSignal: toolAbort.dispose,
              scheduledCtx: getScheduledContext(),
              cancel: cancelBackgroundOwner,
              rootTaskId: watcherId,
              rootWatcherId: watcherId,
            };
            captured.visibleAgentId = captured.agentId;
            // Voice origin (from the turn's ALS context, live at capture
            // time): lets the completion below announce itself on the
            // originating device's speaker instead of silently posting to
            // chat that nobody is looking at.
            try {
              const { getTurnContext } = await import('./lib/turn-abort-context.mjs');
              const _tc = getTurnContext();
              captured.voiceDeviceId = _tc?.deviceId ?? null;
              captured.voiceConversation = !!_tc?.conversationMode;
            } catch { captured.voiceDeviceId = null; }
            // Voice-origin work lights the device's WAITING ring while it
            // runs (paired −1 in the drain's finally below).
            if (captured.voiceDeviceId) {
              import('./ws-handler.mjs')
                .then(m => m.noteDeviceBackgroundWork(captured.voiceDeviceId, +1))
                .catch(() => {});
            }
            _registerScheduledAutoBgChild({
              scheduledCtx: captured.scheduledCtx,
              userId: captured.userId,
              watcherId: captured.watcherId,
              label: `${captured.displayName || captured.name}: ${captured.name}`,
              kind: captured.owningSkillId === 'delegate' ? 'delegate-tool' : 'tool',
              cancel: captured.cancel,
            });
            (async () => {
              let finalCompletion = null;
              const finalImages = [];
              let finalNotify = null;
              let ownerTerminal = {
                status: 'error', result: '', error: `${captured.name} ended without terminal evidence`,
              };
              let ownerMarked = false;
              const appendFinalImage = (image) => {
                if (!image || (!image.filename && !image.base64 && !image.savedPath)) return;
                const normalized = {
                  ...(image.base64 ? { base64: image.base64 } : {}),
                  mimeType: image.mimeType || image.mediaType || 'image/png',
                  ...(image.filename ? { filename: image.filename } : {}),
                  ...(image.savedPath ? { savedPath: image.savedPath } : {}),
                };
                const key = normalized.savedPath || normalized.filename || normalized.base64?.slice(0, 64);
                if (!finalImages.some(existing => (existing.savedPath || existing.filename || existing.base64?.slice(0, 64)) === key)) {
                  finalImages.push(normalized);
                }
              };
              try {
                const { runInTaskContext } = await import('./lib/task-proxy-context.mjs');
                await runInTaskContext({
                  taskId: captured.taskId || captured.chipTaskId || _autoBgChildId(captured.watcherId),
                  watcherId: captured.watcherId,
                  userId: captured.userId,
                  agentId: captured.agentId,
                  rootTaskId: captured.rootTaskId,
                  rootWatcherId: captured.rootWatcherId,
                  visibleAgentId: captured.visibleAgentId,
                  spanId: `${captured.rootTaskId}:${captured.name}`,
                }, async () => {
                  // Start with the exact iter.next() that lost the foreground
                  // race. Its first value, done marker, or rejection belongs
                  // to this drain and must not be skipped at the handoff.
                  let nextPromise = captured.pendingNext;
                  while (true) {
                    const r = await raceWithAbort(
                      nextPromise,
                      captured.toolSignal,
                      `Tool ${captured.name} cancelled`,
                    );
                    if (r.done) break;
                    const v = r.value;
                    rememberDelegationMeta(v);
                    if (v?.type === 'tool_progress' && v.text) {
                      watchersMod.pushWatcherStatus(captured.userId, captured.watcherId, String(v.text).slice(-1200), {
                        rootTaskId: captured.rootTaskId,
                        phase: 'streaming',
                        currentTool: captured.name,
                        canCancel: true,
                      });
                    } else if (v?.type === 'image') {
                      // Media is a first-class stream event. Collect it for the
                      // durable/live report directly rather than smuggling it
                      // through a later result._images payload.
                      appendFinalImage(v);
                    } else if (v?.type === 'result') {
                      // Run the same normalization/error classification as a
                      // foreground result. Once any final result is an error,
                      // a later stray result must not turn the detached job
                      // back into success.
                      const processed = await _postProcessResult(v);
                      const completion = normalizeAutoBgCompletion(processed, captured.displayName);
                      if (!finalCompletion?.isError || completion.isError) finalCompletion = completion;
                      // Keep compatibility with older structured-result tools;
                      // new streaming tools should emit type:'image' instead.
                      if (Array.isArray(v._images)) v._images.forEach(appendFinalImage);
                      if (v._notify) finalNotify = v._notify;
                      const preview = completion.text.split('\n').find(l => l.trim()) || '';
                      if (preview) {
                        watchersMod.pushWatcherStatus(captured.userId, captured.watcherId, `${captured.displayName}: ${preview.slice(0, 240)}`, {
                          rootTaskId: captured.rootTaskId,
                          phase: 'result',
                          currentTool: null,
                          canCancel: true,
                        });
                      }
                    }
                    nextPromise = Promise.resolve().then(() => iter.next());
                  }
                });
                const bg = await import('./background-tasks.mjs');
                const completion = finalCompletion ?? normalizeAutoBgCompletion('', captured.displayName);
                ownerTerminal = {
                  status: completion.status,
                  result: completion.isError ? '' : completion.content,
                  error: completion.isError ? completion.content : null,
                };
                if (captured.taskId) {
                  ownerMarked = bg.markAutoBackgroundToolTerminal(captured.taskId, ownerTerminal);
                  if (!ownerMarked) throw new Error('slow-tool terminal journal update failed');
                }
                const finalReportImages = finalImages.length ? finalImages : null;
                // Personalization mirror: this result lands after the turn
                // ends, so the primary hook (executeToolStreaming's common
                // completion path) never sees it — record it here instead.
                if (!suppressLearning) try {
                  recordToolObservation({
                    userId: captured.userId, agentId: captured.agentId, toolName: captured.name,
                    skillId: captured.owningSkillId, args: captured.args,
                    resultText: completion.observation.resultText, ok: completion.observation.ok,
                    // Drain runs after the turn's async context is gone — derive
                    // origin from the scheduledContext captured at dispatch time.
                    origin: captured.scheduledCtx?.originTaskId ? 'automation' : 'interactive',
                  });
                } catch { /* never block auto-bg finalization */ }
                if (completion.isError) _reportToolFailure(completion.text);
                if (captured.adopted) {
                  // Chip + root-graph finalization belong to the delegate
                  // skill's sync-delegation handle (children-aware, already ran
                  // when the generator finished). A returned tool error is the
                  // exception: explicitly correct the adopted handle so it can
                  // never remain finalized as a successful delegation.
                  if (completion.isError) {
                    if (captured.chipTaskId) {
                      bg.completeSyncDelegation(captured.chipTaskId, {
                        outcome: 'error',
                        finalText: completion.watcherFinalText,
                        finalReportPreview: completion.content.slice(0, 800),
                      });
                    }
                    watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                      status: completion.status,
                      finalText: completion.watcherFinalText,
                    });
                  }
                } else {
                  const deferred = !captured.scheduledCtx?.originTaskId && bg.deferRootCompletion({
                    userId: captured.userId,
                    rootTaskId: captured.rootTaskId,
                    rootWatcherId: captured.rootWatcherId,
                    status: completion.status,
                    finalText: completion.watcherFinalText,
                    finalReportPreview: completion.content.slice(0, 800),
                  });
                  if (deferred) {
                    log.info('tool', 'auto-bg root waiting for delegated children', { tool: captured.name, watcherId: captured.watcherId, userId: captured.userId });
                  } else {
                    bg.clearTaskRoot(captured.rootTaskId);
                    watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                      status: completion.status,
                      finalText: completion.watcherFinalText,
                    });
                  }
                }
                // Append the result into the agent session so the next LLM
                // turn has context. Best-effort; chip is the primary surface.
                if (captured.agentId) {
                  try {
                    const { appendToSession } = await import('./sessions.mjs');
                    const key = captured.agentId.startsWith(`${captured.userId}_`) ? captured.agentId : `${captured.userId}_${captured.agentId}`;
                    // Persist with kind:'agent_report' + sender metadata so a
                    // hard browser reload re-renders the same fancy bubble
                    // the live broadcast paints. Without kind, the entry
                    // renders as a flat assistant bubble with the literal
                    // "[<name> finished in background]" prefix and loses
                    // the sender-tagged styling.
                    await appendToSession(key, {
                      role: 'assistant',
                      kind: 'agent_report',
                      agentName: captured.displayName,
                      agentEmoji: captured.displayEmoji || '⏵',
                      ...(captured.targetAgentId ? { targetAgentId: captured.targetAgentId } : {}),
                      content: completion.report.content,
                      taskId: `autobg_${captured.watcherId}`,
                      watcherId: captured.watcherId,
                      rootWatcherId: captured.rootWatcherId || captured.watcherId,
                      tool: captured.name,
                      status: completion.report.status,
                      // Durable rows strip inline base64 (multi-MB per image,
                      // re-shipped on every session_loaded) only when a stable
                      // savedPath can render instead. Live broadcast below
                      // always keeps the pixels for immediate display.
                      ...(finalReportImages ? { images: finalReportImages.map(bg.persistedReportImage).filter(Boolean) } : {}),
                      ...(finalNotify ? { notify: finalNotify } : {}),
                      ts: Date.now(),
                    });
                  } catch (_) { /* best-effort */ }
                }
                // Broadcast a notification so the user sees the result land
                // even if the task chip is scrolled out of view. Same path
                // dispatchBackground uses for background ask_agent results.
                // `agent` field tells the browser which coordinator's session
                // this report belongs to so it persists in sessions[<id>].
                try {
                  const { sendToUser } = await import('./ws-handler.mjs');
                  sendToUser(captured.userId, {
                    type: 'agent_report',
                    agent: captured.agentId ?? null,
                    agentName: captured.displayName,
                    agentEmoji: captured.displayEmoji || '⏵',
                    ...(captured.targetAgentId ? { targetAgentId: captured.targetAgentId } : {}),
                    content: completion.report.content,
                    taskId: `autobg_${captured.watcherId}`,
                    watcherId: captured.watcherId,
                    rootWatcherId: captured.rootWatcherId || captured.watcherId,
                    tool: captured.name,
                    status: completion.report.status,
                    ...(finalReportImages ? { images: finalReportImages } : {}),
                    ...(finalNotify ? { notify: finalNotify } : {}),
                    ts: Date.now(),
                  });
                } catch (_) { /* best-effort */ }
                // Speak the completion on the originating voice device —
                // idle-gated queue; with fw >= 0.2.68 it ducks any ambient
                // or AirPlay bed instead of pausing it.
                if (captured.voiceDeviceId) {
                  try {
                    const { enqueueVoiceAnnouncement, announcementLine } = await import('./lib/voice-announcements.mjs');
                    enqueueVoiceAnnouncement(
                      captured.voiceDeviceId,
                      announcementLine(captured.displayName || captured.name, completion.content, captured.args?.task || ''),
                      { kind: 'auto-bg' }
                    );
                  } catch (e) { console.warn('[auto-bg] voice announce enqueue failed:', e.message); }
                }
                await _emitAutoBgNotify(captured.userId, captured.agentId, finalNotify);
                _completeScheduledAutoBgChild({
                  scheduledCtx: captured.scheduledCtx,
                  userId: captured.userId,
                  watcherId: captured.watcherId,
                  resultText: completion.scheduled.resultText,
                  errorMsg: completion.scheduled.errorMsg,
                });
                // Scheduled runs react+finalize via the barrier; only a direct
                // (non-scheduled, non-delegated) chat gets the inline report-back.
                if (!suppressLearning && !captured.scheduledCtx?.originTaskId && !captured.targetAgentId) {
                  await _runAutoBgToolContinuation({
                    userId: captured.userId,
                    agentId: captured.agentId,
                    toolName: captured.name,
                    args: captured.args,
                    resultText: completion.continuation.resultText,
                    errorMsg: completion.continuation.errorMsg,
                  });
                }
                const completionLog = { skill: captured.owningSkillId, tool: captured.name, userId: captured.userId, durationMs: Date.now() - captured.startedAt };
                if (completion.isError) log.warn('tool', 'auto-bg tool returned error', { ...completionLog, err: completion.text.slice(0, 200) });
                else log.info('tool', 'auto-bg tool complete', completionLog);
              } catch (err) {
                const cancelled = isAbortError(err, captured.toolSignal);
                const terminalError = cancelled
                  ? abortError(captured.toolSignal, `${captured.name} cancelled`).message
                  : (err?.message || String(err));
                ownerTerminal = {
                  status: cancelled ? 'cancelled' : 'error',
                  result: '',
                  error: terminalError,
                };
                if (captured.taskId && !ownerMarked) {
                  try {
                    const bg = await import('./background-tasks.mjs');
                    ownerMarked = bg.markAutoBackgroundToolTerminal(captured.taskId, ownerTerminal);
                  } catch { /* journal remains as in-flight for restart recovery */ }
                }
                if (captured.taskId && !ownerMarked) {
                  log.error('tool', 'auto-bg terminal journal update failed', {
                    tool: captured.name, userId: captured.userId,
                  });
                  return;
                }
                // If the delegate skill died before finalizing its registry
                // entry, clean it up here — a leaked entry reads as "still
                // running" to check_workers until the 24h reaper.
                try {
                  if (captured.chipTaskId) {
                    const bg = await import('./background-tasks.mjs');
                    bg.completeSyncDelegation(captured.chipTaskId, {
                      outcome: cancelled ? 'stopped' : 'error',
                      finalText: cancelled
                        ? `■ ${captured.displayName} cancelled`
                        : `⚠ ${captured.displayName} failed: ${terminalError}`,
                    });
                  }
                } catch { /* best-effort */ }
                if (captured.adopted) {
                  watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                    status: cancelled ? 'cancelled' : 'error',
                    finalText: cancelled
                      ? `■ ${captured.name} cancelled`
                      : `⚠ ${captured.name} failed: ${terminalError}`,
                  });
                } else {
                  try {
                    const bg = await import('./background-tasks.mjs');
                    const deferred = !captured.scheduledCtx?.originTaskId && bg.deferRootCompletion({
                      userId: captured.userId,
                      rootTaskId: captured.rootTaskId,
                      rootWatcherId: captured.rootWatcherId,
                      status: cancelled ? 'cancelled' : 'error',
                      finalText: cancelled
                        ? `■ ${captured.name} cancelled`
                        : `⚠ ${captured.name} failed: ${terminalError}`,
                      finalReportPreview: terminalError.slice(0, 800),
                    });
                    if (!deferred) {
                      bg.clearTaskRoot(captured.rootTaskId);
                      watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                        status: cancelled ? 'cancelled' : 'error',
                        finalText: cancelled
                          ? `■ ${captured.name} cancelled`
                          : `⚠ ${captured.name} failed: ${terminalError}`,
                      });
                    }
                  } catch {
                    watchersMod.completeWatcher(captured.userId, captured.watcherId, {
                      status: cancelled ? 'cancelled' : 'error',
                      finalText: cancelled
                        ? `■ ${captured.name} cancelled`
                        : `⚠ ${captured.name} failed: ${terminalError}`,
                    });
                  }
                }
                await _emitAutoBgToolReport({
                  userId: captured.userId,
                  agentId: captured.agentId,
                  toolName: captured.name,
                  displayName: captured.displayName,
                  displayEmoji: captured.displayEmoji || '⏵',
                  watcherId: captured.watcherId,
                  rootWatcherId: captured.rootWatcherId || captured.watcherId,
                  targetAgentId: captured.targetAgentId,
                  content: cancelled
                    ? `${captured.displayName || captured.name} was cancelled.`
                    : `${captured.displayName || captured.name} failed: ${terminalError}`,
                  status: cancelled ? 'cancelled' : 'error',
                });
                _completeScheduledAutoBgChild({
                  scheduledCtx: captured.scheduledCtx,
                  userId: captured.userId,
                  watcherId: captured.watcherId,
                  resultText: '',
                  errorMsg: terminalError,
                });
                if (!suppressLearning && !captured.scheduledCtx?.originTaskId && !captured.targetAgentId) {
                  await _runAutoBgToolContinuation({
                    userId: captured.userId,
                    agentId: captured.agentId,
                    toolName: captured.name,
                    args: captured.args,
                    resultText: '',
                    errorMsg: terminalError,
                  });
                }
                if (cancelled) {
                  log.info('tool', 'auto-bg tool cancelled', {
                    skill: captured.owningSkillId, tool: captured.name, userId: captured.userId,
                  });
                } else {
                  log.warn('tool', 'auto-bg tool threw', {
                    skill: captured.owningSkillId, tool: captured.name,
                    userId: captured.userId, err: terminalError,
                  });
                }
              } finally {
                captured.disposeToolSignal?.();
                // Fresh slow-tool handoffs have a real registry/journal owner;
                // adopted delegation chips are already owned by their sync
                // delegation record and must not be retired here.
                if (captured.taskId) {
                  try {
                    const bg = await import('./background-tasks.mjs');
                    if (!ownerMarked) {
                      ownerMarked = bg.markAutoBackgroundToolTerminal(captured.taskId, ownerTerminal);
                    }
                    if (ownerMarked) bg.retireAutoBackgroundTool(captured.taskId);
                  } catch (e) {
                    log.warn('tool', 'auto-bg owner retirement failed', {
                      tool: captured.name, userId: captured.userId, err: e?.message || String(e),
                    });
                  }
                }
                // Release the WAITING-ring hold on success AND error paths.
                if (captured.voiceDeviceId) {
                  import('./ws-handler.mjs')
                    .then(m => m.noteDeviceBackgroundWork(captured.voiceDeviceId, -1))
                    .catch(() => {});
                }
              }
            })();
            toolExecutionTransferred = true;
            return;   // outer generator ends — LLM sees the deferred result + turn finishes
          }
          // Registration failed: stay foreground-owned, keep the same
          // pending read, and retry after another boundary interval.
          autoBgDeadline = Date.now() + AUTO_BG_MS;
          continue;
        }

        yield await _postProcessResult(value);
      }
      } finally {
        // Consumer teardown (turn aborted / Stop) abandons THIS generator at a
        // yield; without forwarding the finalization, the skill's iterator
        // stays suspended forever — its finally blocks (busy-slot release,
        // sync-delegation finishSync) never run and the delegation reads as
        // "running" until the 24h reaper. Skip when the iterator was handed
        // to the detached auto-bg worker (it owns draining it now).
        if (!iterFinished && !backgrounded) {
          try { Promise.resolve(iter.return?.()).catch(() => {}); } catch { /* best-effort */ }
        }
      }
    } else {
      // ── Single-promise path ─────────────────────────────────────────────
      // Race the await against a 10s timer. If the timer wins, register a
      // chip, yield deferred result, let the promise resolve into the chip.
      const racePromise = Promise.resolve(result);
      const TIMER_TOKEN = Symbol('AUTO_BG_TIMER');
      // Don't hurdle over a pending user prompt: while the tool is blocked
      // waiting for the user to answer a consent/credential prompt (e.g.
      // ctx.ensureRuntime's download confirmation), the auto-bg timer must NOT
      // fire a "running in the background" chip. Keep re-racing until the tool
      // finishes OR no prompt is pending. Once the user answers, the real work
      // backgrounds normally on the next tick.
      let winner;
      if (!AUTO_BG_ENABLED) {
        // The parent worker/task chip is already the user's background
        // surface. Await the real value so the model can perform dependent
        // tool calls instead of seeing a premature synthetic result.
        winner = await raceWithAbort(
          racePromise,
          toolAbort.signal,
          `Tool ${name} cancelled`,
        );
      } else {
        do {
          winner = await raceWithAbort(
            Promise.race([
              racePromise,
              new Promise(resolve => setTimeout(() => resolve(TIMER_TOKEN), AUTO_BG_MS)),
            ]),
            toolAbort.signal,
            `Tool ${name} cancelled`,
          );
        } while (winner === TIMER_TOKEN && hasPendingPrompt(userId));
      }

      promiseAutoBackground: if (winner === TIMER_TOKEN) {
        let watchersMod;
        let attribAgentId;
        let scheduledCtx;
        let wid;
        let ownerRegistered = false;
        let cancelBackgroundOwner = null;
        const autoBgTaskId = `autobg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
          watchersMod = await import('./scheduler/watchers.mjs');
          attribAgentId = await _resolveAttributionAgent(userId, agentId);
          scheduledCtx = getScheduledContext();
          wid = watchersMod.registerWatcher({
          userId,
          agentId: attribAgentId,
          kind: 'task_proxy',
          label: `⏵ ${name}`,
          state: {
            taskId: autoBgTaskId,
            status: 'running',
            targetAgentName: name,
            targetAgentEmoji: '⏵',
            tool: name,
            phase: 'backgrounded',
            summary: `${name} is still running`,
            startedAt: _toolStart,
            lastActivityAt: Date.now(),
            canCancel: true,
          },
          cadenceSec: 30,
          expiresAt: null,
          });
          watchersMod.pushWatcherStatus(userId, wid, `${name} is still running in the background`, {
            phase: 'backgrounded',
            currentTool: name,
            canCancel: true,
          });
          const bg = await import('./background-tasks.mjs');
          if (!bg.registerAutoBackgroundTool({
            taskId: autoBgTaskId,
            userId,
            agentId: attribAgentId,
            toolName: name,
            watcherId: wid,
            startedAt: _toolStart,
            abort: reason => toolAbort.abort(reason),
          })) {
            throw new Error('slow-tool owner registration failed');
          }
          ownerRegistered = true;
          cancelBackgroundOwner = reason => bg.cancelTask(userId, autoBgTaskId, reason);
        } catch (error) {
          // The promise is already running. If ownership registration fails,
          // keep this turn attached and await the real result; throwing here
          // would orphan a side effect with no watcher or completion report.
          console.warn('[auto-bg] promise watcher register failed; staying foreground:', error?.message || error);
          if (wid && !ownerRegistered) {
            try { watchersMod?.unregisterWatcher?.(userId, wid, 'handoff_failed'); }
            catch { /* foreground promise remains the execution owner */ }
          }
          winner = await raceWithAbort(
            racePromise,
            toolAbort.signal,
            `Tool ${name} cancelled`,
          );
          break promiseAutoBackground;
        }
        _registerScheduledAutoBgChild({
          scheduledCtx,
          userId,
          watcherId: wid,
          label: name,
          kind: 'tool',
          cancel: cancelBackgroundOwner,
        });
        yield { type: 'result', text: `\`${name}\` is running in the background (task ${wid}). Its result will be delivered to you automatically when it finishes. If the user asks about it before then, call list_active_agents to find this task and get_task_log to read its live progress and partial results — never tell the user you have no information about it.` };
        yield { type: '__hide_turn', reason: 'bg_chip', taskId: wid };

        let ownerTerminal = {
          status: 'error', result: '', error: `${name} ended without terminal evidence`,
        };
        let ownerMarked = false;
        const promiseOwnerContext = {
          taskId: autoBgTaskId,
          watcherId: wid,
          userId,
          agentId: attribAgentId,
          rootTaskId: wid,
          rootWatcherId: wid,
          visibleAgentId: attribAgentId,
          spanId: `${wid}:${name}`,
        };
        raceWithAbort(
          racePromise,
          toolAbort.signal,
          `Tool ${name} cancelled`,
        ).then((val) => runInTaskContext(promiseOwnerContext, async () => {
          // Normalize structured tool results like the inline path does — otherwise
          // a delayed { text, _images, _notify } result becomes the string
          // "[object Object]" and its images/notifications are lost.
          const structured = val && typeof val === 'object' && typeof val.text === 'string';
          const processed = await _postProcessResult({
            type: 'result',
            text: structured ? val.text : String(val ?? ''),
            ...(structured && Array.isArray(val._images) ? { _images: val._images } : {}),
            ...(structured && val._notify ? { _notify: val._notify } : {}),
          });
          const completion = normalizeAutoBgCompletion(processed, name);
          ownerTerminal = {
            status: completion.status,
            result: completion.isError ? '' : completion.content,
            error: completion.isError ? completion.content : null,
          };
          {
            const bg = await import('./background-tasks.mjs');
            ownerMarked = bg.markAutoBackgroundToolTerminal(autoBgTaskId, ownerTerminal);
            if (!ownerMarked) throw new Error('slow-tool terminal journal update failed');
          }
          const images = completion.images;
          const notify = completion.notify;
          // Personalization mirror: single-promise auto-bg result also lands
          // after the turn ends — same rationale as the streaming-path mirror.
          if (!suppressLearning) try {
            recordToolObservation({
              userId, agentId: attribAgentId, toolName: name, skillId: owningSkillId,
              args: mergedArgs,
              resultText: completion.observation.resultText, ok: completion.observation.ok,
              // Drain runs after the turn's async context is gone — derive
              // origin from the scheduledContext captured at dispatch time.
              origin: scheduledCtx?.originTaskId ? 'automation' : 'interactive',
            });
          } catch { /* never block auto-bg finalization */ }
          if (completion.isError) _reportToolFailure(completion.text);
          const key = agentId
            ? (agentId.startsWith(`${userId}_`) ? agentId : `${userId}_${agentId}`)
            : null;
          watchersMod.completeWatcher(userId, wid, {
            status: completion.status,
            finalText: completion.watcherFinalText,
          });
          if (key) {
            try {
              const { appendToSession } = await import('./sessions.mjs');
              const { persistedReportImage } = await import('./background-tasks.mjs');
              await appendToSession(key, {
                role: 'assistant',
                kind: 'agent_report',
                agentName: name,
                agentEmoji: '⏵',
                content: completion.report.content,
                taskId: `autobg_${wid}`,
                watcherId: wid,
                rootWatcherId: wid,
                tool: name,
                status: completion.report.status,
                // Durable rows strip inline base64 — see the streaming path.
                ...(images ? { images: images.map(persistedReportImage).filter(Boolean) } : {}),
                ...(notify ? { notify } : {}),
                ts: Date.now(),
              });
            } catch (_) { /* best-effort */ }
          }
          try {
            const { sendToUser } = await import('./ws-handler.mjs');
            sendToUser(userId, {
              type: 'agent_report',
              agent: key,
              agentName: name,
              agentEmoji: '⏵',
              content: completion.report.content,
              ...(images ? { images } : {}),
              ...(notify ? { notify } : {}),
              taskId: `autobg_${wid}`,
              watcherId: wid,
              rootWatcherId: wid,
              tool: name,
              status: completion.report.status,
              ts: Date.now(),
            });
          } catch (_) { /* best-effort */ }
          await _emitAutoBgNotify(userId, attribAgentId || agentId, notify);
          _completeScheduledAutoBgChild({
            scheduledCtx,
            userId,
            watcherId: wid,
            resultText: completion.scheduled.resultText,
            errorMsg: completion.scheduled.errorMsg,
          });
          // Scheduled runs react+finalize via the barrier; direct chats get the
          // inline report-back continuation.
          if (!suppressLearning && !scheduledCtx?.originTaskId) {
            await _runAutoBgToolContinuation({
              userId,
              agentId: attribAgentId,
              toolName: name,
              args: mergedArgs,
              resultText: completion.continuation.resultText,
              errorMsg: completion.continuation.errorMsg,
            });
          }
          const completionLog = { skill: owningSkillId, tool: name, userId, durationMs: Date.now() - _toolStart };
          if (completion.isError) log.warn('tool', 'auto-bg tool returned error', { ...completionLog, err: completion.text.slice(0, 200) });
          else log.info('tool', 'auto-bg tool complete', completionLog);
        })).catch((err) => runInTaskContext(promiseOwnerContext, async () => {
          const cancelled = isAbortError(err, toolAbort.signal);
          const terminalError = cancelled
            ? abortError(toolAbort.signal, `${name} cancelled`).message
            : (err?.message || String(err));
          ownerTerminal = {
            status: cancelled ? 'cancelled' : 'error',
            result: '',
            error: terminalError,
          };
          if (!ownerMarked) {
            try {
              const bg = await import('./background-tasks.mjs');
              ownerMarked = bg.markAutoBackgroundToolTerminal(autoBgTaskId, ownerTerminal);
            } catch { /* journal remains in-flight for restart recovery */ }
          }
          if (!ownerMarked) {
            log.error('tool', 'auto-bg terminal journal update failed', { tool: name, userId });
            return;
          }
          watchersMod.completeWatcher(userId, wid, {
            status: cancelled ? 'cancelled' : 'error',
            finalText: cancelled
              ? `■ ${name} cancelled`
              : `⚠ ${name} failed: ${terminalError}`,
          });
          await _emitAutoBgToolReport({
            userId,
            agentId: attribAgentId,
            toolName: name,
            displayName: name,
            displayEmoji: '⏵',
            watcherId: wid,
            rootWatcherId: wid,
            content: cancelled ? `${name} was cancelled.` : `${name} failed: ${terminalError}`,
            status: cancelled ? 'cancelled' : 'error',
          });
          _completeScheduledAutoBgChild({
            scheduledCtx,
            userId,
            watcherId: wid,
            resultText: '',
            errorMsg: terminalError,
          });
          if (!suppressLearning && !scheduledCtx?.originTaskId) {
            await _runAutoBgToolContinuation({
              userId,
              agentId: attribAgentId,
              toolName: name,
              args: mergedArgs,
              resultText: '',
              errorMsg: terminalError,
            });
          }
          if (cancelled) log.info('tool', 'auto-bg tool cancelled', { skill: owningSkillId, tool: name, userId });
          else log.warn('tool', 'auto-bg tool threw', { skill: owningSkillId, tool: name, userId, err: terminalError });
        })).finally(() => runInTaskContext(promiseOwnerContext, async () => {
          toolAbort.dispose();
          try {
            const bg = await import('./background-tasks.mjs');
            if (!ownerMarked) {
              ownerMarked = bg.markAutoBackgroundToolTerminal(autoBgTaskId, ownerTerminal);
            }
            if (ownerMarked) bg.retireAutoBackgroundTool(autoBgTaskId);
          } catch (e) {
            log.warn('tool', 'auto-bg owner retirement failed', {
              tool: name, userId, err: e?.message || String(e),
            });
          }
        })).catch(e => {
          log.warn('tool', 'auto-bg terminal reporting failed', {
            tool: name, userId, err: e?.message || String(e),
          });
        });
        toolExecutionTransferred = true;
        return;
      }

      // Won the race — normal sync result. If the tool returned an object
      // with a `.text` field, treat it as a structured result and preserve
      // ancillary fields (`_images` for browser_screenshot, `_notify` for
      // existing patterns) so the chat dispatcher can forward them. Plain
      // strings still flow through unchanged.
      const isStructured = winner && typeof winner === 'object' && typeof winner.text === 'string';
      if (toolAbort.signal.aborted) throw abortError(toolAbort.signal, `Tool ${name} cancelled`);
      toolExecutionSettled = true;
      yield await _postProcessResult({
        type: 'result',
        text: isStructured ? winner.text : String(winner ?? ''),
        ...(isStructured && winner._notify ? { _notify: winner._notify } : {}),
        ...(isStructured && Array.isArray(winner._images) ? { _images: winner._images } : {}),
      });
    }
    log.info('tool', 'tool complete', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart });

    // Phase-3 intent learner: record AFTER completion and ONLY on success.
    // Recording pre-exec (the old shape) learned a FAILED tool as a good
    // utterance→tool mapping — the learned_intent proposal even asserts the
    // tool "ran anyway". Covers coordinator-direct AND delegated-specialist
    // calls (both funnel through here); the local fastpath uses a different
    // executor, so local successes are intentionally NOT recorded. Auto-
    // backgrounded tools (the return paths above) also don't record: their
    // result lands after the turn, and the recorder is consumed at turn end.
    if (!suppressLearning && !_resultWasError) {
      try { recordToolExecution(userId, name); } catch { /* never block tool dispatch */ }
    }

    // Personalization: fire-and-forget observation of this tool result (the
    // recorder itself applies config/skip-list gating — this call is
    // unconditional so it also captures failures for the digest).
    if (!suppressLearning) try {
      recordToolObservation({
        userId, agentId, toolName: name, skillId: owningSkillId,
        args: mergedArgs, resultText: _resultWasError ? _lastErrText : _lastResultText, ok: !_resultWasError,
      });
    } catch { /* never block tool dispatch */ }

    // Alias-framework cascade: any registered manifest can declare
    // cascade_on_tools — when one of those tools succeeds, drop user-stored
    // aliases for the corresponding entity id. Fire-and-forget; never
    // blocks the main flow.
    if (!suppressLearning && userId) {
      import('./lib/skill-alias-framework.mjs')
        .then(fw => fw.maybeCascadeOnToolSuccess(userId, name, mergedArgs))
        .catch(() => {});
    }

    if (_resultWasError) {
      // The skill caught its own error and returned it as a string. Count a
      // failure (not a default-arg success) so flaky-tool proposals still fire
      // and the recipe learner doesn't bank a failed call as a success recipe.
      log.warn('tool', 'tool returned error', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart, err: _lastErrText.slice(0, 200) });
      _reportToolFailure(_lastErrText);
    }
  } catch (e) {
    if (isAbortError(e, toolAbort.signal)) {
      const cancellation = abortError(toolAbort.signal, `Tool ${name} cancelled`);
      log.info('tool', 'tool cancelled', {
        skill: owningSkillId,
        tool: name,
        userId,
        agentId,
        durationMs: Date.now() - _toolStart,
      });
      // Cancellation belongs to the task/turn lifecycle, not the flaky-tool
      // learner. Let the model stream owner unwind so it can publish one
      // cancelled/stopped terminal outcome.
      throw cancellation;
    }
    toolExecutionSettled = true;
    console.error(`[skills] Runtime error in tool "${name}":`, e.message);
    log.error('tool', 'tool threw', { skill: owningSkillId, tool: name, userId, agentId, durationMs: Date.now() - _toolStart, err: e.message });
    yield { type: 'result', text: `Tool error (${name}): ${e.message}`, isError: true };

    // Phase-3: count the failure. Fire-and-forget so the user's bubble lands
    // immediately. On threshold trip we emit a tool_failure proposal (the
    // owning-skill id is captured so the proposer can route the remedy through
    // refine vs a diagnostic). Shared with the caught-and-returned-error path.
    _reportToolFailure(e.message);
  } finally {
    if (!toolExecutionTransferred) {
      // A consumer can abandon a streaming tool at a yield without aborting the
      // whole turn (provider teardown, policy stop, etc.). Signal the skill's
      // cleanup path before releasing the parent listener.
      if (!toolExecutionSettled && !toolAbort.signal.aborted) {
        toolAbort.abort(`Tool ${name} execution owner stopped`);
      }
      toolAbort.dispose();
    }
  }
}
