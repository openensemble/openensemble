import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BASE_DIR } from '../lib/paths.mjs';
import {
  recordPending, markCommitted, markRolledBack, getEntry, listAudit,
  hasPendingChange, writePendingMarker, readPendingMarker, deletePendingMarker,
  restoreEntrySnapshots, revertEntry,
  STATUS_PENDING, STATUS_COMMITTED, STATUS_ROLLED_BACK,
} from '../lib/oe-admin-audit.mjs';

const AUDIT_PATH    = path.join(BASE_DIR, 'config', 'oe-admin-audit.jsonl');
const SNAPSHOTS_DIR = path.join(BASE_DIR, 'config', 'oe-admin-snapshots');
const PENDING_PATH  = path.join(BASE_DIR, 'config', '.pending-change.json');

function cleanup() {
  try { fs.unlinkSync(AUDIT_PATH); } catch {}
  try { fs.unlinkSync(PENDING_PATH); } catch {}
  try { fs.rmSync(SNAPSHOTS_DIR, { recursive: true, force: true }); } catch {}
}

describe('audit log', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('records a pending entry and lists it', () => {
    const id = recordPending({
      userId: 'user_test',
      op: 'set_config_field',
      args: { path: 'enabledProviders.foo', value: true },
      snapshotFiles: [],
      inverse: { kind: 'set_config_field', path: 'enabledProviders.foo', value: undefined },
    });
    const entries = listAudit();
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].status).toBe(STATUS_PENDING);
  });

  it('markCommitted updates the status', () => {
    const id = recordPending({ userId: 'u', op: 'noop', args: {}, snapshotFiles: [], inverse: null });
    expect(markCommitted(id)).toBe(true);
    expect(getEntry(id).status).toBe(STATUS_COMMITTED);
  });

  it('markRolledBack updates status + reason', () => {
    const id = recordPending({ userId: 'u', op: 'noop', args: {}, snapshotFiles: [], inverse: null });
    markRolledBack(id, 'test-reason');
    const e = getEntry(id);
    expect(e.status).toBe(STATUS_ROLLED_BACK);
    expect(e.rolledBackReason).toBe('test-reason');
  });

  it('listAudit returns newest first', () => {
    const a = recordPending({ userId: 'u', op: 'first',  args: {}, snapshotFiles: [], inverse: null });
    const b = recordPending({ userId: 'u', op: 'second', args: {}, snapshotFiles: [], inverse: null });
    const entries = listAudit({ limit: 5 });
    expect(entries[0].id).toBe(b);
    expect(entries[1].id).toBe(a);
  });
});

describe('snapshots + restore', () => {
  const FAKE_FILE = path.join(BASE_DIR, 'config', 'user-providers.json');
  beforeEach(() => { cleanup(); try { fs.unlinkSync(FAKE_FILE); } catch {} });
  afterEach(() => { cleanup(); try { fs.unlinkSync(FAKE_FILE); } catch {} });

  it('snapshots and restores file contents byte-for-byte', async () => {
    // Seed a known file
    fs.mkdirSync(path.dirname(FAKE_FILE), { recursive: true });
    fs.writeFileSync(FAKE_FILE, '{"original":true}');
    const id = recordPending({
      userId: 'u', op: 'noop', args: {},
      snapshotFiles: ['config/user-providers.json'],
      inverse: null,
    });
    // Mutate the file
    fs.writeFileSync(FAKE_FILE, '{"mutated":true}');
    expect(fs.readFileSync(FAKE_FILE, 'utf8')).toContain('mutated');
    // Restore
    await restoreEntrySnapshots(id);
    expect(fs.readFileSync(FAKE_FILE, 'utf8')).toBe('{"original":true}');
  });

  it('snapshots a missing file by recording ABSENT, restore deletes', async () => {
    // Ensure file does NOT exist
    try { fs.unlinkSync(FAKE_FILE); } catch {}
    const id = recordPending({
      userId: 'u', op: 'noop', args: {},
      snapshotFiles: ['config/user-providers.json'],
      inverse: null,
    });
    // Create the file (simulating change)
    fs.writeFileSync(FAKE_FILE, '{"created":true}');
    // Restore should remove it
    await restoreEntrySnapshots(id);
    expect(fs.existsSync(FAKE_FILE)).toBe(false);
  });

  it('revertEntry refuses double-revert', async () => {
    const id = recordPending({ userId: 'u', op: 'noop', args: {}, snapshotFiles: [], inverse: null });
    await revertEntry(id);
    await expect(revertEntry(id)).rejects.toThrow(/already rolled back/);
  });
});

describe('pending marker (single-slot)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('hasPendingChange reflects marker file presence', () => {
    expect(hasPendingChange()).toBe(false);
    writePendingMarker({ entryId: 'ent_x' });
    expect(hasPendingChange()).toBe(true);
    deletePendingMarker();
    expect(hasPendingChange()).toBe(false);
  });

  it('roundtrip carries entryId and PID', () => {
    writePendingMarker({ entryId: 'ent_xyz' });
    const m = readPendingMarker();
    expect(m.entryId).toBe('ent_xyz');
    expect(m.restartPid).toBe(process.pid);
    expect(m.restartTriggeredAt).toBeTruthy();
  });
});
