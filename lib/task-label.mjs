/**
 * One-shot LLM rewrite for scheduled tasks.
 *
 * The plan model's `intent` field is a heavy compression of the user's
 * request (e.g. "SUBJECT: TEST BODY: Lets see if this works" → "test body"),
 * which makes for awful UI titles, and the raw text contains the scheduling
 * trigger ("in 5 minutes …") which makes the agent at fire time think it
 * needs to delay the action.
 *
 * polishTask asks the user's coordinator agent's own provider for two
 * fields in a single call:
 *   - title:       3-7 word heading for the task list
 *   - instruction: the request rewritten as a plain "do this now" command,
 *                  with the trigger removed and all content (subject, body,
 *                  recipient) preserved verbatim
 *
 * Returns null on any failure (no key, network error, timeout, unsupported
 * provider, unparseable output) so the caller falls back to its own
 * defaults — scheduling still works without LLM support.
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

const SYSTEM = `You preprocess a scheduled-task request. Given the user's raw text, output exactly two single-line fields and nothing else:

TITLE: <3-7 word heading-cased label for the task list>
INSTRUCTION: <the request rewritten as a plain "do this now" command, with the scheduling trigger ("in N minutes", "tomorrow at 5pm", "every morning at 7am", "schedule", "remind me to", etc) removed. Keep all subject, body, recipient, content, and address details verbatim.>

The trigger time has already arrived by the time the instruction is read, so the instruction must NOT mention timing.

Examples:

Input: "in 5 minutes send me an email. SUBJECT: TEST BODY: Lets see if this works"
TITLE: Send TEST email
INSTRUCTION: send me an email. SUBJECT: TEST BODY: Lets see if this works

Input: "every morning at 7am give me a news briefing"
TITLE: Daily news briefing
INSTRUCTION: give me a news briefing

Input: "at 12pm send me an email of the current stock market averages"
TITLE: Stock averages email
INSTRUCTION: send me an email of the current stock market averages

Input: "in 5 minutes send me an email reminding me to take my pills"
TITLE: Pill reminder email
INSTRUCTION: send me an email reminding me to take my pills

Input: "remind me to take my pills at 9pm"
TITLE: Take pills
INSTRUCTION: take my pills

Input: "in 2 hours email shawn at scmurray1@gmail.com about the deploy status"
TITLE: Email Shawn deploy status
INSTRUCTION: email shawn at scmurray1@gmail.com about the deploy status`;

const TIMEOUT_MS = 6000;
const MAX_TOKENS = 120;

export async function polishTask(rawText, userId) {
  if (!rawText || !userId) return null;
  const coordId = getUserCoordinatorAgentId(userId);
  if (!coordId) return null;
  const agent = getAgentsForUser(userId).find(a => a.id === coordId);
  if (!agent?.provider) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const text = await dispatch(agent, rawText, ctrl.signal, userId);
    return parseTitleAndInstruction(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseTitleAndInstruction(text) {
  if (!text) return null;
  const titleMatch = text.match(/^\s*TITLE:\s*(.+?)\s*$/im);
  const instrMatch = text.match(/^\s*INSTRUCTION:\s*([\s\S]+?)\s*$/im);
  const title = titleMatch?.[1]?.replace(/^["']|["']$|\.$/g, '').trim().slice(0, 80);
  const instruction = instrMatch?.[1]?.trim();
  if (!title || !instruction) return null;
  return { title, instruction };
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
      options: { num_predict: MAX_TOKENS + 20 },
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
