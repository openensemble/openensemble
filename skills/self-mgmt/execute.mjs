import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USERS_DIR = path.join(BASE_DIR, 'users');

function getUserById(userId) {
  try {
    const p = path.join(USERS_DIR, userId, 'profile.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

function saveUserById(user) {
  writeFileSync(path.join(USERS_DIR, user.id, 'profile.json'), JSON.stringify(user, null, 2));
}

function autoEnableSkillForUser(userId, skillId) {
  try {
    const user = getUserById(userId);
    if (user?.skills && !user.skills.includes(skillId)) {
      user.skills.push(skillId);
      saveUserById(user);
    }
  } catch {}
}

const SKILLS_DIR = path.join(BASE_DIR, 'skills');

function loadSkillManifest(skillId) {
  const p = path.join(SKILLS_DIR, skillId, 'manifest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function rulesPath(skillId) {
  return path.join(SKILLS_DIR, skillId, 'rules.md');
}

function loadRules(skillId) {
  const p = rulesPath(skillId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function saveRules(skillId, rules) {
  if (rules.length === 0) {
    const p = rulesPath(skillId);
    if (existsSync(p)) unlinkSync(p);
  } else {
    writeFileSync(rulesPath(skillId), rules.join('\n') + '\n', 'utf8');
  }
}

export default async function execute(name, args, userId, agentId) {
  if (name === 'role_add_rule') {
    const { roleId, rule } = args;
    const skillId = roleId;
    if (!skillId || !rule) return 'roleId and rule are required.';
    const manifest = loadSkillManifest(skillId);
    if (!manifest) return `No role found with id "${skillId}".`;
    const rules = loadRules(skillId);
    rules.push(`- ${rule.trim()}`);
    saveRules(skillId, rules);
    return `Rule added to ${manifest.name}. It will apply to any agent handling this role from the next conversation.`;
  }

  if (name === 'role_remove_rule') {
    const { roleId, index } = args;
    const skillId = roleId;
    if (!skillId || index == null) return 'roleId and index are required.';
    const manifest = loadSkillManifest(skillId);
    if (!manifest) return `No role found with id "${skillId}".`;
    const rules = loadRules(skillId);
    if (index < 0 || index >= rules.length) return `Index ${index} is out of range. There are ${rules.length} rule(s).`;
    const removed = rules.splice(index, 1)[0];
    saveRules(skillId, rules);
    return `Removed rule: ${removed}`;
  }

  if (name === 'role_list_rules') {
    const { roleId } = args;
    const skillId = roleId;
    if (!skillId) return 'roleId is required.';
    const manifest = loadSkillManifest(skillId);
    if (!manifest) return `No role found with id "${skillId}".`;
    const rules = loadRules(skillId);
    if (rules.length === 0) return `No custom rules set for ${manifest.name}.`;
    return `Rules for ${manifest.name}:\n${rules.map((r, i) => `[${i}] ${r}`).join('\n')}`;
  }

  if (name === 'list_roles') {
    const { listRoles, getRoleAssignments } = await import('../../roles.mjs');
    const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
    const assignments = getRoleAssignments(userId);
    const allAgents = getAgentsForUser(userId);
    const roles = listRoles().filter(s => s.service);
    if (!roles.length) return 'No roles defined yet.';
    return roles.map(r => {
      const agentId = assignments[r.id];
      const agent = agentId ? allAgents.find(a => a.id === agentId) : null;
      const who = agent ? `${agent.emoji ?? ''} ${agent.name}`.trim() : 'unassigned';
      return `• ${r.icon ?? ''} ${r.name} — ${who}${r.description ? ` (${r.description})` : ''}`;
    }).join('\n');
  }

  if (name === 'create_role') {
    const user = getUserById(userId);
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) return 'Creating roles requires admin privileges.';
    const { name: roleName, icon, description, responsibilities, confirmed } = args;
    if (!roleName?.trim() || !responsibilities?.trim()) return 'name and responsibilities are required.';
    if (!confirmed) return 'You must present the draft system prompt to the user and get their explicit approval before creating the role. Show them the responsibilities text and ask if they want any changes, then call create_role again with confirmed=true.';
    const id = 'role_' + roleName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const { getRoleManifest, addRoleManifest } = await import('../../roles.mjs');
    if (getRoleManifest(id)) return `A role named "${roleName}" already exists. Use assign_role_to_agent to assign it to an agent instead of creating a new one.`;
    const manifest = {
      id, name: roleName.trim(), icon: icon?.trim() || '🎯',
      description: description?.trim() || '',
      category: 'custom', service: true, custom: true,
      systemPromptAddition: responsibilities.trim(),
      tools: [], enabled_by_default: false,
    };
    const skillDir = path.join(SKILLS_DIR, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    addRoleManifest(manifest);
    return `Role "${roleName.trim()}" created. You can assign it to an agent by saying "assign ${roleName.trim()} to [agent name]".`;
  }

  if (name === 'delete_role') {
    const user = getUserById(userId);
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) return 'Deleting roles requires admin privileges.';
    const { listRoles, getRoleManifest, removeRoleManifest } = await import('../../roles.mjs');
    const roleName = args.name?.trim().toLowerCase();
    const role = listRoles().find(s => s.service && s.name.toLowerCase() === roleName);
    if (!role) return `No role named "${args.name}" found.`;
    if (!role.custom) return `"${role.name}" is a built-in role and cannot be deleted.`;
    const skillDir = path.join(SKILLS_DIR, role.id);
    rmSync(skillDir, { recursive: true, force: true });
    removeRoleManifest(role.id);
    const CFG_PATH = path.join(BASE_DIR, 'config.json');
    try {
      const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
      if (cfg.skillAssignments) { delete cfg.skillAssignments[role.id]; writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); }
    } catch {}
    return `Role "${role.name}" has been deleted.`;
  }

  if (name === 'assign_role_to_agent') {
    const user = getUserById(userId);
    if (!user) return 'User not found.';
    const isPrivileged = user.role === 'admin' || user.role === 'owner';
    const { listRoles, getRoleAssignments, setRoleAssignment } = await import('../../roles.mjs');
    const { getAgentsForUser, loadCustomAgents } = await import('../../routes/_helpers.mjs');
    const roleName  = args.role_name?.trim().toLowerCase();
    const agentName = args.agent_name?.trim().toLowerCase();
    const role = listRoles().find(s => s.service && s.name.toLowerCase() === roleName);
    if (!role) return `No role named "${args.role_name}" found. Use list_roles to see available roles.`;
    // Non-admin users may only assign roles they have been granted
    if (!isPrivileged) {
      const userSkills = user.skills ?? [];
      if (!userSkills.includes(role.id)) return `You don't have permission to assign the "${role.name}" role.`;
    }
    const allAgents = getAgentsForUser(userId);
    const agent = allAgents.find(a => a.name.toLowerCase() === agentName);
    if (!agent) return `No agent named "${args.agent_name}" found.`;
    // Non-admin users may only assign roles to their own custom agents
    if (!isPrivileged) {
      const ownedAgent = loadCustomAgents().find(a => a.id === agent.id && a.ownerId === userId);
      if (!ownedAgent) return `You can only assign roles to agents you own.`;
    }
    const prev = getRoleAssignments(userId)[role.id];
    setRoleAssignment(role.id, agent.id, userId);
    // Auto-enable the skill for the requesting user
    if (user.skills && !user.skills.includes(role.id)) {
      user.skills.push(role.id);
      saveUserById(user);
    }
    const prevAgent = prev ? allAgents.find(a => a.id === prev) : null;
    const from = prevAgent ? ` (previously ${prevAgent.name})` : '';
    return `${role.icon ?? ''} ${role.name} is now assigned to ${agent.emoji ?? ''} ${agent.name}${from}.`;
  }

  if (name === 'remember_fact') {
    const text = args.text?.trim();
    if (!text || text.length < 5) return 'text is required (at least 5 characters).';
    if (text.length > 500) return 'Fact too long — keep it under 500 characters so it lands cleanly in the system prompt.';
    const scope = typeof args.scope === 'string' ? args.scope.trim().toLowerCase() : null;
    const { pinFact } = await import('../../memory.mjs');
    const rec = await pinFact({ agentId, text, userId, scope });
    if (!rec) return 'Failed to store fact (see server logs).';
    if (rec._dedupHit) {
      // Existing fact already covers this — no new row written.
      return `Already knew that — kept the existing fact: ${rec.text}`;
    }
    const scopeNote = rec.role_scope
      ? ` (scoped to role "${rec.role_scope}" — only agents holding this role will see it)`
      : ' (shared across all agents)';
    return `Pinned fact${scopeNote}: ${text}`;
  }

  if (name === 'recall_facts') {
    const query = args.query?.trim();
    if (!query) return 'query is required.';
    const { recall } = await import('../../memory.mjs');
    const [facts, params, episodes] = await Promise.all([
      recall({ agentId: 'shared', type: 'user_facts', query, topK: 6, includeShared: false, userId }).catch(() => []),
      recall({ agentId, type: 'params', query, topK: 4, includeShared: false, userId }).catch(() => []),
      recall({ agentId, type: 'episodes', query, topK: 4, includeShared: false, userId }).catch(() => []),
    ]);
    const parts = [];
    if (facts.length) parts.push('Facts:\n' + facts.map(f => `• ${f.text}`).join('\n'));
    if (params.length) parts.push('Agent params:\n' + params.map(p => `• ${p.text}`).join('\n'));
    if (episodes.length) {
      const lines = episodes.map(e => {
        const date = new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const body = e.text.length > 200 ? e.text.slice(0, 200) + '…' : e.text;
        return `• [${date}] ${body}`;
      }).join('\n');
      parts.push('Past conversations:\n' + lines);
    }
    return parts.length ? parts.join('\n\n') : `No stored memories match "${query}".`;
  }

  if (name === 'forget_fact') {
    const text = args.text?.trim();
    if (!text || text.length < 3) return 'text is required.';
    const { forgetByText } = await import('../../memory/recall.mjs');
    const { forgotten, texts } = await forgetByText({ agentId, text, userId, includeImmortal: true });
    if (!forgotten) return `No memories matched "${text}" closely enough to forget.`;
    return `Forgot ${forgotten} memor${forgotten === 1 ? 'y' : 'ies'}:\n${texts.map(t => `• ${t}`).join('\n')}`;
  }

  if (name !== 'claim_role') return null;

  const { roleId, force = false, release = false } = args;
  const skillId = roleId;
  if (!skillId) return 'roleId is required.';

  const manifest = loadSkillManifest(skillId);
  if (!manifest) return `No role found with id "${skillId}".`;

  // Delegate/system roles can't be assigned
  if (manifest.category === 'delegate') return `${manifest.name} is a system role and cannot be assigned.`;

  const { getRoleAssignments, setRoleAssignment } = await import('../../roles.mjs');
  const assignments = getRoleAssignments(userId);
  const currentOwner = assignments[skillId] ?? null;
  // Normalize agentId — strip userId prefix for consistent comparison
  const bareAgentId = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;

  // Release
  if (release) {
    if (currentOwner !== bareAgentId) {
      return currentOwner
        ? `${manifest.name} is owned by "${currentOwner}", not you.`
        : `${manifest.name} isn't assigned to anyone — already available to all agents.`;
    }
    setRoleAssignment(skillId, null, userId);
    return `Done — ${manifest.name} released back to all agents.`;
  }

  // Already mine
  if (currentOwner === bareAgentId) {
    return `${manifest.name} is already under your control.`;
  }

  // Owned by someone else — require explicit user confirmation
  if (currentOwner && !force) {
    return `${manifest.name} is currently assigned to agent "${currentOwner}". Tell the user who currently owns it and ask them to confirm the transfer. If they confirm, call claim_role again with force=true.`;
  }

  // Claim it
  setRoleAssignment(skillId, bareAgentId, userId);
  autoEnableSkillForUser(userId, skillId);
  const from = currentOwner ? ` (transferred from "${currentOwner}")` : '';
  return `Done — ${manifest.name} is now under your control${from}.`;
}
