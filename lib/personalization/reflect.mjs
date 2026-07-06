// @ts-check
/**
 * Reflection — the core Personalization loop. Runs every 6 hours (see
 * lib/personalization/scheduler-init.mjs) — "nightly" was the original
 * once-a-day cadence this ran on; the name stuck around in a few internal
 * identifiers (the scheduler builtin key is still 'personalizationNightly')
 * but the actual cadence is no longer nightly.
 *
 * runReflection() gathers a user's recent signal (observation digests,
 * upcoming calendar, recent session summaries, and what's already been
 * inferred about them), asks an LLM for a strict-JSON analysis (temporal
 * patterns / facts / relationships / preferences / contradictions / unmet
 * intents / a handful of ask-first offers), hard-caps + validates whatever
 * comes back regardless of what the model actually produced, then applies
 * it: inferences go to cortex + the ledger sidecar (lib/personalization/
 * ledger.mjs), offers become ask-first proposals (or, once a kind has
 * graduated to auto-approved, execute directly with a receipt notice),
 * open questions become leads the 15-min sweep (lead-runner.mjs) re-checks.
 *
 * Privacy hard rule: if the resolved provider fails for ANY reason (network
 * down, auth expired, unparseable output twice), the run is SKIPPED and the
 * failure recorded in lastRun.notice — never retried against a different
 * provider. This is enforced by treating every completeJSON rejection the
 * same way, so there's no special-casing to get wrong between "local pick
 * down" and "cloud pick down".
 *
 * getBriefingSection() is the free, no-LLM half: it renders whatever is
 * already on disk (recent ledger entries, pending personalization_offer
 * proposals, and any budget/quiet-hours-held lead hits — see its own doc
 * comment for why a briefing is allowed to bypass those holds) into a short
 * text block a scheduled "briefing" task can append (wired by the integrator
 * in scheduler.mjs — see ADDENDUM D).
 */
import { randomUUID } from 'crypto';
import { getConfig, saveConfig } from './config.mjs';
import { readObservations } from './observations.mjs';
import { addLead, listLeads, markLeadNotifyState, parseRefreshCadence, nextCheckFromCadence } from './leads.mjs';
import { isKindSuppressed, isKindAutoApproved } from './graduation.mjs';
import { applyInference, listLedger } from './ledger.mjs';
import { resolveReflectionModel, completeJSON } from './providers.mjs';
import { getFreshMirror, eventStartMs } from '../calendar-mirror.mjs';
import { getUserCoordinatorAgentId } from '../../routes/_helpers.mjs';

// Re-running within this window (unless force:true) is a no-op that just
// echoes the previous lastRun — guards against a double-fire (e.g. a manual
// "Run now" click landing seconds before/after the scheduled reflection
// builtin fires) burning an extra LLM call and a second round of
// proposals/leads for one run. Well under the 6-hour reflection cadence, so
// it only ever catches genuine double-fires, never a legitimately-due run.
const MIN_RERUN_INTERVAL_MS = 30 * 60_000;

// Prompt-size guards — readObservations can return up to 2000 lines and a
// week of calendar/session data can be large; none of that is useful past a
// few dozen most-recent items for THIS prompt (older signal already shaped
// today's ledger), so we cap what actually goes in regardless of source caps.
const OBS_PROMPT_CAP = 200;
const CALENDAR_PROMPT_CAP = 40;
const SUMMARIES_PROMPT_CAP = 20;
const MEMORIES_PROMPT_CAP = 60;
const SESSION_SUMMARY_LOOKBACK_DAYS = 7;
const CALENDAR_LOOKAHEAD_DAYS = 7;

const VALID_INFERENCE_TYPES = new Set(['pattern', 'fact', 'relationship', 'preference']);
const VALID_VERBS = new Set(['new', 'reinforce', 'contradict']);
const MAX_STATEMENT_LEN = 300;

const OUTPUT_SCHEMA = `{
  "inferences": [{"type": "pattern|fact|relationship|preference", "statement": "<=300 chars, durable — NEVER a restatement of a single calendar event/appointment", "confidence": 0.0-1.0, "evidence": ["obs/summary id", "..."], "verb": "new|reinforce|contradict", "targetMemoryId": "<existing memory id from [EXISTING MEMORIES], required for reinforce/contradict, else null>"}],
  "offers": [{"kind": "stable-kebab-slug", "title": "short title", "body": "one or two sentences", "action": {"tool": "set_reminder", "args": {"label": "short reminder label (REQUIRED)", "datetime": "<ISO 8601 with timezone offset, REQUIRED for one-shot>", "repeat": "once"}}, "expiresAt": "<ISO date, or null>"}],
  "open_leads": [{"query": "the user's original want, restated neutrally, one line", "toolName": "<the SAME read-only data-fetch tool that produced the miss, or null — NEVER set_reminder/schedule_task/send_*/any mutating tool>", "args": {}, "skillId": "<owning skill id, or null>", "nextCheckAt": "<ISO date>", "why": "one line: what unmet intent this addresses"}]
}`;

// Exported solely as a test seam (personalization-reflect.test.mjs asserts
// the durability-test / forbidden-echo / mutating-tool-guard wording below
// stays in place) — runReflection is still the only export other modules use.
export function buildSystemPrompt({ maxInferences, maxOffers, maxLeads }) {
  return `You are a careful personal-assistant analyst. You study a user's recent activity and produce structured, honest insights — nothing more.

Respond with JSON ONLY, matching this schema exactly (no prose, no markdown fences):
${OUTPUT_SCHEMA}

Rules:
- Every inference MUST cite at least one evidence id drawn from [OBSERVATIONS] or [RECENT SESSION SUMMARIES]. Never invent one.
- Confidence must be honest — use low values (below 0.5) for weak signal. Do not inflate.
- NEVER invent events, facts, or calendar entries that are not present in the sections below.
- DURABILITY TEST (required for every inference before you include it): would this statement still be true and useful in about a month? If the honest answer is no, it is NOT an inference — leave it out entirely (it does not belong anywhere in "inferences").
  - FORBIDDEN as inferences: restating a single calendar event or appointment — e.g. "You have a scheduled event called Team Huddle today at 6:00 PM local time.", "You have two flights to Springfield on May 12.", "Alex's birthday is on May 15." These are one-off facts about a specific occurrence, not durable learning. A calendar event only becomes inference-worthy once it reveals a genuine recurring pattern, relationship, or preference — never from a single instance.
  - GOOD inference examples (each generalizes beyond the one event that revealed it): "User follows LG Twins baseball" (from a repeated cluster of games, not one game), "User regularly travels between Tokyo and Seoul" (from a recurring travel pattern, not one trip), "User's work schedule includes shared days off with their partner" (from a recurring overlap, not one shared day).
  - The "type" field must genuinely match the content: "pattern" = a recurring behavior seen across multiple observations; "relationship" = an ongoing connection to a person/place/organization; "preference" = a stated or behavior-implied like/dislike/habit; "fact" = a stable, durable attribute of the user's life. A single calendar event is never any of these — if you can't honestly assign one of these types to a durable claim, don't include the inference.
- Use verb "reinforce" or "contradict" (with targetMemoryId set to an id from [EXISTING MEMORIES]) when new signal supports or conflicts with something already known; otherwise use "new".
- Prefer "prepare"/"remind" style offers (packing reminders, prep tasks, timely follow-ups) over generic suggestions.
- Every offer's action.tool MUST be "set_reminder" (the only tool wired for automatic execution here) with valid args for it.
- open_leads may ONLY come from an unmet user intent found in [RECENT SESSION SUMMARIES]: the user asked for something, the answer available at the time was a miss (not found / not available yet / pending), and the answer could plausibly change later. "query" = the user's original want restated neutrally (e.g. "apples on BOGO sale at Publix"), "toolName"/"args" = the SAME read-only data-fetch tool and arguments that produced the miss — NEVER a reminder, scheduling, messaging, or any other mutating/notification tool (those belong in "offers" instead, never in "open_leads"). If there is no such qualifying unmet intent in this run, "open_leads" MUST be an empty array — never invent one to fill it.
- Cap yourself to at most ${maxInferences} inferences, ${maxOffers} offers, and ${maxLeads} open_leads. Fewer is fine — quality over quantity. An empty array in any field is fine if there's nothing worth surfacing. That said, when the evidence genuinely supports a durable statement (a repeated event class, a recurring correspondent, a travel pattern), DO include it — an empty "inferences" list is correct only when nothing durable is actually present in the inputs.`;
}

function buildUserPrompt({ existingMemories, observations, calendarEvents, sessionSummaries, now }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const lines = [`Today: ${now.toISOString()} (local timezone: ${tz})`, ''];

  lines.push('[EXISTING MEMORIES]');
  if (existingMemories.length) {
    for (const m of existingMemories) lines.push(`- id=${m.id} tier=${m.tier}${m.flag ? ` flag=${m.flag}` : ''}: ${m.statement}`);
  } else lines.push('(none yet)');
  lines.push('');

  lines.push('[OBSERVATIONS]');
  if (observations.length) {
    for (const o of observations) lines.push(`- id=${o.id} [${o.ts}] (${o.source}${o.skillId ? '/' + o.skillId : ''}/${o.kind}) ${o.digest}`);
  } else lines.push('(none since last run)');
  lines.push('');

  lines.push(`[CALENDAR NEXT ${CALENDAR_LOOKAHEAD_DAYS} DAYS]`);
  if (calendarEvents.length) {
    for (const e of calendarEvents) {
      const when = e.start?.dateTime || e.start?.date || 'unknown time';
      lines.push(`- ${e.summary || '(no title)'} — ${when}${e.location ? ` @ ${e.location}` : ''}`);
    }
  } else lines.push('(no calendar signal)');
  lines.push('');

  lines.push('[RECENT SESSION SUMMARIES]');
  if (sessionSummaries.length) {
    for (const s of sessionSummaries) lines.push(`- id=${s.id} [${s.created_at}] ${s.text}`);
  } else lines.push('(none)');

  return lines.join('\n');
}

function clampConfidence(v, fallback = 0.6) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

function sanitizeInferences(list, cap) {
  return (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.statement === 'string' && x.statement.trim() && x.statement.length <= MAX_STATEMENT_LEN)
    .slice(0, Math.max(0, cap))
    .map(x => {
      const verb = VALID_VERBS.has(x.verb) ? x.verb : 'new';
      const needsTarget = verb === 'reinforce' || verb === 'contradict';
      const targetMemoryId = needsTarget && typeof x.targetMemoryId === 'string' && x.targetMemoryId ? x.targetMemoryId : null;
      return {
        type: VALID_INFERENCE_TYPES.has(x.type) ? x.type : 'fact',
        statement: x.statement.trim(),
        confidence: clampConfidence(x.confidence),
        evidence: Array.isArray(x.evidence) ? x.evidence.slice(0, 10).map(String) : [],
        // A reinforce/contradict without a resolvable target degrades to 'new'
        // rather than being dropped — better to record it than lose the signal.
        verb: needsTarget && !targetMemoryId ? 'new' : verb,
        targetMemoryId,
      };
    });
}

// The only tool currently wired for offer execution (ask-first accept AND
// graduated auto-exec both eventually call action.tool directly) — reject
// anything else server-side rather than trust the model's own instruction-
// following, since a graduated kind executes without a human in the loop.
const ALLOWED_OFFER_TOOLS = new Set(['set_reminder']);

// A set_reminder offer is only executable with a real schedule: one-shot needs
// a parseable `datetime`, daily needs an HH:MM `time`. Offers failing this are
// dropped here (with a log) so they never become accept-then-fail proposals.
function offerHasValidSchedule(x) {
  const args = x?.action?.args;
  if (!args || typeof args !== 'object') return false;
  if (args.repeat === 'daily') return typeof args.time === 'string' && /^\d{1,2}:\d{2}$/.test(args.time);
  return typeof args.datetime === 'string' && !Number.isNaN(Date.parse(args.datetime));
}

function sanitizeOffers(list, cap) {
  return (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.kind === 'string' && x.kind.trim() && typeof x.title === 'string' && x.title.trim() && ALLOWED_OFFER_TOOLS.has(x.action?.tool))
    .filter(x => {
      const ok = offerHasValidSchedule(x);
      if (!ok) console.warn(`[personalization] dropped offer without valid schedule: ${x.kind}`);
      return ok;
    })
    .slice(0, Math.max(0, cap))
    .map(x => ({
      kind: String(x.kind).trim().slice(0, 60),
      title: String(x.title).trim().slice(0, 100),
      body: typeof x.body === 'string' ? x.body.slice(0, 400) : '',
      action: { tool: String(x.action.tool), args: (x.action.args && typeof x.action.args === 'object') ? x.action.args : {} },
      expiresAt: typeof x.expiresAt === 'string' && !Number.isNaN(Date.parse(x.expiresAt)) ? x.expiresAt : null,
    }));
}

function sanitizeOpenLeads(list, cap) {
  return (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.query === 'string' && x.query.trim())
    .slice(0, Math.max(0, cap))
    .map(x => ({
      query: String(x.query).trim().slice(0, 300),
      toolName: typeof x.toolName === 'string' && x.toolName ? x.toolName : null,
      args: (x.args && typeof x.args === 'object') ? x.args : {},
      skillId: typeof x.skillId === 'string' && x.skillId ? x.skillId : null,
      nextCheckAt: typeof x.nextCheckAt === 'string' && !Number.isNaN(Date.parse(x.nextCheckAt)) ? x.nextCheckAt : null,
      why: typeof x.why === 'string' ? x.why.slice(0, 200) : '',
    }));
}

// CONTRACTS v1.2 #5 — session summaries come ONLY from the user's coordinator
// agent's own episodes table (source='summary', see memory/session-buffer.mjs).
// This helper intentionally lives here, not memory/recall.mjs.
async function getRecentSessionSummaries(userId, daysBack = SESSION_SUMMARY_LOOKBACK_DAYS) {
  const coordId = getUserCoordinatorAgentId(userId);
  if (!coordId) return [];
  try {
    const { getTable } = await import('../../memory/lance.mjs');
    const { safeLanceVal } = await import('../../memory/shared.mjs');
    const isoCutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString();
    const table = await getTable(`${coordId}_episodes`, userId);
    return await table.query()
      .where(`source = 'summary' AND forgotten = false AND created_at >= '${safeLanceVal(isoCutoff)}'`)
      .toArray();
  } catch (e) {
    console.warn(`[personalization] getRecentSessionSummaries failed for ${userId}: ${e.message}`);
    return [];
  }
}

async function readObservationsSafe(userId, sinceIso) {
  try {
    return await readObservations(userId, { sinceTs: sinceIso, limit: 2000 });
  } catch (e) {
    console.warn(`[personalization] readObservations failed for ${userId}: ${e.message}`);
    return [];
  }
}

/**
 * Attempts direct tool execution for an auto-approved (graduated) offer kind.
 * Returns false on ANY doubt so the caller falls back to a normal ask-first
 * proposal — never crashes, never silently "succeeds" on an error-shaped
 * result.
 *
 * Wrapped in suppressObservations: this is the personalization system's OWN
 * automated tool invocation, not user activity — without the wrap, its
 * result would get recorded by roles.mjs's unconditional recordToolObservation
 * hook and feed back into the observation log as if the user had done it,
 * which the next reflection could misread as a genuine user pattern.
 */
async function autoExecuteOffer(userId, agentId, offer) {
  try {
    const { executeToolStreaming } = await import('../../roles.mjs');
    const { suppressObservations } = await import('./recorder.mjs');
    const { sawResult, isError } = await suppressObservations(async () => {
      let t = '';
      let saw = false;
      let err = false;
      for await (const ev of executeToolStreaming(offer.action.tool, offer.action.args || {}, userId, agentId, null)) {
        if (ev?.type === 'result' && typeof ev.text === 'string') {
          t += (t ? '\n' : '') + ev.text;
          saw = true;
          if (ev.isError) err = true;
        }
      }
      return { text: t, sawResult: saw, isError: err };
    });
    if (!sawResult) return false;
    // Trust executeToolStreaming's own isError flag — the same convention
    // offer-handlers.mjs's _runAction uses — rather than text-sniffing a
    // regex. The regex this replaced never matched the dispatcher's
    // canonical normalized failure shape 'Tool error: <msg>' (it starts with
    // "Tool", not "error"), so a graduated offer whose tool genuinely failed
    // was reported as a false success ("Done automatically: …").
    if (isError) return false;
    try {
      const { notifyUser } = await import('./notify.mjs');
      notifyUser(userId, {
        type: 'status', kind: 'personalization', watcherId: `offer_${offer.kind}_${Date.now()}`,
        label: 'Personalization', text: `Done automatically: ${offer.title}`, final: true, finalStatus: 'done',
      });
    } catch (e) {
      console.warn(`[personalization] autoExecuteOffer: notify failed: ${e.message}`);
    }
    return true;
  } catch (e) {
    console.warn(`[personalization] autoExecuteOffer failed for kind "${offer.kind}", falling back to a proposal: ${e.message}`);
    return false;
  }
}

/** Creates the ask-first 'personalization_offer' proposal (CONTRACTS v1.2 #1). */
async function proposeOffer(userId, agentId, offer) {
  // @ts-ignore — createProposal is exported by the integrator's hunk (it's
  // currently module-private in lib/proposals.mjs); the runtime guard right
  // below handles the pre-integration window without throwing.
  const { createProposal } = await import('../proposals.mjs');
  if (typeof createProposal !== 'function') {
    console.warn('[personalization] proposeOffer: createProposal is not exported from lib/proposals.mjs yet — skipping offer');
    return null;
  }
  return createProposal({
    id: 'prop_' + randomUUID().slice(0, 12),
    userId, agentId, kind: 'personalization_offer',
    message: offer.body ? `${offer.title}\n\n${offer.body}` : offer.title,
    accept_label: 'Yes, do it',
    dismiss_label: 'No thanks',
    createdAt: Date.now(),
    status: 'pending',
    offerKind: offer.kind,
    action: offer.action,
    graduate: false,
    expiresAt: offer.expiresAt || null,
  });
}

// `analyzedThroughTs` carries forward the watermark of the LAST SUCCESSFUL
// run (never the current attempt's `at`) — see runReflection's success path
// for where it actually advances. Passing the previous value through on
// every skip/failure path is what stops a failed run from permanently
// excising that window's observations from every future reflection: without
// it, persisting lastRun.at=now on a failure would become the next run's
// window start, silently dropping everything in between.
function skipStats(at, notice, analyzedThroughTs = null) {
  return { at, model: null, provider: null, tokensIn: 0, tokensOut: 0, inferences: 0, offers: 0, leads: 0, skipped: true, notice, analyzedThroughTs };
}

async function persistLastRun(userId, stats) {
  try {
    await saveConfig(userId, { lastRun: stats });
  } catch (e) {
    console.warn(`[personalization] runReflection: failed to persist lastRun for ${userId}: ${e.message}`);
  }
}

/**
 * Resolves an open_lead's nextCheckAt: a skill's declared refreshCadence
 * manifest field wins over the model's own guess (per the refreshCadence
 * spec section — "declared cadence wins over LLM estimate").
 */
async function resolveLeadNextCheckAt(userId, lead, now) {
  if (lead.skillId) {
    try {
      const { getRoleManifest } = await import('../../roles.mjs');
      const declared = getRoleManifest(lead.skillId, userId)?.refreshCadence;
      if (declared) {
        const cadence = parseRefreshCadence(declared);
        if (cadence) return nextCheckFromCadence(cadence, now);
      }
    } catch (e) {
      console.warn(`[personalization] resolveLeadNextCheckAt: manifest lookup failed for ${lead.skillId}: ${e.message}`);
    }
  }
  if (lead.nextCheckAt) return lead.nextCheckAt;
  return new Date(now.getTime() + 86_400_000).toISOString();
}

/**
 * Runs one scheduled (or forced) reflection pass for a user. See module doc.
 * Test seam (CONTRACTS v1.2 #4): pass `_testCompleteJSON` to replace
 * providers.completeJSON so tests never reach a real provider.
 *
 * @param {string} userId
 * @param {{force?: boolean, _testCompleteJSON?: Function}} [opts]
 * @returns {Promise<object>} lastRun-shaped stats — always returned, never throws
 */
export async function runReflection(userId, { force = false, _testCompleteJSON } = {}) {
  const startedAt = Date.now();
  const atIso = new Date(startedAt).toISOString();
  if (!userId) return skipStats(atIso, 'No user id.');

  let config;
  try {
    config = await getConfig(userId);
  } catch (e) {
    console.warn(`[personalization] runReflection: getConfig failed for ${userId}: ${e.message}`);
    return skipStats(atIso, 'Configuration unavailable.');
  }

  if (!config?.enabled) {
    const stats = skipStats(atIso, 'Personalization is turned off.', config.lastRun?.analyzedThroughTs ?? config.lastRun?.at ?? null);
    await persistLastRun(userId, stats);
    return stats;
  }

  if (!force && config.lastRun?.at) {
    const sinceMs = startedAt - Date.parse(config.lastRun.at);
    if (Number.isFinite(sinceMs) && sinceMs >= 0 && sinceMs < MIN_RERUN_INTERVAL_MS) {
      return { ...config.lastRun, skipped: true, notice: config.lastRun.notice || 'Already ran recently — skipped.' };
    }
  }

  const resolved = await resolveReflectionModel(userId).catch(e => {
    console.warn(`[personalization] resolveReflectionModel failed for ${userId}: ${e.message}`);
    return null;
  });
  if (!resolved) {
    const stats = skipStats(atIso, 'No model configured for personalization (model set to Off, or the coordinator has no provider/model set).', config.lastRun?.analyzedThroughTs ?? config.lastRun?.at ?? null);
    await persistLastRun(userId, stats);
    return stats;
  }

  // ── Gather inputs — every source is best-effort; a missing source narrows
  // context, it never fails the run. ──────────────────────────────────────
  // Watermark: analyzedThroughTs (set only on a successful run, below) wins
  // over the legacy `.at` field, which used to advance on EVERY run
  // (including skipped/failed ones) and could permanently exclude a whole
  // day's observations from ever being analyzed. `?? lastRun.at` is backcompat
  // for a lastRun object persisted before this field existed.
  const sinceTs = config.lastRun?.analyzedThroughTs ?? config.lastRun?.at ?? null;
  const [existingMemories, observations, mirror, sessionSummaries] = await Promise.all([
    listLedger(userId).catch(e => { console.warn(`[personalization] listLedger failed: ${e.message}`); return []; }),
    readObservationsSafe(userId, sinceTs),
    getFreshMirror(userId).catch(e => { console.warn(`[personalization] getFreshMirror failed: ${e.message}`); return null; }),
    getRecentSessionSummaries(userId),
  ]);

  const now = new Date();
  const lookaheadMs = now.getTime() + CALENDAR_LOOKAHEAD_DAYS * 86_400_000;
  const calendarEvents = (mirror?.events || [])
    .filter(e => { const t = eventStartMs(e); return t >= now.getTime() - 3_600_000 && t <= lookaheadMs; })
    .slice(0, CALENDAR_PROMPT_CAP);

  const maxInferences = Number.isFinite(config.maxInferencesPerRun) ? config.maxInferencesPerRun : 5;
  const maxOffers = Number.isFinite(config.maxOffersPerRun) ? config.maxOffersPerRun : 2;
  const maxLeads = Number.isFinite(config.maxOpenLeads) ? config.maxOpenLeads : 8;

  const systemPrompt = buildSystemPrompt({ maxInferences, maxOffers, maxLeads });
  const userPrompt = buildUserPrompt({
    existingMemories: existingMemories.slice(0, MEMORIES_PROMPT_CAP),
    observations: observations.slice(-OBS_PROMPT_CAP),
    calendarEvents,
    sessionSummaries: sessionSummaries.slice(0, SUMMARIES_PROMPT_CAP),
    now,
  });

  const complete = typeof _testCompleteJSON === 'function' ? _testCompleteJSON : completeJSON;
  let result;
  try {
    result = await complete({
      userId, providerId: resolved.providerId, model: resolved.model,
      system: systemPrompt, user: userPrompt, schema: OUTPUT_SCHEMA, maxTokens: 2000,
    });
  } catch (e) {
    // Privacy hard rule: never fall back to a different provider — just skip
    // and record why, regardless of which provider or failure mode it was.
    console.warn(`[personalization] reflection completion failed for ${userId} (${resolved.providerId}/${resolved.model}): ${e.message}`);
    const stats = {
      at: atIso, model: resolved.model, provider: resolved.providerId,
      tokensIn: 0, tokensOut: 0, inferences: 0, offers: 0, leads: 0,
      skipped: true, notice: `Couldn't complete this run with ${resolved.label} (${e.code || 'error'}) — skipped rather than switch providers.`,
      // Carry the prior watermark forward — this failed attempt must not
      // advance it (see skipStats' doc comment above).
      analyzedThroughTs: config.lastRun?.analyzedThroughTs ?? config.lastRun?.at ?? null,
    };
    await persistLastRun(userId, stats);
    return stats;
  }

  const inferences = sanitizeInferences(result.json?.inferences, maxInferences);
  const offers = sanitizeOffers(result.json?.offers, maxOffers);
  const openLeads = sanitizeOpenLeads(result.json?.open_leads, maxLeads);

  // ── Apply inferences to cortex + ledger ─────────────────────────────────
  let appliedCount = 0;
  for (const inf of inferences) {
    try {
      const r = await applyInference(userId, inf);
      if (r.action === 'created' || r.action === 'reinforced' || r.action === 'contradicted' || r.action === 'deduped') appliedCount++;
    } catch (e) {
      console.warn(`[personalization] applyInference failed: ${e.message}`);
    }
  }

  // ── Offers: ask-first proposals, or direct execution once a kind has
  // graduated to auto-approved (falling back to a proposal on any doubt). ──
  const coordId = getUserCoordinatorAgentId(userId);
  let offersCreated = 0;
  for (const offer of offers) {
    try {
      if (await isKindSuppressed(userId, offer.kind)) continue;
      if (coordId && await isKindAutoApproved(userId, offer.kind)) {
        const ok = await autoExecuteOffer(userId, coordId, offer);
        if (ok) { offersCreated++; continue; }
      }
      if (!coordId) { console.warn(`[personalization] no coordinator agent for ${userId} — cannot attach offer proposal`); continue; }
      const created = await proposeOffer(userId, coordId, offer);
      if (created) offersCreated++;
    } catch (e) {
      console.warn(`[personalization] offer handling failed for kind "${offer.kind}": ${e.message}`);
    }
  }

  // ── Open leads ───────────────────────────────────────────────────────────
  let leadsRegistered = 0;
  for (const lead of openLeads) {
    try {
      const nextCheckAt = await resolveLeadNextCheckAt(userId, lead, now);
      const added = await addLead(userId, {
        query: lead.query, toolName: lead.toolName, args: lead.args, skillId: lead.skillId,
        agentId: coordId || null, nextCheckAt,
      });
      // addLead returns {rejected:'mutating-tool'} for a lead whose toolName
      // fails the guard (defense-in-depth backstop for the prompt-level rule
      // above) — that's neither a fresh registration nor a dedupe, so it must
      // not inflate the leads-registered count.
      if (added && !added.deduped && !added.rejected) leadsRegistered++;
    } catch (e) {
      console.warn(`[personalization] addLead failed: ${e.message}`);
    }
  }

  const stats = {
    at: atIso, model: resolved.model, provider: resolved.providerId,
    // `?? null` (not `|| 0`) — a provider that genuinely couldn't surface
    // usage (e.g. a stream that ended before its usage event) reports null,
    // and that must survive into lastRun rather than being coerced to a
    // misleading 0.
    tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null,
    inferences: appliedCount, offers: offersCreated, leads: leadsRegistered,
    skipped: false, notice: null,
    // The watermark only ever advances on a genuinely successful run, and
    // always to the run-START timestamp (not "now" after however long the
    // LLM call + apply phase took) — so nothing that arrived mid-run is
    // skipped by the NEXT run's window.
    analyzedThroughTs: atIso,
  };
  await persistLastRun(userId, stats);
  return stats;
}

/**
 * The free, no-LLM half: renders whatever's already on disk into a compact
 * briefing blurb — recent ledger entries, a summary of pending
 * personalization_offer proposals, and any lead hits that were held back
 * from an unsolicited ping (quiet hours / exhausted daily ping budget — see
 * lead-runner.mjs's ADDENDUM H / _deliverHit). Returns null when there's
 * nothing to say (a fresh install, or a user with personalization off) so
 * the integrator's briefing-note builder can skip appending an empty
 * section.
 *
 * A briefing is user-SOLICITED in-channel content (the user asked to be
 * brought up to speed), not an unsolicited ping — so surfacing a held hit
 * here deliberately does NOT consume the ping budget and ignores
 * notifyAfter/quiet-hours, unlike lead-runner.mjs's own pass-1 flush. It
 * still counts as delivery, though: unlike the rest of this function, the
 * held-hit branch below has a side effect (markLeadNotifyState) — that's
 * deliberate bookkeeping, not an oversight, so the sweep's pass-1 never
 * delivers the same hit a second time.
 *
 * @param {string} userId
 * @returns {Promise<{text: string, offers: Array<object>} | null>}
 */
export async function getBriefingSection(userId) {
  if (!userId) return null;

  // Gate on config.enabled FIRST, before touching any residual data — a user
  // who has turned Personalization off (or was never on) must never get
  // learned-about-you content injected into a briefing, even if stale ledger
  // rows or a pending personalization_offer proposal are still on disk (the
  // only way to purge those today is the per-row Delete / Start fresh
  // actions, neither of which fires just from flipping the switch off).
  let config;
  try {
    config = await getConfig(userId);
  } catch (e) {
    console.warn(`[personalization] getBriefingSection: getConfig failed for ${userId}: ${e.message}`);
    return null;
  }
  if (!config?.enabled) return null;

  let ledgerRows = [];
  try {
    ledgerRows = await listLedger(userId);
  } catch (e) {
    console.warn(`[personalization] getBriefingSection: listLedger failed for ${userId}: ${e.message}`);
  }

  let pendingOffers = [];
  try {
    const { listUserProposals } = await import('../proposals.mjs');
    pendingOffers = listUserProposals(userId, 'pending').filter(p => p.kind === 'personalization_offer');
  } catch (e) {
    console.warn(`[personalization] getBriefingSection: listUserProposals failed for ${userId}: ${e.message}`);
  }

  // Hits held back by quiet hours or an exhausted daily ping budget
  // (ADDENDUM H) — activeOnly:false because a 'hit' lead is terminal, not
  // active, and would otherwise be invisible here.
  let heldHits = [];
  try {
    const allLeads = await listLeads(userId, { activeOnly: false });
    heldHits = allLeads.filter(l => l.status === 'hit' && l.pendingNotify);
  } catch (e) {
    console.warn(`[personalization] getBriefingSection: listLeads failed for ${userId}: ${e.message}`);
  }

  const cutoffMs = Date.now() - SESSION_SUMMARY_LOOKBACK_DAYS * 86_400_000;
  const recentFacts = ledgerRows
    .filter(r => !r.flag && Date.parse(r.createdAt || '') >= cutoffMs)
    .slice(0, 5);

  if (!recentFacts.length && !pendingOffers.length && !heldHits.length) return null;

  const lines = [];
  if (recentFacts.length) {
    lines.push("Here's what I've picked up about you recently:");
    for (const f of recentFacts) lines.push(`- ${f.statement}`);
  }
  if (pendingOffers.length) {
    if (lines.length) lines.push('');
    lines.push(`I also have ${pendingOffers.length} suggestion${pendingOffers.length > 1 ? 's' : ''} waiting for your OK — check the chat for the card${pendingOffers.length > 1 ? 's' : ''}.`);
  }
  if (heldHits.length) {
    if (lines.length) lines.push('');
    lines.push('While I was holding off on pinging you:');
    for (const lead of heldHits) lines.push(`- ${lead.lastResult || `Update on: ${lead.query}`}`);
  }

  const offers = pendingOffers.map(p => {
    const [title, ...rest] = String(p.message || '').split('\n');
    return { kind: p.offerKind ?? null, title: title || '', body: rest.join('\n').trim(), action: p.action ?? null, expiresAt: p.expiresAt ?? null };
  });

  // Delivery bookkeeping (deliberate side effect — see doc comment above):
  // mark every surfaced hit notified so lead-runner.mjs's own pass-1 flush
  // doesn't deliver the same hit again once quiet hours end / budget resets.
  if (heldHits.length) {
    const notifiedAt = new Date().toISOString();
    for (const lead of heldHits) {
      try {
        await markLeadNotifyState(userId, lead.id, { pendingNotify: false, notifyAfter: null, notifiedAt });
      } catch (e) {
        console.warn(`[personalization] getBriefingSection: markLeadNotifyState failed for ${lead.id}: ${e.message}`);
      }
    }
  }

  return { text: lines.join('\n'), offers };
}
