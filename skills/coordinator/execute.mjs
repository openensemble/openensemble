export default async function* execute(name, args, userId, agentId) {
  if (name === 'request_tools') {
    const { getToolRouterContext } = await import('../../lib/tool-router-context.mjs');
    const { expandToolsByReason } = await import('../../lib/tool-router.mjs');
    const ctx = getToolRouterContext();
    if (!ctx) {
      // Not in a coordinator turn — this tool is a no-op outside that context.
      yield { type: 'result', text: 'request_tools is only available during a coordinator turn.' };
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

  if (name !== 'ask_agent') return;

  const { agent_id, task, background = false, _parallel = false } = args;
  if (!agent_id) { yield { type: 'result', text: 'Missing agent_id.' }; return; }
  if (!task) { yield { type: 'result', text: 'Missing task.' }; return; }

  const { getAgentsForUser } = await import('../../routes/_helpers.mjs');

  const agents = getAgentsForUser(userId);
  // Accept either the real id (agent_2dfdf5ca) or the display name ("Ada").
  // Some models (notably gpt-5.x via the Codex backend) hallucinate names
  // even when the tool description lists real ids.
  let targetAgent = agents.find(a => a.id === agent_id);
  if (!targetAgent) {
    const needle = String(agent_id).toLowerCase();
    targetAgent = agents.find(a => a.name?.toLowerCase() === needle)
               ?? agents.find(a => a.id.toLowerCase().endsWith('_' + needle));
  }
  if (!targetAgent) {
    // Exclude coordinator-class agents (skillCategory 'general'/'web') so the
    // model doesn't see itself in the roster. Don't hardcode any specific id —
    // every install names its coordinator differently.
    const roster = agents
      .filter(a => a.skillCategory && a.skillCategory !== 'general' && a.skillCategory !== 'web')
      .map(a => `  - ${a.id} (${a.name}${a.emoji ? ' ' + a.emoji : ''})${a.skillCategory ? ' — role: ' + a.skillCategory : ''}`)
      .join('\n');
    yield {
      type: 'result',
      text: `Agent '${agent_id}' not found. Do NOT invent agent IDs. Retry with one of these real IDs:\n${roster || '  (no specialist agents configured)'}`,
    };
    return;
  }

  const agentName  = targetAgent.name  ?? agent_id;
  const agentEmoji = targetAgent.emoji ?? '🤖';

  // Enrich system prompt with date context (mirrors delegate/execute.mjs)
  const now = new Date();
  const todayStr   = now.toISOString().slice(0, 10);
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const yearStart  = `${now.getFullYear()}-01-01`;
  const financeExtra = (targetAgent.skillCategory === 'finance' || targetAgent.skillCategory === 'expenses')
    ? `\nUser ID: ${userId}\nAlways pass this exact User ID to every expense tool call.`
    : '';
  // Every coordinator delegation is ephemeral — fresh session per call, no prior
  // history loaded, nothing persisted back. Mirrors skills/delegate/execute.mjs
  // so both delegation paths behave identically. Direct user↔agent WS chat
  // bypasses this skill, so per-agent jsonl files stay persistent for direct chat.
  const delegId = `ephemeral_deleg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${agent_id}`;
  const scopedAgent = {
    ...targetAgent,
    id: delegId,
    ephemeral: true,
    systemPrompt: `${targetAgent.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}${financeExtra}`,
  };

  // Background dispatch — fire and forget, return immediately
  if (background || _parallel) {
    const { dispatchBackground } = await import('../../background-tasks.mjs');
    const taskId = dispatchBackground(scopedAgent, task, userId, agentId ?? `${userId}_${agent_id}`, agentName, agentEmoji);
    yield { type: 'result', text: `Dispatching ${agentName} in background (task ${taskId}).` };
    return;
  }

  const { streamChat } = await import('../../chat.mjs');

  let fullText = '';
  let mediaEvent = null;
  for await (const event of streamChat(scopedAgent, task, null, null, userId)) {
    if (event.type === 'token') { fullText += event.text; yield event; }
    else if (event.type === 'replace') { fullText = event.text; yield event; }
    else if (event.type === 'error') { yield { type: 'result', text: `Error from ${agentName}: ${event.message}` }; return; }
    else if (event.type === 'video' || event.type === 'image') { mediaEvent = event; yield event; }
  }
  if (!mediaEvent) yield { type: 'result', text: fullText.trim() || `${agentName} completed the task.` };
}
