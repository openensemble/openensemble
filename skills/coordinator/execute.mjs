// Platform-knowledge FAQ, returned only when the LLM calls
// `oe_describe_platform`. Pulled out of the coordinator SPA so it doesn't
// ship on every turn — most turns don't need this content. Keep it factual
// and stable; refresh when the platform's capabilities change shape.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { CFG_PATH, userSkillsDir } from '../../lib/paths.mjs';

const PLATFORM_KNOWLEDGE = `# OpenEnsemble platform

OpenEnsemble is a self-hosted multi-user AI assistant platform.

## Avatars
- Supported formats: JPEG, PNG, WebP, GIF
- Max upload size: 2 MB
- Output dimensions: 512 × 512 px (square, auto-cropped)
- Fallback: built-in emoji avatars

## Users & accounts
- Multi-user: each user has their own account, settings, and agent sessions
- Child accounts with per-account safety settings
- Invite links for onboarding new users
- Per-user email connections (e.g. Gmail via OAuth)

## Agents & roles
- Agents are configured per-user; roles add tools and context to specific agents
- Roles are assigned to specific agents in platform config
- Each agent-user session is stored as a separate conversation history

## Configuration
- All user-facing config is done via chat or the UI — no manual file editing required for end users
`;

export default async function* execute(name, args, userId, agentId) {
  if (name === 'oe_describe_platform') {
    yield { type: 'result', text: PLATFORM_KNOWLEDGE };
    return;
  }

  if (name === 'request_tools') {
    const { getToolRouterContext } = await import('../../lib/tool-router-context.mjs');
    const { expandToolsByReason } = await import('../../lib/tool-router.mjs');
    const ctx = getToolRouterContext();
    if (!ctx) {
      // No per-turn routing context — nothing was trimmed, so there's nothing
      // to recover. The full toolset is already available this turn.
      yield { type: 'result', text: 'request_tools has nothing to add — the full toolset is already available this turn.' };
      return;
    }
    const reason = typeof args?.reason === 'string' ? args.reason : null;
    const groups = Array.isArray(args?.groups) ? args.groups : null;
    if (!reason && !groups) {
      yield { type: 'result', text: 'Pass either a `reason` (free text) or `groups` (array of skill IDs).' };
      return;
    }
    const r = await expandToolsByReason({
      agent: ctx.agent, fullTools: ctx.fullTools,
      reason, groups, userId,
      alreadyIncludedSkills: ctx.initiallyIncludedSkills,
    });
    for (const s of r.addedSkills) ctx.addedSkills.add(s);
    if (!Array.isArray(ctx.recoveryLoads)) ctx.recoveryLoads = [];
    ctx.recoveryLoads.push({
      source: 'request_tools',
      requestedGroups: (groups ?? []).filter(group => typeof group === 'string').slice(0, 64),
      addedSkills: [...r.addedSkills],
      addedToolNames: [...r.addedToolNames],
    });
    if (!r.addedToolNames.length) {
      yield { type: 'result', text: `No additional tools matched (reason: "${reason ?? '?'}", groups: ${JSON.stringify(groups ?? [])}). If you need a role-gated capability, use ask_agent to delegate instead.` };
      return;
    }
    // NOTE: the expanded skills' SPAs do NOT get added back into the system
    // prompt this turn — providers read systemPrompt once per turn (as a
    // function param, not from agent.systemPrompt). The LLM works from the
    // tool descriptions only for newly-added tools, which is usually enough.
    // If we observe quality issues for specific skills, future work could
    // thread a mutable currentSystemPrompt ref through the providers.
    yield { type: 'result', text: `Added ${r.addedToolNames.length} tool(s) from ${r.addedSkills.join(', ')}: ${r.addedToolNames.join(', ')}. These are now available — call them directly.` };
    return;
  }

  if (name === 'create_agent') {
    const agentName = args.name?.trim();
    if (!agentName) { yield { type: 'result', text: 'name is required.' }; return; }
    const { createCustomAgent } = await import('../../agents.mjs');
    const { broadcastAgentList, getAgentsForUser } = await import('../../routes/_helpers.mjs');
    const roleId = args.role_id?.trim() || undefined;
    let inheritedModel, inheritedProvider;
    if (!args.model && agentId) {
      const callerRealId = agentId.startsWith(`${userId}_`) ? agentId.slice(userId.length + 1) : agentId;
      const caller = getAgentsForUser(userId).find(a => a.id === callerRealId);
      if (caller) { inheritedModel = caller.model; inheritedProvider = caller.provider; }
    }
    const agent = createCustomAgent({
      name: agentName,
      emoji: args.emoji || '🤖',
      description: args.description || '',
      model: args.model || inheritedModel,
      provider: args.provider || inheritedProvider,
      ownerId: userId,
    });
    if (roleId) {
      const { setRoleAssignment } = await import('../../roles.mjs');
      setRoleAssignment(roleId, agent.id, userId);
    }
    broadcastAgentList();
    const roleNote = roleId ? ` and assigned to the "${roleId}" role` : '';
    yield { type: 'result', text: `Agent "${agent.name}" (${agent.emoji}) created successfully${roleNote}.` };
    return;
  }

  if (name === 'list_roles') {
    const { listRoles, getRoleAssignments } = await import('../../roles.mjs');
    const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
    const assignments = getRoleAssignments(userId);
    const allAgents = getAgentsForUser(userId);
    const all = listRoles(userId);
    const roles = all.filter(s => s.service);
    const customSkills = all.filter(s =>
      !s.service && s.category !== 'delegate' && !s.hidden && s.userScope === userId
    );
    const fmtOwner = (skillId) => {
      const ownerId = assignments[skillId];
      if (!ownerId) return 'unassigned';
      const agent = allAgents.find(a => a.id === ownerId);
      return agent ? `${agent.emoji ?? ''} ${agent.name}`.trim() : ownerId;
    };
    const lines = [];
    if (roles.length) {
      lines.push('## Roles');
      for (const r of roles) {
        lines.push(`• ${r.icon ?? ''} ${r.name} — ${fmtOwner(r.id)}${r.description ? ` (${r.description})` : ''}`);
      }
    }
    if (customSkills.length) {
      if (lines.length) lines.push('');
      lines.push('## Custom skills (one owner each)');
      for (const s of customSkills) {
        lines.push(`• ${s.icon ?? ''} ${s.name} (id: ${s.id}) — ${fmtOwner(s.id)}${s.description ? ` (${s.description})` : ''}`);
      }
    }
    yield { type: 'result', text: lines.length ? lines.join('\n') : 'No roles or custom skills defined yet.' };
    return;
  }

  if (name === 'create_role') {
    const { getUser } = await import('../../routes/_helpers.mjs');
    const user = getUser(userId);
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
      yield { type: 'result', text: 'Creating roles requires admin privileges.' };
      return;
    }
    const { name: roleName, icon, description, responsibilities, confirmed } = args;
    if (!roleName?.trim() || !responsibilities?.trim()) {
      yield { type: 'result', text: 'name and responsibilities are required.' };
      return;
    }
    if (!description?.trim()) {
      yield { type: 'result', text: 'description is required — the coordinator uses it to decide when to delegate to this role. Write one short sentence describing what kinds of requests this role handles.' };
      return;
    }
    if (!confirmed) {
      yield { type: 'result', text: 'You must present the draft system prompt to the user and get their explicit approval before creating the role. Show them the responsibilities text and ask if they want any changes, then call create_role again with confirmed=true.' };
      return;
    }
    const id = 'role_' + roleName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const { getRoleManifest, addRoleManifest } = await import('../../roles.mjs');
    if (getRoleManifest(id, userId) || getRoleManifest(id)) {
      yield { type: 'result', text: `A role named "${roleName}" already exists. Use assign_role_to_agent to assign it to an agent instead of creating a new one.` };
      return;
    }
    const manifest = {
      id, name: roleName.trim(), icon: icon?.trim() || '🎯',
      description: description.trim(), category: 'custom', service: true, custom: true,
      systemPromptAddition: responsibilities.trim(),
      tools: [], enabled_by_default: false,
    };
    const skillDir = path.join(userSkillsDir(userId), id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    addRoleManifest(manifest, userId);
    yield { type: 'result', text: `Role "${roleName.trim()}" created. You can assign it to an agent by saying "assign ${roleName.trim()} to [agent name]".` };
    return;
  }

  if (name === 'delete_role') {
    const { getUser } = await import('../../routes/_helpers.mjs');
    const user = getUser(userId);
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
      yield { type: 'result', text: 'Deleting roles requires admin privileges.' };
      return;
    }
    const { listRoles, removeRoleManifest } = await import('../../roles.mjs');
    const roleName = args.name?.trim().toLowerCase();
    const role = listRoles(userId).find(s => s.service && s.name.toLowerCase() === roleName);
    if (!role) {
      yield { type: 'result', text: `No role named "${args.name}" found.` };
      return;
    }
    if (!role.custom) {
      yield { type: 'result', text: `"${role.name}" is a built-in role and cannot be deleted.` };
      return;
    }
    const userRoot = userSkillsDir(userId);
    const skillDir = path.join(userRoot, role.id);
    const rel = path.relative(userRoot, skillDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      yield { type: 'result', text: `Refusing to delete role "${role.name}" — resolved path escapes the user skills directory.` };
      return;
    }
    rmSync(skillDir, { recursive: true, force: true });
    removeRoleManifest(role.id, userId);
    try {
      const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
      if (cfg.skillAssignments) {
        delete cfg.skillAssignments[role.id];
        writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
      }
    } catch {}
    yield { type: 'result', text: `Role "${role.name}" has been deleted.` };
    return;
  }

  if (name === 'assign_role_to_agent') {
    const { getUser } = await import('../../routes/_helpers.mjs');
    const user = getUser(userId);
    if (!user) {
      yield { type: 'result', text: 'User not found.' };
      return;
    }
    const isPrivileged = user.role === 'admin' || user.role === 'owner';
    const { listRoles, getRoleAssignments, setRoleAssignment } = await import('../../roles.mjs');
    const { getAgentsForUser, loadCustomAgents } = await import('../../routes/_helpers.mjs');
    const roleName  = args.role_name?.trim().toLowerCase();
    const agentName = args.agent_name?.trim().toLowerCase();
    const role = listRoles(userId).find(s => s.service && s.name.toLowerCase() === roleName);
    if (!role) {
      yield { type: 'result', text: `No role named "${args.role_name}" found. Use list_roles to see available roles.` };
      return;
    }
    if (!isPrivileged) {
      const userSkills = user.skills ?? [];
      if (!userSkills.includes(role.id)) {
        yield { type: 'result', text: `You don't have permission to assign the "${role.name}" role.` };
        return;
      }
    }
    const allAgents = getAgentsForUser(userId);
    const agent = allAgents.find(a => a.name.toLowerCase() === agentName);
    if (!agent) {
      yield { type: 'result', text: `No agent named "${args.agent_name}" found.` };
      return;
    }
    if (!isPrivileged) {
      const ownedAgent = loadCustomAgents().find(a => a.id === agent.id && a.ownerId === userId);
      if (!ownedAgent) {
        yield { type: 'result', text: 'You can only assign roles to agents you own.' };
        return;
      }
    }
    const prev = getRoleAssignments(userId)[role.id];
    setRoleAssignment(role.id, agent.id, userId);
    if (user.skills && !user.skills.includes(role.id)) {
      user.skills.push(role.id);
      const { saveUser } = await import('../../routes/_helpers.mjs');
      saveUser(user);
    }
    const prevAgent = prev ? allAgents.find(a => a.id === prev) : null;
    const from = prevAgent ? ` (previously ${prevAgent.name})` : '';
    yield { type: 'result', text: `${role.icon ?? ''} ${role.name} is now assigned to ${agent.emoji ?? ''} ${agent.name}${from}.` };
    return;
  }

  // ask_agent is handled by skills/delegate/execute.mjs (single
  // implementation, with depth + caller-role enforcement). Don't claim
  // it here — let the executor lookup route to the delegate skill instead.
}
