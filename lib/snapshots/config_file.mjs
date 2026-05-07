/**
 * `config_file` mechanism — edit configuration files on a remote node and
 * run a reload command. The remote-file machinery goes through the injected
 * execFn (production: skills/nodes/sendCommand wrapper).
 *
 * opSpec shape (capability-dispatcher fills these from profile.config_file):
 *   {
 *     mechanism: 'config_file',
 *     parameters: { ... },
 *     write: {
 *       files: [{ path: '/etc/nginx/conf.d/foo.conf', content: '<full new content>' }],
 *       reload_cmd: 'systemctl reload nginx',
 *       pre_validate_cmd: 'nginx -t -c /tmp/staged.conf'  // optional, NOT yet wired
 *     },
 *     pre_capture: { paths: ['/etc/nginx/conf.d/foo.conf'] }   // optional; defaults to write.files paths
 *   }
 *
 * Snapshot strategy:
 *   capture — read each file via `cat | base64`, store as JSON manifest of
 *             {path, content_b64} per file. This IS the rollback fuel; no
 *             separate `inverse` is needed (or used).
 *   execute — for each file, base64-decode the new content into the path
 *             via `cat <<EOF | base64 -d > path`. Then run reload_cmd if set.
 *   restore — for each file in the snapshot, write the captured content back,
 *             then run reload_cmd if it was set on the original op.
 *
 * Files that don't exist pre-write are recorded with `existed: false` and
 * the restore step deletes them rather than restoring "(no content)".
 *
 * Binary files: base64 round-trips them transparently. UTF-8 isn't assumed;
 * the wire format is bytes via Node's Buffer.
 */

import fs from 'fs';
import { writeSnapshotFile } from './util.mjs';

const HEREDOC_TAG = '__OE_CFG_EOF__';
const READ_TIMEOUT_SEC = 60;
const WRITE_TIMEOUT_SEC = 60;

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function readRemoteFile(execFn, path) {
  // `test -f` first so we can distinguish "file absent" (legitimate pre-state
  // for a brand-new config) from "read failed" (transient error).
  const exists = await execFn(`test -e ${shellQuote(path)} && echo present || echo absent`, { timeout: READ_TIMEOUT_SEC });
  if (exists.stdout.trim() === 'absent') return { existed: false, content_b64: null };

  // -w 0 = no line wrapping. Most distros' base64 supports it; fall back to
  // unwrapped + tr if not. (Pi-hole's Debian, Ubuntu, RHEL all support -w.)
  const res = await execFn(`base64 -w 0 ${shellQuote(path)}`, { timeout: READ_TIMEOUT_SEC });
  if (res.exitCode !== 0) {
    // Fallback for distros where -w 0 isn't supported
    const fallback = await execFn(`base64 ${shellQuote(path)} | tr -d '\\n'`, { timeout: READ_TIMEOUT_SEC });
    if (fallback.exitCode !== 0) {
      throw new Error(`read ${path} failed: ${(res.stderr || fallback.stderr || '').slice(0, 200)}`);
    }
    return { existed: true, content_b64: fallback.stdout.trim() };
  }
  return { existed: true, content_b64: res.stdout.trim() };
}

async function writeRemoteFile(execFn, path, contentB64) {
  // Heredoc with quoted tag prevents variable expansion in content.
  // base64 ignores embedded newlines so wrapping is fine; we don't pre-wrap.
  const cmd = `cat <<'${HEREDOC_TAG}' | base64 -d > ${shellQuote(path)}\n${contentB64}\n${HEREDOC_TAG}`;
  const res = await execFn(cmd, { timeout: WRITE_TIMEOUT_SEC });
  if (res.exitCode !== 0) {
    throw new Error(`write ${path} failed: ${(res.stderr || '').slice(0, 200)}`);
  }
}

async function deleteRemoteFile(execFn, path) {
  const res = await execFn(`rm -f ${shellQuote(path)}`, { timeout: READ_TIMEOUT_SEC });
  if (res.exitCode !== 0) {
    throw new Error(`rm ${path} failed: ${(res.stderr || '').slice(0, 200)}`);
  }
}

export const config_file = {
  name: 'config_file',

  minimumRisk() { return 'low'; },

  async capture(opSpec, ctx) {
    if (!ctx.execFn) throw new Error('config_file mechanism requires ctx.execFn');

    // Default pre_capture to the same paths the write touches.
    const pathsToCapture = opSpec.pre_capture?.paths
      ?? (opSpec.write?.files || []).map(f => f.path);

    if (pathsToCapture.length === 0) return [];

    const captured = [];
    for (const p of pathsToCapture) {
      const r = await readRemoteFile(ctx.execFn, p);
      captured.push({ path: p, existed: r.existed, content_b64: r.content_b64 });
    }

    // Carry the reload command into the snapshot so restore knows how to
    // re-apply state without re-consulting the original opSpec.
    const manifest = {
      files: captured,
      reload_cmd: opSpec.write?.reload_cmd || null,
    };
    const payload = JSON.stringify(manifest);
    const file = writeSnapshotFile(ctx.userId, ctx.nodeId, ctx.opId, 'cfg.json', payload);
    return [{
      type: 'config_file',
      stored_at: file,
      size_bytes: Buffer.byteLength(payload),
      metadata: { paths: pathsToCapture, reload_cmd: manifest.reload_cmd },
    }];
  },

  async execute(opSpec, ctx) {
    if (!ctx.execFn) throw new Error('config_file mechanism requires ctx.execFn');
    const files = opSpec.write?.files || [];
    if (!files.length) throw new Error('config_file.execute: write.files empty');

    const written = [];
    for (const f of files) {
      if (typeof f.content !== 'string') {
        throw new Error(`config_file: files[].content must be string for path ${f.path}`);
      }
      const b64 = Buffer.from(f.content, 'utf8').toString('base64');
      await writeRemoteFile(ctx.execFn, f.path, b64);
      written.push(f.path);
    }

    let reloaded = null;
    if (opSpec.write?.reload_cmd) {
      const r = await ctx.execFn(opSpec.write.reload_cmd, { timeout: WRITE_TIMEOUT_SEC });
      reloaded = { command: opSpec.write.reload_cmd, exit_code: r.exitCode, stdout_tail: (r.stdout || '').slice(-300), stderr_tail: (r.stderr || '').slice(-300) };
      if (r.exitCode !== 0) {
        return {
          exit_code: r.exitCode,
          mechanism_response: { written, reloaded, reload_failed: true },
          stderr_tail: r.stderr?.slice(-500) || null,
        };
      }
    }

    return {
      exit_code: 0,
      mechanism_response: { written, reloaded },
    };
  },

  async restore(record, ctx) {
    if (!ctx.execFn) return { outcome: 'failure', message: 'restore requires ctx.execFn' };
    const snap = record.pre_state.snapshots?.find(s => s.type === 'config_file');
    if (!snap) return { outcome: 'failure', message: 'no config_file snapshot to restore' };

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(snap.stored_at, 'utf8'));
    } catch (e) {
      return { outcome: 'failure', message: `snapshot read failed: ${e.message}` };
    }

    const restored = [];
    for (const f of manifest.files) {
      if (f.existed) {
        await writeRemoteFile(ctx.execFn, f.path, f.content_b64);
        restored.push(`wrote ${f.path}`);
      } else {
        // File didn't exist before — undo by deleting whatever we wrote.
        try { await deleteRemoteFile(ctx.execFn, f.path); restored.push(`deleted ${f.path}`); }
        catch (e) { return { outcome: 'failure', message: `delete ${f.path} failed: ${e.message}` }; }
      }
    }

    if (manifest.reload_cmd) {
      const r = await ctx.execFn(manifest.reload_cmd, { timeout: WRITE_TIMEOUT_SEC });
      if (r.exitCode !== 0) {
        return { outcome: 'failure', message: `reload after restore failed: ${(r.stderr || '').slice(0, 200)}` };
      }
    }

    return { outcome: 'success', message: `restored ${manifest.files.length} file(s); ${restored.join(', ')}` };
  },

  async validate(record) {
    const snap = record.pre_state.snapshots?.find(s => s.type === 'config_file');
    if (!snap) return { valid: false, reason: 'no config_file snapshot' };
    if (!fs.existsSync(snap.stored_at)) return { valid: false, reason: 'snapshot file missing' };
    return { valid: true };
  },
};
