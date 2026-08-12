/**
 * Full-fidelity voice capture for local debugging.
 *
 * Saves the exact PCM that was handed to Whisper for a turn, plus a sidecar
 * JSON carrying the device telemetry AND sample-level level analysis, so a
 * question like "was that utterance clipped?" is answerable from the metadata
 * alone without opening a single WAV.
 *
 * This retains household speech. It is therefore OFF unless an operator
 * explicitly arms it by creating the `ENABLED` marker in the capture root:
 *
 *     mkdir -p ~/voice-captures && touch ~/voice-captures/ENABLED   # arm
 *     rm ~/voice-captures/ENABLED                                   # disarm
 *
 * Disarming leaves already-captured audio in place — deleting recordings is a
 * separate, deliberate act, not a side effect of turning the feature off.
 *
 * The capture root deliberately lives OUTSIDE the OE tree (default
 * `~/voice-captures`, override with `OE_VOICE_CAPTURE_DIR`) so the recordings
 * are removable without touching OE, and so a backup of the OE tree does not
 * silently carry audio with it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CAPTURE_ROOT =
  process.env.OE_VOICE_CAPTURE_DIR || path.join(os.homedir(), 'voice-captures');

const ENABLE_MARKER = 'ENABLED';

// Prune oldest captures once the tree exceeds this. At ~2 MB/day of real
// household use this is years of headroom; it exists so a runaway loop or a
// stuck device cannot quietly fill the disk.
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const FULL_SCALE = 32767;
// A sample within ~0.2 dBFS of full scale. Individual samples land here on
// perfectly clean loud speech; it is the RUN of consecutive ones that means
// the waveform got flat-topped, which is what maxClipRun measures.
const NEAR_FULL_SCALE = 32000;

/** Armed only when the operator created the marker file. Cheap enough to
 *  call per turn — one stat() against a path the OS has cached. */
export function isCaptureEnabled() {
  try {
    return fs.existsSync(path.join(CAPTURE_ROOT, ENABLE_MARKER));
  } catch {
    return false;
  }
}

function dbfs(ratio) {
  if (!(ratio > 0)) return null;
  return Math.round(20 * Math.log10(ratio) * 10) / 10;
}

/**
 * Sample-level analysis of 16-bit mono PCM.
 *
 * The device only reports a per-chunk mean-square, which cannot distinguish
 * "loud but clean" from "clipped" — the exact ambiguity that made the
 * 2026-08-09 bed/bad turns unresolvable. These numbers settle it:
 *   - peakDbfs near 0 with maxClipRun >= 3 is flat-topping (true clipping)
 *   - peakDbfs near 0 with maxClipRun <= 2 is just hot, not clipped
 *   - crestDb collapsing toward ~6 dB is the other clipping signature, since
 *     undistorted speech normally sits around 12-18 dB
 */
export function analyzePcm16(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return null;

  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let nearClipped = 0;
  let run = 0;
  let maxRun = 0;

  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sumSq += a * a;
    if (a >= FULL_SCALE) clipped++;
    if (a >= NEAR_FULL_SCALE) {
      nearClipped++;
      if (++run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }

  const rms = Math.sqrt(sumSq / n);
  const peakDbfs = dbfs(peak / 32768);
  const rmsDbfs = dbfs(rms / 32768);

  return {
    samples: n,
    durationMs: Math.round((n / 16000) * 1000),
    peakSample: peak,
    peakDbfs,
    rmsDbfs,
    // Peak-to-RMS. Undistorted speech ~12-18 dB; a collapse toward 6 dB means
    // the peaks got squashed off.
    crestDb: peakDbfs !== null && rmsDbfs !== null
      ? Math.round((peakDbfs - rmsDbfs) * 10) / 10
      : null,
    clippedSamples: clipped,
    nearClippedSamples: nearClipped,
    // Longest run of consecutive at-or-near-full-scale samples. >= 3 is the
    // signature of a flat-topped waveform rather than an incidental peak.
    maxClipRun: maxRun,
    likelyClipped: maxRun >= 3,
  };
}

function safeName(s, fallback) {
  const v = String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return v || fallback;
}

/** Total bytes and file list under a dir, newest-last. Best-effort. */
function walkFiles(dir) {
  const out = [];
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch { /* raced with a delete */ }
      }
    }
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

/**
 * Drop oldest capture pairs until the tree is back under MAX_BYTES. The
 * ENABLED marker is never a candidate (it is not under turns/).
 */
export function pruneCaptures(maxBytes = MAX_BYTES) {
  const turnsDir = path.join(CAPTURE_ROOT, 'turns');
  const files = walkFiles(turnsDir);
  let total = files.reduce((a, f) => a + f.size, 0);
  if (total <= maxBytes) return { pruned: 0, totalBytes: total };
  let pruned = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      fs.unlinkSync(f.path);
      total -= f.size;
      pruned++;
    } catch { /* best-effort */ }
  }
  return { pruned, totalBytes: total };
}

/**
 * Persist one turn's audio + metadata.
 *
 * @param {Buffer} wav   complete WAV (header + PCM) as sent to STT
 * @param {Buffer} pcm   the raw 16-bit mono PCM behind that WAV
 * @param {object} meta  turn/device telemetry to record alongside
 * @returns {string|null} sidecar JSON path, or null if disarmed / on failure
 */
export function captureTurn(wav, pcm, meta = {}) {
  if (!isCaptureEnabled()) return null;
  try {
    const deviceId = safeName(meta.deviceId, 'unknown-device');
    const turnId = safeName(meta.turnId, 'noid');
    const dir = path.join(CAPTURE_ROOT, 'turns', deviceId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const stamp = `${Date.now()}_${turnId}`;
    const wavPath = path.join(dir, `${stamp}.wav`);
    const jsonPath = path.join(dir, `${stamp}.json`);

    // 0600 at creation: these files hold household speech.
    fs.writeFileSync(wavPath, wav, { mode: 0o600 });
    fs.writeFileSync(jsonPath, JSON.stringify({
      ...meta,
      iso: new Date().toISOString(),
      wav: path.basename(wavPath),
      levels: analyzePcm16(pcm),
      transcript: null,
    }, null, 2), { mode: 0o600 });

    pruneCaptures();
    return jsonPath;
  } catch {
    return null;  // capture must never break a voice turn
  }
}

/** Fill in the transcript once STT returns. No-op if capture was disarmed. */
export function attachTranscript(jsonPath, transcript, extra = {}) {
  if (!jsonPath) return;
  try {
    const obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    obj.transcript = typeof transcript === 'string' ? transcript : null;
    Object.assign(obj, extra);
    fs.writeFileSync(jsonPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}
