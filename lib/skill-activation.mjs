// A model can request activation, but only a subsequent real user approval
// can consume this conversation-scoped request and change enabled skills.
import { stagePending, getPending, takePending, clearPendingFor } from './pending-approvals.mjs';
import { getTurn, getTurnRestartContext } from './turn-trace-context.mjs';

export const SKILL_ACTIVATION_PHRASE = 'ENABLE SKILL';
const KIND = 'skill_activation';

export function getPendingSkillActivation(userId, agentId) {
  return getPending(userId, KIND, agentId);
}

export function clearPendingSkillActivation(userId, agentId, expectedOpId = null) {
  return clearPendingFor(userId, KIND, agentId, { expectedOpId });
}

export async function findDisabledSkillRequirements({ userId, agentId, reason = '', groups = [] }) {
  const { listRoles, isSkillRuntimeEnabledForUser } = await import('../roles.mjs');
  const catalog = listRoles(userId, { includeDisabled: true }).filter(m => !m.hidden && !m.always_on);
  const explicit = new Set(Array.isArray(groups) ? groups.filter(g => typeof g === 'string') : []);
  const explicitMatches = catalog.filter(m => explicit.has(m.id)
    || m.tools?.some(t => explicit.has(t.function?.name)));
  let candidates = explicitMatches;
  if (!candidates.length && reason) {
    const { inferMissingToolSkills } = await import('./tool-router.mjs');
    const inferred = inferMissingToolSkills({ userText: reason, userId });
    const words = new Set(String(reason).toLowerCase().match(/[a-z0-9_.:-]+/g) || []);
    const phrase = ` ${String(reason).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
    candidates = catalog.filter(m => inferred.has(m.id) || words.has(m.id.toLowerCase())
      || ((m.custom || m.userScope === userId) && m.name?.length >= 4
        && phrase.includes(` ${m.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `))
      || m.tools?.some(t => words.has(t.function?.name?.toLowerCase())));
  }
  return candidates.filter(m => !isSkillRuntimeEnabledForUser(m.id, userId, agentId)).map(m => m.id);
}

export async function requestSkillActivation({ userId, agentId, skillIds, task = '', background = false }) {
  if (!skillIds?.length) return null;
  const { assertSkillToggleAllowed } = await import('./skill-enablement.mjs');
  const { getRoleManifest } = await import('../roles.mjs');
  const ids = [...new Set(skillIds)].slice(0, 8);
  const names = ids.map(id => getRoleManifest(id, userId)?.name || id);
  for (const id of ids) {
    try { assertSkillToggleAllowed(userId, userId, id, true); }
    catch (error) {
      return { text: `${names.join(', ')} is not enabled. ${error.message}. Ask the account administrator to enable access before continuing.`, blocked: true };
    }
  }
  const turn = getTurn();
  if (background || !turn?.agentId || turn.userId !== userId || turn.source === 'background') {
    return { text: `${names.join(', ')} is not enabled. Return this blocker to the user's assistant so it can ask permission to enable the skill and resume the task. Do not enable it from background work.`, blocked: true };
  }
  const originalTask = String(getTurnRestartContext()?.text || task || '').trim().slice(0, 12000);
  const existing = getPendingSkillActivation(userId, turn.agentId);
  if (!existing || JSON.stringify(existing.skillIds) !== JSON.stringify(ids) || existing.task !== originalTask) {
    stagePending(userId, KIND, { skillIds: ids, names, task: originalTask });
  }
  return {
    text: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not enabled. Ask the user: “Would you like me to enable ${names.join(', ')} and continue?” Wait for their reply or the Enable button. Nothing has been enabled. Do not call other tools to bypass this choice.`,
    pending: true,
  };
}

export async function isSkillActivationAllowed(userId, pending) {
  const { assertSkillToggleAllowed } = await import('./skill-enablement.mjs');
  if (!Array.isArray(pending?.skillIds) || !pending.skillIds.length || pending.skillIds.length > 8) return false;
  try {
    for (const id of pending.skillIds) assertSkillToggleAllowed(userId, userId, id, true);
    return true;
  } catch { return false; }
}

export async function executePendingSkillActivation(userId, agentId, expectedOpId = null) {
  const pending = takePending(userId, KIND, agentId, { expectedOpId });
  if (!pending) return { text: 'That skill activation is no longer pending. Nothing was enabled.' };
  if (!await isSkillActivationAllowed(userId, pending)) {
    return { text: 'That skill activation is no longer permitted for your account. Ask your administrator for access.' };
  }
  const { setUserSkillEnabled } = await import('./skill-enablement.mjs');
  const { getRoleManifest, getDurableRoleAssignment, setRoleAssignment } = await import('../roles.mjs');
  const { getAgentsForUser, broadcastAgentList } = await import('../routes/_helpers.mjs');
  const enabled = [];
  try {
    for (const id of pending.skillIds) {
      const result = await setUserSkillEnabled(userId, userId, id, true);
      if (!result.enabled) throw new Error(`Could not enable ${id}`);
      enabled.push(id);
      // Custom skills require one durable owner. Preserve an existing owner;
      // an unassigned skill the user just approved belongs to this assistant.
      const manifest = getRoleManifest(id, userId);
      if ((manifest?.custom || manifest?.createdBy === userId) && !getDurableRoleAssignment(id, userId)) {
        const bareAgentId = agentId?.startsWith(`${userId}_`) ? agentId.slice(userId.length + 1) : agentId;
        if (getAgentsForUser(userId).some(agent => agent.id === bareAgentId)) {
          setRoleAssignment(id, bareAgentId, userId);
          broadcastAgentList();
        }
      }
    }
  } catch (error) {
    return { text: `Could not finish enabling the required skills: ${error.message}.${enabled.length ? ` Already enabled: ${enabled.join(', ')}.` : ''}` };
  }
  return {
    text: `Enabled ${pending.names.join(', ')}.${pending.task ? ' Continuing your request.' : ''}`,
    followupPrompt: pending.task
      ? `${pending.task}\n\n[The user approved enabling ${pending.names.join(', ')}. The server has enabled it. Continue the original request above using the conversation history; preserve completed work and do not repeat completed actions. Check remaining setup with tools; enabling a skill does not configure provider credentials.]`
      : null,
  };
}
