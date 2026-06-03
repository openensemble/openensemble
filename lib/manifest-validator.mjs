// @ts-check
/**
 * Static manifest ↔ code consistency check for skill-builder.
 *
 * Complements lib/lsp-diagnose.mjs (which catches code-side type/import
 * errors). This validator catches STRUCTURAL drift between manifest.json
 * and execute.mjs — the failure class where both files are individually
 * valid but disagree on tool names. Symptoms: LLM calls a tool, falls
 * through to `return null`, user sees "Function returned null for an
 * unknown tool name." No clear signal which side is wrong.
 *
 * What we check:
 *   1. Every tool declared in manifest.tools[*].function.name has a
 *      matching handler in execute.mjs — detected via `name === '...'`,
 *      `name == '...'`, or `case '...':` (the three canonical OE skill
 *      dispatch patterns). Missing handler → blocking error.
 *   2. Every name handled in execute.mjs has a matching declaration in
 *      manifest.tools. Handled-but-not-declared → warning (probably dead
 *      code; the LLM never sees the tool because the manifest gates what
 *      the LLM is allowed to call).
 *
 * What we DON'T check (phase 1):
 *   - Argument name agreement (manifest declares `zip_code`, code reads
 *     `args.zip`). Doable but needs per-handler scope detection, which
 *     requires parsing handler blocks. Deferred.
 *   - Description accuracy ("manifest says returns text but code returns
 *     JSON"). That's semantic; skill_update_tool_def is the right tool
 *     for that.
 *
 * Skill-builder gate semantics — caller decides:
 *   - Run alongside lspDiagnose so both kinds of bugs surface in one shot.
 *   - skip_validator:true bypasses; intended for the rare case where the
 *     code dispatches through a helper function and this regex-based
 *     check misses the real handler.
 */

/**
 * @typedef {Object} ManifestDiagnostic
 * @property {'error'|'warning'} severity
 * @property {string} code            short stable id like 'MV001'
 * @property {string} message
 * @property {string} [hint]
 */

/**
 * @param {any} manifest        parsed manifest.json
 * @param {string} code         execute.mjs source
 * @returns {{ ok:boolean, diagnostics:ManifestDiagnostic[] }}
 */
export function validateManifestCode(manifest, code) {
  /** @type {ManifestDiagnostic[]} */
  const diagnostics = [];

  // ── 1. tool names declared in the manifest ──────────────────────────
  /** @type {Set<string>} */
  const declared = new Set();
  for (const t of (manifest?.tools ?? [])) {
    const n = t?.function?.name;
    if (typeof n === 'string' && n) declared.add(n);
  }

  // ── 2. names dispatched in the code ─────────────────────────────────
  // Three canonical patterns:
  //   - `name === 'x'` or `name === "x"`  (and `==` as well)
  //   - `case 'x':` or `case "x":`
  // Single regex would be over-permissive (could match within comments
  // or strings); two narrow regexes + a comment-strip pass is safer.
  const stripped = _stripCommentsAndStrings(code);
  /** @type {Set<string>} */
  const handled = new Set();
  // name === 'x' (also == for older code)
  for (const m of stripped.matchAll(/\bname\s*={2,3}\s*['"`]([^'"`]+)['"`]/g)) {
    handled.add(m[1]);
  }
  // case 'x':
  for (const m of stripped.matchAll(/\bcase\s+['"`]([^'"`]+)['"`]\s*:/g)) {
    handled.add(m[1]);
  }

  // ── 3. diff ─────────────────────────────────────────────────────────
  for (const tool of [...declared].sort()) {
    if (!handled.has(tool)) {
      diagnostics.push({
        severity: 'error',
        code: 'MV001',
        message: `Tool "${tool}" is declared in manifest.tools[] but no handler matches in execute.mjs.`,
        hint: `The LLM would call this tool and your code would return null. Add \`if (name === '${tool}') { ... }\` to executeSkillTool, or remove the tool from the manifest if it's no longer needed.`,
      });
    }
  }
  for (const tool of [...handled].sort()) {
    if (!declared.has(tool)) {
      diagnostics.push({
        severity: 'warning',
        code: 'MV002',
        message: `execute.mjs handles "${tool}" but no matching tool is declared in manifest.tools[]. The LLM will never call this tool — the manifest is the gate.`,
        hint: `Either add an entry to manifest.tools with name: "${tool}", or remove the dead handler from execute.mjs.`,
      });
    }
  }

  const ok = !diagnostics.some(d => d.severity === 'error');
  return { ok, diagnostics };
}

/**
 * Format a diagnostics array for the skill-builder tool result. Same
 * shape as lsp-diagnose.formatDiagnostics so the two readouts compose
 * cleanly when both gates run together.
 *
 * @param {ManifestDiagnostic[]} diagnostics
 */
export function formatManifestDiagnostics(diagnostics) {
  if (!diagnostics.length) return '(no diagnostics)';
  const lines = [];
  for (const d of diagnostics) {
    const sev = d.severity === 'error' ? '✖' : '⚠';
    lines.push(`${sev} [${d.code}] ${d.message}`);
    if (d.hint) lines.push(`  ↳ ${d.hint}`);
  }
  return lines.join('\n');
}

/**
 * Strip line and block comments. We deliberately leave string literals
 * intact — the dispatch patterns we're matching ARE string literals
 * (`name === 'foo'`), so blanking them would destroy our captures.
 *
 * Theoretical false-positive: a string literal that happens to contain
 * the substring `name === 'something'`. Rare enough in practice (would
 * have to appear in a code-generation string or help text) that we
 * accept the risk; the false-positive cost is one extra orphan warning
 * the coder dismisses, not a hard block.
 *
 * @param {string} src
 */
function _stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
