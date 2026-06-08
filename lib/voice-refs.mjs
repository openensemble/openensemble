/**
 * Per-user voice references for Pocket TTS zero-shot cloning.
 *
 * Storage: users/<userId>/voice-refs/<refId>.wav + .json
 *   - <refId>.wav  — reference audio (~15-20s of the target voice, mono WAV)
 *   - <refId>.json — { label, transcript, uploaded_at, duration_s, size_bytes }
 *
 * Pocket TTS clones zero-shot from just the reference WAV (no transcript
 * required — transcript is kept optional for legacy callers). Quality is best
 * with a clean ~15-20s clip of a single speaker; noisier samples can hurt.
 *
 * The slot_assignments[N].ttsVoice value, when ttsProvider='pocket-tts', is
 * the refId string. Resolution: refId → users/<owner>/voice-refs/<id>.wav.
 * Reference owner = device-OWNER's voice-refs (not the slot's effective
 * user) so the same household admin manages all voices on their device.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const MAX_WAV_BYTES = 5 * 1024 * 1024;     // 5 MB cap — ~30s 44.1k stereo PCM
const MAX_TRANSCRIPT_BYTES = 2 * 1024;     // transcripts are short
export const MAX_REFS_PER_USER = 10;

function refsDir(userId) {
  return path.join(USERS_DIR, userId, 'voice-refs');
}

/**
 * Validate an uploaded reference. Returns null if valid, else a user-
 * friendly error string. Structural checks only — we don't try to verify
 * the audio is actually speech or playable through F5-TTS.
 */
export function validateUpload(wavBuffer, label, transcript) {
  if (!Buffer.isBuffer(wavBuffer)) return 'audio must be a binary file';
  if (wavBuffer.length === 0) return 'audio is empty';
  if (wavBuffer.length > MAX_WAV_BYTES) {
    return `audio is ${wavBuffer.length} bytes; cap is ${MAX_WAV_BYTES} (~30 s)`;
  }
  // WAV files start with "RIFF" at byte 0 and "WAVE" at byte 8.
  const riff = wavBuffer.slice(0, 4).toString('ascii');
  const wave = wavBuffer.slice(8, 12).toString('ascii');
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    return 'audio must be a WAV file (RIFF/WAVE header missing)';
  }
  if (typeof label !== 'string' || !label.trim()) {
    return 'label is required (e.g. "Shawn", "Test", "kid-1")';
  }
  // transcript is OPTIONAL: zero-shot engines (Pocket TTS) need only the audio.
  // F5-TTS callers still pass the exact transcript; if present we cap its length.
  if (typeof transcript !== 'string') {
    return 'transcript must be a string (may be empty for zero-shot voice cloning)';
  }
  if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) {
    return `transcript too long (${Buffer.byteLength(transcript)} > ${MAX_TRANSCRIPT_BYTES})`;
  }
  return null;
}

/**
 * Decode a WAV header to estimate duration. Returns seconds or null if
 * the header doesn't parse (validation already verified RIFF/WAVE so the
 * basic shape exists; we just probe for the fmt chunk).
 */
function estimateDurationSec(wavBuffer) {
  try {
    // fmt chunk usually starts at byte 12. byte rate at offset 28 (uint32 LE).
    if (wavBuffer.slice(12, 16).toString('ascii') !== 'fmt ') return null;
    const byteRate = wavBuffer.readUInt32LE(28);
    if (!byteRate) return null;
    return (wavBuffer.length - 44) / byteRate; // approximate; close enough for UI
  } catch { return null; }
}

export function addVoiceRef(userId, { wavBuffer, label, transcript }) {
  const dir = refsDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const existing = listVoiceRefs(userId);
  if (existing.length >= MAX_REFS_PER_USER) {
    const err = new Error(`Reference library full (${existing.length}/${MAX_REFS_PER_USER}). Delete one to upload a new voice.`);
    err.code = 'LIBRARY_FULL';
    throw err;
  }
  const id = `ref_${randomBytes(4).toString('hex')}`;
  const wavPath = path.join(dir, `${id}.wav`);
  const metaPath = path.join(dir, `${id}.json`);
  const meta = {
    id,
    label: String(label).slice(0, 64).trim(),
    transcript: String(transcript).slice(0, MAX_TRANSCRIPT_BYTES).trim(),
    uploaded_at: Date.now(),
    duration_s: estimateDurationSec(wavBuffer),
    size_bytes: wavBuffer.length,
  };
  atomicWriteSync(wavPath, wavBuffer);
  atomicWriteSync(metaPath, JSON.stringify(meta, null, 2));
  return id;
}

export function listVoiceRefs(userId) {
  const dir = refsDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.wav')) continue;
    const id = f.slice(0, -'.wav'.length);
    const metaPath = path.join(dir, `${id}.json`);
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      out.push(meta);
    } catch {}
  }
  out.sort((a, b) => (b.uploaded_at ?? 0) - (a.uploaded_at ?? 0));
  return out;
}

/**
 * Returns the absolute path to a reference's WAV + its transcript, or null
 * if no such reference exists for the user. The path form (not bytes) is
 * what F5-TTS expects — it'll open + decode the file itself.
 */
export function getVoiceRef(userId, refId) {
  if (!refId || typeof refId !== 'string') return null;
  if (!/^ref_[a-f0-9]+$/.test(refId)) return null;
  const dir = refsDir(userId);
  const wavPath = path.join(dir, `${refId}.wav`);
  const metaPath = path.join(dir, `${refId}.json`);
  if (!fs.existsSync(wavPath) || !fs.existsSync(metaPath)) return null;
  let transcript = '';
  try { transcript = JSON.parse(fs.readFileSync(metaPath, 'utf8')).transcript || ''; } catch {}
  return { wavPath, transcript };
}

export function deleteVoiceRef(userId, refId) {
  const r = getVoiceRef(userId, refId);
  if (!r) return false;
  const dir = refsDir(userId);
  // .safetensors is the cached Pocket TTS speaker-state (written lazily by the
  // pocket-tts service on first use); remove it too so deletes don't orphan it.
  for (const f of [`${refId}.wav`, `${refId}.json`, `${refId}.safetensors`]) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {
      console.warn(`[voice-refs] unlink ${p} failed: ${e.message}`);
    }
  }
  return true;
}
