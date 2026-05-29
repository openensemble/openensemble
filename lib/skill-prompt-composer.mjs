// @ts-check
/**
 * Compose the per-skill SPA + rules portion of an agent's system prompt.
 *
 * Pulled out of routes/_helpers/agent-resolver.mjs so it can run TWICE
 * per turn for coordinator agents:
 *   1. At agent resolution time (full tool set, baseline prompt).
 *   2. In chat.mjs after `trimToolsForTurn` shrinks agent.tools — the
 *      SPA recompose picks up the smaller skill activeSet and drops the
 *      SPAs whose tools no longer ship this turn.
 *
 * Without step 2, trimming agent.tools saves tool-schema bytes but leaves
 * the (larger) skill SPAs in the prompt. The 10 KB profiles SPA was the
 * single biggest contributor to coordinator prompt bloat.
 *
 * Pure function of the inputs — no module-level state, no caches.
 */

import fs from 'fs';
import path from 'path';
import { BASE_DIR } from '../routes/_helpers/paths.mjs';
import { userRoleRulesPath } from './paths.mjs';
import { listRoles, getRoleManifest } from '../roles.mjs';

/**
 * Build toolName → owningSkillId index from the manifests this user sees.
 * First-writer-wins so a duplicate tool name across manifests is stable.
 */
function _toolOwnerIndex(userId) {
  const idx = Object.create(null);
  for (const m of listRoles(userId)) {
    for (const t of (m.tools ?? [])) {
      const name = t.function?.name;
      if (name && !idx[name]) idx[name] = m.id;
    }
  }
  return idx;
}

/**
 * Per-user / per-flag template expander. Kept here because the SPAs use
 * {{TOKENS}} that depend on user-scope (USER_NAME, agent name, email
 * confirm-gate flag, etc.).
 */
function _buildTemplateExpander({ userName, agentName, agentEmoji, serverIp, emailNoConfirm, userId }) {
  const emailConfirmGuidance = emailNoConfirm
    ? `- {{USER_NAME}} has opted into send-without-confirm: when they explicitly ask you to send/reply/compose, do it directly. Still show a draft preview only when YOU initiated the suggestion and they haven't agreed yet.`
    : `- ALWAYS show a reply or compose draft and wait for explicit approval before sending.`;
  const emailComposeFlow = emailNoConfirm
    ? `- For replies: when {{USER_NAME}} explicitly asks you to reply, call email_reply directly. Show a draft first only if their wording was ambiguous (e.g. "draft a reply").\n- For new emails: when {{USER_NAME}} explicitly asks you to email/send, call email_compose directly. Show a draft first only if you're filling in a gap (e.g. recipient unstated, no clear request to send).`
    : `- For replies: show draft → get confirmation → call email_reply\n- For new emails: show draft → get confirmation → call email_compose`;
  return (s) => s
    .replace(/\{\{USER_NAME\}\}/g, userName)
    .replace(/\{\{AGENT_NAME\}\}/g, agentName)
    .replace(/\{\{AGENT_EMOJI\}\}/g, agentEmoji)
    .replace(/\{\{SERVER_IP\}\}/g, serverIp)
    .replace(/\{\{EMAIL_CONFIRM_GUIDANCE\}\}/g, emailConfirmGuidance)
    .replace(/\{\{EMAIL_COMPOSE_FLOW\}\}/g, emailComposeFlow);
}

/**
 * Compose the skill-prompt-additions section.
 *
 * @param {object} args
 * @param {Array}  args.tools           Current tool list. Drives "which SPAs are active".
 * @param {string} args.userId
 * @param {string} args.userName        For {{USER_NAME}} expansion.
 * @param {string} args.agentName       For {{AGENT_NAME}} expansion.
 * @param {string} args.agentEmoji
 * @param {string} args.serverIp        For {{SERVER_IP}} expansion.
 * @param {boolean} args.emailNoConfirm Drives the email-skill template branch.
 * @returns {string}  The SPA block. May be empty.
 */
export function composeSkillSpaBlock({ tools, userId, userName, agentName, agentEmoji, serverIp, emailNoConfirm }) {
  const owners = _toolOwnerIndex(userId);
  const activeSkillIds = new Set();
  for (const t of tools ?? []) {
    const skillId = owners[t.function?.name];
    if (skillId) activeSkillIds.add(skillId);
  }
  // Stable order across runs: walk listRoles in its native order.
  const orderedSkillIds = listRoles(userId).map(m => m.id).filter(id => activeSkillIds.has(id));
  const expand = _buildTemplateExpander({ userName, agentName, agentEmoji, serverIp, emailNoConfirm, userId });

  const parts = orderedSkillIds
    .map(skillId => {
      const piece = [];
      const raw = getRoleManifest(skillId, userId)?.systemPromptAddition;
      if (raw) {
        let spa = expand(raw);
        if (spa.includes('{{WORKSPACE}}')) {
          const ws = path.join(BASE_DIR, 'users', userId, 'documents', 'code');
          spa = spa.replace(/\{\{WORKSPACE\}\}/g, ws);
        }
        piece.push(spa);
      }
      // Global rules.md (shipped baseline like coder/coordinator) + per-user
      // role-rules/<skillId>.md (auto-promoted from repeated corrections).
      const globalRulesPath = path.join(BASE_DIR, 'skills', skillId, 'rules.md');
      if (fs.existsSync(globalRulesPath)) {
        const rules = fs.readFileSync(globalRulesPath, 'utf8').trim();
        if (rules) piece.push(rules);
      }
      const userRulesPath = userRoleRulesPath(userId, skillId);
      if (fs.existsSync(userRulesPath)) {
        const rules = fs.readFileSync(userRulesPath, 'utf8').trim();
        if (rules) piece.push(`## Your standing instructions for ${getRoleManifest(skillId, userId)?.name ?? skillId}\n${rules}`);
      }
      return piece.join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n');

  return parts;
}
