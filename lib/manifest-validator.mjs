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
 *   3. A localIntent that targets a destructive tool is explicitly
 *      confirmation-gated. A manifest cannot relabel a destructive tool as a
 *      no-confirm local fast path.
 *   4. preferenceOpportunities form a bounded, same-skill watcher contract.
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
  const diagnostics = [
    ...validatePreferenceOpportunities(manifest),
    ...validateLocalIntentConfirmations(manifest),
  ];

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
  for (const m of stripped.matchAll(/(?<![.\w$])name\s*={2,3}\s*['"`]([^'"`]+)['"`]/g)) {
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
 * A local intent with `confirm:false` may execute without a coordinator turn.
 * Never let that declaration downgrade a tool which the same manifest marks as
 * destructive (and therefore confirmation-requiring).
 *
 * @param {any} manifest
 * @returns {ManifestDiagnostic[]}
 */
export function validateLocalIntentConfirmations(manifest) {
  const intents = manifest?.localIntents;
  if (!Array.isArray(intents)) return [];

  const destructiveTools = new Set((manifest?.tools ?? [])
    .filter(tool => tool?.destructive === true)
    .map(tool => typeof tool?.function?.name === 'string' ? tool.function.name.trim() : '')
    .filter(Boolean));
  /** @type {ManifestDiagnostic[]} */
  const diagnostics = [];

  for (let index = 0; index < intents.length; index++) {
    const intent = intents[index];
    const toolName = typeof intent?.tool === 'string' ? intent.tool.trim() : '';
    if (!destructiveTools.has(toolName) || intent?.confirm === true) continue;
    diagnostics.push({
      severity: 'error',
      code: 'MV201',
      message: `localIntents[${index}] targets destructive tool "${toolName}" and must set confirm:true.`,
      hint: 'Confirmed local intents defer to the normal approval flow instead of executing on the no-LLM fast path.',
    });
  }
  return diagnostics;
}

/**
 * Validate the optional, declarative confirmed-preference → watcher activation
 * contract. These checks deliberately live alongside the manifest/code gate so
 * hand-edited skills receive the same protection as skill-builder output.
 *
 * @param {any} manifest
 * @returns {ManifestDiagnostic[]}
 */
export function validatePreferenceOpportunities(manifest) {
  /** @type {ManifestDiagnostic[]} */
  const diagnostics = [];
  const values = manifest?.preferenceOpportunities;
  if (values === undefined) return diagnostics;
  if (!Array.isArray(values)) {
    return [{
      severity: 'error', code: 'MV101',
      message: 'manifest.preferenceOpportunities must be an array.',
      hint: 'Use an array of declarative activation recipes, or remove the field.',
    }];
  }
  if (values.length > 3) {
    diagnostics.push({
      severity: 'error', code: 'MV102',
      message: 'manifest.preferenceOpportunities supports at most 3 recipes per skill.',
      hint: 'Keep the declarations narrow and combine related preference keywords into one recipe.',
    });
  }

  const tools = new Map((manifest?.tools ?? [])
    .map(tool => [tool?.function?.name, tool])
    .filter(([name]) => typeof name === 'string' && name));
  const watcherKinds = new Set((manifest?.watchers ?? [])
    .map(watcher => typeof watcher?.kind === 'string' ? watcher.kind.trim() : '')
    .filter(Boolean));
  const ids = new Set();
  const watcherKeys = new Set();

  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const at = `preferenceOpportunities[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      diagnostics.push({ severity: 'error', code: 'MV103', message: `${at} must be an object.` });
      continue;
    }

    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) {
      diagnostics.push({
        severity: 'error', code: 'MV104',
        message: `${at}.id must be a lowercase kebab slug of 64 characters or fewer.`,
      });
    } else if (ids.has(id)) {
      diagnostics.push({ severity: 'error', code: 'MV105', message: `${at}.id duplicates "${id}".` });
    } else ids.add(id);

    const keywords = value.preferenceKeywords;
    if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 32
      || keywords.some(keyword => typeof keyword !== 'string'
        || _normalizePreferenceKeyword(keyword).length < 3
        || _normalizePreferenceKeyword(keyword).length > 40)) {
      diagnostics.push({
        severity: 'error', code: 'MV106',
        message: `${at}.preferenceKeywords must contain 1-32 string terms that normalize to 3-40 characters each.`,
      });
    }

    const interestSignals = value.interestSignals;
    if (interestSignals != null) {
      if (!Array.isArray(interestSignals) || interestSignals.length < 1 || interestSignals.length > 5) {
        diagnostics.push({
          severity: 'error', code: 'MV118',
          message: `${at}.interestSignals must contain 1-5 declarative tool/arg mappings.`,
        });
      } else {
        const seenSignals = new Set();
        for (let signalIndex = 0; signalIndex < interestSignals.length; signalIndex++) {
          const signal = interestSignals[signalIndex];
          const signalAt = `${at}.interestSignals[${signalIndex}]`;
          const signalToolName = typeof signal?.tool === 'string' ? signal.tool.trim() : '';
          const argName = typeof signal?.arg === 'string' ? signal.arg.trim() : '';
          const signalTool = tools.get(signalToolName);
          const argSchema = signalTool?.function?.parameters?.properties?.[argName];
          const sensitiveArg = /key|token|secret|password|auth|bearer|credential|cookie|private[_.-]?key|client[_.-]?secret|session[_.-]?(?:id|key)|csrf/i;
          const identity = `${signalToolName}\0${argName}`;
          if (!signal || typeof signal !== 'object' || Array.isArray(signal)
            || Object.keys(signal).some(key => !['tool', 'arg'].includes(key))) {
            diagnostics.push({ severity: 'error', code: 'MV119', message: `${signalAt} must contain only tool and arg.` });
          } else if (!signalTool || signalTool.destructive === true) {
            diagnostics.push({
              severity: 'error', code: 'MV120',
              message: `${signalAt}.tool must name a non-destructive tool declared by this manifest.`,
            });
          } else if (!argName || sensitiveArg.test(argName) || argSchema?.type !== 'string') {
            diagnostics.push({
              severity: 'error', code: 'MV121',
              message: `${signalAt}.arg must name a non-sensitive string parameter declared by ${signalToolName}.`,
            });
          } else if (seenSignals.has(identity)) {
            diagnostics.push({ severity: 'error', code: 'MV122', message: `${signalAt} duplicates another interest signal.` });
          } else seenSignals.add(identity);
        }
      }
    }

    const activationTool = typeof value.activationTool === 'string' ? value.activationTool.trim() : '';
    const tool = tools.get(activationTool);
    if (!tool) {
      diagnostics.push({
        severity: 'error', code: 'MV107',
        message: `${at}.activationTool must name a tool declared by this manifest.`,
      });
    } else if (tool.destructive !== true) {
      diagnostics.push({
        severity: 'error', code: 'MV108',
        message: `${at}.activationTool "${activationTool}" must be marked destructive:true.`,
        hint: 'Watcher creation changes durable state and must remain confirmation-gated.',
      });
    }

    const watcherKind = typeof value.watcherKind === 'string' ? value.watcherKind.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(watcherKind) || !watcherKinds.has(watcherKind)) {
      diagnostics.push({
        severity: 'error', code: 'MV109',
        message: `${at}.watcherKind must exactly match a kind declared in manifest.watchers[].`,
      });
    }
    const dedupKey = typeof value.dedupKey === 'string' ? value.dedupKey.trim() : '';
    if (!dedupKey || dedupKey.length > 160 || /[\u0000-\u001f\u007f]/.test(dedupKey)) {
      diagnostics.push({
        severity: 'error', code: 'MV110',
        message: `${at}.dedupKey must be a non-control string of 160 characters or fewer.`,
      });
    } else if (watcherKind) {
      const watcherKey = `${watcherKind}\u0000${dedupKey}`;
      if (watcherKeys.has(watcherKey)) {
        diagnostics.push({
          severity: 'error', code: 'MV111',
          message: `${at} duplicates another recipe's watcherKind + dedupKey activation identity.`,
        });
      } else watcherKeys.add(watcherKey);
    }

    const args = value.activationArgs == null ? {} : value.activationArgs;
    const argsError = _validatePreferenceActivationArgs(args);
    if (argsError) {
      diagnostics.push({ severity: 'error', code: 'MV112', message: `${at}.activationArgs ${argsError}` });
    } else if (Object.keys(args).length) {
      const declared = tool?.function?.parameters?.properties;
      const unknown = !declared || typeof declared !== 'object'
        ? Object.keys(args)
        : Object.keys(args).filter(key => !Object.hasOwn(declared, key));
      if (unknown.length) {
        diagnostics.push({
          severity: 'error', code: 'MV113',
          message: `${at}.activationArgs contains fields not declared by ${activationTool}: ${unknown.join(', ')}.`,
        });
      }
    }

    if (value.title != null && (typeof value.title !== 'string' || value.title.trim().length > 100)) {
      diagnostics.push({ severity: 'error', code: 'MV114', message: `${at}.title must be a string of 100 characters or fewer.` });
    }
    if (value.body != null && (typeof value.body !== 'string' || value.body.trim().length > 400)) {
      diagnostics.push({ severity: 'error', code: 'MV115', message: `${at}.body must be a string of 400 characters or fewer.` });
    }
    if (value.autonomy != null && value.autonomy !== 'informational') {
      diagnostics.push({
        severity: 'error', code: 'MV116',
        message: `${at}.autonomy may only be "informational"; omit it for ask-first behavior.`,
      });
    }
    if (value.autonomy === 'informational' && args?.deliver !== 'notify') {
      diagnostics.push({
        severity: 'error', code: 'MV117',
        message: `${at}.autonomy="informational" requires activationArgs.deliver to be "notify".`,
        hint: 'Agent turns, email, Telegram, purchases, messages, calendar changes, and other executable/external effects remain ask-first.',
      });
    }
  }
  return diagnostics;
}

function _normalizePreferenceKeyword(value) {
  return String(value || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _validatePreferenceActivationArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be a plain JSON object.';
  const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
  const sensitiveKey = /key|token|secret|password|auth|bearer|credential|cookie|private[_.-]?key|client[_.-]?secret|session[_.-]?(?:id|key)|csrf/i;
  const sensitiveValues = [
    /\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
    /\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)=[^\s&]{4,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  ];
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    const item = current.value;
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      if (sensitiveValues.some(re => re.test(item))) return 'must not contain credential-like values.';
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return 'must contain only finite JSON numbers.';
      continue;
    }
    if (typeof item !== 'object' || current.depth > 5 || seen.has(item)) {
      return 'must be acyclic JSON no more than 5 levels deep.';
    }
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 20) return 'arrays may contain at most 20 items.';
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const entries = Object.entries(item);
    if (entries.length > 32) return 'objects may contain at most 32 fields.';
    for (const [key, child] of entries) {
      if (dangerousKeys.has(key)) return `contains forbidden key "${key}".`;
      if (sensitiveKey.test(key)) return `must not contain credential-like field "${key}".`;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, 'utf8') > 4_000) return 'must be 4000 bytes or fewer.';
  } catch { return 'must be valid JSON.'; }
  return null;
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
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    // Preserve literals because dispatch names live inside them, but never
    // interpret URL/media-type text such as "https://" or "*/*" as a JS
    // comment opener. The previous scanner did, which could erase the rest of
    // a perfectly valid skill before its tool handlers were inspected.
    if (quote) {
      out += c;
      if (c === '\\') {
        if (i + 1 < src.length) out += src[++i];
      } else if (c === quote) {
        quote = null;
      }
      i++;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
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
