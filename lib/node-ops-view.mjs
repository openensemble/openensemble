import { listWatchers } from '../scheduler/watchers.mjs';
import { listProfilesForNode, loadProfile } from './service-profile.mjs';
import { listIncidents, loadIncident } from './incident.mjs';
import { getNodeProfilesSummary } from './node-profile-summary.mjs';
import { profileHealthWatcherDetail } from './watcher-health-details.mjs';

const CLOSED = new Set(['resolved', 'abandoned']);

function tsMs(ts) {
  const n = Date.parse(ts || '');
  return Number.isFinite(n) ? n : 0;
}

function openIncidents(userId, nodeId) {
  return listIncidents(userId, nodeId, { openOnly: true });
}

function allIncidents(userId, nodeId) {
  return listIncidents(userId, nodeId).slice(0, 20);
}

function uniqueProfiles(userId, nodeId, hostname) {
  const out = [];
  const seen = new Set();
  for (const key of [nodeId, hostname].filter(Boolean)) {
    for (const p of listProfilesForNode(userId, key)) {
      if (seen.has(p.service_id)) continue;
      seen.add(p.service_id);
      out.push(p);
    }
  }
  return out;
}

function healthWatchers(userId, nodeId, hostname) {
  return (listWatchers(userId).active || [])
    .filter(w => w.kind === 'profile_health' && (w.state?.node_id === nodeId || w.state?.node_id === hostname));
}

function latestFixProposal(incident) {
  return [...(incident.events || [])].reverse().find(e => e.type === 'fix_proposed')?.payload || null;
}

function timelineForIncident(incident) {
  const rows = [];
  const add = (ts, kind, title, detail = '', data = {}) => rows.push({ ts, kind, title, detail, data });
  add(incident.ts_opened, 'opened', 'Incident opened', `${incident.service_id || 'service'} signal "${incident.triggering_signal?.kind || 'unknown'}" failed.`, {
    observed: incident.triggering_signal?.value ?? null,
    expected: incident.triggering_signal?.expected ?? null,
  });
  for (const d of incident.diagnostics_collected || []) {
    add(d.ts, 'diagnostic', 'Diagnostic ran', d.output_excerpt || d.interpretation || d.op_id || '', d);
  }
  for (const e of incident.events || []) {
    if (e.type === 'failure_mode_matched') {
      add(e.ts, 'matched', 'Failure mode matched', e.payload?.mode_id || '', e.payload || {});
    } else if (e.type === 'fix_proposed') {
      add(e.ts, 'proposed', 'Fix proposed', `${e.payload?.op_id || 'operation'} (${e.payload?.risk || 'risk unknown'})`, e.payload || {});
    } else if (e.type === 'status_changed') {
      add(e.ts, 'status', 'Status changed', `${e.payload?.from || '?'} -> ${e.payload?.to || '?'}`, e.payload || {});
    } else if (e.type === 'closed') {
      add(e.ts, 'closed', 'Incident closed', e.payload?.summary || e.payload?.final_status || '', e.payload || {});
    }
  }
  for (const f of incident.fix_attempts || []) {
    add(f.ts, f.outcome === 'success' ? 'fixed' : 'fix_failed', f.outcome === 'success' ? 'Fix applied' : 'Fix failed', f.message || f.op_id_in_profile || '', f);
  }
  rows.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  return rows;
}

function incidentSummary(incident) {
  const sig = incident.triggering_signal || {};
  const proposed = latestFixProposal(incident);
  const lastFix = [...(incident.fix_attempts || [])].reverse()[0] || null;
  let action = 'Investigate';
  let summary = `${incident.service_id || 'Service'} signal "${sig.kind || 'unknown'}" is ${CLOSED.has(incident.status) ? 'closed' : 'open'}.`;
  if (incident.status === 'fix_applied' || lastFix?.outcome === 'success') {
    action = 'Verify recovery';
    summary = `OE applied ${lastFix?.op_id_in_profile || 'a fix'}; waiting for health verification.`;
  } else if (incident.status === 'fix_proposed' && proposed) {
    action = 'Approve fix';
    summary = `OE proposed ${proposed.op_id} (${proposed.risk || 'risk unknown'}).`;
  } else if ((incident.diagnostics_collected || []).length > 0) {
    action = 'Review diagnostics';
    summary = `OE ran ${incident.diagnostics_collected.length} diagnostic step(s).`;
  }
  return { action, summary, proposed_fix: proposed };
}

function buildQualityGates({ node, profiles, summaries, watchers, incidents }) {
  const gates = [];
  const add = (status, label, detail, severity = 'info') => gates.push({ status, label, detail, severity });
  if (node.health === 'disconnected') add('fail', 'Node offline', 'The agent is not connected, so OE cannot diagnose or fix it.', 'critical');
  else if (node.health === 'stale') add('warn', 'Node not responding', 'The agent has missed recent heartbeats.', 'warn');
  else add('pass', 'Node reachable', 'The node agent is connected.');

  if (node.outdated) add('warn', 'Agent update available', `Current ${node.version || 'unknown'}, latest ${node.latestVersion || 'unknown'}.`, 'warn');
  else add('pass', 'Agent current', 'The node agent version is current.');

  if (!profiles.length) {
    add('warn', 'Monitoring incomplete', 'No service profiles are approved for this node yet.', 'warn');
    return gates;
  }
  const host = profiles.find(p => p.service_id === 'system');
  if (!host) add('warn', 'Host health missing', 'Approve Host health so OE can monitor disk, memory, load, and agent status.', 'warn');

  for (const p of profiles) {
    const label = p.service_id === 'system' ? 'Host health' : p.service_id;
    const summary = summaries.find(s => s.service_id === p.service_id);
    if (p.trust_state === 'unverified') add('warn', `${label} is Draft`, 'Monitoring and auto-fix are off until approved.', 'warn');
    if ((p.health_signals || []).some(s => s.expect === undefined && s.check?.expect === undefined)) {
      add('warn', `${label} has loose checks`, 'One or more signals rely only on command success.', 'info');
    }
    if (summary && p.trust_state !== 'unverified' && !summary.watcher_active && (p.health_signals || []).length) {
      add('fail', `${label} watcher inactive`, 'Approved profile has health signals but no active watcher.', 'critical');
    }
    const ops = p.operations || [];
    const writeOps = ops.filter(o => !o.readonly);
    if (writeOps.length && writeOps.some(o => !o.verified)) {
      const unverified = writeOps.filter(o => !o.verified).length;
      add(
        'warn',
        `${label} Auto-fix actions need verification`,
        `${unverified}/${writeOps.length} write action${writeOps.length === 1 ? '' : 's'} still need verification. Monitoring remains onboarded; those actions will be proposed instead of auto-running.`,
        'warn',
      );
    }
  }
  if (incidents.length) add('fail', 'Open incident', `${incidents.length} open incident${incidents.length === 1 ? '' : 's'} need attention.`, 'critical');
  if (!watchers.length) add('warn', 'No active health watchers', 'Approve at least one profile to start continuous checks.', 'warn');
  return gates;
}

function buildActionItems({ node, summaries, profiles, incidents }) {
  const items = [];
  const add = (kind, severity, title, detail, action = null, data = {}) => items.push({ kind, severity, title, detail, action, data });
  if (node.health === 'disconnected') add('offline', 'critical', `${node.hostname} is offline`, 'OE cannot run diagnostics until the node reconnects.', 'Investigate', { nodeId: node.nodeId });
  if (node.health === 'stale') add('stale', 'warn', `${node.hostname} is not responding`, 'The node missed recent heartbeats.', 'Investigate', { nodeId: node.nodeId });
  // Only surface the "outdated / Upgrade" item when the node is actually
  // reachable. While it's offline or not-responding — including the brief
  // window right after clicking Upgrade, when the agent restarts — the
  // offline/stale item above already covers it, and an upgrade can't be pushed
  // to a disconnected node anyway. Suppressing it here avoids stacking a
  // second, misleading item on top of the offline one.
  const reachable = node.health !== 'disconnected' && node.health !== 'stale';
  if (node.outdated && reachable) {
    if (node.secureUpdates === false) {
      // Legacy agent (pre-2.0.0) can't verify signed updates, so it can't be
      // auto-upgraded over the network — the item must direct the user to
      // re-run the installer on the device, not offer a one-click "Upgrade"
      // that the server will only refuse. The client renders the right button
      // off data.secureUpdates.
      add('outdated', 'warn', `${node.hostname}: enable secure updates`,
        `Agent ${node.version || 'unknown'} can't verify signed updates. Re-run the installer on this device to upgrade to ${node.latestVersion || 'the latest version'} and enable verified auto-updates.`,
        'Enable secure updates', { nodeId: node.nodeId, secureUpdates: false });
    } else {
      add('outdated', 'warn', `${node.hostname} agent is outdated`,
        `Current ${node.version || 'unknown'}, latest ${node.latestVersion || 'unknown'}.`,
        'Upgrade agent', { nodeId: node.nodeId, secureUpdates: true });
    }
  }
  for (const inc of incidents) {
    const s = incidentSummary(inc);
    add(
      inc.status === 'fix_proposed' ? 'fix_proposed' : 'incident',
      inc.status === 'fix_proposed' ? 'warn' : 'critical',
      `${inc.service_id || 'Service'} incident: ${inc.triggering_signal?.kind || inc.id}`,
      s.summary,
      s.action,
      { nodeId: node.nodeId, incidentId: inc.id, serviceId: inc.service_id, proposed_fix: s.proposed_fix },
    );
  }
  for (const p of profiles) {
    if (p.trust_state === 'unverified') {
      add('profile_draft', 'info', `${p.service_id} profile needs approval`, 'Approve monitoring after read-only verification passes.', 'Approve', { nodeId: node.nodeId, serviceId: p.service_id });
    }
  }
  for (const s of summaries) {
    if (s.signals_unhealthy) {
      add('signal_unhealthy', 'critical', `${s.service_id} has failing checks`, `${s.signals_unhealthy}/${s.signals_total} health signals failing.`, 'Health', { nodeId: node.nodeId, serviceId: s.service_id });
    }
  }
  return items;
}

function reliability({ node, summaries, gates, incidents }) {
  let score = 100;
  if (node.health === 'disconnected') score -= 45;
  else if (node.health === 'stale') score -= 25;
  if (node.outdated) score -= 8;
  score -= Math.min(35, incidents.length * 15);
  for (const s of summaries) {
    score -= s.signals_unhealthy * 12;
    score -= s.signals_unknown * 3;
    if (s.trust_state === 'unverified') score -= 5;
    if (!s.watcher_active && s.signals_total) score -= 8;
  }
  score = Math.max(0, Math.min(100, score));
  const hasCritical = gates.some(g => g.status === 'fail');
  const label = hasCritical || score < 60 ? 'Failing' : score < 80 ? 'Degraded' : score < 95 ? 'Good' : 'Excellent';
  return { score, label };
}

function eventLog({ node, profiles, watchers, incidents }) {
  const rows = [];
  const add = (ts, kind, title, detail = '') => rows.push({ ts, kind, title, detail });
  add(new Date(node.lastHeartbeat || Date.now()).toISOString(), 'node', node.health || 'unknown', `Node ${node.hostname || node.nodeId}`);
  for (const p of profiles) add(p.updated_at || p.created_at || new Date().toISOString(), 'profile', `${p.service_id} profile ${p.trust_state}`, `${(p.health_signals || []).length} signal(s), ${(p.operations || []).length} op(s)`);
  for (const w of watchers) add(new Date(w.lastTickAt || w.createdAt || Date.now()).toISOString(), 'watcher', `${w.state?.service_id || w.kind} watcher`, w.lastStatusText || 'active');
  for (const inc of incidents) {
    add(inc.ts_opened, 'incident', `${inc.service_id || 'service'} incident opened`, inc.triggering_signal?.kind || inc.id);
    if (inc.ts_closed) add(inc.ts_closed, 'incident', `${inc.service_id || 'service'} incident closed`, inc.resolution_summary || inc.status);
  }
  rows.sort((a, b) => tsMs(b.ts) - tsMs(a.ts));
  return rows.slice(0, 20);
}

export function buildNodeOpsView(userId, node) {
  const profiles = uniqueProfiles(userId, node.nodeId, node.hostname);
  const summaries = getNodeProfilesSummary(userId, node.nodeId, node.hostname);
  const watchers = healthWatchers(userId, node.nodeId, node.hostname);
  const open = openIncidents(userId, node.nodeId);
  const incidents = allIncidents(userId, node.nodeId);
  const detailedWatchers = watchers.map(w => profileHealthWatcherDetail(userId, w));
  const gates = buildQualityGates({ node, profiles, summaries, watchers, incidents: open });
  const actions = buildActionItems({ node, summaries, profiles, incidents: open });
  const rel = reliability({ node, summaries, gates, incidents: open });
  return {
    nodeId: node.nodeId,
    hostname: node.hostname,
    reliability: rel,
    actionItems: actions,
    qualityGates: gates,
    profiles: summaries,
    watchers: detailedWatchers,
    incidents: incidents.map(inc => ({
      id: inc.id,
      status: inc.status,
      service_id: inc.service_id,
      ts_opened: inc.ts_opened,
      ts_closed: inc.ts_closed,
      triggering_signal: inc.triggering_signal,
      diagnostics_collected: inc.diagnostics_collected || [],
      fix_attempts: inc.fix_attempts || [],
      resolution_summary: inc.resolution_summary || null,
      summary: incidentSummary(inc),
      timeline: timelineForIncident(inc),
    })),
    eventLog: eventLog({ node, profiles, watchers, incidents }),
  };
}

export function getIncidentProposedFix(userId, nodeId, incidentId) {
  const inc = loadIncident(userId, nodeId, incidentId);
  if (!inc) return null;
  const fix = latestFixProposal(inc);
  if (!fix?.op_id) return null;
  const profile = loadProfile(userId, nodeId, inc.service_id);
  if (!profile) return null;
  return { incident: inc, profile, fix };
}
