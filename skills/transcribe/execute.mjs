/**
 * Transcribe skill — speech-to-text for audio/video files on disk.
 *
 * Routes through OE's configured STT path the same way the voice-device
 * /api/stt route does, so users get whichever STT backend they've picked
 * (local Faster-Whisper or a remote API). Video files get their audio
 * track extracted with ffmpeg to a temp wav before upload, since faster-
 * whisper handles audio containers but not raw video.
 *
 * Tool:
 *   transcribe_file({ path, language? }) → { text, durationSec, language, sourceBytes }
 *
 * Notes:
 *   - Path access is gated to user file dirs (~/.openensemble/users/<id>/files/...)
 *     and the caller's own per-user scratch dir (os.tmpdir()/oe-<userId>/).
 *     Absolute paths outside those — including another user's /tmp staging —
 *     are rejected so an LLM hallucination can't read /etc/shadow or a peer's
 *     upload.
 *   - Files over 500 MB are rejected before upload — at that size, you want
 *     to split the file manually anyway (long videos induce Whisper hallucination).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig } from '../../routes/_helpers.mjs';
import { getUserFilesDir, USER_FILE_KINDS } from '../../lib/paths.mjs';

// Exported so the chat-dispatch attachment fast-path can reuse them
// (audio/video attachments → same STT pipeline as @-mentioned files).
export const MAX_BYTES = 500 * 1024 * 1024;
export const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus']);
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv']);

export function isAllowedPath(absPath, userId) {
  if (!absPath || typeof absPath !== 'string') return false;
  const resolved = path.resolve(absPath);
  // Per-user scratch under the OS temp dir (oe-<userId>/…). A bare /tmp
  // allowlist let transcribe_file read ANOTHER user's staged upload — scope it
  // to this caller's own subdir. (Real attachment transcriptions resolve to the
  // user-files dir below, not /tmp, so this doesn't affect the normal flow.)
  if (userId) {
    const scratchRoot = path.join(os.tmpdir(), `oe-${userId}`);
    if (resolved === scratchRoot || resolved.startsWith(scratchRoot + path.sep)) return true;
  }
  // Any of the user's own file kinds.
  for (const kind of USER_FILE_KINDS) {
    const root = getUserFilesDir(userId, kind);
    if (resolved.startsWith(root + path.sep) || resolved === root) return true;
  }
  return false;
}

export async function extractAudio(videoPath) {
  // ffmpeg → 16 kHz mono wav (matches Whisper's native input rate).
  // Output goes to a tmpfile we delete after upload.
  const out = path.join(os.tmpdir(), `oe-transcribe-${Date.now()}-${process.pid}.wav`);
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav',
      out,
    ]);
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  return out;
}

export async function sttUpload(filePath, language) {
  const cfg = loadConfig();
  const isLocal = cfg.sttMode === 'local';
  const sttUrl = isLocal
    ? 'http://127.0.0.1:5154/v1/audio/transcriptions'
    : cfg.sttApiUrl;
  const sttKey = isLocal ? 'local' : cfg.sttApiKey;
  if (!sttUrl) throw new Error('STT is not configured');

  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(filePath));
  form.append('model', cfg.sttModel || 'whisper-1');
  if (language) form.append('language', language);

  // 5 minutes — long audio can take a while even on GPU. faster-whisper local
  // is fast; remote may need every second.
  const r = await fetch(sttUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sttKey || 'placeholder'}` },
    body: form,
    signal: AbortSignal.timeout(300000),
  });
  if (!r.ok) throw new Error(`STT returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function executeSkillTool(name, args, userId) {
  if (args?.__validate) return '';
  if (name !== 'transcribe_file') return `unknown tool: ${name}`;

  const rawPath = String(args?.path || '').trim();
  if (!rawPath) return 'Missing required argument: path';

  const abs = path.resolve(rawPath);
  if (!isAllowedPath(abs, userId)) {
    return `Refused: path is outside your user-files directories and your per-user scratch dir. Got: ${abs}`;
  }
  if (!fs.existsSync(abs)) return `File not found: ${abs}`;
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return `Not a regular file: ${abs}`;
  if (stat.size > MAX_BYTES) {
    return `File is ${(stat.size / 1024 / 1024).toFixed(0)} MB — too large for one-shot transcription. Split into smaller chunks.`;
  }
  if (stat.size === 0) return 'File is empty (0 bytes).';

  const ext = path.extname(abs).toLowerCase();
  const isAudio = AUDIO_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  if (!isAudio && !isVideo) {
    return `Unsupported file type: ${ext}. Audio: ${[...AUDIO_EXTS].join(' ')} · Video: ${[...VIDEO_EXTS].join(' ')}`;
  }

  let uploadPath = abs;
  let extractedAudio = null;
  if (isVideo) {
    try {
      extractedAudio = await extractAudio(abs);
      uploadPath = extractedAudio;
    } catch (e) {
      return `Failed to extract audio from video (${e.message}). Is ffmpeg installed?`;
    }
  }

  try {
    const started = Date.now();
    const result = await sttUpload(uploadPath, args.language);
    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    const text = result.text ?? result.transcript ?? '';
    return JSON.stringify({
      text: text.trim(),
      file: path.basename(abs),
      bytes: stat.size,
      elapsedSec,
      language: result.language ?? args.language ?? null,
    });
  } catch (e) {
    return `Transcription failed: ${e.message}`;
  } finally {
    if (extractedAudio) { try { fs.unlinkSync(extractedAudio); } catch {} }
  }
}
