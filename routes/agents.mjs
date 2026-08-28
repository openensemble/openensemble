/**
 * Agent routes: /api/agents CRUD, /api/agent-model/:id, /api/roles, /api/roles/toggle
 */

import fs   from 'fs';
import path from 'path';
import {
  requireAuth, requirePrivileged, getAuthToken, getSessionUserId, getUser,
  getUserRole, isPrivileged, loadUsers, loadConfig,
  modifyUsers, modifyUser, modifyConfig,
  agentToWire, readBody, getAgentsForUser, getUserEnabledSkills,
  saveUserAgentOverride, broadcastAgentList,
  getAgent, loadCustomAgents, updateAgentMeta, invalidateModelOverridesCache, listRoles,
  BASE_DIR,
} from './_helpers.mjs';
import {
  clearCustomAgentPrimaryRolesForRole,
  createCustomAgent,
  deleteCustomAgent,
  findDurablePrimaryRoleAgent,
  getCustomAgentRecord,
  updateCustomAgent,
  validatePrimarySkillCategory,
} from '../agents.mjs';
import {
  onRoleEnabled, getRoleAssignments, getDurableRoleAssignment,
  setRoleAssignment, clearRoleAssignmentsForAgent,
  getRoleManifest, addRoleManifest, removeRoleManifest, getRoleTools,
  isSkillRuntimeEnabledForUser,
} from '../roles.mjs';
import { EFFORT_VALUES, normalizeReasoningEffort, reasoningEffortOptions } from '../lib/reasoning-effort.mjs';
import {
  clearSkillOverride,
  getSkillExecutionOverride,
  setSkillOverride,
  setSkillExecutionOverride,
} from '../lib/skill-overrides.mjs';
import { isExecutionTextModel } from '../lib/skill-execution.mjs';
import { validateExecutionModelAccess } from '../lib/execution-model-policy.mjs';
import {
  tryAcquireUserTopologyTransition,
  runWithUserTopologyLease,
  finishUserTopologyTransition,
  rollbackUserTopologyTransition,
} from '../chat-dispatch/slot-registry.mjs';

function setRoleAssignmentForUser(roleId, agentId, userId) {
  return setRoleAssignment(roleId, agentId || null, userId);
}

function agentToEditorWire(agent, userId) {
  const raw = getCustomAgentRecord(agent?.id, userId);
  return {
    ...agentToWire(agent),
    // Never derive this field from the runtime/projected roster: in single
    // mode every effective role can point at the primary assistant.
    primarySkillCategory: raw?.skillCategory ?? null,
  };
}

function replacementDefaultForRole(roleId, userId, excludeAgentId = null) {
  return findDurablePrimaryRoleAgent(roleId, userId, { excludeAgentId })?.id ?? null;
}

function restoreRoleAssignment(roleId, agentId, userId) {
  if (roleId) setRoleAssignmentForUser(roleId, agentId, userId);
}

function visibleRoleForUser(userId, skillId) {
  const role = listRoles(userId, { includeDisabled: true })
    .find(item => item.id === skillId && !item.hidden);
  if (!role) return null;
  const user = getUser(userId);
  if (!isPrivileged(userId) && Array.isArray(user?.allowedSkills)
      && !user.allowedSkills.includes(skillId)) return null;
  return role;
}

function inheritedAgentForSkill(userId, skillId) {
  const agents = getAgentsForUser(userId);
  const assignments = getRoleAssignments(userId);
  const assignedId = assignments[skillId];
  const assigned = assignedId ? agents.find(agent => agent.id === assignedId) : null;
  if (assigned) return assigned;
  const coordinatorId = assignments.coordinator;
  return agents.find(agent => agent.id === coordinatorId) ?? agents[0] ?? null;
}

function cleanOptionalExecutionValue(value) {
  if (value == null || value === '') return null;
  return typeof value === 'string' ? value.trim() : value;
}

async function validateSkillExecution(userId, skillId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: 'Execution setting must be an object' };
  }
  const provider = cleanOptionalExecutionValue(body.provider);
  const model = cleanOptionalExecutionValue(body.model);
  const rawEffort = cleanOptionalExecutionValue(body.reasoningEffort);
  const reasoningEffort = typeof rawEffort === 'string' ? rawEffort.toLowerCase() : rawEffort;

  if ((provider == null) !== (model == null)) {
    return { status: 400, error: 'Provider and model must be selected or inherited together' };
  }
  if (provider != null && !isExecutionTextModel(provider, model)) {
    return { status: 400, error: 'That provider/model is not a valid text model' };
  }
  if (reasoningEffort != null && !EFFORT_VALUES.includes(reasoningEffort)) {
    return { status: 400, error: 'Invalid reasoning effort' };
  }

  if (provider != null) {
    const access = await validateExecutionModelAccess(userId, provider, model, { refreshCatalog: true });
    if (!access.ok) return { status: access.status ?? 400, error: access.error };
  }

  if (reasoningEffort != null) {
    const inherited = inheritedAgentForSkill(userId, skillId);
    const effectiveProvider = provider ?? inherited?.provider ?? '';
    const effectiveModel = model ?? inherited?.model ?? '';
    const supported = new Set(reasoningEffortOptions(effectiveProvider, effectiveModel).map(option => option.value));
    if (!supported.has(reasoningEffort)) {
      return {
        status: 400,
        error: `Reasoning effort "${reasoningEffort}" is not supported by ${effectiveModel || 'the inherited model'}`,
      };
    }
  }

  if (provider == null && reasoningEffort == null) return { execution: null };
  return {
    execution: {
      ...(provider == null ? {} : { provider, model }),
      ...(reasoningEffort == null ? {} : { reasoningEffort }),
    },
  };
}

export async function handle(req, res) {
  if (req.url.startsWith('/api/reasoning-efforts') && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('agent');
    const model = url.searchParams.get('model');
    const provider = url.searchParams.get('provider');
    const agent = agentId ? getAgentsForUser(authId).find(a => a.id === agentId) : null;
    const resolvedModel = model || agent?.model || '';
    const resolvedProvider = provider || agent?.provider || '';
    const current = normalizeReasoningEffort(agent?.reasoningEffort, 'auto');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: resolvedModel,
      provider: resolvedProvider,
      current,
      options: reasoningEffortOptions(resolvedProvider, resolvedModel),
    }));
    return true;
  }

  // Update an agent's model
  const agentModelMatch = req.url.match(/^\/api\/agent-model\/(\w+)$/);
  if (agentModelMatch && req.method === 'POST') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const { model, provider } = JSON.parse(await readBody(req));
      await updateAgentMeta(agentModelMatch[1], { model, provider });
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // List agents (auth required — unauthenticated calls used to leak the
  // global agent roster: names, models, providers)
  if (req.url === '/api/agents' && req.method === 'GET') {
    const callerUserId = requireAuth(req, res); if (!callerUserId) return true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAgentsForUser(callerUserId)
      .map(agent => agentToEditorWire(agent, callerUserId))));
    return true;
  }

  // Agent → full tool listing (read-only dashboard view). For each agent
  // returns EVERY tool in its resolved toolset, grouped by the skill that owns
  // it, plus a source label (primary / assigned / shared / always-on /
  // delegate). The list is the agent's already-resolved `.tools` — i.e. AFTER
  // the primary role's defaultToolIds allowlist — so it matches what the agent
  // actually carries before the per-turn router trims it (raw resolveAgentTools
  // would over-report for roles like coordinator/coder/email that curate
  // defaultToolIds).
  if (req.url === '/api/agent-skills' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const assignments   = getRoleAssignments(authId);
      const coordinatorId = assignments['coordinator'] ?? null;
      const agents        = getAgentsForUser(authId);
      const manifests     = listRoles(authId);
      const manById       = new Map(manifests.map(m => [m.id, m]));

      // tool name → owning skill id (mirrors agent-resolver's buildToolOwnerIndex).
      const toolOwner = Object.create(null);
      for (const m of manifests) {
        for (const t of (m.tools ?? [])) {
          const name = t.function?.name ?? t.name;
          if (name && !toolOwner[name]) toolOwner[name] = m.id;
        }
      }

      const SRC_RANK = { primary: 0, assigned: 1, bundled: 2, 'always-on': 3, shared: 4, delegate: 5, core: 6, other: 7 };

      const out = agents.map(a => {
        const isCoord = a.id === coordinatorId;
        const assignedHere = (id) => {
          const owner = assignments[id];
          return !!owner && (owner === a.id || (owner === 'coordinator' && isCoord));
        };
        const classify = (skillId) => {
          if (skillId && skillId === a.skillCategory) return 'primary';
          const m = skillId ? manById.get(skillId) : null;
          if (!m) return 'core';
          if (assignedHere(skillId)) return 'assigned';
          if (m.category === 'delegate') return 'delegate';
          if (m.category === 'utility' && !assignments[skillId]) return 'shared';
          if (m.always_on) return 'always-on';
          if (m.bundled_with_role) return 'bundled';
          return 'other';
        };

        const resolved = Array.isArray(a.tools) ? a.tools : [];
        // Group resolved tools by owning skill.
        const groupMap = new Map(); // skillId(or '__core') → {skillId, skillName, source, tools:[]}
        for (const t of resolved) {
          const name = t.function?.name ?? t.name;
          if (!name) continue;
          const desc = t.function?.description ?? t.description ?? '';
          const skillId = toolOwner[name] ?? null;
          const key = skillId ?? '__core';
          if (!groupMap.has(key)) {
            const m = skillId ? manById.get(skillId) : null;
            groupMap.set(key, {
              skillId,
              skillName: m?.name ?? (skillId ?? 'Always-on / core'),
              source: skillId ? classify(skillId) : 'core',
              tools: [],
            });
          }
          groupMap.get(key).tools.push({ name, description: desc });
        }
        const groups = [...groupMap.values()].sort((x, y) =>
          (SRC_RANK[x.source] ?? 9) - (SRC_RANK[y.source] ?? 9) || x.skillName.localeCompare(y.skillName));
        for (const g of groups) g.tools.sort((p, q) => p.name.localeCompare(q.name));

        // Dangling primary role (assigned skill whose manifest was deleted).
        const danglingPrimary = (a.skillCategory && a.skillCategory !== 'general' && !manById.has(a.skillCategory))
          ? a.skillCategory : null;

        return {
          id: a.id, name: a.name, emoji: a.emoji ?? '', model: a.model ?? '',
          role: a.skillCategory ?? null, isCoordinator: isCoord,
          totalTools: resolved.length, danglingPrimary, groups,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: out }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Create custom agent
  if (req.url === '/api/agents' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    let topologyTransition = null;
    let createdAgent = null;
    let previousRoleOwner = null;
    let previousCoordinatorOwner = null;
    let previousOrchestration;
    let hadPreviousOrchestration = false;
    try {
      // Per-user agent cap — guard against runaway creation from a compromised
      // or misbehaving account.
      const MAX_AGENTS_PER_USER = 50;
      const existing = loadCustomAgents().filter(a => a.ownerId === authId).length;
      if (existing >= MAX_AGENTS_PER_USER) {
        res.writeHead(429); res.end(JSON.stringify({ error: `Agent limit reached (${MAX_AGENTS_PER_USER}). Delete some before creating more.` })); return true;
      }
      let { name, emoji, description, model, provider, toolSet, skillCategory, systemPrompt, personality, maxTokens, contextSize, reasoningEffort } = JSON.parse(await readBody(req));
      reasoningEffort = normalizeReasoningEffort(reasoningEffort, 'auto');
      if (personality != null && (typeof personality !== 'string' || personality.length > 2000)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'personality must be a string of 2000 characters or fewer' })); return true;
      }
      if (contextSize != null) {
        contextSize = parseInt(contextSize, 10);
        if (!Number.isFinite(contextSize) || contextSize < 1024 || contextSize > 2_000_000) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'contextSize must be between 1024 and 2000000' })); return true;
        }
      }
      // Child accounts: clamp toolSet/skillCategory to a safe whitelist. A child cannot
      // create an agent that pulls in coder/nodes/email/admin tools via skillCategory.
      const caller = getUser(authId);
      previousCoordinatorOwner = getDurableRoleAssignment('coordinator', authId);
      hadPreviousOrchestration = Object.prototype.hasOwnProperty.call(caller ?? {}, 'orchestration');
      previousOrchestration = hadPreviousOrchestration
        ? JSON.parse(JSON.stringify(caller.orchestration))
        : undefined;
      if (caller?.role === 'child') {
        const CHILD_SAFE_TOOLSETS = ['web', null, undefined, ''];
        if (!CHILD_SAFE_TOOLSETS.includes(toolSet)) toolSet = 'web';
        // Child can't set a custom system prompt — it must use buildSystemPrompt
        // so the safety prefix and identity template apply cleanly. Personality
        // is prompt text too (same jailbreak-suffix vector), so it's clamped
        // under the same invariant: a child can't author prompt text.
        systemPrompt = undefined;
        personality = undefined;
      }
      const roleValidation = await validatePrimarySkillCategory(authId, skillCategory);
      if (!roleValidation.ok) {
        res.writeHead(roleValidation.status ?? 400);
        res.end(JSON.stringify({ error: roleValidation.error }));
        return true;
      }
      skillCategory = roleValidation.skillCategory;
      topologyTransition = tryAcquireUserTopologyTransition(authId);
      if (!topologyTransition) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Another reply or account setup change is active. Try again when it finishes.' }));
        return true;
      }
      const agent = await runWithUserTopologyLease(topologyTransition.lease, async () => {
        const { getRequestedOrchestrationPolicy, completePendingPrimary } = await import('../lib/orchestration-policy.mjs');
        const needsPrimaryCompletion = getRequestedOrchestrationPolicy(authId).pendingPrimary === true;
        const created = createCustomAgent({ name, emoji, description, model, provider, toolSet, skillCategory, systemPrompt, personality, maxTokens, contextSize, ownerId: authId });
        createdAgent = created;
        // reasoningEffort is account-specific: persist the creator's choice as a
        // per-user override rather than on the shared agent record.
        if (reasoningEffort !== 'auto') {
          await saveUserAgentOverride(authId, created.id, { reasoningEffort });
        }
        if (skillCategory) {
          previousRoleOwner = getDurableRoleAssignment(skillCategory, authId);
          // A durable category grants the role to every matching specialist.
          // The single routing default stays with its current owner; only the
          // first specialist claims an unowned default.
          if (!previousRoleOwner) {
            setRoleAssignment(skillCategory, created.id, authId);
          }
        }
        // New accounts request single mode before an agent exists. Primary
        // selection is part of this create transaction: returning success with
        // a still-pending policy lets a retry create a second agent and strands
        // onboarding permanently.
        if (needsPrimaryCompletion) {
          if (!(await completePendingPrimary(authId, created.id))) {
            throw new Error('Could not finish single-agent onboarding: pending primary was not completed');
          }
        }
        return created;
      });
      finishUserTopologyTransition(topologyTransition);
      topologyTransition = null;
      try { broadcastAgentList(); } catch (e) { console.warn('[agents] post-create roster broadcast failed:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agentToEditorWire({ ...agent, reasoningEffort }, authId)));
    } catch (e) {
      // Creation spans agents.json, profile/config assignments and an optional
      // per-user override. Compensate every durable write while the topology
      // writer is still held so a failed request cannot leave a ghost agent.
      if (createdAgent) {
        try { await deleteCustomAgent(createdAgent.id); } catch {}
        try { clearRoleAssignmentsForAgent(createdAgent.id, authId); } catch {}
        try { restoreRoleAssignment(createdAgent.skillCategory, previousRoleOwner, authId); } catch {}
        try { restoreRoleAssignment('coordinator', previousCoordinatorOwner, authId); } catch {}
        try {
          await modifyUser(authId, user => {
            if (user.agentOverrides) delete user.agentOverrides[createdAgent.id];
            if (hadPreviousOrchestration) user.orchestration = previousOrchestration;
            else delete user.orchestration;
          });
        } catch {}
      }
      res.writeHead(e?.code === 'ORCHESTRATION_BUSY' ? 409 : 400);
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      if (topologyTransition) rollbackUserTopologyTransition(topologyTransition);
    }
    return true;
  }

  // Update / delete agent
  const agentMatch = req.url.match(/^\/api\/agents\/([\w-]+)$/);
  if (agentMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    let topologyTransition = null;
    let roleMutation = null;
    let roleMutationStarted = false;
    try {
      const changes = JSON.parse(await readBody(req));
      // Existence check BEFORE any mutation — updateAgentMeta/saveUserAgentOverride
      // used to run first, so a PATCH against a garbage id wrote a global
      // agentModels entry (or a per-user override) into config before 404ing.
      if (!getAgent(agentMatch[1])) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return true;
      }
      const rawOwnedAgent = getCustomAgentRecord(agentMatch[1], authId);
      const uiChanges = {};
      const globalChanges = {};
      if (changes.name)     uiChanges.name     = changes.name;
      if (changes.emoji)    uiChanges.emoji    = changes.emoji;
      // `in` (not truthy check) so an empty string explicitly clears the
      // value — both fields are user-editable in the agent settings panel,
      // and a blank description should be saveable. Without these two
      // entries the PATCH silently dropped description/systemPrompt edits
      // and the UI would re-render the old value on next load, looking
      // like the change had "reverted".
      if ('description' in changes)  uiChanges.description  = changes.description;
      // Mirror the create-time child clamp: a child can't author prompt text.
      // Without this, PATCH stored a verbatim systemPrompt and broke the
      // invariant (the safety prefix still prepends, but jailbreak-suffix
      // text landed in the stored prompt).
      if ('systemPrompt' in changes && getUser(authId)?.role !== 'child') {
        uiChanges.systemPrompt = changes.systemPrompt;
      }
      // Personality: same child clamp as systemPrompt (it's prompt text).
      // `in` detection so an empty string explicitly clears it.
      if ('personality' in changes && getUser(authId)?.role !== 'child') {
        if (changes.personality != null && (typeof changes.personality !== 'string' || changes.personality.length > 2000)) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'personality must be a string of 2000 characters or fewer' })); return true;
        }
        uiChanges.personality = (changes.personality ?? '').trim();
      }
      // Role (primary skill category). Create-only until now, which is why
      // guide/roles.md's "change Role in the edit panel" did not work and why a
      // second Coder could only be made by stealing the assignment.
      if ('skillCategory' in changes) {
        // The role belongs to the agent record, not to a viewer. Editing it via
        // a per-user override would let a non-owner grant themselves a role's
        // tools on a shared agent, so require ownership outright.
        if (!rawOwnedAgent) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Only the agent owner can change its role.' }));
          return true;
        }
        const roleValidation = await validatePrimarySkillCategory(
          authId,
          changes.skillCategory,
          { currentSkillCategory: rawOwnedAgent.skillCategory ?? null },
        );
        if (!roleValidation.ok) {
          res.writeHead(roleValidation.status ?? 400);
          res.end(JSON.stringify({ error: roleValidation.error }));
          return true;
        }
        if (!roleValidation.unchanged) {
          const oldRole = rawOwnedAgent.skillCategory ?? null;
          const newRole = roleValidation.skillCategory;
          uiChanges.skillCategory = newRole;
          roleMutation = {
            oldRole,
            newRole,
            oldOwner: oldRole ? getDurableRoleAssignment(oldRole, authId) : null,
            newOwner: newRole ? getDurableRoleAssignment(newRole, authId) : null,
          };
        }
      }
      if (changes.model)     globalChanges.model     = changes.model;
      if (changes.provider)  globalChanges.provider  = changes.provider;
      // reasoningEffort is account-specific — always a per-user override, never
      // written to the shared agent record or global config. Handled separately
      // below so user A's "high" never changes user B's effort on the same agent.
      if ('maxTokens' in changes) globalChanges.maxTokens = changes.maxTokens ? parseInt(changes.maxTokens, 10) : null;
      if ('contextSize' in changes) {
        const cs = changes.contextSize ? parseInt(changes.contextSize, 10) : null;
        if (cs != null && (!Number.isFinite(cs) || cs < 1024 || cs > 2_000_000)) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'contextSize must be between 1024 and 2000000' })); return true;
        }
        globalChanges.contextSize = cs;
      }
      // Validate global-write authority before changing the durable primary;
      // otherwise a rejected model edit could still commit a role mutation.
      if (Object.keys(globalChanges).length) {
        const customRec = loadCustomAgents().find(a => a.id === agentMatch[1]);
        const ownsIt = Boolean(customRec && customRec.ownerId === authId);
        if (!ownsIt && !isPrivileged(authId)) {
          res.writeHead(403); res.end(JSON.stringify({ error: 'Not your agent' })); return true;
        }
      }
      if (roleMutation) {
        topologyTransition = tryAcquireUserTopologyTransition(authId);
        if (!topologyTransition) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'Another reply or account setup change is active. Try again when it finishes.' }));
          return true;
        }
      }

      const applyChanges = async () => {
        if (Object.keys(uiChanges).length) {
          if (rawOwnedAgent) {
            if (!updateCustomAgent(agentMatch[1], uiChanges)) {
              throw new Error('Agent disappeared before the update could be saved');
            }
            roleMutationStarted = Boolean(roleMutation);

            if (roleMutation) {
              const { oldRole, newRole, oldOwner, newOwner } = roleMutation;
              // Relinquish only an old default actually owned by this agent,
              // and keep it routed to another same-role specialist if one exists.
              if (oldRole && oldRole !== newRole && oldOwner === agentMatch[1]) {
                setRoleAssignmentForUser(
                  oldRole,
                  replacementDefaultForRole(oldRole, authId, agentMatch[1]),
                  authId,
                );
              }
              // Editing a durable category never steals an existing routing
              // default. The new specialist claims it only when it is vacant.
              if (newRole && !newOwner) {
                setRoleAssignmentForUser(newRole, agentMatch[1], authId);
              }
            }

          // Clear any stale per-user overrides for fields now canonical on the agent
            await modifyUser(authId, u => {
              if (u.agentOverrides?.[agentMatch[1]]) {
                for (const k of Object.keys(uiChanges)) delete u.agentOverrides[agentMatch[1]][k];
              }
            });
          } else {
            await saveUserAgentOverride(authId, agentMatch[1], uiChanges); // fire-and-forget made the change look reverted on a fast reload
          }
        }

        // Per-user reasoning effort: scoped to the calling account, applied over
        // the agent via getAgentsForUser's agentOverrides merge at chat time.
        if ('reasoningEffort' in changes) {
          await saveUserAgentOverride(authId, agentMatch[1], {
            reasoningEffort: normalizeReasoningEffort(changes.reasoningEffort, 'auto'),
          });
        }
        if (Object.keys(globalChanges).length) {
          await updateAgentMeta(agentMatch[1], globalChanges);
        }
      };
      if (topologyTransition) {
        await runWithUserTopologyLease(topologyTransition.lease, applyChanges);
        finishUserTopologyTransition(topologyTransition);
        topologyTransition = null;
        roleMutationStarted = false;
      } else {
        await applyChanges();
      }
      const base = getAgent(agentMatch[1]);
      if (!base) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return true; }
      const userOverrides = getUser(authId)?.agentOverrides?.[agentMatch[1]] ?? {};
      try { broadcastAgentList(); } catch (e) { console.warn('[agents] post-edit roster broadcast failed:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agentToEditorWire({ ...base, ...userOverrides }, authId)));
    } catch (e) {
      if (roleMutationStarted && roleMutation) {
        try { updateCustomAgent(agentMatch[1], { skillCategory: roleMutation.oldRole }); } catch {}
        try { restoreRoleAssignment(roleMutation.oldRole, roleMutation.oldOwner, authId); } catch {}
        if (roleMutation.newRole !== roleMutation.oldRole) {
          try { restoreRoleAssignment(roleMutation.newRole, roleMutation.newOwner, authId); } catch {}
        }
      }
      res.writeHead(e?.code === 'ORCHESTRATION_BUSY' ? 409 : 400);
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      if (topologyTransition) rollbackUserTopologyTransition(topologyTransition);
    }
    return true;
  }

  if (agentMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const ca = loadCustomAgents().find(a => a.id === agentMatch[1]);
    if (!ca) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found or not a custom agent' })); return true; }
    if (ca.ownerId && ca.ownerId !== authId) { res.writeHead(403); res.end(JSON.stringify({ error: 'Not your agent' })); return true; }
    const ownerId = ca.ownerId || authId;
    const topologyTransition = tryAcquireUserTopologyTransition(ownerId);
    if (!topologyTransition) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: 'This agent is handling active work. Wait for it to finish before deleting it.' }));
      return true;
    }
    let deletionCommitted = false;
    let topologyReleased = false;
    const cleanupWarnings = [];
    const warnCleanup = (label, error) => {
      const message = error?.message || String(error);
      cleanupWarnings.push(`${label}: ${message}`);
      console.warn(`[agents] ${label} after deleting "${agentMatch[1]}" failed:`, message);
    };
    const sendDeleteSuccess = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ...(cleanupWarnings.length ? { warnings: cleanupWarnings } : {}),
      }));
    };
    try {
      await runWithUserTopologyLease(topologyTransition.lease, async () => {
        const { getOrchestrationPolicy, handleAgentDeleted } = await import('../lib/orchestration-policy.mjs');
        const policy = getOrchestrationPolicy(ownerId);
        // A child's orchestration policy is parent-managed. Letting the child
        // delete its primary would indirectly change that policy.
        if (getUser(authId)?.role === 'child' && policy.primaryAgentId === agentMatch[1]) {
          const error = new Error('Your active agent is managed by your parent or administrator');
          error.code = 'ORCHESTRATION_MANAGED';
          throw error;
        }

        const { listActiveBackgroundWorkForAgent } = await import('../background-tasks.mjs');
        const active = listActiveBackgroundWorkForAgent(ownerId, agentMatch[1]);
        if (active.length) {
          const error = new Error(`Stop ${active.length} active background task${active.length === 1 ? '' : 's'} owned by this agent before deleting it.`);
          error.code = 'AGENT_BUSY';
          throw error;
        }

        const defaultRoleIds = listRoles(ownerId, { includeDisabled: true })
          .filter(role => getDurableRoleAssignment(role.id, ownerId) === agentMatch[1])
          .map(role => role.id);

        // Durable agent removal is the transaction's commit point. Every
        // destructive precheck above runs first, while topology cleanup below
        // is compensating repair. In particular, do not cancel watchers or
        // rewrite orchestration before this succeeds: an agents.json write
        // failure must leave the account exactly as it was.
        await deleteCustomAgent(agentMatch[1]);
        if (loadCustomAgents().some(agent => agent.id === agentMatch[1] && (agent.ownerId || authId) === ownerId)) {
          throw new Error('Agent record still exists after deletion');
        }
        deletionCommitted = true;

        // Repair a primary policy first. If the normal service fails, make one
        // direct best-effort repair while the writer is still held. Read-time
        // policy normalization is fail-safe even if both writes fail, and the
        // startup stamp will retry the durable repair.
        try {
          if (await handleAgentDeleted(ownerId, agentMatch[1])) {
            console.log(`[agents] single-mode primary ${agentMatch[1]} deleted — reverted ${ownerId} to ensemble`);
          }
        } catch (policyError) {
          try {
            await modifyUser(ownerId, user => {
              if (user?.orchestration?.primaryAgentId === agentMatch[1]) {
                user.orchestration = { mode: 'ensemble' };
              }
            });
            console.warn(`[agents] orchestration service cleanup failed for "${agentMatch[1]}"; direct repair succeeded:`, policyError?.message || policyError);
          } catch (fallbackError) {
            warnCleanup('orchestration cleanup', fallbackError);
          }
        }

        try {
          const removedAssignments = clearRoleAssignmentsForAgent(agentMatch[1], ownerId);
          if (removedAssignments > 0) console.log(`[agents] cleared ${removedAssignments} assignment(s) for deleted agent "${agentMatch[1]}"`);
        } catch (e) {
          warnCleanup('role-assignment cleanup', e);
        }
        for (const roleId of defaultRoleIds) {
          try {
            setRoleAssignmentForUser(
              roleId,
              replacementDefaultForRole(roleId, ownerId, agentMatch[1]),
              ownerId,
            );
          } catch (e) {
            warnCleanup(`role-default repair (${roleId})`, e);
          }
        }

        try {
          const { clearActiveProjectForAgent } = await import('../skills/coder/execute.mjs');
          clearActiveProjectForAgent(ownerId, agentMatch[1]);
        } catch (e) {
          warnCleanup('coder project-pointer cleanup', e);
        }

        // Persisted watchers are part of the deleted agent's topology. Cancel
        // them after the commit while the writer still prevents a new tick
        // from starting against the old id.
        try {
          const { unregisterMatchingWatchers } = await import('../scheduler/watchers.mjs');
          const scopedId = `${ownerId}_${agentMatch[1]}`;
          unregisterMatchingWatchers(ownerId,
            watcher => watcher?.agentId === agentMatch[1] || watcher?.agentId === scopedId,
            'agent_deleted');
        } catch (e) {
          warnCleanup('watcher cleanup', e);
        }

        // Cascade-delete the owner's aliases. HTTP deletions do not pass
        // through tool dispatch, so manifest cascade_on_tools cannot fire.
        try {
          const { deleteAliasesByEntityId } = await import('../lib/skill-alias-framework.mjs');
          const removed = deleteAliasesByEntityId(ownerId, 'agent', agentMatch[1]);
          if (removed > 0) console.log(`[agents] dropped ${removed} agent alias(es) for "${agentMatch[1]}"`);
        } catch (e) { warnCleanup('alias cleanup', e); }
      });
      finishUserTopologyTransition(topologyTransition);
      topologyReleased = true;
      try { broadcastAgentList(); } catch (e) { warnCleanup('roster broadcast', e); }
      sendDeleteSuccess();
    } catch (e) {
      if (!topologyReleased) rollbackUserTopologyTransition(topologyTransition);
      // No post-commit exception should turn a successful durable deletion
      // into a 500 that tells the caller the agent still exists. Keep this
      // guard for failures outside the individually protected cascades.
      if (deletionCommitted) {
        warnCleanup('post-delete cleanup', e);
        try { broadcastAgentList(); } catch (broadcastError) { warnCleanup('roster broadcast', broadcastError); }
        sendDeleteSuccess();
        return true;
      }
      const status = e?.code === 'ORCHESTRATION_MANAGED' ? 403
        : (e?.code === 'AGENT_BUSY' || e?.code === 'ORCHESTRATION_BUSY' ? 409 : 500);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
    return true;
  }

  // Roles (formerly skills) — auth-gated: leaks the full tool catalog otherwise
  if (req.url === '/api/roles' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const userSkills = getUserEnabledSkills(authId);
    const assignments = getRoleAssignments(authId);
    const priv = isPrivileged(authId);
    let roleList = listRoles(authId, { includeDisabled: true }).filter(s => !s.hidden);
    if (!priv) {
      const currentUser = loadUsers().find(u => u.id === authId);
      if (currentUser?.allowedSkills != null) {
        roleList = roleList.filter(s => currentUser.allowedSkills.includes(s.id));
      }
    }
    const roles = roleList.map(s => ({
      ...s,
      enabled: !s.disabledByOverride && (s.always_on === true || userSkills.includes(s.id)),
      assignment: assignments[s.id] ?? null,
      // The server resolves an unassigned skill through the coordinator (then
      // roster fallback), not whichever chat tab happens to be active. Surface
      // that exact answer so effort capability options match save validation.
      inheritedAgentId: inheritedAgentForSkill(authId, s.id)?.id ?? null,
      execution: getSkillExecutionOverride(authId, s.id),
      // Portable auto tier/effort from the skill manifest (not a model pin).
      execution_hint: s.execution_hint && typeof s.execution_hint === 'object'
        ? s.execution_hint
        : null,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(roles)); return true;
  }

  const roleExecutionMatch = req.url.match(/^\/api\/roles\/([^/?]+)\/execution$/);
  if (roleExecutionMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const skillId = decodeURIComponent(roleExecutionMatch[1]);
    if (!visibleRoleForUser(authId, skillId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Role or skill not found' }));
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const validated = await validateSkillExecution(authId, skillId, body);
      if (validated.error) {
        res.writeHead(validated.status ?? 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: validated.error }));
        return true;
      }
      const result = await setSkillExecutionOverride(authId, skillId, validated.execution);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error || 'Could not save execution setting' }));
        return true;
      }
      const execution = getSkillExecutionOverride(authId, skillId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, execution }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  if (req.url === '/api/roles/assign' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    let topologyTransition = null;
    let primaryBackfill = null;
    let primaryBackfillStarted = false;
    let oldAssignment = null;
    let assignmentRoleId = null;
    try {
      const { skillId, agentId } = JSON.parse(await readBody(req));
      if (typeof skillId !== 'string' || !skillId.trim() || skillId.length > 128) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'A valid skillId is required' })); return true;
      }
      if (agentId != null && (typeof agentId !== 'string' || !agentId)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'agentId must be a non-empty string or null' })); return true;
      }
      const roleId = skillId.trim();
      assignmentRoleId = roleId;
      const role = visibleRoleForUser(authId, roleId);
      if (!role || role.category === 'delegate') {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Role or skill not found' })); return true;
      }
      if (agentId != null && !isSkillRuntimeEnabledForUser(roleId, authId)) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'That role or skill is disabled for this account' })); return true;
      }
      const targetAgent = agentId == null ? null : getCustomAgentRecord(agentId, authId);
      if (agentId != null && !targetAgent) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'You can only assign roles to agents you own' })); return true;
      }

      topologyTransition = tryAcquireUserTopologyTransition(authId);
      if (!topologyTransition) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Another reply or account setup change is active. Try again when it finishes.' }));
        return true;
      }
      oldAssignment = getDurableRoleAssignment(roleId, authId);
      const assignmentUser = getUser(authId);
      if (!isPrivileged(authId) && assignmentUser?.skillsLocked
          && oldAssignment !== (agentId ?? null)) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Your tools are managed by an administrator' })); return true;
      }
      if (targetAgent && role.service) {
        const currentPrimary = targetAgent.skillCategory ?? null;
        const currentPrimaryManifest = currentPrimary
          ? getRoleManifest(currentPrimary, authId)
          : null;
        const needsBackfill = !currentPrimary
          || currentPrimary === 'general'
          || !currentPrimaryManifest;
        if (oldAssignment === targetAgent.id && !needsBackfill) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, assignment: oldAssignment }));
          return true;
        }
        // Service assignments obey the same child/lock/allow/enable policy as
        // a durable primary, even when an existing different primary means this
        // assignment remains secondary.
        const policy = await validatePrimarySkillCategory(
          authId,
          roleId,
          { currentSkillCategory: targetAgent.skillCategory ?? null, allowUnchanged: false },
        );
        if (!policy.ok) {
          res.writeHead(policy.status ?? 400); res.end(JSON.stringify({ error: policy.error })); return true;
        }
        if (needsBackfill) {
          primaryBackfill = { agentId: targetAgent.id, oldRole: currentPrimary, newRole: roleId };
        }
      }

      // A pure no-op leaves the durable files untouched. The short-lived
      // topology lease above makes this decision against a stable snapshot.
      if (oldAssignment === (agentId ?? null) && !primaryBackfill) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, assignment: oldAssignment }));
        return true;
      }
      const assignment = await runWithUserTopologyLease(topologyTransition.lease, async () => {
        if (primaryBackfill) {
          if (!updateCustomAgent(primaryBackfill.agentId, { skillCategory: primaryBackfill.newRole })) {
            throw new Error('Agent disappeared before its primary role could be saved');
          }
          primaryBackfillStarted = true;
        }
        // Explicit drawer/API unassignment is a user choice and remains null.
        // Automatic replacement is reserved for lifecycle loss (primary role
        // change or agent deletion), where the old default disappears.
        const nextAssignment = agentId ?? null;
        setRoleAssignmentForUser(roleId, nextAssignment, authId);
        return nextAssignment;
      });
      finishUserTopologyTransition(topologyTransition);
      topologyTransition = null;
      primaryBackfillStarted = false;
      try { broadcastAgentList(); } catch (e) { console.warn('[roles] post-assignment roster broadcast failed:', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, assignment }));
    } catch (e) {
      if (primaryBackfillStarted && primaryBackfill) {
        try { updateCustomAgent(primaryBackfill.agentId, { skillCategory: primaryBackfill.oldRole }); } catch {}
      }
      if (topologyTransition) {
        try { restoreRoleAssignment(assignmentRoleId, oldAssignment, authId); } catch {}
      }
      res.writeHead(e?.code === 'ORCHESTRATION_BUSY' ? 409 : 400);
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      if (topologyTransition) rollbackUserTopologyTransition(topologyTransition);
    }
    return true;
  }

  if (req.url === '/api/roles/toggle' && req.method === 'POST') {
    const authId = requireAuth(req, res, { allowMediaToken: false }); if (!authId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const { skillId, enabled, userId: requestedTargetId } = body || {};
      if (typeof skillId !== 'string' || !skillId.trim() || skillId.length > 128) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'A valid skillId is required' })); return true;
      }
      if (typeof enabled !== 'boolean') {
        res.writeHead(400); res.end(JSON.stringify({ error: 'enabled must be a boolean' })); return true;
      }
      if (requestedTargetId !== undefined
          && (typeof requestedTargetId !== 'string' || !requestedTargetId)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'userId must be a non-empty string' })); return true;
      }
      const targetId = requestedTargetId || authId;
      const authRole = getUserRole(authId);

      // Users can mutate only themselves. Admins may manage only ordinary
      // accounts they created; the owner remains the installation-wide
      // authority. This mirrors /api/users/:id instead of treating every
      // privileged account as globally omnipotent.
      const snap = loadUsers();
      const snapIdx = snap.findIndex(u => u.id === targetId);
      if (snapIdx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'User not found' })); return true; }
      const target = snap[snapIdx];
      if (targetId !== authId) {
        const adminCanManage = authRole === 'admin'
          && (target.role === 'user' || target.role === 'child')
          && target.parentId === authId;
        if (authRole !== 'owner' && !adminCanManage) {
          res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true;
        }
      }

      const manifest = getRoleManifest(skillId, targetId);
      if (!manifest || manifest.hidden) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Tool not found' })); return true;
      }
      if (manifest.always_on && !enabled) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'This tool is always on' })); return true;
      }
      if (target.skillsLocked && targetId === authId && !isPrivileged(authId)) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Your tools are managed by an administrator' })); return true;
      }
      if (Array.isArray(target.allowedSkills)
          && !target.allowedSkills.includes(skillId)
          && target.role !== 'owner' && target.role !== 'admin') {
        res.writeHead(403); res.end(JSON.stringify({ error: 'That tool is not permitted for your account' })); return true;
      }

      const wasEnabled = isSkillRuntimeEnabledForUser(skillId, targetId);
      // The disabled override is authoritative for default/bundled sources,
      // while profile.skills is the explicit activation source. Keep both in
      // sync so toggling works for every non-always-on skill and can undo a
      // prior advanced override without erasing hidden-tool/execution choices.
      const currentSeed = Array.isArray(target.skills)
        ? target.skills
        : getUserEnabledSkills(targetId);
      // Enabling commits the profile source before lifting the deny override;
      // disabling commits the deny first. A second-write failure therefore
      // always fails closed and a retry converges the two stores.
      if (!enabled) {
        const overrideResult = await setSkillOverride(targetId, skillId, { disabled: true });
        if (!overrideResult.ok) throw new Error(overrideResult.error || 'Could not update tool override');
      }
      const updatedSkills = await modifyUser(targetId, u => {
        const current = Array.isArray(u.skills) ? u.skills : currentSeed;
        u.skills = enabled
          ? [...new Set([...current, skillId])]
          : current.filter(s => s !== skillId);
      }).then(u => u?.skills ?? null);
      if (enabled) {
        const overrideResult = await setSkillOverride(targetId, skillId, { disabled: false });
        if (!overrideResult.ok) throw new Error(overrideResult.error || 'Could not update tool override');
      }
      const effectiveEnabled = isSkillRuntimeEnabledForUser(skillId, targetId);
      broadcastAgentList();
      if (!wasEnabled && effectiveEnabled) onRoleEnabled(skillId, targetId).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ skills: updatedSkills ?? [], enabled: effectiveEnabled }));
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
      // Path-safety: the id comes from the URL and is matched against a
      // manifest whose own `id` field is attacker-influenceable data — never
      // let it traverse out of skills/ into an rmSync.
      if (!/^[\w][\w.-]*$/.test(id) || id.includes('..')) throw new Error('Invalid role id');
      const manifest = getRoleManifest(id);
      if (!manifest) throw new Error('Role not found');
      if (!manifest.service) throw new Error('Cannot delete tools, only roles');
      const skillDir = path.join(BASE_DIR, 'skills', id);
      fs.rmSync(skillDir, { recursive: true, force: true });
      removeRoleManifest(id);
      clearCustomAgentPrimaryRolesForRole(id);
      await modifyConfig(cfg => { if (cfg.skillAssignments) delete cfg.skillAssignments[id]; });
      // Cascade per-user assignments too — stale profile.skillAssignments
      // entries kept pointing at the deleted role.
      try {
        const { loadUsers, modifyUser } = await import('./_helpers.mjs');
        for (const u of loadUsers()) {
          if (u.skillAssignments && id in u.skillAssignments) {
            await modifyUser(u.id, p => { if (p.skillAssignments) delete p.skillAssignments[id]; });
          }
          await clearSkillOverride(u.id, id).catch(() => {});
        }
      } catch (e) { console.warn('[roles] per-user assignment cascade failed:', e.message); }
      broadcastAgentList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  return false;
}
