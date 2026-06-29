// @ts-check
/**
 * Shared guardrails for OE's learning loops.
 *
 * Hermes-style "learn from repeated experience" is useful, but OE routes that
 * learning into real tools, routing, aliases, routines, and local dispatch.
 * Keep the high-risk classifiers centralized so proposal emitters, accept
 * handlers, and direct auto-learners do not drift apart.
 */

export const DESTRUCTIVE_VERB_RE =
  /\b(?:delete|remove|wipe|drop|format|destroy|erase|rm|uninstall|purge|trash|unlink|truncate|shred|overwrite|kill|reset|clear|forget|cancel)\b/i;

// Tool names use "_" as a separator and "_" is a word character, so \b does
// not work between "delete" and "_". Use explicit boundaries.
export const DESTRUCTIVE_TOOL_RE =
  /(?:^|_)(?:delete|remove|cancel|destroy|drop|purge|trash|uninstall|kill|wipe|forget|clear|reset)(?:_|$)/i;

export const SENSITIVE_ARG_RE = /key|token|secret|password|auth|bearer/i;

// Args that are the work/target of a single call, not durable preferences.
export const PER_CALL_ARG_NAMES = new Set([
  'task', 'query', 'q', 'url', 'path', 'file', 'address', 'command', 'cmd',
  'prompt', 'text', 'body', 'content', 'message', 'code', 'regex',
  'expression', 'script', 'filter', 'name', 'pattern', 'search', 'input',
  'phrase', 'keyword', 'term',
  'offset', 'start', 'from', 'since', 'cursor', 'page', 'before', 'after',
  'page_token', 'next_page_token', 'continuation',
  'icon', 'emoji', 'color', 'description', 'label', 'title', 'tags',
  'category', 'subject',
  'agent_id', 'recipient', 'sender', 'to', 'cc', 'bcc', 'id', 'target',
  'node_id', 'device_id', 'entity_id', 'scene_id', 'service_id', 'tool',
  'channel_id', 'video_id', 'doc_id', 'file_id', 'thread_id', 'message_id',
  'project_id', 'task_id', 'watcher_id', 'proposal_id', 'skill_id',
  'role_id', 'user_id', 'account', 'account_id',
]);

export const NATURAL_DEFAULT_VALUES = new Set([
  '', '.', '..', '/', '~',
  'auto', 'default', 'none', 'null', 'undefined',
]);

// Tool-specific args that look preference-like in isolation but change the
// meaning, audience, or safety boundary of a single call.
export const NEVER_DEFAULT_TOOL_ARGS = new Set([
  'remember_fact.scope',
]);

const GENERIC_ALIAS_PHRASES = new Set([
  'latest', 'new', 'recent', 'newest', 'old', 'oldest', 'next', 'previous',
  'prev', 'last', 'first', 'default',
  'this', 'that', 'these', 'those', 'it', 'one', 'thing', 'item', 'stuff',
  'email', 'message', 'file', 'account', 'skill', 'agent', 'node', 'project',
]);

export function isDestructiveText(text) {
  return DESTRUCTIVE_VERB_RE.test(String(text || ''));
}

export function isDestructiveTool(toolName) {
  return DESTRUCTIVE_TOOL_RE.test(String(toolName || ''));
}

export function isSensitiveArgName(argName) {
  return SENSITIVE_ARG_RE.test(String(argName || ''));
}

export function isPerCallArgName(argName) {
  const a = String(argName || '');
  if (!a) return true;
  if (/Id$/.test(a) || /(^|_)(id|ids|uuid|guid|token)$/i.test(a)) return true;
  if (/date/i.test(a)) return true;
  // Result-count / paging knobs (maxResults, max_results, limit, count,
  // page_size, per_page, num_results, results, rows). These size a single
  // call's response window, not a durable preference — pinning e.g.
  // `gcal_list.maxResults = 10` is pure proposal noise.
  if (/^(?:max_?results?|num_?results?|page_?size|per_?page|limit|count|results?|rows?)$/i.test(a)) return true;
  return PER_CALL_ARG_NAMES.has(a.toLowerCase());
}

export function isToolArgNeverDefault(toolName, argName) {
  return NEVER_DEFAULT_TOOL_ARGS.has(`${String(toolName || '').toLowerCase()}.${String(argName || '').toLowerCase()}`);
}

export function isPrimitiveDefaultValue(value, { maxStringLen = 200 } = {}) {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') return false;
  if (t === 'string') {
    if (value.length > maxStringLen) return false;
    const v = value.toLowerCase().trim();
    if (NATURAL_DEFAULT_VALUES.has(v)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
    if (/^[0-9a-f]{12,}$/i.test(value)) return false;
  }
  if (t === 'number' && Math.abs(value) > 1e6) return false;
  if (t === 'boolean' && value === false) return false;
  return true;
}

export function isDefaultArgNoise(toolName, argName, value) {
  if (isDestructiveTool(toolName)) return true;
  if (isToolArgNeverDefault(toolName, argName)) return true;
  if (isSensitiveArgName(argName)) return true;
  if (isPerCallArgName(argName)) return true;
  return !isPrimitiveDefaultValue(value);
}

export function normalizeLearnedPhrase(phrase, nounSingular = '') {
  let n = String(phrase ?? '').toLowerCase().trim()
    .replace(/^(the|a|an|my|our)\s+/, '')
    .replace(/['"`]/g, '')
    .replace(/[._\-/]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (nounSingular) {
    const ns = String(nounSingular).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    n = n.replace(new RegExp(`\\s+${ns}$`), '').trim();
  }
  return n;
}

export function isLearnableAliasPhrase(phrase, nounSingular = '') {
  const n = normalizeLearnedPhrase(phrase, nounSingular);
  if (!n || n.length < 2 || n.length > 60) return false;
  if (GENERIC_ALIAS_PHRASES.has(n)) return false;
  if (/^\d+$/.test(n)) return false;
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;
  if (words.every(w => GENERIC_ALIAS_PHRASES.has(w))) return false;
  return true;
}
