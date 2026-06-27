// Platform-knowledge FAQ, returned only when the LLM calls
// `oe_describe_platform`. Pulled out of the coordinator SPA so it doesn't
// ship on every turn — most turns don't need this content. Keep it factual
// and stable; refresh when the platform's capabilities change shape.
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

  // ask_agent is handled by skills/delegate/execute.mjs (single
  // implementation, with depth + caller-role enforcement). Don't claim
  // it here — let the executor lookup route to the delegate skill instead.
}
