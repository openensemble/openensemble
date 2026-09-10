import fs from 'node:fs';
import path from 'node:path';
import { USERS_DIR } from './paths.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

function calibrationPath(userId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid calibration owner');
  return path.join(USERS_DIR, userId, 'voice-calibration.json');
}
function read(userId) {
  try { return JSON.parse(fs.readFileSync(calibrationPath(userId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export function deviceWakeCutoff(userId, deviceId, slot, assignment) {
  try {
    const saved = read(userId)[`${deviceId}:${slot}`];
    if (saved?.wakewordId === assignment?.wakewordId && saved?.ownerUserId === assignment?.ownerUserId
        && typeof saved?.cutoff === 'number' && saved.cutoff >= 0.5 && saved.cutoff <= 0.99) return saved.cutoff;
  } catch {}
  return undefined;
}
export async function saveDeviceWakeCutoff(userId, deviceId, slot, assignment, cutoff) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId) || !Number.isInteger(slot) || slot < 0 || slot > 5) throw new Error('Invalid device or slot');
  if (cutoff !== null && !(typeof cutoff === 'number' && Number.isFinite(cutoff) && cutoff >= 0.5 && cutoff <= 0.99)) throw new Error('Sensitivity cutoff must be between 0.50 and 0.99.');
  const file = calibrationPath(userId);
  await withLock(file, () => {
    const records = read(userId);
    const key = `${deviceId}:${slot}`;
    if (cutoff === null) delete records[key];
    else records[key] = { wakewordId: assignment.wakewordId, ownerUserId: assignment.ownerUserId, cutoff: Math.round(cutoff * 100) / 100, at: Date.now() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify(records), { mode: 0o600 });
  });
}

export function summarizeRoomCalibration(samples, turns, { startedAt, quietUntil, slot }) {
  const quiet = samples.filter(sample => sample.ts >= startedAt && sample.ts <= quietUntil);
  const attempts = turns.filter(turn => turn.startedAt > quietUntil && turn.wake?.slot === slot && turn.wake?.decision !== 'followup');
  const quietScores = quiet.flatMap(sample => sample.peaks.filter(peak => peak.slot === slot).map(peak => peak.score));
  const scores = attempts.map(turn => turn.wake?.score).filter(score => typeof score === 'number' && Number.isFinite(score));
  const quietPeak = quietScores.length ? Math.max(...quietScores) : null;
  const speechMin = scores.length ? Math.min(...scores) : null;
  const levels = quiet.map(sample => sample.audioLevel).filter(value => Number.isFinite(value));
  let recommendation = null;
  let explanation = 'Collect at least two quiet-room samples and three deliberate wake attempts before choosing a cutoff.';
  if (quietScores.length >= 2 && scores.length >= 3) {
    if (speechMin >= 0.60 && speechMin - quietPeak >= 0.12) {
      recommendation = Math.max(0.5, Math.min(0.95, Math.floor((quietPeak + speechMin) * 50) / 100));
      explanation = 'Quiet-room scores and deliberate wakes were separated. Try this average-score cutoff, then repeat the check from your normal speaking position.';
    } else explanation = 'Room noise and wake scores overlap, or deliberate wakes are too weak. Move the device away from speakers or fans and repeat calibration before tightening sensitivity.';
  }
  return { quietSamples: quietScores.length, attempts: scores.length, quietPeak, speechMin,
    quietLevel: levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) : null,
    recommendation, explanation };
}
