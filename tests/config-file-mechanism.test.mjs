/**
 * Tests for the config_file mechanism — capture, execute, rollback,
 * including the "file did not exist before" edge case.
 *
 * Uses an in-memory fake filesystem driven by a synthetic execFn so the
 * mechanism's shell commands (cat, base64, heredoc, rm) are exercised
 * without touching a real node.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';

import { dispatchOperation } from '../lib/op-dispatcher.mjs';
import { rollbackOperation } from '../lib/rollback.mjs';
import { dispatchCapabilityCall } from '../lib/capability-dispatcher.mjs';
import { saveProfile } from '../lib/service-profile.mjs';
import { readOpRecords, nodeDir, getRollbackStatus } from '../lib/op-record.mjs';

const USER = 'user_cfgtest';
const NODE = 'nginx-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const intent = (text = 'cfg test') => ({ user_text: text, agent: 'tester' });

// ── synthetic remote shell + filesystem ──────────────────────────────────────
//
// Implements the subset of shell our config_file mechanism actually uses:
//   - test -e <path> && echo present || echo absent
//   - base64 -w 0 <path>
//   - cat <<TAG | base64 -d > <path>\n<b64>\nTAG
//   - rm -f <path>
//   - any "reload" command we whitelist
//
// Returns the same {stdout, stderr, exitCode} shape as makeNodeExecFn.
function makeFakeShell(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles)); // path → content (utf8 string)
  const reloadHistory = [];

  const execFn = async (command) => {
    // test -e
    let m = command.match(/^test -e '([^']+)' && echo present \|\| echo absent$/);
    if (m) {
      return { stdout: files.has(m[1]) ? 'present' : 'absent', stderr: '', exitCode: 0 };
    }

    // base64 -w 0 <path>
    m = command.match(/^base64 -w 0 '([^']+)'$/);
    if (m) {
      if (!files.has(m[1])) return { stdout: '', stderr: 'No such file', exitCode: 1 };
      const b64 = Buffer.from(files.get(m[1]), 'utf8').toString('base64');
      return { stdout: b64, stderr: '', exitCode: 0 };
    }

    // base64 <path> | tr -d '\n'  (fallback)
    m = command.match(/^base64 '([^']+)' \| tr -d '\\n'$/);
    if (m) {
      if (!files.has(m[1])) return { stdout: '', stderr: 'No such file', exitCode: 1 };
      const b64 = Buffer.from(files.get(m[1]), 'utf8').toString('base64');
      return { stdout: b64, stderr: '', exitCode: 0 };
    }

    // cat <<TAG | base64 -d > path\n<b64>\nTAG
    m = command.match(/^cat <<'__OE_CFG_EOF__' \| base64 -d > '([^']+)'\n([\s\S]+?)\n__OE_CFG_EOF__$/);
    if (m) {
      const b64 = m[2].trim();
      let decoded;
      try { decoded = Buffer.from(b64, 'base64').toString('utf8'); }
      catch { return { stdout: '', stderr: 'invalid base64', exitCode: 1 }; }
      files.set(m[1], decoded);
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // rm -f <path>
    m = command.match(/^rm -f '([^']+)'$/);
    if (m) {
      files.delete(m[1]);
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // reload commands we recognize
    if (command === 'systemctl reload nginx' || command === 'systemctl reload pihole-FTL') {
      reloadHistory.push(command);
      return { stdout: 'reloaded', stderr: '', exitCode: 0 };
    }
    if (command === 'reload-fail') {
      return { stdout: '', stderr: 'reload broke', exitCode: 1 };
    }

    return { stdout: '', stderr: `unknown command: ${command}`, exitCode: 127 };
  };

  return { execFn, files, reloadHistory };
}

// ── direct dispatcher tests ─────────────────────────────────────────────────

describe('config_file mechanism — direct op-dispatcher', () => {
  it('captures, writes, and rolls back a single file', async () => {
    const shell = makeFakeShell({
      '/etc/nginx/conf.d/foo.conf': 'server { listen 80; }\n',
    });

    const newContent = 'server { listen 8080; }\n';

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'nginx',
      intent: intent('change listen port'),
      opSpec: {
        id: 'edit_foo_conf', mechanism: 'config_file',
        parameters: {},
        declared_risk: 'medium',
        write: {
          files: [{ path: '/etc/nginx/conf.d/foo.conf', content: newContent }],
          reload_cmd: 'systemctl reload nginx',
        },
      },
      ctx: { execFn: shell.execFn },
    });

    expect(record.outcome).toBe('success');
    expect(record.rollback.available).toBe(true);
    expect(record.rollback.method).toBe('config_file');
    expect(record.pre_state.snapshots).toHaveLength(1);
    expect(record.pre_state.snapshots[0].type).toBe('config_file');

    // File on the fake node is updated; reload ran.
    expect(shell.files.get('/etc/nginx/conf.d/foo.conf')).toBe(newContent);
    expect(shell.reloadHistory).toEqual(['systemctl reload nginx']);

    // Rollback restores the original + reloads again
    const rb = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'),
      ctx: { execFn: shell.execFn },
    });
    expect(rb.outcome).toBe('success');
    expect(shell.files.get('/etc/nginx/conf.d/foo.conf')).toBe('server { listen 80; }\n');
    expect(shell.reloadHistory).toEqual(['systemctl reload nginx', 'systemctl reload nginx']);
    expect(getRollbackStatus(USER, NODE, record.id).invoked).toBe(true);
  });

  it('handles "file did not exist before" — rollback deletes the new file', async () => {
    const shell = makeFakeShell(); // empty filesystem

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'nginx',
      intent: intent('add new vhost'),
      opSpec: {
        id: 'add_vhost', mechanism: 'config_file',
        parameters: {},
        declared_risk: 'low',
        write: {
          files: [{ path: '/etc/nginx/conf.d/new.conf', content: 'server { listen 9000; }' }],
          reload_cmd: 'systemctl reload nginx',
        },
      },
      ctx: { execFn: shell.execFn },
    });

    expect(record.outcome).toBe('success');
    expect(record.rollback.available).toBe(true);
    expect(shell.files.get('/etc/nginx/conf.d/new.conf')).toBe('server { listen 9000; }');
    // Snapshot manifest should record `existed: false` for that file.
    const snap = JSON.parse(fs.readFileSync(record.pre_state.snapshots[0].stored_at, 'utf8'));
    expect(snap.files[0].existed).toBe(false);

    await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'),
      ctx: { execFn: shell.execFn },
    });
    expect(shell.files.has('/etc/nginx/conf.d/new.conf')).toBe(false);
  });

  it('handles multiple files atomically (all written, all rolled back)', async () => {
    const shell = makeFakeShell({
      '/etc/a': 'old-a',
      '/etc/b': 'old-b',
    });

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'nginx',
      intent: intent('multi-file edit'),
      opSpec: {
        id: 'multi', mechanism: 'config_file',
        parameters: {},
        declared_risk: 'medium',
        write: {
          files: [
            { path: '/etc/a', content: 'new-a' },
            { path: '/etc/b', content: 'new-b' },
          ],
        },
      },
      ctx: { execFn: shell.execFn },
    });

    expect(record.outcome).toBe('success');
    expect(shell.files.get('/etc/a')).toBe('new-a');
    expect(shell.files.get('/etc/b')).toBe('new-b');

    await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'),
      ctx: { execFn: shell.execFn },
    });
    expect(shell.files.get('/etc/a')).toBe('old-a');
    expect(shell.files.get('/etc/b')).toBe('old-b');
  });

  it('reports failure when reload_cmd returns non-zero', async () => {
    const shell = makeFakeShell({ '/etc/x': 'old' });

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'nginx',
      intent: intent(),
      opSpec: {
        id: 'edit_with_bad_reload', mechanism: 'config_file',
        parameters: {}, declared_risk: 'medium',
        write: {
          files: [{ path: '/etc/x', content: 'new' }],
          reload_cmd: 'reload-fail',
        },
      },
      ctx: { execFn: shell.execFn },
    });
    expect(record.outcome).toBe('failure');
    // File got written before reload failed — that's fine, snapshot still
    // covers it so rollback recovers state.
    expect(shell.files.get('/etc/x')).toBe('new');

    // Failed ops aren't rollback-eligible by default, but the snapshot is
    // still on disk — surgical recovery is a manual step the user can do.
    expect(record.rollback.available).toBe(false);
  });

  it('handles content with newlines and special chars cleanly', async () => {
    const shell = makeFakeShell({ '/etc/messy': 'old' });
    const messy = 'line 1\nline 2 with \'quotes\'\nline 3 with $variables and `backticks`\n';

    await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'nginx',
      intent: intent(),
      opSpec: {
        id: 'messy', mechanism: 'config_file',
        parameters: {}, declared_risk: 'low',
        write: { files: [{ path: '/etc/messy', content: messy }] },
      },
      ctx: { execFn: shell.execFn },
    });
    expect(shell.files.get('/etc/messy')).toBe(messy);
  });

  it('throws cleanly when execFn missing', async () => {
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'nginx',
      intent: intent(),
      opSpec: {
        id: 'no_exec', mechanism: 'config_file',
        parameters: {}, declared_risk: 'low',
        write: { files: [{ path: '/etc/x', content: 'y' }] },
      },
      ctx: {},
    });
    expect(record.outcome).toBe('failure');
    expect(record.execution.error).toMatch(/execFn/);
  });
});

// ── via capability-dispatcher (profile-driven) ───────────────────────────────

describe('config_file mechanism — via capability-dispatcher', () => {
  it('dispatches profile.config_file ops with template substitution', async () => {
    // Hand-roll a minimal nginx profile.
    const profile = {
      service_id: 'nginx',
      node_id: NODE,
      identity: { what_it_is: 'reverse proxy', primary_value: 'edge', related_capabilities: ['reverse_proxy'] },
      control_surface: {
        api: null,
        config_files: [{ path: '/etc/nginx/conf.d/${name}.conf', format: 'nginx', owner_user: 'root' }],
        cli: ['nginx'],
        services: ['nginx.service'],
        log_sources: [],
      },
      operations: [{
        id: 'add_vhost',
        capability: 'reverse_proxy',
        description: 'Add an nginx vhost.',
        mechanism: 'config_file',
        risk: 'medium',
        readonly: false,
        parameters: [
          { name: 'name', type: 'string', required: true },
          { name: 'content', type: 'string', required: true },
        ],
        config_file: {
          write: {
            files: [{ path: '/etc/nginx/conf.d/${name}.conf', content: '${content}' }],
            reload_cmd: 'systemctl reload nginx',
          },
        },
        verified: false,
        last_tested: null,
        last_failure: null,
      }],
      health_signals: [],
      diagnostic_recipes: {},
      failure_modes: [],
      troubleshooting: [],
      update_path: null,
      backup_before: [],
      known_quirks: [],
      trust_state: 'reviewed',
      trust_state_changed_at: new Date().toISOString(),
      trust_state_changed_by: USER,
      research_sources: [],
      detected_version: null,
      endpoint: null,
    };
    saveProfile(USER, NODE, profile);

    const shell = makeFakeShell();

    const result = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'nginx', opId: 'add_vhost',
      parameters: { name: 'foo', content: 'server { listen 80; }' },
      intent: intent('add foo vhost'),
      ctx: { execFn: shell.execFn },
    });

    expect(result.error).toBeNull();
    expect(result.record.outcome).toBe('success');
    expect(shell.files.get('/etc/nginx/conf.d/foo.conf')).toBe('server { listen 80; }');
    expect(shell.reloadHistory).toEqual(['systemctl reload nginx']);

    // Activity log captured it
    const records = readOpRecords(USER, NODE);
    expect(records).toHaveLength(1);
    expect(records[0].rollback.available).toBe(true);
  });
});
