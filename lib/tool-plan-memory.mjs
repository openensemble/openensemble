import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const MAX_RECIPES = 120;
const MATCH_THRESHOLD = 0.58;

function storePath(userId) {
  return path.join(USERS_DIR, userId, 'tool-plan-recipes.json');
}

function loadStore(userId) {
  try {
    const p = storePath(userId);
    if (!fs.existsSync(p)) return { version: 1, recipes: [] };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { version: 1, recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [] };
  } catch {
    return { version: 1, recipes: [] };
  }
}

function saveStore(userId, store) {
  const p = storePath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    recipes: (store.recipes || []).slice(0, MAX_RECIPES),
  }, null, 2));
}

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\w@.]+/g, ' ')
    .replace(/\b\d+\b/g, ' number ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseTokens(text) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'my', 'me', 'i', 'you', 'and', 'or', 'that', 'this', 'it', 'please']);
  return normalizePhrase(text).split(' ').filter(t => t.length > 1 && !stop.has(t));
}

function tokenScore(a, b) {
  const at = new Set(phraseTokens(a));
  const bt = new Set(phraseTokens(b));
  if (!at.size || !bt.size) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap / Math.max(at.size, bt.size);
}

function stableAgentId(agentId, userId) {
  const raw = String(agentId || '').trim();
  const prefix = `${userId}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function cleanTools(tools) {
  return [...new Set((Array.isArray(tools) ? tools : [])
    .filter(t => typeof t === 'string')
    .map(t => t.trim())
    .filter(t => /^[A-Za-z0-9_.:-]{1,120}$/.test(t)))];
}

export function rememberToolPlan(userId, { agentId, phrase, selectedTools, mode = 'selected', source = 'user' } = {}) {
  if (!userId || !phrase || !agentId) return { ok: false, error: 'userId, agentId, and phrase are required' };
  const cleanMode = mode === 'none' ? 'none' : 'selected';
  const tools = cleanTools(selectedTools);
  if (cleanMode === 'selected' && !tools.length) return { ok: false, error: 'selectedTools are required' };
  const store = loadStore(userId);
  const targetAgentId = stableAgentId(agentId, userId);
  const norm = normalizePhrase(phrase);
  const existing = store.recipes.find(r =>
    r.agentId === targetAgentId && (r.examples || []).some(ex => tokenScore(ex, norm) >= 0.8)
  );
  const rec = existing || {
    id: `tool_recipe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agentId: targetAgentId,
    examples: [],
    createdAt: Date.now(),
  };
  rec.examples = [String(phrase).trim(), ...(rec.examples || []).filter(ex => normalizePhrase(ex) !== norm)].slice(0, 8);
  rec.mode = cleanMode;
  rec.selectedTools = tools;
  rec.source = String(source || 'user').slice(0, 80);
  rec.updatedAt = Date.now();
  if (!existing) store.recipes.unshift(rec);
  store.recipes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  saveStore(userId, store);
  return { ok: true, recipe: rec };
}

export function matchToolPlan(userId, { agentId, phrase } = {}) {
  if (!userId || !agentId || !phrase) return null;
  const targetAgentId = stableAgentId(agentId, userId);
  let best = null;
  for (const rec of loadStore(userId).recipes) {
    if (rec.agentId !== targetAgentId) continue;
    for (const ex of rec.examples || []) {
      const score = tokenScore(phrase, ex);
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { ...rec, score };
    }
  }
  if (!best) return null;
  return {
    mode: best.mode === 'none' ? 'none' : 'selected',
    selectedTools: cleanTools(best.selectedTools),
    source: 'server-remembered',
    recipeId: best.id,
    score: best.score,
  };
}
