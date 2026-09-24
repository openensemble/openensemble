// Only an explicit request detaches node_exec immediately. Ordinary commands
// use the dispatcher's elapsed-time boundary: mentioning rsync in a process
// check or log filename does not make a command long-running, and timeout is
// a maximum duration, not an estimate. Existing task owners await real output.
import { currentTaskContext } from '../../lib/task-proxy-context.mjs';
import { getTurnContext } from '../../lib/turn-abort-context.mjs';
import { getScheduledContext } from '../../lib/scheduled-context.mjs';

export function shouldDetachNodeExec({ background } = {}) {
  return background === true
    && currentTaskContext() == null
    // Scheduled runs deliberately use the generic auto-background child
    // barrier. A skill-owned detached chip is invisible to that barrier and
    // could let the schedule finalize before the remote command exits.
    && getScheduledContext()?.originTaskId == null
    && getTurnContext()?.awaitSlowTools !== true
    && getTurnContext()?.suppressLearning !== true;
}
