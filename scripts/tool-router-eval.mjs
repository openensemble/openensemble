#!/usr/bin/env node

/**
 * Offline, side-effect-free evaluation of the per-turn tool router.
 *
 * Run with NODE_ENV=test in the isolated lab image with networking disabled.
 * Test mode redirects every writable OE path to a disposable per-process base.
 * The script loads the bundled embedding model, checks declared on-demand
 * examples, exercises single- and multi-skill prompts, and verifies explicit
 * and natural-language request_tools recovery. It never executes an action
 * tool.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadRoleManifests, listRoles, getRoleManifest } from '../roles.mjs';
import { getAgentsForUser } from '../routes/_helpers/agent-resolver.mjs';
import {
  expandToolsByReason,
  trimToolsForTurn,
  _internal,
} from '../lib/tool-router.mjs';
import {
  classifyByEmbedding,
  loadIntentEmbeddings,
} from '../lib/specialist-embed-router.mjs';
import { BASE_DIR, SKILLS_DIR, USERS_DIR } from '../lib/paths.mjs';
import { ROUTER_CASES } from './tool-router-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// loadRoleManifests performs startup migrations/cleanup. Never let this
// evaluator point at a durable OE base: NODE_ENV=test makes lib/paths create a
// disposable per-process tree that is removed on exit.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  throw new Error('tool-router-eval must run with NODE_ENV=test so all manifest/config/user writes stay in a disposable base');
}

function toolName(tool) {
  return tool?.function?.name ?? tool?.name ?? '';
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function uniqueTools(manifests) {
  const seen = new Set();
  const out = [];
  for (const manifest of manifests) {
    for (const tool of manifest.tools ?? []) {
      const name = toolName(tool);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(tool);
    }
  }
  return out;
}

function selectedOnDemand(trim) {
  return [...(trim.skillsKept ?? trim.initiallyIncludedSkills ?? [])]
    .filter(skillId => onDemand.has(skillId))
    .sort();
}

const userArgIndex = process.argv.indexOf('--user');
const agentArgIndex = process.argv.indexOf('--agent');
const evaluatedUserId = userArgIndex >= 0 ? process.argv[userArgIndex + 1] : null;
const evaluatedAgentId = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : null;

// Point the disposable registry at the read-only source manifests. For a live
// agent evaluation, copy only that user's state into the disposable base so
// assignments/custom manifests resolve without touching the source user.
rmSync(SKILLS_DIR, { recursive: true, force: true });
symlinkSync(path.join(root, 'skills'), SKILLS_DIR, 'dir');
// lib/paths redirects model lookup into the disposable BASE_DIR in test mode.
// Keep data writes isolated while exposing the image's read-only, bundled
// embedding cache; without this link transformers.js tries the network and the
// offline evaluator silently degenerates into a direct-rule-only test.
const sourceModelsDir = path.join(root, 'models');
const testModelsDir = path.join(BASE_DIR, 'models');
if (!existsSync(sourceModelsDir)) {
  throw new Error(`Bundled models are unavailable at ${sourceModelsDir}; run this evaluator inside the OE lab image`);
}
rmSync(testModelsDir, { recursive: true, force: true });
symlinkSync(sourceModelsDir, testModelsDir, 'dir');
if (evaluatedUserId) {
  const sourceUserDir = path.join(root, 'users', evaluatedUserId);
  if (!existsSync(sourceUserDir)) throw new Error(`Cannot find source user ${evaluatedUserId} under ${path.join(root, 'users')}`);
  mkdirSync(USERS_DIR, { recursive: true });
  cpSync(sourceUserDir, path.join(USERS_DIR, evaluatedUserId), { recursive: true, force: true });
}

loadRoleManifests();
const evaluatedAgent = evaluatedUserId && evaluatedAgentId
  ? getAgentsForUser(evaluatedUserId).find(agent => agent.id === evaluatedAgentId)
  : null;
if ((evaluatedUserId || evaluatedAgentId) && !evaluatedAgent) {
  throw new Error(`Cannot resolve live agent ${evaluatedAgentId ?? '<missing>'} for user ${evaluatedUserId ?? '<missing>'}`);
}
const manifests = listRoles(evaluatedUserId);
const onDemand = new Set([
  ..._internal.ON_DEMAND_SKILL_IDS,
  ...manifests
    .filter(m => m.custom === true && m.coordinator_scope === 'auto')
    .map(m => m.id),
]);
const allTools = evaluatedAgent?.tools ?? uniqueTools(manifests);
const toolsBySkill = new Map(manifests.map(m => [m.id, (m.tools ?? []).map(toolName).filter(Boolean)]));

const loadStarted = performance.now();
await loadIntentEmbeddings();
const embeddingLoadMs = Math.round(performance.now() - loadStarted);

// 1. Every declared example should classify back to the skill that owns it.
const selfRecall = { total: 0, exact: 0, missed: [], wrong: [], latenciesMs: [] };
for (const skillId of onDemand) {
  const manifest = getRoleManifest(skillId, evaluatedUserId);
  for (const phrase of manifest?.intent_examples ?? []) {
    selfRecall.total++;
    const started = performance.now();
    const hit = await classifyByEmbedding(phrase, evaluatedUserId, null, {
      threshold: _internal.INITIAL_INCLUDE_THRESHOLD,
      gap: 0.04,
      includeUnassigned: true,
    });
    selfRecall.latenciesMs.push(performance.now() - started);
    if (hit?.skillId === skillId) selfRecall.exact++;
    else if (!hit) selfRecall.missed.push({ skillId, phrase });
    else selfRecall.wrong.push({ skillId, phrase, got: hit.skillId, sim: Number(hit.sim.toFixed(4)) });
  }
}

// 2. Human-shaped prompts, including multi-skill composition and known prior
// false-positive phrases. "forbidden" catches expensive irrelevant loads.
const additionalPromptCases = [
  { prompt: 'Check my email and show the newest unread messages', required: ['email'] },
  { prompt: 'Reply to Dana and tell her dinner starts at seven', required: ['email'] },
  { prompt: 'Am I free Friday afternoon?', required: ['gcal'] },
  { prompt: 'Move my dentist appointment to next Tuesday', required: ['gcal'] },
  { prompt: 'Ping me when the sun goes down', required: ['tasks'] },
  { prompt: 'Wake me at 6:30 tomorrow morning', required: ['tasks'] },
  { prompt: "Bind 'movie time' to dim the lights and start the fireplace sound", required: ['routines', 'role_home_assistant'] },
  { prompt: 'Show my installed model providers', required: ['oe-admin'] },
  { prompt: 'Onboard Pi-hole as a managed service profile', required: ['profiles'] },
  { prompt: 'What tabs do I have open?', required: ['browser-ext'] },
  { prompt: 'List my desktop sandboxes', required: ['desktop'] },
  { prompt: 'Connect the GitHub MCP server', required: ['mcp-admin'] },
  { prompt: 'Is the coder still working on my task?', required: ['active-agents'] },
  { prompt: 'Is the front door locked?', required: ['role_home_assistant'] },
  { prompt: 'Set the thermostat to 70 degrees', required: ['role_home_assistant'] },
  { prompt: 'Put on Disney Plus on the TV', required: ['role_tv_control'], forbidden: ['tasks'] },
  { prompt: 'How much did I spend on groceries last month?', required: ['expenses'] },
  { prompt: 'Fix the login bug in src/auth.js', required: ['coder'] },
  { prompt: 'Restart Docker on my Proxmox host', required: ['nodes'] },
  { prompt: 'Investigate the latest advances in solid-state batteries', required: ['deep_research'] },
  { prompt: 'Build a new skill that tracks grocery prices', required: ['skill-builder'] },
  { prompt: 'Quiz me on French irregular verbs', required: ['role_tutor'] },
  { prompt: 'Generate an image of a red fox in a snowy forest', required: ['image_generator'] },
  { prompt: 'Create a short video of waves crashing at sunset', required: ['role_video_generator'] },
  { prompt: 'What is said in this audio recording?', required: ['transcribe'] },
  { prompt: 'Proofread my resume and tighten the wording', required: ['documents'] },
  { prompt: 'Email my calendar agenda to me', required: ['email', 'gcal'] },
  { prompt: 'Turn off the kitchen lights and remind me to lock the door at 10 PM', required: ['role_home_assistant', 'tasks'] },
  { prompt: 'Generate a birthday image and email it to Shawn', required: ['image_generator', 'email'] },
  { prompt: 'Research the GPU market and email me the report', required: ['deep_research', 'email'] },
  { prompt: 'show me the weather report', required: [], forbidden: ['role_tv_control', 'documents'] },
  { prompt: 'explain this compiler error message', required: [], forbidden: ['email'] },
  { prompt: 'write a Python script that sorts a list', required: ['coder'], forbidden: ['role_home_assistant'] },
  { prompt: 'turn off notifications in the chat app', required: [], forbidden: ['role_home_assistant'] },
  { prompt: 'handle the JavaScript click event', required: [], forbidden: ['gcal', 'browser-ext'] },
  { prompt: 'explain the YouTube Data API', required: [], forbidden: ['role_tv_control'] },
  { prompt: 'watch Netflix on the TV', required: ['role_tv_control'], forbidden: ['tasks'] },
  { prompt: 'what is 17 times 23', required: [], forbidden: [...onDemand] },
];
// Supplemental cases are gates too. Leaving strict undefined previously let
// them accumulate arbitrary extra on-demand skills while still reporting a
// pass, inflating the clear-pass metric.
const promptCases = [
  ...ROUTER_CASES,
  ...additionalPromptCases.map(testCase => ({ strict: true, ...testCase })),
];

const promptResults = [];
const promptFailures = [];
for (const testCase of promptCases) {
  const agent = {
    id: evaluatedAgent?.id ?? 'offline_router_eval',
    skillCategory: evaluatedAgent?.skillCategory ?? 'coordinator',
    provider: evaluatedAgent?.provider ?? 'anthropic',
    tools: allTools,
  };
  const started = performance.now();
  const trim = await trimToolsForTurn({ agent, userText: testCase.prompt, userId: evaluatedUserId, source: 'web' });
  const latencyMs = performance.now() - started;
  const selected = selectedOnDemand(trim);
  const keptToolNames = new Set(trim.trimmedTools.map(toolName));
  const fullToolNames = new Set(trim.fullTools.map(toolName));
  const missing = (testCase.required ?? []).filter(skillId => !selected.includes(skillId));
  // A skill label is not enough: the second-stage bucket gate used to report
  // `tasks` selected while removing every task tool. Require every tool from
  // that skill that the evaluated agent actually owns to survive, and treat an
  // owned-surface gap as a missing capability.
  const missingTools = [];
  for (const skillId of testCase.required ?? []) {
    const declared = toolsBySkill.get(skillId) ?? [];
    const available = declared.filter(name => fullToolNames.has(name));
    if (!available.length) {
      missingTools.push(`${skillId}:<no tools on evaluated agent>`);
      continue;
    }
    for (const name of available) if (!keptToolNames.has(name)) missingTools.push(`${skillId}:${name}`);
  }
  const forbidden = (testCase.forbidden ?? []).filter(skillId => selected.includes(skillId));
  const unexpected = testCase.strict
    ? selected.filter(skillId => !(testCase.required ?? []).includes(skillId))
    : [];
  const missingAlways = (testCase.requiresAlways ?? []).filter(name => !keptToolNames.has(name));
  const result = {
    id: testCase.id ?? null,
    category: testCase.category ?? 'supplemental',
    prompt: testCase.prompt,
    required: testCase.required ?? [],
    ambiguous: testCase.ambiguous === true,
    selected,
    missing,
    missingTools,
    forbidden,
    unexpected,
    missingAlways,
    keptTools: trim.trimmedTools.length,
    fullTools: trim.fullTools.length,
    latencyMs: Number(latencyMs.toFixed(1)),
  };
  promptResults.push(result);
  if (missing.length || missingTools.length || forbidden.length || unexpected.length || missingAlways.length) promptFailures.push(result);
}

// 3. Explicit request_tools recovery must work for every toolful on-demand
// group, and natural-language recovery must work from held-out corpus wording.
const explicitRecovery = { tested: 0, passed: 0, failures: [] };
const reasonRecovery = { tested: 0, passed: 0, failures: [] };
const zeroToolSkills = [];
const requestToolsDef = allTools.find(t => toolName(t) === 'request_tools');
const evaluatedToolNames = new Set(allTools.map(toolName));
for (const skillId of onDemand) {
  const declared = toolsBySkill.get(skillId) ?? [];
  if (!declared.length) {
    zeroToolSkills.push(skillId);
    continue;
  }
  const expected = declared.filter(name => evaluatedToolNames.has(name));
  if (!expected.length) {
    explicitRecovery.failures.push({ skillId, missing: [`${skillId}:<no tools on evaluated agent>`], addedSkills: [] });
    reasonRecovery.failures.push({ skillId, reason: null, missing: [`${skillId}:<no tools on evaluated agent>`], addedSkills: [] });
    continue;
  }

  explicitRecovery.tested++;
  {
    const agent = { tools: requestToolsDef ? [requestToolsDef] : [] };
    const result = await expandToolsByReason({
      agent, fullTools: allTools, reason: null, groups: [skillId], userId: evaluatedUserId,
      alreadyIncludedSkills: new Set(),
    });
    const missing = expected.filter(name => !result.addedToolNames.includes(name));
    if (!missing.length && result.addedSkills.includes(skillId)) explicitRecovery.passed++;
    else explicitRecovery.failures.push({ skillId, missing, addedSkills: result.addedSkills });
  }

  // Use a human-shaped corpus prompt, not the skill's own embedded training
  // phrase. Exact self-recall is a manifest-integrity diagnostic, not evidence
  // that natural-language recovery generalizes.
  const reasonCase = promptCases.find(testCase =>
    testCase.ambiguous !== true && (testCase.required ?? []).includes(skillId));
  const reason = reasonCase?.prompt;
  if (reason) {
    reasonRecovery.tested++;
    const agent = { tools: requestToolsDef ? [requestToolsDef] : [] };
    const result = await expandToolsByReason({
      agent, fullTools: allTools, reason, groups: null, userId: evaluatedUserId,
      alreadyIncludedSkills: new Set(),
    });
    const missing = expected.filter(name => !result.addedToolNames.includes(name));
    if (!missing.length && result.addedSkills.includes(skillId)) reasonRecovery.passed++;
    else reasonRecovery.failures.push({ skillId, reason, missing, addedSkills: result.addedSkills });
  } else {
    reasonRecovery.failures.push({ skillId, reason: null, missing: ['no non-ambiguous corpus prompt'], addedSkills: [] });
  }
}

// 4. Inventory every tool-capable provider loop. This is deliberately labeled
// structural inspection, not proof: behavioral schema-refresh coverage lives in
// lib/tool-router.test.mjs and exercises request_tools across these adapters.
const providerFiles = [
  'chat/providers/anthropic.mjs',
  'chat/providers/openai-compat.mjs',
  'chat/providers/lmstudio.mjs',
  'chat/providers/openai-responses.mjs',
  'chat/providers/openrouter.mjs',
  'chat/providers/ollama.mjs',
];
const providerLoopInspection = providerFiles.map(file => {
  const source = readFileSync(path.join(root, file), 'utf8');
  return {
    file,
    mentionsDynamicAgentTools: /agent\.tools/.test(source),
    behavioralCoverage: 'lib/tool-router.test.mjs',
  };
});

const latencyValues = [
  ...selfRecall.latenciesMs,
  ...promptResults.map(r => r.latencyMs),
];
const imageToolCount = toolsBySkill.get('image_generator')?.length ?? 0;
const emailToolCount = toolsBySkill.get('email')?.length ?? 0;
const isCapabilityOnlyFailure = failure =>
  (failure.missing.length > 0 || failure.missingTools.length > 0)
  && failure.missing.every(skillId => (toolsBySkill.get(skillId)?.length ?? 0) === 0)
  && failure.forbidden.length === 0
  && failure.unexpected.length === 0
  && failure.missingAlways.length === 0;
const criticalFailures = [
  ...selfRecall.missed.map(failure => ({ type: 'intent-example-missed', ...failure })),
  ...selfRecall.wrong.map(failure => ({ type: 'intent-example-wrong', ...failure })),
  ...promptFailures.filter(f => !f.ambiguous),
  ...explicitRecovery.failures,
  ...reasonRecovery.failures,
  ...zeroToolSkills.map(skillId => ({ type: 'zero-tool-on-demand-skill', skillId })),
  ...(!requestToolsDef ? [{ type: 'request-tools-missing-from-evaluated-agent' }] : []),
];

const report = {
  generatedAt: new Date().toISOString(),
  mode: evaluatedAgent ? { kind: 'live-agent', userId: evaluatedUserId, agentId: evaluatedAgentId } : { kind: 'idealized-all-manifests' },
  embeddingLoadMs,
  corpus: {
    manifests: manifests.length,
    totalTools: allTools.length,
    onDemandSkills: onDemand.size,
    emailToolCount,
    imageToolCount,
    zeroToolOnDemandSkills: zeroToolSkills,
  },
  intentExampleSelfRecall: {
    total: selfRecall.total,
    exact: selfRecall.exact,
    accuracy: selfRecall.total ? Number((selfRecall.exact / selfRecall.total).toFixed(4)) : 0,
    missed: selfRecall.missed,
    wrong: selfRecall.wrong,
  },
  promptMatrix: {
    total: promptResults.length,
    passed: promptResults.length - promptFailures.length,
    clearCases: promptResults.filter(r => !r.ambiguous).length,
    clearPassed: promptResults.filter(r => !r.ambiguous && !promptFailures.includes(r)).length,
    knownCapabilityOnlyFailures: promptFailures.filter(isCapabilityOnlyFailure),
    ambiguousFailures: promptFailures.filter(r => r.ambiguous),
    failures: promptFailures,
    results: promptResults,
  },
  recovery: { explicit: explicitRecovery, byReason: reasonRecovery },
  providerLoopInspection,
  routingLatencyMs: {
    samples: latencyValues.length,
    median: Number(percentile(latencyValues, 0.5).toFixed(1)),
    p95: Number(percentile(latencyValues, 0.95).toFixed(1)),
    max: Number(Math.max(0, ...latencyValues).toFixed(1)),
  },
  capabilityGaps: zeroToolSkills.map(skillId => `${skillId} exposes no coordinator-callable tool`),
  criticalFailureCount: criticalFailures.length,
};

const adversarialResults = promptResults.filter(result => result.id !== null);
const resultPassed = result => !promptFailures.includes(result);
const clearRoutable = result =>
  !result.ambiguous
  && result.required.every(skillId => (toolsBySkill.get(skillId)?.length ?? 0) > 0);
report.adversarialMatrix = {
  total: adversarialResults.length,
  passed: adversarialResults.filter(resultPassed).length,
  clear: adversarialResults.filter(result => !result.ambiguous).length,
  clearPassed: adversarialResults.filter(result => !result.ambiguous && resultPassed(result)).length,
  clearRoutable: adversarialResults.filter(clearRoutable).length,
  clearRoutablePassed: adversarialResults.filter(result => clearRoutable(result) && resultPassed(result)).length,
};

if (process.argv.includes('--summary')) {
  console.log('ROUTER_EVAL_SUMMARY_JSON');
  console.log(JSON.stringify({
    mode: report.mode,
    corpus: report.corpus,
    intentExampleSelfRecall: report.intentExampleSelfRecall,
    adversarialMatrix: report.adversarialMatrix,
    promptMatrix: {
      total: report.promptMatrix.total,
      passed: report.promptMatrix.passed,
      clearCases: report.promptMatrix.clearCases,
      clearPassed: report.promptMatrix.clearPassed,
      failures: report.promptMatrix.failures.map(({ id, prompt, missing, missingTools, forbidden, unexpected, ambiguous }) => ({ id, prompt, missing, missingTools, forbidden, unexpected, ambiguous })),
    },
    recovery: report.recovery,
    providerLoopInspection: report.providerLoopInspection,
    routingLatencyMs: report.routingLatencyMs,
    capabilityGaps: report.capabilityGaps,
    criticalFailureCount: report.criticalFailureCount,
  }, null, 2));
} else {
  console.log('ROUTER_EVAL_JSON');
  console.log(JSON.stringify(report, null, 2));
}
if (criticalFailures.length) process.exitCode = 1;
