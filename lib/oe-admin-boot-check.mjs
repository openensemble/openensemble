// @ts-check
/**
 * Boot-check for oe-admin pending changes.
 *
 * Runs first thing in server.mjs (before route registration). Detects the
 * single-slot pending marker at config/.pending-change.json and acts on it:
 *
 *   - If the marker was written by THIS process (rare; only happens if the
 *     marker is written and then runBootCheck() is called in the same boot
 *     before commit), return — normal flow.
 *
 *   - If the marker was written by a DIFFERENT PID (i.e., the previous boot
 *     wrote it, restarted, and we're now starting after the restart), then
 *     the change is in its "tentative" window: schedule a commit-deadline
 *     timer that promotes the entry to committed once /health returns 200
 *     within commitDeadlineMs, or auto-reverts and exits if it doesn't.
 *
 *   - If the marker exists AND we're in a fresh boot AND a previous boot
 *     ALSO failed to commit (we can tell because the marker is still here
 *     after a full restart cycle), auto-revert immediately and continue
 *     boot. This is the "previous startup crashed" path.
 *
 * Layer 2 (external supervisor under bin/oe-supervise.mjs) handles the
 * case where Node itself can't even start. Layer 1 (this file) handles
 * everything where init runs but a config change broke startup.
 */

import fs from 'fs';
import http from 'http';
import {
  readPendingMarker, deletePendingMarker, markCommitted, revertEntry, getEntry,
  STATUS_PENDING,
} from './oe-admin-audit.mjs';
import { log } from '../logger.mjs';

const DEFAULT_HEALTHCHECK_PORT = 3737;
const DEFAULT_HEALTHCHECK_PATH = '/api/_alive';
const POLL_INTERVAL_MS = 500;

let _commitTimer = null;
let _commitPollInterval = null;
let _bootCheckRan = false;

/**
 * Probe the alive endpoint. Returns true if HTTP status is 200 or 503 —
 * both indicate "server bound to its port and is responding" which is the
 * commit signal we want. Any other failure (ECONNREFUSED, ETIMEDOUT) is
 * "not yet."
 */
function probeAlive(port, pathStr) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathStr,
      method: 'GET',
      timeout: 1500,
    }, res => {
      // Drain.
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200 || res.statusCode === 503));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Run the boot-check. Should be the FIRST thing server.mjs does after
 * imports — before routes register, before anything else can throw.
 *
 * If a pending marker is found from a prior PID's boot AND that prior boot
 * already crashed (heuristic: marker is older than ~5 seconds AND we're
 * starting fresh), revert the entry synchronously before continuing.
 *
 * Otherwise, schedule a commit-deadline timer that watches /api/_alive
 * for up to commitDeadlineMs. Health 200 → markCommitted. Timeout →
 * revert + process.exit(1) so the supervisor (or systemd) can respawn.
 */
export async function runBootCheck({ port = DEFAULT_HEALTHCHECK_PORT } = {}) {
  if (_bootCheckRan) return;
  _bootCheckRan = true;

  const marker = readPendingMarker();
  if (!marker) return;

  const entry = getEntry(marker.entryId);
  if (!entry) {
    log.warn('oe-admin', 'pending marker references missing audit entry; clearing', { entryId: marker.entryId });
    deletePendingMarker();
    return;
  }

  // If the marker was written by THIS PID (race during same boot), let it
  // ride — caller will commit-or-revert before exit.
  if (marker.restartPid === process.pid) return;

  // Marker from a prior PID. Two cases distinguished by entry status:
  //   1. entry is still STATUS_PENDING → this is the first boot after the
  //      restart; arm the commit-deadline timer.
  //   2. entry is already STATUS_PENDING and we're seeing the marker for
  //      the SECOND time (i.e., the boot that armed it crashed) → revert
  //      now. We can't strictly distinguish from #1 without a second
  //      marker field, so we use the absence of any "armed at this PID"
  //      marker file as a proxy: the supervisor (Layer 2) is responsible
  //      for that bookkeeping; without it, we err on the side of arming
  //      the timer and letting timeout do the revert.

  if (entry.status !== STATUS_PENDING) {
    log.info('oe-admin', 'pending marker for non-pending entry; clearing', { entryId: marker.entryId, status: entry.status });
    deletePendingMarker();
    return;
  }

  // ── Quick crash check ────────────────────────────────────────────────────
  // If we boot and find a marker from a previous PID that's older than the
  // entry's commitDeadlineMs, the previous boot definitely never committed
  // — auto-revert immediately so we come up clean.
  const markerAge = Date.now() - new Date(marker.restartTriggeredAt).getTime();
  if (markerAge > (entry.commitDeadlineMs ?? 60_000)) {
    log.warn('oe-admin', 'previous boot did not commit before deadline; auto-reverting', {
      entryId: marker.entryId, ageMs: markerAge,
    });
    try {
      await revertEntry(marker.entryId, { reason: 'previous_boot_failed' });
    } catch (e) {
      log.error('oe-admin', 'revert failed during boot recovery', { entryId: marker.entryId, err: e.message });
    }
    deletePendingMarker();
    return;
  }

  // Otherwise: arm the commit-deadline timer. /api/_alive returning 200 (or
  // 503 — either indicates the server is responding) → mark committed.
  log.info('oe-admin', 'arming commit-deadline timer', {
    entryId: marker.entryId, deadlineMs: entry.commitDeadlineMs,
  });
  armCommitDeadline(marker.entryId, entry.commitDeadlineMs ?? 60_000, port);
}

function armCommitDeadline(entryId, deadlineMs, port) {
  const startedAt = Date.now();
  _commitPollInterval = setInterval(async () => {
    if (await probeAlive(port, DEFAULT_HEALTHCHECK_PATH)) {
      clearInterval(_commitPollInterval); _commitPollInterval = null;
      clearTimeout(_commitTimer);          _commitTimer = null;
      markCommitted(entryId);
      deletePendingMarker();
      log.info('oe-admin', 'pending change committed', { entryId, elapsedMs: Date.now() - startedAt });
    }
  }, POLL_INTERVAL_MS);

  _commitTimer = setTimeout(async () => {
    if (_commitPollInterval) { clearInterval(_commitPollInterval); _commitPollInterval = null; }
    log.error('oe-admin', 'commit deadline exceeded; auto-reverting + exiting', { entryId, deadlineMs });
    try {
      await revertEntry(entryId, { reason: 'commit_deadline_exceeded' });
    } catch (e) {
      log.error('oe-admin', 'revert failed at commit deadline', { entryId, err: e.message });
    }
    deletePendingMarker();
    // Exit non-zero so the supervisor (or systemd) re-spawns clean. If we
    // didn't exit, the broken state would persist until the next manual
    // restart.
    process.exit(1);
  }, deadlineMs + 1000);
  // +1s slop so the poll has a chance to commit at the boundary.
}

/**
 * Cancel an armed commit-deadline timer. Called when the server is shutting
 * down intentionally so we don't fire the deadline during a clean restart.
 */
export function cancelCommitDeadline() {
  if (_commitPollInterval) { clearInterval(_commitPollInterval); _commitPollInterval = null; }
  if (_commitTimer)        { clearTimeout(_commitTimer);          _commitTimer = null; }
}

/**
 * The lightweight liveness endpoint the boot-check polls. Returns 200 once
 * route registration has completed (this module imported = server is up
 * enough to bind HTTP). Separate from /health so a provider being down
 * doesn't fail the commit deadline.
 */
export function aliveResponse(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ alive: true, ts: Date.now() }));
}
