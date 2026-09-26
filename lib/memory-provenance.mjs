import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { resolveProjectSessionKey } from './project-context.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

function sourcePath(userId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid memory owner');
  return path.join(USERS_DIR, userId, 'memory-sources.json');
}

function readSources(userId) {
  try {
    const value = JSON.parse(fs.readFileSync(sourcePath(userId), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function getMemorySource(userId, table, id) {
  return readSources(userId)[`${table}:${id}`] || null;
}

export function captureMemorySource(userId, agentId) {
  const turn = getTurn();
  if (!turn?.turnId || turn.userId !== userId || !(agentId || turn.agentId)) return null;
  const agentKey = agent => agent.startsWith(`${userId}_`) ? agent : `${userId}_${agent}`;
  const sameAgent = !agentId || (turn.agentId && agentKey(agentId) === agentKey(turn.agentId));
  const rawKey = (sameAgent && turn.sessionKey) || agentKey(agentId || turn.agentId);
  const sessionKey = resolveProjectSessionKey(rawKey);
  if (!sessionKey.startsWith(`${userId}_`)) return null;
  return { sessionKey, turnId: turn.turnId, at: turn.startedAt || Date.now() };
}

export async function recordMemorySource(userId, table, id, sourceContext = undefined) {
  try {
    // Idle summaries must use the original turns, not the timer's ambient turn.
    const source = sourceContext === undefined ? captureMemorySource(userId) : sourceContext;
    if (!source || !/^[a-zA-Z0-9_-]+$/.test(source.sessionKey || '')
      || !source.sessionKey.startsWith(`${userId}_`) || typeof source.turnId !== 'string'
      || !source.turnId || !Number.isFinite(source.at)) return;
    const turnIds = Array.isArray(source.turnIds) ? [...new Set(source.turnIds)]
      .filter(value => typeof value === 'string' && value.length > 0 && value.length <= 200).slice(-8) : null;
    const savedSource = { sessionKey: source.sessionKey, turnId: source.turnId, at: source.at,
      ...(turnIds?.length ? { turnIds } : {}) };
    const file = sourcePath(userId);
    await withLock(file, () => {
      const entries = readSources(userId);
      const key = `${table}:${id}`;
      if (entries[key]) return;
      entries[key] = savedSource;
      const kept = Object.fromEntries(Object.entries(entries).sort((a, b) => a[1].at - b[1].at).slice(-5000));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteSync(file, JSON.stringify(kept), { mode: 0o600 });
    });
  } catch (error) { console.warn('[memory] source link could not be saved:', error.message); }
}
