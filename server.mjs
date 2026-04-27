/**
 * OpenEnsemble — Lightweight AI assistant server
 * HTTP + WebSocket on port 3737
 */

import http       from 'http';
import fs         from 'fs';
import path       from 'path';
import { fileURLToPath } from 'url';
import { listAgents } from './agents.mjs';
import { loadRoleManifests, validateSkills, reconcileRoleDrawers } from './roles.mjs';
import { loadDrawerManifests } from './plugins.mjs';
import { startScheduler, stopScheduler, loadTasks, addTask, registerBuiltin } from './scheduler.mjs';
import { initAutoLabel, stopAllWatchers } from './gmail-autolabel.mjs';
import { abortAllChats } from './chat-dispatch.mjs';
import { getRateLimit } from './rate-limit.mjs';
import {
  initWs, broadcast, broadcastAgentList, broadcastToUsers, sendToUser,
  getWsClientCount, getNodeClientCount, closeAllWsClients,
} from './ws-handler.mjs';

// Route modules
import { handle as handlePlugins }  from './routes/plugins.mjs';
import { handle as handleGmail }    from './routes/gmail.mjs';
import { handle as handleConfig }   from './routes/config.mjs';
import { handle as handleAgents }   from './routes/agents.mjs';
import { handle as handleAuth }     from './routes/auth.mjs';
import { handle as handleUsers }    from './routes/users.mjs';
import { handle as handleAdmin }    from './routes/admin.mjs';
import { handle as handleExpenses } from './routes/expenses.mjs';
import { handle as handleResearch } from './routes/research.mjs';
import { handle as handleDesktop }  from './routes/desktop.mjs';
import { handle as handleMisc }     from './routes/misc.mjs';
import { handle as handleSharedDocs } from './routes/shared-docs.mjs';
import { handle as handleHealth, setRuntimeMetricsFn } from './routes/health.mjs';
import { handle as handleOAuth }         from './routes/oauth.mjs';
import { handle as handleMsOAuth }       from './routes/ms-oauth.mjs';
import { handle as handleOpenAIOAuth }   from './routes/openai-oauth.mjs';
import { handle as handleEmailAccounts } from './routes/email-accounts.mjs';
import { handle as handleTelegram }      from './routes/telegram.mjs';
import { handle as handleMemory }        from './routes/memory.mjs';
import { handle as handleReasonRuntime } from './routes/reason-runtime.mjs';
import { handle as handlePlanRuntime }   from './routes/plan-runtime.mjs';
import { handle as handleSharing }      from './routes/sharing.mjs';
import { handle as handleNodes }        from './routes/nodes.mjs';
import { handle as handleTutor }          from './routes/tutor.mjs';
import { handle as handleCoder }          from './routes/coder.mjs';
import { sendTelegramToUser }             from './routes/telegram.mjs';
import { startDiscoveryBeacon, stopDiscoveryBeacon } from './discovery.mjs';
import { migrateUserDirs }               from './migrate-user-dirs.mjs';
import { setBackgroundBroadcastFn } from './background-tasks.mjs';
import { startUpdateChecker } from './lib/update.mjs';

// Shared helpers
import {
  loadConfig, loadUsers, loadPersistedSessions, setBroadcastFn, setUserBroadcastFn,
  EXPENSES_UPLOADS, CFG_PATH,
} from './routes/_helpers.mjs';
import { log, configureLogger } from './logger.mjs';

// Apply user-configured log caps from config.json (safe to call before any log).
try {
  const _cfg = loadConfig();
  if (_cfg?.logs) configureLogger(_cfg.logs);
} catch {}

const PORT    = 3737;
const UI_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── PID-file guard ───────────────────────────────────────────────────────────
// Refuse to start if another OE server is already running. Prevents the
// EADDRINUSE crash-loop you get when systemd thinks the unit is stopped but a
// stray instance (manual `node server.mjs`, orphan child) still holds port 3737.
const PID_FILE = path.join(BASE_DIR, 'server.pid');
(function pidGuard() {
  let stalePid = NaN;
  try { stalePid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10); } catch { return; }
  if (!Number.isInteger(stalePid) || stalePid === process.pid || stalePid <= 0) return;
  try { process.kill(stalePid, 0); } catch { return; } // not alive → stale file, ignore
  // PID is alive. Confirm it's actually our server (guard against PID reuse).
  let cmdline = '';
  try { cmdline = fs.readFileSync(`/proc/${stalePid}/cmdline`, 'utf8'); } catch {}
  if (cmdline && !cmdline.includes('server.mjs')) return; // unrelated process, stale file
  console.error(`[startup] Another OpenEnsemble server is already running (PID ${stalePid}).`);
  console.error(`[startup] To take over manually:  kill ${stalePid} && oe start`);
  process.exit(1);
})();
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (e) {
  console.warn('[startup] Could not write PID file:', e.message);
}

// ── Lock down config.json permissions on startup ─────────────────────────────
// config.json holds API keys; keep it owner-readable only.
try {
  if (fs.existsSync(CFG_PATH)) {
    const mode = fs.statSync(CFG_PATH).mode & 0o777;
    if (mode !== 0o600) {
      fs.chmodSync(CFG_PATH, 0o600);
      console.log(`[security] Tightened config.json permissions 0${mode.toString(8)} → 0600`);
    }
  }
} catch (e) {
  console.warn('[security] Could not chmod config.json:', e.message);
}

// ── One-time migration: split Ollama cloud/local endpoints ───────────────────
// Historically cortex.ollamaUrl defaulted to http://localhost:11434 and was
// used for both "cloud" and "local" tiers. After the split, the cloud slot
// keeps the name `ollamaUrl` (now defaulting to ollama.com) and a separate
// `ollamaLocalUrl` holds the local endpoint. Existing installs still have the
// legacy localhost value pointed at the cloud slot — move it to local here.
try {
  if (fs.existsSync(CFG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    const cortex = raw.cortex ?? {};
    if (cortex.ollamaUrl === 'http://localhost:11434') {
      cortex.ollamaLocalUrl = cortex.ollamaLocalUrl || 'http://localhost:11434';
      cortex.ollamaUrl = 'https://ollama.com/api';
      raw.cortex = cortex;
      fs.writeFileSync(CFG_PATH, JSON.stringify(raw, null, 2));
      console.log('[migrate] Split legacy cortex.ollamaUrl (localhost) → ollamaLocalUrl; cloud now defaults to ollama.com');
    }
  }
} catch (e) {
  console.warn('[migrate] ollama endpoint migration skipped:', e.message);
}

// Expose the install root to skills and drawer plugins so they can locate
// user data without hard-coding an absolute path or relying on relative
// `../..` tricks (which break for user-created skills at
// `users/{userId}/skills/{id}/` — a deeper path than built-in skills).
process.env.OPENENSEMBLE_ROOT = BASE_DIR;

// ── CSS concatenation (source split files → single styles.css) ───────────────
function buildCSS() {
  const cssDir = path.join(UI_DIR, 'css');
  if (!fs.existsSync(cssDir)) return;
  const files = fs.readdirSync(cssDir)
    .filter(f => f.endsWith('.css'))
    .sort();
  const combined = files
    .map(f => fs.readFileSync(path.join(cssDir, f), 'utf8'))
    .join('\n');
  fs.writeFileSync(path.join(UI_DIR, 'styles.css'), combined);
  console.log(`[css] Built styles.css from ${files.length} source files`);
}

// ── Route dispatch order ─────────────────────────────────────────────────────
const routeHandlers = [
  handleHealth,    // /health (public) + /api/admin/health (authed)
  handlePlugins,   // must be early — delegates /api/* to plugin servers
  handleOAuth,          // /api/oauth/google/* — per-user Google OAuth flow
  handleMsOAuth,        // /api/oauth/microsoft/* — Microsoft OAuth flow
  handleOpenAIOAuth,    // /api/oauth/openai/*    — ChatGPT (Codex) OAuth flow
  handleEmailAccounts,  // /api/email-accounts, /api/inbox
  handleGmail,          // /api/gmail/autolabel*
  handleConfig,
  handleAgents,
  handleAuth,
  handleUsers,
  handleAdmin,
  handleSharedDocs,
  handleSharing,
  handleExpenses,
  handleMemory,
  handleReasonRuntime,
  handlePlanRuntime,
  handleResearch,
  handleDesktop,
  handleNodes,
  handleMisc,
  handleTelegram,
  handleTutor,
  handleCoder,
];

// CSP: inline script-src/style-src are required by index.html (149 inline
// on* handlers, 398 inline style= attributes). Whitelisted CDNs are the ones
// actually loaded in index.html. This isn't airtight against XSS but does
// block attacker-controlled 3rd-party script/frame/object sources.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' ws: wss: https://unpkg.com https://cdn.jsdelivr.net",
  // Allow OE pages to frame OE resources — PDF viewer in the Documents
   // drawer mounts /api/shared-docs/<id>/view in an iframe. Foreign origins
   // are still blocked (clickjacking guard intact).
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP,
};

// Max raw body size for any /api/* request (covers multipart uploads too).
// Multipart handlers parse the full stream into memory — without this cap a
// client could POST gigabytes.
const API_BODY_CAP = 25 * 1024 * 1024; // 25 MiB

const httpServer = http.createServer(async (req, res) => {
  // Inject security headers into every response
  const _origWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, headers) => {
    const merged = typeof headers === 'object' && headers !== null
      ? { ...SECURITY_HEADERS, ...headers }
      : { ...SECURITY_HEADERS, ...(headers || {}) };
    return _origWriteHead(status, merged);
  };

  // Canonicalize origin: redirect 127.0.0.1 → localhost so localStorage/cookies are shared
  const host = req.headers.host ?? '';
  if (host.startsWith('127.0.0.1')) {
    res.writeHead(302, { Location: `http://localhost:${host.split(':')[1] || PORT}${req.url}` });
    res.end();
    return;
  }

  // Serve the UI
  if (req.url.startsWith('/invite/') || req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(UI_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }); res.end(html); return;
  }

  if (req.url === '/manifest.json') {
    const manifest = fs.readFileSync(path.join(UI_DIR, 'manifest.json'));
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); res.end(manifest); return;
  }

  // Serve static assets from public/ (css, js)
  const STATIC_TYPES = { '.css': 'text/css', '.js': 'text/javascript' };
  const ext = path.extname(req.url);
  if (STATIC_TYPES[ext]) {
    const safeName = path.basename(req.url);
    const filePath = path.join(UI_DIR, safeName);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext], 'Cache-Control': 'public, max-age=3600' }); res.end(data); return;
    }
  }

  // Rate-limit API endpoints
  if (req.url.startsWith('/api/')) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const isUpload = req.url.includes('upload') || req.url.includes('restore') || req.url.includes('avatar');
    const { limited, remaining, resetAt } = getRateLimit(ip, isUpload);
    res.setHeader('X-RateLimit-Remaining', remaining);
    if (limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil((resetAt - Date.now()) / 1000).toString() });
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
      return;
    }
    // Hard cap on advertised request size. Blocks multi-gigabyte uploads at the
    // edge before any route-level parser allocates memory for them. Restore is
    // exempt — it streams a tarball with its own 500 MB compressed cap.
    if (req.url !== '/api/admin/restore' && req.url !== '/api/admin/restore-initial') {
      const declared = parseInt(req.headers['content-length'] || '0', 10);
      if (declared > API_BODY_CAP) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
    }
  }

  // CSRF-ish guard: for state-changing /api/* requests from a browser Origin,
  // reject if the Origin hostname doesn't match the request Host. Non-browser
  // clients (curl, node agents, mobile) don't send Origin and are allowed
  // (they still need a valid Bearer token).
  if (req.url.startsWith('/api/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    // Allowlist: OAuth callbacks come from external providers and have no valid Origin
    const isOAuthCallback = req.url.startsWith('/api/oauth/') && req.url.includes('/callback');
    // Telegram webhooks come from Telegram's own servers with no Origin
    const isTelegramHook  = req.url.startsWith('/api/telegram/');
    if (!isOAuthCallback && !isTelegramHook) {
      const origin = req.headers.origin || req.headers.referer;
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          const reqHost = req.headers.host || '';
          // Accept matching host, or canonical localhost alternatives
          const ok = originHost === reqHost
            || originHost.replace(/^127\.0\.0\.1/, 'localhost') === reqHost.replace(/^127\.0\.0\.1/, 'localhost')
            || originHost.replace(/^localhost/, '127.0.0.1') === reqHost.replace(/^localhost/, '127.0.0.1');
          if (!ok) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
            return;
          }
        } catch { /* malformed origin — fall through (no header is OK) */ }
      }
    }
  }

  // Try each route module in order
  try {
    for (const handler of routeHandlers) {
      if (await handler(req, res)) return;
    }
  } catch (e) {
    // Any handler throw (sync or async) lands here — without this, an
    // unhandled rejection crashes the whole Node process under the default
    // Node 20+ --unhandled-rejections=throw policy.
    console.error('[http] unhandled route error:', e);
    if (!res.headersSent) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      } catch {}
    } else {
      try { res.end(); } catch {}
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket ────────────────────────────────────────────────────────────────
// WebSocket setup, auth, message dispatch, heartbeat, and per-user cap all
// live in ws-handler.mjs. Connect the broadcast helpers back into the parts
// of the system that need to push events (scheduler, background tasks,
// route modules via the _helpers injection points, /health metrics).
initWs(httpServer);

setBroadcastFn(broadcastAgentList);
setBackgroundBroadcastFn(broadcast);
setUserBroadcastFn(broadcastToUsers);
setRuntimeMetricsFn(() => ({
  wsClients: getWsClientCount(),
  nodeClients: getNodeClientCount(),
}));

// ── Builtin task: fire reminder notification ─────────────────────────────────
registerBuiltin('fireReminder', async (task) => {
  // Weekdays-only check: skip weekends
  if (task.weekdaysOnly) {
    const day = new Date().getDay();
    if (day === 0 || day === 6) return 'Skipped (weekend)';
  }

  const user = loadUsers().find(u => u.id === task.ownerId);
  const channel = user?.reminderChannel || 'websocket';
  const wantWs = channel === 'websocket' || channel === 'all';
  const wantTg = channel === 'telegram'  || channel === 'all';
  const wantEm = channel === 'email'     || channel === 'all';

  const payload = { type: 'reminder', id: task.id, label: task.label, ts: Date.now() };
  const delivered = [];

  if (wantWs) {
    const n = sendToUser(task.ownerId, payload);
    if (n > 0) delivered.push(`ws(${n})`);
  }

  if (wantTg) {
    try {
      const ok = await sendTelegramToUser(task.ownerId, `⏰ Reminder: ${task.label}`);
      if (ok) delivered.push('telegram');
    } catch (e) { console.warn('[reminder] telegram delivery failed:', e.message); }
  }

  if (wantEm) {
    try {
      // Read the user's email accounts and pick the first one with SMTP configured.
      // The email skill stores these at users/<id>/email-accounts.json; keeping the
      // read inline here avoids pulling the whole email-accounts route module in.
      const { USERS_DIR } = await import('./lib/paths.mjs');
      const fs = await import('fs');
      const path = await import('path');
      const p = path.join(USERS_DIR, task.ownerId, 'email-accounts.json');
      if (fs.existsSync(p)) {
        const accts = JSON.parse(fs.readFileSync(p, 'utf8'));
        const sender = accts.find(a => a.smtpHost && a.encryptedPassword);
        if (sender) {
          const { sendSmtpEmail } = await import('./lib/smtp-client.mjs');
          await sendSmtpEmail(sender, {
            to: sender.username,
            subject: `Reminder: ${task.label}`,
            body: `This is your reminder:\n\n${task.label}\n\nFired at ${new Date().toLocaleString()}.`,
          });
          delivered.push('email');
        }
      }
    } catch (e) { console.warn('[reminder] email delivery failed:', e.message); }
  }

  // Fallback: if the preferred channel couldn't deliver and WS wasn't already
  // tried, send via WS so the reminder isn't silently dropped.
  if (!delivered.length && !wantWs) {
    const n = sendToUser(task.ownerId, payload);
    if (n > 0) delivered.push(`ws-fallback(${n})`);
  }

  // Auto-delete one-time reminders after firing — they don't need to persist
  if (task.repeat === 'once') {
    const { removeTask } = await import('./scheduler.mjs');
    removeTask(task.id);
  }

  const summary = delivered.length ? delivered.join('+') : 'nobody-online';
  console.log(`[reminder] "${task.label}" → ${summary} for ${task.ownerId}`);
  return delivered.length ? `Reminder fired via ${summary}: "${task.label}"` : `Reminder fired but no channel delivered: "${task.label}"`;
});

// ── Builtin task: tutor daily nudge ──────────────────────────────────────────
registerBuiltin('tutorNudge', async (task) => {
  const { getUser } = await import('./routes/_helpers.mjs');
  const { loadTutorStats, getUserLocalDate, getUserLocalHour } = await import('./lib/tutor-stats.mjs');

  const user = getUser(task.ownerId);
  if (!user) return 'Skipped: user gone';
  const prefs = user.tutorReminders || {};
  if (!prefs.enabled || prefs.channel === 'off') return 'Skipped: reminders off';

  const stats = loadTutorStats(task.ownerId);

  // Already studied today? Skip.
  const today = getUserLocalDate(task.ownerId, new Date(), stats);
  if (stats.dayLog?.[today]?.minutes > 0 || stats.dayLog?.[today]?.answered > 0) {
    return 'Skipped: already studied today';
  }

  // Quiet hours check — user-local.
  const hour = getUserLocalHour(task.ownerId, new Date(), stats);
  const { start = '22:30', end = '08:00' } = prefs.quietHours || {};
  const [qsH] = start.split(':').map(Number);
  const [qeH] = end.split(':').map(Number);
  const inQuiet = qsH > qeH
    ? (hour >= qsH || hour < qeH)  // wraps midnight
    : (hour >= qsH && hour < qeH);
  if (inQuiet) return 'Skipped: quiet hours';

  // At-risk nudge only fires if current streak is worth protecting
  const kind = task.meta?.kind || 'daily';
  if (kind === 'at_risk' && (stats.streak?.current || 0) < 3) return 'Skipped: streak too low';

  const subjects = Object.entries(stats.subjects || {});
  const topSubject = subjects.sort((a, b) => (b[1].lastStudied || '').localeCompare(a[1].lastStudied || ''))[0]?.[0] || null;
  const streak = stats.streak?.current || 0;

  const line = kind === 'at_risk'
    ? `🔥 Don't break your ${streak}-day streak! A quick review takes 2 minutes.`
    : streak > 0
      ? `🎓 Keep your ${streak}-day streak going — ${topSubject ? `time for ${topSubject}` : 'your tutor is ready'}.`
      : `🎓 Ready to learn? ${topSubject ? `Pick up where you left off on ${topSubject}.` : 'Start a session whenever you like.'}`;

  const nudgePayload = { type: 'tutor_nudge', kind, subject: topSubject, streak, message: line, ts: Date.now() };
  let delivered = 0;

  if (prefs.channel === 'websocket') {
    delivered = sendToUser(task.ownerId, nudgePayload);
  } else if (prefs.channel === 'telegram') {
    const ok = await sendTelegramToUser(task.ownerId, line);
    delivered = ok ? 1 : 0;
    // Fallback to websocket if Telegram unavailable
    if (!ok) {
      delivered = sendToUser(task.ownerId, nudgePayload);
      console.log(`[tutor] Telegram fallback → websocket for ${task.ownerId}`);
    }
  } else if (prefs.channel === 'email') {
    // Email delivery falls back to Telegram then websocket if unavailable.
    // Full SMTP integration requires the user's linked email account — defer
    // to phase 2.5 follow-up; for now, try Telegram then websocket.
    const ok = await sendTelegramToUser(task.ownerId, line);
    delivered = ok ? 1 : 0;
    if (!ok) delivered = sendToUser(task.ownerId, nudgePayload);
  }

  // Coordinator priming (prefs.primeCoordinator) is intentionally deferred —
  // dispatchBackground requires the coordinator scoped-agent object, which we
  // don't resolve here. Revisit when a tutor-priming helper lands.

  console.log(`[tutor] ${kind} nudge "${task.ownerId}" → ${delivered} via ${prefs.channel}`);
  return delivered ? `Nudge delivered via ${prefs.channel}` : `Nudge queued but user offline (${prefs.channel})`;
});

// ── Builtin task: weekly wrap-up (Sun night user-local) ──────────────────────
registerBuiltin('tutorWeekWrap', async (task) => {
  const { runWeekWrap, getUserTz } = await import('./lib/tutor-stats.mjs');
  // Self-gate to Sunday in user-local tz (scheduler only supports daily cadence).
  const tz = getUserTz(task.ownerId);
  let weekday = '';
  try { weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()); } catch {}
  if (weekday !== 'Sun') return `Skipped: not Sunday (${weekday} in ${tz})`;
  const { recap, granted } = await runWeekWrap(task.ownerId);

  if (granted) {
    sendToUser(task.ownerId, {
      type: 'tutor_celebration',
      kind: granted.id,
      label: 'Weekly goal hit!',
      icon: '🎯',
      ts: Date.now(),
    });
  }

  return `WeekWrap: ${recap.minutesStudied}min/${recap.daysStudied}d, goalMet=${recap.goalMet}, granted=${granted?.id || 'none'}`;
});

// ── Builtin task: clean old uploads ──────────────────────────────────────────
registerBuiltin('cleanUploads', () => {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(EXPENSES_UPLOADS);
    let deleted = 0;
    for (const f of files) {
      const fp = path.join(EXPENSES_UPLOADS, f);
      try {
        const { mtimeMs } = fs.statSync(fp);
        if (mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; }
      } catch (e) { console.warn('[cleanUploads] Failed to process', f + ':', e.message); }
    }
    return deleted ? `Deleted ${deleted} old upload file${deleted > 1 ? 's' : ''}.` : 'No old uploads to clean.';
  } catch (e) {
    return `Error: ${e.message}`;
  }
});

async function seedSystemTasks() {
  const existing = loadTasks();
  if (!existing.find(t => t.type === 'builtin' && t.handler === 'cleanUploads')) {
    await addTask({
      label: 'Clean uploads folder',
      type: 'builtin',
      handler: 'cleanUploads',
      agent: 'system',
      repeat: 'daily',
      time: '03:00',
      ownerId: null,
    });
    console.log('[scheduler] Seeded cleanUploads task');
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
migrateUserDirs();
buildCSS();
loadRoleManifests();
validateSkills().catch(() => {});
loadDrawerManifests();
reconcileRoleDrawers();
loadPersistedSessions();

// Timeouts to mitigate slowloris / slow-body attacks without cutting off
// long LLM streaming responses (those go through WS, not HTTP).
httpServer.headersTimeout = 30_000;  // 30s to receive request headers
httpServer.requestTimeout = 120_000; // 2 min to receive full request
httpServer.keepAliveTimeout = 65_000;
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[startup] Port ${PORT} is already in use. Another OpenEnsemble instance may be running.`);
    try { fs.unlinkSync(PID_FILE); } catch {} // don't strand our own pid file
    process.exit(1);
  }
  console.error('[startup] HTTP server error:', err);
  process.exit(1);
});
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 OpenEnsemble running at http://localhost:${PORT}\n`);
  console.log('Agents:', listAgents().map(a => `${a.emoji} ${a.name}`).join('  '));
  console.log('Press Ctrl+C to stop\n');
  log.info('startup', 'Server listening', { port: PORT, agents: listAgents().length });

  seedSystemTasks();
  startScheduler(broadcast);
  initAutoLabel(loadUsers());
  startDiscoveryBeacon(PORT);
  cortexHealthCheck();

  // ── Auto-update checker ───────────────────────────────────────────────────
  // Polls origin for new commits and broadcasts to admin browsers when a new
  // version is available. Toggle with config.updateCheckEnabled (default on).
  const _upCfg = loadConfig();
  _stopUpdateChecker = startUpdateChecker({
    enabled:    _upCfg.updateCheckEnabled !== false,
    intervalMs: _upCfg.updateCheckIntervalMs ?? 3_600_000,
    remote:     _upCfg.updateRemote || 'origin',
    onAvailable: (state) => {
      const adminIds = loadUsers()
        .filter(u => u.role === 'owner' || u.role === 'admin')
        .map(u => u.id);
      if (!adminIds.length) return;
      broadcastToUsers(adminIds, {
        type: 'update_available',
        currentSha: state.currentSha,
        remoteSha:  state.remoteSha,
        ts: Date.now(),
      });
    },
  });
});

let _stopUpdateChecker = null;

// Probes the embed endpoint once at startup. If it returns an all-zero vector
// (provider unreachable or model missing), every vector search will collapse
// to _distance=0 and the dedup in memory/lance.mjs will silently drop every
// non-episode write. This check makes that failure loud instead of invisible.
async function cortexHealthCheck() {
  try {
    const { embed } = await import('./memory/embedding.mjs');
    const { getCortexConfig, resolveReasonProvider } = await import('./memory/shared.mjs');
    const { embedModel, embedUrl, embedProvider, reasonProvider } = getCortexConfig();

    // For the bundled model, warm the pipeline up front so the first user
    // request doesn't pay the ~1s load cost. Failure here is loud because
    // weights may not have been fetched yet.
    if (embedProvider === 'builtin') {
      try {
        const { initBuiltinEmbed } = await import('./memory/builtin-embed.mjs');
        await initBuiltinEmbed();
      } catch (e) {
        const banner =
          '\n' + '='.repeat(70) + '\n' +
          '[cortex] ⚠️  BUILT-IN EMBEDDING MODEL FAILED TO LOAD.\n' +
          `    error: ${e.message}\n` +
          '    Fix: re-run `npm install` to fetch the model weights.\n' +
          '='.repeat(70) + '\n';
        console.error(banner);
        log.warn('cortex', 'Built-in embed init failed', { error: e.message });
        return;
      }
    }

    // Warm the bundled reasoning model the same way if it's going to be used.
    // Triggered for explicit 'builtin' or 'auto' (which prefers builtin). Don't
    // block startup — kick off the warmup in the background and surface a
    // loud banner only if it actually fails to load. The q8_0 GGUF is ~150 MB
    // and loads through node-llama-cpp; cold load takes a few seconds on a Pi.
    const willUseBuiltinReason =
      reasonProvider === 'builtin' ||
      (reasonProvider === 'auto' && await (async () => {
        try {
          return (await resolveReasonProvider()) === 'builtin';
        } catch { return false; }
      })());
    if (willUseBuiltinReason) {
      import('./memory/builtin-reason.mjs').then(async ({ initBuiltinReason, getBuiltinReasonModelId }) => {
        try {
          await initBuiltinReason();
          console.log(`[cortex] reason ready (builtin/${getBuiltinReasonModelId()})`);
        } catch (e) {
          const banner =
            '\n' + '='.repeat(70) + '\n' +
            '[cortex] ⚠️  BUILT-IN REASONING MODEL FAILED TO LOAD.\n' +
            `    error: ${e.message}\n` +
            '    Fix: re-run `npm install` to fetch the model weights,\n' +
            '    or set cortex.reasonProvider to "ollama"/"lmstudio" as a fallback.\n' +
            '='.repeat(70) + '\n';
          console.error(banner);
          log.warn('cortex', 'Built-in reason init failed', { error: e.message });
        }
      }).catch(e => console.warn('[cortex] reason module import failed:', e.message));
    }

    const vec = await embed('cortex health check');
    const isZero = vec && vec.length && vec.every(v => v === 0);
    if (isZero) {
      const banner =
        '\n' + '='.repeat(70) + '\n' +
        '[cortex] ⚠️  EMBEDDINGS ARE BROKEN — all memory writes will silently fail.\n' +
        `    provider: ${embedProvider}\n` +
        `    model:    ${embedModel}\n` +
        `    url:      ${embedUrl}\n` +
        '    Fix: make sure the embed model is pulled and the provider is up.\n' +
        '    Built-in: re-run `npm install` to (re)fetch the bundled model.\n' +
        '    Ollama:   `ollama pull nomic-embed-text` and pick it in /settings.\n' +
        '='.repeat(70) + '\n';
      console.error(banner);
      log.warn('cortex', 'Embedding probe returned zero vector', { embedProvider, embedModel, embedUrl });
    } else {
      console.log(`[cortex] embeddings OK (${embedProvider}/${embedModel}, ${vec.length}-dim)`);
    }
  } catch (e) {
    console.error('[cortex] Health check threw:', e.message);
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
let _shuttingDown = false;

async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — shutting down gracefully…`);
  log.info('shutdown', 'Received signal', { signal });

  // 1. Stop accepting new connections
  httpServer.close(() => console.log('[shutdown] HTTP server closed'));

  // 2. Stop scheduled tasks, gmail watchers, and the update checker
  stopScheduler();
  stopAllWatchers();
  _stopUpdateChecker?.();

  // 3. Abort all in-flight chat streams
  abortAllChats();

  // 4. Close WebSocket connections gracefully
  closeAllWsClients('Server is shutting down');

  // 5. Give in-flight file writes a moment to finish, then exit
  //    Hard kill after 5s if something hangs
  const forceTimer = setTimeout(() => {
    console.error('[shutdown] Timed out — forcing exit');
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  await new Promise(r => setTimeout(r, 500));

  try { fs.unlinkSync(PID_FILE); } catch {}

  console.log('[shutdown] Clean exit');
  log.info('shutdown', 'Clean exit', { signal });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
