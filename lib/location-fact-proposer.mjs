/**
 * Location-fact proposer — turn "I probed a dead path, then found it elsewhere"
 * into a host-scoped memory fact.
 *
 * Pattern this catches:
 *   user: "where's the windows pxe boot tree on pxeserver?"
 *   sydney: node_exec → `find /var/lib/tftpboot ...` → STDERR "No such file or directory"
 *   sydney: node_exec → `ls /srv/tftp` → non-empty listing
 *
 * The agent learned the canonical location on this specific host. Stash it as
 * a deferred candidate; next turn (if not a correction) propose pinning
 * "On <host>, the path for <topic> is /srv/tftp (not /var/lib/tftpboot)" to
 * shared user_facts with host_scope set.
 *
 * Detection is heuristic-only (no LLM call) — same shape as the other
 * proposers. False positives are cheap (user dismisses the bubble); false
 * negatives just mean the agent re-probes next time.
 */
import { proposeLocationFact } from './proposals.mjs';

const RATE_LIMIT_MS = 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 30 * 60 * 1000;
const _lastProposedPerUser = new Map();
const _pendingCandidates = new Map(); // userId+agentId -> { candidate, createdAt }

const CORRECTION_RE = /\b(?:wrong|incorrect|not (?:what|right|correct|like that|that)|that'?s? (?:not|wrong)|don'?t (?:do|need|want)|undo|redo|i (?:said|wanted|meant)|you didn'?t|you missed)\b/i;

// "find: '/var/lib/tftpboot': No such file or directory"
// "ls: cannot access '/etc/foo': No such file or directory"
// "stat: cannot statx '/var/log/bar': No such file or directory"
const FAILED_PATH_RE = /(?:^|\n)\s*(?:find|ls|cat|stat|head|tail|grep|cd|tree):?\s+(?:cannot (?:access|stat\w*) )?['"`]?(\/[A-Za-z0-9._\-/]+)['"`]?:\s*No such file or directory/g;

// A successful absolute-path probe: command contains an absolute path AND
// stdout is non-trivial. We capture the path from the COMMAND, not from
// stdout — stdout is too variable to parse generically. Look for the first
// absolute-path token in the command string.
const ABS_PATH_IN_COMMAND_RE = /(?<![/\w])(\/(?:etc|srv|var|opt|usr|home|root|tmp|mnt|media|run)\/[A-Za-z0-9._\-/]+)/;

function key(userId, agentId) { return `${userId}::${agentId}`; }

export function _resetForTests() {
  _lastProposedPerUser.clear();
  _pendingCandidates.clear();
}

// Exposed for unit tests — keeps the integration test surface (which would
// otherwise need a live node registry + cortex) separate from heuristic
// regression coverage.
export function _findPairingForTests(toolsUsed) {
  return findPairing(toolsUsed);
}

// Extract the absolute paths that a node_exec command failed to find.
function extractFailedPaths(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  FAILED_PATH_RE.lastIndex = 0;
  while ((m = FAILED_PATH_RE.exec(text)) !== null) found.add(m[1]);
  return [...found];
}

// Extract the first absolute path from a node_exec command string. We only
// trust paths under well-known service-config roots so a hallucinated path or
// a shell expression like `$(pwd)/x` doesn't get treated as a "discovery".
function extractCommandPath(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(ABS_PATH_IN_COMMAND_RE);
  return m ? m[1] : null;
}

// Crude "this stdout looks like real content" check. Avoids treating empty
// echo-fenced output ("--- foo ---\n--- bar ---") as a discovery. We accept
// anything with at least one non-fence line that isn't just whitespace.
function hasRealContent(resultText) {
  if (!resultText) return false;
  // Strip the STDERR section and the trailing "Exit code: ..." line — those
  // are node_exec's wrapper, not the actual stdout we care about.
  const body = resultText.split(/\n\s*STDERR:/)[0]
    .replace(/\n\s*Exit code:.*$/m, '')
    .trim();
  if (!body) return false;
  // Reject if every non-blank line is a section fence ("--- foo ---").
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const nonFence = lines.filter(l => !/^---\s.*\s---$/.test(l));
  return nonFence.length > 0;
}

function nodeExecCalls(toolsUsed) {
  return (toolsUsed || []).filter(t => t?.name === 'node_exec');
}

// Walk the turn's node_exec calls and pair (failed_path, found_path) when:
//   1. an earlier call failed on /some/path with "No such file or directory"
//   2. a later call ran against a different absolute path AND produced
//      non-empty stdout content
//   3. both calls targeted the same node_id (host)
// Returns the first such pairing or null.
function findPairing(toolsUsed) {
  const calls = nodeExecCalls(toolsUsed);
  if (calls.length < 2) return null;

  // First pass: collect failed paths per call (with node_id + index).
  const failures = [];
  for (let i = 0; i < calls.length; i++) {
    const t = calls[i];
    const paths = extractFailedPaths(t.text || '');
    if (paths.length === 0) continue;
    const nodeId = t.args?.node_id;
    if (!nodeId) continue;
    failures.push({ index: i, nodeId, paths });
  }
  if (failures.length === 0) return null;

  // Second pass: find a later success against a DIFFERENT path on the same node.
  for (const fail of failures) {
    for (let j = fail.index + 1; j < calls.length; j++) {
      const t = calls[j];
      if (t.args?.node_id !== fail.nodeId) continue;
      const cmdPath = extractCommandPath(t.args?.command);
      if (!cmdPath) continue;
      if (fail.paths.some(p => cmdPath === p || cmdPath.startsWith(p + '/') || p.startsWith(cmdPath + '/'))) continue;
      if (!hasRealContent(t.text)) continue;
      return {
        nodeId: fail.nodeId,
        failedPath: fail.paths[0],
        foundPath: cmdPath,
      };
    }
  }
  return null;
}

// Resolve nodeId → hostname via the node registry. Lazy import to avoid
// pulling the registry into modules that don't need it.
async function resolveHostname(nodeId, userId) {
  try {
    const { getNode } = await import('../skills/nodes/node-registry.mjs');
    const node = getNode(nodeId, userId);
    return node?.hostname || null;
  } catch { return null; }
}

export async function maybeProposeLocationFact({ userId, agentId, agentName, userMessage, toolsUsed }) {
  if (!userId || !agentId || !Array.isArray(toolsUsed)) return null;

  const last = _lastProposedPerUser.get(userId);
  if (last && (Date.now() - last) < RATE_LIMIT_MS) return null;

  const pairing = findPairing(toolsUsed);
  if (!pairing) return null;

  const hostname = await resolveHostname(pairing.nodeId, userId);
  if (!hostname) return null;

  const userExcerpt = (userMessage || '').slice(0, 140).replace(/\s+/g, ' ').trim();

  _pendingCandidates.set(key(userId, agentId), {
    candidate: {
      userId, agentId,
      agentName: agentName ?? '',
      hostname,
      failedPath: pairing.failedPath,
      foundPath: pairing.foundPath,
      userTrigger: userExcerpt,
    },
    createdAt: Date.now(),
  });
  return { stashed: true, hostname, foundPath: pairing.foundPath };
}

export async function flushPendingLocationFact({ userId, agentId, currentUserMessage }) {
  const k = key(userId, agentId);
  const stash = _pendingCandidates.get(k);
  if (!stash) return null;
  _pendingCandidates.delete(k);

  if (Date.now() - stash.createdAt > CANDIDATE_TTL_MS) return { dropped: 'ttl' };
  if (CORRECTION_RE.test(currentUserMessage || '')) return { dropped: 'correction' };

  const last = _lastProposedPerUser.get(userId);
  if (last && (Date.now() - last) < RATE_LIMIT_MS) return { dropped: 'ratelimited' };

  const proposed = await proposeLocationFact(stash.candidate);
  if (proposed) _lastProposedPerUser.set(userId, Date.now());
  return proposed;
}
