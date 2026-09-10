import { clearSession, getSessionEpoch } from '../sessions.mjs';
import { abortChat, getActiveStream } from '../chat-dispatch/slot-registry.mjs';
import { cancelPendingCredentialPrompts } from './credentials.mjs';
import { currentProjectId, projectSessionKey } from './project-context.mjs';
import { getAgentsForUser, isUserTimeBlocked } from '../routes/_helpers.mjs';

export async function clearChatSession(userId, agentId, { expectedEpoch = null, requestId = null } = {}) {
  if (isUserTimeBlocked(userId)) throw new Error('Access is restricted at this time');
  if (!getAgentsForUser(userId).some(agent => agent.id === agentId)) throw new Error('Unknown agent');
  const projectId = currentProjectId(userId);
  const sessionKey = projectSessionKey(userId, agentId, projectId);
  const epoch = getSessionEpoch(sessionKey);
  const ignored = () => ({ type: 'session_clear_ignored', agent: agentId,
    sessionEpoch: getSessionEpoch(sessionKey), ...(projectId ? { projectId } : {}) });
  if (expectedEpoch && expectedEpoch !== epoch) return ignored();
  let sessionEpoch;
  try {
    sessionEpoch = await clearSession(sessionKey, { expectedEpoch: epoch, requestId, beforeClear: () => {
      const snapshot = getActiveStream(userId, agentId);
      abortChat(userId, agentId);
      cancelPendingCredentialPrompts(userId, { agentId });
      return snapshot;
    } });
  }
  catch (error) { if (error.code === 'SESSION_CHANGED') return ignored(); throw error; }
  return { type: 'session_cleared', agent: agentId, sessionEpoch,
    ...(projectId ? { projectId, projectProgressSaved: true } : {}) };
}
