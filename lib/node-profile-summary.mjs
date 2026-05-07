/**
 * Compact per-node rollup of profile state for the nodes drawer.
 * Aggregates from the service-profile store + watcher supervisor + incident
 * log into one summary array, one entry per saved profile on the node.
 *
 * Returned shape (per profile):
 *   {
 *     service_id, detected_version, trust_state,
 *     ops_total, ops_verified,
 *     signals_total, signals_healthy, signals_unhealthy, signals_unknown,
 *     watcher_active,                 // is a profile_health watcher running?
 *     open_incidents,                 // count of incidents not yet closed
 *     overall: 'healthy' | 'unhealthy' | 'monitoring' | 'unverified',
 *   }
 *
 * `overall` is derived for convenient UI dot-coloring:
 *   - 'unverified'  → trust_state = 'unverified' (no monitoring expected)
 *   - 'unhealthy'   → at least one signal in unhealthy state
 *   - 'monitoring'  → reviewed/proven but signals haven't all checked yet
 *                     (or watcher inactive, or all signals unknown)
 *   - 'healthy'     → all signals healthy
 */

import { listProfilesForNode } from './service-profile.mjs';
import { listWatchers } from '../scheduler/watchers.mjs';
import { listIncidents } from './incident.mjs';

export function getNodeProfilesSummary(userId, nodeId, hostname = null) {
  if (!userId || !nodeId) return [];

  // Profiles may have been saved against either the canonical nodeId or the
  // hostname (LLM tools take hostnames straight from node_list). Try both,
  // de-duped by service_id, so the rollup picks them up either way.
  let profiles = listProfilesForNode(userId, nodeId);
  if (hostname && hostname !== nodeId) {
    const fromHost = listProfilesForNode(userId, hostname);
    if (fromHost.length) {
      const seen = new Set(profiles.map(p => p.service_id));
      for (const p of fromHost) if (!seen.has(p.service_id)) profiles.push(p);
    }
  }
  if (!profiles.length) return [];

  const watchers = listWatchers(userId).active.filter(
    w => w.kind === 'profile_health' && (w.state?.node_id === nodeId || (hostname && w.state?.node_id === hostname)),
  );
  // Index watchers by service_id so the per-profile lookup is O(1) — list of
  // services per node is small (usually 1-5) but the filter+find combo is
  // tidier as a Map.
  const watcherBySvc = new Map();
  for (const w of watchers) {
    if (w.state?.service_id) watcherBySvc.set(w.state.service_id, w);
  }

  // Open-incidents: cheap to enumerate per-node — the file is small. Count
  // how many incidents tag each service. Check under both ids since the same
  // hostname/nodeId drift applies to incident storage.
  const openIncByService = new Map();
  const collectIncidents = (key) => {
    try {
      for (const inc of listIncidents(userId, key, { openOnly: true })) {
        const k = inc.service_id || '';
        openIncByService.set(k, (openIncByService.get(k) || 0) + 1);
      }
    } catch { /* incidents are best-effort */ }
  };
  collectIncidents(nodeId);
  if (hostname && hostname !== nodeId) collectIncidents(hostname);

  return profiles.map(p => buildEntry(p, watcherBySvc.get(p.service_id), openIncByService.get(p.service_id) || 0));
}

function buildEntry(profile, watcher, openIncidents) {
  const ops = Array.isArray(profile.operations) ? profile.operations : [];
  const ops_total = ops.length;
  const ops_verified = ops.filter(o => o.verified).length;

  // Pull signal states from the live watcher if present. If the watcher
  // hasn't been registered (unverified profile, or supervisor failed to
  // reload), fall back to the profile's declared signal count with all-unknown
  // states so the UI still shows what's expected.
  const sigStates = watcher?.state?.signals?.map(s => s.last_state) ?? [];
  const declaredSigs = Array.isArray(profile.health_signals) ? profile.health_signals.length : 0;
  const signals_total = sigStates.length || declaredSigs;
  const signals_healthy = sigStates.filter(s => s === 'healthy').length;
  const signals_unhealthy = sigStates.filter(s => s === 'unhealthy').length;
  const signals_unknown = signals_total - signals_healthy - signals_unhealthy;
  const watcher_active = !!watcher;

  let overall;
  if (profile.trust_state === 'unverified') overall = 'unverified';
  else if (signals_unhealthy > 0)           overall = 'unhealthy';
  else if (signals_total === 0)             overall = 'monitoring'; // no signals declared
  else if (signals_healthy === signals_total) overall = 'healthy';
  else                                      overall = 'monitoring';

  return {
    service_id:        profile.service_id,
    detected_version:  profile.detected_version || null,
    trust_state:       profile.trust_state,
    ops_total,
    ops_verified,
    signals_total,
    signals_healthy,
    signals_unhealthy,
    signals_unknown,
    watcher_active,
    open_incidents:    openIncidents,
    overall,
  };
}
