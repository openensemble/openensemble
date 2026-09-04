/**
 * Explicit fan-out preflight for detached coordinator workers.
 *
 * Parallel child agents are an opt-in execution mode. Ordinary prompts stay
 * on one execution path even when their work could be divided (for example,
 * a news roundup or comparison). The gate opens only when the user explicitly
 * asks for parallelism/multiple agents or the parent carries an exact count.
 */

const ROOT_WORKER_ID_RE = /^ephemeral_worker_[^_]+_[^_]+_.+$/;

const HARD_MAX_PARALLEL_WORKSTREAMS = 12;

export function resolveMaxParallelWorkstreams(
  configuredValue = process.env.OPENENSEMBLE_MAX_WORKSTREAMS_PER_OUTCOME,
) {
  if (configuredValue === undefined || configuredValue === null) {
    return HARD_MAX_PARALLEL_WORKSTREAMS;
  }
  const text = String(configuredValue).trim();
  if (!/^\d+$/.test(text)) return HARD_MAX_PARALLEL_WORKSTREAMS;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 2) {
    return HARD_MAX_PARALLEL_WORKSTREAMS;
  }
  return Math.min(parsed, HARD_MAX_PARALLEL_WORKSTREAMS);
}

export const MAX_PARALLEL_WORKSTREAMS = resolveMaxParallelWorkstreams();
const MAX_ADAPTIVE_PARALLEL_WORKSTREAMS = Math.min(4, MAX_PARALLEL_WORKSTREAMS);

const SINGLE_AGENT_RE = /\bsingle[- ](?:threaded|agent)\b/i;
// A period inside a provider/model id is not a sentence boundary. Safety
// guards must therefore scan through `gpt-5.6` while still stopping at the
// period in `agents. Use ...`.
const CLAUSE_TEXT_CHARACTER = String.raw`(?:(?<=[a-z0-9])\.(?=[a-z0-9])|[^,.;!?\n])`;
const NEGATED_FANOUT_RE = new RegExp(
  String.raw`\b(?:do\s+not|don't|never|without|instead\s+of|rather\s+than|except|avoid|refrain\s+from|no|not(?!\s+only\b))\b${CLAUSE_TEXT_CHARACTER}{0,120}\b(?:parallel(?:ize|ism)?|fan[- ]?out|agents?|sub[- ]?agents?|multiple\s+agents?|workers?|lanes?|workstreams?)\b`,
  'i',
);
// Stop a removed negative clause at an explicit contrast so a later affirmative
// command remains available ("do not spawn Terra agents, but spawn Grok agents").
const NEGATED_FANOUT_CLAUSE_RE = new RegExp(
  String.raw`\b(?:do\s+not|don't|never|without|instead\s+of|rather\s+than|except|avoid|refrain\s+from|no|not(?!\s+only\b))\b(?:(?!\b(?:but|however)\b)${CLAUSE_TEXT_CHARACTER}){0,120}\b(?:parallel(?:ize|ism)?|fan[- ]?out|agents?|sub[- ]?agents?|multiple\s+agents?|workers?|lanes?|workstreams?)\b(?:(?!\b(?:but|however)\b)${CLAUSE_TEXT_CHARACTER})*`,
  'gi',
);
const INFORMATIONAL_FANOUT_RE = /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i(?:'d|\s+would)\s+like\s+you\s+to)\s+)?(?:(?:explain|describe|define)\b|(?:tell\s+me|show\s+me)\s+(?:why|how|what)\b|(?:why|how|what)\b)[^.!?\n]{0,160}\b(?:parallel|fan[- ]?out|agents?|workers?|workstreams?)\b/i;
// Questions about agent execution are not authorization to execute. Keep the
// polite imperative "Can you use ..." available while rejecting first-person
// hypotheticals/advice such as "Can I use ...?" and "If I use ..., what happens?".
const INFORMATIONAL_AGENT_EXECUTION_RE = /^(?:please[, ]+)?(?:(?:can|could|should|would|may|might|do|did|have|has|had|are|is|was|were)\s+(?:i|we)\b|(?:should|may|might|do|did|does|have|has|had|are|is|was|were)\s+you\b|(?:is|would)\s+it\b|i\s+wonder\s+(?:whether|if)\b|if\s+(?:i|we)\b|(?:what|why|how|when|where)\b[^.!?\n]{0,200}\bif\s+(?:i|we)\b|(?:tell|show)\s+me\b[^.!?\n]{0,120}\b(?:whether|if)\s+(?:i|we|you|they)\b|(?:they|he|she|the\s+user)\s+(?:asked|told)\s+(?:me|us|you)\s+to\b|(?:(?:the|this|that|my|your|an?)\s+)?(?:instruction|prompt|example|text|message|request|article|document|quote|sentence)\s+(?:says?|reads?|states?|mentions?|includes?|contains?)\b)/i;
const PASTED_CONTENT_BOUNDARY_RE = /\b(?:(?:summari[sz]e|analy[sz]e|review|critique|rewrite|paraphrase|translate|transcribe|classify|explain|interpret)\b[^:;!?]{0,120}\b)?(?:(?:this|that|these|those|the|a|an)\s+)?(?:(?:following|pasted|quoted|attached|provided)\s+)?(?:quote|text|passage|excerpt|prompt|request|message|instructions?|content|transcript|example|sentence|paragraph|document|snippet|command|following)\b[^:;!?]{0,40}:/i;
const BARE_PASTED_CONTENT_BOUNDARY_RE = /\b(?:summari[sz]e|analy[sz]e|review|critique|rewrite|paraphrase|translate|transcribe|classify|explain|interpret)\b[^:;!?\n]{0,120}:/i;
const EXPLICIT_FANOUT_RE = /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to|let'?s)\s+)?(?:parallelize|fan[- ]?out)\b|^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to)\s+)?(?:research|search|analy[sz]e|compare|audit|check|review|investigate|process|handle|do|run|work\s+on)\b[^.!?\n]{0,120}\bin\s+parallel\b|\b(?:use|spawn|spin\s+up|run|hire|launch|start|create|assign)\s+(?:multiple|several|many)\s+(?:agents?|sub[- ]?agents?|workers?|lanes?|workstreams?)\b|\b(?:use|spawn|spin\s+up|run|hire|launch|start|create|assign)\s+(?:agents|sub[- ]?agents|workers|lanes|workstreams)\s+(?:to|for|on)\b/i;
const EXPLICIT_BACKGROUND_RE = /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to)\s+)?(?:run|do|handle|start|put|move)\b[^.!?\n]{0,120}\bin\s+(?:the\s+)?background\b|\b(?:spawn|spin\s+up|hire|launch|start|use|run)\s+(?:(?:a|an|one|some|\d+)\s+)?(?:background\s+)?(?:agents?|workers?)\b/i;
const DIVISIBLE_ACTION_RE = /\b(?:search|research|find|look\s+up|gather|collect|pull|survey|scan|sweep|inspect|audit|review|analy[sz]e|compare|benchmark|evaluate|verify|validate|cross[- ]check|triage|test|check|summari[sz]e|catalog|inventory|investigate|trace|profile|measure|assess|identify|discover|map|diagnose|debug|troubleshoot|classify|label|extract|score|translate|draft|generate)\b/i;
const COUNT_WORDS = Object.freeze({
  one: 1,
  both: 2,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
});
// Keep numeric counts atomic. Without the surrounding guards, "1.5 agents"
// can be misread as five agents and "-2 agents" as two.
const AGENT_COUNT_TOKEN = '(?:(?<![\\d.,+\\-])\\d+(?![\\d.,])|one|both|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const AGENT_COMMAND_PATTERN = '(?:use|spawn|spin\\s+up|run|hire|launch|start|create|assign|delegate\\s+to|i\\s+(?:want|need)|i(?:\'d|\\s+would)\\s+like|give\\s+me|have|get)';
const MALFORMED_AGENT_COUNT_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:exactly\\s+)?(?:[+\\-]\\d+|\\d+(?:[.,]\\d+)+)\\s+(?:[a-z0-9][a-z0-9._:/+@-]*\\s+)?(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
  'i',
);
const TARGET_QUALIFIED_COUNT_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:exactly\\s+)?(\\d+|zero|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|hundreds?|thousands?)\\s+[a-z0-9][a-z0-9._:/+@-]*\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
  'gi',
);
const DECLARATIVE_AGENT_EXECUTION_RE = /^(?:i|we)\s+(?:use|run|have|spawn|hire|launch|start|create|assign|get)\b[^.!?\n]{0,160}\b(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\b|^(?:my|our)\s+team\s+(?:uses?|runs?|has|spawns?|hires?|launches?|starts?|creates?|assigns?|gets?)\b[^.!?\n]{0,160}\b(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\b|^there\s+(?:are|were|is|was)\b[^.!?\n]{0,160}\b(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\b/i;
const LANE_COUNT_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:exactly\\s+)?(${AGENT_COUNT_TOKEN})\\s+(?:(?:background|child)\\s+)?(?:agents?|lanes?|workstreams?|sub[- ]?agents?|workers?)\\b|\\b(${AGENT_COUNT_TOKEN})\\s+(?:(?:background|child)\\s+)?(?:agents?|lanes?|workstreams?|sub[- ]?agents?|workers?)\\s+(?:to|for|on)\\b`,
  'gi',
);
const COUNTED_AGENT_COMMAND_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:exactly\\s+)?(?=${AGENT_COUNT_TOKEN}\\b)`,
  'gi',
);
const UNCOUNTED_AGENT_COMMAND_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:multiple|several|many|some)\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
  'gi',
);
const UNCOUNTED_TARGETED_AGENT_COMMAND_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:multiple|several|many|some|all)\\s+([a-z0-9][a-z0-9._:/+@-]*)\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
  'gi',
);
const UNCOUNTED_AGENT_FOR_TARGET_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:(?:multiple|several|many|some|all)\\s+)?(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\s+(?:for|with|using|on)\\s+([a-z0-9][a-z0-9._:/+@-]*)`,
  'gi',
);
const UNCOUNTED_NAMED_AGENTS_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+([a-z0-9][a-z0-9._:/+@-]*)\\s+(?:agents|sub[- ]?agents|workers|workstreams|lanes)\\b`,
  'gi',
);
const BARE_NAMED_AGENTS_RE = /^(?:please\s+)?([a-z0-9][a-z0-9._:/+@-]*)\s+(?:agents|sub[- ]?agents|workers|workstreams|lanes)\b(?!\s+(?:are|is|means?|refers?|were)\b)/i;
const TARGET_BEFORE_AGENT_GROUP_RE = new RegExp(
  `\\b(${AGENT_COUNT_TOKEN})\\s+([a-z0-9][a-z0-9._:/+@-]*)\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
  'gi',
);
const EFFORT_VALUE_PATTERN = '(?:(?:ultra(?:\\s+|[_-])code)|(?:extra(?:\\s+|-)high)|[a-z][a-z0-9_-]{0,31})';
const CANONICAL_BARE_EFFORT_PATTERN = '(?:auto|off|on|none|minimal|low|medium|high|xhigh|max|ultra|extra(?:\\s+|-)high)';
const EFFORT_SEPARATOR_PATTERN = '(?:\\s*:\\s*|\\s+(?:(?:at\\s+)?level(?:\\s+set\\s+to)?|at|set\\s+to)\\s+|\\s+)';
const EFFORT_EXPRESSION_PATTERN = `(?:(?:think(?:ing)?|reasoning(?:\\s+effort)?|effort)${EFFORT_SEPARATOR_PATTERN}(${EFFORT_VALUE_PATTERN})|(${EFFORT_VALUE_PATTERN})\\s+(?:reasoning(?:\\s+effort)?|effort)|at\\s+(${CANONICAL_BARE_EFFORT_PATTERN}))`;
const EFFORT_BEFORE_TARGET_GROUP_RE = new RegExp(
  `\\b(${AGENT_COUNT_TOKEN})\\s+(${EFFORT_VALUE_PATTERN})(?:-|\\s+)effort\\s+([a-z0-9][a-z0-9._:/+@-]*)\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
  'gi',
);
const AGENT_FOR_TARGET_GROUP_RE = new RegExp(
  `\\b(${AGENT_COUNT_TOKEN})\\s+(?:(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\s+)?(?:for|with|using|on)\\s+([a-z0-9][a-z0-9._:/+@-]*)`,
  'gi',
);
const QUOTED_TARGET_BEFORE_AGENT_RE = new RegExp(
  `(\\b${AGENT_COUNT_TOKEN}\\s+)["'“‘]([a-z0-9][a-z0-9._:/+@-]*)["'”’](\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b)`,
  'gi',
);
const QUOTED_TARGET_AFTER_AGENT_RE = new RegExp(
  `(\\b${AGENT_COUNT_TOKEN}\\s+(?:(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\s+)?(?:for|with|using|on)\\s+)["'“‘]([a-z0-9][a-z0-9._:/+@-]*)["'”’]`,
  'gi',
);
const DECLARED_AGENT_ALLOCATION_HEADER_RE = new RegExp(
  `^${AGENT_COMMAND_PATTERN}\\s+(?:exactly\\s+)?(${AGENT_COUNT_TOKEN})\\s+(?:(?:background|child)\\s+)?(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)(?:\\s+(?:with\\s+)?${EFFORT_EXPRESSION_PATTERN})?\\s*[:,]`,
  'i',
);
// Inside an explicit total header, allow compact list entries ("1 Luna,
// 1 Grok") without requiring the word "agent" after every target.
const DECLARED_BARE_TARGET_GROUP_RE = new RegExp(
  `(?:^|[:,;]\\s*|\\band\\s+)(${AGENT_COUNT_TOKEN})\\s+([a-z0-9][a-z0-9._:/+@-]*)(?=\\s*(?:,|;|[.!?]|$|\\band\\b|\\bto\\b|\\b(?:using\\s+)?provider\\b|\\bmodel\\b|\\bwith\\s+(?:reasoning|effort|${EFFORT_VALUE_PATTERN}\\s+effort)\\b|\\bat\\s+${CANONICAL_BARE_EFFORT_PATTERN}\\b))`,
  'gi',
);
const DECLARED_IMPLICIT_TARGET_GROUP_RE = /(?:^|[:,;]\s*|\band\s+)([a-z0-9][a-z0-9._:/+@-]*)(?:\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?))?(?=\s*(?:,|;|[.!?]|$|\band\b|\bto\b))/gi;
const CONTINUED_TARGET_GROUP_RE = new RegExp(
  `^\\s*(?:and\\s+)?(?:(${AGENT_COUNT_TOKEN})\\s+((?!(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?|for|with|using|on)\\b)[a-z0-9][a-z0-9._:/+@-]*)(?:\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?))?\\b|(${AGENT_COUNT_TOKEN})\\s+(?:(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\s+)?(?:for|with|using|on)\\s+([a-z0-9][a-z0-9._:/+@-]*))`,
  'i',
);
const ALL_ON_TARGET_RE = /\ball\s+(?:(?:requested|spawned|child)\s+)?(?:(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\s+)?(?:(?:for|with|using|on)\s+)?([a-z0-9][a-z0-9._:/+@-]*)/gi;
const SINGLE_NAMED_AGENT_RE = new RegExp(
  `\\b(?:with|using|${AGENT_COMMAND_PATTERN})\\s+(?:a|an|one)\\s+([a-z0-9][a-z0-9._:/+@-]*)\\s+(?:agent|sub[- ]?agent|worker)\\b`,
  'gi',
);
const GLOBAL_AGENT_EFFORT_RE = new RegExp(
  `\\b(?:all|both|each)(?:\\s+(?:requested|spawned|child))?(?:\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?))?\\s+(?:(?:with)\\s+)?${EFFORT_EXPRESSION_PATTERN}\\b`,
  'i',
);
const LEADING_GLOBAL_EFFORT_RE = new RegExp(
  `^(?:please\\s+)?(?:with\\s+)?${EFFORT_EXPRESSION_PATTERN}\\s*[,;:]?\\s*$`,
  'i',
);
const COMMON_MODEL_TARGETS = new Set([
  'anthropic', 'claude', 'openai', 'gpt', 'codex', 'sol', 'terra', 'luna',
  'xai', 'grok', 'qwen', 'ollama', 'llama', 'gemma', 'mistral', 'mixtral',
  'deepseek', 'gemini', 'google', 'glm', 'kimi', 'minimax', 'lmstudio',
  'lm-studio', 'openrouter', 'perplexity', 'sonar', 'groq', 'together',
  'cerebras', 'cohere', 'command', 'openai-oauth', 'xai-oauth',
]);
const TARGETED_AGENT_COMMAND_RE = new RegExp(
  `\\b${AGENT_COMMAND_PATTERN}\\s+(?:(?:a|an|some|multiple|several|many|all|${AGENT_COUNT_TOKEN})\\s+)?[a-z0-9][a-z0-9._:/+@-]*\\s+(?:agents?|sub[- ]?agents?|workers?)\\b`,
  'i',
);

const RESOURCE_WORD = '(?:sources?|sites?|vendors?|retailers?|marketplaces?|stores?|listings?|files?|documents?|modules?|components?|packages?|services?|endpoints?|apis?|repositories?|branches?|accounts?|records?|datasets?|candidates?|regions?|markets?|categories?|stories?|headlines?|products?|models?|providers?|issues?|failures?|tests?|logs?|hosts?|nodes?|servers?|databases?|tables?|collections?|workflows?|tickets?|pages?|papers?|studies?|implementations?|approaches?|solutions?|options?|alternatives?)';
const PLURAL_RESOURCE_WORD = '(?:sources|sites|vendors|retailers|marketplaces|stores|listings|files|documents|modules|components|packages|services|endpoints|apis|repositories|branches|accounts|records|datasets|candidates|regions|markets|categories|stories|headlines|products|models|providers|issues|failures|tests|logs|hosts|nodes|servers|databases|tables|collections|workflows|tickets|pages|papers|studies|implementations|approaches|solutions|options|alternatives)';
const MULTI_RESOURCE_RE = new RegExp(
  `\\b(?:multiple|several|many|various|different|all|every|each|across|major|top\\s+\\d+)\\s+(?:independent\\s+)?${RESOURCE_WORD}\\b`,
  'i',
);
const EXPLICIT_RESOURCE_COUNT_RE = new RegExp(
  `\\b(?:\\d+|dozens?|hundreds?)\\s+${RESOURCE_WORD}\\b`,
  'i',
);
const PLURAL_RESOURCE_RE = new RegExp(`\\b${PLURAL_RESOURCE_WORD}\\b`, 'i');

const COMPARISON_RE = /\b(?:compare|comparison|benchmark|rank|shortlist)\b|\b(?:find|identify|choose|select|determine|recommend)\b[^.\n]{0,80}\b(?:best|lowest|cheapest|fastest|most\s+(?:reliable|accurate|capable|affordable|efficient)|top\s+\d+)\b|\b(?:best|lowest|cheapest)\b[^.\n]{0,80}\b(?:price|deal|rate|offer|quote)\b|\b(?:prices?|deals?|rates?|offers?|quotes?)\b[^.\n]{0,80}\b(?:across|compare|best|lowest|cheapest)\b|\b(?:alternatives?|options?|candidates?)\b[^.\n]{0,60}\b(?:compare|evaluate|rank|recommend)\b/i;
const COVERAGE_RE = /\b(?:latest|current|today'?s?|recent)\b[^.\n]{0,50}\b(?:news|headlines?|developments?|updates?)\b|\b(?:news|headlines?|developments?|updates?)\b[^.\n]{0,50}\b(?:briefing|roundup|digest|coverage)\b|\b(?:briefing|roundup|digest)\b[^.\n]{0,50}\b(?:news|headlines?|developments?|updates?)\b/i;
const BROAD_REVIEW_RE = /\b(?:audit|survey|scan|sweep|inventory|map|triage|review|analy[sz]e|test)\b[^.\n]{0,100}\b(?:across|all|every|multiple|several|various|different)\b/i;

function normalizeTask(task) {
  return String(task || '').replace(/\s+/g, ' ').trim();
}

function maskIdentifierDots(text) {
  return String(text || '').replace(/(?<=[a-z0-9])\.(?=[a-z0-9])/gi, '_');
}

function listedTargetCount(text) {
  const match = text.match(/\b(?:check|review|inspect|compare|test|audit|search|query|cover|including|across|from|plus)\b([^.\n]{0,280})/i);
  if (!match) return 0;
  const tail = match[1];
  const commaParts = tail.split(/\s*,\s*/).filter(part => part.trim().length >= 2);
  const andParts = tail.split(/\s+(?:and|plus)\s+/i).filter(part => part.trim().length >= 2);
  return Math.max(commaParts.length, andParts.length);
}

function normalizeRequestedWorkstreams(value) {
  const count = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  return Number.isSafeInteger(count) && count >= 2 ? count : null;
}

function normalizePositiveAgentCount(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const count = Number(COUNT_WORDS[raw] ?? raw);
  return Number.isSafeInteger(count)
    && count >= 1
    && count <= HARD_MAX_PARALLEL_WORKSTREAMS
    ? count
    : null;
}

function executionTargetHintMatchesLabel(value, targetHints) {
  const label = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!label || !Array.isArray(targetHints)) return false;
  return targetHints.some(target => {
    const provider = String(target?.provider || '').normalize('NFKC').trim().toLowerCase();
    const model = String(target?.model || '').normalize('NFKC').trim().toLowerCase();
    if (!provider || !model) return false;
    if (label === provider || label === model || label === `${provider}/${model}`) return true;
    if ((Array.isArray(target?.aliases) ? target.aliases : []).some(alias =>
      String(alias || '').normalize('NFKC').trim().toLowerCase() === label)) return true;
    // Runtime catalogs often namespace models as vendor/family-version. A
    // natural one-token family alias may match only the first complete token of
    // the model's final path segment; never a substring or a later generic
    // qualifier such as "pro" or "instruct".
    const modelBase = model.split('/').at(-1) || '';
    const family = modelBase.split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
    return label === family;
  });
}

function looksLikeExecutionTargetLabel(value, targetHints = []) {
  const label = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!label || /\s/.test(label)) return false;
  if (COMMON_MODEL_TARGETS.has(label)) return true;
  if (executionTargetHintMatchesLabel(label, targetHints)) return true;
  if (/^\d+(?:\.\d+)+(?:[-_.](?:sol|terra|luna))$/.test(label)) return true;
  // An arbitrary configured target remains expressible without teaching this
  // parser every future vendor name: use its canonical provider/model pair.
  if (/^[a-z0-9][a-z0-9._+@-]*\/[a-z0-9][a-z0-9._:/+@-]*$/.test(label)) return true;
  // Known model families commonly carry versions/tags in one identifier.
  // Keep the family boundary controlled so "solutions" is never "Sol".
  return /^(?:claude|gpt|codex|grok|qwen|llama|gemma|mistral|mixtral|deepseek|gemini|glm|kimi|minimax|sonar|command)(?:[-_.:/]?\d|[-_.:/][a-z0-9])/i.test(label);
}

function normalizeTargetAliasesInText(value) {
  return String(value || '')
    .replace(/\b(using|with|on)\s+provider\s+([a-z0-9][a-z0-9._+@-]*)\s*,?\s*(?:and\s+)?model\s+([a-z0-9][a-z0-9._:/+@-]*)/gi, '$1 $2/$3')
    .replace(/\b(gpt)\s+(\d+(?:\.\d+)+)\s+(sol|terra|luna)\b/gi, '$1-$2-$3')
    .replace(/\b(\d+(?:\.\d+)+)\s+(sol|terra|luna)\b/gi, '$1-$2')
    .replace(/\b(claude)\s+(opus|sonnet|haiku)(?:\s+(\d+(?:\.\d+)*))?\b/gi,
      (_match, family, variant, version) => [family, variant, version].filter(Boolean).join('-'))
    .replace(/\b(grok)\s+(\d+(?:\.\d+)+)\b/gi, '$1-$2')
    .replace(/\blm\s+studio\b/gi, 'lmstudio')
    .replace(/\b(openai|xai)\s+oauth\b/gi, '$1-oauth');
}

function normalizeAttestedTargetAliasesInText(value, targetHints = []) {
  const candidates = [];
  for (const target of Array.isArray(targetHints) ? targetHints : []) {
    const provider = String(target?.provider || '').trim();
    const model = String(target?.model || '').trim();
    if (!provider || !model) continue;
    for (const rawAlias of Array.isArray(target?.aliases) ? target.aliases : []) {
      const alias = String(rawAlias || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      // One-token aliases are handled by executionTargetHintMatchesLabel.
      // This pass exists for catalog display names and multi-word aliases, and
      // deliberately accepts only a conservative identifier-like alphabet.
      if (!alias.includes(' ') || alias.length > 120
          || !/^[a-z0-9][a-z0-9._+@:/ -]*[a-z0-9]$/i.test(alias)) continue;
      candidates.push({ alias, replacement: `${provider}/${model}` });
    }
  }
  // Prefer the longest server-attested phrase so a catalog containing both
  // "Nimbus" and "Nimbus Prime" cannot partially rewrite the latter.
  candidates.sort((left, right) => right.alias.length - left.alias.length);
  let text = String(value || '');
  for (const { alias, replacement } of candidates) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(
      `(^|[^a-z0-9._+@:/-])${escaped}(?=$|[^a-z0-9._+@:/-])`,
      'gi',
    );
    text = text.replace(pattern, (_match, prefix) => `${prefix}${replacement}`);
  }
  return text;
}

function parsedTargetLabel(value) {
  // Target token patterns allow dots so canonical ids such as gpt-5.6 remain
  // atomic. When the target is sentence-final, do not mistake the terminating
  // period for part of the provider/model id ("use all agents for Grok.").
  return String(value || '').trim().replace(/[.,;!?]+$/, '');
}

function firstRealClauseTerminator(text, start, limit) {
  for (let index = start; index < limit; index++) {
    const char = text[index];
    if (char === ';' || char === '!' || char === '?' || char === '\n') return index;
    if (char !== '.') continue;
    // Dots surrounded by identifier characters belong to model ids such as
    // gpt-5.6-luna. Every other dot is a sentence boundary.
    if (/[a-z0-9]/i.test(text[index - 1] || '')
        && /[a-z0-9]/i.test(text[index + 1] || '')) continue;
    return index;
  }
  return limit;
}

function normalizeParsedReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (/^ultra(?:[ _-]+)code$/.test(effort)) return 'ultra_code';
  if (/^extra(?:[ _-]+)high$/.test(effort)) return 'xhigh';
  return effort || null;
}

function effortFromMatch(match) {
  if (!match) return null;
  return normalizeParsedReasoningEffort(
    match.slice(1).find(value => typeof value === 'string' && value.length > 0),
  );
}

function leadingReasoningEffort(text, start) {
  const prefix = String(text || '').slice(0, start);
  const boundary = Math.max(
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf('\n'),
  );
  return effortFromMatch(prefix.slice(boundary + 1).match(LEADING_GLOBAL_EFFORT_RE));
}

function hasUnsupportedTargetQualifiedCount(text) {
  TARGET_QUALIFIED_COUNT_RE.lastIndex = 0;
  for (const match of String(text || '').matchAll(TARGET_QUALIFIED_COUNT_RE)) {
    const raw = String(match[1] || '').toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(count) || count < 1 || count > HARD_MAX_PARALLEL_WORKSTREAMS) {
      return true;
    }
  }
  return false;
}

function nearbyReasoningEffort(text, end) {
  const tail = String(text || '').slice(end, end + 180);
  const adjacent = tail.match(new RegExp(
    `^\\s*(?:[,([]\\s*)?(?:with\\s+)?${EFFORT_EXPRESSION_PATTERN}\\b`,
    'i',
  ));
  if (adjacent) return effortFromMatch(adjacent);
  const qualified = tail.match(new RegExp(
    `^\\s*(?:[,([]\\s*)?(?:(?:(?:using\\s+)?(?:provider|model)\\s+[a-z0-9][a-z0-9._:/+@-]*\\s*,?\\s*){1,2}|(?:using|with|on)\\s+[a-z0-9][a-z0-9._+@-]*/[a-z0-9][a-z0-9._:/+@-]*\\s*,?\\s*)(?:with\\s+)?${EFFORT_EXPRESSION_PATTERN}\\b`,
    'i',
  ));
  if (qualified) return effortFromMatch(qualified);
  const referential = tail.match(new RegExp(
    `^\\s*(?:[,.);:]\\s*)?(?:and\\s+)?(?:i\\s+(?:want|need)\\s+)?(?:(?:have|let|make)\\s+)?(?:them|all|both|each|the\\s+(?:agents?|workers?|workstreams?|lanes?))\\s+(?:to\\s+)?(?:(?:think|reason)(?:ing)?(?:\\s+(?:at|on))?|(?:use|set)(?:\\s+(?:their|the))?\\s+(?:reasoning(?:\\s+effort)?|effort)(?:\\s+(?:to|at))?)\\s+(${EFFORT_VALUE_PATTERN})\\b`,
    'i',
  ));
  if (referential) return normalizeParsedReasoningEffort(referential[1]);
  const imperative = tail.match(new RegExp(
    `^\\s*(?:[,.);:]\\s*)?(?:and\\s+)?(?:set|use)\\s+(?:their|the\\s+(?:agents?|workers?|workstreams?|lanes?)'?s?)\\s+(?:reasoning(?:\\s+effort)?|effort)(?:\\s+(?:to|at))?\\s+(${EFFORT_VALUE_PATTERN})\\b`,
    'i',
  ));
  return normalizeParsedReasoningEffort(imperative?.[1]);
}

function declaredAgentAllocationClause(text, clauseStart, nextAnchor, targetHints) {
  const bounded = text.slice(clauseStart, nextAnchor);
  const header = bounded.match(DECLARED_AGENT_ALLOCATION_HEADER_RE);
  const declaredCount = normalizePositiveAgentCount(header?.[1]);
  let end = firstRealClauseTerminator(text, clauseStart, nextAnchor);
  if (declaredCount === null) return { end, declaredCount: null };

  // A semicolon normally starts an independent outcome. It remains part of a
  // declared allocation list only when the next clause is syntactically
  // another counted, known model group ("; and 1 Grok agent ...").
  while (text[end] === ';') {
    const continuation = text.slice(end + 1, nextAnchor).match(CONTINUED_TARGET_GROUP_RE);
    const label = String(continuation?.[2] ?? continuation?.[4] ?? '')
      .replace(/[.,;!?]+$/, '');
    if (!continuation || !looksLikeExecutionTargetLabel(label, targetHints)) break;
    end = firstRealClauseTerminator(text, end + 1, nextAnchor);
  }
  return { end, declaredCount };
}

function explicitRequestText(text) {
  let withoutQuotes = String(text || '')
    // Quoting just the target name is common emphasis, not pasted content.
    // Unwrap it only inside an already explicit counted-agent shape before
    // stripping every other quoted span.
    .replace(QUOTED_TARGET_BEFORE_AGENT_RE, '$1$2$3')
    .replace(QUOTED_TARGET_AFTER_AGENT_RE, '$1$2')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    .replace(/(^|[\s([{:=])'[^'\n]*'/g, '$1 ')
    .replace(/‘[^’\n]*’/g, ' ');
  const pastedContentBoundary = [
    withoutQuotes.match(PASTED_CONTENT_BOUNDARY_RE),
    withoutQuotes.match(BARE_PASTED_CONTENT_BOUNDARY_RE),
  ].filter(match => match?.index !== undefined)
    .sort((left, right) => left.index - right.index)[0];
  if (pastedContentBoundary?.index !== undefined) {
    const colonOffset = pastedContentBoundary[0].lastIndexOf(':');
    withoutQuotes = withoutQuotes.slice(
      0,
      pastedContentBoundary.index + Math.max(colonOffset, 0),
    );
  }
  const withoutNegatedClauses = withoutQuotes.replace(NEGATED_FANOUT_CLAUSE_RE, ' ');
  if (MALFORMED_AGENT_COUNT_RE.test(withoutNegatedClauses)
      || hasUnsupportedTargetQualifiedCount(withoutNegatedClauses)) return '';
  const safetyText = maskIdentifierDots(withoutNegatedClauses.trim());
  if (INFORMATIONAL_FANOUT_RE.test(safetyText)
      || INFORMATIONAL_AGENT_EXECUTION_RE.test(safetyText)
      || DECLARATIVE_AGENT_EXECUTION_RE.test(safetyText)) return '';
  return withoutNegatedClauses.replace(/\s+/g, ' ').trim();
}

/**
 * Return every exact agent/workstream count explicitly requested in trusted
 * user text. Repeated counts are retained because they may size distinct
 * outcomes in the same prompt.
 */
export function explicitParallelLaneCounts(task) {
  return explicitParallelLaneRequests(task).map(request => request.count);
}

function detailedParallelLaneRequests(task) {
  const text = explicitRequestText(task);
  const matches = [...text.matchAll(LANE_COUNT_RE)];
  const requests = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const raw = String(match[1] ?? match[2] ?? '').toLowerCase();
    const count = normalizeRequestedWorkstreams(COUNT_WORDS[raw] ?? raw);
    if (count === null) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const localClause = text.slice(start, end).split(/[.;!?]/, 1)[0];
    requests.push({
      count,
      context: localClause.trim().slice(0, 240),
      start,
      end: start + localClause.length,
    });
  }
  return requests;
}

export function explicitParallelLaneRequests(task) {
  return detailedParallelLaneRequests(task).map(({ count, context }) => ({ count, context }));
}

function targetedAgentExecutionRequests(task, targetHints = []) {
  const text = normalizeAttestedTargetAliasesInText(
    normalizeTargetAliasesInText(explicitRequestText(task)),
    targetHints,
  );
  if (!text) return { requests: [], blockedGenericRanges: [] };
  const anchors = [...text.matchAll(COUNTED_AGENT_COMMAND_RE)];
  const requests = [];
  const blockedGenericRanges = [];

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
    const anchor = anchors[anchorIndex];
    const clauseStart = anchor.index ?? 0;
    const nextAnchor = anchors[anchorIndex + 1]?.index ?? text.length;
    const declaredAllocation = declaredAgentAllocationClause(
      text,
      clauseStart,
      nextAnchor,
      targetHints,
    );
    const clauseEnd = declaredAllocation.end;
    const clause = text.slice(clauseStart, clauseEnd);
    const groups = [];
    const seen = new Set();

    const collectGroup = (regex, {
      countIndex = 1,
      labelIndex = 2,
      effortIndex = null,
      fixedCount = null,
    } = {}) => {
      regex.lastIndex = 0;
      for (const match of clause.matchAll(regex)) {
        const count = fixedCount ?? normalizePositiveAgentCount(match[countIndex]);
        const label = parsedTargetLabel(match[labelIndex]);
        if (count === null || !looksLikeExecutionTargetLabel(label, targetHints)) continue;
        const start = clauseStart + (match.index ?? 0);
        const end = start + match[0].length;
        const key = `${start}:${end}:${label.toLowerCase()}:${count}`;
        if (seen.has(key)) continue;
        seen.add(key);
        groups.push({
          label,
          count,
          mode: 'exact-count',
          start,
          end,
          reasoningEffort: effortIndex === null
            ? nearbyReasoningEffort(text, end)
            : normalizeParsedReasoningEffort(match[effortIndex]),
        });
      }
    };
    collectGroup(TARGET_BEFORE_AGENT_GROUP_RE);
    collectGroup(AGENT_FOR_TARGET_GROUP_RE);
    collectGroup(EFFORT_BEFORE_TARGET_GROUP_RE, {
      labelIndex: 3,
      effortIndex: 2,
    });
    if (declaredAllocation.declaredCount !== null) {
      collectGroup(DECLARED_BARE_TARGET_GROUP_RE);
      collectGroup(DECLARED_IMPLICIT_TARGET_GROUP_RE, {
        labelIndex: 1,
        fixedCount: 1,
      });
    }

    // "Use 5 agents ..., all with Luna" is one homogeneous target rather
    // than a second allocation group.
    if (!groups.length) {
      ALL_ON_TARGET_RE.lastIndex = 0;
      const allMatch = [...clause.matchAll(ALL_ON_TARGET_RE)]
        .find(match => looksLikeExecutionTargetLabel(match[1], targetHints));
      if (allMatch) {
        const leading = clause.match(new RegExp(
          `^(?:\\S+\\s+){0,3}(?:exactly\\s+)?(${AGENT_COUNT_TOKEN})\\s+(?:agents?|sub[- ]?agents?|workers?|workstreams?|lanes?)\\b`,
          'i',
        ));
        const count = normalizePositiveAgentCount(leading?.[1]);
        if (count !== null) {
          const targetEnd = clauseStart + (allMatch.index ?? 0) + allMatch[0].length;
          groups.push({
            label: String(allMatch[1]),
            count: null,
            mode: 'all',
            start: clauseStart,
            end: targetEnd,
            reasoningEffort: nearbyReasoningEffort(text, targetEnd),
          });
        }
      }
    }

    if (!groups.length) continue;
    const globalEffort = effortFromMatch(clause.match(GLOBAL_AGENT_EFFORT_RE))
      ?? leadingReasoningEffort(text, clauseStart);
    if (globalEffort) {
      for (const group of groups) {
        if (!group.reasoningEffort) group.reasoningEffort = globalEffort;
      }
    }
    groups.sort((left, right) => left.start - right.start);
    const exactGroups = groups.filter(group => group.mode === 'exact-count');
    const exactGroupCount = exactGroups.length
      ? exactGroups.reduce((sum, group) => sum + group.count, 0)
      : null;
    if (declaredAllocation.declaredCount !== null
        && exactGroups.length > 0
        && exactGroupCount !== declaredAllocation.declaredCount) {
      // A malformed model-allocation list must not silently degrade to the
      // generic total from its header, which would discard the user's targets.
      blockedGenericRanges.push({ start: clauseStart, end: clauseEnd });
      continue;
    }
    const count = exactGroupCount
      ?? normalizePositiveAgentCount(
        clause.match(new RegExp(`(${AGENT_COUNT_TOKEN})`, 'i'))?.[1],
      );
    if (count === null || count > HARD_MAX_PARALLEL_WORKSTREAMS) continue;
    const firstCountOffset = clause.search(new RegExp(`\\b${AGENT_COUNT_TOKEN}\\b`, 'i'));
    const firstGroupStart = Math.min(...groups.map(group => group.start));
    const start = declaredAllocation.declaredCount !== null
      ? clauseStart
      : firstCountOffset >= 0
      && firstGroupStart === clauseStart + firstCountOffset
        ? clauseStart
        : firstGroupStart;
    const end = Math.max(...groups.map(group => group.end));
    const context = clause.trim().slice(0, 240);
    requests.push({
      id: `targeted:${start}:${end}:${count}:${context}`,
      kind: 'targeted',
      count,
      context,
      start,
      end,
      targets: groups.map(({ label, count: groupCount, mode, reasoningEffort }) => ({
        label,
        count: groupCount,
        mode,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })),
    });
  }

  UNCOUNTED_AGENT_COMMAND_RE.lastIndex = 0;
  for (const anchor of text.matchAll(UNCOUNTED_AGENT_COMMAND_RE)) {
    const clauseStart = anchor.index ?? 0;
    const clauseEnd = firstRealClauseTerminator(text, clauseStart, text.length);
    const clause = text.slice(clauseStart, clauseEnd);
    ALL_ON_TARGET_RE.lastIndex = 0;
    const match = [...clause.matchAll(ALL_ON_TARGET_RE)]
      .find(candidate => looksLikeExecutionTargetLabel(candidate[1], targetHints));
    if (!match) continue;
    const end = clauseStart + (match.index ?? 0) + match[0].length;
    const context = clause.trim().slice(0, 240);
    requests.push({
      id: `targeted:${clauseStart}:${end}:adaptive:${context}`,
      kind: 'targeted',
      count: null,
      context,
      start: clauseStart,
      end,
      targets: [{
        label: String(match[1]),
        count: null,
        mode: 'all',
        ...(nearbyReasoningEffort(text, end)
          ? { reasoningEffort: nearbyReasoningEffort(text, end) }
          : {}),
      }],
    });
  }

  // "Use multiple Qwen agents" carries both adaptive fan-out permission and
  // a homogeneous target. It is distinct from "use multiple agents ... all on
  // Qwen", which is handled above.
  UNCOUNTED_TARGETED_AGENT_COMMAND_RE.lastIndex = 0;
  for (const match of text.matchAll(UNCOUNTED_TARGETED_AGENT_COMMAND_RE)) {
    const label = parsedTargetLabel(match[1]);
    if (!looksLikeExecutionTargetLabel(label, targetHints)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (requests.some(request => start >= request.start && start < request.end)) continue;
    const contextEnd = firstRealClauseTerminator(text, end, text.length);
    const context = text.slice(start, contextEnd).trim().slice(0, 240);
    const effort = nearbyReasoningEffort(text, end);
    requests.push({
      id: `targeted:${start}:${end}:adaptive:${context}`,
      kind: 'targeted',
      count: null,
      context,
      start,
      end,
      targets: [{
        label,
        count: null,
        mode: 'all',
        ...(effort ? { reasoningEffort: effort } : {}),
      }],
    });
  }

  // "Use agents for Grok" is the target-after-agent counterpart of "Use
  // Grok agents". With no count, it grants adaptive rather than exact fan-out.
  UNCOUNTED_AGENT_FOR_TARGET_RE.lastIndex = 0;
  for (const match of text.matchAll(UNCOUNTED_AGENT_FOR_TARGET_RE)) {
    const label = parsedTargetLabel(match[1]);
    if (!looksLikeExecutionTargetLabel(label, targetHints)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (requests.some(request => start >= request.start && start < request.end)) continue;
    const contextEnd = firstRealClauseTerminator(text, end, text.length);
    const context = text.slice(start, contextEnd).trim().slice(0, 240);
    const effort = nearbyReasoningEffort(text, end)
      ?? leadingReasoningEffort(text, start);
    requests.push({
      id: `targeted:${start}:${end}:adaptive:${context}`,
      kind: 'targeted',
      count: null,
      context,
      start,
      end,
      targets: [{
        label,
        count: null,
        mode: 'all',
        ...(effort ? { reasoningEffort: effort } : {}),
      }],
    });
  }

  UNCOUNTED_NAMED_AGENTS_RE.lastIndex = 0;
  for (const match of text.matchAll(UNCOUNTED_NAMED_AGENTS_RE)) {
    const label = parsedTargetLabel(match[1]);
    if (!looksLikeExecutionTargetLabel(label, targetHints)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (requests.some(request => start >= request.start && start < request.end)) continue;
    const contextEnd = firstRealClauseTerminator(text, end, text.length);
    const context = text.slice(start, contextEnd).trim().slice(0, 240);
    const effort = nearbyReasoningEffort(text, end);
    requests.push({
      id: `targeted:${start}:${end}:adaptive:${context}`,
      kind: 'targeted',
      count: null,
      context,
      start,
      end,
      targets: [{
        label,
        count: null,
        mode: 'all',
        ...(effort ? { reasoningEffort: effort } : {}),
      }],
    });
  }

  const bareMatch = text.match(BARE_NAMED_AGENTS_RE);
  if (bareMatch && looksLikeExecutionTargetLabel(bareMatch[1], targetHints)) {
    const start = bareMatch.index ?? 0;
    const end = start + bareMatch[0].length;
    if (!requests.some(request => start >= request.start && start < request.end)) {
      const contextEnd = firstRealClauseTerminator(text, end, text.length);
      const context = text.slice(start, contextEnd).trim().slice(0, 240);
      const effort = nearbyReasoningEffort(text, end);
      requests.push({
        id: `targeted:${start}:${end}:adaptive:${context}`,
        kind: 'targeted',
        count: null,
        context,
        start,
        end,
        targets: [{
          label: String(bareMatch[1]),
          count: null,
          mode: 'all',
          ...(effort ? { reasoningEffort: effort } : {}),
        }],
      });
    }
  }

  SINGLE_NAMED_AGENT_RE.lastIndex = 0;
  for (const match of text.matchAll(SINGLE_NAMED_AGENT_RE)) {
    const label = parsedTargetLabel(match[1]);
    if (!looksLikeExecutionTargetLabel(label, targetHints)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (requests.some(request => start >= request.start && start < request.end)) continue;
    const contextStart = Math.max(0, text.lastIndexOf('.', start - 1) + 1);
    const contextEnd = firstRealClauseTerminator(text, end, text.length);
    const context = text.slice(contextStart, contextEnd).trim().slice(0, 240);
    requests.push({
      id: `targeted:${start}:${end}:1:${context}`,
      kind: 'targeted',
      count: 1,
      context,
      start,
      end,
      targets: [{
        label,
        count: 1,
        mode: 'exact-count',
        ...(nearbyReasoningEffort(text, end)
          ? { reasoningEffort: nearbyReasoningEffort(text, end) }
          : {}),
      }],
    });
  }
  return { requests, blockedGenericRanges };
}

/**
 * Return independently reservable agent outcomes from trusted user text.
 * Model-qualified groups form one summed outcome; unrelated generic counts
 * remain separate outcomes and therefore retain their own launch budget.
 */
export function explicitAgentExecutionRequests(task, targetHints = []) {
  const {
    requests: targeted,
    blockedGenericRanges,
  } = targetedAgentExecutionRequests(task, targetHints);
  const generic = detailedParallelLaneRequests(task)
    .filter(request => !targeted.some(target =>
      request.start >= target.start && request.start < target.end)
      && !blockedGenericRanges.some(range =>
        request.start >= range.start && request.start < range.end))
    .map(request => ({
      ...request,
      id: `generic:${request.start}:${request.end}:${request.count}:${request.context}`,
      kind: 'generic',
      targets: [],
    }));
  return [...generic, ...targeted]
    .sort((left, right) => left.start - right.start);
}

/**
 * Aggregate model-qualified agent groups in trusted user text. This covers
 * forms the generic lane parser intentionally cannot, including "1 Qwen
 * agent and 1 Grok agent" and the shorthand "1 agent for Qwen, 1 for Grok".
 * The caller still validates the structured provider/model allocation.
 */
export function explicitTargetedAgentCount(task, targetHints = []) {
  const requests = explicitAgentExecutionRequests(task, targetHints);
  return requests.length === 1 && requests[0].kind === 'targeted'
    ? requests[0].count
    : null;
}

export function explicitlyRequestsAgentExecution(task, targetHints = []) {
  const text = explicitRequestText(task);
  if (!text) return false;
  const executionRequests = explicitAgentExecutionRequests(text, targetHints);
  const malformedDeclaredAllocation = targetedAgentExecutionRequests(text, targetHints)
    .blockedGenericRanges.length > 0;
  return executionRequests.length > 0
    || (!malformedDeclaredAllocation
      && (BARE_NAMED_AGENTS_RE.test(text)
        || TARGETED_AGENT_COMMAND_RE.test(text)
        || EXPLICIT_FANOUT_RE.test(text)
        || EXPLICIT_BACKGROUND_RE.test(text)));
}

/**
 * Classify a task without looking at its domain or available tool names.
 * @param {string} task
 * @param {{requestedWorkstreams?: number|string, explicitParallelism?: boolean, allowTextRequest?: boolean, executionTargets?: object[]}} [options]
 */
export function classifyClearlySplittableWork(task, {
  requestedWorkstreams,
  explicitParallelism = false,
  allowTextRequest = true,
  executionTargets = [],
} = /** @type {{requestedWorkstreams?: number|string, explicitParallelism?: boolean, allowTextRequest?: boolean, executionTargets?: object[]}} */ ({})) {
  const text = normalizeTask(task);
  const explicitText = allowTextRequest ? explicitRequestText(task) : '';
  const textCounts = allowTextRequest ? explicitParallelLaneCounts(text) : [];
  const targetedAgentCount = allowTextRequest
    ? explicitTargetedAgentCount(text, executionTargets)
    : null;
  const uncountedTargetFanout = allowTextRequest
    && explicitAgentExecutionRequests(text, executionTargets)
      .some(request => request.kind === 'targeted' && request.count === null);
  const textOptsOut = allowTextRequest
    && (SINGLE_AGENT_RE.test(text) || (NEGATED_FANOUT_RE.test(text) && !explicitText));
  const structuredLaneCount = normalizeRequestedWorkstreams(requestedWorkstreams);
  const textLaneCount = !textOptsOut
    ? ((targetedAgentCount >= 2 ? targetedAgentCount : null) ?? textCounts[0] ?? null)
    : null;
  const requestedLanes = structuredLaneCount ?? textLaneCount;
  const laneCountSource = structuredLaneCount !== null
    ? 'structured'
    : (textLaneCount !== null ? 'route-text' : 'adaptive');
  const requestExceedsLimit = requestedLanes !== null
    && requestedLanes > MAX_PARALLEL_WORKSTREAMS;
  const explicitEffectiveLanes = requestedLanes === null
    ? null
    : Math.min(requestedLanes, MAX_PARALLEL_WORKSTREAMS);
  const reasons = [];
  // A structured count was deliberately carried by the parent coordinator
  // after interpreting the user's request. Incidental prose in the detached
  // task (for example, "do not mention workers in the report") must not erase
  // that authoritative scheduling decision.
  if (requestedLanes === null
      && explicitParallelism !== true
      && (!text || textOptsOut)) {
    return {
      required: false,
      suggestedLanes: 1,
      effectiveLanes: 1,
      requestedLanes,
      maxLanes: MAX_PARALLEL_WORKSTREAMS,
      requestExceedsLimit,
      laneCountSource,
      reasons,
      family: 'single',
    };
  }

  const explicitFanout = requestedLanes !== null
    || explicitParallelism === true
    || uncountedTargetFanout
    || (allowTextRequest && EXPLICIT_FANOUT_RE.test(explicitText));
  const action = DIVISIBLE_ACTION_RE.test(text);
  const comparison = COMPARISON_RE.test(text);
  const coverage = COVERAGE_RE.test(text);
  const multiResource = MULTI_RESOURCE_RE.test(text);
  const countedResources = EXPLICIT_RESOURCE_COUNT_RE.test(text);
  const broadReview = BROAD_REVIEW_RE.test(text);
  const targetCount = listedTargetCount(text);
  const listedTargets = action && targetCount >= 3;
  const pluralCoverage = action
    && PLURAL_RESOURCE_RE.test(text)
    && /\b(?:across|from|cover|search|scan|survey|audit|compare|review|inspect|check)\b/i.test(text);
  if (explicitFanout) reasons.push('explicit-parallelism');
  if (comparison) reasons.push('comparison-or-selection');
  if (coverage) reasons.push('broad-current-coverage');
  if (multiResource || countedResources || pluralCoverage) reasons.push('multiple-resources');
  if (broadReview) reasons.push('broad-review');
  if (listedTargets) reasons.push('explicit-target-list');

  // Divisibility informs sizing after an explicit request; it never opts the
  // user into extra model executions. This boundary is intentionally
  // independent of task domain, tool names, and provider behavior.
  const required = explicitFanout;

  let suggestedLanes = 1;
  if (required) {
    const adaptiveSuggestion = (targetCount >= 4 ? 4 : targetCount >= 3 ? 3 : null)
      || (multiResource && /\b(?:all|every|many|across)\b/i.test(text) ? 4 : null)
      || (comparison || coverage ? 3 : 2);
    suggestedLanes = explicitEffectiveLanes
      || Math.min(adaptiveSuggestion, MAX_ADAPTIVE_PARALLEL_WORKSTREAMS);
  }

  return {
    required,
    suggestedLanes,
    effectiveLanes: suggestedLanes,
    requestedLanes,
    maxLanes: MAX_PARALLEL_WORKSTREAMS,
    requestExceedsLimit,
    laneCountSource,
    reasons: required ? reasons : [],
    family: required
      ? (comparison ? 'comparison' : coverage ? 'coverage' : 'multi-resource')
      : 'single',
  };
}

export function describeParallelWorkLaneRequirement(assessment = null) {
  const explicit = ['structured', 'route-text'].includes(assessment?.laneCountSource)
    ? normalizeRequestedWorkstreams(assessment?.effectiveLanes)
    : null;
  if (explicit !== null) return `exactly ${explicit}`;
  const configuredMax = normalizeRequestedWorkstreams(assessment?.maxLanes)
    ?? MAX_PARALLEL_WORKSTREAMS;
  const adaptiveMax = Math.min(4, configuredMax);
  return adaptiveMax === 2 ? 'exactly 2' : `2–${adaptiveMax}`;
}

export function isRootDetachedWorker(agent, taskContext) {
  if (agent?.ephemeral !== true || !ROOT_WORKER_ID_RE.test(String(agent?.id || ''))) return false;
  if (!taskContext?.taskId || taskContext.parentTaskId) return false;
  return taskContext.rootTaskId === taskContext.taskId;
}

export function installParallelWorkGate({
  agent,
  routeText,
  taskContext,
  recoverableTools = [],
}) {
  if (!agent || !Array.isArray(agent.tools)) {
    return { required: false, locked: false, note: '', assessment: null };
  }
  const eligibleRoot = isRootDetachedWorker(agent, taskContext);
  if (!eligibleRoot && agent._parallelWorkGate?.state) {
    // Defensive against shallow-cloned internal state. Assign a fresh value on
    // the non-root object; never mutate the root's shared gate record.
    agent._parallelWorkGate = null;
  }
  if (agent._parallelWorkGate?.state && eligibleRoot) {
    return {
      required: agent._parallelWorkGate.required === true,
      locked: agent._parallelWorkGate.state === 'locked',
      note: agent._parallelWorkGate.note || '',
      assessment: agent._parallelWorkGate.assessment || null,
    };
  }

  const assessment = classifyClearlySplittableWork(routeText, {
    requestedWorkstreams: agent.requestedWorkstreams,
    explicitParallelism: agent.parallelWorkRequested === true,
    allowTextRequest: agent.ephemeral !== true,
    executionTargets: agent.executionTargetAllocation?.entries || [],
  });
  if (!assessment.required || !eligibleRoot) {
    return { required: false, locked: false, note: '', assessment };
  }
  const parallelTool = agent.tools.find(tool => tool?.function?.name === 'parallel_work')
    || (Array.isArray(recoverableTools)
      ? recoverableTools.find(tool => tool?.function?.name === 'parallel_work')
      : null);
  const routedTools = [...agent.tools];
  if (!parallelTool) {
    const note = [
      '## Mandatory parallel-work preflight unavailable',
      `This detached outcome requires ${describeParallelWorkLaneRequirement(assessment)} child workstreams, but the parallel_work capability is unavailable.`,
      'Do not claim the task is complete. Report this capability failure.',
    ].join('\n');
    agent._parallelWorkGate = {
      required: true,
      state: 'locked',
      routedTools,
      assessment,
      note,
      unavailable: true,
      installedAt: Date.now(),
    };
    agent.tools = [];
    return { required: true, locked: true, unavailable: true, note, assessment };
  }

  const laneWord = assessment.suggestedLanes === 1 ? 'lane' : 'lanes';
  const adaptiveRequirement = describeParallelWorkLaneRequirement(assessment);
  const laneInstruction = assessment.requestedLanes !== null
    ? (assessment.requestExceedsLimit
      ? [
          `The request specifies ${assessment.requestedLanes} child workers, which exceeds the current per-outcome safety limit of ${assessment.maxLanes}.`,
          `Your first substantive action MUST be a \`parallel_work\` call with exactly ${assessment.suggestedLanes} explicit, non-overlapping work items. State clearly in the final answer that the requested count was limited to ${assessment.suggestedLanes}; do not silently reduce it.`,
        ]
      : [
          `The request specifies exactly ${assessment.requestedLanes} child workers; the coordinator does not count toward that total.`,
          `Your first substantive action MUST be a \`parallel_work\` call with exactly ${assessment.suggestedLanes} explicit, non-overlapping work items. Do not reduce or expand that count.`,
        ])
    : [
        `Your first substantive action MUST be a \`parallel_work\` call with ${adaptiveRequirement} explicit, non-overlapping work items. Do not answer from memory and do not attempt a domain tool first.`,
        adaptiveRequirement.startsWith('exactly ')
          ? `Use ${adaptiveRequirement}; the configured per-outcome ceiling does not permit a larger adaptive team.`
          : `Use the fewest useful lanes; ${assessment.suggestedLanes} ${laneWord} is the current recommendation, but adjust within ${adaptiveRequirement} when the actual scope warrants it.`,
      ];
  const executionAllocation = agent.executionTargetAllocation;
  const targetEntries = Array.isArray(executionAllocation?.entries)
    ? executionAllocation.entries
    : [];
  const describeTarget = entry => {
    const pair = `${JSON.stringify(entry.provider)}/${JSON.stringify(entry.model)}`;
    return Object.hasOwn(entry, 'reasoningEffort')
      ? `${pair} (reasoning effort ${JSON.stringify(entry.reasoningEffort)})`
      : `${pair} (reasoning effort omitted)`;
  };
  const executionInstructions = targetEntries.length
    ? (executionAllocation.mode === 'homogeneous'
      ? [
          `Every child will run on the configured execution target ${describeTarget(targetEntries[0])}; omit work_items[].execution and let the server apply this homogeneous target.`,
          Object.hasOwn(targetEntries[0], 'reasoningEffort')
            ? `If you include execution anyway, repeat the exact pair and reasoning_effort ${JSON.stringify(targetEntries[0].reasoningEffort)}.`
            : 'If you include execution anyway, repeat the exact pair but omit reasoning_effort; auto is not a placeholder for an omitted effort.',
        ]
      : [
          `The exact child execution allocation is ${targetEntries.map(entry => `${entry.count ?? 1} × ${describeTarget(entry)}`).join(', ')}.`,
          'Every work item MUST include execution.provider and execution.model, and the complete work_items array must match that provider/model multiset exactly. Lane order may differ; counts may not.',
          'Include reasoning_effort only for an allocation entry that explicitly carries one. When its effort is omitted, omit reasoning_effort too; auto is not a placeholder.',
        ])
    : [];
  const note = [
    '## Mandatory parallel-work preflight',
    'The user explicitly requested parallel agents for this detached outcome.',
    ...laneInstruction,
    ...executionInstructions,
    'You are the coordinator: assign every lane centrally and give each one a distinct stable claim. Children do not negotiate assignments with each other.',
    'After the lane reports return, resolve conflicts, synthesize one answer, and perform any dependent or mutating steps yourself in serial order.',
  ].join('\n');
  const state = {
    required: true,
    state: 'locked',
    routedTools,
    assessment,
    note,
    installedAt: Date.now(),
  };
  agent._parallelWorkGate = state;
  agent.tools = [parallelTool];
  return { required: true, locked: true, note, assessment };
}

export function isParallelWorkGateLocked(agent) {
  return agent?._parallelWorkGate?.required === true
    && agent._parallelWorkGate.state === 'locked';
}

export function unlockParallelWorkGate(agent, outcome = 'completed') {
  const gate = agent?._parallelWorkGate;
  if (!gate || gate.required !== true || gate.state !== 'locked') return false;
  agent.tools = Array.isArray(gate.routedTools) ? [...gate.routedTools] : [];
  gate.state = 'satisfied';
  gate.outcome = outcome;
  gate.completedAt = Date.now();
  return true;
}
