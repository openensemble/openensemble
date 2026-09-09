import { AsyncLocalStorage } from 'node:async_hooks';

// Bound to one authenticated conversation, inherited by its delegated work.
export const projectContext = new AsyncLocalStorage();
export const isProjectId = value => typeof value === 'string' && /^space_[a-f0-9]{24}$/.test(value);
export const projectIdFromSession = value => String(value || '').match(/__(space_[a-f0-9]{24})$/)?.[1] || null;
export const withoutProjectSuffix = value => String(value || '').replace(/__space_[a-f0-9]{24}$/, '');
export function currentProjectId(userId) {
  const context = projectContext.getStore();
  return context?.userId === userId ? context.projectId || null : null;
}
export function projectSessionKey(userId, agentId, projectId = currentProjectId(userId)) {
  if (projectId && !isProjectId(projectId)) throw new Error('Invalid project space');
  return `${userId}_${agentId}${projectId ? `__${projectId}` : ''}`;
}
export function resolveProjectSessionKey(key) {
  const context = projectContext.getStore();
  if (!context?.projectId || typeof key !== 'string' || projectIdFromSession(key)
      || !key.startsWith(`${context.userId}_`)) return key;
  return `${key}__${context.projectId}`;
}
export function projectEvent(userId, event) {
  if (!event || typeof event !== 'object') return event;
  const id = event.projectId ?? projectIdFromSession(event.agent) ?? currentProjectId(userId);
  return id ? { ...event, projectId: id, ...(event.agent ? { agent: withoutProjectSuffix(event.agent) } : {}) } : event;
}
export function matchesProject(client, event) {
  return (client._projectId || null) === (event?.projectId || projectIdFromSession(event?.agent) || null);
}
