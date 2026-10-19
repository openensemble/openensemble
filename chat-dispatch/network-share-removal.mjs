import { appendToSession, failPendingTurn, loadSession } from '../sessions.mjs';
import { randomUUID } from 'node:crypto';
import { getUserRole } from '../routes/_helpers.mjs';
import { networkShares } from '../lib/network-shares.mjs';
import { stagePending, getPending, takePending, clearPendingFor } from '../lib/pending-approvals.mjs';
import { detectNetworkShareRemoval, isNetworkShareFileRemoval, shareLocationInText, SHARE_REMOVAL_REQUEST } from '../lib/network-share-removal.mjs';

const KIND = 'network_share_removal';
const safeChoice = /^(?:1|one|option\s+(?:1|one)|oe\s+only|(?:only\s+)?remove\s+(?:it\s+)?from\s+oe(?:\s+only)?|keep\s+(?:all\s+)?(?:the\s+)?files)[.!]?$/i;
const deleteChoice = /^(?:2|two|option\s+(?:2|two)|delete\s+(?:all\s+)?(?:the\s+)?files\s+and\s+(?:the\s+)?share|delete\s+(?:the\s+)?share\s+and\s+(?:all\s+)?(?:its\s+|the\s+)?files)[.!]?$/i;
const cancelChoice = /^(?:3|three|option\s+(?:3|three)|ignore(?:\s+(?:(?:this|that|the)\s+request|it))?|cancel|stop|never\s*mind|nevermind|neither|no)[.!]?$/i;
const display = value => String(value || 'this share').replace(/[`\r\n]/g, ' ').slice(0, 250);
const question = pending => `How should I remove **${display(pending.reference)}**?\n\n1. **Remove from OE only** — disconnect it${pending.forget ? ' and forget the saved connection' : ''}. Keep the server's share and all files.\n2. **Delete all files and the share** — permanently delete its contents and remove the share from the server. This requires a separate confirmation of the exact address.\n3. **Ignore this request** — cancel removal and leave the connection, share, and files unchanged.\n\nReply **1**, **2**, or **3**. You can also say **cancel**. Nothing has been changed.`;
const confirmation = pending => `Permanently delete **all files** in \`${display(pending.location)}\` and remove that share from its server? Other shares must remain untouched.\n\nTo confirm, copy this exact phrase:\n\n${pending.confirmation}\n\nReply **1** to remove it from OE only, or **3** (**ignore this request**) or **cancel** to keep it. Nothing has been deleted.`;

export async function tryNetworkShareRemovalIntercept({ userText, userId, agentId, agent, toolPlan, onEvent }) {
  let pending = getPending(userId, KIND, agentId);
  const text = String(userText || '').trim();
  if (toolPlan?.mode === 'none' && !(pending && cancelChoice.test(text))) return null;
  const isConfirmation = /^DELETE SHARE /i.test(text);
  if (!pending && !SHARE_REMOVAL_REQUEST.test(text) && !isConfirmation
      && !safeChoice.test(text) && !deleteChoice.test(text) && !cancelChoice.test(text)) return null;
  const history = await loadSession(`${userId}_${agentId}`);
  const lastAssistant = history.filter(row => row.role === 'assistant').at(-1)?.content || '';
  const staleChoice = !pending && (safeChoice.test(text) || deleteChoice.test(text) || cancelChoice.test(text))
    && /How should I remove \*\*|To confirm, copy this exact phrase:/i.test(lastAssistant);
  if (!pending && !SHARE_REMOVAL_REQUEST.test(text) && !isConfirmation && !staleChoice) return null;

  const finish = async (reply, extra = {}) => {
    try {
      await appendToSession(`${userId}_${agentId}`,
        { role: 'user', content: userText, ts: Date.now() },
        { role: 'assistant', content: reply, ts: Date.now() });
    } catch {
      await failPendingTurn(`${userId}_${agentId}`, 'Could not save the share-removal result', { retryable: false }).catch(() => {});
      onEvent({ type: 'error', code: 'persistence_failed', retryable: false, agent: agentId,
        message: 'Could not save the share-removal result. Check connection status before retrying.' });
      return { handled: true };
    }
    onEvent({ type: 'token', text: reply, agent: agentId });
    if (!extra.followupPrompt) onEvent({ type: 'done', agent: agentId });
    return { handled: true, ...extra };
  };
  if (isConfirmation && (!pending || pending.phase !== 'confirm' || text !== pending.confirmation)) {
    return finish('That deletion confirmation is expired, stale, or does not match this chat. Nothing was deleted. Ask to remove the share again.');
  }
  if (staleChoice) return finish(cancelChoice.test(text) ? 'No share removal is pending. Nothing was changed.'
    : 'That share-removal choice has expired. Nothing was changed. Ask to remove the share again.');
  if (pending && cancelChoice.test(text)) {
    clearPendingFor(userId, KIND, agentId, { expectedOpId: pending.opId });
    return finish('Share removal cancelled. The OE connection, server share, and all files are unchanged.');
  }
  const allowed = new Set((agent?.tools || []).map(tool => tool.function?.name));
  const shares = allowed.has('disconnect_network_share') ? await networkShares.list(userId) : [];
  if (pending && isNetworkShareFileRemoval(text, shares)) {
    clearPendingFor(userId, KIND, agentId, { expectedOpId: pending.opId });
    return null;
  }
  const request = pending ? null : detectNetworkShareRemoval(text, shares, history);
  if (!pending && !request) return null;
  if (getUserRole(userId) === 'child' || !allowed.has('disconnect_network_share')) {
    return finish('Network share removal is unavailable for this account or assistant. Nothing was changed.');
  }
  if (pending && safeChoice.test(text)) {
    const chosen = takePending(userId, KIND, agentId, { expectedOpId: pending.opId });
    if (!chosen) return finish('That share-removal choice is no longer pending. Nothing was changed.');
    try {
      const shares = await networkShares.list(userId);
      const record = shares.find(share => chosen.shareId ? share.id === chosen.shareId : share.location === chosen.location);
      if (!record || (chosen.location && record.location !== chosen.location)) {
        return finish(`There is no matching saved OE connection for **${display(chosen.reference)}**. I did not change the server's share or files. Older system mounts are separate from OE's saved connections.`);
      }
      await networkShares.disconnect(userId, { share_id: record.id, forget: chosen.forget });
      return finish(`Removed **${display(record.name)}** from OE${chosen.forget ? ' and forgot its saved connection' : ' (saved settings retained; automatic mounting is off)'}. The server's share and all files are unchanged.`);
    } catch (error) {
      return finish(`Could not remove the OE connection: ${error.code ? error.message : 'the connection operation failed'}. The server's share and files were not deleted.`);
    }
  }
  if (pending?.phase === 'address' && /^(?:smb|nfs):|^\/\/|^\\\\/i.test(text) && !shareLocationInText(text)) {
    return finish('That is not a valid SMB or NFS share address. Provide the exact address without credentials. Nothing was changed.');
  }
  if (pending && (deleteChoice.test(text) || (pending.phase === 'address' && shareLocationInText(text)) || isConfirmation)) {
    if (!['owner', 'admin'].includes(getUserRole(userId)) || !allowed.has('node_exec')) {
      return finish('Deleting a server share requires an administrator and an authorized server node. Nothing was changed. Reply 1 to remove the OE connection only, or 3 to ignore this request.');
    }
    if (isConfirmation) {
      const approved = takePending(userId, KIND, agentId, { expectedOpId: pending.opId });
      if (!approved) return finish('That deletion is no longer pending. Nothing was changed.');
      return finish(`Confirmed deletion of \`${display(approved.location)}\` and all its files. Checking the server target before proceeding.\n\n`, {
        networkShareDeletionApproval: { userId, agentId, location: approved.location, opId: approved.opId },
        followupPrompt: `The user chose permanent deletion and confirmed the exact share address ${JSON.stringify(approved.location)} and ALL files inside it. Remove only that share and its contents, then remove its OE connection if present. Verify the server identity and exact backing directory first; never delete a server root, a parent directory, another share, or files outside this share. If the share's backing directory is shared with another export or cannot be determined safely, stop and explain. Do not substitute another target. Report tool-confirmed results. This approval applies only to this operation.`,
      });
    }
    const location = pending.location || shareLocationInText(text);
    if (!location) {
      stagePending(userId, KIND, { ...pending, phase: 'address' });
      return finish('Before deletion, provide the exact SMB or NFS share address (for example, smb://server/share or nfs://server/export). I will show it for final confirmation. Reply 3 to ignore this request. Nothing was changed.');
    }
    const payload = { ...pending, phase: 'confirm', location };
    // A fresh nonce binds the typed confirmation to this exact staged choice.
    payload.confirmation = `DELETE SHARE ${location} AND ALL FILES #${randomUUID()}`;
    stagePending(userId, KIND, payload);
    return finish(confirmation(payload));
  }
  if (pending && /^(?:yes|ok|okay|do it|sure)[.!]?$/i.test(text)) {
    return finish(pending.phase === 'confirm' ? confirmation(pending) : question(pending));
  }
  const nextRequest = request || detectNetworkShareRemoval(text, shares, history);
  if (!nextRequest) {
    // An ambiguous reply must not fall through to the model, which could
    // interpret it using the old chat's destructive tool history.
    if (pending) return finish(pending.phase === 'confirm' ? confirmation(pending) : question(pending));
    return null;
  }
  stagePending(userId, KIND, { ...nextRequest, phase: 'choice' });
  return finish(question(nextRequest));
}
