// @ts-check
/**
 * Per-user default-arg pinning for tool calls.
 *
 * Two stores:
 *  - `users/<id>/tool-defaults.json`   — accepted pins, merged into args at
 *                                        dispatch time
 *  - `users/<id>/tool-arg-counts.json` — sliding-window counter of identical
 *                                        arg values per (tool, arg). Used to
 *                                        decide when to propose a new pin.
 *
 * Safety:
 *  - Arg-name blocklist: never count/pin args matching key|token|secret|
 *    password|auth|bearer (case-insensitive substring).
 *  - Tool-name blocklist: skip destructive tools entirely
 *    (delete|remove|cancel|destroy|drop|purge|uninstall|kill|wipe).
 *  - Primitive values only: string|number|boolean. Skip null/undefined.
 *  - Skip strings longer than 200 chars (likely free-text, not a default).
 *  - User-provided args always win over the pinned default. We only fill
 *    keys that are absent or undefined.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const ARG_BLOCKLIST_RE  = /key|token|secret|password|auth|bearer/i;
// Args that ARE the work being done, not stable preferences. Pinning these
// either freezes the tool to one specific job (web_search.query = "weather
// <city>") or is meaningless (ask_agent.task = "some test prompt").
// Skipped at both the counter and the proposer level.
const PER_CALL_ARG_NAMES = new Set([
  // Free-text inputs (the work itself)
  'task', 'query', 'url', 'path', 'command', 'prompt', 'text', 'subject',
  'body', 'content', 'message', 'code', 'regex', 'expression', 'script',
  'filter', 'name', 'pattern', 'search', 'input',
  // Paging cursors — describe "where in the data to begin", never a stable
  // user preference (next call uses a different offset by definition)
  'offset', 'start', 'from', 'since', 'cursor', 'page', 'before', 'after',
  'page_token', 'next_page_token', 'continuation',
  // Per-item descriptors — picked fresh each time you create/edit a thing
  // (a skill's icon, a watcher's label, a task's title, an alarm's
  // description, etc. — pinning would force every future creation to
  // reuse the same descriptor)
  'icon', 'emoji', 'color', 'description', 'label', 'title', 'tags', 'category',
  // Target identifiers — every call targets a specific thing; pinning would
  // force every future call at that ONE target, which is wrong (node_exec
  // could be any node, ha calls could be any entity, etc.)
  'agent_id', 'recipient', 'to', 'id', 'target',
  'node_id', 'device_id', 'entity_id', 'scene_id', 'service_id', 'tool',
  'channel_id', 'video_id', 'doc_id', 'file_id', 'thread_id', 'message_id',
  'project_id', 'task_id', 'watcher_id', 'proposal_id', 'skill_id',
  'role_id', 'user_id', 'account_id',
]);
// Tool-name blocklist. Tool names use `_` as separator and `_` is a word
// character in regex, so `\b` between `delete` and `_` does NOT match. Use
// explicit (start-or-underscore) / (end-or-underscore) boundaries.
const TOOL_BLOCKLIST_RE = /(?:^|_)(?:delete|remove|cancel|destroy|drop|purge|uninstall|kill|wipe|forget)(?:_|$)/i;
const COUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PIN_THRESHOLD = 3;
const MAX_STRING_LEN = 200;

function defaultsPath(userId) { return path.join(USERS_DIR, userId, 'tool-defaults.json'); }
function countsPath(userId)   { return path.join(USERS_DIR, userId, 'tool-arg-counts.json'); }

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export function loadDefaults(userId) {
  if (!userId) return {};
  return readJsonSafe(defaultsPath(userId));
}

async function saveDefaults(userId, data) {
  const p = defaultsPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
}

function loadCounts(userId) {
  return readJsonSafe(countsPath(userId));
}

async function saveCounts(userId, data) {
  const p = countsPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  });
}

// Sentinel "natural default" values — shorthand for "use the implicit
// default", not a real preference. Pinning these is redundant because
// omitting the arg gives the same behavior. Pinning a SPECIFIC path
// (e.g. directory = "/home/shawn/myproject") IS useful; pinning "." is not.
const NATURAL_DEFAULT_VALUES = new Set([
  '', '.', '..', '/', '~',
  'auto', 'default', 'none', 'null', 'undefined',
]);

function isPinnableArg(argName, value) {
  if (!argName || ARG_BLOCKLIST_RE.test(argName)) return false;
  // Per-call args that are the work itself (the search query, the file
  // path, the agent target, the recipient) are never stable defaults.
  if (PER_CALL_ARG_NAMES.has(argName.toLowerCase())) return false;
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') return false;
  if (t === 'string' && value.length > MAX_STRING_LEN) return false;
  // Skip sentinel values that mean "use the natural default"
  if (t === 'string' && NATURAL_DEFAULT_VALUES.has(value.toLowerCase().trim())) return false;
  // Boolean `false` is almost always the natural default — pinning it
  // amounts to "leave behavior unchanged." `true` CAN be a real
  // preference (e.g. always-on verbose mode), so keep that pinnable.
  if (t === 'boolean' && value === false) return false;
  return true;
}

// Exposed for the sweep so it applies the same blocklists as runtime.
export function _testIsPinnable(toolName, argName, value) {
  if (!isPinnableTool(toolName)) return false;
  return isPinnableArg(argName, value);
}

function isPinnableTool(toolName) {
  if (!toolName) return false;
  if (TOOL_BLOCKLIST_RE.test(toolName)) return false;
  return true;
}

/**
 * Merge accepted defaults into args before dispatch. User-provided args win;
 * we only fill keys that are absent or undefined. Returns a new object so
 * the caller can compare in/out without aliasing.
 */
export function mergeDefaults(userId, toolName, args) {
  if (!userId || !toolName || !args || typeof args !== 'object') return args;
  if (!isPinnableTool(toolName)) return args;
  const all = loadDefaults(userId);
  const pins = all[toolName];
  if (!pins || typeof pins !== 'object') return args;
  const out = { ...args };
  for (const [k, v] of Object.entries(pins)) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/**
 * Count an observed arg value. Fire-and-forget from the dispatcher. Returns
 * an object describing what happened so the caller can decide to propose:
 *   { proposed: false }                              — no action
 *   { proposed: true, tool, arg, value, count }      — threshold tripped,
 *                                                      caller should emit
 *                                                      a default_arg proposal
 *
 * We trip exactly once per value at the threshold count. After tripping we
 * leave the counter in place so the user dismissing the proposal can re-trip
 * later if they keep using the value — but the proposal layer's own
 * dismiss cooldown gates re-prompts in practice.
 */
export async function recordToolCall(userId, toolName, args) {
  if (!userId || !toolName || !args || typeof args !== 'object') return { proposed: false };
  if (!isPinnableTool(toolName)) return { proposed: false };

  // Skip if any pin already exists for this tool+arg — no need to count.
  const existing = loadDefaults(userId)[toolName] || {};

  const counts = loadCounts(userId);
  const now = Date.now();
  const cutoff = now - COUNT_WINDOW_MS;
  let proposal = null;
  let mutated = false;

  for (const [argName, value] of Object.entries(args)) {
    if (existing[argName] !== undefined) continue;        // already pinned
    if (!isPinnableArg(argName, value)) continue;
    const key = `${toolName}.${argName}`;
    const vKey = canonicalValueKey(value);

    if (!counts[key]) counts[key] = {};
    const bucket = counts[key][vKey];
    const arr = Array.isArray(bucket) ? bucket.filter(t => t > cutoff) : [];
    arr.push(now);
    counts[key][vKey] = arr;
    mutated = true;

    // Prune buckets that emptied out so the file doesn't grow forever.
    if (arr.length === 0) delete counts[key][vKey];
    if (Object.keys(counts[key]).length === 0) delete counts[key];

    // Trip on the threshold-th occurrence (not every subsequent one) so we
    // emit a single proposal per value, not N. The proposal's own dismiss
    // cooldown handles the case where the user said no to this pin recently.
    if (!proposal && arr.length === PIN_THRESHOLD) {
      // Same-arg conflict suppression: if the user has passed 2+ DIFFERENT
      // values for the same (tool, arg) in this window, this arg is varying
      // per call — don't propose a default at all. Without this we'd flood
      // the inbox with N competing proposals for timeout=30/60/120/300/etc.
      const valueBucketCount = Object.keys(counts[key]).length;
      if (valueBucketCount >= 2) {
        // Skip — too many competing values to pick one default.
        continue;
      }
      proposal = { proposed: true, tool: toolName, arg: argName, value, count: PIN_THRESHOLD };
    }
  }

  if (mutated) {
    try { await saveCounts(userId, counts); } catch (e) {
      console.warn('[tool-defaults] counts persist failed:', e.message);
    }
  }
  return proposal || { proposed: false };
}

function canonicalValueKey(value) {
  const t = typeof value;
  // Bucket key has to be JSON-stable and reasonably short. Primitives stringify
  // cleanly; the isPinnableArg gate already excluded objects/arrays.
  if (t === 'string')  return `s:${value}`;
  if (t === 'number')  return `n:${value}`;
  if (t === 'boolean') return `b:${value}`;
  return `j:${JSON.stringify(value)}`;
}

/**
 * Accept handler — write a pin. Idempotent: re-pinning the same value is a
 * no-op; pinning a NEW value for the same (tool,arg) overwrites.
 */
export async function pinDefault(userId, toolName, argName, value) {
  if (!userId || !toolName || !argName) return { ok: false, error: 'bad args' };
  if (!isPinnableTool(toolName) || !isPinnableArg(argName, value)) {
    return { ok: false, error: 'not pinnable' };
  }
  const all = loadDefaults(userId);
  if (!all[toolName]) all[toolName] = {};
  all[toolName][argName] = value;
  await saveDefaults(userId, all);
  return { ok: true };
}

/**
 * Revoke handler — drop a pin. Writes an audit line to
 * users/<id>/tool-defaults.deleted.log before mutation so the user can
 * recover from a mistaken click.
 */
export async function unpinDefault(userId, toolName, argName) {
  if (!userId || !toolName || !argName) return { ok: false, error: 'bad args' };
  const all = loadDefaults(userId);
  const cur = all[toolName]?.[argName];
  if (cur === undefined) return { ok: false, error: 'not found' };
  try {
    const logPath = path.join(USERS_DIR, userId, 'tool-defaults.deleted.log');
    fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), tool: toolName, arg: argName, value: cur }) + '\n');
  } catch (e) {
    console.warn('[tool-defaults] deleted-log write failed:', e.message);
  }
  delete all[toolName][argName];
  if (Object.keys(all[toolName]).length === 0) delete all[toolName];
  await saveDefaults(userId, all);
  return { ok: true, removed: { tool: toolName, arg: argName, value: cur } };
}

/**
 * Pin-usage event log — used by the default_arg outcome measurer to count
 * overrides in the 7d post-accept window. Called from the dispatcher AFTER
 * mergeDefaults so we can compare what the user supplied vs. the pinned value.
 *
 * Event kinds:
 *   fill      — pin was applied (user omitted the arg)
 *   reaffirm  — user supplied the same value as the pin (no override)
 *   override  — user supplied a DIFFERENT value (the pin is wrong / they wanted something else)
 */
const PIN_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
function pinEventsPath(userId) {
  return path.join(USERS_DIR, userId, 'tool-pin-events.jsonl');
}
function valueEquals(a, b) {
  const t = typeof a;
  if (t !== typeof b) return false;
  if (t === 'string' || t === 'number' || t === 'boolean') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
export async function recordPinUsage(userId, toolName, suppliedArgs) {
  if (!userId || !toolName || !suppliedArgs || typeof suppliedArgs !== 'object') return;
  const pins = loadDefaults(userId)[toolName];
  if (!pins || typeof pins !== 'object') return;
  const events = [];
  const now = Date.now();
  for (const [argName, pinnedValue] of Object.entries(pins)) {
    const supplied = suppliedArgs[argName];
    let kind;
    if (supplied === undefined) kind = 'fill';
    else if (valueEquals(supplied, pinnedValue)) kind = 'reaffirm';
    else kind = 'override';
    events.push({ ts: now, tool: toolName, arg: argName, kind, pinned: pinnedValue, supplied: supplied ?? null });
  }
  if (!events.length) return;

  const p = pinEventsPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - PIN_EVENT_RETENTION_MS;
      let kept = [];
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (rec.ts > cutoff) kept.push(line);
          } catch { /* drop bad lines */ }
        }
      }
      for (const ev of events) kept.push(JSON.stringify(ev));
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[tool-defaults] pin-event append failed:', e.message);
  }
}
export function loadPinEvents(userId) {
  if (!userId) return [];
  const p = pinEventsPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Aggregated view for the Learn panel — flat list of pins suitable for
 * rendering one row per pin.
 */
export function listDefaults(userId) {
  const all = loadDefaults(userId);
  const out = [];
  for (const [tool, args] of Object.entries(all)) {
    if (!args || typeof args !== 'object') continue;
    for (const [arg, value] of Object.entries(args)) {
      out.push({ tool, arg, value });
    }
  }
  return out;
}
