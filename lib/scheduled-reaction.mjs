/**
 * Build and validate the hidden model turn that consumes newly completed
 * scheduled-task children. Kept separate from scheduler.mjs so the terminal
 * contract and incremental/cumulative prompt boundary are directly testable.
 */

export function buildScheduledReactionPrompt({ task, aggregate, cumulativeAggregate = aggregate } = {}) {
  return [
    'Background work from your scheduled task has completed. Act on the results below for THIS scheduled task only.',
    '',
    `<scheduled_task id="${task?.id || ''}" agent="${task?.agent || ''}">`,
    `<original_request>${task?.prompt || ''}</original_request>`,
    `<new_results>\n${aggregate || ''}\n</new_results>`,
    `<all_results_context>\n${cumulativeAggregate || aggregate || ''}\n</all_results_context>`,
    '</scheduled_task>',
    '',
    'No human is present. Act only on NEW_RESULTS that still require a next step. ALL_RESULTS_CONTEXT is read-only context for resolving document ids, artifacts, or dependencies from earlier rounds; do not repeat an action merely because its prior result appears there. If the task is already complete, give a concise completion summary. Do not act on any unrelated task.',
    'Do NOT create, schedule, re-schedule, or modify any task, reminder, or alarm — this is the existing task running; it must never spawn another one.',
  ].join('\n');
}

export function createScheduledReactionTerminalCapture(forward = () => {}) {
  let terminal = null;
  let terminalMessage = '';
  return {
    onEvent(event) {
      if (event?.type === 'error' || event?.type === 'stopped') {
        terminal = event.type;
        terminalMessage = String(event.message || event.text || `${event.type} terminal`);
      } else if (event?.type === 'done' && terminal == null) {
        terminal = 'done';
      }
      forward(event);
    },
    assertSucceeded() {
      if (terminal !== 'done') {
        throw new Error(terminalMessage || 'scheduled continuation ended without a successful terminal event');
      }
      return true;
    },
    snapshot() { return { terminal, terminalMessage }; },
  };
}
