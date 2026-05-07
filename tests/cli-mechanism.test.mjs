/**
 * Tests for the cli mechanism + capability dispatch through it.
 *
 * The cli mechanism is what makes profile-defined CLI ops (e.g.
 * pihole_restart, systemctl reload, apt install) runnable end-to-end with
 * the full audit + rollback story. Tests use an injected execFn — production
 * wires through node-exec-wrapper.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { dispatchOperation } from '../lib/op-dispatcher.mjs';
import { rollbackOperation } from '../lib/rollback.mjs';
import { dispatchCapabilityCall } from '../lib/capability-dispatcher.mjs';
import { saveProfile, markOperationVerified } from '../lib/service-profile.mjs';
import { readOpRecords, nodeDir, getRollbackStatus } from '../lib/op-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_clitest';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const intent = (text = 'cli test') => ({ user_text: text, agent: 'tester' });

// Mock execFn: keeps a tiny "world" recording start/stop state so we can
// assert reversibility.
function makeMockShell() {
  const state = { dnsRunning: true, history: [] };
  const execFn = async (command) => {
    state.history.push(command);
    if (command === 'pihole restartdns') {
      state.dnsRunning = true;
      return { stdout: 'DNS service restarted', stderr: '', exitCode: 0 };
    }
    if (command === 'systemctl stop pihole-FTL') {
      state.dnsRunning = false;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command === 'systemctl start pihole-FTL') {
      state.dnsRunning = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command === 'systemctl is-active pihole-FTL') {
      return { stdout: state.dnsRunning ? 'active' : 'inactive', stderr: '', exitCode: state.dnsRunning ? 0 : 3 };
    }
    if (command === 'cat /etc/pihole/regex.list') {
      return { stdout: '^ad-.*\\.example\\.com$\n', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('false-cmd')) {
      return { stdout: '', stderr: 'something failed', exitCode: 1 };
    }
    return { stdout: '', stderr: 'unknown', exitCode: 127 };
  };
  return { state, execFn };
}

// ── direct dispatcher tests ─────────────────────────────────────────────────

describe('cli mechanism — direct op-dispatcher', () => {
  it('runs a simple cli op with no inverse → high risk + rollback unavailable', async () => {
    const { execFn } = makeMockShell();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'pihole_restart', mechanism: 'cli',
        parameters: {},
        declared_risk: 'medium',
        write: { command: 'pihole restartdns' },
      },
      ctx: { execFn },
    });
    expect(record.outcome).toBe('success');
    expect(record.operation.risk_class).toBe('high'); // no snapshot escalates
    expect(record.rollback.available).toBe(false);
    expect(record.rollback.method).toBe('manual');
  });

  it('cli op WITH inverse becomes rollback-eligible', async () => {
    const shell = makeMockShell();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('stop pihole-FTL'),
      opSpec: {
        id: 'systemctl_stop', mechanism: 'cli',
        parameters: {},
        declared_risk: 'medium',
        write:   { command: 'systemctl stop pihole-FTL' },
        inverse: { command: 'systemctl start pihole-FTL' },
      },
      ctx: { execFn: shell.execFn },
    });
    expect(record.outcome).toBe('success');
    expect(record.rollback.available).toBe(true);
    expect(record.rollback.method).toBe('cli');
    expect(shell.state.dnsRunning).toBe(false);

    // Roll back → service back up
    const rb = await rollbackOperation({
      userId: USER, nodeId: NODE, opId: record.id,
      intent: intent('undo'),
      ctx: { execFn: shell.execFn },
    });
    expect(rb.outcome).toBe('success');
    expect(shell.state.dnsRunning).toBe(true);
    expect(getRollbackStatus(USER, NODE, record.id).invoked).toBe(true);
  });

  it('records pre_capture stdout when defined', async () => {
    const { execFn } = makeMockShell();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'inspect_regex', mechanism: 'cli',
        parameters: {},
        declared_risk: 'low',
        pre_capture: { command: 'cat /etc/pihole/regex.list' },
        write:       { command: 'pihole restartdns' }, // any write
      },
      ctx: { execFn },
    });
    expect(record.pre_state.snapshots).toHaveLength(1);
    expect(record.pre_state.snapshots[0].type).toBe('cli_capture');
  });

  it('records non-zero exit as failure with stderr_tail', async () => {
    const { execFn } = makeMockShell();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'doomed', mechanism: 'cli',
        parameters: {},
        declared_risk: 'low',
        write: { command: 'false-cmd asdf' },
      },
      ctx: { execFn },
    });
    expect(record.outcome).toBe('failure');
    expect(record.execution.exit_code).toBe(1);
    expect(record.execution.stderr_tail).toMatch(/something failed/);
  });

  it('throws cleanly when execFn is missing', async () => {
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'x', mechanism: 'cli',
        parameters: {}, declared_risk: 'low',
        write: { command: 'echo hi' },
      },
      ctx: {}, // no execFn
    });
    expect(record.outcome).toBe('failure');
    expect(record.execution.error).toMatch(/execFn/);
  });
});

// ── through capability-dispatcher (profile-driven) ───────────────────────────

describe('cli mechanism — via capability-dispatcher', () => {
  it('dispatches profile.cli operations with template substitution', async () => {
    const profile = JSON.parse(JSON.stringify(PIHOLE));
    // Override pihole_restart with an inverse so we can prove rollback works
    const op = profile.operations.find(o => o.id === 'pihole_restart');
    op.cli = {
      write:   { command: 'pihole restartdns' },
      inverse: { command: 'systemctl start pihole-FTL' },
    };
    saveProfile(USER, NODE, profile);
    markOperationVerified(USER, NODE, 'pihole', 'pihole_restart', true);

    const shell = makeMockShell();
    const result = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'pihole_restart',
      parameters: {},
      intent: intent('restart pihole'),
      ctx: { execFn: shell.execFn, auth_override: 'good' },
    });
    expect(result.error).toBeNull();
    expect(result.record.outcome).toBe('success');
    expect(result.record.operation.mechanism).toBe('cli');
    expect(shell.state.history).toContain('pihole restartdns');

    const records = readOpRecords(USER, NODE);
    expect(records).toHaveLength(1);
    expect(records[0].rollback.available).toBe(true); // because inverse defined
  });

  it('substitutes parameters into cli templates', async () => {
    const profile = JSON.parse(JSON.stringify(PIHOLE));
    profile.operations.push({
      id: 'tail_log', capability: null,
      description: 'tail an arbitrary log file',
      mechanism: 'cli', risk: 'low', readonly: true,
      parameters: [{ name: 'path', type: 'string', required: true, example: '/var/log/syslog' }],
      cli: { write: { command: 'cat ${path}' } },
      verified: false, last_tested: null, last_failure: null,
    });
    saveProfile(USER, NODE, profile);

    const seen = [];
    const execFn = async (cmd) => {
      seen.push(cmd);
      return { stdout: 'log content', stderr: '', exitCode: 0 };
    };

    const result = await dispatchCapabilityCall({
      userId: USER, nodeId: NODE, serviceId: 'pihole', opId: 'tail_log',
      parameters: { path: '/etc/pihole/regex.list' },
      intent: intent('tail regex list'),
      ctx: { execFn, auth_override: '' },
    });
    expect(result.record.outcome).toBe('success');
    expect(seen).toEqual(['cat /etc/pihole/regex.list']);
  });
});
