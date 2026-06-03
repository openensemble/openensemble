// @ts-check
/**
 * chat-dispatch/slash-commands.mjs
 *
 * Slash-command interceptors that run BEFORE the LLM and short-circuit the
 * chat pipeline when matched. Each is a small pure-ish handler — input is
 * the raw user text plus a tiny context, output is `{handled, reply,
 * broadcastAgentList?}`. The caller (chat-dispatch.mjs) emits the chat
 * events, persists the session, and calls finalizeTurn.
 *
 * Currently:
 *   /trim on|off|status   — runtime toggle for specialist-router tool trim
 *   /threshold [N]        — embed-router cosine threshold get/set
 *   /claim <skillId>      — assign a role to the current agent
 *   /release <skillId>    — un-assign a role
 *
 * The specialist-trim toggle's STATE also lives here (single source of
 * truth) — chat-dispatch's specialist router imports `getSpecialistTrim`
 * to read it when deciding whether to trim a router-fired turn.
 */

import { getRoleManifest, getRoleAssignments, setRoleAssignment, listRoles } from '../roles.mjs';
import { modifyUser } from '../routes/_helpers.mjs';

// Runtime toggle for the specialist router's tool-surface trim.
// Default OFF: A/B testing on 2026-05-16 ("give me my last 10 emails") showed
// no measurable speedup from trimming 85 → 13 tools (22.4s vs 22.8s). The
// bottleneck is reasoning/output, not tool-schema overhead — at least for
// gpt-5.5 on typical specialist queries. Kept toggleable via `/trim on|off`
// so future experiments (different models, simpler queries) can re-test.
let _specialistTrimEnabled = false;

export function getSpecialistTrim() { return _specialistTrimEnabled; }

/**
 * Try every registered slash command. Returns null on miss, or
 * {handled:true, reply, broadcastAgentList?} on match.
 *
 * @param {object} ctx
 * @param {string} ctx.userText
 * @param {string} ctx.userId
 * @param {string} ctx.agentId
 * @param {{ name: string }} ctx.agent
 * @returns {Promise<null | { handled: true, reply: string, broadcastAgentList?: boolean }>}
 */
export async function tryHandleSlashCommand({ userText, userId, agentId, agent }) {
  // /trim on|off|status — runtime toggle of specialist-router tool trimming.
  // Lets you A/B latency the same query without restarting the server.
  const trimMatch = userText.match(/^\/trim(?:\s+(on|off|status))?\s*$/i);
  if (trimMatch) {
    const arg = (trimMatch[1] || 'status').toLowerCase();
    if (arg === 'on')  _specialistTrimEnabled = true;
    if (arg === 'off') _specialistTrimEnabled = false;
    console.log(`[chat] /trim ${arg} → enabled=${_specialistTrimEnabled}`);
    const reply = _specialistTrimEnabled
      ? 'Tool-trim ON — router-fired turns use role-only tools (~5-13 each).'
      : 'Tool-trim OFF — router-fired turns use the specialist\'s full tool surface (~70-85 each).';
    return { handled: true, reply };
  }

  // /threshold N — tune the embed-router cosine threshold live (default 0.72).
  // Higher = stricter (fewer paraphrases routed); lower = more permissive.
  // /threshold alone reports the current value.
  const thrMatch = userText.match(/^\/threshold(?:\s+(\d+(?:\.\d+)?))?\s*$/i);
  if (thrMatch) {
    const { getEmbedThreshold, setEmbedThreshold } = await import('../lib/specialist-embed-router.mjs');
    let reply;
    if (thrMatch[1] !== undefined) {
      const n = Number(thrMatch[1]);
      if (setEmbedThreshold(n)) reply = `Embed-router threshold set to ${n.toFixed(3)} (cosine similarity).`;
      else reply = 'Threshold must be a number between 0 and 1.';
    } else {
      reply = `Embed-router threshold is ${getEmbedThreshold().toFixed(3)} (cosine similarity). Use /threshold 0.7 to change.`;
    }
    return { handled: true, reply };
  }

  // Bare /claim or /release with no skill id → list what's assignable so
  // the user can pick. Without this, typing just "/claim" matched no
  // regex and fell through to the LLM with no useful response.
  const bareClaimMatch = userText.match(/^\/?(claim|release)\s*$/i);
  if (bareClaimMatch) {
    const action = bareClaimMatch[1].toLowerCase();
    const assignments = getRoleAssignments(userId);
    const all = listRoles(userId).filter(m => m.category !== 'delegate' && !m.hidden);
    const customSkills = all.filter(m => !!m.userScope && !m.service);
    const roles = all.filter(m => m.service);
    const ownerLabel = (id) => {
      const owner = assignments[id];
      if (!owner) return '_unassigned_';
      if (owner === agentId) return `**this agent**`;
      return owner;
    };
    const fmt = (m) => `• \`${m.id}\` — ${m.name} → ${ownerLabel(m.id)}`;
    const lines = [];
    if (action === 'claim') {
      lines.push(`Type \`/claim <id>\` from this chat to move a skill or role to **${agent.name}**.`);
    } else {
      lines.push(`Type \`/release <id>\` from this chat to un-assign one of **${agent.name}**'s skills/roles.`);
    }
    lines.push('');
    if (customSkills.length) {
      lines.push('**Custom skills**');
      for (const m of customSkills) lines.push(fmt(m));
    }
    if (roles.length) {
      if (customSkills.length) lines.push('');
      lines.push('**Roles**');
      for (const m of roles) lines.push(fmt(m));
    }
    return { handled: true, reply: lines.join('\n') };
  }

  // /claim <skillId> and /release <skillId>
  const claimMatch = userText.match(/^\/?(claim|release)\s+(\S+)/i);
  if (claimMatch) {
    const action  = claimMatch[1].toLowerCase();
    const skillId = claimMatch[2].toLowerCase();
    const manifest = getRoleManifest(skillId, userId);
    let reply;
    if (!manifest) {
      const all = listRoles(userId).filter(m => m.category !== 'delegate' && !m.hidden);
      const cs = all.filter(m => !!m.userScope && !m.service).map(m => m.id);
      const rs = all.filter(m => m.service).map(m => m.id);
      const parts = [`No skill or role found with id "${skillId}".`];
      if (cs.length) parts.push(`**Custom skills:** ${cs.join(', ')}`);
      if (rs.length) parts.push(`**Roles:** ${rs.join(', ')}`);
      reply = parts.join('\n');
    } else if (manifest.category === 'delegate') {
      reply = `${manifest.name} is a system role and cannot be assigned.`;
    } else if (action === 'release') {
      const assignments = getRoleAssignments(userId);
      if (assignments[skillId] !== agentId) {
        reply = assignments[skillId]
          ? `${manifest.name} is owned by "${assignments[skillId]}", not this agent.`
          : `${manifest.name} isn't assigned to anyone.`;
      } else {
        setRoleAssignment(skillId, null, userId);
        reply = manifest.custom
          ? `✓ Released **${manifest.name}** — no agent will see its tools until you /claim it from another agent.`
          : `✓ Released **${manifest.name}** — now unassigned.`;
      }
    } else {
      const assignments = getRoleAssignments(userId);
      const current = assignments[skillId];
      if (current === agentId) {
        reply = `${manifest.name} is already assigned to this agent.`;
      } else {
        if (current) reply = `✓ **${manifest.name}** transferred from "${current}" to **${agent.name}**.`;
        else reply = `✓ **${manifest.name}** is now assigned to **${agent.name}**.`;
        setRoleAssignment(skillId, agentId, userId);
        // Add the skill to this user's enabled list — surgical write of just
        // this profile.json. Using saveUsers here would trigger a full users/
        // directory GC sweep (historical root cause of the master-key wipe;
        // see feedback_master_key_never_overwrite).
        try {
          modifyUser(userId, u => {
            if (u.skills && !u.skills.includes(skillId)) u.skills.push(skillId);
          });
        } catch {}
      }
    }
    return { handled: true, reply };
  }

  return null;
}
