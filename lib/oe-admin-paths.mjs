// @ts-check
/**
 * Filesystem allowlist + privilege gate for the oe-admin skill.
 *
 * Every mutation tool in skills/oe-admin/ funnels writes through
 * assertWritablePath() so a misbehaving recipe can't `rm -rf /` or
 * overwrite OE's source tree. Recipe-author is the LLM, so we assume
 * the recipe is untrusted; the floor is this allowlist + the admin
 * sudo prompt for any root-needing step.
 */

import path from 'path';
import { BASE_DIR } from './paths.mjs';
import { isPrivileged } from '../routes/_helpers.mjs';

/**
 * Throw an Error with a stable `.code` field. Every oe-admin assertion
 * carries one of these codes; callers match on `e.code` (recipe runners,
 * tests, audit logger).
 *
 * @param {string} message
 * @param {string} code
 * @returns {never}
 */
function throwCoded(message, code) {
  const e = /** @type {Error & {code: string}} */ (new Error(message));
  e.code = code;
  throw e;
}

/** Throws if userId is not owner/admin. Every oe-admin tool calls this first. */
export function requirePrivilegedTool(userId) {
  if (!isPrivileged(userId)) {
    throwCoded('Permission denied: oe-admin tools require owner or admin role.', 'EPRIVILEGE');
  }
}

// Paths that mutation tools are allowed to write (relative to BASE_DIR).
const WRITE_ALLOWLIST = [
  /^config\.json$/,
  /^config\/user-providers\.json$/,
  /^config\/oe-admin-audit\.jsonl$/,
  /^config\/oe-admin-snapshots\/[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)?$/,
  /^config\/\.pending-change\.json$/,
  /^skills\/oe-admin\/integrations\/[a-z0-9_-]+\.json$/,
  /^users\/[a-zA-Z0-9_-]+\/credentials\/[a-z0-9_.-]+\.json$/,
];

// Always-deny list — these win over any allowlist match.
const WRITE_DENYLIST = [
  /^users\/_system\/\.master-key$/,
  /^routes\//,
  /^lib\//,
  /^public\//,
  /^chat\//,
  /^memory\//,
  /^scheduler\//,
  /^node_modules\//,
  /^vendor\//,
  /^venv\//,
  /^bin\//,
  /^server\.mjs$/,
  /^chat\.mjs$/,
  /^ws-handler\.mjs$/,
];

function relToBase(absPath) {
  const abs = path.resolve(absPath);
  const rel = path.relative(BASE_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throwCoded(`Path escapes OE install dir: ${absPath}`, 'EOUTSIDE');
  }
  // Always test forward-slash form so the regexes work on Windows too.
  return rel.replace(/\\/g, '/');
}

/**
 * Throws unless `absPath` is on the oe-admin write allowlist and not on the
 * deny list. Use this before EVERY filesystem write inside an oe-admin tool.
 */
export function assertWritablePath(absPath) {
  const rel = relToBase(absPath);
  if (WRITE_DENYLIST.some(re => re.test(rel))) {
    throwCoded(`Path is on oe-admin deny list: ${rel}`, 'EDENIED');
  }
  if (!WRITE_ALLOWLIST.some(re => re.test(rel))) {
    throwCoded(`Path is not on oe-admin write allowlist: ${rel}`, 'ENOTALLOWED');
  }
}

// Config-field path allowlist for set_config_field. We deliberately keep this
// narrow: feature flags + enabledProviders + integrations namespace. API keys
// go through add_provider (which routes through encryptConfigSecrets), never
// through set_config_field — that's why every *ApiKey / *Token suffix is
// explicitly denied below.
const CONFIG_PATH_ALLOWLIST = [
  /^enabledProviders(\.[a-z0-9_-]+)?$/i,
  /^integrations(\.[a-z0-9_-]+){1,3}$/i,
  /^featureFlags(\.[a-z0-9_-]+)?$/i,
  /^stripThinkingTags$/,
  /^logs(\.[a-z0-9_-]+)?$/i,
  /^cortex\.(embedProvider|reasonProvider|ollamaUrl|lmstudioUrl|ollamaLocalUrl)$/,
  /^providerFailover(\.[a-z0-9_-]+)?$/,
];

const CONFIG_FIELD_DENY = /(ApiKey|Token|Secret|Password|ClientId|Username|owner|userIds|users)$/i;

/**
 * Throws unless the given dotted config path is on the set_config_field
 * allowlist. Rejects anything matching *ApiKey, *Token, owner, userIds, etc.
 */
export function assertConfigPathAllowed(dottedPath) {
  const p = String(dottedPath ?? '').trim();
  if (!p) {
    throwCoded('config path is required', 'EINVAL');
  }
  // Final segment check first so the *ApiKey deny rule fires even on nested
  // paths like cortex.openaiApiKey or providers.foo.apiKey.
  const tail = p.split('.').pop();
  if (CONFIG_FIELD_DENY.test(tail)) {
    throwCoded(`config path "${p}" is denied (secret/identity field — use add_provider or a dedicated tool)`, 'EDENIED');
  }
  if (!CONFIG_PATH_ALLOWLIST.some(re => re.test(p))) {
    throwCoded(`config path "${p}" is not on the set_config_field allowlist`, 'ENOTALLOWED');
  }
}

/**
 * Validate an integration recipe before saving / running it. Returns a
 * normalized object on success or throws on the first violation. The
 * validator is intentionally strict — recipe authors are LLMs and we want
 * surprises to fail loudly rather than half-execute.
 */
export function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throwCoded('recipe must be an object', 'EINVAL');
  }
  const out = {
    name: String(recipe.name ?? '').trim(),
    description: String(recipe.description ?? '').trim(),
    version: Number(recipe.version) || 1,
    prerequisites: Array.isArray(recipe.prerequisites) ? recipe.prerequisites : [],
    credentials: Array.isArray(recipe.credentials) ? recipe.credentials : [],
    steps: Array.isArray(recipe.steps) ? recipe.steps : [],
    configWrites: Array.isArray(recipe.configWrites) ? recipe.configWrites : [],
    verify: recipe.verify ?? null,
    rollback: Array.isArray(recipe.rollback) ? recipe.rollback : [],
  };
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/.test(out.name)) {
    throwCoded('recipe.name must be lowercase letters/numbers/hyphens/underscores', 'EINVAL');
  }
  if (!out.description) {
    throwCoded('recipe.description is required', 'EINVAL');
  }
  // Credentials: ids must be unique kebab/snake-case
  const credIds = new Set();
  for (const c of out.credentials) {
    if (!c || typeof c !== 'object' || !c.id || !c.label) {
      throwCoded('each credential entry must have { id, label }', 'EINVAL');
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(c.id)) {
      throwCoded(`credential id "${c.id}" must be lowercase letters/numbers/hyphens/underscores`, 'EINVAL');
    }
    if (credIds.has(c.id)) {
      throwCoded(`duplicate credential id: ${c.id}`, 'EINVAL');
    }
    credIds.add(c.id);
  }
  // Steps: cmd[0] must be a plain binary token, no shell metacharacters.
  for (let i = 0; i < out.steps.length; i++) {
    validateCommand(out.steps[i], `steps[${i}]`, credIds);
  }
  for (let i = 0; i < out.rollback.length; i++) {
    validateCommand(out.rollback[i], `rollback[${i}]`, credIds);
  }
  // configWrites: every path must satisfy assertConfigPathAllowed
  for (let i = 0; i < out.configWrites.length; i++) {
    const w = out.configWrites[i];
    if (!w || typeof w !== 'object' || typeof w.path !== 'string') {
      throwCoded(`configWrites[${i}] must be { path, value }`, 'EINVAL');
    }
    assertConfigPathAllowed(w.path);
  }
  if (out.verify) {
    if (typeof out.verify !== 'object' || !Array.isArray(out.verify.cmd)) {
      throwCoded('recipe.verify must be { cmd: [...], expect?: {...} }', 'EINVAL');
    }
    validateCommand(out.verify, 'verify', credIds);
  }
  return out;
}

const SAFE_BIN_RE = /^[a-zA-Z0-9_./-]+$/;
const META_CHARS_RE = /[;&|`$<>(){}\\]/;

function validateCommand(step, label, credIds) {
  if (!step || typeof step !== 'object' || !Array.isArray(step.cmd) || step.cmd.length === 0) {
    throwCoded(`${label}.cmd must be a non-empty array`, 'EINVAL');
  }
  const bin = step.cmd[0];
  if (typeof bin !== 'string' || !SAFE_BIN_RE.test(bin) || META_CHARS_RE.test(bin)) {
    throwCoded(`${label}.cmd[0] "${bin}" is not a safe binary name`, 'EINVAL');
  }
  // Args may use {{credentials.<id>}} or {{env.<NAME>}} templates.
  for (let i = 1; i < step.cmd.length; i++) {
    const a = step.cmd[i];
    if (typeof a !== 'string') {
      throwCoded(`${label}.cmd[${i}] must be a string`, 'EINVAL');
    }
    for (const m of a.matchAll(/\{\{credentials\.([a-z0-9_-]+)\}\}/g)) {
      if (!credIds.has(m[1])) {
        throwCoded(`${label} references undeclared credential "${m[1]}"`, 'EINVAL');
      }
    }
  }
  // Optional stdin payload (string) — written to the child's stdin after spawn.
  if (step.stdin != null && typeof step.stdin !== 'string') {
    throwCoded(`${label}.stdin must be a string when present`, 'EINVAL');
  }
}

/**
 * Substitute {{credentials.<id>}} AND {{env.<NAME>}} templates in a step's
 * cmd args using the provided lookup maps. Returns a new cmd array — the
 * input is not mutated. Used at run time by install_integration after
 * credentials are collected and the runtime env is built.
 *
 *   credLookup: { id: 'plaintext_value', ... }   — collected by credential prompt
 *   envLookup:  { NAME: 'value', ... }            — install-detected (BASE_DIR etc.)
 */
export function applyCredentialTemplates(cmd, credLookup, envLookup) {
  return cmd.map((a, i) => {
    if (i === 0 || typeof a !== 'string') return a;
    let out = a.replace(/\{\{credentials\.([a-z0-9_-]+)\}\}/g, (_, id) => {
      const v = credLookup?.[id];
      if (v == null) throw new Error(`missing credential value for "${id}"`);
      return v;
    });
    out = out.replace(/\{\{env\.([A-Z][A-Z0-9_]*)\}\}/g, (_, name) => {
      const v = envLookup?.[name];
      if (v == null) throw new Error(`missing env value for "${name}"`);
      return v;
    });
    return out;
  });
}

/** Same template substitution applied to a stdin string. */
export function applyTemplatesToString(s, credLookup, envLookup) {
  if (typeof s !== 'string') return s;
  let out = s.replace(/\{\{credentials\.([a-z0-9_-]+)\}\}/g, (_, id) => {
    const v = credLookup?.[id];
    if (v == null) throw new Error(`missing credential value for "${id}"`);
    return v;
  });
  out = out.replace(/\{\{env\.([A-Z][A-Z0-9_]*)\}\}/g, (_, name) => {
    const v = envLookup?.[name];
    if (v == null) throw new Error(`missing env value for "${name}"`);
    return v;
  });
  return out;
}
