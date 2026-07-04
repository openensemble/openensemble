import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import {
  USERS_DIR, SKILLS_DIR,
  userRoleRulesDir, userRoleRulesPath,
} from '../../lib/paths.mjs';

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

function loadSkillManifest(skillId) {
  const p = path.join(SKILLS_DIR, skillId, 'manifest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Per-user rules: live under users/<uid>/role-rules/<skillId>.md so one user's
// standing instructions don't leak into another user's agents. Globals at
// skills/<skillId>/rules.md are still read by agent-resolver as a shipped
// baseline (e.g. coder + coordinator ship rules.md in the repo) but
// role_add/remove/list_rules below only ever touch user scope.
function rulesPath(userId, skillId) {
  return userRoleRulesPath(userId, skillId);
}

function loadRules(userId, skillId) {
  const p = rulesPath(userId, skillId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function saveRules(userId, skillId, rules) {
  const p = rulesPath(userId, skillId);
  if (rules.length === 0) {
    if (existsSync(p)) unlinkSync(p);
  } else {
    mkdirSync(userRoleRulesDir(userId), { recursive: true });
    writeFileSync(p, rules.join('\n') + '\n', 'utf8');
  }
}

// Resolve a skill manifest from EITHER the built-in skills dir or the
// caller's user-scoped custom skills. Returns null if neither has it.
async function resolveSkill(skillId, userId) {
  const builtin = loadSkillManifest(skillId);
  if (builtin) return builtin;
  const { getRoleManifest } = await import('../../roles.mjs');
  return getRoleManifest(skillId, userId) || null;
}

function normId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function acronym(s) {
  return String(s || '')
    .replace(/^role[_-]+/i, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => part[0]?.toLowerCase() || '')
    .join('');
}

async function visibleSkills(userId) {
  const { listRoles } = await import('../../roles.mjs');
  const fromRegistry = listRoles(userId);
  const byId = new Map(fromRegistry.map(m => [m.id, m]));
  try {
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = loadSkillManifest(entry.name);
      if (m && !byId.has(m.id || entry.name)) byId.set(m.id || entry.name, m);
    }
  } catch {}
  return [...byId.values()];
}

async function ownedSkillIds(userId, agentId) {
  if (!agentId) return new Set();
  const { getRoleAssignments } = await import('../../roles.mjs');
  const bareAgentId = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const assignments = getRoleAssignments(userId);
  const out = new Set();
  for (const [skillId, owner] of Object.entries(assignments)) {
    if (owner === bareAgentId) out.add(skillId);
  }
  return out;
}

async function agentNameMatches(input, userId, agentId) {
  const q = normId(input);
  if (!q) return false;
  const bareAgentId = userId && agentId?.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  if (q === normId(bareAgentId) || q === normId(agentId)) return true;
  try {
    const { getAgentsForUser } = await import('../../routes/_helpers.mjs');
    const agent = getAgentsForUser(userId).find(a => a.id === bareAgentId || a.id === agentId);
    return !!agent && (q === normId(agent.name) || q === normId(agent.id));
  } catch {
    return false;
  }
}

async function resolveSkillRef(rawSkillId, userId, agentId) {
  const input = String(rawSkillId || '').trim();
  if (!input) {
    const owned = await ownedSkillIds(userId, agentId);
    const skills = await visibleSkills(userId);
    const ownedSkills = skills.filter(s => owned.has(s.id));
    if (ownedSkills.length === 1) return { skillId: ownedSkills[0].id, manifest: ownedSkills[0] };
    return { error: ownedSkills.length > 1 ? `Which skill? You own: ${ownedSkills.map(s => `${s.name || s.id} (${s.id})`).join(', ')}.` : 'skillId is required.' };
  }

  const exact = await resolveSkill(input, userId);
  if (exact) return { skillId: exact.id || input, manifest: exact };

  const skills = await visibleSkills(userId);
  const owned = await ownedSkillIds(userId, agentId);
  const q = normId(input);
  const candidates = skills.map(s => {
    const id = s.id || '';
    const names = [
      id,
      id.replace(/^role[_-]+/, ''),
      s.name || '',
      s.description || '',
      acronym(id),
      acronym(s.name || ''),
    ].map(normId).filter(Boolean);
    const exactish = names.some(n => n === q);
    const contains = q.length >= 3 && names.some(n => n.includes(q) || q.includes(n));
    return { skillId: id, manifest: s, owned: owned.has(id), exactish, contains };
  }).filter(c => c.exactish || c.contains);

  const ownedCandidates = candidates.filter(c => c.owned);
  const pool = ownedCandidates.length ? ownedCandidates : candidates;
  if (pool.length === 1) return { skillId: pool[0].skillId, manifest: pool[0].manifest };

  if (pool.length > 1) {
    const exactOwned = pool.filter(c => c.owned && c.exactish);
    if (exactOwned.length === 1) return { skillId: exactOwned[0].skillId, manifest: exactOwned[0].manifest };
    return { error: `More than one skill matches "${input}": ${pool.map(c => `${c.manifest.name || c.skillId} (${c.skillId})`).join(', ')}.` };
  }

  if (await agentNameMatches(input, userId, agentId)) {
    const ownedSkills = skills.filter(s => owned.has(s.id));
    if (ownedSkills.length === 1) return { skillId: ownedSkills[0].id, manifest: ownedSkills[0] };
  }

  const ownedNames = skills
    .filter(s => owned.has(s.id))
    .map(s => `${s.name || s.id} (${s.id})`);
  return {
    error: ownedNames.length
      ? `No skill found matching "${input}". Skills you own: ${ownedNames.join(', ')}.`
      : `No skill found matching "${input}".`,
  };
}

// Strict ownership: every agent is the sole authority over the skills it
// holds. Only the current owner of a skill (via getRoleAssignments for
// built-in roles, manifest.assign_to for custom skills) may write its
// rules. Even the coordinator can't write rules for a skill it doesn't
// own — it must delegate to the holding agent via ask_agent.
async function checkSkillOwnership(skillId, userId, agentId, manifest) {
  const { getRoleAssignments } = await import('../../roles.mjs');
  const assignments = getRoleAssignments(userId);
  const bareAgentId = userId && agentId.startsWith(userId + '_') ? agentId.slice(userId.length + 1) : agentId;
  const assigned = assignments[skillId] ?? null;
  // Custom skills carry a top-level `assign_to` set by skill-builder when
  // the skill is created. Fall back to that if the runtime assignment map
  // doesn't carry it (e.g. the user hasn't reassigned since the skill
  // was created).
  const owner = assigned ?? manifest?.assign_to ?? null;
  if (!owner) {
    // Unassigned built-in: anyone may write — same legacy semantics as
    // role_add_rule before this change. Custom skills SHOULD always have
    // assign_to from skill_create, so this path is rare for them.
    return { ok: true, owner: null };
  }
  if (owner === bareAgentId) return { ok: true, owner };
  return { ok: false, owner };
}

function ownershipDenial(manifest, owner) {
  return `You don't own the ${manifest.name} skill — its rules belong to whoever holds it. Use ask_agent to delegate this rule-write to the holding agent (currently "${owner}"). Each agent is the sole authority over its own skills.`;
}

export default async function execute(name, args, userId, agentId) {
  // teach_fastpath_phrase — user-taught local fast-path: "when I say X, run
  // skill Y". Writes the phrase to users/<id>/learned-intents.json bound to
  // one of the skill's tools; lib/local-label.mjs materializes it into a
  // dispatchable intent on the very next turn (no restart), so the phrase
  // runs on-device with no cloud-LLM call. Additive + revertable via
  // forget_fastpath_phrase.
  if (name === 'teach_fastpath_phrase') {
    const phrase = String(args?.phrase || '').trim();
    const skillArg = String(args?.skill_id || '').trim();
    if (phrase.length < 3 || phrase.length > 200) return 'phrase must be 3-200 characters.';
    if (!skillArg) return 'skill_id is required (use skill_list or the skill name the user said).';
    if (!userId) return 'userId is required.';
    const { listRoles } = await import('../../roles.mjs');
    const skill = listRoles(userId).find(m => m.id === skillArg)
      || listRoles(userId).find(m => (m.name || '').toLowerCase() === skillArg.toLowerCase());
    if (!skill) return `Unknown skill "${skillArg}". Ask the user which skill they mean, or list their skills.`;
    const toolNames = (skill.tools || []).map(t => t.function?.name).filter(Boolean);
    if (!toolNames.length) return `Skill "${skill.name}" declares no tools — nothing to bind the phrase to.`;
    let toolName = args?.tool && toolNames.includes(args.tool) ? args.tool : null;
    if (!toolName && args?.tool) return `Skill "${skill.name}" has no tool "${args.tool}". Its tools: ${toolNames.join(', ')}.`;
    if (!toolName) {
      if (toolNames.length === 1) toolName = toolNames[0];
      else {
        const intentTools = [...new Set((skill.localIntents || []).map(li => li.tool))];
        if (intentTools.length === 1) toolName = intentTools[0];
        else return `Skill "${skill.name}" has ${toolNames.length} tools — pass \`tool\` to say which one the phrase should run: ${toolNames.join(', ')}.`;
      }
    }
    // Reuse an existing intent for this tool when one exists (the phrase joins
    // its learned utterances); otherwise mint a user_taught intent that
    // materializes standalone.
    const existing = (skill.localIntents || []).find(li => li.tool === toolName);
    const intentId = existing?.id || `user_taught_${toolName}`;
    const { addLearnedUtterance } = await import('../../lib/learned-intents.mjs');
    await addLearnedUtterance(userId, { skillId: skill.id, intentId, tool: toolName, utterance: phrase });
    return `Learned. Saying "${phrase}" now runs ${toolName} (${skill.name}) instantly on-device — no cloud call. It takes effect on the next message. Undo anytime with forget_fastpath_phrase.`;
  }

  if (name === 'forget_fastpath_phrase') {
    const phrase = String(args?.phrase || '').trim();
    const skillArg = String(args?.skill_id || '').trim();
    if (!phrase) return 'phrase is required.';
    if (!skillArg) return 'skill_id is required.';
    const { loadLearnedIntents, removeLearnedUtterance } = await import('../../lib/learned-intents.mjs');
    const store = loadLearnedIntents(userId) || {};
    const intents = store[skillArg];
    if (!intents) return `No taught phrases stored for skill "${skillArg}".`;
    const normPhrase = phrase.toLowerCase().replace(/\s+/g, ' ');
    for (const [intentId, entry] of Object.entries(intents)) {
      const hit = (entry?.utterances || []).find(u => u.toLowerCase().replace(/\s+/g, ' ') === normPhrase);
      if (hit) {
        await removeLearnedUtterance(userId, skillArg, intentId, hit);
        return `Forgotten — "${hit}" no longer triggers ${entry.tool} locally. (It'll route through the normal assistant flow instead.)`;
      }
    }
    return `Couldn't find that exact phrase among the taught ones for "${skillArg}". Stored phrases: ${Object.values(intents).flatMap(e => e.utterances || []).map(u => `"${u}"`).join(', ') || '(none)'}.`;
  }

  // skill_add_rule — generalised from role_add_rule. Works for built-in
  // roles AND user-scoped custom skills, AND enforces strict ownership:
  // only the agent currently holding the skill may write its rules. Any
  // other agent (including the coordinator) must delegate via ask_agent.
  if (name === 'skill_add_rule' || name === 'role_add_rule') {
    const { skillId: argSkillId, roleId, rule } = args;
    if (!rule) return 'rule is required.';
    if (!userId) return 'userId is required for per-user rules.';
    const resolved = await resolveSkillRef(argSkillId || roleId, userId, agentId);
    if (resolved.error) return resolved.error;
    const { skillId, manifest } = resolved;
    const own = await checkSkillOwnership(skillId, userId, agentId, manifest);
    if (!own.ok) return ownershipDenial(manifest, own.owner);
    const rules = loadRules(userId, skillId);
    const incoming = `- ${rule.trim()}`;
    // Normalize for duplicate detection: lowercase, drop punctuation,
    // collapse whitespace. Catches paraphrases of the same rule landing
    // on consecutive corrections (e.g. "X may send …" vs "send X
    // without asking …") as separate adds.
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const incomingNorm = norm(incoming);
    if (rules.some(r => norm(r) === incomingNorm)) {
      return `That rule is already set for ${manifest.name} — no change.`;
    }
    rules.push(incoming);
    saveRules(userId, skillId, rules);
    return `Rule added to ${manifest.name} for your account. It applies from the next conversation onward.`;
  }

  if (name === 'skill_remove_rule' || name === 'role_remove_rule') {
    const { skillId: argSkillId, roleId, index } = args;
    if (index == null) return 'index is required.';
    if (!userId) return 'userId is required.';
    const resolved = await resolveSkillRef(argSkillId || roleId, userId, agentId);
    if (resolved.error) return resolved.error;
    const { skillId, manifest } = resolved;
    const own = await checkSkillOwnership(skillId, userId, agentId, manifest);
    if (!own.ok) return ownershipDenial(manifest, own.owner);
    const rules = loadRules(userId, skillId);
    if (index < 0 || index >= rules.length) return `Index ${index} is out of range. There are ${rules.length} rule(s).`;
    const removed = rules.splice(index, 1)[0];
    saveRules(userId, skillId, rules);
    return `Removed rule: ${removed}`;
  }

  if (name === 'set_email_send_without_confirm') {
    if (!userId) return 'userId is required.';
    const { enabled } = args;
    if (typeof enabled !== 'boolean') return 'enabled must be true or false.';
    const user = getUserById(userId);
    if (!user) return `User profile not found for ${userId}.`;
    const wasEnabled = user.emailSendWithoutConfirm === true;
    user.emailSendWithoutConfirm = enabled;
    user.id = user.id ?? userId;
    saveUserById(user);
    if (enabled === wasEnabled) {
      return enabled
        ? 'Email send-without-confirm is already ON — emails will continue to send directly when you explicitly ask.'
        : 'Email send-without-confirm is already OFF — emails will continue to require draft + confirmation.';
    }
    return enabled
      ? 'Email send-without-confirm turned ON. From your next conversation onward, when you explicitly ask the email agent to send a reply or new email, it will send directly without showing a draft first. Drafts the agent proactively suggests still wait for your approval.'
      : 'Email send-without-confirm turned OFF. The email agent will now show a draft and wait for your explicit approval before every send.';
  }

  if (name === 'skill_list_rules' || name === 'role_list_rules') {
    const { skillId: argSkillId, roleId } = args;
    if (!userId) return 'userId is required.';
    const resolved = await resolveSkillRef(argSkillId || roleId, userId, agentId);
    if (resolved.error) return resolved.error;
    const { skillId, manifest } = resolved;
    // List doesn't require ownership — any agent can READ what rules
    // are in place, because that's the same info skill-prompt-composer
    // surfaces in their own system prompt anyway. Only mutation is gated.
    const rules = loadRules(userId, skillId);
    if (rules.length === 0) return `No custom rules set for ${manifest.name}.`;
    return `Rules for ${manifest.name}:\n${rules.map((r, i) => `[${i}] ${r}`).join('\n')}`;
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
