// @ts-check

const REPLAY_MUTATION_TOOL_RE = /(?:^|_)(?:accept|add|apply|approve|archive|assign|call|cancel|clear|close|commit|compose|configure|confirm|create|delete|deploy|disable|download|edit|enable|execute|forget|grant|install|label|launch|lock|manage|mark|move|open|pair|patch|publish|purge|reject|remember|remove|rename|reply|reset|resolve|restart|restore|revert|revoke|rollback|run|save|schedule|send|set|share|sort|spawn|start|stop|submit|switch|sync|toggle|trash|turn|uninstall|unlock|update|upload|write)(?:_|$)/i;
const REPLAY_READ_TOOL_RE = /(?:^|_)(?:check|count|describe|detect|fetch|find|get|inspect|list|lookup|now|preview|query|read|recall|scan|search|show|snapshot|stats|status|view)(?:_|$)/i;

/**
 * Decide whether admitting a tool call should invalidate completed read
 * results in the current turn. Manifest metadata wins; recognizable read
 * verbs stay in the current state epoch. Unknown tools fail safe as mutations
 * so an uncommon action such as revert_audit_entry cannot leave stale reads
 * reusable merely because its verb was absent from a finite allowlist.
 */
export function toolCallAdvancesReplayEpoch(toolDef, name, args = null) {
  if (toolDef?.replayPolicy === 'turn'
      || toolDef?.replayPolicy === 'mutation'
      || toolDef?.destructive === true
      || args?.follow_up === true) {
    return true;
  }
  if (toolDef?.readOnly === true || toolDef?.parallelSafeRead === true) {
    return false;
  }
  if (REPLAY_MUTATION_TOOL_RE.test(String(name || ''))) return true;
  if (REPLAY_READ_TOOL_RE.test(String(name || ''))) return false;
  return true;
}
