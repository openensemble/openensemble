/**
 * routes/tutor.mjs
 * HTTP API for the tutor role: reminder prefs, stats, today dashboard data,
 * activity beacon, timezone capture.
 *
 * Endpoints:
 *   GET  /api/tutor/reminders       — current prefs
 *   PUT  /api/tutor/reminders       — update prefs (rebuilds user's tutor-tagged tasks)
 *   GET  /api/tutor/stats           — full stats snapshot
 *   GET  /api/tutor/today           — dashboard payload (stats + due reviews + weekly recap)
 *   POST /api/tutor/activity-beacon — heartbeat from tutor UI → rolls dayLog.minutes
 *   POST /api/tutor/tz              — capture user tz on first tutor interaction
 */

import { requireAuth, readBody, getUser, saveUser } from './_helpers.mjs';
import {
  loadTutorStats, recordSessionActivity, getWeeklyRecap, setUserTz, setWeeklyGoal,
  masteryBand, levelProgress,
} from '../lib/tutor-stats.mjs';
import { loadTasks, addTask, removeTask } from '../scheduler.mjs';

const DEFAULT_REMINDER_PREFS = {
  enabled: false,
  channel: 'websocket',
  dailyTime: '19:30',
  subjects: [],
  quietHours: { start: '22:30', end: '08:00' },
  streakAtRiskNudge: true,
  celebrationNotifications: true,
  primeCoordinator: false,
};

function readPrefs(userId) {
  const user = getUser(userId);
  return { ...DEFAULT_REMINDER_PREFS, ...(user?.tutorReminders || {}) };
}

function writePrefs(userId, patch) {
  const user = getUser(userId);
  if (!user) throw new Error('user not found');
  const current = { ...DEFAULT_REMINDER_PREFS, ...(user.tutorReminders || {}) };
  const next = { ...current, ...patch };
  if (patch.quietHours) next.quietHours = { ...current.quietHours, ...patch.quietHours };
  user.tutorReminders = next;
  saveUser(user);
  return next;
}

/**
 * Rebuild the user's tutor-tagged scheduler tasks from their current prefs.
 * Removes any existing tasks with meta.tutor=true for this user, then adds
 * the daily nudge (and streak-at-risk nudge if enabled).
 */
async function rebuildTutorTasks(userId) {
  const prefs = readPrefs(userId);
  const stats = loadTutorStats(userId);
  const tz = stats.tz || null;

  for (const t of loadTasks()) {
    if (t.ownerId === userId && t?.meta?.tutor) {
      try { removeTask(t.id); } catch {}
    }
  }
  if (!prefs.enabled || prefs.channel === 'off') return { added: 0 };

  const added = [];
  added.push(await addTask({
    ownerId: userId,
    type: 'builtin',
    handler: 'tutorNudge',
    label: 'Tutor daily reminder',
    time: prefs.dailyTime,
    timezone: tz || undefined,
    repeat: 'daily',
    meta: { tutor: true, kind: 'daily' },
  }));
  if (prefs.streakAtRiskNudge) {
    const atRisk = computeAtRiskTime(prefs.quietHours?.start || '22:30');
    added.push(await addTask({
      ownerId: userId,
      type: 'builtin',
      handler: 'tutorNudge',
      label: 'Tutor streak-at-risk nudge',
      time: atRisk,
      timezone: tz || undefined,
      repeat: 'daily',
      meta: { tutor: true, kind: 'at_risk' },
    }));
  }
  added.push(await addTask({
    ownerId: userId,
    type: 'builtin',
    handler: 'tutorWeekWrap',
    label: 'Tutor weekly wrap-up',
    time: '21:00',
    timezone: tz || undefined,
    repeat: 'daily', // handler self-gates to Sunday user-local
    meta: { tutor: true, kind: 'week_wrap' },
  }));
  // Avoid dragging the scheduler import surface into this module; a dynamic
  // reload is triggered elsewhere via scheduleNewTask (addTask) already.
  return { added: added.length };
}

function computeAtRiskTime(quietStart) {
  const [h, m] = String(quietStart).split(':').map(Number);
  if (Number.isNaN(h)) return '20:30';
  const total = (h * 60 + (m || 0)) - 120; // 2 hours before quiet hours
  const wrapped = (total + 24 * 60) % (24 * 60);
  const hh = Math.floor(wrapped / 60), mm = wrapped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
  return true;
}

export async function handle(req, res) {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/tutor/')) return false;

  const userId = requireAuth(req, res);
  if (!userId) return true;

  if (url === '/api/tutor/reminders' && req.method === 'GET') {
    return json(res, 200, readPrefs(userId));
  }

  if (url === '/api/tutor/reminders' && req.method === 'PUT') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      // Validate fields we accept
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.channel === 'string' && ['websocket','telegram','email','off'].includes(body.channel)) patch.channel = body.channel;
      if (typeof body.dailyTime === 'string' && /^\d{1,2}:\d{2}$/.test(body.dailyTime)) patch.dailyTime = body.dailyTime;
      if (typeof body.streakAtRiskNudge === 'boolean') patch.streakAtRiskNudge = body.streakAtRiskNudge;
      if (typeof body.celebrationNotifications === 'boolean') patch.celebrationNotifications = body.celebrationNotifications;
      if (typeof body.primeCoordinator === 'boolean') patch.primeCoordinator = body.primeCoordinator;
      if (body.quietHours && typeof body.quietHours === 'object') {
        const qh = {};
        if (typeof body.quietHours.start === 'string' && /^\d{1,2}:\d{2}$/.test(body.quietHours.start)) qh.start = body.quietHours.start;
        if (typeof body.quietHours.end   === 'string' && /^\d{1,2}:\d{2}$/.test(body.quietHours.end))   qh.end   = body.quietHours.end;
        if (Object.keys(qh).length) patch.quietHours = qh;
      }
      if (patch.channel === 'off') patch.enabled = false;
      if (patch.channel && patch.channel !== 'off' && patch.enabled === undefined) patch.enabled = true;
      writePrefs(userId, patch);
      const rebuilt = await rebuildTutorTasks(userId);
      return json(res, 200, { ok: true, prefs: readPrefs(userId), tasks: rebuilt });
    } catch (e) {
      return json(res, 400, { error: 'Invalid body', detail: e.message });
    }
  }

  if (url === '/api/tutor/stats' && req.method === 'GET') {
    const stats = loadTutorStats(userId);
    const { level, intoLevel, nextLevelAt } = levelProgress(stats.xp);
    return json(res, 200, { stats, level, intoLevel, nextLevelAt });
  }

  if (url === '/api/tutor/today' && req.method === 'GET') {
    const stats = loadTutorStats(userId);
    const { level, intoLevel, nextLevelAt } = levelProgress(stats.xp);
    const recap = getWeeklyRecap(userId, new Date());
    const subjects = Object.entries(stats.subjects).map(([id, s]) => ({
      id,
      mastery: s.mastery,
      band: masteryBand(s.mastery),
      totalMinutes: s.totalMinutes,
      lastStudied: s.lastStudied,
      difficulty: s.difficulty,
    })).sort((a, b) => (b.lastStudied || '').localeCompare(a.lastStudied || ''));
    // Pull due reviews lazily to avoid forcing lance init on every request.
    let dueReviews = [];
    try {
      const { getDueReviews } = await import('../memory/recall.mjs');
      dueReviews = await getDueReviews({ agentId: 'tutor', type: 'params', userId, limit: 10 });
    } catch {}
    return json(res, 200, {
      stats, level, intoLevel, nextLevelAt, recap, subjects,
      dueReviews: dueReviews.map(m => ({
        id: m.id, text: m.text, category: m.category, subject: m.subject,
        nextReviewAt: m.next_review_at, stability: m.stability,
      })),
    });
  }

  if (url === '/api/tutor/activity-beacon' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const subject = String(body.subject || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'general';
      const minutes = Math.max(0, Math.min(10, Number(body.minutes) || 0));
      if (!minutes) return json(res, 200, { ok: true, recorded: 0 });
      await recordSessionActivity(userId, subject, { minutes });
      return json(res, 200, { ok: true, recorded: minutes });
    } catch (e) {
      return json(res, 400, { error: 'Invalid body', detail: e.message });
    }
  }

  if (url === '/api/tutor/tz' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const tz = String(body.tz || '').trim();
      if (!tz || !/^[A-Za-z_]+\/[A-Za-z_+-]+/.test(tz)) return json(res, 400, { error: 'Invalid tz' });
      await setUserTz(userId, tz);
      return json(res, 200, { ok: true, tz });
    } catch (e) {
      return json(res, 400, { error: 'Invalid body', detail: e.message });
    }
  }

  if (url === '/api/tutor/goal' && req.method === 'PUT') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const minutesPerWeek = Number.isFinite(+body.minutesPerWeek) ? +body.minutesPerWeek : undefined;
      const daysPerWeek = Number.isFinite(+body.daysPerWeek) ? +body.daysPerWeek : undefined;
      if (minutesPerWeek === undefined && daysPerWeek === undefined) return json(res, 400, { error: 'Provide minutesPerWeek or daysPerWeek' });
      const goal = await setWeeklyGoal(userId, { minutesPerWeek, daysPerWeek });
      return json(res, 200, { ok: true, goal });
    } catch (e) {
      return json(res, 400, { error: 'Invalid body', detail: e.message });
    }
  }

  return false;
}
