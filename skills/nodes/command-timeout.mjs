// New agents report job liveness independently of stdout. Older agents need
// a finite execution limit until upgraded to the tracking protocol.
export const NODE_EXEC_TRACKING_CAPABILITY = 'exec-progress-v1';
export const LEGACY_NODE_EXEC_TIMEOUT_SECONDS = 86400;
export const MAX_NODE_EXEC_TIMEOUT_SECONDS = 86400;
export const NODE_EXEC_STATUS_TIMEOUT_MS = 90_000;

// The node gives a timed-out process five seconds to exit before killing its
// process tree. Allow that result, plus network transit, to reach the server.
export const NODE_EXEC_RESULT_GRACE_SECONDS = 10;

export function supportsNodeExecTracking(node) {
  return node?.capabilities?.includes(NODE_EXEC_TRACKING_CAPABILITY) === true;
}

export function parseNodeExecTimeout(value, node) {
  if (value === undefined) return supportsNodeExecTracking(node) ? 0 : LEGACY_NODE_EXEC_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_NODE_EXEC_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be an integer from 0 to ${MAX_NODE_EXEC_TIMEOUT_SECONDS} seconds. Nothing was started.`);
  }
  if (value === 0 && !supportsNodeExecTracking(node)) {
    throw new Error('Update this node agent to enable commands without an execution deadline. Nothing was started.');
  }
  return value;
}
