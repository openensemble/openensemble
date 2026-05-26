// @ts-check
/**
 * Append-only audit log + file-snapshot store for oe-admin mutations.
 *
 * Every change made by the oe-admin skill writes one entry to
 * config/oe-admin-audit.jsonl BEFORE the change is applied. The entry
 * captures:
 *   - the inverse operation (what to undo)
 *   - a verbatim copy of every file the change is about to touch
 *     (under config/oe-admin-snapshots/<entryId>/)
 *
 * Revert is mechanical: restore the snapshot files, run the inverse
 * commands. There's no JSON diff or schema-aware merge — we copy the
 * file before, copy it back if asked.
 *
 * Single-slot pending marker: only one mutation can be awaiting
 * restart-commit at a time (config/.pending-change.json). This keeps the
 * boot-check unambiguous about which entry to revert if the next boot
 * fails. After a successful restart-commit, the marker is deleted and a
 * new mutation can begin.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { BASE_DIR } from './paths.mjs';
import { assertWritablePath } from './oe-admin-paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { log } from '../logger.mjs';

const CFG_DIR        = path.join(BASE_DIR, 'config');
const AUDIT_PATH     = path.join(CFG_DIR, 'oe-admin-audit.jsonl');
const SNAPSHOTS_DIR  = path.join(CFG_DIR, 'oe-admin-snapshots');
const PENDING_PATH   = path.join(CFG_DIR, '.pending-change.json');

export const STATUS_PENDING     = 'pending';
export const STATUS_COMMITTED   = 'committed';
export const STATUS_ROLLED_BACK = 'rolled_back';

function ensureCfgDir() {
  if (!fs.existsSync(CFG_DIR)) fs.mkdirSync(CFG_DIR, { recursive: true });
}

function newEntryId() {
  const t = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const r = crypto.randomBytes(2).toString('hex');
  return `ent_${t}_${r}`;
}

/**
 * Snapshot a list of repo-relative file paths into the entry's snapshot dir.
 * Missing files are recorded as ABSENT (snapshot dir gets a marker file)
 * so revert knows to delete rather than restore.
 */
function snapshotFiles(entryId, relPaths) {
  ensureCfgDir();
  const dir = path.join(SNAPSHOTS_DIR, entryId);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of relPaths) {
    const src = path.join(BASE_DIR, rel);
    const dst = path.join(dir, rel.replace(/[\\/]/g, '__'));
    // Snapshot files themselves live under config/oe-admin-snapshots/<id>/,
    // which is on the allowlist — assert it so we catch any path-traversal
    // attempt in `relPaths` early.
    assertWritablePath(dst);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    } else {
      fs.writeFileSync(dst + '.ABSENT', '');
    }
  }
}

/**
 * Restore the snapshotted versions of the given relPaths. Files that were
 * absent at snapshot time are deleted (matching the .ABSENT marker).
 */
function restoreSnapshot(entryId, relPaths) {
  const dir = path.join(SNAPSHOTS_DIR, entryId);
  for (const rel of relPaths) {
    const src = path.join(dir, rel.replace(/[\\/]/g, '__'));
    const absentMarker = src + '.ABSENT';
    const dst = path.join(BASE_DIR, rel);
    assertWritablePath(dst);
    if (fs.existsSync(absentMarker)) {
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
    } else if (fs.existsSync(src)) {
      // Atomic restore via tmp + rename so a partial write can't leave the
      // file half-restored if we crash mid-revert.
      const tmp = dst + '.restore-tmp';
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
    }
  }
}

// ── Audit log ────────────────────────────────────────────────────────────────

/**
 * Append a pending entry to the audit log. Returns the assigned entry id.
 * Caller is expected to populate `snapshotFiles`, `inverse`, `args`, etc.
 */
export function recordPending({ userId, op, args = {}, inverse = null, snapshotFiles: filesToSnapshot = [], restartRequired = false, commitDeadlineMs = 60_000 }) {
  ensureCfgDir();
  const id = newEntryId();
  const entry = {
    id,
    ts: new Date().toISOString(),
    userId,
    op,
    args,
    snapshotFiles: filesToSnapshot,
    inverse,
    status: STATUS_PENDING,
    restartRequired: !!restartRequired,
    commitDeadlineMs,
  };
  // Snapshot first so a crash between log append and snapshot leaves us
  // in a known-bad state we can still revert.
  snapshotFiles(id, filesToSnapshot);
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  log.info('oe-admin', 'audit pending', { id, op, userId, restartRequired });
  return id;
}

/**
 * Rewrite an existing entry's status. Used by markCommitted / markRolledBack.
 * Implemented by re-reading the JSONL, mutating the row, and atomically
 * writing it back. Audit log is small (10k cap before rotation) so this
 * is fine.
 */
function updateStatus(id, mutator) {
  ensureCfgDir();
  if (!fs.existsSync(AUDIT_PATH)) return false;
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
  let changed = false;
  const out = lines.map(line => {
    try {
      const e = JSON.parse(line);
      if (e.id === id) {
        mutator(e);
        changed = true;
        return JSON.stringify(e);
      }
      return line;
    } catch { return line; }
  });
  if (changed) atomicWriteSync(AUDIT_PATH, out.join('\n') + '\n');
  return changed;
}

export function markCommitted(id) {
  return updateStatus(id, e => {
    e.status = STATUS_COMMITTED;
    e.committedAt = new Date().toISOString();
  });
}

export function markRolledBack(id, reason) {
  return updateStatus(id, e => {
    e.status = STATUS_ROLLED_BACK;
    e.rolledBackAt = new Date().toISOString();
    if (reason) e.rolledBackReason = reason;
  });
}

/** Return the full entry record (or null if not found). */
export function getEntry(id) {
  if (!fs.existsSync(AUDIT_PATH)) return null;
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.id === id) return e;
    } catch {}
  }
  return null;
}

/** Return the most recent N entries, newest first. */
export function listAudit({ limit = 25, since = null, includeRolledBack = true } = {}) {
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (!includeRolledBack && e.status === STATUS_ROLLED_BACK) continue;
      if (since && e.ts < since) continue;
      out.push(e);
    } catch {}
  }
  return out;
}

// ── Pending-marker (single-slot in-flight) ───────────────────────────────────

/** Returns true if a pending change is awaiting restart-commit. */
export function hasPendingChange() {
  return fs.existsSync(PENDING_PATH);
}

export function readPendingMarker() {
  if (!fs.existsSync(PENDING_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); }
  catch { return null; }
}

/** Write the pending marker. Caller passes the audit entryId being committed. */
export function writePendingMarker({ entryId, restartTriggeredAt, restartPid }) {
  ensureCfgDir();
  assertWritablePath(PENDING_PATH);
  atomicWriteSync(PENDING_PATH, JSON.stringify({
    entryId,
    restartTriggeredAt: restartTriggeredAt ?? new Date().toISOString(),
    restartPid: restartPid ?? process.pid,
  }));
}

export function deletePendingMarker() {
  if (fs.existsSync(PENDING_PATH)) {
    try { fs.unlinkSync(PENDING_PATH); } catch {}
  }
}

// ── Revert ───────────────────────────────────────────────────────────────────

/**
 * Restore the snapshot files for an entry. Does NOT run inverse commands —
 * the caller (install_integration's revert path) is responsible for running
 * recipe rollback steps with the appropriate sudo handling. We separate
 * these because shell execution needs the credential primitive, but file
 * restore is pure FS.
 */
export async function restoreEntrySnapshots(id) {
  const entry = getEntry(id);
  if (!entry) throw new Error(`audit entry not found: ${id}`);
  if (entry.status === STATUS_ROLLED_BACK) {
    throw new Error(`audit entry already rolled back: ${id}`);
  }
  restoreSnapshot(id, entry.snapshotFiles ?? []);
  return entry;
}

/**
 * Full revert: restore snapshots + return the inverse so the caller can
 * dispatch any inverse commands (config writes, integration rollback,
 * credential deletions). Marks the entry rolled_back on success.
 */
export async function revertEntry(id, { reason = 'manual', commandRunner = null } = {}) {
  const entry = await restoreEntrySnapshots(id);

  // Apply inverse actions that we own directly. The recipe-rollback subset
  // (which may need sudo) is handled by the caller via commandRunner.
  if (entry.inverse) {
    const inv = entry.inverse;
    if (inv.kind === 'set_config_field') {
      // Snapshot restore already covers this — config.json was snapshotted.
    } else if (inv.kind === 'add_provider_revert') {
      // Snapshot restore already covers config.json + user-providers.json.
      // The credential deletion stays our job.
      try {
        const { deleteCredential } = await import('./credentials.mjs');
        for (const credId of inv.deleteCredentialIds ?? []) {
          if (entry.userId) deleteCredential(entry.userId, credId);
        }
      } catch (e) {
        log.warn('oe-admin', 'cred delete during revert failed', { id, err: e.message });
      }
    } else if (inv.kind === 'install_integration_revert') {
      // configWrites are covered by snapshot restore. Rollback shell steps
      // get dispatched by the caller (it has the sudo context).
      if (Array.isArray(inv.rollbackSteps) && commandRunner) {
        for (const step of inv.rollbackSteps) {
          try { await commandRunner(step); }
          catch (e) {
            log.warn('oe-admin', 'rollback step failed', { id, step: step.id, err: e.message });
          }
        }
      }
    }
  }

  markRolledBack(id, reason);
  log.info('oe-admin', 'audit reverted', { id, reason });
  return entry;
}
