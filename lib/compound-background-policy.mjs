/**
 * Pure policy for moving a long, self-contained singleton workflow to one
 * detached worker before the foreground model starts.
 *
 * The policy deliberately knows nothing about a particular user skill. It
 * matches each explicit instruction clause against the tool schemas and role
 * manifest metadata that were routed for this turn, then estimates the cost of
 * the dependent chain. A custom live-data skill therefore participates through
 * its own name/description/intent examples; no domain name is baked in here.
 */

import { routingInstructionClauses } from './routing-clauses.mjs';

const CONTROL_TOOL_NAMES = new Set([
  'ask_agent', 'spawn_worker', 'check_workers', 'stop_worker',
  'report_progress', 'request_tools', 'list_roles', 'list_active_agents',
  'get_task_log',
]);

const TOKEN_STOPWORDS = new Set([
  'a', 'active', 'an', 'and', 'are', 'as', 'at', 'background', 'be', 'by',
  'currently', 'did', 'do', 'does', 'exactly', 'for', 'from', 'has', 'have',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'once', 'or', 'please',
  'that', 'the', 'their', 'them', 'then', 'this', 'to', 'using', 'with',
  'you', 'your', 'user', 'optional', 'required', 'parameter', 'parameters',
  'tool', 'directly', 'something', 'anything', 'current', 'today', 'now',
  'use', 'used',
]);

const ACTION_CLASSES = {
  create: new Set(['build', 'compose', 'create', 'draw', 'generate', 'make', 'prepare', 'produce', 'render', 'write']),
  retrieve: new Set(['check', 'fetch', 'find', 'get', 'list', 'look', 'read', 'research', 'search', 'show', 'summarize', 'what', 'how']),
  deliver: new Set(['deliver', 'email', 'forward', 'message', 'post', 'send', 'share', 'text', 'upload']),
  mutate: new Set(['add', 'book', 'buy', 'call', 'cancel', 'delete', 'open', 'order', 'play', 'remove', 'set', 'turn', 'update']),
};

const ARTIFACT_WORDS = new Set([
  'archive', 'asset', 'attachment', 'audio', 'chart', 'code', 'diagram',
  'document', 'file', 'image', 'illustration', 'media', 'photo', 'picture',
  'presentation', 'report', 'spreadsheet', 'video',
]);
const LIVE_WORDS = new Set([
  'api', 'current', 'fetch', 'forecast', 'latest', 'live', 'lookup',
  'realtime', 'remote', 'search', 'status', 'today', 'tomorrow',
]);
const DELIVERY_SHAPE_WORDS = new Set([
  'attachment', 'body', 'channel', 'content', 'destination', 'message',
  'recipient', 'subject', 'target', 'to',
]);

const FOREGROUND_OVERRIDE_RE = /\b(?:do\s+not|don'?t|never)\s+(?:run\s+this\s+in\s+the\s+)?background\b|\b(?:keep|run|do)\s+(?:this\s+)?(?:in\s+the\s+)?foreground\b|\b(?:synchronously|while\s+i\s+wait|wait\s+for\s+it)\b/i;
const BACKGROUND_REQUEST_RE = /\b(?:in\s+the\s+background|background\s+(?:this|task|job)|while\s+(?:i|we)\s+(?:keep\s+)?chatting)\b/i;
// A detached worker cannot ask a useful follow-up. Stay foreground when the
// instruction itself says a human decision/preview must occur before action.
const INTERACTION_REQUIRED_RE = /\b(?:ask\s+me\s+(?:first|before)|before\s+you\s+(?:act|continue|do|send|start)|let\s+me\s+(?:choose|decide|pick|review)|show\s+me\s+(?:a\s+)?(?:draft|preview|proposal)\s+first|wait\s+for\s+(?:my\s+)?(?:approval|confirmation)|only\s+after\s+i\s+(?:approve|confirm)|if\s+i\s+(?:approve|confirm))\b/i;

// These are orchestration instructions for the foreground manager, not work
// the already-admitted worker must repeat. Only strip a colon-delimited prefix
// that names the exact control tool; ordinary requests containing the words
// "worker" or "background" remain untouched.
const SPAWN_WORKER_PREFIX_RE = /^\s*(?:please\s+)?(?:use|call|invoke)\s+(?:the\s+)?`?spawn_worker`?\b[^:!?;\n]{0,240}:\s*/i;
const NEGATIVE_CLAUSE_START_RE = /^\s*(?:please\s+)?(?:do\s+not|don'?t|never|avoid|refrain\s+from|without|no\b)/i;
const INLINE_NEGATIVE_CONSTRAINT_RE = /(?:\s*,?\s*\b(?:but\s+)?(?:do\s+not|don'?t|never|avoid|refrain\s+from|without)\b|\s*,\s*no\b)/i;
const RETURN_AFTER_WORKER_START_RE = /(?:^|(?<=[.!?])\s+)(?:please\s+)?return\s+immediately\b(?=[^.!?\n]{0,180}\b(?:worker|background|chat(?:ting)?)\b)[^.!?\n]*(?:[.!?](?=\s|$)|$)/gi;

function stem(raw) {
  let word = String(raw || '').toLowerCase();
  if (word.length > 5 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
  else if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3).replace(/(.)\1$/, '$1');
  else if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
  else if (word.length > 5 && word.endsWith('es')) word = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
  return word;
}

function words(value, { keepStopwords = false } = {}) {
  const matches = String(value ?? '').toLowerCase().normalize('NFKC').match(/[a-z0-9]+/g) || [];
  return new Set(matches
    .map(stem)
    .filter(word => word.length >= 2 && (keepStopwords || !TOKEN_STOPWORDS.has(word))));
}

// Lexical tool matching is deliberately exact-word. Morphological stems are
// still useful for action classes ("emailed" is delivery), but using them for
// tool identity made the adjective "listed" count as the `list_watches`
// operation. Tool schemas are an admission contract, so false negatives fail
// open to the normal foreground path while false positives freeze bogus work.
function lexicalWords(value, { keepStopwords = false } = {}) {
  const matches = String(value ?? '').toLowerCase().normalize('NFKC').match(/[a-z0-9]+/g) || [];
  return new Set(matches
    .filter(word => word.length >= 2 && (keepStopwords || !TOKEN_STOPWORDS.has(word))));
}

function stripSpawnWorkerPrefix(value) {
  return String(value ?? '').replace(SPAWN_WORKER_PREFIX_RE, '').trim();
}

// Constraints such as "do not email" narrow a job; they are never positive
// steps in its completion contract. For a mixed clause, keep only the
// affirmative prefix. Truncating an ambiguous tail is conservative: any later
// positive operation becomes unmatched and stays in the foreground rather
// than turning a prohibited tool into mandatory work.
function affirmativeInstructionClause(value) {
  const withoutOrchestration = stripSpawnWorkerPrefix(value);
  if (!withoutOrchestration || NEGATIVE_CLAUSE_START_RE.test(withoutOrchestration)) return '';
  const negative = INLINE_NEGATIVE_CONSTRAINT_RE.exec(withoutOrchestration);
  if (!negative) return withoutOrchestration;
  return withoutOrchestration.slice(0, negative.index)
    .replace(/[\s,;:-]+$/, '')
    .trim();
}

/**
 * Build model-only guidance for a worker that the server has already admitted.
 * The original prompt remains the durable task/idempotency identity; this copy
 * removes only manager instructions that would make the leaf worker try to
 * hire another worker and preserves the user's actual work and prohibitions.
 */
export function compoundWorkerExecutionTask(userText) {
  const original = String(userText ?? '').trim();
  if (!original) return null;
  const withoutPrefix = stripSpawnWorkerPrefix(original);
  const withoutReturn = withoutPrefix.replace(RETURN_AFTER_WORKER_START_RE, ' ').trim();
  const changed = withoutPrefix !== original || withoutReturn !== withoutPrefix;
  if (!changed || !withoutReturn) return null;
  return [
    'The background worker requested by the user has already been started. Do not call spawn_worker; perform the job below directly and return its actual result.',
    '',
    withoutReturn,
  ].join('\n');
}

function flattenSchemaText(schema, out = [], depth = 0) {
  if (!schema || depth > 5) return out;
  if (typeof schema === 'string') {
    out.push(schema);
    return out;
  }
  if (Array.isArray(schema)) {
    for (const value of schema) flattenSchemaText(value, out, depth + 1);
    return out;
  }
  if (typeof schema !== 'object') return out;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        out.push(propertyName);
        flattenSchemaText(propertySchema, out, depth + 1);
      }
    } else if (key === 'enum' || key === 'description' || key === 'title') {
      out.push(key);
      flattenSchemaText(value, out, depth + 1);
    } else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      flattenSchemaText(value, out, depth + 1);
    }
  }
  return out;
}

function actionKinds(tokenSet) {
  const kinds = new Set();
  for (const [kind, verbs] of Object.entries(ACTION_CLASSES)) {
    if ([...verbs].some(verb => tokenSet.has(stem(verb)))) kinds.add(kind);
  }
  return kinds;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count++;
  return count;
}

function ownerIntentText(owner) {
  const values = [owner?.name, owner?.description, owner?.category];
  if (Array.isArray(owner?.intent_examples)) values.push(...owner.intent_examples);
  if (Array.isArray(owner?.localIntents)) {
    for (const intent of owner.localIntents) {
      if (Array.isArray(intent?.utterances)) values.push(...intent.utterances);
    }
  }
  return values.filter(Boolean).join(' ');
}

function toolMetadata(entry) {
  const fn = entry?.tool?.function || entry?.tool || {};
  const schemaText = flattenSchemaText(fn.parameters || fn.input_schema || {}).join(' ');
  const nameText = String(fn.name || entry?.name || '').replace(/[_.:-]+/g, ' ');
  const descriptionText = [fn.description, schemaText].filter(Boolean).join(' ');
  const ownerText = ownerIntentText(entry?.owner);
  const allText = [nameText, descriptionText, ownerText].filter(Boolean).join(' ');
  return {
    name: fn.name || entry?.name || '',
    nameTokens: lexicalWords(nameText),
    descriptionTokens: lexicalWords(descriptionText),
    ownerTokens: lexicalWords(ownerText),
    allTokens: words(allText, { keepStopwords: true }),
    allText,
  };
}

function matchesManifestPattern(clause, owner) {
  for (const pattern of (Array.isArray(owner?.intent_patterns) ? owner.intent_patterns : [])) {
    try { if (new RegExp(pattern, 'i').test(clause)) return true; }
    catch { /* malformed user manifest patterns are ignored here, as in routing */ }
  }
  return false;
}

function inferTraits(entry, metadata) {
  const tool = entry?.tool || {};
  const kinds = actionKinds(metadata.allTokens);
  const artifact = kinds.has('create')
    && intersectionSize(metadata.allTokens, ARTIFACT_WORDS) > 0;
  const delivery = kinds.has('deliver')
    && intersectionSize(metadata.allTokens, DELIVERY_SHAPE_WORDS) > 0;
  const liveRead = tool.readOnly === true
    || (kinds.has('retrieve') && intersectionSize(metadata.allTokens, LIVE_WORDS) > 0);
  const explicitlyLong = /\b(?:long[- ]running|background\s+job|may\s+take|takes?\s+(?:several|a\s+few)\s+(?:seconds|minutes)|deep\s+research)\b/i.test(metadata.allText);
  const longRunning = explicitlyLong || (artifact
    && /\b(?:audio|generate|image|media|render|research|video)\b/i.test(metadata.allText));
  return {
    artifactProducer: artifact,
    delivery,
    liveRead,
    longRunning,
    destructive: tool.destructive === true || tool.function?.destructive === true,
  };
}

function bestToolForClause(clause, entries) {
  const clauseTokens = lexicalWords(clause);
  const clauseAllTokens = words(clause, { keepStopwords: true });
  const clauseKinds = actionKinds(clauseAllTokens);
  const byCapability = new Map();

  for (const entry of entries) {
    const metadata = toolMetadata(entry);
    if (!metadata.name || CONTROL_TOOL_NAMES.has(metadata.name)) continue;
    const nameOverlap = intersectionSize(clauseTokens, metadata.nameTokens);
    const descriptionOverlap = intersectionSize(clauseTokens, metadata.descriptionTokens);
    const ownerOverlap = intersectionSize(clauseTokens, metadata.ownerTokens);
    const metadataKinds = actionKinds(metadata.allTokens);
    const actionOverlap = intersectionSize(clauseKinds, metadataKinds);
    const pattern = matchesManifestPattern(clause, entry?.owner);
    const lexical = nameOverlap + descriptionOverlap + ownerOverlap;
    if (!pattern && (lexical === 0 || actionOverlap === 0)) continue;

    const score = (nameOverlap * 5) + (descriptionOverlap * 2)
      + ownerOverlap + (actionOverlap * 3) + (pattern ? 10 : 0);
    if (score < 7) continue;
    const capability = entry?.ownerId || `runtime:${metadata.name}`;
    const candidate = {
      clause,
      capability,
      toolName: metadata.name,
      score,
      traits: inferTraits(entry, metadata),
    };
    const prior = byCapability.get(capability);
    if (!prior || candidate.score > prior.score) byCapability.set(capability, candidate);
  }

  return [...byCapability.values()]
    .sort((a, b) => b.score - a.score || a.capability.localeCompare(b.capability))[0] || null;
}

function estimateStepSeconds(step) {
  if (step.traits.longRunning) return 10;
  if (step.traits.artifactProducer) return 7;
  if (step.traits.liveRead) return 3;
  if (step.traits.delivery) return 2;
  return 2;
}

/**
 * @param {{
 *   userText: string,
 *   entries: Array<{tool: object, ownerId?: string, owner?: object}>,
 *   minimumSeconds?: number,
 * }} args
 */
export function evaluateCompoundBackground({ userText, entries, minimumSeconds = 12 }) {
  const text = String(userText || '').trim();
  const base = {
    shouldBackground: false,
    reason: 'not-qualified',
    clauses: [], matchedSteps: [], capabilityCount: 0, estimatedSeconds: 0,
  };
  if (!text || FOREGROUND_OVERRIDE_RE.test(text)) {
    return { ...base, reason: text ? 'foreground-override' : 'empty' };
  }
  if (INTERACTION_REQUIRED_RE.test(text)) return { ...base, reason: 'needs-interaction' };

  const clauses = routingInstructionClauses(text, { max: 8 })
    .map(affirmativeInstructionClause)
    .filter(Boolean);
  if (clauses.length < 2) return { ...base, clauses, reason: 'single-step' };
  const matchedSteps = clauses.map(clause => bestToolForClause(clause, entries || [])).filter(Boolean);
  const capabilities = new Set(matchedSteps.map(step => step.capability));
  const orchestrationSeconds = Math.max(0, matchedSteps.length - 1) * 4;
  const estimatedSeconds = matchedSteps.reduce((sum, step) => sum + estimateStepSeconds(step), 0)
    + orchestrationSeconds;
  const common = { clauses, matchedSteps, capabilityCount: capabilities.size, estimatedSeconds };
  // A detached worker cannot ask what an unmatched instruction meant, and a
  // partial match must never silently turn a three-step request into a
  // two-step completion contract. Keep the whole turn in the foreground when
  // even one explicit instruction clause lacks a routed capability.
  if (matchedSteps.length !== clauses.length) {
    return { ...base, ...common, reason: 'unmatched-clause' };
  }
  if (matchedSteps.length < 2 || capabilities.size < 2) {
    return { ...base, ...common, reason: 'insufficient-capabilities' };
  }
  if (matchedSteps.some(step => step.traits.destructive)) {
    return { ...base, ...common, reason: 'destructive-tool' };
  }
  const hasHeavyStep = matchedSteps.some(step => step.traits.longRunning || step.traits.artifactProducer);
  const userAskedForBackground = BACKGROUND_REQUEST_RE.test(text);
  const longEnough = estimatedSeconds >= minimumSeconds;
  const complexEnough = hasHeavyStep || matchedSteps.length >= 3;
  const shouldBackground = userAskedForBackground
    ? longEnough
    : (longEnough && complexEnough);
  return {
    ...base,
    ...common,
    shouldBackground,
    reason: shouldBackground
      ? (userAskedForBackground ? 'explicit-background' : 'long-compound-workflow')
      : 'below-background-threshold',
  };
}

export const _internal = {
  actionKinds,
  affirmativeInstructionClause,
  bestToolForClause,
  flattenSchemaText,
  lexicalWords,
  stem,
  stripSpawnWorkerPrefix,
  toolMetadata,
  words,
};
