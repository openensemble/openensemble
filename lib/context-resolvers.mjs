/**
 * Context-resolvers aggregator.
 *
 * The pre-LLM step where every entity-alias resolver runs against the user's
 * message and contributes a one-line system note to the LLM turn. Skill and
 * agent resolvers today; add more (devices, nodes, email accounts) by
 * appending to RESOLVERS — each must export `resolve(userId, text)` returning
 * a resolution object or null, plus `buildHint(resolution)` returning the
 * string to inject.
 *
 * Why a separate aggregator: chat-dispatch shouldn't grow a chain of try/imports
 * every time we add an entity type. Each resolver is independent + best-effort,
 * a failure in one never blocks the LLM turn or any other resolver.
 */

// The hand-coded one-offs (skill / agent / node / email_account / project)
// were each ~200 LOC modules with near-identical structure. They've all
// migrated to the manifest-driven framework in lib/skill-alias-framework.mjs:
//   - skill         → skills/skill-builder/manifest.json
//   - project       → skills/coder/manifest.json
//   - node          → skills/nodes/manifest.json
//   - email_account → skills/email/manifest.json
//   - agent         → roles.mjs system-level registerAliasCatalog at boot
//                     (no skill owns the agent roster)
//   - yt_channel    → users/<id>/skills/youtube-downloader/manifest.json
// This RESOLVERS list now only holds entries that genuinely don't fit the
// framework's manifest model — currently empty. New entity kinds should
// declare alias_catalog in a manifest instead of being added here.
const RESOLVERS = [];

/**
 * Run every registered resolver against the user's text. Returns the
 * concatenated hint string (one per resolved entity, newline-separated) or
 * null if nothing matched. Each resolver runs in parallel and is wrapped in
 * a try/catch — a thrown resolver never blocks the others or the LLM turn.
 *
 * Two sources of resolvers:
 *   1. RESOLVERS list above — the original per-entity modules. Each was
 *      written as a one-off before the framework existed; kept here so the
 *      built-in entity kinds (skill/agent/node/email_account/project) keep
 *      working without a manifest migration.
 *   2. Skill-alias framework — any user/built-in skill that declares an
 *      alias_catalog block in its manifest. Registered at boot by roles.mjs.
 *      lib/skill-alias-framework.mjs holds the registry and the catalog
 *      reader; we just call its single resolve entry point here.
 *
 * Side-effects: resolvers may auto-save new aliases on a name-match fallback.
 * That's intentional — observing-and-learning is the whole point.
 *
 * @returns {Promise<{hints: string, resolutions: any[]}>}
 */
export async function buildContextHints(userId, text) {
  if (!userId || typeof text !== 'string' || text.length < 4) {
    return { hints: '', resolutions: [] };
  }
  const settled = await Promise.allSettled(RESOLVERS.map(async (r) => {
    try {
      const mod = await r.importer();
      const resolveFn = mod[r.resolveFn];
      const hintFn = mod[r.hintFn];
      if (typeof resolveFn !== 'function' || typeof hintFn !== 'function') return null;
      const resolution = await resolveFn(userId, text);
      if (!resolution) return null;
      const hint = hintFn(resolution);
      if (!hint) return null;
      return { kind: r.name, resolution, hint };
    } catch (e) {
      console.warn(`[context-resolvers] ${r.name} threw: ${e.message}`);
      return null;
    }
  }));
  const ok = settled
    .filter(s => s.status === 'fulfilled' && s.value)
    .map(s => s.value);

  // Framework-registered resolvers — manifest-declared. Single call into the
  // framework returns the first match (the framework iterates its own
  // registry). Built-in resolvers already ran in parallel above; for the
  // framework set we accept one resolution per turn since most messages
  // reference at most one manifest-declared entity at a time.
  try {
    const fw = await import('./skill-alias-framework.mjs');
    const res = await fw.resolveFromMessage(userId, text);
    if (res) {
      const hint = fw.buildHintNote(res);
      if (hint) ok.push({ kind: res.entity_kind, resolution: res, hint });
    }
  } catch (e) {
    console.warn('[context-resolvers] framework resolve failed:', e.message);
  }

  const hints = ok.map(x => x.hint).join('\n');
  return { hints, resolutions: ok };
}
