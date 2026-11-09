/**
 * lib/stt.mjs — shared speech-to-text core.
 *
 * Extracted from the inline provider call in routes/config.mjs `/api/stt` so
 * voice entry points share one implementation:
 *   - POST /api/stt          — the voice device's legacy buffered upload
 *   - ws-handler stt_end     — the streaming-STT path (binary WS frames
 *                              accumulated server-side, then transcribed)
 *   - OE wake verification  — bounded transcription using the current provider
 *
 * sttMode=local routes to the selected local speech service regardless of the
 * configured remote URL/key, so users can keep their Groq/OpenAI credentials
 * saved while flipping between local and remote.
 */
import { loadConfig } from '../routes/_helpers.mjs';
import { localSttProvider, localSttUrl } from './local-stt.mjs';

/**
 * Transcribe an audio buffer. Throws on provider/transport failure.
 * @param {Buffer} audioBuf   complete audio file bytes (wav/webm/…)
 * @param {object} opts       { mime, name, lang, timeoutMs, temperature, responseFormat, redirect, maxResponseBytes }
 * @returns {Promise<{transcript: string, raw: any}>}
 */
export async function transcribeAudio(audioBuf, {
  mime = 'audio/wav', name = 'speech.wav', lang = '', timeoutMs = 30000,
  temperature, responseFormat, redirect = 'follow', maxResponseBytes,
} = {}) {
  const cfg = loadConfig();
  const isLocal = cfg.sttMode === 'local';
  if (!isLocal && (!cfg.sttApiKey || !cfg.sttApiUrl)) {
    const err = new Error('STT provider not configured');
    err.code = 'STT_NOT_CONFIGURED';
    throw err;
  }
  const form = new FormData();
  form.append('file', new Blob([audioBuf], { type: mime }), name);
  form.append('model', isLocal ? localSttProvider(cfg).model : (cfg.sttModel || 'whisper-1'));
  // Always pin a language. With none, multilingual Whisper auto-detects and,
  // on the silence/noise that follows a FALSE wake, hallucinates whatever is
  // statistically common in its training data. Caller-sent lang wins; else
  // the config default; else English.
  form.append('language', lang || cfg.sttLanguage || 'en');
  if (temperature !== undefined) form.append('temperature', String(temperature));
  if (responseFormat) form.append('response_format', responseFormat);
  const sttUrl = isLocal
    ? localSttUrl(localSttProvider(cfg))
    : cfg.sttApiUrl;
  const sttKey = isLocal ? 'local' : cfg.sttApiKey;
  const sttRes = await fetch(sttUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sttKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
    redirect,
  });
  if (!sttRes.ok) {
    if (maxResponseBytes != null) {
      await sttRes.body?.cancel().catch(() => {});
      throw new Error(`STT API returned ${sttRes.status}`);
    }
    throw new Error(`STT API returned ${sttRes.status}: ${await sttRes.text()}`);
  }
  const data = await readSttJson(sttRes, maxResponseBytes);
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

// A short wake window should never produce an unbounded response. Other STT
// callers retain their existing response handling for longer recordings.
async function readSttJson(response, maxBytes) {
  if (maxBytes == null) return response.json();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
      || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('STT response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty STT response');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('STT response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
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
