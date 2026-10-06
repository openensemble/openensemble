import { deleteSession, savedChatSessionKeys } from '../sessions.mjs';
import { tryAcquireUserTopologyTransition, finishUserTopologyTransition } from '../chat-dispatch/slot-registry.mjs';
import { getActiveTasks } from '../background-tasks.mjs';
import { loadTasksForOwner, updateTask } from '../scheduler.mjs';
import { projectContext, projectSessionKey, chatIdFromSession, withoutConversationSuffix } from './project-context.mjs';
import { forgetProjectChat } from './project-feed.mjs';
import { cancelPendingCredentialPrompts } from './credentials.mjs';
import { clearPendingForChat } from './pending-approvals.mjs';
import { sendToUser } from '../ws-handler/delivery.mjs';
import { ChatError } from './saved-chats.mjs';

// Hold the existing turn-admission gate until every history and its metadata
// have been removed. Late writers retain an obsolete session epoch.
export async function deleteSavedChatHistory(userId, chat, removeMetadata) {
  const transition = tryAcquireUserTopologyTransition(userId);
  if (!transition) throw new ChatError(409, 'Wait for running replies to finish before deleting a chat.');
  try {
    if (getActiveTasks().some(task => task.userId === userId && chatIdFromSession(task.sourceSessionKey) === chat.id)) {
      throw new ChatError(409, 'Stop or finish this chat’s running tasks before deleting it.');
    }
    await projectContext.run({ userId, projectId: chat.projectId, chatId: chat.id }, async () => {
      const keys = new Set(await savedChatSessionKeys(userId, chat.id, chat.projectId));
      keys.add(projectSessionKey(userId, chat.agentId, chat.projectId, chat.id));
      for (const key of keys) {
        const agentId = withoutConversationSuffix(key).slice(userId.length + 1);
        cancelPendingCredentialPrompts(userId, { agentId });
        await deleteSession(key, { strict: true });
      }
      clearPendingForChat(userId, chat.id);
      for (const task of loadTasksForOwner(userId).filter(task => task.chatId === chat.id)) {
        await updateTask(task.id, { enabled: false, chatId: null, disabledReason: 'Source chat deleted. Review this task before re-enabling it.' }, userId);
      }
      await forgetProjectChat(userId, chat.projectId, chat.id);
      removeMetadata();
    });
    sendToUser(userId, { type: 'saved_chat_deleted', chatId: chat.id, projectId: chat.projectId });
  } finally { finishUserTopologyTransition(transition); }
}
