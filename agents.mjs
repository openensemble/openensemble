/**
 * Agent definitions for OpenEnsemble.
 * Each agent has an id, display name, model, system prompt, and tool list.
 */

import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync, watch } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import { CFG_PATH, USERS_DIR, readConfig } from './lib/paths.mjs';
// Simple in-process caches — invalidated on write or file change
let _customAgentsCache = null; // cache of ALL agents across all user files
let _modelOverridesCache = null;

// Invalidate caches when files change externally (direct edits, model hot-swap)
try {
  if (existsSync(USERS_DIR)) {
    watch(USERS_DIR, { recursive: true }, (_, filename) => {
      if (filename?.endsWith('agents.json')) _customAgentsCache = null;
    });
  }
  if (existsSync(CFG_PATH)) {
    watch(CFG_PATH, () => { _modelOverridesCache = null; });
  }
} catch (e) { console.warn('[agents] fs.watch unavailable:', e.message); }

// ── Custom agent persistence ───────────────────────────────────────────────────
function getUserAgentsPath(userId) {
  return path.join(USERS_DIR, userId, 'agents.json');
}

// outputDir, if set, must resolve inside the owner's own documents folder.
// Prevents granting an agent access to /etc, /root, another user's data, or
// anywhere outside the user's private scope.
function validateOutputDir(userId, outputDir) {
  if (!outputDir) return;
  if (!userId || userId === 'shared') {
    throw new Error('outputDir requires an owning user — shared agents cannot have an outputDir');
  }
  const allowedRoot = path.resolve(path.join(USERS_DIR, userId, 'documents'));
  const resolved = path.resolve(outputDir);
  const rel = path.relative(allowedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`outputDir must be inside your documents folder (${allowedRoot})`);
  }
}

function loadUserAgents(userId) {
  const p = getUserAgentsPath(userId);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

function saveUserAgents(userId, list) {
  const dir = path.join(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getUserAgentsPath(userId), JSON.stringify(list, null, 2));
  _customAgentsCache = null;
}

export function loadCustomAgents() {
  if (_customAgentsCache) return _customAgentsCache;
  if (!existsSync(USERS_DIR)) return (_customAgentsCache = []);
  try {
    const agents = [];
    for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(USERS_DIR, entry.name, 'agents.json');
      try { if (existsSync(p)) agents.push(...JSON.parse(readFileSync(p, 'utf8'))); } catch {}
    }
    return (_customAgentsCache = agents);
  } catch { return (_customAgentsCache = []); }
}

function buildSystemPrompt(name, emoji, description) {
  // Identity-only template. Role/capability guidance is injected at runtime
  // from skill manifests' systemPromptAddition based on which tools resolve
  // for this agent (see routes/_helpers.mjs:getAgentsForUser).
  // {{AGENT_NAME}} / {{AGENT_EMOJI}} are expanded per-request so the stored
  // prompt stays portable across renames and role swaps.
  return `You are {{AGENT_NAME}} {{AGENT_EMOJI}}, {{USER_NAME}}'s AI assistant. ${description}

Be concise and direct. {{USER_NAME}} prefers short, focused answers over long explanations.

You have access to persistent memory — relevant facts from past conversations may appear in your context. Use them naturally. When {{USER_NAME}} says "remember X", confirm briefly. When they say "forget X", confirm it's been removed.`;
}

export function createCustomAgent({ name, emoji = '🤖', description, model, provider, toolSet = 'web', systemPrompt, outputDir, maxTokens, contextSize, ownerId = null }) {
  if (outputDir) validateOutputDir(ownerId, outputDir);
  const id = 'agent_' + randomBytes(4).toString('hex');
  const agent = {
    id, name, emoji,
    model:    model    ?? getCoordinatorModel().model,
    provider: provider ?? getCoordinatorModel().provider,
    toolSet,
    description,
    systemPrompt: systemPrompt ?? buildSystemPrompt(name, emoji, description),
    custom: true,
    ...(ownerId    ? { ownerId }    : {}),
    ...(outputDir  ? { outputDir }  : {}),
    ...(maxTokens  ? { maxTokens }  : {}),
    ...(contextSize ? { contextSize } : {}),
  };
  const userId = ownerId ?? 'shared';
  const list = loadUserAgents(userId);
  list.push(agent);
  saveUserAgents(userId, list);
  return agent;
}

export function updateCustomAgent(id, changes) {
  if (changes && 'ownerId' in changes) {
    throw new Error('ownerId is immutable; agents cannot be transferred between users');
  }
  const all = loadCustomAgents();
  const existing = all.find(a => a.id === id);
  if (!existing) return null;
  const userId = existing.ownerId ?? 'shared';
  if (changes && 'outputDir' in changes && changes.outputDir) {
    validateOutputDir(userId, changes.outputDir);
  }
  const list = loadUserAgents(userId);
  const idx = list.findIndex(a => a.id === id);
  if (idx === -1) return null;
  const prev = list[idx];
  const next = { ...prev, ...changes };
  if (!changes.systemPrompt && (changes.name || changes.emoji || changes.description)) {
    next.systemPrompt = buildSystemPrompt(
      next.name, next.emoji, next.description ?? prev.description ?? ''
    );
  }
  list[idx] = next;
  saveUserAgents(userId, list);
  return list[idx];
}

export function deleteCustomAgent(id) {
  const all = loadCustomAgents();
  const existing = all.find(a => a.id === id);
  if (!existing) return;
  const userId = existing.ownerId ?? 'shared';
  const list = loadUserAgents(userId).filter(a => a.id !== id);
  saveUserAgents(userId, list);
}

// Update name/emoji for ANY agent (built-in or custom) — built-ins stored in config.json
export function updateAgentMeta(id, changes) {
  // Custom agents: update the JSON file
  const customs = loadCustomAgents();
  if (customs.find(a => a.id === id)) return updateCustomAgent(id, changes);

  // Built-in agents: store name/emoji overrides in config.json agentModels
  const allowed = {};
  if (changes.name)  allowed.name  = changes.name;
  if (changes.emoji) allowed.emoji = changes.emoji;
  if (!Object.keys(allowed).length) return null;
  try {
    const cfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};
    cfg.agentModels = cfg.agentModels ?? {};
    cfg.agentModels[id] = { ...(cfg.agentModels[id] ?? {}), ...allowed };
    writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
    invalidateModelOverridesCache();
    return getAgent(id);
  } catch (e) { console.warn('[agents] Failed to update agent meta:', e.message); return null; }
}

function getAgentModelOverrides() {
  if (_modelOverridesCache) return _modelOverridesCache;
  const cfg = readConfig();
  _modelOverridesCache = cfg.agentModels ?? {};
  return _modelOverridesCache;
}

export function invalidateModelOverridesCache() {
  _modelOverridesCache = null;
}

/**
 * Returns the ID of the coordinator agent from config.
 */
export function getCoordinatorAgentId() {
  const cfg = readConfig();
  return cfg.coordinatorAgent ?? null;
}

/**
 * Returns { model, provider } for the coordinator agent,
 * resolving config overrides over the custom agent definition.
 */
function getCoordinatorModel() {
  const coordId = getCoordinatorAgentId();
  const overrides = getAgentModelOverrides()[coordId] ?? {};
  const agent = loadCustomAgents().find(a => a.id === coordId);
  return {
    model:    overrides.model    ?? agent?.model    ?? 'claude-sonnet-4-6',
    provider: overrides.provider ?? agent?.provider ?? 'anthropic',
  };
}

export function getAgentScope(id) {
  const agent = loadCustomAgents().find(a => a.id === id);
  const overrides = getAgentModelOverrides()[id] ?? {};
  const scope = overrides.scope ?? agent?.scope ?? 'private';
  const shareGroup = overrides.shareGroup ?? agent?.shareGroup ?? null;
  const crossAgentRead = overrides.crossAgentRead ?? agent?.crossAgentRead ?? [];
  return { scope, shareGroup, crossAgentRead };
}

export function getAgent(id) {
  const overrides = getAgentModelOverrides();
  const agent = loadCustomAgents().find(a => a.id === id) ?? null;
  if (!agent) return null;
  const a = overrides[id] ? { ...agent, ...overrides[id] } : agent;
  return { ...a, tools: a.tools ?? [] };
}

export function listAgents() {
  const overrides = getAgentModelOverrides();
  return loadCustomAgents().map(a => {
    const resolved = overrides[a.id] ? { ...a, ...overrides[a.id] } : a;
    return { ...resolved, tools: resolved.tools ?? [] };
  });
}
