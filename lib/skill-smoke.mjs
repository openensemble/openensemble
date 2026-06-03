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
 * @param {string} skillDir       absolute path to the just-written skill folder
 * @param {any} manifest          parsed manifest object
 * @returns {Promise<SmokeReport>}
 */
export async function runSkillSmoke(skillDir, manifest) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  if (tools.length === 0) {
    return { ok: true, results: [{ tool: '(none)', outcome: 'skip', reason: 'no-tools-declared', durationMs: 0 }] };
  }

  // Dynamic-import the freshly-written skill. Cache-bust via query string
  // so we don't get a stale version on repeated smoke runs in the same
  // process (handlePatchCode → patch → smoke → patch again).
  const execPath = path.join(skillDir, 'execute.mjs');
  const url = pathToFileURL(execPath).href + `?smoke=${Date.now()}`;
  /** @type {any} */
  let mod;
  try { mod = await import(url); }
  catch (e) {
    return { ok: false, results: [], setupError: `Skill failed to load: ${e.message}` };
  }
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
  if (n.includes('zip') || n.includes('postal')) return '33909';
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
