#!/usr/bin/env node
/**
 * Server entrypoint / boot safety-net.
 *
 * This is what the systemd unit and start.sh actually exec. It uses ONLY Node
 * builtins so it can never itself fail to load for want of a dependency.
 *
 * Normal path: import server.mjs, which starts listening. Done.
 *
 * Failure path: if server.mjs can't load ONLY because a dependency is missing
 * or a native module won't load (ERR_MODULE_NOT_FOUND / ERR_DLOPEN_FAILED) —
 * the exact case ensure-deps.mjs couldn't auto-repair — bring up a tiny
 * diagnostic server on the same port that TELLS the operator what's wrong and
 * offers a one-click retry, instead of crash-looping into a dead port with no
 * explanation. Any OTHER load error (a real code bug) is re-thrown so it
 * crashes loudly — we never mask genuine bugs behind a friendly page.
 *
 * Self-heals: the diagnostic page's Retry, and a periodic background retry,
 * re-run ensure-deps.mjs; once deps resolve, the launcher restarts into the
 * real server (via systemd Restart=, or a fresh re-exec when standalone).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SELF = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SELF);
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const SERVER_ENTRY = process.env.OE_LAUNCH_TARGET
  ? path.resolve(ROOT, process.env.OE_LAUNCH_TARGET)
  : path.join(ROOT, 'server.mjs');
const ENSURE_DEPS = path.join(SCRIPTS_DIR, 'ensure-deps.mjs');
const STATUS_PATH = path.join(ROOT, 'dep-status.json');
const PORT = Number(process.env.PORT) || 3737;

const DEP_ERROR_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED']);
function isDependencyLoadFailure(err) {
  return !!err && DEP_ERROR_CODES.has(err.code);
}

function log(...a) { console.log('[launch]', ...a); }

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); }
  catch { return null; }
}

// ── main ─────────────────────────────────────────────────────────────────
try {
  await import(SERVER_ENTRY);
  // Resolved → server.mjs ran its top-level (listen is scheduled). The open
  // server handle keeps this process alive; nothing more to do here.
} catch (err) {
  if (!isDependencyLoadFailure(err)) {
    // A real bug (syntax error, runtime throw, bad config). Fail loudly.
    console.error('[launch] server failed to start (not a dependency issue) — re-throwing:');
    throw err;
  }
  log(`server.mjs could not load due to a missing/unbuildable dependency (${err.code}). Starting the diagnostic fallback on port ${PORT}.`);
  startFallback(err);
}

// ── Fallback diagnostic server ─────────────────────────────────────────────
function startFallback(loadErr) {
  let retrying = false;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/retry') {
      runRetry(res);
      return;
    }
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '30' });
    res.end(renderPage(loadErr));
  });

  server.on('error', (e) => {
    // If we can't even bind the port, there's nothing more we can do but log —
    // exiting would just crash-loop, so stay up and keep the log visible.
    log(`diagnostic server could not bind port ${PORT}: ${e.message}`);
  });

  server.listen(PORT, '0.0.0.0', () => {
    log(`Diagnostic page live at http://<this-host>:${PORT} — waiting for dependencies to be resolved.`);
  });

  // Auto-retry in the background so the server heals itself once the operator
  // installs whatever was missing (e.g. build tools), without them having to
  // click anything.
  const timer = setInterval(() => { if (!retrying) attemptHeal(); }, 3 * 60 * 1000);
  timer.unref?.();

  function runRetry(res) {
    if (retrying) { res.writeHead(429).end('Retry already in progress'); return; }
    // Kick the heal, but answer the request immediately — a native rebuild can
    // take minutes and we don't want the browser to hang.
    attemptHeal();
    res.writeHead(202, { 'Content-Type': 'text/plain' });
    res.end('Retrying dependency install — this page will start working once it succeeds. Refresh in a minute.');
  }

  function attemptHeal() {
    retrying = true;
    log('Re-running ensure-deps.mjs…');
    try {
      spawnSync(process.execPath, [ENSURE_DEPS], { cwd: ROOT, stdio: 'inherit', env: process.env });
    } catch (e) {
      log(`ensure-deps run failed: ${e.message}`);
    }
    const status = readStatus();
    if (status && status.ok) {
      log('Dependencies resolved — restarting into the real server.');
      relaunch(server);
    } else {
      retrying = false;
    }
  }
}

// Restart into a fresh process so server.mjs is imported cleanly. Under systemd
// exiting is enough (Restart=always respawns us); standalone we re-exec so the
// server actually comes back.
function relaunch(server) {
  const underSystemd = !!(process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID);
  try { server.close(); } catch { /* ignore */ }
  if (underSystemd) {
    process.exit(0);
    return;
  }
  try {
    const child = spawn(process.execPath, [SELF], { stdio: 'inherit', env: process.env });
    child.on('spawn', () => process.exit(0));
    child.on('error', (e) => log(`re-exec failed, staying in fallback: ${e.message}`));
  } catch (e) {
    log(`re-exec failed, staying in fallback: ${e.message}`);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function renderPage(loadErr) {
  const status = readStatus();
  const missing = status?.missing?.length ? status.missing : null;
  const reason = status?.reason || loadErr?.message || 'A required dependency could not be loaded.';
  const logTail = status?.logTail || '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenEnsemble — needs attention</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 760px; margin: 8vh auto; padding: 0 20px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; margin: 0 0 1.5rem; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 10px; padding: 18px 20px; margin: 14px 0; }
  code, pre { font-family: ui-monospace, monospace; }
  pre { background: rgba(128,128,128,.12); padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; }
  ul { padding-left: 1.2rem; } li { margin: .2rem 0; }
  button { font: inherit; padding: 9px 16px; border-radius: 8px; border: 1px solid rgba(128,128,128,.4);
           background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .ok { color: #16a34a; } .muted { opacity: .65; font-size: 13px; }
</style></head>
<body>
  <h1>OpenEnsemble can't finish starting</h1>
  <p class="sub">A dependency is missing or couldn't be built, so the main server didn't load. Everything below runs on a minimal fallback — the app itself is not up yet.</p>

  <div class="card">
    <strong>What happened</strong>
    <p>${esc(reason)}</p>
    ${missing ? `<p>Still missing:</p><ul>${missing.map((m) => `<li><code>${esc(m)}</code></li>`).join('')}</ul>` : ''}
  </div>

  <div class="card">
    <strong>Try to fix it automatically</strong>
    <p class="muted">Re-runs the dependency install. If the packages are just missing, this usually fixes it on its own.</p>
    <button id="retry" onclick="retry()">Retry install</button>
    <span id="msg" class="muted" style="margin-left:10px"></span>
  </div>

  <div class="card">
    <strong>If retry keeps failing</strong>
    <p class="muted">A dependency with a native build (e.g. it needs a C++ compiler) can't install without the build tools. On Debian/Ubuntu:</p>
    <pre>sudo apt-get install -y build-essential python3
# then, from the install directory:
npm install</pre>
    <p class="muted">This page retries on its own every few minutes and will switch to the app once the install succeeds.</p>
  </div>

  ${logTail ? `<div class="card"><strong>Last install log (tail)</strong><pre>${esc(logTail)}</pre></div>` : ''}

<script>
  async function retry() {
    var b = document.getElementById('retry'), m = document.getElementById('msg');
    b.disabled = true; m.textContent = 'Retrying…';
    try {
      var r = await fetch('/retry', { method: 'POST' });
      m.textContent = await r.text();
    } catch (e) { m.textContent = 'Retry request failed: ' + e; }
    setTimeout(function () { location.reload(); }, 60000);
  }
</script>
</body></html>`;
}
