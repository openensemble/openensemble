#!/usr/bin/env node
// scripts/elevenlabs-list-voices.mjs
//
// Browse ElevenLabs voices to pick one for corpus synthesis. Defaults to
// the shared library filtered for Australian female English.
//
// Usage:
//   ELEVEN_API_KEY=sk_... node scripts/elevenlabs-list-voices.mjs
//   ELEVEN_API_KEY=sk_... node scripts/elevenlabs-list-voices.mjs --mine
//   ELEVEN_API_KEY=sk_... node scripts/elevenlabs-list-voices.mjs --gender male --accent british
//
// Prints: voice_id  name  (accent, gender, age) — preview_url

const apiKey = process.env.ELEVEN_API_KEY;
if (!apiKey) { console.error('ELEVEN_API_KEY not set'); process.exit(1); }

const argv = process.argv.slice(2);
const opt = (k, dflt) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : dflt;
};
const mine = argv.includes('--mine');
const gender = opt('gender', 'female');
const accent = opt('accent', 'australian');
const language = opt('language', 'en');
const search = opt('search', '');
const pageSize = parseInt(opt('page-size', '50'), 10);

async function listMine() {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    accent: v.labels?.accent || '',
    gender: v.labels?.gender || '',
    age: v.labels?.age || '',
    preview: v.preview_url || '',
  }));
}

async function listShared() {
  const params = new URLSearchParams({
    page_size: String(pageSize),
    gender,
    language,
  });
  if (accent) params.set('accent', accent);
  if (search) params.set('search', search);
  const res = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params}`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    accent: v.accent || '',
    gender: v.gender || '',
    age: v.age || '',
    preview: v.preview_url || '',
  }));
}

const voices = mine ? await listMine() : await listShared();

if (!voices.length) {
  console.log('No voices matched. Try --mine, or relax --accent / --gender filters.');
  process.exit(0);
}

const idW = Math.max(...voices.map(v => v.id.length));
const nameW = Math.max(...voices.map(v => v.name.length));
for (const v of voices) {
  const meta = [v.accent, v.gender, v.age].filter(Boolean).join(', ');
  console.log(`${v.id.padEnd(idW)}  ${v.name.padEnd(nameW)}  (${meta})  ${v.preview}`);
}
console.log(`\n${voices.length} voice(s). Pass --voice-id <id> to scripts/piper-elevenlabs-corpus.mjs`);
