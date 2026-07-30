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
const NEGATED_FANOUT_RE = /\b(?:do\s+not|don't|never|without)\b[^,.;!?\n]{0,120}\b(?:parallel(?:ize|ism)?|fan[- ]?out|agents?|sub[- ]?agents?|multiple\s+agents?|workers?|lanes?|workstreams?)\b/i;
const NEGATED_FANOUT_CLAUSE_RE = /\b(?:do\s+not|don't|never|without)\b[^,.;!?\n]{0,120}\b(?:parallel(?:ize|ism)?|fan[- ]?out|agents?|sub[- ]?agents?|multiple\s+agents?|workers?|lanes?|workstreams?)\b[^,.;!?\n]*/gi;
const INFORMATIONAL_FANOUT_RE = /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i(?:'d|\s+would)\s+like\s+you\s+to)\s+)?(?:(?:explain|describe|define)\b|(?:tell\s+me|show\s+me)\s+(?:why|how|what)\b|(?:why|how|what)\b)[^.!?\n]{0,160}\b(?:parallel|fan[- ]?out|agents?|workers?|workstreams?)\b/i;
const PASTED_CONTENT_BOUNDARY_RE = /\b(?:(?:summari[sz]e|analy[sz]e|review|critique|rewrite|paraphrase|translate|transcribe|classify|explain|interpret)\b[^:;!?]{0,120}\b)?(?:(?:this|that|these|those|the|a|an)\s+)?(?:(?:following|pasted|quoted|attached|provided)\s+)?(?:quote|text|passage|excerpt|prompt|request|message|instructions?|content|transcript|example|sentence|paragraph|document|snippet|command|following)\b[^:;!?]{0,40}:/i;
const BARE_PASTED_CONTENT_BOUNDARY_RE = /\b(?:summari[sz]e|analy[sz]e|review|critique|rewrite|paraphrase|translate|transcribe|classify|explain|interpret)\b[^:;!?\n]{0,120}:/i;
const EXPLICIT_FANOUT_RE = /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to|let'?s)\s+)?(?:parallelize|fan[- ]?out)\b|^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to)\s+)?(?:research|search|analy[sz]e|compare|audit|check|review|investigate|process|handle|do|run|work\s+on)\b[^.!?\n]{0,120}\bin\s+parallel\b|\b(?:use|spawn|hire|launch|start|create|assign)\s+(?:multiple|several|many)\s+(?:agents?|sub[- ]?agents?|workers?|lanes?|workstreams?)\b|\b(?:use|spawn|hire|launch|start|create|assign)\s+(?:agents|sub[- ]?agents|workers|lanes|workstreams)\s+(?:to|for|on)\b/i;
const EXPLICIT_BACKGROUND_RE = /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to)\s+)?(?:run|do|handle|start|put|move)\b[^.!?\n]{0,120}\bin\s+(?:the\s+)?background\b|\b(?:spawn|hire|launch|start|use)\s+(?:(?:a|an|one|some|\d+)\s+)?(?:background\s+)?(?:agents?|workers?)\b/i;
const DIVISIBLE_ACTION_RE = /\b(?:search|research|find|look\s+up|gather|collect|pull|survey|scan|sweep|inspect|audit|review|analy[sz]e|compare|benchmark|evaluate|verify|validate|cross[- ]check|triage|test|check|summari[sz]e|catalog|inventory|investigate|trace|profile|measure|assess|identify|discover|map|diagnose|debug|troubleshoot|classify|label|extract|score|translate|draft|generate)\b/i;
const LANE_COUNT_RE = /\b(?:use|spawn|hire|launch|start|run|create|assign|delegate\s+to)\s+(?:exactly\s+)?(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:agents?|lanes?|workstreams?|sub[- ]?agents?|workers?)\b|\b(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:agents?|lanes?|workstreams?|sub[- ]?agents?|workers?)\s+(?:to|for|on)\b/gi;
const COUNT_WORDS = Object.freeze({
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

function explicitRequestText(text) {
  let withoutQuotes = String(text || '')
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
  if (INFORMATIONAL_FANOUT_RE.test(withoutNegatedClauses.trim())) return '';
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

export function explicitParallelLaneRequests(task) {
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
    });
  }
  return requests;
}

export function explicitlyRequestsAgentExecution(task) {
  const text = explicitRequestText(task);
  if (!text) return false;
  return explicitParallelLaneCounts(text).length > 0
    || EXPLICIT_FANOUT_RE.test(text)
    || EXPLICIT_BACKGROUND_RE.test(text);
}

/**
 * Classify a task without looking at its domain or available tool names.
 * @param {string} task
 * @param {{requestedWorkstreams?: number|string, explicitParallelism?: boolean, allowTextRequest?: boolean}} [options]
 */
export function classifyClearlySplittableWork(task, {
  requestedWorkstreams,
  explicitParallelism = false,
  allowTextRequest = true,
} = /** @type {{requestedWorkstreams?: number|string, explicitParallelism?: boolean, allowTextRequest?: boolean}} */ ({})) {
  const text = normalizeTask(task);
  const explicitText = allowTextRequest ? explicitRequestText(task) : '';
  const textCounts = allowTextRequest ? explicitParallelLaneCounts(text) : [];
  const textOptsOut = allowTextRequest
    && (SINGLE_AGENT_RE.test(text) || (NEGATED_FANOUT_RE.test(text) && !explicitText));
  const structuredLaneCount = normalizeRequestedWorkstreams(requestedWorkstreams);
  const textLaneCount = !textOptsOut ? (textCounts[0] ?? null) : null;
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
  const note = [
    '## Mandatory parallel-work preflight',
    'The user explicitly requested parallel agents for this detached outcome.',
    ...laneInstruction,
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
