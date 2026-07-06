// @ts-check
/**
 * ctx.registerLead — the personalization counterpart to ctx.proposeMonitor
 * (lib/monitor-helper.mjs). Lets a skill's tool handler register an "I'll
 * check back on this and let you know" open lead without re-deriving cadence
 * math or the announce-line phrasing.
 *
 * Wired into buildCtx by the integrator (roles.mjs:1176, right after
 * ctx.proposeMonitor): `ctx.registerLead = buildRegisterLead({ userId,
 * agentId: wsAgentId })`.
 */
import { addLead, parseRefreshCadence, nextCheckFromCadence } from './leads.mjs';

/** Friendly relative-time phrasing for the announce line. */
function describeWhen(iso) {
  const target = new Date(iso).getTime();
  const now = Date.now();
  if (!Number.isFinite(target) || target <= now) return 'shortly';
  const diffMs = target - now;
  const mins = Math.round(diffMs / 60000);
  if (mins <= 15) return 'shortly';
  if (mins < 90) return `in about ${mins < 60 ? mins + ' minutes' : 'an hour'}`;
  const hours = Math.round(diffMs / 3600000);
  if (hours < 20) return `in about ${hours} hours`;
  const t = new Date(target), n = new Date(now);
  const dayDiff = Math.round(
    (new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
      - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86400000
  );
  if (dayDiff <= 1) return 'tomorrow morning';
  if (dayDiff <= 7) {
    const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][t.getDay()];
    return `on ${wd}`;
  }
  return 'in a few days';
}

/**
 * Builds the ctx.registerLead closure bound to (userId, agentId). Returns
 * async (leadPartial) => {ok, announce} — announce is always a one-line,
 * user-facing sentence the calling skill can include in its own reply
 * ("…I'll check <when> and let you know.").
 *
 * @param {{userId: string, agentId: string|null}} bindings
 */
export function buildRegisterLead({ userId, agentId }) {
  return async function registerLead(leadPartial = /** @type {any} */ ({})) {
    try {
      if (!leadPartial || typeof leadPartial !== 'object' || !leadPartial.query) {
        throw new Error('registerLead: query (string) required');
      }

      // Declared skill cadence wins over the caller's own estimate (e.g. an
      // LLM-guessed cadenceHint) — see roles.mjs getRoleManifest + the
      // refreshCadence manifest field.
      let declaredCadence = null;
      if (leadPartial.skillId) {
        try {
          const { getRoleManifest } = await import('../../roles.mjs');
          declaredCadence = getRoleManifest(leadPartial.skillId, userId)?.refreshCadence || null;
        } catch (e) {
          console.warn(`[personalization] registerLead: getRoleManifest lookup failed: ${e.message}`);
        }
      }
      const cadenceStr = declaredCadence || leadPartial.cadenceHint || null;
      const cadence = parseRefreshCadence(cadenceStr) || { kind: 'daily' };
      const now = new Date();
      const nextCheckAt = leadPartial.nextCheckAt || nextCheckFromCadence(cadence, now);

      const result = await addLead(userId, {
        ...leadPartial,
        agentId: agentId || null,
        cadenceHint: cadenceStr,
        nextCheckAt,
      });

      // addLead rejects a lead outright (never stores it) when its toolName
      // isn't lead-eligible — {rejected:'mutating-tool'} (the name itself
      // looks like a mutation/notification) or {rejected:'not-lead-eligible'}
      // (not mutating by name, but also not a known-safe read-only tool —
      // e.g. node_exec; see leads.mjs's isLeadEligibleTool). Either way the
      // result has no `.deduped` field. Falling through to the success
      // branch below would return {ok:true, announce:"I'll check ... and let
      // you know."} for a lead that was never registered —
      // describeWhen(undefined) even degrades to 'shortly', making the false
      // promise read as imminent. Report failure honestly instead so the
      // calling skill never tells the user it will follow up on something
      // that can't happen.
      if (result?.rejected) {
        return {
          ok: false,
          announce: "I can't set up an automatic follow-up for that (I can only re-check simple read-only lookups automatically), so I won't be checking back on this one.",
        };
      }

      if (result?.deduped) {
        if (result.capped) {
          return {
            ok: false,
            announce: "I'm already tracking as much as I can for you right now, so I couldn't add that one — let me know if I should drop an older one.",
          };
        }
        const when = describeWhen(result.existing?.nextCheckAt || nextCheckAt);
        return { ok: true, announce: `I'm already keeping an eye on that — I'll check ${when} and let you know.` };
      }

      const when = describeWhen(result.nextCheckAt);
      return { ok: true, announce: `I'll check ${when} and let you know.` };
    } catch (e) {
      console.warn(`[personalization] registerLead failed: ${e.message}`);
      return { ok: false, announce: "I couldn't set that up to check on later." };
    }
  };
}
