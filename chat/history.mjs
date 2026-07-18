/**
 * Session → LLM history rebuild (tool_calls / tool results / provider adapt).
 * Extracted from chat.mjs — pure move; public API re-exported from chat.mjs.
 */

import { applyRedactions } from '../lib/credentials.mjs';
import { isProviderCallOrdinal } from './provider-consumer.mjs';

// Durable sessions keep one visible assistant row per turn, plus compact
// toolEvents/toolResults metadata. Provider APIs, however, distinguish an
// assistant's function call from the tool's output. Replaying that metadata as
// ordinary assistant prose made it possible for a model to copy strings such
// as "[tools used this turn: ...]" and falsely present them as a fresh call.
// Rebuild the original protocol boundary instead: assistant tool_calls, tool
// results, then the assistant's user-facing answer.
const HISTORY_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OMITTED_TOOL_RESULT = '[Tool result omitted from older conversation context.]';
const MISSING_TOOL_RESULT = '[Tool completed, but no textual result was retained.]';

function historyToolArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parsePersistedToolSummary(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([A-Za-z0-9_-]{1,64})([\s\S]*)$/);
  if (!match) return null;
  const suffix = match[2];
  if (suffix && !suffix.startsWith('(')) return null;
  let args = {};
  if (suffix) {
    const raw = suffix.endsWith(')') ? suffix.slice(1, -1) : suffix.slice(1);
    try { args = historyToolArgs(JSON.parse(raw)); } catch { /* truncated legacy preview */ }
  }
  return { name: match[1], args };
}

function safeToolArguments(value) {
  try { return JSON.stringify(historyToolArgs(value)); }
  catch { return '{}'; }
}

function stripLegacyToolProvenanceProse(value) {
  if (typeof value !== 'string') return value;
  return value
    // The compact call summary was always one line.
    .replace(/(^|\r?\n)[ \t]*\[tools used this turn:[^\r\n]*\][ \t]*(?=\r?\n|$)/gi, '$1')
    // Full results were always the final appendix on an assistant message.
    .replace(/(?:\r?\n)?[ \t]*\[prior-turn tool results\][\s\S]*$/i, '')
    .trimEnd();
}

function persistedToolCallBatches(row, rowIndex, keepFullResult) {
  const results = Array.isArray(row?.toolResults)
    ? row.toolResults.filter(r => r && HISTORY_TOOL_NAME_RE.test(String(r.name || '')))
    : [];
  const usedResults = new Set();
  const takeResult = (name, requestedIndex = null, allowNameFallback = true) => {
    if (Number.isInteger(requestedIndex)
        && requestedIndex >= 0
        && requestedIndex < results.length
        && results[requestedIndex]?.name === name
        && !usedResults.has(requestedIndex)) {
      usedResults.add(requestedIndex);
      return results[requestedIndex];
    }
    if (!allowNameFallback) return null;
    const idx = results.findIndex((r, i) => r.name === name && !usedResults.has(i));
    if (idx === -1) return null;
    usedResults.add(idx);
    return results[idx];
  };

  let records = [];
  if (Array.isArray(row?.toolEvents) && row.toolEvents.length) {
    // toolEvents are authoritative for modern rows: they retain exact (but
    // redacted) arguments and resultIndex preserves same-name FIFO pairing.
    // Pending calls never produced a result and must not be reconstructed as
    // completed work. Provider-hosted searches are also not local function
    // calls, so keep their answer in assistant prose without fabricating one.
    records = row.toolEvents
      .filter(event => {
        if (!event || !HISTORY_TOOL_NAME_RE.test(String(event.name || ''))) return false;
        // Nested specialist events are observations of delegated work, not
        // coordinator-local calls. The enclosing ask_agent event/result is the
        // coordinator's real protocol boundary and remains in history.
        if (event.delegated === true) return false;
        if (event.native === true) return false;
        // Compatibility for native-search rows written before `native` was
        // persisted explicitly.
        if (event.name === 'web_search'
            && event.args == null
            && !Number.isInteger(event.resultIndex)
            && results.some(r => r.name === 'web_search' && r.text === 'provider-hosted web search')) return false;
        return event.status === 'done' || event.status === 'error' || Number.isInteger(event.resultIndex);
      })
      .map(event => ({
        name: event.name,
        args: historyToolArgs(event.args),
        status: event.status,
        providerCallOrdinal: isProviderCallOrdinal(event.providerCallOrdinal)
          ? event.providerCallOrdinal
          : null,
        // Modern rows carry an exact resultIndex. Never guess by name when it
        // is absent: repeated same-name calls can otherwise receive each
        // other's outputs. Older toolEvent rows retained their own `text`
        // before resultIndex existed, so use that call-local value when
        // present. FIFO fallback is reserved for legacy toolsUsed summaries.
        result: takeResult(event.name, event.resultIndex, false)
          ?? (typeof event.text === 'string' && event.text.length
            ? { name: event.name, text: event.text }
            : null),
      }));
  } else if (Array.isArray(row?.toolsUsed)) {
    // Pre-toolEvents sessions retain `name({args preview})`. Parse complete
    // previews when possible; a truncated preview safely degrades to {} while
    // preserving the fact that the call really occurred.
    records = row.toolsUsed
      .map(parsePersistedToolSummary)
      .filter(Boolean)
      .map(call => ({
        ...call,
        status: 'done',
        providerCallOrdinal: null,
        result: takeResult(call.name),
      }));
  }

  const calls = records.map((record, callIndex) => {
    const retained = record.result == null ? null : String(record.result.text ?? '');
    const output = keepFullResult
      ? (retained || MISSING_TOOL_RESULT)
      : OMITTED_TOOL_RESULT;
    return {
      id: `call_hist_${rowIndex}_${callIndex}`,
      name: record.name,
      arguments: safeToolArguments(record.args),
      output: applyRedactions(output),
      providerCallOrdinal: record.providerCallOrdinal,
    };
  });

  if (!calls.length) return [];
  // Ordinals were added after structured history first shipped. If even one
  // retained local call lacks the new metadata, keep the legacy behavior and
  // replay the entire turn as one parallel batch. Guessing boundaries from
  // call/result order would invent dependencies that were never observed.
  if (!calls.every(call => isProviderCallOrdinal(call.providerCallOrdinal))) {
    return [calls];
  }

  const byOrdinal = new Map();
  for (const call of calls) {
    if (!byOrdinal.has(call.providerCallOrdinal)) byOrdinal.set(call.providerCallOrdinal, []);
    byOrdinal.get(call.providerCallOrdinal).push(call);
  }
  return [...byOrdinal.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, batch]) => batch);
}

/**
 * Convert durable session rows into provider-neutral OpenAI-style history.
 * Recent tool outputs remain available for pronoun follow-ups; older calls
 * retain a small structured completion marker instead of their full payload.
 */
export function buildLlmHistory(sessionRows) {
  const rows = Array.isArray(sessionRows) ? sessionRows : [];
  const fullResultIndexes = new Set();
  for (let i = rows.length - 1; i >= 0 && fullResultIndexes.size < 2; i--) {
    if (rows[i]?.role === 'assistant'
        && Array.isArray(rows[i]?.toolResults)
        && rows[i].toolResults.length
        // Hosted/native-only rows are telemetry, not replayable local calls.
        // Do not let one consume either of the two recent full-output slots.
        && persistedToolCallBatches(rows[i], i, false).length) fullResultIndexes.add(i);
  }

  const history = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || {};
    const { role, content, name, via, viaName } = row;
    // Old mapper-generated appendices and model-imitated copies are reserved
    // protocol text, never part of the assistant's semantic answer. Strip
    // them from model context while leaving the durable/UI row untouched.
    let body = role === 'assistant' ? stripLegacyToolProvenanceProse(content) : content;
    if (role === 'assistant' && via) {
      body = `${body || ''}\n[note: this reply was produced by the ${viaName ?? via} specialist via the pre-LLM router — you (the coordinator) did not run a turn]`;
    }

    if (role === 'assistant') {
      const callBatches = persistedToolCallBatches(row, rowIndex, fullResultIndexes.has(rowIndex));
      if (callBatches.length) {
        for (const calls of callBatches) {
          history.push({
            role: 'assistant',
            content: null,
            tool_calls: calls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          });
          for (const call of calls) {
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: call.output,
            });
          }
        }
        if (typeof body === 'string' && body.length) history.push({ role: 'assistant', content: body });
        continue;
      }
    }

    // A marker-only fabricated/legacy appendix strips to an empty string.
    // Omit that row instead of sending a strict provider an empty assistant
    // message with neither text nor a structured call.
    if (role === 'assistant' && (body == null || body === '')) continue;
    history.push(name ? { role, content: body, name } : { role, content: body });
  }
  return history;
}

function parsedToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { return historyToolArgs(JSON.parse(value)); } catch { return {}; }
}

/** Convert canonical structured history only where a provider wire format differs. */
export function adaptLlmHistoryForProvider(messages, provider) {
  const rows = Array.isArray(messages) ? messages : [];
  if (provider === 'anthropic') {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row?.role === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.length) {
        const blocks = [];
        if (typeof row.content === 'string' && row.content.trim()) blocks.push({ type: 'text', text: row.content });
        for (const call of row.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name ?? call.name,
            input: parsedToolArguments(call.function?.arguments ?? call.arguments),
          });
        }
        out.push({ role: 'assistant', content: blocks });
        const resultBlocks = [];
        while (rows[i + 1]?.role === 'tool') {
          const result = rows[++i];
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: result.tool_call_id,
            content: String(result.content ?? ''),
          });
        }
        if (resultBlocks.length) out.push({ role: 'user', content: resultBlocks });
        continue;
      }
      // Pair-safe trimming below prevents an orphan, but fail closed if a
      // malformed legacy row somehow supplies one.
      if (row?.role === 'tool') continue;
      out.push(row);
    }
    return out;
  }

  if (provider === 'ollama') {
    return rows.map(row => {
      if (row?.role === 'assistant' && Array.isArray(row.tool_calls)) {
        return {
          ...row,
          tool_calls: row.tool_calls.map(call => ({
            ...call,
            function: {
              ...call.function,
              arguments: parsedToolArguments(call.function?.arguments),
            },
          })),
        };
      }
      // Ollama pairs by function name and does not use OpenAI's call id.
      if (row?.role === 'tool') {
        return { role: 'tool', name: row.name, content: row.content };
      }
      return row;
    });
  }

  return rows;
}

export function historyMessageChars(message) {
  try { return JSON.stringify(message).length; }
  catch { return String(message?.content ?? '').length; }
}

