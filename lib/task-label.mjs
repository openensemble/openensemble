/**
 * One-shot LLM polish for scheduled-task labels.
 *
 * The plan model's `intent` field is a heavy compression of the user's
 * request (e.g. "SUBJECT: TEST BODY: Lets see if this works" → "test body"),
 * which makes for awful UI titles. cleanIntent() then strips scheduling
 * scaffolding but can't reconstruct content the plan model already lost.
 *
 * This helper takes the raw user request and asks the user's coordinator
 * agent's own provider/model for a short, human-readable title. Returns the
 * fallback on any failure (no key, network error, timeout, unsupported
 * provider) so scheduling still works regardless.
 */
import {
  ANTHROPIC_URL,
  OPENAI_OAUTH_BASE,
  OPENROUTER_URL,
  LMSTUDIO_COMPAT,
  OPENAI_COMPAT_PROVIDERS,
  getAnthropicKey,
  getCompatKey,
  getOpenRouterKey,
  getOllamaUrl,
  getOllamaKey,
  readAnthropicSSE,
} from '../chat/providers/_shared.mjs';
import { ensureFreshToken } from './openai-codex-auth.mjs';
import { getAgentsForUser, getUserCoordinatorAgentId } from '../routes/_helpers.mjs';

const SYSTEM = `You write short titles for scheduled tasks. Given a user's raw scheduling request, return a 3-7 word title that captures the action and key subject. Drop the time/recurrence. Capitalize like a heading. No quotes, no trailing period. Output ONLY the title — nothing else.

Examples:
"in 5 minutes send me an email. SUBJECT: TEST BODY: Lets see if this works" -> Send TEST email
"every morning at 7am give me a news briefing" -> Daily news briefing
"remind me to take my pills at 9pm" -> Take pills
"schedule a call with mom tomorrow at 3pm" -> Call mom`;

const TIMEOUT_MS = 5000;
const MAX_TOKENS = 30;

export async function polishLabel(rawText, fallback, userId) {
  if (!rawText || !userId) return fallback;
  const coordId = getUserCoordinatorAgentId(userId);
  if (!coordId) return fallback;
  const agent = getAgentsForUser(userId).find(a => a.id === coordId);
  if (!agent?.provider) return fallback;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const text = await dispatch(agent, rawText, ctrl.signal, userId);
    if (!text) return fallback;
    const cleaned = text.replace(/^["']|["']$|\.$/g, '').trim().slice(0, 80);
    return cleaned || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function dispatch(agent, user, signal, userId) {
  const p = agent.provider;
  if (p === 'anthropic')      return callAnthropic(agent.model, user, signal);
  if (p === 'openrouter')     return callOpenAICompat(OPENROUTER_URL, getOpenRouterKey(), agent.model, user, signal);
  if (p === 'openai-oauth')   return callOpenAIResponses(agent.model, user, signal, userId);
  if (p === 'lmstudio')       return callOpenAICompat(LMSTUDIO_COMPAT, 'lmstudio', agent.model, user, signal);
  if (p === 'ollama')         return callOllama(getOllamaUrl(), getOllamaKey(), agent.model, user, signal);
  const compatKey = p === 'grok' ? 'xai' : p;
  if (OPENAI_COMPAT_PROVIDERS[compatKey]) {
    const baseUrl = OPENAI_COMPAT_PROVIDERS[compatKey].baseUrl;
    return callOpenAICompat(`${baseUrl}/chat/completions`, getCompatKey(compatKey), agent.model, user, signal);
  }
  return null;
}

async function callAnthropic(model, user, signal) {
  const key = getAnthropicKey();
  if (!key) return null;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST', signal,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.content?.[0]?.text?.trim() ?? null;
}

async function callOpenAICompat(url, key, model, user, signal) {
  if (!key || !model) return null;
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callOllama(url, key, model, user, signal) {
  if (!model) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, {
    method: 'POST', signal, headers,
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_predict: MAX_TOKENS + 10 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.message?.content?.trim() ?? null;
}

// ChatGPT OAuth — /responses is streaming-only; we drain output_text deltas.
async function callOpenAIResponses(model, user, signal, userId) {
  if (!model) return null;
  const auth = await ensureFreshToken(userId).catch(() => null);
  if (!auth) return null;
  const headers = {
    'Content-Type':  'application/json',
    'Accept':        'text/event-stream',
    'Authorization': `Bearer ${auth.access_token}`,
    'OpenAI-Beta':   'responses=experimental',
    'Originator':    'codex_cli_rs',
  };
  if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
  const res = await fetch(`${OPENAI_OAUTH_BASE}/responses`, {
    method: 'POST', signal, headers,
    body: JSON.stringify({
      model,
      instructions: SYSTEM,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }],
      // "low" is fine for a 5-word title — gpt-5.x can refuse tools at "none",
      // but we're not using tools here, just plain text out.
      reasoning: { effort: 'low' },
      store: false,
      stream: true,
    }),
  });
  if (!res.ok) return null;
  let acc = '';
  for await (const ev of readAnthropicSSE(res.body)) {
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') acc += ev.delta;
    if (ev.type === 'response.completed' || ev.type === 'response.output_text.done') break;
  }
  return acc.trim() || null;
}
