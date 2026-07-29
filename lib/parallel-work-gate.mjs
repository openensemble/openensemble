/**
 * Mandatory fan-out preflight for detached coordinator workers.
 *
 * This is intentionally conservative. A false negative merely leaves the
 * worker free to use parallel_work voluntarily; a false positive spends extra
 * model calls. Only task shapes with clear independent coverage are gated.
 */

const ROOT_WORKER_ID_RE = /^ephemeral_worker_[^_]+_[^_]+_.+$/;

const NO_FANOUT_RE = /\b(?:do\s+not|don't|without)\s+(?:use\s+)?(?:parallel(?:ize|ism)?|fan[- ]?out|subagents?|multiple\s+agents?|workers?|workstreams?)\b|\bsingle[- ](?:threaded|agent)\b/i;
const EXPLICIT_FANOUT_RE = /\b(?:parallel(?:ize|ism)?|fan[- ]?out|multiple\s+agents?|subagents?|independent\s+(?:lanes?|workstreams?)|workstreams?)\b/i;
const SINGLE_SCOPE_RE = /\b(?:exactly\s+one|only\s+one|a\s+single)\s+(?:source|site|file|document|module|component|service|endpoint|api|account|record|dataset|candidate|region|category|story|product|issue|test|log|host|server|database|table|page|paper)\b|\bfrom\s+[^,.;\n]{1,80}\s+only\b/i;

const DIVISIBLE_ACTION_RE = /\b(?:search|research|find|look\s+up|gather|collect|pull|survey|scan|sweep|inspect|audit|review|analy[sz]e|compare|benchmark|evaluate|verify|validate|cross[- ]check|triage|test|check|summari[sz]e|catalog|inventory|investigate|trace|profile|measure|assess|identify|discover|map|diagnose|debug|troubleshoot|classify|label|extract|score|translate|draft|generate)\b/i;
const DESTRUCTIVE_ONLY_RE = /\b(?:delete|remove|purge|deploy|restart|reboot|send|publish|merge|commit|apply|install|uninstall)\b/i;

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
const DEPENDENT_SEQUENCE_RE = /\b(?:using|with|from|based\s+on)\s+(?:that|the|its)\s+(?:result|output|answer|finding)s?\b|\b(?:after|once)\s+(?:that|it|the\s+(?:search|read|analysis|research|build|test))\b[^.\n]{0,80}\b(?:then\s+)?(?:update|edit|write|send|apply|deploy|restart|publish)\b/i;

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

function explicitLaneCount(text) {
  const match = text.match(/\b([2-9])\s+(?:agents?|lanes?|workstreams?|subagents?|workers?)\b/i);
  if (!match) return null;
  return Math.max(2, Math.min(4, Number(match[1])));
}

/**
 * Classify a task without looking at its domain or available tool names.
 */
export function classifyClearlySplittableWork(task) {
  const text = normalizeTask(task);
  const reasons = [];
  if (!text || NO_FANOUT_RE.test(text)) {
    return { required: false, suggestedLanes: 1, reasons, family: 'single' };
  }

  const explicitFanout = EXPLICIT_FANOUT_RE.test(text);
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
  const dependentOnly = DEPENDENT_SEQUENCE_RE.test(text)
    && !comparison
    && !coverage
    && !multiResource
    && !countedResources
    && !listedTargets;
  const destructiveOnly = DESTRUCTIVE_ONLY_RE.test(text) && !action;
  const singleScope = SINGLE_SCOPE_RE.test(text);

  if (explicitFanout) reasons.push('explicit-parallelism');
  if (comparison) reasons.push('comparison-or-selection');
  if (coverage) reasons.push('broad-current-coverage');
  if (multiResource || countedResources || pluralCoverage) reasons.push('multiple-resources');
  if (broadReview) reasons.push('broad-review');
  if (listedTargets) reasons.push('explicit-target-list');

  let required = explicitFanout
    || comparison
    || coverage
    || broadReview
    || listedTargets
    || (action && (multiResource || countedResources || pluralCoverage));

  if ((singleScope || dependentOnly || destructiveOnly) && !explicitFanout) {
    required = false;
  }

  let suggestedLanes = 1;
  if (required) {
    suggestedLanes = explicitLaneCount(text)
      || (targetCount >= 4 ? 4 : targetCount >= 3 ? 3 : null)
      || (multiResource && /\b(?:all|every|many|across)\b/i.test(text) ? 4 : null)
      || (comparison || coverage ? 3 : 2);
  }

  return {
    required,
    suggestedLanes,
    reasons: required ? reasons : [],
    family: required
      ? (comparison ? 'comparison' : coverage ? 'coverage' : 'multi-resource')
      : 'single',
  };
}

export function isRootDetachedWorker(agent, taskContext) {
  if (agent?.ephemeral !== true || !ROOT_WORKER_ID_RE.test(String(agent?.id || ''))) return false;
  if (!taskContext?.taskId || taskContext.parentTaskId) return false;
  return taskContext.rootTaskId === taskContext.taskId;
}

export function installParallelWorkGate({ agent, routeText, taskContext }) {
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

  const assessment = classifyClearlySplittableWork(routeText);
  const parallelTool = agent.tools.find(tool => tool?.function?.name === 'parallel_work');
  if (!assessment.required || !eligibleRoot || !parallelTool) {
    return { required: false, locked: false, note: '', assessment };
  }

  const laneWord = assessment.suggestedLanes === 1 ? 'lane' : 'lanes';
  const note = [
    '## Mandatory parallel-work preflight',
    'The server classified this detached outcome as clearly divisible into independent coverage.',
    'Your first substantive action MUST be a `parallel_work` call with 2–4 explicit, non-overlapping work items. Do not answer from memory and do not attempt a domain tool first.',
    `Use the fewest useful lanes; ${assessment.suggestedLanes} ${laneWord} is the current recommendation, but adjust within 2–4 when the actual scope warrants it.`,
    'You are the coordinator: assign every lane centrally and give each one a distinct stable claim. Children do not negotiate assignments with each other.',
    'After the lane reports return, resolve conflicts, synthesize one answer, and perform any dependent or mutating steps yourself in serial order.',
  ].join('\n');
  const state = {
    required: true,
    state: 'locked',
    routedTools: [...agent.tools],
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
