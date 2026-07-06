// @ts-check
/**
 * The 15-minute lead sweep. Called inline from the 'personalizationLeadSweep'
 * scheduler builtin (scheduler-init.mjs) for every user with active leads —
 * NEVER via addTask (a scheduled run can't create a task; ADDENDUM A /
 * scheduler.mjs:205-208, and builtins run in scheduled context).
 *
 * Each due lead gets re-invoked via its stored tool+args, judged hit/miss by
 * a tiny completeJSON call, and either:
 *   - hit  → notified now (existing WS status/notify path), held for quiet
 *            hours (notifyAfter), or — once the daily ping budget is
 *            exhausted — queued for the briefing: reflect.mjs's
 *            getBriefingSection renders any pendingNotify hit and marks it
 *            notified there. This sweep's own pass-1 (below) only flushes a
 *            held hit once quiet hours end / budget resets on their own;
 *            getBriefingSection is the OTHER way a held hit can be delivered.
 *   - miss → checksLeft decremented, rescheduled by cadence, or expired
 *            quietly (no throw, no user-visible error) once checksLeft hits 0.
 *   - inconclusive (the judge call itself failed) → rescheduled without
 *            consuming a check, same as an unresolved reflection model
 *            below (_deferRescheduleIso) — the tool already ran, but a judge
 *            infra failure isn't the lead's fault, so checksLeft must stay
 *            untouched either way.
 *
 * Safety: a due lead whose toolName isn't lead-eligible (see leads.mjs's
 * isLeadEligibleTool — not mutating by name, not destructive-by-name, and
 * either a builtin read-only lookup or the owning skill's manifest opts the
 * tool in via `readOnly: true`; addLead already rejects these at
 * registration, this is the second layer) is NEVER invoked; it's expired
 * immediately with lastResult 'invalid tool'.
 */
import {
  dueLeads, listLeads, recordLeadCheck, markLeadNotifyState,
  parseRefreshCadence, nextCheckFromCadence, isLeadEligibleTool, expireLead, rescheduleLead,
} from './leads.mjs';
import { consumePingBudget } from './graduation.mjs';
import { suppressObservations } from './recorder.mjs';

const RESULT_EXCERPT_MAX = 1500;
const DEFAULT_QUIET_END_HOUR = 8;
// Floor for how far out a due lead gets pushed when this cycle can't reach a
// verdict for a reason that isn't the lead's fault: either no reflection
// model resolved (privacy hard rule: never invoke the tool without a model to
// judge the result) or the judge call itself failed after the tool already
// ran. Either way: never just leave the lead "due" forever — see the loop in
// runDueLeads below.
const DEFER_MIN_RESCHEDULE_MS = 6 * 60 * 60 * 1000;

async function _safeConfig(userId) {
  const DEFAULTS = { quietHours: { start: '22:00', end: '08:00' } };
  try {
    const { getConfig } = await import('./config.mjs');
    const cfg = await getConfig(userId);
    return { ...DEFAULTS, ...cfg };
  } catch (e) {
    console.warn(`[personalization] lead-runner: config unavailable, using defaults (${e.message})`);
    return DEFAULTS;
  }
}

async function _isQuietHours(cfg, now) {
  try {
    const { isQuietHours } = await import('./config.mjs');
    return !!isQuietHours(cfg, now);
  } catch (e) {
    console.warn(`[personalization] lead-runner: isQuietHours unavailable, assuming not-quiet (${e.message})`);
    return false; // fail open — a rare unwanted ping beats a lead that never delivers
  }
}

async function _resolveModel(userId) {
  try {
    const { resolveReflectionModel } = await import('./providers.mjs');
    return await resolveReflectionModel(userId);
  } catch (e) {
    console.warn(`[personalization] lead-runner: resolveReflectionModel failed for ${userId}: ${e.message}`);
    return null;
  }
}

/**
 * Re-invokes the lead's stored tool+args, collecting {type:'result'} text.
 * Wrapped in suppressObservations for the real (non-test-seam) path — this is
 * the personalization system re-checking its OWN lead, not the user making a
 * fresh request, so it must never land in the observation log as if it were
 * user activity (reflection would otherwise read the sweep's own polling
 * back as evidence of a user pattern).
 */
async function _runTool(toolName, args, userId, agentId, _testExecuteTool) {
  if (typeof _testExecuteTool === 'function') return _testExecuteTool(toolName, args, userId);
  const { executeToolStreaming } = await import('../../roles.mjs');
  return suppressObservations(async () => {
    let text = '';
    for await (const ev of executeToolStreaming(toolName, args || {}, userId, agentId || null, null)) {
      if (ev?.type === 'result' && typeof ev.text === 'string') text += (text ? '\n' : '') + ev.text;
    }
    return text;
  });
}

/**
 * How far to push a due lead's nextCheckAt out when this cycle can't reach a
 * verdict WITHOUT the lead's own fault — either no reflection model resolved
 * (the tool is never invoked at all) or the judge call itself failed after
 * the tool already ran (completeJSON threw, so _judge returned null). At
 * least DEFER_MIN_RESCHEDULE_MS, or the lead's own declared/guessed cadence
 * if that's further out. Never less than the floor — a lead whose cadence is
 * 'hourly' must not spin the sweep every 15 minutes just because the
 * model/judge happens to be unavailable right now. Neither caller decrements
 * checksLeft (see both call sites in runDueLeads below).
 */
function _deferRescheduleIso(lead, now) {
  const cadence = parseRefreshCadence(lead.cadenceHint) || { kind: 'daily' };
  const cadenceNextMs = Date.parse(nextCheckFromCadence(cadence, now));
  const floorMs = now.getTime() + DEFER_MIN_RESCHEDULE_MS;
  return new Date(Math.max(Number.isFinite(cadenceNextMs) ? cadenceNextMs : 0, floorMs)).toISOString();
}

/** Tiny hit/miss judge call — "did this result satisfy: <query>?" */
async function _judge({ userId, providerId, model, query, resultText, _testCompleteJSON }) {
  const system = 'You are checking whether a background tool re-check satisfied a user\'s standing question. '
    + 'Reply with JSON ONLY, no prose, matching this schema: {"hit": true|false, "line": "<one-line, plain-language summary, <=200 chars>"}. '
    + 'Only say hit:true if the result concretely satisfies the query below. Never invent facts that are not present in the result.';
  const user = `QUERY: ${query}\n\nLATEST RESULT:\n${(resultText || '(no result / tool unavailable)').slice(0, RESULT_EXCERPT_MAX)}\n\n`
    + 'Does this concretely satisfy the query? Respond with the JSON object only.';
  const schema = { hit: 'boolean', line: 'string, <=200 chars' };
  try {
    const fn = typeof _testCompleteJSON === 'function'
      ? _testCompleteJSON
      : (await import('./providers.mjs')).completeJSON;
    const { json } = await fn({ userId, providerId, model, system, user, schema, maxTokens: 200 });
    const hit = json?.hit === true;
    const line = (typeof json?.line === 'string' && json.line.trim())
      ? json.line.trim().slice(0, 200)
      : (hit ? String(query).slice(0, 200) : 'No update yet.');
    return { hit, line };
  } catch (e) {
    console.warn(`[personalization] lead-runner: judge call failed: ${e.message}`);
    return null; // inconclusive — caller must not consume a check on infra failure
  }
}

function _quietEndIso(cfg, now) {
  const [h, m] = String(cfg?.quietHours?.end || '08:00').split(':').map(Number);
  const next = new Date(now);
  next.setHours(Number.isFinite(h) ? h : DEFAULT_QUIET_END_HOUR, Number.isFinite(m) ? m : 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/**
 * Delivers (or holds) a hit. Order per ADDENDUM H: quiet hours holds first
 * (notifyAfter=quiet-end), THEN the daily ping budget is consumed — a lead
 * that clears quiet hours but has no budget left queues for the briefing
 * instead of the sweep re-trying every 15 minutes.
 */
async function _deliverHit(userId, leadId, line, cfg, now) {
  const quiet = await _isQuietHours(cfg, now);
  if (quiet) {
    await markLeadNotifyState(userId, leadId, { pendingNotify: true, notifyAfter: _quietEndIso(cfg, now) });
    return false;
  }
  const budgetOk = await consumePingBudget(userId).catch(e => {
    console.warn(`[personalization] lead-runner: consumePingBudget failed: ${e.message}`);
    return false;
  });
  if (!budgetOk) {
    await markLeadNotifyState(userId, leadId, { pendingNotify: true, notifyAfter: null });
    return false;
  }
  try {
    const { notifyUser } = await import('./notify.mjs');
    notifyUser(userId, {
      type: 'status', kind: 'personalization', watcherId: `lead_${leadId}`,
      label: 'Personalization', text: line, final: true, finalStatus: 'done',
    });
  } catch (e) {
    console.warn(`[personalization] lead-runner: notifyUser unavailable: ${e.message}`);
  }
  await markLeadNotifyState(userId, leadId, { pendingNotify: false, notifyAfter: null, notifiedAt: new Date().toISOString() });
  return true;
}

/**
 * Re-checks every due lead for one user. Test seam: pass _testExecuteTool /
 * _testCompleteJSON to bypass real tool execution / LLM calls.
 * @param {string} userId
 * @param {Object} [testSeams]
 * @param {Function} [testSeams._testExecuteTool]
 * @param {Function} [testSeams._testCompleteJSON]
 */
export async function runDueLeads(userId, { _testExecuteTool, _testCompleteJSON } = {}) {
  let checked = 0, hits = 0, expired = 0;
  const now = new Date();
  try {
    const cfg = await _safeConfig(userId);

    // Pass 1: flush any previously-hit leads that were held back for quiet
    // hours or an exhausted ping budget and are now clear to go out.
    const all = await listLeads(userId, { activeOnly: false });
    for (const lead of all) {
      if (lead.status !== 'hit' || !lead.pendingNotify) continue;
      if (lead.notifyAfter && new Date(lead.notifyAfter).getTime() > now.getTime()) continue;
      try {
        await _deliverHit(userId, lead.id, lead.lastResult || `Update on: ${lead.query}`, cfg, now);
      } catch (e) {
        console.warn(`[personalization] lead-runner: pending-notify delivery failed for ${lead.id}: ${e.message}`);
      }
    }

    // Pass 2: re-check active leads whose nextCheckAt has arrived.
    const due = await dueLeads(userId, now);
    if (!due.length) return { checked, hits, expired };

    const model = await _resolveModel(userId);
    // "log once" per sweep, not once per due lead — a whole batch of due
    // leads sharing the same unresolved-model cause shouldn't spam the log.
    let warnedNoModel = false;

    for (const lead of due) {
      checked++;

      if (!lead.toolName) {
        // Nothing to re-invoke — consume a check quietly so a tool-less
        // lead doesn't linger forever, rather than spending an LLM call on it.
        const cadence = parseRefreshCadence(lead.cadenceHint) || { kind: 'daily' };
        const updated = await recordLeadCheck(userId, lead.id, {
          hit: false, resultLine: 'No re-check tool available.', nextCheckAt: nextCheckFromCadence(cadence, now),
        });
        if (updated?.status === 'expired') expired++;
        continue;
      }

      // Second guard layer (addLead is the first, at registration time) —
      // never invoke a tool that isn't lead-eligible even if one somehow made
      // it onto disk (e.g. a lead written before this guard existed, its
      // owning skill's manifest dropped the `readOnly` flag since
      // registration, or a name like `node_exec` that no name-shape
      // blocklist would ever catch — see leads.mjs's isLeadEligibleTool).
      // Expire immediately rather than decrementing checksLeft: this isn't
      // "no update yet", it's "this lead should never have existed".
      if (!(await isLeadEligibleTool(lead.toolName, { skillId: lead.skillId, userId }))) {
        console.warn(`[personalization] lead-runner: refusing to invoke non-lead-eligible tool "${lead.toolName}" for lead ${lead.id} — expiring instead`);
        await expireLead(userId, lead.id, 'invalid tool');
        expired++;
        continue;
      }

      // No-silent-fallback-across-the-privacy-boundary: if no reflection
      // model resolved (e.g. the user's local provider is unreachable, or
      // model is explicitly set to 'off'), this MUST be checked BEFORE the
      // tool is invoked — not after. Invoking first and only then bailing
      // meant a lead's tool (a live web/API fetch, in the general case) was
      // re-executed every 15-minute sweep with the result simply discarded,
      // AND checksLeft/nextCheckAt were never touched, so the lead stayed
      // "due" forever: an unbounded re-invocation loop with no expiry.
      // Reschedule (without consuming a check) far enough out that an
      // unresolved model can't spin the sweep — this genuinely isn't the
      // lead's fault, so checksLeft must stay untouched either way.
      if (!model && !_testCompleteJSON) {
        if (!warnedNoModel) {
          console.warn(`[personalization] lead-runner: no reflection model resolved for ${userId} — deferring due leads without invoking their tools`);
          warnedNoModel = true;
        }
        try {
          await rescheduleLead(userId, lead.id, _deferRescheduleIso(lead, now));
        } catch (e) {
          console.warn(`[personalization] lead-runner: reschedule-without-model failed for ${lead.id}: ${e.message}`);
        }
        continue;
      }

      let resultText = '';
      try {
        resultText = await _runTool(lead.toolName, lead.args, userId, lead.agentId, _testExecuteTool);
      } catch (e) {
        console.warn(`[personalization] lead-runner: tool re-check failed for ${lead.id} (${lead.toolName}): ${e.message}`);
        resultText = '';
      }

      const verdict = await _judge({
        userId, providerId: model?.providerId, model: model?.model,
        query: lead.query, resultText, _testCompleteJSON,
      });
      if (!verdict) {
        // The tool has ALREADY run — unlike the no-model branch above, this
        // failure happens AFTER invocation, so a bare `continue` would leave
        // nextCheckAt/checksLeft untouched and the lead would still be "due"
        // on the very next 15-minute sweep, re-running the tool every cycle
        // for as long as the judge call (completeJSON) keeps throwing.
        // Reschedule without consuming a check — same escape hatch as the
        // no-model path, since a judge-infra failure isn't the lead's fault
        // either.
        try {
          await rescheduleLead(userId, lead.id, _deferRescheduleIso(lead, now));
        } catch (e) {
          console.warn(`[personalization] lead-runner: reschedule-after-judge-failure failed for ${lead.id}: ${e.message}`);
        }
        continue;
      }

      if (verdict.hit) {
        hits++;
        await recordLeadCheck(userId, lead.id, { hit: true, resultLine: verdict.line });
        try {
          await _deliverHit(userId, lead.id, verdict.line, cfg, now);
        } catch (e) {
          console.warn(`[personalization] lead-runner: hit delivery failed for ${lead.id}: ${e.message}`);
        }
      } else {
        const cadence = parseRefreshCadence(lead.cadenceHint) || { kind: 'daily' };
        const updated = await recordLeadCheck(userId, lead.id, {
          hit: false, resultLine: verdict.line, nextCheckAt: nextCheckFromCadence(cadence, now),
        });
        if (updated?.status === 'expired') expired++;
      }
    }
  } catch (e) {
    console.error(`[personalization] runDueLeads failed for ${userId}: ${e.message}`);
  }
  return { checked, hits, expired };
}
