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
 * never raw content". For tools that plausibly read or transmit someone
 * else's content — an email body, a file/document, a fetched web page, a
 * shell command's output, a chat/message transcript — isContentTool()
 * degrades BOTH halves of the digest: args collapse to key names only (no
 * values) and the result collapses to ok/error + a line/char count instead
 * of the first lines of the actual text. An error's first line is still
 * kept even for a content tool — that's a diagnostic, not third-party
 * content. Every other tool keeps the old "first two lines" gist (that's
 * genuinely useful for e.g. a weather or Home Assistant result), except
 * any arg whose name looks like a credential (isSensitiveArgName) is still
 * redacted.
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
import { isSensitiveArgName } from '../learning-safety.mjs';

const MAX_DIGEST_LEN = 400;
const MAX_ARGS_GIST_LEN = 80;

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

// Tool names that plausibly read or transmit someone else's (or the user's
// own saved) content rather than a small structured status: email bodies,
// files/documents, fetched web pages, shell/command output, chat/message
// transcripts. Matched conservative-inclusive — a name that plausibly reads
// content is treated as content-bearing even where today's payload happens
// to be more metadata than body text (e.g. email_list's subject lines are
// still someone's real mail). Pattern-based so a same-shaped tool added
// later (a future email_search, node_read_*) is caught automatically; the
// Set below is for exact names the pattern can't reach (bare exec tools,
// and a few email/research tools whose names don't contain a matched verb).
// Write-side tools (compose/reply/write_file/save) are here too: they carry
// the raw content in their ARGS instead of their result — a drafted email
// body is just as much "raw content" as a received one, and the keys-only
// args gist still preserves the activity shape ("composed an email").
const CONTENT_TOOL_RE = /(?:^|_)(?:read|search|thread|fetch|transcribe|observe)(?:_|$)/i;
const CONTENT_TOOL_SET = new Set([
  'node_exec', 'coder_run_command', 'desktop_run_command',
  'email_list', 'email_label_query', 'email_purge_sender',
  'get_research', 'get_task_log', 'desktop_download_url', 'deep_research_parallel',
  'email_compose', 'email_reply', 'email_user',
  'coder_write_file', 'desktop_write_file', 'desktop_save_file', 'save_research',
  'tutor_recall_notes', 'tutor_save_note', // stored personal notes/quizzes — recall returns them verbatim
  'update_research', // args.content = the full merged research doc
  'coder_edit_file', 'coder_multi_edit', // args old_string/new_string = real file content
  'browser_site_notes_write', 'browser_type', // typed/saved browser text
  'send_telegram_message', // message body = chat content
]);

function isContentTool(toolName) {
  const t = String(toolName || '');
  return CONTENT_TOOL_SET.has(t) || CONTENT_TOOL_RE.test(t);
}

function capGist(s) {
  return s.length > MAX_ARGS_GIST_LEN ? `${s.slice(0, MAX_ARGS_GIST_LEN - 3)}...` : s;
}

/** Args gist for a NON-content tool: raw values, but a credential-shaped key
 * (isSensitiveArgName — key/token/secret/password/auth/bearer) is redacted. */
function argsGist(args) {
  if (!args || typeof args !== 'object') return '';
  const safe = {};
  for (const [k, v] of Object.entries(args)) safe[k] = isSensitiveArgName(k) ? '[redacted]' : v;
  let s;
  try { s = JSON.stringify(safe); } catch { return ''; }
  return s ? capGist(s) : '';
}

/** Args gist for a content tool: key names only, every value elided — e.g.
 * `{"command":…,"cwd":…}`. Never carries a value, sensitive or not. */
function argsKeysGist(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = Object.keys(args);
  if (!keys.length) return '';
  return capGist(`{${keys.map(k => `"${k}":…`).join(',')}}`);
}

/**
 * "first meaningful line(s) + counts" gist of a (possibly multi-line, possibly
 * huge) result string. Never includes more than a couple of lines verbatim —
 * this is a digest, not a transcript. Used for non-content tools only.
 */
function resultGist(resultText, ok) {
  const text = typeof resultText === 'string' ? resultText : String(resultText ?? '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const shown = lines.slice(0, 2).join(' ');
  const more = lines.length > 2 ? ` (+${lines.length - 2} more lines)` : '';
  const prefix = ok === false ? 'error: ' : '';
  return `${prefix}${shown}${more}`;
}

/**
 * Result gist for a content tool: shape only, never the text itself. An
 * error keeps its first line verbatim (a diagnostic, not third-party
 * content); a success collapses to "ok, N lines, M chars".
 */
function resultShapeGist(resultText, ok) {
  const text = typeof resultText === 'string' ? resultText : String(resultText ?? '');
  if (ok === false) {
    const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) || '';
    return `error: ${firstLine}`;
  }
  const lineCount = text.split('\n').map(l => l.trim()).filter(Boolean).length;
  const chars = text.length;
  const charsLabel = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
  return `ok, ${lineCount} line${lineCount === 1 ? '' : 's'}, ${charsLabel}`;
}

/** "<toolName>(<args gist>) -> <result gist>", hard-capped at 400 chars total.
 * Content tools (isContentTool) get the degraded key-only args + shape-only
 * result; everything else keeps the old verbatim-ish two-line gist. */
function buildDigest(toolName, args, resultText, ok) {
  const contentTool = isContentTool(toolName);
  const argsPart = contentTool ? argsKeysGist(args) : argsGist(args);
  const resultPart = contentTool ? resultShapeGist(resultText, ok) : resultGist(resultText, ok);
  let digest = `${toolName}(${argsPart}) -> ${resultPart}`;
  if (digest.length > MAX_DIGEST_LEN) digest = `${digest.slice(0, MAX_DIGEST_LEN - 3)}...`;
  return digest;
}

/**
 * Record one tool-call result as a personalization observation. Fire-and-
 * forget: returns void immediately, does its (async) work off to the side,
 * and never throws into the caller — every step is wrapped.
 * @param {{userId: string, agentId?: string|null, toolName: string, skillId?: string|null, args?: any, resultText?: string, ok?: boolean}} params
 */
export function recordToolObservation({ userId, agentId = null, toolName, skillId = null, args = null, resultText = '', ok = true } = /** @type {any} */ ({})) {
  // typeof check, not just truthiness — a non-string toolName would throw
  // synchronously at .startsWith below, into the tool-dispatch hot path this
  // function promises never to throw into.
  if (!userId || typeof toolName !== 'string' || !toolName) return;
  if (_suppressionALS.getStore()) return;
  if (SKIP_TOOLS.has(toolName) || toolName.startsWith('personalization_')) return;

  Promise.resolve()
    .then(async () => {
      const config = await getCachedConfig(userId);
      if (!config?.enabled || !config?.sources?.tools) return;
      const digest = buildDigest(toolName, args, resultText, ok);
      await appendObservation(userId, {
        source: toolName,
        skillId: skillId || null,
        kind: 'tool_result',
        digest,
        agentId: agentId || null,
      });
    })
    .catch(e => console.warn('[personalization] recordToolObservation failed:', e?.message || e));
}
