import { pin, recall, remember, forgetByText, getDueReviews, updateReviewSchedule } from '../../memory.mjs';
import {
  recordSessionActivity, recordMilestone, claimDaily, getAdaptation,
  loadTutorStats, setUserTz, setWeeklyGoal, masteryBand, xpForLevel, levelProgress,
  ACHIEVEMENTS,
} from '../../lib/tutor-stats.mjs';
import { getUser, saveUser } from '../../routes/_helpers.mjs';

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

const TUTOR_PREFIX = '[TUTOR';

function normalizeSubject(s) {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function tag(subject, category) {
  return `[TUTOR:${subject}:${category}]`;
}

function labelFor(achievementId) {
  const a = ACHIEVEMENTS.find(x => x.id === achievementId);
  return a ? `${a.icon} ${a.label}` : achievementId;
}

function formatAchievements(list) {
  if (!list?.length) return '';
  const labels = list.map(a => labelFor(a.id));
  return ` 🎖 Unlocked: ${labels.join(', ')}.`;
}

// Parse milestone headings from roadmap text. Accepts lines starting with "## ",
// numbered "1. ", or "- [ ] "/"- [x] " checkboxes. Returns array of { id, label }.
function extractMilestones(text) {
  const out = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let label = null;
    if (line.startsWith('## ')) label = line.slice(3).trim();
    else if (/^\d+\.\s+/.test(line)) label = line.replace(/^\d+\.\s+/, '').trim();
    else if (/^- \[[ x]\]\s+/.test(line)) label = line.replace(/^- \[[ x]\]\s+/, '').trim();
    if (!label) continue;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (id && !out.find(m => m.id === id)) out.push({ id, label });
  }
  return out;
}

export default async function execute(name, args, userId, agentId) {
  const aid = agentId || 'main';

  if (name === 'tutor_pronounce') {
    const text = args.text?.trim();
    const lang = args.lang?.trim().toLowerCase();
    if (!text) return 'Error: text is required.';
    if (!lang) return 'Error: lang is required (e.g. "fr", "es", "de").';
    // Return special marker that the frontend converts into a playable audio button
    return `⟨pronounce:${lang}:${text}⟩`;
  }

  if (name === 'tutor_save_note') {
    const subject = normalizeSubject(args.subject);
    const category = args.category || 'study_note';
    if (!subject) return 'Error: subject is required.';
    if (!args.text?.trim()) return 'Error: text is required.';

    const text = `${tag(subject, category)} ${args.text.trim()}`;
    // Schedule first review in 24 hours for quiz results and study notes
    const needsReview = category === 'quiz_result' || category === 'study_note';
    const nextReview = needsReview ? new Date(Date.now() + 24 * 3_600_000).toISOString() : '';
    await remember({
      agentId: aid, type: 'params', text,
      immortal: true, source: 'user_stated', confidence: 1.0,
      metadata: { category: `tutor_${category}`, next_review_at: nextReview },
      userId,
    });

    // ── Stats hook ──
    let achievementNotice = '';
    try {
      if (category === 'quiz_result') {
        // Extract correctness from text: tutor prompt instructs "[Quiz answer: X — correct]" context
        // or we look for "correct"/"incorrect" keywords in the saved note.
        const lower = args.text.toLowerCase();
        const isCorrect = /\bcorrect\b/.test(lower) && !/\bincorrect\b/.test(lower);
        const xp = isCorrect ? 10 : 3;
        const res = await recordSessionActivity(userId, subject, {
          minutes: 1, answered: 1, correct: isCorrect ? 1 : 0, xp, isCorrectQuiz: isCorrect,
        });
        achievementNotice = formatAchievements(res.newAchievements);
        if (res.masteryBandChanged) {
          achievementNotice += ` 📈 Mastery advanced: ${res.prevBand} → ${res.newBand}.`;
        }
      } else if (category === 'study_note') {
        const res = await recordSessionActivity(userId, subject, { minutes: 1, xp: 2 });
        achievementNotice = formatAchievements(res.newAchievements);
      } else if (category === 'progress') {
        const res = await recordSessionActivity(userId, subject, { minutes: 2, xp: 5 });
        achievementNotice = formatAchievements(res.newAchievements);
        // Detect milestone reference in the progress text
        const milestoneMatch = args.text.match(/(?:milestone|completed|finished|mastered)[: ]*"?([^"\n.]+)/i);
        if (milestoneMatch) {
          const label = milestoneMatch[1].trim();
          const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
          if (id) {
            const m = await recordMilestone(userId, subject, id);
            if (m?.newAchievements?.length) achievementNotice += formatAchievements(m.newAchievements);
          }
        }
      }
    } catch (e) { console.warn('[tutor] stats hook failed:', e.message); }

    return `Saved ${category.replace('_', ' ')} for "${subject}".${achievementNotice}`;
  }

  if (name === 'tutor_recall_notes') {
    const subject = normalizeSubject(args.subject);
    if (!subject) return 'Error: subject is required.';
    if (!args.query?.trim()) return 'Error: query is required.';

    const query = `${tag(subject, args.category || '')} ${args.query.trim()}`;
    const results = await recall({
      agentId: aid, type: 'params', query, topK: 20,
      includeShared: false, userId,
    });

    // Filter to this subject
    const subjectTag = `[TUTOR:${subject}:`;
    const filtered = results.filter(r => r.text?.includes(subjectTag));

    // Further filter by category if specified
    const categoryFiltered = args.category
      ? filtered.filter(r => r.text?.includes(tag(subject, args.category)))
      : filtered;

    if (!categoryFiltered.length) return `No notes found for "${subject}"${args.category ? ` (${args.category})` : ''}.`;

    return categoryFiltered.map(r => {
      const clean = r.text.replace(/^\[TUTOR:[^\]]*\]\s*/, '');
      const cat = r.text.match(/\[TUTOR:[^:]+:([^\]]+)\]/)?.[1] || 'note';
      const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `[${cat} — ${date}] ${clean}`;
    }).join('\n');
  }

  if (name === 'tutor_get_progress') {
    const subject = normalizeSubject(args.subject);
    if (!subject) return 'Error: subject is required.';

    // Recall roadmap and progress entries for this subject
    const results = await recall({
      agentId: aid, type: 'params',
      query: `${tag(subject, 'roadmap')} ${tag(subject, 'progress')} learning milestones`,
      topK: 30, includeShared: false, userId,
    });

    const subjectTag = `[TUTOR:${subject}:`;
    const all = results.filter(r => r.text?.includes(subjectTag));

    const roadmaps = all.filter(r => r.text?.includes(tag(subject, 'roadmap')));
    const progress = all.filter(r => r.text?.includes(tag(subject, 'progress')));

    const parts = [];
    if (roadmaps.length) {
      // Most recent roadmap (highest created_at)
      const latest = roadmaps.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      parts.push('## Roadmap\n' + latest.text.replace(/^\[TUTOR:[^\]]*\]\s*/, ''));
    } else {
      parts.push('No roadmap found for this subject.');
    }

    if (progress.length) {
      const sorted = progress.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const entries = sorted.slice(0, 10).map(r => {
        const clean = r.text.replace(/^\[TUTOR:[^\]]*\]\s*/, '');
        const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `- [${date}] ${clean}`;
      });
      parts.push('\n## Recent Progress\n' + entries.join('\n'));
    } else {
      parts.push('\nNo progress recorded yet.');
    }

    // Append stats summary for this subject
    try {
      const stats = loadTutorStats(userId);
      const subj = stats.subjects[subject];
      if (subj) {
        const band = masteryBand(subj.mastery);
        parts.push(`\n## Stats\n- Mastery: **${band}** (${Math.round(subj.mastery * 100)}%)\n- Total time: ${subj.totalMinutes} min\n- Milestones reached: ${subj.milestonesReached?.length || 0}\n- Current streak: ${stats.streak.current} day(s)`);
      }
    } catch {}

    return parts.join('\n');
  }

  if (name === 'tutor_list_subjects') {
    // Broad search for all tutor entries
    const results = await recall({
      agentId: aid, type: 'params',
      query: `${TUTOR_PREFIX} subject roadmap progress study`,
      topK: 50, includeShared: false, userId,
    });

    const subjects = new Map();
    for (const r of results) {
      const m = r.text?.match(/\[TUTOR:([^:]+):/);
      if (!m) continue;
      const subj = m[1];
      if (!subjects.has(subj)) {
        subjects.set(subj, { noteCount: 0, lastActivity: r.created_at, hasRoadmap: false });
      }
      const info = subjects.get(subj);
      info.noteCount++;
      if (r.text.includes(':roadmap]')) info.hasRoadmap = true;
      if (new Date(r.created_at) > new Date(info.lastActivity)) info.lastActivity = r.created_at;
    }

    if (!subjects.size) return 'No active subjects found. The user has not started any tutoring sessions yet.';

    let stats = null;
    try { stats = loadTutorStats(userId); } catch {}

    const lines = [...subjects.entries()]
      .sort((a, b) => new Date(b[1].lastActivity) - new Date(a[1].lastActivity))
      .map(([subj, info]) => {
        const date = new Date(info.lastActivity).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const roadmap = info.hasRoadmap ? '✓ roadmap' : '✗ no roadmap';
        const masteryStr = stats?.subjects?.[subj]
          ? `, mastery: ${masteryBand(stats.subjects[subj].mastery)}`
          : '';
        return `- **${subj}** — ${info.noteCount} notes, ${roadmap}${masteryStr}, last active ${date}`;
      });

    return '## Active Subjects\n' + lines.join('\n');
  }

  if (name === 'tutor_update_roadmap') {
    const subject = normalizeSubject(args.subject);
    if (!subject) return 'Error: subject is required.';
    if (!args.roadmap_text?.trim()) return 'Error: roadmap_text is required.';

    // Archive old roadmaps by forgetting them (uses non-immortal remember for roadmaps)
    await forgetByText({ agentId: aid, text: `${tag(subject, 'roadmap')}`, userId });

    // Save new roadmap — use remember (non-immortal, high stability) so it can be replaced later
    const text = `${tag(subject, 'roadmap')} ${args.roadmap_text.trim()}`;
    await remember({
      agentId: aid, type: 'params', text,
      immortal: false, source: 'tutor', confidence: 1.0,
      metadata: { category: 'tutor_roadmap', title: subject },
      userId,
    });

    // Extract milestones into stats for progress tracking
    try {
      const milestones = extractMilestones(args.roadmap_text);
      // Seed the subject so it shows up on the dashboard even before any notes are saved
      await recordSessionActivity(userId, subject, { minutes: 0, xp: 0 });
      const mcount = milestones.length;
      return `Roadmap for "${subject}" has been saved. Detected ${mcount} milestone${mcount === 1 ? '' : 's'}.`;
    } catch {
      return `Roadmap for "${subject}" has been saved.`;
    }
  }

  if (name === 'tutor_get_due_reviews') {
    const due = await getDueReviews({ agentId: aid, type: 'params', userId, limit: 10 });
    if (!due.length) return 'No items due for review right now.';

    return '## Due for Review\n' + due.map(m => {
      const clean = m.text.replace(/^\[TUTOR:[^\]]*\]\s*/, '');
      const subj = m.text.match(/\[TUTOR:([^:]+):/)?.[1] || 'unknown';
      const cat = m.text.match(/\[TUTOR:[^:]+:([^\]]+)\]/)?.[1] || 'note';
      const lastReviewed = m.last_recalled_at
        ? new Date(m.last_recalled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : 'never';
      return `- **${subj}** (${cat}) — reviewed ${lastReviewed}, ${m.recall_count || 0} times | ID: ${m.id}\n  ${clean}`;
    }).join('\n');
  }

  if (name === 'tutor_record_review') {
    const memoryId = args.memory_id;
    const correct = args.correct;
    const rating = args.rating; // optional: 'again'|'hard'|'good'|'easy' from flashcard
    if (!memoryId) return 'Error: memory_id is required.';

    const result = await updateReviewSchedule({ agentId: aid, type: 'params', memoryId, userId, rating, correct });
    if (!result) return 'Error: memory not found.';

    // Extract subject from memory text tag so stats can track per-subject perf
    let subject = null;
    try {
      const lookup = await recall({ agentId: aid, type: 'params', query: memoryId, topK: 1, userId });
      const match = lookup.find(r => r.id === memoryId);
      subject = match?.text?.match(/\[TUTOR:([^:]+):/)?.[1] || null;
    } catch {}

    let achievementNotice = '';
    try {
      const isCorrect = rating ? (rating === 'good' || rating === 'easy') : correct;
      if (subject) {
        const res = await recordSessionActivity(userId, subject, {
          answered: 1, correct: isCorrect ? 1 : 0, xp: isCorrect ? 10 : 3, isCorrectQuiz: isCorrect,
        });
        achievementNotice = formatAchievements(res.newAchievements);
        if (res.masteryBandChanged) achievementNotice += ` 📈 Mastery: ${res.prevBand} → ${res.newBand}.`;
      }
    } catch {}

    const nextDate = new Date(result.nextReview).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
    const ratingNote = rating ? ` [${rating}]` : '';
    return `Review recorded (${correct ? 'correct' : 'incorrect'}${ratingNote}). Next review: ${nextDate}. Stability: ${Math.round(result.newStability)}h. Total reviews: ${result.recallCount}.${achievementNotice}`;
  }

  if (name === 'tutor_claim_daily') {
    const result = await claimDaily(userId);
    if (!result.dayChanged) {
      return `Already claimed today. Current streak: ${result.newStreak} day(s). XP: ${result.totalXp}, Level: ${result.level}.`;
    }
    const shieldNote = result.shieldConsumed ? ' 🛡 Shield used to save the streak!' : '';
    const resetNote = result.streakReset ? ' (Streak restarted after a gap.)' : '';
    const levelUpNote = result.leveledUp ? ` 🎉 LEVEL UP → Level ${result.level}!` : '';
    const achievementNote = formatAchievements(result.achievements);
    return `Streak: **${result.newStreak} day${result.newStreak === 1 ? '' : 's'}** (+${result.xpGained} XP).${shieldNote}${resetNote}${levelUpNote}${achievementNote}`;
  }

  if (name === 'tutor_get_adaptation') {
    const subject = normalizeSubject(args.subject);
    if (!subject) return 'Error: subject is required.';
    const a = getAdaptation(userId, subject);
    const mixTop = Object.entries(a.suggestedMix).sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([k, v]) => `${k}: ${Math.round(v * 100)}%`).join(', ');
    return `## Adaptation for ${subject}\n- Difficulty: **${a.difficulty}**\n- Recent perf: ${Math.round(a.recentPerfScore * 100)}% (from ${a.recentSampleSize} answers)\n- Mastery: ${a.masteryBand} (${Math.round(a.mastery * 100)}%)\n- Current correct-streak: ${a.streakCorrect}\n- Suggested widget mix: ${mixTop}`;
  }

  if (name === 'tutor_get_stats') {
    const stats = loadTutorStats(userId);
    const { level, intoLevel, nextLevelAt } = levelProgress(stats.xp);
    const subjectsLine = Object.entries(stats.subjects).slice(0, 10).map(([s, v]) =>
      `  - ${s}: ${masteryBand(v.mastery)} (${Math.round(v.mastery * 100)}%) • ${v.totalMinutes}min`
    ).join('\n');
    const recentAch = stats.achievements.slice(-3).map(a => labelFor(a.id)).join(', ') || 'none yet';
    return `## Your Tutor Stats
- **Streak**: ${stats.streak.current} day${stats.streak.current === 1 ? '' : 's'} (longest: ${stats.streak.longest})
- **XP**: ${stats.xp} (Level ${level}, ${intoLevel}/${nextLevelAt} to next)
- **Shields available**: ${stats.streak.shieldsAvailable}
- **Weekly goal**: ${stats.weeklyGoal.minutesPerWeek} min, ${stats.weeklyGoal.daysPerWeek} days
- **Recent achievements**: ${recentAch}
${subjectsLine ? '- **Subjects**:\n' + subjectsLine : ''}`;
  }

  if (name === 'tutor_set_tz') {
    const tz = args.tz?.trim();
    if (!tz) return 'Error: tz is required (e.g. "America/New_York").';
    await setUserTz(userId, tz);
    return `Timezone set to ${tz}.`;
  }

  if (name === 'tutor_set_reminder_prefs') {
    const user = getUser(userId);
    if (!user) return 'Error: user not found.';
    const current = { ...DEFAULT_REMINDER_PREFS, ...(user.tutorReminders || {}) };
    if (args.channel !== undefined) current.channel = args.channel;
    if (args.dailyTime !== undefined) current.dailyTime = args.dailyTime;
    if (args.streakAtRiskNudge !== undefined) current.streakAtRiskNudge = !!args.streakAtRiskNudge;
    if (args.enabled !== undefined) current.enabled = !!args.enabled;
    if (current.enabled === false && args.channel === 'off') current.channel = 'off';
    if (args.channel === 'off') current.enabled = false;
    if (args.channel && args.channel !== 'off' && args.enabled === undefined) current.enabled = true;
    user.tutorReminders = current;
    saveUser(user);
    return `Reminders: ${current.enabled ? `ON (${current.channel}) at ${current.dailyTime} daily${current.streakAtRiskNudge ? ' + streak-at-risk nudge' : ''}` : 'OFF'}. Takes effect on next scheduler reload.`;
  }

  if (name === 'tutor_get_reminder_prefs') {
    const user = getUser(userId);
    const prefs = { ...DEFAULT_REMINDER_PREFS, ...(user?.tutorReminders || {}) };
    return `## Reminder preferences\n- Enabled: ${prefs.enabled}\n- Channel: ${prefs.channel}\n- Daily time: ${prefs.dailyTime}\n- Streak-at-risk nudge: ${prefs.streakAtRiskNudge}\n- Quiet hours: ${prefs.quietHours.start}–${prefs.quietHours.end}`;
  }

  if (name === 'tutor_set_goal') {
    const minutesPerWeek = Number.isFinite(args.minutesPerWeek) ? Math.max(0, Math.round(args.minutesPerWeek)) : undefined;
    const daysPerWeek = Number.isFinite(args.daysPerWeek) ? Math.max(1, Math.min(7, Math.round(args.daysPerWeek))) : undefined;
    if (minutesPerWeek === undefined && daysPerWeek === undefined) return 'Error: pass minutesPerWeek and/or daysPerWeek.';
    const goal = await setWeeklyGoal(userId, { minutesPerWeek, daysPerWeek });
    return `Weekly goal set: **${goal.minutesPerWeek} min/week**, **${goal.daysPerWeek} days/week**.`;
  }

  return `Unknown tutor tool: ${name}`;
}
