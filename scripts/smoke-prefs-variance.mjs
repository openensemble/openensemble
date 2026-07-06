#!/usr/bin/env node
/**
 * Quick variance check — fire the same prefs question 3x against Sydney
 * to separate LLM/network variance from a real regression in the
 * predictive-context wiring.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { BASE_DIR } from '../lib/paths.mjs';

function pickToken() {
  const all = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'active-sessions.json'), 'utf8'));
  const cands = Object.entries(all).filter(([k, v]) =>
    v?.kind === 'browser' && v?.userId === (process.env.OE_TEST_USER || 'user_00000000') && (!v?.expiresAt || v.expiresAt > Date.now())
  ).sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));
  if (!cands.length) throw new Error('no browser token');
  return cands[0][0];
}

async function sendOne(token, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3737/ws');
    const t0 = Date.now();
    let firstToken = null;
    let reply = '';
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 60_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'chat', agent: 'sydney', text })), 50);
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'token' && typeof msg.text === 'string') {
        if (!firstToken) firstToken = Date.now() - t0;
        reply += msg.text;
      }
      if (msg.type === 'done' || msg.type === 'error') {
        clearTimeout(timeout); ws.close();
        resolve({ total: Date.now() - t0, firstToken, reply: reply.trim().slice(0, 100) });
      }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

const token = pickToken();
const cases = [
  'what are some of my preferences?',
  'what are some of my preferences?',
  'what are some of my preferences?',
];
for (let i = 0; i < cases.length; i++) {
  const r = await sendOne(token, cases[i]);
  console.log(`run ${i+1}: total=${r.total}ms  first-token=${r.firstToken}ms  reply="${r.reply}…"`);
  await new Promise(r => setTimeout(r, 1000));
}
