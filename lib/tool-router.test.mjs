import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const resolvedMcpToolsByAgent = vi.hoisted(() => new Map());
vi.mock('./mcp-tools.mjs', () => {
  const forAgent = (userId, agentId) =>
    resolvedMcpToolsByAgent.get(`${userId}::${agentId}`) ?? [];
  return {
    getCachedMcpToolDefsForAgent: forAgent,
    getCachedMcpToolDefsForAgents: (userId, agentIds) => {
      const seen = new Set();
      return (agentIds ?? []).flatMap(agentId => forAgent(userId, agentId))
        .filter(tool => {
          const name = tool?.function?.name;
          if (!name || seen.has(name)) return false;
          seen.add(name);
          return true;
        });
    },
  };
});

import {
  expandToolsByReason,
  scoreToolsForTurn,
  shouldPreserveCachePrefix,
  trimToolsForTurn,
  _internal,
} from './tool-router.mjs';
import { toolRouterContext } from './tool-router-context.mjs';
import { loadRoleManifests, listRoles, getRoleManifest, resolveAgentTools } from '../roles.mjs';
import executeCoordinatorTool from '../skills/coordinator/execute.mjs';
import { CFG_PATH, SKILLS_DIR, USERS_DIR } from './paths.mjs';
import { getAgentsForUser } from '../routes/_helpers/agent-resolver.mjs';
import { streamAnthropic } from '../chat/providers/anthropic.mjs';
import { streamOpenAICompat } from '../chat/providers/openai-compat.mjs';
import { streamLMStudio, streamLMStudioCompat } from '../chat/providers/lmstudio.mjs';
import { streamOpenRouter } from '../chat/providers/openrouter.mjs';
import { streamOllama } from '../chat/providers/ollama.mjs';
import { streamOpenAIResponses } from '../chat/providers/openai-responses.mjs';

// Keep the real manifest/assignment APIs, but make the provider-loop test
// execute only the two safe tools it needs. The production dispatcher lazy-
// loads executors through SKILLS_DIR; under Vitest that directory is an
// intentionally disposable tree, so exercising it here would test the test-
// path redirect rather than provider schema refresh. The router executor and
// email executor below are still the real implementations.
vi.mock('../roles.mjs', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeToolStreaming: async function* (name, args, userId, agentId, allowedTools = []) {
      if (!allowedTools.includes(name)) {
        yield { type: 'result', text: `Unknown tool: ${name}` };
        return;
      }
      if (name === 'request_tools') {
        const { default: execute } = await import('../skills/coordinator/execute.mjs');
        yield* execute(name, args, userId, agentId);
        return;
      }
      if (name === 'email_list_accounts') {
        const { default: execute } = await import('../skills/email/execute.mjs');
        yield { type: 'result', text: String(await execute(name, args, userId)) };
        return;
      }
      yield { type: 'result', text: `Unhandled test tool: ${name}` };
    },
  };
});

beforeAll(() => {
  const sourceSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills');
  // lib/paths redirects tests to a disposable BASE_DIR. Point its skills path
  // back at the read-only source tree so lazy-loaded executors keep their real
  // relative imports (`../../lib`, `../../routes`, etc.) instead of being copied
  // into an incomplete temp tree.
  rmSync(SKILLS_DIR, { recursive: true, force: true });
  symlinkSync(sourceSkills, SKILLS_DIR, 'dir');
  mkdirSync(path.dirname(CFG_PATH), { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify({
    skillAssignments: {
      // Deliberately place coder first: primary-role resolution must not depend
      // on JSON insertion order when one agent owns both roles.
      coder: 'jarvis_bundle_test',
      coordinator: 'jarvis_bundle_test',
      'test-gpu': 'jarvis_bundle_test',
    },
  }));
  const fixtureUserId = 'router_bundle_user';
  const fixtureUserDir = path.join(USERS_DIR, fixtureUserId);
  mkdirSync(fixtureUserDir, { recursive: true });
  writeFileSync(path.join(fixtureUserDir, 'profile.json'), JSON.stringify({
    id: fixtureUserId,
    name: 'Router Test User',
    role: 'owner',
    skills: ['coordinator', 'coder', 'mcp', 'test-gpu', 'test-legacy-include'],
    // The fork inferred solo mode from the one-agent roster; stock requires
    // the stored policy (plan D4), so the singleton-router expectations in
    // this file only hold with an explicit single-mode stamp.
    orchestration: { mode: 'single', primaryAgentId: 'jarvis_bundle_test' },
  }));
  writeFileSync(path.join(fixtureUserDir, 'agents.json'), JSON.stringify([
    {
      id: 'jarvis_bundle_test',
      name: 'Jarvis Test',
      ownerId: fixtureUserId,
      provider: 'anthropic',
      model: 'router-test',
      toolSet: 'web',
      systemPrompt: 'Router test agent.',
    },
    {
      id: 'jarvis_bundle_parked',
      name: 'Parked Specialist',
      ownerId: fixtureUserId,
      provider: 'anthropic',
      model: 'router-test',
      skillCategory: 'coder',
      systemPrompt: 'Parked specialist fixture.',
    },
  ]));
  for (const id of ['router-e2e-user', 'router-provider-user']) {
    const dir = path.join(USERS_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
      id,
      name: 'Router Provider Fixture',
      role: 'user',
      allowedSkills: null,
      skills: ['coordinator', 'email'],
      skillAssignments: {},
      orchestration: { mode: 'ensemble' },
    }));
  }
  resolvedMcpToolsByAgent.set(`${fixtureUserId}::jarvis_bundle_parked`, [
    mcpTool('parked', 'lookup', 'Look up data through the parked specialist server.'),
  ]);
  const customSkillDir = path.join(fixtureUserDir, 'skills', 'test-gpu');
  mkdirSync(customSkillDir, { recursive: true });
  writeFileSync(path.join(customSkillDir, 'manifest.json'), JSON.stringify({
    id: 'test-gpu',
    name: 'Test GPU',
    description: 'A specialist-only GPU fixture that becomes on-demand for a singleton Jarvis.',
    category: 'utility',
    custom: true,
    createdBy: fixtureUserId,
    coordinator_scope: 'exclude',
    enabled_by_default: false,
    tools: [{
      type: 'function',
      function: {
        name: 'test_gpu_list',
        description: 'List test GPU capacity.',
        parameters: { type: 'object', properties: {} },
      },
    }],
  }));
  writeFileSync(path.join(customSkillDir, 'execute.mjs'), 'export default async () => "test gpu";\n');

  const localWeatherDir = path.join(fixtureUserDir, 'skills', 'localweather');
  mkdirSync(localWeatherDir, { recursive: true });
  writeFileSync(path.join(localWeatherDir, 'manifest.json'), JSON.stringify({
    id: 'localweather',
    name: 'Local Weather',
    description: 'Gets current local weather and the local forecast.',
    category: 'utility',
    custom: true,
    createdBy: fixtureUserId,
    coordinator_scope: 'auto',
    enabled_by_default: false,
    intent_examples: [
      "what's the weather",
      'check the weather',
      'current weather and forecast',
      'weather in Cape Coral',
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'localweather_get_weather',
        description: 'Get current local weather and the local forecast.',
        parameters: { type: 'object', properties: {} },
      },
    }],
  }));
  writeFileSync(path.join(localWeatherDir, 'execute.mjs'), 'export default async () => "sunny";\n');

  for (const fixture of [
    {
      id: 'flight-booker',
      name: 'Flight Booker',
      description: 'Searches flight options and watches saved trips for price drops.',
      intent_examples: [
        'find flights from Tampa to Tokyo',
        'search flights from RSW to LAX',
        'watch my trip for price drops',
      ],
      tool: 'flight_search_fixture',
    },
    {
      id: 'youtube-download',
      name: 'YouTube Download',
      description: 'Downloads YouTube videos and finds uploads from saved channels.',
      intent_examples: [
        'download the latest video from this channel',
        'show new uploads from a saved channel',
        'get the newest video from this channel',
      ],
      tool: 'youtube_download_fixture',
    },
  ]) {
    const dir = path.join(fixtureUserDir, 'skills', fixture.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      ...fixture,
      category: 'utility',
      custom: true,
      createdBy: fixtureUserId,
      coordinator_scope: 'auto',
      enabled_by_default: false,
      tools: [{
        type: 'function',
        function: {
          name: fixture.tool,
          description: fixture.description,
          parameters: { type: 'object', properties: {} },
        },
      }],
    }));
    writeFileSync(path.join(dir, 'execute.mjs'), 'export default async () => "fixture";\n');
  }

  const includedCustomSkillDir = path.join(fixtureUserDir, 'skills', 'test-legacy-include');
  mkdirSync(includedCustomSkillDir, { recursive: true });
  writeFileSync(path.join(includedCustomSkillDir, 'manifest.json'), JSON.stringify({
    id: 'test-legacy-include',
    name: 'Legacy Included Skill',
    description: 'A custom coordinator skill that must remain on the stable surface.',
    category: 'utility',
    custom: true,
    createdBy: fixtureUserId,
    coordinator_scope: 'include',
    enabled_by_default: false,
    tools: [{
      type: 'function',
      function: {
        name: 'test_legacy_status',
        description: 'Read the legacy custom status.',
        parameters: { type: 'object', properties: {} },
      },
    }],
  }));
  writeFileSync(path.join(includedCustomSkillDir, 'execute.mjs'), 'export default async () => "legacy status";\n');

  const multiUserId = 'router_multi_user';
  const multiUserDir = path.join(USERS_DIR, multiUserId);
  mkdirSync(multiUserDir, { recursive: true });
  writeFileSync(path.join(multiUserDir, 'profile.json'), JSON.stringify({
    id: multiUserId,
    name: 'Router Multi User',
    role: 'owner',
    skills: ['coordinator', 'delegate', 'mcp'],
  }));
  writeFileSync(path.join(multiUserDir, 'agents.json'), JSON.stringify([
    {
      id: 'router_multi_coordinator',
      name: 'Multi Coordinator',
      ownerId: multiUserId,
      provider: 'anthropic',
      model: 'router-test',
      skillCategory: 'coordinator',
      systemPrompt: 'Multi-agent coordinator fixture.',
    },
    {
      id: 'router_multi_helper',
      name: 'Multi Helper',
      ownerId: multiUserId,
      provider: 'anthropic',
      model: 'router-test',
      skillCategory: 'coder',
      systemPrompt: 'Multi-agent helper fixture.',
    },
  ]));
  resolvedMcpToolsByAgent.set(`${multiUserId}::router_multi_helper`, [
    mcpTool('ensemble_helper', 'lookup', 'Look up data assigned to the ensemble helper.'),
  ]);
  loadRoleManifests();
});

describe('cache-stable prefix experiment', () => {
  it('can never disable trimming for singleton Jarvis or its workers', () => {
    const base = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
    try {
      writeFileSync(CFG_PATH, JSON.stringify({
        ...base,
        toolRouter: { ...(base.toolRouter || {}), cacheStablePrefix: true },
      }));
      expect(shouldPreserveCachePrefix({ provider: 'openai-oauth', _rosterSolo: true })).toBe(false);
      expect(shouldPreserveCachePrefix({ provider: 'openai-oauth', ephemeral: true })).toBe(false);
      expect(shouldPreserveCachePrefix({ provider: 'openai-oauth' })).toBe(true);
    } finally {
      writeFileSync(CFG_PATH, JSON.stringify(base));
    }
  });
});

function toolName(tool) {
  return tool?.function?.name ?? tool?.name ?? '';
}

function expectModelCallMatchesBody(event, body, { provider, round } = {}) {
  const toolsPresent = Array.isArray(body.tools);
  const tools = toolsPresent ? body.tools : [];
  const serialized = toolsPresent ? JSON.stringify(tools) : '';
  expect(event).toMatchObject({
    type: '__model_call',
    ...(provider ? { provider } : {}),
    ...(round ? { round } : {}),
    phase: 'dispatch_planned',
    toolsPresent,
    toolNames: tools.map(tool => tool?.function?.name ?? tool?.name ?? tool?.type).filter(Boolean),
    toolCount: tools.length,
    toolSchemaBytes: Buffer.byteLength(serialized),
    schemaTokEst: Math.ceil(Buffer.byteLength(serialized) / 4),
    schemaHash: createHash('sha256').update(serialized).digest('hex'),
  });
}

function toolsFor(skillId) {
  return getRoleManifest(skillId)?.tools ?? [];
}

function allTools() {
  const seen = new Set();
  const out = [];
  for (const manifest of listRoles()) {
    for (const tool of manifest.tools ?? []) {
      const name = toolName(tool);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(tool);
    }
  }
  return out;
}

function mcpTool(serverId, name, description) {
  return {
    type: 'function',
    function: {
      name: `mcp_${serverId}__${name}`,
      description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

function directMatches(text) {
  return new Set(
    _internal.DIRECT_INTENT_RULES
      .filter(rule => rule.re.test(text))
      .map(rule => rule.skillId),
  );
}

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

function anthropicSse(events) {
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicToolUse(name, args, id) {
  return anthropicSse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]);
}

function anthropicText(text) {
  return anthropicSse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]);
}

function openAiSse(events) {
  const payload = [
    ...events.map(event => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function openAiToolUse(name, args, id = 'call_router') {
  return openAiSse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

function openAiText(text) {
  return openAiSse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
}

function ndjson(events) {
  return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function ollamaToolUse(name, args) {
  return ndjson([
    { message: { tool_calls: [{ function: { name, arguments: args } }] }, done: false },
    { message: {}, done: true, prompt_eval_count: 5, eval_count: 2 },
  ]);
}

function ollamaText(text) {
  return ndjson([
    { message: { content: text }, done: false },
    { message: {}, done: true, prompt_eval_count: 5, eval_count: 2 },
  ]);
}

function responsesToolUse(name, args) {
  const item = { type: 'function_call', id: 'fc_router', call_id: 'call_router', name, arguments: JSON.stringify(args) };
  return openAiSse([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
  ]);
}

function responsesText(text) {
  return openAiSse([
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
  ]);
}

describe('tool router manifest contracts', () => {
  it('has a manifest for every built-in on-demand skill', () => {
    const missing = [..._internal.ON_DEMAND_SKILL_IDS]
      .filter(skillId => !getRoleManifest(skillId));
    expect(missing).toEqual([]);
  });

  it('has globally unique, structurally valid function definitions', () => {
    const owners = new Map();
    const duplicateNames = [];
    const invalid = [];
    for (const manifest of listRoles()) {
      for (const tool of manifest.tools ?? []) {
        const fn = tool?.function;
        if (!fn?.name || typeof fn.description !== 'string' || !fn.description.trim()) {
          invalid.push(`${manifest.id}:${fn?.name ?? '<unnamed>'}`);
          continue;
        }
        if (owners.has(fn.name)) duplicateNames.push(`${fn.name}:${owners.get(fn.name)}:${manifest.id}`);
        else owners.set(fn.name, manifest.id);
        const schema = fn.parameters;
        if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
          invalid.push(`${manifest.id}:${fn.name}:parameters`);
          continue;
        }
        for (const required of schema.required ?? []) {
          if (!(required in schema.properties)) invalid.push(`${manifest.id}:${fn.name}:required:${required}`);
        }
      }
    }
    expect(duplicateNames).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it('documents every built-in request_tools group in the coordinator schema', () => {
    const requestTools = toolsFor('coordinator').find(t => toolName(t) === 'request_tools');
    const description = requestTools?.function?.parameters?.properties?.groups?.description ?? '';
    const missing = [..._internal.ON_DEMAND_SKILL_IDS]
      .filter(skillId => !description.includes(`'${skillId}'`));
    expect(missing).toEqual([]);
  });

  it('gives one coordinator the bundles of every secondary role it owns', () => {
    const names = new Set(resolveAgentTools(
      'coordinator',
      ['coordinator', 'coder'],
      'jarvis_bundle_test',
      null,
    ).map(toolName));
    expect(names.has('skill_create')).toBe(true);
    expect(names.has('list_active_agents')).toBe(true);
  });

  it('does not resurrect a revoked secondary role through a stale assignment', () => {
    const names = new Set(resolveAgentTools(
      'coordinator',
      ['coordinator'],
      'jarvis_bundle_test',
      null,
    ).map(toolName));
    expect(names.has('skill_create')).toBe(false);
    expect(names.has('list_active_agents')).toBe(true);
  });

  it('keeps coordinator primary and secondary bundles in the final resolved agent surface', () => {
    const agent = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    expect(agent?.skillCategory).toBe('coordinator');
    const names = new Set((agent?.tools ?? []).map(toolName));
    expect(names.has('skill_create')).toBe(true);
    expect(names.has('list_active_agents')).toBe(true);
  });

  it('preserves global always-on tools through resolved defaultToolIds filtering', () => {
    for (const [userId, agentId] of [
      ['router_bundle_user', 'jarvis_bundle_test'],
      ['router_multi_user', 'router_multi_coordinator'],
    ]) {
      const agent = getAgentsForUser(userId).find(candidate => candidate.id === agentId);
      const names = new Set((agent?.tools ?? []).map(toolName));
      expect(names.has('set_orchestration_mode'), `${userId}:${agentId}`).toBe(true);
    }
  });

  it('projects parked-specialist MCP schemas onto only the singleton primary', () => {
    const singlePrimary = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    expect((singlePrimary?.tools ?? []).map(toolName)).toContain('mcp_parked__lookup');

    const ensembleCoordinator = getAgentsForUser('router_multi_user')
      .find(candidate => candidate.id === 'router_multi_coordinator');
    const ensembleHelper = getAgentsForUser('router_multi_user')
      .find(candidate => candidate.id === 'router_multi_helper');
    expect((ensembleCoordinator?.tools ?? []).map(toolName)).not.toContain('mcp_ensemble_helper__lookup');
    expect((ensembleHelper?.tools ?? []).map(toolName)).toContain('mcp_ensemble_helper__lookup');
  });

  it('removes named-agent delegation but preserves worker multitasking on a singleton roster', () => {
    const agent = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const names = new Set((agent?.tools ?? []).map(toolName));
    expect(agent?._rosterSolo).toBe(true);
    expect(names.has('ask_agent')).toBe(false);
    for (const name of ['spawn_worker', 'check_workers', 'stop_worker', 'report_progress']) {
      expect(names.has(name)).toBe(true);
    }
    const requestTools = agent?.tools?.find(tool => toolName(tool) === 'request_tools');
    const declaredRequestTools = getRoleManifest('coordinator', 'router_bundle_user')
      ?.tools?.find(tool => toolName(tool) === 'request_tools');
    expect(requestTools?.function?.description).toContain('spawn_worker');
    expect(requestTools?.function?.description).not.toContain('ask_agent');
    expect(requestTools?.function?.parameters).toEqual(declaredRequestTools?.function?.parameters);
    expect(declaredRequestTools?.function?.description).toContain('ask_agent');
  });

  it('preserves named-agent delegation for a real multi-agent roster', () => {
    const agent = getAgentsForUser('router_multi_user')
      .find(candidate => candidate.id === 'router_multi_coordinator');
    const names = new Set((agent?.tools ?? []).map(toolName));
    expect(agent?._rosterSolo).toBe(false);
    expect(names.has('ask_agent')).toBe(true);
    expect(names.has('spawn_worker')).toBe(true);
    const requestTools = agent?.tools?.find(tool => toolName(tool) === 'request_tools');
    expect(requestTools?.function?.description).toContain('ask_agent');
    const declaredRequestTools = getRoleManifest('coordinator', 'router_multi_user')
      ?.tools?.find(tool => toolName(tool) === 'request_tools');
    expect(requestTools).toEqual(declaredRequestTools);
  });

  it('keeps request_tools constant-size as the custom skill surface grows', () => {
    const agent = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const requestTools = agent?.tools?.find(tool => toolName(tool) === 'request_tools');
    const description = requestTools?.function?.parameters?.properties?.groups?.description ?? '';
    expect(agent?._rosterSolo).toBe(true);
    expect(description).toContain('permission-scoped user-defined skill ID');
    expect(description).not.toContain("'test-gpu'");
  });
});

describe('deterministic direct-intent rules', () => {
  const positives = [
    ['email', 'Reply to the newest message from Dana'],
    ['email', 'Open the live message with exact subject "READ NATURAL"'],
    ['email', 'Has Nora written back?'],
    ['email', 'Please correspond with Pat about the invoice'],
    ['email', 'Clear out newsletters from my mailbox'],
    ['email', 'Check my calendar, inbox, and what is playing on the TV'],
    ['gcal', 'What is on my calendar tomorrow?'],
    ['gcal', 'Am I booked after lunch?'],
    ['gcal', 'Find a free half hour with Dana tomorrow'],
    ['gcal', 'Put lunch with Maya at noon Tuesday'],
    ['gcal', 'Move our sync to Friday'],
    ['tasks', 'Remind me at 5 PM to call Mom'],
    ['tasks', 'Nudge me at six to take my pills'],
    ['tasks', "Don't let me forget the oven in twenty minutes"],
    ['tasks', 'At sunset, give me a heads-up to close the windows'],
    ['tasks', 'Keep tabs on SOL and tell me once it crosses 200'],
    ['tasks', 'Show me my to do list'],
    ['tasks', 'Add milk to my to-do list'],
    ['expenses', 'Review my expenses for overdue bills'],
    ['deep_research', 'Research the latest battery breakthroughs'],
    ['image_generator', 'Sketch a lunar rover crossing a blue desert'],
    ['image_generator', 'Make me a minimalist logo for Acme'],
    ['role_video_generator', 'Create a short video of waves at sunset'],
    ['skill-builder', 'Build a new custom skill for tracking prices'],
    ['skill-builder', 'Build a new Local Weather skill'],
    ['coder', 'Write a Python script that sorts a list'],
    ['routines', 'When I say goodnight, turn off the lights'],
    ['documents', '[Document: Notes | id: doc_abcdef123456] replace the title'],
    ['desktop', 'Read a local file on my laptop'],
    ['browser-ext', 'Read the page I am on in my browser'],
    ['mcp-admin', 'List my MCP servers'],
    ['active-agents', "How's the background task going?"],
    ['web', 'Search the web for the latest OpenEnsemble news'],
    ['web', 'Find from the official Node.js website the currently listed Active LTS release'],
    ['telegram', 'Send that update on Telegram'],
    ['profile_files', 'List my saved files'],
    ['logs', 'Show me the recent server logs'],
    ['self-mgmt', 'Remember that the lab uses port 4737'],
    ['user-admin', 'List the household users'],
    ['coordinator', 'Create a new role for media review'],
    ['role_home_assistant', 'Turn off the kitchen lights'],
    ['role_home_assistant', 'Kill the lamps downstairs'],
    ['role_home_assistant', 'Make the den cooler'],
    ['role_tv_control', 'Launch Netflix on the TV'],
    ['oe-admin', 'Check the OpenEnsemble update status'],
    ['oe-admin', 'Switch my LLM provider to the backup account'],
  ];

  for (const [skillId, prompt] of positives) {
    it(`matches ${skillId}: ${prompt}`, () => {
      expect(directMatches(prompt).has(skillId)).toBe(true);
    });
  }

  const negatives = [
    ['show me the weather report', ['role_tv_control', 'documents']],
    ['open the garage door', ['role_tv_control', 'browser-ext']],
    ['pause for a second', ['role_tv_control']],
    ['explain this compiler error message', ['email']],
    ['open the error message in the compiler', ['email']],
    ['open the chat message Dana sent', ['email']],
    ['write a Python script that sorts a list', ['role_home_assistant']],
    ['turn off notifications in the chat app', ['role_home_assistant']],
    ['handle the JavaScript click event', ['gcal']],
    ['handle the JavaScript click event', ['browser-ext']],
    ['explain the YouTube Data API', ['role_tv_control']],
    ['watch Netflix on the TV', ['tasks']],
    ['keep tabs on SOL and tell me once it crosses 200', ['browser-ext']],
    ['grep the repo for TODO comments', ['tasks']],
    ['switch topics', ['role_home_assistant']],
    ['I got a reply from the server', ['email']],
    ['put on some light music', ['role_home_assistant']],
    ['make a video call to Dana', ['role_video_generator']],
    ['create a video playlist', ['role_video_generator']],
    ['show me the front door camera', ['role_home_assistant']],
    ['add an event listener to this button', ['gcal']],
    ['create an event emitter in JavaScript', ['gcal']],
    ['run the script', ['role_home_assistant']],
    ['summarize this climate research paper', ['role_home_assistant']],
    ['the city lights were beautiful', ['role_home_assistant']],
    ['let me know why this Python test fails', ['tasks']],
    ['is the coder still working on my task', ['tasks']],
    ['Use spawn_worker exactly once to do this in the background: find from the official Node.js website the currently listed Active LTS major release, then report one concise sentence with its official URL. Do not use email and do not make any changes. Return immediately after starting the worker so I can keep chatting.', ['tasks']],
    ['explain database transaction isolation', ['expenses']],
    ['what is our token budget', ['expenses']],
    ['match the subject as closely as the provider allows', ['oe-admin']],
    ['search the web for the latest OpenEnsemble news', ['oe-admin']],
    ['draw a conclusion from the evidence', ['image_generator']],
    ['sketch out a migration plan', ['image_generator']],
    ['illustrate the point with an example', ['image_generator']],
    ['Email the project update to Alex', ['email']],
    ['Send a note to Alex at alex@example.com', ['email']],
    ['what is 17 times 23', [..._internal.ON_DEMAND_SKILL_IDS]],
  ];

  for (const [prompt, forbidden] of negatives) {
    it(`does not false-positive: ${prompt}`, () => {
      const got = directMatches(prompt);
      expect(forbidden.filter(skillId => got.has(skillId))).toEqual([]);
    });
  }

  it('blocks software-context embedding lookalikes unless a direct entity also matches', () => {
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('role_home_assistant')?.test('turn off notifications in the chat app')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('browser-ext')?.test('handle a JavaScript click event handler')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('role_tv_control')?.test('explain the YouTube API docs')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('role_tv_control')?.test('the movie was unexpectedly moving')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('youtube-download')?.test('explain the YouTube Data API')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('youtube-download')?.test('create a short video of waves')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('gcal')?.test('will I need an umbrella this afternoon?')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('gcal')?.test('my schedule is already packed')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('expenses')?.test('what is our token budget?')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('routines')?.test('give me a heads-up at sunset')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('deep_research')?.test('find this on the official Node.js website')).toBe(true);
  });

  it('requires a domain anchor before expanding an ambiguous custom-skill tie', () => {
    const planner = {
      id: 'synthx_marathon',
      name: 'Race Training Plan',
      description: 'Tracks race training and weekly mileage.',
      intent_examples: ['plan my next marathon training session', 'show my running plan'],
    };
    const pantry = {
      id: 'synthx_pantry_pro',
      name: 'Pantry Inventory Pro',
      description: 'Tracks pantry staples, quantities, and expiration dates.',
      intent_examples: ['am I running low on anything in the pantry pro'],
    };
    expect(_internal.customAmbiguityHasLexicalAnchor('Sketch out a migration plan.', planner)).toBe(false);
    expect(_internal.customAmbiguityHasLexicalAnchor('Am I low on anything in the pantry?', pantry)).toBe(true);
  });

  it('does not treat isolated custom-skill identity qualifiers as domain intent', () => {
    const finance = {
      id: 'personal-finance',
      name: 'Personal Finance',
      intent_examples: ['review my personal finance budget', 'show personal finance spending'],
    };
    const familyCalendar = {
      id: 'family-calendar',
      name: 'Family Calendar',
      intent_examples: ['show the family calendar', 'add this to the family calendar'],
    };
    expect(_internal.customIntentLexicalScore('send it to my personal email', finance)).toBe(0);
    expect(_internal.customIntentLexicalScore('play a family video', familyCalendar)).toBe(0);
  });

  it('requires a real manifest domain word before accepting a custom embedding hit', () => {
    const flight = {
      id: 'flight-booker',
      name: 'Flight Booker',
      description: 'Searches flight options and watches saved trips for price drops.',
      intent_examples: ['find flights from Tampa', 'search flights from RSW', 'watch my trip'],
    };
    const youtube = {
      id: 'youtube-download',
      name: 'YouTube Download',
      description: 'Downloads videos and finds uploads from saved channels.',
      intent_examples: ['download a video from a channel', 'show uploads from a saved channel'],
    };
    expect(_internal.customEmbeddingHasLexicalAnchor('Anything new from the bank?', flight)).toBe(false);
    expect(_internal.customEmbeddingHasLexicalAnchor('Find this from the official Node.js website', flight)).toBe(false);
    expect(_internal.customEmbeddingHasLexicalAnchor('That script was funny', youtube)).toBe(false);
    expect(_internal.customEmbeddingHasLexicalAnchor('Find flights to Denver', flight)).toBe(true);
    expect(_internal.customEmbeddingHasLexicalAnchor('Download the latest YouTube video', youtube)).toBe(true);
    const preorderWatch = {
      id: 'pokemon-etb-preorders',
      name: 'Pokemon ETB Preorders',
      description: 'Watches Pokemon elite trainer box preorders.',
      intent_examples: [
        'notify me when Pokemon ETB preorders open',
        'email me when elite trainer boxes are available',
      ],
    };
    expect(_internal.customEmbeddingHasLexicalAnchor('Ping me when the sun goes down', preorderWatch)).toBe(false);
    expect(_internal.customEmbeddingHasLexicalAnchor('Why does auth crash when the token expires?', preorderWatch)).toBe(false);
  });
});

describe('skill-level trimming', () => {
  it('makes an explicitly named specialist-only custom skill on-demand for singleton Jarvis', async () => {
    const resolved = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const result = await trimToolsForTurn({
      agent: resolved,
      userId: 'router_bundle_user',
      userText: 'Use Test GPU to list available capacity',
    });
    expect(result.skillsKept?.has('test-gpu')).toBe(true);
    expect(result.trimmedTools.map(toolName)).toContain('test_gpu_list');
    expect(result.trimmedTools.map(toolName)).not.toContain('ask_agent');
    expect(result.trimmedTools.map(toolName)).toContain('spawn_worker');
  });

  it('keeps a web weather fallback when singleton Jarvis owns no local weather skill', async () => {
    const agent = {
      id: 'jarvis_no_local_weather',
      skillCategory: 'coordinator',
      provider: 'anthropic',
      _rosterSolo: true,
      tools: allTools(),
    };
    for (const userText of ["What's the weather tomorrow?", 'How bad is the pollen outside?']) {
      const result = await trimToolsForTurn({
        agent,
        userId: null,
        userText,
      });
      expect(result.skillsKept?.has('web'), userText).toBe(true);
      expect(result.trimmedTools.map(toolName), userText).toContain('web_search');
    }
  });

  it('prefers any matching custom weather skill while retaining web for extended conditions', async () => {
    const userId = 'router_bundle_user';
    const localWeatherTool = getRoleManifest('localweather', userId)?.tools?.[0];
    const agent = {
      id: 'jarvis_custom_weather',
      skillCategory: 'coordinator',
      provider: 'anthropic',
      _rosterSolo: true,
      tools: [...allTools(), localWeatherTool].filter(Boolean),
    };
    const ordinary = await trimToolsForTurn({
      agent, userId, userText: 'Check the weather tomorrow', source: 'web',
    });
    expect(ordinary.skillsKept?.has('localweather')).toBe(true);
    expect(ordinary.trimmedTools.map(toolName)).toContain('localweather_get_weather');
    expect(ordinary.skillsKept?.has('web')).toBe(false);
    expect(ordinary.trimmedTools.map(toolName)).not.toContain('web_search');

    const extended = await trimToolsForTurn({
      agent, userId, userText: 'Check the weather and pollen tomorrow', source: 'web',
    });
    expect(extended.skillsKept?.has('localweather')).toBe(true);
    expect(extended.skillsKept?.has('web')).toBe(true);
    expect(extended.trimmedTools.map(toolName)).toContain('web_search');
  });

  it('preserves specialist-only custom scope outside a singleton roster', async () => {
    const resolved = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const result = await trimToolsForTurn({
      agent: { ...resolved, _rosterSolo: false },
      userId: 'router_bundle_user',
      userText: 'Use Test GPU to list available capacity',
    });
    expect(result.skillsKept?.has('test-gpu')).toBe(false);
    expect(result.trimmedTools.map(toolName)).not.toContain('test_gpu_list');
  });

  it('preserves coordinator-included custom skills on a singleton primary', async () => {
    const resolved = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const result = await trimToolsForTurn({
      agent: resolved,
      userId: 'router_bundle_user',
      userText: 'Hello, how are you today?',
    });
    expect(result.trimmedTools.map(toolName)).toContain('test_legacy_status');
  });

  it('retains email_user for natural and explicit outbound delivery on a singleton primary', async () => {
    const resolved = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    for (const userText of [
      'Email Alex the project update',
      'Could you mail Mom the photos?',
      'Use email_user to send this report to Alex',
    ]) {
      const result = await trimToolsForTurn({
        agent: resolved,
        userId: 'router_bundle_user',
        userText,
      });
      const names = result.trimmedTools.map(toolName);
      expect(names, userText).toContain('email_user');
      expect(result.skillsKept?.has('email-send'), userText).toBe(true);
      expect(result.skillsKept?.has('email'), userText).toBe(false);
      for (const tool of toolsFor('email')) {
        expect(names, `${userText}: ${toolName(tool)}`).not.toContain(toolName(tool));
      }
    }
  });

  it('does not retain email_user for non-outbound mailbox or tool questions', async () => {
    const resolved = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    for (const userText of [
      'List my email accounts',
      'Read the email from Mom',
      'What email tools are available?',
      'What does the email_user tool do?',
    ]) {
      const result = await trimToolsForTurn({
        agent: resolved,
        userId: 'router_bundle_user',
        userText,
      });
      expect(result.trimmedTools.map(toolName), userText).not.toContain('email_user');
      expect(result.skillsKept?.has('email-send'), userText).toBe(false);
    }
  });

  it('keeps mailbox read tools for an open-the-live-message request', async () => {
    const agent = { id: 'router_test', skillCategory: 'coordinator', provider: 'anthropic', tools: allTools() };
    const result = await trimToolsForTurn({
      agent,
      userId: null,
      userText: 'Open the live message with exact subject "READ NATURAL" and report the end of its full body',
    });
    const keptNames = new Set(result.trimmedTools.map(toolName));
    expect(result.skillsKept?.has('email')).toBe(true);
    expect(keptNames.has('email_list')).toBe(true);
    expect(keptNames.has('email_read')).toBe(true);
  });

  it('keeps mailbox tools when inbox is one item in a compound request', async () => {
    const agent = { id: 'router_mailbox_compound', skillCategory: 'coordinator', provider: 'anthropic', tools: allTools() };
    for (const userText of [
      'Clear out newsletters from my mailbox',
      'Check my calendar, inbox, and what is playing on the TV',
    ]) {
      const result = await trimToolsForTurn({ agent, userId: null, userText });
      expect(result.skillsKept?.has('email'), userText).toBe(true);
      expect(result.trimmedTools.map(toolName), userText).toContain('email_list');
    }
  });

  it('routes a concise official-source lookup to web without custom or deep-research noise', async () => {
    const userId = 'router_bundle_user';
    const customTools = ['flight-booker', 'youtube-download']
      .flatMap(skillId => getRoleManifest(skillId, userId)?.tools ?? []);
    const agent = {
      id: 'jarvis_official_lookup',
      skillCategory: 'coordinator',
      provider: 'anthropic',
      _rosterSolo: true,
      tools: [...allTools(), ...customTools],
    };
    const userText = 'find from the official Node.js website the currently listed Active LTS major release, then write one concise sentence with its official URL';
    const result = await trimToolsForTurn({ agent, userId, userText, source: 'web' });
    const names = new Set(result.trimmedTools.map(toolName));
    expect(names.has('web_search')).toBe(true);
    expect(names.has('fetch_url')).toBe(true);
    expect(names.has('research_search')).toBe(false);
    expect(names.has('flight_search_fixture')).toBe(false);
    expect(names.has('youtube_download_fixture')).toBe(false);
    expect(result.skillsKept?.has('web')).toBe(true);
    expect(result.skillsKept?.has('coder')).toBe(false);
    expect(result.skillsKept?.has('deep_research')).toBe(false);
    expect(result.skillsKept?.has('flight-booker')).toBe(false);
    expect(result.skillsKept?.has('youtube-download')).toBe(false);
  });

  it('does not load task/watch schemas for an ordinary worker wrapper', async () => {
    const agent = {
      id: 'jarvis_background_official_lookup',
      skillCategory: 'coordinator',
      provider: 'anthropic',
      _rosterSolo: true,
      tools: allTools(),
    };
    const userText = 'Use spawn_worker exactly once to do this in the background: find from the official Node.js website the currently listed Active LTS major release, then report one concise sentence with its official URL. Do not use email and do not make any changes. Return immediately after starting the worker so I can keep chatting.';
    const result = await trimToolsForTurn({ agent, userId: null, userText, source: 'web' });
    const names = new Set(result.trimmedTools.map(toolName));
    expect(result.skillsKept?.has('web')).toBe(true);
    expect(result.skillsKept?.has('tasks')).toBe(false);
    for (const taskTool of toolsFor('tasks')) {
      expect(names.has(toolName(taskTool)), toolName(taskTool)).toBe(false);
    }
  });

  it('preserves explicitly requested deep research alongside an official source', async () => {
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_official_deep_research',
        skillCategory: 'coordinator',
        provider: 'anthropic',
        _rosterSolo: true,
        tools: allTools(),
      },
      userId: null,
      userText: 'Deep research the Node.js release landscape and verify details on the official Node.js website',
      source: 'web',
    });
    expect(result.skillsKept?.has('web')).toBe(true);
    expect(result.skillsKept?.has('deep_research')).toBe(true);
    expect(result.trimmedTools.map(toolName)).toContain('research_search');
    expect(result.trimmedTools.map(toolName)).toContain('fetch_url');
  });

  it('preserves explicit code work based on official documentation', async () => {
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_official_code_work',
        skillCategory: 'coordinator',
        provider: 'anthropic',
        _rosterSolo: true,
        tools: allTools(),
      },
      userId: null,
      userText: 'Find the official Node.js documentation, then write a JavaScript function that prints the current version',
      source: 'web',
    });
    expect(result.skillsKept?.has('web')).toBe(true);
    expect(result.skillsKept?.has('coder')).toBe(true);
    expect(result.trimmedTools.map(toolName)).toContain('coder_write_file');
  });

  it('does not run existing custom domains when their nouns describe a new skill', async () => {
    const userId = 'router_bundle_user';
    const weatherTool = getRoleManifest('localweather', userId)?.tools?.[0];
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_skill_builder_domain',
        skillCategory: 'coordinator',
        provider: 'anthropic',
        _rosterSolo: true,
        tools: [...allTools(), weatherTool].filter(Boolean),
      },
      userId,
      userText: 'Build a new Local Weather skill',
      source: 'web',
    });
    expect(result.skillsKept?.has('skill-builder')).toBe(true);
    expect(result.skillsKept?.has('localweather')).toBe(false);
    expect(result.trimmedTools.map(toolName)).not.toContain('localweather_get_weather');
  });

  it('still runs an explicitly named custom skill outside skill authoring', async () => {
    const userId = 'router_bundle_user';
    const weatherTool = getRoleManifest('localweather', userId)?.tools?.[0];
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_named_custom_domain',
        skillCategory: 'coordinator',
        provider: 'anthropic',
        _rosterSolo: true,
        tools: [...allTools(), weatherTool].filter(Boolean),
      },
      userId,
      userText: 'Use Local Weather to check tomorrow\'s forecast',
      source: 'web',
    });
    expect(result.skillsKept?.has('localweather')).toBe(true);
    expect(result.trimmedTools.map(toolName)).toContain('localweather_get_weather');
  });

  it('does not confuse generated video with the YouTube download consumer', async () => {
    const userId = 'router_bundle_user';
    const youtubeTool = getRoleManifest('youtube-download', userId)?.tools?.[0];
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_video_producer',
        skillCategory: 'coordinator',
        provider: 'anthropic',
        _rosterSolo: true,
        tools: [...allTools(), youtubeTool].filter(Boolean),
      },
      userId,
      userText: 'Create a short video of waves crashing at sunset',
      source: 'web',
    });
    expect(result.skillsKept?.has('role_video_generator')).toBe(true);
    expect(result.skillsKept?.has('youtube-download')).toBe(false);
    expect(result.trimmedTools.map(toolName)).not.toContain('youtube_download_fixture');
  });

  it('does not route a custom skill from inline payload prose', async () => {
    const userId = 'router_bundle_user';
    const localWeatherTool = getRoleManifest('localweather', userId)?.tools?.[0];
    const agent = {
      id: 'jarvis_payload_test',
      skillCategory: 'coordinator',
      _rosterSolo: true,
      tools: [...allTools(), localWeatherTool].filter(Boolean),
    };
    for (const userText of [
      'Summarize this report:\n\nCheck the weather before leaving. Sales increased afterward.',
      'Email this text:\n\nHow is the weather today? That was the survey question.',
      'Summarize this:\n\nCheck the weather before leaving.',
      'Summarize the report below:\n\nCheck the weather before leaving.',
      'Can you summarize this report:\n\nHow is the weather today?',
      'Could you please summarize this report:\n\nHow is the weather today?',
      'Email this to Dana:\n\nCheck the weather before leaving.',
      'Draft an email using this text:\n\nCheck the weather before leaving.',
      'Create a summary of the following report:\n\nCheck the weather before leaving.',
      'Summarize this report: Check the weather before leaving.',
    ]) {
      const result = await trimToolsForTurn({ agent, userId, userText, source: 'web' });
      expect(result.skillsKept?.has('localweather'), userText).toBe(false);
      expect(result.trimmedTools.map(toolName), userText).not.toContain('localweather_get_weather');
    }
    const pollenPayload = await trimToolsForTurn({
      agent,
      userId,
      userText: 'Summarize this report:\n\nPollen levels were high throughout the study.',
      source: 'web',
    });
    expect(pollenPayload.trimmedTools.map(toolName)).not.toContain('fetch_url');
    const attachedWorkflow = await trimToolsForTurn({
      agent,
      userId,
      userText: 'Summarize the attached report\n\nCheck the weather\n\nEmail the summary to me',
      source: 'web',
    });
    expect(attachedWorkflow.trimmedTools.map(toolName)).toContain('localweather_get_weather');
  });

  it('reports only skills that retain at least one worker schema', async () => {
    const agent = {
      id: 'ephemeral_worker_trace', skillCategory: 'coordinator', provider: 'anthropic',
      tools: allTools(), ephemeral: true, _rosterSolo: true,
    };
    const result = await trimToolsForTurn({
      agent,
      userId: null,
      userText: 'Use live email tools to read the exact message as closely as the provider allows',
    });
    expect([...(result.skillsKept ?? [])].sort()).toEqual(['coordinator', 'delegate', 'email']);
  });

  it('loads every directly requested skill in a multi-domain prompt', async () => {
    const agent = { id: 'router_test', skillCategory: 'coordinator', provider: 'anthropic', tools: allTools() };
    const result = await trimToolsForTurn({
      agent,
      userId: null,
      userText: 'Email my calendar agenda to me, turn off the kitchen lights, and set a reminder for 8 PM',
    });
    for (const skillId of ['gcal', 'role_home_assistant', 'tasks']) {
      expect(result.skillsKept?.has(skillId)).toBe(true);
      const keptNames = new Set(result.trimmedTools.map(toolName));
      for (const tool of toolsFor(skillId)) expect(keptNames.has(toolName(tool))).toBe(true);
    }
    expect(result.skillsKept?.has('email')).toBe(false);
    expect(result.trimmedTools.map(toolName)).toContain('email_user');
  });

  it('keeps the neutral coordinator surface small and free of on-demand skills', async () => {
    const agent = { id: 'router_test', skillCategory: 'coordinator', provider: 'anthropic', tools: allTools() };
    const result = await trimToolsForTurn({ agent, userId: null, userText: 'Hello, how are you today?' });
    const leaked = [...(result.skillsKept ?? [])]
      .filter(skillId => _internal.ON_DEMAND_SKILL_IDS.has(skillId));
    expect(leaked).toEqual([]);
    expect(result.trimmedTools.length).toBeLessThan(result.fullTools.length);
  });

  it('gives singleton Jarvis only worker controls on a neutral turn', async () => {
    const result = await scoreToolsForTurn({
      tools: allTools(), userText: 'Hello, how are you?', userId: null,
      agent: { id: 'jarvis_solo', skillCategory: 'coordinator', _rosterSolo: true },
      source: 'web', protectedSkillIds: new Set(),
    });
    const names = result.kept.map(toolName);
    for (const required of ['request_tools', 'spawn_worker', 'check_workers', 'stop_worker']) {
      expect(names).toContain(required);
    }
    for (const unrelated of [
      'ask_agent', 'report_progress', 'email_user', 'remember_fact', 'web_search',
      'read_logs', 'manage_user', 'create_agent', 'send_telegram_message',
    ]) expect(names).not.toContain(unrelated);
  });
});

describe('tool-level borrowed-bucket routing', () => {
  const borrowed = () => [
    ...toolsFor('email'),
    ...toolsFor('tasks'),
    ...toolsFor('self-mgmt'),
    ...toolsFor('desktop'),
    ...toolsFor('coordinator'),
  ];

  it('never trims primary email tools or control tools', async () => {
    const result = await scoreToolsForTurn({
      tools: borrowed(), userText: 'summarize the inbox', userId: null,
      agent: { id: 'email_test', skillCategory: 'email' }, source: 'web',
    });
    const kept = new Set(result.kept.map(toolName));
    for (const tool of toolsFor('email')) expect(kept.has(toolName(tool))).toBe(true);
    expect(kept.has('request_tools')).toBe(true);
    expect(kept.has('remember_fact')).toBe(true);
  });

  it('keeps named delegation only when the roster has another agent', async () => {
    for (const [rosterSolo, expected] of [[true, false], [false, true]]) {
      const result = await scoreToolsForTurn({
        tools: [...borrowed(), ...toolsFor('delegate')], userText: 'summarize the inbox', userId: null,
        agent: { id: 'router_test', skillCategory: 'coordinator', _rosterSolo: rosterSolo },
        source: 'web', protectedSkillIds: new Set(['email']),
      });
      expect(new Set(result.kept.map(toolName)).has('ask_agent')).toBe(expected);
    }
  });

  it('drops borrowed task, desktop, and self-management admin buckets on neutral turns', async () => {
    const result = await scoreToolsForTurn({
      tools: borrowed(), userText: 'summarize the inbox', userId: null,
      agent: { id: 'email_test', skillCategory: 'email' }, source: 'web',
    });
    const kept = new Set(result.kept.map(toolName));
    expect(kept.has('set_reminder')).toBe(false);
    expect(kept.has('desktop_read_file')).toBe(false);
    expect(kept.has('skill_add_rule')).toBe(false);
  });

  it('does not preserve a borrowed task bucket for ordinary infinitive "to do" wording', async () => {
    const result = await scoreToolsForTurn({
      tools: borrowed(),
      userText: 'Use spawn_worker exactly once to do this in the background: find from the official Node.js website the currently listed Active LTS major release, then report one concise sentence with its official URL.',
      userId: null,
      agent: { id: 'router_background_lookup', skillCategory: 'coordinator', _rosterSolo: true },
      source: 'web',
    });
    const kept = new Set(result.kept.map(toolName));
    expect(kept.has('set_reminder')).toBe(false);
    expect(kept.has('schedule_task')).toBe(false);
    expect(kept.has('create_watch')).toBe(false);
  });

  it('restores each borrowed bucket only for its matching directive or origin', async () => {
    const cases = [
      ['remind me at five', 'web', 'set_reminder'],
      ['add a rule for this agent', 'web', 'skill_add_rule'],
      ['read a local file on my laptop', 'web', 'desktop_read_file'],
      ['summarize the inbox', 'desktop-app', 'desktop_read_file'],
    ];
    for (const [userText, source, expectedTool] of cases) {
      const result = await scoreToolsForTurn({
        tools: borrowed(), userText, userId: null,
        agent: { id: 'email_test', skillCategory: 'email' }, source,
      });
      expect(new Set(result.kept.map(toolName)).has(expectedTool), `${userText} -> ${expectedTool}`).toBe(true);
    }
  });

  it('does not re-trim a bucket skill already admitted by coordinator intent', async () => {
    const result = await scoreToolsForTurn({
      tools: borrowed(),
      userText: 'Keep tabs on SOL and tell me once it crosses 200',
      userId: null,
      agent: { id: 'router_test', skillCategory: 'coordinator' },
      source: 'web',
      protectedSkillIds: new Set(['tasks']),
    });
    const kept = new Set(result.kept.map(toolName));
    for (const tool of toolsFor('tasks')) expect(kept.has(toolName(tool))).toBe(true);
  });

  it('scopes an ephemeral worker to recovery, progress, and its matched task skill', async () => {
    const result = await scoreToolsForTurn({
      tools: allTools(),
      userText: 'Use live email tools to open the exact mailbox message',
      userId: null,
      agent: { id: 'ephemeral_worker_test', skillCategory: 'coordinator', ephemeral: true },
      source: 'web',
      protectedSkillIds: new Set(['email']),
    });
    const kept = new Set(result.kept.map(toolName));
    for (const tool of toolsFor('email')) expect(kept.has(toolName(tool))).toBe(true);
    expect(kept.has('request_tools')).toBe(true);
    expect(kept.has('report_progress')).toBe(true);
    for (const unrelated of [
      'ask_agent', 'spawn_worker', 'create_agent', 'manage_user', 'read_logs',
      'web_search', 'send_telegram_message', 'remember_fact', 'email_user',
      'restart_server',
    ]) expect(kept.has(unrelated), unrelated).toBe(false);
  });

  it('keeps a detached specialist worker\'s primary email tools without classifier protection', async () => {
    const result = await scoreToolsForTurn({
      tools: allTools(),
      userText: 'Open and triage the exact mailbox message',
      userId: null,
      agent: {
        id: 'ephemeral_worker_1700000000000_ab123_email_agent',
        skillCategory: 'email',
        ephemeral: true,
      },
      source: 'web',
      protectedSkillIds: new Set(),
    });
    const kept = new Set(result.kept.map(toolName));
    for (const tool of toolsFor('email')) expect(kept.has(toolName(tool))).toBe(true);
    expect(kept.has('request_tools')).toBe(true);
    expect(kept.has('report_progress')).toBe(true);
    const emailToolNames = new Set(toolsFor('email').map(toolName));
    expect(result.decisions
      .filter(decision => emailToolNames.has(decision.name))
      .every(decision => decision.reason === 'worker-primary-skill')).toBe(true);
  });

  it('does not mistake an ephemeral ask_agent specialist for a detached worker', async () => {
    const result = await trimToolsForTurn({
      userText: 'Use live email tools to open the exact mailbox message',
      userId: null,
      agent: {
        id: 'ephemeral_deleg_d1_1700000000000_ab123_email_agent',
        skillCategory: 'email',
        ephemeral: true,
        tools: allTools(),
      },
      source: 'web',
    });
    const kept = new Set(result.trimmedTools.map(toolName));
    for (const tool of toolsFor('email')) expect(kept.has(toolName(tool))).toBe(true);
    expect(kept.has('email_user')).toBe(true);
    expect(result.toolDecisions?.some(decision => decision.reason === 'worker-scope-drop')).toBe(false);
  });
});

describe('dynamic MCP tool trimming and recovery', () => {
  const githubCreate = mcpTool('github', 'create_issue', 'Create an issue in a repository.');
  const githubList = mcpTool('github', 'list_issues', 'List repository issues.');
  const githubPr = mcpTool('github', 'create_pull_request', 'Open a pull request for a branch.');
  const slackSend = mcpTool('slack', 'post_channel_message', 'Post a message to a Slack channel.');

  it('keeps only operation-relevant MCP schemas on the initial turn', async () => {
    const requestTools = toolsFor('coordinator').find(t => toolName(t) === 'request_tools');
    const fullTools = [requestTools, githubCreate, githubList, githubPr, slackSend].filter(Boolean);
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_mcp_test',
        skillCategory: 'coordinator',
        _rosterSolo: true,
        tools: fullTools,
      },
      userText: 'Create a GitHub issue about the broken release build',
      userId: null,
      source: 'web',
    });
    const kept = new Set(result.trimmedTools.map(toolName));
    expect(kept.has('request_tools')).toBe(true);
    expect(kept.has(toolName(githubCreate))).toBe(true);
    expect(kept.has(toolName(githubList))).toBe(false);
    expect(kept.has(toolName(githubPr))).toBe(false);
    expect(kept.has(toolName(slackSend))).toBe(false);
    expect(result.skillsKept).toContain('mcp:github');
  });

  it('keeps the stable floor flat as unrelated MCP schemas grow', async () => {
    const requestTools = toolsFor('coordinator').find(t => toolName(t) === 'request_tools');
    const dynamic = Array.from({ length: 250 }, (_, index) =>
      mcpTool(`server_${Math.floor(index / 10)}`, `operation_${index}`, `Perform domain ${index} maintenance.`));
    const fullTools = [requestTools, ...dynamic].filter(Boolean);
    const result = await trimToolsForTurn({
      agent: {
        id: 'jarvis_mcp_growth_test',
        skillCategory: 'coordinator',
        _rosterSolo: true,
        tools: fullTools,
      },
      userText: 'Email my weekly status update',
      userId: null,
      source: 'web',
    });
    expect(result.trimmedTools.map(toolName)).toEqual(['request_tools']);
  });

  it('recovers a narrow MCP operation from reason alongside a built-in domain', async () => {
    const requestTools = toolsFor('coordinator').find(t => toolName(t) === 'request_tools');
    const emailTools = toolsFor('email');
    const emailSendTools = toolsFor('email-send');
    const fullTools = [requestTools, ...emailTools, ...emailSendTools, githubCreate, githubList, githubPr, slackSend].filter(Boolean);
    const agent = { tools: [requestTools], _rosterSolo: true };
    const result = await expandToolsByReason({
      agent,
      fullTools,
      reason: 'Create a GitHub issue and email me the result',
      groups: null,
      userId: null,
      alreadyIncludedSkills: new Set(),
    });
    expect(result.addedSkills).toContain('email-send');
    expect(result.addedSkills).not.toContain('email');
    expect(result.addedSkills).toContain('mcp:github');
    expect(result.addedToolNames).toContain('email_user');
    expect(result.addedToolNames).toContain(toolName(githubCreate));
    expect(result.addedToolNames).not.toContain(toolName(githubPr));
    expect(result.addedToolNames).not.toContain(toolName(slackSend));
  });

  it('loads one complete MCP server only when explicitly requested', async () => {
    const requestTools = toolsFor('coordinator').find(t => toolName(t) === 'request_tools');
    const fullTools = [requestTools, githubCreate, githubList, githubPr, slackSend].filter(Boolean);
    const agent = { tools: [requestTools], _rosterSolo: true };
    const result = await expandToolsByReason({
      agent,
      fullTools,
      reason: 'I need repository tools',
      groups: ['mcp:github'],
      userId: null,
      alreadyIncludedSkills: new Set(),
    });
    expect(result.addedSkills).toEqual(['mcp:github']);
    expect(new Set(result.addedToolNames)).toEqual(new Set([
      toolName(githubCreate), toolName(githubList), toolName(githubPr),
    ]));
    expect(result.addedToolNames).not.toContain(toolName(slackSend));
  });

  it('recovers the missing remainder of an initially partial MCP server', async () => {
    const requestTools = toolsFor('coordinator').find(t => toolName(t) === 'request_tools');
    const fullTools = [requestTools, githubCreate, githubList, githubPr].filter(Boolean);
    const agent = { tools: [requestTools, githubCreate], _rosterSolo: true };
    const result = await expandToolsByReason({
      agent,
      fullTools,
      reason: null,
      groups: ['mcp:github'],
      userId: null,
      alreadyIncludedSkills: new Set(['mcp:github']),
    });
    expect(new Set(result.addedToolNames)).toEqual(new Set([
      toolName(githubList), toolName(githubPr),
    ]));
    expect(result.addedSkills).toEqual(['mcp:github']);
  });
});

describe('request_tools recovery', () => {
  it('recovers only web for a concise official-source lookup', async () => {
    const userId = 'router_bundle_user';
    const customTools = ['flight-booker', 'youtube-download']
      .flatMap(skillId => getRoleManifest(skillId, userId)?.tools ?? []);
    const fullTools = [...allTools(), ...customTools];
    const requestTools = fullTools.find(tool => toolName(tool) === 'request_tools');
    const agent = { tools: [requestTools].filter(Boolean), _rosterSolo: true };
    const result = await expandToolsByReason({
      agent,
      fullTools,
      reason: 'find from the official Node.js website the currently listed Active LTS major release, then write one concise sentence with its official URL',
      groups: null,
      userId,
      alreadyIncludedSkills: new Set(),
    });
    expect(result.addedSkills).toEqual(['web']);
    expect(result.addedToolNames).toContain('web_search');
    expect(result.addedToolNames).toContain('fetch_url');
    expect(result.addedToolNames).not.toContain('research_search');
    expect(result.addedToolNames).not.toContain('flight_search_fixture');
    expect(result.addedToolNames).not.toContain('youtube_download_fixture');
  });

  it('recovers coder when an official-source request includes real code work', async () => {
    const fullTools = allTools();
    const requestTools = fullTools.find(tool => toolName(tool) === 'request_tools');
    const agent = { tools: [requestTools].filter(Boolean), _rosterSolo: true };
    const result = await expandToolsByReason({
      agent,
      fullTools,
      reason: 'Find the official Node.js documentation, then write a JavaScript function that prints the current version',
      groups: null,
      userId: null,
      alreadyIncludedSkills: new Set(),
    });
    expect(result.addedSkills).toContain('web');
    expect(result.addedSkills).toContain('coder');
    expect(result.addedToolNames).toContain('web_search');
    expect(result.addedToolNames).toContain('coder_write_file');
  });

  it('recovers a singleton-only custom group by explicit id and exact-name reason', async () => {
    const resolved = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const requestTools = resolved.tools.find(tool => toolName(tool) === 'request_tools');
    for (const args of [
      { groups: ['test-gpu'], reason: null },
      { groups: null, reason: 'Use Test GPU to list available capacity' },
    ]) {
      const agent = { tools: [requestTools], _rosterSolo: true };
      const result = await expandToolsByReason({
        agent,
        fullTools: resolved.tools,
        ...args,
        userId: 'router_bundle_user',
        alreadyIncludedSkills: new Set(),
      });
      expect(result.addedSkills).toContain('test-gpu');
      expect(result.addedToolNames).toContain('test_gpu_list');
    }
  });

  it('explicitly recovers every toolful built-in on-demand group', async () => {
    const fullTools = allTools();
    const failures = [];
    for (const skillId of _internal.ON_DEMAND_SKILL_IDS) {
      const expected = toolsFor(skillId).map(toolName).filter(Boolean);
      if (!expected.length) continue;
      const agent = { tools: fullTools.filter(t => toolName(t) === 'request_tools') };
      const result = await expandToolsByReason({
        agent, fullTools, groups: [skillId], reason: null,
        userId: null, alreadyIncludedSkills: new Set(),
      });
      const added = new Set(result.addedToolNames);
      const missing = expected.filter(name => !added.has(name));
      if (missing.length || !result.addedSkills.includes(skillId)) failures.push({ skillId, missing });
    }
    expect(failures).toEqual([]);
  });

  it('recovers the missing remainder of a partially visible skill without duplicates', async () => {
    const fullTools = allTools();
    const firstEmailTool = toolsFor('email')[0];
    const agent = { tools: [
      toolsFor('coordinator').find(t => toolName(t) === 'request_tools'),
      firstEmailTool,
    ].filter(Boolean) };
    const result = await expandToolsByReason({
      agent, fullTools, groups: ['email'], reason: null,
      userId: null, alreadyIncludedSkills: new Set(),
    });
    expect(result.addedToolNames).not.toContain(toolName(firstEmailTool));
    expect(new Set(agent.tools.map(toolName)).size).toBe(agent.tools.length);
    expect(toolsFor('email').every(t => agent.tools.some(a => toolName(a) === toolName(t)))).toBe(true);
  });

  it('ignores unknown groups and is idempotent on repeated expansion', async () => {
    const fullTools = allTools();
    const agent = { tools: fullTools.filter(t => toolName(t) === 'request_tools') };
    const unknown = await expandToolsByReason({
      agent, fullTools, groups: ['not-a-real-skill'], reason: null,
      userId: null, alreadyIncludedSkills: new Set(),
    });
    expect(unknown).toEqual({ addedToolNames: [], addedSkills: [] });
    await expandToolsByReason({ agent, fullTools, groups: ['email'], reason: null, userId: null, alreadyIncludedSkills: new Set() });
    const repeat = await expandToolsByReason({ agent, fullTools, groups: ['email'], reason: null, userId: null, alreadyIncludedSkills: new Set() });
    expect(repeat).toEqual({ addedToolNames: [], addedSkills: [] });
  });

  it('lets a valid explicit group override an unrelated reason embedding', async () => {
    // Ported from the fork using `expenses` instead of `image_generator`:
    // stock's image_generator manifest ships no tools (the fork's generator
    // rebuild is out of scope), and this case only needs SOME on-demand
    // skill with real tools to prove explicit groups beat the reason text.
    const fullTools = allTools();
    const agent = { tools: fullTools.filter(t => toolName(t) === 'request_tools') };
    const result = await expandToolsByReason({
      agent, fullTools,
      groups: ['expenses'],
      reason: 'save a generated image into my desktop sandbox',
      userId: null,
      alreadyIncludedSkills: new Set(),
    });
    expect(result.addedSkills).toEqual(['expenses']);
    expect(toolsFor('expenses').every(t => agent.tools.some(a => toolName(a) === toolName(t)))).toBe(true);
    expect(agent.tools.some(t => toolName(t).startsWith('desktop_'))).toBe(false);
  });

  it('recovers every deterministic skill in a multi-domain reason', async () => {
    const fullTools = allTools();
    const agent = { tools: fullTools.filter(t => toolName(t) === 'request_tools') };
    const result = await expandToolsByReason({
      agent,
      fullTools,
      groups: null,
      reason: 'Research the latest battery breakthroughs, review my expenses, and email me a report',
      userId: null,
      alreadyIncludedSkills: new Set(),
    });
    expect(new Set(result.addedSkills)).toEqual(new Set(['deep_research', 'expenses', 'email-send']));
    for (const skillId of ['deep_research', 'expenses', 'email-send']) {
      expect(toolsFor(skillId).every(t => agent.tools.some(a => toolName(a) === toolName(t)))).toBe(true);
    }
    expect(toolsFor('email').some(t => agent.tools.some(a => toolName(a) === toolName(t)))).toBe(false);
  });

  it('works through AsyncLocalStorage and the real coordinator executor', async () => {
    const fullTools = allTools();
    const agent = { tools: fullTools.filter(t => toolName(t) === 'request_tools') };
    const store = {
      agent, fullTools, initiallyIncludedSkills: new Set(), addedSkills: new Set(),
    };
    const events = await toolRouterContext.run(store, () =>
      collect(executeCoordinatorTool('request_tools', { groups: ['email'] }, null, 'router_test')),
    );
    expect(store.addedSkills.has('email')).toBe(true);
    expect(toolsFor('email').every(t => agent.tools.some(a => toolName(a) === toolName(t)))).toBe(true);
    expect(events.at(-1)?.text).toMatch(/^Added \d+ tool\(s\) from email:/);
  });

  it('completes model -> request_tools -> refreshed provider schema -> email action end to end', async () => {
    const fullTools = allTools();
    const requestTools = fullTools.find(t => toolName(t) === 'request_tools');
    const agent = {
      id: 'router_e2e',
      provider: 'anthropic',
      model: 'claude-router-test',
      maxToolLoops: 6,
      tools: requestTools ? [requestTools] : [],
    };
    const store = {
      agent, fullTools, initiallyIncludedSkills: new Set(), addedSkills: new Set(),
    };
    const requestBodies = [];
    let call = 0;
    const oldKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'router-test-key';
    vi.stubGlobal('fetch', async (_url, opts) => {
      requestBodies.push(JSON.parse(opts.body));
      call++;
      if (call === 1) return anthropicToolUse('request_tools', { groups: ['email'] }, 'tool_request');
      if (call === 2) return anthropicToolUse('email_list_accounts', {}, 'tool_email');
      return anthropicText('Email tools loaded and the account check completed safely.');
    });

    try {
      const events = await toolRouterContext.run(store, () => collect(streamAnthropic(
        agent,
        'You are a router integration test.',
        [{ role: 'user', content: 'Use email, loading its tools if needed.' }],
        AbortSignal.timeout(5000),
        'router-e2e-user',
      )));

      const bodyToolNames = body => (body.tools ?? []).map(t => t.name).filter(Boolean);
      expect(requestBodies).toHaveLength(3);
      expect(bodyToolNames(requestBodies[0])).toContain('request_tools');
      expect(bodyToolNames(requestBodies[0])).not.toContain('email_list_accounts');
      expect(bodyToolNames(requestBodies[1])).toContain('email_list_accounts');
      expect(bodyToolNames(requestBodies[2])).toContain('email_list_accounts');
      expect(store.addedSkills.has('email')).toBe(true);
      expect(events.filter(e => e.type === 'tool_call').map(e => e.name)).toEqual(['request_tools', 'email_list_accounts']);
      const modelCalls = events.filter(event => event.type === '__model_call');
      expect(modelCalls).toHaveLength(3);
      requestBodies.forEach((body, index) => {
        expectModelCallMatchesBody(modelCalls[index], body, { provider: 'anthropic', round: index + 1 });
      });
      expect(events.find(e => e.type === 'tool_result' && e.name === 'email_list_accounts')?.text).toMatch(/No email accounts connected/);
      expect(events.filter(e => e.type === 'token').map(e => e.text).join('')).toContain('account check completed safely');
    } finally {
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldKey;
      vi.unstubAllGlobals();
    }
  });
});

describe('provider loops refresh their schema after request_tools', () => {
  it('records the exact empty tool surface for LM Studio native dispatch', async () => {
    const requestBodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      requestBodies.push(JSON.parse(opts.body));
      return new Response([
        `data: ${JSON.stringify({ type: 'message.delta', content: 'done' })}\n`,
        `data: ${JSON.stringify({ type: 'chat.end', response_id: 'native_trace_response' })}\n`,
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    try {
      const events = await collect(streamLMStudio(
        { id: 'router_lmstudio_native_trace', provider: 'lmstudio', model: 'native-model', tools: [] },
        'router test',
        [{ role: 'user', content: 'hello' }],
        AbortSignal.timeout(5000),
        'router-provider-user',
      ));
      expect(requestBodies).toHaveLength(1);
      const modelCalls = events.filter(event => event.type === '__model_call');
      expect(modelCalls).toHaveLength(1);
      expectModelCallMatchesBody(modelCalls[0], requestBodies[0], { provider: 'lmstudio', round: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const cases = [
    {
      name: 'OpenAI-compatible chat',
      envKey: 'DEEPSEEK_API_KEY',
      provider: 'deepseek',
      model: 'deepseek-chat',
      first: () => openAiToolUse('request_tools', { groups: ['email'] }),
      second: () => openAiText('done'),
      stream: (agent, signal) => streamOpenAICompat('deepseek', agent, 'router test', [{ role: 'user', content: 'check email' }], signal, 'router-provider-user'),
    },
    {
      name: 'LM Studio compatibility',
      provider: 'lmstudio',
      model: 'local-tool-model',
      first: () => openAiToolUse('request_tools', { groups: ['email'] }),
      second: () => openAiText('done'),
      stream: (agent, signal) => streamLMStudioCompat(agent, 'router test', [{ role: 'user', content: 'check email' }], signal, 'router-provider-user'),
    },
    {
      name: 'OpenRouter',
      envKey: 'OPENROUTER_API_KEY',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      first: () => openAiToolUse('request_tools', { groups: ['email'] }),
      second: () => openAiText('done'),
      stream: (agent, signal) => streamOpenRouter(agent, 'router test', [{ role: 'user', content: 'check email' }], signal, 'router-provider-user'),
    },
    {
      name: 'Ollama',
      provider: 'ollama',
      model: 'local-tool-model',
      first: () => ollamaToolUse('request_tools', { groups: ['email'] }),
      second: () => ollamaText('done'),
      stream: (agent, signal) => streamOllama(agent, 'router test', [{ role: 'user', content: 'check email' }], signal, 'router-provider-user'),
    },
    {
      name: 'Responses API',
      envKey: 'GROK_API_KEY',
      provider: 'grok',
      model: 'grok-4-fast',
      first: () => responsesToolUse('request_tools', { groups: ['email'] }),
      second: () => responsesText('done'),
      stream: (agent, signal) => streamOpenAIResponses(agent, 'router test', [{ role: 'user', content: 'check email' }], signal, 'router-provider-user'),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} re-reads agent.tools on the next model call`, async () => {
      const fullTools = allTools();
      const requestTools = fullTools.find(t => toolName(t) === 'request_tools');
      const agent = {
        id: `router_${testCase.provider}`,
        provider: testCase.provider,
        model: testCase.model,
        maxToolLoops: 4,
        tools: requestTools ? [requestTools] : [],
      };
      const store = { agent, fullTools, initiallyIncludedSkills: new Set(), addedSkills: new Set() };
      const requestBodies = [];
      let call = 0;
      const oldEnv = testCase.envKey ? process.env[testCase.envKey] : undefined;
      if (testCase.envKey) process.env[testCase.envKey] = 'router-test-key';
      vi.stubGlobal('fetch', async (_url, opts) => {
        requestBodies.push(JSON.parse(opts.body));
        call++;
        return call === 1 ? testCase.first() : testCase.second();
      });

      try {
        const events = await toolRouterContext.run(store, () =>
          collect(testCase.stream(agent, AbortSignal.timeout(5000))));
        const schemaNames = body => (body.tools ?? [])
          .map(tool => tool.function?.name ?? tool.name)
          .filter(Boolean);
        expect(requestBodies).toHaveLength(2);
        expect(schemaNames(requestBodies[0])).toContain('request_tools');
        expect(schemaNames(requestBodies[0])).not.toContain('email_list_accounts');
        expect(schemaNames(requestBodies[1])).toContain('email_list_accounts');
        expect(store.addedSkills.has('email')).toBe(true);
        expect(events.some(event => event.type === 'tool_call' && event.name === 'request_tools')).toBe(true);
        const modelCalls = events.filter(event => event.type === '__model_call');
        expect(modelCalls).toHaveLength(2);
        requestBodies.forEach((body, index) => {
          expectModelCallMatchesBody(modelCalls[index], body, {
            provider: testCase.provider === 'grok' ? 'grok' : testCase.provider,
            round: index + 1,
          });
        });
      } finally {
        if (testCase.envKey) {
          if (oldEnv === undefined) delete process.env[testCase.envKey];
          else process.env[testCase.envKey] = oldEnv;
        }
        vi.unstubAllGlobals();
      }
    });
  }
});
