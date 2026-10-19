import fs from 'node:fs/promises';
import path from 'node:path';
import { BASE_DIR, getUserDir } from '../routes/_helpers/paths.mjs';
import { projectIdFromSession, chatIdFromSession, withoutConversationSuffix } from './project-context.mjs';
import { stableAgentRef } from './agent-ref.mjs';

const MAX_ITEMS = 200;
const SOURCE_LIMIT = 2000;
const clean = (value, limit = 240) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, limit) : '';
const timestamp = value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value) || 0;

async function readAccountStore(userId, name) {
  const file = path.join(getUserDir(userId), name);
  try {
    if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('Account store too large');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Every source is a local, account-scoped read. Opening this view must never
// contact a mail provider, mount a share, resume work, or change an allowance.
const sources = {
  approvals: async userId => {
    const store = await readAccountStore(userId, 'proposals.json');
    if (store !== undefined && (!store || typeof store !== 'object' || !Array.isArray(store.proposals))) throw new Error('Invalid approval store');
    return (await import('./proposals.mjs')).listUserProposals(userId, 'pending');
  },
  permissions: async userId => (await import('../chat-dispatch/slot-registry.mjs')).getActiveStreams(userId, { allProjects: true }),
  credentials: async userId => (await import('./credentials.mjs')).getPendingCredentialPrompts(userId, null, { allProjects: true }),
  schedules: async userId => {
    const value = await readAccountStore(userId, 'tasks.json');
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Invalid schedule store');
    return value.filter(row => !row.ownerId || row.ownerId === userId);
  },
  jobs: async userId => (await import('../background-tasks.mjs')).getActiveTasks().filter(row => row.userId === userId),
  failures: async userId => {
    const { assertWatcherStoreHealthy, listWatchers } = await import('../scheduler/watchers.mjs');
    assertWatcherStoreHealthy(userId);
    const { active, recent } = listWatchers(userId);
    return [...active, ...recent];
  },
  nodes: async userId => (await import('../skills/nodes/node-registry.mjs')).getNodes(userId),
  shares: async userId => (await import('./network-shares.mjs')).networkShares.list(userId),
  mail: async userId => (await import('./mail-workspace.mjs')).listMailReviewItems(userId),
  budgets: async userId => (await import('./run-budgets.mjs')).listPausedBudgetRuns(userId),
  backup: async () => (await import('./backup-checks.mjs')).getBackupAttention(BASE_DIR),
};

export function attentionConversation(userId, row) {
  const key = String(row.sourceSessionKey || '');
  const base = withoutConversationSuffix(key);
  return {
    agentId: clean(stableAgentRef(userId, withoutConversationSuffix(row.visibleAgentId || row.coordinatorAgentId || row.agentId || row.agent || (base.startsWith(`${userId}_`) ? base.slice(userId.length + 1) : ''))), 160),
    projectId: clean(row.projectId || projectIdFromSession(key), 100) || null,
    chatId: clean(row.chatId || chatIdFromSession(key), 100) || null,
  };
}

/** Injection is for isolated tests; routes always use the account-scoped sources above. */
export async function getNeedsAttention(userId, { agents = [], projects = [], admin = false } = {}, loaders = sources) {
  if (!/^user_[a-zA-Z0-9_-]+$/.test(userId || '')) throw new Error('A signed-in account is required');
  const names = new Map(agents.map(agent => [agent.id, clean(agent.name)]));
  const spaces = new Map(projects.map(project => [project.id, clean(project.name)]));
  const entries = Object.entries(loaders).filter(([name]) => name !== 'backup' || admin);
  const results = await Promise.allSettled(entries.map(([, load]) => load(userId)));
  const items = [], unavailable = [], truncatedSources = [];
  const add = (source, row, category, title, detail, action, updatedAt, priority = 2) => {
    if (row.userId && row.userId !== userId || row.ownerId && row.ownerId !== userId) return;
    const context = attentionConversation(userId, row);
    const fallbackId = context.agentId ? `${context.agentId}:${context.projectId || 'general'}:${context.chatId || 'original'}` : '';
    const sourceId = clean(row.id || row.taskId || row.nodeId || row.credentialId || row.runId || row.turnId || fallbackId, 400);
    if (!sourceId) return;
    items.push({ id: `${source}:${sourceId}`, source, sourceId, category, title: clean(title), detail: clean(detail, 600),
      owner: names.get(context.agentId) || 'Your account', project: spaces.get(context.projectId) || null,
      context, action, updatedAt: timestamp(updatedAt), priority });
  };
  results.forEach((result, index) => {
    const [source] = entries[index];
    if (result.status !== 'fulfilled') { unavailable.push(source); return; }
    if (!Array.isArray(result.value)) { unavailable.push(source); return; }
    if (result.value.length > SOURCE_LIMIT) truncatedSources.push(source);
    for (const row of result.value.slice(0, SOURCE_LIMIT)) {
      if (!row || typeof row !== 'object') continue;
      if (source === 'approvals') {
        if (row.status !== 'pending') continue;
        add(source, row, 'approval', row.title || row.label || 'Suggestion awaiting approval', row.description || row.summary,
          { type: 'proposal', label: 'Review suggestion' }, row.createdAt, 1);
      } else if (source === 'permissions') {
        if (row.phase !== 'awaiting_permission' || !row.permissionRequest) continue;
        add(source, row, 'approval', 'An agent needs permission', row.permissionRequest.description || row.permissionRequest.reason || 'Review the requested action in its conversation.',
          { type: 'conversation', label: 'Review permission' }, row.startTs, 0);
      } else if (source === 'credentials') {
        if (row.expiresAt && row.expiresAt <= Date.now()) continue;
        add(source, row, 'approval', row.label || 'An agent needs your input', row.description,
          { type: 'conversation', label: 'Open protected form' }, row.expiresAt, 0);
      } else if (source === 'schedules') {
        if (!row.lastError && !row.disabledReason) continue;
        add(source, row, 'failure', row.label || 'Scheduled task needs review', row.disabledReason || row.lastError,
          { type: 'schedule', label: 'Review task' }, row.lastRun || row.createdAt);
      } else if (source === 'jobs') {
        const cp = row.checkpoint;
        if (row.status !== 'paused' && cp?.status !== 'paused') continue;
        add(source, row, 'paused', row.summary || 'Interrupted work', cp?.reason || cp?.disabledReason || 'Saved progress is waiting for review.',
          { type: cp?.disabledReason ? 'conversation' : 'job', label: cp?.disabledReason ? 'Review conversation' : 'Review saved progress' }, cp?.updatedAt || row.startedAt, 1);
      } else if (source === 'failures') {
        if (!['error', 'failed', 'stalled'].some(status => [row.finalStatus, row.status, row.state?.phase].includes(status))) continue;
        add(source, row, 'failure', row.label || 'Task needs review', row.lastStatusText || row.finalText || 'Open the task ledger for details.',
          { type: 'watcher', label: 'Review task details' }, row.endedAt || row.updatedAt || row.startedAt);
      } else if (source === 'nodes') {
        if (!['disconnected', 'stale', 'unhealthy', 'error'].includes(row.health)) continue;
        add(source, row, 'connection', row.hostname || 'Paired node', row.health === 'disconnected' ? 'This paired node is offline.' : 'This paired node needs a health check.',
          { type: 'node', label: 'Review connection' }, row.disconnectedAt || row.lastHeartbeat);
      } else if (source === 'shares') {
        if (row.connected || row.autoMount === false) continue;
        add(source, row, 'connection', row.name || 'Network share', 'This saved share should connect automatically, but is not mounted.',
          { type: 'share', label: 'Review share connection' }, 0);
      } else if (source === 'mail') {
        add(source, row, 'uncertain', row.subject || row.title || 'Email send needs review', 'Check the sent message evidence before resolving this send.',
          { type: 'mail', label: 'Resolve email outcome' }, row.updatedAt || row.createdAt, 0);
      } else if (source === 'budgets') {
        add(source, row, 'paused', row.title || row.summary || 'Run paused at its budget', row.reason || 'Review usage and explicitly authorize any additional allowance.',
          { type: 'budget', label: 'Review budget' }, row.updatedAt || row.createdAt, 1);
      } else if (source === 'backup') {
        add(source, { ...row, id: row.id || 'verification' }, 'failure', row.title || 'Backup verification needs attention', row.detail || row.message || 'Review the last backup check in Settings.',
          { type: 'backup', label: 'Review backup check' }, row.updatedAt || row.at);
      }
    }
  });
  const unique = [...new Map(items.map(item => [item.id, item])).values()]
    .sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const counts = {};
  for (const item of unique) counts[item.category] = (counts[item.category] || 0) + 1;
  return { items: unique.slice(0, MAX_ITEMS), total: unique.length, counts, unavailable, truncatedSources,
    truncated: unique.length > MAX_ITEMS || truncatedSources.length > 0, checkedAt: Date.now() };
}
