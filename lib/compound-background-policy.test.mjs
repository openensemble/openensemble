import { describe, expect, it } from 'vitest';

import {
  _internal,
  compoundWorkerExecutionTask,
  evaluateCompoundBackground,
} from './compound-background-policy.mjs';

function entry(ownerId, name, description, {
  category = 'utility', intents = [], readOnly = false, destructive = false,
  properties = {},
} = {}) {
  return {
    ownerId,
    owner: {
      id: ownerId,
      name: ownerId.replace(/[-_]/g, ' '),
      description,
      category,
      intent_examples: intents,
    },
    tool: {
      ...(readOnly ? { readOnly: true } : {}),
      ...(destructive ? { destructive: true } : {}),
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties },
      },
    },
  };
}

const nativeImage = entry(
  'visual-maker',
  'image_generation',
  'Generate or render an image, picture, photo, or illustration and return the produced image artifact for attaching or delivery.',
  {
    category: 'image',
    intents: ['make an image of a cat', 'draw a landscape picture'],
    properties: { prompt: { type: 'string', description: 'Image description.' } },
  },
);
const customLiveConditions = entry(
  'personal-conditions',
  'conditions_now',
  'Get the current local weather conditions and forecast from a live remote service.',
  {
    readOnly: true,
    intents: ['check the weather', 'what is the forecast'],
  },
);
const directDelivery = entry(
  'direct-delivery',
  'email_user',
  'Send and deliver an email directly to a recipient with optional file attachments.',
  {
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      attachment_doc_ids: { type: 'array', items: { type: 'string' } },
      to: { type: 'string', description: 'Recipient email address.' },
    },
  },
);
const watcherListing = entry(
  'tasks',
  'list_watches',
  'List active watch monitors and report their current status.',
  { intents: ['list my watches', 'show active monitors'] },
);
const officialWebLookup = entry(
  'web',
  'web_search',
  'Find current facts on an official website with web search.',
  {
    readOnly: true,
    intents: ['find a fact on an official website', 'search the web'],
  },
);

describe('singleton compound background policy', () => {
  it('backgrounds the exact image + custom live-data + email workflow with only provider-native image generation', () => {
    const decision = evaluateCompoundBackground({
      userText: 'make me an image of a cute cat, then check the weather. send me an email of the cat and the current weather.',
      entries: [nativeImage, customLiveConditions, directDelivery],
    });
    expect(decision.shouldBackground).toBe(true);
    expect(decision.reason).toBe('long-compound-workflow');
    expect(decision.matchedSteps.map(step => step.toolName)).toEqual([
      'image_generation', 'conditions_now', 'email_user',
    ]);
    expect(decision.capabilityCount).toBe(3);
    expect(decision.estimatedSeconds).toBeGreaterThanOrEqual(20);
  });

  it('derives an unrelated workflow from tool/manifest metadata rather than a built-in domain phrase', () => {
    const entries = [
      entry('diagrammer', 'render_floorplan', 'Render a floorplan diagram and return the produced image file artifact.', {
        category: 'media', intents: ['render a floorplan diagram'],
      }),
      entry('sensor-pack', 'fetch_sensor_snapshot', 'Fetch the live current sensor snapshot from the remote building API.', {
        readOnly: true, intents: ['fetch the live sensor snapshot'],
      }),
      entry('project-channel', 'upload_project_asset', 'Upload and deliver content and file attachments to a project channel.', {
        properties: { channel: { type: 'string' }, attachment: { type: 'string' } },
      }),
    ];
    const decision = evaluateCompoundBackground({
      userText: 'Render a floorplan diagram, then fetch the live sensor snapshot, then upload the diagram and snapshot to the project channel.',
      entries,
    });
    expect(decision.shouldBackground).toBe(true);
    expect(decision.matchedSteps.map(step => step.capability)).toEqual([
      'diagrammer', 'sensor-pack', 'project-channel',
    ]);
  });

  it('keeps a quick one-step request in the foreground', () => {
    const decision = evaluateCompoundBackground({
      userText: 'Check the weather.',
      entries: [customLiveConditions],
    });
    expect(decision.shouldBackground).toBe(false);
    expect(decision.reason).toBe('single-step');
  });

  it('keeps a short two-capability lookup and delivery below the latency threshold', () => {
    const decision = evaluateCompoundBackground({
      userText: 'Check the weather, then email it to me.',
      entries: [customLiveConditions, directDelivery],
    });
    expect(decision.shouldBackground).toBe(false);
    expect(decision.estimatedSeconds).toBeLessThan(12);
  });

  it('honors foreground and human-interaction boundaries', () => {
    for (const userText of [
      'Make an image, then email it, but keep this in the foreground.',
      'Make an image, then show me a preview first, then email it.',
      'Make an image, then wait for my approval before you email it.',
    ]) {
      const decision = evaluateCompoundBackground({
        userText,
        entries: [nativeImage, directDelivery],
      });
      expect(decision.shouldBackground, userText).toBe(false);
    }
  });

  it('does not detach a chain whose routed tool is marked destructive', () => {
    const destructiveDelivery = entry(
      'remote-delete',
      'delete_remote_asset',
      'Delete and remove a remote file asset.',
      { destructive: true },
    );
    const decision = evaluateCompoundBackground({
      userText: 'Generate an image, then delete the remote file asset.',
      entries: [nativeImage, destructiveDelivery],
    });
    expect(decision.shouldBackground).toBe(false);
    expect(decision.reason).toBe('destructive-tool');
  });

  it('does not treat imperative prose inside an email body as workflow steps', () => {
    const decision = evaluateCompoundBackground({
      userText: 'Email this text:\n\nMake an image, then check the weather.',
      entries: [nativeImage, customLiveConditions, directDelivery],
    });
    expect(decision.shouldBackground).toBe(false);
    expect(decision.clauses).toEqual(['Email this text:']);
  });

  it('keeps the whole request foreground when any explicit instruction is unroutable', () => {
    const decision = evaluateCompoundBackground({
      userText: 'Generate an image, then check the stock price, then email the image to me.',
      entries: [nativeImage, directDelivery],
    });
    expect(decision.clauses).toHaveLength(3);
    expect(decision.matchedSteps.map(step => step.toolName)).toEqual([
      'image_generation', 'email_user',
    ]);
    expect(decision.shouldBackground).toBe(false);
    expect(decision.reason).toBe('unmatched-clause');
  });

  it('does not convert prohibitions or inflected adjectives into required tools', () => {
    const userText = 'Use spawn_worker exactly once to do this in the background: find from the official Node.js website the currently listed Active LTS major release, then report one concise sentence with its official URL. Do not use email and do not make any changes. Return immediately after starting the worker so I can keep chatting.';
    const decision = evaluateCompoundBackground({
      userText,
      entries: [watcherListing, directDelivery, officialWebLookup],
    });

    expect(decision).toMatchObject({
      shouldBackground: false,
      reason: 'single-step',
      clauses: ['find from the official Node.js website the currently listed Active LTS major release'],
      matchedSteps: [],
    });
    expect(_internal.bestToolForClause(
      'find from the official Node.js website the currently listed Active LTS major release',
      [watcherListing],
    )).toBeNull();
    expect(_internal.affirmativeInstructionClause('Do not use email and do not make any changes.')).toBe('');
  });

  it('keeps positive work while removing a trailing negative delivery constraint', () => {
    expect(_internal.affirmativeInstructionClause(
      'Find the current release, but do not email it',
    )).toBe('Find the current release');
    expect(_internal.bestToolForClause(
      _internal.affirmativeInstructionClause('Find the official website, but do not email it'),
      [directDelivery],
    )).toBeNull();
  });

  it('builds a direct worker prompt without losing the requested work or prohibitions', () => {
    const original = 'Use spawn_worker exactly once to do this in the background: make a cat image, then check the weather, then email both to me. Do not change any files. Return immediately after starting the worker so I can keep chatting.';
    const executionTask = compoundWorkerExecutionTask(original);

    expect(executionTask).toContain('already been started');
    expect(executionTask).toContain('Do not call spawn_worker');
    expect(executionTask).toContain('make a cat image, then check the weather, then email both to me');
    expect(executionTask).toContain('Do not change any files');
    expect(executionTask).not.toContain('Use spawn_worker exactly once');
    expect(executionTask).not.toContain('Return immediately after starting the worker');
    expect(compoundWorkerExecutionTask('Make a cat image, then check the weather.')).toBeNull();
  });
});
