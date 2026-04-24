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

  return null; // unknown tool
}

export default executeSkillTool;
