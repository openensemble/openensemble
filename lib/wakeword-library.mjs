/**
 * Per-user wake-word library.
 *
 * Storage: users/<userId>/wakewords/<wwId>.tflite + .json
 *   - <wwId>.tflite = the microWakeWord v2 streaming model, as uploaded
 *   - <wwId>.json   = the manifest file, as uploaded (esphome v2 schema)
 *
 * Each device's voice-devices.json slot_assignments[N] can reference a
 * wwId; when set, OE pushes that file pair to the device's SPIFFS at
 * /ww/slotN.{tflite,json} via the existing WS, and the firmware reloads
 * the slot. When unset, the device uses whatever was baked into the
 * firmware build.
 *
 * Validation rules (enforced on upload):
 *   - .tflite ≤ 256 KB (firmware buffer cap in load_model_file)
 *   - .tflite starts with "TFL3" magic at byte offset 4 (TFLite header)
 *   - .json parses, has a `micro` object with probability_cutoff in [0,1]
 *
 * Library entries belong to the user that uploaded them; cross-user share
 * is not supported in v1. (The slot routing's cross-user feature is
 * orthogonal — the device-OWNER's library is what's pushed regardless of
 * which user the slot routes to. Reasonable: who uploaded the wake word
 * doesn't have to be who answers it.)
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const MAX_TFLITE_BYTES = 256 * 1024; // matches firmware load_model_file cap
const MAX_MANIFEST_BYTES = 4 * 1024;  // matches firmware read_slot_manifest cap
// Per-user library cap. Each entry is ~60 KB so 10 entries = ~600 KB of
// user files — trivial disk, but a cap protects against drive-fill DoS
// from a compromised or careless account. Bump if real use cases need
// more variety. UI surfaces this so users see "5 / 10" and don't try to
// upload an 11th without warning.
export const MAX_LIBRARY_ENTRIES = 10;

function libraryDir(userId) {
  return path.join(USERS_DIR, userId, 'wakewords');
}

/**
 * Validate an uploaded tflite buffer + manifest object. Returns null if
 * valid, otherwise an error message string suitable for surfacing to the
 * user. The tflite check is structural (magic bytes); we don't try to
 * actually run the model or verify it's a microWakeWord-shaped graph.
 */
export function validateUpload(tfliteBuffer, manifestObj) {
  if (!Buffer.isBuffer(tfliteBuffer)) return 'tflite must be a binary file';
  if (tfliteBuffer.length === 0) return 'tflite is empty';
  if (tfliteBuffer.length > MAX_TFLITE_BYTES) {
    return `tflite is ${tfliteBuffer.length} bytes; firmware accepts at most ${MAX_TFLITE_BYTES}`;
  }
  // TFLite files have the FlatBuffer "TFL3" magic at offset 4. Older
  // (pre-2020) tflite uses no magic — we accept either, but warn-by-comment.
  const magic = tfliteBuffer.slice(4, 8).toString('ascii');
  if (magic !== 'TFL3' && tfliteBuffer.length > 8) {
    // Some toolchains omit the magic — check for the FlatBuffers root-table
    // offset at byte 0 instead. If neither matches, reject.
    const rootOffset = tfliteBuffer.readUInt32LE(0);
    if (rootOffset === 0 || rootOffset >= tfliteBuffer.length) {
      return 'tflite does not look like a TFLite model (bad magic + root offset)';
    }
  }
  if (!manifestObj || typeof manifestObj !== 'object') return 'manifest must be a JSON object';
  if (typeof manifestObj.wake_word !== 'string' || !manifestObj.wake_word) {
    return 'manifest.wake_word must be a non-empty string';
  }
  if (!manifestObj.micro || typeof manifestObj.micro !== 'object') {
    return 'manifest.micro must be an object (esphome v2 schema)';
  }
  const cut = manifestObj.micro.probability_cutoff;
  if (typeof cut !== 'number' || cut < 0 || cut > 1) {
    return 'manifest.micro.probability_cutoff must be a number in [0,1]';
  }
  const manifestStr = JSON.stringify(manifestObj);
  if (Buffer.byteLength(manifestStr) > MAX_MANIFEST_BYTES) {
    return `manifest serializes to ${Buffer.byteLength(manifestStr)} bytes; firmware accepts at most ${MAX_MANIFEST_BYTES}`;
  }
  return null;
}

/**
 * Add a wake word to the user's library. Caller is responsible for
 * validating first via validateUpload(). Returns the new entry's id.
 */
export function addLibraryWakeword(userId, { tfliteBuffer, manifestObj, originalFilename = null }) {
  const dir = libraryDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  // Enforce the per-user cap. Counted by listing the dir rather than a
  // stored counter so manual deletes (admin via filesystem) update the
  // count without needing a separate cleanup step.
  const existing = listLibraryWakewords(userId);
  if (existing.length >= MAX_LIBRARY_ENTRIES) {
    const err = new Error(`Library full (${existing.length}/${MAX_LIBRARY_ENTRIES}). Delete one to upload a new wake word.`);
    err.code = 'LIBRARY_FULL';
    throw err;
  }
  const id = `ww_${randomBytes(4).toString('hex')}`;
  const tflitePath = path.join(dir, `${id}.tflite`);
  const manifestPath = path.join(dir, `${id}.json`);
  // Stamp library-side metadata onto a sibling _meta.json — keeps the
  // device-bound manifest pristine (firmware's cJSON parser only reads
  // specific fields, but extra fields confuse downstream tooling).
  const metaPath = path.join(dir, `${id}._meta.json`);
  const meta = {
    id,
    original_filename: originalFilename ? String(originalFilename).slice(0, 128) : null,
    uploaded_at: Date.now(),
    size_bytes: tfliteBuffer.length,
  };
  // Write tflite first; if anything fails the manifest+meta won't reference
  // a missing file. Atomic so a partial write doesn't leave a half-baked
  // .tflite the firmware would reject at load time.
  atomicWriteSync(tflitePath, tfliteBuffer);
  atomicWriteSync(manifestPath, JSON.stringify(manifestObj, null, 2));
  atomicWriteSync(metaPath, JSON.stringify(meta, null, 2));
  return id;
}

/**
 * Walks the user's library dir, returns one entry per wakeword file pair.
 * Skips any orphaned/half-written files.
 */
export function listLibraryWakewords(userId) {
  const dir = libraryDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.tflite')) continue;
    const id = f.slice(0, -'.tflite'.length);
    const tflitePath = path.join(dir, `${id}.tflite`);
    const manifestPath = path.join(dir, `${id}.json`);
    const metaPath = path.join(dir, `${id}._meta.json`);
    if (!fs.existsSync(manifestPath)) continue; // orphan
    let manifest = {};
    let meta = {};
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    const stat = fs.statSync(tflitePath);
    out.push({
      id,
      wake_word: manifest.wake_word ?? '(no phrase)',
      author: manifest.author ?? null,
      probability_cutoff: manifest?.micro?.probability_cutoff ?? null,
      original_filename: meta.original_filename ?? null,
      uploaded_at: meta.uploaded_at ?? stat.mtimeMs,
      size_bytes: stat.size,
    });
  }
  // Newest first.
  out.sort((a, b) => (b.uploaded_at ?? 0) - (a.uploaded_at ?? 0));
  return out;
}

/**
 * Stock wake-word library: ships with OE, visible to every user, read-only.
 * Files live at wakewords/stock/<slug>.{tflite,json} (top-level so they
 * escape the blanket `models/` gitignore that hides LLM weights); the slug
 * must match /^[a-z0-9_]+$/. Exposed to clients with the stable id
 * `stock_<slug>` so a slot assignment survives a stock-library refresh.
 */
const STOCK_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'wakewords', 'stock');

export function isStockWwId(wwId) {
  return typeof wwId === 'string' && /^stock_[a-z0-9_]+$/.test(wwId);
}

export function listStockWakewords() {
  if (!fs.existsSync(STOCK_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(STOCK_DIR)) {
    if (!f.endsWith('.tflite')) continue;
    const slug = f.slice(0, -'.tflite'.length);
    if (!/^[a-z0-9_]+$/.test(slug)) continue;
    const tflitePath = path.join(STOCK_DIR, `${slug}.tflite`);
    const manifestPath = path.join(STOCK_DIR, `${slug}.json`);
    if (!fs.existsSync(manifestPath)) continue;
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    const stat = fs.statSync(tflitePath);
    out.push({
      id: `stock_${slug}`,
      wake_word: manifest.wake_word ?? slug,
      author: manifest.author ?? null,
      probability_cutoff: manifest?.micro?.probability_cutoff ?? null,
      original_filename: null,
      uploaded_at: stat.mtimeMs,
      size_bytes: stat.size,
      stock: true,
    });
  }
  out.sort((a, b) => (a.wake_word ?? '').localeCompare(b.wake_word ?? ''));
  return out;
}

/**
 * Returns the file pair for a wake word id, or null when not found.
 * Caller can use .read paths (sync) to ship the bytes to the device.
 * Stock ids (`stock_<slug>`) resolve to the OE-shipped stock dir regardless
 * of userId.
 */
export function getLibraryWakeword(userId, wwId) {
  if (!wwId || typeof wwId !== 'string') return null;
  if (isStockWwId(wwId)) {
    const slug = wwId.slice('stock_'.length);
    const tflitePath = path.join(STOCK_DIR, `${slug}.tflite`);
    const manifestPath = path.join(STOCK_DIR, `${slug}.json`);
    if (!fs.existsSync(tflitePath) || !fs.existsSync(manifestPath)) return null;
    return { tflitePath, manifestPath };
  }
  // Sanitize: id must match the format we generated. Defends against any
  // path-traversal sneak via a forged id like '../../etc/passwd'.
  if (!/^ww_[a-f0-9]+$/.test(wwId)) return null;
  const dir = libraryDir(userId);
  const tflitePath = path.join(dir, `${wwId}.tflite`);
  const manifestPath = path.join(dir, `${wwId}.json`);
  if (!fs.existsSync(tflitePath) || !fs.existsSync(manifestPath)) return null;
  return { tflitePath, manifestPath };
}

/**
 * Reads + returns the tflite bytes + manifest JSON string for OTA push.
 * Returns null if the entry doesn't exist.
 */
export function readLibraryWakeword(userId, wwId) {
  const paths = getLibraryWakeword(userId, wwId);
  if (!paths) return null;
  return {
    tflite: fs.readFileSync(paths.tflitePath),
    manifestJson: fs.readFileSync(paths.manifestPath, 'utf8'),
  };
}

/**
 * Server-side mirror of the wake words the firmware bundles in its SPIFFS
 * partition at build time. Used to OTA-revert a slot back to its built-in
 * after a custom wake word has overwritten the SPIFFS file. Bytes live at
 * wakewords/builtin/slot{N}.{tflite,json} in the OE repo and must stay in
 * sync with firmware/voice-device/wakewords/ when the firmware ships new
 * built-ins.
 *
 * Returns { tflite, manifestJson } or null if no built-in exists for the
 * requested slot (firmware-only slot, server hasn't been seeded).
 */
const BUILTIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'wakewords', 'builtin');

export function readBuiltinWakeword(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 7) return null;
  const tflitePath  = path.join(BUILTIN_DIR, `slot${slot}.tflite`);
  const manifestPath = path.join(BUILTIN_DIR, `slot${slot}.json`);
  if (!fs.existsSync(tflitePath) || !fs.existsSync(manifestPath)) return null;
  return {
    tflite: fs.readFileSync(tflitePath),
    manifestJson: fs.readFileSync(manifestPath, 'utf8'),
  };
}

/**
 * Read the built-in's manifest object so the UI can show the phrase + cutoff
 * without making the user open the file. Used for the slot dropdown label.
 * Returns the parsed manifest or null.
 */
export function getBuiltinManifest(slot) {
  const bw = readBuiltinWakeword(slot);
  if (!bw) return null;
  try { return JSON.parse(bw.manifestJson); } catch { return null; }
}

/**
 * Remove a wake word from the user's library. Returns true if anything
 * was actually deleted. Note: this does NOT clear references to the wwId
 * from device slot_assignments — those will start serving the firmware-
 * built-in slot again on next reload. (Trade-off: we'd need to walk the
 * voice-devices files to clean up, which is cheap. TODO if it becomes
 * confusing.)
 */
export function deleteLibraryWakeword(userId, wwId) {
  // Stock entries are read-only — deletion would require admin rights on
  // the OE install dir, which the per-user library API does not grant.
  if (isStockWwId(wwId)) return false;
  const paths = getLibraryWakeword(userId, wwId);
  if (!paths) return false;
  const dir = libraryDir(userId);
  for (const f of [`${wwId}.tflite`, `${wwId}.json`, `${wwId}._meta.json`]) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {
      console.warn(`[ww-lib] unlink ${p} failed: ${e.message}`);
    }
  }
  return true;
}
