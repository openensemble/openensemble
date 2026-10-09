import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVoiceConfig, findUsersSharingTo } from './voice-config.mjs';
import { getVoiceRef } from './voice-refs.mjs';
import { readLibraryWakeword } from './wakeword-library.mjs';
import { accountSpeechVoice } from './mobile-voice.mjs';

export function mobileVoicePreferences(userId) {
  const assignments = readVoiceConfig(userId).slot_assignments;
  const incoming = findUsersSharingTo(userId);
  const own = Object.entries(assignments).sort(([a], [b]) => Number(a) - Number(b))
    .find(([, a]) => a?.ownerUserId === userId && a.wakewordId);
  const shared = incoming.filter(a => a.assignment?.ownerUserId === userId && a.assignment.wakewordId)
    .sort((a, b) => a.ownerUserId.localeCompare(b.ownerUserId) || a.slot - b.slot)[0];
  const assignment = own?.[1] || shared?.assignment;
  const owner = own ? userId : shared?.ownerUserId;
  const word = assignment && readLibraryWakeword(owner, assignment.wakewordId);
  const phrase = word ? JSON.parse(word.manifestJson).wake_word : null;
  return { wakePhrase: typeof phrase === 'string' && phrase.trim() ? phrase.trim() : 'Hey OE',
    pauseSeconds: 1.2, followUpSeconds: 8 };
}

export function mobilePocketVoice(userId, cfg) {
  const selected = accountSpeechVoice(userId, readVoiceConfig(userId).slot_assignments,
    cfg.ttsVoice || '', findUsersSharingTo(userId));
  const v = selected.voice;
  if (v.startsWith('ref_')) {
    const ref = getVoiceRef(selected.ownerUserId, v);
    if (ref) return { refPath: ref.wavPath, voice: null };
  }
  const defaultPath = path.join(os.homedir(), '.openensemble', 'models', 'tts', 'pocket-tts', 'default-voice.safetensors');
  if ((!v || v === 'default' || v === 'default-en' || v.startsWith('ref_')) && fs.existsSync(defaultPath)) {
    return { refPath: defaultPath, voice: null };
  }
  return { refPath: null, voice: v && !v.startsWith('ref_') ? v : 'george' };
}
