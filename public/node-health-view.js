// Shared renderer for node health details in Tasks and Nodes drawers.
(function () {
  function h(s) {
    return typeof escHtml === 'function' ? escHtml(String(s ?? '')) : String(s ?? '');
  }

  function formatExpect(expect) {
    if (!expect || typeof expect !== 'object') return 'no expectation recorded';
    const [op, val] = Object.entries(expect)[0] || [];
    if (!op) return JSON.stringify(expect);
    const words = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '=', neq: '!=', contains: 'contains', matches: 'matches' };
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
        <div class="node-health-line">Observed: <code>${h(observedValue(sig))}</code>; expected: <code>${h(formatExpect(sig.expect))}</code></div>
        <div class="node-health-line">Last checked: ${h(formatCheckedAt(sig.last_checked_at))}</div>
        ${incident ? `<div class="node-health-line">Incident: <code>${h(incident.id)}</code> (${h(incident.status)}) opened ${h(new Date(incident.ts_opened).toLocaleString())}</div>` : ''}
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
        ${signals.map(renderSignal).join('') || '<div class="node-health-muted">No health signals recorded for this watcher.</div>'}
      </div>`;
  }

  function renderNodeHealthWatchers(watchers, opts = {}) {
    const arr = Array.isArray(watchers) ? watchers : [];
    if (!arr.length) return `<div class="node-health-empty">${h(opts.empty || 'No active health watchers for this node.')}</div>`;
    return `<div class="node-health-list">${arr.map(renderWatcher).join('')}</div>`;
  }

  window.OENodeHealthView = { renderNodeHealthWatchers };
})();
