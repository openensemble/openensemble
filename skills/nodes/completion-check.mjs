// A command can exit while the work it launched is still running (for
// example, a SMART self-test). Keep that work owned by the normal node task
// until a read-only completion command supplies its actual result.
export const NODE_JOB_PENDING = 75;

export function startsSmartTest(command) {
  return /\bsmartctl(?:\.exe)?\s+[^\n;|&]*?(?:-t\s*|--test(?:=|\s+))(?:short|long|conveyance|offline|select)\b/i.test(String(command || ''));
}

export function parseCompletionCheck(value, command) {
  if (value == null) {
    if (startsSmartTest(command)) {
      throw new Error('SMART tests keep running after smartctl exits. Nothing was started. Retry node_exec with completion_check: {command, interval_seconds, timeout_seconds}. The check must only read the status and latest self-test results for the exact drives being tested, exit 75 while ANY test is still running, exit 0 with ALL final results, and exit another code on failure. OpenEnsemble creates the completion watcher automatically; do not launch the tests separately.');
    }
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)
      || typeof value.command !== 'string' || !value.command.trim()) {
    throw new Error('completion_check.command must be a non-empty read-only status command. Nothing was started.');
  }
  if (startsSmartTest(value.command)) {
    throw new Error('completion_check must read SMART status/results, never start or restart a test. Nothing was started.');
  }
  const interval = value.interval_seconds ?? 15;
  const timeout = value.timeout_seconds ?? 600;
  if (!Number.isInteger(interval) || interval < 5 || interval > 300
      || !Number.isInteger(timeout) || timeout < interval || timeout > 86400) {
    throw new Error('completion_check requires interval_seconds from 5 to 300 and timeout_seconds from interval_seconds to 86400 (integers). Nothing was started.');
  }
  return { command: value.command.trim(), intervalSeconds: interval, timeoutSeconds: timeout };
}

export async function waitForNodeCompletion(check, runCheck, onProgress) {
  const deadline = Date.now() + check.timeoutSeconds * 1000;
  let lastOutput = '';
  while (Date.now() < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const result = await runCheck(check.command, Math.min(60, remainingSeconds));
    if (result.exitCode !== NODE_JOB_PENDING) return result;
    lastOutput = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-2000);
    onProgress(`Job still running; checking again in ${check.intervalSeconds}s.${lastOutput ? `\n${lastOutput}` : ''}\n`);
    const remaining = deadline - Date.now();
    const finalWait = remaining <= check.intervalSeconds * 1000;
    const delay = Math.min(check.intervalSeconds * 1000, remaining);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    // Timers can wake just before their requested deadline. Do not issue an
    // extra remote check with a fresh timeout at the end of the wait budget.
    if (finalWait) break;
  }
  throw new Error(`Completion check timed out after ${check.timeoutSeconds}s. The node job may still be running; its final outcome is unknown. Do not restart it automatically.${lastOutput ? `\nLast status:\n${lastOutput}` : ''}`);
}
