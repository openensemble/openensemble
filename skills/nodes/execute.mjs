/**
 * Skill executor for Remote Nodes.
 * Routes tool calls to the shared node registry.
 */

import { getNodes, getNode, sendCommand, sendCommandStreaming } from './node-registry.mjs';
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

    try {
      let totalOutput = '';
      // Use canonical nodeId for the send call — getNode may have resolved a hostname.
      const result = await sendCommandStreaming(node.nodeId, userId, {
        type: 'exec',
        command,
        timeout: Math.min(timeout, 300),
      }, (stream, data) => {
        // onChunk callback — not used for yielding (can't yield from callback)
        // chunks are collected by the registry's pendingCommands.chunks
      });

      // Build final result from the completed command
      let output = '';
      if (result.stdout) output += truncate(result.stdout);
      if (result.stderr) output += (output ? '\n\n' : '') + `STDERR:\n${truncate(result.stderr)}`;
      output += `\n\nExit code: ${result.exitCode} (${result.duration}ms)`;
      yield { type: 'result', text: output || `Command completed with exit code ${result.exitCode}` };
    } catch (e) {
      yield { type: 'result', text: `Command failed: ${e.message}` };
    }
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
