import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import executeImage, { __test as imageTest } from './skills/image_generator/execute.mjs';
import executeVideo, { __test as videoTest, watcherHandlers } from './skills/role_video_generator/execute.mjs';
import {
  drainIteratorIncludingBoundary,
  buildSkillExecutionContextForTest,
  loadRoleManifests,
  getRoleAssignments,
  resolveWatcherRegistrationAgentId,
  resolveAgentTools,
} from './roles.mjs';
import { shouldUseProviderHostedImageBackend, trimToolsForTurn } from './lib/tool-router.mjs';
import {
  applyProviderHostedImageTool,
  saveImageGenerationResult,
  toResponsesTools,
} from './chat/providers/openai-responses.mjs';
import { normalizeToolResult } from './lib/tool-error.mjs';
import { CFG_PATH, getUserFilesDir, SKILLS_DIR, USERS_DIR } from './lib/paths.mjs';
import { loadSession } from './sessions.mjs';

const USER_ID = 'single_media_capability_user';
const PRIMARY_ID = 'single_media_primary';
const IMAGE_AGENT_ID = 'single_media_image_parked';
const VIDEO_AGENT_ID = 'single_media_video_parked';
const USER_DIR = path.join(USERS_DIR, USER_ID);
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function toolNames(tools) {
  return tools.map(tool => tool?.function?.name ?? tool?.name).filter(Boolean);
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

beforeAll(() => {
  const sourceSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'skills');
  rmSync(SKILLS_DIR, { recursive: true, force: true });
  symlinkSync(sourceSkills, SKILLS_DIR, 'dir');
  loadRoleManifests();
});

beforeEach(() => {
  mkdirSync(USER_DIR, { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify({
    enabledProviders: { fireworks: true, grok: true },
    skillAssignments: {},
  }));
  writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify({
    id: USER_ID,
    role: 'user',
    skills: ['coordinator', 'image_generator', 'role_video_generator'],
    skillAssignments: {
      coordinator: PRIMARY_ID,
      image_generator: IMAGE_AGENT_ID,
      role_video_generator: VIDEO_AGENT_ID,
    },
    orchestration: { mode: 'single', primaryAgentId: PRIMARY_ID },
  }));
  writeFileSync(path.join(USER_DIR, 'agents.json'), JSON.stringify([
    {
      id: PRIMARY_ID,
      ownerId: USER_ID,
      name: 'Primary',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      skillCategory: 'coordinator',
    },
    {
      id: IMAGE_AGENT_ID,
      ownerId: USER_ID,
      name: 'Parked Image Provider',
      provider: 'fireworks',
      model: 'flux-1-schnell-fp8',
      aspectRatio: '3:2',
      skillCategory: 'image_generator',
    },
    {
      id: VIDEO_AGENT_ID,
      ownerId: USER_ID,
      name: 'Parked Video Provider',
      provider: 'grok',
      model: 'grok-imagine-video',
      skillCategory: 'role_video_generator',
    },
  ]));
  process.env.FIREWORKS_API_KEY = 'test-fireworks-key';
  process.env.GROK_API_KEY = 'test-grok-key';
  delete process.env.OPENENSEMBLE_LAB;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIREWORKS_API_KEY;
  delete process.env.GROK_API_KEY;
  delete process.env.OPENENSEMBLE_LAB;
  rmSync(USER_DIR, { recursive: true, force: true });
});

describe('single-primary media capabilities', () => {
  it('projects both media skills onto a non-media primary and routes their real tools by intent', async () => {
    const assignments = getRoleAssignments(USER_ID);
    expect(assignments.image_generator).toBe(PRIMARY_ID);
    expect(assignments.role_video_generator).toBe(PRIMARY_ID);

    const fullTools = resolveAgentTools(
      'coordinator',
      ['coordinator', 'image_generator', 'role_video_generator'],
      PRIMARY_ID,
      USER_ID,
    );
    expect(toolNames(fullTools)).toEqual(expect.arrayContaining(['generate_image', 'generate_video']));

    const primary = {
      id: PRIMARY_ID,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      skillCategory: 'coordinator',
      _rosterSolo: true,
      tools: fullTools,
    };
    const imageTurn = await trimToolsForTurn({
      agent: primary,
      userText: 'Generate an image of a red fox in moonlight.',
      userId: USER_ID,
    });
    const videoTurn = await trimToolsForTurn({
      agent: primary,
      userText: 'Create a short video of waves at sunset.',
      userId: USER_ID,
    });

    expect(toolNames(imageTurn.trimmedTools)).toContain('generate_image');
    expect(toolNames(videoTurn.trimmedTools)).toContain('generate_video');
    expect(primary).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('executes image generation through the raw parked media assignment, not the primary provider', async () => {
    expect(imageTest.selectBackend(USER_ID, 'fast')).toEqual({
      provider: 'fireworks',
      model: 'flux-1-schnell-fp8',
      aspectRatio: '3:2',
    });

    const fetchSpy = vi.fn(async (url, options) => {
      expect(String(url)).toContain('/flux-1-schnell-fp8/text_to_image');
      expect(options.headers.Authorization).toBe('Bearer test-fireworks-key');
      expect(JSON.parse(options.body)).toMatchObject({ prompt: 'a red fox in moonlight', aspect_ratio: '16:9' });
      return new Response(JSON.stringify({ base64: [PNG_B64] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const chunks = await collect(executeImage('generate_image', {
      prompt: 'a red fox in moonlight',
      aspect_ratio: '16:9',
    }, USER_ID, PRIMARY_ID));

    const image = chunks.find(chunk => chunk.type === 'image');
    expect(image).toMatchObject({ mimeType: 'image/png', base64: PNG_B64 });
    expect(image.filename).toMatch(/\.png$/);
    expect(image.savedPath).toBe(`images:${image.filename}`);
    const imageDiskPath = path.join(getUserFilesDir(USER_ID, 'images'), image.filename);
    expect(existsSync(imageDiskPath)).toBe(true);
    expect(readFileSync(imageDiskPath).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
    expect(statSync(imageDiskPath).mode & 0o777).toBe(0o600);
    expect(chunks.at(-1).text).toContain('configured fireworks fast tier');
    expect(chunks.at(-1)._images).toEqual([expect.objectContaining({
      base64: PNG_B64,
      mediaType: 'image/png',
      filename: image.filename,
      savedPath: image.savedPath,
    })]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('preserves the parked image assignment aspect ratio when no public override is supplied', async () => {
    const fetchSpy = vi.fn(async (_url, options) => {
      expect(JSON.parse(options.body).aspect_ratio).toBe('3:2');
      return new Response(JSON.stringify({ base64: [PNG_B64] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const chunks = await collect(executeImage(
      'generate_image', { prompt: 'configured landscape' }, USER_ID, PRIMARY_ID,
    ));
    expect(chunks.at(-1).text).toContain('Image generated');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('does not let a public quality argument escalate to an unconfigured paid tier', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const chunks = await collect(executeImage(
      'generate_image', { prompt: 'quality escalation probe', quality: 'quality' }, USER_ID, PRIMARY_ID,
    ));
    expect(normalizeToolResult(chunks.at(-1).text).text).toMatch(/configured image assignment is fast-tier/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes a legacy Grok quality assignment and allowed-model entry before provider dispatch', async () => {
    const agents = JSON.parse(readFileSync(path.join(USER_DIR, 'agents.json'), 'utf8'));
    const imageAgent = agents.find(agent => agent.id === IMAGE_AGENT_ID);
    Object.assign(imageAgent, { provider: 'grok', model: 'grok-imagine-image-pro', aspectRatio: '4:5' });
    writeFileSync(path.join(USER_DIR, 'agents.json'), JSON.stringify(agents));
    const profile = JSON.parse(readFileSync(path.join(USER_DIR, 'profile.json'), 'utf8'));
    writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify({
      ...profile,
      allowedModels: ['grok-imagine-image-pro'],
    }));
    expect(imageTest.selectBackend(USER_ID, 'quality')).toEqual({
      provider: 'grok',
      model: 'grok-imagine-image-quality',
      aspectRatio: '4:5',
    });
    const fetchSpy = vi.fn(async (_url, options) => {
      expect(JSON.parse(options.body)).toMatchObject({
        model: 'grok-imagine-image-quality',
        aspect_ratio: '4:5',
      });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const chunks = await collect(executeImage(
      'generate_image', { prompt: 'legacy quality assignment' }, USER_ID, PRIMARY_ID,
    ));
    expect(chunks.at(-1).text).toContain('configured grok quality tier');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('edits only a bounded owner-scoped image attachment through an approved Kontext assignment', async () => {
    const agents = JSON.parse(readFileSync(path.join(USER_DIR, 'agents.json'), 'utf8'));
    const imageAgent = agents.find(agent => agent.id === IMAGE_AGENT_ID);
    Object.assign(imageAgent, { model: 'flux-kontext-pro', aspectRatio: '16:9' });
    writeFileSync(path.join(USER_DIR, 'agents.json'), JSON.stringify(agents));
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.FIREWORKS_API_KEY = 'lab-fake';
    process.env.GROK_API_KEY = 'lab-fake';
    const inputName = 'edit-source.png';
    writeFileSync(path.join(getUserFilesDir(USER_ID, 'images'), inputName), Buffer.from(PNG_B64, 'base64'));
    const fetchSpy = vi.fn(async (url, options) => {
      if (!String(url).endsWith('/get_result')) {
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({ prompt: 'turn it into a watercolor', aspect_ratio: '16:9' });
        expect(body.input_image).toBe(`data:image/png;base64,${PNG_B64}`);
        return new Response(JSON.stringify({ request_id: 'edit-request-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'Ready', result: { base64: [PNG_B64] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const chunks = await collect(executeImage('generate_image', {
      prompt: 'turn it into a watercolor',
      input_image_id: `images:${inputName}`,
    }, USER_ID, PRIMARY_ID));
    expect(chunks.find(chunk => chunk.type === 'tool_progress')?.text).toBe('Editing image…');
    expect(chunks.find(chunk => chunk.type === 'image')).toMatchObject({ mimeType: 'image/png' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockClear();
    const rejected = await collect(executeImage('generate_image', {
      prompt: 'unsafe edit', input_image_id: 'images:../outside.png',
    }, USER_ID, PRIMARY_ID));
    expect(normalizeToolResult(rejected.at(-1).text).text).toMatch(/attachment ID is invalid/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds, validates, and stores native hosted image results without exposing disk paths', () => {
    const saved = saveImageGenerationResult(USER_ID, { id: 'native-call', result: PNG_B64 });
    expect(saved).toMatchObject({ mimeType: 'image/png', savedPath: `images:${saved.filename}` });
    const diskPath = path.join(getUserFilesDir(USER_ID, 'images'), saved.filename);
    expect(readFileSync(diskPath).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
    expect(statSync(diskPath).mode & 0o777).toBe(0o600);
    expect(saveImageGenerationResult(USER_ID, { result: Buffer.from('not an image').toString('base64') })).toBeNull();
    expect(saveImageGenerationResult(USER_ID, { result: 'A'.repeat(28_000_000) })).toBeNull();
  });

  it('hands the already-read slow-tool boundary to the detached sink with its structured images', async () => {
    const boundary = {
      type: 'result',
      text: 'terminal image result',
      _images: [{ filename: 'boundary.png', base64: PNG_B64, mediaType: 'image/png' }],
    };
    async function* tail() {
      yield { type: 'tool_progress', text: 'later event' };
    }
    const seen = [];
    await drainIteratorIncludingBoundary(tail(), boundary, async value => seen.push(value));
    expect(seen).toEqual([
      boundary,
      { type: 'tool_progress', text: 'later event' },
    ]);
    expect(seen[0]._images[0]).toMatchObject({ filename: 'boundary.png', base64: PNG_B64 });
  });

  it('swaps an authorized local schema for hosted image generation only when no local backend is usable', async () => {
    delete process.env.FIREWORKS_API_KEY;
    delete process.env.GROK_API_KEY;
    writeFileSync(CFG_PATH, JSON.stringify({
      enabledProviders: { fireworks: false, grok: false },
      skillAssignments: {},
    }));
    const fullTools = resolveAgentTools(
      'coordinator',
      ['coordinator', 'image_generator'],
      PRIMARY_ID,
      USER_ID,
    );
    expect(toolNames(fullTools)).toContain('generate_image');

    const agent = {
      id: PRIMARY_ID,
      provider: 'openai-oauth',
      model: 'gpt-5.4',
      skillCategory: 'coordinator',
      _rosterSolo: true,
      tools: fullTools,
    };
    const result = await trimToolsForTurn({
      agent,
      userText: 'Generate an image of a lighthouse.',
      userId: USER_ID,
    });

    expect(toolNames(result.fullTools)).toContain('generate_image');
    expect(toolNames(result.trimmedTools)).toContain('generate_image');
    agent.tools = result.trimmedTools;
    agent._providerHostedImageBackend = shouldUseProviderHostedImageBackend(agent, USER_ID);
    const wireTools = applyProviderHostedImageTool(agent, toResponsesTools(agent.tools), 0);
    expect(wireTools).toContainEqual({ type: 'image_generation' });
    expect(wireTools.some(tool => tool.name === 'generate_image')).toBe(false);
  });

  it('prefers a configured local backend and never grants hosted images to an allowedSkills-restricted account', () => {
    const authorizedTools = resolveAgentTools(
      'coordinator',
      ['coordinator', 'image_generator'],
      PRIMARY_ID,
      USER_ID,
    );
    const localAgent = {
      provider: 'openai-oauth', model: 'gpt-5.4', tools: authorizedTools,
      _providerHostedImageBackend: shouldUseProviderHostedImageBackend({ provider: 'openai-oauth', model: 'gpt-5.4' }, USER_ID),
    };
    expect(localAgent._providerHostedImageBackend).toBe(false);
    const localWireTools = applyProviderHostedImageTool(localAgent, toResponsesTools(localAgent.tools), 0);
    expect(localWireTools.some(tool => tool.name === 'generate_image')).toBe(true);
    expect(localWireTools.some(tool => tool.type === 'image_generation')).toBe(false);

    const profile = JSON.parse(readFileSync(path.join(USER_DIR, 'profile.json'), 'utf8'));
    writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify({ ...profile, allowedSkills: [] }));
    const restrictedTools = resolveAgentTools(
      'coordinator',
      ['coordinator', 'image_generator'],
      PRIMARY_ID,
      USER_ID,
    );
    expect(toolNames(restrictedTools)).not.toContain('generate_image');
    const restrictedAgent = {
      provider: 'openai-oauth', model: 'gpt-5.4', tools: restrictedTools,
      _providerHostedImageBackend: true,
    };
    const restrictedWireTools = applyProviderHostedImageTool(
      restrictedAgent,
      restrictedTools.length ? toResponsesTools(restrictedTools) : undefined,
      0,
    );
    expect(restrictedWireTools?.some(tool => tool.type === 'image_generation') ?? false).toBe(false);
  });

  it('queues video generation as a durable fixed-provider watcher without changing or calling the primary', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const watch = vi.fn(async () => 'watch-media-1');

    const result = await executeVideo(
      'generate_video',
      { prompt: 'waves at sunset with a slow camera pan' },
      USER_ID,
      PRIMARY_ID,
      { watch },
    );

    expect(result).toContain('watch-media-1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0][0]).toMatchObject({
      kind: 'grok_video_generation',
      cadenceSec: 5,
      requirePersist: true,
      state: {
        phase: 'queued',
        prompt: 'waves at sunset with a slow camera pan',
        model: 'grok-imagine-video',
        requestId: null,
      },
    });
    expect(typeof watcherHandlers.grok_video_generation).toBe('function');
  });

  it('infers watcher skill ownership, persists the parked target in single mode, and restores it after reload', async () => {
    await expect(resolveWatcherRegistrationAgentId(USER_ID, PRIMARY_ID, null))
      .resolves.toBe(`${USER_ID}_coordinator`);
    const ctx = await buildSkillExecutionContextForTest(
      USER_ID,
      `${USER_ID}_${PRIMARY_ID}`,
      'role_video_generator',
    );
    const watcherId = await ctx.watch({
      kind: 'grok_video_generation',
      label: 'durable watcher owner transfer',
      state: { phase: 'queued', prompt: 'durable watcher owner transfer', model: 'grok-imagine-video' },
      expiresAt: Date.now() + 60_000,
      requirePersist: true,
    });
    expect(watcherId).toBeTruthy();
    const persisted = JSON.parse(readFileSync(path.join(USER_DIR, 'watchers.json'), 'utf8'));
    const stored = persisted.active.find(record => record.kind === 'grok_video_generation');
    expect(stored).toMatchObject({
      agentId: `${USER_ID}_${VIDEO_AGENT_ID}`,
      skillId: 'role_video_generator',
    });

    const profile = JSON.parse(readFileSync(path.join(USER_DIR, 'profile.json'), 'utf8'));
    const canonicalWatchers = await import('./scheduler/watchers.mjs');
    const topology = await import('./chat-dispatch/slot-registry.mjs');
    const overlapLiveVideo = vi.fn();
    canonicalWatchers.startWatcherSupervisor({ showVideo: overlapLiveVideo });
    canonicalWatchers.stopWatcherSupervisor();
    const canonicalRecord = canonicalWatchers.getWatcher(USER_ID, stored.id);
    const overlapDelivery = {
      url: '/api/desktop/videos/overlap.mp4',
      filename: 'overlap.mp4',
      savedPath: 'videos:overlap.mp4',
      deliveryId: 'provider-overlap-1',
    };

    const writer = topology.tryAcquireUserTopologyTransition(USER_ID);
    expect(writer).toBeTruthy();
    writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify({
      ...profile,
      orchestration: { mode: 'ensemble', primaryAgentId: PRIMARY_ID },
    }));
    const pendingDelivery = canonicalWatchers.handlerHelpers(canonicalRecord).showVideo(overlapDelivery);
    try {
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(overlapLiveVideo).not.toHaveBeenCalled();
    } finally {
      topology.finishUserTopologyTransition(writer);
    }
    await expect(pendingDelivery).resolves.toBe(true);
    expect(overlapLiveVideo).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      agent: `${USER_ID}_${VIDEO_AGENT_ID}`,
    }));
    const overlapReportId = `watcher-video:${stored.id}:provider-overlap-1`;
    expect((await loadSession(`${USER_ID}_${VIDEO_AGENT_ID}`, 100))
      .filter(row => row.reportId === overlapReportId)).toHaveLength(1);
    expect((await loadSession(`${USER_ID}_${PRIMARY_ID}`, 100))
      .filter(row => row.reportId === overlapReportId)).toHaveLength(0);

    // Simulate a crash immediately after the single-mode delivery session was
    // reserved but before its report append. A later ensemble-mode retry must
    // append only to that reservation and suppress a stale live send.
    writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify(profile));
    const crashDelivery = {
      url: '/api/desktop/videos/crash-retry.mp4',
      filename: 'crash-retry.mp4',
      savedPath: 'videos:crash-retry.mp4',
      deliveryId: 'provider-crash-1',
    };
    canonicalWatchers.__test.reserveWatcherMediaDelivery(
      canonicalRecord,
      crashDelivery.deliveryId,
      `${USER_ID}_${PRIMARY_ID}`,
    );
    writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify({
      ...profile,
      orchestration: { mode: 'ensemble', primaryAgentId: PRIMARY_ID },
    }));

    const reloadedWatchers = await import('./scheduler/watchers.mjs?media_reload');
    const retryLiveVideo = vi.fn();
    const liveImage = vi.fn();
    reloadedWatchers.startWatcherSupervisor({ showVideo: retryLiveVideo, showImage: liveImage });
    reloadedWatchers.stopWatcherSupervisor();
    const reloaded = reloadedWatchers.getWatcher(USER_ID, stored.id);
    expect(reloaded.agentId).toBe(`${USER_ID}_${VIDEO_AGENT_ID}`);
    const helpers = reloadedWatchers.handlerHelpers(reloaded);
    await expect(helpers.showVideo(crashDelivery)).resolves.toBe(false);
    await expect(helpers.showVideo(crashDelivery)).resolves.toBe(false);
    expect(retryLiveVideo).not.toHaveBeenCalled();
    const crashReportId = `watcher-video:${stored.id}:provider-crash-1`;
    const primaryCrashReports = (await loadSession(`${USER_ID}_${PRIMARY_ID}`, 100))
      .filter(row => row.reportId === crashReportId);
    const specialistCrashReports = (await loadSession(`${USER_ID}_${VIDEO_AGENT_ID}`, 100))
      .filter(row => row.reportId === crashReportId);
    expect(primaryCrashReports).toHaveLength(1);
    expect(specialistCrashReports).toHaveLength(0);

    reloadedWatchers.unregisterWatcher(USER_ID, stored.id);
    await expect(helpers.showVideo({ ...crashDelivery, deliveryId: 'after-cancel' })).resolves.toBe(false);
    await expect(helpers.showImage({ filename: 'after-cancel.png', base64: PNG_B64 })).resolves.toBe(false);
    expect(liveImage).not.toHaveBeenCalled();
    canonicalWatchers.unregisterWatcher(USER_ID, stored.id);
  });

  it('rolls back a paid watcher registration when its initial durable write fails', async () => {
    const failedUser = `${USER_ID}_persist_failure`;
    const failedDir = path.join(USERS_DIR, failedUser);
    mkdirSync(path.join(failedDir, 'watchers.json'), { recursive: true });
    const isolated = await import('./scheduler/watchers.mjs');
    try {
      expect(() => isolated.registerWatcher({
        userId: failedUser,
        agentId: `${failedUser}_coordinator`,
        kind: 'grok_video_generation',
        skillId: 'role_video_generator',
        state: { phase: 'queued' },
        expiresAt: Date.now() + 60_000,
        requirePersist: true,
      })).toThrow(/could not be persisted/i);
      expect(isolated.listWatchers(failedUser).active).toHaveLength(0);
    } finally {
      rmSync(failedDir, { recursive: true, force: true });
    }
  });

  it('fails closed before session append when a media delivery reservation cannot persist', async () => {
    const failedUser = `${USER_ID}_delivery_persist_failure`;
    const failedDir = path.join(USERS_DIR, failedUser);
    mkdirSync(failedDir, { recursive: true });
    const watchers = await import('./scheduler/watchers.mjs');
    try {
      const watcherId = watchers.registerWatcher({
        userId: failedUser,
        agentId: `${failedUser}_coordinator`,
        kind: 'delivery_persist_failure',
        state: {},
        expiresAt: Date.now() + 60_000,
        requirePersist: true,
      });
      const record = watchers.getWatcher(failedUser, watcherId);
      const store = path.join(failedDir, 'watchers.json');
      rmSync(store, { force: true });
      mkdirSync(store);
      expect(() => watchers.__test.reserveWatcherMediaDelivery(
        record,
        'delivery-1',
        `${failedUser}_coordinator`,
      )).toThrow(/could not be persisted/i);
      expect(record.mediaDeliveryReservations).toBeUndefined();
    } finally {
      rmSync(failedDir, { recursive: true, force: true });
    }
  });

  it('terminates before provider I/O when a durable pre-submission claim cannot be saved', async () => {
    const watchers = await import('./scheduler/watchers.mjs');
    const watcherId = watchers.registerWatcher({
      userId: USER_ID,
      agentId: `${USER_ID}_${VIDEO_AGENT_ID}`,
      kind: 'grok_video_generation',
      skillId: 'role_video_generator',
      state: {
        phase: 'queued',
        prompt: 'durable claim failure probe',
        model: 'grok-imagine-video',
        requestId: null,
      },
      expiresAt: Date.now() + 60_000,
      requirePersist: true,
    });
    const store = path.join(USER_DIR, 'watchers.json');
    rmSync(store, { force: true });
    mkdirSync(store);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await watchers.__test.tickOne(
      watchers.getWatcher(USER_ID, watcherId),
      watcherHandlers.grok_video_generation,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(watchers.getWatcher(USER_ID, watcherId)).toMatchObject({
      status: 'error',
      lastStatusText: expect.stringMatching(/durable pre-submission claim could not be saved/i),
    });
    rmSync(store, { recursive: true, force: true });
  });

  it('does not queue video work through a disabled provider', async () => {
    writeFileSync(CFG_PATH, JSON.stringify({
      enabledProviders: { fireworks: true, grok: false },
      skillAssignments: {},
    }));
    const watch = vi.fn();
    const result = await executeVideo(
      'generate_video',
      { prompt: 'waves at sunset' },
      USER_ID,
      PRIMARY_ID,
      { watch },
    );
    expect(result).toContain('Grok is disabled');
    expect(watch).not.toHaveBeenCalled();
  });

  it('enforces the account model ceiling for the configured video assignment', async () => {
    const profile = JSON.parse(readFileSync(path.join(USER_DIR, 'profile.json'), 'utf8'));
    writeFileSync(path.join(USER_DIR, 'profile.json'), JSON.stringify({ ...profile, allowedModels: [] }));
    const watch = vi.fn();
    const result = await executeVideo(
      'generate_video', { prompt: 'model ceiling probe' }, USER_ID, PRIMARY_ID, { watch },
    );
    expect(result).toMatch(/not approved/i);
    expect(watch).not.toHaveBeenCalled();
  });

  it('starts, resumes, saves, and publishes a video watcher job', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.GROK_API_KEY = 'lab-fake';
    const videoBytes = Buffer.concat([
      Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    const videoUrl = 'http://127.0.0.1:9932/output/request-42.mp4';
    const fetchSpy = vi.fn(async (url, options) => {
      const value = String(url);
      if (value.endsWith('/videos/generations')) {
        expect(options.redirect).toBe('error');
        expect(JSON.parse(options.body)).toMatchObject({
          model: 'grok-imagine-video',
          prompt: 'a fox running through snow',
        });
        return new Response(JSON.stringify({ id: 'request-42' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (value.endsWith('/videos/request-42')) {
        return new Response(JSON.stringify({ status: 'done', video: { url: videoUrl, respect_moderation: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(value).toBe(videoUrl);
      return new Response(videoBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const claimed = await watcherHandlers.grok_video_generation({
      phase: 'queued',
      prompt: 'a fox running through snow',
      model: 'grok-imagine-video',
      requestId: null,
    }, { userId: USER_ID });
    expect(claimed.newState).toMatchObject({
      phase: 'submission_claimed',
      model: 'grok-imagine-video',
      submissionBootNonce: videoTest.videoBootNonce,
    });
    expect(claimed.newState.submissionClaimId).toMatch(/^[a-f0-9]{32}$/);
    expect(claimed.requirePersist).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const started = await watcherHandlers.grok_video_generation(claimed.newState, { userId: USER_ID });
    expect(started.newState).toMatchObject({
      phase: 'generating',
      model: 'grok-imagine-video',
      requestId: 'request-42',
      progress: 0,
    });

    const showVideo = vi.fn();
    const completed = await watcherHandlers.grok_video_generation(started.newState, {
      userId: USER_ID,
      showVideo,
    });
    expect(completed).toMatchObject({ done: true, newState: { phase: 'done', progress: 100 } });
    const videoDiskPath = path.join(getUserFilesDir(USER_ID, 'videos'), completed.newState.filename);
    expect(existsSync(videoDiskPath)).toBe(true);
    expect(readFileSync(videoDiskPath).equals(videoBytes)).toBe(true);
    expect(completed.newState).not.toHaveProperty('savedPath');
    expect(completed.newState.attachmentId).toBe(`videos:${completed.newState.filename}`);
    expect(showVideo).toHaveBeenCalledWith(expect.objectContaining({
      url: `/api/desktop/videos/${encodeURIComponent(completed.newState.filename)}`,
      filename: completed.newState.filename,
      savedPath: `videos:${completed.newState.filename}`,
    }));
    expect(showVideo.mock.calls[0][0].url).not.toBe(videoUrl);
    expect(completed.textUpdate).toContain(`Attachment ID: videos:${completed.newState.filename}`);
    expect(completed.textUpdate).not.toContain(USERS_DIR);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const repeatedShow = vi.fn();
    const repeated = await watcherHandlers.grok_video_generation(started.newState, {
      userId: USER_ID,
      showVideo: repeatedShow,
    });
    expect(repeated.newState.filename).toBe(completed.newState.filename);
    expect(repeated.newState.attachmentId).toBe(completed.newState.attachmentId);
    expect(repeatedShow).toHaveBeenCalledOnce();
    // One repeat poll, but no second provider-media download.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('never automatically repeats a provider POST after an ambiguous claimed submission', async () => {
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.GROK_API_KEY = 'lab-fake';
    const claimed = await watcherHandlers.grok_video_generation({
      phase: 'queued', prompt: 'an ambiguous submission', model: 'grok-imagine-video', requestId: null,
    }, { userId: USER_ID });
    const fetchSpy = vi.fn(async () => { throw new Error('socket closed after write'); });
    vi.stubGlobal('fetch', fetchSpy);

    const first = await watcherHandlers.grok_video_generation(claimed.newState, { userId: USER_ID });
    const repeated = await watcherHandlers.grok_video_generation(claimed.newState, { userId: USER_ID });
    expect(first).toMatchObject({ done: true, failed: true });
    expect(repeated).toMatchObject({ done: true, failed: true });
    expect(first.textUpdate).toMatch(/ambiguous.*not retried automatically/i);
    expect(repeated.textUpdate).toMatch(/ambiguous.*not retried automatically/i);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const afterRestart = await watcherHandlers.grok_video_generation({
      ...claimed.newState,
      submissionClaimId: '0123456789abcdef0123456789abcdef',
      submissionBootNonce: 'previous-server-process',
    }, { userId: USER_ID });
    expect(afterRestart).toMatchObject({ done: true, failed: true });
    expect(afterRestart.textUpdate).toMatch(/interrupted.*not retried automatically/i);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ['failed', { status: 'failed', message: 'provider render failed' }, /generation failed.*provider render failed/i],
    ['expired', { status: 'expired' }, /generation expired/i],
    ['unknown', { status: 'mystery' }, /invalid video status/i],
    ['missing', {}, /invalid video status/i],
    ['moderation', {
      status: 'done',
      video: { url: 'http://127.0.0.1:9932/output/blocked.mp4', respect_moderation: false },
    }, /blocked.*moderation/i],
    ['missing moderation clearance', {
      status: 'done',
      video: { url: 'http://127.0.0.1:9932/output/unverified.mp4' },
    }, /not explicitly cleared by moderation/i],
  ])('terminates honestly for the provider %s state', async (_label, providerBody, expected) => {
    process.env.OPENENSEMBLE_LAB = '1';
    process.env.GROK_API_KEY = 'lab-fake';
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(providerBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const showVideo = vi.fn();
    const result = await watcherHandlers.grok_video_generation({
      phase: 'generating', prompt: 'terminal state probe', model: 'grok-imagine-video', requestId: 'request-terminal',
    }, { userId: USER_ID, showVideo });
    expect(result).toMatchObject({ done: true, failed: true });
    expect(result.textUpdate).toMatch(expected);
    expect(showVideo).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('fails closed on model overrides and malformed provider media', async () => {
    expect(() => videoTest.validatePublicVideoUrl('http://public.example/video.mp4')).toThrow(/not allowed/i);
    expect(() => videoTest.validatePublicVideoUrl('https://127.0.0.1/video.mp4')).toThrow(/private or unsafe/i);
    const validTarget = path.join(getUserFilesDir(USER_ID, 'videos'), 'valid-target.mp4');
    const linkedVideo = path.join(getUserFilesDir(USER_ID, 'videos'), 'linked.mp4');
    writeFileSync(validTarget, Buffer.concat([
      Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(8),
    ]));
    symlinkSync(validTarget, linkedVideo);
    await expect(videoTest.validExistingVideo(linkedVideo)).resolves.toBe(false);
    const watch = vi.fn();
    const rejected = await executeVideo(
      'generate_video',
      { prompt: 'waves', model: 'attacker-selected-model' },
      USER_ID,
      PRIMARY_ID,
      { watch },
    );
    expect(rejected).toContain('does not accept');
    expect(watch).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ base64: ['bm90IGFuIGltYWdl'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const chunks = await collect(executeImage('generate_image', { prompt: 'bad provider bytes' }, USER_ID, PRIMARY_ID));
    const failure = chunks.find(chunk => chunk.type === 'result');
    expect(normalizeToolResult(failure.text).text).toMatch(/Tool error:.*supported PNG/i);
  });
});
