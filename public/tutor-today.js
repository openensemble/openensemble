// ── Today drawer (Tutor) ─────────────────────────────────────────────────────

async function loadTutorToday() {
  const body = $('tutorTodayBody');
  if (!body) return;
  body.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Loading…</div>`;
  const token = localStorage.getItem('oe_token');
  try {
    const r = await fetch('/api/tutor/today', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) { body.innerHTML = renderTutorEmpty('Could not load tutor data.'); return; }
    const data = await r.json();
    body.innerHTML = renderTutorToday(data);
  } catch (e) {
    body.innerHTML = renderTutorEmpty(`Error: ${escHtml(e.message)}`);
  }
}

function renderTutorEmpty(msg) {
  return `<div class="tutor-today-empty">
    <div style="font-size:48px;margin-bottom:8px">🎓</div>
    <div style="color:var(--muted);font-size:13px">${escHtml(msg || 'Start a tutor session to build your streak.')}</div>
    <button class="tutor-today-cta" onclick="startTutorSession()">Start a session</button>
  </div>`;
}

function startTutorSession() {
  closeAllDrawers();
  try {
    if (typeof ws !== 'undefined' && ws?.readyState === 1 && typeof activeAgent !== 'undefined') {
      ws.send(JSON.stringify({ type: 'chat', agent: activeAgent, text: "Let's have a tutor session." }));
      if (typeof setStreaming === 'function') setStreaming(true);
      if (typeof setTyping === 'function') setTyping(true);
    }
  } catch {}
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTutorToday({ stats, level, intoLevel, nextLevelAt, recap, subjects, dueReviews }) {
  if (!stats || (stats.xp === 0 && !Object.keys(stats.subjects || {}).length)) {
    return renderTutorEmpty('No tutor activity yet — start your first session to begin a streak.');
  }

  const streak = stats.streak || {};
  const xpPct = Math.max(0, Math.min(100, Math.round((intoLevel / Math.max(1, nextLevelAt)) * 100)));
  const todayMin = (stats.dayLog?.[todayYmdLocal()]?.minutes) || 0;
  const weekMin = recap?.totalMinutes || 0;
  const weekDays = recap?.daysMetGoal || 0;
  const weekGoalMin = stats.weeklyGoal?.minutesPerWeek || 150;
  const weekPct = Math.max(0, Math.min(100, Math.round((weekMin / Math.max(1, weekGoalMin)) * 100)));

  const heatStrip = (recap?.heatStrip || []).map((cell) => {
    const cls = cell.goalMet ? 'hot' : cell.minutes > 0 ? 'warm' : 'cold';
    return `<div class="tutor-heat-cell ${cls}" title="${cell.date}: ${cell.minutes} min">${cell.label}</div>`;
  }).join('');

  const dueBlock = (dueReviews || []).length
    ? `<ul class="tutor-due-list">${dueReviews.map(r => `
        <li>
          <div class="tutor-due-text">${escHtml(r.subject || 'Review')} · ${escHtml((r.text || '').slice(0, 80))}</div>
          <button class="tutor-due-start" onclick="startReview('${escHtml(r.subject || '')}')">Start</button>
        </li>`).join('')}</ul>`
    : `<div style="color:var(--muted);font-size:12px;padding:8px 0">Nothing due right now.</div>`;

  const subjGrid = (subjects || []).length
    ? `<div class="tutor-subject-grid">${subjects.map(s => `
        <div class="tutor-subject-card">
          <div class="tutor-subject-name">${escHtml(s.id)}</div>
          <div class="tutor-subject-band">${s.band}</div>
          <div class="tutor-mastery-bar"><div class="tutor-mastery-fill" style="width:${Math.round(s.mastery * 100)}%"></div></div>
          <div class="tutor-subject-meta">${s.totalMinutes} min · ${s.lastStudied ? timeAgoShort(s.lastStudied) : 'never'}</div>
        </div>`).join('')}</div>`
    : `<div style="color:var(--muted);font-size:12px;padding:8px 0">No subjects yet.</div>`;

  const recentAch = (stats.achievements || []).slice(-3);
  const achBlock = recentAch.length
    ? `<div class="tutor-ach-shelf">${recentAch.map(a => `<div class="tutor-ach-chip" title="${escHtml(a.id)}">${achievementIcon(a.id)} ${escHtml(achievementLabel(a.id))}</div>`).join('')}</div>`
    : `<div style="color:var(--muted);font-size:12px">No achievements yet — your next lesson will unlock them.</div>`;

  return `
    <div class="tutor-today">
      <div class="tutor-today-hero">
        <div class="tutor-hero-streak">
          <div class="tutor-flame ${streak.current > 0 ? 'on' : ''}">🔥</div>
          <div class="tutor-streak-num">${streak.current || 0}</div>
          <div class="tutor-streak-sub">day${streak.current === 1 ? '' : 's'}</div>
          <div class="tutor-streak-longest">best: ${streak.longest || 0}</div>
        </div>
        <div class="tutor-hero-xp">
          <div class="tutor-level">Level ${level ?? 0}</div>
          <div class="tutor-xp-bar"><div class="tutor-xp-fill" style="width:${xpPct}%"></div></div>
          <div class="tutor-xp-label">${intoLevel}/${nextLevelAt} XP · ${stats.xp} total</div>
        </div>
      </div>

      <div class="tutor-today-section">
        <div class="tutor-section-hdr">This week</div>
        <div class="tutor-week-row">
          <div class="tutor-week-progress">
            <div class="tutor-mastery-bar"><div class="tutor-mastery-fill" style="width:${weekPct}%"></div></div>
            <div class="tutor-week-label">${weekMin} / ${weekGoalMin} min · ${weekDays} / ${stats.weeklyGoal?.daysPerWeek || 5} days</div>
          </div>
          <div class="tutor-today-min">Today: <strong>${todayMin}</strong> min</div>
        </div>
        <div class="tutor-heat-strip">${heatStrip}</div>
      </div>

      <div class="tutor-today-section">
        <div class="tutor-section-hdr">Due reviews</div>
        ${dueBlock}
      </div>

      <div class="tutor-today-section">
        <div class="tutor-section-hdr">Subjects</div>
        ${subjGrid}
      </div>

      <div class="tutor-today-section">
        <div class="tutor-section-hdr">Recent achievements</div>
        ${achBlock}
      </div>

      <div class="tutor-today-actions">
        <button class="tutor-today-cta" onclick="startTutorSession()">Start session</button>
        <button class="tutor-today-link" onclick="openTutorPrefsPanel()">⚙ Reminders</button>
      </div>
    </div>
  `;
}

function startReview(subject) {
  closeAllDrawers();
  const text = subject ? `Let's review my ${subject}` : "Let's review today's due items";
  try {
    if (typeof ws !== 'undefined' && ws?.readyState === 1 && typeof activeAgent !== 'undefined') {
      ws.send(JSON.stringify({ type: 'chat', agent: activeAgent, text }));
      if (typeof setStreaming === 'function') setStreaming(true);
      if (typeof setTyping === 'function') setTyping(true);
    }
  } catch {}
}

// Minimal reminder-prefs panel — opens inside the Today drawer.
async function openTutorPrefsPanel() {
  const body = $('tutorTodayBody');
  if (!body) return;
  const token = localStorage.getItem('oe_token');
  let prefs = { enabled: false, channel: 'websocket', dailyTime: '19:30', streakAtRiskNudge: true };
  try {
    const r = await fetch('/api/tutor/reminders', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (r.ok) prefs = await r.json();
  } catch {}
  body.innerHTML = `
    <div class="tutor-today">
      <button class="tutor-today-link" onclick="loadTutorToday()">← Back</button>
      <h3>Reminders</h3>
      <label class="tutor-prefs-row">
        <span>Enabled</span>
        <input type="checkbox" id="tutor-pref-enabled" ${prefs.enabled ? 'checked' : ''} />
      </label>
      <label class="tutor-prefs-row">
        <span>Channel</span>
        <select id="tutor-pref-channel">
          <option value="websocket" ${prefs.channel === 'websocket' ? 'selected' : ''}>In-app toast</option>
          <option value="telegram"  ${prefs.channel === 'telegram'  ? 'selected' : ''}>Telegram</option>
          <option value="email"     ${prefs.channel === 'email'     ? 'selected' : ''}>Email</option>
          <option value="off"       ${prefs.channel === 'off'       ? 'selected' : ''}>Off</option>
        </select>
      </label>
      <label class="tutor-prefs-row">
        <span>Daily time (HH:MM)</span>
        <input type="time" id="tutor-pref-time" value="${escHtml(prefs.dailyTime)}" />
      </label>
      <label class="tutor-prefs-row">
        <span>Streak-at-risk nudge</span>
        <input type="checkbox" id="tutor-pref-atrisk" ${prefs.streakAtRiskNudge ? 'checked' : ''} />
      </label>
      <div class="tutor-today-actions">
        <button class="tutor-today-cta" onclick="saveTutorPrefs()">Save</button>
      </div>
    </div>`;
}

async function saveTutorPrefs() {
  const token = localStorage.getItem('oe_token');
  const payload = {
    enabled: $('tutor-pref-enabled').checked,
    channel: $('tutor-pref-channel').value,
    dailyTime: $('tutor-pref-time').value || '19:30',
    streakAtRiskNudge: $('tutor-pref-atrisk').checked,
  };
  const r = await fetch('/api/tutor/reminders', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (r.ok) { if (typeof showToast === 'function') showToast('Reminder preferences saved'); loadTutorToday(); }
  else if (typeof showToast === 'function') showToast('Failed to save preferences');
}

function todayYmdLocal() {
  try { return new Date().toLocaleDateString('en-CA'); }
  catch { return new Date().toISOString().slice(0, 10); }
}

function timeAgoShort(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const h = Math.floor((Date.now() - t) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

const TUTOR_ACHIEVEMENTS = {
  first_quiz:       { label: 'First quiz',       icon: '✍️' },
  first_note:       { label: 'First note',       icon: '📝' },
  first_roadmap:    { label: 'First roadmap',    icon: '🗺️' },
  streak_7:         { label: '7-day streak',     icon: '🔥' },
  streak_30:        { label: '30-day streak',    icon: '🔥🔥' },
  streak_100:       { label: '100-day streak',   icon: '🔥🔥🔥' },
  level_5:          { label: 'Level 5',          icon: '⭐' },
  level_10:         { label: 'Level 10',         icon: '🌟' },
  level_25:         { label: 'Level 25',         icon: '🏆' },
  mastered_subject: { label: 'Mastered subject', icon: '🎓' },
  perfect_week:     { label: 'Weekly goal hit',  icon: '🎯' },
  polyglot_3:       { label: 'Polyglot (3+)',    icon: '🌍' },
  night_owl:        { label: 'Night owl',        icon: '🦉' },
  early_bird:       { label: 'Early bird',       icon: '🐦' },
  perfect_10:       { label: '10 in a row',      icon: '💯' },
};
function achievementIcon(id) { return TUTOR_ACHIEVEMENTS[id]?.icon ?? '🏅'; }
function achievementLabel(id) { return TUTOR_ACHIEVEMENTS[id]?.label ?? id; }
