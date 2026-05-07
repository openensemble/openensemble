/**
 * Render a node's activity.jsonl into a human-readable ACTIVITY.md.
 *
 * The JSONL is the source of truth (machine-readable, append-only, kept
 * forever). The MD is a derived, idempotent rendering — re-run anytime, the
 * file is rewritten from scratch each time.
 *
 * Auto-rendering after every write is the dispatcher's job (TODO); this
 * module just exposes the pure rendering function.
 */

import fs from 'fs';
import path from 'path';
import {
  readOpRecords,
  getRollbackStatus,
  nodeDir,
  isPinned,
} from './op-record.mjs';

const RISK_BADGE = {
  low:    'low',
  medium: 'med',
  high:   'HIGH',
};

const OUTCOME_BADGE = {
  success:     'OK',
  failure:     'FAIL',
  partial:     'PARTIAL',
  rolled_back: 'rolled-back',
  aborted:     'aborted',
};

function activityMdPath(userId, nodeId) {
  return path.join(nodeDir(userId, nodeId), 'ACTIVITY.md');
}

function fmtTime(iso) {
  // 2026-05-06T14:23:09.142Z → "2026-05-06 14:23:09 UTC"
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function fmtParams(params) {
  if (!params || typeof params !== 'object') return '';
  const entries = Object.entries(params);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
}

// Markdown-table escape: pipe and newline are the painful chars.
function tcell(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function rollbackCell(userId, nodeId, rec) {
  if (rec.rolls_back_op_id) {
    return `→ rollback of \`${rec.rolls_back_op_id}\``;
  }
  const status = getRollbackStatus(userId, nodeId, rec.id);
  if (!status.exists) return '';
  if (status.invoked) {
    return status.invocation_outcome === 'success'
      ? `rolled back at ${fmtTime(status.invoked_at)}`
      : `rollback attempted (${status.invocation_outcome})`;
  }
  if (status.expired) return 'snapshot expired';
  if (!status.available) return rec.rollback?.method === 'manual' ? 'manual only' : 'unavailable';
  const pinned = isPinned(userId, nodeId, rec.id) ? ' (pinned)' : '';
  return `available${pinned}`;
}

function summaryStats(records) {
  const counts = { total: records.length, success: 0, failure: 0, partial: 0, rolled_back: 0, aborted: 0 };
  for (const r of records) {
    if (counts[r.outcome] != null) counts[r.outcome]++;
  }
  return counts;
}

/**
 * Render the activity log for a single node.
 * Returns the rendered markdown string and writes it to ACTIVITY.md.
 *
 * @param {string} userId
 * @param {string} nodeId
 * @param {object} [opts]
 * @param {number} [opts.limit] cap rows shown in the table (most-recent kept)
 * @param {boolean} [opts.write=true] write to disk; pass false to render-only
 */
export function renderActivity(userId, nodeId, opts = {}) {
  const { limit, write = true } = opts;
  const records = readOpRecords(userId, nodeId);
  const summary = summaryStats(records);

  const head = [
    `# Activity — ${nodeId}`,
    '',
    `_Last rendered: ${fmtTime(new Date().toISOString())}_  `,
    `_Source: \`activity.jsonl\` (${records.length} record${records.length === 1 ? '' : 's'})_`,
    '',
    `**Summary:** ${summary.total} total · ${summary.success} ok · ${summary.failure} failed` +
      (summary.rolled_back ? ` · ${summary.rolled_back} rolled-back-marker` : '') +
      (summary.partial ? ` · ${summary.partial} partial` : '') +
      (summary.aborted ? ` · ${summary.aborted} aborted` : ''),
    '',
  ];

  // Most-recent first in the table.
  const ordered = records.slice().reverse();
  const rows = (typeof limit === 'number' && limit > 0) ? ordered.slice(0, limit) : ordered;

  const tableHead = [
    '| When | Service | Operation | Intent | Outcome | Risk | Rollback | Op ID |',
    '|------|---------|-----------|--------|---------|------|----------|-------|',
  ];
  const tableRows = rows.map(r => {
    const opCall = r.operation.id + (r.operation.parameters && Object.keys(r.operation.parameters).length
      ? `(${fmtParams(r.operation.parameters)})`
      : '');
    return '| ' + [
      fmtTime(r.ts),
      tcell(r.service_id || ''),
      tcell(opCall),
      tcell(r.intent.user_text || ''),
      OUTCOME_BADGE[r.outcome] || r.outcome,
      RISK_BADGE[r.operation.risk_class] || r.operation.risk_class,
      tcell(rollbackCell(userId, nodeId, r)),
      `\`${r.id}\``,
    ].join(' | ') + ' |';
  });

  const md = [
    ...head,
    ...(rows.length ? [...tableHead, ...tableRows] : ['_No operations yet._']),
    '',
  ].join('\n');

  if (write) {
    const p = activityMdPath(userId, nodeId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, md, 'utf8');
  }
  return md;
}

export { activityMdPath };
