// @ts-check
/**
 * Compact, privacy-safe inventory of what the user already runs in OE.
 *
 * Personalization facts alone do not know about live skills, watches, tasks,
 * or nodes — so chat recommendations and reflection both re-propose work that
 * is already done. This module builds a short deterministic summary from
 * on-disk user state so the model can prefer real gaps over re-setup.
 *
 * Only labels and structural counts are included — never secrets, tool
 * outputs, email content, or raw config bodies.
 */
import fs from 'fs';
import path from 'path';
import { BASE_DIR, USERS_DIR, userSkillsDir } from '../paths.mjs';

const DEFAULT_MAX_CHARS = 520;
const MAX_SKILLS = 12;
const MAX_WATCHES = 14;
const MAX_TASKS = 8;
const MAX_NODES = 12;
const MAX_ORPHANS = 6;

function cleanLabel(value, max = 48) {
  return String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJsonIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listCustomSkills(userId) {
  const dir = userSkillsDir(userId);
  /** @type {string[]} */
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const manifestPath = path.join(dir, entry.name, 'manifest.json');
      const manifest = readJsonIfPresent(manifestPath);
      const name = cleanLabel(manifest?.name || manifest?.id || entry.name, 40);
      if (name) out.push(name);
      if (out.length >= MAX_SKILLS) break;
    }
  } catch { /* best-effort */ }
  return out;
}

function listActiveWatches(userId) {
  const data = readJsonIfPresent(path.join(USERS_DIR, userId, 'watchers.json'));
  const active = Array.isArray(data?.active) ? data.active : [];
  /** @type {string[]} */
  const out = [];
  for (const w of active) {
    if (!w || typeof w !== 'object') continue;
    // Transient task proxies are not standing setup the model should treat as
    // durable automation inventory.
    if (w.kind === 'task_proxy') continue;
    if (w.status && w.status !== 'active') continue;
    const label = cleanLabel(w.label || w.kind || w.skillId || w.id, 56);
    if (!label) continue;
    out.push(label);
    if (out.length >= MAX_WATCHES) break;
  }
  return out;
}

function listTasks(userId) {
  const data = readJsonIfPresent(path.join(USERS_DIR, userId, 'tasks.json'));
  const tasks = Array.isArray(data) ? data : (Array.isArray(data?.tasks) ? data.tasks : []);
  /** @type {string[]} */
  const out = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    // Prompts are task instructions and can contain private or adversarial
    // content. Inventory only needs a display label, so fall back to the
    // structural id rather than exposing the raw prompt.
    const label = cleanLabel(t.label || t.name || t.id, 48);
    if (!label) continue;
    const enabled = t.enabled !== false && t.status !== 'disabled' && t.status !== 'paused';
    out.push(enabled ? label : `${label} (paused)`);
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

function listNodes(userId) {
  const data = readJsonIfPresent(path.join(BASE_DIR, 'nodes.json'));
  const nodes = Array.isArray(data?.nodes) ? data.nodes : (Array.isArray(data) ? data : []);
  /** @type {string[]} */
  const live = [];
  /** @type {Set<string>} */
  const liveIds = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n.userId && n.userId !== userId) continue;
    const id = cleanLabel(n.nodeId || n.hostname, 40);
    if (!id) continue;
    liveIds.add(id.toLowerCase());
    // Keep the complete registered-id set for orphan detection even when the
    // human-readable inventory has reached its display cap.
    if (live.length < MAX_NODES) {
      const stale = n.disconnectedAt != null;
      live.push(stale ? `${id} (disconnected)` : id);
    }
  }

  /** @type {string[]} */
  const orphans = [];
  try {
    const nodesDir = path.join(USERS_DIR, userId, 'nodes');
    if (fs.existsSync(nodesDir)) {
      for (const entry of fs.readdirSync(nodesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const name = cleanLabel(entry.name, 40);
        if (!name) continue;
        if (liveIds.has(name.toLowerCase())) continue;
        orphans.push(name);
        if (orphans.length >= MAX_ORPHANS) break;
      }
    }
  } catch { /* best-effort */ }

  return { live, orphans };
}

/**
 * Build a short multi-line inventory for prompt injection.
 *
 * @param {string} userId
 * @param {{ maxChars?: number }} [opts]
 * @returns {{ text: string, empty: boolean, meta: { skills: number, watches: number, tasks: number, nodes: number, orphanNodes: number } }}
 */
export function buildSetupInventory(userId, opts = {}) {
  const maxChars = Math.max(120, Math.min(1200, Number(opts.maxChars) || DEFAULT_MAX_CHARS));
  if (!userId || typeof userId !== 'string') {
    return { text: '', empty: true, meta: { skills: 0, watches: 0, tasks: 0, nodes: 0, orphanNodes: 0 } };
  }

  const skills = listCustomSkills(userId);
  const watches = listActiveWatches(userId);
  const tasks = listTasks(userId);
  const { live: nodes, orphans } = listNodes(userId);

  const lines = [];
  if (skills.length) lines.push(`Custom skills: ${skills.join('; ')}`);
  if (watches.length) lines.push(`Active watches: ${watches.join('; ')}`);
  if (tasks.length) lines.push(`Scheduled tasks: ${tasks.join('; ')}`);
  if (nodes.length) lines.push(`Nodes: ${nodes.join('; ')}`);
  if (orphans.length) {
    lines.push(`Orphan node profiles (no live agent): ${orphans.join('; ')}`);
  }

  if (!lines.length) {
    return {
      text: '',
      empty: true,
      meta: { skills: 0, watches: 0, tasks: 0, nodes: 0, orphanNodes: 0 },
    };
  }

  // Header is instructional for the model, not user data.
  let text = 'Already set up (do not re-recommend as new work unless broken):\n' + lines.join('\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…';
  }

  return {
    text,
    empty: false,
    meta: {
      skills: skills.length,
      watches: watches.length,
      tasks: tasks.length,
      nodes: nodes.length,
      orphanNodes: orphans.length,
    },
  };
}
