// @ts-check
/**
 * Outbound MCP server — exposes OpenEnsemble AS an MCP server at /mcp.
 *
 * External MCP clients (Claude Code, Claude Desktop, Cursor, scripts)
 * authenticate with a personal access token (lib/mcp-access-tokens.mjs)
 * and get user-scoped tools:
 *
 *   chat scope:         ask_coordinator, ask_agent, list_agents
 *   memory-read scope:  recall_memory
 *   memory-write scope: remember_fact, forget_fact
 *
 * Transport: MCP Streamable HTTP in STATELESS mode — every POST builds a
 * fresh Server + transport pair, handles the one request, and tears down
 * on response close. No session ids, no server-side conversation state;
 * the external client owns the conversation and each ask_* call is an
 * isolated one-shot agent turn (silent + isolatedTaskRun — nothing lands
 * in the user's chat sessions).
 *
 * NOT under /api/* on purpose: the /api edge middleware (IP rate limit,
 * body cap, CSRF-origin check) doesn't run here, so this module enforces
 * its own per-token rate limits and body cap.
 *
 * Test isolation: all paths come from lib/paths.mjs (BASE_DIR redirect
 * under vitest). OE internals (chat, helpers, memory) are dynamic imports
 * inside handlers to keep boot order clean.
 */
import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveAccessToken } from './mcp-access-tokens.mjs';
import { USERS_DIR } from './paths.mjs';
import { log } from '../logger.mjs';

const BODY_CAP = 5 * 1024 * 1024;           // 5 MiB — MCP messages are small
const TURN_TIMEOUT_MS = 240_000;            // hard cap on one agent turn
const PROGRESS_INTERVAL_MS = 15_000;        // keep long turns alive for clients that reset timeout on progress

// ── Per-token rate limits (in-memory sliding windows) ────────────────────────
const REQ_LIMIT_PER_MIN = 120;              // any /mcp request
const CALL_LIMIT_PER_MIN = 30;              // tools/call specifically
const _reqWindow = new Map();               // tokenId → number[] (ms stamps)
const _callWindow = new Map();

function overLimit(map, tokenId, limit) {
  const now = Date.now();
  const stamps = (map.get(tokenId) ?? []).filter(t => now - t < 60_000);
  if (stamps.length >= limit) { map.set(tokenId, stamps); return true; }
  stamps.push(now);
  map.set(tokenId, stamps);
  return false;
}

// ── Audit log — per-user JSONL, size-capped ──────────────────────────────────
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const AUDIT_KEEP_LINES = 1000;

function auditPath(userId) {
  return path.join(USERS_DIR, userId, 'mcp-outbound-audit.jsonl');
}

function appendAudit(userId, entry) {
  try {
    const p = auditPath(userId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', { mode: 0o600 });
    const { size } = fs.statSync(p);
    if (size > AUDIT_MAX_BYTES) {
      const lines = fs.readFileSync(p, 'utf8').trimEnd().split('\n');
      fs.writeFileSync(p, lines.slice(-AUDIT_KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
    }
  } catch (e) { console.warn('[mcp-out] audit write failed:', e.message); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function jsonError(res, status, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readBodyCapped(req, cap) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Resolve the user's roster + coordinator once per request. */
async function loadRoster(userId) {
  const { getAgentsForUser, getUserCoordinatorAgentId } = await import('../routes/_helpers.mjs');
  const agents = getAgentsForUser(userId);
  const coordinatorId = getUserCoordinatorAgentId(userId)
    ?? agents.find(a => a.skillCategory === 'coordinator')?.id
    ?? null;
  return { agents, coordinatorId };
}

/**
 * Run one isolated, silent agent turn and return the final reply text.
 * Mirrors lib/run-agent-with-retry.mjs's inner loop, but with a real abort
 * on timeout/client-disconnect (retry helper can't abort) and no retries —
 * the external MCP client owns retry policy.
 */
async function runIsolatedTurn({ agent, userId, message, clientSignal, onProgress }) {
  const { streamChat } = await import('../chat.mjs');
  const { scheduledContext } = await import('./scheduled-context.mjs');
  const { getUser } = await import('../routes/_helpers.mjs');

  const userName = getUser(userId)?.name ?? 'the user';
  const systemNote =
    `[EXTERNAL MCP CLIENT] This message arrives from an external MCP client (Claude Code, Claude Desktop, Cursor, or a script) ` +
    `authenticated with a personal access token that ${userName} created. ${userName} is NOT in the OE chat UI. ` +
    `Each call is an isolated turn: you have no memory of previous MCP calls and there is no follow-up turn for confirmations. ` +
    `If the instruction explicitly requests an action, perform it now — do not show drafts or wait for approval, no one can answer. ` +
    `If a required detail is missing, reply asking for it (the client can call again with a fuller instruction). ` +
    `Reply in plain text — no UI widgets or pills. Your reply is returned verbatim to the external client and may appear in that client's logs.`;

  const scopedAgent = { ...agent, id: `${userId}_${agent.id}` };
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TURN_TIMEOUT_MS);
  const onClientAbort = () => ac.abort();
  clientSignal?.addEventListener?.('abort', onClientAbort);
  const progressTimer = onProgress ? setInterval(() => onProgress(), PROGRESS_INTERVAL_MS) : null;

  let content = '';
  try {
    await scheduledContext.run({ scheduledNote: systemNote }, async () => {
      for await (const event of streamChat(scopedAgent, message, ac.signal, null, userId, null, systemNote, true, null, { isolatedTaskRun: true })) {
        if (event.type === 'error') throw new Error(event.message || 'provider error');
        if (event.type === '__content') content = event.content;
      }
    });
  } catch (e) {
    if (timedOut) throw new Error(`Agent turn exceeded ${TURN_TIMEOUT_MS / 1000}s and was aborted`);
    if (clientSignal?.aborted) throw new Error('Client disconnected; agent turn aborted');
    const causeMsg = e?.cause?.message || e?.cause?.code;
    throw new Error(causeMsg ? `${e.message}: ${causeMsg}` : (e?.message || String(e)));
  } finally {
    clearTimeout(timer);
    if (progressTimer) clearInterval(progressTimer);
    clientSignal?.removeEventListener?.('abort', onClientAbort);
  }
  const trimmed = (content || '').trim();
  // LoopGuard stalls yield "Stopped: <reason>." without a type:'error' event.
  if (/^Stopped:\s/.test(trimmed) && trimmed.length < 200) throw new Error(trimmed);
  return trimmed || '(the agent returned no text)';
}

// ── Tool definitions, scoped per token ───────────────────────────────────────
function rosterLine(agents) {
  return agents
    .map(a => `${a.id}=${a.name}(${a.skillCategory ?? 'general'})`)
    .join(', ') || 'none';
}

/**
 * @param {{id:string,userId:string,name:string,scopes:string[],agentId:string|null}} tokenRec
 * @param {{agents: any[], coordinatorId: string|null}} roster
 */
function buildToolDefs(tokenRec, roster) {
  const scopes = new Set(tokenRec.scopes);
  const bound = tokenRec.agentId
    ? roster.agents.find(a => a.id === tokenRec.agentId) ?? null
    : null;
  const askable = bound ? [bound] : roster.agents;
  const defs = [];

  if (scopes.has('chat')) {
    const coordinator = roster.agents.find(a => a.id === roster.coordinatorId);
    if (coordinator && (!bound || bound.id === coordinator.id)) {
      defs.push({
        name: 'ask_coordinator',
        description:
          `Send a message to ${coordinator.name}, the user's OpenEnsemble coordinator agent. The coordinator can answer from the user's ` +
          `context and memory, use its tools, and delegate to specialist agents. Each call is an isolated turn (no memory of prior calls) ` +
          `— include all needed context in the message. Returns the coordinator's final reply text.`,
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', description: 'The complete, self-contained instruction or question.' } },
          required: ['message'],
        },
      });
    }
    if (!bound || bound.id !== coordinator?.id) {
      defs.push({
        name: 'ask_agent',
        description:
          `Send a message to one of the user's OpenEnsemble agents and get its final reply text. Each call is an isolated turn — ` +
          `include all needed context. Available agents: ${rosterLine(askable)}.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', enum: askable.map(a => a.id), description: 'Which agent to ask.' },
            message: { type: 'string', description: 'The complete, self-contained instruction or question.' },
          },
          required: ['agent_id', 'message'],
        },
      });
    }
    defs.push({
      name: 'list_agents',
      description: 'List the user\'s OpenEnsemble agents: id, name, role, and description.',
      inputSchema: { type: 'object', properties: {} },
    });
  }

  if (scopes.has('memory-read')) {
    defs.push({
      name: 'recall_memory',
      description: 'Search the user\'s durable OpenEnsemble memory (pinned facts and past-conversation episodes) by semantic query.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for, e.g. "proxmox server details".' } },
        required: ['query'],
      },
    });
  }

  if (scopes.has('memory-write')) {
    defs.push({
      name: 'remember_fact',
      description: 'Pin a durable fact into the user\'s OpenEnsemble memory so every OE agent can recall it later. Keep it one self-contained sentence.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, 5–500 characters.' },
          scope: { type: 'string', description: 'Optional role scope (e.g. "nodes", "email"). Omit or pass "shared" for a universal fact.' },
        },
        required: ['text'],
      },
    });
    defs.push({
      name: 'forget_fact',
      description: 'Remove a stored fact from the user\'s OpenEnsemble memory by matching its text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text of the fact to forget (close match is enough).' } },
        required: ['text'],
      },
    });
  }

  return defs;
}

// ── Tool dispatch ────────────────────────────────────────────────────────────
async function callTool({ tokenRec, roster, name, args, clientSignal, onProgress }) {
  const userId = tokenRec.userId;
  const scopes = new Set(tokenRec.scopes);
  const requireScope = (s) => {
    if (!scopes.has(s)) throw new Error(`This access token lacks the "${s}" scope required by ${name}.`);
  };
  const bound = tokenRec.agentId;

  if (name === 'list_agents') {
    requireScope('chat');
    const list = (bound ? roster.agents.filter(a => a.id === bound) : roster.agents)
      .map(a => ({
        id: a.id, name: a.name, role: a.skillCategory ?? 'general',
        coordinator: a.id === roster.coordinatorId || undefined,
        description: a.description || undefined,
      }));
    return JSON.stringify(list, null, 2);
  }

  if (name === 'ask_coordinator' || name === 'ask_agent') {
    requireScope('chat');
    const targetId = name === 'ask_coordinator' ? roster.coordinatorId : String(args.agent_id ?? '');
    if (name === 'ask_coordinator' && !targetId) throw new Error('No coordinator agent is configured for this user.');
    if (bound && targetId !== bound) throw new Error(`This access token is bound to agent "${bound}" and cannot talk to "${targetId}".`);
    const agent = roster.agents.find(a => a.id === targetId);
    if (!agent) throw new Error(`Unknown agent "${targetId}". Call list_agents for valid ids.`);
    const message = String(args.message ?? '').trim();
    if (!message) throw new Error('message is required.');
    return runIsolatedTurn({ agent, userId, message, clientSignal, onProgress });
  }

  if (name === 'recall_memory') {
    requireScope('memory-read');
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('query is required.');
    const { recall } = await import('../memory.mjs');
    const coordScoped = roster.coordinatorId ? `${userId}_${roster.coordinatorId}` : 'shared';
    const [facts, episodes] = await Promise.all([
      recall({ agentId: 'shared', type: 'user_facts', query, topK: 8, includeShared: false, userId }).catch(() => []),
      recall({ agentId: coordScoped, type: 'episodes', query, topK: 4, includeShared: false, userId }).catch(() => []),
    ]);
    const parts = [];
    if (facts.length) parts.push('Facts:\n' + facts.map(f => `• ${f.text}`).join('\n'));
    if (episodes.length) {
      parts.push('Past conversations:\n' + episodes.map(e => {
        const date = new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const body = e.text.length > 200 ? e.text.slice(0, 200) + '…' : e.text;
        return `• [${date}] ${body}`;
      }).join('\n'));
    }
    return parts.length ? parts.join('\n\n') : `No stored memories match "${query}".`;
  }

  if (name === 'remember_fact') {
    requireScope('memory-write');
    const text = String(args.text ?? '').trim();
    if (text.length < 5) throw new Error('text is required (at least 5 characters).');
    if (text.length > 500) throw new Error('Fact too long — keep it under 500 characters.');
    const { pinFact } = await import('../memory.mjs');
    const coordScoped = roster.coordinatorId ? `${userId}_${roster.coordinatorId}` : 'shared';
    const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim().toLowerCase() : 'shared';
    const rec = await pinFact({ agentId: coordScoped, text, userId, scope });
    if (!rec) throw new Error('Failed to store fact (see server logs).');
    if (rec._dedupHit) return `Already knew that — kept the existing fact: ${rec.text}`;
    return `Pinned fact${rec.role_scope ? ` (scoped to role "${rec.role_scope}")` : ''}: ${text}`;
  }

  if (name === 'forget_fact') {
    requireScope('memory-write');
    const text = String(args.text ?? '').trim();
    if (text.length < 3) throw new Error('text is required.');
    const { forgetByText } = await import('../memory/recall.mjs');
    const coordScoped = roster.coordinatorId ? `${userId}_${roster.coordinatorId}` : 'shared';
    const { forgotten, texts } = await forgetByText({ agentId: coordScoped, text, userId, includeImmortal: true });
    if (!forgotten) return `No memories matched "${text}" closely enough to forget.`;
    return `Forgot ${forgotten} memor${forgotten === 1 ? 'y' : 'ies'}:\n${texts.map(t => `• ${t}`).join('\n')}`;
  }

  throw new Error(`Unknown tool "${name}".`);
}

// ── Per-request MCP server ───────────────────────────────────────────────────
function buildServer(tokenRec, roster, clientMeta) {
  const server = new Server(
    { name: 'openensemble', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'OpenEnsemble (OE) — the user\'s personal multi-agent assistant. Use ask_coordinator for anything the user\'s OE ' +
        'agents handle (email, calendar, home automation, files, research, background tasks); use recall_memory before ' +
        'asking the user something OE may already know. Every call is scoped to the token owner\'s account.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(tokenRec, roster),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name ?? '';
    const args = request.params?.arguments ?? {};
    const started = Date.now();

    if (overLimit(_callWindow, tokenRec.id, CALL_LIMIT_PER_MIN)) {
      return { isError: true, content: [{ type: 'text', text: `Rate limit: max ${CALL_LIMIT_PER_MIN} tool calls per minute per token.` }] };
    }

    // Progress keep-alive for long agent turns — only when the client asked
    // for progress (sent a progressToken) and the transport is still open.
    const progressToken = request.params?._meta?.progressToken;
    let progress = 0;
    const onProgress = progressToken !== undefined
      ? () => { extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++progress } }).catch(() => {}); }
      : null;

    let ok = true, resultText = '';
    try {
      resultText = await callTool({ tokenRec, roster, name, args, clientSignal: extra?.signal, onProgress });
    } catch (e) {
      ok = false;
      resultText = e?.message || String(e);
    }
    const ms = Date.now() - started;
    appendAudit(tokenRec.userId, {
      ts: new Date().toISOString(),
      tokenId: tokenRec.id, tokenName: tokenRec.name,
      tool: name,
      args: JSON.stringify(args).slice(0, 200),
      ok, ms,
      ip: clientMeta.ip, ua: clientMeta.ua,
    });
    log.info('mcp-out', 'tool call', { userId: tokenRec.userId, tokenId: tokenRec.id, tool: name, ok, ms });
    return ok
      ? { content: [{ type: 'text', text: resultText }] }
      : { isError: true, content: [{ type: 'text', text: resultText }] };
  });

  return server;
}

// Exposed for tests only — tool listing + dispatch without the HTTP/transport layer.
export const _forTests = { buildToolDefs, callTool, loadRoster };

// ── HTTP route handler (server.mjs routeHandlers entry) ──────────────────────
export async function handle(req, res) {
  const pathname = (req.url ?? '').split('?', 1)[0];
  if (pathname !== '/mcp') return false;

  // Stateless transport: no sessions to GET (SSE notifications) or DELETE.
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed — stateless MCP endpoint, POST only' }, id: null }));
    return true;
  }

  const auth = req.headers.authorization ?? '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const tokenRec = resolveAccessToken(raw);
  if (!tokenRec) {
    jsonError(res, 401, 'Invalid or missing access token. Create one in OpenEnsemble → Settings → MCP → External access.', { 'WWW-Authenticate': 'Bearer realm="OpenEnsemble MCP"' });
    return true;
  }

  // Defense in depth: child accounts can't create tokens, but if one exists
  // for a child (role changed after minting), refuse it.
  const { getUserRole } = await import('../routes/_helpers.mjs');
  if (getUserRole(tokenRec.userId) === 'child') {
    jsonError(res, 403, 'Access tokens are not available for this account.');
    return true;
  }

  if (overLimit(_reqWindow, tokenRec.id, REQ_LIMIT_PER_MIN)) {
    jsonError(res, 429, 'Too many requests for this token. Slow down.', { 'Retry-After': '30' });
    return true;
  }

  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > BODY_CAP) { jsonError(res, 413, 'Request body too large'); return true; }

  let parsedBody;
  try {
    parsedBody = JSON.parse(await readBodyCapped(req, BODY_CAP));
  } catch {
    jsonError(res, 400, 'Body must be valid JSON');
    return true;
  }

  const clientMeta = {
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
    ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
  };

  let roster;
  try {
    roster = await loadRoster(tokenRec.userId);
  } catch (e) {
    console.error('[mcp-out] roster load failed:', e);
    jsonError(res, 500, 'Internal error');
    return true;
  }

  const server = buildServer(tokenRec, roster, clientMeta);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    console.error('[mcp-out] request handling failed:', e);
    if (!res.headersSent) jsonError(res, 500, 'Internal error');
    else { try { res.end(); } catch {} }
  }
  return true;
}
