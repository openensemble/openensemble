/**
 * Tutor Stats Ledger — per-user JSON at users/{userId}/tutorStats.json
 *
 * Streaks, XP, mastery, achievements, weekly goal, dayLog, shields.
 * Locked read-modify-write via withLock (same pattern as modifyActivity).
 * All day-boundary math is user-local; never UTC-slice for streak logic.
 */

import fs from 'fs';
import path from 'path';
import { withLock, getUserDir, getUser } from '../routes/_helpers.mjs';

const STATS_VERSION = 1;

// ── Level curve (triangular) ─────────────────────────────────────────────────
// xpForLevel(1)=100, (2)=300, (3)=600, (4)=1000, (5)=1500, (10)=5500...
export function xpForLevel(n) { return 100 * n * (n + 1) / 2; }
export function levelProgress(xp) {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) level++;
  const intoLevel = xp - xpForLevel(level);
  const nextLevelAt = xpForLevel(level + 1) - xpForLevel(level);
  return { level, intoLevel, nextLevelAt };
}

// ── Achievements (hardcoded starter set) ─────────────────────────────────────
export const ACHIEVEMENTS = [
  { id: 'first_quiz',       label: 'First quiz answered',        icon: '✍️' },
  { id: 'first_note',       label: 'First note saved',           icon: '📝' },
  { id: 'first_roadmap',    label: 'First roadmap built',        icon: '🗺️' },
  { id: 'streak_7',         label: '7-day streak',               icon: '🔥' },
  { id: 'streak_30',        label: '30-day streak',              icon: '🔥🔥' },
  { id: 'streak_100',       label: '100-day streak',             icon: '🔥🔥🔥' },
  { id: 'level_5',          label: 'Reached Level 5',            icon: '⭐' },
  { id: 'level_10',         label: 'Reached Level 10',           icon: '🌟' },
  { id: 'level_25',         label: 'Reached Level 25',           icon: '🏆' },
  { id: 'mastered_subject', label: 'Mastered a subject',         icon: '🎓' },
  { id: 'perfect_week',     label: 'Met weekly goal',            icon: '🎯' },
  { id: 'polyglot_3',       label: '3 active language subjects', icon: '🌍' },
  { id: 'night_owl',        label: 'Studied after 22:00',        icon: '🦉' },
  { id: 'early_bird',       label: 'Studied before 07:00',       icon: '🐦' },
  { id: 'perfect_10',       label: '10 correct in a row',        icon: '💯' },
];
const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map(a => a.id));

// ── Paths & defaults ─────────────────────────────────────────────────────────
function statsPath(userId) {
  return path.join(getUserDir(userId), 'tutorStats.json');
}

function defaultStats() {
  return {
    version: STATS_VERSION,
    xp: 0,
    level: 0,
    streak: { current: 0, longest: 0, lastStudyDay: '', shieldsAvailable: 1, shieldsUsedThisMonth: 0, lastShieldGrant: '' },
    tz: '',
    weeklyGoal: { minutesPerWeek: 150, daysPerWeek: 5 },
    subjects: {},
    achievements: [],
    dayLog: {},
    lastNudgeAt: '',
    createdAt: new Date().toISOString(),
  };
}

function defaultSubject() {
  return {
    mastery: 0,
    lastStudied: '',
    totalMinutes: 0,
    recentPerf: [],
    difficulty: 'medium',
    milestonesReached: [],
    streakCorrect: 0,
  };
}

export function loadTutorStats(userId) {
  const p = statsPath(userId);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Migrate: fill in any missing top-level fields from default
      const defaults = defaultStats();
      for (const k of Object.keys(defaults)) if (!(k in data)) data[k] = defaults[k];
      return data;
    }
  } catch (e) { console.warn('[tutor-stats] load failed for', userId + ':', e.message); }
  return defaultStats();
}

export function saveTutorStats(userId, stats) {
  const dir = getUserDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsPath(userId), JSON.stringify(stats, null, 2));
}

export function modifyTutorStats(userId, fn) {
  return withLock(statsPath(userId), async () => {
    const stats = loadTutorStats(userId);
    const result = await fn(stats);
    saveTutorStats(userId, stats);
    return { stats, result };
  });
}

// ── Timezone helpers ─────────────────────────────────────────────────────────
export function getUserTz(userId, stats = null) {
  if (stats?.tz) return stats.tz;
  const p = getUser(userId);
  return p?.tz || 'UTC';
}

// Returns YYYY-MM-DD in the user's local timezone (never UTC-slice for streaks).
export function getUserLocalDate(userId, date = new Date(), stats = null) {
  const tz = getUserTz(userId, stats);
  try {
    return date.toLocaleDateString('en-CA', { timeZone: tz });
  } catch { return date.toLocaleDateString('en-CA'); }
}

export function getUserLocalHour(userId, date = new Date(), stats = null) {
  const tz = getUserTz(userId, stats);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(date);
    return parseInt(parts.find(p => p.type === 'hour').value, 10);
  } catch { return date.getHours(); }
}

// Day difference in user-local terms: 0 = same day, 1 = yesterday, etc.
// Returns null if invalid input.
export function daysBetweenLocal(userId, prevYmd, curYmd) {
  if (!prevYmd || !curYmd) return null;
  // YMD strings are anchor-safe — parse as local midnight
  const [py, pm, pd] = prevYmd.split('-').map(Number);
  const [cy, cm, cd] = curYmd.split('-').map(Number);
  if (!py || !cy) return null;
  const prev = Date.UTC(py, pm - 1, pd);
  const cur = Date.UTC(cy, cm - 1, cd);
  return Math.round((cur - prev) / 86_400_000);
}

// ── Monday-local detection for shield refill ─────────────────────────────────
function isMondayLocal(userId, date, stats) {
  const tz = getUserTz(userId, stats);
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
    return name === 'Mon';
  } catch { return date.getDay() === 1; }
}

// ── XP / level ───────────────────────────────────────────────────────────────
// Mutates stats.xp and stats.level. Returns { gained, leveledUp, newLevel }.
function applyXp(stats, amount) {
  if (!amount || amount <= 0) return { gained: 0, leveledUp: false, newLevel: stats.level };
  const prevLevel = stats.level;
  stats.xp += amount;
  const { level } = levelProgress(stats.xp);
  const leveledUp = level > prevLevel;
  stats.level = level;
  return { gained: amount, leveledUp, newLevel: level };
}

// ── Achievement granting ─────────────────────────────────────────────────────
function grantAchievement(stats, id) {
  if (!ACHIEVEMENT_IDS.has(id)) return null;
  if (stats.achievements.some(a => a.id === id)) return null;
  const entry = { id, earnedAt: new Date().toISOString() };
  stats.achievements.push(entry);
  return entry;
}

// ── Streak roll ──────────────────────────────────────────────────────────────
// Called when there's study activity today. Determines whether today is a
// new day, whether a streak-day was missed, whether a shield saves the streak.
// Mutates stats.streak. Returns { dayChanged, streakIncremented, shieldConsumed, streakReset }.
function rollStreakOnActivity(stats, userId, now) {
  const today = getUserLocalDate(userId, now, stats);
  const last = stats.streak.lastStudyDay;
  if (last === today) return { dayChanged: false, streakIncremented: false, shieldConsumed: false, streakReset: false };
  const delta = last ? daysBetweenLocal(userId, last, today) : null;
  let streakIncremented = false, shieldConsumed = false, streakReset = false;
  if (!last) {
    stats.streak.current = 1;
    streakIncremented = true;
  } else if (delta === 1) {
    stats.streak.current += 1;
    streakIncremented = true;
  } else if (delta === 2 && stats.streak.shieldsAvailable > 0) {
    // One missed day, shield saves it → streak continues as +1 from last
    stats.streak.shieldsAvailable -= 1;
    stats.streak.shieldsUsedThisMonth = (stats.streak.shieldsUsedThisMonth || 0) + 1;
    stats.streak.current += 1;
    streakIncremented = true;
    shieldConsumed = true;
  } else if (delta > 1) {
    stats.streak.current = 1;
    streakIncremented = true;
    streakReset = true;
  } else if (delta === 0) {
    // Same-day edge case (already handled above, defensive)
  }
  if (stats.streak.current > (stats.streak.longest || 0)) stats.streak.longest = stats.streak.current;
  stats.streak.lastStudyDay = today;
  return { dayChanged: true, streakIncremented, shieldConsumed, streakReset };
}

function maybeGrantShield(stats, userId, now) {
  const today = getUserLocalDate(userId, now, stats);
  if (stats.streak.lastShieldGrant === today) return;
  if (!isMondayLocal(userId, now, stats)) return;
  // Refill to 1 (no stockpile)
  if ((stats.streak.shieldsAvailable || 0) < 1) stats.streak.shieldsAvailable = 1;
  stats.streak.lastShieldGrant = today;
  // Reset monthly count on first Monday of month
  const day = today.slice(-2);
  if (parseInt(day, 10) <= 7) stats.streak.shieldsUsedThisMonth = 0;
}

// ── Mastery recompute ────────────────────────────────────────────────────────
// Cheap: recency-weighted correctness (from recentPerf ring) × roadmap coverage.
function recomputeMastery(subj) {
  if (!subj.recentPerf?.length) { subj.mastery = 0; return; }
  const perf = subj.recentPerf;
  // Recency-weighted: latest answer weighs most
  let weightSum = 0, weighted = 0;
  for (let i = 0; i < perf.length; i++) {
    const w = i + 1; // 1..N
    weighted += perf[i] * w;
    weightSum += w;
  }
  const perfScore = weighted / weightSum;
  const milestones = (subj.milestonesReached?.length || 0);
  // Mastery ramps with milestones: 0 mastery → just perf; after 10 milestones → full weight
  const milestoneWeight = Math.min(1, milestones / 10);
  subj.mastery = Math.max(0, Math.min(1, 0.5 * perfScore + 0.5 * milestoneWeight * perfScore + 0.5 * (milestoneWeight * 0.5)));
  // Difficulty band from perf mean
  if (perfScore >= 0.85 && perf.length >= 5) subj.difficulty = 'hard';
  else if (perfScore <= 0.55 && perf.length >= 5) subj.difficulty = 'easy';
  else subj.difficulty = 'medium';
}

export function masteryBand(m) {
  if (m >= 0.85) return 'Mastered';
  if (m >= 0.6) return 'Advanced';
  if (m >= 0.3) return 'Intermediate';
  return 'Beginner';
}

// ── Main mutation API ────────────────────────────────────────────────────────
/**
 * Record a session of activity: minutes studied, questions answered, correctness, XP awarded.
 * Handles dayLog, recentPerf ring buffer, mastery recompute, and achievement grants.
 * Returns: { newAchievements: [...], masteryBandChanged, prevBand, newBand }.
 */
export async function recordSessionActivity(userId, subject, { minutes = 0, answered = 0, correct = 0, xp = 0, isCorrectQuiz = null } = {}) {
  const now = new Date();
  const { result } = await modifyTutorStats(userId, (stats) => {
    const today = getUserLocalDate(userId, now, stats);
    if (!stats.dayLog[today]) stats.dayLog[today] = { minutes: 0, xp: 0, answeredCorrect: 0, answered: 0, subjects: [] };
    const day = stats.dayLog[today];
    day.minutes = Math.round((day.minutes || 0) + minutes);
    day.answered += answered;
    day.answeredCorrect += correct;
    if (subject && !day.subjects.includes(subject)) day.subjects.push(subject);

    if (!stats.subjects[subject]) stats.subjects[subject] = defaultSubject();
    const subj = stats.subjects[subject];
    const prevBand = masteryBand(subj.mastery);
    subj.totalMinutes = Math.round((subj.totalMinutes || 0) + minutes);
    subj.lastStudied = now.toISOString();
    if (isCorrectQuiz !== null) {
      subj.recentPerf.push(isCorrectQuiz ? 1 : 0);
      while (subj.recentPerf.length > 10) subj.recentPerf.shift();
      subj.streakCorrect = isCorrectQuiz ? (subj.streakCorrect || 0) + 1 : 0;
    }
    recomputeMastery(subj);
    const newBand = masteryBand(subj.mastery);

    applyXp(stats, xp);
    day.xp = Math.round((day.xp || 0) + xp);

    // Achievements: check contextual unlocks
    const newAch = [];
    const hour = getUserLocalHour(userId, now, stats);
    if (answered > 0 && isCorrectQuiz !== null) {
      const a = grantAchievement(stats, 'first_quiz');
      if (a) newAch.push(a);
    }
    if (subj.streakCorrect >= 10) {
      const a = grantAchievement(stats, 'perfect_10');
      if (a) newAch.push(a);
    }
    if (hour >= 22) { const a = grantAchievement(stats, 'night_owl'); if (a) newAch.push(a); }
    if (hour < 7) { const a = grantAchievement(stats, 'early_bird'); if (a) newAch.push(a); }
    if (newBand === 'Mastered' && prevBand !== 'Mastered') {
      const a = grantAchievement(stats, 'mastered_subject');
      if (a) newAch.push(a);
    }
    // Level achievements
    if (stats.level >= 25) { const a = grantAchievement(stats, 'level_25'); if (a) newAch.push(a); }
    else if (stats.level >= 10) { const a = grantAchievement(stats, 'level_10'); if (a) newAch.push(a); }
    else if (stats.level >= 5) { const a = grantAchievement(stats, 'level_5'); if (a) newAch.push(a); }
    // Polyglot
    const langSubjects = Object.keys(stats.subjects).filter(s =>
      /^(french|spanish|german|japanese|chinese|mandarin|korean|italian|portuguese|russian|arabic|hindi|dutch|swedish|greek|hebrew|turkish|polish|vietnamese|thai|indonesian)(_|$)/.test(s)
    );
    if (langSubjects.length >= 3) { const a = grantAchievement(stats, 'polyglot_3'); if (a) newAch.push(a); }

    return { newAchievements: newAch, prevBand, newBand, masteryBandChanged: prevBand !== newBand };
  });
  return result;
}

/**
 * Record that the user studied today — idempotent per-day. Rolls streak, awards
 * a small daily-completion XP bonus (once per day), grants streak achievements.
 * Returns { newStreak, xpGained, leveledUp, achievements, shieldConsumed, dayChanged }.
 */
export async function claimDaily(userId) {
  const now = new Date();
  const { result } = await modifyTutorStats(userId, (stats) => {
    maybeGrantShield(stats, userId, now);
    const roll = rollStreakOnActivity(stats, userId, now);
    let xpGained = 0, leveledUp = false;
    const newAch = [];
    if (roll.dayChanged) {
      // Daily completion XP bonus
      const bonus = 20 + Math.min(50, stats.streak.current * 2); // 22 on day 1, 40 on day 10, capped
      const r = applyXp(stats, bonus);
      xpGained = r.gained;
      leveledUp = r.leveledUp;
      const today = getUserLocalDate(userId, now, stats);
      if (stats.dayLog[today]) stats.dayLog[today].xp = (stats.dayLog[today].xp || 0) + bonus;

      if (stats.streak.current === 7) { const a = grantAchievement(stats, 'streak_7'); if (a) newAch.push(a); }
      if (stats.streak.current === 30) { const a = grantAchievement(stats, 'streak_30'); if (a) newAch.push(a); }
      if (stats.streak.current === 100) { const a = grantAchievement(stats, 'streak_100'); if (a) newAch.push(a); }
      // Level achievements may fire here too
      if (stats.level >= 25) { const a = grantAchievement(stats, 'level_25'); if (a) newAch.push(a); }
      else if (stats.level >= 10) { const a = grantAchievement(stats, 'level_10'); if (a) newAch.push(a); }
      else if (stats.level >= 5) { const a = grantAchievement(stats, 'level_5'); if (a) newAch.push(a); }
    }
    return {
      newStreak: stats.streak.current,
      xpGained,
      leveledUp,
      achievements: newAch,
      shieldConsumed: roll.shieldConsumed,
      dayChanged: roll.dayChanged,
      streakReset: roll.streakReset,
      totalXp: stats.xp,
      level: stats.level,
    };
  });
  return result;
}

/**
 * Record a completed roadmap milestone. Returns { alreadyCompleted, newAchievements }.
 */
export async function recordMilestone(userId, subject, milestoneId) {
  if (!subject || !milestoneId) return { alreadyCompleted: false, newAchievements: [] };
  const { result } = await modifyTutorStats(userId, (stats) => {
    if (!stats.subjects[subject]) stats.subjects[subject] = defaultSubject();
    const subj = stats.subjects[subject];
    if (subj.milestonesReached.includes(milestoneId)) return { alreadyCompleted: true, newAchievements: [] };
    subj.milestonesReached.push(milestoneId);
    recomputeMastery(subj);
    const newAch = [];
    if (subj.milestonesReached.length === 1) {
      const a = grantAchievement(stats, 'first_roadmap');
      if (a) newAch.push(a);
    }
    applyXp(stats, 50); // Milestone completion bonus
    return { alreadyCompleted: false, newAchievements: newAch };
  });
  return result;
}

/**
 * Set weekly goal. Returns the updated goal object.
 */
export async function setWeeklyGoal(userId, { minutesPerWeek, daysPerWeek }) {
  const { stats } = await modifyTutorStats(userId, (stats) => {
    if (typeof minutesPerWeek === 'number' && minutesPerWeek > 0) stats.weeklyGoal.minutesPerWeek = Math.min(minutesPerWeek, 5000);
    if (typeof daysPerWeek === 'number' && daysPerWeek > 0) stats.weeklyGoal.daysPerWeek = Math.min(Math.max(1, daysPerWeek), 7);
  });
  return stats.weeklyGoal;
}

/**
 * Compute adaptation signal for a subject.
 */
export function getAdaptation(userId, subject) {
  const stats = loadTutorStats(userId);
  const subj = stats.subjects[subject] || defaultSubject();
  const perf = subj.recentPerf;
  const recentPerfScore = perf.length ? perf.reduce((a, b) => a + b, 0) / perf.length : 0.5;
  const difficulty = subj.difficulty || 'medium';
  // Widget mix suggestions
  let suggestedMix;
  if (difficulty === 'easy' || perf.length < 3) {
    suggestedMix = { quiz: 0.5, flashcard: 0.3, fill_blank: 0.2, free_response: 0, cloze: 0, matching: 0, ordering: 0 };
  } else if (difficulty === 'hard') {
    suggestedMix = { quiz: 0.1, flashcard: 0.15, fill_blank: 0.2, free_response: 0.3, cloze: 0.15, matching: 0.05, ordering: 0.05 };
  } else {
    suggestedMix = { quiz: 0.25, flashcard: 0.2, fill_blank: 0.2, free_response: 0.15, cloze: 0.1, matching: 0.05, ordering: 0.05 };
  }
  return {
    difficulty,
    recentPerfScore: Math.round(recentPerfScore * 100) / 100,
    mastery: Math.round(subj.mastery * 100) / 100,
    masteryBand: masteryBand(subj.mastery),
    streakCorrect: subj.streakCorrect || 0,
    recentSampleSize: perf.length,
    suggestedMix,
  };
}

/**
 * Weekly recap — counts days in current ISO week that hit minimum minutes.
 * Returns { weekStart, weekEnd, minutesStudied, daysStudied, goalMet, perfectWeek }.
 */
export function getWeeklyRecap(userId, now = new Date()) {
  const stats = loadTutorStats(userId);
  const tz = getUserTz(userId, stats);
  // Determine Monday-local of current week as anchor
  const todayYmd = getUserLocalDate(userId, now, stats);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const anchor = new Date(Date.UTC(ty, tm - 1, td));
  const dayOfWeek = ((anchor.getUTCDay() + 6) % 7); // 0=Mon
  const weekStart = new Date(anchor.getTime() - dayOfWeek * 86_400_000);
  const weekEnd = new Date(weekStart.getTime() + 6 * 86_400_000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = ymd(new Date(weekStart.getTime() + i * 86_400_000));
    days.push({ date: d, entry: stats.dayLog[d] || null });
  }
  const minutesStudied = days.reduce((s, d) => s + (d.entry?.minutes || 0), 0);
  const daysStudied = days.filter(d => (d.entry?.minutes || 0) > 0).length;
  const goal = stats.weeklyGoal;
  const minutesGoalMet = minutesStudied >= (goal.minutesPerWeek || 150);
  const daysGoalMet = daysStudied >= (goal.daysPerWeek || 5);
  const goalMet = minutesGoalMet && daysGoalMet;
  const daysMetGoal = days.filter(d => (d.entry?.minutes || 0) >= 10).length;
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const heatStrip = days.map((d, i) => ({
    date: d.date,
    label: labels[i],
    minutes: d.entry?.minutes || 0,
    goalMet: (d.entry?.minutes || 0) >= 10,
  }));
  return {
    weekStart: ymd(weekStart), weekEnd: ymd(weekEnd),
    minutesStudied, totalMinutes: minutesStudied,
    daysStudied, daysMetGoal, goalMet, days, goal, tz, heatStrip,
  };
}

/**
 * Set the user's timezone (captured once from the browser).
 */
export async function setUserTz(userId, tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 60) return;
  await modifyTutorStats(userId, (stats) => { stats.tz = tz; });
}

/**
 * Mark a nudge as fired (so we don't over-fire).
 */
export async function recordNudgeFired(userId) {
  await modifyTutorStats(userId, (stats) => { stats.lastNudgeAt = new Date().toISOString(); });
}

/**
 * Weekly wrap-up — grants `perfect_week` on the first week the user meets
 * their goal. Returns { recap, granted } where granted is the achievement
 * entry (first-time only) or null.
 */
export async function runWeekWrap(userId, now = new Date()) {
  const recap = getWeeklyRecap(userId, now);
  if (!recap.goalMet) return { recap, granted: null };
  const { result } = await modifyTutorStats(userId, (stats) => {
    return grantAchievement(stats, 'perfect_week');
  });
  return { recap, granted: result };
}

/**
 * Prune subjects that have zero entries in memory (caller confirms).
 */
export async function pruneEmptySubjects(userId, subjectsWithData) {
  const have = new Set(subjectsWithData || []);
  await modifyTutorStats(userId, (stats) => {
    for (const s of Object.keys(stats.subjects)) {
      if (!have.has(s) && !stats.subjects[s].lastStudied) delete stats.subjects[s];
    }
  });
}
