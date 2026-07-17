// node_exec has its own eager task-chip path for command shapes that are
// predictably long. That path is useful only when the call is foreground-owned;
// an existing worker/delegation/request owner must await the command so its
// model can inspect the real output before taking dependent steps.
import { currentTaskContext } from '../../lib/task-proxy-context.mjs';
import { getTurnContext } from '../../lib/turn-abort-context.mjs';
import { getScheduledContext } from '../../lib/scheduled-context.mjs';

const LONG_COMMAND_RE = /\b(apt|apt-get|dnf|yum)\s+(install|upgrade|update|dist-upgrade|full-upgrade|autoremove)\b|\b(npm|pip|pip3|cargo|gem|composer|brew)\s+(install|upgrade|update)\b|\b(make|cmake|cargo\s+build|go\s+build|mvn|gradle)\b|\b(docker)\s+(pull|build|run|compose)\b|\bcurl\s.+\|\s*(sudo\s+)?(sh|bash)\b|\b(git\s+clone|wget|rsync)\b|\bsystemctl\s+(restart|reload)\b|\b(snap|flatpak)\s+(install|update|refresh)\b/i;

export function shouldDetachNodeExec({ background, command = '', timeout = 60 } = {}) {
  const requested = typeof background === 'boolean'
    ? background
    : (LONG_COMMAND_RE.test(String(command || '')) || Number(timeout) > 60);
  return requested
    && currentTaskContext() == null
    // Scheduled runs deliberately use the generic auto-background child
    // barrier. A skill-owned detached chip is invisible to that barrier and
    // could let the schedule finalize before the remote command exits.
    && getScheduledContext()?.originTaskId == null
    && getTurnContext()?.awaitSlowTools !== true;
}
