// Shared settings/chat activation path. An enabled skill never grants access
// beyond the account's allowedSkills ceiling or removes hidden-tool choices.
import { getUser, getUserEnabledSkills, modifyUser, broadcastAgentList } from '../routes/_helpers.mjs';
import { getRoleManifest, isSkillRuntimeEnabledForUser, onRoleEnabled } from '../roles.mjs';
import { setSkillOverride } from './skill-overrides.mjs';

function denied(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function assertSkillToggleAllowed(authId, targetId, skillId, enabled, target = getUser(targetId)) {
  const actor = getUser(authId);
  if (!actor || !target) throw denied('User not found', 404);
  const privileged = actor.role === 'owner' || actor.role === 'admin';
  if (targetId !== authId && actor.role !== 'owner'
      && !(actor.role === 'admin' && ['user', 'child'].includes(target.role) && target.parentId === authId)) {
    throw denied('Forbidden', 403);
  }
  const manifest = getRoleManifest(skillId, targetId);
  if (!manifest || manifest.hidden) throw denied('Skill not found', 404);
  if (manifest.always_on && !enabled) throw denied('This skill is always on', 400);
  if (target.skillsLocked && targetId === authId && !privileged) {
    throw denied('Your skills are managed by an administrator', 403);
  }
  if (Array.isArray(target.allowedSkills) && !target.allowedSkills.includes(skillId)
      && target.role !== 'owner' && target.role !== 'admin') {
    throw denied('That skill is not permitted for your account', 403);
  }
  return manifest;
}

export async function setUserSkillEnabled(authId, targetId, skillId, enabled) {
  assertSkillToggleAllowed(authId, targetId, skillId, enabled);
  const wasEnabled = isSkillRuntimeEnabledForUser(skillId, targetId);
  const profile = getUser(targetId);
  const currentSeed = Array.isArray(profile?.skills) ? profile.skills : getUserEnabledSkills(targetId);
  // Commit the deny first when disabling; lift it last when enabling.
  if (!enabled) {
    const result = await setSkillOverride(targetId, skillId, { disabled: true });
    if (!result.ok) throw new Error(result.error || 'Could not update skill override');
  }
  const updated = await modifyUser(targetId, user => {
    assertSkillToggleAllowed(authId, targetId, skillId, enabled, user);
    const current = Array.isArray(user.skills) ? user.skills : currentSeed;
    user.skills = enabled ? [...new Set([...current, skillId])] : current.filter(id => id !== skillId);
  });
  if (enabled) {
    assertSkillToggleAllowed(authId, targetId, skillId, enabled);
    const result = await setSkillOverride(targetId, skillId, { disabled: false });
    if (!result.ok) throw new Error(result.error || 'Could not update skill override');
  }
  const effectiveEnabled = isSkillRuntimeEnabledForUser(skillId, targetId);
  broadcastAgentList();
  if (!wasEnabled && effectiveEnabled) onRoleEnabled(skillId, targetId).catch(() => {});
  return { skills: updated.skills ?? [], enabled: effectiveEnabled };
}
