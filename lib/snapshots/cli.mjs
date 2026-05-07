/**
 * `cli` mechanism — operations expressed as shell commands run on a remote
 * node via the injected execFn (see lib/node-exec-wrapper.mjs in production).
 *
 * opSpec shape (capability-dispatcher fills these from profile.cli):
 *   {
 *     mechanism: 'cli',
 *     parameters: { ... },
 *     write:   { command: 'pihole restartdns' },
 *     inverse: { command: 'pihole disable' }   // optional
 *     pre_capture: { command: '...' }          // optional
 *   }
 *
 * Snapshot strategy:
 *   - With `pre_capture`: run the read command, save stdout as op_<id>.pre.txt.
 *     This is audit-only — rollback uses inverse, not the stdout.
 *   - Without `pre_capture` and without `inverse`: no snapshot. Dispatcher
 *     escalates risk to 'high' and rollback.method becomes 'manual'. That's
 *     correct: a freeform shell command without a defined inverse is by
 *     definition not auto-reversible.
 *
 * Execute reports stdout/stderr tails on the op record. Exit-code 0 = success.
 */

import { writeSnapshotFile } from './util.mjs';

const TAIL_BYTES = 500;

function tail(s, n = TAIL_BYTES) {
  if (!s) return null;
  return s.length > n ? s.slice(-n) : s;
}

export const cli = {
  name: 'cli',

  // CLI mechanism doesn't impose a risk floor by itself — the dispatcher
  // already escalates to 'high' when no snapshot can be captured AND no
  // inverse is defined. That covers the freeform-no-rollback case correctly.
  minimumRisk() { return 'low'; },

  async capture(opSpec, ctx) {
    if (!opSpec.pre_capture?.command) return [];
    if (!ctx.execFn) {
      throw new Error('cli mechanism requires ctx.execFn for pre_capture');
    }
    const res = await ctx.execFn(opSpec.pre_capture.command);
    const payload = JSON.stringify({
      pre_capture: opSpec.pre_capture,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      exitCode: res.exitCode,
    });
    const file = writeSnapshotFile(ctx.userId, ctx.nodeId, ctx.opId, 'pre.json', payload);
    return [{
      type: 'cli_capture',
      stored_at: file,
      size_bytes: Buffer.byteLength(payload),
      metadata: { command: opSpec.pre_capture.command, exitCode: res.exitCode },
    }];
  },

  async execute(opSpec, ctx) {
    if (!opSpec.write?.command) throw new Error('cli.execute: opSpec.write.command missing');
    if (!ctx.execFn) throw new Error('cli mechanism requires ctx.execFn');
    const res = await ctx.execFn(opSpec.write.command);
    return {
      exit_code: res.exitCode,
      mechanism_response: { command: opSpec.write.command, exitCode: res.exitCode },
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  },

  async restore(record, ctx) {
    const inv = record.rollback?.inverse_call;
    if (!inv?.command) return { outcome: 'failure', message: 'no inverse command recorded' };
    if (!ctx.execFn) return { outcome: 'failure', message: 'restore requires ctx.execFn' };
    const res = await ctx.execFn(inv.command);
    if (res.exitCode !== 0) {
      return {
        outcome: 'failure',
        message: `inverse "${inv.command}" exit=${res.exitCode}: ${(res.stderr || '').slice(0, 200)}`,
      };
    }
    return { outcome: 'success', message: `ran inverse "${inv.command}"` };
  },

  async validate(record) {
    if (!record.rollback?.inverse_call?.command) {
      return { valid: false, reason: 'no inverse command recorded' };
    }
    return { valid: true };
  },
};
