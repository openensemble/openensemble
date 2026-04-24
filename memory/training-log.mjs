/**
 * Dev-only training capture. Gated on `cortex._devCapture === true` in
 * config.json (undocumented — never exposed in UI or user-facing docs).
 *
 * When enabled, every call to _chatCall() in memory/shared.mjs appends one
 * JSONL record to ~/.openensemble/training/capture/<caller>/<YYYY-MM>.jsonl
 * with the full I/O. The OpenEnsemble team uses these records to build the
 * training corpus for future openensemble/reason-v* releases (see
 * training/README.md in the repo).
 *
 * Everything here is best-effort. Logger failures never propagate to callers
 * — the reason model's correctness must not depend on whether logging works.
 *
 * Disk safety:
 *  - Each record is a single JSON line (newline-terminated) so partial writes
 *    are recoverable (parse per-line, drop the last if corrupted).
 *  - One file per caller × month keeps individual files manageable to scp/edit.
 *  - Writes are append-only; nothing in this module ever truncates or deletes.
 *  - Size cap of 500 MB total, enforced monthly, skips new writes beyond cap
 *    (loudly) to avoid filling the user's disk during a rogue capture session.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';

const CAPTURE_DIR = path.join(USERS_DIR, '..', 'training', 'capture');
const SIZE_CAP_BYTES = 500 * 1024 * 1024; // 500 MB
const KNOWN_CALLERS = new Set([
  'salience', 'contradiction', 'signals', 'friction', 'summary', 'unknown',
]);

let _overCapWarned = false;
let _lastSizeCheck = 0;
let _cachedSize = 0;
const SIZE_CHECK_INTERVAL_MS = 30_000; // recompute disk usage at most every 30s

function _currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function _diskUsage(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += _diskUsage(p);
    else if (entry.isFile()) {
      try { total += fs.statSync(p).size; } catch { /* ignore stat races */ }
    }
  }
  return total;
}

function _isOverCap() {
  const now = Date.now();
  if (now - _lastSizeCheck > SIZE_CHECK_INTERVAL_MS) {
    _cachedSize = _diskUsage(CAPTURE_DIR);
    _lastSizeCheck = now;
  }
  if (_cachedSize > SIZE_CAP_BYTES) {
    if (!_overCapWarned) {
      console.warn(
        `[cortex] training capture disabled: disk usage ${Math.round(_cachedSize / 1e6)} MB ` +
        `exceeds ${Math.round(SIZE_CAP_BYTES / 1e6)} MB cap. ` +
        `Clear ${CAPTURE_DIR} or lower capture volume to re-enable.`
      );
      _overCapWarned = true;
    }
    return true;
  }
  _overCapWarned = false;
  return false;
}

/**
 * Append one JSONL record. Never throws — failures are logged once and swallowed.
 * @param {object} record — see schema in file header / plan Stage 5
 */
export function captureChatCall(record) {
  try {
    if (_isOverCap()) return;
    const caller = KNOWN_CALLERS.has(record.caller) ? record.caller : 'unknown';
    const dir = path.join(CAPTURE_DIR, caller);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${_currentMonth()}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      caller,
      callId: (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      userId: record.userId ?? null,
      agentId: record.agentId ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      temperature: record.temperature ?? null,
      system: record.system ?? null,
      user: record.user ?? null,
      raw_output: record.raw_output ?? null,
      parsed_output: record.parsed_output ?? null,
      parse_ok: record.parsed_output != null,
      latency_ms: record.latency_ms ?? null,
    }) + '\n';
    fs.appendFile(file, line, err => {
      if (err) console.warn('[cortex] training capture append failed:', err.message);
      // Writes invalidate the cached size — force recompute next call
      _lastSizeCheck = 0;
    });
  } catch (e) {
    console.warn('[cortex] training capture failed:', e.message);
  }
}

/** Admin/diagnostic helper — returns per-caller counts and disk usage. */
export function getCaptureStats() {
  const stats = { cap_bytes: SIZE_CAP_BYTES, total_bytes: 0, per_caller: {} };
  if (!fs.existsSync(CAPTURE_DIR)) return stats;
  for (const caller of fs.readdirSync(CAPTURE_DIR)) {
    const dir = path.join(CAPTURE_DIR, caller);
    if (!fs.statSync(dir).isDirectory()) continue;
    let bytes = 0, lines = 0, files = 0;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const sz = fs.statSync(p).size;
      bytes += sz; files++;
      try { lines += fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { /* ignore */ }
    }
    stats.per_caller[caller] = { bytes, lines, files };
    stats.total_bytes += bytes;
  }
  return stats;
}
