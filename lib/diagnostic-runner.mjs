/**
 * Diagnostic recipe runner — when an incident opens, auto-execute the steps
 * in the matching `profile.diagnostic_recipes[<key>]` and attach output to
 * the incident.
 *
 * Mechanism support:
 *   http  — fetchFn(url) (defaults to globalThis.fetch)
 *   cli   — execFn(command) → {stdout, stderr, exitCode}; for remote nodes
 *           production wires this through skills/nodes/node-registry.sendCommand
 *
 * Profile templates ${endpoint} / ${auth} are substituted before execution.
 * Per-step timeout caps; output excerpted to keep incident records bounded.
 */

import { substituteTemplate } from './service-profile.mjs';
import { recordDiagnostic } from './incident.mjs';

const STEP_TIMEOUT_MS = 30_000;
const OUTPUT_EXCERPT_BYTES = 1500;

function trim(s) {
  if (s == null) return '(no output)';
  if (s.length <= OUTPUT_EXCERPT_BYTES) return s;
  return s.slice(0, OUTPUT_EXCERPT_BYTES) + `\n... [truncated, ${s.length - OUTPUT_EXCERPT_BYTES} more bytes]`;
}

async function doFetch(call, ctx) {
  const fetchFn = ctx.fetchFn || globalThis.fetch;
  if (!fetchFn) throw new Error('no fetch implementation available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
  try {
    const res = await fetchFn(call.url, { method: call.method || 'GET', headers: call.headers || {}, signal: ctrl.signal });
    const body = await res.text();
    return `HTTP ${res.status}\n${body}`;
  } finally {
    clearTimeout(timer);
  }
}

async function doExec(command, ctx) {
  if (!ctx.execFn) throw new Error('CLI diagnostic step requires ctx.execFn (typically node_exec wrapper)');
  const res = await ctx.execFn(command);
  const out = res.stdout || '';
  const err = res.stderr ? `\n[stderr]\n${res.stderr}` : '';
  const code = (typeof res.exitCode === 'number' && res.exitCode !== 0) ? `\n[exit ${res.exitCode}]` : '';
  return out + err + code;
}

/**
 * Execute one recipe and attach all step outputs to the incident.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.nodeId
 * @param {string} input.incidentId
 * @param {object} input.profile
 * @param {string} input.recipeKey   e.g. 'service_up_failed' — must exist in profile.diagnostic_recipes
 * @param {object} [input.ctx]       {fetchFn, execFn, auth_override}
 * @returns {Promise<{ran, results}>}
 */
export async function runDiagnosticRecipe(input) {
  const { userId, nodeId, incidentId, profile, recipeKey } = input;
  const ctx = input.ctx || {};
  const recipe = profile?.diagnostic_recipes?.[recipeKey];
  if (!Array.isArray(recipe) || recipe.length === 0) {
    return { ran: 0, results: [], reason: `no diagnostic recipe for "${recipeKey}"` };
  }

  const tplCtx = {
    endpoint: profile.endpoint || '',
    auth: ctx.auth_override ?? '',
  };

  const results = [];

  for (const rawStep of recipe) {
    const step = typeof rawStep === 'string'
      ? { mechanism: 'note', note: rawStep }
      : rawStep;
    const stepLabel = step.command || step.url || `${step.mechanism} step`;
    let output = null;
    let error = null;

    try {
      if (step.mechanism === 'note') {
        output = `[guidance] ${step.note || step.what_to_look_for || stepLabel}`;
      } else if (step.mechanism === 'http') {
        if (!step.url) throw new Error('http step missing url');
        const url = substituteTemplate(step.url, tplCtx);
        output = await doFetch({ ...step, url }, ctx);
      } else if (step.mechanism === 'cli') {
        if (!step.command) throw new Error('cli step missing command');
        const cmd = substituteTemplate(step.command, tplCtx);
        output = await doExec(cmd, ctx);
      } else {
        throw new Error(`unsupported diagnostic mechanism: ${step.mechanism}`);
      }
    } catch (e) {
      error = e.message;
    }

    const excerpt = error ? `[error] ${error}` : trim(output);
    recordDiagnostic(userId, nodeId, incidentId, {
      recipe_step: stepLabel,
      output_excerpt: excerpt,
      interpretation: null,
    });
    results.push({ step: stepLabel, mechanism: step.mechanism, what_to_look_for: step.what_to_look_for, output: excerpt, error });
  }

  return { ran: results.length, results };
}
