import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createSession } from './routes/_helpers/auth-sessions.mjs';
import { saveUser } from './routes/_helpers.mjs';
import { createCustomAgent } from './agents.mjs';
import { setOrchestrationPolicy } from './lib/orchestration-policy.mjs';
import { broadcastAgentList, initWs, sendToUser } from './ws-handler.mjs';

let httpServer;
let wsServers;
let baseUrl;
const clients = [];

function connectUser(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const messages = [];
    clients.push(ws);
    const timer = setTimeout(() => reject(new Error('websocket auth timed out')), 5_000);
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (message.type === 'agent_list') {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
    });
  });
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

async function closeWebSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.close();
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 500))]);
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

async function closeServer(wss) {
  if (!wss) return;
  for (const client of wss.clients) client.terminate();
  await new Promise(resolve => wss.close(() => resolve()));
}

beforeAll(async () => {
  httpServer = http.createServer((_req, res) => res.end('ok'));
  wsServers = initWs(httpServer);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const { port } = httpServer.address();
  baseUrl = `ws://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await Promise.all(clients.map(closeWebSocket));
  await new Promise(resolve => httpServer.close(() => resolve()));
  await Promise.all(Object.values(wsServers || {}).map(closeServer));
});

describe('private WebSocket user delivery', () => {
  it('carries normalized stored orchestration policy on initial and switched agent lists', async () => {
    const userId = `ws-orchestration-${Date.now()}`;
    saveUser({
      id: userId,
      name: 'WS Orchestration',
      role: 'user',
      skills: [],
      skillAssignments: {},
      orchestration: { mode: 'ensemble' },
    });
    const primary = createCustomAgent({
      name: 'WS Primary',
      description: 'websocket orchestration fixture',
      provider: 'openai',
      model: 'gpt-4',
      toolSet: 'none',
      systemPrompt: 'WS fixture.',
      ownerId: userId,
    });
    saveUser({
      id: userId,
      name: 'WS Orchestration',
      role: 'user',
      skills: [],
      skillAssignments: { coordinator: primary.id },
      orchestration: { mode: 'ensemble', primaryAgentId: primary.id },
    });
    await setOrchestrationPolicy(userId, { mode: 'single', primaryAgentId: primary.id });

    const client = await connectUser(createSession(userId));
    const initial = client.messages.find(message => message.type === 'agent_list');
    expect(initial.orchestration).toEqual({ mode: 'single', primaryAgentId: primary.id });
    expect(initial.agents.map(agent => agent.id)).toEqual([primary.id]);

    await setOrchestrationPolicy(userId, { mode: 'ensemble' });
    broadcastAgentList();
    await waitFor(() => client.messages.some(message =>
      message.type === 'agent_list' && message.orchestration?.mode === 'ensemble'));
    const restored = client.messages.findLast(message => message.type === 'agent_list');
    expect(restored.orchestration).toEqual({ mode: 'ensemble', primaryAgentId: primary.id });
  });

  it('delivers a background completion to the owner and never the other authenticated user', async () => {
    const userA = `ws-owner-a-${Date.now()}`;
    const userB = `ws-owner-b-${Date.now()}`;
    const [clientA, clientB] = await Promise.all([
      connectUser(createSession(userA)),
      connectUser(createSession(userB)),
    ]);
    const event = {
      type: 'assistant_notification',
      notification_id: `private-${Date.now()}`,
      content: 'Owner A private completion',
      agent: 'primary',
    };

    expect(sendToUser(userA, event)).toBe(1);
    await waitFor(() => clientA.messages.some(message => message.notification_id === event.notification_id));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(clientA.messages).toContainEqual(expect.objectContaining({
      notification_id: event.notification_id,
      content: event.content,
    }));
    expect(clientB.messages.some(message => message.notification_id === event.notification_id)).toBe(false);
  });
});
