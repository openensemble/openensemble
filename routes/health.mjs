/**
 * Health check routes:
 *   GET /health          — unauthenticated, lightweight status
 *   GET /api/admin/health — authenticated, full system health for dashboard
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadConfig, loadUsers, requirePrivileged, getUserDir,
  EXPENSES_DB, SESSIONS_PATH,
} from './_helpers.mjs';
import { loadAllTasksForScheduler, isSchedulerRunning } from '../scheduler.mjs';
import { isWatcherRunning } from '../gmail-autolabel.mjs';
import { getActiveTasks as getActiveBgTasks } from '../background-tasks.mjs';
import { readToken as readOpenAIOAuthToken } from '../lib/openai-codex-auth.mjs';
import { getCachedState as getUpdateState } from '../lib/update.mjs';

const BASE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startedAt = Date.now();

// Runtime metrics injected by server.mjs at startup (WebSocket count etc.)
let _runtimeMetricsFn = null;
export function setRuntimeMetricsFn(fn) { _runtimeMetricsFn = fn; }

async function checkProvider(url, timeoutMs = 2500, headers = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    return r.ok;
  } catch (e) { console.debug('[health] Provider check failed for', url + ':', e.message); return false; }
}

async function checkAnthropicKey(apiKey) {
  if (!apiKey) return false;
  try {
    // Use the models endpoint — zero tokens, just validates the key
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch (e) { console.debug('[health] Anthropic key check failed:', e.message); return false; }
}

// Cloud OpenAI-compatible providers that expose a Bearer-auth GET /models endpoint.
// Each entry maps a top-level config field to the URL we hit to validate the key.
// Perplexity is intentionally omitted — it has no /models endpoint, so we fall
// back to "configured iff key present" for it below.
const COMPAT_HEALTH_PROBES = [
  { id: 'openai',     keyField: 'openaiApiKey',     modelsUrl: 'https://api.openai.com/v1/models' },
  { id: 'gemini',     keyField: 'geminiApiKey',     modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models' },
  { id: 'deepseek',   keyField: 'deepseekApiKey',   modelsUrl: 'https://api.deepseek.com/v1/models' },
  { id: 'groq',       keyField: 'groqApiKey',       modelsUrl: 'https://api.groq.com/openai/v1/models' },
  { id: 'mistral',    keyField: 'mistralApiKey',    modelsUrl: 'https://api.mistral.ai/v1/models' },
  { id: 'together',   keyField: 'togetherApiKey',   modelsUrl: 'https://api.together.xyz/v1/models' },
  { id: 'zai',        keyField: 'zaiApiKey',        modelsUrl: 'https://api.z.ai/api/paas/v4/models' },
  { id: 'grok',       keyField: 'grokApiKey',       modelsUrl: 'https://api.x.ai/v1/models' },
  { id: 'openrouter', keyField: 'openrouterApiKey', modelsUrl: 'https://openrouter.ai/api/v1/models' },
  { id: 'fireworks',  keyField: 'fireworksApiKey',  modelsUrl: 'https://api.fireworks.ai/inference/v1/models' },
];

async function checkBearerKey(url, apiKey) {
  if (!apiKey) return false;
  return checkProvider(url, 4000, { Authorization: `Bearer ${apiKey}` });
}

// Any user has a non-expired OpenAI OAuth token (or a refresh token to mint one).
// Returns { configured, ok }. We don't hit the network — the OAuth helper
// auto-refreshes on real use, so a present-and-refreshable token is "healthy".
function openAIOAuthStatus(users) {
  let anyToken = false, anyOk = false;
  for (const u of users) {
    const t = readOpenAIOAuthToken(u.id);
    if (!t) continue;
    anyToken = true;
    const expired = t.expires_at ? Date.now() > t.expires_at : true;
    if (!expired || t.refresh_token) { anyOk = true; break; }
  }
  return { configured: anyToken, ok: anyOk };
}

function gmailTokenStatus(userId) {
  const dir = getUserDir(userId);
  // Check per-account tokens first (email-accounts.json), same as oauth.mjs
  try {
    const accountsPath = path.join(dir, 'email-accounts.json');
    if (fs.existsSync(accountsPath)) {
      const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
      const gmailAccounts = accounts.filter(a => a.provider === 'gmail');
      if (gmailAccounts.length > 0) {
        // Return valid if any per-account token is usable
        for (const a of gmailAccounts) {
          const tp = path.join(dir, `gmail-token-${a.id}.json`);
          if (!fs.existsSync(tp)) continue;
          try {
            const tokens = JSON.parse(fs.readFileSync(tp, 'utf8'));
            const expired = tokens.expiry_date ? Date.now() > tokens.expiry_date : true;
            if (!expired || tokens.refresh_token) return { exists: true, expired: false, hasRefresh: !!tokens.refresh_token };
          } catch (e) { console.warn('[health] Failed to read Gmail account token for', userId + ':', e.message); }
        }
        return { exists: false, expired: true };
      }
    }
  } catch (e) { console.warn('[health] Failed to read email-accounts for', userId + ':', e.message); }
  // Fall back to legacy base token path
  const tokenPath = path.join(dir, 'gmail-token.json');
  if (!fs.existsSync(tokenPath)) return { exists: false, expired: true };
  try {
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const expired = tokens.expiry_date ? Date.now() > tokens.expiry_date : true;
    return { exists: true, expired, hasRefresh: !!tokens.refresh_token };
  } catch (e) { console.warn('[health] Failed to read Gmail token for', userId + ':', e.message); return { exists: false, expired: true }; }
}

function countSessionFiles() {
  const sessDir = path.join(BASE_DIR, 'sessions');
  if (!fs.existsSync(sessDir)) return { files: 0, totalLines: 0 };
  const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
  let totalLines = 0;
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(sessDir, f), 'utf8');
      totalLines += content.split('\n').filter(Boolean).length;
    } catch (e) { console.warn('[health] Failed to read session file', f + ':', e.message); }
  }
  return { files: files.length, totalLines };
}

function countExpenses() {
  if (!fs.existsSync(EXPENSES_DB)) return 0;
  try { return JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')).length; } catch (e) { console.warn('[health] Failed to read expenses DB:', e.message); return 0; }
}

function listCortexUsers() {
  try {
    return fs.readdirSync(BASE_DIR)
      .filter(d => d.startsWith('cortex-') && fs.statSync(path.join(BASE_DIR, d)).isDirectory())
      .map(d => d.replace('cortex-', ''));
  } catch (e) { console.warn('[health] Failed to list cortex users:', e.message); return []; }
}

async function buildFullHealth() {
  const cfg = loadConfig();
  const cortex = cfg.cortex ?? {};
  const ollamaUrl   = (cortex.ollamaUrl ?? 'http://localhost:11434').replace(/\/api\/?$/, '');
  const ollamaKey   = cortex.ollamaApiKey ?? null;
  const lmstudioUrl = cortex.lmstudioUrl ?? 'http://127.0.0.1:1234';
  const users = loadUsers();

  const embedProvider  = cortex.embedProvider ?? 'builtin';
  const reasonProvider = cortex.reasonProvider ?? 'auto';
  const enabled = cfg.enabledProviders ?? {};
  // The toggle is authoritative: if a provider is explicitly disabled
  // (enabledProviders[id] === false) it must not appear in system health,
  // even if its API key is still in config. Default (undefined) is enabled.
  const isEnabled = (id) => enabled[id] !== false;

  const cortexUsesOllama   = embedProvider === 'ollama'   || reasonProvider === 'ollama';
  const cortexUsesLmstudio = embedProvider === 'lmstudio' || reasonProvider === 'lmstudio';
  const anthropicConfigured = !!cfg.anthropicApiKey                                   && isEnabled('anthropic');
  const ollamaConfigured    = (!!ollamaKey || enabled.ollama === true || cortexUsesOllama) && isEnabled('ollama');
  const lmstudioConfigured  = (enabled.lmstudio === true || cortexUsesLmstudio)        && isEnabled('lmstudio');

  // Probe only what's configured
  const ollamaAuthHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};

  // Compat-provider probes: fire only those with a key set AND not toggled
  // off, in parallel with the core probes so the dashboard load stays under
  // the 4s timeout ceiling.
  const compatProbes = COMPAT_HEALTH_PROBES
    .filter(p => !!cfg[p.keyField] && isEnabled(p.id))
    .map(p => ({ id: p.id, promise: checkBearerKey(p.modelsUrl, cfg[p.keyField]) }));

  const [ollamaOk, lmstudioOk, anthropicOk, ...compatResults] = await Promise.all([
    ollamaConfigured    ? checkProvider(`${ollamaUrl}/api/tags`, 2500, ollamaAuthHeaders) : Promise.resolve(null),
    lmstudioConfigured  ? checkProvider(`${lmstudioUrl}/v1/models`)                       : Promise.resolve(null),
    anthropicConfigured ? checkAnthropicKey(cfg.anthropicApiKey)                          : Promise.resolve(null),
    ...compatProbes.map(p => p.promise),
  ]);

  const providers = {};
  if (anthropicConfigured) providers.anthropic = anthropicOk;
  if (ollamaConfigured)    providers.ollama    = ollamaOk;
  if (lmstudioConfigured)  providers.lmstudio  = lmstudioOk;
  compatProbes.forEach((p, i) => { providers[p.id] = compatResults[i]; });

  // Perplexity has no /models endpoint — treat "key present" as configured+ok.
  if (cfg.perplexityApiKey && isEnabled('perplexity')) providers.perplexity = true;

  // OpenAI OAuth (ChatGPT login) — per-user tokens, no global API key.
  const oauthStatus = openAIOAuthStatus(users);
  if (oauthStatus.configured && isEnabled('openai-oauth')) providers['openai-oauth'] = oauthStatus.ok;

  // Cortex health. Embed and reason both have a built-in tier (nomic ONNX +
  // our llama.cpp adapter) that runs in-process, so we check those first
  // before falling through to whatever external runtime is configured.
  let builtinReasonOk = false;
  try {
    const { isBuiltinReasonReady } = await import('../memory/builtin-reason.mjs');
    builtinReasonOk = isBuiltinReasonReady();
  } catch { /* builtin unavailable on this platform */ }
  const embedOk  = embedProvider === 'builtin' ? true
    : embedProvider === 'lmstudio' ? !!lmstudioOk
    : !!ollamaOk;
  const reasonOk = reasonProvider === 'builtin' ? builtinReasonOk
    : reasonProvider === 'lmstudio' ? !!lmstudioOk
    : reasonProvider === 'ollama' ? !!ollamaOk
    // 'auto' resolves to builtin when ready, else tries external runtimes.
    : (builtinReasonOk || !!ollamaOk || !!lmstudioOk);

  // Gmail status per user with gmail enabled
  const gmailUsers = users.filter(u => u.emailProvider === 'gmail');
  const gmail = {};
  for (const u of gmailUsers) {
    const token = gmailTokenStatus(u.id);
    gmail[u.id] = {
      name: u.name,
      autolabel: isWatcherRunning(u.id),
      tokenValid: token.exists && (!token.expired || token.hasRefresh),
    };
  }

  const sessions = countSessionFiles();
  const tasks = loadAllTasksForScheduler();
  const cortexUsers = listCortexUsers();

  // Overall ok: every configured provider must be reachable, and embed must
  // work. Unconfigured providers are absent from `providers` and don't count.
  const allProvidersOk = Object.values(providers).every(v => v === true);
  const ok = allProvidersOk && embedOk;

  // Runtime metrics (WebSocket clients, memory, background tasks)
  const runtime = _runtimeMetricsFn ? (_runtimeMetricsFn() ?? {}) : {};
  const mem = process.memoryUsage();
  const bgTasks = getActiveBgTasks();

  return {
    ok,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    providers,
    cortex: {
      embed: embedOk,
      reason: reasonOk,
      embedProvider,
      reasonProvider,
    },
    gmail: Object.keys(gmail).length ? gmail : null,
    disk: {
      sessionsCount: sessions.files,
      sessionLines: sessions.totalLines,
      expensesTxnCount: countExpenses(),
      cortexUsers,
    },
    users: users.length,
    scheduler: {
      running: isSchedulerRunning(),
      tasks: tasks.length,
      active: tasks.filter(t => t.enabled !== false).length,
    },
    runtime: {
      wsClients:   runtime.wsClients   ?? null,
      nodeClients: runtime.nodeClients ?? null,
      bgTasks:     bgTasks.length,
      memoryMB: {
        rss:       Math.round(mem.rss / 1024 / 1024),
        heapUsed:  Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        external:  Math.round(mem.external / 1024 / 1024),
      },
      nodeVersion: process.version,
    },
    update: getUpdateState(),
  };
}

export async function handle(req, res) {
  // Public health check — liveness only. Provider availability and uptime
  // are reconnaissance gifts to an unauthenticated caller; admin dashboard
  // gets the full picture via /api/admin/health below.
  if (req.url === '/health' && req.method === 'GET') {
    const health = await buildFullHealth();
    const status = health.ok ? 200 : 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: health.ok }));
    return true;
  }

  // Admin health — full details for dashboard
  if (req.url === '/api/admin/health' && req.method === 'GET') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    const health = await buildFullHealth();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return true;
  }

  return false;
}
