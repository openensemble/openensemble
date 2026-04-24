/**
 * Context-compression helpers + LoopGuard (tool-loop stall detection).
 *
 * - LoopGuard: identical-call stall + error-loop detection
 * - compressToolDefs(): trim verbose tool descriptions
 * - compressToolCalls(): truncate large string args stored in history
 * - truncateToolResult(): cap tool output length
 * - compressOllamaHistory(): trim older tool/message content past a budget
 */

// ── LoopGuard — smart tool-loop stall detection ──────────────────────────────
// Replaces the hard MAX_LOOPS cap as the primary safeguard. All provider
// loops share this class. The hard ceiling (default 500) is a last resort;
// stall detection (identical-call and error-loop) is the real brake.
export class LoopGuard {
  constructor(maxLoops = 500) {
    this.maxLoops = maxLoops;
    this.count = 0;
    this.recentSigs = [];
    this.consecutiveErrors = 0;
    this.WINDOW = 4;        // identical-call window
    this.ERROR_WINDOW = 5;  // consecutive all-error iterations before break
  }
  /** Call at the top of each while iteration. Returns false → stop. */
  tick() { return ++this.count < this.maxLoops; }
  /**
   * Call after tool execution, before `continue`.
   * @param {Array<{name:string, args:string}>} calls  — tool name + raw args JSON
   * @param {Array<string>}                     results — tool result strings
   * @returns {{ stalled:boolean, reason:string }}
   */
  check(calls, results) {
    const sig = calls.map(c => `${c.name}:${c.args}`).join('|');
    this.recentSigs.push(sig);
    if (this.recentSigs.length > this.WINDOW) this.recentSigs.shift();
    // Identical-call stall
    if (this.recentSigs.length === this.WINDOW &&
        this.recentSigs.every(s => s === this.recentSigs[0])) {
      return { stalled: true, reason: `same tool call repeated ${this.WINDOW} times` };
    }
    // Error loop
    const allErrors = results.length > 0 &&
      results.every(r => /^(Tool error:|Error:)/i.test(String(r).trim()));
    this.consecutiveErrors = allErrors ? this.consecutiveErrors + 1 : 0;
    if (this.consecutiveErrors >= this.ERROR_WINDOW) {
      return { stalled: true, reason: `${this.ERROR_WINDOW} consecutive error results` };
    }
    return { stalled: false, reason: '' };
  }
}

// ── Tool definition compression ──────────────────────────────────────────────
// Compress tool definitions before sending to the model — truncates verbose
// descriptions that add tokens without meaningfully helping the model choose tools.
const TOOL_DESC_LIMIT  = 120; // chars for top-level tool description
const PARAM_DESC_LIMIT =  80; // chars for each parameter description
export function compressToolDefs(tools) {
  return tools.map(t => {
    const fn = t.function;
    const props = Object.fromEntries(
      Object.entries(fn.parameters?.properties ?? {}).map(([k, v]) => [k, {
        ...v,
        ...(typeof v.description === 'string' && v.description.length > PARAM_DESC_LIMIT
          ? { description: v.description.slice(0, PARAM_DESC_LIMIT) + '…' }
          : {}),
      }])
    );
    return {
      ...t,
      function: {
        ...fn,
        ...(typeof fn.description === 'string' && fn.description.length > TOOL_DESC_LIMIT
          ? { description: fn.description.slice(0, TOOL_DESC_LIMIT) + '…' }
          : {}),
        parameters: { ...fn.parameters, properties: props },
      },
    };
  });
}

// Truncate large string arguments in tool calls before storing in history.
// The model doesn't need the full file content in its context — it can use
// coder_read_file if it needs to re-examine a file (same as how Claude works).
const TOOL_ARG_LIMIT = 200; // chars kept per large argument
export function compressToolCalls(toolCalls) {
  return toolCalls.map(tc => {
    const raw = tc.function?.arguments ?? tc.arguments ?? {};
    const compressed = Object.fromEntries(
      Object.entries(raw).map(([k, v]) =>
        typeof v === 'string' && v.length > TOOL_ARG_LIMIT
          ? [k, v.slice(0, TOOL_ARG_LIMIT) + `…[${v.length - TOOL_ARG_LIMIT} chars — use coder_read_file to view]`]
          : [k, v]
      )
    );
    const copy = structuredClone(tc);
    if (copy.function) copy.function.arguments = compressed;
    else copy.arguments = compressed;
    return copy;
  });
}

// Truncate a tool result string before storing in history — mirrors how Claude Code
// truncates large tool outputs so the model isn't carrying full file contents forward.
export const TOOL_RESULT_LIMIT = 6000; // chars kept from large tool results
export function truncateToolResult(result) {
  if (typeof result !== 'string' || result.length <= TOOL_RESULT_LIMIT) return result;
  return result.slice(0, TOOL_RESULT_LIMIT) + `\n…[${result.length - TOOL_RESULT_LIMIT} chars truncated]`;
}

// Compress old tool-call/result pairs in the Ollama message list to prevent
// context bloat on long coding sessions. Keeps the system message and the most
// recent `keepTail` messages verbatim; older assistant tool-call messages have
// their arguments collapsed to a one-line summary and tool results are truncated,
// while preserving the pairing structure so the API doesn't see orphaned messages.
const HISTORY_KEEP_TAIL = 8; // recent messages kept verbatim
const PLAIN_MSG_LIMIT   = 400; // chars kept from large non-tool user/assistant messages

// ctxWindow: agent's contextSize (default 32768). Budget = 35% of window.
export function compressOllamaHistory(messages, ctxWindow = 32768) {
  if (messages.length <= HISTORY_KEEP_TAIL + 1) return;

  const HISTORY_TOKEN_BUDGET = Math.floor(ctxWindow * 0.35);

  // Quick size estimate (chars / 4 ≈ tokens)
  const approxSize = messages.reduce((n, m) => {
    return n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length;
  }, 0) / 4;
  if (approxSize <= HISTORY_TOKEN_BUDGET) return;

  // Compress all message types outside the keep-tail window
  const compressUpTo = messages.length - HISTORY_KEEP_TAIL;
  for (let i = 1; i < compressUpTo; i++) {
    const msg = messages[i];

    // Collapse assistant tool-call messages to a compact summary
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const summary = msg.tool_calls.map(tc => {
        const name = tc.function?.name ?? tc.name ?? '?';
        const args = tc.function?.arguments ?? tc.arguments ?? {};
        const argStr = Object.entries(args)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : v}`)
          .join(', ');
        return `[called ${name}(${argStr})]`;
      }).join('; ');
      messages[i] = { role: 'assistant', content: summary };
      continue;
    }

    // Truncate large tool result messages
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_LIMIT) {
      messages[i] = { ...msg, content: msg.content.slice(0, TOOL_RESULT_LIMIT) + `\n…[truncated]` };
      continue;
    }

    // Truncate large plain user/assistant messages (e.g. pasted email bodies stored in session)
    if ((msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string' && msg.content.length > PLAIN_MSG_LIMIT) {
      messages[i] = { ...msg, content: msg.content.slice(0, PLAIN_MSG_LIMIT) + `\n…[truncated]` };
    }
  }
}
