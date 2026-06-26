import { loadIncident } from './incident.mjs';

export function profileHealthSignalDetails(userId, watcher) {
  if (watcher?.kind !== 'profile_health') return null;
  const nodeId = watcher.state?.node_id;
  const signals = Array.isArray(watcher.state?.signals) ? watcher.state.signals : [];
  return signals.map(sig => {
    let incident = null;
    if (nodeId && sig.current_incident_id) {
      try {
        const inc = loadIncident(userId, nodeId, sig.current_incident_id);
        if (inc) {
          incident = {
            id: inc.id,
            status: inc.status,
            service_id: inc.service_id || null,
            ts_opened: inc.ts_opened,
            ts_closed: inc.ts_closed || null,
            triggering_signal: inc.triggering_signal || null,
            diagnostics_collected: Array.isArray(inc.diagnostics_collected) ? inc.diagnostics_collected.slice(-5) : [],
            fix_attempts: Array.isArray(inc.fix_attempts) ? inc.fix_attempts.slice(-5) : [],
            events: Array.isArray(inc.events) ? inc.events.slice(-5) : [],
            resolution_summary: inc.resolution_summary || null,
          };
        }
      } catch { /* incident detail is advisory */ }
    }
    return {
      kind: sig.kind,
      severity: sig.severity || null,
      last_state: sig.last_state || 'unknown',
      last_checked_at: sig.last_checked_at || null,
      current_incident_id: sig.current_incident_id || null,
      check: sig.check || null,
      expect: sig.expect || null,
      last_output: sig.last_output ?? null,
      last_error: sig.last_error ?? null,
      incident,
    };
  });
}

export function profileHealthWatcherDetail(userId, watcher) {
  return {
    id: watcher.id,
    kind: watcher.kind,
    label: watcher.label,
    status: watcher.status,
    service_id: watcher.state?.service_id || null,
    node_id: watcher.state?.node_id || null,
    cadenceSec: watcher.cadenceSec,
    lastStatusText: watcher.lastStatusText || null,
    lastTickAt: watcher.lastTickAt || null,
    lastChangeAt: watcher.lastChangeAt || null,
    ticks: watcher.ticks || 0,
    failures: watcher.failures || 0,
    profileHealth: profileHealthSignalDetails(userId, watcher),
  };
}
