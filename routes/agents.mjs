/**
 * Agent routes: /api/agents CRUD, /api/agent-model/:id, /api/roles, /api/roles/toggle
 */

import fs   from 'fs';
import path from 'path';
import {
  requireAuth, requirePrivileged, getAuthToken, getSessionUserId, getUser,
  isPrivileged, loadUsers, loadConfig,
  modifyUsers, modifyUser, modifyConfig,
  agentToWire, readBody, getAgentsForUser, getUserEnabledSkills,
  saveUserAgentOverride, broadcastAgentList,
  getAgent, loadCustomAgents, updateAgentMeta, invalidateModelOverridesCache, listRoles,
  BASE_DIR,
} from './_helpers.mjs';
import { createCustomAgent, deleteCustomAgent, updateCustomAgent } from '../agents.mjs';
import { onRoleEnabled, getRoleAssignments, setRoleAssignment, getRoleManifest, addRoleManifest, removeRoleManifest } from '../roles.mjs';

function setRoleAssignmentForUser(roleId, agentId, userId) {
  return setRoleAssignment(roleId, agentId || null, userId);
}

export async function handle(req, res) {
  // Update an agent's model
  const agentModelMatch = req.url.match(/^\/api\/agent-model\/(\w+)$/);
  if (agentModelMatch && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const { model, provider } = JSON.parse(await readBody(req));
      updateAgentMeta(agentModelMatch[1], { model, provider });
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // List agents
  if (req.url === '/api/agents' && req.method === 'GET') {
    const callerUserId = getSessionUserId(getAuthToken(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAgentsForUser(callerUserId).map(agentToWire)));
    return true;
  }

  // Create custom agent
  if (req.url === '/api/agents' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      // Per-user agent cap — guard against runaway creation from a compromised
      // or misbehaving account.
      const MAX_AGENTS_PER_USER = 50;
      const existing = loadCustomAgents().filter(a => a.ownerId === authId).length;
      if (existing >= MAX_AGENTS_PER_USER) {
        res.writeHead(429); res.end(JSON.stringify({ error: `Agent limit reached (${MAX_AGENTS_PER_USER}). Delete some before creating more.` })); return true;
      }
      let { name, emoji, description, model, provider, toolSet, skillCategory, systemPrompt, outputDir, maxTokens, contextSize } = JSON.parse(await readBody(req));
      if (contextSize != null) {
        contextSize = parseInt(contextSize, 10);
        if (!Number.isFinite(contextSize) || contextSize < 1024 || contextSize > 2_000_000) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'contextSize must be between 1024 and 2000000' })); return true;
        }
      }
      // Child accounts: clamp toolSet/skillCategory to a safe whitelist. A child cannot
      // create an agent that pulls in coder/nodes/email/admin tools via skillCategory.
      const caller = getUser(authId);
      if (caller?.role === 'child') {
        const CHILD_SAFE_TOOLSETS = ['web', null, undefined, ''];
        const CHILD_SAFE_SKILL_CATEGORIES = ['deep_research', 'web', 'image_generator'];
        if (!CHILD_SAFE_TOOLSETS.includes(toolSet)) toolSet = 'web';
        if (skillCategory && !CHILD_SAFE_SKILL_CATEGORIES.includes(skillCategory)) skillCategory = null;
        // Child can't set a custom system prompt — it must use buildSystemPrompt
        // so the safety prefix and identity template apply cleanly.
        systemPrompt = undefined;
        outputDir = undefined;
      }
      const agent = createCustomAgent({ name, emoji, description, model, provider, toolSet, systemPrompt, outputDir, maxTokens, contextSize, ownerId: authId });
      if (skillCategory) {
        const { setRoleAssignment } = await import('../roles.mjs');
        setRoleAssignment(skillCategory, agent.id, authId);
      }
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agentToWire(agent)));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Update / delete agent
  const agentMatch = req.url.match(/^\/api\/agents\/([\w-]+)$/);
  if (agentMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const changes = JSON.parse(await readBody(req));
      const uiChanges = {};
      const globalChanges = {};
      if (changes.name)     uiChanges.name     = changes.name;
      if (changes.emoji)    uiChanges.emoji    = changes.emoji;
      if (changes.model)     globalChanges.model     = changes.model;
      if (changes.provider)  globalChanges.provider  = changes.provider;
      if ('outputDir' in changes) globalChanges.outputDir = changes.outputDir || null;
      if ('maxTokens' in changes) globalChanges.maxTokens = changes.maxTokens ? parseInt(changes.maxTokens, 10) : null;
      if ('contextSize' in changes) {
        const cs = changes.contextSize ? parseInt(changes.contextSize, 10) : null;
        if (cs != null && (!Number.isFinite(cs) || cs < 1024 || cs > 2_000_000)) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'contextSize must be between 1024 and 2000000' })); return true;
        }
        globalChanges.contextSize = cs;
      }
      if (Object.keys(uiChanges).length) {
        const ownedCustom = loadCustomAgents().find(a => a.id === agentMatch[1] && a.ownerId === authId);
        if (ownedCustom) {
          updateCustomAgent(agentMatch[1], uiChanges);
          // Clear any stale per-user overrides for fields now canonical on the agent
          await modifyUser(authId, u => {
            if (u.agentOverrides?.[agentMatch[1]]) {
              for (const k of Object.keys(uiChanges)) delete u.agentOverrides[agentMatch[1]][k];
            }
          });
        } else {
          saveUserAgentOverride(authId, agentMatch[1], uiChanges);
        }
      }
      if (Object.keys(globalChanges).length) {
        updateAgentMeta(agentMatch[1], globalChanges);
      }
      const base = getAgent(agentMatch[1]);
      if (!base) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return true; }
      const userOverrides = getUser(authId)?.agentOverrides?.[agentMatch[1]] ?? {};
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agentToWire({ ...base, ...userOverrides })));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (agentMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const ca = loadCustomAgents().find(a => a.id === agentMatch[1]);
    if (!ca) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found or not a custom agent' })); return true; }
    if (ca.ownerId && ca.ownerId !== authId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Not your agent' })); return true; }
    deleteCustomAgent(agentMatch[1]);
    broadcastAgentList();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    return true;
  }

  // Roles (formerly skills) — auth-gated: leaks the full tool catalog otherwise
  if (req.url === '/api/roles' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const userSkills = getUserEnabledSkills(authId);
    const assignments = getRoleAssignments(authId);
    const priv = isPrivileged(authId);
    let roleList = listRoles(authId).filter(s => !s.hidden);
    if (!priv) {
      const currentUser = loadUsers().find(u => u.id === authId);
      if (currentUser?.allowedSkills != null) {
        roleList = roleList.filter(s => currentUser.allowedSkills.includes(s.id));
      }
    }
    const roles = roleList.map(s => ({ ...s, enabled: userSkills.includes(s.id), assignment: assignments[s.id] ?? null }));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(roles)); return true;
  }

  if (req.url === '/api/roles/assign' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { skillId, agentId } = JSON.parse(await readBody(req));
      // Allow non-admin users to assign a role only to their own custom agents
      if (!isPrivileged(authId)) {
        const { loadCustomAgents } = await import('../agents.mjs');
        const ownedAgent = loadCustomAgents().find(a => a.id === agentId && a.ownerId === authId);
        if (!ownedAgent) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
      }
      await setRoleAssignmentForUser(skillId, agentId, authId);
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (req.url === '/api/roles/toggle' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { skillId, enabled, userId: targetUserId } = JSON.parse(await readBody(req));
      const targetId = (targetUserId && isPrivileged(authId)) ? targetUserId : authId;
      // Pre-flight checks on a snapshot (low-risk, roles toggle isn't highly concurrent)
      const snap = loadUsers();
      const snapIdx = snap.findIndex(u => u.id === targetId);
      if (snapIdx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }
      if (snap[snapIdx].skillsLocked && !isPrivileged(authId)) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Your tools are managed by an administrator' })); return true;
      }
      if (enabled && snap[snapIdx].allowedSkills != null && !isPrivileged(authId) && !snap[snapIdx].allowedSkills.includes(skillId)) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'That tool is not permitted for your account' })); return true;
      }
      const updatedSkills = await modifyUser(targetId, u => {
        const current = u.skills ?? getUserEnabledSkills(targetId);
        u.skills = enabled
          ? [...new Set([...current, skillId])]
          : current.filter(s => s !== skillId);
      }).then(u => u?.skills ?? null);
      broadcastAgentList();
      if (enabled) onRoleEnabled(skillId, targetId).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ skills: updatedSkills ?? [] }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Create custom role (admin only)
  if (req.url === '/api/roles' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    try {
      const { name, icon, description, responsibilities } = JSON.parse(await readBody(req));
      if (!name?.trim()) throw new Error('name required');
      const id = 'role_' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (getRoleManifest(id)) throw new Error('A role with that name already exists');
      const manifest = {
        id, name: name.trim(), icon: icon?.trim() || '🎯',
        description: description?.trim() || '',
        category: 'custom', service: true, custom: true,
        systemPromptAddition: responsibilities?.trim() || '',
        tools: [], enabled_by_default: false,
      };
      const skillDir = path.join(BASE_DIR, 'skills', id);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      addRoleManifest(manifest);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, manifest }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Delete custom role (admin only)
  if (req.url.startsWith('/api/roles/') && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    const id = decodeURIComponent(req.url.slice('/api/roles/'.length));
    try {
      const manifest = getRoleManifest(id);
      if (!manifest) throw new Error('Role not found');
      if (!manifest.service) throw new Error('Cannot delete tools, only roles');
      const skillDir = path.join(BASE_DIR, 'skills', id);
      fs.rmSync(skillDir, { recursive: true, force: true });
      removeRoleManifest(id);
      await modifyConfig(cfg => { if (cfg.skillAssignments) delete cfg.skillAssignments[id]; });
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  return false;
}
