/**
 * Expense groups, expense books, per-user activity tracking,
 * token usage recording, and share-group resolution.
 *
 * Imports from '../_helpers.mjs' are function-scoped (loadConfig) to avoid
 * circular-import TDZ at module init.
 */

import fs from 'fs';
import path from 'path';
import {
  EXPENSE_GROUPS_PATH, EXPENSE_BOOKS_PATH, BASE_DIR, getUserDir,
} from './paths.mjs';
import { withLock, makeModify } from './io-lock.mjs';
import { loadConfig } from '../_helpers.mjs';

// ── Expense groups ───────────────────────────────────────────────────────────
export function loadExpGroups() {
  try { if (fs.existsSync(EXPENSE_GROUPS_PATH)) return JSON.parse(fs.readFileSync(EXPENSE_GROUPS_PATH, 'utf8')); } catch (e) { console.warn('[expenses] Failed to load groups.json:', e.message); }
  return [];
}
export function saveExpGroups(list) { fs.mkdirSync(path.dirname(EXPENSE_GROUPS_PATH), { recursive: true }); fs.writeFileSync(EXPENSE_GROUPS_PATH, JSON.stringify(list, null, 2)); }
export function getExpGroupForUser(userId) { return loadExpGroups().find(g => g.memberIds.includes(userId)) ?? null; }
export function getExpGroupMemberIds(userId) { const g = getExpGroupForUser(userId); return g ? g.memberIds : [userId]; }

// ── Expense books ────────────────────────────────────────────────────────────
export function loadExpBooks() {
  try { if (fs.existsSync(EXPENSE_BOOKS_PATH)) return JSON.parse(fs.readFileSync(EXPENSE_BOOKS_PATH, 'utf8')); } catch (e) { console.warn('[expenses] Failed to load books.json:', e.message); }
  return [];
}
export function saveExpBooks(list) { fs.mkdirSync(path.dirname(EXPENSE_BOOKS_PATH), { recursive: true }); fs.writeFileSync(EXPENSE_BOOKS_PATH, JSON.stringify(list, null, 2)); }
export function getExpBooksForUser(userId) {
  return loadExpBooks().filter(b => b.ownerId === userId || (b.sharedWith ?? []).includes(userId));
}

export const modifyExpGroups = makeModify(loadExpGroups, saveExpGroups, EXPENSE_GROUPS_PATH);
export const modifyExpBooks  = makeModify(loadExpBooks,  saveExpBooks,  EXPENSE_BOOKS_PATH);

// ── Share group resolution ───────────────────────────────────────────────────
export function resolveShareGroup(groupType, userId) {
  if (groupType === 'expense') return getExpGroupMemberIds(userId);
  return [userId]; // unknown group type — no sharing
}

// ── Activity tracking ────────────────────────────────────────────────────────
// loadActivity(userId) → per-user data { date: { ... } }
// loadActivity()       → all users     { userId: { date: { ... } } }  (admin view)
export function loadActivity(userId) {
  if (userId) {
    const p = path.join(getUserDir(userId), 'activity.json');
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.warn('[activity] Failed to load activity for', userId + ':', e.message); }
    return {};
  }
  // All users — scan users subdirectories
  const usersDir = path.join(BASE_DIR, 'users');
  if (!fs.existsSync(usersDir)) return {};
  const result = {};
  try {
    for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(usersDir, entry.name, 'activity.json');
      try { if (fs.existsSync(p)) result[entry.name] = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    }
  } catch (e) { console.warn('[activity] Failed to read users dir for activity:', e.message); }
  return result;
}
export function saveActivity(data, userId) {
  const dir = getUserDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify(data, null, 2)); }
  catch (e) { console.warn('[activity] Failed to save activity for', userId + ':', e.message); }
}
export function modifyActivity(userId, fn) {
  const userPath = path.join(getUserDir(userId), 'activity.json');
  return withLock(userPath, () => {
    const data = loadActivity(userId);
    const result = fn(data);
    saveActivity(data, userId);
    return result;
  });
}
export async function recordActivity(userId, agentId, { message = false, apiCall = false } = {}) {
  if (!userId || userId === 'default') return;
  await modifyActivity(userId, data => {
    const today = new Date().toISOString().slice(0, 10);
    if (!data[today]) data[today] = { messages: 0, apiCalls: 0, agentUsage: {} };
    const day = data[today];
    if (message) day.messages++;
    if (apiCall) day.apiCalls++;
    if (agentId && message) day.agentUsage[agentId] = (day.agentUsage[agentId] ?? 0) + 1;
  });
}

// ── Token usage tracking ────────────────────────────────────────────────────
function estimateCost(provider, model, input, output) {
  if (provider === 'ollama' || provider === 'lmstudio') return 0; // local models
  if (provider === 'anthropic') return (input * 3 + output * 15) / 1_000_000;
  if (provider === 'fireworks') return (input * 3 + output * 15) / 1_000_000;
  if (provider === 'grok') return (input * 5 + output * 15) / 1_000_000;
  if (provider === 'openrouter') {
    try {
      const cfg = loadConfig();
      const p = cfg.openrouterPricing?.[model];
      if (p) return (input * p.input + output * p.output) / 1_000_000;
    } catch { /* ignore */ }
  }
  return 0;
}

export async function recordTokenUsage(userId, inputTokens, outputTokens, provider, model) {
  if (!userId || userId === 'default' || (!inputTokens && !outputTokens)) return;
  await modifyActivity(userId, data => {
    const today = new Date().toISOString().slice(0, 10);
    if (!data[today]) data[today] = { messages: 0, apiCalls: 0, agentUsage: {} };
    const day = data[today];
    if (!day.tokensByModel) day.tokensByModel = {};
    const key = `${provider}||${model}`;
    if (!day.tokensByModel[key]) day.tokensByModel[key] = { input: 0, output: 0, cost: 0 };
    day.tokensByModel[key].input += inputTokens;
    day.tokensByModel[key].output += outputTokens;
    const cost = estimateCost(provider, model, inputTokens, outputTokens);
    day.tokensByModel[key].cost = Math.round((day.tokensByModel[key].cost + cost) * 1e6) / 1e6;
    day.totalEstimatedCost = Math.round(((day.totalEstimatedCost ?? 0) + cost) * 1e6) / 1e6;
  });
}
