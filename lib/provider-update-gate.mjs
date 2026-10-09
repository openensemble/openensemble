/** Test a proposal separately, before a user's request or any tool can use it. */
import { providerUpdateId, recordProviderUpdate, getProviderUpdateResult } from './provider-update-status.mjs';

const inFlight = new Map();
const COOLDOWN = 6 * 60 * 60_000;

export function updateFailureReason(status) {
  if (status === 401) return 'The test was blocked by an invalid or expired key/login.';
  if (status === 402 || status === 403) return 'The test was blocked by account access, permissions or billing.';
  if (status === 429) return 'The test was rate limited. OE will try again later.';
  if (status >= 500) return 'The provider was unavailable during the test. OE will try again later.';
  return status ? `The compatibility test failed (HTTP ${status}). An OE adapter update may be needed.`
    : 'The compatibility test did not complete with a valid response. An OE adapter update may be needed.';
}

async function testChatStream(endpoint, apiKey, model, proposal, signal) {
  const body = { model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true };
  // Reasoning models may spend the allowance before emitting visible text.
  // Keep both parameter variants bounded but large enough for a short answer.
  body[proposal.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = 512;
  if (!proposal.streamUsageDisabled) body.stream_options = { include_usage: true };
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(proposal.endpoint || endpoint, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, reason: updateFailureReason(response.status) };
  }
  return validateProbeStream(response);
}

export async function validateProbeStream(response, protocol = 'chat') {
  // Validate the wire protocol and completion, not just HTTP 200. Probes have
  // no tools and no user messages; they cannot generate images or do work.
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, reason: updateFailureReason() };
  let content = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128 * 1024) return { ok: false, reason: updateFailureReason() };
      content += Buffer.from(value).toString('utf8');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let text = false, completed = false;
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { if (protocol === 'chat') completed = true; continue; }
    let event;
    try { event = JSON.parse(data); } catch { return { ok: false, reason: updateFailureReason() }; }
    if (event.error || event.type === 'response.failed' || event.type === 'response.incomplete') return { ok: false, reason: updateFailureReason() };
    if (protocol === 'responses') {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta.trim()) text = true;
      if (event.type === 'response.completed' && event.response?.status === 'completed') {
        if (event.response.output?.some(item => item.type !== 'message' && item.type !== 'reasoning')) return { ok: false, reason: updateFailureReason() };
        if (event.response.output?.some(item => item.content?.some(c => c.type === 'output_text' && c.text?.trim()))) text = true;
        completed = true;
      }
      continue;
    }
    const choice = event.choices?.[0];
    if (choice?.delta?.tool_calls?.length) return { ok: false, reason: updateFailureReason() };
    if (typeof choice?.delta?.content === 'string' && choice.delta.content.trim()) text = true;
    if (['stop', 'length'].includes(choice?.finish_reason)) completed = true;
  }
  return text && completed ? { ok: true } : { ok: false, reason: updateFailureReason() };
}

export async function testProviderCompatibility({ provider, model, endpoint, apiKey, proposal,
  source = 'provider response', userId = '', signal, unsupported = false }) {
  // Scope results to the credential and user without storing either credential
  // or request text. Concurrent requests share a probe, not a user response.
  const id = providerUpdateId(userId, provider, endpoint, model, apiKey, source, proposal);
  const context = { id, userId, provider, model, source };
  const previous = getProviderUpdateResult(id);
  if (['rejected', 'blocked', 'rolled_back'].includes(previous?.status) && Date.now() - previous.checkedAt < COOLDOWN) {
    return { ok: false, context, reason: previous.reason, cached: true };
  }
  if (inFlight.has(id)) return inFlight.get(id);
  const task = (async () => {
    let safe = false;
    try {
      const target = new URL(proposal.endpoint || endpoint), trusted = new URL(endpoint);
      safe = target.origin === trusted.origin && target.protocol === 'https:' && !target.username && !target.password
        && !target.search && !target.hash;
      // Existing user-configured local endpoints can test parameter changes,
      // but a feed cannot redirect them or change paths over plain HTTP.
      if (target.href === trusted.href && ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) safe = true;
    } catch { /* Reject malformed URLs. */ }
    if (unsupported || !safe) {
      const reason = 'The proposed endpoint or protocol change needs an OE adapter update.';
      recordProviderUpdate({ ...context, status: 'rejected', reason });
      return { ok: false, context, reason };
    }
    recordProviderUpdate({ ...context, status: 'testing' });
    let result;
    try { result = await testChatStream(endpoint, apiKey, model, proposal, signal); }
    catch {
      result = { ok: false, reason: signal?.aborted ? 'The test was cancelled.' : 'The test timed out or could not reach the provider. OE will try again later.' };
    }
    if (!result.ok) recordProviderUpdate({ ...context, status: 'blocked', reason: result.reason });
    return { ...result, context };
  })().finally(() => { inFlight.delete(id); });
  inFlight.set(id, task);
  return task;
}
