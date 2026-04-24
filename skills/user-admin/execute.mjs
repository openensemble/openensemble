import { loadUsers, modifyUser, getUser, hashPassword, validatePassword, clearUserSessions } from '../../routes/_helpers.mjs';

export async function executeSkillTool(name, args, userId) {
  const caller = getUser(userId);
  if (!caller || (caller.role !== 'owner' && caller.role !== 'admin')) {
    return 'This action requires admin or owner privileges.';
  }

  if (name === 'list_users') {
    const users = loadUsers();
    return users.map(u => {
      const parts = [`${u.emoji ?? '🧑'} ${u.name} (${u.role})`];
      if (u.locked) parts.push('🔒 LOCKED');
      if (u.accessSchedule) parts.push(`⏰ Blocked ${u.accessSchedule.blockedFrom}–${u.accessSchedule.blockedUntil}`);
      return parts.join(' — ');
    }).join('\n');
  }

  if (name === 'manage_user') {
    const { user_name, action, blocked_from, blocked_until, new_password } = args;

    // Find target user by name (case-insensitive)
    const users = loadUsers();
    const target = users.find(u => u.name.toLowerCase() === user_name.toLowerCase());
    if (!target) return `User "${user_name}" not found. Available users: ${users.map(u => u.name).join(', ')}`;

    // Prevent modifying the owner account
    if (target.role === 'owner') return 'Cannot modify the owner account.';

    // Admin scope: admins can only manage users they created
    if (caller.role === 'admin' && target.parentId !== userId) {
      return 'You can only manage accounts you created.';
    }

    const targetId = target.id;

    switch (action) {
      case 'lock': {
        await modifyUser(targetId, u => { u.locked = true; });
        clearUserSessions(targetId);
        return `${target.name}'s account has been locked. They have been logged out and cannot sign in until unlocked.`;
      }

      case 'unlock': {
        await modifyUser(targetId, u => { u.locked = false; });
        return `${target.name}'s account has been unlocked. They can now sign in.`;
      }

      case 'set_schedule': {
        if (!blocked_from || !blocked_until) return 'Both blocked_from and blocked_until are required (HH:MM format).';
        if (!/^\d{2}:\d{2}$/.test(blocked_from) || !/^\d{2}:\d{2}$/.test(blocked_until)) {
          return 'Times must be in HH:MM format (e.g. "20:00", "08:00").';
        }
        await modifyUser(targetId, u => { u.accessSchedule = { blockedFrom: blocked_from, blockedUntil: blocked_until }; });
        return `Access schedule set for ${target.name}: blocked from ${blocked_from} to ${blocked_until}. They will not be able to log in during those hours.`;
      }

      case 'clear_schedule': {
        await modifyUser(targetId, u => { delete u.accessSchedule; });
        return `Access schedule cleared for ${target.name}. No time restrictions.`;
      }

      case 'reset_password': {
        const pwErr = validatePassword(new_password);
        if (pwErr) return pwErr;
        const passwordHash = await hashPassword(new_password);
        await modifyUser(targetId, u => { u.passwordHash = passwordHash; });
        clearUserSessions(targetId);
        return `Password has been reset for ${target.name}. They have been logged out and will need to use the new password.`;
      }

      default:
        return `Unknown action "${action}". Valid actions: lock, unlock, set_schedule, clear_schedule, reset_password.`;
    }
  }

  return null;
}

export default executeSkillTool;
