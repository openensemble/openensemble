#!/usr/bin/env node
/**
 * Live WS chat smoke for the predictive-context layer. Connects to the
 * running OpenEnsemble server, authenticates with a fresh browser token,
 * sends a battery of test messages to Sydney, and prints what Sydney says
 * + the timing breakdown.
 *
 * Validates the change against the running server end-to-end (server must
 * be restarted first so it loads the new memory/context.mjs + memory/
 * predictive-context.mjs).
 *
 * Test cases:
 *   1. "yes" — confirmation. Sydney should respond with something
 *      contextually relevant to the *prior* turn (acknowledgement). The
 *      cortex block should be empty (we skipped the recall).
 *   2. "what fruit do I like?" — real recall question. Cortex should
 *      surface fruit-related user_facts and Sydney should answer from
 *      memory rather than asking.
 *   3. "/threshold 0.5" — slash command. Cortex skipped.
 *
 * Token is read from active-sessions.json (the production browser session
 * store) and used ONLY to send WS messages to this user's own agents. No
 * token value is printed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { BASE_DIR } from '../lib/paths.mjs';

const SESSIONS_PATH = path.join(BASE_DIR, 'active-sessions.json');
const WS_URL = process.env.OE_WS_URL || 'ws://127.0.0.1:3737/ws';
const TARGET_AGENT = process.env.OE_AGENT_ID || 'sydney';

function pickToken() {
  const all = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
  const candidates = Object.entries(all).filter(([k, v]) =>
    v?.kind === 'browser' && v?.userId === (process.env.OE_TEST_USER || 'user_00000000') && (!v?.expiresAt || v.expiresAt > Date.now())
  ).sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));
  if (!candidates.length) throw new Error('no non-expired browser session for the test user');
  return { token: candidates[0][0], userId: candidates[0][1].userId };
}

async function sendOne({ token, agentId, text, label }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const t0 = Date.now();
    let firstToken = null;
    let assistantText = '';
    const toolCalls = [];
    let cortexMemoryStored = 0;
    let proposals = 0;

    const closeAfter = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ label, text, durationMs: Date.now() - t0, firstTokenMs: firstToken,
               assistantText: assistantText.trim(), toolCalls, cortexMemoryStored, proposals,
               timedOut: true });
    }, 60_000);

    ws.on('open', () => {
      // The server doesn't ack the auth message — it silently authenticates
      // and starts streaming initial data. Send auth then immediately send
      // the chat. If auth fails the server replies with {type:'error',message:'Unauthorized'}
      // and closes; that's caught in the message handler below.
      ws.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'chat', agent: agentId, text }));
      }, 50);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'token' && typeof msg.text === 'string') {
        if (!firstToken) firstToken = Date.now() - t0;
        assistantText += msg.text;
      }
      if (msg.type === 'tool_call') {
        toolCalls.push(msg.name || msg.tool || '?');
      }
      if (msg.type === 'memory_stored') cortexMemoryStored++;
      if (msg.type === 'proposal') proposals++;
      if (msg.type === 'done' || msg.type === 'error') {
        clearTimeout(closeAfter);
        try { ws.close(); } catch {}
        resolve({ label, text, durationMs: Date.now() - t0, firstTokenMs: firstToken,
                 assistantText: assistantText.trim(), toolCalls, cortexMemoryStored, proposals,
                 errored: msg.type === 'error', errorMsg: msg.message });
      }
    });

    ws.on('error', (e) => {
      clearTimeout(closeAfter);
      reject(e);
    });
  });
}

async function main() {
  const { token, userId } = pickToken();
  console.log(`connected as ${userId}  agent=${TARGET_AGENT}  ws=${WS_URL}`);
  console.log('─'.repeat(80));

  const cases = [
    { label: 'real-q-fruit',  text: 'what fruit do I like?' },
    { label: 'confirm-yes',   text: 'yes' },
    { label: 'slash-trim',    text: '/trim' },
    { label: 'real-q-prefs',  text: 'what are some of my preferences?' },
    { label: 'voice-vol-up',  text: 'volume up' },
  ];

  for (const c of cases) {
    process.stdout.write(`[${c.label.padEnd(14)}] sending "${c.text}"...\n`);
    try {
      const r = await sendOne({ token, agentId: TARGET_AGENT, text: c.text, label: c.label });
      const ft = r.firstTokenMs != null ? `first-token=${r.firstTokenMs}ms` : '(no tokens)';
      const tail = r.timedOut ? ' TIMEOUT' : (r.errored ? ` ERROR: ${r.errorMsg}` : '');
      console.log(`  total=${r.durationMs}ms  ${ft}  tools=[${r.toolCalls.join(',')}]  memStored=${r.cortexMemoryStored}  proposals=${r.proposals}${tail}`);
      const replyPreview = r.assistantText.replace(/\n+/g, ' ').slice(0, 220);
      console.log(`  reply: ${replyPreview}${r.assistantText.length > 220 ? '…' : ''}`);
    } catch (e) {
      console.log(`  WS error: ${e.message}`);
    }
    console.log();
    await new Promise(r => setTimeout(r, 500));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
