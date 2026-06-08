/**
 * OpenEnsemble — Lightweight AI assistant server
 * HTTP + WebSocket on port 3737
 */

import http       from 'http';
import https      from 'https';
import fs         from 'fs';
import path       from 'path';
import os         from 'os';
import { fileURLToPath } from 'url';
import { listAgents } from './agents.mjs';
import { loadRoleManifests, validateSkills, reconcileRoleDrawers } from './roles.mjs';
import { loadDrawerManifests } from './plugins.mjs';
import { startScheduler, stopScheduler, loadTasksForOwner, addTask, removeTask, registerBuiltin } from './scheduler.mjs';
import { startWatcherSupervisor, stopWatcherSupervisor } from './scheduler/watchers.mjs';
import { startBackgroundRefresh as startHaCacheRefresh } from './lib/ha-cache.mjs';
import { loadIntentEmbeddings } from './lib/specialist-embed-router.mjs';
import { registerSystemWatchHandlers } from './scheduler/watch-handlers.mjs';
import { startHealthMonitorHandlers } from './scheduler/health-monitor.mjs';
import { pruneAllSnapshots } from './scheduler/snapshot-pruner.mjs';
import { makeNodeExecFn } from './lib/node-exec-wrapper.mjs';
import { resolveTokenStorage } from './lib/token-storage.mjs';
import { loadProfile as loadServiceProfile } from './lib/service-profile.mjs';
import { setProposalBroadcastFn, bootLoadProposals } from './lib/proposals.mjs';
import { initAutoLabel, stopAllWatchers } from './gmail-autolabel.mjs';
import { abortAllChats } from './chat-dispatch.mjs';
import { getRateLimit } from './rate-limit.mjs';
import {
  initWs, attachWsUpgrade, broadcast, broadcastAgentList, broadcastToUsers, sendToUser,
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
import { handle as handleTunnel }        from './routes/tunnel.mjs';
import { handle as handleIntegrations }  from './routes/integrations.mjs';
import { startTunnelSupervisor, stopTunnelSupervisor } from './lib/tunnel.mjs';
import { handle as handleMemory }        from './routes/memory.mjs';
import { handle as handleReasonRuntime } from './routes/reason-runtime.mjs';
import { handle as handlePlanRuntime }   from './routes/plan-runtime.mjs';
import { handle as handleSharing }      from './routes/sharing.mjs';
import { handle as handleNodes }        from './routes/nodes.mjs';
import { handle as handleDevices }      from './routes/devices.mjs';
import { handle as handleWakewords }    from './routes/wakewords.mjs';
import { handle as handleVoiceRefs }    from './routes/voice-refs.mjs';
import { handle as handleVoiceConfig }  from './routes/voice-config.mjs';
import { handle as handleRoutines }     from './routes/routines.mjs';
import { handle as handleTutor }          from './routes/tutor.mjs';
import { handle as handleCoder }          from './routes/coder.mjs';
import { handle as handleGuide }          from './routes/guide.mjs';
import { handle as handleHomeAssistant }  from './routes/home-assistant.mjs';
import { handle as handleMcp }            from './routes/mcp.mjs';
import { sendTelegramToUser, reregisterAllWebhooks as reregisterTelegramWebhooks } from './routes/telegram.mjs';
import { speakReminder, pickReminderDevices } from './lib/voice-reminder.mjs';
import { registerAlarm, getCachedAlarmTts, sendAlarmArm } from './lib/alarms.mjs';
import { formatDurationAdj } from './lib/voice-timer.mjs';
import { startDiscoveryBeacon, stopDiscoveryBeacon } from './discovery.mjs';
import { migrateUserDirs }               from './migrate-user-dirs.mjs';
import { setBackgroundBroadcastFn } from './background-tasks.mjs';
import { setRuntimeWarnBroadcast } from './lib/runtime-warn.mjs';
import { startUpdateChecker } from './lib/update.mjs';
import { runBootCheck, aliveResponse, cancelCommitDeadline } from './lib/oe-admin-boot-check.mjs';

// Shared helpers
import {
  loadConfig, loadUsers, loadPersistedSessions, setBroadcastFn, setUserBroadcastFn,
  CFG_PATH,
} from './routes/_helpers.mjs';
import { log, configureLogger } from './logger.mjs';

// Apply user-configured log caps from config.json (safe to call before any log).
try {
  const _cfg = loadConfig();
  if (_cfg?.logs) configureLogger(_cfg.logs);
} catch {}

const PORT     = 3737;
const HTTPS_PORT = 3739;  // adjacent to 3737; 3738 reserved for the node-agent UDP discovery broadcast
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
  handleDevices,
  handleWakewords,
  handleVoiceRefs,
  handleVoiceConfig,
  handleRoutines,
  handleMisc,
  handleTelegram,
  handleTunnel,
  handleIntegrations,
  handleTutor,
  handleCoder,
  handleGuide,
  handleHomeAssistant,
  handleMcp,
];

// CSP. Inline event handlers are no longer used — the public/event-delegation.js
// harness routes data-action attributes to global functions, so script-src
// drops 'unsafe-inline' and any XSS that injects HTML can't execute scripts
// or on* handlers. Inline style= attributes still exist on lots of elements
// so style-src keeps 'unsafe-inline' for now (lower risk class — no JS exec).
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https://fonts.gstatic.com",
  // TTS audio previews + reminder chimes use data:audio/mp3 URIs. Without
  // an explicit media-src this falls back to default-src 'self', which
  // blocks data: schemes and silently breaks <audio> playback.
  "media-src 'self' data: blob:",
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
  // EXCEPT for the oe-admin boot-check liveness endpoint — it pings 127.0.0.1
  // directly and would 302-loop if we redirected.
  const host = req.headers.host ?? '';
  if (req.url === '/api/_alive') {
    aliveResponse(res);
    return;
  }
  if (host.startsWith('127.0.0.1')) {
    res.writeHead(302, { Location: `http://localhost:${host.split(':')[1] || PORT}${req.url}` });
    res.end();
    return;
  }

  // Serve the UI. Match on the pathname (not raw req.url) so query strings
  // like /?oauth=success or /?utm_source=email are treated as the root —
  // the query string is metadata for the resource, not part of the path
  // identity. Strict req.url === '/' was 404'ing OAuth-success redirects
  // and any shared link with tracking params.
  const _pathname = req.url.split('?', 1)[0];
  if (_pathname.startsWith('/invite/') || _pathname === '/' || _pathname === '/index.html') {
    const html = fs.readFileSync(path.join(UI_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }); res.end(html); return;
  }


  if (req.url === '/manifest.json') {
    const manifest = fs.readFileSync(path.join(UI_DIR, 'manifest.json'));
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); res.end(manifest); return;
  }

  // Serve static assets from public/ (css, js)
  const STATIC_TYPES = { '.css': 'text/css', '.js': 'text/javascript' };
  const ext = path.extname(_pathname);
  if (STATIC_TYPES[ext]) {
    const safeName = path.basename(_pathname);
    const filePath = path.join(UI_DIR, safeName);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext], 'Cache-Control': 'public, max-age=3600' }); res.end(data); return;
    }
  }

  // Nested static trees for the browser flash wizard: firmware bins +
  // vendored libs (esptool-js + webdfu). Constrained to two prefixes and
  // path-normalised so a request can't escape the public/ root.
  {
    const NESTED_TYPES = {
      '.js':   'text/javascript',
      '.json': 'application/json',
      '.bin':  'application/octet-stream',
      '.css':  'text/css',
      '.map':  'application/json',
    };
    const url = _pathname;
    if (NESTED_TYPES[ext] && (url.startsWith('/firmware/') || url.startsWith('/vendor/'))) {
      const decoded = decodeURIComponent(url).replace(/^\/+/, '');
      const filePath = path.resolve(UI_DIR, decoded);
      if (filePath.startsWith(UI_DIR + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const data = fs.readFileSync(filePath);
        // No-cache: this tree is being actively iterated on (flash wizard
        // bring-up). Browsers were holding stale webdfu.js + manifests
        // across reloads. Revisit once the wizard stabilises.
        res.writeHead(200, { 'Content-Type': NESTED_TYPES[ext], 'Cache-Control': 'no-cache' });
        res.end(data);
        return;
      }
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
    // edge before any route-level parser allocates memory for them. Routes
    // that legitimately accept large bodies (admin restore tarballs,
    // shared-docs file uploads) are exempt — they enforce their own limits
    // closer to the parser.
    const exemptFromBodyCap =
      req.url === '/api/admin/restore' ||
      req.url === '/api/admin/restore-initial' ||
      (req.method === 'POST' && req.url.startsWith('/api/shared-docs')) ||
      // Chat attachments (audio/video for transcription, large images, etc.)
      // — enforced at 500 MB by the route-level busboy parser.
      (req.method === 'POST' && req.url === '/api/chat-upload') ||
      // Ambient-library MP3 uploads — enforced at 40 MB by the route-level
      // handler in routes/devices.mjs.
      (req.method === 'POST' && req.url.startsWith('/api/devices/ambient-library/'));
    if (!exemptFromBodyCap) {
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
setRuntimeWarnBroadcast(broadcast);
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
  // Voice fires when (a) the channel is 'voice' / 'all' / 'websocket' with a
  // per-task device override, or (b) the task itself names a target device.
  // The override path means "remind me in the kitchen at 5" works even for a
  // user whose default channel is websocket+email.
  const wantVoice = channel === 'voice' || channel === 'all' || !!task.voiceDeviceId;

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
      const { USERS_DIR } = await import('./lib/paths.mjs');
      const fs = await import('fs');
      const path = await import('path');
      const p = path.join(USERS_DIR, task.ownerId, 'email-accounts.json');
      const accts = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
      const isSendable = (a) => a.provider === 'gmail' || a.provider === 'microsoft' || (a.smtpHost && a.encryptedPassword);
      // User-selected account wins; otherwise first sendable account by createdAt order.
      const preferredId = user?.reminderEmailId;
      const preferred = preferredId ? accts.find(a => a.id === preferredId) : null;
      const sender = (preferred && isSendable(preferred)) ? preferred : accts.find(isSendable);
      if (!sender) {
        console.warn(`[reminder] email skipped — no sendable account for ${task.ownerId} (need Gmail OAuth, Microsoft OAuth, or SMTP-configured account)`);
      } else {
        const subject = `Reminder: ${task.label}`;
        const body = `This is your reminder:\n\n${task.label}\n\nFired at ${new Date().toLocaleString()}.`;
        const to = sender.username || user?.email;
        if (!to) {
          console.warn(`[reminder] email skipped — sender account "${sender.label}" has no username/recipient address`);
        } else if (sender.provider === 'gmail') {
          const { getAccessToken } = await import('./lib/google-auth.mjs');
          const token = await getAccessToken('gmail', task.ownerId, sender.id);
          const raw = [`To: ${to}`, `Subject: ${subject}`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, body].join('\r\n');
          const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
          });
          if (!r.ok) throw new Error(`Gmail send ${r.status}: ${await r.text()}`);
          delivered.push('email');
        } else if (sender.provider === 'microsoft') {
          const { composeMsMessage } = await import('./lib/ms-graph.mjs');
          await composeMsMessage(task.ownerId, sender.id, { to, subject, body });
          delivered.push('email');
        } else {
          const { sendSmtpEmail } = await import('./lib/smtp-client.mjs');
          await sendSmtpEmail(task.ownerId, sender, { to, subject, body });
          delivered.push('email');
        }
      }
    } catch (e) { console.warn('[reminder] email delivery failed:', e.message); }
  }

  if (wantVoice) {
    try {
      const deviceIds = pickReminderDevices({ user, channel, taskDeviceId: task.voiceDeviceId });
      if (deviceIds.length) {
        // Device-managed alarm path: triggered by timer-fast-path tasks
        // (voiceTimer + voiceTimerSeconds) or by set_alarm tool calls
        // (task.alarm). Rings on the device until the user dismisses or
        // the 10-minute cap hits. Distinct from one-shot reminders below.
        const isAlarm = (task.voiceTimer && task.voiceTimerSeconds) || task.alarm;
        if (isAlarm) {
          const label = task.voiceTimerSeconds
            ? formatDurationAdj(task.voiceTimerSeconds)
            : (task.label || 'alarm');
          const id = registerAlarm({
            userId: task.ownerId,
            label,
            deviceIds,
            triggerAtMs: Date.now(),
            awaitingFireAck: true,
          });
          // Alarms ring chime-only — no TTS announcement. The chime + cadence
          // is the alarm; the label is for logging / future "list my alarms"
          // queries only. Skipping synth saves an OpenAI TTS round-trip per
          // fire and matches phone-alarm behavior.
          let pushed = 0;
          const alarmType = task.voiceTimer ? 'timer' : 'wallclock';
          for (const dId of deviceIds) {
            if (sendAlarmArm(dId, { id, label, triggerAtMs: Date.now(), audioMp3: null, type: alarmType })) {
              pushed++;
            }
          }
          delivered.push(`alarm(${pushed}/${deviceIds.length})`);
        } else {
          // Regular reminder → one-shot chime + TTS.
          const fired = await speakReminder({ userId: task.ownerId, deviceIds, text: task.label });
          if (fired.length) delivered.push(`voice(${fired.length})`);
        }
      }
    } catch (e) { console.warn('[reminder] voice delivery failed:', e.message); }
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

// ── Builtin task: hard-delete soft-forgotten cortex memories ────────────────
// Walks every users/<id>/cortex/*.lance table and drops rows where
// `forgotten = true` and the row was created more than 30 days ago. Soft-
// deletes are kept that long so users can recover from an accidental forget.
registerBuiltin('cortexCleanup', async () => {
  try {
    const { cleanupAllUsers } = await import('./memory/cleanup.mjs');
    const result = await cleanupAllUsers(30);
    return result.totalDeleted
      ? `Dropped ${result.totalDeleted} forgotten memory row(s) across ${result.users} user(s).`
      : 'No forgotten rows older than 30 days.';
  } catch (e) {
    return `Error: ${e.message}`;
  }
});

// cleanUploads task removed 2026-05-06 — uploads now persist into the
// profile-files registry (lib/profile-files.mjs) keyed by stable file_id.
// Expense transactions reference sourceFileId instead of a raw filename, so
// there's nothing to scrub at 24h. Old installs may still have a daily task
// stub from the previous seed; seedSystemTasks below removes it on boot.

async function seedSystemTasks() {
  const existing = loadTasksForOwner('system');
  // Remove the legacy cleanUploads task if a previous install seeded it.
  // The handler is gone (uploads persist in the profile-files registry now)
  // so the task would error daily if left in place.
  const stale = existing.find(t => t.type === 'builtin' && t.handler === 'cleanUploads');
  if (stale) {
    await removeTask(stale.id);
    console.log('[scheduler] Removed legacy cleanUploads task — uploads are now persistent in profile-files');
  }
  if (!existing.find(t => t.type === 'builtin' && t.handler === 'cortexCleanup')) {
    await addTask({
      label: 'Cortex memory cleanup',
      type: 'builtin',
      handler: 'cortexCleanup',
      agent: 'system',
      repeat: 'daily',
      time: '03:30',
      ownerId: null,
    });
    console.log('[scheduler] Seeded cortexCleanup task');
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

// One-shot encryption migration for any plaintext API keys that survive a
// pre-encryption build of OE. Idempotent — no-op once everything is
// encrypted. Uses users/_system/.master-key (in OE backups) so reinstall +
// restore works without manual key handling.
(async () => {
  try {
    const { bootstrapEncryption, bootstrapProfileEncryption } = await import('./lib/config-secrets.mjs');
    const { atomicWriteSync } = await import('./routes/_helpers/io-lock.mjs');
    const { CFG_PATH } = await import('./routes/_helpers/paths.mjs');
    const { log } = await import('./logger.mjs');
    await bootstrapEncryption({ cfgPath: CFG_PATH, atomicWriteSync, log });
    // Same migration for per-user profile.json (telegram.botToken,
    // telegram.webhookSecret). Runs after the config bootstrap so the
    // master key already exists when this needs to decide "create key?"
    // vs "encrypt existing".
    await bootstrapProfileEncryption({ atomicWriteSync, log });
    // And the OAuth/Microsoft token files. They'd otherwise stay plaintext
    // until their next refresh (~1h for Google access tokens, longer for
    // dormant services). The threat model (git commit / log snippet /
    // casual disk read) wants them encrypted now, not eventually.
    const { bootstrapTokenFileEncryption } = await import('./lib/encrypted-file.mjs');
    const { USERS_DIR } = await import('./routes/_helpers/paths.mjs');
    await bootstrapTokenFileEncryption({
      usersDir: USERS_DIR,
      prefixes: ['gmail-token', 'gcal-token', 'ms-token', 'mcp'],
      log,
    });
  } catch (e) {
    console.warn('[config-secrets] bootstrap migration failed:', e.message);
  }
})();

// One-shot systemd unit self-repair. Old installs shipped with
// Restart=on-failure, which doesn't fire when the server SIGTERMs itself
// to restart — net effect was "shut down, never come back". Patches the
// unit to Restart=always if needed; takes effect on next restart, doesn't
// disrupt the current session.
(async () => {
  try {
    const { repairSystemdUnit } = await import('./lib/systemd-repair.mjs');
    await repairSystemdUnit();
  } catch (e) {
    console.warn('[systemd-repair] failed:', e.message);
  }
})();

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
// First non-internal IPv4 is usually the right LAN address. Fall back to
// localhost only when no external interface is configured (e.g. netns).
function _detectLanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
httpServer.listen(PORT, '0.0.0.0', () => {
  const lanIp = _detectLanIp();
  console.log(`\n🎵 OpenEnsemble running at http://${lanIp}:${PORT}\n`);

  // Arm oe-admin boot-check. If a pending mutation is awaiting commit and
  // the server is now responding, this commits the change (or reverts +
  // exits if the deadline expires). Safe no-op when no pending marker.
  runBootCheck({ port: PORT }).catch(e => console.warn('[oe-admin] boot-check failed:', e.message));

  // MCP tools — warm each user's tool cache from their registered servers.
  // Fire-and-forget so the listen callback doesn't block; users without
  // mcp.json (the vast majority right now) finish in ~0ms.
  import('./lib/mcp-tools.mjs').then(m => m.warmAllUsersAtBoot())
    .catch(e => console.warn('[mcp-tools] boot warm failed:', e.message));

  // HTTPS listener (port 3739) for browser features that need a secure
  // context — WebUSB / Web Serial for the voice-device flash wizard.
  // Self-signed cert lives at tls/{cert,key}.pem and is generated by
  // install.sh; absence is non-fatal (HTTPS just doesn't come up). To
  // use a real cert, drop your own pair into tls/ and restart.
  try {
    const certPath = path.join(BASE_DIR, 'tls', 'cert.pem');
    const keyPath  = path.join(BASE_DIR, 'tls', 'key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const httpsServer = https.createServer(
        { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
        httpServer.listeners('request')[0],  // reuse the same request handler
      );
      attachWsUpgrade(httpsServer);
      httpsServer.headersTimeout  = httpServer.headersTimeout;
      httpsServer.requestTimeout  = httpServer.requestTimeout;
      httpsServer.keepAliveTimeout = httpServer.keepAliveTimeout;
      httpsServer.on('error', err => log.error('startup', 'HTTPS error', { err: err.message }));
      httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`🔒 HTTPS at https://${lanIp}:${HTTPS_PORT}  (self-signed — browser shows warning on first visit)`);
        log.info('startup', 'HTTPS listening', { port: HTTPS_PORT });
      });
    } else {
      log.info('startup', 'TLS cert not found — HTTPS disabled', { certPath });
    }
  } catch (e) {
    log.warn('startup', 'HTTPS setup failed', { err: e.message });
  }

  console.log('Agents:', listAgents().map(a => `${a.emoji} ${a.name}`).join('  '));
  console.log('Press Ctrl+C to stop\n');
  log.info('startup', 'Server listening', { port: PORT, agents: listAgents().length });

  seedSystemTasks();
  startScheduler(broadcast);

  // HA entity-name cache: powers the chat-dispatch fast-path so "turn on X"
  // skips the LLM. Lazy load on first use, plus a periodic refresh so newly
  // added HA devices show up without a server restart.
  startHaCacheRefresh();

  // Specialist intent-example embeddings — warm the embed-router cache so the
  // first user query doesn't pay the ~1-3s "embed N example phrases" cost.
  // Runs async; chat works without it (just falls through to regex/coordinator).
  loadIntentEmbeddings().catch(e => log.warn?.('embed-router', 'load failed', { err: e.message }));

  // Watcher supervisor: per-user polling for long-running async work
  // (video gen, training, price alerts, etc.). Distinct from scheduler
  // (one-shot/cron) — see scheduler/watchers.mjs for the design.
  registerSystemWatchHandlers();
  startWatcherSupervisor({
    sendStatus:       (userId, msg) => sendToUser(userId, msg),
    sendNotification: (userId, msg) => sendToUser(userId, msg),
    showImage:        (userId, msg) => sendToUser(userId, { type: 'image', ...msg }),
    showVideo:        (userId, msg) => sendToUser(userId, { type: 'video', ...msg }),
  });

  // Profile health monitor: per-service watchers fire the troubleshooting
  // loop on healthy→unhealthy transitions. ctxResolver wires through the
  // node registry (for CLI checks/diagnostics) and resolves auth from the
  // profile's declared token_storage. Lazily reads the profile each tick —
  // tolerable since checks are 60s+ cadence and the file is tiny.
  startHealthMonitorHandlers({
    ctxResolver: (state, helpers) => {
      const profile = loadServiceProfile(helpers.userId, state.node_id, state.service_id);
      const storageRef = profile?.control_surface?.api?.token_storage;
      const auth = storageRef ? resolveTokenStorage(helpers.userId, storageRef) : null;
      return {
        fetchFn:        globalThis.fetch,
        execFn:         makeNodeExecFn(helpers.userId, state.node_id),
        auth_override:  auth || '',
      };
    },
  });

  // Snapshot pruner: daily sweep, deletes pre-state captures older than 30d
  // unless their op_id is in pinned.json. Runs once at boot to clean any
  // accumulated stale snapshots, then daily.
  try { pruneAllSnapshots(); } catch (e) { log.warn('snapshot-pruner', 'boot prune failed', { err: e.message }); }
  setInterval(() => {
    try { pruneAllSnapshots(); }
    catch (e) { log.warn('snapshot-pruner', 'daily prune failed', { err: e.message }); }
  }, 24 * 60 * 60 * 1000).unref?.();
  // Friction-as-proposer needs the same per-user push channel as watchers
  // for proposal bubbles + the task_complete broadcast on accept.
  setProposalBroadcastFn((userId, msg) => sendToUser(userId, msg));
  // Reap stranded 'running' proposals from a previous crash + restore the
  // dismiss-cooldown map so a recently-dismissed pattern doesn't immediately
  // re-propose post-restart.
  bootLoadProposals();

  // Cloudflare tunnel supervisor — only re-spawns if a prior config marked
  // it enabled. The onPublicUrlChange callback re-registers every user's
  // Telegram webhook if the tunnel hostname changes (e.g. user switches
  // their named tunnel to a different mapped hostname).
  startTunnelSupervisor({
    onPublicUrlChange: async (url, prevUrl) => {
      if (url === prevUrl) return;
      const result = await reregisterTelegramWebhooks(url);
      log.info('tunnel', 'Telegram webhooks re-registered after URL change', { url, ...result });
    },
  }).catch(e => log.warn('tunnel', 'Supervisor boot failed', { err: e.message }));
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
  stopWatcherSupervisor();
  stopAllWatchers();
  stopTunnelSupervisor().catch(() => {});
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
