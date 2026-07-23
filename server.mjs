/**
 * OpenEnsemble — Lightweight AI assistant server
 * HTTP + WebSocket on port 3737
 */

import http       from 'http';
import https      from 'https';
import fs         from 'fs';
import path       from 'path';
import os         from 'os';
import crypto     from 'crypto';
import { fileURLToPath } from 'url';
import { listAgents } from './agents.mjs';
import { loadRoleManifests, validateSkills, reconcileRoleDrawers } from './roles.mjs';
import { loadDrawerManifests, stopAllDrawerWorkers } from './plugins.mjs';
import { startScheduler, stopScheduler, loadTasksForOwner, addTask, removeTask, registerBuiltin } from './scheduler.mjs';
import { initPersonalization } from './lib/personalization/scheduler-init.mjs';
import { setNotifyFn } from './lib/personalization/notify.mjs';
import { startWatcherSupervisor, stopWatcherSupervisor } from './scheduler/watchers.mjs';
import { startBackgroundRefresh as startHaCacheRefresh } from './lib/ha-cache.mjs';
import {
  startHaWebSocketBridge,
  stopHaWebSocketBridge,
} from './lib/ha-websocket.mjs';
import { handleHomeAssistantOpenEnsembleEvent } from './lib/ha-event-bridge.mjs';
import { loadIntentEmbeddings } from './lib/specialist-embed-router.mjs';
import { registerSystemWatchHandlers } from './scheduler/watch-handlers.mjs';
import { startHealthMonitorHandlers } from './scheduler/health-monitor.mjs';
import { pruneAllSnapshots } from './scheduler/snapshot-pruner.mjs';
import { makeNodeExecFn } from './lib/node-exec-wrapper.mjs';
import { resolveTokenStorage } from './lib/token-storage.mjs';
import { loadProfile as loadServiceProfile } from './lib/service-profile.mjs';
import { setProposalBroadcastFn, bootLoadProposals } from './lib/proposals.mjs';
import { startVoiceUdpLog } from './lib/voice-udplog.mjs';
import { recordDeviceDiag } from './lib/voice-device-health.mjs';
import { startVoiceDeviceMonitor, stopVoiceDeviceMonitor } from './lib/voice-device-monitor.mjs';
import { startCalendarMirrorLoop, stopCalendarMirrorLoop } from './lib/calendar-mirror.mjs';
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
import { handle as handleXaiOAuth }      from './routes/xai-oauth.mjs';
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
import { handle as handleAdmission }    from './routes/admission.mjs';
import { handle as handleBrowserPairing } from './routes/browser-pairing.mjs';
import { handle as handleDevices }      from './routes/devices.mjs';
import { handle as handleWakewords }    from './routes/wakewords.mjs';
import { handle as handleTv }           from './routes/tv.mjs';
import { handle as handleVoiceRefs }    from './routes/voice-refs.mjs';
import { handle as handleVoiceConfig }  from './routes/voice-config.mjs';
import { handle as handleRoutines }     from './routes/routines.mjs';
import { handle as handlePersonalization } from './routes/personalization.mjs';
import { handle as handleTutor }          from './routes/tutor.mjs';
import { handle as handleCoder }          from './routes/coder.mjs';
import { handle as handleGuide }          from './routes/guide.mjs';
import { handle as handleHomeAssistant }  from './routes/home-assistant.mjs';
import { handle as handleMcp }            from './routes/mcp.mjs';
import { handle as handleMcpOutbound }    from './lib/mcp-outbound.mjs';
import { handle as handleRunInspector }   from './routes/run-inspector.mjs';
import { handle as handleSkillPermissions } from './routes/skill-permissions.mjs';
import { sendTelegramToUser, reregisterAllWebhooks as reregisterTelegramWebhooks } from './routes/telegram.mjs';
import { scheduledTelegramDeliveryScope } from './lib/telegram-delivery-idempotency.mjs';
import { speakReminder, pickReminderDevices } from './lib/voice-reminder.mjs';
import { registerAlarm, getCachedAlarmTts, sendAlarmArm } from './lib/alarms.mjs';
import { formatDurationAdj } from './lib/voice-timer.mjs';
import { startDiscoveryBeacon, stopDiscoveryBeacon, startMdnsAdvertiser, stopMdnsAdvertiser } from './discovery.mjs';
import { migrateUserDirs }               from './migrate-user-dirs.mjs';
import { setBackgroundUserSendFn, bootRecoverInterruptedTasks } from './background-tasks.mjs';
import { setNodesBroadcastFn } from './skills/nodes/execute.mjs';
import { setRuntimeWarnBroadcast } from './lib/runtime-warn.mjs';
import { setSalienceNotifyBroadcast } from './lib/proposal-salience.mjs';
import { startUpdateChecker } from './lib/update.mjs';
import { runBootCheck, aliveResponse, cancelCommitDeadline } from './lib/oe-admin-boot-check.mjs';
import { resumeRestartContinuationAtBoot } from './lib/restart-continuation.mjs';
import { sendReminderEmail } from './lib/reminder-email.mjs';

// Shared helpers
import {
  loadConfig, loadUsers, loadPersistedSessions, setBroadcastFn, setUserBroadcastFn,
  CFG_PATH, getClientIp,
} from './routes/_helpers.mjs';
import { log, configureLogger } from './logger.mjs';

// Apply user-configured log caps from config.json (safe to call before any log).
try {
  const _cfg = loadConfig();
  if (_cfg?.logs) configureLogger(_cfg.logs);
} catch {}

// Process-wide backstop: an unhandled promise rejection (e.g. a throw inside
// an async request/WS handler that no local try/catch caught) would, under
// Node's default policy, terminate the process — turning any single malformed
// request into a crash-loop that wipes all in-memory state. Registering this
// listener overrides that default: log it loudly and stay up. This is the
// safety net; individual handlers still guard their own failure paths.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  try { log.error('process', 'unhandledRejection (kept alive)', { err }); }
  catch { console.error('[process] unhandledRejection (kept alive):', err); }
});

const PORT     = 3737;
const HTTPS_PORT = 3739;  // adjacent to 3737; 3738 reserved for the node-agent UDP discovery broadcast
const UI_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
// The isolated real-model lab must not start any independent writer, network
// listener, credential migration, or host repair before the later scheduler
// guard is reached. Production never sets this environment variable.
const ISOLATED_LAB_RUNTIME = process.env.OPENENSEMBLE_LAB === '1';

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

// ── UI build id + asset caching ──────────────────────────────────────────────
// One hash over the UI shell (top-level html/js/css + vendor libs), computed
// at boot. index.html is served with every local js/css URL stamped
// ?v=<buildId>, and an asset request whose ?v matches gets a far-future
// immutable cache; anything else revalidates via ETag. This makes one page
// load an atomic bundle — the old `max-age=3600` with no validators let a
// phone run mixed old/new files for up to an hour after every update.
// Note: assets edited without a server restart keep the old build id, so
// stamped URLs may pin stale copies until the next restart recomputes the id
// (production updates always restart; dev already restarts for CSS concat).
let UI_BUILD_ID = 'dev';
function computeUiBuildId() {
  const entries = [];
  const addDir = (dir, prefix) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      entries.push(`${prefix}${name}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  };
  addDir(UI_DIR, '');
  addDir(path.join(UI_DIR, 'vendor'), 'vendor/');
  UI_BUILD_ID = crypto.createHash('sha1').update(entries.join('\n')).digest('hex').slice(0, 12);
  console.log(`[ui] Build id ${UI_BUILD_ID}`);
}

function fileEtag(st) {
  return `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
}

// Answers with 304 (and returns true) when the client already has this ETag.
function notModified(req, res, etag, cacheControl) {
  if (req.headers['if-none-match'] !== etag) return false;
  res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
  res.end();
  return true;
}

function requestedBuildId(reqUrl) {
  return (reqUrl.match(/[?&]v=([0-9a-f]+)/) || [])[1];
}

// index.html with build-id-stamped asset URLs, memoized on (mtime, build id).
let _indexCache = null;
function versionedIndexHtml() {
  const indexPath = path.join(UI_DIR, 'index.html');
  const st = fs.statSync(indexPath);
  if (!_indexCache || _indexCache.mtimeMs !== st.mtimeMs || _indexCache.buildId !== UI_BUILD_ID) {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const html = raw.replace(
      /(src|href)="(\/(?:vendor\/)?[^"?]+\.(?:js|css))"/g,
      `$1="$2?v=${UI_BUILD_ID}"`,
    );
    _indexCache = {
      mtimeMs: st.mtimeMs,
      buildId: UI_BUILD_ID,
      html: Buffer.from(html),
      etag: `"idx-${UI_BUILD_ID}-${Math.round(st.mtimeMs).toString(16)}"`,
    };
  }
  return _indexCache;
}

// ── Route dispatch order ─────────────────────────────────────────────────────
const routeHandlers = [
  handleHealth,    // /health (public) + /api/admin/health (authed)
  handlePlugins,   // must be early — delegates /api/* to plugin servers
  handleOAuth,          // /api/oauth/google/* — per-user Google OAuth flow
  handleMsOAuth,        // /api/oauth/microsoft/* — Microsoft OAuth flow
  handleOpenAIOAuth,    // /api/oauth/openai/*    — ChatGPT (Codex) OAuth flow
  handleXaiOAuth,       // /api/oauth/xai/*       — SuperGrok / X Premium+ OAuth flow
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
  handleAdmission,
  handleBrowserPairing,
  handleDevices,
  handleWakewords,
  handleTv,        // /api/tv/* + /api/tv-app/* + /api/wakewords/stock/:id.tflite
                   // (after handleWakewords, which only matches /api/wakewords
                   // exactly and single-segment /api/wakewords/:id, so it falls
                   // through for the stock-alias GET)
  handleVoiceRefs,
  handleVoiceConfig,
  handleRoutines,
  handlePersonalization,
  handleMisc,
  handleTelegram,
  handleTunnel,
  handleIntegrations,
  handleTutor,
  handleCoder,
  handleGuide,
  handleHomeAssistant,
  handleMcp,
  handleMcpOutbound,  // /mcp — OE exposed AS an MCP server (bearer PAT auth)
  handleRunInspector,
  handleSkillPermissions,
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
    const idx = versionedIndexHtml();
    if (notModified(req, res, idx.etag, 'no-cache')) return;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', ETag: idx.etag });
    res.end(idx.html); return;
  }


  if (_pathname === '/manifest.json') {
    const mfPath = path.join(UI_DIR, 'manifest.json');
    const mfEtag = fileEtag(fs.statSync(mfPath));
    if (notModified(req, res, mfEtag, 'no-cache')) return;
    const manifest = fs.readFileSync(mfPath);
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache', ETag: mfEtag });
    res.end(manifest); return;
  }

  // Serve static assets from public/ (css, js). A ?v matching the current
  // build id caches forever (index.html stamps those URLs); anything else
  // revalidates every load via ETag.
  const STATIC_TYPES = { '.css': 'text/css', '.js': 'text/javascript' };
  const ext = path.extname(_pathname);
  if (STATIC_TYPES[ext]) {
    const safeName = path.basename(_pathname);
    const filePath = path.join(UI_DIR, safeName);
    let stat = null;
    try { stat = fs.statSync(filePath); } catch {}
    if (stat?.isFile()) {
      const etag = fileEtag(stat);
      const cache = requestedBuildId(req.url) === UI_BUILD_ID
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      if (notModified(req, res, etag, cache)) return;
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext], 'Cache-Control': cache, ETag: etag });
      res.end(data); return;
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
      // decodeURIComponent throws URIError on a malformed escape (e.g.
      // `/firmware/%.js`). This block runs before the request-dispatch
      // try/catch, so an uncaught throw here would reject the request
      // handler's promise — a pre-auth remote crash vector. Guard it and
      // 400 instead.
      let decoded;
      try { decoded = decodeURIComponent(url).replace(/^\/+/, ''); }
      catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad request'); return; }
      const filePath = path.resolve(UI_DIR, decoded);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch {}
      if (filePath.startsWith(UI_DIR + path.sep) && stat?.isFile()) {
        const etag = fileEtag(stat);
        // vendor/ libs are part of the versioned UI bundle. firmware/ stays
        // no-cache (flash wizard + device OTA iterate on it) but ETag now
        // gives 304s instead of re-sending multi-MB bins.
        const cache = url.startsWith('/vendor/') && requestedBuildId(req.url) === UI_BUILD_ID
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        if (notModified(req, res, etag, cache)) return;
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': NESTED_TYPES[ext],
          'Content-Length': data.length,
          'Cache-Control': cache,
          ETag: etag,
        });
        res.end(data);
        return;
      }
    }
  }

  // Rate-limit API endpoints
  if (req.url.startsWith('/api/')) {
    const ip = getClientIp(req);
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
    // OE Bridge has no same-origin page context during device-code pairing.
    // These two endpoints are intentionally unauthenticated and protected by
    // a high-entropy claim secret + dedicated rate limits. Allow only native
    // clients (no Origin) or extension schemes; approval is NOT exempt.
    const pairingPath = req.url.split('?', 1)[0];
    const pairingOrigin = String(req.headers.origin || '');
    const isBrowserPairingClient = (
      pairingPath === '/api/browser/pairing/requests' ||
      pairingPath === '/api/browser/pairing/claims'
    ) && (!pairingOrigin || /^(?:chrome|moz)-extension:\/\/[a-z0-9_-]+$/i.test(pairingOrigin));
    if (!isOAuthCallback && !isTelegramHook && !isBrowserPairingClient) {
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
initWs(httpServer, { allowAuxiliary: !ISOLATED_LAB_RUNTIME });

// Voice-device UDP diagnostic sink — devices (fw >= 0.2.52) forward their
// [boot]/[hb]/[ambient-stats] heartbeat lines here over UDP so a Wi-Fi-only
// device can be watched live without a serial cable, and the datagrams survive
// WS drops. Tail /tmp/oe-voice-udplog.log. The health loop consumes the same
// stream: cap_sps mic-liveness ([hb], fw >= 0.2.61) catches devices that are
// online-but-deaf, [boot] frequency catches reboot storms; each confirmed
// episode notifies the owner once, with a recovery follow-up. Must be wired
// after initWs — attribution resolves sender IP via the live WS client set.
if (!ISOLATED_LAB_RUNTIME) startVoiceUdpLog({ onLine: recordDeviceDiag });

// Voice-device offline alerting — notifies the owner (Telegram/email) when a
// paired device stays unreachable past the threshold, once per episode, with
// a recovery note when it returns. Must start after initWs: it reads the live
// WS client set via isDeviceOnline. See lib/voice-device-monitor.mjs.
if (!ISOLATED_LAB_RUNTIME) startVoiceDeviceMonitor();

// Calendar mirror refresh loop — 5-min incremental sync-token pulls for every
// user with gcal creds, so calendar fast-paths and calendar_snapshot answer
// from local data. See lib/calendar-mirror.mjs; disable via
// calendarMirrorRefreshMin: 0 in config.json.
if (!ISOLATED_LAB_RUNTIME) startCalendarMirrorLoop();

setBroadcastFn(broadcastAgentList);
setBackgroundUserSendFn(sendToUser);
setNodesBroadcastFn(sendToUser);
setUserBroadcastFn(broadcastToUsers);
setRuntimeWarnBroadcast(broadcast);
setRuntimeMetricsFn(() => ({
  wsClients: getWsClientCount(),
  nodeClients: getNodeClientCount(),
}));

// ── Builtin task: fire reminder notification ─────────────────────────────────
registerBuiltin('fireReminder', async (task, runContext = {}) => {
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
      const ok = await sendTelegramToUser(task.ownerId, `⏰ Reminder: ${task.label}`, {
        idempotencyScope: scheduledTelegramDeliveryScope('fire-reminder', task, runContext),
      });
      if (ok) delivered.push('telegram');
    } catch (e) { console.warn('[reminder] telegram delivery failed:', e.message); }
  }

  if (wantEm) {
    try {
      const result = await sendReminderEmail(task, user, runContext);
      if (result.ok) delivered.push('email');
      else console.warn(`[reminder] email ${result.skipped ? 'skipped' : 'delivery failed'} for ${task.ownerId}: ${result.message}`);
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
registerBuiltin('tutorNudge', async (task, runContext = {}) => {
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
    const ok = await sendTelegramToUser(task.ownerId, line, {
      idempotencyScope: scheduledTelegramDeliveryScope('tutor-nudge', task, runContext),
    });
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
    const ok = await sendTelegramToUser(task.ownerId, line, {
      idempotencyScope: scheduledTelegramDeliveryScope('tutor-nudge', task, runContext),
    });
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
if (!ISOLATED_LAB_RUNTIME) migrateUserDirs();
buildCSS();
computeUiBuildId(); // after buildCSS so styles.css is part of the hash
loadRoleManifests({ runMigrations: !ISOLATED_LAB_RUNTIME });
if (!ISOLATED_LAB_RUNTIME) validateSkills().catch(() => {});
loadDrawerManifests();
if (!ISOLATED_LAB_RUNTIME) reconcileRoleDrawers();
loadPersistedSessions();

// A metered lab run must see one stable router for every case. Warm the local
// embedding index before the HTTP/WebSocket surface becomes healthy, and fail
// the lab closed if it cannot be built. Production retains its asynchronous
// warm-up below so normal startup latency is unchanged.
if (ISOLATED_LAB_RUNTIME) await loadIntentEmbeddings();

// One-shot encryption migration for any plaintext API keys that survive a
// pre-encryption build of OE. Idempotent — no-op once everything is
// encrypted. Uses users/_system/.master-key (in OE backups) so reinstall +
// restore works without manual key handling.
if (!ISOLATED_LAB_RUNTIME) await (async () => {
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
  // Orchestration-mode stamping (integration plan D4): every pre-existing
  // profile gets an explicit { mode: 'ensemble' } so behavior never depends
  // on field absence. After the encryption bootstrap so the two migrations
  // don't interleave writes to the same profiles.
  try {
    const { stampOrchestrationDefaults } = await import('./lib/orchestration-policy.mjs');
    const stamped = await stampOrchestrationDefaults();
    if (stamped > 0) console.log(`[orchestration] normalized policy on ${stamped} profile(s)`);
  } catch (e) {
    console.warn('[orchestration] default stamping failed:', e.message);
  }
})();

// One-shot systemd unit self-repair. Old installs shipped with
// Restart=on-failure, which doesn't fire when the server SIGTERMs itself
// to restart — net effect was "shut down, never come back". Patches the
// unit to Restart=always if needed; takes effect on next restart, doesn't
// disrupt the current session.
if (!ISOLATED_LAB_RUNTIME) (async () => {
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
  if (!ISOLATED_LAB_RUNTIME) {
    runBootCheck({ port: PORT }).catch(e => console.warn('[oe-admin] boot-check failed:', e.message));
    // A restart may have terminated the initiating chat stream after all
    // writes completed. Resume its same-agent, read-only verification/report
    // only after the HTTP surface and role registry are live. Do not await:
    // audited continuations poll the boot-check outcome.
    void resumeRestartContinuationAtBoot();
  }

  // MCP tools — warm each user's tool cache from their registered servers.
  // Fire-and-forget so the listen callback doesn't block; users without
  // mcp.json (the vast majority right now) finish in ~0ms.
  if (!ISOLATED_LAB_RUNTIME) {
    import('./lib/mcp-tools.mjs').then(m => m.warmAllUsersAtBoot())
      .catch(e => console.warn('[mcp-tools] boot warm failed:', e.message));
  }

  // HTTPS listener (port 3739) for browser features that need a secure
  // context — WebUSB / Web Serial for the voice-device flash wizard.
  // Self-signed cert lives at tls/{cert,key}.pem and is generated by
  // install.sh; absence is non-fatal (HTTPS just doesn't come up). To
  // use a real cert, drop your own pair into tls/ and restart.
  if (!ISOLATED_LAB_RUNTIME) try {
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

  // Seeds must complete before the arm loop reads the task files, or a
  // freshly seeded builtin task stays unarmed until the next restart.
  if (!ISOLATED_LAB_RUNTIME) {
    (async () => {
      try { await seedSystemTasks(); } catch (e) { log.warn('startup', 'seedSystemTasks failed', { err: e.message }); }
      try { await initPersonalization(); } catch (e) { console.error('[personalization] initPersonalization failed:', e.message); }
      startScheduler(broadcast);
    })();
  }

  // HA entity-name cache: powers the chat-dispatch fast-path so "turn on X"
  // skips the LLM. Lazy load on first use, plus a periodic refresh so newly
  // added HA devices show up without a server restart.
  if (!ISOLATED_LAB_RUNTIME) {
    startHaCacheRefresh();
    startHaWebSocketBridge({
      onOpenEnsembleEvent: handleHomeAssistantOpenEnsembleEvent,
    });
  }

  // Specialist intent-example embeddings — warm the embed-router cache so the
  // first user query doesn't pay the ~1-3s "embed N example phrases" cost.
  // Runs async; chat works without it (just falls through to regex/coordinator).
  if (!ISOLATED_LAB_RUNTIME) {
    loadIntentEmbeddings().catch(e => log.warn?.('embed-router', 'load failed', { err: e.message }));
  }

  // A real-model lab gate must have no independent writer that can race its
  // exact mailbox/image/recipe baseline. Keep the router warm, but suppress
  // scheduler, watcher, monitor, recovery, tunnel, OAuth-refresh, proposal,
  // pruning, discovery, and self-heal loops. Production never sets this env.
  if (ISOLATED_LAB_RUNTIME) {
    log.info('startup', 'isolated lab background services suppressed');
    return;
  }

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
  setNotifyFn((userId, msg) => sendToUser(userId, msg));

  // Restart recovery for in-flight background delegations/workers: anything
  // still in the on-disk journal was killed by this restart — mark it
  // cancelled, finalize its chip, and notify the owning chat so the
  // coordinator can't claim it's "already in progress" from stale session
  // memory. Must run after startWatcherSupervisor (completeWatcher only sees
  // watcher files already loaded into memory).
  bootRecoverInterruptedTasks().catch(e => log.warn?.('background-tasks', 'boot recovery failed', { err: e.message }));

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

  // Local snapshot pruner: daily sweep for pre-state files older than 30d.
  // Remote host snapshots are intentionally not auto-deleted: an immutable op
  // record can outlive a node→host reassignment, so deletion first needs a
  // durable host-identity binding and a one-shot pruning ledger.
  try { pruneAllSnapshots(); } catch (e) { log.warn('snapshot-pruner', 'boot prune failed', { err: e.message }); }
  setInterval(() => {
    try { pruneAllSnapshots(); }
    catch (e) { log.warn('snapshot-pruner', 'daily prune failed', { err: e.message }); }
  }, 24 * 60 * 60 * 1000).unref?.();

  // OpenAI ChatGPT (Codex) + xAI SuperGrok OAuth token keep-alive: the provider
  // only refreshes a user's token when THAT user makes a call, so an account
  // nobody chats as would let its token (and eventually its refresh_token)
  // lapse and get revoked for inactivity — forcing a manual reconnect. Roll
  // any near-expiry token at boot and daily, regardless of activity.
  (async () => {
    const keepAlive = async (when) => {
      try {
        const { refreshExpiringCodexTokens } = await import('./lib/openai-codex-auth.mjs');
        const r = await refreshExpiringCodexTokens();
        if (r.refreshed || r.failed) log.info('openai-oauth', `${when} codex token keep-alive`, r);
      } catch (e) { log.warn('openai-oauth', `${when} codex keep-alive failed`, { err: e.message }); }
      try {
        const { refreshExpiringXaiTokens } = await import('./lib/xai-oauth-auth.mjs');
        // xAI device-code access tokens are often ~15m; refresh anything
        // expiring within 12h so the daily job still covers them with margin.
        const r = await refreshExpiringXaiTokens({ withinMs: 12 * 60 * 60 * 1000 });
        if (r.refreshed || r.failed) log.info('xai-oauth', `${when} grok token keep-alive`, r);
      } catch (e) { log.warn('xai-oauth', `${when} grok keep-alive failed`, { err: e.message }); }
    };
    await keepAlive('boot');
    setInterval(() => { keepAlive('daily'); }, 24 * 60 * 60 * 1000).unref?.();
  })();
  // Friction-as-proposer needs the same per-user push channel as watchers
  // for proposal bubbles + the task_complete broadcast on accept.
  setProposalBroadcastFn((userId, msg) => sendToUser(userId, msg));
  // Proposal auto-pause notices ride the same per-user push channel — a
  // one-line toast when a proposal kind pauses, instead of silent console-only.
  setSalienceNotifyBroadcast((userId, msg) => sendToUser(userId, msg));
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
  startMdnsAdvertiser(PORT); // no-op if discovery.mdns is false; never blocks/throws on failure
  cortexHealthCheck();

  // Self-heal a stale systemd unit so the boot-safety scripts (ensure-deps +
  // launch) actually run on the NEXT restart. Best-effort, never restarts now,
  // never throws into boot. (Same "re-render versioned artifact at boot" idea
  // the oe CLI wrapper already uses — closes the gap for installs whose unit
  // predates this wiring.)
  import('./scripts/heal-service-unit.mjs')
    .then(({ healServiceUnit }) => {
      const r = healServiceUnit({ installDir: BASE_DIR });
      if (r.changed) log.info('boot', 'systemd unit self-healed (boot-safety wiring added; effective next restart)', { unit: r.unitPath });
    })
    .catch(e => log.warn('boot', 'service-unit self-heal skipped', { err: e.message }));

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
  stopVoiceDeviceMonitor();
  stopCalendarMirrorLoop();
  stopAllDrawerWorkers();
  stopHaWebSocketBridge();
  stopTunnelSupervisor().catch(() => {});
  stopMdnsAdvertiser().catch(() => {});
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
