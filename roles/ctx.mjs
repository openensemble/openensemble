// @ts-check
/**
 * Skill execution context (buildCtx) + desktop artifact helpers.
 */

import { getTurnContext } from '../lib/turn-abort-context.mjs';
import { buildSkillCredentials } from '../lib/credentials.mjs';
import { skillDeclaresNetwork } from '../lib/skill-net-policy.mjs';
import { buildProposeMonitor, buildCollectionHelpers } from '../lib/monitor-helper.mjs';
import { buildBrowserHelpers } from '../lib/browser-helper.mjs';
import { buildDeviceHelpers } from '../lib/device-helper.mjs';
import { buildSkillLogger } from '../lib/skill-logger.mjs';
import { buildRegisterLead } from '../lib/personalization/lead-helper.mjs';
import { buildSkillPersonalizationHelpers } from '../lib/personalization/skill-helper.mjs';
import { listDesktops, sendDesktopCommand } from '../lib/desktop-bus.mjs';
import { getScheduledContext } from '../lib/scheduled-context.mjs';
import { registerScheduledChild, completeScheduledChild } from '../lib/scheduled-child-barrier.mjs';
import { getUserFilesDir, userSkillsDir, SKILLS_DIR, USERS_DIR } from '../lib/paths.mjs';
import { log } from '../logger.mjs';
import path from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

// Bound deps from roles.mjs to avoid circular imports.
let getRoleManifest = () => null;
let resolveKey = () => null;
let getExecutorByKey = async () => null;

export function bindCtxDeps(deps) {
  if (deps.getRoleManifest !== undefined) getRoleManifest = deps.getRoleManifest;
  if (deps.resolveKey !== undefined) resolveKey = deps.resolveKey;
  if (deps.getExecutorByKey !== undefined) getExecutorByKey = deps.getExecutorByKey;
}

// ── Execution ─────────────────────────────────────────────────────────────────

// Lazy ws-handler import — avoids the chat-dispatch ↔ roles ↔ ws-handler cycle.
let _wsMod = null;
async function _wsHandler() {
  if (_wsMod === null) {
    try { _wsMod = await import('../ws-handler.mjs'); }
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
export async function buildCtx(userId, agentId, skillId = null, signal = getTurnContext()?.signal ?? null) {
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
      const watchers = await import('../scheduler/watchers.mjs');
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
      const { getPreferenceSafeAutoContext } = await import('../lib/personalization/safe-auto-context.mjs');
      if (getPreferenceSafeAutoContext()?.activationNonce) {
        throw new Error('unwatch is unavailable while committing a preference monitor activation');
      }
      const watchers = await import('../scheduler/watchers.mjs');
      return watchers.unregisterWatcher(userId, watcherId);
    } catch (e) { console.warn('[ctx.unwatch]', e.message); return false; }
  };
  // Bulk-cancel watchers matching a predicate. Used by skills that tear down
  // a resource a watcher polls (e.g. terminating a pod that has a render
  // watcher attached) so we don't keep showing stale progress bubbles.
  // predicate is a sync function (record) -> bool, evaluated in-process.
  ctx.unwatchMatching = async (predicate) => {
    try {
      const { getPreferenceSafeAutoContext } = await import('../lib/personalization/safe-auto-context.mjs');
      if (getPreferenceSafeAutoContext()?.activationNonce) {
        throw new Error('unwatchMatching is unavailable while committing a preference monitor activation');
      }
      const watchers = await import('../scheduler/watchers.mjs');
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
      const m = await import('../lib/credentials.mjs');
      return m.getCredentialValue(userId, id);
    } catch (e) { console.warn('[ctx.getCredential]', e.message); return null; }
  };
  ctx.requestCredential = async (opts = {}) => {
    try {
      const m = await import('../lib/credentials.mjs');
      return m.requestCredential({ ...opts, userId });
    } catch (e) { console.warn('[ctx.requestCredential]', e.message); return null; }
  };
  ctx.storeCredential = async (opts = /** @type {any} */ ({})) => {
    try {
      const m = await import('../lib/credentials.mjs');
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
    const rt = await import('../lib/skill-runtime.mjs');
    const existing = rt.resolveSkillBinary(_skillDir, name);
    if (existing) return existing;                       // self-heal / already provisioned
    // Consent: explicit, per-download, reusing the wired 'confirm' prompt. The
    // user sees the exact URL; Cancel/timeout rejects and we abort.
    const m = await import('../lib/credentials.mjs');
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
    const sb = await import('../lib/skill-sandbox.mjs');
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

