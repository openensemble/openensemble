#!/usr/bin/env node
// @ts-check
/**
 * One-time cleanup for the default_arg/watch proposer rework.
 *
 * - Fails pending/snoozed default_arg proposals that predate the user-authored
 *   evidence flag or no longer pass safety gates.
 * - Fails pending/snoozed monitorable watch proposals whose target is a vague
 *   pronoun/state phrase.
 * - Prunes tool-arg-counts buckets that can never produce a valid default.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { _testIsPinnable } from '../lib/tool-defaults.mjs';
import { extractMonitorableSource } from '../lib/monitorable-source.mjs';

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function decodeVKey(vKey) {
  if (typeof vKey !== 'string') return undefined;
  if (vKey.startsWith('s:')) return vKey.slice(2);
  if (vKey.startsWith('n:')) return Number(vKey.slice(2));
  if (vKey.startsWith('b:')) return vKey.slice(2) === 'true';
  if (vKey.startsWith('j:')) {
    try { return JSON.parse(vKey.slice(2)); } catch { return undefined; }
  }
  return undefined;
}

function extractWatchTarget(message) {
  const m = String(message || '').match(/monitor for:\s*([\s\S]+)$/i);
  return m ? m[1].trim() : String(message || '');
}

function cleanProposals(userId, userDir) {
  const p = path.join(userDir, 'proposals.json');
  const data = readJsonSafe(p, null);
  if (!data || !Array.isArray(data.proposals)) return 0;
  let changed = 0;
  for (const rec of data.proposals) {
    if (rec.status !== 'pending' && rec.status !== 'snoozed') continue;
    let reason = null;
    if (rec.kind === 'default_arg') {
      if (rec.userAuthored !== true) reason = 'default_arg lacks user-authored evidence';
      else if (!_testIsPinnable(rec.tool, rec.arg, rec.value)) reason = 'default_arg no longer passes safety gates';
    } else if (rec.kind === 'watch' && !rec.watchSourceKey && /monitor for:/i.test(rec.message || '')) {
      const source = extractMonitorableSource(extractWatchTarget(rec.message));
      if (!source.ok) reason = 'watch proposal lacks a nameable source';
    }
    if (!reason) continue;
    rec.status = 'failed';
    rec.outcome = `Purged by learning cleanup: ${reason}.`;
    rec.endedAt = Date.now();
    changed++;
  }
  if (changed) writeJson(p, data);
  return changed;
}

function cleanCounts(userDir) {
  const p = path.join(userDir, 'tool-arg-counts.json');
  const counts = readJsonSafe(p, null);
  if (!counts || typeof counts !== 'object') return 0;
  let removed = 0;
  for (const [key, valueBuckets] of Object.entries({ ...counts })) {
    if (!key.includes('.') || !valueBuckets || typeof valueBuckets !== 'object') {
      delete counts[key];
      removed++;
      continue;
    }
    const dot = key.indexOf('.');
    const tool = key.slice(0, dot);
    const arg = key.slice(dot + 1);
    for (const [vKey] of Object.entries({ ...valueBuckets })) {
      const value = decodeVKey(vKey);
      if (value === undefined || !_testIsPinnable(tool, arg, value)) {
        delete valueBuckets[vKey];
        removed++;
      }
    }
    if (!Object.keys(valueBuckets).length) delete counts[key];
  }
  if (removed) writeJson(p, counts);
  return removed;
}

let proposalCount = 0;
let countBuckets = 0;
for (const entry of fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR, { withFileTypes: true }) : []) {
  if (!entry.isDirectory()) continue;
  const userId = entry.name;
  const userDir = path.join(USERS_DIR, userId);
  proposalCount += cleanProposals(userId, userDir);
  countBuckets += cleanCounts(userDir);
}

console.log(JSON.stringify({ ok: true, proposalsPurged: proposalCount, countBucketsPruned: countBuckets }, null, 2));
