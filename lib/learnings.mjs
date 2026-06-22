// @ts-check
/**
 * Aggregated learnings reader for the Learn drawer (the "What I've learned
 * about you" surface).
 *
 * Reads scattered per-user state and normalizes it into a single payload:
 *  - rules        — per-role standing rules from role-rules/<id>.md
 *  - aliases      — HA noun aliases from ha-aliases.json
 *  - routines     — phrase→action routines from routines.json
 *  - skills       — user-created skill manifests from users/<id>/skills/
 *  - recentAccepted — proposals accepted in the last 30d (audit trail)
 *
 * Read-only — revoke happens via existing helpers (deleteAlias, saveRoutines,
 * skill_delete) called from the route layer. This file MUST NOT write.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR, userRoleRulesDir, userSkillsDir } from './paths.mjs';
import { listDefaults, unpinDefault } from './tool-defaults.mjs';
import { listRecentFailures } from './tool-failures.mjs';
import { summarizeByKind, getOutcome } from './proposal-outcomes.mjs';
import { loadOverrides, removeOverride } from './routing-overrides.mjs';
import { loadLearnedIntents, removeLearnedUtterance } from './learned-intents.mjs';
import { getAllStatuses, resetKind } from './proposal-salience.mjs';
import { listSkillOverrides, setSkillOverride, clearSkillOverride } from './skill-overrides.mjs';

const RECENT_ACCEPTED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function listRules(userId) {
  const dir = userRoleRulesDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const roleId = ent.name.replace(/\.md$/, '');
    const fpath = path.join(dir, ent.name);
    let text;
    try { text = fs.readFileSync(fpath, 'utf8'); } catch { continue; }
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
    if (!lines.length) continue;
    const rules = lines.map((line, idx) => ({
      idx,
      text: line.replace(/^-\s+/, '').trim(),
    }));
    out.push({ roleId, rules });
  }
  return out;
}

function listAliases(userId) {
  const p = path.join(USERS_DIR, userId, 'ha-aliases.json');
  const data = readJsonSafe(p);
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([phrase, entityId]) => ({ phrase, entityId }));
}

function listRoutines(userId) {
  const p = path.join(USERS_DIR, userId, 'routines.json');
  const data = readJsonSafe(p);
  const arr = data?.routines;
  if (!Array.isArray(arr)) return [];
  return arr.map(r => ({
    id: r.id,
    trigger: r.trigger,
    aliases: r.aliases ?? [],
    actionCount: Array.isArray(r.actions) ? r.actions.length : 0,
    firstAction: Array.isArray(r.actions) && r.actions[0] ? summarizeAction(r.actions[0]) : '',
    deviceId: r.device_id ?? null,
  }));
}

function summarizeAction(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.type === 'ha_scene')     return `${a.verb || 'call'} ${a.scene_id || ''}`.trim();
  if (a.type === 'play_ambient') return `play ${a.file || 'audio'}`;
  if (a.type === 'tts_say')      return `say "${String(a.text || '').slice(0, 40)}"`;
  return a.type || '';
}

function listSkills(userId) {
  const dir = userSkillsDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const mpath = path.join(dir, ent.name, 'manifest.json');
    const m = readJsonSafe(mpath);
    if (!m) continue;
    out.push({
      id: m.id || ent.name,
      name: m.name || m.id || ent.name,
      description: m.description || '',
      icon: m.icon || '',
      toolCount: Array.isArray(m.tools) ? m.tools.length : 0,
      createdAt: m.createdAt || null,
    });
  }
  return out;
}

function listRecentAccepted(userId) {
  const p = path.join(USERS_DIR, userId, 'proposals.json');
  const data = readJsonSafe(p);
  const arr = data?.proposals;
  if (!Array.isArray(arr)) return [];
  const cutoff = Date.now() - RECENT_ACCEPTED_WINDOW_MS;
  return arr
    .filter(r => r.status === 'accepted' && (r.endedAt || 0) > cutoff)
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .slice(0, 50)
    .map(r => {
      const o = getOutcome(userId, r.id);
      return {
        id: r.id,
        kind: r.kind,
        endedAt: r.endedAt || null,
        outcome: r.outcome || '',
        summary: summarizeProposal(r),
        agentId: r.agentId || null,
        // outcome telemetry — null if not yet measured (7d post-window not
        // elapsed) or if the proposal predates Phase 4 wiring.
        deltaMeasured: o && (o.postCount !== null && o.postCount !== undefined) ? true : false,
        delta: o?.delta ?? null,
        preCount: o?.preCount ?? null,
        postCount: o?.postCount ?? null,
        semantic: o?.semantic ?? null,
        note: o?.note ?? null,
        measurerUsed: o?.measurerUsed ?? null,
      };
    });
}

function summarizeProposal(r) {
  switch (r.kind) {
    case 'rule_promotion':    return r.ruleText ? `Rule: ${r.ruleText}` : 'Rule added';
    case 'alias_proposal':    return r.phrase && r.entityId ? `Alias: "${r.phrase}" → ${r.entityId}` : 'Alias added';
    case 'routine_proposal':  return r.trigger && r.entityId ? `Routine: "${r.trigger}" → ${r.service || 'call'} ${r.entityId}` : 'Routine added';
    case 'skill_proposal':    return `Skill built from ${Array.isArray(r.toolNames) ? r.toolNames.length : 0} tools`;
    case 'skill_deprecation': return r.skillId ? `Deleted skill: ${r.skillId}` : 'Skill deleted';
    case 'skill_refine':      return r.skillId ? `Refined skill: ${r.skillId}` : 'Skill refined';
    case 'location_fact':     return r.hostname && r.foundPath ? `Location: ${r.hostname} → ${r.foundPath}` : 'Location pinned';
    case 'learned_intent':    return r.skillId && r.intentId ? `Learned phrasings: ${r.skillId}/${r.intentId}` : 'Local phrasing learned';
    case 'recurring_task':    return 'Recurring task created';
    case 'watch':             return 'Watcher created';
    default:                  return r.kind || 'change';
  }
}

// Phase-3 learned local-intent phrasings, flattened for the Learn drawer.
export function listLearnedIntents(userId) {
  const obj = loadLearnedIntents(userId);
  const out = [];
  for (const [skillId, intents] of Object.entries(obj || {})) {
    for (const [intentId, v] of Object.entries(intents || {})) {
      out.push({
        skillId, intentId,
        tool: v?.tool || null,
        utterances: Array.isArray(v?.utterances) ? v.utterances : [],
        learnedAt: v?.learnedAt || null,
      });
    }
  }
  return out;
}

export function readLearnings(userId) {
  if (!userId) return null;
  return {
    rules:          listRules(userId),
    aliases:        listAliases(userId),
    routines:       listRoutines(userId),
    defaults:       listDefaults(userId),
    routingOverrides: loadOverrides(userId),
    learnedIntents: listLearnedIntents(userId),
    failures:       listRecentFailures(userId),
    skills:         listSkills(userId),
    recentAccepted: listRecentAccepted(userId),
    outcomesByKind: summarizeByKind(userId),
    salienceStatus: getAllStatuses(userId),
    skillOverrides:  listSkillOverrides(userId),
  };
}

// ── Revokes ────────────────────────────────────────────────────────────────
// Each revoke writes the removed value to a sibling `.deleted.log` file
// before mutating the live store, so a user can recover a mistaken delete.

function appendDeletedLog(userId, name, entry) {
  const p = path.join(USERS_DIR, userId, `${name}.deleted.log`);
  try {
    fs.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch (e) {
    console.warn('[learnings] deleted-log write failed:', e.message);
  }
}

/**
 * Remove a single rule line from users/<id>/role-rules/<roleId>.md by index.
 * Index is the position in the filtered list returned by readLearnings — the
 * UI passes it back so the user can revoke by row, not by line text.
 */
export function revokeRule(userId, roleId, idx) {
  if (!userId || !roleId || typeof idx !== 'number' || idx < 0) {
    return { ok: false, error: 'bad args' };
  }
  const dir = userRoleRulesDir(userId);
  const fpath = path.join(dir, `${roleId}.md`);
  if (!fs.existsSync(fpath)) return { ok: false, error: 'not found' };
  const text = fs.readFileSync(fpath, 'utf8');
  const lines = text.split('\n');
  const ruleLineIndices = [];
  lines.forEach((line, i) => { if (line.trim().startsWith('- ')) ruleLineIndices.push(i); });
  if (idx >= ruleLineIndices.length) return { ok: false, error: 'index out of range' };
  const removeAt = ruleLineIndices[idx];
  const removed = lines[removeAt];
  appendDeletedLog(userId, `role-rules/${roleId}`, { line: removed });
  lines.splice(removeAt, 1);
  fs.writeFileSync(fpath, lines.join('\n'), 'utf8');
  return { ok: true, removed: removed.replace(/^-\s+/, '').trim() };
}

export async function revokeAlias(userId, phrase) {
  if (!userId || !phrase) return { ok: false, error: 'bad args' };
  const { deleteAlias, loadAliases, normalizeAliasPhrase } = await import('./ha-aliases.mjs');
  const all = loadAliases(userId) || {};
  // Phrase may arrive un-normalized (e.g. from a proposal payload that
  // captured the raw user input). The store uses normalized keys.
  const normPhrase = normalizeAliasPhrase(phrase);
  const prev = all[normPhrase];
  if (!prev) return { ok: false, error: 'not found' };
  appendDeletedLog(userId, 'ha-aliases', { phrase: normPhrase, entityId: prev });
  deleteAlias(userId, normPhrase);
  return { ok: true, removed: { phrase: normPhrase, entityId: prev } };
}

export async function revokeDefault(userId, tool, arg) {
  if (!userId || !tool || !arg) return { ok: false, error: 'bad args' };
  return unpinDefault(userId, tool, arg);
}

export async function revokeRoutingOverride(userId, id) {
  if (!userId || !id) return { ok: false, error: 'bad args' };
  return removeOverride(userId, id);
}

// Revoke learned phrasings. With `utterances` (proposal undo) → remove just those;
// without (Learn-drawer DELETE) → remove the whole intent's learned set.
export async function revokeLearnedIntent(userId, skillId, intentId, utterances) {
  if (!userId || !skillId || !intentId) return { ok: false, error: 'bad args' };
  if (Array.isArray(utterances) && utterances.length) {
    let removed = 0;
    for (const u of utterances) {
      const r = await removeLearnedUtterance(userId, skillId, intentId, u);
      if (r.ok) removed++;
    }
    return { ok: removed > 0, removed };
  }
  return removeLearnedUtterance(userId, skillId, intentId);   // whole intent
}

export async function resetSalienceKind(userId, kind) {
  if (!userId || !kind) return { ok: false, error: 'bad args' };
  return resetKind(userId, kind);
}

export async function applySkillOverride(userId, skillId, patch) {
  if (!userId || !skillId) return { ok: false, error: 'bad args' };
  return setSkillOverride(userId, skillId, patch);
}

export async function revokeSkillOverride(userId, skillId) {
  if (!userId || !skillId) return { ok: false, error: 'bad args' };
  return clearSkillOverride(userId, skillId);
}

export async function revokeRoutine(userId, routineId) {
  if (!userId || !routineId) return { ok: false, error: 'bad args' };
  const { loadRoutines, saveRoutines } = await import('./routines.mjs');
  const { routines } = loadRoutines(userId);
  const removed = routines.find(r => r.id === routineId);
  if (!removed) return { ok: false, error: 'not found' };
  appendDeletedLog(userId, 'routines', { routine: removed });
  saveRoutines(userId, routines.filter(r => r.id !== routineId));
  return { ok: true, removed: { id: routineId, trigger: removed.trigger } };
}
