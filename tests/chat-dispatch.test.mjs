/**
 * Integration test for handleChatMessage — the orchestrator behind WS chat
 * and Telegram. The point isn't to re-test every interceptor (those have
 * their own units); it's to lock in the *dispatch* invariants so a future
 * refactor (e.g. the interceptor-chain rewrite) can't quietly break them:
 *
 *   - Order: a slash command short-circuits before the LLM runs.
 *   - "handled" actually short-circuits — no double-emit, no double-run.
 *   - The busy-slot / abort-controller / stream-buffer registries are
 *     drained on EVERY handled path (slash / HA / trivia / LLM).
 *   - isAgentBusy goes false after the turn settles.
 *
 * Strategy: real chat-dispatch + real slot-registry + real slash-commands;
 * mock the leaf dependencies that would otherwise call out (streamChat,
 * scheduler-intent, voice-reminder, HA client). The fast-paths each have
 * a dynamic import for their backend, which is easy to stub.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BASE_DIR, USERS_DIR } from '../lib/paths.mjs';

// Mock the LLM driver — every test that hits the main LLM path replaces this.
// Default: throw so any test that *unexpectedly* falls through to the LLM
// fails loudly instead of going to the real provider.
vi.mock('../chat.mjs', () => ({
  streamChat: vi.fn(async function* () {
    throw new Error('streamChat called but test did not mock it');
  }),
}));

// Mock the scheduler intercept so it never matches (and never tries to load
// the bundled GGUF plan model in tests).
vi.mock('../lib/scheduler-intent.mjs', () => ({
  interceptScheduling: vi.fn(async () => ({ matched: false })),
}));

// Mock the embedding-router miss so we don't try to load the embedder GGUF.
vi.mock('../lib/specialist-embed-router.mjs', () => ({
  classifyByEmbedding: vi.fn(async () => null),
  getEmbedThreshold: vi.fn(() => 0.72),
  setEmbedThreshold: vi.fn(() => true),
}));

// Mock voice-device WS sender so voice tests don't need a real WebSocket.
vi.mock('../ws-handler.mjs', () => ({
  sendToDevice: vi.fn(),
}));

// Mock the HA client to control success / failure of the HA fast-path.
vi.mock('../lib/ha-client.mjs', () => ({
  getHaConfig: vi.fn(() => ({ baseUrl: 'http://ha.test', token: 't' })),
  haRequest:   vi.fn(async () => ({ result: 'ok' })),
}));

// Pin HA name resolution to a known entity so the HA fast-path classifies.
vi.mock('../lib/ha-cache.mjs', () => ({
  ensureCache: vi.fn(async () => new Map()),
  lookupEntity: vi.fn(async (phrase) => {
    if (/kitchen lights?/i.test(phrase)) {
      return { entity_id: 'light.kitchen', domain: 'light', friendly_name: 'Kitchen' };
    }
    return null;
  }),
}));

vi.mock('../lib/ha-aliases.mjs', () => ({
  resolveAlias: vi.fn(() => null),
}));

const { handleChatMessage, isAgentBusy } = await import('../chat-dispatch.mjs');
const { streamChat } = await import('../chat.mjs');
const { sendToDevice } = await import('../ws-handler.mjs');
const { haRequest } = await import('../lib/ha-client.mjs');
const { saveUser } = await import('../routes/_helpers.mjs');
const { createCustomAgent } = await import('../agents.mjs');

const USER_ID = 'user_chatdispatch_test';

let agentId;

function ensureUserDir() {
  fs.mkdirSync(path.join(USERS_DIR, USER_ID), { recursive: true });
}

beforeAll(() => {
  ensureUserDir();
  saveUser({
    id: USER_ID,
    name: 'Test',
    role: 'user',
    skills: [],
    skillAssignments: {},
  });
  const agent = createCustomAgent({
    name: 'Test Coord',
    emoji: '🧪',
    description: 'integration test coordinator',
    provider: 'openai',
    model: 'gpt-4',
    toolSet: 'web',
    systemPrompt: 'You are a test coordinator.',
    ownerId: USER_ID,
  });
  agentId = agent.id;
  // Wire it as coordinator so getUserCoordinatorAgentId resolves.
  saveUser({
    id: USER_ID,
    name: 'Test',
    role: 'user',
    skills: [],
    skillAssignments: { coordinator: agentId },
  });
});

afterEach(() => {
  // Reset call history between tests; the default mock factory above is
  // re-installed by vi.mock, so we just clear counters.
  vi.mocked(streamChat).mockClear();
  vi.mocked(sendToDevice).mockClear();
  vi.mocked(haRequest).mockClear();
});

// Helper: collect onEvent payloads into an array.
function collector() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe('handleChatMessage — dispatch invariants', () => {
  it('slash /threshold short-circuits before the LLM and drains the busy slot', async () => {
    const { events, onEvent } = collector();
    await handleChatMessage({
      userId: USER_ID, agentId, text: '/threshold',
      onEvent,
    });
    // Reply emitted + done emitted
    expect(events.some(e => e.type === 'token' && /threshold/i.test(e.text))).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    // LLM not invoked
    expect(streamChat).not.toHaveBeenCalled();
    // Busy slot released
    expect(isAgentBusy(`${USER_ID}_${agentId}`)).toBe(false);
  });

  it('HA fast-path "turn on kitchen lights" emits the HA confirm and drains the slot', async () => {
    const { events, onEvent } = collector();
    await handleChatMessage({
      userId: USER_ID, agentId, text: 'turn on kitchen lights',
      onEvent,
    });
    expect(haRequest).toHaveBeenCalledOnce();
    expect(events.some(e => e.type === 'token' && /Kitchen on\./.test(e.text))).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(streamChat).not.toHaveBeenCalled();
    expect(isAgentBusy(`${USER_ID}_${agentId}`)).toBe(false);
  });

  it('voice-device "volume up" sends WS message + emits "okay." + no LLM', async () => {
    const { events, onEvent } = collector();
    await handleChatMessage({
      userId: USER_ID, agentId, text: 'volume up',
      source: 'voice-device', deviceId: 'dev_test',
      onEvent,
    });
    expect(sendToDevice).toHaveBeenCalledWith('dev_test', expect.objectContaining({ type: 'set_volume' }));
    expect(events.some(e => e.type === 'token' && /okay/i.test(e.text))).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('trivia fast-path "what time is it" answers from the local clock with no LLM', async () => {
    const { events, onEvent } = collector();
    await handleChatMessage({
      userId: USER_ID, agentId, text: 'what time is it',
      onEvent,
    });
    expect(events.some(e => e.type === 'token' && e.text && e.text.length > 0)).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(streamChat).not.toHaveBeenCalled();
    expect(isAgentBusy(`${USER_ID}_${agentId}`)).toBe(false);
  });

  it('an unmatched turn invokes streamChat and drains the slot', async () => {
    // Replace the default-throwing mock for this one turn.
    vi.mocked(streamChat).mockImplementationOnce(async function* () {
      yield { type: 'token', text: 'hello from LLM' };
    });
    const { events, onEvent } = collector();
    await handleChatMessage({
      userId: USER_ID, agentId, text: 'tell me a haiku about clouds',
      onEvent,
    });
    expect(streamChat).toHaveBeenCalledOnce();
    expect(events.some(e => e.type === 'token' && /hello from LLM/.test(e.text))).toBe(true);
    expect(isAgentBusy(`${USER_ID}_${agentId}`)).toBe(false);
  });

  it('a thrown LLM error is surfaced as an error event and still drains the slot', async () => {
    vi.mocked(streamChat).mockImplementationOnce(async function* () {
      throw new Error('provider exploded');
    });
    const { events, onEvent } = collector();
    await handleChatMessage({
      userId: USER_ID, agentId, text: 'this will explode',
      onEvent,
    });
    expect(events.some(e => e.type === 'error' && /provider exploded/.test(e.message))).toBe(true);
    expect(isAgentBusy(`${USER_ID}_${agentId}`)).toBe(false);
  });
});
