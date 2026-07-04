/**
 * lib/stt.mjs — shared speech-to-text core.
 *
 * Extracted from the inline provider call in routes/config.mjs `/api/stt` so
 * two entry points share one implementation:
 *   - POST /api/stt          — the voice device's legacy buffered upload
 *   - ws-handler stt_end     — the streaming-STT path (binary WS frames
 *                              accumulated server-side, then transcribed)
 *
 * sttMode=local routes to the Faster-Whisper sidecar regardless of the
 * configured remote URL/key, so users can keep their Groq/OpenAI credentials
 * saved while flipping between local and remote.
 */
import { loadConfig } from '../routes/_helpers.mjs';

/**
 * Transcribe an audio buffer. Throws on provider/transport failure.
 * @param {Buffer} audioBuf   complete audio file bytes (wav/webm/…)
 * @param {object} opts       { mime, name, lang }
 * @returns {Promise<{transcript: string, raw: any}>}
 */
export async function transcribeAudio(audioBuf, { mime = 'audio/wav', name = 'speech.wav', lang = '' } = {}) {
  const cfg = loadConfig();
  const isLocal = cfg.sttMode === 'local';
  if (!isLocal && (!cfg.sttApiKey || !cfg.sttApiUrl)) {
    const err = new Error('STT provider not configured');
    err.code = 'STT_NOT_CONFIGURED';
    throw err;
  }
  const form = new FormData();
  form.append('file', new Blob([audioBuf], { type: mime }), name);
  form.append('model', cfg.sttModel || 'whisper-1');
  // Always pin a language. With none, multilingual Whisper auto-detects and,
  // on the silence/noise that follows a FALSE wake, hallucinates whatever is
  // statistically common in its training data. Caller-sent lang wins; else
  // the config default; else English.
  form.append('language', lang || cfg.sttLanguage || 'en');
  const sttUrl = isLocal
    ? 'http://127.0.0.1:5154/v1/audio/transcriptions'
    : cfg.sttApiUrl;
  const sttKey = isLocal ? 'local' : cfg.sttApiKey;
  const sttRes = await fetch(sttUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sttKey}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!sttRes.ok) throw new Error(`STT API returned ${sttRes.status}: ${await sttRes.text()}`);
  const data = await sttRes.json();
  let transcript = data.text ?? data.transcript ?? '';
  // Whisper renders times like "11:02 AM" as "11.02 AM" or just "11.22"
  // — period instead of colon. Normalize any HH.MM in valid time range
  // (00-23 hours, 00-59 minutes) to HH:MM. The bounds keep prices
  // ("$1.99") and version numbers ("v1.2") from getting rewritten.
  transcript = transcript.replace(
    /\b([0-1]?\d|2[0-3])\.([0-5]\d)\b/g,
    '$1:$2',
  );
  return { transcript, raw: data };
}

/**
 * Wrap raw 16 kHz mono s16le PCM in a minimal WAV container — the shape the
 * streaming-STT accumulator hands to transcribeAudio. Mirrors the firmware's
 * write_wav_header (oe_stt.c).
 */
export function wavWrapPcm16kMono(pcmBuf) {
  const header = Buffer.alloc(44);
  const sampleRate = 16000, channels = 1, bits = 16;
  const byteRate = sampleRate * channels * (bits / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bits / 8), 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]);
}
