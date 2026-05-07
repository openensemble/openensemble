/**
 * Wrap the node-registry sendCommand into the simple
 *   async (command, opts?) → {stdout, stderr, exitCode}
 * shape that diagnostic-runner and the cli mechanism expect.
 *
 * Why a wrapper: keeps lib/* free of skills/* imports, lets tests inject a
 * mock execFn, and centralizes timeout + error handling for remote shell
 * execution.
 */

const DEFAULT_TIMEOUT_SEC = 60;

export function makeNodeExecFn(userId, nodeId) {
  return async function execFn(command, opts = {}) {
    if (!command) throw new Error('execFn: command required');
    // Lazy-import so this module stays cheap to load and tests that mock the
    // wrapper don't transitively pull in the WS-bound node registry.
    const { sendCommand } = await import('../skills/nodes/node-registry.mjs');
    const timeout = Math.max(1, Math.min(300, opts.timeout ?? DEFAULT_TIMEOUT_SEC));
    try {
      const res = await sendCommand(nodeId, userId, { type: 'exec', command, timeout });
      return {
        stdout: res?.stdout ?? '',
        stderr: res?.stderr ?? '',
        exitCode: typeof res?.exitCode === 'number' ? res.exitCode : 1,
      };
    } catch (e) {
      // Surface as a non-zero exit so callers don't have to try/catch every
      // call site separately. The stderr carries the message.
      return { stdout: '', stderr: e.message || String(e), exitCode: 1 };
    }
  };
}
