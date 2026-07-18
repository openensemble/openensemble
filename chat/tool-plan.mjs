/**
 * User tool-plan application and current-turn builders.
 * Extracted from chat.mjs.
 */
import { getSelectedPlanKeepTools } from '../roles.mjs';
import { composeSkillSpaBlock } from '../lib/skill-prompt-composer.mjs';
import { buildImageUserMessage } from './providers/_shared.mjs';

const SELECTED_PLAN_CONTROL_TOOLS = new Set(['request_tools', 'web_search', 'email_user']);

export function sanitizeToolPlanForStream(plan) {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.mode === 'none') return { mode: 'none', selectedTools: [], source: plan.source || null };
  if (plan.mode !== 'selected') return null;
  const selectedTools = Array.isArray(plan.selectedTools)
    ? [...new Set(plan.selectedTools.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()))]
    : [];
  if (!selectedTools.length) return null;
  return { mode: 'selected', selectedTools, source: plan.source || null };
}

export function recomposeAgentPromptForTools(agent) {
  if (agent._promptTiers && agent._composerInputs) {
    const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
    agent._promptTiers = { ...agent._promptTiers, context: newSpa || '' };
    agent.systemPrompt = [agent._promptTiers.stable, agent._promptTiers.context, agent._promptTiers.volatile].filter(Boolean).join('\n\n');
  } else if (agent._systemPromptShell && agent._composerInputs) {
    const newSpa = composeSkillSpaBlock({ tools: agent.tools, ...agent._composerInputs });
    agent.systemPrompt = agent._systemPromptShell.replace('%%SKILL_SPAS%%', newSpa);
  }
}

export function applyUserToolPlan(agent, plan, userId = null) {
  const clean = sanitizeToolPlanForStream(plan);
  if (!clean || !Array.isArray(agent.tools)) return null;
  const before = agent.tools.length;
  const fullTools = agent.tools.slice();
  if (clean.mode === 'none') {
    agent.tools = [];
    return { mode: 'none', before, after: 0, selected: [], fullTools };
  }
  // A cached or hand-crafted client plan can name a tool that the current
  // orchestration policy no longer exposes. Intersect with the live resolved
  // surface before filtering and before reporting the plan back into prompts,
  // telemetry, or recipe learning; never describe a removed tool as selected.
  const availableNames = new Set(fullTools.map(tool => tool?.function?.name).filter(Boolean));
  const effectiveSelected = clean.selectedTools.filter(name => availableNames.has(name));
  const selected = new Set(effectiveSelected);
  const controlTools = new Set(SELECTED_PLAN_CONTROL_TOOLS);
  try {
    const manifestKeeps = agent._rosterSolo === true
      ? getSelectedPlanKeepTools(selected, userId)
      : getSelectedPlanKeepTools(null, userId);
    for (const t of manifestKeeps) controlTools.add(t);
  } catch { /* registry not loaded yet — base set still applies */ }
  if ((agent.skillCategory === 'coordinator' || selected.size === 0)
      && agent._rosterSolo !== true) controlTools.add('ask_agent');
  agent.tools = agent.tools.filter(t => {
    const name = t.function?.name;
    return selected.has(name) || controlTools.has(name);
  });
  return { mode: 'selected', before, after: agent.tools.length, selected: effectiveSelected, fullTools };
}

export function executionSkillsForSelectedTools(userId, toolNames) {
  const selected = new Set(Array.isArray(toolNames) ? toolNames : []);
  if (!selected.size) return [];
  const out = [];
  try {
    for (const manifest of listRoles(userId)) {
      if ((manifest.tools ?? []).some(tool => selected.has(tool?.function?.name ?? tool?.name))) {
        out.push(manifest.id);
      }
    }
  } catch { /* routing remains on the agent default if the registry is unavailable */ }
  return out;
}

export function userAllowedExecutionModels(userId) {
  if (!userId || userId === 'default') return null;
  try {
    const profile = JSON.parse(readFileSync(path.join(USERS_DIR, userId, 'profile.json'), 'utf8'));
    return Array.isArray(profile?.allowedModels) ? profile.allowedModels : null;
  } catch {
    // Missing/corrupt account policy must not unlock a restricted override.
    return [];
  }
}

export function skillExecutionTraceSummary(resolution) {
  if (!resolution) return null;
  const shape = value => ({
    provider: value?.provider ?? null,
    model: value?.model ?? null,
    reasoningEffort: value?.reasoningEffort ?? null,
  });
  return {
    applied: resolution.applied === true,
    reason: resolution.reason ?? null,
    baseline: shape(resolution.baseline),
    effective: shape(resolution.effective),
    sourceSkillIds: {
      model: resolution.sourceSkillIds?.model ?? null,
      reasoningEffort: resolution.sourceSkillIds?.reasoningEffort ?? null,
    },
    sourceKinds: {
      model: resolution.sourceKinds?.model ?? null,
      reasoningEffort: resolution.sourceKinds?.reasoningEffort ?? null,
    },
    reasoningEffortInherited: resolution.reasoningEffortInherited === true,
    contenders: (resolution.contenders ?? []).slice(0, 32).map(candidate => ({
      skillId: candidate.skillId ?? null,
      provider: candidate.provider ?? null,
      model: candidate.model ?? null,
      reasoningEffort: candidate.reasoningEffort ?? null,
      source: candidate.source ?? null,
      tier: candidate.tier ?? null,
      eligible: candidate.eligible === true,
      reason: candidate.reason ?? null,
    })),
  };
}

export function buildUserToolPlanSystemBlock(agent, userToolPlanResult) {
  if (!userToolPlanResult) return '';
  const rosterSolo = agent?._rosterSolo === true;
  const selectedNames = (Array.isArray(userToolPlanResult.selected) ? userToolPlanResult.selected : [])
    .filter(name => !(rosterSolo && name === 'ask_agent'));
  const selectedNote = rosterSolo
    ? (selectedNames.length
        ? ` These selected action tools are available this turn: ${selectedNames.join(', ')}. Control-plane tools such as request_tools may also be available so you can recover from an incomplete selected set and continue the task yourself. Do not claim unrelated tools are unavailable; request tools, answer, use a background worker for long or parallel work, or ask a concise follow-up if the selected set is insufficient.`
        : ' None of the requested action tools are available in single-assistant mode. Use request_tools to recover a needed capability, continue without tools, or ask a concise follow-up.')
    : ` These selected action tools are available this turn: ${userToolPlanResult.selected.join(', ')}. Control-plane tools such as ask_agent/request_tools may also be available so you can delegate or recover from an incomplete selected set. Do not claim unrelated tools are unavailable; delegate, request tools, answer, or ask a concise follow-up if the selected set is insufficient.`;
  return `\n\n## User-selected tool plan\nThe user selected tool mode "${userToolPlanResult.mode}" before sending this message.${userToolPlanResult.mode === 'selected'
    ? selectedNote
    : ' No tools are available this turn; answer without tool calls or ask a concise follow-up if live action is required.'}`;
}

/**
 * Build the current-turn user message from an already-normalized attachments
 * array. Images (base64 present) go through buildImageUserMessage — the same
 * per-provider vision-content builder that reinjects N tool-produced images
 * into the NEXT model turn (see chat/providers/_shared.mjs and every
 * provider's `working.push(buildImageUserMessage(...))` call after a tool
 * returns `_images`). Reusing it here means a multi-file upload gets the
 * identical Anthropic / Ollama / OpenAI-compat+Responses / LM Studio content
 * shapes instead of a second hand-rolled per-provider branch, and any future
 * provider only needs to teach buildImageUserMessage its shape once.
 *
 * No image attachments (none at all, or only audio/video/pdf/csv/etc — see
 * attachmentNotes above, which fold each one's path/extraction note into
 * userText/sessionText separately) → a plain text turn.
 *
 * Exported for tests (mirrors tests/provider-tool-images.test.mjs style —
 * asserting N image parts from N attachments rather than driving a full
 * streamChat turn through a mocked provider).
 */
export function buildCurrentUserTurn(agent, userText, attachments) {
  const imageParts = (attachments || [])
    .filter(a => a?.base64)
    .map(a => ({ base64: a.base64, mediaType: a.mimeType }));
  if (!imageParts.length) return { role: 'user', content: userText };
  return buildImageUserMessage(agent.provider, imageParts, userText || 'What is in this image?');
}

