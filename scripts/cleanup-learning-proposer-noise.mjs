#!/usr/bin/env node
// @ts-check
/**
 * One-time cleanup for the learning-proposer rework.
 *
 * default_arg is RETIRED (see RETIRED_PROPOSAL_KINDS in learning-policy.mjs):
 * - Fails ALL pending/snoozed default_arg proposals. The boot sweep in
 *   proposals.mjs does this too (kind-retired), so old installs converge on
 *   restart even if this script never runs; running it just writes a clearer
 *   outcome message.
 * - Deletes users/<id>/tool-arg-counts.json — the mining counter store has no
 *   reader or writer anymore.
 * - Fails pending/snoozed monitorable watch proposals whose target is a vague
 *   pronoun/state phrase (pre-source-extraction cards).
 *
 * Accepted pins in tool-defaults.json are untouched — they keep merging.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { extractMonitorableSource } from '../lib/monitorable-source.mjs';

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
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
      reason = 'the default_arg proposer is retired (tool args are model-authored, not user preferences)';
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

function removeCountsFile(userDir) {
  const p = path.join(userDir, 'tool-arg-counts.json');
  if (!fs.existsSync(p)) return 0;
  fs.rmSync(p, { force: true });
  return 1;
}

let proposalCount = 0;
let countFilesRemoved = 0;
for (const entry of fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR, { withFileTypes: true }) : []) {
  if (!entry.isDirectory()) continue;
  const userId = entry.name;
  const userDir = path.join(USERS_DIR, userId);
  proposalCount += cleanProposals(userId, userDir);
  countFilesRemoved += removeCountsFile(userDir);
}

console.log(JSON.stringify({ ok: true, proposalsPurged: proposalCount, countFilesRemoved }, null, 2));
