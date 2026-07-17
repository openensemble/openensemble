// @ts-check
/**
 * task-bridge skill: lets an agent running in a background task pause to
 * ask the user a question. Only meaningful when called from inside
 * dispatchBackground's streamChat loop — that's where the ALS context is
 * established by background-tasks.mjs runInTaskContext().
 */
import { currentTaskContext, awaitUserReply } from '../../lib/task-proxy-context.mjs';
import { pushWatcherStatus } from '../../scheduler/watchers.mjs';
import { abortError } from '../../lib/abort-utils.mjs';

export async function* executeSkillTool(name, args, userId = 'default', _agentId = null, toolCtx = null) {
  if (name !== 'ask_user_via_task') { yield { type: 'result', text: null }; return; }

  const question = String(args?.question || '').trim();
  if (!question) {
    yield { type: 'result', text: 'Missing question parameter.' };
    return;
  }

  const ctx = currentTaskContext();
  if (!ctx?.watcherId) {
    yield {
      type: 'result',
      text: 'This tool only works inside a background task. Looks like you were called from a direct chat — just ask the user normally.',
    };
    return;
  }

  // Flip the watcher to awaiting_input + post the question to chat. Both
  // tabs converge to the same "awaiting" state via the existing status
  // broadcast pipe.
  try {
    pushWatcherStatus(userId, ctx.watcherId, `❓ ${question}`, {
      awaiting_input: true,
      pending_question: question,
      questionPostedAt: Date.now(),
      lastNudgeAt: Date.now(),
    });
  } catch (e) {
    console.warn('[task-bridge] failed to post awaiting-input status:', e.message);
  }

  // Block until the user replies (POST /api/watchers/:id/reply resolves
  // the promise). 24h timeout — long enough that idle users aren't a
  // problem; long task abandonment is what the watcher's heartbeat catches.
  let reply;
  try {
    reply = await awaitUserReply(ctx.watcherId, question, {
      timeoutMs: 24 * 60 * 60 * 1000,
      signal: toolCtx?.signal ?? null,
    });
  } catch (e) {
    if (toolCtx?.signal?.aborted) {
      throw abortError(toolCtx.signal, 'Background task cancelled while awaiting user input');
    }
    pushWatcherStatus(userId, ctx.watcherId, `⏱ Question timed out: "${question.slice(0, 60)}"`, {
      awaiting_input: false,
      pending_question: null,
    });
    yield { type: 'result', text: `User did not reply: ${e.message}. Continuing with best-guess defaults.` };
    return;
  }

  // Clear awaiting state, post the user's reply so the chip shows what
  // landed (multi-tab consistency).
  pushWatcherStatus(userId, ctx.watcherId, `↪ You: ${reply.slice(0, 200)}`, {
    awaiting_input: false,
    pending_question: null,
  });

  yield { type: 'result', text: `User replied: ${reply}` };
}

export default executeSkillTool;
