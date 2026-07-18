/**
 * Route handler for remote nodes.
 *
 * This file is the REST dispatcher (+ static asset endpoints). The bulk of the
 * logic lives in three submodules:
 *
 *   routes/nodes/pairing.mjs    — pairing code issue/redeem
 *   routes/nodes/websocket.mjs  — /ws/nodes — node agent WS server
 *   routes/nodes/terminal.mjs   — /ws/nodes/terminal + /nodes/terminal HTML
 *
 * `initNodeWss` / `initTerminalWss` are re-exported so server.mjs can keep
 * importing them from this file.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  removeNode, pushUpdate, pushUninstall, getNodes, getNode, setNodeAutoFix, setNodeOnboardingState,
  sendCommand, sendCommandStreaming,
} from '../skills/nodes/node-registry.mjs';
import { getUpdatePublicKeyPem } from '../lib/node-update-signing.mjs';
import { requireAuth, readBody, getUser, getSessionUserId, getAuthToken, clearUserNodeSessions } from './_helpers.mjs';
import { getLanAddress } from '../discovery.mjs';
import { getNodeProfilesSummary } from '../lib/node-profile-summary.mjs';
import { buildNodeOpsView, getIncidentProposedFix } from '../lib/node-ops-view.mjs';
import { ensureNodeSystemProfile } from '../lib/node-system-profile.mjs';
import { loadProfile, setTrustState } from '../lib/service-profile.mjs';
import { verifyProfileReadonly } from '../lib/capability-dispatcher.mjs';
import { makeNodeExecFn } from '../lib/node-exec-wrapper.mjs';
import { applyProposedFix } from '../lib/fix-proposer.mjs';
import { resolveTokenStorage } from '../lib/token-storage.mjs';
import { runNodeOnboarding, summarizeNodeSystemHealth } from '../lib/node-onboarding.mjs';
import {
  registerProfileHealthWatchers,
  unregisterProfileHealthWatchers,
} from '../scheduler/health-monitor.mjs';
import { handlePairingRoutes } from './nodes/pairing.mjs';
import { initNodeWss, getNodeWss } from './nodes/websocket.mjs';
import { initTerminalWss, getTerminalWss, handleTerminalPage, handleTerminalTicket } from './nodes/terminal.mjs';
import nodesSkill from '../skills/nodes/execute.mjs';

export { initNodeWss, getNodeWss, initTerminalWss, getTerminalWss };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_DIR = path.join(__dirname, '..', 'remote');

// ── Latest agent version (read from remote/oe-node-agent.mjs on demand) ─────
let _cachedAgentVersion = null;
let _cachedAgentMtime = 0;
function getLatestAgentVersion() {
  try {
    const agentPath = path.join(REMOTE_DIR, 'oe-node-agent.mjs');
    const stat = fs.statSync(agentPath);
    if (stat.mtimeMs === _cachedAgentMtime && _cachedAgentVersion) return _cachedAgentVersion;
    const src = fs.readFileSync(agentPath, 'utf8');
    const m = src.match(/const AGENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
    _cachedAgentVersion = m ? m[1] : 'unknown';
    _cachedAgentMtime = stat.mtimeMs;
    return _cachedAgentVersion;
  } catch {
    return 'unknown';
  }
}

// ── REST API for the web UI ──────────────────────────────────────────────────
export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Hard block: child accounts cannot touch any authenticated /api/nodes or
  // /nodes/terminal endpoint. The unauthenticated bootstrap endpoints
  // (/nodes/install.sh, /nodes/agent) are static script assets and fine.
  if ((p.startsWith('/api/nodes') || p === '/nodes/terminal')) {
    const callerId = getSessionUserId(getAuthToken(req));
    if (callerId && getUser(callerId)?.role === 'child') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not permitted for this account' }));
      return true;
    }
  }

  // GET /nodes/install.sh — bootstrap installer (unauthenticated)
  if (p === '/nodes/install.sh' && req.method === 'GET') {
    try {
      const scriptPath = path.join(REMOTE_DIR, 'install.sh');
      let script = fs.readFileSync(scriptPath, 'utf8');
      // Inject the server's own URL so the script knows where to fetch the agent.
      // If the incoming Host header is localhost (e.g. install.sh was fetched
      // by the user's browser on the same machine), swap in the LAN IP so the
      // remote node can reach it.
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const hostHeader = req.headers.host || 'localhost:3737';
      const isLocalhost = /^(localhost|127\.|0\.0\.0\.0)/.test(hostHeader.split(':')[0]);
      const port = hostHeader.split(':')[1] || '3737';
      const serverHost = isLocalhost ? `${getLanAddress()}:${port}` : hostHeader;
      const downloadUrl = `${proto}://${serverHost}`;
      script = `#!/usr/bin/env bash\nexport OE_DOWNLOAD_URL="${downloadUrl}"\n${script.replace(/^#!.*\n/, '')}`;
      res.writeHead(200, {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(script);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load install script');
    }
    return true;
  }

  // GET /nodes/agent-pubkey — Ed25519 public key the agent pins at install/pair
  // time to verify signed self-updates (unauthenticated, like /nodes/agent —
  // the key is public by design; only the server holds the private half).
  if (p === '/nodes/agent-pubkey' && req.method === 'GET') {
    try {
      const pem = getUpdatePublicKeyPem();
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Cache-Control': 'no-cache' });
      res.end(pem);
    } catch (e) {
      res.writeHead(500); res.end('update signing key unavailable');
    }
    return true;
  }

  // GET /nodes/agent — raw agent script (unauthenticated)
  if (p === '/nodes/agent' && req.method === 'GET') {
    try {
      const agentPath = path.join(REMOTE_DIR, 'oe-node-agent.mjs');
      const script = fs.readFileSync(agentPath);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(script);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load agent script');
    }
    return true;
  }

  // GET /nodes/terminal — popout xterm.js terminal page
  if (p === '/nodes/terminal' && req.method === 'GET') {
    return handleTerminalPage(req, res, url);
  }

  // POST /api/nodes/terminal-ticket — mint a single-use page ticket
  if (p === '/api/nodes/terminal-ticket' && req.method === 'POST') {
    return handleTerminalTicket(req, res);
  }

  // GET /api/nodes — list connected nodes
  if (p === '/api/nodes' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeList = getNodes(userId);
    const latestVersion = getLatestAgentVersion();
    // Annotate each node with whether it's outdated
    const annotated = nodeList.map(n => {
      const node = {
        ...n,
        latestVersion,
        outdated: n.version && n.version !== 'unknown' && n.version !== latestVersion,
        profiles: getNodeProfilesSummary(userId, n.nodeId, n.hostname),
      };
      const ops = buildNodeOpsView(userId, node);
      const systemHealth = summarizeNodeSystemHealth({
        node,
        profiles: node.profiles,
        onboarding: n.onboarding,
        autoFixEnabled: n.autoFixEnabled,
      });
      return {
        ...node,
        reliability: ops.reliability,
        actionItems: ops.actionItems,
        qualityGates: ops.qualityGates,
        eventLog: ops.eventLog,
        systemHealth,
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(annotated));
    return true;
  }

  // GET /api/nodes/latest-version — current server-side agent version
  if (p === '/api/nodes/latest-version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: getLatestAgentVersion() }));
    return true;
  }

  // GET /api/nodes/:nodeId/health — node-scoped profile health details.
  // This is the same source used by the Tasks drawer node-health grouping and
  // the Nodes drawer Health popout.
  const healthMatch = p.match(/^\/api\/nodes\/([^/]+)\/health$/);
  if (healthMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(healthMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    const latestVersion = getLatestAgentVersion();
    const annotatedNode = {
      ...node,
      latestVersion,
      outdated: node.version && node.version !== 'unknown' && node.version !== latestVersion,
    };
    const ops = buildNodeOpsView(userId, annotatedNode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      nodeId,
      hostname: node.hostname,
      health: node.health,
      profiles: ops.profiles,
      watchers: ops.watchers,
      reliability: ops.reliability,
      actionItems: ops.actionItems,
      qualityGates: ops.qualityGates,
      incidents: ops.incidents,
      eventLog: ops.eventLog,
    }));
    return true;
  }

  // GET /api/nodes/:nodeId/ops — complete node operations view.
  const opsMatch = p.match(/^\/api\/nodes\/([^/]+)\/ops$/);
  if (opsMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(opsMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    const latestVersion = getLatestAgentVersion();
    const annotatedNode = {
      ...node,
      latestVersion,
      outdated: node.version && node.version !== 'unknown' && node.version !== latestVersion,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildNodeOpsView(userId, annotatedNode)));
    return true;
  }

  // POST /api/nodes/:nodeId/incidents/:incidentId/apply-fix — approve a
  // fix_proposed incident and run the proposed operation through the normal
  // capability dispatcher.
  const applyFixMatch = p.match(/^\/api\/nodes\/([^/]+)\/incidents\/([^/]+)\/apply-fix$/);
  if (applyFixMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(applyFixMatch[1]);
    const incidentId = decodeURIComponent(applyFixMatch[2]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    const found = getIncidentProposedFix(userId, nodeId, incidentId);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No proposed fix found for this incident.' }));
      return true;
    }
    const storageRef = found.profile?.control_surface?.api?.token_storage;
    const auth = storageRef ? resolveTokenStorage(userId, storageRef) : null;
    try {
      const result = await applyProposedFix({
        userId,
        nodeId,
        incidentId,
        profile: found.profile,
        fix: { op_id: found.fix.op_id },
        ctx: {
          fetchFn: globalThis.fetch,
          execFn: makeNodeExecFn(userId, nodeId),
          auth_override: auth || '',
        },
        confirmedBy: userId,
      });
      const latestVersion = getLatestAgentVersion();
      const annotatedNode = {
        ...node,
        latestVersion,
        outdated: node.version && node.version !== 'unknown' && node.version !== latestVersion,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result, ops: buildNodeOpsView(userId, annotatedNode) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // DELETE /api/nodes/:nodeId — tell the agent to uninstall, then revoke it.
  // If the registry entry is already gone but orphan profiles/watchers remain
  // (the pre-cascade bug), still purge local data so Remove stays the one
  // control that fully forgets a node.
  const deleteMatch = p.match(/^\/api\/nodes\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(deleteMatch[1]);

    // Step 1: ask the agent to run its self-destruct script (best-effort — if
    // the node is offline, we still proceed to revoke).
    pushUninstall(nodeId, userId);

    // Step 2: give the agent a moment to spawn the detached self-destruct
    // process before we close its WS in removeNode().
    setTimeout(async () => {
      const result = removeNode(nodeId, userId);
      let cascade = null;
      try {
        const { purgeNodeLocalData, safeNodeDataDir } = await import('../lib/node-cleanup.mjs');
        // Await purge even when removeNode already kicked a fire-and-forget
        // cascade — idempotent, and guarantees the response means "done".
        const dir = safeNodeDataDir(userId, nodeId);
        const hadDir = !!(dir && fs.existsSync(dir));
        cascade = await purgeNodeLocalData(userId, nodeId);
        if (!result.removed && !hadDir && !cascade.watchersCancelled && !cascade.dataDeleted) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.reason || 'not found' }));
          return;
        }
      } catch (e) {
        if (!result.removed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.reason || 'not found' }));
          return;
        }
        console.warn('[nodes] cascade cleanup failed:', e?.message || e);
      }
      // Cascade-delete the user's node aliases. routes/* deletions don't go
      // through tool dispatch, so the framework's manifest cascade_on_tools
      // doesn't fire here — call the public helper directly instead.
      try {
        const { deleteAliasesByEntityId } = await import('../lib/skill-alias-framework.mjs');
        const removed = deleteAliasesByEntityId(userId, 'node', nodeId);
        if (removed > 0) console.log(`[nodes] dropped ${removed} alias(es) for "${nodeId}"`);
      } catch (e) { console.warn('[nodes] alias cascade-delete failed:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        removed: true,
        uninstallRequested: result.removed,
        orphan: !result.removed,
        cascade: cascade || undefined,
      }));
    }, 1000);
    return true;
  }

  // POST /api/nodes/:nodeId/update — push an update to a connected agent
  const updateMatch = p.match(/^\/api\/nodes\/([^/]+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(updateMatch[1]);
    const result = pushUpdate(nodeId, userId);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error, needsReprovision: !!result.needsReprovision }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pushed: true, nodeId }));
    return true;
  }

  // POST /api/nodes/:nodeId/profile/:serviceId/onboard
  // Approves an existing profile after verifying read-only diagnostics.
  // target=reviewed starts monitoring; target=proven is the explicit second
  // step that permits medium-risk fixes when the node Auto-fix gate is on.
  const profileOnboardMatch = p.match(/^\/api\/nodes\/([^/]+)\/profile\/([^/]+)\/onboard$/);
  const legacySystemOnboardMatch = p.match(/^\/api\/nodes\/([^/]+)\/system-profile\/onboard$/);
  if ((profileOnboardMatch || legacySystemOnboardMatch) && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent((profileOnboardMatch || legacySystemOnboardMatch)[1]);
    const serviceId = profileOnboardMatch ? decodeURIComponent(profileOnboardMatch[2]) : 'system';
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }

    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    const target = body.target === 'proven' ? 'proven' : 'reviewed';
    const ensured = serviceId === 'system'
      ? ensureNodeSystemProfile(userId, nodeId, { hostname: node.hostname, platform: node.platform })
      : null;
    let profile = loadProfile(userId, nodeId, serviceId);
    if (!profile) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: ensured?.reason || `No profile exists for "${serviceId}" on this node yet.` }));
      return true;
    }

    if (target === 'proven' && profile.trust_state !== 'reviewed' && profile.trust_state !== 'proven') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Approve ${serviceId === 'system' ? 'Host health' : serviceId} before enabling Auto-fix.` }));
      return true;
    }

    let verification = null;
    if (target === 'reviewed') {
      try {
        verification = await verifyProfileReadonly({
          userId,
          nodeId,
          serviceId,
          ctx: { execFn: makeNodeExecFn(userId, nodeId) },
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Verification failed: ${e.message}` }));
        return true;
      }
      if (verification.failed > 0 || verification.tested === 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Profile verification did not pass. Fix the failed diagnostic before approving.',
          verification,
          profiles: getNodeProfilesSummary(userId, nodeId, node.hostname),
        }));
        return true;
      }
    }

    try {
      profile = setTrustState(userId, nodeId, serviceId, target, userId);
      unregisterProfileHealthWatchers(userId, nodeId, serviceId);
      let watcher = null;
      if ((profile.health_signals || []).length > 0) {
        watcher = registerProfileHealthWatchers(userId, nodeId, serviceId, {
          agentId: `${userId}_coordinator`,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        target,
        verification,
        watcher,
        profiles: getNodeProfilesSummary(userId, nodeId, node.hostname),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/nodes/:nodeId/detect-services — probe node and return the same
  // human-readable summary the nodes skill uses. The UI uses this as the first
  // step of node onboarding before handing profile creation to the agent.
  const detectServicesMatch = p.match(/^\/api\/nodes\/([^/]+)\/detect-services$/);
  if (detectServicesMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(detectServicesMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    try {
      const chunks = [];
      for await (const ev of nodesSkill('node_detect_services', { node_id: nodeId }, userId, null, {})) {
        if (ev?.text) chunks.push(ev.text);
      }
      const text = chunks.join('\n\n') || 'No service detection output.';
      const detected = [...text.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(m => m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text, detected, profiles: getNodeProfilesSummary(userId, nodeId, node.hostname) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/nodes/:nodeId/onboard — run the guided System Health onboarding
  // workflow. This starts read-only host/service monitoring and records whether
  // every detected profile was onboarded or only a partial set could be enabled.
  const onboardMatch = p.match(/^\/api\/nodes\/([^/]+)\/onboard$/);
  if (onboardMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(onboardMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    try {
      const result = await runNodeOnboarding({
        userId,
        node,
        scope: body.scope || 'safe',
        execFn: async (command) => sendCommand(node.nodeId, userId, {
          type: 'exec',
          command,
          timeout: 45,
        }),
      });
      setNodeOnboardingState(node.nodeId, userId, result);
      const profiles = getNodeProfilesSummary(userId, node.nodeId, node.hostname);
      const systemHealth = summarizeNodeSystemHealth({
        node: { ...node, onboarding: result },
        profiles,
        onboarding: result,
        autoFixEnabled: node.autoFixEnabled,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, onboarding: result, profiles, systemHealth }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // PATCH /api/nodes/:nodeId/auto-fix — per-node gate for autonomous fixes.
  // Monitoring can run without this; autonomous fixes only turn on after
  // System Health is fully onboarded.
  const autoFixMatch = p.match(/^\/api\/nodes\/([^/]+)\/auto-fix$/);
  if (autoFixMatch && req.method === 'PATCH') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(autoFixMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    const enabled = !!body.enabled;
    const profiles = getNodeProfilesSummary(userId, node.nodeId, node.hostname);
    const systemHealth = summarizeNodeSystemHealth({
      node,
      profiles,
      onboarding: node.onboarding,
      autoFixEnabled: node.autoFixEnabled,
    });
    if (enabled && !systemHealth.autoFixAvailable) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Auto-fix is available after System Health is fully onboarded.',
        systemHealth,
      }));
      return true;
    }
    const updated = setNodeAutoFix(node.nodeId, userId, enabled);
    const updatedHealth = summarizeNodeSystemHealth({
      node: updated,
      profiles,
      onboarding: updated?.onboarding,
      autoFixEnabled: updated?.autoFixEnabled,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, node: updated, systemHealth: updatedHealth }));
    return true;
  }

  // POST /api/nodes/revoke-all — revoke every paired node + every node session
  // owned by this user. Use when an unrecognized node appears or after a
  // suspected token compromise. Idempotent.
  if (p === '/api/nodes/revoke-all' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeList = getNodes(userId);
    let removed = 0;
    for (const n of nodeList) {
      // Best-effort uninstall, then revoke. If a node is offline the WS close
      // is a no-op; isRevoked() prevents reconnect.
      try { pushUninstall(n.nodeId, userId); } catch {}
      const r = removeNode(n.nodeId, userId);
      if (r.removed) removed++;
    }
    const sessionsRevoked = clearUserNodeSessions(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed, sessionsRevoked, total: nodeList.length }));
    return true;
  }

  // POST /api/nodes/update-all — push updates to every node owned by the user
  if (p === '/api/nodes/update-all' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeList = getNodes(userId);
    const results = nodeList.map(n => ({ nodeId: n.nodeId, ...pushUpdate(n.nodeId, userId) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pushed: results.length, results }));
    return true;
  }

  // GET /api/nodes/:nodeId/status — get detailed node status
  const statusMatch = p.match(/^\/api\/nodes\/([^/]+)\/status$/);
  if (statusMatch && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(statusMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    try {
      const result = await sendCommand(nodeId, userId, { type: 'status' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...node, liveStatus: result }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...node, liveStatus: null, statusError: e.message }));
    }
    return true;
  }

  // POST /api/nodes/:nodeId/exec — execute command, return full result
  const execMatch = p.match(/^\/api\/nodes\/([^/]+)\/exec$/);
  if (execMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(execMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command is required' }));
      return true;
    }
    try {
      const result = await sendCommand(nodeId, userId, {
        type: 'exec',
        command: body.command,
        timeout: Math.min(body.timeout || 60, 300),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/nodes/:nodeId/exec/stream — SSE streaming command output
  const streamMatch = p.match(/^\/api\/nodes\/([^/]+)\/exec\/stream$/);
  if (streamMatch && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return true;
    const nodeId = decodeURIComponent(streamMatch[1]);
    const node = getNode(nodeId, userId);
    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Node not found' }));
      return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command is required' }));
      return true;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      const result = await sendCommandStreaming(nodeId, userId, {
        type: 'exec',
        command: body.command,
        timeout: Math.min(body.timeout || 60, 300),
      }, (stream, data) => {
        // Send each chunk as an SSE event
        res.write(`data: ${JSON.stringify({ stream, data })}\n\n`);
      });

      // Send final result
      res.write(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`);
      res.end();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      res.end();
    }
    return true;
  }

  // Pairing: /api/nodes/pair and /api/nodes/redeem
  if (await handlePairingRoutes(req, res, p)) return true;

  return false;
}
