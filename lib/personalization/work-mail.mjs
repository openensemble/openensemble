import { getConfig } from './config.mjs';
import { readWorkState, mutateWorkState, workFingerprint } from './work-store.mjs';
import { queueWorkEvent } from './work-events.mjs';
import { getUser, isUserTimeBlocked } from '../../routes/_helpers.mjs';
import { getProjectSpace } from '../project-spaces.mjs';

export function incomingGoalReply(messages, since) {
  return (Array.isArray(messages) ? messages : []).filter(message =>
    Number(message.internalDate) > since && message.id && message.threadId
    && !message.labelIds?.some(label => ['SENT', 'DRAFT'].includes(label)))
    .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))[0] || null;
}

/** Read only explicitly linked Gmail threads, independently of auto-labeling. */
export async function pollWorkReplies(userId, { now = Date.now(), fetchFn = fetch } = {}) {
  const config = await getConfig(userId);
  const user = getUser(userId);
  if (!user || isUserTimeBlocked(userId) || (Array.isArray(user.allowedSkills) && !['tasks', 'email'].every(skill => user.allowedSkills.includes(skill)))) return;
  if (!config.enabled || !config.setupComplete || config.model === 'off' || config.workMode === 'off' || !config.sources.tools || !config.sources.sessions) return;
  const { listDashboardEmailAccounts } = await import('../../routes/email-accounts.mjs');
  const { getAccessToken } = await import('../google-auth.mjs');
  const accounts = listDashboardEmailAccounts(userId);
  const state = readWorkState(userId);
  const goals = state.goals.filter(goal => goal.status === 'active' && goal.emailRef).slice(0, 8);
  for (const goal of goals) {
    if (goal.projectId) {
      try { if (getProjectSpace(userId, goal.projectId).archived) continue; } catch { continue; }
    }
    const account = accounts.find(row => row.id === goal.emailRef.accountId && row.provider === 'gmail');
    if (!account) continue;
    const key = workFingerprint([goal.id, goal.emailRef]);
    const last = state.mailChecks?.[key];
    if (last && now - last.checkedAt < 5 * 60_000) continue;
    // Reserve the poll timestamp so API errors back off too.
    await mutateWorkState(userId, file => {
      file.mailChecks ||= {};
      file.mailChecks[key] = { ...last, checkedAt: now };
      const active = new Set(file.goals.filter(row => row.status === 'active' && row.emailRef).map(row => workFingerprint([row.id, row.emailRef])));
      for (const old of Object.keys(file.mailChecks)) if (!active.has(old)) delete file.mailChecks[old];
    });
    try {
      const token = await getAccessToken('gmail', userId, account.id === 'acct_gmail_legacy' ? null : account.id);
      const response = await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(goal.emailRef.threadId)}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Gmail HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 512_000) throw new Error('Thread exceeds preparation limit');
      const thread = JSON.parse(body);
      const message = incomingGoalReply(thread.messages, Math.max(Date.parse(goal.createdAt), last?.seenAt || 0));
      if (!message) continue;
      const live = readWorkState(userId).goals.find(row => row.id === goal.id);
      if (!live || live.status !== 'active' || live.revision !== goal.revision) continue;
      const queued = await queueWorkEvent(userId, { kind: 'email', accountId: account.id,
        threadId: message.threadId, messageId: message.id, snippet: message.snippet || '',
        subject: message.payload?.headers?.find(header => header.name.toLowerCase() === 'subject')?.value || '' });
      if (queued) await mutateWorkState(userId, file => {
        if (file.mailChecks?.[key]) file.mailChecks[key].seenAt = Number(message.internalDate);
      });
    } catch (error) { console.warn('[proactive-work] linked Gmail thread check failed:', error.message); }
  }
}
