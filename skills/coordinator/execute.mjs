// Platform-knowledge FAQ, returned only when the LLM calls
// `oe_describe_platform`. Pulled out of the coordinator SPA so it doesn't
// ship on every turn — most turns don't need this content. Keep it factual
// and stable; refresh when the platform's capabilities change shape.
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { userSkillsDir } from '../../lib/paths.mjs';

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
    const {
      describeParallelWorkLaneRequirement,
      isParallelWorkGateLocked,
    } = await import('../../lib/parallel-work-gate.mjs');
    const ctx = getToolRouterContext();
    if (!ctx) {
      // No per-turn routing context — nothing was trimmed, so there's nothing
      // to recover. The full toolset is already available this turn.
      yield { type: 'result', text: 'request_tools has nothing to add — the full toolset is already available this turn.' };
      return;
    }
    if (isParallelWorkGateLocked(ctx.agent)) {
      const laneRequirement = describeParallelWorkLaneRequirement(
        ctx.agent?._parallelWorkGate?.assessment,
      );
      yield {
        type: 'result',
        text: `Tool recovery is locked until the mandatory parallel-work preflight completes. Call parallel_work with ${laneRequirement} non-overlapping claimed lanes first.`,
        isError: true,
      };
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
      const { getOrchestrationPolicy } = await import('../../lib/orchestration-policy.mjs');
      const fallback = getOrchestrationPolicy(userId).mode === 'single'
        ? 'Continue with your own tools, or use spawn_worker for genuinely long or parallel work.'
        : 'If you need a role-gated capability, use ask_agent to delegate instead.';
      yield { type: 'result', text: `No additional tools matched (reason: "${reason ?? '?'}", groups: ${JSON.stringify(groups ?? [])}). ${fallback}` };
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
    const {
      createCustomAgent,
      deleteCustomAgent,
      validatePrimarySkillCategory,
    } = await import('../../agents.mjs');
    const { broadcastAgentList, getAgentsForUser } = await import('../../routes/_helpers.mjs');
    const roleId = args.role_id?.trim() || undefined;
    let inheritedModel, inheritedProvider;
    if (!args.model && agentId) {
      const callerRealId = agentId.startsWith(`${userId}_`) ? agentId.slice(userId.length + 1) : agentId;
      const caller = getAgentsForUser(userId).find(a => a.id === callerRealId);
      if (caller) { inheritedModel = caller.model; inheritedProvider = caller.provider; }
    }
    const roleValidation = await validatePrimarySkillCategory(userId, roleId);
    if (!roleValidation.ok) {
      yield { type: 'result', text: roleValidation.error, isError: true };
      return;
    }
    const durableRole = roleValidation.skillCategory;
    const {
      tryAcquireUserTopologyTransition,
      runWithUserTopologyLease,
      finishUserTopologyTransition,
      rollbackUserTopologyTransition,
    } = await import('../../chat-dispatch/slot-registry.mjs');
    const topologyTransition = tryAcquireUserTopologyTransition(userId);
    if (!topologyTransition) {
      yield {
        type: 'result',
        text: 'Another reply or account setup change is active. Try again when it finishes.',
        isError: true,
      };
      return;
    }
    let agent = null;
    let createdAgent = null;
    try {
      agent = await runWithUserTopologyLease(topologyTransition.lease, async () => {
        const created = createCustomAgent({
          name: agentName,
          emoji: args.emoji || '🤖',
          description: args.description || '',
          model: args.model || inheritedModel,
          provider: args.provider || inheritedProvider,
          skillCategory: durableRole,
          ownerId: userId,
        });
        createdAgent = created;
        if (durableRole) {
          const { getDurableRoleAssignment, setRoleAssignment } = await import('../../roles.mjs');
          if (!getDurableRoleAssignment(durableRole, userId)) {
            setRoleAssignment(durableRole, created.id, userId);
          }
        }
        return created;
      });
      finishUserTopologyTransition(topologyTransition);
    } catch (error) {
      if (createdAgent) {
        try { await deleteCustomAgent(createdAgent.id); } catch {}
        try {
          const { clearRoleAssignmentsForAgent } = await import('../../roles.mjs');
          clearRoleAssignmentsForAgent(createdAgent.id, userId);
        } catch {}
      }
      rollbackUserTopologyTransition(topologyTransition);
      yield { type: 'result', text: `Could not create agent: ${error.message}`, isError: true };
      return;
    }
    try { broadcastAgentList(); } catch (error) {
      console.warn('[coordinator] post-create roster broadcast failed:', error.message);
    }
    const roleNote = durableRole ? ` with the "${durableRole}" primary role` : '';
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
    const { listRoles, removeRoleManifest, setRoleAssignment } = await import('../../roles.mjs');
    const { clearCustomAgentPrimaryRolesForRole } = await import('../../agents.mjs');
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
    clearCustomAgentPrimaryRolesForRole(role.id, userId);
    setRoleAssignment(role.id, null, userId);
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
    const {
      getDurableRoleAssignment,
      isSkillRuntimeEnabledForUser,
      listRoles,
      setRoleAssignment,
    } = await import('../../roles.mjs');
    const { broadcastAgentList, loadCustomAgents } = await import('../../routes/_helpers.mjs');
    const {
      getCustomAgentRecord,
      updateCustomAgent,
      validatePrimarySkillCategory,
    } = await import('../../agents.mjs');
    const roleName  = args.role_name?.trim().toLowerCase();
    const agentName = args.agent_name?.trim().toLowerCase();
    const role = listRoles(userId).find(s => s.service && s.name.toLowerCase() === roleName);
    if (!role) {
      yield { type: 'result', text: `No role named "${args.role_name}" found. Use list_roles to see available roles.` };
      return;
    }
    if (!isSkillRuntimeEnabledForUser(role.id, userId)) {
      yield { type: 'result', text: `The "${role.name}" role is disabled for this account.`, isError: true };
      return;
    }
    const ownedAgents = loadCustomAgents().filter(a => a.ownerId === userId);
    const agent = ownedAgents.find(a => a.name.toLowerCase() === agentName);
    if (!agent) {
      yield { type: 'result', text: `No agent named "${args.agent_name}" found.` };
      return;
    }
    const prev = getDurableRoleAssignment(role.id, userId);
    if (!isPrivileged && user.skillsLocked && prev !== agent.id) {
      yield { type: 'result', text: 'Your tools are managed by an administrator.', isError: true };
      return;
    }
    const currentPrimary = agent.skillCategory ?? null;
    const { getRoleManifest } = await import('../../roles.mjs');
    const needsBackfill = !currentPrimary
      || currentPrimary === 'general'
      || !getRoleManifest(currentPrimary, userId);
    if (prev === agent.id && !needsBackfill) {
      yield { type: 'result', text: `${role.icon ?? ''} ${role.name} is already assigned to ${agent.emoji ?? ''} ${agent.name}.` };
      return;
    }
    const policy = await validatePrimarySkillCategory(
      userId,
      role.id,
      { currentSkillCategory: agent.skillCategory ?? null, allowUnchanged: false },
    );
    if (!policy.ok) {
      yield { type: 'result', text: policy.error, isError: true };
      return;
    }
    const {
      tryAcquireUserTopologyTransition,
      runWithUserTopologyLease,
      finishUserTopologyTransition,
      rollbackUserTopologyTransition,
    } = await import('../../chat-dispatch/slot-registry.mjs');
    const topologyTransition = tryAcquireUserTopologyTransition(userId);
    if (!topologyTransition) {
      yield { type: 'result', text: 'Another reply or account setup change is active. Try again when it finishes.', isError: true };
      return;
    }
    let backfillStarted = false;
    try {
      await runWithUserTopologyLease(topologyTransition.lease, async () => {
        if (needsBackfill) {
          if (!updateCustomAgent(agent.id, { skillCategory: role.id })) {
            throw new Error('Agent disappeared before its primary role could be saved');
          }
          backfillStarted = true;
        }
        setRoleAssignment(role.id, agent.id, userId);
      });
      finishUserTopologyTransition(topologyTransition);
    } catch (error) {
      if (backfillStarted) {
        try { updateCustomAgent(agent.id, { skillCategory: currentPrimary }); } catch {}
      }
      try { setRoleAssignment(role.id, prev, userId); } catch {}
      rollbackUserTopologyTransition(topologyTransition);
      yield { type: 'result', text: `Could not assign role: ${error.message}`, isError: true };
      return;
    }
    try { broadcastAgentList(); } catch (error) {
      console.warn('[coordinator] post-assignment roster broadcast failed:', error.message);
    }
    const prevAgent = prev ? getCustomAgentRecord(prev, userId) : null;
    const from = prevAgent ? ` (previously ${prevAgent.name})` : '';
    yield { type: 'result', text: `${role.icon ?? ''} ${role.name} is now assigned to ${agent.emoji ?? ''} ${agent.name}${from}.` };
    return;
  }

  // ask_agent is handled by skills/delegate/execute.mjs (single
  // implementation, with depth + caller-role enforcement). Don't claim
  // it here — let the executor lookup route to the delegate skill instead.
}
