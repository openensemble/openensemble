import { setTimeout as delay } from 'node:timers/promises';
import { consumeProvider, mergeProviderUsage } from './provider-consumer.mjs';
import { isRetrySafeControlTool } from './recovery.mjs';
import { isTransientProviderError } from '../lib/provider-recovery.mjs';

const RETRY_DELAYS = [5_000, 15_000, 30_000];

// Keep retries inside the same turn and cancellation signal. Only restart a
// provider before it has invoked an action; never replay a completed tool.
export async function* consumeProviderWithRetry(providerFactory, { retry = false, signal, ...options } = {}) {
  let prior = null;
  for (let attempt = 0; ; attempt++) {
    let failure = null;
    let effectSeen = false;
    const consumer = consumeProvider(providerFactory(), {
      ...options,
      providerCallOrdinalOffset: (options.providerCallOrdinalOffset || 0) + (prior?.modelCalls.length || 0),
    });
    let result;
    try {
      while (true) {
        const step = await consumer.next();
        if (step.done) { result = step.value; break; }
        const event = step.value;
        if (event.type === 'error') { failure = event; continue; }
        if (['tool_call', 'tool_progress', 'tool_result'].includes(event.type) && !isRetrySafeControlTool(event.name)) effectSeen = true;
        if (['permission_request', 'approval_pending', 'credential_prompt', 'image', 'video', 'hide_turn', '__notify'].includes(event.type)) effectSeen = true;
        yield event;
      }
    } finally { await consumer.return(); }
    if (prior) {
      result.usage = mergeProviderUsage(prior.usage, result.usage);
      for (const field of ['modelCalls', 'toolsUsed', 'toolEvents', 'toolIdentityAnomalies', 'turnImages']) result[field] = [...prior[field], ...result[field]];
    }
    // A paid hosted image request can be accepted before the socket fails.
    // Its provider adapter intentionally forbids replay even without a receipt.
    const paidImageOffered = result.modelCalls.some(call => call.toolNames?.includes('image_generation'));
    const safe = !effectSeen && !paidImageOffered && !result.turnImages.length && !result.toolIdentityAnomalies.length
      && result.toolEvents.every(event => isRetrySafeControlTool(event.name));
    if (!retry || !result.errored || !safe || signal?.aborted
        || attempt >= RETRY_DELAYS.length || !isTransientProviderError(failure)) {
      if (failure) yield failure;
      return result;
    }
    const delayMs = RETRY_DELAYS[attempt];
    yield { type: 'provider_retry', attempt: attempt + 2, maxAttempts: RETRY_DELAYS.length + 1,
      retryAt: Date.now() + delayMs, message: 'The AI connection was interrupted. Retrying automatically…' };
    try { await delay(delayMs, undefined, { signal }); }
    catch (error) { if (signal?.aborted) return result; throw error; }
    if (signal?.aborted) return result;
    // A partial draft is replaced, not concatenated with a second answer.
    yield { type: 'replace', text: '' };
    yield { type: 'provider_retry', attempt: attempt + 2, maxAttempts: RETRY_DELAYS.length + 1, retryAt: null };
    prior = result;
  }
}
