// @ts-check
/**
 * Per-tool smoke runner for skill-builder.
 *
 * Imports a freshly-written skill and exercises every tool the manifest
 * declares — with plausible args generated from each tool's parameter
 * schema. Catches handler crashes, wrong-typed returns, hangs, and
 * arg-name mismatches that earlier static checks (LSP, manifest
 * validator) can't see because they don't execute the code.
 *
 * Default policy: every tool runs unless its manifest entry is annotated
 * `destructive: true` (e.g. sends email, writes to a remote API,
 * deletes things). The coder marks destructive tools explicitly via the
 * blueprint; everything else gets the safety net for free.
 *
 * Skill executors get a STUB ctx so a smoke test never leaks side
 * effects (no real images displayed, no credentials emitted, no
 * monitors registered). Tools that need real credentials should detect
 * `undefined` from `ctx.getCredential` and return a graceful error
 * message — that's the correct production behavior anyway.
 *
 * Replaces the old `validateExecutor` (which only tested tool[0] with
 * empty args and silently swallowed errors).
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { readConfig } from './paths.mjs';
import { mayImportCustomCodeInProcess } from './custom-code-policy.mjs';

const PER_TOOL_TIMEOUT_MS = 3000;

/**
 * @typedef {Object} SmokeResult
 * @property {string} tool
 * @property {'pass'|'skip'|'fail'} outcome
 * @property {string} [reason]      'destructive' / 'crashed' / 'timeout' / 'wrong-type' / 'no-tools-declared'
 * @property {string} [message]     human-readable detail (the crash message, the bad return, etc.)
 * @property {number} durationMs
 */

/**
 * @typedef {Object} SmokeReport
 * @property {boolean} ok           true iff no `fail` outcomes
 * @property {SmokeResult[]} results
 * @property {string} [setupError]  non-empty when the skill itself couldn't be loaded
 */

/**
 * Mirror of roles.mjs shouldSandboxSkill for the authoring seam: a skill that
 * would RUN sandboxed must also be SMOKED sandboxed — the smoke executes the
 * freshly-written (LLM-generated) code, which is exactly when top-level code
 * running in the OE process would be most dangerous.
 * @param {any} manifest
 * @param {string|null} userId
 * @param {string} skillDir
 */
function _shouldSandboxSmoke(manifest, userId, skillDir) {
  // A user-owned skill may opt out of its normal runtime jail only when the
  // owning account is trusted at this exact boundary. Children, managed users
  // denied this skill, and missing/unreadable profiles are forced through the
  // subprocess even if untrusted manifest data says `isolate:false`.
  const isCustom = manifest?.custom === true || Boolean(_deriveUserIdFromSkillDir(skillDir));
  if (isCustom && !mayImportCustomCodeInProcess(userId, manifest?.id || path.basename(skillDir))) {
    return true;
  }
  if (manifest?.sandbox?.isolate === true) return true;
  try {
    const sb = readConfig()?.skillSandbox || {};
    if (sb.enabled === true) return true;
    if (Array.isArray(sb.skills) && sb.skills.includes(manifest?.id)) return true;
  } catch { /* config unreadable → fall through */ }
  return false;
}

/**
 * @param {string} skillDir       absolute path to the just-written skill folder
 * @param {any} manifest          parsed manifest object
 * @param {{ userId?: string|null }} [opts]  owner — required for the jailed path
 * @returns {Promise<SmokeReport>}
 */
export async function runSkillSmoke(skillDir, manifest, { userId = null } = {}) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  if (tools.length === 0) {
    return { ok: true, results: [{ tool: '(none)', outcome: 'skip', reason: 'no-tools-declared', durationMs: 0 }] };
  }

  // Sandboxed skills: run the WHOLE smoke inside the bwrap jail (skill-host
  // mode:'smoke' imports the module in-jail and calls smokeModule below).
  // Network in the smoke mirrors the skill's declared runtime policy.
  const derivedOwner = _deriveUserIdFromSkillDir(skillDir);
  // For custom code, filesystem ownership wins over the caller. An admin may
  // edit a child's skill, but that must not make the child's module eligible
  // for the admin's trusted in-process smoke path. A custom path outside the
  // canonical users/<uid>/skills tree stays untrusted unless its declared
  // creator exactly matches the caller.
  const uid = manifest?.custom === true
    ? (derivedOwner || (manifest?.createdBy === userId ? userId : null))
    : (userId || derivedOwner);
  if (_shouldSandboxSmoke(manifest, uid, skillDir)) {
    const skillId = manifest?.id || path.basename(skillDir);
    if (!uid) {
      return { ok: false, results: [], setupError: `Cannot smoke-test sandboxed skill "${skillId}": owner userId not resolvable from ${skillDir}.` };
    }
    try {
      const { runSandboxedJob } = await import('./skill-subprocess.mjs');
      const timeoutMs = Math.max(30_000, tools.length * PER_TOOL_TIMEOUT_MS + 15_000);
      const r = await runSandboxedJob({
        userId: uid, skillId,
        jobPayload: { t: 'job', mode: 'smoke', skillExecPath: path.join(skillDir, 'execute.mjs'), manifest },
        // The smoke stub ctx is self-contained in-jail — nothing should RPC out.
        handleRpc: async (method) => { throw new Error(`smoke ctx is a stub; ${method} is not available during smoke tests`); },
        net: manifest?.sandbox?.network === true,
        timeoutMs,
      });
      if (!r.ok) return { ok: false, results: [], setupError: String(/** @type {any} */ (r).error || 'sandboxed smoke failed') };
      return /** @type {SmokeReport} */ (r.result);
    } catch (e) {
      return { ok: false, results: [], setupError: `Sandboxed smoke could not run: ${e?.message || e}` };
    }
  }

  // Trusted path (explicit sandbox opt-out / global skills): in-process, as
  // before. Cache-bust via query string so we don't get a stale version on
  // repeated smoke runs in the same process (patch → smoke → patch again).
  const execPath = path.join(skillDir, 'execute.mjs');
  const url = pathToFileURL(execPath).href + `?smoke=${Date.now()}`;
  /** @type {any} */
  let mod;
  try { mod = await import(url); }
  catch (e) {
    return { ok: false, results: [], setupError: `Skill failed to load: ${e.message}` };
  }
  return smokeModule(mod, manifest);
}

/** Derive users/<uid>/skills/<slug> → uid; null for any other layout. */
function _deriveUserIdFromSkillDir(skillDir) {
  const m = String(skillDir || '').match(/[\\/]users[\\/]([^\\/]+)[\\/]skills[\\/]/);
  return m ? m[1] : null;
}

/**
 * Everything after module load — shape checks, unknown-tool probe, per-tool
 * invocations with a stub ctx. Runs in-process for trusted skills and INSIDE
 * the jail (imported by lib/skill-host.mjs mode:'smoke') for sandboxed ones.
 * @param {any} mod        the imported execute.mjs module
 * @param {any} manifest
 * @returns {Promise<SmokeReport>}
 */
export async function smokeModule(mod, manifest) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  const fn = mod.default ?? mod.executeSkillTool;
  if (typeof fn !== 'function') {
    return { ok: false, results: [], setupError: 'execute.mjs must export executeSkillTool as a named or default export.' };
  }
  if (fn.length !== 4 && fn.length !== 5) {
    return {
      ok: false, results: [],
      setupError: `executeSkillTool must declare 4 or 5 parameters (name, args, userId, agentId[, ctx]) but yours declares ${fn.length}. Copy the signature from the blueprint exactly.`,
    };
  }

  // Universal first check: unknown tool name must return null. Same as
  // the old validateExecutor — kept here because a bad fallthrough breaks
  // every downstream tool call regardless of arg shape.
  const stub = _makeStubCtx();
  try {
    const unknownResult = await fn('__unknown_tool_check__', {}, 'test-user', 'test-agent', stub);
    if (unknownResult !== null && unknownResult !== undefined) {
      return {
        ok: false, results: [],
        setupError: `Function returned ${JSON.stringify(unknownResult).slice(0,120)} for an unknown tool name but must return null. The final fallthrough in executeSkillTool must be \`return null\`.`,
      };
    }
  } catch (e) {
    return { ok: false, results: [], setupError: `Function throws on unknown tool name — must return null instead: ${e.message}` };
  }

  /** @type {SmokeResult[]} */
  const results = [];
  for (const t of tools) {
    const toolName = t?.function?.name;
    if (!toolName) continue;
    if (t?.destructive === true) {
      results.push({
        tool: toolName, outcome: 'skip', reason: 'destructive',
        message: 'marked destructive in manifest; smoke can\'t safely invoke it.',
        durationMs: 0,
      });
      continue;
    }
    const args = _generateArgsFromSchema(toolName, t.function?.parameters);
    const startedAt = Date.now();
    try {
      const value = await _raceWithTimeout(
        fn(toolName, args, 'test-user', 'test-agent', stub),
        PER_TOOL_TIMEOUT_MS,
        toolName,
      );
      const durationMs = Date.now() - startedAt;
      if (value === null || value === undefined) {
        // Returning null for a real tool name is suspicious — could be a
        // missing if-branch in the dispatcher. Treat as warning (skip
        // outcome with a note) rather than hard fail, since some skills
        // intentionally return null when args don't match a sub-mode.
        results.push({
          tool: toolName, outcome: 'skip', reason: 'returned-null',
          message: 'returned null with generated args; may indicate a missing if-branch or args mismatch with the manifest schema.',
          durationMs,
        });
      } else if (typeof value !== 'string') {
        results.push({
          tool: toolName, outcome: 'fail', reason: 'wrong-type',
          message: `returned a ${typeof value} (${JSON.stringify(value).slice(0,120)}) but must return a string or null.`,
          durationMs,
        });
      } else {
        results.push({ tool: toolName, outcome: 'pass', message: `${value.slice(0,140)}${value.length > 140 ? '…' : ''}`, durationMs });
      }
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      const reason = /smoke timeout/.test(e.message) ? 'timeout' : 'crashed';
      results.push({
        tool: toolName, outcome: 'fail', reason,
        message: e.message,
        durationMs,
      });
    }
  }

  const ok = !results.some(r => r.outcome === 'fail');
  return { ok, results };
}

/**
 * Render a SmokeReport into a multi-line string for the skill-builder
 * tool result. Mirrors lsp-diagnose.formatDiagnostics so the three
 * gates' readouts compose cleanly when surfaced together.
 *
 * @param {SmokeReport} report
 */
export function formatSmokeReport(report) {
  if (report.setupError) return `✖ Skill load: ${report.setupError}`;
  if (!report.results.length) return '(no tools tested)';
  const lines = [];
  for (const r of report.results) {
    const icon = r.outcome === 'pass' ? '✓' : r.outcome === 'fail' ? '✖' : '⚠';
    const time = r.durationMs > 0 ? ` (${r.durationMs}ms)` : '';
    const reasonTag = r.reason ? ` [${r.reason}]` : '';
    lines.push(`${icon} ${r.tool}${reasonTag}${time}${r.message ? ': ' + r.message : ''}`);
  }
  return lines.join('\n');
}

// ─── Args generator ──────────────────────────────────────────────────────────
// Generate plausible values from a tool's JSON-schema parameters block.
// Required properties are populated; optional ones skipped unless they're
// the discriminator in an obvious if/else (e.g., a "mode" field). The
// field-name heuristics aren't trying to be perfect — they just need to
// produce values that don't immediately fail input validation, so the
// real handler body gets a chance to run.

/**
 * @param {string} toolName  used for keying heuristics in case the
 *                           schema is bare (no properties).
 * @param {any} parameters   the JSON schema
 */
function _generateArgsFromSchema(toolName, parameters) {
  if (!parameters || typeof parameters !== 'object') return {};
  const props = parameters.properties ?? {};
  const required = Array.isArray(parameters.required) ? new Set(parameters.required) : new Set();
  const args = /** @type {Record<string, any>} */ ({});
  for (const [name, schema] of Object.entries(props)) {
    if (!required.has(name)) continue;
    args[name] = _generateValueForField(name, /** @type {any} */ (schema));
  }
  return args;
}

/**
 * @param {string} fieldName
 * @param {any} schema
 */
function _generateValueForField(fieldName, schema) {
  if (!schema || typeof schema !== 'object') return 'test';
  // Honor explicit default
  if (schema.default !== undefined) return schema.default;
  // Honor enum — pick the first value
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  // Honor example if provided
  if (schema.examples && Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  const type = schema.type;
  if (type === 'number' || type === 'integer') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  // string + everything else falls into name-based heuristics
  return _stringHeuristic(fieldName);
}

/**
 * @param {string} fieldName
 */
function _stringHeuristic(fieldName) {
  const n = fieldName.toLowerCase();
  if (n.includes('zip') || n.includes('postal')) return '62704';
  if (n.includes('email')) return 'test@example.com';
  if (n.includes('url') || n.includes('uri') || n.includes('link')) return 'https://example.com';
  if (n.includes('phone') || n.includes('mobile') || n.includes('tel')) return '+15555550100';
  if (n.includes('date')) return '2026-01-01';
  if (n.includes('time')) return '12:00';
  if (n.includes('lat') && !n.includes('late')) return '26.6406';   // Fort Myers
  if (n.includes('lng') || n.includes('lon')) return '-81.8723';
  if (n.includes('country') || n.includes('region')) return 'US';
  if (n.includes('lang') || n.includes('locale')) return 'en';
  if (n.includes('query') || n.includes('search') || n.includes('term') || n.includes('q')) return 'test';
  if (n.includes('text') || n.includes('content') || n.includes('body') || n.includes('message')) return 'test message';
  if (n.includes('name') || n.includes('title') || n.includes('label')) return 'test';
  if (n.includes('id')) return 'test-id';
  if (n.includes('path') || n.includes('file')) return '/tmp/test';
  if (n.includes('format') || n.includes('type') || n.includes('kind')) return 'text';
  return 'test';
}

// ─── Stub ctx ────────────────────────────────────────────────────────────────
// Skills built per the blueprint use these ctx helpers. The stub is
// permissive on read-shaped helpers (returns undefined for credentials so
// the skill's "missing credential" branch fires) and refuses on write-
// shaped helpers (so a smoke run can never leak a real action).

function _makeStubCtx() {
  return {
    userId: 'test-user',
    agentId: 'test-agent',
    // Read-shaped — return undefined so the skill's missing-credential
    // branch executes naturally.
    getCredential: async () => undefined,
    personalization: {
      // Personalization reads are side-effect free. Smoke mode has no user
      // profile, so expose the production shape with an empty result.
      confirmedPreferences: async () => [],
      confirmedPreferenceDetails: async () => [],
    },
    // Write-shaped — explicit error so any code path that tries to
    // request/persist a credential during smoke surfaces clearly.
    requestCredential: async () => { throw new Error('requestCredential is not available in smoke-test mode'); },
    // Side-effect helpers — no-ops that return success counts.
    showImage: async () => 0,
    showVideo: async () => 0,
    // Watcher / monitor helpers — no-ops returning null so registration
    // patterns don't crash, but nothing actually registers.
    watch: async () => null,
    unwatch: async () => false,
    unwatchMatching: async () => 0,
    proposeMonitor: async () => null,
  };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
async function _raceWithTimeout(promise, ms, label) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`smoke timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
