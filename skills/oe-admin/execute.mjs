/**
 * OE Admin skill — modify the OpenEnsemble installation itself.
 *
 * Every handler:
 *   1. Calls requirePrivilegedTool(userId) — refuses if not owner/admin.
 *   2. Goes through assertWritablePath / assertConfigPathAllowed for any
 *      filesystem mutation.
 *   3. Records a pending audit entry BEFORE the change so revert is mechanical.
 *   4. Issues credential prompts via the central primitive (values never
 *      reach the LLM).
 *
 * Restart semantics: changes that need a restart write a single-slot
 * pending marker, then `restart_server` triggers the re-exec. The boot
 * watchdog auto-reverts if the next process can't come up.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { BASE_DIR } from '../../lib/paths.mjs';
import {
  requirePrivilegedTool, assertWritablePath, assertConfigPathAllowed,
  validateRecipe, applyCredentialTemplates, applyTemplatesToString,
} from '../../lib/oe-admin-paths.mjs';
import {
  requestCredential, resolveCredentialValue, dropRamCredential,
  registerRedaction, unregisterRedaction, redactSecret, listCredentials,
} from '../../lib/credentials.mjs';
import {
  recordPending, getEntry, listAudit, markCommitted, markRolledBack,
  hasPendingChange, writePendingMarker, deletePendingMarker, revertEntry,
} from '../../lib/oe-admin-audit.mjs';
import {
  loadUserProviders, setUserProvider, removeUserProvider, mergeProviders,
} from '../../lib/user-providers.mjs';
import { OPENAI_COMPAT_PROVIDERS } from '../../chat/providers/_shared.mjs';
import { modifyConfig, loadConfig } from '../../routes/_helpers.mjs';
import {
  checkForUpdate, applyUpdate, forceApplyUpdate, getCachedState, getCurrentSha,
} from '../../lib/update.mjs';
import {
  getStatus as getTunnelStatus, configure as configureTunnel,
  start as startTunnel, stop as stopTunnel, setEnabled as setTunnelEnabled,
} from '../../lib/tunnel.mjs';
import { log } from '../../logger.mjs';
import { walkToolGates, formatGateWalkReport } from '../../lib/tool-gate-walker.mjs';

const BLUEPRINT_PATH    = path.join(BASE_DIR, 'skills', 'oe-admin', 'OE_ADMIN_BLUEPRINT.md');
const INTEGRATIONS_DIR  = path.join(BASE_DIR, 'skills', 'oe-admin', 'integrations');
const USER_PROVIDERS    = path.join(BASE_DIR, 'config', 'user-providers.json');

function recipeFilePath(name) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`bad recipe name: ${name}`);
  return path.join(INTEGRATIONS_DIR, `${name}.json`);
}

// ── Tool: oe_admin_read_blueprint ────────────────────────────────────────────

function handleReadBlueprint() {
  try { return fs.readFileSync(BLUEPRINT_PATH, 'utf8'); }
  catch { return `Blueprint not found at ${BLUEPRINT_PATH}`; }
}

// ── Tool: list_user_providers ────────────────────────────────────────────────

function handleListUserProviders() {
  const overlay = loadUserProviders();
  const entries = Object.entries(overlay);
  if (!entries.length) return 'No user-added providers. Built-in providers (OpenAI, Anthropic, Groq, DeepSeek, Mistral, Together, Perplexity, Gemini, xAI, Z.AI, Ollama, LM Studio) are always available.';
  return entries.map(([id, e]) =>
    `• **${e.displayName || id}** (id: ${id}) — ${e.baseUrl} → key in cfg.${e.keyField}`
  ).join('\n');
}

// ── Tool: list_integration_recipes ──────────────────────────────────────────

function handleListRecipes() {
  if (!fs.existsSync(INTEGRATIONS_DIR)) return 'No integration recipes yet.';
  const names = fs.readdirSync(INTEGRATIONS_DIR)
    .filter(n => n.endsWith('.json'))
    .map(n => n.replace(/\.json$/, ''));
  if (!names.length) return 'No integration recipes yet. Use save_integration_recipe to author one.';
  return names.map(n => `• ${n}`).join('\n');
}

function handleReadRecipe(args) {
  const { name } = args ?? {};
  if (!name) return 'name is required.';
  const p = recipeFilePath(name);
  if (!fs.existsSync(p)) return `Recipe "${name}" not found.`;
  return fs.readFileSync(p, 'utf8');
}

function handleSaveRecipe(args) {
  const { name, recipe } = args ?? {};
  if (!name || typeof name !== 'string') return 'name is required.';
  if (!recipe || typeof recipe !== 'object') return 'recipe must be an object.';
  // Validation throws on any rule violation.
  const normalized = validateRecipe({ ...recipe, name });
  const p = recipeFilePath(name);
  assertWritablePath(p);
  if (!fs.existsSync(INTEGRATIONS_DIR)) fs.mkdirSync(INTEGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(normalized, null, 2));
  return `Recipe "${name}" saved to skills/oe-admin/integrations/${name}.json. Call install_integration({ recipeName: "${name}" }) to run it.`;
}

// ── Tool: add_provider ───────────────────────────────────────────────────────

async function handleAddProvider(args, userId, agentId) {
  if (hasPendingChange()) {
    return 'Another oe-admin change is awaiting restart-commit. Call restart_server to commit it, or revert_audit_entry to clear the marker, before starting a new change.';
  }
  const { name, baseUrl, keyField, displayName, modelsEndpoint, sampleModelId } = args ?? {};
  if (!name || !baseUrl || !keyField) return 'name, baseUrl, and keyField are required.';
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return 'name must be lowercase letters/numbers/hyphens, starting with a letter.';
  if (!/^[a-z][a-zA-Z0-9]*ApiKey$/.test(keyField)) return 'keyField must look like "<provider>ApiKey" (e.g. cerebrasApiKey).';

  // Validate URL via the existing helper. Use the same gate routes/config.mjs uses.
  let validatedUrl;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `baseUrl protocol ${u.protocol} not allowed.`;
    validatedUrl = u.toString().replace(/\/$/, '');
  } catch { return `baseUrl is not a valid URL: ${baseUrl}`; }

  if (STATIC_BUILTIN_IDS.has(name)) {
    return `Provider "${name}" is a built-in. Use the Settings → Providers UI (or set_config_field on enabledProviders) to toggle it instead.`;
  }

  // Request the API key via the credential prompt. The value never reaches us.
  let credResult;
  try {
    credResult = await requestCredential({
      userId,
      label: `API key for ${displayName || name}`,
      description: `Pasted into the protected input — never sent to the LLM. Stored encrypted under users/${userId}/credentials/.`,
      kind: 'api_key',
      ttlMs: 300_000,
    });
  } catch (e) {
    if (e.code === 'CANCELLED') return 'Cancelled — provider not added.';
    return `Failed to collect API key: ${e.message}`;
  }
  const apiKey = resolveCredentialValue(userId, credResult.id);
  if (!apiKey) return 'Could not retrieve the API key after submission.';
  // Register for redaction so any subprocess we run later can't echo it.
  registerRedaction(apiKey);

  try {
    // Pre-change snapshot + audit entry. Touch config.json + user-providers.json.
    const entryId = recordPending({
      userId,
      op: 'add_provider',
      args: { name, baseUrl: validatedUrl, keyField, displayName: displayName || name },
      snapshotFiles: ['config.json', 'config/user-providers.json'],
      inverse: {
        kind: 'add_provider_revert',
        removeOverlayKey: name,
        clearConfigField: keyField,
        deleteCredentialIds: [credResult.id],
      },
      restartRequired: true,
      commitDeadlineMs: 60_000,
    });

    // Write the encrypted key into config.json via modifyConfig.
    await modifyConfig(cfg => { cfg[keyField] = apiKey; });
    // Write the overlay entry.
    setUserProvider(name, {
      baseUrl: validatedUrl,
      keyField,
      displayName: displayName || name,
      addedBy: userId,
      addedAt: new Date().toISOString(),
    });

    // Optional probe — best-effort, doesn't fail the op.
    const probeUrl = validatedUrl + (modelsEndpoint || '/models');
    let probeMsg;
    try {
      const r = await fetch(probeUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      probeMsg = r.ok
        ? `✓ Probe of ${probeUrl} succeeded (HTTP ${r.status}).`
        : `⚠ Probe of ${probeUrl} returned HTTP ${r.status} — provider may still work; sample model "${sampleModelId ?? '<none provided>'}" couldn't be auto-listed.`;
    } catch (e) {
      probeMsg = `⚠ Probe of ${probeUrl} failed: ${e.message}. The key is stored anyway; verify manually in Settings → Providers after restart.`;
    }

    return [
      `Provider "${name}" added. Audit entry: ${entryId}.`,
      probeMsg,
      `Restart required — call restart_server({ reason: "add provider ${name}" }) to commit.`,
    ].join('\n');
  } finally {
    // Clear the plaintext from our local scope; the encrypted copy lives in
    // config.json. The redaction registration stays until restart (cheap).
    unregisterRedaction(apiKey);
  }
}

// Built-in providers we refuse to overwrite via the overlay.
const STATIC_BUILTIN_IDS = new Set([
  'openai', 'deepseek', 'mistral', 'groq', 'together', 'perplexity',
  'gemini', 'xai', 'zai',
]);

// ── Tool: set_config_field ───────────────────────────────────────────────────

async function handleSetConfigField(args, userId) {
  if (hasPendingChange()) {
    return 'Another oe-admin change is awaiting restart-commit. Commit or revert it first.';
  }
  const { path: dotted, value } = args ?? {};
  if (!dotted || typeof dotted !== 'string') return 'path is required.';
  try { assertConfigPathAllowed(dotted); }
  catch (e) { return `Refused: ${e.message}`; }

  // Snapshot config.json + record prior value for the inverse.
  const cfg = loadConfig();
  const segs = dotted.split('.');
  let prev; { let cur = cfg; for (const s of segs) cur = cur?.[s]; prev = cur; }

  const entryId = recordPending({
    userId,
    op: 'set_config_field',
    args: { path: dotted, value },
    snapshotFiles: ['config.json'],
    inverse: { kind: 'set_config_field', path: dotted, value: prev },
    restartRequired: true,
    commitDeadlineMs: 60_000,
  });

  await modifyConfig(c => {
    let cur = c;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {};
      cur = cur[s];
    }
    cur[segs[segs.length - 1]] = value;
  });

  return `config.${dotted} set (audit ${entryId}). Restart required — call restart_server to commit.`;
}

// ── Recipe runner core ───────────────────────────────────────────────────────
// Loads + validates a recipe, snapshots config.json, runs its steps with the
// supplied credential values + sudo password, applies configWrites, and
// records the result in the audit log. Caller is responsible for collecting
// credentials (either via the chat credential-prompt widget or via a direct
// HTTP request body).
//
// Returns: { ok, status: 'committed'|'restart_required'|'rolled_back'|'error',
//            entryId, message, outputs }
export async function runRecipeWithCredentials(recipeName, userId, opts = {}) {
  const { credValues = {}, sudoPassword = null } = opts;

  if (hasPendingChange()) {
    return { ok: false, status: 'error', message: 'Another oe-admin change is awaiting restart-commit. Commit or revert it first.' };
  }
  const p = recipeFilePath(recipeName);
  if (!fs.existsSync(p)) return { ok: false, status: 'error', message: `Recipe "${recipeName}" not found.` };
  let recipe;
  try { recipe = validateRecipe(JSON.parse(fs.readFileSync(p, 'utf8'))); }
  catch (e) { return { ok: false, status: 'error', message: `Recipe failed validation: ${e.message}` }; }

  // Validate that every credential the recipe declares was supplied.
  for (const c of recipe.credentials) {
    const v = credValues[c.id];
    if (typeof v !== 'string' || !v.length) {
      return { ok: false, status: 'error', message: `Credential "${c.id}" (${c.label}) was empty.` };
    }
  }
  const needsRoot = recipe.steps.some(s => s.requiresRoot) || recipe.rollback.some(s => s.requiresRoot);
  if (needsRoot && process.getuid && process.getuid() !== 0 && !sudoPassword) {
    return { ok: false, status: 'error', message: 'Recipe needs sudo but no sudo password was supplied.' };
  }

  // Register redactions so secrets get scrubbed from any LLM-bound tool output
  // that happens to capture this subprocess's stdout/stderr.
  for (const v of Object.values(credValues)) registerRedaction(v);
  if (sudoPassword) registerRedaction(sudoPassword);

  const entryId = recordPending({
    userId,
    op: 'install_integration',
    args: { recipeName },
    snapshotFiles: ['config.json'],
    inverse: {
      kind: 'install_integration_revert',
      rollbackSteps: recipe.rollback,
      configWrites: recipe.configWrites,
    },
    restartRequired: recipe.configWrites.length > 0,
    commitDeadlineMs: 60_000,
  });

  const outputs = [];
  // Install-detected env vars available to every step as {{env.NAME}}.
  const envLookup = {
    OE_BASE_DIR: BASE_DIR,
    OE_NODE_BIN: process.execPath,
    OE_USER:     os.userInfo().username,
    OE_PORT:     '3737',
    OE_SUPERVISE: path.join(BASE_DIR, 'bin', 'oe-supervise.mjs'),
  };

  async function runOne(step, label) {
    const cmd = applyCredentialTemplates(step.cmd, credValues, envLookup);
    const child = step.requiresRoot && sudoPassword
      ? spawn('sudo', ['-S', '-p', '', ...cmd], { timeout: step.timeoutMs ?? 60_000 })
      : spawn(cmd[0], cmd.slice(1), { timeout: step.timeoutMs ?? 60_000 });
    if (step.requiresRoot && sudoPassword) {
      child.stdin.write(sudoPassword + '\n');
    }
    if (typeof step.stdin === 'string' && step.stdin.length > 0) {
      const payload = applyTemplatesToString(step.stdin, credValues, envLookup);
      child.stdin.write(payload);
    }
    child.stdin.end();
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    const exitCode = await new Promise(resolve => {
      child.on('exit', code => resolve(code ?? -1));
      child.on('error', () => resolve(-1));
    });
    if (sudoPassword) { out = redactSecret(out, sudoPassword); err = redactSecret(err, sudoPassword); }
    const tail = (out + (err ? '\n[stderr]\n' + err : '')).slice(-4000);
    outputs.push(`### ${label} (${step.id})\n\`\`\`\nexit=${exitCode}\n${tail}\n\`\`\``);
    return exitCode;
  }

  let failed = false;
  try {
    for (const step of recipe.steps) {
      const code = await runOne(step, 'step');
      if (code !== 0) { failed = true; break; }
    }
    if (!failed && recipe.verify) {
      const code = await runOne(recipe.verify, 'verify');
      if (code !== 0) failed = true;
    }

    if (failed) {
      for (const step of [...recipe.rollback].reverse()) {
        try { await runOne(step, 'rollback'); } catch {}
      }
      markRolledBack(entryId, 'step_failed');
      return {
        ok: false, status: 'rolled_back', entryId, outputs,
        message: `Recipe "${recipeName}" failed and was rolled back (audit ${entryId}).`,
      };
    }

    if (recipe.configWrites.length) {
      await modifyConfig(cfg => {
        for (const w of recipe.configWrites) {
          assertConfigPathAllowed(w.path);
          const segs = w.path.split('.');
          let cur = cfg;
          for (let i = 0; i < segs.length - 1; i++) {
            const s = segs[i];
            if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {};
            cur = cur[s];
          }
          cur[segs[segs.length - 1]] = w.value;
        }
      });
      return {
        ok: true, status: 'restart_required', entryId, outputs,
        message: `Recipe "${recipeName}" completed (audit ${entryId}). Restart required to apply configWrites — call restart_server.`,
      };
    }

    markCommitted(entryId);
    return {
      ok: true, status: 'committed', entryId, outputs,
      message: `Recipe "${recipeName}" completed (audit ${entryId}). No restart needed.`,
    };
  } finally {
    for (const v of Object.values(credValues)) unregisterRedaction(v);
    if (sudoPassword) unregisterRedaction(sudoPassword);
  }
}

// ── Tool: install_integration ────────────────────────────────────────────────
// LLM wrapper — collects credentials via the in-chat credential-prompt widget,
// then hands off to runRecipeWithCredentials.

async function handleInstallIntegration(args, userId) {
  const { recipeName } = args ?? {};
  if (!recipeName) return 'recipeName is required.';
  const p = recipeFilePath(recipeName);
  if (!fs.existsSync(p)) return `Recipe "${recipeName}" not found.`;
  let recipe;
  try { recipe = validateRecipe(JSON.parse(fs.readFileSync(p, 'utf8'))); }
  catch (e) { return `Recipe failed validation: ${e.message}`; }

  // Collect credentials declared by the recipe.
  const credValues = {};
  for (const c of recipe.credentials) {
    let credResult;
    try {
      credResult = await requestCredential({
        userId,
        label: c.label,
        description: c.description,
        kind: c.kind ?? 'api_key',
        ttlMs: 300_000,
      });
    } catch (e) {
      return `Cancelled while collecting "${c.label}": ${e.message}`;
    }
    const v = resolveCredentialValue(userId, credResult.id);
    if (!v) return `Credential "${c.id}" was empty.`;
    credValues[c.id] = v;
  }

  // If any step needs root, collect sudo password once (RAM only).
  const needsRoot = recipe.steps.some(s => s.requiresRoot) || recipe.rollback.some(s => s.requiresRoot);
  let sudoPassword = null;
  if (needsRoot && process.getuid && process.getuid() !== 0) {
    try {
      const sudoResult = await requestCredential({
        userId,
        label: 'sudo password',
        description: 'Used once for this recipe. Held in memory only — never persisted.',
        kind: 'sudo',
        ttlMs: 300_000,
      });
      sudoPassword = resolveCredentialValue(userId, sudoResult.id);
      dropRamCredential(sudoResult.id);
    } catch (e) {
      return `Cancelled while collecting sudo password: ${e.message}`;
    }
  }

  const result = await runRecipeWithCredentials(recipeName, userId, { credValues, sudoPassword });
  const outputBlock = result.outputs?.length ? '\n\n' + result.outputs.join('\n\n') : '';
  return `${result.message}${outputBlock}`;
}

// ── Tool: restart_server ─────────────────────────────────────────────────────

async function handleRestartServer(args, userId) {
  const { reason } = args ?? {};
  const recent = listAudit({ limit: 5 });
  const pending = recent.find(e => e.status === 'pending');
  if (!pending) {
    return 'No pending change to commit. If you want to restart anyway, run the system restart command (admin only).';
  }

  // Final confirm step.
  let confirmResult;
  try {
    confirmResult = await requestCredential({
      userId,
      label: 'Type RESTART to confirm',
      description: `About to restart OE to commit audit ${pending.id} (${pending.op}). Reason: ${reason ?? '(none)'}.`,
      kind: 'confirm',
      ttlMs: 60_000,
    });
  } catch (e) {
    return `Cancelled: ${e.message}`;
  }
  const phrase = resolveCredentialValue(userId, confirmResult.id);
  dropRamCredential(confirmResult.id);
  if ((phrase || '').trim().toUpperCase() !== 'RESTART') {
    return 'Confirmation phrase was not "RESTART" — restart cancelled.';
  }

  // Write the pending marker linking the change to this restart attempt.
  writePendingMarker({ entryId: pending.id });

  log.warn('oe-admin', 'restart triggered by admin', { userId, entryId: pending.id, reason });

  // Under systemd, just SIGTERM and let Restart=always respawn. Standalone,
  // spawn a detached re-exec. Same dual path lib/update.mjs:restartProcess
  // uses — keeps oe-admin compatible with the systemd-unit recipe.
  const underSystemd = !!(process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID);
  setTimeout(() => {
    try {
      if (underSystemd) {
        log.info('oe-admin', 'restart: systemd will respawn');
        process.kill(process.pid, 'SIGTERM');
        return;
      }
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        cwd: BASE_DIR,
      });
      child.unref();
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      log.error('oe-admin', 'restart spawn failed', { err: e.message });
      deletePendingMarker();
    }
  }, 200);

  return `Restart scheduled. Audit ${pending.id} will be committed once the new process answers /api/_alive within ${pending.commitDeadlineMs ?? 60_000}ms; otherwise the change will be auto-reverted.`;
}

// ── Tool: list_audit_log / revert_audit_entry ────────────────────────────────

function handleListAudit(args) {
  const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50);
  const entries = listAudit({ limit });
  if (!entries.length) return 'No oe-admin audit entries yet.';
  return entries.map(e => {
    const status = e.status === 'pending'      ? '⏳ pending'
                 : e.status === 'committed'    ? '✓ committed'
                 : e.status === 'rolled_back'  ? '↩ rolled_back'
                 : e.status;
    const detail = e.op === 'add_provider'     ? `provider=${e.args.name}`
                 : e.op === 'set_config_field' ? `path=${e.args.path}`
                 : e.op === 'install_integration' ? `recipe=${e.args.recipeName}`
                 : '';
    return `• \`${e.id}\` — ${status} — ${e.op}${detail ? ' (' + detail + ')' : ''} — ${e.ts}`;
  }).join('\n');
}

async function handleRevertAuditEntry(args, userId) {
  const { id } = args ?? {};
  if (!id) return 'id is required (use list_audit_log to find it).';
  const entry = getEntry(id);
  if (!entry) return `Audit entry "${id}" not found.`;
  if (entry.status === 'rolled_back') return `Audit entry "${id}" is already rolled back.`;

  // If the entry needs sudo for any rollback step, collect a sudo password.
  const needsRoot = (entry.inverse?.rollbackSteps ?? []).some(s => s.requiresRoot);
  let sudoPassword = null;
  if (needsRoot && process.getuid && process.getuid() !== 0) {
    try {
      const r = await requestCredential({
        userId, label: 'sudo password (for revert)',
        kind: 'sudo', ttlMs: 180_000,
      });
      sudoPassword = resolveCredentialValue(userId, r.id);
      registerRedaction(sudoPassword);
      dropRamCredential(r.id);
    } catch (e) {
      return `Cancelled: ${e.message}`;
    }
  }

  async function commandRunner(step) {
    const child = step.requiresRoot && sudoPassword
      ? spawn('sudo', ['-S', '-p', '', ...step.cmd], { timeout: step.timeoutMs ?? 60_000 })
      : spawn(step.cmd[0], step.cmd.slice(1), { timeout: step.timeoutMs ?? 60_000 });
    if (step.requiresRoot && sudoPassword) {
      child.stdin.write(sudoPassword + '\n');
      child.stdin.end();
    }
    return new Promise(resolve => child.on('exit', code => resolve(code ?? -1)));
  }

  try {
    await revertEntry(id, { reason: 'manual_revert', commandRunner });
  } finally {
    if (sudoPassword) { unregisterRedaction(sudoPassword); sudoPassword = null; }
  }
  // If the original op was restart-required, the revert also requires one.
  const note = entry.restartRequired ? ' Restart required to fully un-apply.' : '';
  return `Reverted audit entry ${id}.${note}`;
}

// ── Tool: oe_update_check / oe_update_apply / oe_update_force_apply ──────────

async function handleUpdateCheck() {
  const state = await checkForUpdate();
  if (!state.enabled) return `Auto-update unavailable: ${state.error ?? 'not a git repo or git missing'}.`;
  if (!state.currentSha) return 'Unable to read current git SHA.';
  if (state.error)        return `Last check error: ${state.error}. Current: ${shortSha(state.currentSha)}`;
  if (!state.available)   return `Up to date (${shortSha(state.currentSha)}). Last checked ${state.lastCheckedAt ? new Date(state.lastCheckedAt).toISOString() : 'never'}.`;
  return `Update available: ${shortSha(state.currentSha)} → ${shortSha(state.remoteSha)}. Call oe_update_apply to install it.`;
}

function shortSha(s) { return s ? String(s).slice(0, 8) : '<none>'; }

async function handleUpdateApply(args, userId) {
  const fromSha = await getCurrentSha();
  // Audit-log the update intent before kicking it off. applyUpdate restarts
  // the process itself, so the boot-check / pending-marker pipeline doesn't
  // apply here — but the log entry records fromSha so an admin can manually
  // `git reset --hard <fromSha>` if the new build is broken.
  const entryId = recordPending({
    userId,
    op: 'oe_update_apply',
    args: { fromSha, force: !!args?.force },
    snapshotFiles: [],
    inverse: { kind: 'oe_update_revert', fromSha },
    restartRequired: true,
    commitDeadlineMs: 90_000,
  });
  const result = args?.force
    ? await forceApplyUpdate()
    : await applyUpdate();
  if (!result.ok) {
    markRolledBack(entryId, `apply_failed:${result.code}`);
    return `Update failed (${result.code}): ${result.message}`;
  }
  // applyUpdate calls restartProcess at the end — the audit entry stays
  // pending until manually committed by the admin via list_audit_log /
  // (future) commit_audit_entry. For now, mark it committed optimistically
  // since the new build will start applying immediately.
  markCommitted(entryId);
  return `Update applying: ${shortSha(result.fromSha)} → ${shortSha(result.toSha)}${result.npmRan ? ' (npm install ran)' : ''}. Server restarting. Audit: ${entryId}.`;
}

// ── Tool: tunnel_* ───────────────────────────────────────────────────────────

function handleTunnelStatus() {
  const s = getTunnelStatus();
  return [
    `Mode: ${s.mode}`,
    `Enabled: ${s.enabled}`,
    `State: ${s.state}`,
    s.hostname ? `Hostname: ${s.hostname}` : null,
    s.publicUrl ? `Public URL: ${s.publicUrl}` : null,
    s.hasToken ? `Token: present (chmod 600)` : `Token: not configured`,
    s.lastError ? `Last error: ${s.lastError}` : null,
  ].filter(Boolean).join('\n');
}

async function handleTunnelConfigure(args, userId) {
  if (hasPendingChange()) {
    return 'Another oe-admin change is awaiting restart-commit. Commit or revert it first.';
  }
  const { hostname, localPort } = args ?? {};
  if (!hostname || typeof hostname !== 'string') return 'hostname is required (e.g. oe.example.com).';
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(hostname)) return `hostname "${hostname}" does not look like a fully-qualified domain.`;

  // Token via credential prompt (kind api_key — encrypted at rest under
  // users/<id>/credentials/, NOT in tunnel.json. lib/tunnel.mjs still gets a
  // plaintext copy in tunnel.json which is chmod 600 + gitignored).
  let credResult;
  try {
    credResult = await requestCredential({
      userId,
      label: `Cloudflare Tunnel token for ${hostname}`,
      description: 'From the Cloudflare Zero Trust dashboard: Networks → Tunnels → your tunnel → Configure → "Install and run a connector" → copy the token (the long string after `--token`).',
      kind: 'api_key',
      ttlMs: 300_000,
    });
  } catch (e) {
    if (e.code === 'CANCELLED') return 'Cancelled — tunnel not configured.';
    return `Failed to collect token: ${e.message}`;
  }
  const token = resolveCredentialValue(userId, credResult.id);
  if (!token) return 'Could not retrieve the tunnel token after submission.';
  registerRedaction(token);

  try {
    const entryId = recordPending({
      userId,
      op: 'tunnel_configure',
      args: { hostname, localPort: localPort ?? 3737 },
      snapshotFiles: ['tunnel.json'],
      inverse: { kind: 'tunnel_revert', deleteCredentialIds: [credResult.id] },
      restartRequired: false,
      commitDeadlineMs: 30_000,
    });
    await configureTunnel({
      mode: 'cloudflare',
      hostname,
      token,
      localPort: Number(localPort) || 3737,
    });
    markCommitted(entryId);
    return `Tunnel configured for ${hostname}. Call tunnel_start to bring it up. Audit: ${entryId}.`;
  } finally {
    unregisterRedaction(token);
  }
}

async function handleTunnelStart(args, userId) {
  try {
    await setTunnelEnabled(true);
    await startTunnel();
    const s = getTunnelStatus();
    return `Tunnel started. State: ${s.state}. ${s.publicUrl ? 'Public URL: ' + s.publicUrl : 'Waiting for cloudflared to publish a URL…'}`;
  } catch (e) {
    return `tunnel_start failed: ${e.message}`;
  }
}

async function handleTunnelStop(args, userId) {
  try {
    await stopTunnel({ persistEnabled: false });
    return `Tunnel stopped. autoStart disabled until tunnel_start is called again.`;
  } catch (e) {
    return `tunnel_stop failed: ${e.message}`;
  }
}

// ── Tool: admin_diagnose_tool ────────────────────────────────────────────────
// Read-only GATE-WALKER diagnostic — see lib/tool-gate-walker.mjs. Diagnoses
// a DIFFERENT (tool, agent, user) triple than the one calling this tool, so
// `targetUserId` defaults to the caller's own id but can target any user
// (this handler is already admin-gated by executeSkillTool's top-level
// requirePrivilegedTool check).

async function handleDiagnoseTool(args, userId) {
  const { toolName, agentId, targetUserId, source, sampleText } = args ?? {};
  if (!toolName || typeof toolName !== 'string') return 'toolName is required.';
  if (!agentId || typeof agentId !== 'string') return 'agentId is required.';
  const diagUserId = (typeof targetUserId === 'string' && targetUserId.trim()) ? targetUserId.trim() : userId;
  const validSources = new Set(['browser', 'voice-device', 'telegram', 'desktop-app']);
  const diagSource = validSources.has(source) ? source : null;
  try {
    const result = await walkToolGates({
      toolName, agentId, userId: diagUserId,
      source: diagSource,
      sampleText: (typeof sampleText === 'string' && sampleText.trim()) ? sampleText.trim() : null,
    });
    return formatGateWalkReport(result);
  } catch (e) {
    return `admin_diagnose_tool failed: ${e.message}`;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function executeSkillTool(name, args, userId, agentId) {
  try {
    requirePrivilegedTool(userId);
  } catch (e) {
    if (e.code === 'EPRIVILEGE') return e.message;
    throw e;
  }
  try {
    if (name === 'oe_admin_read_blueprint') return handleReadBlueprint();
    if (name === 'list_user_providers')     return handleListUserProviders();
    if (name === 'list_integration_recipes') return handleListRecipes();
    if (name === 'read_integration_recipe') return handleReadRecipe(args);
    if (name === 'save_integration_recipe') return handleSaveRecipe(args);
    if (name === 'add_provider')            return await handleAddProvider(args, userId, agentId);
    if (name === 'set_config_field')        return await handleSetConfigField(args, userId);
    if (name === 'install_integration')     return await handleInstallIntegration(args, userId);
    if (name === 'restart_server')          return await handleRestartServer(args, userId);
    if (name === 'list_audit_log')          return handleListAudit(args);
    if (name === 'revert_audit_entry')      return await handleRevertAuditEntry(args, userId);
    if (name === 'oe_update_check')         return await handleUpdateCheck();
    if (name === 'oe_update_apply')         return await handleUpdateApply(args, userId);
    if (name === 'tunnel_status')           return handleTunnelStatus();
    if (name === 'tunnel_configure')        return await handleTunnelConfigure(args, userId);
    if (name === 'tunnel_start')            return await handleTunnelStart(args, userId);
    if (name === 'tunnel_stop')             return await handleTunnelStop(args, userId);
    if (name === 'admin_diagnose_tool')     return await handleDiagnoseTool(args, userId);
    return null;
  } catch (e) {
    log.error('oe-admin', `${name} failed`, { err: e.message, stack: e.stack?.slice(0, 400) });
    return `OE Admin error: ${e.message}`;
  }
}

export default executeSkillTool;
