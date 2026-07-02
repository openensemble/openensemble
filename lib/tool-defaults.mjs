// @ts-check
/**
 * Per-user default-arg pinning for tool calls.
 *
 * One store: `users/<id>/tool-defaults.json` — accepted pins, merged into
 * args at dispatch time. The counter that mined tool calls to PROPOSE new
 * pins (`tool-arg-counts.json`) is retired — tool args are model-authored,
 * so repeated values were never user preferences (see RETIRED_PROPOSAL_KINDS
 * in learning-policy.mjs). Pins now only come from explicit user action, and
 * existing accepted pins keep merging and can be revoked from the Learn panel.
 *
 * Safety:
 *  - Arg-name blocklist: never count/pin args matching key|token|secret|
 *    password|auth|bearer (case-insensitive substring).
 *  - Tool-name blocklist: skip destructive tools entirely
 *    (delete|remove|cancel|destroy|drop|purge|trash|uninstall|kill|wipe).
 *  - Primitive values only: string|number|boolean. Skip null/undefined.
 *  - Skip strings longer than 200 chars (likely free-text, not a default).
 *  - User-provided args always win over the pinned default. We only fill
 *    keys that are absent or undefined.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { isDefaultArgNoise, isDestructiveTool, isInfrastructureDefaultTool } from './learning-safety.mjs';

function defaultsPath(userId) { return path.join(USERS_DIR, userId, 'tool-defaults.json'); }

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

function isPinnableArg(toolName, argName, value) {
  // Pass the real tool name through: some guards (e.g. NEVER_DEFAULT_TOOL_ARGS
  // for remember_fact.scope) are keyed on tool+arg, so dropping the tool name
  // here would silently let a tool-scoped unsafe default slip past merge/pin.
  return !isDefaultArgNoise(toolName, argName, value);
}

// Exposed for the sweep so it applies the same blocklists as runtime.
export function _testIsPinnable(toolName, argName, value) {
  if (!isPinnableTool(toolName)) return false;
  return isPinnableArg(toolName, argName, value);
}

function isPinnableTool(toolName) {
  if (!toolName) return false;
  if (isInfrastructureDefaultTool(toolName)) return false;
  if (isDestructiveTool(toolName)) return false;
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
    if (!isPinnableArg(toolName, k, v)) continue;
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/**
 * Accept handler — write a pin. Idempotent: re-pinning the same value is a
 * no-op; pinning a NEW value for the same (tool,arg) overwrites.
 */
export async function pinDefault(userId, toolName, argName, value) {
  if (!userId || !toolName || !argName) return { ok: false, error: 'bad args' };
  if (!isPinnableTool(toolName) || !isPinnableArg(toolName, argName, value)) {
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
    if (!isPinnableArg(toolName, argName, pinnedValue)) continue;
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
    if (!isPinnableTool(tool)) continue;
    if (!args || typeof args !== 'object') continue;
    for (const [arg, value] of Object.entries(args)) {
      if (!isPinnableArg(tool, arg, value)) continue;
      out.push({ tool, arg, value });
    }
  }
  return out;
}
