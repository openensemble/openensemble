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
 * Pure function of the inputs — the only module-level state is the
 * mtime-checked rules-file cache below, which is invisible to callers.
 */

import fs from 'fs';
import path from 'path';
import { BASE_DIR } from '../routes/_helpers/paths.mjs';
import { userRoleRulesPath } from './paths.mjs';
import { listRoles, getRoleManifest } from '../roles.mjs';
import { listDesktops } from './desktop-bus.mjs';

/**
 * Mtime-checked file read cache for rules.md / role-rules/*.md. The composer
 * runs 2-4× per coordinator turn and used to readFileSync every active
 * skill's rules on each pass — a per-turn disk storm. One statSync replaces
 * each read; edits (mtime change) or deletion invalidate naturally.
 * Returns the trimmed text, or null when the file is missing/unreadable.
 */
const _rulesCache = new Map(); // path -> { mtimeMs, text }
function _readTrimmedCached(p) {
  let st;
  try { st = fs.statSync(p); } catch { _rulesCache.delete(p); return null; }
  const hit = _rulesCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
  let text;
  try { text = fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
  _rulesCache.set(p, { mtimeMs: st.mtimeMs, text });
  return text;
}

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
 * @param {boolean} [args.rosterSolo]   True when this user runs single-agent
 *                                      mode (stored orchestration policy, not
 *                                      roster shape). Skills may ship a
 *                                      `systemPromptAdditionSolo` that
 *                                      replaces their SPA in that world —
 *                                      guidance about routing to named
 *                                      specialists is dead weight (and a trap)
 *                                      when no specialists exist.
 * @returns {string}  The SPA block. May be empty.
 */
export function composeSkillSpaBlock({ tools, userId, userName, agentName, agentEmoji, serverIp, emailNoConfirm, rosterSolo = false }) {
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
      const manifest = getRoleManifest(skillId, userId);
      const raw = (rosterSolo && manifest?.systemPromptAdditionSolo) || manifest?.systemPromptAddition;
      if (raw) {
        let spa = expand(raw);
        if (spa.includes('{{WORKSPACE}}')) {
          const ws = path.join(BASE_DIR, 'users', userId, 'documents', 'code');
          spa = spa.replace(/\{\{WORKSPACE\}\}/g, ws);
        }
        if (skillId === 'desktop') {
          const clients = listDesktops(userId);
          const status = clients.length
            ? `Current desktop bridge status: connected (${clients.map(c => `${c.name || c.clientId}: ${c.clientId}`).join(', ')}). Prefer desktop_* tools for local files when {{USER_NAME}} asks for local desktop output.`
            : 'Current desktop bridge status: no desktop client is connected. Do not claim you saved files locally unless a desktop_* tool call succeeds.';
          spa = `${spa}\n\n${expand(status)}`;
        }
        piece.push(spa);
      }
      // Auto-inject collection-watcher guidance for skills that declare one.
      // This frees skill authors from having to remember to document the
      // generic list/update/remove_watch_item flow for their owning agent —
      // every time a manifest says `collection_watchers: ['kind1', ...]`,
      // the owning agent gets a stock paragraph telling it how to query and
      // mutate the items inside the collection without going through the
      // skill's own kickoff tool.
      const kinds = Array.isArray(manifest?.collection_watchers) ? manifest.collection_watchers.filter(k => typeof k === 'string') : [];
      if (kinds.length) {
        const kindList = kinds.map(k => `\`${k}\``).join(', ');
        const skillName = manifest?.name || skillId;
        piece.push(`### Collection watchers in ${skillName}
This skill manages one or more items inside a single watcher record (collection mode) for these kinds: ${kindList}. To inspect or modify the per-item list at runtime — without touching the skill's kickoff tool — use:
- \`list_watch_items({ kind: '<one-of-above>' })\` — see every tracked item with its per-item cadence + next-due time + delivery mode.
- \`update_watch_item({ kind, item_id, patch: { cadenceSec: N, deliver: 'agent'|'email'|'telegram'|'notify', ... } })\` — change cadence, delivery, or skill-specific fields on ONE item. Each item's cadenceSec is enforced ≥ 60 seconds.
- \`remove_watch_item({ kind, item_id })\` — drop ONE item from the collection. The parent watcher stays alive even when empty so the user can add more later.

Always call \`list_watch_items\` first to pick the right \`item_id\`. To ADD a new item, call this skill's own kickoff tool — the generic tools above are read/update/delete only.`);
      }
      // Global rules.md (shipped baseline like coder/coordinator) + per-user
      // role-rules/<skillId>.md (auto-promoted from repeated corrections).
      const globalRules = _readTrimmedCached(path.join(BASE_DIR, 'skills', skillId, 'rules.md'));
      if (globalRules) piece.push(globalRules);
      const userRules = _readTrimmedCached(userRoleRulesPath(userId, skillId));
      if (userRules) piece.push(`## Your standing instructions for ${getRoleManifest(skillId, userId)?.name ?? skillId}\n${userRules}`);
      return piece.join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n');

  return parts;
}
