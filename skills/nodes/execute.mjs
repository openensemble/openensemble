/**
 * Skill executor for Remote Nodes.
 * Routes tool calls to the shared node registry.
 */

import { getNodes, getNode, sendCommand, sendCommandStreaming, setReadableFolders, isPathAllowed } from './node-registry.mjs';
import { getActiveProjectInfo } from '../coder/execute.mjs';
import { generatePairingCode, PAIRING_CODE_TTL_SECONDS } from '../../routes/nodes/pairing.mjs';
import { getLanAddress } from '../../discovery.mjs';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Rate-limit agent-initiated pairing-code requests per user.
// Keyed by userId → array of timestamps (ms) within the current window.
const PAIR_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PAIR_RATE_MAX = 30;                    // codes per window per user (Proxmox-scale unattended pairing)
const _pairRateBuckets = new Map();

function _pairRateCheck(userId) {
  const now = Date.now();
  const bucket = (_pairRateBuckets.get(userId) || []).filter(t => now - t < PAIR_RATE_WINDOW_MS);
  if (bucket.length >= PAIR_RATE_MAX) {
    const oldest = bucket[0];
    const retryInSec = Math.ceil((PAIR_RATE_WINDOW_MS - (now - oldest)) / 1000);
    return { ok: false, retryInSec, used: bucket.length };
  }
  bucket.push(now);
  _pairRateBuckets.set(userId, bucket);
  return { ok: true, used: bucket.length };
}

function _auditPairing(userId, agentId, code, reason) {
  try {
    const dir = path.join(BASE_DIR, 'users', userId);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agentId: agentId || 'unknown',
      code,
      reason: reason || null,
    }) + '\n';
    appendFileSync(path.join(dir, 'agent-pairings.log'), line);
  } catch (e) {
    console.warn('[nodes] audit log write failed:', e.message);
  }
}

// Cap on raw project size pushed to a node. tar.gz + base64 rides over the
// node WebSocket (default ~100MB), so we leave headroom after compression.
const PUSH_SIZE_CAP = 80 * 1024 * 1024;

function tarProject(projectDir) {
  return new Promise((resolve, reject) => {
    const parent = path.dirname(projectDir);
    const leaf = path.basename(projectDir);
    // -C parent leaf → archive the project directory's CONTENTS under "./"
    // using --transform, so it extracts directly into dest_path without an
    // extra project-name subdirectory. Exclude common heavy build junk.
    const args = [
      'czf', '-',
      '-C', projectDir,
      '--exclude=.git',
      '--exclude=node_modules',
      '--exclude=__pycache__',
      '--exclude=.venv',
      '--exclude=venv',
      '--exclude=dist',
      '--exclude=build',
      '--exclude=.openensemble',
      '.',
    ];
    const proc = spawn('tar', args);
    const chunks = [];
    let stderr = '';
    let totalBytes = 0;
    proc.stdout.on('data', c => {
      totalBytes += c.length;
      if (totalBytes > PUSH_SIZE_CAP) {
        try { proc.kill('SIGKILL'); } catch {}
        return reject(new Error(
          `Project too large to push (>${Math.floor(PUSH_SIZE_CAP / (1024*1024))}MB compressed). ` +
          `Clean up the project or use a smaller asset set.`
        ));
      }
      chunks.push(c);
    });
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`tar exited ${code}: ${stderr.trim() || 'unknown error'}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

function isSafeServiceName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(name);
}

function shellEscape(s) {
  // single-quote escape for bash
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const OUTPUT_CAP = 50 * 1024; // 50KB max for LLM context

function truncate(text, max = OUTPUT_CAP) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n… [truncated, ${text.length - max} bytes omitted]`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)}${units[i]}`;
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return 'unknown';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function* executeSkillTool(name, args, userId, agentId) {
  if (name === 'node_list') {
    const nodeList = getNodes(userId);
    if (!nodeList.length) {
      yield { type: 'result', text: 'No remote nodes connected. Install oe-node-agent on a machine and connect it to this server.' };
      return;
    }
    yield { type: 'result', text: nodeList.map(n => {
      const healthIcon = { healthy: '🟢', stale: '🟡', recovered: '🔵', disconnected: '🔴' }[n.health] || '⚪';
      let line = `**${n.hostname}** (${n.nodeId}) ${healthIcon} ${n.health}`;
      line += `\n  OS: ${n.distro} ${n.arch} | Shell: ${n.shell} | Pkg: ${n.packageManager}`;
      if (n.stats) {
        line += `\n  Uptime: ${formatUptime(n.stats.uptime)} | Load: ${(n.stats.load || [0])[0].toFixed(2)}`;
        line += ` | Mem: ${formatBytes(n.stats.memUsed)}/${formatBytes(n.stats.memTotal)}`;
        if (n.stats.disk) {
          if (typeof n.stats.disk === 'object' && n.stats.disk.pct) {
            line += ` | Disk: ${n.stats.disk.used}/${n.stats.disk.size} (${n.stats.disk.pct})`;
          }
        }
      }
      if (n.restartCount > 0) {
        line += `\n  Restarts: ${n.restartCount}`;
      }
      return line;
    }).join('\n\n') };
    return;
  }

  if (name === 'node_exec') {
    const { node_id, command, timeout = 60 } = args;
    if (!node_id) { yield { type: 'result', text: 'Error: node_id is required.' }; return; }
    if (!command) { yield { type: 'result', text: 'Error: command is required.' }; return; }

    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected. Use node_list to see available nodes.` }; return; }

    // Bridge the chunk callback (from the registry's WS stream) into yieldable
    // events. A simple promise-queue: callback pushes, generator awaits next.
    const queue = [];
    let pendingResolver = null;
    const push = (item) => {
      if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r(item); }
      else queue.push(item);
    };
    const nextItem = () => queue.length
      ? Promise.resolve(queue.shift())
      : new Promise(res => { pendingResolver = res; });

    let cmdResult = null;
    let cmdError = null;
    sendCommandStreaming(node.nodeId, userId, {
      type: 'exec',
      command,
      timeout: Math.min(timeout, 300),
    }, (stream, data) => push({ kind: 'chunk', stream, data }))
      .then(r => { cmdResult = r; push({ kind: 'done' }); })
      .catch(e => { cmdError = e; push({ kind: 'done' }); });

    // Coalesce bursts of small chunks into one progress event per ~150ms
    // so a fast-streaming command doesn't flood the websocket.
    const FLUSH_MS = 150;
    const FLUSH_MAX = 4 * 1024;
    let buf = { stdout: '', stderr: '' };
    let lastFlush = 0;
    const drainBuf = () => {
      const out = (buf.stdout ? buf.stdout : '') + (buf.stderr ? `STDERR${buf.stderr}` : '');
      buf = { stdout: '', stderr: '' };
      lastFlush = Date.now();
      return out;
    };

    while (true) {
      const item = await nextItem();
      if (item.kind === 'chunk') {
        if (item.stream === 'stderr') buf.stderr += item.data;
        else                          buf.stdout += item.data;
        const total = buf.stdout.length + buf.stderr.length;
        if (total >= FLUSH_MAX || Date.now() - lastFlush >= FLUSH_MS) {
          yield { type: 'tool_progress', name: 'node_exec', text: drainBuf() };
        }
        continue;
      }
      // done
      if (buf.stdout || buf.stderr) {
        yield { type: 'tool_progress', name: 'node_exec', text: drainBuf() };
      }
      if (cmdError) {
        yield { type: 'result', text: `Command failed: ${cmdError.message}` };
        return;
      }
      let output = '';
      if (cmdResult.stdout) output += truncate(cmdResult.stdout);
      if (cmdResult.stderr) output += (output ? '\n\n' : '') + `STDERR:\n${truncate(cmdResult.stderr)}`;
      output += `\n\nExit code: ${cmdResult.exitCode} (${cmdResult.duration}ms)`;
      yield { type: 'result', text: output || `Command completed with exit code ${cmdResult.exitCode}` };
      return;
    }
  }

  if (name === 'node_read_file') {
    // Read a file from a remote node. Server-side allowlist check happens
    // BEFORE the command is sent — if the path isn't under one of the
    // node's readableFolders, this never reaches the agent. node_exec
    // bypasses this allowlist by design (different privilege class).
    const { node_id, path: filePath, max_bytes = 100_000 } = args;
    if (!node_id)   { yield { type: 'result', text: 'Error: node_id is required.' }; return; }
    if (!filePath)  { yield { type: 'result', text: 'Error: path is required.' }; return; }
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      yield { type: 'result', text: 'Error: path must be absolute Unix-style starting with "/".' }; return;
    }

    const node = getNode(node_id, userId);
    if (!node) {
      yield { type: 'result', text: `Node "${node_id}" not found or not connected.` };
      return;
    }

    if (!isPathAllowed(node.nodeId, userId, filePath)) {
      const folders = node.readableFolders || [];
      yield { type: 'result', text: folders.length
        ? `Error: "${filePath}" is not in the readable-folders allowlist for ${node.hostname}.\nAllowed folders: ${folders.join(', ')}\nUse node_set_readable_folders to expand the list.`
        : `Error: ${node.hostname} has no readable folders configured. Use node_set_readable_folders first to whitelist a path prefix (e.g. "/home/${node.hostname === 'localhost' ? 'shawn' : 'user'}/Documents").`
      };
      return;
    }

    const cap = Math.min(Math.max(Number(max_bytes) || 100_000, 1024), 5 * 1024 * 1024);
    // Single-quote the path; escape embedded single quotes the shell-safe way.
    const quoted = "'" + String(filePath).replace(/'/g, "'\\''") + "'";
    const isWindows = (node.platform || '').toLowerCase().startsWith('win');
    const command = isWindows
      ? `Get-Content -Raw -TotalCount ${cap} ${quoted}`
      : `head -c ${cap} -- ${quoted}`;

    let result;
    try {
      result = await sendCommand(node.nodeId, userId, { type: 'exec', command, timeout: 30 });
    } catch (e) {
      yield { type: 'result', text: `Error reading file: ${e.message}` };
      return;
    }
    if (result.exitCode !== 0) {
      yield { type: 'result', text: `Read failed (exit ${result.exitCode}):\n${(result.stderr || '').slice(0, 500) || '(no error message)'}` };
      return;
    }
    const body = result.stdout || '';
    const truncated = body.length === cap ? `\n\n[truncated at ${cap} bytes; pass max_bytes=N to read more]` : '';
    yield { type: 'result', text: body ? `[${node.hostname}:${filePath}]\n\n${body}${truncated}` : `(empty file at ${filePath})` };
    return;
  }

  if (name === 'node_set_readable_folders') {
    // Configure the per-node read allowlist. Each call REPLACES the existing
    // list (it doesn't append) — keeps the user's mental model simple. To
    // remove all access, call with an empty array.
    const { node_id, paths } = args;
    if (!node_id) { yield { type: 'result', text: 'Error: node_id is required.' }; return; }
    if (!Array.isArray(paths)) { yield { type: 'result', text: 'Error: paths must be an array of absolute paths.' }; return; }

    const node = getNode(node_id, userId);
    if (!node) {
      yield { type: 'result', text: `Node "${node_id}" not found or not connected.` };
      return;
    }

    const updated = setReadableFolders(node.nodeId, userId, paths);
    if (!updated) {
      yield { type: 'result', text: 'Could not update readable folders (node not owned by this user).' };
      return;
    }

    yield { type: 'result', text: updated.readableFolders.length
      ? `Set readable folders on ${updated.hostname}:\n${updated.readableFolders.map(f => `- ${f}`).join('\n')}`
      : `Cleared readable folders on ${updated.hostname} — node_read_file will reject all reads until folders are configured again.`
    };
    return;
  }

  if (name === 'node_push_project') {
    const { node_id, dest_path, clean = false } = args;
    if (!node_id)   { yield { type: 'result', text: 'Error: node_id is required.' }; return; }
    if (!dest_path) { yield { type: 'result', text: 'Error: dest_path is required.' }; return; }
    if (typeof dest_path !== 'string' || !dest_path.startsWith('/')) {
      yield { type: 'result', text: 'Error: dest_path must be an absolute Unix-style path starting with "/".' }; return;
    }

    const info = getActiveProjectInfo(userId);
    if (!info) {
      yield { type: 'result', text: 'No active coder project. Use coder_create_project or coder_switch_project first, then try again.' };
      return;
    }

    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected. Use node_list.` }; return; }

    let tarBuf;
    try { tarBuf = await tarProject(info.dir); }
    catch (e) { yield { type: 'result', text: `Failed to package project: ${e.message}` }; return; }

    const b64 = tarBuf.toString('base64');

    try {
      const result = await sendCommand(node.nodeId, userId, {
        type: 'push_tar',
        destPath: dest_path,
        data: b64,
        clean: !!clean,
        timeout: 300,
      });
      const out = [];
      if (result.stdout) out.push(result.stdout.trim());
      if (result.stderr) out.push(`STDERR:\n${result.stderr.trim()}`);
      out.push(`Exit ${result.exitCode} (${result.duration}ms) • sent ${tarBuf.length} bytes compressed from "${info.project}" → ${node.hostname}:${dest_path}`);
      yield { type: 'result', text: out.filter(Boolean).join('\n\n') };
    } catch (e) {
      yield { type: 'result', text: `Push failed: ${e.message}` };
    }
    return;
  }

  if (name === 'node_start_service') {
    const { node_id, command, cwd, name: svcName } = args;
    if (!node_id) { yield { type: 'result', text: 'Error: node_id is required.' }; return; }
    if (!command) { yield { type: 'result', text: 'Error: command is required.' }; return; }
    if (cwd && (typeof cwd !== 'string' || !cwd.startsWith('/'))) {
      yield { type: 'result', text: 'Error: cwd must be an absolute path starting with "/".' }; return;
    }
    const label = isSafeServiceName(svcName) ? svcName : `svc-${randomBytes(3).toString('hex')}`;

    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected.` }; return; }

    // Subshell prints PID:<pid> then exits. The child keeps running detached
    // because nohup + </dev/null disown it from the controlling shell.
    const logPath = `/tmp/oe-svc-${label}-${Date.now()}.log`;
    const cdPart = cwd ? `cd ${shellEscape(cwd)} && ` : '';
    const wrapped =
      `mkdir -p /tmp && ` +
      `( ${cdPart}nohup bash -c ${shellEscape(command)} > ${shellEscape(logPath)} 2>&1 < /dev/null & echo "PID:$!" )`;

    try {
      const result = await sendCommand(node.nodeId, userId, { type: 'exec', command: wrapped, timeout: 30 });
      const pidMatch = (result.stdout || '').match(/PID:(\d+)/);
      if (!pidMatch) {
        yield { type: 'result', text: `Service may not have started. stdout: ${result.stdout || '(empty)'}\nstderr: ${result.stderr || '(empty)'}\nexit ${result.exitCode}` };
        return;
      }
      const pid = parseInt(pidMatch[1], 10);

      // Wait briefly, then peek the log so the model can confirm it's alive.
      await new Promise(r => setTimeout(r, 1500));
      const tailCmd = `kill -0 ${pid} 2>/dev/null && echo "ALIVE" || echo "DEAD"; echo "--- log tail ---"; tail -n 20 ${shellEscape(logPath)} 2>/dev/null || true`;
      const tailResult = await sendCommand(node.nodeId, userId, { type: 'exec', command: tailCmd, timeout: 10 });

      yield { type: 'result', text:
        `Started "${label}" on ${node.hostname} — PID ${pid}\n` +
        `Log: ${logPath}\n` +
        `Status:\n${(tailResult.stdout || '').trim()}`
      };
    } catch (e) {
      yield { type: 'result', text: `Failed to start service: ${e.message}` };
    }
    return;
  }

  if (name === 'node_stop_service') {
    const { node_id, pid } = args;
    if (!node_id) { yield { type: 'result', text: 'Error: node_id is required.' }; return; }
    if (!Number.isInteger(pid) || pid < 2) { yield { type: 'result', text: 'Error: pid must be a positive integer.' }; return; }

    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected.` }; return; }

    const cmd = `kill ${pid} 2>/dev/null; sleep 2; if kill -0 ${pid} 2>/dev/null; then kill -9 ${pid} 2>/dev/null && echo "force-killed"; else echo "stopped"; fi`;
    try {
      const result = await sendCommand(node.nodeId, userId, { type: 'exec', command: cmd, timeout: 15 });
      const status = (result.stdout || '').trim() || `exit ${result.exitCode}`;
      yield { type: 'result', text: `PID ${pid} on ${node.hostname}: ${status}` };
    } catch (e) {
      yield { type: 'result', text: `Failed to stop PID ${pid}: ${e.message}` };
    }
    return;
  }

  if (name === 'node_pair_code') {
    const { reason } = args || {};
    const rate = _pairRateCheck(userId);
    if (!rate.ok) {
      yield { type: 'result', text:
        `Rate limit: ${PAIR_RATE_MAX} pairing codes per hour per user reached. ` +
        `Try again in ~${Math.ceil(rate.retryInSec / 60)} minutes, or ask the user to pair manually from Settings.`
      };
      return;
    }
    const code = generatePairingCode(userId);
    _auditPairing(userId, agentId, code, reason);

    const serverHost = `${getLanAddress()}:3737`;
    const installUrl = `http://${serverHost}/nodes/install.sh`;
    const oneLiner = `curl -fsSL ${installUrl} | sh -s -- --server http://${serverHost} --code ${code}`;

    yield { type: 'result', text:
      `Pairing code: **${code}** (expires in ${Math.floor(PAIRING_CODE_TTL_SECONDS / 60)} minutes, single-use)\n` +
      `Server: http://${serverHost}\n` +
      `Install URL: ${installUrl}\n\n` +
      `Unattended install one-liner (run on the target machine):\n\`\`\`\n${oneLiner}\n\`\`\`\n\n` +
      `IMPORTANT: codes are single-use. For multi-target rollouts (e.g. every Proxmox LXC), ` +
      `call node_pair_code again for each container — do NOT reuse one code across multiple machines. ` +
      `You have ${PAIR_RATE_MAX - rate.used} codes remaining this hour.`
    };
    return;
  }

  if (name === 'node_status') {
    const { node_id } = args;
    if (!node_id) { yield { type: 'result', text: 'Error: node_id is required.' }; return; }

    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected.` }; return; }

    try {
      const result = await sendCommand(node.nodeId, userId, { type: 'status' });
      let out = `**${node.hostname}** Status:`;
      out += `\n  Platform: ${result.platform || node.platform}`;
      out += `\n  Distro: ${result.distro || node.distro}`;
      out += `\n  Arch: ${result.arch || node.arch}`;
      out += `\n  Shell: ${node.shell} | Pkg Manager: ${node.packageManager}`;
      out += `\n  Uptime: ${formatUptime(result.uptime)}`;
      out += `\n  CPUs: ${result.cpus || 'unknown'}`;
      out += `\n  Load: ${(result.load || [0, 0, 0]).map(l => l.toFixed(2)).join(', ')}`;
      out += `\n  Memory: ${formatBytes(result.memUsed)} / ${formatBytes(result.memTotal)} (${formatBytes(result.memFree)} free)`;
      if (result.disk) {
        if (Array.isArray(result.disk)) {
          for (const d of result.disk) {
            out += `\n  Disk ${d.Name || '?'}: ${formatBytes(d.Used)} used, ${formatBytes(d.Free)} free`;
          }
        } else {
          out += `\n  Disk: ${result.disk.used}/${result.disk.size} (${result.disk.pct} used)`;
        }
      }
      out += `\n  Health: ${node.health}`;
      if (node.restartCount > 0) out += ` (${node.restartCount} restarts)`;
      yield { type: 'result', text: out };
    } catch (e) {
      yield { type: 'result', text: `Failed to get status: ${e.message}` };
    }
    return;
  }

  yield { type: 'result', text: null };
}

export default executeSkillTool;
