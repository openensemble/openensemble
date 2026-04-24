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
import { loadTasks, isSchedulerRunning } from '../scheduler.mjs';
import { isWatcherRunning } from '../gmail-autolabel.mjs';
import { getActiveTasks as getActiveBgTasks } from '../background-tasks.mjs';

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

  // A provider is "configured" if it has an API key or is explicitly enabled
  // (or cortex relies on it). Unconfigured providers are neither probed nor
  // reported, so they can't trigger a spurious Degraded state.
  const cortexUsesOllama   = embedProvider === 'ollama'   || reasonProvider === 'ollama';
  const cortexUsesLmstudio = embedProvider === 'lmstudio' || reasonProvider === 'lmstudio';
  const anthropicConfigured = !!cfg.anthropicApiKey;
  const ollamaConfigured    = !!ollamaKey || !!enabled.ollama || cortexUsesOllama;
  const lmstudioConfigured  = !!enabled.lmstudio || cortexUsesLmstudio;

  // Probe only what's configured
  const ollamaAuthHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};
  const [ollamaOk, lmstudioOk, anthropicOk] = await Promise.all([
    ollamaConfigured    ? checkProvider(`${ollamaUrl}/api/tags`, 2500, ollamaAuthHeaders) : Promise.resolve(null),
    lmstudioConfigured  ? checkProvider(`${lmstudioUrl}/v1/models`)                       : Promise.resolve(null),
    anthropicConfigured ? checkAnthropicKey(cfg.anthropicApiKey)                          : Promise.resolve(null),
  ]);

  const providers = {};
  if (anthropicConfigured) providers.anthropic = anthropicOk;
  if (ollamaConfigured)    providers.ollama    = ollamaOk;
  if (lmstudioConfigured)  providers.lmstudio  = lmstudioOk;

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
  const tasks = loadTasks();
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
