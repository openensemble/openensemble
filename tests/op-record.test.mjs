import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import {
  generateOpId,
  buildOpRecord,
  validateOpRecord,
  writeOpRecord,
  readOpRecords,
  findOpRecord,
  getRollbackStatus,
  pinSnapshot,
  unpinSnapshot,
  isPinned,
  listPinned,
  nodeDir,
  activityLogPath,
  ensureNodeDir,
  OpRecordValidationError,
  constants,
} from '../lib/op-record.mjs';

const USER = 'user_optest';
const NODE = 'pihole-test';

// vitest.config sets NODE_ENV=test → BASE_DIR redirects to a per-process tmp,
// cleaned up at exit. Each test gets a fresh node dir so there's no bleed.
beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

function baseInput(overrides = {}) {
  return {
    node_id: NODE,
    intent: { user_text: 'block ads on doubleclick.net', agent: 'coordinator' },
    operation: {
      id: 'dns_block',
      mechanism: 'http',
      risk_class: 'low',
      parameters: { domain: 'doubleclick.net' },
    },
    pre_state: { snapshots: [] },
    execution: { exit_code: 0 },
    outcome: 'success',
    rollback: { available: false, method: 'none' },
    ...overrides,
  };
}

describe('generateOpId', () => {
  it('produces ids starting with op_ and embedding the timestamp', () => {
    const id = generateOpId(Date.UTC(2026, 4, 6, 14, 23, 9));
    expect(id).toMatch(/^op_2026-05-06T14-23-09-000Z_[0-9a-f]{6}$/);
  });

  it('is monotonically sortable by timestamp', () => {
    const a = generateOpId(1000);
    const b = generateOpId(2000);
    expect(a < b).toBe(true);
  });
});

describe('validateOpRecord', () => {
  it('accepts a minimal valid record', () => {
    const rec = buildOpRecord(baseInput());
    expect(() => validateOpRecord(rec)).not.toThrow();
  });

  it('rejects missing top-level fields', () => {
    expect(() => validateOpRecord({})).toThrow(OpRecordValidationError);
  });

  it('rejects unknown mechanism', () => {
    expect(() => buildOpRecord(baseInput({
      operation: { id: 'x', mechanism: 'bogus', risk_class: 'low' },
    }))).toThrow(/mechanism/);
  });

  it('rejects unknown outcome', () => {
    expect(() => buildOpRecord(baseInput({ outcome: 'mostly-ok' }))).toThrow(/outcome/);
  });

  it('rejects unknown risk_class', () => {
    expect(() => buildOpRecord(baseInput({
      operation: { id: 'x', mechanism: 'http', risk_class: 'apocalyptic' },
    }))).toThrow(/risk_class/);
  });

  it('rejects rollback.available=true with method=manual', () => {
    expect(() => buildOpRecord(baseInput({
      rollback: { available: true, method: 'manual' },
    }))).toThrow(/manual/);
  });

  it('rejects rollback.available=true with method=none', () => {
    expect(() => buildOpRecord(baseInput({
      rollback: { available: true, method: 'none' },
    }))).toThrow(/none/);
  });

  it('rejects malformed ts', () => {
    expect(() => validateOpRecord({ ...buildOpRecord(baseInput()), ts: 'not-a-date' }))
      .toThrow(/ts/);
  });
});

describe('buildOpRecord defaults', () => {
  it('fills schema_version + ts + id when omitted', () => {
    const rec = buildOpRecord(baseInput());
    expect(rec.schema_version).toBe(constants.SCHEMA_VERSION);
    expect(rec.id).toMatch(/^op_/);
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects an explicit id and ts', () => {
    const rec = buildOpRecord(baseInput({ id: 'op_custom_xyz', ts: '2026-01-01T00:00:00.000Z' }));
    expect(rec.id).toBe('op_custom_xyz');
    expect(rec.ts).toBe('2026-01-01T00:00:00.000Z');
  });

  it('sets default rollback expiry ~30 days out when not specified', () => {
    const now = Date.now();
    const rec = buildOpRecord(baseInput());
    const exp = new Date(rec.rollback.expires_at).getTime();
    const days = (exp - now) / 86400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('preserves rolls_back_op_id when set (rollback ops)', () => {
    const rec = buildOpRecord(baseInput({ rolls_back_op_id: 'op_original_xyz' }));
    expect(rec.rolls_back_op_id).toBe('op_original_xyz');
  });
});

describe('writeOpRecord + readOpRecords', () => {
  it('appends a record and reads it back', () => {
    const rec = buildOpRecord(baseInput());
    writeOpRecord(USER, NODE, rec);

    const all = readOpRecords(USER, NODE);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(rec.id);
    expect(all[0].operation.parameters.domain).toBe('doubleclick.net');
  });

  it('preserves write order across multiple appends', () => {
    const a = buildOpRecord(baseInput({ ts: '2026-01-01T00:00:00.000Z' }));
    const b = buildOpRecord(baseInput({ ts: '2026-01-02T00:00:00.000Z' }));
    const c = buildOpRecord(baseInput({ ts: '2026-01-03T00:00:00.000Z' }));
    writeOpRecord(USER, NODE, a);
    writeOpRecord(USER, NODE, b);
    writeOpRecord(USER, NODE, c);

    const all = readOpRecords(USER, NODE);
    expect(all.map(r => r.id)).toEqual([a.id, b.id, c.id]);
  });

  it('returns [] for a node with no activity log', () => {
    expect(readOpRecords(USER, 'nonexistent-node')).toEqual([]);
  });

  it('filters by since/until', () => {
    writeOpRecord(USER, NODE, buildOpRecord(baseInput({ ts: '2026-01-01T00:00:00.000Z' })));
    writeOpRecord(USER, NODE, buildOpRecord(baseInput({ ts: '2026-01-02T00:00:00.000Z' })));
    writeOpRecord(USER, NODE, buildOpRecord(baseInput({ ts: '2026-01-03T00:00:00.000Z' })));

    const filtered = readOpRecords(USER, NODE, {
      since: '2026-01-02T00:00:00.000Z',
      until: '2026-01-02T23:59:59.000Z',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].ts).toBe('2026-01-02T00:00:00.000Z');
  });

  it('skips malformed lines without crashing', () => {
    ensureNodeDir(USER, NODE);
    fs.appendFileSync(activityLogPath(USER, NODE), '{not valid json}\n');
    writeOpRecord(USER, NODE, buildOpRecord(baseInput()));
    fs.appendFileSync(activityLogPath(USER, NODE), 'another bad line\n');

    const all = readOpRecords(USER, NODE);
    expect(all).toHaveLength(1);
  });

  it('rejects writing a record that fails validation', () => {
    expect(() => writeOpRecord(USER, NODE, { id: 'bad' })).toThrow(OpRecordValidationError);
  });
});

describe('immutability invariant', () => {
  it('appending never rewrites previous lines', () => {
    const rec1 = buildOpRecord(baseInput());
    writeOpRecord(USER, NODE, rec1);
    const before = fs.readFileSync(activityLogPath(USER, NODE), 'utf8');

    const rec2 = buildOpRecord(baseInput({ intent: { user_text: 'second op' } }));
    writeOpRecord(USER, NODE, rec2);
    const after = fs.readFileSync(activityLogPath(USER, NODE), 'utf8');

    // The prefix of `after` must equal `before` (append-only).
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });
});

describe('findOpRecord', () => {
  it('finds a record by id', () => {
    const a = buildOpRecord(baseInput());
    const b = buildOpRecord(baseInput());
    writeOpRecord(USER, NODE, a);
    writeOpRecord(USER, NODE, b);

    expect(findOpRecord(USER, NODE, a.id).id).toBe(a.id);
    expect(findOpRecord(USER, NODE, b.id).id).toBe(b.id);
  });

  it('returns null for unknown id', () => {
    writeOpRecord(USER, NODE, buildOpRecord(baseInput()));
    expect(findOpRecord(USER, NODE, 'op_does_not_exist')).toBeNull();
  });
});

describe('getRollbackStatus', () => {
  it('reports an op as not-yet-rolled-back when no rollback op exists', () => {
    const orig = buildOpRecord(baseInput({
      rollback: { available: true, method: 'http', inverse_call: { method: 'GET', url: 'http://x' } },
    }));
    writeOpRecord(USER, NODE, orig);

    const status = getRollbackStatus(USER, NODE, orig.id);
    expect(status.exists).toBe(true);
    expect(status.invoked).toBe(false);
    expect(status.available).toBe(true);
    expect(status.method).toBe('http');
  });

  it('marks the original as invoked + unavailable once a successful rollback op references it', () => {
    const orig = buildOpRecord(baseInput({
      rollback: { available: true, method: 'http', inverse_call: { method: 'GET', url: 'http://x' } },
    }));
    writeOpRecord(USER, NODE, orig);

    const rb = buildOpRecord(baseInput({
      rolls_back_op_id: orig.id,
      intent: { user_text: 'undo', agent: 'coordinator' },
      operation: { id: 'rollback_' + orig.id, mechanism: 'http', risk_class: 'low' },
      outcome: 'success',
      ts: new Date(Date.now() + 1000).toISOString(),
    }));
    writeOpRecord(USER, NODE, rb);

    const status = getRollbackStatus(USER, NODE, orig.id);
    expect(status.invoked).toBe(true);
    expect(status.invocation_op_id).toBe(rb.id);
    expect(status.invocation_outcome).toBe('success');
    expect(status.available).toBe(false); // surgically rolled back, can't redo
  });

  it('keeps available=true when the rollback op itself failed', () => {
    const orig = buildOpRecord(baseInput({
      rollback: { available: true, method: 'http', inverse_call: { method: 'GET', url: 'http://x' } },
    }));
    writeOpRecord(USER, NODE, orig);

    const rb = buildOpRecord(baseInput({
      rolls_back_op_id: orig.id,
      operation: { id: 'rollback_' + orig.id, mechanism: 'http', risk_class: 'low' },
      outcome: 'failure',
      ts: new Date(Date.now() + 1000).toISOString(),
    }));
    writeOpRecord(USER, NODE, rb);

    const status = getRollbackStatus(USER, NODE, orig.id);
    expect(status.invoked).toBe(true);
    expect(status.invocation_outcome).toBe('failure');
    // Could still try again — rollback didn't take effect.
    expect(status.available).toBe(true);
  });

  it('reports expired=true once expires_at has passed', () => {
    const orig = buildOpRecord(baseInput({
      rollback: {
        available: true,
        method: 'http',
        inverse_call: { method: 'GET', url: 'http://x' },
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    }));
    writeOpRecord(USER, NODE, orig);

    const status = getRollbackStatus(USER, NODE, orig.id);
    expect(status.expired).toBe(true);
  });

  it('returns exists:false for unknown op', () => {
    expect(getRollbackStatus(USER, NODE, 'op_nope').exists).toBe(false);
  });
});

describe('pin state', () => {
  it('starts empty and persists across reads', () => {
    expect(listPinned(USER, NODE)).toEqual([]);

    pinSnapshot(USER, NODE, 'op_one');
    pinSnapshot(USER, NODE, 'op_two');
    expect(listPinned(USER, NODE).sort()).toEqual(['op_one', 'op_two']);
    expect(isPinned(USER, NODE, 'op_one')).toBe(true);
    expect(isPinned(USER, NODE, 'op_three')).toBe(false);
  });

  it('pinning the same id twice is a no-op', () => {
    pinSnapshot(USER, NODE, 'op_one');
    pinSnapshot(USER, NODE, 'op_one');
    expect(listPinned(USER, NODE)).toEqual(['op_one']);
  });

  it('unpin removes the id', () => {
    pinSnapshot(USER, NODE, 'op_one');
    pinSnapshot(USER, NODE, 'op_two');
    unpinSnapshot(USER, NODE, 'op_one');
    expect(listPinned(USER, NODE)).toEqual(['op_two']);
  });

  it('unpinning an id that was never pinned is a no-op', () => {
    pinSnapshot(USER, NODE, 'op_one');
    unpinSnapshot(USER, NODE, 'op_never');
    expect(listPinned(USER, NODE)).toEqual(['op_one']);
  });
});
