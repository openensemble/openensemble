import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  expandToolsByReason,
  scoreToolsForTurn,
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
import { streamLMStudioCompat } from '../chat/providers/lmstudio.mjs';
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
    skills: ['coordinator', 'coder', 'test-gpu'],
  }));
  writeFileSync(path.join(fixtureUserDir, 'agents.json'), JSON.stringify([{
    id: 'jarvis_bundle_test',
    name: 'Jarvis Test',
    ownerId: fixtureUserId,
    provider: 'anthropic',
    model: 'router-test',
    toolSet: 'web',
    systemPrompt: 'Router test agent.',
  }]));
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
  loadRoleManifests();
});

function toolName(tool) {
  return tool?.function?.name ?? tool?.name ?? '';
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

  it('documents every permission-scoped custom recovery group on request_tools', () => {
    const agent = getAgentsForUser('router_bundle_user')
      .find(candidate => candidate.id === 'jarvis_bundle_test');
    const requestTools = agent?.tools?.find(tool => toolName(tool) === 'request_tools');
    const description = requestTools?.function?.parameters?.properties?.groups?.description ?? '';
    expect(agent?._rosterSolo).toBe(true);
    expect(description).toContain("'test-gpu'");
  });
});

describe('deterministic direct-intent rules', () => {
  const positives = [
    ['email', 'Email the project update to Shawn'],
    ['email', 'Reply to the newest message from Dana'],
    ['email', 'Open the live message with exact subject "READ NATURAL"'],
    ['email', 'Has Nora written back?'],
    ['email', 'Please correspond with Pat about the invoice'],
    ['email', 'Send a note to Alex at alex@example.com'],
    ['gcal', 'What is on my calendar tomorrow?'],
    ['gcal', 'Am I booked after lunch?'],
    ['gcal', 'Find a free half hour with Dana tomorrow'],
    ['gcal', 'Put lunch with Maya at noon Tuesday'],
    ['gcal', 'Move our sync to Friday'],
    ['tasks', 'Remind me at 5 PM to call Mom'],
    ['tasks', 'Nudge me at six to take my pills'],
    ['tasks', "Don't let me forget the oven in twenty minutes"],
    ['tasks', 'At sunset, give me a heads-up to close the windows'],
    ['expenses', 'Review my expenses for overdue bills'],
    ['deep_research', 'Research the latest battery breakthroughs'],
    ['image_generator', 'Sketch a lunar rover crossing a blue desert'],
    ['image_generator', 'Make me a minimalist logo for Acme'],
    ['role_video_generator', 'Create a short video of waves at sunset'],
    ['skill-builder', 'Build a new custom skill for tracking prices'],
    ['coder', 'Write a Python script that sorts a list'],
    ['routines', 'When I say goodnight, turn off the lights'],
    ['documents', '[Document: Notes | id: doc_abcdef123456] replace the title'],
    ['desktop', 'Read a local file on my laptop'],
    ['browser-ext', 'Read the page I am on in my browser'],
    ['mcp-admin', 'List my MCP servers'],
    ['active-agents', "How's the background task going?"],
    ['role_home_assistant', 'Turn off the kitchen lights'],
    ['role_home_assistant', 'Kill the lamps downstairs'],
    ['role_home_assistant', 'Make the den cooler'],
    ['role_tv_control', 'Launch Netflix on the TV'],
    ['oe-admin', 'Check the OpenEnsemble update status'],
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
    ['explain database transaction isolation', ['expenses']],
    ['what is our token budget', ['expenses']],
    ['draw a conclusion from the evidence', ['image_generator']],
    ['sketch out a migration plan', ['image_generator']],
    ['illustrate the point with an example', ['image_generator']],
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
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('youtube-download')?.test('explain the YouTube Data API')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('gcal')?.test('will I need an umbrella this afternoon?')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('expenses')?.test('what is our token budget?')).toBe(true);
    expect(_internal.EMBED_INTENT_BLOCK_RULES.get('routines')?.test('give me a heads-up at sunset')).toBe(true);
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

  it('loads every directly requested skill in a multi-domain prompt', async () => {
    const agent = { id: 'router_test', skillCategory: 'coordinator', provider: 'anthropic', tools: allTools() };
    const result = await trimToolsForTurn({
      agent,
      userId: null,
      userText: 'Email my calendar agenda to me, turn off the kitchen lights, and set a reminder for 8 PM',
    });
    for (const skillId of ['email', 'gcal', 'role_home_assistant', 'tasks']) {
      expect(result.skillsKept?.has(skillId)).toBe(true);
      const keptNames = new Set(result.trimmedTools.map(toolName));
      for (const tool of toolsFor(skillId)) expect(keptNames.has(toolName(tool))).toBe(true);
    }
  });

  it('keeps the neutral coordinator surface small and free of on-demand skills', async () => {
    const agent = { id: 'router_test', skillCategory: 'coordinator', provider: 'anthropic', tools: allTools() };
    const result = await trimToolsForTurn({ agent, userId: null, userText: 'Hello, how are you today?' });
    const leaked = [...(result.skillsKept ?? [])]
      .filter(skillId => _internal.ON_DEMAND_SKILL_IDS.has(skillId));
    expect(leaked).toEqual([]);
    expect(result.trimmedTools.length).toBeLessThan(result.fullTools.length);
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
});

describe('request_tools recovery', () => {
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
    expect(new Set(result.addedSkills)).toEqual(new Set(['deep_research', 'expenses', 'email']));
    for (const skillId of ['deep_research', 'expenses', 'email']) {
      expect(toolsFor(skillId).every(t => agent.tools.some(a => toolName(a) === toolName(t)))).toBe(true);
    }
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
