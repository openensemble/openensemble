// @ts-check
/**
 * chat-dispatch/profile-intercepts.mjs
 *
 * Text-intercepts that read the user's message and update the user's
 * profile or owned-agent record. Both run after the agent is resolved but
 * before the LLM dispatch:
 *
 *   - News-pref detection: matches strings like "set my news topic to
 *     technology" and writes newsDefaultTopic on the user. Side-effect
 *     only; the turn continues into the normal pipeline so the agent can
 *     also acknowledge it.
 *
 *   - Rename / re-emoji detection: matches "go by Helen the moon", writes
 *     the new name/emoji onto the agent (or per-user override), emits a
 *     spoken confirmation, persists the turn, and short-circuits the rest
 *     of the pipeline.
 */

import { updateCustomAgent, loadCustomAgents } from '../agents.mjs';
import { appendToSession } from '../sessions.mjs';
import {
  modifyUser, detectNewsPref, detectRenameCommand, saveUserAgentOverride,
} from '../routes/_helpers.mjs';

/**
 * Detect a news-preference command in the raw message and persist it.
 * Always returns null — the turn continues into the normal chat pipeline
 * so the agent can also acknowledge the change in its reply.
 */
export function tryNewsPrefIntercept({ rawText, userId, onEvent }) {
  const newsPrefIdx = detectNewsPref(rawText);
  if (newsPrefIdx === null) return null;
  try {
    // Surgical: write just this user's profile.json. Don't bulk-rewrite
    // every user — saveUsers does directory garbage-collection that has
    // bitten us before (see feedback_master_key_never_overwrite).
    modifyUser(userId, u => { u.newsDefaultTopic = newsPrefIdx; });
  } catch (e) { console.warn('[chat] Failed to save news preference:', e.message); }
  onEvent({ type: 'news_pref_saved', topic: newsPrefIdx });
  return null;
}

/**
 * Detect a rename/re-emoji command ("go by Helen the moon", "call yourself
 * Foo 🌟"). On match, writes the new name/emoji to the canonical agent
 * record (if owned) or a per-user override (otherwise), emits a spoken
 * confirmation, persists the turn, and returns {handled:true} so the
 * caller short-circuits the rest of the pipeline.
 *
 * @returns {{ handled: true } | null}
 */
export function tryRenameIntercept({ rawText, userId, agentId, agent, onEvent, onBroadcast }) {
  const rename = detectRenameCommand(rawText);
  if (!rename) return null;
  // Strip null values so we only update what was actually specified
  const changes = Object.fromEntries(Object.entries(rename).filter(([, v]) => v != null));
  // If this is a custom agent owned by the user, update the agent itself
  const customAgent = loadCustomAgents().find(a => a.id === agentId && a.ownerId === userId);
  if (customAgent) {
    updateCustomAgent(agentId, changes);
    // Clear any stale per-user overrides for fields now canonical on the agent.
    // Surgical write — same reason as the news-pref site above.
    try {
      modifyUser(userId, u => {
        if (u.agentOverrides?.[agentId]) {
          for (const k of Object.keys(changes)) delete u.agentOverrides[agentId][k];
        }
      });
    } catch (e) { console.warn('[chat] Failed to clear agent overrides:', e.message); }
  } else {
    saveUserAgentOverride(userId, agentId, changes);
  }
  onBroadcast();
  const newName  = changes.name  ?? agent.name;
  const newEmoji = changes.emoji ?? agent.emoji ?? '';
  const reply = `Got it — I'll go by **${newName}**${newEmoji ? ` ${newEmoji}` : ''} from now on.`;
  onEvent({ type: 'token', text: reply, agent: agentId });
  onEvent({ type: 'done', agent: agentId });
  appendToSession(`${userId}_${agentId}`,
    { role: 'user', content: rawText, ts: Date.now() },
    { role: 'assistant', content: reply, ts: Date.now() }
  );
  return { handled: true };
}
