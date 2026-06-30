// @ts-check
/**
 * Full teardown of a deleted skill's LEARNED state.
 *
 * skill-builder handleDelete already removes the skill dir, manifest, drawer,
 * LanceDB triggers, intent embeddings, profile entry, and the skill's state JSON.
 * This adds the learned/remembered state that's CLEANLY ATTRIBUTABLE to the skill:
 *
 *   by skillId      → standing role rules (role-rules/<skillId>.md), skill
 *                     overrides, learned dispatch utterances
 *   by tool names   → tool-plan recipes, pinned default args, tool-failure history
 *
 * NOT purged — and deliberately so: free-form memory facts ("what I've learned
 * about you"). Those carry no skill tag, so auto-attribution would mean a semantic
 * guess that risks deleting unrelated facts. Left for the user to prune by hand.
 *
 * Every step is independently guarded — a teardown failure must never block the
 * skill deletion itself. Returns a summary the caller can surface.
 */
import fs from 'fs';
import path from 'path';
import { userRoleRulesDir } from './paths.mjs';
import { clearSkillOverride } from './skill-overrides.mjs';
import { listDefaults, unpinDefault } from './tool-defaults.mjs';
import { purgeToolFailures } from './tool-failures.mjs';
import { forgetToolPlansForTools } from './tool-plan-memory.mjs';
import { purgeSkillIntents } from './learned-intents.mjs';

export async function purgeSkillState(userId, { skillId, toolNames = [] } = {}) {
  if (!userId || !skillId) return {};
  const summary = {};
  const tools = new Set((toolNames || []).filter(Boolean));

  // 0. Cancel the skill's registered watchers so a deleted skill stops firing
  //    with no handler ("Handler not found" spam). Keyed by skillId per watcher.
  try {
    const { unregisterMatchingWatchers } = await import('../scheduler/watchers.mjs');
    const n = unregisterMatchingWatchers(userId, w => (w.skillId || null) === skillId, 'skill-deleted');
    if (n) summary.watchers = n;
  } catch (e) { summary.watchersError = e.message; }

  // 1. Standing role rules + their deleted-log tombstone (keyed by skillId).
  try {
    const dir = userRoleRulesDir(userId);
    let n = 0;
    for (const f of [`${skillId}.md`, `${skillId}.deleted.log`]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); n++; }
    }
    if (n) summary.rules = n;
  } catch (e) { summary.rulesError = e.message; }

  // 2. Skill overrides (keyed by skillId).
  try { await clearSkillOverride(userId, skillId); summary.overridesCleared = true; }
  catch (e) { summary.overridesError = e.message; }

  // 3. Learned dispatch utterances (keyed by skillId).
  try { const r = await purgeSkillIntents(userId, skillId); if (r.removed) summary.learnedIntents = r.removed; }
  catch (e) { summary.intentsError = e.message; }

  // 4. Tool-keyed learnings (by the skill's own tool names).
  if (tools.size) {
    try {
      let unpinned = 0;
      for (const d of (listDefaults(userId) || [])) {
        if (tools.has(d.tool)) { await unpinDefault(userId, d.tool, d.arg); unpinned++; }
      }
      if (unpinned) summary.pinnedDefaults = unpinned;
    } catch (e) { summary.defaultsError = e.message; }
    try { const r = await purgeToolFailures(userId, [...tools]); if (r.removed) summary.toolFailures = r.removed; }
    catch (e) { summary.failuresError = e.message; }
    try { const r = forgetToolPlansForTools(userId, [...tools]); if (r.removed) summary.recipes = r.removed; }
    catch (e) { summary.recipesError = e.message; }
  }

  return summary;
}

/** One-line human summary of what purgeSkillState removed, or '' if nothing. */
export function summarizePurge(summary = {}) {
  const parts = [];
  if (summary.watchers) parts.push(`${summary.watchers} watcher(s)`);
  if (summary.rules) parts.push(`${summary.rules} rule file(s)`);
  if (summary.learnedIntents) parts.push(`${summary.learnedIntents} learned intent(s)`);
  if (summary.recipes) parts.push(`${summary.recipes} recipe(s)`);
  if (summary.pinnedDefaults) parts.push(`${summary.pinnedDefaults} pinned default(s)`);
  if (summary.toolFailures) parts.push(`${summary.toolFailures} failure record(s)`);
  if (summary.overridesCleared) parts.push('skill overrides');
  return parts.join(', ');
}
