// @ts-check
/**
 * Timestamped log of node_exec invocations. The location_fact outcome
 * measurer scans this log to detect "dead-path re-probes" — invocations
 * whose `command` substring contains the path that the pinned fact said
 * doesn't exist. Each re-probe in the post window means the fact didn't
 * stick (the agent kept trying the wrong path).
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function eventsPath(userId) {
  return path.join(USERS_DIR, userId, 'node-exec-paths.jsonl');
}

export async function appendNodeExec(userId, { nodeId, command }) {
  if (!userId || !command) return;
  const now = Date.now();
  const line = JSON.stringify({
    ts: now,
    nodeId: nodeId || null,
    command: String(command).slice(0, 500),
  });
  const p = eventsPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - RETENTION_MS;
      let kept = [];
      if (fs.existsSync(p)) {
        const fileLines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const ln of fileLines) {
          try {
            const rec = JSON.parse(ln);
            if (rec.ts > cutoff) kept.push(ln);
          } catch { /* drop */ }
        }
      }
      kept.push(line);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[node-exec-paths] append failed:', e.message);
  }
}

export function loadNodeExecPaths(userId) {
  if (!userId) return [];
  const p = eventsPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Count invocations where `command` contains the given path substring,
 * scoped to a specific node (or any node if hostname is null).
 */
export function countDeadPathProbes(userId, hostname, deadPath, from, to) {
  const events = loadNodeExecPaths(userId);
  if (!deadPath) return 0;
  let n = 0;
  for (const e of events) {
    if (e.ts < from || e.ts >= to) continue;
    if (hostname && e.nodeId !== hostname) continue;
    if (!e.command.includes(deadPath)) continue;
    n++;
  }
  return n;
}
