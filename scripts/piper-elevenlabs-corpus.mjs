#!/usr/bin/env node
// scripts/piper-elevenlabs-corpus.mjs
//
// Synthesize a sentence list with ElevenLabs, write 22050 Hz mono WAV files
// + LJSpeech-style metadata.csv ready for Piper fine-tuning. Resumable —
// existing wavs are skipped.
//
// Note: ElevenLabs ToS restricts using generated audio to train competing
// TTS systems. Personal/internal use of a Piper voice is generally fine but
// check current terms before redistributing the trained voice.
//
// Usage:
//   ELEVEN_API_KEY=sk_... \
//   node scripts/piper-elevenlabs-corpus.mjs \
//     --voice-id <eleven_voice_id> \
//     --sentences ~/piper-training/aussie-female-v1/sentences.csv \
//     --out       ~/piper-training/aussie-female-v1 \
//     [--model eleven_multilingual_v2]   # or eleven_turbo_v2_5
//     [--stability 0.5] [--similarity 0.75] [--style 0.0]
//     [--delay-ms 150]
//
// Output layout:
//   <out>/wav/<id>.wav        signed 16-bit PCM, 22050 Hz, mono
//   <out>/metadata.csv        id|text   (Piper preprocess input)

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (k, dflt) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : dflt;
};

const apiKey = process.env.ELEVEN_API_KEY;
const voiceId = opt('voice-id');
const sentencesPath = opt('sentences');
const outDir = opt('out');
const modelId = opt('model', 'eleven_multilingual_v2');
const stability = parseFloat(opt('stability', '0.5'));
const similarity = parseFloat(opt('similarity', '0.75'));
const style = parseFloat(opt('style', '0'));
const delayMs = parseInt(opt('delay-ms', '150'), 10);

if (!apiKey || !voiceId || !sentencesPath || !outDir) {
  console.error('Missing required args. See header for usage.');
  process.exit(1);
}

const wavDir = path.join(outDir, 'wav');
fs.mkdirSync(wavDir, { recursive: true });

const sentences = fs.readFileSync(sentencesPath, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && l.includes('|'))
  .map(line => {
    const idx = line.indexOf('|');
    return { id: line.slice(0, idx).trim(), text: line.slice(idx + 1).trim() };
  });

function writeWav(pcmBuf, outPath, sampleRate = 22050) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(outPath, Buffer.concat([header, pcmBuf]));
}

async function synth(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_22050`;
  const body = {
    text,
    model_id: modelId,
    voice_settings: {
      stability,
      similarity_boost: similarity,
      style,
      use_speaker_boost: true,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/pcm',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${errText.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

const metaPath = path.join(outDir, 'metadata.csv');
const existingMeta = fs.existsSync(metaPath)
  ? new Set(
      fs.readFileSync(metaPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => l.split('|')[0]),
    )
  : new Set();
const metaStream = fs.createWriteStream(metaPath, { flags: 'a' });

let synthed = 0, skipped = 0, failed = 0, totalChars = 0;
const startTime = Date.now();

for (const { id, text } of sentences) {
  const wavPath = path.join(wavDir, `${id}.wav`);
  const wavExists = fs.existsSync(wavPath);
  const metaExists = existingMeta.has(id);

  if (wavExists && metaExists) { skipped++; continue; }

  if (!wavExists) {
    let attempt = 0;
    let ok = false;
    while (attempt < 4) {
      try {
        const pcm = await synth(text);
        writeWav(pcm, wavPath);
        synthed++;
        totalChars += text.length;
        ok = true;
        break;
      } catch (err) {
        attempt++;
        const wait = 2000 * attempt;
        console.warn(`${id} retry ${attempt} after ${wait}ms: ${err.message}`);
        await sleep(wait);
      }
    }
    if (!ok) { failed++; console.error(`FAILED ${id}`); continue; }
  }

  if (!metaExists) {
    metaStream.write(`${id}|${text}\n`);
    existingMeta.add(id);
  }

  const done = synthed + skipped;
  if (done % 10 === 0 || done === sentences.length) {
    const secs = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`[${done}/${sentences.length}] synthed=${synthed} skipped=${skipped} failed=${failed} chars=${totalChars} t=${secs}s`);
  }

  if (delayMs > 0) await sleep(delayMs);
}

metaStream.end();
const secs = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('');
console.log(`Done. synthed=${synthed} skipped=${skipped} failed=${failed} chars=${totalChars} time=${secs}s`);
console.log(`Wavs:     ${wavDir}`);
console.log(`Metadata: ${metaPath}`);
console.log('');
console.log('Next: fine-tune Piper. Rough recipe:');
console.log('  pip install piper-tts piper-train');
console.log(`  python -m piper_train.preprocess \\`);
console.log(`    --language en-au --input-dir ${outDir} \\`);
console.log(`    --output-dir ${outDir}/train --dataset-format ljspeech \\`);
console.log(`    --single-speaker --sample-rate 22050`);
console.log('  # then download a base medium checkpoint (e.g. en_GB-alba-medium) and:');
console.log(`  python -m piper_train fit --data.config-path ${outDir}/train/config.json \\`);
console.log('    --trainer.devices 1 --trainer.accelerator gpu \\');
console.log('    --resume_from_checkpoint <base.ckpt> --trainer.max_epochs 4000');
