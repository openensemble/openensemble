// @ts-check
/**
 * Pre-write type/import diagnostics for skill-builder.
 *
 * Direct TypeScript compiler API (no tsserver process) — we don't need
 * IDE features, only error reporting. One-shot type-check per call with
 * an in-memory tsconfig and an overlay of virtual files (so we can
 * diagnose proposed content BEFORE writeFileSync).
 *
 * Invariant: never block a skill write because of LSP infrastructure.
 * If TypeScript can't be loaded, times out, or throws, return
 * `{ok:true, skipped:{reason}}` and let the caller proceed.
 */
import fs from 'fs';
import path from 'path';
import { BASE_DIR } from './paths.mjs';

/** @typedef {{file:string, line:number, column:number, severity:'error'|'warning'|'info', code:number, message:string, hint?:string}} Diagnostic */

const DEFAULT_TIMEOUT_MS = 3000;

// Hint gloss table — when a TS diagnostic code + a regex against the
// message matches, prepend our friendlier hint. Falls back to plain TS
// message when nothing matches. Keep the regexes narrow; over-matching
// produces misleading hints, which is worse than no hint.
const HINTS = [
  {
    code: 2307,
    re: /Cannot find module ['"]\.\.\/\.\.\/lib\//,
    hint: 'User skills live four levels deep (users/<id>/skills/<skillId>/), so `lib/` is `../../../../lib/`, not `../../lib/`. See SKILL_BLUEPRINT.md for the exact import paths.',
  },
  {
    code: 2339,
    re: /Property '(getCredential|requestCredential|showImage|showVideo|watch|unwatch|proposeMonitor)' does not exist/,
    hint: 'Did you forget the `ctx` parameter? Skill executors take 5 args: `executeSkillTool(name, args, userId, agentId, ctx)`. The ctx helpers (getCredential, showImage, etc.) hang off that 5th arg. See SKILL_BLUEPRINT.md.',
  },
  {
    code: 2345,
    re: /Argument of type 'Promise</,
    hint: 'Looks like a missing `await`. Most `ctx.*` helpers are async — prefix the call with `await`.',
  },
  {
    code: 2304,
    re: /Cannot find name '(require|module|__dirname|__filename|exports)'/,
    hint: 'OE skills are ESM (.mjs). Use `import` / `export default` instead of CommonJS `require` / `module.exports`. For __dirname equivalent, use `new URL(\'.\', import.meta.url).pathname`.',
  },
  {
    code: 2304,
    re: /Cannot find name 'ctx'/,
    hint: 'Did you forget to declare `ctx` in the function signature? Skill executors take 5 args: `executeSkillTool(name, args, userId, agentId, ctx)`.',
  },
  {
    code: 1259,
    re: /Module .* can only be default-imported using the 'esModuleInterop' flag/,
    hint: 'Use a named import or the namespace-import form: `import * as foo from \'bar\'`.',
  },
];

function hintFor(code, message) {
  for (const h of HINTS) if (h.code === code && h.re.test(message)) return h.hint;
  return undefined;
}

/**
 * @param {string} skillDir       absolute path of the skill folder
 * @param {Record<string,string>} virtualFiles  overlay: relPath → content
 * @param {{ timeoutMs?: number, includeWarnings?: boolean }} [opts]
 * @returns {Promise<{ ok:boolean, diagnostics:Diagnostic[], tookMs:number, skipped?:{reason:string} }>}
 */
export async function lspDiagnose(skillDir, virtualFiles, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeWarnings = opts.includeWarnings ?? true;

  let ts;
  try { ts = (await import('typescript')).default; }
  catch (e) {
    return { ok: true, diagnostics: [], tookMs: Date.now() - t0, skipped: { reason: `typescript unavailable: ${e.message}` } };
  }

  // Race the actual analysis against a hard timeout. Whichever finishes
  // first wins — but if the timeout fires, we return ok:true so the
  // caller writes the file anyway. Infrastructure issues never block.
  const analysis = _runAnalysis(ts, skillDir, virtualFiles, includeWarnings);
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([analysis, timeout]);
    if (timer) clearTimeout(timer);
    if (result && /** @type {any} */ (result).__timedOut) {
      return { ok: true, diagnostics: [], tookMs: Date.now() - t0, skipped: { reason: `timeout after ${timeoutMs}ms` } };
    }
    /** @type {Diagnostic[]} */
    const diagnostics = /** @type {any} */ (result);
    const ok = !diagnostics.some(d => d.severity === 'error');
    return { ok, diagnostics, tookMs: Date.now() - t0 };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: true, diagnostics: [], tookMs: Date.now() - t0, skipped: { reason: `lsp threw: ${e.message}` } };
  }
}

/**
 * Run the actual TS compilation. Returns array of normalized Diagnostic.
 */
async function _runAnalysis(ts, skillDir, virtualFiles, includeWarnings) {
  // Resolve paths. The skill directory should be absolute; we resolve
  // every overlay key relative to it so callers can pass `execute.mjs`
  // without worrying about absolute vs relative.
  const absSkillDir = path.isAbsolute(skillDir) ? skillDir : path.resolve(skillDir);
  /** @type {Record<string,string>} */
  const overlay = {};
  for (const [k, v] of Object.entries(virtualFiles)) {
    const abs = path.isAbsolute(k) ? k : path.join(absSkillDir, k);
    overlay[ts.sys.useCaseSensitiveFileNames ? abs : abs.toLowerCase()] = v;
  }

  // Compiler options — mirror tsconfig.json's @ts-check shape but turn
  // checkJs on globally for the skill workspace. checkJs=true is the
  // whole point: user skills get auto-checked without needing @ts-check
  // pragmas in every generated file.
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: true,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    forceConsistentCasingInFileNames: true,
    noEmit: true,
    lib: ['esnext'],
    types: ['node'],
    rootDir: BASE_DIR,
    baseUrl: BASE_DIR,
  };

  // Custom compiler host: overlay first, then disk.
  /** @type {string[]} */
  const rootFiles = [];
  for (const [absPath, _content] of Object.entries(overlay)) {
    if (absPath.endsWith('.mjs') || absPath.endsWith('.js') || absPath.endsWith('.ts')) rootFiles.push(absPath);
  }

  const realHost = ts.createCompilerHost(compilerOptions, true);
  const host = {
    ...realHost,
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const lookupKey = ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(overlay, lookupKey)) {
        return ts.createSourceFile(fileName, overlay[lookupKey], languageVersion, /*setParentNodes*/ true);
      }
      return realHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    fileExists: (fileName) => {
      const lookupKey = ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(overlay, lookupKey)) return true;
      return realHost.fileExists(fileName);
    },
    readFile: (fileName) => {
      const lookupKey = ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(overlay, lookupKey)) return overlay[lookupKey];
      return realHost.readFile(fileName);
    },
  };

  const program = ts.createProgram(rootFiles, compilerOptions, host);

  /** @type {Diagnostic[]} */
  const out = [];
  for (const sourceFile of program.getSourceFiles()) {
    // Skip lib.d.ts and anything from node_modules — we only diagnose
    // the skill's own files. Without this, importing TypeScript's
    // built-in lib triggers thousands of warnings.
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    if (sourceFile.isDeclarationFile) continue;
    // Only report on files that are in the overlay (i.e., the proposed
    // skill code). Other imports are checked but their diagnostics
    // belong to those files, not the skill being authored.
    const lookupKey = ts.sys.useCaseSensitiveFileNames ? sourceFile.fileName : sourceFile.fileName.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(overlay, lookupKey)) continue;
    const syntactic = program.getSyntacticDiagnostics(sourceFile);
    const semantic = program.getSemanticDiagnostics(sourceFile);
    for (const d of [...syntactic, ...semantic]) {
      if (d.category === ts.DiagnosticCategory.Suggestion) continue;
      if (!includeWarnings && d.category !== ts.DiagnosticCategory.Error) continue;
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      let line = 0, column = 0;
      if (d.file && typeof d.start === 'number') {
        const loc = d.file.getLineAndCharacterOfPosition(d.start);
        line = loc.line + 1;
        column = loc.character + 1;
      }
      const severity = d.category === ts.DiagnosticCategory.Error ? 'error'
        : d.category === ts.DiagnosticCategory.Warning ? 'warning'
        : 'info';
      out.push({
        file: path.relative(absSkillDir, sourceFile.fileName) || sourceFile.fileName,
        line, column, severity,
        code: d.code,
        message,
        hint: hintFor(d.code, message),
      });
    }
  }
  return out;
}

/**
 * Format an array of diagnostics into a human/LLM-friendly multi-line
 * string. Used by skill-builder tools to surface errors back to the
 * coder agent in the tool result.
 *
 * @param {Diagnostic[]} diagnostics
 */
export function formatDiagnostics(diagnostics) {
  if (!diagnostics.length) return '(no diagnostics)';
  const lines = [];
  for (const d of diagnostics) {
    const sev = d.severity === 'error' ? '✖' : d.severity === 'warning' ? '⚠' : 'ℹ';
    lines.push(`${sev} ${d.file}:${d.line}:${d.column} [TS${d.code}] ${d.message}`);
    if (d.hint) lines.push(`  ↳ ${d.hint}`);
  }
  return lines.join('\n');
}
