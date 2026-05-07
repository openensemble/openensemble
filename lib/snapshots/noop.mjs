/**
 * `noop` mechanism — synthetic substrate for testing the dispatcher and
 * rollback pipeline without touching real services. Tests construct a `world`
 * Map, hand it to the dispatcher via ctx, and the noop handler reads/writes it.
 *
 * Two subtypes (set on opSpec.mechanism_subtype):
 *   - 'set'         — reversible. Captures (key, oldValue, hadKey) before write.
 *                     Restore puts oldValue back, or deletes if key was absent.
 *   - 'destructive' — irreversible. Returns no snapshot, dispatcher computes
 *                     risk_class='high' and rollback.method='manual'.
 *
 * Used by tests/op-dispatcher.test.mjs.
 */

import { writeSnapshotFile, readSnapshotFile, snapshotFileExists } from './util.mjs';

export const noop = {
  name: 'noop',

  minimumRisk(opSpec) {
    return opSpec.mechanism_subtype === 'destructive' ? 'high' : 'low';
  },

  async capture(opSpec, ctx) {
    if (opSpec.mechanism_subtype === 'destructive') return [];
    const { world, opId, userId, nodeId } = ctx;
    const key = opSpec.parameters?.key;
    const had = world.has(key);
    const oldValue = had ? world.get(key) : null;
    const payload = JSON.stringify({ key, had, oldValue });
    const file = writeSnapshotFile(userId, nodeId, opId, 'pre.json', payload);
    return [{
      type: 'noop_state',
      stored_at: file,
      size_bytes: Buffer.byteLength(payload),
      metadata: { key, had, oldValue },
    }];
  },

  async execute(opSpec, ctx) {
    const { world } = ctx;
    if (opSpec.mechanism_subtype === 'destructive') {
      world.clear();
      return { exit_code: 0, mechanism_response: { cleared: true } };
    }
    const { key, value } = opSpec.parameters || {};
    world.set(key, value);
    return { exit_code: 0, mechanism_response: { key, value } };
  },

  async restore(record, ctx) {
    if (record.operation.mechanism_subtype === 'destructive') {
      return { outcome: 'failure', message: 'destructive ops cannot be restored' };
    }
    const buf = readSnapshotFile(ctx.userId, ctx.nodeId, record.id, 'pre.json');
    const { key, had, oldValue } = JSON.parse(buf.toString('utf8'));
    if (had) {
      ctx.world.set(key, oldValue);
      return { outcome: 'success', message: `restored ${key} = ${JSON.stringify(oldValue)}` };
    }
    ctx.world.delete(key);
    return { outcome: 'success', message: `removed ${key}` };
  },

  async validate(record, ctx) {
    if (record.operation.mechanism_subtype === 'destructive') {
      return { valid: false, reason: 'destructive op has no snapshot' };
    }
    if (!snapshotFileExists(ctx.userId, ctx.nodeId, record.id, 'pre.json')) {
      return { valid: false, reason: 'snapshot file missing' };
    }
    return { valid: true };
  },
};
