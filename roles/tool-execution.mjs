// @ts-check
/**
 * Streaming tool dispatch (executeToolStreaming).
 * Extracted from roles.mjs. Uses registry helpers exported from roles.mjs
 * (circular import is ESM-live-binding safe for function exports).
 */
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { SKILLS_DIR, USERS_DIR, userSkillsDir, getUserFilesDir, readConfig } from '../lib/paths.mjs';
import { buildSkillCredentials } from '../lib/credentials.mjs';
import { skillDeclaresNetwork } from '../lib/skill-net-policy.mjs';
import { buildProposeMonitor, buildCollectionHelpers } from '../lib/monitor-helper.mjs';
import { buildBrowserHelpers } from '../lib/browser-helper.mjs';
import { buildDeviceHelpers } from '../lib/device-helper.mjs';
import { buildSkillLogger } from '../lib/skill-logger.mjs';
import { recordDomainSkill } from '../lib/memory-scope-context.mjs';
import { recordToolExecution } from '../lib/tool-exec-log.mjs';
import { recordToolObservation } from '../lib/personalization/recorder.mjs';
import { buildRegisterLead } from '../lib/personalization/lead-helper.mjs';
import { buildSkillPersonalizationHelpers } from '../lib/personalization/skill-helper.mjs';
import { getVoiceContext } from '../lib/voice-context.mjs';
import { listDesktops, sendDesktopCommand } from '../lib/desktop-bus.mjs';
import { getScheduledContext } from '../lib/scheduled-context.mjs';
import { registerScheduledChild, completeScheduledChild } from '../lib/scheduled-child-barrier.mjs';
import { mergeDefaults, recordPinUsage } from '../lib/tool-defaults.mjs';
import { normalizeToolResult, toolError } from '../lib/tool-error.mjs';
import { hasPendingPrompt } from '../lib/credentials.mjs';
import { recordToolFailure } from '../lib/tool-failures.mjs';
import { isSkillDisabled, getHiddenTools } from '../lib/skill-overrides.mjs';
import {
  isEphemeralAgentId as _isEphem,
  cacheGet as _ephemCacheGet,
  cacheSet as _ephemCacheSet,
  rerankListResult as _ephemRerank,
  isListStyleTool as _ephemIsListTool,
} from '../lib/ephemeral-tool-cache.mjs';
import { log } from '../logger.mjs';
import { getTurnContext } from '../lib/turn-abort-context.mjs';
import { currentTaskContext, runInTaskContext } from '../lib/task-proxy-context.mjs';
import {
  abortError,
  createLinkedAbortController,
  isAbortError,
  raceWithAbort,
} from '../lib/abort-utils.mjs';
import {
  drainIteratorIncludingBoundary,
  racePendingIteratorNext,
  autoBackgroundToolsInCurrentContext,
  normalizeAutoBgCompletion,
  _resolveAttributionAgent,
  _agentIdFromSessionKey,
  _emitAutoBgNotify,
  _runAutoBgToolContinuation,
  _autoBgChildId,
  _autoBackgroundDelayMs,
  _registerScheduledAutoBgChild,
  _completeScheduledAutoBgChild,
  _emitAutoBgToolReport,
} from './auto-background.mjs';

// Bound from roles.mjs after registry helpers are defined (avoids circular import).
/** @type {any} */
let resolveKey = () => null;
/** @type {any} */
let visibleEntries = function* () {};
/** @type {any} */
let getExecutorByKey = async () => null;
/** @type {any} */
let buildCtx = async () => ({});
/** @type {any} */
let runCustomSkillValue = async () => { throw new Error('tool-execution not bound'); };
/** @type {any} */
let shouldSandboxSkill = () => false;
/** @type {any} */
let isSkillAllowedForUser = () => true;
/** @type {any} */
let isSkillRuntimeEnabledForUser = () => true;
/** @type {any} */
let isScopableSkill = () => false;
/** @type {any} */
let getRoleManifest = () => null;
/** @type {any} */
let listRoles = () => [];
/** @type {any} */
let _readUserProfile = () => null;

export function bindToolExecutionDeps(deps) {
  resolveKey = deps.resolveKey;
  visibleEntries = deps.visibleEntries;
  getExecutorByKey = deps.getExecutorByKey;
  buildCtx = deps.buildCtx;
  runCustomSkillValue = deps.runCustomSkillValue;
  shouldSandboxSkill = deps.shouldSandboxSkill;
  isSkillAllowedForUser = deps.isSkillAllowedForUser;
  isSkillRuntimeEnabledForUser = deps.isSkillRuntimeEnabledForUser;
  isScopableSkill = deps.isScopableSkill;
  getRoleManifest = deps.getRoleManifest;
  listRoles = deps.listRoles;
  _readUserProfile = deps._readUserProfile;
}


// Tool name aliases — models sometimes call a bare name instead of the prefixed one.
export const TOOL_ALIASES = {
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
export const NON_LEARNING_BLOCKED_TOOLS = new Set([
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
          const { proposeToolFailure } = await import('../lib/proposals.mjs');
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
            watchersMod = await import('../scheduler/watchers.mjs');
            const taskGraph = await import('../background-tasks.mjs');
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
                  const bg = await import('../background-tasks.mjs');
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
              const { getTurnContext } = await import('../lib/turn-abort-context.mjs');
              const _tc = getTurnContext();
              captured.voiceDeviceId = _tc?.deviceId ?? null;
              captured.voiceConversation = !!_tc?.conversationMode;
            } catch { captured.voiceDeviceId = null; }
            // Voice-origin work lights the device's WAITING ring while it
            // runs (paired −1 in the drain's finally below).
            if (captured.voiceDeviceId) {
              import('../ws-handler.mjs')
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
                const { runInTaskContext } = await import('../lib/task-proxy-context.mjs');
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
                const bg = await import('../background-tasks.mjs');
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
                    const { appendToSession } = await import('../sessions.mjs');
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
                  const { sendToUser } = await import('../ws-handler.mjs');
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
                    const { enqueueVoiceAnnouncement, announcementLine } = await import('../lib/voice-announcements.mjs');
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
                    const bg = await import('../background-tasks.mjs');
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
                    const bg = await import('../background-tasks.mjs');
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
                    const bg = await import('../background-tasks.mjs');
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
                    const bg = await import('../background-tasks.mjs');
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
                  import('../ws-handler.mjs')
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
          watchersMod = await import('../scheduler/watchers.mjs');
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
          const bg = await import('../background-tasks.mjs');
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
            const bg = await import('../background-tasks.mjs');
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
              const { appendToSession } = await import('../sessions.mjs');
              const { persistedReportImage } = await import('../background-tasks.mjs');
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
            const { sendToUser } = await import('../ws-handler.mjs');
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
              const bg = await import('../background-tasks.mjs');
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
            const bg = await import('../background-tasks.mjs');
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
      import('../lib/skill-alias-framework.mjs')
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
