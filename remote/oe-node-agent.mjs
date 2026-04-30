#!/usr/bin/env node
/**
 * OpenEnsemble Node Agent — lightweight remote machine client.
 * Connects to an OpenEnsemble server and allows remote command execution,
 * status monitoring, and system management.
 *
 * Usage:
 *   node oe-node-agent.mjs                     # Run with config from ~/.oe-node/config.json
 *   Post-install, interact with the agent via the `oe` CLI:
 *     oe                    # service status (default)
 *     oe start|stop|restart # service control
 *     oe logs [-f]          # tail service logs
 *     oe repair <code>      # re-pair with the server
 *     oe update             # download and install the latest agent
 *     oe change-access      # change the agent's sudo access level
 *     oe menu               # interactive config menu
 *     oe help               # full command list
 *
 *   Direct invocation (used by systemd/launchd and the installer, not end users):
 *     node oe-node-agent.mjs                    # daemon mode
 *     node oe-node-agent.mjs install-service    # install service + CLI wrapper
 *     node oe-node-agent.mjs uninstall          # remove service
 *     node oe-node-agent.mjs setup --pair-only  # write config, don't start
 *
 * Config (~/.oe-node/config.json):
 *   {
 *     "server": "ws://your-server:3737/ws/nodes",
 *     "token": "your-session-token",
 *     "nodeId": "my-machine",
 *     "capabilities": ["docker", "proxmox"]
 *   }
 */

import { spawn, execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import http from 'http';
import readline from 'readline';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Version ──────────────────────────────────────────────────────────────────
// Bump this any time the agent script changes so the server can detect outdated
// nodes. The server reads this constant from /nodes/agent to know the latest
// version; the agent sends it in the register message.
const AGENT_VERSION = '1.6.2';

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.USERPROFILE || process.env.HOME || '.', '.oe-node')
  : path.join(process.env.HOME || '/root', '.oe-node');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Secure permissions on Linux/macOS
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  }
}

// ── Auto-Discovery ───────────────────────────────────────────────────────────
const DISCOVERY_PORT = 3738;
const DISCOVERY_MAGIC = 'OPENENSEMBLE';

function discoverServer(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('No server found on LAN (timed out)'));
    }, timeoutMs);

    sock.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.magic === DISCOVERY_MAGIC && data.host && data.port) {
          clearTimeout(timer);
          sock.close();
          resolve({
            host: data.host,
            port: data.port,
            hostname: data.hostname,
            wsUrl: `ws://${data.host}:${data.port}/ws/nodes`,
            httpUrl: `http://${data.host}:${data.port}`,
          });
        }
      } catch {}
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
      reject(new Error(`Discovery error: ${err.message}`));
    });

    sock.bind(DISCOVERY_PORT, () => {
      log('Scanning LAN for OpenEnsemble server...');
    });
  });
}

// ── Pairing ──────────────────────────────────────────────────────────────────
function redeemPairingCode(httpUrl, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code });
    const url = new URL('/api/nodes/redeem', httpUrl);

    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode === 200 && result.token) {
            resolve(result);
          } else {
            reject(new Error(result.error || 'Pairing failed'));
          }
        } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Interactive Setup ────────────────────────────────────────────────────────
async function interactiveSetup() {
  // Unattended mode: OE_PAIRING_CODE preseed means skip all prompts. Used by
  // install.sh when invoked with --code, or by an agent-driven provisioning run
  // (e.g. Proxmox host looping over LXCs via `pct exec`).
  const unattendedCode = (process.env.OE_PAIRING_CODE || '').trim();
  const unattended = unattendedCode.length > 0;

  const rl = unattended ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = unattended
    ? async () => ''
    : (q) => new Promise(r => rl.question(q, r));

  console.log('\n=== OpenEnsemble Node Agent Setup ===\n');
  if (unattended) console.log('(Unattended mode: OE_PAIRING_CODE set — skipping prompts)\n');

  // Step 1: Discover, use pre-seeded env var, or manual entry.
  // OE_AGENT_DEFAULT_SERVER lets the install.sh bootstrap skip discovery entirely
  // by passing the known server URL (e.g. "http://10.0.0.10:3737").
  let serverInfo = null;
  const preseed = process.env.OE_AGENT_DEFAULT_SERVER;

  if (preseed) {
    const m = preseed.match(/^(?:https?|wss?):\/\/([^/:]+)(?::(\d+))?/);
    if (m) {
      const host = m[1];
      const port = parseInt(m[2], 10) || 3737;
      console.log(`Step 1: Using server from installer: ${host}:${port}`);
      if (unattended) {
        serverInfo = {
          host, port,
          wsUrl: `ws://${host}:${port}/ws/nodes`,
          httpUrl: `http://${host}:${port}`,
        };
      } else {
        console.log('  (set OE_AGENT_DEFAULT_SERVER= to override)\n');
        const confirm = (await ask('Use this server? [Y/n]: ')).trim().toLowerCase();
        if (confirm !== 'n' && confirm !== 'no') {
          serverInfo = {
            host, port,
            wsUrl: `ws://${host}:${port}/ws/nodes`,
            httpUrl: `http://${host}:${port}`,
          };
        }
      }
    }
  }

  if (!serverInfo) {
    if (unattended) {
      console.error('Unattended setup requires --server (OE_AGENT_DEFAULT_SERVER) alongside --code (OE_PAIRING_CODE).');
      process.exit(1);
    }
    console.log('Step 1: Find server');
    console.log('  [1] Auto-discover on LAN');
    console.log('  [2] Enter server address manually\n');
    const choice = await ask('Choice (1/2): ');

    if (choice.trim() === '1') {
      try {
        serverInfo = await discoverServer(15000);
        console.log(`\nFound server: ${serverInfo.hostname} at ${serverInfo.host}:${serverInfo.port}`);
      } catch (e) {
        console.log(`\n${e.message}`);
        console.log('Falling back to manual entry.\n');
      }
    }

    if (!serverInfo) {
      const addr = await ask('Server address (e.g. 10.0.0.10:3737): ');
      const [host, port] = addr.trim().split(':');
      serverInfo = {
        host: host || 'localhost',
        port: parseInt(port, 10) || 3737,
        wsUrl: `ws://${host || 'localhost'}:${port || 3737}/ws/nodes`,
        httpUrl: `http://${host || 'localhost'}:${port || 3737}`,
      };
    }
  }

  // Step 2: Authenticate via pairing code
  let code;
  if (unattended) {
    console.log(`Step 2: Pairing with code from OE_PAIRING_CODE`);
    code = unattendedCode;
  } else {
    console.log('\nStep 2: Pair with server');
    console.log('  In the OpenEnsemble web UI, open the Nodes drawer and click "Pair New Node".');
    console.log('  Enter the 6-character code shown.\n');
    code = await ask('Pairing code: ');
  }

  let token;
  try {
    const result = await redeemPairingCode(serverInfo.httpUrl, code.trim());
    token = result.token;
    console.log('\nPaired successfully!');
  } catch (e) {
    console.error(`\nPairing failed: ${e.message}`);
    if (unattended) { process.exit(1); }
    console.log('You can also enter a session token manually.');
    token = await ask('Session token (or leave empty to abort): ');
    if (!token.trim()) {
      rl.close();
      process.exit(1);
    }
    token = token.trim();
  }

  // Step 3: Node ID
  const defaultNodeId = os.hostname();
  const nodeId = unattended
    ? defaultNodeId
    : ((await ask(`\nNode ID [${defaultNodeId}]: `)).trim() || defaultNodeId);

  // Step 4: Save config
  const config = {
    server: serverInfo.wsUrl,
    token,
    nodeId,
    capabilities: [],
  };

  saveConfig(config);
  console.log(`\nConfig saved to ${CONFIG_PATH}`);
  console.log('Starting agent...\n');
  if (rl) rl.close();
  return config;
}

// ── Repair Pairing ───────────────────────────────────────────────────────────
// Re-pair an already-installed agent with a fresh pairing code without reinstalling.
// Reads the server URL from the existing config, swaps the token, restarts the service.
async function repairPairing(rawCode) {
  const code = (rawCode || '').trim();
  if (!code) {
    console.error('Usage: sudo oe repair <CODE>');
    console.error('  Generate a fresh code in the web UI (Nodes drawer → Pair New Node)');
    console.error('  or via the node_pair_code agent tool.');
    process.exit(1);
  }

  // Prefer the service's install-dir config (authoritative on a paired host);
  // fall back to the user-home config (--setup was run but not --install-service).
  const installPath = path.join(OE_INSTALL_DIR, '.oe-node', 'config.json');
  const targets = [];
  if (fs.existsSync(installPath)) targets.push(installPath);
  if (fs.existsSync(CONFIG_PATH)) targets.push(CONFIG_PATH);

  if (targets.length === 0) {
    console.error('✗ No existing agent config found.');
    console.error(`  Checked: ${installPath}`);
    console.error(`           ${CONFIG_PATH}`);
    console.error('  This node has never been paired. Run the install script instead:');
    console.error('    curl -fsSL <server>/nodes/install.sh | sh -s -- --server <server> --code <CODE>');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(targets[0], 'utf8'));
  if (!config.server) {
    console.error(`✗ Existing config at ${targets[0]} is missing "server" — cannot repair.`);
    process.exit(1);
  }

  // ws://host:port/ws/nodes → http://host:port
  const httpUrl = config.server.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws\/nodes.*$/, '');

  console.log(`\n=== OpenEnsemble Node Agent — Repair ===\n`);
  console.log(`Server:  ${httpUrl}`);
  console.log(`Config:  ${targets.join(', ')}`);
  console.log(`Node ID: ${config.nodeId || os.hostname()}\n`);
  console.log('Redeeming pairing code...');

  let result;
  try {
    result = await redeemPairingCode(httpUrl, code);
  } catch (e) {
    console.error(`✗ Pairing failed: ${e.message}`);
    console.error('  The code may be expired (10-minute TTL), already used, or the server is unreachable.');
    process.exit(1);
  }

  config.token = result.token;

  for (const target of targets) {
    try {
      fs.writeFileSync(target, JSON.stringify(config, null, 2));
      fs.chmodSync(target, 0o600);
      console.log(`✓ Updated token in ${target}`);
    } catch (e) {
      console.error(`✗ Failed to write ${target}: ${e.message}`);
      console.error('  Re-run with sudo if the file is owned by the oe-agent service user.');
      process.exit(1);
    }
  }

  // Restart the service so it reconnects with the new token.
  const platform = os.platform();
  try {
    if (platform === 'linux') {
      execSync('systemctl restart oe-node-agent', { stdio: 'inherit' });
      console.log('\n✓ Service restarted. Agent should reconnect within a few seconds.');
    } else if (platform === 'darwin') {
      execSync('launchctl kickstart -k system/com.openensemble.node-agent', { stdio: 'inherit' });
      console.log('\n✓ Service restarted. Agent should reconnect within a few seconds.');
    } else {
      console.log('\n✓ Token updated. Restart the agent to apply.');
    }
  } catch {
    console.log('\n✓ Token updated, but service restart failed.');
    console.log('  Run manually:  sudo systemctl restart oe-node-agent');
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Platform Detection ───────────────────────────────────────────────────────
function detectPlatform() {
  const platform = os.platform();
  const arch = os.arch();
  const hostname = os.hostname();

  // Detect distro
  let distro = platform;
  if (platform === 'linux') {
    try {
      const release = fs.readFileSync('/etc/os-release', 'utf8');
      const m = release.match(/^PRETTY_NAME="?(.+?)"?\s*$/m);
      distro = m ? m[1] : 'Linux';
    } catch { distro = 'Linux'; }
  } else if (platform === 'win32') {
    distro = `Windows ${os.release()}`;
  } else if (platform === 'darwin') {
    try {
      const ver = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
      distro = `macOS ${ver}`;
    } catch { distro = `macOS ${os.release()}`; }
  }

  // Detect shell
  let shell;
  if (platform === 'win32') {
    shell = 'powershell';
  } else {
    shell = process.env.SHELL || '/bin/sh';
  }

  // Detect package manager
  const packageManager = detectPackageManager(platform);

  return { platform, distro, arch, hostname, shell, packageManager };
}

function detectPackageManager(platform) {
  if (platform === 'win32') {
    if (commandExists('winget')) return 'winget';
    if (commandExists('choco'))  return 'choco';
    if (commandExists('scoop'))  return 'scoop';
    return 'winget';
  }
  if (platform === 'darwin') {
    if (commandExists('brew')) return 'brew';
    return 'unknown';
  }
  // Linux
  if (commandExists('apt'))     return 'apt';
  if (commandExists('pacman'))  return 'pacman';
  if (commandExists('dnf'))     return 'dnf';
  if (commandExists('yum'))     return 'yum';
  if (commandExists('zypper'))  return 'zypper';
  if (commandExists('apk'))     return 'apk';
  if (commandExists('nix-env')) return 'nix';
  if (commandExists('emerge'))  return 'emerge';
  return 'unknown';
}

function commandExists(cmd) {
  try {
    execSync(
      process.platform === 'win32' ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`,
      { stdio: 'ignore' }
    );
    return true;
  } catch { return false; }
}

// ── System Status ────────────────────────────────────────────────────────────
function gatherStats() {
  const result = {
    uptime: os.uptime(),
    load: os.loadavg(),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    memUsed: os.totalmem() - os.freemem(),
    cpus: os.cpus().length,
    disk: null,
  };

  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -c "Get-PSDrive -PSProvider FileSystem | Select Name,Used,Free | ConvertTo-Json"',
        { encoding: 'utf8', timeout: 5000 }
      );
      result.disk = JSON.parse(out);
    } else {
      const out = execSync('df / --output=size,used,avail,pcent 2>/dev/null | tail -1', {
        encoding: 'utf8', timeout: 5000,
      });
      const parts = out.trim().split(/\s+/);
      if (parts.length >= 4) {
        // Convert 1K-blocks to human-readable
        const toHuman = (kb) => {
          const n = parseInt(kb, 10) * 1024;
          if (n >= 1e12) return (n / 1e12).toFixed(1) + 'TB';
          if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB';
          if (n >= 1e6) return (n / 1e6).toFixed(1) + 'MB';
          return kb + 'KB';
        };
        result.disk = {
          size: toHuman(parts[0]),
          used: toHuman(parts[1]),
          avail: toHuman(parts[2]),
          pct: parts[3],
        };
      }
    }
  } catch (e) {
    // Non-critical — disk info is optional
  }

  return result;
}

function gatherFullStatus() {
  const info = detectPlatform();
  return {
    ...gatherStats(),
    hostname: info.hostname,
    platform: info.platform,
    distro: info.distro,
    arch: info.arch,
  };
}

// ── Command Execution ────────────────────────────────────────────────────────
const _activeProcs = new Map(); // cmdId → child process

function executeCommand(cmdId, command, timeout, ws) {
  const isWindows = process.platform === 'win32';
  const startTime = Date.now();

  const proc = isWindows
    ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
        timeout: timeout * 1000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      })
    : spawn('bash', ['-c', command], {
        timeout: timeout * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });

  _activeProcs.set(cmdId, proc);

  let stdout = '', stderr = '';
  let finished = false;

  // Stream partial output
  proc.stdout.on('data', (chunk) => {
    const data = chunk.toString();
    stdout += data;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmd_stream', cmdId, stream: 'stdout', data }));
    }
  });

  proc.stderr.on('data', (chunk) => {
    const data = chunk.toString();
    stderr += data;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmd_stream', cmdId, stream: 'stderr', data }));
    }
  });

  // Hard kill if process doesn't exit after timeout + grace period
  const hardKillTimer = setTimeout(() => {
    if (!finished) {
      try { proc.kill('SIGKILL'); } catch {}
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'cmd_result', cmdId,
          stdout: stdout.slice(0, 10 * 1024 * 1024),
          stderr: `Process killed: exceeded ${timeout}s timeout`,
          exitCode: 137,
          duration: Date.now() - startTime,
        }));
      }
      _activeProcs.delete(cmdId);
      finished = true;
    }
  }, (timeout + 5) * 1000);

  proc.on('close', (exitCode) => {
    if (finished) return;
    finished = true;
    clearTimeout(hardKillTimer);
    _activeProcs.delete(cmdId);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'cmd_result', cmdId,
        stdout: stdout.slice(0, 10 * 1024 * 1024),
        stderr: stderr.slice(0, 10 * 1024 * 1024),
        exitCode: exitCode ?? 1,
        duration: Date.now() - startTime,
      }));
    }
  });

  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(hardKillTimer);
    _activeProcs.delete(cmdId);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'cmd_result', cmdId,
        stdout,
        stderr: err.message,
        exitCode: 1,
        duration: Date.now() - startTime,
      }));
    }
  });
}

// ── PTY Sessions ────────────────────────────────────────────────────────────
const _activePtys = new Map(); // ptyId → { proc, ws }
const MAX_PTYS = 5;

function startPty(ptyId, cols, rows, ws) {
  if (_activePtys.size >= MAX_PTYS) {
    ws.send(JSON.stringify({ type: 'pty_error', ptyId, message: `Max PTY limit (${MAX_PTYS}) reached` }));
    return;
  }

  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const shellArgs = isWindows ? ['-NoLogo'] : [];

  const proc = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.HOME || process.env.USERPROFILE || '/',
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  _activePtys.set(ptyId, { proc, ws });

  proc.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pty_output', ptyId, data }));
    }
  });

  proc.onExit(({ exitCode }) => {
    _activePtys.delete(ptyId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pty_exit', ptyId, exitCode }));
    }
    log(`PTY ${ptyId} exited (code ${exitCode})`);
  });

  log(`PTY ${ptyId} started (${shell}, ${cols}x${rows})`);
  ws.send(JSON.stringify({ type: 'pty_started', ptyId }));
}

function writePty(ptyId, data) {
  const session = _activePtys.get(ptyId);
  if (session) session.proc.write(data);
}

function resizePty(ptyId, cols, rows) {
  const session = _activePtys.get(ptyId);
  if (session) session.proc.resize(cols, rows);
}

function killPty(ptyId) {
  const session = _activePtys.get(ptyId);
  if (!session) return;
  try { session.proc.kill(); } catch {}
  _activePtys.delete(ptyId);
  log(`PTY ${ptyId} killed`);
}

function killAllPtys() {
  for (const [ptyId, session] of _activePtys) {
    try { session.proc.kill(); } catch {}
  }
  _activePtys.clear();
}

// ── WebSocket Connection ─────────────────────────────────────────────────────
const RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30, 60]; // seconds

function runAgent(config) {
  return new Promise((resolve, reject) => {
    const info = detectPlatform();
    const serverUrl = `${config.server}?token=${config.token}`;

    log(`Connecting to ${config.server.replace(/\?.*/, '')}...`);

    let ws;
    try {
      // handshakeTimeout prevents the constructor from parking forever if the
      // TCP connect succeeds but the upgrade handshake never completes.
      ws = new WebSocket(serverUrl, { handshakeTimeout: 15000 });
    } catch (e) {
      return reject(e);
    }

    let registered = false;
    let pingTimer = null;
    let livenessTimer = null;
    let lastActivity = Date.now();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (pingTimer)     { clearInterval(pingTimer);     pingTimer = null; }
      if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null; }
      try { ws.terminate(); } catch {}
      resolve();
    };

    // Application-level liveness watchdog. If we haven't seen any server
    // activity (message or pong) in 90s, treat the socket as dead and tear
    // it down. Catches half-open TCP sockets where neither `close` nor
    // `error` ever fire — e.g. when OE is restarted abruptly mid-frame.
    livenessTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle > 90000) {
        log(`No server activity for ${Math.round(idle/1000)}s — terminating stale socket`);
        settle();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, 30000);

    ws.on('open', () => {
      lastActivity = Date.now();
      log('Connected. Registering...');
      ws.send(JSON.stringify({
        type: 'register',
        hostname: info.hostname,
        platform: info.platform,
        distro: info.distro,
        arch: info.arch,
        shell: info.shell,
        packageManager: info.packageManager,
        nodeId: config.nodeId || info.hostname,
        capabilities: config.capabilities || [],
        accessLevel: config.accessLevel || 'unknown',
        accessLocked: !!config.accessLocked,
        version: AGENT_VERSION,
      }));
    });

    ws.on('message', (raw) => {
      lastActivity = Date.now();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case 'registered':
          registered = true;
          log(`Registered as ${msg.nodeId}`);

          // Systemd watchdog support
          notifyWatchdog();
          pingTimer = setInterval(notifyWatchdog, 60000);
          break;

        case 'revoked':
          log(`Server revoked this node: ${msg.message || 'removed by user'}`);
          log('Exiting. Run "sudo oe uninstall" to clean up, or "sudo oe setup" to re-pair.');
          try { ws.close(1000, 'Revoked'); } catch {}
          process.exit(0);
          break;

        case 'update':
          handleUpdateMessage(msg, ws, config).catch(e => {
            log(`[update] failed: ${e.message}`);
            try { ws.send(JSON.stringify({ type: 'update_result', ok: false, error: e.message })); } catch {}
          });
          break;

        case 'uninstall':
          log(`Server requested uninstall: ${msg.message || ''}`);
          try { ws.send(JSON.stringify({ type: 'uninstall_ack' })); } catch {}
          try { ws.close(1000, 'Uninstalling'); } catch {}
          // Fire off the self-destruct script (installed by installService, root-owned,
          // runnable via NOPASSWD sudo). It stops the service, removes the user,
          // wipes /opt/oe-node-agent, and deletes itself — all after we exit.
          try {
            const self = '/opt/oe-node-agent/self-destruct.sh';
            if (fs.existsSync(self)) {
              const child = spawn('sudo', ['-n', self], { detached: true, stdio: 'ignore' });
              child.unref();
              log('Self-destruct launched. Exiting.');
            } else {
              log(`Self-destruct script not found at ${self}. Cannot auto-uninstall.`);
            }
          } catch (e) {
            log(`[uninstall] spawn failed: ${e.message}`);
          }
          setTimeout(() => process.exit(0), 300);
          break;

        case 'exec':
          log(`Exec [${msg.cmdId}]: ${msg.command.slice(0, 100)}${msg.command.length > 100 ? '...' : ''}`);
          executeCommand(msg.cmdId, msg.command, msg.timeout || 60, ws);
          break;

        case 'push_tar':
          handlePushTar(msg, ws).catch(e => {
            log(`[push_tar] failed: ${e.message}`);
            try {
              ws.send(JSON.stringify({
                type: 'cmd_result', cmdId: msg.cmdId,
                stdout: '', stderr: `push_tar failed: ${e.message}`,
                exitCode: 1, duration: 0,
              }));
            } catch {}
          });
          break;

        case 'status':
          log(`Status request [${msg.cmdId}]`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'status_result',
              cmdId: msg.cmdId,
              ...gatherFullStatus(),
            }));
          }
          break;

        case 'ping':
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', stats: gatherStats() }));
          }
          break;

        case 'pty_start':
          startPty(msg.ptyId, msg.cols, msg.rows, ws);
          break;

        case 'pty_input':
          writePty(msg.ptyId, msg.data);
          break;

        case 'pty_resize':
          resizePty(msg.ptyId, msg.cols, msg.rows);
          break;

        case 'pty_kill':
          killPty(msg.ptyId);
          break;

        case 'error':
          log(`Server error: ${msg.message}`);
          break;

        default:
          log(`Unknown message type: ${msg.type}`);
      }
    });

    ws.on('close', (code, reason) => {
      registered = false;
      killAllPtys();
      log(`Disconnected (${code}${reason ? ': ' + reason : ''})`);
      settle();
    });

    ws.on('error', (err) => {
      log(`WebSocket error: ${err.message}`);
      // Don't trust `close` to always follow `error` — for some half-open
      // socket failures only one of the two fires. Settle here too;
      // settle() is idempotent so a later close is a no-op.
      settle();
    });

    ws.on('pong', () => { lastActivity = Date.now(); });
  });
}

// ── Handle the status command differently ────────────────────────────────────
// The registry sends { type: 'status', cmdId } and expects a cmd_result back.
// We override the response to include full status info. The registry will see
// it as a cmd_result and resolve the Promise. The skill executor interprets the
// extra fields (platform, distro, etc.) from the result.

// ── Systemd Watchdog ─────────────────────────────────────────────────────────
// Best-effort sd_notify via the systemd-notify CLI. Only fires if NOTIFY_SOCKET
// is set by systemd AND the unit file has WatchdogSec= set. With our default
// template (no WatchdogSec), this is a no-op.
function notifyWatchdog() {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    execSync('systemd-notify WATCHDOG=1', { stdio: 'ignore', timeout: 2000 });
  } catch { /* systemd-notify not available or unit has no watchdog — ignore */ }
}

// ── Service Installation ─────────────────────────────────────────────────────
const OE_USER = 'oe-agent';
const OE_INSTALL_DIR = '/opt/oe-node-agent';
const OE_SUDOERS_PATH = `/etc/sudoers.d/${OE_USER}`;

const ACCESS_LEVELS = {
  updates:    { label: 'Updates Only',  desc: 'package manager + reboot/shutdown' },
  sysadmin:   { label: 'System Admin',  desc: 'updates + systemctl, journalctl, docker, networking, users' },
  monitoring: { label: 'Monitoring',    desc: 'read-only system commands (no installs, no reboot)' },
  full:       { label: 'Full Access',   desc: 'unrestricted sudo (NOPASSWD: ALL)' },
  nosudo:     { label: 'No Sudo',       desc: 'no sudo access (monitoring via OS APIs only)' },
};

function whichOrNull(cmd) {
  try { return execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// Always-on sudoers rules — lets oe-agent run its own --change-access and
// restart its own service. Without this, the "click access badge" UI can't
// work because the terminal PTY runs as oe-agent which has no password.
function buildSelfSudoersLines() {
  const nodePath = process.execPath || whichOrNull('node') || '/usr/bin/node';
  const agentPath = `${OE_INSTALL_DIR}/oe-node-agent.mjs`;
  const systemctl = whichOrNull('systemctl') || '/usr/bin/systemctl';
  return [
    `${OE_USER} ALL=(ALL) NOPASSWD: ${nodePath} ${agentPath} --change-access`,
    `${OE_USER} ALL=(ALL) NOPASSWD: ${systemctl} restart oe-node-agent`,
    `${OE_USER} ALL=(ALL) NOPASSWD: ${systemctl} restart oe-node-agent.service`,
  ];
}

function buildSudoersLine(level) {
  if (level === 'full') return `${OE_USER} ALL=(ALL) NOPASSWD: ALL`;
  if (level === 'nosudo') return null;

  const pkgMgrs = ['apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'snap', 'flatpak'];
  const rebootCmds = ['reboot', 'shutdown'];
  const sysadminCmds = ['systemctl', 'journalctl', 'mount', 'umount', 'ip', 'iptables', 'ss',
    'docker', 'crontab', 'kill', 'killall', 'chown', 'chmod', 'useradd', 'usermod', 'groupadd',
    'pihole', 'ufw', 'fail2ban-client', 'nft', 'firewall-cmd', 'wg', 'wg-quick', 'tailscale'];
  const monitorCmds = ['journalctl', 'ss', 'df', 'du', 'free', 'top', 'htop', 'lsblk', 'lscpu',
    'dmidecode', 'fdisk', 'docker'];

  let cmds = [];
  if (level === 'updates') {
    cmds = [...pkgMgrs, ...rebootCmds];
  } else if (level === 'sysadmin') {
    cmds = [...pkgMgrs, ...rebootCmds, ...sysadminCmds];
  } else if (level === 'monitoring') {
    cmds = monitorCmds;
  }

  // Resolve to actual paths on this system
  const paths = cmds.map(c => whichOrNull(c)).filter(Boolean);
  if (!paths.length) return null;

  return `${OE_USER} ALL=(ALL) NOPASSWD: ${paths.join(', ')}`;
}

// Writes the systemd unit (Linux) or launchd plist (macOS) for the node agent.
// For accessLevel==="full" the service runs as root — Proxmox `pct`/`qm` and
// similar admin tooling need to read /etc/pve/priv/* which is unreadable by
// the unprivileged `oe-agent` user even with NOPASSWD sudo, because commands
// run by the agent are not wrapped in sudo. "full" is meant to give the agent
// unrestricted host control, so root is the honest implementation.
function writeServiceUnit(platform, accessLevel) {
  const nodePath = process.execPath;
  const runAsRoot = accessLevel === 'full';

  if (platform === 'linux') {
    const userLines = runAsRoot
      ? 'User=root\nGroup=root'
      : `User=${OE_USER}\nGroup=${OE_USER}`;
    const unit = `[Unit]
Description=OpenEnsemble Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLines}
ExecStart=${nodePath} ${OE_INSTALL_DIR}/oe-node-agent.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=${OE_INSTALL_DIR}
WorkingDirectory=${OE_INSTALL_DIR}

[Install]
WantedBy=multi-user.target
`;
    const unitPath = '/etc/systemd/system/oe-node-agent.service';
    fs.writeFileSync(unitPath, unit);
    log(`Wrote ${unitPath}${runAsRoot ? ' (running as root — full access)' : ''}`);
    execSync('systemctl daemon-reload');
    execSync('systemctl enable oe-node-agent');
    execSync('systemctl restart oe-node-agent');
    log('Service (re)started.');
  } else if (platform === 'darwin') {
    // LaunchDaemons run as root by default; omit UserName for "full".
    const userBlock = runAsRoot ? '' : `  <key>UserName</key>\n  <string>${OE_USER}</string>\n`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openensemble.node-agent</string>
${userBlock}  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${OE_INSTALL_DIR}/oe-node-agent.mjs</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>WorkingDirectory</key>
  <string>${OE_INSTALL_DIR}</string>
  <key>StandardOutPath</key>
  <string>${OE_INSTALL_DIR}/agent.log</string>
  <key>StandardErrorPath</key>
  <string>${OE_INSTALL_DIR}/agent.log</string>
</dict>
</plist>
`;
    const plistPath = '/Library/LaunchDaemons/com.openensemble.node-agent.plist';
    fs.writeFileSync(plistPath, plist);
    try { execSync(`launchctl unload ${plistPath}`, { stdio: 'ignore' }); } catch {}
    execSync(`launchctl load ${plistPath}`);
    log(`Installed LaunchDaemon: ${plistPath}${runAsRoot ? ' (running as root — full access)' : ''}`);
  }
}

async function installService() {
  const platform = process.platform;

  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    log(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  // Root check (Linux/macOS)
  if (platform !== 'win32' && process.getuid() !== 0) {
    console.error('This command must be run with sudo:\n  sudo oe install-service');
    process.exit(1);
  }

  if (platform === 'win32') {
    // Windows: keep simple — LocalSystem has full access, no sudo concept
    const nodePath = process.execPath;
    const agentPath = __filename;
    try {
      execSync(`sc create "OENodeAgent" binPath= "${nodePath} ${agentPath}" start= auto DisplayName= "OpenEnsemble Node Agent"`, { stdio: 'inherit' });
      execSync('sc start OENodeAgent', { stdio: 'inherit' });
      // Save access level to config
      const config = loadConfig() || {};
      config.accessLevel = 'full';
      saveConfig(config);
      log('Windows service installed and started.');
    } catch (e) {
      log(`Failed to install service: ${e.message}`);
      log('Try running as Administrator.');
    }
    return;
  }

  // ── Linux / macOS ──

  // Unattended mode: OE_AGENT_UNATTENDED=1 (set by install.sh when --code was
  // passed) means skip all service-install prompts and use safe defaults:
  // access level = "updates" (matches interactive default), access locked = true.
  // Override with OE_AGENT_ACCESS_LEVEL / OE_AGENT_ACCESS_LOCKED.
  const unattended = process.env.OE_AGENT_UNATTENDED === '1' || (process.env.OE_PAIRING_CODE || '').trim().length > 0;

  const rl = unattended ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = unattended
    ? async () => ''
    : (q) => new Promise(r => rl.question(q, r));

  console.log('\n=== OpenEnsemble Node Agent — Service Install ===\n');
  if (unattended) console.log('(Unattended mode — using default access level "updates", locked)\n');

  // Step 1: Select access level
  const keys = Object.keys(ACCESS_LEVELS);
  let accessLevel;
  if (unattended) {
    const envLevel = (process.env.OE_AGENT_ACCESS_LEVEL || '').trim().toLowerCase();
    accessLevel = keys.includes(envLevel) ? envLevel : 'updates';
  } else {
    console.log('Select sudo access level for the oe-agent account:\n');
    keys.forEach((k, i) => {
      const lv = ACCESS_LEVELS[k];
      console.log(`  [${i + 1}] ${lv.label.padEnd(16)} — ${lv.desc}`);
    });
    console.log('');
    const choice = (await ask('Choice (1-5) [1]: ')).trim() || '1';
    const idx = parseInt(choice, 10) - 1;
    accessLevel = keys[idx] || 'updates';
  }
  const levelInfo = ACCESS_LEVELS[accessLevel];
  console.log(`\n→ Selected: ${levelInfo.label}`);

  // Step 1b: Ask about locking the access level
  let accessLocked;
  if (unattended) {
    const envLocked = (process.env.OE_AGENT_ACCESS_LOCKED || '').trim().toLowerCase();
    // Default to locked (true) unless explicitly set to '0'/'false'/'no'
    accessLocked = !(envLocked === '0' || envLocked === 'false' || envLocked === 'no');
  } else {
    console.log('\nAllow the agent to change its own access level from the web UI?');
    console.log('  [Y] Yes — convenient, but lets anything running as oe-agent escalate to Full Access');
    console.log('  [N] No  — strict: access level can only be changed by SSH login with real sudo');
    const lockAnswer = (await ask('Allow self-management? [y/N]: ')).trim().toLowerCase();
    accessLocked = !(lockAnswer === 'y' || lockAnswer === 'yes');
  }
  console.log(accessLocked
    ? '→ Locked: access level changes require SSH + sudo (recommended for security-sensitive nodes)'
    : '→ Unlocked: access level can be changed from the web UI (convenient default)');

  // Step 2: Create system user
  try {
    execSync(`id ${OE_USER} 2>/dev/null`, { stdio: 'ignore' });
    log(`User ${OE_USER} already exists`);
  } catch {
    if (platform === 'linux') {
      execSync(`useradd --system --shell /usr/sbin/nologin --home-dir ${OE_INSTALL_DIR} --create-home ${OE_USER}`);
    } else {
      // macOS
      execSync(`dscl . -create /Users/${OE_USER}`);
      execSync(`dscl . -create /Users/${OE_USER} UserShell /usr/bin/false`);
      execSync(`dscl . -create /Users/${OE_USER} NFSHomeDirectory ${OE_INSTALL_DIR}`);
      if (!fs.existsSync(OE_INSTALL_DIR)) fs.mkdirSync(OE_INSTALL_DIR, { recursive: true });
    }
    log(`Created system user: ${OE_USER}`);
  }

  // Step 3: Copy agent files to install dir
  if (!fs.existsSync(OE_INSTALL_DIR)) fs.mkdirSync(OE_INSTALL_DIR, { recursive: true });

  // Copy agent script
  fs.copyFileSync(__filename, path.join(OE_INSTALL_DIR, 'oe-node-agent.mjs'));

  // Copy node_modules
  const srcModules = path.join(__dirname, 'node_modules');
  if (fs.existsSync(srcModules)) {
    execSync(`cp -r "${srcModules}" "${OE_INSTALL_DIR}/"`, { stdio: 'ignore' });
  }

  // Copy package.json
  const srcPkg = path.join(__dirname, 'package.json');
  if (fs.existsSync(srcPkg)) {
    fs.copyFileSync(srcPkg, path.join(OE_INSTALL_DIR, 'package.json'));
  }

  // Copy config from installer's home
  const installerConfig = loadConfig();
  if (installerConfig) {
    const oeConfigDir = path.join(OE_INSTALL_DIR, '.oe-node');
    if (!fs.existsSync(oeConfigDir)) fs.mkdirSync(oeConfigDir, { recursive: true });
    installerConfig.accessLevel = accessLevel;
    installerConfig.accessLocked = accessLocked;
    fs.writeFileSync(path.join(oeConfigDir, 'config.json'), JSON.stringify(installerConfig, null, 2));
    try { fs.chmodSync(path.join(oeConfigDir, 'config.json'), 0o600); } catch {}
    log(`Config copied to ${oeConfigDir}/config.json`);
  } else {
    console.warn('Warning: No config.json found. Run "sudo oe setup" first, then "sudo oe install-service".');
  }

  // Set ownership
  execSync(`chown -R ${OE_USER}:${OE_USER} ${OE_INSTALL_DIR}`);

  // Step 4: Write sudoers
  const sudoersLine = buildSudoersLine(accessLevel);
  // Write the self-destruct script (root-owned, chmod 500) so the agent can
  // uninstall itself when the user clicks Remove in the UI. Always present
  // regardless of access lock — remote uninstall is a core admin action.
  const selfDestructPath = `${OE_INSTALL_DIR}/self-destruct.sh`;
  const selfDestruct = `#!/usr/bin/env bash
# OpenEnsemble Node Agent — self-destruct (invoked via NOPASSWD sudo)
set +e
sleep 2
systemctl stop oe-node-agent
systemctl disable oe-node-agent
rm -f /etc/systemd/system/oe-node-agent.service
systemctl daemon-reload
rm -f ${OE_SUDOERS_PATH}
userdel -r ${OE_USER} 2>/dev/null
rm -f /usr/local/bin/oe /usr/local/bin/openensemble
rm -rf ${OE_INSTALL_DIR}
logger -t oe-node-agent "Self-destruct complete"
`;
  fs.writeFileSync(selfDestructPath, selfDestruct);
  execSync(`chown root:root ${selfDestructPath}`);
  execSync(`chmod 500 ${selfDestructPath}`);

  const header = `# OpenEnsemble Node Agent — access level: ${accessLevel}${accessLocked ? ' (LOCKED)' : ''}\n`;
  // Always allow the agent to run the self-destruct script — needed for UI-driven remove
  const selfDestructLine = `${OE_USER} ALL=(ALL) NOPASSWD: ${selfDestructPath}`;
  let selfBlock = `\n# Remote uninstall: agent can invoke self-destruct on UI Remove\n${selfDestructLine}\n`;
  if (!accessLocked) {
    const selfLines = buildSelfSudoersLines();
    selfBlock += `\n# Self-management: allows oe-agent to change its own access level from the UI\n${selfLines.join('\n')}\n`;
  } else {
    selfBlock += `\n# Access level LOCKED — self-management disabled. To change: SSH in and edit this file + re-run "sudo oe install-service"\n`;
  }
  const sudoersContent = header + (sudoersLine ? sudoersLine + '\n' : '') + selfBlock;
  fs.writeFileSync(OE_SUDOERS_PATH, sudoersContent);
  fs.chmodSync(OE_SUDOERS_PATH, 0o440);
  try {
    execSync(`visudo -cf ${OE_SUDOERS_PATH}`, { stdio: 'ignore' });
    log(`Sudoers written to ${OE_SUDOERS_PATH} (${levelInfo.label})`);
  } catch {
    fs.unlinkSync(OE_SUDOERS_PATH);
    console.error('ERROR: sudoers validation failed! File removed. Check paths manually.');
    if (rl) rl.close();
    process.exit(1);
  }

  // Also save access level to the installer's config for the register message
  if (installerConfig) {
    installerConfig.accessLevel = accessLevel;
    installerConfig.accessLocked = accessLocked;
    saveConfig(installerConfig);
  }

  // Step 5: Write systemd unit / launchd plist
  writeServiceUnit(platform, accessLevel);

  // Step 6: Install the `oe` CLI wrapper (Linux + macOS)
  installCliWrapper();

  console.log(`\n✓ Service installed as ${OE_USER} with ${levelInfo.label} access`);
  console.log(`  Install dir: ${OE_INSTALL_DIR}`);
  if (sudoersLine) console.log(`  Sudoers:     ${OE_SUDOERS_PATH}`);
  console.log(`  Admin CLI:   oe  (try 'oe help')`);
  console.log('');
  if (rl) rl.close();
}

// Install /usr/local/bin/oe and remove the legacy /usr/local/bin/openensemble.
// Called from installService() at install time and from updateAgent() to migrate
// already-paired nodes onto the new wrapper name.
function installCliWrapper() {
  const platform = os.platform();
  if (platform !== 'linux' && platform !== 'darwin') return;
  const nodePath = process.execPath || whichOrNull('node') || '/usr/bin/node';
  const wrapperPath = '/usr/local/bin/oe';
  const legacyWrapperPath = '/usr/local/bin/openensemble';
  const wrapper = `#!/usr/bin/env bash
# OpenEnsemble Node Agent — admin CLI
# Read-only commands run as the current user; everything else auto-elevates.

case "\${1:-}" in
  status|logs|help|--help|-h|discover|version|--version|-v)
    ;;
  *)
    # Bare "oe" lands here too — menu needs root, so elevate.
    if [ "$(id -u)" -ne 0 ]; then exec sudo "$0" "$@"; fi
    ;;
esac

# Bare "oe" → interactive config menu
if [ $# -eq 0 ]; then set -- menu; fi

exec ${nodePath} ${OE_INSTALL_DIR}/oe-node-agent.mjs "$@"
`;
  try {
    fs.writeFileSync(wrapperPath, wrapper);
    fs.chmodSync(wrapperPath, 0o755);
    log(`Installed CLI: ${wrapperPath}`);
  } catch (e) {
    console.warn(`Warning: could not install ${wrapperPath}: ${e.message}`);
    return;
  }
  if (fs.existsSync(legacyWrapperPath)) {
    try { fs.unlinkSync(legacyWrapperPath); log(`Removed legacy ${legacyWrapperPath}`); } catch {}
  }
}

function uninstallService() {
  const platform = process.platform;

  if (platform !== 'win32' && process.getuid() !== 0) {
    console.error('This command must be run with sudo:\n  sudo oe uninstall');
    process.exit(1);
  }

  if (platform === 'linux') {
    try { execSync('systemctl stop oe-node-agent', { stdio: 'inherit' }); } catch {}
    try { execSync('systemctl disable oe-node-agent', { stdio: 'inherit' }); } catch {}
    try { fs.unlinkSync('/etc/systemd/system/oe-node-agent.service'); } catch {}
    try { execSync('systemctl daemon-reload'); } catch {}
    try { fs.unlinkSync(OE_SUDOERS_PATH); log(`Removed ${OE_SUDOERS_PATH}`); } catch {}
    try { execSync(`userdel -r ${OE_USER} 2>/dev/null`, { stdio: 'ignore' }); log(`Removed user ${OE_USER}`); } catch {}
    try { execSync(`rm -rf ${OE_INSTALL_DIR}`, { stdio: 'ignore' }); log(`Removed ${OE_INSTALL_DIR}`); } catch {}
    try { fs.unlinkSync('/usr/local/bin/oe'); log('Removed /usr/local/bin/oe'); } catch {}
    try { fs.unlinkSync('/usr/local/bin/openensemble'); log('Removed legacy /usr/local/bin/openensemble'); } catch {}
    log('Service fully removed.');
  } else if (platform === 'darwin') {
    const plistPath = '/Library/LaunchDaemons/com.openensemble.node-agent.plist';
    try { execSync(`launchctl unload ${plistPath}`); } catch {}
    try { fs.unlinkSync(plistPath); } catch {}
    try { fs.unlinkSync(OE_SUDOERS_PATH); } catch {}
    try { execSync(`dscl . -delete /Users/${OE_USER}`); } catch {}
    try { execSync(`rm -rf ${OE_INSTALL_DIR}`, { stdio: 'ignore' }); } catch {}
    try { fs.unlinkSync('/usr/local/bin/oe'); } catch {}
    try { fs.unlinkSync('/usr/local/bin/openensemble'); } catch {}
    log('Service fully removed.');
  } else if (platform === 'win32') {
    try { execSync('sc stop OENodeAgent', { stdio: 'inherit' }); } catch {}
    try { execSync('sc delete OENodeAgent', { stdio: 'inherit' }); } catch {}
    log('Windows service removed.');
  }
}

// ── Server-pushed update (triggered by 'update' WS message) ─────────────────
// Receive a base64-encoded tar.gz from the server and extract it into destPath.
// Writes the payload to a temp file, invokes `tar xzf`, and returns a cmd_result
// so it plugs into the same pending-command plumbing as exec/status.
async function handlePushTar(msg, ws) {
  const { cmdId, destPath, data, clean } = msg;
  if (!cmdId)    throw new Error('missing cmdId');
  if (!destPath) throw new Error('missing destPath');
  if (!data)     throw new Error('missing data');
  if (typeof destPath !== 'string' || !path.isAbsolute(destPath)) {
    throw new Error('destPath must be absolute');
  }
  const start = Date.now();

  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('decoded payload is empty');

  fs.mkdirSync(destPath, { recursive: true });
  if (clean) {
    for (const entry of fs.readdirSync(destPath)) {
      try { fs.rmSync(path.join(destPath, entry), { recursive: true, force: true }); } catch {}
    }
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `oe-push-${cmdId}.tar.gz`);
  fs.writeFileSync(tmpFile, buf);

  const isWindows = process.platform === 'win32';
  const tarBin = isWindows ? 'tar.exe' : 'tar'; // Windows 10+ ships tar.exe

  const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
    const proc = spawn(tarBin, ['xzf', tmpFile, '-C', destPath]);
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });
    proc.on('error', reject);
    proc.on('close', code => resolve({ stdout: out, stderr: err, exitCode: code ?? 1 }));
  });

  try { fs.unlinkSync(tmpFile); } catch {}

  // Best-effort file count for the summary.
  let fileCount = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else fileCount++;
      }
    };
    walk(destPath);
  } catch {}

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'cmd_result', cmdId,
      stdout: exitCode === 0
        ? `Extracted ${buf.length} bytes into ${destPath} (${fileCount} files)${stdout ? '\n' + stdout : ''}`
        : stdout,
      stderr,
      exitCode,
      duration: Date.now() - start,
    }));
  }
}

async function handleUpdateMessage(msg, ws, config) {
  log('[update] Server requested update — downloading...');

  // Build http URL from ws:// server
  const m = (config?.server || '').match(/^wss?:\/\/([^/:]+)(?::(\d+))?/);
  if (!m) throw new Error(`Cannot parse server URL: ${config?.server}`);
  const httpUrl = msg.url || `http://${m[1]}:${m[2] || '3737'}/nodes/agent`;

  // Determine where to write. Service install runs from /opt/oe-node-agent;
  // manual runs live wherever __filename points.
  const dest = __filename;
  const tmp = `${dest}.new`;

  // Download via https/http (avoid depending on curl being present)
  const { default: http } = await import(httpUrl.startsWith('https') ? 'https' : 'http');
  await new Promise((resolve, reject) => {
    const req = http.get(httpUrl, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('download timed out')));
  });

  const size = fs.statSync(tmp).size;
  if (size < 5000) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`downloaded file looks wrong (${size} bytes)`);
  }

  // Basic sanity check — must be a JS file starting with a shebang or /**
  const head = fs.readFileSync(tmp, 'utf8').slice(0, 200);
  if (!head.includes('OpenEnsemble') && !head.includes('import')) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('downloaded file does not look like the agent');
  }

  fs.renameSync(tmp, dest);
  log(`[update] Wrote ${dest} (${size} bytes). ACKing and exiting for restart...`);

  // Refresh the /usr/local/bin/oe wrapper from the *currently-running* code.
  // The wrapper was added later than the auto-update flow, so older nodes that
  // got the .mjs via push-update were never migrated off the legacy
  // /usr/local/bin/openensemble name. Best-effort: writes need root, the
  // function may be absent on very old agents — both cases are caught.
  try {
    if (typeof installCliWrapper === 'function') installCliWrapper();
  } catch (e) {
    log(`[update] wrapper refresh skipped: ${e.message}`);
  }

  try { ws.send(JSON.stringify({ type: 'update_result', ok: true, size })); } catch {}

  // Give the ACK a moment to flush, then exit. systemd's Restart=always will
  // relaunch us with the new code.
  setTimeout(() => {
    try { ws.close(1000, 'Updating'); } catch {}
    process.exit(0);
  }, 500);
}

// ── Update (re-download agent from paired server) ─────────────────────────────
async function updateAgent() {
  if (process.platform === 'win32') {
    console.log('Auto-update not supported on Windows yet. Re-run the installer manually.');
    return;
  }
  if (process.getuid() !== 0) {
    console.error('This command must be run with sudo.');
    return;
  }

  const config = loadConfig() || (() => {
    // When run from the menu as root, config might be at /opt/oe-node-agent/.oe-node/config.json
    const alt = path.join(OE_INSTALL_DIR, '.oe-node', 'config.json');
    if (fs.existsSync(alt)) return JSON.parse(fs.readFileSync(alt, 'utf8'));
    return null;
  })();
  if (!config || !config.server) {
    console.error('No config found — cannot determine server URL.');
    return;
  }

  // ws://host:port/ws/nodes → http://host:port/nodes/agent
  const m = config.server.match(/^wss?:\/\/([^/:]+)(?::(\d+))?/);
  if (!m) { console.error(`Could not parse server URL: ${config.server}`); return; }
  const httpUrl = `http://${m[1]}:${m[2] || '3737'}/nodes/agent`;

  const dest = path.join(OE_INSTALL_DIR, 'oe-node-agent.mjs');
  const tmp = `${dest}.new`;
  console.log(`Downloading latest agent from ${httpUrl}...`);
  try {
    execSync(`curl -fsSL "${httpUrl}" -o "${tmp}"`, { stdio: 'inherit' });
  } catch {
    try { execSync(`wget -q "${httpUrl}" -O "${tmp}"`, { stdio: 'inherit' }); }
    catch { console.error('Download failed (neither curl nor wget worked).'); return; }
  }
  const size = fs.statSync(tmp).size;
  if (size < 1000) { console.error(`Downloaded file looks wrong (${size} bytes). Aborting.`); try { fs.unlinkSync(tmp); } catch {} return; }

  fs.renameSync(tmp, dest);
  try { execSync(`chown ${OE_USER}:${OE_USER} ${dest}`); } catch {}
  console.log(`Updated ${dest} (${size} bytes).`);
  // Refresh the CLI wrapper so pre-rename installs (that have
  // /usr/local/bin/openensemble) migrate to /usr/local/bin/oe on update.
  installCliWrapper();
  console.log('Restarting service...');
  try { execSync('systemctl restart oe-node-agent', { stdio: 'inherit' }); }
  catch { console.error('Service restart failed. Check: systemctl status oe-node-agent'); return; }
  console.log('Update complete.');
}

// ── Interactive config menu ───────────────────────────────────────────────────
async function configMenu() {
  if (process.platform === 'win32') {
    console.log('Config menu is not available on Windows. Use services.msc / sc.exe.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  while (true) {
    console.log('\n=== OpenEnsemble Node Agent — Config Menu ===\n');
    console.log('  [1] Change access level');
    console.log('  [2] Update agent (re-download from server)');
    console.log('  [3] Service status');
    console.log('  [4] Tail service logs');
    console.log('  [5] Restart service');
    console.log('  [6] Show config');
    console.log('  [7] Uninstall service');
    console.log('  [q] Quit\n');
    const choice = (await ask('Choice: ')).trim().toLowerCase();

    try {
      if (choice === '1') {
        rl.close();
        await changeAccess();
        return;
      } else if (choice === '2') {
        await updateAgent();
      } else if (choice === '3') {
        try { execSync('systemctl status oe-node-agent --no-pager', { stdio: 'inherit' }); } catch {}
      } else if (choice === '4') {
        console.log('Press Ctrl-C to stop tailing logs.\n');
        try { execSync('journalctl -u oe-node-agent -n 50 -f', { stdio: 'inherit' }); } catch {}
      } else if (choice === '5') {
        try { execSync('systemctl restart oe-node-agent', { stdio: 'inherit' }); console.log('Service restarted.'); } catch (e) { console.error(e.message); }
      } else if (choice === '6') {
        const paths = [CONFIG_PATH, path.join(OE_INSTALL_DIR, '.oe-node', 'config.json')];
        for (const p of paths) {
          if (fs.existsSync(p)) {
            console.log(`\n--- ${p} ---`);
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            // Redact the token
            if (cfg.token) cfg.token = cfg.token.slice(0, 6) + '…(redacted)';
            console.log(JSON.stringify(cfg, null, 2));
            break;
          }
        }
      } else if (choice === '7') {
        const confirm = (await ask('Uninstall the service and remove all files? [y/N]: ')).trim().toLowerCase();
        if (confirm === 'y' || confirm === 'yes') {
          rl.close();
          uninstallService();
          return;
        }
      } else if (choice === 'q' || choice === 'quit' || choice === 'exit') {
        rl.close();
        return;
      } else {
        console.log('Unknown choice.');
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
    }
  }
}

async function changeAccess() {
  const platform = process.platform;

  if (platform === 'win32') {
    console.log('Windows services run as LocalSystem with full access. No access levels to change.');
    process.exit(0);
  }

  if (process.getuid() !== 0) {
    console.error('This command must be run with sudo:\n  sudo oe change-access');
    process.exit(1);
  }

  // Load current config to show current level
  const configPath = path.join(OE_INSTALL_DIR, '.oe-node', 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  const currentLevel = config.accessLevel || 'unknown';
  const currentInfo = ACCESS_LEVELS[currentLevel];

  // If access is locked and this wasn't invoked with --force, refuse
  const forceFlag = process.argv.includes('--force');
  if (config.accessLocked && !forceFlag) {
    console.error('\n✗ Access level is LOCKED on this node.');
    console.error('  Self-management via the web UI is disabled.');
    console.error('  To unlock: SSH in as a real admin and run:');
    console.error(`    sudo oe change-access --force\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log('\n=== OpenEnsemble Node Agent — Change Access Level ===\n');
  console.log(`Current level: ${currentInfo ? currentInfo.label : currentLevel}`);
  console.log(`Locked:        ${config.accessLocked ? 'yes' : 'no'}\n`);

  console.log('Select new sudo access level:\n');
  const keys = Object.keys(ACCESS_LEVELS);
  keys.forEach((k, i) => {
    const lv = ACCESS_LEVELS[k];
    const marker = k === currentLevel ? ' ← current' : '';
    console.log(`  [${i + 1}] ${lv.label.padEnd(16)} — ${lv.desc}${marker}`);
  });
  console.log('');
  const choice = (await ask('Choice (1-5): ')).trim();
  if (!choice) { console.log('Cancelled.'); rl.close(); process.exit(0); }
  const idx = parseInt(choice, 10) - 1;
  const newLevel = keys[idx];
  if (!newLevel) { console.error('Invalid choice.'); rl.close(); process.exit(1); }

  if (newLevel === currentLevel) {
    console.log(`Already set to ${ACCESS_LEVELS[newLevel].label}. No changes needed.`);
    rl.close();
    process.exit(0);
  }

  const levelInfo = ACCESS_LEVELS[newLevel];
  console.log(`\n→ Changing from ${currentInfo?.label || currentLevel} to ${levelInfo.label}...`);

  // If we're running with --force (SSH unlock), ask if they want to change lock state
  let newLocked = !!config.accessLocked;
  if (forceFlag) {
    const ans = (await ask(`Lock this access level against UI changes? [y/N]: `)).trim().toLowerCase();
    newLocked = (ans === 'y' || ans === 'yes');
  }

  // Update sudoers
  const sudoersLine = buildSudoersLine(newLevel);
  const header = `# OpenEnsemble Node Agent — access level: ${newLevel}${newLocked ? ' (LOCKED)' : ''}\n`;
  const selfDestructPath = `${OE_INSTALL_DIR}/self-destruct.sh`;
  const selfDestructLine = `${OE_USER} ALL=(ALL) NOPASSWD: ${selfDestructPath}`;
  let selfBlock = `\n# Remote uninstall: agent can invoke self-destruct on UI Remove\n${selfDestructLine}\n`;
  if (!newLocked) {
    const selfLines = buildSelfSudoersLines();
    selfBlock += `\n# Self-management: allows oe-agent to change its own access level from the UI\n${selfLines.join('\n')}\n`;
  } else {
    selfBlock += `\n# Access level LOCKED — self-management disabled. To change: SSH in and run with --force\n`;
  }
  const sudoersContent = header + (sudoersLine ? sudoersLine + '\n' : '') + selfBlock;
  fs.writeFileSync(OE_SUDOERS_PATH, sudoersContent);
  fs.chmodSync(OE_SUDOERS_PATH, 0o440);
  try {
    execSync(`visudo -cf ${OE_SUDOERS_PATH}`, { stdio: 'ignore' });
    log(`Sudoers updated to ${OE_SUDOERS_PATH} (${levelInfo.label})`);
  } catch {
    fs.unlinkSync(OE_SUDOERS_PATH);
    console.error('ERROR: sudoers validation failed! File removed.');
    rl.close();
    process.exit(1);
  }

  // Update config
  config.accessLevel = newLevel;
  config.accessLocked = newLocked;
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.chmodSync(configPath, 0o600);
  } catch (e) {
    console.error('Failed to update config:', e.message);
  }

  // Also update the installer's local config if present
  const localConfig = loadConfig();
  if (localConfig) {
    localConfig.accessLevel = newLevel;
    localConfig.accessLocked = newLocked;
    saveConfig(localConfig);
  }

  console.log(`\n✓ Access level changed to ${levelInfo.label}`);

  // Rewrite the service unit so a transition to/from "full" switches the
  // User=root vs User=oe-agent binding. writeServiceUnit() also restarts
  // the service, so we don't need a separate restart below.
  const crossesFullBoundary = (currentLevel === 'full') !== (newLevel === 'full');
  if (crossesFullBoundary) {
    try {
      writeServiceUnit(platform, newLevel);
      console.log('  Service unit rewritten and restarted. New access level will be reported on reconnect.');
    } catch (e) {
      console.log(`  Note: Could not rewrite service unit: ${e.message}`);
      console.log('  Run manually:  sudo oe install-service');
    }
  } else {
    // Same user binding — just kick the service to pick up the new sudoers.
    try {
      if (platform === 'linux') {
        execSync('systemctl restart oe-node-agent', { stdio: 'inherit' });
        console.log('  Service restarted. New access level will be reported on reconnect.');
      } else if (platform === 'darwin') {
        execSync('launchctl kickstart -k system/com.openensemble.node-agent', { stdio: 'inherit' });
        console.log('  Service restarted. New access level will be reported on reconnect.');
      }
    } catch {
      console.log('  Note: Could not restart service automatically. Run: sudo systemctl restart oe-node-agent');
    }
  }

  console.log('');
  rl.close();
}

// ── CLI helpers (start/stop/restart/status/logs/help) ───────────────────────
function serviceControl(action) {
  const platform = os.platform();
  if (platform === 'linux') {
    execSync(`systemctl ${action} oe-node-agent`, { stdio: 'inherit' });
  } else if (platform === 'darwin') {
    const label = 'com.openensemble.node-agent';
    const plist = `/Library/LaunchDaemons/${label}.plist`;
    if (action === 'start')   execSync(`launchctl load ${plist}`, { stdio: 'inherit' });
    else if (action === 'stop')    execSync(`launchctl unload ${plist}`, { stdio: 'inherit' });
    else if (action === 'restart') execSync(`launchctl kickstart -k system/${label}`, { stdio: 'inherit' });
  } else if (platform === 'win32') {
    const mapping = { start: 'start', stop: 'stop', restart: null };
    if (action === 'restart') {
      try { execSync('sc stop OENodeAgent', { stdio: 'inherit' }); } catch {}
      execSync('sc start OENodeAgent', { stdio: 'inherit' });
    } else {
      execSync(`sc ${mapping[action]} OENodeAgent`, { stdio: 'inherit' });
    }
  } else {
    console.error(`Service control not supported on ${platform}`);
    process.exit(1);
  }
}

function showStatus() {
  const platform = os.platform();
  let active = null;
  if (platform === 'linux') {
    try {
      active = execSync('systemctl is-active oe-node-agent', { encoding: 'utf8' }).trim();
    } catch (e) {
      // is-active exits non-zero for inactive/failed units; stdout still has the state
      active = (e.stdout || '').toString().trim() || 'inactive';
    }
    console.log(active === 'active'
      ? '✓ oe-node-agent is running'
      : `✗ oe-node-agent is ${active}`);
    try { execSync('systemctl status oe-node-agent --no-pager -n 5', { stdio: 'inherit' }); } catch {}
  } else if (platform === 'darwin') {
    try {
      execSync('launchctl print system/com.openensemble.node-agent', { stdio: 'inherit' });
    } catch {
      console.log('✗ oe-node-agent is not loaded');
    }
  } else if (platform === 'win32') {
    try { execSync('sc query OENodeAgent', { stdio: 'inherit' }); }
    catch { console.log('✗ OENodeAgent service not found'); }
  }

  // Show the config summary so the user can verify which server this node
  // is paired to without digging through files.
  const config = loadConfig() || (() => {
    const alt = path.join(OE_INSTALL_DIR, '.oe-node', 'config.json');
    try { return JSON.parse(fs.readFileSync(alt, 'utf8')); } catch { return null; }
  })();
  if (config) {
    console.log('');
    console.log(`  Server:  ${config.server}`);
    console.log(`  Node ID: ${config.nodeId || os.hostname()}`);
    if (config.accessLevel) {
      console.log(`  Access:  ${config.accessLevel}${config.accessLocked ? ' (locked)' : ''}`);
    }
  } else {
    console.log('\n  No pairing config found. Run "sudo oe setup" to pair with a server.');
  }
}

function showLogs(rest) {
  const follow = rest.includes('-f') || rest.includes('--follow');
  const platform = os.platform();
  if (platform === 'linux') {
    const cmd = follow
      ? 'journalctl -u oe-node-agent -f'
      : 'journalctl -u oe-node-agent -n 100 --no-pager';
    execSync(cmd, { stdio: 'inherit' });
  } else if (platform === 'darwin') {
    const logPath = `${OE_INSTALL_DIR}/agent.log`;
    if (!fs.existsSync(logPath)) { console.log(`No log at ${logPath}`); return; }
    execSync(follow ? `tail -f "${logPath}"` : `tail -100 "${logPath}"`, { stdio: 'inherit' });
  } else if (platform === 'win32') {
    console.log('On Windows, check Event Viewer → Windows Logs → Application for "OENodeAgent".');
  }
}

function printHelp() {
  console.log(`OpenEnsemble Node Agent — CLI

Usage:  oe <command> [args]        (bare "oe" = status)

Service control:
  status              Show service status and pairing info (default)
  start               Start the agent service
  stop                Stop the agent service
  restart             Restart the agent service
  logs [-f]           Show recent logs (pass -f to follow)

Pairing / updates:
  repair <code>       Re-pair with the server using a fresh pairing code
  update              Download and install the latest agent script
  setup               Run the interactive pairing flow
  discover            Scan the LAN for an OpenEnsemble server

Install / remove:
  install-service     Install the systemd/launchd service + sudoers rules
  uninstall           Remove the service, user, and install dir
  change-access       Change the agent's sudo access level
  menu                Open the interactive config menu

  help                Show this message

Read-only commands (status, logs, help) run as the current user.
All other commands auto-elevate via sudo if not already root.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Catch-all error handlers — prevent exit
process.on('uncaughtException', (err) => {
  log(`[watchdog] Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  log(`[watchdog] Unhandled rejection: ${err}`);
});

// Graceful shutdown
let _shuttingDown = false;
function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log('Shutting down...');
  for (const [cmdId, proc] of _activeProcs) {
    try { proc.kill(); } catch {}
  }
  killAllPtys();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Map legacy --flag invocations (from old sudoers rules, from remote/install.sh
// on first-install, and from any scripts users wrote) onto the new subcommand
// names so both forms dispatch to the same handler. This keeps existing
// deployments working after they self-update to the renamed CLI.
function resolveSubcommand(a0) {
  switch (a0) {
    case '-c': case '--menu': case '--config': return 'menu';
    case '--update':            return 'update';
    case '--install-service':   return 'install-service';
    case '--uninstall-service': return 'uninstall';
    case '--change-access':     return 'change-access';
    case '--repair':            return 'repair';
    case '--setup':             return 'setup';
    case '--discover':          return 'discover';
    default: return a0;
  }
}

const cmd = resolveSubcommand(args[0] || '');
const rest = args.slice(1);
const PAIR_ONLY = args.includes('--pair-only');

async function runCli() {
  switch (cmd) {
    case 'menu': {
      if (process.platform !== 'win32' && process.getuid() !== 0) {
        console.error('The config menu must be run with sudo:\n  sudo oe menu');
        process.exit(1);
      }
      await configMenu();
      return;
    }
    case 'update':           await updateAgent(); return;
    case 'install-service':  await installService(); return;
    case 'change-access':    await changeAccess(); return;
    case 'uninstall':        uninstallService(); return;
    case 'repair':           await repairPairing(rest[0]); return;
    case 'setup': {
      const config = await interactiveSetup();
      // --pair-only: used by remote/install.sh so setup chains into install-service
      // without leaving the agent running in the foreground.
      if (PAIR_ONLY) {
        console.log('Config saved. Next: run "sudo oe install-service".');
        return;
      }
      startMainLoop(config);
      return 'noexit';
    }
    case 'discover': {
      const info = await discoverServer(15000);
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    case 'start': case 'stop': case 'restart':
      serviceControl(cmd); return;
    case 'status':
      showStatus(); return;
    case 'logs':
      showLogs(rest); return;
    case 'help': case '--help': case '-h':
      printHelp(); return;
    case '': {
      // No args = daemon mode (systemd / launchd ExecStart). If there's no
      // config yet, drop into interactive setup (manual invocation path).
      let config = loadConfig();
      if (!config) {
        log('No config found. Running interactive setup...');
        config = await interactiveSetup();
      }
      startMainLoop(config);
      return 'noexit';
    }
    default:
      console.error(`Unknown command: ${args[0]}`);
      console.error(`Run 'oe help' for usage.`);
      process.exit(1);
  }
}

runCli().then(result => {
  if (result !== 'noexit') process.exit(0);
}).catch(e => {
  console.error(`${cmd || 'oe'}: ${e.message}`);
  process.exit(1);
});

// Self-healing main loop
async function startMainLoop(config) {
  log(`OpenEnsemble Node Agent starting`);
  log(`  Server:  ${config.server}`);
  log(`  Node ID: ${config.nodeId || os.hostname()}`);

  const info = detectPlatform();
  log(`  OS:      ${info.distro} (${info.platform}/${info.arch})`);
  log(`  Shell:   ${info.shell}`);
  log(`  Pkg:     ${info.packageManager}`);

  let attempt = 0;

  while (!_shuttingDown) {
    const connectTime = Date.now();
    try {
      await runAgent(config);
      // If we get here, the connection closed cleanly
    } catch (err) {
      log(`[watchdog] Agent error: ${err.message}`);
    }

    if (_shuttingDown) break;

    // Reset attempt counter if connection lasted more than 60s
    if (Date.now() - connectTime > 60000) attempt = 0;

    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    log(`[reconnect] Attempt ${attempt + 1} in ${delay}s...`);
    await sleep(delay * 1000);
    attempt++;
  }
}

// startMainLoop is called from the conditional above
