/**
 * Logs skill — lets admin agents read and summarize server logs.
 *
 * Tools:
 *   read_logs({file, tail, level, q, since})
 *   scan_for_concerns({since, maxGroups})
 *
 * Admin/owner only. Children and regular users get a polite refusal.
 */

import { readLog, listLogFiles } from '../../logger.mjs';
import { getUser } from '../../routes/_helpers.mjs';
import { listTurnTrees, getTurnDetail } from '../../lib/turn-trace-reader.mjs';

function isAdmin(userId) {
  const u = getUser(userId);
  return u?.role === 'owner' || u?.role === 'admin';
}

function formatEntry(e) {
  const ts = e.ts ? new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19) : '----';
  const lvl = (e.level || 'info').toUpperCase().padEnd(5);
  const tag = `[${e.tag || ''}]`;
  const meta = e.meta ? ' ' + JSON.stringify(e.meta) : '';
  return `${ts} ${lvl} ${tag} ${e.msg || ''}${meta}`;
}

export async function executeSkillTool(name, args, userId) {
  if (args?.__validate) return '';
  if (!isAdmin(userId)) return 'Reading server logs requires admin or owner privileges.';

  if (name === 'read_logs') {
    const { file = 'app', tail = 100, level, q, since } = args || {};
    const opts = { file, tail: Math.min(Math.max(1, tail || 100), 500) };
    if (level) opts.level = level;
    if (q)     opts.q = q;
    if (since) opts.since = since;
    const { entries, totalBytes } = readLog(opts);
    if (!entries.length) return `No matching entries in ${file}.log. File size: ${totalBytes} bytes.`;
    const header = `${entries.length} entries from ${file}.log (file size ${totalBytes} bytes):`;
    return [header, ...entries.map(formatEntry)].join('\n');
  }

  if (name === 'scan_for_concerns') {
    const maxGroups = Math.min(Math.max(1, args?.maxGroups ?? 15), 50);
    const since = args?.since ?? (Date.now() - 24 * 60 * 60 * 1000);

    // Pull a large tail from the app log and filter to warn/error in JS.
    // This gives us a single consistent view without reading both files twice.
    const { entries } = readLog({ file: 'app', tail: 5000, since });
    const concerning = entries.filter(e => e.level === 'warn' || e.level === 'error');

    if (!concerning.length) {
      const files = listLogFiles();
      const sizes = files.map(f => `${f.name}=${f.size}B`).join(', ');
      return `No warnings or errors found since ${new Date(typeof since === 'number' ? since : Date.parse(since)).toISOString()}. Log files: ${sizes}.`;
    }

    // Group by (tag + msg) — normalize noisy numeric IDs so similar events cluster.
    const groups = new Map();
    for (const e of concerning) {
      const normMsg = String(e.msg || '').replace(/\b\d{5,}\b/g, '#').replace(/[0-9a-f]{16,}/gi, '<id>');
      const key = `${e.level}|${e.tag}|${normMsg}`;
      const g = groups.get(key) ?? { level: e.level, tag: e.tag, msg: normMsg, count: 0, firstTs: e.ts, lastTs: e.ts, sample: e };
      g.count++;
      if (e.ts && (!g.firstTs || e.ts < g.firstTs)) g.firstTs = e.ts;
      if (e.ts && (!g.lastTs  || e.ts > g.lastTs))  g.lastTs  = e.ts;
      groups.set(key, g);
    }

    const sorted = [...groups.values()]
      .sort((a, b) => (a.level === b.level ? b.count - a.count : (a.level === 'error' ? -1 : 1)))
      .slice(0, maxGroups);

    const errCount  = concerning.filter(e => e.level === 'error').length;
    const warnCount = concerning.length - errCount;

    const lines = [
      `Log scan since ${new Date(typeof since === 'number' ? since : Date.parse(since)).toISOString()}:`,
      `  ${errCount} error(s), ${warnCount} warning(s) across ${groups.size} distinct event group(s).`,
      '',
      'Top issues:',
    ];
    for (const g of sorted) {
      const span = (g.firstTs && g.lastTs && g.firstTs !== g.lastTs)
        ? `${new Date(g.firstTs).toISOString().slice(11, 19)} → ${new Date(g.lastTs).toISOString().slice(11, 19)}`
        : (g.lastTs ? new Date(g.lastTs).toISOString().slice(11, 19) : '?');
      lines.push(`  [${g.level.toUpperCase()}] (${g.tag}) ×${g.count}  ${span}  — ${g.msg}`);
    }
    return lines.join('\n');
  }

  if (name === 'read_turns') {
    const tail = Math.min(Math.max(1000, args?.tail ?? 4000), 20000);
    const id = (args?.turnId || args?.rootId || '').trim();

    if (id) {
      const detail = getTurnDetail(id, { tail, join: true });
      if (!detail) return `No turn ${id} found in the last ${tail} log lines. Try a larger tail or list recent turns with no id.`;
      return formatTurnDetail(detail);
    }

    const limit = Math.min(Math.max(1, args?.limit ?? 25), 200);
    const trees = listTurnTrees({ tail, userId: args?.userId || null, limit });
    if (!trees.length) return `No turn traces in the last ${tail} log lines.`;
    const lines = [`${trees.length} recent turn(s), newest first:`];
    for (const t of trees) {
      lines.push(formatTreeRow(t));
    }
    lines.push('', 'Pass a turnId to expand one turn end-to-end (spans, delegations, joined telemetry).');
    return lines.join('\n');
  }

  return null; // unknown tool
}

function fmtTok(n) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtTs(ts) {
  return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '----';
}

function formatTreeRow(t) {
  // Show the FULL id (incl. t_ prefix) — it's the exact value to pass back to
  // read_turns for expansion. Stripping the prefix made the model echo a
  // prefix-less id that the detail lookup couldn't match.
  const id = t.rootId || '';
  const route = [t.source, t.routing?.mode].filter(Boolean).join('/') || '?';
  const agents = t.agents.join(', ') || '(no LLM span)';
  const calls = t.toolCalls.length ? `calls=${[...new Set(t.toolCalls)].join(',')}` : 'calls=none';
  const deleg = t.delegations.length ? `  deleg=${t.delegations.join('; ')}` : '';
  const errs = t.errorCount ? `  ERR×${t.errorCount}` : '';
  const turns = t.turnCount > 1 ? ` (${t.turnCount} turns)` : '';
  return `${fmtTs(t.startedAt)}  ${id}  [${route}]  ${agents}${turns}  spans=${t.spanCount}  ${calls}  tok=${fmtTok(t.inTok)}/${fmtTok(t.outTok)}  ${fmtMs(t.durationMs)}${deleg}${errs}`;
}

function formatTurnDetail(detail) {
  const out = [];
  const head = detail.turns[0] || {};
  out.push(`Turn tree ${detail.rootId} (matched by ${detail.matched}) — user=${detail.userId || '?'}, source=${head.source || '?'}, routing=${JSON.stringify(head.routing || {})}`);

  for (const t of detail.turns) {
    out.push('');
    const srcTag = t.source && t.source !== 'web' ? `  [${t.source}]` : '';
    out.push(`▸ ${t.turnId}  depth=${t.depth}${srcTag}  ${fmtTs(t.startedAt)}  ${fmtMs(t.durationMs)}`);
    if (!t.spans?.length) out.push('    (no agent span — fast-path / handled before LLM)');
    for (const s of (t.spans || [])) {
      const calls = (s.toolCalls || []).map(c => `${c.name}(${c.ok ? 'ok' : 'fail'}${c.ms != null ? `,${fmtMs(c.ms)}` : ''}${c.delegated ? ',deleg' : ''})`).join(', ') || 'none';
      out.push(`    ${s.agent} · ${s.provider || '?'}/${s.model || '?'} · tools=${(s.tools || []).length} · tok=${fmtTok(s.inTok)}/${fmtTok(s.outTok)} · ${fmtMs(s.ms)}${s.error ? ` · ERROR: ${s.error}` : ''}`);
      out.push(`        calls: ${calls}`);
    }
    for (const d of (t.delegations || [])) {
      out.push(`    delegation: ${d.from} → ${d.to}${d.background ? ' (background)' : ''}${d.ms != null ? `  ${fmtMs(d.ms)}` : ''}  "${d.directive || ''}"`);
    }
    for (const e of (t.errors || [])) out.push(`    error: ${e}`);
  }

  const j = detail.joined;
  if (j) {
    out.push('');
    out.push('Joined telemetry (same turnId):');
    out.push(`  tool invocations: ${j.invocations.length}${j.invocations.length ? ' — ' + j.invocations.map(i => i.toolName + (i.skillId ? `(${i.skillId})` : '')).join(', ') : ''}`);
    out.push(`  router mistakes:  ${j.routerMistakes.length}${j.routerMistakes.length ? ' — ' + j.routerMistakes.map(m => `${m.prevAgent}→${m.correctedAgent}`).join(', ') : ''}`);
    out.push(`  corrections:      ${j.corrections.length}${j.corrections.length ? ' — ' + j.corrections.map(c => c.skillId || c.agentId).join(', ') : ''}`);
    if (j.joinError) out.push(`  (join error: ${j.joinError})`);
  }
  return out.join('\n');
}

export default executeSkillTool;
