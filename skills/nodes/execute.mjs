/**
 * Skill executor for Remote Nodes.
 * Routes tool calls to the shared node registry.
 */

import { getNodes, getNode, sendCommand, sendCommandStreaming, setReadableFolders, isPathAllowed, setParentHost, getParentHost, waitForNodeReconnect } from './node-registry.mjs';
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
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
    if (!command) { yield { type: 'result', text: 'This tool needs a command. Call it again with command specified.' }; return; }

    // Phase-11c: log the invocation for the location_fact outcome measurer.
    // Fire-and-forget — never blocks dispatch.
    import('../../lib/node-exec-paths.mjs').then(m =>
      m.appendNodeExec(userId, { nodeId: node_id, command })
    ).catch(e => console.warn('[node-exec-paths] log failed:', e.message));

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
    if (!node_id)   { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
    if (!filePath)  { yield { type: 'result', text: 'This tool needs a path. Call it again with path specified.' }; return; }
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
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
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
    if (!node_id)   { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
    if (!dest_path) { yield { type: 'result', text: 'This tool needs a dest_path. Call it again with dest_path specified.' }; return; }
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
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
    if (!command) { yield { type: 'result', text: 'This tool needs a command. Call it again with command specified.' }; return; }
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
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
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
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }

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

  if (name === 'node_set_parent_host') {
    const { node_id, parent_host } = args || {};
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }

    // Several fields land in `lib/host-snapshot.mjs` interpolated into shell
    // commands (zfs snapshot ${dataset}@${snap}, btrfs subvolume snapshot
    // ${subvolume} ${snap_path}, etc.). Reject any value that contains shell
    // metacharacters so a hallucinated or prompt-injected parent_host can't
    // become RCE on the storage host. The allowed character class is the
    // intersection of valid ZFS dataset names and valid filesystem paths.
    if (parent_host && typeof parent_host === 'object') {
      const SHELL_SAFE = /^[A-Za-z0-9._/@:+-]+$/;
      const fields = ['dataset', 'subvolume', 'snapshot_dir', 'ssh_host', 'node', 'vmid', 'kind', 'type'];
      for (const f of fields) {
        const v = parent_host[f];
        if (v == null) continue;
        if (typeof v !== 'string' && typeof v !== 'number') {
          yield { type: 'result', text: `Error: parent_host.${f} must be a string.` };
          return;
        }
        if (!SHELL_SAFE.test(String(v))) {
          yield { type: 'result', text: `Error: parent_host.${f} contains disallowed characters. Allowed: letters, digits, and ._/@:+-` };
          return;
        }
      }
    }

    try {
      const updated = setParentHost(node_id, userId, parent_host ?? null);
      if (!updated) { yield { type: 'result', text: `Node "${node_id}" not found.` }; return; }
      if (parent_host == null) {
        yield { type: 'result', text: `Cleared parent_host for "${updated.hostname}". Host-level rollback no longer available for high-risk ops here (surgical rollback still works).` };
      } else {
        let target;
        let suffix = 'High-risk ops will now auto-snapshot the host before running.';
        if (parent_host.type === 'proxmox') {
          const memNote = parent_host.kind === 'qemu'
            ? (parent_host.vmstate ? ' (with RAM/vmstate)' : ' (disk-only — set vmstate:true if you want exact mid-execution restore)')
            : '';
          target = `Proxmox ${parent_host.kind} ${parent_host.vmid} on ${parent_host.node}${memNote}`;
        } else if (parent_host.type === 'zfs') {
          target = `ZFS dataset ${parent_host.dataset} on ${parent_host.ssh_host}`;
        } else if (parent_host.type === 'btrfs') {
          target = `Btrfs subvolume ${parent_host.subvolume} (snapshots → ${parent_host.snapshot_dir})`;
          suffix = 'High-risk ops will auto-snapshot. NOTE: btrfs auto-rollback is NOT applied automatically — OE preserves the snapshot and surfaces the manual recovery command if you ask to roll back.';
        }
        yield { type: 'result', text: `Wired "${updated.hostname}" → ${target}. ${suffix}` };
      }
    } catch (e) {
      yield { type: 'result', text: `Error: ${e.message}` };
    }
    return;
  }

  if (name === 'node_grant_permission') {
    const { node_id, type, name: permName, rationale } = args || {};
    if (!node_id || !type || !permName) {
      yield { type: 'result', text: 'node_grant_permission needs node_id, type, and name. Call this tool again with all three.' };
      return;
    }
    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected.` }; return; }

    // Validate type up front so we don't half-apply something unsupported.
    if (!['group', 'sudoers', 'access_level'].includes(type)) {
      yield { type: 'result', text: `Error: unsupported type "${type}". Use "group", "sudoers", or "access_level".` };
      return;
    }

    // Without access_level=full the agent runs as a non-root user. Privilege
    // changes (usermod, /etc/sudoers, systemctl restart) all need root, and
    // sudo will prompt → hang. Bail with a clear next step.
    if (node.accessLevel !== 'full') {
      yield {
        type: 'result',
        text:
          `Cannot grant permission: node "${node.hostname}" is running at access_level=${node.accessLevel ?? 'unknown'}. ` +
          `Privilege changes need access_level=full (oe-agent runs as root). ` +
          `Have ${'{{USER_NAME}}'} run \`sudo oe change-access full\` on the node, then try again.`,
      };
      return;
    }

    yield { type: 'tool_progress', name: 'node_grant_permission', text: `Granting ${type}=${permName} on ${node.hostname}…` };

    if (type === 'group') {
      // 1. Add to the group. usermod is idempotent; running it on a user
      //    already in the group is a no-op.
      const um = await sendCommand(node_id, userId, {
        type: 'exec',
        command: `usermod -a -G ${shellEscape(permName)} oe-agent`,
        timeout: 15,
      }).catch(e => ({ exitCode: 1, stderr: e.message }));
      if (um.exitCode !== 0) {
        yield { type: 'result', text: `usermod failed: ${(um.stderr || '').slice(0, 300)}` };
        return;
      }

      // 2. Restart the node-agent so the new group is picked up. The exec
      //    will not return cleanly because the agent process IS being killed;
      //    we ignore the rejection and wait for reconnect.
      sendCommand(node_id, userId, {
        type: 'exec',
        command: 'systemctl restart oe-node-agent',
        timeout: 5,
      }).catch(() => {});

      const recon = await waitForNodeReconnect(node_id, userId, 60_000);
      if (!recon.ok) {
        yield { type: 'result', text: `oe-agent did not reconnect after restart: ${recon.reason}. Check the node manually.` };
        return;
      }

      // 3. Verify the membership took.
      const verify = await sendCommand(node_id, userId, {
        type: 'exec',
        command: 'id -Gn oe-agent',
        timeout: 10,
      }).catch(e => ({ exitCode: 1, stdout: '', stderr: e.message }));
      const groups = (verify.stdout || '').trim().split(/\s+/);
      if (verify.exitCode !== 0 || !groups.includes(permName)) {
        yield {
          type: 'result',
          text: `Permission applied but verification could not confirm membership. \`id -Gn oe-agent\` returned: ${(verify.stdout || verify.stderr || '').slice(0, 300)}`,
        };
        return;
      }

      yield {
        type: 'result',
        text:
          `Added oe-agent to group \`${permName}\` on ${node.hostname} (verified). ` +
          `Service operations that needed this group should now work without sudo prompts.` +
          (rationale ? ` (Reason: ${rationale}.)` : ''),
      };
      return;
    }

    if (type === 'sudoers') {
      // Sudoers entries land in /etc/sudoers.d/oe-agent-<safe>. The filename
      // must not contain dots or unsafe chars (sudoers.d ignores files with
      // dots in the name). We sanitize from the binary path:
      //   /usr/bin/systemctl  → systemctl
      //   /usr/local/bin/pihole → pihole
      // and require an absolute path so we're not granting NOPASSWD on
      // ambiguous PATH lookups.
      if (!permName.startsWith('/')) {
        yield {
          type: 'result',
          text: `Error: sudoers grants require an ABSOLUTE binary path (e.g. /usr/bin/systemctl), got "${permName}". Use \`which <cmd>\` first.`,
        };
        return;
      }
      const safe = permName.split('/').pop().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
      const sudoersFile = `/etc/sudoers.d/oe-agent-${safe}`;
      const line = `oe-agent ALL=(ALL) NOPASSWD: ${permName}`;
      // 1. Verify the binary exists before granting NOPASSWD on it.
      const exists = await sendCommand(node_id, userId, {
        type: 'exec', command: `test -x ${shellEscape(permName)} && echo present || echo missing`, timeout: 10,
      }).catch(e => ({ exitCode: 1, stdout: '', stderr: e.message }));
      if ((exists.stdout || '').trim() !== 'present') {
        yield { type: 'result', text: `Refusing to grant NOPASSWD: \`${permName}\` does not exist or is not executable on ${node.hostname}.` };
        return;
      }
      // 2. Write the file. Use printf to avoid heredoc shell quoting issues.
      //    Then chmod 0440 (sudoers requirement) and validate with visudo.
      const escaped = line.replace(/'/g, `'\\''`);
      const writeRes = await sendCommand(node_id, userId, {
        type: 'exec',
        command: `printf '%s\\n' '${escaped}' > ${sudoersFile} && chmod 0440 ${sudoersFile} && visudo -cf ${sudoersFile}`,
        timeout: 15,
      }).catch(e => ({ exitCode: 1, stdout: '', stderr: e.message }));
      if (writeRes.exitCode !== 0) {
        // visudo failed → file is invalid; clean up
        await sendCommand(node_id, userId, {
          type: 'exec', command: `rm -f ${sudoersFile}`, timeout: 5,
        }).catch(() => {});
        yield { type: 'result', text: `sudoers install failed: ${(writeRes.stderr || writeRes.stdout || '').slice(0, 300)}` };
        return;
      }
      // 3. Verify with `sudo -ln` — should now show the new entry.
      const verify = await sendCommand(node_id, userId, {
        type: 'exec', command: `sudo -ln 2>&1`, timeout: 10,
      }).catch(e => ({ exitCode: 1, stdout: '', stderr: e.message }));
      const verified = (verify.stdout || '').includes(permName);
      yield {
        type: 'result',
        text: verified
          ? `Granted NOPASSWD sudo for \`${permName}\` on ${node.hostname} (sudoers file: ${sudoersFile}, verified).` + (rationale ? ` (Reason: ${rationale}.)` : '')
          : `sudoers entry installed but \`sudo -ln\` did not list it. File at ${sudoersFile} — check manually.`,
      };
      return;
    }

    if (type === 'access_level') {
      if (!['updates', 'full'].includes(permName)) {
        yield { type: 'result', text: 'access_level must be "updates" or "full".' };
        return;
      }
      // `oe change-access <level>` rewrites the systemd unit + restarts.
      // It needs sudo on the node side; if access_level was already full,
      // the agent runs as root and this is no-prompt.
      sendCommand(node_id, userId, {
        type: 'exec',
        command: `oe change-access ${permName}`,
        timeout: 30,
      }).catch(() => {});
      const recon = await waitForNodeReconnect(node_id, userId, 60_000);
      if (!recon.ok) {
        yield { type: 'result', text: `oe-agent did not reconnect after access-level change: ${recon.reason}.` };
        return;
      }
      const after = getNode(node_id, userId);
      yield {
        type: 'result',
        text: `Access level set to \`${permName}\` on ${node.hostname} (current: ${after?.accessLevel ?? '?'}).` +
          (rationale ? ` (Reason: ${rationale}.)` : ''),
      };
      return;
    }
  }

  if (name === 'node_check_agent_permissions') {
    const { node_id } = args || {};
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected.` }; return; }

    // Probe: who is oe-agent running as, what groups, what sudo can it use.
    // `sudo -ln` lists allowed commands without prompting (returns "may run" lines).
    // We swallow stderr from sudo since it'll print "user not allowed" or similar
    // when the user has no sudo entitlement at all.
    const probe = [
      'echo "::user::"; id -un',
      'echo "::uid::";  id -u',
      'echo "::groups::"; id -Gn',
      'echo "::sudo_n::"; sudo -ln 2>&1 | grep -E "may run|NOPASSWD|password required|not allowed" || echo "(no entries)"',
    ].join(' && ');

    let stdout;
    try {
      const r = await sendCommand(node_id, userId, { type: 'exec', command: probe, timeout: 15 });
      stdout = r.stdout || '';
    } catch (e) {
      yield { type: 'result', text: `Probe failed: ${e.message}` };
      return;
    }

    const sections = { user: '', uid: '', groups: '', sudo_n: '' };
    let cur = null;
    for (const line of stdout.split('\n')) {
      const m = line.match(/^::(user|uid|groups|sudo_n)::$/);
      if (m) { cur = m[1]; continue; }
      if (cur != null) sections[cur] += (sections[cur] ? '\n' : '') + line;
    }

    const groupList = (sections.groups || '').trim().split(/\s+/).filter(Boolean);
    const isRoot = sections.uid?.trim() === '0';
    const sudoLines = (sections.sudo_n || '').split('\n').map(l => l.trim()).filter(Boolean);
    const sudoNoPwd = sudoLines.filter(l => /NOPASSWD/i.test(l));
    const sudoNeedsPwd = sudoLines.filter(l => !/NOPASSWD/i.test(l) && /(may run|password required)/i.test(l));
    const noSudo = sudoLines.length === 0 || sudoLines.some(l => /not allowed/i.test(l));

    const out = [
      `**Agent permissions on ${node.hostname}:**`,
      `- Running as: \`${(sections.user || 'unknown').trim()}\` (uid ${sections.uid?.trim() || '?'})${isRoot ? ' — **root**' : ''}`,
      `- Groups: ${groupList.length ? groupList.map(g => `\`${g}\``).join(', ') : '(none)'}`,
    ];
    if (isRoot) {
      out.push(`- sudo: not needed — already root`);
    } else if (noSudo) {
      out.push(`- sudo: **not configured** for this user`);
    } else {
      if (sudoNoPwd.length) out.push(`- sudo (no password): ${sudoNoPwd.map(l => `\`${l}\``).join('; ')}`);
      if (sudoNeedsPwd.length) out.push(`- sudo (password required): ${sudoNeedsPwd.map(l => `\`${l}\``).join('; ')}`);
    }
    out.push('', '_Compare these to a profile\'s `agent_requirements`. Common gaps:_');
    out.push('- Pi-hole v6 write ops → user must be in `pihole` group');
    out.push('- Docker → user must be in `docker` group');
    out.push('- libvirt/QEMU → user must be in `libvirt` group');
    out.push('- Proxmox `pct`/`qm` → access_level must be `full` (runs as root)');
    yield { type: 'result', text: out.join('\n') };
    return;
  }

  if (name === 'node_detect_services') {
    const { node_id } = args || {};
    if (!node_id) { yield { type: 'result', text: 'This tool needs a node_id. Call it again with node_id specified.' }; return; }
    const node = getNode(node_id, userId);
    if (!node) { yield { type: 'result', text: `Node "${node_id}" not found or not connected.` }; return; }

    const probeScript = [
      'echo "::ports::"',
      "ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | awk -F: '{print $NF}' | sort -un | head -30",
      'echo "::binaries::"',
      'for b in pihole home-assistant nginx caddy mariadbd mysqld postgres redis-server tailscale mosquitto vaultwarden bw dhcpd kea-dhcp4-server tftpd-hpa in.tftpd atftpd dnsmasq named unbound coredns kresd nsd rpc.nfsd exportfs rpcbind; do command -v "$b" >/dev/null && echo "$b"; done',
      'echo "::paths::"',
      'for p in /etc/pihole /etc/nginx /etc/caddy /etc/dnsmasq.d /var/lib/mysql /var/lib/mariadb /var/lib/postgresql /etc/mosquitto /opt/vaultwarden /etc/tailscale /etc/dhcp /etc/dnsmasq.conf /var/lib/tftpboot /srv/tftp /srv/tftpboot /srv/pxeboot /srv/pxe /etc/bind /etc/unbound /etc/coredns /etc/knot-resolver /etc/nsd /etc/exports /etc/exports.d /proc/fs/nfsd /var/lib/nfs; do test -e "$p" && echo "$p"; done',
      'echo "::services::"',
      "systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}' | head -40",
      'echo "::flags::"',
      // dnsmasq is a DHCP server iff one of its config files declares a dhcp-range.
      // Pi-hole, libvirt, and bare dnsmasq all expose this the same way.
      "grep -lq '^[[:space:]]*dhcp-range=' /etc/dnsmasq.conf /etc/dnsmasq.d/*.conf 2>/dev/null && echo dnsmasq_dhcp_enabled || true",
      // dnsmasq with a tftp-root= line is acting as a TFTP server too.
      "grep -lq '^[[:space:]]*tftp-root=' /etc/dnsmasq.conf /etc/dnsmasq.d/*.conf 2>/dev/null && echo dnsmasq_tftp_enabled || true",
    ].join(' && ');

    let out;
    try {
      const r = await sendCommand(node_id, userId, { type: 'exec', command: probeScript, timeout: 30 });
      out = r.stdout || '';
    } catch (e) {
      yield { type: 'result', text: `Probe failed: ${e.message}` };
      return;
    }

    const sections = { ports: [], binaries: [], paths: [], services: [], flags: [] };
    let cur = null;
    for (const line of out.split('\n').map(s => s.trim()).filter(Boolean)) {
      const m = line.match(/^::(ports|binaries|paths|services|flags)::$/);
      if (m) { cur = m[1]; continue; }
      if (cur) sections[cur].push(line);
    }

    const detected = [];
    const has = (s, x) => sections[s].some(v => v.includes(x));
    const hasFlag = (f) => sections.flags.includes(f);

    if (has('binaries', 'pihole') || has('paths', '/etc/pihole')) {
      // Pi-hole always provides DNS. DHCP is opt-in via dnsmasq config —
      // detected via the dnsmasq_dhcp_enabled flag the probe sets when any
      // /etc/dnsmasq.d/*.conf has a dhcp-range= line.
      const roles = ['DNS'];
      if (hasFlag('dnsmasq_dhcp_enabled')) roles.push('DHCP');
      detected.push({ kind: 'pihole', evidence: [`pi-hole providing: ${roles.join(' + ')}`] });
    }
    if (has('binaries', 'home-assistant') || sections.services.some(s => s.startsWith('home-assistant'))) {
      detected.push({ kind: 'home_assistant', evidence: ['HA service'] });
    }
    if (has('binaries', 'nginx') || has('paths', '/etc/nginx')) detected.push({ kind: 'nginx', evidence: ['nginx config'] });
    if (has('binaries', 'caddy') || has('paths', '/etc/caddy')) detected.push({ kind: 'caddy', evidence: ['caddy'] });
    if (has('binaries', 'mariadbd') || has('binaries', 'mysqld') || has('paths', '/var/lib/mysql') || has('paths', '/var/lib/mariadb')) {
      detected.push({ kind: 'mariadb', evidence: ['mysql/mariadb'] });
    }
    if (has('binaries', 'postgres') || has('paths', '/var/lib/postgresql')) detected.push({ kind: 'postgresql', evidence: ['postgres'] });
    if (has('binaries', 'redis-server')) detected.push({ kind: 'redis', evidence: ['redis-server'] });
    if (has('binaries', 'tailscale') || has('paths', '/etc/tailscale')) detected.push({ kind: 'tailscale', evidence: ['tailscale'] });
    if (has('binaries', 'mosquitto') || has('paths', '/etc/mosquitto')) detected.push({ kind: 'mosquitto', evidence: ['mosquitto'] });
    if (has('binaries', 'vaultwarden') || has('binaries', 'bw') || has('paths', '/opt/vaultwarden')) {
      detected.push({ kind: 'vaultwarden', evidence: ['vaultwarden'] });
    }

    // ── NFS ──────────────────────────────────────────────────────────────
    // Emit even on boxes that also run Samba — letting it ride on a samba
    // profile means a node that's NFS-only (e.g. a PXE root server) gets
    // missed. The user / Sydney can decide whether to onboard one combined
    // file-sharing profile or split nfs and samba.
    const nfsServiceRunning = sections.services.some(s =>
      s.startsWith('nfs-server') || s.startsWith('nfs-kernel-server') || s === 'nfsd.service',
    );
    const hasNfsExports = has('paths', '/etc/exports') || has('paths', '/etc/exports.d');
    if (has('binaries', 'rpc.nfsd') || has('binaries', 'exportfs') || hasNfsExports || has('paths', '/proc/fs/nfsd') || nfsServiceRunning) {
      const ev = [];
      if (has('binaries', 'rpc.nfsd')) ev.push('rpc.nfsd binary');
      if (hasNfsExports)               ev.push('/etc/exports');
      if (nfsServiceRunning)           ev.push('nfs-server unit running');
      detected.push({ kind: 'nfs', evidence: ev.length ? ev : ['NFS server present'] });
    }

    // ── DNS servers (standalone — pi-hole already handled above) ─────────
    if (has('binaries', 'named') || has('paths', '/etc/bind')) {
      detected.push({ kind: 'bind9', evidence: ['BIND9 (named)'] });
    }
    if (has('binaries', 'unbound') || has('paths', '/etc/unbound')) {
      detected.push({ kind: 'unbound', evidence: ['Unbound recursive DNS resolver'] });
    }
    if (has('binaries', 'coredns') || has('paths', '/etc/coredns')) {
      detected.push({ kind: 'coredns', evidence: ['CoreDNS'] });
    }
    if (has('binaries', 'kresd') || has('paths', '/etc/knot-resolver')) {
      detected.push({ kind: 'knot_resolver', evidence: ['Knot Resolver (kresd)'] });
    }
    if (has('binaries', 'nsd') || has('paths', '/etc/nsd')) {
      detected.push({ kind: 'nsd', evidence: ['NSD authoritative DNS'] });
    }

    // ── DHCP / TFTP / PXE stack ──────────────────────────────────────────
    // dnsmasq covers DNS + DHCP + TFTP depending on config. We detect the
    // active roles from /etc/dnsmasq.d/* via the probe's flags section.
    // ISC dhcpd / Kea / standalone tftpd are detected by binary presence.
    const dnsmasqIsDhcp  = hasFlag('dnsmasq_dhcp_enabled');
    const dnsmasqIsTftp  = hasFlag('dnsmasq_tftp_enabled');
    const hasIscDhcpd    = has('binaries', 'dhcpd') || has('binaries', 'kea-dhcp4-server');
    const hasStandaloneTftp = ['tftpd-hpa', 'in.tftpd', 'atftpd'].some(b => has('binaries', b))
      || ['/var/lib/tftpboot', '/srv/tftp', '/srv/tftpboot'].some(p => has('paths', p));
    const hasNetbootDir  = ['/srv/pxe', '/srv/pxeboot', '/srv/tftpboot', '/var/lib/tftpboot'].some(p => has('paths', p));

    const dhcpActive = hasIscDhcpd || dnsmasqIsDhcp;
    const tftpActive = hasStandaloneTftp || dnsmasqIsTftp;

    if (dhcpActive) {
      const ev = [];
      if (hasIscDhcpd) ev.push(has('binaries', 'kea-dhcp4-server') ? 'Kea DHCP server' : 'ISC dhcpd');
      if (dnsmasqIsDhcp && !detected.some(d => d.kind === 'pihole')) ev.push('dnsmasq with dhcp-range= configured');
      // Pi-hole's DHCP role is already noted on the pihole entry; only add a
      // standalone dhcp_server kind when something OTHER than pihole is the
      // DHCP authority on this node.
      if (ev.length) detected.push({ kind: 'dhcp_server', evidence: ev });
    }
    if (tftpActive) {
      const ev = [];
      if (hasStandaloneTftp) ev.push('tftpd binary or /srv/tftp dir');
      if (dnsmasqIsTftp) ev.push('dnsmasq with tftp-root= configured');
      detected.push({ kind: 'tftp_server', evidence: ev });
    }

    // PXE meta-hint when this clearly is a netboot setup.
    if ((dhcpActive && tftpActive) || (hasNetbootDir && (dhcpActive || tftpActive))) {
      detected.push({
        kind: 'pxe',
        evidence: ['DHCP + TFTP / netboot dir present — consider one combined `pxe` profile that wraps the whole stack rather than separate dhcp/tftp profiles.'],
      });
    }

    // Bare dnsmasq (not pi-hole, not playing a more specific role we already
    // emitted) — flag as a DNS resolver since that's its default mode.
    const dnsmasqPresent = has('binaries', 'dnsmasq') || has('paths', '/etc/dnsmasq.conf');
    const dnsmasqAlreadyExplained =
      detected.some(d => d.kind === 'pihole') || dnsmasqIsDhcp || dnsmasqIsTftp;
    if (dnsmasqPresent && !dnsmasqAlreadyExplained) {
      detected.push({ kind: 'dnsmasq', evidence: ['dnsmasq running as a DNS forwarder (no DHCP or TFTP role enabled)'] });
    }

    if (detected.length === 0) {
      yield { type: 'result', text: `No known services detected on "${node.hostname}".\n\nObserved listening ports: ${sections.ports.join(', ') || '(none)'}\nIf a service is here that the probe missed, you can still onboard it manually with profile_save.` };
      return;
    }

    const lines = [`Detected on "${node.hostname}":`];
    for (const d of detected) lines.push(`- **${d.kind}** — ${d.evidence.join(', ')}`);
    if (sections.ports.length) lines.push(`\n_Listening ports: ${sections.ports.join(', ')}_`);
    lines.push('\nNext: research each detected service, then call `profile_save` for it.');
    yield { type: 'result', text: lines.join('\n') };
    return;
  }

  yield { type: 'result', text: null };
}

export default executeSkillTool;
