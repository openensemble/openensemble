/**
 * Tool-result previews + draining helpers.
 *
 * - summarizeToolResult(): condense a tool result for UI chrome
 * - normalizeToolResult(): coerce string-or-{text,_notify} tool results
 * - drainToolResult(): drive an async-gen tool to completion for parallel dispatch
 */

import { executeToolStreaming } from '../roles.mjs';

// Produce a concise summary of a tool result for the UI (avoids dumping raw code/data).
// Per-tool handlers provide structured previews for the noisiest tools;
// everything else falls back to generic markdown-stripped truncation.
export function summarizeToolResult(name, result) {
  if (!result) return result;
  const text = String(result);
  const tooled = TOOL_PREVIEWS[name]?.(text);
  if (tooled) return tooled;
  return genericPreview(text);
}

function genericPreview(text) {
  // Strip markdown noise so previews don't show raw **bold** / __underline__ syntax.
  const clean = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 120) return clean;
  // Cut at the last word boundary within the budget so we don't chop emoji / words.
  const MAX = 110;
  let cut = clean.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 60) cut = cut.slice(0, lastSpace);
  return `${cut}… (${clean.length} chars)`;
}

// Per-tool preview formatters. Return null to fall back to genericPreview.
const TOOL_PREVIEWS = {
  node_list(text) {
    // Entries are separated by blank lines; each starts with "**hostname** (nodeId) <icon> <health>"
    const entries = text.split(/\n\n+/).filter(e => e.trim().startsWith('**'));
    if (!entries.length) return null;
    const counts = { healthy: 0, degraded: 0, down: 0, other: 0 };
    for (const e of entries) {
      const health = e.match(/🟢|🟡|🔴/)?.[0];
      if (health === '🟢') counts.healthy++;
      else if (health === '🟡') counts.degraded++;
      else if (health === '🔴') counts.down++;
      else counts.other++;
    }
    const parts = [`${entries.length} node${entries.length === 1 ? '' : 's'}`];
    if (counts.healthy)  parts.push(`${counts.healthy} 🟢`);
    if (counts.degraded) parts.push(`${counts.degraded} 🟡`);
    if (counts.down)     parts.push(`${counts.down} 🔴`);
    return parts.join(' · ');
  },
  node_exec(text) {
    // Two shapes: short status blob ending with "Exit code: N (Mms)", or a long
    // command output ending the same way. Surface exit + duration + output size.
    const exitMatch = text.match(/Exit code:\s*(-?\d+)\s*\((\d+)ms\)/);
    if (!exitMatch) return null;
    const [, code, ms] = exitMatch;
    const bodyBytes = text.length;
    const secs = (Number(ms) / 1000).toFixed(1);
    const exitIcon = code === '0' ? '✓' : '✗';
    return `${exitIcon} exit ${code} · ${secs}s · ${bodyBytes} B`;
  },
  node_status(text) {
    // Format: "**hostname** Status:\n  Platform: ...\n  Distro: ...\n  Uptime: ..."
    const host = text.match(/^\*\*(.+?)\*\*/)?.[1];
    const distro = text.match(/Distro:\s*(.+)/)?.[1]?.trim();
    const uptime = text.match(/Uptime:\s*(.+)/)?.[1]?.trim();
    const load = text.match(/Load:\s*([\d.,\s]+)/)?.[1]?.split(',')[0]?.trim();
    const parts = [];
    if (host)   parts.push(host);
    if (distro) parts.push(distro);
    if (uptime) parts.push(`up ${uptime}`);
    if (load)   parts.push(`load ${load}`);
    return parts.length ? parts.join(' · ') : null;
  },
  ask_agent(text) {
    // Strip any "[Note: waited Xs ...]" prefix we add for queued delegations,
    // then show the first sentence of the specialist's reply.
    const stripped = text.replace(/^\[Note:[^\]]+\]\s*/, '').trim();
    const firstLine = stripped.split('\n').find(l => l.trim()) ?? '';
    const clean = firstLine.replace(/\*\*(.+?)\*\*/g, '$1').trim();
    if (clean.length <= 140) return clean;
    const cut = clean.slice(0, 130);
    const lastSpace = cut.lastIndexOf(' ');
    return `${cut.slice(0, lastSpace > 60 ? lastSpace : 130)}…`;
  },
};

// Normalize tool results — tools can return a string or { text, _notify }
export function normalizeToolResult(result) {
  if (typeof result === 'object' && result !== null && typeof result.text === 'string') {
    return { text: result.text, _notify: result._notify ?? null };
  }
  return { text: String(result), _notify: null };
}

// Drain an async generator tool into a plain string — used for parallel execution
export async function drainToolResult(name, args, userId, agentId) {
  let toolResult = '';
  try {
    for await (const chunk of executeToolStreaming(name, args, userId, agentId)) {
      if (chunk.type === 'token')  toolResult += chunk.text;
      if (chunk.type === 'result') toolResult = chunk.text;
    }
  } catch (e) {
    console.error('[tool error parallel]', name, e.stack || e.message);
    toolResult = `Tool error: ${e.message}`;
  }
  return normalizeToolResult(toolResult).text;
}

// Drain a tool to completion while buffering UI-relevant events (permission_request,
// nested tool_call, tool_result). Used by the parallel tool-dispatch path so mixed
// tool types can run concurrently without losing events the sequential path would
// have yielded mid-stream. Events are replayed in order after the tool completes.
export async function drainToolWithEvents(name, args, userId, agentId) {
  const events = [];
  let toolResult = '';
  try {
    for await (const chunk of executeToolStreaming(name, args, userId, agentId)) {
      if (chunk.type === 'token')              toolResult += chunk.text;
      if (chunk.type === 'permission_request') events.push(chunk);
      if (chunk.type === 'tool_call')          events.push({ type: 'tool_call', name: chunk.name, args: chunk.args });
      if (chunk.type === 'tool_result')        events.push({ type: 'tool_result', name: chunk.name, text: chunk.text, preview: summarizeToolResult(chunk.name, chunk.text) });
      if (chunk.type === 'result')             toolResult = chunk.text;
    }
  } catch (e) {
    console.error('[tool error parallel]', name, e.stack || e.message);
    toolResult = `Tool error: ${e.message}`;
  }
  const norm = normalizeToolResult(toolResult);
  return { text: norm.text, _notify: norm._notify, events };
}
