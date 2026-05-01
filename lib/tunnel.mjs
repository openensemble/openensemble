/**
 * Tunnel supervisor — exposes this OE install to the public internet via
 * Cloudflare Tunnel (token mode):
 *
 *   `cloudflared tunnel run --token <token>` — user creates the tunnel in
 *   their CF Zero Trust dashboard, maps a hostname (e.g. oe.example.com)
 *   to http://localhost:<port>, copies the token, pastes it here. We
 *   supervise a long-lived child process.
 *
 * Other providers were prototyped and removed:
 *   • Quick Tunnel (*.trycloudflare.com) — Telegram's webhook resolver
 *     couldn't look up trycloudflare hostnames.
 *   • Tailscale Funnel — same Telegram resolver issue with *.ts.net,
 *     and the OE-managed tailscaled added significant complexity for no
 *     benefit over Cloudflare Token mode for the primary use case.
 *
 * State lives in tunnel.json at the install root (gitignored — contains the
 * tunnel token in plaintext, matching the existing config.json provider-key
 * pattern). chmod 600 on every write.
 *
 * The supervisor is intentionally a small state machine, not a generic
 * process manager. We track:
 *   mode, enabled, autoStart, token, hostname, publicUrl, lastError,
 *   state ∈ {stopped, starting, running, crashed, error}
 *
 * On restart with `enabled === true` the supervisor calls start() once. If
 * the subprocess exits non-zero without a stop() request, we restart with
 * exponential backoff capped at 60 s, giving up after 5 consecutive failures
 * within 5 min and entering 'crashed' state — user must explicitly Start
 * again from the UI to retry.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { BASE_DIR } from './paths.mjs';
import { ensureCloudflared, findCloudflared } from './tunnel-binary.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { log } from '../logger.mjs';

const TUNNEL_PATH = path.join(BASE_DIR, 'tunnel.json');
const PID_PATH    = path.join(BASE_DIR, 'tunnel.pid');

const RESTART_WINDOW_MS  = 5 * 60_000;
const RESTART_MAX_TRIES  = 5;
const BACKOFF_MIN_MS     = 1_000;
const BACKOFF_MAX_MS     = 60_000;

// In-memory live state (the truth for whether we're running). Persisted state
// in tunnel.json is the recovery copy after a server restart.
let _proc = null;
let _state = 'stopped';
let _publicUrl = null;
let _lastError = null;
let _stopRequested = false;
let _restartAttempts = [];
let _backoffTimer = null;
let _onPublicUrlChange = null; // (url, prevUrl) => Promise<void>

// ── Persistence ──────────────────────────────────────────────────────────────

function defaultConfig() {
  return {
    mode: 'off',           // 'off' | 'cloudflare'
    enabled: false,        // boot autostart toggle
    token: null,           // CF tunnel token
    hostname: null,        // user-configured CF hostname
    localPort: 3737,       // OE port to expose
    publicUrl: null,       // last-known URL
    lastError: null,
    updatedAt: null,
  };
}

function loadTunnelConfig() {
  try {
    if (fs.existsSync(TUNNEL_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TUNNEL_PATH, 'utf8'));
      // Schema migrations from removed providers/modes.
      if (raw.mode === 'quick' || raw.mode === 'tailscale') {
        raw.mode = 'off'; raw.enabled = false; raw.publicUrl = null;
      }
      if (raw.mode === 'token') raw.mode = 'cloudflare'; // pre-multi-provider name
      delete raw.authKey; // Tailscale-only field, no longer used
      return { ...defaultConfig(), ...raw };
    }
  } catch (e) {
    log.warn('tunnel', 'Failed to parse tunnel.json — using defaults', { err: e.message });
  }
  return defaultConfig();
}

async function saveTunnelConfig(patch) {
  return withLock(TUNNEL_PATH, () => {
    const cur = loadTunnelConfig();
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    atomicWriteSync(TUNNEL_PATH, JSON.stringify(next, null, 2));
    try { fs.chmodSync(TUNNEL_PATH, 0o600); } catch {}
    return next;
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Boot the supervisor. If tunnel.json says enabled === true, kick off start().
 * Idempotent — safe to call multiple times.
 */
export async function startTunnelSupervisor({ onPublicUrlChange } = {}) {
  _onPublicUrlChange = onPublicUrlChange ?? null;
  // Reap a stale PID file from a prior unclean shutdown. We don't kill it —
  // could be a different process by now — just delete the stale record.
  try { if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH); } catch {}

  const cfg = loadTunnelConfig();
  if (cfg.enabled && cfg.mode !== 'off') {
    log.info('tunnel', 'Auto-starting tunnel from prior config', { mode: cfg.mode });
    try { await start(); }
    catch (e) { log.warn('tunnel', 'Auto-start failed', { err: e.message }); }
  }
}

export async function stopTunnelSupervisor() {
  // Preserve enabled flag — this is a server-lifecycle stop, not a user-
  // intended Stop. Otherwise every restart would silently disable the
  // tunnel and the user would have to re-Start it after every reboot.
  await stop({ persistEnabled: true });
}

/**
 * Read-only status snapshot. Suitable for /api/tunnel/status.
 * Includes the token-set flag but not the token itself.
 */
export function getStatus() {
  const cfg = loadTunnelConfig();
  return {
    mode: cfg.mode,
    enabled: cfg.enabled,
    hostname: cfg.hostname,
    hasToken: !!cfg.token,
    localPort: cfg.localPort,
    state: _state,
    publicUrl: _publicUrl ?? cfg.publicUrl ?? null,
    lastError: _lastError ?? cfg.lastError ?? null,
    binaryPresent: !!findCloudflared(),
    pid: _proc?.pid ?? null,
  };
}

/** Same as getStatus().publicUrl, exposed for the Telegram autofill route. */
export function getPublicUrl() {
  if (_state === 'running' && _publicUrl) return _publicUrl;
  const cfg = loadTunnelConfig();
  // Only return a cached URL if the supervisor thinks the tunnel should be up.
  if (cfg.enabled && cfg.publicUrl) return cfg.publicUrl;
  return null;
}

/**
 * Persist new configuration. Does NOT start/stop directly, but flips
 * `enabled: true` when the resulting config has a runnable token-mode
 * tunnel — so the next server restart auto-connects without the user
 * having to re-click Start. Switching mode to 'off' flips enabled to
 * false (nothing to run).
 * @param {object} patch  { mode?, token?, hostname?, localPort? }
 */
export async function configure(patch) {
  const sanitized = {};
  if (patch.mode !== undefined) {
    if (!['off', 'cloudflare'].includes(patch.mode)) {
      throw new Error('mode must be one of: off, cloudflare');
    }
    sanitized.mode = patch.mode;
  }
  if (patch.token !== undefined) {
    sanitized.token = patch.token ? String(patch.token).trim() : null;
  }
  if (patch.hostname !== undefined) {
    sanitized.hostname = patch.hostname ? String(patch.hostname).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
  }
  if (patch.localPort !== undefined) {
    const n = Number(patch.localPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('localPort must be 1-65535');
    sanitized.localPort = n;
  }
  // Auto-enable: if the merged config is fully runnable, flip enabled=true.
  // If switching to off, flip enabled=false. Previously the user had to also
  // click Start to make boot autostart kick in — surprising for "I saved a
  // tunnel, why doesn't it come back after restart?".
  const cur = loadTunnelConfig();
  const merged = { ...cur, ...sanitized };
  if (merged.mode === 'off') sanitized.enabled = false;
  else if (merged.mode === 'cloudflare' && merged.token) sanitized.enabled = true;
  return saveTunnelConfig(sanitized);
}

/**
 * Start the tunnel using the configured provider. If already running, no-op.
 * Throws if mode is 'off' or provider-required fields are missing.
 */
export async function start() {
  if (_proc) return getStatus();
  const cfg = loadTunnelConfig();
  if (cfg.mode === 'off') throw new Error('Tunnel mode is off — configure mode first');
  if (cfg.mode === 'cloudflare') return _startCloudflare(cfg);
  throw new Error(`Unsupported tunnel mode: ${cfg.mode}`);
}

async function _startCloudflare(cfg) {
  if (!cfg.token) throw new Error('Cloudflare mode requires a CF tunnel token');

  _stopRequested = false;
  _state = 'starting';
  _lastError = null;

  let bin;
  try { bin = await ensureCloudflared({ logger: (m) => log.info('tunnel', m) }); }
  catch (e) {
    _state = 'error';
    _lastError = e.message;
    await saveTunnelConfig({ lastError: e.message });
    throw e;
  }

  const args = ['tunnel', '--no-autoupdate', 'run', '--token', cfg.token];

  log.info('tunnel', 'Spawning cloudflared', { mode: cfg.mode, port: cfg.localPort });
  _proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  try { fs.writeFileSync(PID_PATH, String(_proc.pid)); } catch {}

  let stderrBuf = '';
  const handleLine = async (line) => {
    // Token mode "Registered tunnel connection" lines confirm we're up. The
    // public URL is just the user-configured hostname — cloudflared doesn't
    // emit it, since the routing happens server-side at Cloudflare.
    if (/Registered tunnel connection/i.test(line)) {
      if (_state !== 'running') {
        _state = 'running';
        const url = cfg.hostname ? `https://${cfg.hostname}` : null;
        if (url && url !== _publicUrl) {
          const prev = _publicUrl;
          _publicUrl = url;
          await saveTunnelConfig({ publicUrl: url, lastError: null });
          if (_onPublicUrlChange) {
            try { await _onPublicUrlChange(url, prev); }
            catch (e) { log.warn('tunnel', 'onPublicUrlChange callback failed', { err: e.message }); }
          }
        }
      }
    }
  };

  _proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      handleLine(line).catch(() => {});
    }
  });
  _proc.stdout.on('data', (chunk) => {
    // cloudflared usually doesn't write to stdout for these subcommands, but
    // we watch it anyway in case a future version moves logging over.
    const txt = chunk.toString();
    for (const line of txt.split('\n')) if (line) handleLine(line).catch(() => {});
  });

  _proc.on('exit', (code, signal) => {
    log.info('tunnel', 'cloudflared exited', { code, signal, stopRequested: _stopRequested });
    const wasRunning = _state === 'running';
    _proc = null;
    try { if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH); } catch {}

    if (_stopRequested) {
      _state = 'stopped';
      _publicUrl = null;
      saveTunnelConfig({ publicUrl: null }).catch(() => {});
      return;
    }

    // Unexpected exit — record + maybe restart.
    _lastError = `cloudflared exited (code=${code} signal=${signal})`;
    saveTunnelConfig({ lastError: _lastError }).catch(() => {});

    const now = Date.now();
    _restartAttempts = _restartAttempts.filter(t => now - t < RESTART_WINDOW_MS);
    _restartAttempts.push(now);
    if (_restartAttempts.length > RESTART_MAX_TRIES) {
      log.warn('tunnel', `cloudflared failed ${RESTART_MAX_TRIES}× in ${RESTART_WINDOW_MS / 60000}min — giving up`);
      _state = 'crashed';
      return;
    }
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, _restartAttempts.length - 1));
    log.info('tunnel', `restarting in ${backoff}ms (attempt ${_restartAttempts.length}/${RESTART_MAX_TRIES})`);
    _backoffTimer = setTimeout(() => { start().catch(e => log.warn('tunnel', 'auto-restart failed', { err: e.message })); }, backoff);
    if (wasRunning) _state = 'starting';
  });
}

/**
 * Stop whichever provider is active and clear any auto-restart backoff.
 * @param {{persistEnabled?: boolean}} opts  When persistEnabled === false (the
 *   default), we also write enabled:false so the next server boot doesn't
 *   re-spawn. Pass true to keep enabled flag (e.g. for transient stops).
 */
export async function stop({ persistEnabled = false } = {}) {
  _stopRequested = true;
  if (_backoffTimer) { clearTimeout(_backoffTimer); _backoffTimer = null; }
  // Cloudflare path: kill the cloudflared subprocess we spawned.
  if (_proc) {
    try { _proc.kill('SIGTERM'); } catch {}
    // SIGKILL fallback after 5 s if it didn't honor SIGTERM.
    setTimeout(() => { if (_proc) try { _proc.kill('SIGKILL'); } catch {} }, 5_000);
  }
  _state = 'stopped';
  _publicUrl = null;
  await saveTunnelConfig({ publicUrl: null, ...(persistEnabled ? {} : { enabled: false }) });
}

/** Persist enabled flag — called by the /enable + /disable routes. */
export async function setEnabled(enabled) {
  return saveTunnelConfig({ enabled: !!enabled });
}
