// @ts-check
/**
 * Fire-and-forget tool-result recorder for Personalization. Hooked at
 * roles.mjs's tool-dispatch chokepoints (see spec ADDENDUM B) so every tool
 * call the coordinator or a delegated specialist makes — including
 * auto-backgrounded ones once they land — becomes a deterministic, one-line
 * digest in the user's observation log for the scheduled reflection (every
 * 6 hours — see scheduler-init.mjs) to read.
 *
 * Deliberately NO LLM here: this is pure truncate-and-count digesting, kept
 * cheap enough to run unconditionally on the tool-dispatch hot path (mirrors
 * the precedent in lib/tool-exec-log.mjs — cheap, bounded, never blocks).
 *
 * recordToolObservation() itself never throws and never returns a promise
 * the caller has to handle — every failure (config read, disk write, bad
 * input) is caught and logged with a `[personalization]` prefix.
 *
 * Privacy: this digest can end up in front of a user-chosen cloud model at
 * reflection time, whose Settings label promises "activity summaries —
 * never raw content". The default is therefore shape-only for EVERY tool:
 * argument names/types plus result status/line/character counts. Raw-ish
 * summaries are available only to the tiny, audited SAFE_SUMMARY_TOOLS list,
 * and even those recursively redact credential-shaped fields/values. Error
 * text is never retained under either policy.
 *
 * Self-feedback-loop guard: roles.mjs's recordToolObservation hook is
 * unconditional (it fires for every tool call, including personalization's
 * OWN automated ones — lead-runner re-checking a lead's tool, autoExecuteOffer
 * running a graduated offer, an accepted offer's action). Without suppression,
 * that background churn gets recorded as if it were user activity, and the
 * next reflection can misread the system's own polling as a user pattern
 * (e.g. "User checks Publix BOGO sales daily"). suppressObservations(fn) runs
 * `fn` with recording suppressed for its entire async continuation, via
 * AsyncLocalStorage — NOT a module-level boolean, which would suppress
 * unrelated concurrent user turns for the whole time a background tool call
 * happens to be in flight.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig, onConfigSaved } from './config.mjs';
import { appendObservation } from './observations.mjs';
import { getScheduledContext } from '../scheduled-context.mjs';
import {
  isSensitiveSignalKey,
  isStructuredSignalType,
  redactSecretsDeep,
  sanitizeSignalEntities,
  sanitizeSignalMetadata,
  sanitizeSignalText,
} from './signal-safety.mjs';

const MAX_DIGEST_LEN = 400;
const MAX_ARGS_GIST_LEN = 80;
const MAX_INTEREST_TOPIC_LEN = 80;

const _suppressionALS = new AsyncLocalStorage();

/**
 * Runs `fn` (sync or async) with tool-observation recording suppressed for
 * its whole async continuation. Wrap EVERY personalization-originated
 * executeToolStreaming invocation in this — lead-runner.mjs's due-lead tool
 * re-check, reflect.mjs's autoExecuteOffer, and offer-handlers.mjs's offer
 * accept action — so the system's own tool calls never land in the
 * observation log as user activity.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function suppressObservations(fn) {
  return _suppressionALS.run(true, fn);
}

// Tools that would either leak the personalization loop into itself (its own
// read/write tools), duplicate what the ledger already tracks (memory
// read/write, role-rule edits), or are sub-200ms trivia with ~zero learning
// signal (clock reads, watch/agent listings). Exact list per spec CONTRACTS
// item 6 — do not add to this without updating the spec.
const SKIP_TOOLS = new Set([
  'remember_fact',
  'forget_fact',
  'recall_facts',
  'skill_add_rule',
  'skill_remove_rule',
  'list_watches',
  'list_active_agents',
  'get_time',
]);

const CONFIG_TTL_MS = 60_000;
/** @type {Map<string, {at:number, config:any}>} */
const _configCache = new Map();

async function getCachedConfig(userId) {
  const hit = _configCache.get(userId);
  const now = Date.now();
  if (hit && (now - hit.at) < CONFIG_TTL_MS) return hit.config;
  const config = await getConfig(userId);
  _configCache.set(userId, { at: now, config });
  return config;
}

// Dropped the instant a user's config is re-saved (toggling the master
// switch, flipping the model to 'off', etc.) — without this, CONFIG_TTL_MS
// meant up to 60s of recording after the user turned it off. config.mjs
// cannot import this module back (recorder.mjs already imports config.mjs),
// so this registers itself as a listener instead of config.mjs reaching in.
// Guarded: some tests `vi.mock('../lib/personalization/config.mjs', ...)`
// with a partial export list (this module is a transitive import of
// roles.mjs, so it loads even when the test never touches recording) —
// vitest's mock proxy throws on *access* to an unlisted export, even from
// `typeof`, so the whole check has to sit inside the try/catch, not just
// the call.
try {
  if (typeof onConfigSaved === 'function') onConfigSaved((userId) => { _configCache.delete(userId); });
} catch { /* config.mjs mock in this test doesn't export onConfigSaved — cache just won't be invalidated early */ }

// Safe-summary is opt-in, never inferred from a tool-name pattern. Today the
// sole member returns a static, code-owned taxonomy (skills/expenses), not
// user data. Adding a tool here requires auditing both success output and args.
export const AUDITED_SAFE_SUMMARY_TOOLS = Object.freeze(['expense_categories']);
const SAFE_SUMMARY_TOOLS = new Set(AUDITED_SAFE_SUMMARY_TOOLS);

function capGist(s) {
  return s.length > MAX_ARGS_GIST_LEN ? `${s.slice(0, MAX_ARGS_GIST_LEN - 3)}...` : s;
}

function shapeMarker(value, depth, seen) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return typeof value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `binary(${value.byteLength ?? 0})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (depth >= 2) return `object(${Object.keys(value).length})`;
  if (seen.has(value)) return 'circular';
  seen.add(value);
  const entries = Object.entries(value).slice(0, 8);
  const body = entries.map(([key, item], index) => {
    const sensitive = isSensitiveSignalKey(key);
    const marker = sensitive ? '[redacted]' : shapeMarker(item, depth + 1, seen);
    return `${JSON.stringify(sensitive ? `[redacted-key-${index + 1}]` : key)}:${marker}`;
  }).join(',');
  return `{${body}${Object.keys(value).length > entries.length ? ',…' : ''}}`;
}

/** Shape-only args: schema-like key/type information, never argument values. */
function argsShapeGist(args) {
  if (!args || typeof args !== 'object') return '';
  return capGist(shapeMarker(args, 0, new WeakSet()));
}

/**
 * "first meaningful line(s) + counts" gist of a (possibly multi-line, possibly
 * huge) result string. Never includes more than a couple of lines verbatim —
 * this is a digest, not a transcript. Used for non-content tools only.
 */
function safeResultGist(resultText) {
  const text = typeof resultText === 'string' ? resultText : String(resultText ?? '');
  const lines = text.split('\n').map(line => {
    const redacted = redactSecretsDeep(line, { maxString: MAX_DIGEST_LEN });
    return typeof redacted === 'string' ? redacted.trim() : '';
  }).filter(Boolean);
  const shown = lines.slice(0, 2).join(' ');
  const more = lines.length > 2 ? ` (+${lines.length - 2} more lines)` : '';
  return `${shown}${more}`;
}

/**
 * Shape-only result. Error text is never retained: diagnostics commonly echo
 * paths, request bodies, remote content, or credentials.
 */
function resultShapeGist(resultText, ok) {
  const text = typeof resultText === 'string' ? resultText : String(resultText ?? '');
  const lineCount = text.split('\n').map(l => l.trim()).filter(Boolean).length;
  const chars = text.length;
  const charsLabel = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
  const status = ok === false ? 'error' : 'ok';
  return `${status}, ${lineCount} line${lineCount === 1 ? '' : 's'}, ${charsLabel}`;
}

const ERROR_RESULT_RE = /(?:^|\n)\s*(?:error|tool error|failed|failure|exception|cannot\b|could(?:n't| not)\b)/i;

function resultFailed(resultText, ok) {
  if (ok === false) return true;
  const text = typeof resultText === 'string' ? resultText : String(resultText ?? '');
  return ERROR_RESULT_RE.test(text);
}

function normalizeInterestText(value) {
  const clean = sanitizeSignalText(value, MAX_INTEREST_TOPIC_LEN + 1);
  if (!clean || clean.length < 3 || clean.length > MAX_INTEREST_TOPIC_LEN) return '';
  const redacted = redactSecretsDeep(clean, { maxString: MAX_INTEREST_TOPIC_LEN + 1 });
  const text = typeof redacted === 'string' ? redacted.trim() : '';
  return !text || text.includes('[redacted]') ? '' : text;
}

function interestMatchesKeywords(topic, keywords) {
  const normalized = String(topic || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = normalized.split(' ').filter(Boolean);
  return keywords.some(raw => {
    const keyword = String(raw || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (keyword.length < 3 || keyword.length > 40) return false;
    if (keyword.includes(' ')) return ` ${normalized} `.includes(` ${keyword} `);
    return tokens.some(token => token === keyword || token === `${keyword}s`
      || token === `${keyword}es` || `${token}s` === keyword || `${token}es` === keyword);
  });
}

async function declaredInterestTopics({ userId, skillId, toolName, args, companionOpenTopics = false }) {
  if (!userId || !skillId || !toolName || !args || typeof args !== 'object' || Array.isArray(args)) return [];
  try {
    const roles = await import('../../roles.mjs');
    const candidates = roles.listRoles(userId).filter(manifest => manifest?.id === skillId);
    const manifest = candidates.find(candidate => candidate?.userScope === userId)
      || candidates.find(candidate => candidate?.userScope == null);
    if (!manifest) return [];
    const tools = new Map((manifest.tools || [])
      .map(tool => [tool?.function?.name, tool]).filter(([name]) => typeof name === 'string' && name));
    const tool = tools.get(toolName);
    if (!tool || tool.destructive === true) return [];
    const declaredProperties = tool?.function?.parameters?.properties;
    const out = [];
    const seen = new Set();
    for (const recipe of (Array.isArray(manifest.preferenceOpportunities)
      ? manifest.preferenceOpportunities.slice(0, 3) : [])) {
      const keywords = Array.isArray(recipe?.preferenceKeywords)
        ? recipe.preferenceKeywords.slice(0, 32) : [];
      for (const signal of (Array.isArray(recipe?.interestSignals)
        ? recipe.interestSignals.slice(0, 5) : [])) {
        const argName = typeof signal?.arg === 'string' ? signal.arg.trim() : '';
        if (signal?.tool !== toolName || !argName || isSensitiveSignalKey(argName)
          || declaredProperties?.[argName]?.type !== 'string') continue;
        const topic = normalizeInterestText(args[argName]);
        const dedupe = topic.toLocaleLowerCase();
        // Proactive may retain any declared lookup-arg topic (still weak
        // evidence). Helpful/Quiet require a keyword match so broad queries
        // do not bloat the observation log for conservative users.
        if (!topic || seen.has(dedupe)) continue;
        if (!companionOpenTopics && !interestMatchesKeywords(topic, keywords)) continue;
        seen.add(dedupe);
        out.push({ topic, recipeId: String(recipe?.id || '').slice(0, 64) });
        if (out.length >= 3) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** "<toolName>(<args gist>) -> <result gist>", hard-capped at 400 chars total.
 * Shape-only is the default. A safe-summary tool may retain its audited success
 * summary, but never raw error text. */
function buildDigest(toolName, args, resultText, ok) {
  const safeSummary = SAFE_SUMMARY_TOOLS.has(toolName);
  const failed = resultFailed(resultText, ok);
  // Args are always shape-only. The allowlist applies solely to the audited
  // success result; unexpected extra args must not become a privacy bypass.
  const argsPart = argsShapeGist(args);
  const resultPart = safeSummary && !failed ? safeResultGist(resultText) : resultShapeGist(resultText, failed ? false : true);
  let digest = `${toolName}(${argsPart}) -> ${resultPart}`;
  if (digest.length > MAX_DIGEST_LEN) digest = `${digest.slice(0, MAX_DIGEST_LEN - 3)}...`;
  return {
    digest,
    summaryPolicy: safeSummary ? 'safe_summary_v1' : 'shape_only_v1',
    resultStatus: failed ? 'error' : 'ok',
  };
}

/**
 * Origin provenance for the observation: was this tool call part of a live
 * user turn, or fired by one of the user's standing automations (scheduled
 * task, watcher)? Reflection weights these differently — an automation's
 * EXISTENCE is user intent, but its firings are heartbeat, not behavior
 * (four watcher checks at 3am must never read as "user actively checks X").
 *
 * Detection: scheduler task runs, watcher fires, and their reaction/drain
 * turns all run inside scheduledContext with an originTaskId (scheduler.mjs,
 * lib/run-agent-with-retry.mjs, background-tasks.mjs). mcp-outbound.mjs also
 * enters scheduledContext but with only a scheduledNote — an external client
 * acting on the user's live instruction is user-directed, so the
 * originTaskId check deliberately leaves it 'interactive'.
 */
function deriveOrigin() {
  const ctx = getScheduledContext();
  return ctx?.originTaskId ? 'automation' : 'interactive';
}

/**
 * Record one tool-call result as a personalization observation. Fire-and-
 * forget: returns void immediately, does its (async) work off to the side,
 * and never throws into the caller — every step is wrapped.
 *
 * `origin` is normally derived from the live scheduledContext ALS; the
 * auto-backgrounded drain paths in roles.mjs run after the turn's async
 * context is gone, so they pass their captured value explicitly.
 * @param {{userId: string, agentId?: string|null, toolName: string, skillId?: string|null, args?: any, resultText?: string, ok?: boolean, origin?: 'interactive'|'automation'|null}} params
 */
export function recordToolObservation({ userId, agentId = null, toolName, skillId = null, args = null, resultText = '', ok = true, origin = null } = /** @type {any} */ ({})) {
  // typeof check, not just truthiness — a non-string toolName would throw
  // synchronously at .startsWith below, into the tool-dispatch hot path this
  // function promises never to throw into.
  if (!userId || typeof toolName !== 'string' || !toolName) return;
  if (_suppressionALS.getStore()) return;
  if (SKIP_TOOLS.has(toolName) || toolName.startsWith('personalization_')) return;
  // Resolve synchronously, before the async hop — ALS does flow through the
  // promise chain, but capturing here makes the contract obvious.
  const resolvedOrigin = (origin === 'automation' || origin === 'interactive') ? origin : deriveOrigin();

  Promise.resolve()
    .then(async () => {
      const config = await getCachedConfig(userId);
      // Fresh profiles must finish the transparent setup/consent step before
      // any personalization activity is retained. Existing pre-onboarding
      // profiles are migrated by config.mjs with setupComplete=true.
      if (!config?.enabled || config?.setupComplete === false || !config?.sources?.tools) return;
      const { digest, summaryPolicy, resultStatus } = buildDigest(toolName, args, resultText, ok);
      await appendObservation(userId, {
        source: toolName,
        skillId: skillId || null,
        kind: 'tool_result',
        digest,
        metadata: {
          summaryPolicy,
          resultStatus,
        },
        agentId: agentId || null,
        origin: resolvedOrigin,
      });
      // A skill may explicitly declare a safe lookup argument as weak topical
      // evidence. This keeps "are apples on sale?" useful without converting a
      // question into a confirmed preference: it is an encrypted observation,
      // and reflection must see repeated interest before proposing an inference.
      // Proactive engagement may also soft-confirm after repeated interest.
      if (resolvedOrigin === 'interactive' && resultStatus === 'ok' && skillId) {
        let proactiveOpenTopics = false;
        try {
          const configMod = await import('./config.mjs');
          if (typeof configMod.isProactiveEngagement === 'function') {
            proactiveOpenTopics = configMod.isProactiveEngagement(config);
          } else if (typeof configMod.isCompanionEngagement === 'function') {
            proactiveOpenTopics = configMod.isCompanionEngagement(config);
          } else {
            proactiveOpenTopics = config?.engagement === 'proactive'
              || config?.engagement === 'companion';
          }
        } catch { proactiveOpenTopics = false; }
        const topics = await declaredInterestTopics({
          userId, skillId, toolName, args, companionOpenTopics: proactiveOpenTopics,
        });
        for (const { topic, recipeId } of topics) {
          await appendObservation(userId, {
            source: toolName,
            skillId,
            kind: 'interest',
            digest: `Lookup topic: ${topic}`,
            entities: [topic],
            metadata: {
              capturePolicy: proactiveOpenTopics
                ? 'declared_interest_lookup_proactive_v1'
                : 'declared_interest_lookup_v1',
              confidence: 0.2,
              ...(recipeId ? { recipeId } : {}),
            },
            agentId: agentId || null,
            origin: 'interactive',
          });
          if (proactiveOpenTopics) {
            try {
              const { queueProactiveInterestConfirm } = await import('./interest-confirm.mjs');
              queueProactiveInterestConfirm(userId, {
                skillId, topic, recipeId, agentId: agentId || null,
              });
            } catch (e) {
              console.warn('[personalization] proactive interest confirm queue failed:', e?.message || e);
            }
          }
        }
      }
    })
    .catch(e => console.warn('[personalization] recordToolObservation failed:', e?.message || e));
}

/**
 * Persist a high-signal, user-derived personalization event. Unlike the hot
 * tool hook above, this returns a Promise so a caller that deliberately
 * extracts an explicit preference/correction/choice/outcome can await durable
 * capture. Invalid, disabled, or suppressed signals resolve to null; failures
 * are logged without including the user's statement and also resolve to null.
 *
 * Contract (additive to the legacy Observation fields):
 *   kind     = preference | correction | choice | outcome
 *   digest   = one-line statement, <= 400 chars
 *   entities = <= 12 unique strings, each <= 80 chars
 *   metadata = recursively bounded/redacted JSON object
 *
 * @param {{
 *   userId: string,
 *   type: 'preference'|'correction'|'choice'|'outcome',
 *   statement: string,
 *   entities?: string[],
 *   metadata?: object,
 *   source?: string,
 *   skillId?: string|null,
 *   agentId?: string|null,
 *   origin?: 'interactive'|'automation'|null,
 * }} params
 * @returns {Promise<object|null>}
 */
export async function recordStructuredSignal({
  userId,
  type,
  statement,
  entities = [],
  metadata = {},
  source = 'user_explicit',
  skillId = null,
  agentId = null,
  origin = null,
} = /** @type {any} */ ({})) {
  if (!userId || !isStructuredSignalType(type) || _suppressionALS.getStore()) return null;
  const cleanStatement = sanitizeSignalText(statement);
  const digest = redactSecretsDeep(cleanStatement, { maxString: MAX_DIGEST_LEN });
  // A credential-shaped explicit statement is not a learnable preference or
  // correction. Drop it rather than persisting either the secret or a useless
  // "[redacted]" pseudo-belief.
  if (!digest || digest.includes('[redacted]')) return null;
  const resolvedOrigin = (origin === 'automation' || origin === 'interactive') ? origin : deriveOrigin();
  try {
    const config = await getCachedConfig(userId);
    // Structured signals are conversational/session-derived, not tool-result
    // capture. The master switch always wins; sources.sessions is the narrower
    // opt-out when present (missing means enabled for pre-field configs).
    if (!config?.enabled || config?.setupComplete === false || config?.sources?.sessions === false) return null;
    return await appendObservation(userId, {
      source,
      skillId,
      kind: type,
      digest,
      entities: sanitizeSignalEntities(entities),
      metadata: {
        ...sanitizeSignalMetadata(metadata),
        signalType: type,
        capturePolicy: 'explicit_structured_v1',
      },
      agentId,
      origin: resolvedOrigin,
    });
  } catch (e) {
    console.warn('[personalization] recordStructuredSignal failed:', e?.message || e);
    return null;
  }
}

// Re-exported as the stable discovery surface for callers that build typed
// signals without importing the sanitizer leaf directly.
export { STRUCTURED_SIGNAL_TYPES } from './signal-safety.mjs';
