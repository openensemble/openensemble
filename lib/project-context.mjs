import { AsyncLocalStorage } from 'node:async_hooks';

// Bound to one authenticated conversation, inherited by its delegated work.
export const projectContext = new AsyncLocalStorage();
export const isProjectId = value => typeof value === 'string' && /^space_[a-f0-9]{24}$/.test(value);
export const isChatId = value => typeof value === 'string' && /^chat_[a-f0-9]{24}$/.test(value);
export const projectIdFromSession = value => String(value || '').match(/__(space_[a-f0-9]{24})$/)?.[1] || null;
export const chatIdFromSession = value => String(value || '').match(/__(chat_[a-f0-9]{24})(?:__space_[a-f0-9]{24})?$/)?.[1] || null;
export const withoutProjectSuffix = value => String(value || '').replace(/__space_[a-f0-9]{24}$/, '');
export const withoutConversationSuffix = value => withoutProjectSuffix(value).replace(/__chat_[a-f0-9]{24}$/, '');
export function currentProjectId(userId) {
  const context = projectContext.getStore();
  return context?.userId === userId ? context.projectId || null : null;
}
export function currentChatId(userId) {
  const context = projectContext.getStore();
  return context?.userId === userId ? context.chatId || null : null;
}
export function projectSessionKey(userId, agentId, projectId = currentProjectId(userId), chatId = currentChatId(userId)) {
  if (projectId && !isProjectId(projectId)) throw new Error('Invalid project space');
  if (chatId && !isChatId(chatId)) throw new Error('Invalid saved chat');
  return `${userId}_${agentId}${chatId ? `__${chatId}` : ''}${projectId ? `__${projectId}` : ''}`;
}
export function resolveProjectSessionKey(key) {
  const context = projectContext.getStore();
  if ((!context?.projectId && !context?.chatId) || typeof key !== 'string' || projectIdFromSession(key) || chatIdFromSession(key)
      || !key.startsWith(`${context.userId}_`)) return key;
  return `${key}${context.chatId ? `__${context.chatId}` : ''}${context.projectId ? `__${context.projectId}` : ''}`;
}
export function projectEvent(userId, event) {
  if (!event || typeof event !== 'object') return event;
  const explicitKey = projectIdFromSession(event.agent) || chatIdFromSession(event.agent);
  const id = Object.hasOwn(event, 'projectId') ? event.projectId : projectIdFromSession(event.agent) ?? (explicitKey ? null : currentProjectId(userId));
  const chatId = Object.hasOwn(event, 'chatId') ? event.chatId : chatIdFromSession(event.agent) ?? (explicitKey ? null : currentChatId(userId));
  return id || chatId ? { ...event, projectId: id, chatId, ...(event.agent ? { agent: withoutConversationSuffix(event.agent) } : {}) } : event;
}
export function matchesProject(client, event) {
  return (client._projectId || null) === (event?.projectId || projectIdFromSession(event?.agent) || null)
    && (client._chatId || null) === (event?.chatId || chatIdFromSession(event?.agent) || null);
}
