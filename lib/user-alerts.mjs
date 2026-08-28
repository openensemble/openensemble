// @ts-check
/**
 * User-visible failure alerts.
 *
 * A fault that quietly removes something the user set up (a monitor stops, a
 * scheduled task gives up, a delivery is refused by a crash) used to exist only
 * in the logs. `sendToUser` is a websocket push and is simply LOST when nothing
 * is connected, so "we notified them" was not true for anyone who wasn't
 * looking at the UI at that moment.
 *
 * This routes those events to:
 *   1. the coordinator's chat session — the durable record, always written, so
 *      the user finds it whenever they next open the conversation;
 *   2. a live websocket push — always attempted for immediate in-app notice;
 *      and
 *   3. Telegram and/or email when `profile.reminderChannel` selects that
 *      channel (or `all`).
 *
 * Deliberately NOT voice: an alert is reviewable, not time-critical, and
 * speaking a fault aloud in the house — potentially at 3am — is the wrong
 * trade. Reminders keep voice; failures do not.
 *
 * Every send is best-effort and independently guarded: alerting must never be
 * able to throw back into the path that was already failing.
 */
import { log } from '../logger.mjs';

// A fault usually repeats — a watcher re-ticks, a schedule retries hourly.
// Alert once per cause per window rather than on every occurrence, so a
// persistent problem is one message instead of a phone full of them.
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 500;
const _lastAlertAt = new Map(); // `${userId}:${dedupKey}` -> ms

/** Exposed for tests; also lets a caller force-resend after a fix. */
export function _resetAlertDedupe() { _lastAlertAt.clear(); }

function shouldSuppress(userId, dedupKey, now) {
  if (!dedupKey) return false;
  const key = `${userId}:${dedupKey}`;
  const prev = _lastAlertAt.get(key);
  if (prev != null && now - prev < DEDUP_WINDOW_MS) return true;
  // Cheap unbounded-growth guard: drop the oldest half once we exceed the cap.
  if (_lastAlertAt.size >= MAX_DEDUP_ENTRIES) {
    const sorted = [..._lastAlertAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, Math.floor(sorted.length / 2))) _lastAlertAt.delete(k);
  }
  _lastAlertAt.set(key, now);
  return false;
}

/** Plain-language line shown in chat and sent to every channel. */
function composeText({ title, detail, remedy }) {
  const parts = [`⚠️ ${title}`];
  if (detail) parts.push(detail);
  if (remedy) parts.push(remedy);
  return parts.join('\n\n');
}

async function appendToCoordinatorChat(userId, text) {
  const [{ appendToSession }, helpers] = await Promise.all([
    import('../sessions.mjs'),
    import('../routes/_helpers.mjs'),
  ]);
  const coordId = helpers.getUserCoordinatorAgentId(userId);
  if (!coordId) return false;
  // Assignments store the BARE agent id; sessions.mjs only resolves a per-user
  // path for a scoped "<userId>_<agentId>" key (see skills/nodes/node-registry
  // notifyCoordinator for the same rule and the orphan-file bug it caused).
  const sessionKey = String(coordId).startsWith(`${userId}_`)
    ? String(coordId)
    : `${userId}_${coordId}`;
  await appendToSession(sessionKey, { role: 'system', content: text, ts: Date.now() });
  return true;
}

/**
 * Tell `userId` that something they rely on stopped working.
 *
 * @param {string} userId
 * @param {object} alert
 * @param {string} alert.title    One line, plain language, no stack traces.
 * @param {string} [alert.detail] What specifically failed.
 * @param {string} [alert.remedy] What they can do about it, if anything.
 * @param {string} [alert.dedupKey] Cause identity; repeats inside the window
 *                                  are suppressed. Omit to always send.
 * @param {object} [alert.meta]   Structured context for the log line only.
 * @returns {Promise<{sent: boolean, channels: string[], suppressed?: boolean}>}
 */
export async function alertUserOfFailure(userId, { title, detail, remedy, dedupKey, meta } = { title: '' }) {
  if (!userId || !title) return { sent: false, channels: [] };
  const now = Date.now();
  if (shouldSuppress(userId, dedupKey, now)) {
    return { sent: false, channels: [], suppressed: true };
  }

  const text = composeText({ title, detail, remedy });
  const channels = [];

  // 1. Durable chat record — always, regardless of channel preference. This is
  //    the surface the user can come back to.
  try {
    if (await appendToCoordinatorChat(userId, text)) channels.push('chat');
  } catch (e) {
    log.warn('alerts', 'chat record failed', { userId, err: e?.message || String(e) });
  }

  let user = null;
  try {
    const { getUser } = await import('../routes/_helpers.mjs');
    user = getUser(userId);
  } catch { /* fall through to websocket-only below */ }
  const channel = user?.reminderChannel || 'websocket';
  const wantTelegram = channel === 'telegram' || channel === 'all';
  const wantEmail = channel === 'email' || channel === 'all';

  // 2. Live websocket push — instant when a client is open, harmless when not.
  try {
    const { sendToUser } = await import('../ws-handler.mjs');
    const n = sendToUser(userId, {
      type: 'status', kind: 'system_alert', label: 'OpenEnsemble',
      text, final: true, finalStatus: 'error',
    });
    if (n > 0) channels.push(`ws(${n})`);
  } catch (e) {
    log.warn('alerts', 'websocket push failed', { userId, err: e?.message || String(e) });
  }

  if (wantTelegram) {
    try {
      const { sendTelegramToUser } = await import('../routes/telegram.mjs');
      if (await sendTelegramToUser(userId, text)) channels.push('telegram');
    } catch (e) {
      log.warn('alerts', 'telegram delivery failed', { userId, err: e?.message || String(e) });
    }
  }

  if (wantEmail) {
    try {
      const { sendEmailToUser } = await import('./email-delivery.mjs');
      const result = await sendEmailToUser(userId, { subject: `OpenEnsemble: ${title}`, body: text });
      if (result?.ok) channels.push('email');
      else log.warn('alerts', 'email delivery skipped', { userId, reason: result?.message || 'unknown' });
    } catch (e) {
      log.warn('alerts', 'email delivery failed', { userId, err: e?.message || String(e) });
    }
  }

  log.info('alerts', 'user alerted to failure', { userId, title, channels, ...(meta || {}) });
  return { sent: channels.length > 0, channels };
}
