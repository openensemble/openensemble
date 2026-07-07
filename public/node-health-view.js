// Shared renderer for node health details in Tasks and Nodes drawers.
(function () {
  function h(s) {
    return typeof escHtml === 'function' ? escHtml(String(s ?? '')) : String(s ?? '');
  }
  function args(v) {
    return JSON.stringify(v).replace(/'/g, "&#39;");
  }

  function formatExpect(sig) {
    const expect = sig.expect;
    if (expect == null) {
      const mech = sig.check?.mechanism;
      if (mech === 'cli' || mech === 'exec') return 'command succeeds';
      if (mech === 'http') return 'HTTP succeeds';
      return 'check succeeds';
    }
    if (typeof expect === 'string') return expect;
    if (typeof expect !== 'object') return String(expect);
    const [op, val] = Object.entries(expect)[0] || [];
    if (!op) return JSON.stringify(expect);
    const words = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '=', neq: '!=', contains: 'contains', matches: 'matches', exit_code: 'exit code =', status: 'HTTP status =' };
    return `${words[op] || op} ${val}`;
  }

  function formatCheckedAt(ms) {
    if (!ms) return 'never checked';
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? 'unknown time' : d.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function observedValue(sig) {
    const incVal = sig.incident?.triggering_signal?.value;
    if (incVal !== undefined && incVal !== null && incVal !== '') return incVal;
    if (sig.last_output !== undefined && sig.last_output !== null && sig.last_output !== '') return sig.last_output;
    if (sig.last_error) return `error: ${sig.last_error}`;
    if (sig.last_exit_code !== undefined && sig.last_exit_code !== null) return `exit ${sig.last_exit_code}`;
    if (sig.last_http_status !== undefined && sig.last_http_status !== null) return `HTTP ${sig.last_http_status}`;
    return 'not recorded';
  }

  function renderSignal(sig) {
    const bad = sig.last_state === 'unhealthy';
    const incident = sig.incident;
    const diagnostics = incident?.diagnostics_collected || [];
    const diagHtml = diagnostics.length
      ? diagnostics.map(d => `<div class="node-health-diag">${h(d.output_excerpt || d.interpretation || d.op_id || '(diagnostic recorded)')}</div>`).join('')
      : (bad ? '<div class="node-health-muted">No diagnostic recipe/output was recorded for this signal.</div>' : '');
    const event = incident?.events?.[incident.events.length - 1];
    const eventHtml = event
      ? `<div class="node-health-muted">Last event: ${h(event.type || 'event')} · ${h(event.ts || '')}</div>`
      : '';
    return `
      <div class="node-health-signal ${bad ? 'node-health-signal-bad' : 'node-health-signal-ok'}">
        <div class="node-health-signal-head">
          <strong>${bad ? '⚠' : '✓'} ${h(sig.kind)}</strong>
          <span>${h(sig.last_state || 'unknown')}</span>
        </div>
        <div class="node-health-line">Observed: <code>${h(observedValue(sig))}</code>; expected: <code>${h(formatExpect(sig))}</code></div>
        <div class="node-health-line">Last checked: ${h(formatCheckedAt(sig.last_checked_at))}</div>
        ${incident ? `<div class="node-health-line">Incident: <code>${h(incident.id)}</code> (${h(incident.status)}) opened ${h(new Date(incident.ts_opened).toLocaleString())}</div>` : ''}
        ${bad ? `<div class="node-health-actions"><button class="cdraw-btn" data-action="investigateNodeHealth" data-args='${args([sig.node_id || '', sig.service_id || '', sig.kind, sig.current_incident_id || incident?.id || null])}'><i data-lucide="search" style="width:11px;height:11px"></i> Investigate</button></div>` : ''}
        ${sig.check?.command ? `<details class="node-health-command"><summary>Check command</summary><pre>${h(sig.check.command)}</pre></details>` : ''}
        ${diagHtml}
        ${eventHtml}
      </div>`;
  }

  function renderWatcher(w) {
    const signals = Array.isArray(w.profileHealth) ? w.profileHealth : [];
    const failing = signals.filter(s => s.last_state === 'unhealthy').length;
    const service = w.service_id || w.state?.service_id || w.label || 'profile';
    const label = w.label || service;
    const summary = signals.length
      ? `${signals.length - failing}/${signals.length} ok${failing ? ` · ${failing} failing` : ''}`
      : 'no signals recorded';
    return `
      <div class="node-health-service">
        <div class="node-health-service-head">
          <div>
            <div class="node-health-service-title">${h(service === 'system' ? 'Host health' : service)}</div>
            <div class="node-health-muted">${h(label)} · ${h(summary)}</div>
          </div>
          <span class="cdraw-badge ${failing ? 'red' : 'green'}">${failing ? 'Failing' : 'OK'}</span>
        </div>
        ${signals.map(s => renderSignal({ ...s, node_id: w.node_id, service_id: service })).join('') || '<div class="node-health-muted">No health signals recorded for this watcher.</div>'}
      </div>`;
  }

  function renderNodeHealthWatchers(watchers, opts = {}) {
    const arr = Array.isArray(watchers) ? watchers : [];
    if (!arr.length) return `<div class="node-health-empty">${h(opts.empty || 'No active health watchers for this node.')}</div>`;
    return `<div class="node-health-list">${arr.map(renderWatcher).join('')}</div>`;
  }

  function severityClass(sev) {
    if (sev === 'critical') return 'node-health-critical';
    if (sev === 'warn') return 'node-health-warn';
    return 'node-health-info';
  }

  function renderActionItems(items) {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return '<div class="node-health-empty">No action required.</div>';
    return `<div class="node-action-list">${arr.map(item => `
      <div class="node-action-item ${severityClass(item.severity)}">
        <div>
          <div class="node-action-title">${h(item.title)}</div>
          <div class="node-health-muted">${h(item.detail)}</div>
        </div>
        ${renderActionButton(item)}
      </div>`).join('')}</div>`;
  }

  function renderActionButton(item) {
    const d = item.data || {};
    if (item.kind === 'fix_proposed' && d.incidentId) {
      return `<button class="cdraw-btn cdraw-btn-warning" data-action="applyNodeIncidentFix" data-args='${args([d.nodeId, d.incidentId])}'><i data-lucide="wrench" style="width:11px;height:11px"></i> Apply</button>`;
    }
    if (item.kind === 'outdated') {
      // Legacy agent (can't verify signed updates): don't offer a one-click
      // "Upgrade" that the server refuses — send the user to the re-provision
      // flow (re-run the installer on the device) instead.
      if (d.secureUpdates === false) {
        return `<button class="cdraw-btn cdraw-btn-warning" data-action="reprovisionNode" data-args='${args([d.nodeId])}'><i data-lucide="shield-alert" style="width:11px;height:11px"></i> Enable Secure Updates</button>`;
      }
      return `<button class="cdraw-btn" data-action="pushAgentUpdate" data-args='${args([d.nodeId])}'><i data-lucide="refresh-cw" style="width:11px;height:11px"></i> Upgrade</button>`;
    }
    if (item.kind === 'profile_draft') {
      return `<button class="cdraw-btn" data-action="approveNodeProfile" data-args='${args([d.nodeId, d.serviceId])}'><i data-lucide="check-circle-2" style="width:11px;height:11px"></i> Approve</button>`;
    }
    if (item.kind === 'signal_unhealthy') {
      return `<button class="cdraw-btn" data-action="openNodeHealth" data-args='${args([d.nodeId])}'><i data-lucide="heart-pulse" style="width:11px;height:11px"></i> Health</button>`;
    }
    return `<button class="cdraw-btn" data-action="investigateNodeHealth" data-args='${args([d.nodeId || '', d.serviceId || '', '', d.incidentId || null])}'><i data-lucide="search" style="width:11px;height:11px"></i> Investigate</button>`;
  }

  function renderQualityGates(gates) {
    const arr = Array.isArray(gates) ? gates : [];
    if (!arr.length) return '';
    return `<div class="node-quality-grid">${arr.map(g => `
      <div class="node-quality-gate node-quality-${h(g.status)}">
        <span>${g.status === 'pass' ? '✓' : g.status === 'fail' ? '!' : '•'}</span>
        <div><b>${h(g.label)}</b><div>${h(g.detail)}</div></div>
      </div>`).join('')}</div>`;
  }

  function renderTimelineItem(row) {
    return `<div class="node-timeline-item node-timeline-${h(row.kind)}">
      <div class="node-timeline-dot"></div>
      <div>
        <div class="node-timeline-head"><b>${h(row.title)}</b><span>${h(row.ts ? new Date(row.ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '')}</span></div>
        ${row.detail ? `<div class="node-health-muted">${h(row.detail)}</div>` : ''}
      </div>
    </div>`;
  }

  function renderIncidents(incidents) {
    const arr = Array.isArray(incidents) ? incidents : [];
    if (!arr.length) return '<div class="node-health-empty">No incidents recorded for this node.</div>';
    return arr.map(inc => `
      <div class="node-health-service">
        <div class="node-health-service-head">
          <div>
            <div class="node-health-service-title">${h(inc.service_id || 'Service')} · ${h(inc.triggering_signal?.kind || inc.id)}</div>
            <div class="node-health-muted">${h(inc.summary?.summary || inc.status)}</div>
          </div>
          <span class="cdraw-badge ${inc.status === 'resolved' ? 'green' : inc.status === 'fix_proposed' ? 'yellow' : 'red'}">${h(inc.status)}</span>
        </div>
        ${inc.summary?.proposed_fix ? `<div class="node-health-actions"><button class="cdraw-btn cdraw-btn-warning" data-action="applyNodeIncidentFix" data-args='${args([inc.node_id || '', inc.id])}'><i data-lucide="wrench" style="width:11px;height:11px"></i> Apply proposed fix</button></div>` : ''}
        <div class="node-timeline">${(inc.timeline || []).map(renderTimelineItem).join('')}</div>
      </div>`).join('');
  }

  function renderEventLog(events) {
    const arr = Array.isArray(events) ? events : [];
    if (!arr.length) return '<div class="node-health-empty">No node events recorded yet.</div>';
    return `<div class="node-event-log">${arr.map(e => `
      <div class="node-event-row">
        <span>${h(e.ts ? new Date(e.ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '')}</span>
        <b>${h(e.title)}</b>
        <div>${h(e.detail || '')}</div>
      </div>`).join('')}</div>`;
  }

  function renderNodeOpsView(data) {
    const rel = data?.reliability || { score: 0, label: 'Unknown' };
    return `
      <div class="node-ops-view">
        <div class="node-reliability">
          <div><b>${h(rel.label)}</b><span>${h(data?.hostname || data?.nodeId || 'node')}</span></div>
          <strong>${h(rel.score)}</strong>
        </div>
        <div class="node-health-section-title">Action required</div>
        ${renderActionItems(data?.actionItems)}
        <div class="node-health-section-title">Quality gates</div>
        ${renderQualityGates(data?.qualityGates)}
        <div class="node-health-section-title">Health signals</div>
        ${renderNodeHealthWatchers(data?.watchers || [])}
        <div class="node-health-section-title">Incident timeline</div>
        ${renderIncidents((data?.incidents || []).map(i => ({ ...i, node_id: data.nodeId })))}
        <div class="node-health-section-title">Node event log</div>
        ${renderEventLog(data?.eventLog)}
      </div>`;
  }

  window.OENodeHealthView = { renderNodeHealthWatchers, renderNodeOpsView, renderActionItems, renderQualityGates };
})();
