import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import { SKILLS_DIR, USERS_DIR, userSkillsDir } from '../../lib/paths.mjs';
import { PLUGINS_DIR, registerDrawerManifest, unregisterDrawerManifest } from '../../plugins.mjs';

const BLUEPRINT = path.join(SKILLS_DIR, 'SKILL_BLUEPRINT.md');

// ── Profile helpers ───────────────────────────────────────────────────────────

function getProfilePath(userId) { return path.join(USERS_DIR, userId, 'profile.json'); }

function loadProfile(userId) {
  try { return JSON.parse(readFileSync(getProfilePath(userId), 'utf8')); } catch { return null; }
}

function saveProfile(user) {
  writeFileSync(getProfilePath(user.id), JSON.stringify(user, null, 2));
}

function isPrivileged(userId) {
  const u = loadProfile(userId);
  return u?.role === 'owner' || u?.role === 'admin';
}

async function modifyProfile(userId, fn) {
  const { withLock } = await import('../../routes/_helpers.mjs');
  return withLock(getProfilePath(userId), () => {
    const user = loadProfile(userId);
    if (!user) throw new Error(`User ${userId} not found`);
    fn(user);
    saveProfile(user);
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(id)) {
    return 'id must be lowercase letters, numbers, and hyphens only';
  }
  if (id.length > 40) return 'id must be 40 chars or fewer';
  return null;
}

// Try-import the executor and run two behavioural checks:
//   1. Unknown tool name → must return null (not throw, not return object)
//   2. First declared tool name → must return a string (not object, not undefined)
// Returns error string on failure, null on success.
async function validateExecutor(skillDir, toolNames = []) {
  const execPath = path.join(skillDir, 'execute.mjs');
  const url = pathToFileURL(execPath).href + `?validate=${Date.now()}`;
  try {
    const mod = await import(url);
    const fn = mod.default ?? mod.executeSkillTool;
    if (typeof fn !== 'function') {
      return 'execute.mjs must export executeSkillTool as a named or default export';
    }

    // Check 0: must declare exactly 4 parameters (name, args, userId, agentId)
    if (fn.length !== 4) {
      return `executeSkillTool must declare exactly 4 parameters (name, args, userId, agentId) but yours declares ${fn.length}. Copy the signature from the blueprint exactly.`;
    }

    // Check 1: unknown tool name must return null
    let unknownResult;
    try { unknownResult = await fn('__unknown_tool_check__', {}, 'test', null); }
    catch (e) { return `Function throws on unknown tool name — it must return null instead: ${e.message}`; }
    if (unknownResult !== null && unknownResult !== undefined) {
      return `Function returned ${JSON.stringify(unknownResult)} for an unknown tool name but must return null. Check your if/else logic — the final fallthrough must be "return null".`;
    }

    // Check 2: first real tool name must return a string (not an object, not undefined)
    if (toolNames.length > 0) {
      let realResult;
      try { realResult = await fn(toolNames[0], {}, 'test', null); }
      catch (_) { realResult = null; } // network errors etc. are acceptable
      if (realResult !== null && realResult !== undefined && typeof realResult !== 'string') {
        return `Function returned a ${typeof realResult} (${JSON.stringify(realResult).slice(0, 80)}) for tool "${toolNames[0]}" but must return a plain string or null. Do not return objects — return a formatted string instead.`;
      }
    }

    return null;
  } catch (e) {
    return e.message;
  }
}

// ── Drawer helpers ────────────────────────────────────────────────────────────

// Build a globally-unique drawer plugin id from (userId, skillId).
// Stored flat in plugins/ so the id must not collide across users.
function drawerPluginIdFor(userId, skillId) {
  const shortUser = userId.replace(/^user_/, '');
  return `usr_${shortUser}_${skillId}`;
}

function safeDomSuffix(s) { return s.replace(/[^a-zA-Z0-9]/g, '_'); }
function drawerDomIdFor(pluginId) { return 'drawer_' + safeDomSuffix(pluginId); }
function drawerBtnIdFor(pluginId) { return 'sbtn_'   + safeDomSuffix(pluginId); }

// Build and persist a drawer plugin. Returns null on success, or an error string.
async function createDrawerForSkill(pluginId, skillName, skillIcon, userId, skillId, drawer) {
  if (!drawer || typeof drawer !== 'object') return null;
  const { name, icon, lucideIcon, html, initJs, serverCode } = drawer;
  if (!html?.trim()) return 'drawer.html is required when a drawer is provided.';

  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  if (existsSync(pluginDir)) {
    return `Plugin directory "${pluginId}" already exists — refusing to overwrite.`;
  }

  const manifest = {
    id:                 pluginId,
    name:               (name ?? skillName).trim(),
    icon:               (icon ?? skillIcon ?? '🔧').trim(),
    lucideIcon:         typeof lucideIcon === 'string' && lucideIcon.trim() ? lucideIcon.trim() : undefined,
    description:        `Drawer for skill ${skillName}`,
    version:            '1.0.0',
    drawer:             true,
    drawerId:           drawerDomIdFor(pluginId),
    btnId:              drawerBtnIdFor(pluginId),
    enabled_by_default: true,
    custom:             true,
    createdBy:          userId,
    createdAt:          new Date().toISOString(),
    skillId,
    html,
    initJs:             initJs ?? '',
  };
  if (!manifest.lucideIcon) delete manifest.lucideIcon;

  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (serverCode?.trim()) {
    if (!serverCode.includes('handleRequest')) {
      rmSync(pluginDir, { recursive: true, force: true });
      return 'drawer.serverCode must export async function handleRequest(req, res, cfg).';
    }
    writeFileSync(path.join(pluginDir, 'server.mjs'), serverCode);

    // Sanity-import the server module so we catch syntax errors early.
    try {
      const url = pathToFileURL(path.join(pluginDir, 'server.mjs')).href + `?validate=${Date.now()}`;
      const mod = await import(url);
      if (typeof mod.handleRequest !== 'function') {
        rmSync(pluginDir, { recursive: true, force: true });
        return 'drawer.serverCode must export a function named handleRequest.';
      }
    } catch (e) {
      rmSync(pluginDir, { recursive: true, force: true });
      return `drawer.serverCode failed to load: ${e.message}`;
    }
  }

  registerDrawerManifest(manifest);
  return null;
}

function removeDrawerForSkill(userId, skillId) {
  const pluginId  = drawerPluginIdFor(userId, skillId);
  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
  unregisterDrawerManifest(pluginId);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleReadBlueprint() {
  try { return readFileSync(BLUEPRINT, 'utf8'); }
  catch { return `Blueprint not found at ${BLUEPRINT}`; }
}

async function handleCreate(args, userId) {
  const { id: rawId, name, description, icon, tools, code, drawer } = args;

  if (!rawId?.trim()) return 'id is required.';
  if (!name?.trim())  return 'name is required.';
  if (!description?.trim()) return 'description is required.';
  if (!Array.isArray(tools) || !tools.length) return 'tools must be a non-empty array.';
  if (!code?.trim()) return 'code is required.';

  const idErr = validateId(rawId.trim());
  if (idErr) return `Invalid id: ${idErr}`;

  if (!code.includes('executeSkillTool')) {
    return 'code must export executeSkillTool. Did you read the blueprint?';
  }

  const skillId  = rawId.trim();
  const skillDir = path.join(userSkillsDir(userId), skillId);

  const { getRoleManifest, listRoles, addRoleManifest, removeRoleManifest } = await import('../../roles.mjs');

  if (existsSync(skillDir) || getRoleManifest(skillId, userId)) {
    return `Skill "${skillId}" already exists. Use skill_update_code to modify it, or choose a different id.`;
  }

  // Tool name collision check — scoped to what this user can already see.
  // Other users' custom skills are unreachable from this session so collisions don't matter.
  const existingNames = new Set(
    listRoles(userId).flatMap(m => (m.tools ?? []).map(t => t.function?.name)).filter(Boolean)
  );
  const newNames = tools.map(t => t.function?.name).filter(Boolean);
  const collisions = newNames.filter(n => existingNames.has(n));
  if (collisions.length) {
    return `Tool name collision: ${collisions.join(', ')} already exist in another skill. Use unique prefixed names.`;
  }

  const manifest = {
    id: skillId,
    name: name.trim(),
    description: description.trim(),
    icon: icon?.trim() || '🔧',
    category: 'utility',
    always_on: false,
    enabled_by_default: false,
    custom: true,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    tools,
  };

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(skillDir, 'execute.mjs'), code);

  // Validate the code by trying to import it — catch syntax/export errors and signature issues
  const importErr = await validateExecutor(skillDir, newNames);
  if (importErr) {
    rmSync(skillDir, { recursive: true, force: true });
    return `Skill code has an error — files removed. Fix the issue and try again:\n\n${importErr}`;
  }

  addRoleManifest(manifest, userId);

  await modifyProfile(userId, user => {
    user.skills = user.skills ?? [];
    if (!user.skills.includes(skillId)) user.skills.push(skillId);
  });

  // Optional drawer — rolled back on failure so we never leave a half-built state.
  let drawerNote = '';
  if (drawer) {
    const pluginId = drawerPluginIdFor(userId, skillId);
    const drawerErr = await createDrawerForSkill(
      pluginId, manifest.name, manifest.icon, userId, skillId, drawer
    );
    if (drawerErr) {
      removeRoleManifest(skillId, userId);
      rmSync(skillDir, { recursive: true, force: true });
      await modifyProfile(userId, user => {
        user.skills = (user.skills ?? []).filter(s => s !== skillId);
      });
      return `Drawer creation failed — skill creation rolled back:\n\n${drawerErr}`;
    }
    drawerNote = ` A sidebar drawer was also installed — reload the page to see it.`;
  }

  return `Skill "${manifest.name}" (${skillId}) created and loaded. Tools available in your next message: ${newNames.join(', ')}. The skill persists across server restarts.${drawerNote}`;
}

async function handleUpdateCode(args, userId) {
  const { id: skillId, code } = args;
  if (!skillId?.trim()) return 'id is required.';
  if (!code?.trim())    return 'code is required.';
  if (!code.includes('executeSkillTool')) {
    return 'code must export executeSkillTool.';
  }

  const { getRoleManifest, listAllRoles, clearExecutorCache } = await import('../../roles.mjs');

  // Prefer the caller's own scope. Admins can fall through to any user's custom skill.
  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be updated.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const execPath = path.join(skillDir, 'execute.mjs');
  if (!existsSync(execPath)) {
    return `Skill "${skillId}" has no execute.mjs on disk.`;
  }
  const backupPath = execPath + '.bak';

  // Back up current code before overwriting
  writeFileSync(backupPath, readFileSync(execPath));
  writeFileSync(execPath, code);

  // Validate — roll back on error
  const toolNames = (manifest.tools ?? []).map(t => t.function?.name).filter(Boolean);
  const importErr = await validateExecutor(skillDir, toolNames);
  if (importErr) {
    writeFileSync(execPath, readFileSync(backupPath));
    rmSync(backupPath, { force: true });
    return `Updated code has an error — reverted to previous version:\n\n${importErr}`;
  }
  rmSync(backupPath, { force: true });

  clearExecutorCache(skillId, ownerId);

  return `Skill "${manifest.name}" (${skillId}) updated and hot-reloaded. New code is active immediately.`;
}

async function handleReadCode(args, userId) {
  const { id: skillId } = args;
  if (!skillId?.trim()) return 'id is required.';

  const { getRoleManifest, listAllRoles } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be read via this tool.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const execPath = path.join(userSkillsDir(ownerId), skillId, 'execute.mjs');
  if (!existsSync(execPath)) return `Skill "${skillId}" has no execute.mjs on disk.`;

  return readFileSync(execPath, 'utf8');
}

async function handlePatchCode(args, userId) {
  const { id: skillId, edits } = args;
  if (!skillId?.trim()) return 'id is required.';
  if (!Array.isArray(edits) || !edits.length) return 'edits must be a non-empty array.';
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.find !== 'string' || typeof e.replace !== 'string') {
      return `edits[${i}] must be an object with string "find" and "replace" fields.`;
    }
    if (!e.find.length) return `edits[${i}].find must be a non-empty string.`;
  }

  const { getRoleManifest, listAllRoles, clearExecutorCache } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be patched.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const execPath = path.join(skillDir, 'execute.mjs');
  if (!existsSync(execPath)) return `Skill "${skillId}" has no execute.mjs on disk.`;

  const original = readFileSync(execPath, 'utf8');
  let current = original;

  // Apply edits in order. Each find must match exactly once at the time it's applied.
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    const first = current.indexOf(find);
    if (first === -1) {
      return `edits[${i}].find not found in current file. It may have already been changed by an earlier edit, or the surrounding context is off. Call skill_read_code to inspect the current source.`;
    }
    const second = current.indexOf(find, first + 1);
    if (second !== -1) {
      return `edits[${i}].find matches multiple locations — include more surrounding context so it is unique.`;
    }
    current = current.slice(0, first) + replace + current.slice(first + find.length);
  }

  if (current === original) return 'All edits were no-ops — nothing changed.';

  if (!current.includes('executeSkillTool')) {
    return 'Patched code must still export executeSkillTool. Edit rejected.';
  }

  const backupPath = execPath + '.bak';
  writeFileSync(backupPath, original);
  writeFileSync(execPath, current);

  const toolNames = (manifest.tools ?? []).map(t => t.function?.name).filter(Boolean);
  const importErr = await validateExecutor(skillDir, toolNames);
  if (importErr) {
    writeFileSync(execPath, original);
    rmSync(backupPath, { force: true });
    return `Patched code has an error — reverted to previous version:\n\n${importErr}`;
  }
  rmSync(backupPath, { force: true });

  clearExecutorCache(skillId, ownerId);

  const n = edits.length;
  return `Skill "${manifest.name}" (${skillId}) patched (${n} edit${n === 1 ? '' : 's'}) and hot-reloaded. New code is active immediately.`;
}

async function handleDelete(args, userId) {
  const { id: skillId } = args;
  if (!skillId?.trim()) return 'id is required.';

  const { getRoleManifest, listAllRoles, removeRoleManifest, clearExecutorCache } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be deleted.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) return `Skill "${skillId}" not found.`;

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);

  rmSync(skillDir, { recursive: true, force: true });

  removeRoleManifest(skillId, ownerId);
  clearExecutorCache(skillId, ownerId);

  // Remove the paired drawer plugin (if any). Safe no-op when no drawer exists.
  removeDrawerForSkill(ownerId, skillId);

  // Clean up the owner's profile (may be a different user when an admin is deleting).
  await modifyProfile(ownerId, user => {
    user.skills = (user.skills ?? []).filter(s => s !== skillId);
    if (user.skillAssignments) delete user.skillAssignments[skillId];
  });

  return `Skill "${manifest.name}" (${skillId}) deleted and unloaded.`;
}

async function handleList(userId) {
  const { listRoles } = await import('../../roles.mjs');
  const mySkills = listRoles(userId).filter(m => m.custom === true && m.createdBy === userId);
  if (!mySkills.length) return 'No custom skills yet. Use skill_create to build one.';
  return mySkills.map(m => {
    const n = (m.tools ?? []).length;
    return `• ${m.icon ?? '🔧'} **${m.name}** (${m.id}) — ${m.description} [${n} tool${n !== 1 ? 's' : ''}]`;
  }).join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function executeSkillTool(name, args, userId, agentId) {
  try {
    if (name === 'skill_read_blueprint') return handleReadBlueprint();
    if (name === 'skill_create')         return await handleCreate(args, userId);
    if (name === 'skill_update_code')    return await handleUpdateCode(args, userId);
    if (name === 'skill_read_code')      return await handleReadCode(args, userId);
    if (name === 'skill_patch_code')     return await handlePatchCode(args, userId);
    if (name === 'skill_delete')         return await handleDelete(args, userId);
    if (name === 'skill_list')           return await handleList(userId);
    return null;
  } catch (e) {
    console.error(`[skill-builder] ${name}:`, e.message);
    return `Skill builder error: ${e.message}`;
  }
}

export default executeSkillTool;
