/**
 * Alias learning — two feedback loops that keep the alias maps growing on
 * their own as users invent new phrasings.
 *
 * Path A (observe-and-learn):
 *   The pre-LLM resolver couldn't pre-resolve, so the LLM had to figure it
 *   out. After the turn, we look at what tool calls the LLM emitted: if any
 *   arg matches an alias-framework entity's id_arg_names, the framework
 *   records the user's candidate phrase → entity id. Plus a meta-fallback:
 *   when the LLM calls ANY tool from skill X and the user mentioned "the X
 *   skill", learn that as a skill alias (the framework's per-entity learner
 *   can't see this cross-skill pattern, since the called tool's args don't
 *   reference the skill id directly).
 *
 * Path B (clarification-then-yes):
 *   The LLM was unsure and asked "did you mean the X agent?" / "do you mean
 *   the YouTube downloader skill?". We stash a pending clarification keyed
 *   by userId. On the user's next turn, if it's a short affirmation, we
 *   consume the pending clarification and save the alias.
 *
 * Best-effort throughout: silently no-ops on errors; never blocks a turn.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

const PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_MAX_USERS = 64;

const _pending = new Map();   // userId → { origPhrase, entityKind, entityId, ts }

function _gcPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [u, p] of _pending) if (p.ts < cutoff) _pending.delete(u);
}

// ── Path A: observe + learn ─────────────────────────────────────────────────

/**
 * Examine the just-finished LLM turn and learn aliases from what the LLM did.
 * Reads the latest assistant message from the session to find tool_calls,
 * then matches them against the user's message text.
 *
 * Called fire-and-forget from chat-dispatch after runLlmTurn finishes.
 */
export async function observeTurnAndLearn(userId, userText, scopedSessionKey) {
  if (!userId || typeof userText !== 'string' || userText.length < 4) return;
  try {
    const lastAssistant = await _readLastAssistantMessage(userId, scopedSessionKey);
    if (!lastAssistant?.tool_calls?.length) return;

    const fw = await import('./skill-alias-framework.mjs');

    for (const tc of lastAssistant.tool_calls) {
      const toolName = tc.function?.name;
      if (!toolName) continue;
      let argsObj = {};
      try { argsObj = JSON.parse(tc.function?.arguments || '{}'); } catch { continue; }

      // Framework: any tool call with an id_arg matching a registered entity's
      // id_arg_names → learn. Returns true if a learning event fired.
      const learned = await fw.maybeLearnAliasFromCall(userId, userText, toolName, argsObj);
      if (learned) continue;

      // Meta-fallback: skill-by-tool-ownership. If the LLM called any tool
      // owned by skill X (not the skill_delete tool itself, which has an
      // explicit id arg the framework already handles), and the user said
      // "the X skill" / "X skill", learn that mapping. Only applies to the
      // built-in skill entity since no other entity has the same shape.
      await _learnSkillAliasFromOwningTool(userId, userText, toolName, fw);
    }
  } catch (e) {
    console.warn('[alias-learner] observeTurn failed:', e.message);
  }
}

/**
 * Cross-skill learn: when LLM calls a tool that belongs to a specific skill,
 * see if the user mentioned the skill by name and learn that alias. This
 * pattern can't live inside a single skill's alias_catalog because the tool
 * args don't reference the skill id — the relationship is "tool → owning
 * skill" via the manifest registry, not via the tool's own args.
 */
async function _learnSkillAliasFromOwningTool(userId, userText, toolName, fw) {
  // Find which skill owns this tool.
  let skillId = null;
  try {
    const { listAllRoles } = await import('../roles.mjs');
    const owning = listAllRoles().find(m => (m.tools || []).some(t => t.function?.name === toolName));
    if (owning) skillId = owning.id;
  } catch { return; }
  if (!skillId) return;

  // Skip if a skill alias for the user's phrase already resolves to this id.
  const already = await fw.resolveFromMessage(userId, userText);
  if (already && already.entity_kind === 'skill' && already.id === skillId) return;

  // Extract a "the X skill" / "X skill" / "skill X" phrase. Reuse the
  // regex pattern set the framework would have compiled (singular="skill").
  const candidate = _extractPhraseFor(userText, 'skill');
  if (!candidate) return;
  try {
    fw.setAliasExternal(userId, 'skill', candidate, skillId);
    console.log(`[alias-learner] learned skill alias: "${candidate}" → ${skillId} (observed via owning tool)`);
  } catch { /* validation failure — ignore */ }
}

// ── Path B: clarification + affirmation ─────────────────────────────────────

const CLARIFY_PATTERNS = [
  /\bdid\s+you\s+mean\s+(?:the\s+)?(?:["']?)([A-Za-z0-9 _-]{2,40})(?:["']?)\s*\??/i,
  /\bdo\s+you\s+mean\s+(?:the\s+)?(?:["']?)([A-Za-z0-9 _-]{2,40})(?:["']?)\s*\??/i,
  /\bwould\s+that\s+be\s+(?:the\s+)?(?:["']?)([A-Za-z0-9 _-]{2,40})(?:["']?)\s*\??/i,
];

const AFFIRMATION_RE = /^(yes|yeah|yep|yup|sure|correct|right|that one|that's it|exactly|affirmative|ok|okay)\b[\s.!?]*$/i;

/**
 * Called after the LLM responds. Looks for "did you mean X?" in the
 * assistant text and stashes a pending-clarification record so a follow-up
 * "yes" from the user can complete the learning loop.
 *
 * The candidate (X) is resolved by the framework's probeAllRegistered, which
 * tries every registered entity_kind. If X doesn't resolve to a real entity,
 * nothing is stashed — there's nothing useful to learn.
 */
export async function maybeStashClarification(userId, userText, assistantText) {
  if (!userId || typeof assistantText !== 'string') return;
  _gcPending();
  if (_pending.size >= PENDING_MAX_USERS) {
    _pending.delete(_pending.keys().next().value);
  }
  let candidate = null;
  for (const re of CLARIFY_PATTERNS) {
    const m = assistantText.match(re);
    if (m && m[1]) { candidate = m[1].trim().replace(/[,.;:!?]+$/, ''); break; }
  }
  if (!candidate) return;

  let entityKind = null;
  let entityId = null;
  try {
    const fw = await import('./skill-alias-framework.mjs');
    const r = await fw.probeAllRegistered(userId, candidate);
    if (r) { entityKind = r.entity_kind; entityId = r.id; }
  } catch { return; }
  if (!entityKind || !entityId) return;

  _pending.set(userId, {
    origPhrase: _extractPhraseFor(userText, entityKind) || candidate,
    candidate,
    entityKind,
    entityId,
    ts: Date.now(),
  });
}

/**
 * Called BEFORE the next LLM turn. If a pending clarification is set and the
 * user's message is a short affirmation, save the alias and clear the
 * pending. Returns true if a learning event fired.
 */
export async function maybeConsumeAffirmation(userId, userText) {
  if (!userId || typeof userText !== 'string') return false;
  _gcPending();
  const pending = _pending.get(userId);
  if (!pending) return false;
  if (!AFFIRMATION_RE.test(userText.trim())) {
    // User didn't say yes — drop the stale clarification so it can't apply
    // to a future unrelated affirmation.
    _pending.delete(userId);
    return false;
  }
  _pending.delete(userId);

  try {
    const fw = await import('./skill-alias-framework.mjs');
    fw.setAliasExternal(userId, pending.entityKind, pending.origPhrase, pending.entityId);
    console.log(`[alias-learner] learned ${pending.entityKind} alias: "${pending.origPhrase}" → ${pending.entityId} (confirmed)`);
    return true;
  } catch (e) {
    console.warn('[alias-learner] confirmed-learn failed:', e.message);
    return false;
  }
}

// ── Phrase extraction (entity-kind aware, used by Path B + meta-learn) ──────

/**
 * Apply the same regex set the framework would build for a given entity kind
 * directly against user text, to extract the candidate phrase. We do this
 * here (rather than reaching into the framework's compiled patterns) so the
 * learner stays decoupled from framework internals.
 */
function _extractPhraseFor(text, entityKind) {
  const NOUN_BY_KIND = {
    skill: { sing: 'skill', plural: 'skills' },
    agent: { sing: 'agent', plural: 'agents' },
    node:  { sing: 'node',  plural: 'nodes'  },
    email_account: { sing: 'account', plural: 'accounts' },
    project: { sing: 'project', plural: 'projects' },
  };
  // Look up by kind for built-ins; fall back to using the kind itself as a
  // singular noun for manifest-declared kinds we don't have hard-coded.
  const cfg = NOUN_BY_KIND[entityKind] || { sing: entityKind, plural: `${entityKind}s` };
  const ns = cfg.sing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const np = cfg.plural.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const generic = [
    new RegExp(`\\bthe\\s+([A-Za-z][A-Za-z0-9 _-]{1,40}?)\\s+(?:${ns}|${np})\\b`, 'i'),
    new RegExp(`\\b([A-Za-z][A-Za-z0-9 _-]{1,40}?)\\s+(?:${ns}|${np})\\b`, 'i'),
  ];
  for (const re of generic) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim().replace(/[,.;:!?]+$/, '');
  }
  return null;
}

// ── Session helpers ─────────────────────────────────────────────────────────

async function _readLastAssistantMessage(userId, scopedSessionKey) {
  const agentPart = scopedSessionKey?.startsWith(`${userId}_`)
    ? scopedSessionKey.slice(userId.length + 1)
    : scopedSessionKey;
  if (!agentPart) return null;
  const p = path.join(USERS_DIR, userId, 'sessions', `${agentPart}.jsonl`);
  if (!fs.existsSync(p)) return null;
  const fd = await fs.promises.open(p, 'r');
  try {
    const stat = await fd.stat();
    const size = stat.size;
    const readFrom = Math.max(0, size - 16384);
    const buf = Buffer.alloc(size - readFrom);
    await fd.read(buf, 0, buf.length, readFrom);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          return msg;
        }
      } catch { /* skip malformed line */ }
    }
  } finally {
    await fd.close();
  }
  return null;
}
