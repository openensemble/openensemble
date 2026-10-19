// Account-owned limits and durable continuation; no model can authorize these.
let runBudgetDialog = null;
let runBudgetView = 0;

function resetRunBudgets() {
  runBudgetView++;
  runBudgetDialog?.close(); runBudgetDialog?.remove(); runBudgetDialog = null;
}

async function openRunBudgets({ projectId = null, runId = null } = {}) {
  resetRunBudgets();
  const view = runBudgetView;
  const owner = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  const current = () => view === runBudgetView && owner === (typeof _currentUser !== 'undefined' ? _currentUser?.id : null);
  const dialog = document.createElement('dialog');
  dialog.className = 'job-recovery-dialog run-budgets-dialog'; dialog.setAttribute('aria-label', 'Run budgets');
  runBudgetDialog = dialog;
  const style = document.createElement('style');
  style.textContent = '.run-budgets-dialog{width:min(700px,92vw);max-height:88vh;overflow:auto}.run-budgets-dialog fieldset{margin:16px 0;padding:12px;border:1px solid var(--border);border-radius:8px}.run-budgets-dialog label{display:block;margin:8px 0}.run-budgets-dialog input[type=number],.run-budgets-dialog select,.run-budgets-dialog textarea{display:block;width:100%;box-sizing:border-box;padding:7px;margin:5px 0;min-height:40px;background:var(--bg-panel,#171a21);color:var(--text,#e8eaf0);border:1px solid var(--border,#414751);border-radius:6px;font:inherit}.run-budgets-dialog button{margin:5px 8px 5px 0}.run-budgets-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere}.run-budgets-dialog .budget-help{color:var(--muted);font-size:13px}.run-budgets-dialog [role=alert]{color:var(--danger,#f88)}';
  const node = (tag, text, parent = dialog) => { const item = document.createElement(tag); if (text != null) item.textContent = text; parent.append(item); return item; };
  const title = node('h2', 'Run budgets');
  title.id = 'runBudgetsTitle'; dialog.setAttribute('aria-labelledby', title.id);
  node('p', 'Limit the combined model usage of a task, its delegates and retries. Blank limits are unlimited.');
  node('p', 'USD figures are estimates, not a billing guarantee. Provider rates may differ; images, hosted tools and other services can have extra charges. Unknown pricing requires a token-only limit.').className = 'budget-help';
  const close = node('button', 'Close'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  const message = node('p', 'Loading…'); message.setAttribute('role', 'status');
  const content = node('div');
  dialog.prepend(style); document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => { if (runBudgetDialog === dialog) resetRunBudgets(); }, { once: true });
  const api = async (suffix, method = 'GET', body) => {
    const response = await fetch(`/api/run-budgets/${suffix}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update this budget.');
    if (!current()) throw new Error('The account or budget view changed.');
    return data;
  };
  const field = (parent, label, value = null, step = '1') => {
    const wrapper = node('label', label, parent), input = node('input', null, wrapper);
    input.type = 'number'; input.min = '0'; input.step = step; input.placeholder = 'Unlimited'; input.value = value == null ? '' : value;
    return input;
  };
  const limits = (parent, value = {}, prefix = '') => {
    const tokens = field(parent, `${prefix}Tokens`, value.tokens), usd = field(parent, `${prefix}Estimated USD`, value.usd, '0.000001');
    return () => ({ tokens: tokens.value === '' ? null : Number(tokens.value), usd: usd.value === '' ? null : Number(usd.value) });
  };
  const button = (parent, text, action) => {
    const item = node('button', text, parent); item.type = 'button';
    item.addEventListener('click', async () => {
      item.disabled = true; message.textContent = ''; message.setAttribute('role', 'status');
      try { await action(); }
      catch (error) { if (current()) { message.textContent = error.message; message.setAttribute('role', 'alert'); } }
      finally { if (current()) item.disabled = false; }
    });
    return item;
  };
  const reload = next => openRunBudgets({ projectId, runId: next || runId });
  try {
    const [settings, listed] = await Promise.all([api('settings'), api('runs')]);
    if (!current()) return;
    message.textContent = '';
    const defaults = node('fieldset', null, content); node('legend', 'Default for each new run', defaults);
    const defaultValue = limits(defaults, settings.defaults);
    button(defaults, 'Save account defaults', async () => { await api('settings', 'PATCH', { revision: settings.revision, defaults: defaultValue() }); await reload(); });

    if (!projectId && runId) projectId = listed.runs.find(run => run.id === runId)?.projectId || null;
    if (!projectId && typeof activeProjectSpaceId !== 'undefined') projectId = activeProjectSpaceId || null;
    if (!projectId && typeof selectedProjectSpace !== 'undefined') projectId = selectedProjectSpace?.id || null;
    if (projectId) {
      const project = await api(`projects/${encodeURIComponent(projectId)}`);
      if (!current()) return;
      const section = node('fieldset', null, content); node('legend', 'This project', section);
      node('p', `Cumulative model usage: ${project.usage.tokens.toLocaleString()} tokens · $${project.usage.estimatedUsd.toFixed(4)} estimated.`, section);
      const cap = limits(section, project.limits, 'Project total — ');
      const inheritLabel = node('label', null, section), inherit = node('input', null, inheritLabel); inherit.type = 'checkbox'; inherit.checked = project.runLimits == null;
      inheritLabel.append(document.createTextNode(' Use account defaults for new runs'));
      const perRun = node('div', null, section), perRunValue = limits(perRun, project.runLimits || settings.defaults, 'Each new run — ');
      perRun.hidden = inherit.checked; inherit.addEventListener('change', () => { perRun.hidden = inherit.checked; });
      button(section, 'Save project limits', async () => { await api(`projects/${encodeURIComponent(projectId)}`, 'PATCH', { revision: project.revision, limits: cap(), runLimits: inherit.checked ? null : perRunValue() }); await reload(); });
    }

    const estimate = node('fieldset', null, content); node('legend', 'Estimate before starting', estimate);
    const agentLabel = node('label', 'Agent', estimate), agentSelect = node('select', null, agentLabel);
    for (const agent of (typeof agents !== 'undefined' ? agents : [])) { const option = node('option', agent.name || agent.id, agentSelect); option.value = agent.id; }
    if (typeof activeAgent !== 'undefined') agentSelect.value = activeAgent;
    const promptLabel = node('label', 'Task to estimate', estimate), prompt = node('textarea', null, promptLabel); prompt.rows = 3; prompt.maxLength = 64000; prompt.value = document.getElementById('input')?.value || '';
    const estimateText = node('p', '', estimate); estimateText.setAttribute('role', 'status');
    button(estimate, 'Estimate first request', async () => {
      const result = await api('estimate', 'POST', { agentId: agentSelect.value, text: prompt.value });
      estimateText.textContent = `Estimate: ${result.tokens.toLocaleString()} tokens including output allowance. ${result.estimatedUsd == null ? 'USD pricing unavailable.' : `$${result.estimatedUsd.toFixed(4)} estimated.`} ${result.outputCapSupported ? '' : 'This endpoint cannot enforce an output cap and will pause when limits are configured. '} ${result.note}`;
    });

    const runs = node('fieldset', null, content); node('legend', 'Recent budgeted runs', runs);
    if (!listed.runs.length) node('p', 'No budgeted runs yet. Limits apply to new work after you save them.', runs);
    for (const run of listed.runs.slice(0, 40)) button(runs, `${run.status === 'paused' ? 'Paused · ' : ''}${run.title || run.id}`, () => reload(run.id));
    if (runId) {
      const run = await api(`runs/${encodeURIComponent(runId)}`);
      if (!current()) return;
      const section = node('fieldset', null, content); node('legend', run.title || 'Selected run', section);
      button(section, 'Refresh progress', () => reload());
      node('p', `${run.status}: ${run.reason || 'Usage includes the main agent, delegates and retries.'}`, section);
      node('p', `${run.usage.tokens.toLocaleString()} accounted tokens; ${run.reserved.tokens.toLocaleString()} reserved. $${run.usage.estimatedUsd.toFixed(4)} estimated${run.usage.unpricedTokens ? '; some usage has unknown pricing' : ''}${run.usage.uncertainRequests ? '; includes accepted estimates for unknown usage' : ''}.`, section);
      if (run.reserved.requests && ['paused', 'cancelled', 'error'].includes(run.status)) {
        const label = node('label', null, section), accepted = node('input', null, label); accepted.type = 'checkbox';
        label.append(document.createTextNode(' Accept the full reserved estimate for requests with unknown usage'));
        button(section, 'Account for reserved estimate', async () => {
          await api(`runs/${encodeURIComponent(runId)}/settle`, 'POST', { revision: run.revision, acceptUncertainUsage: accepted.checked }); await reload();
        });
        node('p', 'This records usage without restarting any work. Stopped work remains stopped.', section).className = 'budget-help';
      }
      for (const span of run.spans) {
        const row = node('div', null, section);
        node('p', `${span.status} · ${span.title || span.agentId}${span.taskId ? ` · Job ${span.taskId}` : ''}`, row);
        if (span.taskId && ['running', 'ready', 'paused'].includes(span.status) || span.status === 'paused') {
          button(row, 'Stop this work', async () => { await api(`runs/${encodeURIComponent(runId)}/stop`, 'POST', { spanId: span.id }); await reload(); });
        }
      }
      const value = limits(section, run.limits);
      button(section, 'Save this run’s limits', async () => { await api(`runs/${encodeURIComponent(runId)}`, 'PATCH', { revision: run.revision, limits: value() }); await reload(); });
      if (run.status === 'paused') {
        const workLabel = node('label', 'Work to continue', section), work = node('select', null, workLabel);
        for (const span of run.spans.filter(span => span.status === 'paused')) { const option = node('option', span.title || span.agentId, work); option.value = span.id; }
        const extra = limits(section, {}, 'Additional run allowance — ');
        const projectExtra = run.projectId ? limits(section, {}, 'Additional project allowance — ') : () => ({});
        const unknownLabel = node('label', null, section), unknown = node('input', null, unknownLabel); unknown.type = 'checkbox';
        unknownLabel.append(document.createTextNode(' Count unknown requests at their full reserved estimate')); unknownLabel.hidden = !run.reserved.requests;
        const removeLabel = node('label', null, section), remove = node('input', null, removeLabel); remove.type = 'checkbox';
        removeLabel.append(document.createTextNode(' Explicitly continue without this run’s limits (project limits still apply)'));
        const review = node('div', null, section); let reviews = [];
        const showReviews = () => {
          review.replaceChildren(); reviews = [];
          for (const action of run.spans.find(span => span.id === work.value)?.uncertain || []) {
            const box = node('fieldset', null, review); node('legend', `Review interrupted action: ${action.name}`, box); node('pre', JSON.stringify(action.args, null, 2), box);
            const label = node('label', 'After checking its outcome', box), choice = node('select', null, label);
            for (const [id, text] of [['', 'Choose an outcome'], ['completed', 'It completed; use my result'], ['retry', 'I checked; authorize it to run again']]) { const option = node('option', text, choice); option.value = id; }
            const resultLabel = node('label', 'Observed result', box), result = node('textarea', null, resultLabel); result.maxLength = 12000;
            resultLabel.hidden = true; choice.addEventListener('change', () => { resultLabel.hidden = choice.value !== 'completed'; });
            reviews.push({ action, choice, result });
          }
        };
        work.addEventListener('change', showReviews); showReviews();
        button(section, 'Authorize and continue selected work', async () => {
          await api(`runs/${encodeURIComponent(runId)}/authorize`, 'POST', { revision: run.revision, spanId: work.value, additional: extra(), projectAdditional: projectExtra(),
            removeLimits: remove.checked, acceptUncertainUsage: unknown.checked,
            resolutions: reviews.map(item => ({ spanId: work.value, id: item.action.id, outcome: item.choice.value, result: item.result.value })) });
          await reload();
        });
      }
      for (const span of run.spans.filter(item => item.output)) { const details = node('details', null, section); node('summary', `${span.status} · ${span.title || span.agentId}`, details); node('pre', span.output, details); }
    }
  } catch (error) { if (current()) { message.textContent = error.message; message.setAttribute('role', 'alert'); } }
}
