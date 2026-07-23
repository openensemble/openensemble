import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync,
  unlinkSync, renameSync,
} from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { SKILLS_DIR, USERS_DIR, userSkillsDir } from '../../lib/paths.mjs';
import {
  PLUGINS_DIR,
  DRAWER_TRANSACTION_COMMIT_FILE,
  deriveDrawerApiPrefixes,
  registerDrawerManifest,
  unregisterDrawerManifest,
  validateDrawerServerModule,
} from '../../plugins.mjs';
import { mayImportCustomCodeInProcess } from '../../lib/custom-code-policy.mjs';
import { atomicWriteSync, withLock } from '../../routes/_helpers/io-lock.mjs';
import { notifyUser } from '../../lib/personalization/notify.mjs';

const BLUEPRINT = path.join(SKILLS_DIR, 'SKILL_BLUEPRINT.md');
const CAPABILITIES = path.join(SKILLS_DIR, 'skill-builder', 'CAPABILITIES.md');

// ── Skill draft storage ─────────────────────────────────────────────────────
//
// A draft is a file-backed work-in-progress skill spec at
//   users/<uid>/skill-drafts/<draftId>.json
// Skill-builder mutates it across turns until the user says "build it",
// at which point skill_draft_build collapses it into a skill_create call
// and deletes the draft. The shape is intentionally loose — every field
// is optional except `id` and `name` — so the LLM can grow the draft as
// the conversation reveals more, without ever needing a schema migration.
const DRAFT_SCHEMA_VERSION = 1;

function draftsDir(userId) {
  return path.join(USERS_DIR, userId, 'skill-drafts');
}

function draftPath(userId, draftId) {
  return path.join(draftsDir(userId), `${draftId}.json`);
}

function loadDraft(userId, draftId) {
  const p = draftPath(userId, draftId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function saveDraft(draft) {
  if (!draft?.userId || !draft?.draftId) throw new Error('saveDraft: userId + draftId required');
  mkdirSync(draftsDir(draft.userId), { recursive: true });
  writeFileSync(draftPath(draft.userId, draft.draftId), JSON.stringify(draft, null, 2));
}

function listDrafts(userId) {
  const dir = draftsDir(userId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => loadDraft(userId, f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function deleteDraft(userId, draftId) {
  const p = draftPath(userId, draftId);
  if (existsSync(p)) { unlinkSync(p); return true; }
  return false;
}

// "Has the user got a draft for this skill id?" — used by skill_create
// to refuse a direct create when a draft is open, forcing the LLM through
// skill_draft_build instead.
function findOpenDraftForSkillId(userId, skillId) {
  return listDrafts(userId).find(d => (d.spec?.id || '').toLowerCase() === skillId.toLowerCase()) || null;
}

function newDraftId() {
  return 'draft_' + randomBytes(4).toString('hex');
}

function shortSkillId(name) {
  return String(name || 'untitled').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'untitled';
}

// ── Profile helpers ───────────────────────────────────────────────────────────

function getProfilePath(userId) { return path.join(USERS_DIR, userId, 'profile.json'); }

function loadProfile(userId) {
  try { return JSON.parse(readFileSync(getProfilePath(userId), 'utf8')); } catch { return null; }
}

function saveProfile(user) {
  writeFileSync(getProfilePath(user.id), JSON.stringify(user, null, 2));
}

function isPrivileged(userId) {
  const u = loadProfile(userId);
  return u?.role === 'owner' || u?.role === 'admin';
}

async function modifyProfile(userId, fn) {
  const { withLock } = await import('../../routes/_helpers.mjs');
  return withLock(getProfilePath(userId), () => {
    const user = loadProfile(userId);
    if (!user) throw new Error(`User ${userId} not found`);
    fn(user);
    saveProfile(user);
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(id)) {
    return 'id must be lowercase letters, numbers, and hyphens only';
  }
  if (id.length > 40) return 'id must be 40 chars or fewer';
  return null;
}

// Scan skill code for the capabilities the sandbox model needs the user to be aware
// of: outbound network (default-DENIED — a jailed skill has no egress unless the user
// grants it), the encrypted per-skill credential store, and downloaded binary runtimes
// (yt-dlp etc., which also imply network). Best-effort static scan — the runtime jail
// is the real boundary; this just drives the create/update consent prompts.
function scanSkillCapabilities(code) {
  const src = String(code || '');
  const usesRuntime = /\b(ensureRuntime|runSandboxed)\s*\(/.test(src);
  const usesNetwork = usesRuntime
    || /\bfetch\s*\(|\bhttps?\.(request|get)\b|['"]node-fetch['"]|\baxios\b|\bnet\.(connect|createConnection)\b|\bdns\./.test(src);
  const usesCredentials = /\b(ctx|helpers)\s*\.\s*credentials\b/.test(src);
  return { usesNetwork, usesCredentials, usesRuntime };
}

/**
 * Pre-write gates: LSP type-check + manifest/code structural validator.
 * Both run together so a single fix-and-retry covers both bug classes
 * (no "fix LSP, re-try, hit validator, re-try" round-trip).
 *
 * Returns `{ block, warnings }`:
 *   - block: non-empty string when there are blocking errors — caller
 *     should return this to the LLM.
 *   - warnings: non-empty string when there are non-blocking warnings —
 *     caller should append to the success message.
 *
 * Infrastructure failures (LSP timeout, TS missing, etc.) never block.
 *
 * @param {string} skillDir
 * @param {any} manifest
 * @param {string} code
 * @param {{ skip_lsp?: boolean, skip_validator?: boolean, opName: string, skillId: string }} opts
 * @returns {Promise<{block: string|null, warnings: string|null}>}
 */
async function runPreWriteGates(skillDir, manifest, code, opts) {
  const blockParts = [];
  const warnParts = [];

  if (!opts.skip_lsp) {
    try {
      const { lspDiagnose, formatDiagnostics } = await import('../../lib/lsp-diagnose.mjs');
      const diag = await lspDiagnose(skillDir, {
        'execute.mjs': code,
        'manifest.json': JSON.stringify(manifest, null, 2),
      });
      if (diag.skipped) {
        console.log(`[skill-builder] LSP skipped for ${opts.skillId}: ${diag.skipped.reason}`);
      } else if (!diag.ok) {
        blockParts.push('Type-check (LSP) found issues:\n' + formatDiagnostics(diag.diagnostics));
      } else if (diag.diagnostics.length) {
        warnParts.push('Type-check warnings (non-blocking):\n' + formatDiagnostics(diag.diagnostics));
      }
    } catch (e) {
      console.warn('[skill-builder] LSP threw, proceeding without diagnostics:', e.message);
    }
  }

  if (!opts.skip_validator) {
    try {
      const { validateManifestCode, formatManifestDiagnostics } = await import('../../lib/manifest-validator.mjs');
      const r = validateManifestCode(manifest, code);
      if (!r.ok) {
        blockParts.push('Manifest/code consistency check failed:\n' + formatManifestDiagnostics(r.diagnostics));
      } else if (r.diagnostics.length) {
        warnParts.push('Manifest/code warnings (non-blocking):\n' + formatManifestDiagnostics(r.diagnostics));
      }
    } catch (e) {
      console.warn('[skill-builder] validator threw, proceeding:', e.message);
    }
  }

  // Convention nudge (non-blocking, never gated): a skill that catches its own
  // error and RETURNS an `Error: …` string reads as SUCCESS to the per-turn
  // trace (read_turns/Lois) and the recipe learner. Steer toward the structured
  // signal so failures surface honestly. See SKILL_BLUEPRINT.md → "Signaling
  // failure".
  try {
    if (/catch\s*\([^)]*\)\s*\{[^}]*return\s+`?\s*Error/i.test(code) || /return\s+`Error:/.test(code)) {
      warnParts.push('Convention (non-blocking): this skill returns an `Error: …` string on failure. Prefer `return ctx.toolError(\'…\')` (or `throw`) so the failure is recorded honestly in the turn trace and not learned as a successful recipe. See SKILL_BLUEPRINT.md → "Signaling failure".');
    }
  } catch { /* a lint must never block a write */ }

  const block = blockParts.length
    ? `${opts.opName} blocked — fix the issues below and retry. If a check is a false positive, set skip_lsp:true and/or skip_validator:true to bypass that specific gate only:\n\n${blockParts.join('\n\n')}`
    : null;
  const warnings = warnParts.length ? warnParts.join('\n\n') : null;
  return { block, warnings };
}

// The old `validateExecutor` (signature + unknown-tool fallthrough + first-
// tool empty-args check) has been superseded by `lib/skill-smoke.mjs` which
// covers the same ground AND exercises every tool with generated args.

// ── Drawer helpers ────────────────────────────────────────────────────────────

// Build a globally-unique drawer plugin id from (userId, skillId).
// Stored flat in plugins/ so the id must not collide across users.
function drawerPluginIdFor(userId, skillId) {
  const shortUser = userId.replace(/^user_/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `usr_${shortUser}_${skillId}`;
}

function safeDomSuffix(s) { return s.replace(/[^a-zA-Z0-9]/g, '_'); }
function drawerDomIdFor(pluginId) { return 'drawer_' + safeDomSuffix(pluginId); }
function drawerBtnIdFor(pluginId) { return 'sbtn_'   + safeDomSuffix(pluginId); }

const DRAWER_HTML_MAX_BYTES = 512 * 1024;
const DRAWER_INIT_MAX_BYTES = 512 * 1024;
const DRAWER_SERVER_MAX_BYTES = 1024 * 1024;

function nextDrawerVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

function validateDrawerSourceSize(label, value, maxBytes) {
  const bytes = Buffer.byteLength(String(value || ''), 'utf8');
  return bytes > maxBytes
    ? `${label} is too large (${bytes} bytes; maximum ${maxBytes}).`
    : null;
}

function normalizeDrawerSpec(drawer, { skillName, skillIcon }) {
  if (!drawer || typeof drawer !== 'object' || Array.isArray(drawer)) {
    return { error: 'drawer must be an object.' };
  }
  const name = typeof drawer.name === 'string' ? drawer.name.trim() : '';
  const html = typeof drawer.html === 'string' ? drawer.html : '';
  const initJs = drawer.initJs == null ? '' : drawer.initJs;
  const serverCode = drawer.serverCode == null ? '' : drawer.serverCode;
  if (!name) return { error: 'drawer.name is required.' };
  if (!html.trim()) return { error: 'drawer.html is required.' };
  if (typeof initJs !== 'string') return { error: 'drawer.initJs must be a string when provided.' };
  if (typeof serverCode !== 'string') return { error: 'drawer.serverCode must be a string when provided.' };

  const sizeError = validateDrawerSourceSize('drawer.html', html, DRAWER_HTML_MAX_BYTES)
    || validateDrawerSourceSize('drawer.initJs', initJs, DRAWER_INIT_MAX_BYTES)
    || validateDrawerSourceSize('drawer.serverCode', serverCode, DRAWER_SERVER_MAX_BYTES);
  if (sizeError) return { error: sizeError };

  if (initJs.trim()) {
    try {
      // Match the browser's exact execution shape (AsyncFunction) without
      // executing any user code. This catches malformed generated JS before
      // it can replace a working drawer.
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      new AsyncFunction(initJs);
    } catch (e) {
      return { error: `drawer.initJs failed to compile: ${e.message}` };
    }
  }

  return {
    value: {
      name,
      icon: typeof drawer.icon === 'string' && drawer.icon.trim()
        ? drawer.icon.trim()
        : (skillIcon || '🔧'),
      lucideIcon: typeof drawer.lucideIcon === 'string' && drawer.lucideIcon.trim()
        ? drawer.lucideIcon.trim()
        : '',
      html,
      initJs,
      serverCode,
      description: `Drawer for skill ${skillName}`,
    },
  };
}

function readDrawerBundle(ownerId, skillId) {
  const pluginId = drawerPluginIdFor(ownerId, skillId);
  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { error: `Could not parse drawer manifest: ${e.message}` }; }
  if (manifest?.id !== pluginId || manifest?.custom !== true
      || manifest?.createdBy !== ownerId || manifest?.skillId !== skillId) {
    return { error: 'Drawer ownership metadata is invalid; refusing to modify it.' };
  }
  const serverPath = path.join(pluginDir, 'server.mjs');
  return {
    pluginId,
    pluginDir,
    manifest,
    serverCode: existsSync(serverPath) ? readFileSync(serverPath, 'utf8') : '',
  };
}

function prepareDrawerTransaction(pluginId, pluginDir) {
  const prefix = `.${pluginId}.rollback-`;
  const rollbackDirs = existsSync(PLUGINS_DIR)
    ? readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
      .map(entry => path.join(PLUGINS_DIR, entry.name))
    : [];
  const markerPath = path.join(pluginDir, DRAWER_TRANSACTION_COMMIT_FILE);
  if (!rollbackDirs.length) {
    // A committed create has no prior directory to retain. If cleanup was
    // interrupted after its marker write, the canonical directory is enough.
    if (existsSync(markerPath)) {
      try { rmSync(markerPath, { force: true }); } catch {}
    }
    return null;
  }

  let marker = null;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch {}
  const matchingCommitted = marker?.pluginId === pluginId
    && rollbackDirs.some(dir => dir.endsWith(`.rollback-${marker.nonce}`));
  if (!matchingCommitted) {
    if (rollbackDirs.length !== 1) {
      return `Drawer "${pluginId}" has multiple interrupted rollback copies. They were preserved and no live files were changed; resolve the ambiguous transaction copies before retrying.`;
    }
    const rollbackDir = rollbackDirs[0];
    let rollbackManifest;
    try {
      rollbackManifest = JSON.parse(
        readFileSync(path.join(rollbackDir, 'manifest.json'), 'utf8'),
      );
      if (rollbackManifest?.id !== pluginId) throw new Error('rollback ownership mismatch');
      const discardDir = path.join(
        PLUGINS_DIR,
        `.${pluginId}.recovery-discard-${process.pid}-${randomBytes(5).toString('hex')}`,
      );
      let movedLive = false;
      if (existsSync(pluginDir)) {
        renameSync(pluginDir, discardDir);
        movedLive = true;
      }
      try {
        renameSync(rollbackDir, pluginDir);
        registerDrawerManifest(rollbackManifest);
        if (movedLive) rmSync(discardDir, { recursive: true, force: true });
        return null;
      } catch (e) {
        if (!existsSync(pluginDir) && movedLive && existsSync(discardDir)) {
          renameSync(discardDir, pluginDir);
        }
        throw e;
      }
    } catch (e) {
      return `Drawer "${pluginId}" interrupted-transaction recovery failed; all recoverable copies were preserved: ${e.message}`;
    }
  }

  // The live directory carries a marker proving it committed after the swap.
  // Every older rollback for this plugin is now obsolete; clean all of them
  // before permitting a new transaction so an old artifact cannot later roll
  // a newer version backward.
  try {
    for (const rollbackDir of rollbackDirs) {
      const rollbackManifest = JSON.parse(
        readFileSync(path.join(rollbackDir, 'manifest.json'), 'utf8'),
      );
      if (rollbackManifest?.id !== pluginId) {
        throw new Error(`ownership mismatch in ${path.basename(rollbackDir)}`);
      }
    }
    for (const rollbackDir of rollbackDirs) {
      rmSync(rollbackDir, { recursive: true, force: true });
    }
    rmSync(markerPath, { force: true });
    return null;
  } catch (e) {
    return `Drawer "${pluginId}" committed, but rollback cleanup is incomplete: ${e.message}`;
  }
}

async function persistDrawerBundle({
  pluginId, skillName, skillIcon, userId, skillId, drawer, createOnly = false,
  expectedVersion,
}) {
  const expectedPluginId = drawerPluginIdFor(userId, skillId);
  if (pluginId !== expectedPluginId) {
    return `Drawer id mismatch: expected "${expectedPluginId}".`;
  }

  const normalized = normalizeDrawerSpec(drawer, { skillName, skillIcon });
  if (normalized.error) return normalized.error;
  const spec = normalized.value;
  if (spec.serverCode.trim() && !mayImportCustomCodeInProcess(userId, skillId)) {
    return 'drawer.serverCode is unavailable for this account. Create a static HTML/initJs drawer instead.';
  }

  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  return withLock(pluginDir, async () => {
    const transactionError = prepareDrawerTransaction(pluginId, pluginDir);
    if (transactionError) return transactionError;

    // Whole-skill deletion removes this file before it takes the drawer lock.
    // Rechecking under that lock prevents a stale update turn from recreating
    // an orphan drawer after the skill has already been deleted.
    try {
      const skillManifest = JSON.parse(
        readFileSync(path.join(userSkillsDir(userId), skillId, 'manifest.json'), 'utf8'),
      );
      if (skillManifest?.id !== skillId || skillManifest?.createdBy !== userId) {
        return `Skill "${skillId}" changed ownership or was deleted; drawer update cancelled.`;
      }
    } catch {
      return `Skill "${skillId}" was deleted before the drawer update committed.`;
    }

    const prior = readDrawerBundle(userId, skillId);
    if (prior?.error) return prior.error;
    if (createOnly && prior) {
      return `Drawer for skill "${skillId}" already exists. Use skill_update_drawer to replace it.`;
    }
    if (!createOnly && prior && !expectedVersion) {
      return `Drawer "${skillId}" changed concurrently or was not read first. Call skill_read_drawer and retry with expected_version.`;
    }
    if (expectedVersion && prior?.manifest?.version !== expectedVersion) {
      return `Drawer "${skillId}" version conflict: expected ${expectedVersion}, current version is ${prior?.manifest?.version || 'absent'}. Read it again before retrying.`;
    }

    const manifest = {
      id: pluginId,
      name: spec.name,
      icon: spec.icon,
      ...(spec.lucideIcon ? { lucideIcon: spec.lucideIcon } : {}),
      description: spec.description,
      version: prior ? nextDrawerVersion(prior.manifest.version) : '1.0.0',
      drawer: true,
      drawerId: drawerDomIdFor(pluginId),
      btnId: drawerBtnIdFor(pluginId),
      enabled_by_default: prior?.manifest?.enabled_by_default ?? true,
      ...(prior?.manifest?.defaultSettings
          && typeof prior.manifest.defaultSettings === 'object'
          && !Array.isArray(prior.manifest.defaultSettings)
        ? { defaultSettings: prior.manifest.defaultSettings }
        : {}),
      ...(prior?.manifest?.settingsSchema
          && typeof prior.manifest.settingsSchema === 'object'
          && !Array.isArray(prior.manifest.settingsSchema)
        ? { settingsSchema: prior.manifest.settingsSchema }
        : {}),
      custom: true,
      createdBy: userId,
      createdAt: prior?.manifest?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillId,
      html: spec.html,
      initJs: spec.initJs,
    };
    manifest.apiPrefixes = deriveDrawerApiPrefixes(manifest);

    const nonce = `${process.pid}-${randomBytes(5).toString('hex')}`;
    const stageDir = path.join(PLUGINS_DIR, `.${pluginId}.stage-${nonce}`);
    const backupDir = path.join(PLUGINS_DIR, `.${pluginId}.rollback-${nonce}`);
    const commitPath = path.join(pluginDir, DRAWER_TRANSACTION_COMMIT_FILE);
    let committed = false;
    mkdirSync(stageDir, { recursive: false });
    try {
      writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      if (spec.serverCode.trim()) {
        const serverPath = path.join(stageDir, 'server.mjs');
        writeFileSync(serverPath, spec.serverCode);
        const validation = await validateDrawerServerModule(serverPath, { timeoutMs: 5_000 });
        if (!validation?.ok) {
          return `drawer.serverCode failed isolated validation; the current drawer was left unchanged:\n\n${validation?.error || 'unknown validation error'}`;
        }
      }

      let movedPrior = false;
      let installedNew = false;
      try {
        if (existsSync(pluginDir)) {
          renameSync(pluginDir, backupDir);
          movedPrior = true;
        }
        renameSync(stageDir, pluginDir);
        installedNew = true;
        registerDrawerManifest(manifest);
        atomicWriteSync(commitPath, JSON.stringify({ pluginId, nonce }) + '\n', {
          encoding: 'utf8',
          mode: 0o600,
        });
        committed = true;
      } catch (e) {
        let restoreError = null;
        try {
          if (installedNew && existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
          if (movedPrior && existsSync(backupDir)) renameSync(backupDir, pluginDir);
          if (prior?.manifest) registerDrawerManifest(prior.manifest);
          else unregisterDrawerManifest(pluginId);
        } catch (error) {
          restoreError = error;
          console.error('[skill-builder] drawer rollback failed:', error.message);
        }
        return restoreError
          ? `Drawer install failed and automatic rollback was incomplete: ${e.message}. Recovery copy retained at ${backupDir}: ${restoreError.message}`
          : `Drawer install failed — previous version restored: ${e.message}`;
      }
      if (existsSync(backupDir)) {
        try { rmSync(backupDir, { recursive: true, force: true }); }
        catch (e) { console.warn('[skill-builder] drawer rollback-dir cleanup failed:', e.message); }
      }
      if (!existsSync(backupDir)) {
        try { rmSync(commitPath, { force: true }); } catch {}
      }

      void notifyUser(userId, {
        type: 'drawers_changed',
        action: prior ? 'update' : 'add',
        pluginId,
        version: manifest.version,
      });
      return null;
    } finally {
      if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
      if (committed && existsSync(backupDir) && existsSync(pluginDir)) {
        try { rmSync(backupDir, { recursive: true, force: true }); } catch {}
      }
      if (committed && !existsSync(backupDir)) {
        try { rmSync(commitPath, { force: true }); } catch {}
      }
    }
  });
}

// Build and persist a drawer plugin. Returns null on success, or an error string.
export async function createDrawerForSkill(pluginId, skillName, skillIcon, userId, skillId, drawer) {
  if (drawer == null) return null;
  if (typeof drawer !== 'object' || Array.isArray(drawer)) {
    return 'drawer must be an object.';
  }
  return persistDrawerBundle({
    pluginId, skillName, skillIcon, userId, skillId, drawer, createOnly: true,
  });
}

function purgeDrawerTransactionArtifacts(pluginId) {
  try {
    if (!existsSync(PLUGINS_DIR)) return;
    const prefixes = [
      `.${pluginId}.stage-`,
      `.${pluginId}.rollback-`,
      `.${pluginId}.delete-`,
      `.${pluginId}.recovery-discard-`,
    ];
    for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !prefixes.some(prefix => entry.name.startsWith(prefix))) continue;
      try { rmSync(path.join(PLUGINS_DIR, entry.name), { recursive: true, force: true }); }
      catch (e) {
        console.warn('[skill-builder] drawer transaction-artifact cleanup failed:', e.message);
      }
    }
  } catch (e) {
    console.warn('[skill-builder] drawer transaction-artifact scan failed:', e.message);
  }
}

async function removeDrawerForSkill(
  userId,
  skillId,
  { requireExisting = false, expectedVersion } = {},
) {
  const pluginId = drawerPluginIdFor(userId, skillId);
  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  return withLock(pluginDir, async () => {
    if (requireExisting) {
      const transactionError = prepareDrawerTransaction(pluginId, pluginDir);
      if (transactionError) return { error: transactionError };
    }
    const prior = readDrawerBundle(userId, skillId);
    if (prior?.error) return { error: prior.error };
    if (expectedVersion && prior?.manifest?.version !== expectedVersion) {
      return {
        error: `Drawer "${skillId}" version conflict: expected ${expectedVersion}, current version is ${prior?.manifest?.version || 'absent'}. Read it again before retrying.`,
      };
    }
    if (!prior) {
      unregisterDrawerManifest(pluginId);
      if (!requireExisting) purgeDrawerTransactionArtifacts(pluginId);
      return requireExisting
        ? { error: `Skill "${skillId}" does not have a drawer.` }
        : { removed: false, pluginId };
    }
    const tombstone = path.join(
      PLUGINS_DIR,
      `.${pluginId}.delete-${process.pid}-${randomBytes(5).toString('hex')}`,
    );
    try {
      renameSync(pluginDir, tombstone);
      unregisterDrawerManifest(pluginId);
      rmSync(tombstone, { recursive: true, force: true });
      if (!requireExisting) purgeDrawerTransactionArtifacts(pluginId);
    } catch (e) {
      try {
        if (!existsSync(pluginDir) && existsSync(tombstone)) renameSync(tombstone, pluginDir);
        registerDrawerManifest(prior.manifest);
      } catch (restoreError) {
        console.error('[skill-builder] drawer delete rollback failed:', restoreError.message);
      }
      return { error: `Drawer delete failed — previous version restored: ${e.message}` };
    }
    void notifyUser(userId, { type: 'drawers_changed', action: 'delete', pluginId });
    return { removed: true, pluginId };
  });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleReadBlueprint() {
  try { return readFileSync(BLUEPRINT, 'utf8'); }
  catch { return `Blueprint not found at ${BLUEPRINT}`; }
}

// Clean + lightly validate a `localIntents` block (the skill-agnostic local
// cognition tier — see SKILL_BLUEPRINT). Drops entries that don't bind a real
// tool of this skill or are malformed; heavier checks (slot ⊆ tool params,
// regex compiles) run at load in roles.mjs validateSkills as warnings.
function cleanLocalIntents(localIntents, toolNames) {
  if (!Array.isArray(localIntents)) return null;
  const valid = new Set(toolNames);
  const strArr = (a) => Array.isArray(a) ? a.map(s => typeof s === 'string' ? s.trim() : '').filter(Boolean) : [];
  const out = [];
  for (const li of localIntents) {
    if (!li || typeof li !== 'object') continue;
    const id = typeof li.id === 'string' ? li.id.trim() : '';
    const tool = typeof li.tool === 'string' ? li.tool.trim() : '';
    if (!id || !tool || !valid.has(tool)) continue;   // must bind a real tool of this skill
    out.push({ id, tool, utterances: strArr(li.utterances), patterns: strArr(li.patterns), slots: strArr(li.slots), confirm: li.confirm === true });
  }
  return out.length ? out : null;
}

// Validate and canonicalize the declarative bridge from confirmed preferences
// to an ask-first watcher activation. Keeping this in skill-builder means a
// generated skill cannot persist a recipe the runtime would later ignore.
const MAX_PREFERENCE_OPPORTUNITIES = 3;
const MAX_PREFERENCE_KEYWORDS = 32;
const MAX_PREFERENCE_ARGS_BYTES = 4_000;
const PREFERENCE_OPPORTUNITY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WATCHER_KIND_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_ACTIVATION_KEY_RE = /key|token|secret|password|auth|bearer|credential|cookie|private[_.-]?key|client[_.-]?secret|session[_.-]?(?:id|key)|csrf/i;
const SENSITIVE_ACTIVATION_VALUE_RES = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)=[^\s&]{4,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

function normalizePreferenceKeyword(value) {
  return String(value || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cloneSafeActivationArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'activationArgs must be a plain JSON object.' };
  }
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    const item = current.value;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      if (typeof item === 'string' && SENSITIVE_ACTIVATION_VALUE_RES.some(re => re.test(item))) {
        return { error: 'activationArgs must not contain credential-like values.' };
      }
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return { error: 'activationArgs must contain only finite JSON numbers.' };
      continue;
    }
    if (typeof item !== 'object' || current.depth > 5 || seen.has(item)) {
      return { error: 'activationArgs must be acyclic JSON no more than 5 levels deep.' };
    }
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 20) return { error: 'activationArgs arrays may contain at most 20 items.' };
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const entries = Object.entries(item);
    if (entries.length > 32) return { error: 'activationArgs objects may contain at most 32 fields.' };
    for (const [key, child] of entries) {
      if (DANGEROUS_JSON_KEYS.has(key)) return { error: `activationArgs contains forbidden key "${key}".` };
      if (SENSITIVE_ACTIVATION_KEY_RE.test(key)) {
        return { error: `activationArgs must not contain credential-like field "${key}".` };
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, 'utf8') > MAX_PREFERENCE_ARGS_BYTES) {
      return { error: `activationArgs must be ${MAX_PREFERENCE_ARGS_BYTES} bytes or fewer.` };
    }
    return { value: JSON.parse(json) };
  } catch {
    return { error: 'activationArgs must be valid JSON.' };
  }
}

function cleanPreferenceOpportunities(opportunities, toolDefs, watcherDefs) {
  if (!Array.isArray(opportunities)) {
    return { error: 'preferenceOpportunities must be an array. Pass [] to clear it.' };
  }
  if (opportunities.length > MAX_PREFERENCE_OPPORTUNITIES) {
    return { error: `preferenceOpportunities supports at most ${MAX_PREFERENCE_OPPORTUNITIES} recipes per skill.` };
  }
  const toolsByName = new Map((toolDefs || [])
    .map(tool => [tool?.function?.name, tool])
    .filter(([name]) => typeof name === 'string' && name));
  const watcherKinds = new Set((watcherDefs || [])
    .map(watcher => typeof watcher?.kind === 'string' ? watcher.kind.trim() : '')
    .filter(Boolean));
  const seenIds = new Set();
  const values = [];

  for (let index = 0; index < opportunities.length; index++) {
    const raw = opportunities[index];
    const label = `preferenceOpportunities[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `${label} must be an object.` };
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!PREFERENCE_OPPORTUNITY_ID_RE.test(id) || id.length > 64) {
      return { error: `${label}.id must be a lowercase kebab slug of 64 characters or fewer.` };
    }
    if (seenIds.has(id)) return { error: `${label}.id duplicates "${id}".` };
    seenIds.add(id);

    if (!Array.isArray(raw.preferenceKeywords) || !raw.preferenceKeywords.length
      || raw.preferenceKeywords.length > MAX_PREFERENCE_KEYWORDS) {
      return { error: `${label}.preferenceKeywords must contain 1-${MAX_PREFERENCE_KEYWORDS} domain terms.` };
    }
    const keywords = [];
    const seenKeywords = new Set();
    for (const keywordValue of raw.preferenceKeywords) {
      if (typeof keywordValue !== 'string') return { error: `${label}.preferenceKeywords must contain only strings.` };
      const keyword = normalizePreferenceKeyword(keywordValue);
      if (keyword.length < 3 || keyword.length > 40) {
        return { error: `${label}.preferenceKeywords terms must normalize to 3-40 characters.` };
      }
      if (!seenKeywords.has(keyword)) {
        seenKeywords.add(keyword);
        keywords.push(keyword);
      }
    }

    const activationTool = typeof raw.activationTool === 'string' ? raw.activationTool.trim() : '';
    const toolDef = toolsByName.get(activationTool);
    if (!toolDef) return { error: `${label}.activationTool must name a tool declared by this skill.` };
    if (toolDef.destructive !== true) {
      return { error: `${label}.activationTool "${activationTool}" must be marked destructive:true because it creates durable watcher state.` };
    }

    const watcherKind = typeof raw.watcherKind === 'string' ? raw.watcherKind.trim() : '';
    if (!WATCHER_KIND_RE.test(watcherKind) || !watcherKinds.has(watcherKind)) {
      return { error: `${label}.watcherKind must exactly match a kind declared in this skill's watchers array.` };
    }
    const dedupKey = typeof raw.dedupKey === 'string' ? raw.dedupKey.trim() : '';
    if (!dedupKey || dedupKey.length > 160 || /[\u0000-\u001f\u007f]/.test(dedupKey)) {
      return { error: `${label}.dedupKey must be a non-control string of 160 characters or fewer.` };
    }

    const argsResult = cloneSafeActivationArgs(raw.activationArgs == null ? {} : raw.activationArgs);
    if (argsResult.error) return { error: `${label}.${argsResult.error}` };
    const declaredArgs = toolDef?.function?.parameters?.properties;
    const activationArgKeys = Object.keys(argsResult.value);
    if (activationArgKeys.length) {
      const unknown = !declaredArgs || typeof declaredArgs !== 'object'
        ? activationArgKeys
        : activationArgKeys.filter(key => !Object.hasOwn(declaredArgs, key));
      if (unknown.length) {
        return { error: `${label}.activationArgs contains fields not declared by ${activationTool}: ${unknown.join(', ')}.` };
      }
    }
    const autonomy = raw.autonomy == null ? null : raw.autonomy;
    if (autonomy !== null && autonomy !== 'informational') {
      return { error: `${label}.autonomy may only be "informational"; omit it for ask-first behavior.` };
    }
    if (autonomy === 'informational' && argsResult.value.deliver !== 'notify') {
      return { error: `${label}.autonomy="informational" requires activationArgs.deliver to be "notify".` };
    }

    const title = raw.title == null ? '' : (typeof raw.title === 'string' ? raw.title.trim() : null);
    const body = raw.body == null ? '' : (typeof raw.body === 'string' ? raw.body.trim() : null);
    if (title === null || title.length > 100) return { error: `${label}.title must be a string of 100 characters or fewer.` };
    if (body === null || body.length > 400) return { error: `${label}.body must be a string of 400 characters or fewer.` };

    const recipe = {
      id,
      preferenceKeywords: keywords,
      activationTool,
      activationArgs: argsResult.value,
      watcherKind,
      dedupKey,
    };
    if (title) recipe.title = title;
    if (body) recipe.body = body;
    if (autonomy) recipe.autonomy = autonomy;
    values.push(recipe);
  }
  return { values };
}

function cleanSelectedPlanKeep(selectedPlanKeep, toolNames) {
  if (!Array.isArray(selectedPlanKeep)) return null;
  const valid = new Set(toolNames);
  const values = [];
  const invalid = [];
  const seen = new Set();
  const seenInvalid = new Set();
  for (const raw of selectedPlanKeep) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) continue;
    if (!valid.has(name)) {
      if (!seenInvalid.has(name)) {
        seenInvalid.add(name);
        invalid.push(name);
      }
      continue;
    }
    if (!seen.has(name)) {
      seen.add(name);
      values.push(name);
    }
  }
  return { values, invalid };
}

async function handleCreate(args, userId) {
  const { id: rawId, name, description, icon, tools, code, drawer, watchers, intent_examples, localIntents, preferenceOpportunities, selected_plan_keep, coordinator_scope, voice_device, assign_to, skip_lsp, skip_validator, skip_smoke, from_draft, sandbox, allow_network, execution_hint } = args;

  if (!rawId?.trim()) return 'id is required.';
  if (!name?.trim())  return 'name is required.';
  if (!description?.trim()) return 'description is required.';
  if (!Array.isArray(tools) || !tools.length) return 'tools must be a non-empty array.';
  if (!code?.trim()) return 'code is required.';
  if (!assign_to?.trim()) return 'assign_to is required. Specify the agent id that should own this skill (e.g. "coordinator" for general helpers, or a specialist agent\'s id for scoped skills). Custom skills no longer auto-flow to every agent — they must be explicitly assigned.';

  const idErr = validateId(rawId.trim());
  if (idErr) return `Invalid id: ${idErr}`;

  // Draft discipline: if a draft is open for this skill id, refuse direct
  // skill_create — the LLM must go through skill_draft_build (which sets
  // from_draft) so the conversation state stays consistent. Without this
  // an LLM that forgets the draft pattern can silently bypass it.
  if (!from_draft) {
    const openDraft = findOpenDraftForSkillId(userId, rawId.trim());
    if (openDraft) {
      return `Refusing to create — a draft for skill id "${rawId.trim()}" is open (\`${openDraft.draftId}\`). Either:\n- Call \`skill_draft_build({draftId: "${openDraft.draftId}"})\` to ship the drafted spec.\n- Or \`skill_draft_discard({draftId: "${openDraft.draftId}"})\` if you've decided to start fresh.\n- Or pick a different id for this skill.`;
    }
  }

  if (!code.includes('executeSkillTool')) {
    return 'code must export executeSkillTool. Did you read the blueprint?';
  }

  const skillId  = rawId.trim();
  const skillDir = path.join(userSkillsDir(userId), skillId);

  const { getRoleManifest, listRoles, addRoleManifest, removeRoleManifest } = await import('../../roles.mjs');

  if (existsSync(skillDir) || getRoleManifest(skillId, userId)) {
    return `Skill "${skillId}" already exists. Use skill_update_code to modify it, or choose a different id.`;
  }

  // Tool name collision check — scoped to what this user can already see.
  // Other users' custom skills are unreachable from this session so collisions don't matter.
  const existingNames = new Set(
    listRoles(userId).flatMap(m => (m.tools ?? []).map(t => t.function?.name)).filter(Boolean)
  );
  const newNames = tools.map(t => t.function?.name).filter(Boolean);
  const collisions = newNames.filter(n => existingNames.has(n));
  if (collisions.length) {
    return `Tool name collision: ${collisions.join(', ')} already exist in another skill. Use unique prefixed names.`;
  }
  if (selected_plan_keep !== undefined && !Array.isArray(selected_plan_keep)) {
    return 'selected_plan_keep must be an array of exact tool names from this skill.';
  }
  const selectedPlanKeep = cleanSelectedPlanKeep(selected_plan_keep, newNames);
  if (selectedPlanKeep?.invalid.length) {
    return `selected_plan_keep references tools not in this skill: ${selectedPlanKeep.invalid.join(', ')}. Use exact names from tools[].function.name.`;
  }

  // ── Sandbox consent (multi-tenant isolation) ─────────────────────────────────
  // Custom skills run sandboxed by default (isolated to their own data). `sandbox`
  // defaults true; passing false opts OUT (a trust decision — full in-process access).
  // Network egress is DENIED unless the user grants it: since it lets a skill send data
  // out, a network-using skill can't be created until the caller has asked the user and
  // passes allow_network explicitly (true = grant, false = create offline).
  const isolate = sandbox !== false;
  const caps = scanSkillCapabilities(code);
  if (isolate && caps.usesNetwork && allow_network === undefined) {
    const why = caps.usesRuntime ? ' (it downloads and runs an external binary)' : '';
    return `⛔ Network consent needed. This skill makes network calls${why}, and sandboxed skills have NO network access by default — network egress lets a skill send data out, so it needs the user's explicit OK.\n\nAsk the user whether "${name.trim()}" should have network access, then re-call skill_create with allow_network:true (grant) or allow_network:false (create it offline — its fetches will fail until you enable network later).`;
  }

  const manifest = {
    id: skillId,
    name: name.trim(),
    description: description.trim(),
    icon: icon?.trim() || '🔧',
    category: 'utility',
    always_on: false,
    enabled_by_default: false,
    custom: true,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    tools,
  };
  if (Array.isArray(watchers) && watchers.length) {
    manifest.watchers = watchers.map(w => ({
      kind: String(w.kind || '').trim(),
      description: String(w.description || '').trim(),
    })).filter(w => w.kind);
  }
  if (preferenceOpportunities !== undefined) {
    const cleaned = cleanPreferenceOpportunities(preferenceOpportunities, tools, manifest.watchers || []);
    if (cleaned.error) return `Invalid preferenceOpportunities: ${cleaned.error}`;
    if (cleaned.values.length) manifest.preferenceOpportunities = cleaned.values;
  }
  // Per-turn tool router fields. intent_examples drives the embed classifier
  // decision "does this user prompt look like a request for this skill"; when
  // present, the tool-router can include the skill's tools on a matched turn
  // without the LLM having to call request_tools. coordinator_scope controls
  // whether the skill flows to coordinator-class agents at all.
  if (Array.isArray(intent_examples) && intent_examples.length) {
    const cleaned = intent_examples
      .map(s => typeof s === 'string' ? s.trim() : '')
      .filter(s => s.length > 0 && s.length < 200);
    if (cleaned.length) manifest.intent_examples = cleaned;
  }
  // localIntents: simple operations this skill can fulfil LOCALLY (regex →
  // embeddings → the on-device extract model) with no cloud-LLM round-trip.
  // See SKILL_BLUEPRINT's "localIntents" section. Same-tool paraphrase splits
  // are auto-merged and cross-intent ambiguity audited (field lesson: split
  // intents reject each other's utterances via the dispatch gap rule).
  {
    const cleaned = cleanLocalIntents(localIntents, newNames);
    if (cleaned) {
      const { mergeDuplicateToolIntents, auditIntentAmbiguity } = await import('../../lib/local-intent-audit.mjs');
      const { intents, notes } = mergeDuplicateToolIntents(cleaned);
      manifest.localIntents = intents;
      const ambiguity = await auditIntentAmbiguity(intents);
      const intentNotes = [...notes, ...ambiguity];
      if (intentNotes.length) {
        const block = 'localIntents audit:\n- ' + intentNotes.join('\n- ');
        args._gateWarnings = args._gateWarnings ? args._gateWarnings + '\n\n' + block : block;
      }
    }
  }
  if (selectedPlanKeep?.values.length) {
    manifest.selected_plan_keep = selectedPlanKeep.values;
  }
  // voice_device: when true, the skill's tools survive the voice-device tool
  // allowlist (chat-dispatch.mjs voiceToolAllowlistFor) so the user can trigger
  // the skill by speaking to a voice device. Off by default — voice turns run a
  // slim toolset for latency.
  if (voice_device === true) {
    manifest.voice_device = true;
  }
  if (coordinator_scope === 'exclude' || coordinator_scope === 'auto' || coordinator_scope === 'include') {
    manifest.coordinator_scope = coordinator_scope;
  }
  // Sandbox declaration — travels with the skill (roles.shouldSandboxSkill reads
  // sandbox.isolate; the runtime net policy reads sandbox.network). isolate:false is
  // the trust opt-out; network only granted when the user allowed it.
  manifest.sandbox = isolate
    ? { isolate: true, network: allow_network === true }
    : { isolate: false };

  // Portable execution hint (tier/effort) — never a concrete model id. Author
  // may pass execution_hint; otherwise infer from tools/description so custom
  // skills participate in auto model/effort selection without Settings pins.
  {
    const { normalizeExecutionHint, inferExecutionHintFromSpec } = await import('../../lib/execution-auto.mjs');
    const explicit = normalizeExecutionHint(execution_hint);
    const inferred = inferExecutionHintFromSpec({
      name: name.trim(), description: description.trim(), tools, code,
    });
    const hint = explicit || inferred;
    if (hint) manifest.execution_hint = hint;
  }

  // Pre-write gates: LSP type-check + manifest/code structural validator.
  // Both run together so a single fix-and-retry handles both. Strict
  // default — errors block; coder can pass skip_lsp / skip_validator to
  // bypass a specific gate after confirming a false positive.
  const gates = await runPreWriteGates(skillDir, manifest, code, {
    skip_lsp, skip_validator, opName: `Create of "${skillId}"`, skillId,
  });
  if (gates.block) return gates.block;
  if (gates.warnings) args._gateWarnings = gates.warnings;

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(skillDir, 'execute.mjs'), code);

  // Post-write smoke: import the freshly-written skill and exercise
  // every declared tool with schema-generated args. Catches handler
  // crashes, wrong-typed returns, hangs, and arg-name mismatches that
  // the static gates (LSP, manifest validator) can't see because they
  // don't execute the code. Strict default — any failure rolls back
  // the disk write. skip_smoke bypasses; tools marked `destructive:true`
  // in the manifest are skipped individually (see SKILL_BLUEPRINT).
  {
    const { runSkillSmoke, formatSmokeReport } = await import('../../lib/skill-smoke.mjs');
    const report = await runSkillSmoke(skillDir, manifest, { userId });
    if (report.setupError) {
      rmSync(skillDir, { recursive: true, force: true });
      return `Skill failed to load — files removed. Fix the issue and try again:\n\n${report.setupError}`;
    }
    if (!report.ok && !skip_smoke) {
      rmSync(skillDir, { recursive: true, force: true });
      return `Smoke-test failures (tool handlers crashed, hung, or returned the wrong type) — skill files removed. Fix and retry, or pass skip_smoke:true if these are tools the smoke test legitimately can't run (network-only, destructive, etc.):\n\n${formatSmokeReport(report)}`;
    }
    // Surface skipped tools (destructive, returned-null) and non-blocking
    // failures (when skip_smoke is set) as warnings on the success message.
    const hasNotes = report.results.some(r => r.outcome !== 'pass');
    if (hasNotes) {
      const smokeWarnings = 'Smoke notes:\n' + formatSmokeReport(report);
      args._gateWarnings = args._gateWarnings ? args._gateWarnings + '\n\n' + smokeWarnings : smokeWarnings;
    }
  }

  addRoleManifest(manifest, userId);

  await modifyProfile(userId, user => {
    user.skills = user.skills ?? [];
    if (!user.skills.includes(skillId)) user.skills.push(skillId);
  });

  // Persist the user-supplied assign_to mapping. Specialists no longer
  // inherit custom skills automatically — the skill reaches the named
  // agent only via this skillAssignments entry. Resolves "coordinator"
  // shorthand to the user's actual coordinator agent id so the user
  // doesn't have to remember the unique slug. Other ids pass through.
  let assignmentPersisted = false;
  try {
    const { setRoleAssignment } = await import('../../roles.mjs');
    let targetAgentId = assign_to.trim();
    if (targetAgentId.toLowerCase() === 'coordinator') {
      const { getUserCoordinatorAgentId } = await import('../../routes/_helpers.mjs');
      const resolved = getUserCoordinatorAgentId(userId);
      if (resolved) targetAgentId = resolved;
    }
    setRoleAssignment(skillId, targetAgentId, userId);
    assignmentPersisted = true;
  } catch (e) {
    console.warn('[skill-builder] assign failed:', e.message);
  }

  // Optional drawer — rolled back on failure so we never leave a half-built state.
  let drawerNote = '';
  if (drawer) {
    const pluginId = drawerPluginIdFor(userId, skillId);
    const drawerErr = await createDrawerForSkill(
      pluginId, manifest.name, manifest.icon, userId, skillId, drawer
    );
    if (drawerErr) {
      removeRoleManifest(skillId, userId);
      rmSync(skillDir, { recursive: true, force: true });
      if (assignmentPersisted) {
        try {
          const { setRoleAssignment } = await import('../../roles.mjs');
          setRoleAssignment(skillId, null, userId);
        } catch (e) {
          console.warn('[skill-builder] assignment rollback failed:', e.message);
        }
      }
      await modifyProfile(userId, user => {
        user.skills = (user.skills ?? []).filter(s => s !== skillId);
      });
      return `Drawer creation failed — skill creation rolled back:\n\n${drawerErr}`;
    }
    drawerNote = ' A sidebar drawer was also installed and hot-loaded in connected browsers.';
  }

  // Improvement log — first entry for the new skill.
  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(userId, skillId, {
      kind: 'created',
      summary: `Created with ${newNames.length} tool${newNames.length === 1 ? '' : 's'}: ${newNames.join(', ')}`,
    });
  } catch (e) { console.debug('[skill-builder] log append (create) failed:', e.message); }

  // If the new skill declared intent_examples, rebuild the embed-router's
  // index so the classifier picks up its phrases on the next chat turn
  // without waiting for a server restart.
  if (manifest.intent_examples?.length) {
    try {
      const { invalidateIntentEmbeddings, loadIntentEmbeddings } = await import('../../lib/specialist-embed-router.mjs');
      invalidateIntentEmbeddings();
      loadIntentEmbeddings().catch(e => console.warn('[skill-builder] reload intent embeddings failed:', e.message));
    } catch (e) { console.warn('[skill-builder] intent embedding refresh failed:', e.message); }
  }

  const warningTail = args._gateWarnings ? `\n\nNote — warnings (non-blocking):\n${args._gateWarnings}` : '';
  const sandboxLine = isolate
    ? `\n🔒 Runs sandboxed — isolated to its own data${manifest.sandbox.network ? ', with network access' : ', no network access'}.${caps.usesCredentials ? ' Secrets go in its encrypted per-skill credential store.' : ''}`
    : `\n⚠️ Created WITHOUT a sandbox — it runs in-process with full access to your data. Only appropriate for trusted admin skills.`;
  // Structured success sentinel. Every error path above returns a plain string;
  // ONLY this path returns an object with ok:true. Callers (handleDraftBuild,
  // the skill_create dispatch) branch on that instead of regex-matching the
  // prose — a skill whose name/tool contains "failed"/"rejected" no longer
  // gets misclassified as an error (which used to strand the draft and make
  // the retry fail "already exists").
  return { ok: true, message: `Skill "${manifest.name}" (${skillId}) created and loaded. Tools available in your next message: ${newNames.join(', ')}.${manifest.intent_examples?.length ? ` Tool-router classifier picked up ${manifest.intent_examples.length} intent example(s).` : ''} The skill persists across server restarts.${drawerNote}${sandboxLine}${warningTail}` };
}

async function handleUpdateCode(args, userId) {
  const { id: skillId, code, skip_lsp, skip_validator, skip_smoke } = args;
  if (!skillId?.trim()) return 'id is required.';
  if (!code?.trim())    return 'code is required.';
  if (!code.includes('executeSkillTool')) {
    return 'code must export executeSkillTool.';
  }

  const { getRoleManifest, listAllRoles, clearExecutorCache, isSandboxedSkill } = await import('../../roles.mjs');

  // Prefer the caller's own scope. Admins can fall through to any user's custom skill.
  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be updated.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const execPath = path.join(skillDir, 'execute.mjs');
  if (!existsSync(execPath)) {
    return `Skill "${skillId}" has no execute.mjs on disk.`;
  }

  // Pre-write gates: LSP + manifest/code validator on the new code
  // against the current on-disk manifest. Runs BEFORE any file is
  // touched so a broken update leaves the prior good version intact.
  /** @type {any} */
  let onDiskManifest = manifest;
  try { onDiskManifest = JSON.parse(readFileSync(path.join(skillDir, 'manifest.json'), 'utf8')); }
  catch { /* fall back to the in-memory manifest from roles */ }
  const gates = await runPreWriteGates(skillDir, onDiskManifest, code, {
    skip_lsp, skip_validator, opName: `Update of "${skillId}"`, skillId,
  });
  if (gates.block) return gates.block;
  const gateWarnings = gates.warnings ?? '';

  const backupPath = execPath + '.bak';

  // Back up current code before overwriting
  const priorCode = readFileSync(execPath, 'utf8');
  writeFileSync(backupPath, priorCode);
  writeFileSync(execPath, code);

  // Post-write smoke against the on-disk manifest. On any failure we
  // restore from backup before returning the error.
  let smokeWarnings = '';
  {
    const { runSkillSmoke, formatSmokeReport } = await import('../../lib/skill-smoke.mjs');
    const report = await runSkillSmoke(skillDir, onDiskManifest, { userId });
    if (report.setupError) {
      writeFileSync(execPath, readFileSync(backupPath));
      rmSync(backupPath, { force: true });
      return `Updated code failed to load — reverted to previous version:\n\n${report.setupError}`;
    }
    if (!report.ok && !skip_smoke) {
      writeFileSync(execPath, readFileSync(backupPath));
      rmSync(backupPath, { force: true });
      return `Smoke-test failures on the updated code — reverted to previous version. Fix and retry, or pass skip_smoke:true if the failing tools can't be smoke-tested:\n\n${formatSmokeReport(report)}`;
    }
    if (report.results.some(r => r.outcome !== 'pass')) {
      smokeWarnings = 'Smoke notes:\n' + formatSmokeReport(report);
    }
  }
  rmSync(backupPath, { force: true });

  // Versioned history — snapshot the version we just replaced (last
  // HISTORY_KEEP kept). Independent of the crash-restore `.bak` above: `.bak`
  // undoes a bad write WITHIN this call; history lets skill_rollback go back
  // ACROSS calls. Best-effort — never blocks a successful update.
  try {
    const { snapshotToHistory } = await import('../../lib/skill-history.mjs');
    snapshotToHistory(skillDir, 'execute.mjs', priorCode);
  } catch (e) { console.warn('[skill-builder] history snapshot failed:', e.message); }

  clearExecutorCache(skillId, ownerId);

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(ownerId, skillId, {
      kind: 'manual_update',
      summary: `Full code replacement (${code.length} bytes)`,
    });
  } catch (e) { console.debug('[skill-builder] log append (update) failed:', e.message); }

  // Sandbox advisories — surface so the coder can raise them with the user. If the
  // skill isn't isolated, offer to sandbox it; if the new code adds network calls the
  // jail won't permit, or uses secrets, flag that. Grants go via skill_update_manifest
  // (sandbox / allow_network) after the user OKs.
  const caps = scanSkillCapabilities(code);
  const sb = onDiskManifest.sandbox || {};
  const isolated = isSandboxedSkill(skillId, ownerId);
  const advisories = [];
  if (!isolated) {
    advisories.push('This skill is NOT sandboxed (runs in-process with full access). Recommend sandboxing it — ask the user, then call skill_update_manifest({id, sandbox:true}).');
  } else if (caps.usesNetwork && sb.network !== true) {
    advisories.push('The updated code makes network calls, but this sandboxed skill has no network access, so those calls will FAIL. Network egress needs the user\'s OK — ask, then call skill_update_manifest({id, allow_network:true}).');
  }
  if (caps.usesCredentials) advisories.push('Uses the encrypted per-skill credential store for secrets.');
  const advisoryTail = advisories.length ? `\n\n🔒 Sandbox notes:\n- ${advisories.join('\n- ')}` : '';

  const combinedWarnings = [gateWarnings, smokeWarnings].filter(Boolean).join('\n\n');
  const warningTail = combinedWarnings ? `\n\nNote — warnings (non-blocking):\n${combinedWarnings}` : '';
  return `Skill "${manifest.name}" (${skillId}) updated and hot-reloaded. New code is active immediately.${advisoryTail}${warningTail}`;
}

async function handleReadCode(args, userId) {
  const { id: skillId } = args;
  if (!skillId?.trim()) return 'id is required.';

  const { getRoleManifest, listAllRoles } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be read via this tool.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const execPath = path.join(userSkillsDir(ownerId), skillId, 'execute.mjs');
  if (!existsSync(execPath)) return `Skill "${skillId}" has no execute.mjs on disk.`;

  return readFileSync(execPath, 'utf8');
}

async function handlePatchCode(args, userId) {
  const { id: skillId, edits, skip_lsp, skip_validator, skip_smoke } = args;
  if (!skillId?.trim()) return 'id is required.';
  if (!Array.isArray(edits) || !edits.length) return 'edits must be a non-empty array.';
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.find !== 'string' || typeof e.replace !== 'string') {
      return `edits[${i}] must be an object with string "find" and "replace" fields.`;
    }
    if (!e.find.length) return `edits[${i}].find must be a non-empty string.`;
  }

  const { getRoleManifest, listAllRoles, clearExecutorCache } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be patched.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const execPath = path.join(skillDir, 'execute.mjs');
  if (!existsSync(execPath)) return `Skill "${skillId}" has no execute.mjs on disk.`;

  const original = readFileSync(execPath, 'utf8');
  let current = original;

  // Apply edits in order. Each find must match exactly once at the time it's applied.
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    const first = current.indexOf(find);
    if (first === -1) {
      return `edits[${i}].find not found in current file. It may have already been changed by an earlier edit, or the surrounding context is off. Call skill_read_code to inspect the current source.`;
    }
    const second = current.indexOf(find, first + 1);
    if (second !== -1) {
      return `edits[${i}].find matches multiple locations — include more surrounding context so it is unique.`;
    }
    current = current.slice(0, first) + replace + current.slice(first + find.length);
  }

  if (current === original) return 'All edits were no-ops — nothing changed.';

  if (!current.includes('executeSkillTool')) {
    return 'Patched code must still export executeSkillTool. Edit rejected.';
  }

  // Pre-write gates on the post-patch content vs the on-disk manifest.
  /** @type {any} */
  let onDiskManifest = manifest;
  try { onDiskManifest = JSON.parse(readFileSync(path.join(skillDir, 'manifest.json'), 'utf8')); }
  catch { /* fall back to roles' in-memory manifest */ }
  const gates = await runPreWriteGates(skillDir, onDiskManifest, current, {
    skip_lsp, skip_validator, opName: `Patch of "${skillId}"`, skillId,
  });
  if (gates.block) return gates.block;
  const gateWarnings = gates.warnings ?? '';

  const backupPath = execPath + '.bak';
  writeFileSync(backupPath, original);
  writeFileSync(execPath, current);

  // Post-write smoke against the on-disk manifest. Revert from backup
  // on any failure so a broken patch never leaves the user with worse
  // code than they had before.
  let smokeWarnings = '';
  {
    const { runSkillSmoke, formatSmokeReport } = await import('../../lib/skill-smoke.mjs');
    const report = await runSkillSmoke(skillDir, onDiskManifest, { userId });
    if (report.setupError) {
      writeFileSync(execPath, original);
      rmSync(backupPath, { force: true });
      return `Patched code failed to load — reverted to previous version:\n\n${report.setupError}`;
    }
    if (!report.ok && !skip_smoke) {
      writeFileSync(execPath, original);
      rmSync(backupPath, { force: true });
      return `Smoke-test failures on the patched code — reverted to previous version. Fix and retry, or pass skip_smoke:true if the failing tools can't be smoke-tested:\n\n${formatSmokeReport(report)}`;
    }
    if (report.results.some(r => r.outcome !== 'pass')) {
      smokeWarnings = 'Smoke notes:\n' + formatSmokeReport(report);
    }
  }
  rmSync(backupPath, { force: true });

  // Versioned history — snapshot the version we just replaced (last
  // HISTORY_KEEP kept). See skill_update_code for why this is separate
  // from the crash-restore `.bak` above.
  try {
    const { snapshotToHistory } = await import('../../lib/skill-history.mjs');
    snapshotToHistory(skillDir, 'execute.mjs', original);
  } catch (e) { console.warn('[skill-builder] history snapshot failed:', e.message); }

  clearExecutorCache(skillId, ownerId);

  const n = edits.length;

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    // Summary captures the first edit's find-string preview so the log
    // shows what changed without forcing the user to diff manually.
    const firstFind = edits[0].find.replace(/\s+/g, ' ').slice(0, 80);
    appendEntry(ownerId, skillId, {
      kind: 'manual_patch',
      summary: `${n} edit${n === 1 ? '' : 's'} applied; first targeted: "${firstFind}…"`,
    });
  } catch (e) { console.debug('[skill-builder] log append (patch) failed:', e.message); }

  const combinedWarnings = [gateWarnings, smokeWarnings].filter(Boolean).join('\n\n');
  const warningTail = combinedWarnings ? `\n\nNote — warnings (non-blocking):\n${combinedWarnings}` : '';
  return `Skill "${manifest.name}" (${skillId}) patched (${n} edit${n === 1 ? '' : 's'}) and hot-reloaded. New code is active immediately.${warningTail}`;
}

async function handleUpdateToolDef(args, userId) {
  const { id, tool_name, description, parameters } = args;
  if (!id?.trim() || !tool_name?.trim()) {
    return 'Both `id` (skill id) and `tool_name` are required.';
  }
  if (description == null && parameters == null) {
    return 'Provide at least one of `description` or `parameters` to update.';
  }
  if (parameters != null && typeof parameters !== 'object') {
    return '`parameters` must be a JSON-schema object (or omit it entirely).';
  }

  const skillId = id.trim();
  const { getRoleManifest, listAllRoles, clearExecutorCache, addRoleManifest } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be updated.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) {
    return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  }

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const manifestPath = path.join(skillDir, 'manifest.json');
  if (!existsSync(manifestPath)) return `Skill "${skillId}" has no manifest.json on disk.`;

  let disk;
  try {
    disk = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return `Could not parse manifest.json: ${e.message}`;
  }

  const tools = Array.isArray(disk.tools) ? disk.tools : [];
  const toolIdx = tools.findIndex(t => t?.function?.name === tool_name.trim());
  if (toolIdx === -1) {
    const known = tools.map(t => t?.function?.name).filter(Boolean).join(', ');
    return `Tool "${tool_name}" not found in this skill's manifest. Existing tools: ${known || '(none)'}.`;
  }
  const target = tools[toolIdx].function;
  const changed = [];
  if (typeof description === 'string') {
    target.description = description;
    changed.push('description');
  }
  if (parameters != null) {
    target.parameters = parameters;
    changed.push('parameters');
  }
  if (!changed.length) {
    return 'No fields applied — nothing to update.';
  }

  // Atomic write with backup so a write failure mid-stream can be recovered.
  const backupPath = manifestPath + '.bak';
  const original = readFileSync(manifestPath, 'utf8');
  writeFileSync(backupPath, original);
  try {
    writeFileSync(manifestPath, JSON.stringify(disk, null, 2) + '\n');
    // Re-register so the in-memory manifest matches disk. Doesn't reload the
    // executor (no code changed); does refresh the tool list every agent sees
    // on its next resolveAgentTools call.
    addRoleManifest(disk, ownerId);
    // Clear executor cache too: belt-and-suspenders for skills that read
    // their own manifest at runtime. Cheap; the executor reloads on next call.
    clearExecutorCache(skillId, ownerId);
  } catch (e) {
    writeFileSync(manifestPath, original);
    rmSync(backupPath, { force: true });
    return `Manifest write failed — reverted to previous version: ${e.message}`;
  }
  rmSync(backupPath, { force: true });

  // Versioned history — snapshot the manifest version we just replaced.
  try {
    const { snapshotToHistory } = await import('../../lib/skill-history.mjs');
    snapshotToHistory(skillDir, 'manifest.json', original);
  } catch (e) { console.warn('[skill-builder] history snapshot failed:', e.message); }

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(ownerId, skillId, {
      kind: 'manifest_update',
      summary: `Updated tool "${tool_name}" — fields: ${changed.join(', ')}`,
    });
  } catch (e) { console.debug('[skill-builder] log append (manifest_update) failed:', e.message); }

  return `Skill "${manifest.name}" (${skillId}) — tool "${tool_name}" manifest updated (${changed.join(' + ')}). The new description/parameters take effect on every agent's next turn.`;
}

// Update manifest-LEVEL fields (not a specific tool) on an existing skill:
// voice_device, systemPromptAddition, intent_examples, coordinator_scope,
// selected_plan_keep, description. Modeled on handleUpdateToolDef — atomic
// write + re-register so the change is live without a server restart.
async function handleUpdateManifest(args, userId) {
  const { id, voice_device, systemPromptAddition, intent_examples, localIntents, preferenceOpportunities, selected_plan_keep, coordinator_scope, description, sandbox, allow_network, execution_hint } = args;
  if (!id?.trim()) return 'id is required.';

  const skillId = id.trim();
  const { getRoleManifest, listAllRoles, clearExecutorCache, addRoleManifest } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) return 'Only user-created skills can be updated.';
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) return `Skill "${skillId}" not found. Use skill_list to see your skills.`;

  const ownerId = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const manifestPath = path.join(skillDir, 'manifest.json');
  if (!existsSync(manifestPath)) return `Skill "${skillId}" has no manifest.json on disk.`;

  let disk;
  try { disk = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { return `Could not parse manifest.json: ${e.message}`; }

  const changed = [];
  const toolNames = (disk.tools ?? []).map(t => t.function?.name).filter(Boolean);
  if (voice_device === true)  { disk.voice_device = true;       changed.push('voice_device=true'); }
  else if (voice_device === false) { delete disk.voice_device;  changed.push('voice_device=false'); }
  if (typeof systemPromptAddition === 'string' && systemPromptAddition.trim()) {
    disk.systemPromptAddition = systemPromptAddition;
    changed.push('systemPromptAddition');
  }
  if (Array.isArray(intent_examples)) {
    disk.intent_examples = intent_examples
      .map(s => typeof s === 'string' ? s.trim() : '')
      .filter(s => s.length > 0 && s.length < 200);
    changed.push(`intent_examples(${disk.intent_examples.length})`);
  }
  if (coordinator_scope === 'exclude' || coordinator_scope === 'auto' || coordinator_scope === 'include') {
    disk.coordinator_scope = coordinator_scope;
    changed.push(`coordinator_scope=${coordinator_scope}`);
  }
  if (typeof description === 'string' && description.trim()) {
    disk.description = description.trim();
    changed.push('description');
  }
  // localIntents — local cognition tier (see SKILL_BLUEPRINT). Pass [] to clear.
  // Same-tool paraphrase splits are auto-merged and cross-intent ambiguity
  // audited; audit findings ride back on the success message (never block).
  let intentAuditTail = '';
  if (Array.isArray(localIntents)) {
    const cleaned = cleanLocalIntents(localIntents, toolNames) ?? [];
    let finalIntents = cleaned;
    if (cleaned.length) {
      const { mergeDuplicateToolIntents, auditIntentAmbiguity } = await import('../../lib/local-intent-audit.mjs');
      const { intents, notes } = mergeDuplicateToolIntents(cleaned);
      finalIntents = intents;
      const ambiguity = await auditIntentAmbiguity(intents);
      const intentNotes = [...notes, ...ambiguity];
      if (intentNotes.length) intentAuditTail = '\n\nlocalIntents audit:\n- ' + intentNotes.join('\n- ');
    }
    disk.localIntents = finalIntents;
    if (!disk.localIntents.length) delete disk.localIntents;
    changed.push(`localIntents(${disk.localIntents?.length ?? 0})`);
  }
  // preferenceOpportunities — declarative, ask-first activation recipes for
  // confirmed preferences. Pass [] to clear. Recipes must bind this skill's
  // own destructive activation tool and an exactly-declared watcher kind.
  if (preferenceOpportunities !== undefined) {
    const cleaned = cleanPreferenceOpportunities(preferenceOpportunities, disk.tools || [], disk.watchers || []);
    if (cleaned.error) return `Invalid preferenceOpportunities: ${cleaned.error}`;
    if (cleaned.values.length) disk.preferenceOpportunities = cleaned.values;
    else delete disk.preferenceOpportunities;
    changed.push(`preferenceOpportunities(${cleaned.values.length})`);
  }
  // selected_plan_keep — terminal tools that survive selected recipe trimming.
  // Pass [] to clear.
  if (selected_plan_keep !== undefined) {
    if (!Array.isArray(selected_plan_keep)) {
      return 'selected_plan_keep must be an array of exact tool names from this skill. Pass [] to clear.';
    }
    const cleaned = cleanSelectedPlanKeep(selected_plan_keep, toolNames);
    if (cleaned.invalid.length) {
      return `selected_plan_keep references tools not in this skill: ${cleaned.invalid.join(', ')}. Existing tools: ${toolNames.join(', ') || '(none)'}.`;
    }
    if (cleaned.values.length) disk.selected_plan_keep = cleaned.values;
    else delete disk.selected_plan_keep;
    changed.push(`selected_plan_keep(${cleaned.values.length})`);
  }
  // Sandbox controls — isolate (run jailed) and network (allow egress). Only grant
  // network after the user has OK'd it: egress lets the skill send data out.
  if (typeof sandbox === 'boolean') {
    disk.sandbox = { ...(disk.sandbox || {}), isolate: sandbox };
    changed.push(`sandbox.isolate=${sandbox}`);
  }
  if (typeof allow_network === 'boolean') {
    disk.sandbox = { ...(disk.sandbox || {}), network: allow_network };
    changed.push(`sandbox.network=${allow_network}`);
  }
  // Portable execution tier/effort. Pass null to clear; omit to leave unchanged.
  if (execution_hint !== undefined) {
    if (execution_hint === null) {
      delete disk.execution_hint;
      changed.push('execution_hint=cleared');
    } else {
      const { normalizeExecutionHint } = await import('../../lib/execution-auto.mjs');
      const hint = normalizeExecutionHint(execution_hint);
      if (!hint) {
        return 'execution_hint must be {tier?: "fast"|"standard"|"strong"|"reasoning", effort?: "off"|"low"|"medium"|"auto"|"high"} (or null to clear).';
      }
      disk.execution_hint = hint;
      changed.push(`execution_hint=${JSON.stringify(hint)}`);
    }
  }
  if (!changed.length) {
    return 'No fields applied. Provide at least one of: voice_device, systemPromptAddition, intent_examples, localIntents, preferenceOpportunities, selected_plan_keep, coordinator_scope, description, sandbox, allow_network, execution_hint.';
  }

  const backupPath = manifestPath + '.bak';
  const original = readFileSync(manifestPath, 'utf8');
  writeFileSync(backupPath, original);
  try {
    writeFileSync(manifestPath, JSON.stringify(disk, null, 2) + '\n');
    addRoleManifest(disk, ownerId);
    clearExecutorCache(skillId, ownerId);
  } catch (e) {
    writeFileSync(manifestPath, original);
    rmSync(backupPath, { force: true });
    return `Manifest write failed — reverted to previous version: ${e.message}`;
  }
  rmSync(backupPath, { force: true });

  // Versioned history — snapshot the manifest version we just replaced.
  try {
    const { snapshotToHistory } = await import('../../lib/skill-history.mjs');
    snapshotToHistory(skillDir, 'manifest.json', original);
  } catch (e) { console.warn('[skill-builder] history snapshot failed:', e.message); }

  if (Array.isArray(intent_examples)) {
    try {
      const { invalidateIntentEmbeddings, loadIntentEmbeddings } = await import('../../lib/specialist-embed-router.mjs');
      invalidateIntentEmbeddings();
      loadIntentEmbeddings().catch(e => console.warn('[skill-builder] reload intent embeddings failed:', e.message));
    } catch (e) { console.warn('[skill-builder] intent embed rebuild failed:', e.message); }
  }

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(ownerId, skillId, { kind: 'manifest_update', summary: `Manifest fields: ${changed.join(', ')}` });
  } catch (e) { console.debug('[skill-builder] log append (manifest_update) failed:', e.message); }

  return `Skill "${manifest.name}" (${skillId}) manifest updated: ${changed.join(', ')}. Live on the next turn — for voice_device, the next voice turn re-reads the allowlist.${intentAuditTail}`;
}

// Resolve a custom skill manifest with the same owner/admin visibility rule
// every skill-builder handler uses. Returns { manifest, ownerId } or a string
// error message to return verbatim.
async function _resolveOwnedSkill(skillId, userId, requestedOwnerId = null) {
  const { getRoleManifest, listAllRoles } = await import('../../roles.mjs');
  const privileged = isPrivileged(userId);
  const ownerId = typeof requestedOwnerId === 'string' ? requestedOwnerId.trim() : '';
  if (ownerId && ownerId !== userId && !privileged) {
    return 'owner_id may only target another account when called by an admin/owner.';
  }

  let manifest = null;
  const scoped = getRoleManifest(skillId, userId);
  if (!ownerId && scoped?.custom && scoped.createdBy === userId) manifest = scoped;

  if (!manifest && privileged) {
    const matches = listAllRoles().filter(m =>
      m.id === skillId && m.custom && (!ownerId || m.createdBy === ownerId));
    if (matches.length > 1) {
      const owners = [...new Set(matches.map(m => m.createdBy).filter(Boolean))];
      return `Multiple users own a custom skill named "${skillId}". Retry with owner_id (${owners.join(', ')}).`;
    }
    manifest = matches[0] ?? null;
  }

  if (!manifest && scoped && !scoped.custom) {
    return 'Only user-created skills can be used with this tool.';
  }
  if (!manifest) return `Skill "${skillId}" not found. Use skill_list to see your skills.`;
  if (!manifest.createdBy
      || (manifest.createdBy !== userId && !privileged)) {
    return 'Skill ownership could not be verified.';
  }
  return { manifest, ownerId: manifest.createdBy };
}

async function handleReadDrawer(args, userId) {
  const skillId = String(args?.id || '').trim();
  if (!skillId) return 'id is required.';
  const resolved = await _resolveOwnedSkill(skillId, userId, args?.owner_id);
  if (typeof resolved === 'string') return resolved;
  const { ownerId } = resolved;
  const bundle = readDrawerBundle(ownerId, skillId);
  if (bundle?.error) return bundle.error;
  if (!bundle) return `Skill "${skillId}" does not have a drawer.`;
  const m = bundle.manifest;
  return JSON.stringify({
    id: skillId,
    owner_id: ownerId,
    version: m.version,
    drawer: {
      name: m.name,
      ...(m.lucideIcon ? { lucideIcon: m.lucideIcon } : {}),
      ...(m.icon ? { icon: m.icon } : {}),
      html: m.html || '',
      initJs: m.initJs || '',
      serverCode: bundle.serverCode || '',
    },
  }, null, 2);
}

async function handleUpdateDrawer(args, userId) {
  const skillId = String(args?.id || '').trim();
  if (!skillId) return 'id is required.';
  if (!args?.drawer || typeof args.drawer !== 'object' || Array.isArray(args.drawer)) {
    return 'drawer is required and must be a complete drawer object.';
  }
  const resolved = await _resolveOwnedSkill(skillId, userId, args?.owner_id);
  if (typeof resolved === 'string') return resolved;
  const { manifest, ownerId } = resolved;
  const existingBundle = readDrawerBundle(ownerId, skillId);
  if (existingBundle?.error) return existingBundle.error;
  const expectedVersion = typeof args?.expected_version === 'string'
    ? args.expected_version.trim()
    : '';
  // An interrupted swap may temporarily hide the canonical directory while
  // its rollback copy remains authoritative. Supplying a version proves this
  // is a replacement; persistDrawerBundle recovers and CAS-checks it under
  // the lock before writing.
  const existed = !!existingBundle || !!expectedVersion;
  if (existed && !expectedVersion) {
    return 'expected_version is required when replacing a drawer. Call skill_read_drawer first and pass its version.';
  }
  const pluginId = drawerPluginIdFor(ownerId, skillId);
  const error = await persistDrawerBundle({
    pluginId,
    skillName: manifest.name,
    skillIcon: manifest.icon,
    userId: ownerId,
    skillId,
    drawer: args.drawer,
    createOnly: false,
    expectedVersion: expectedVersion || undefined,
  });
  if (error) return error;

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(ownerId, skillId, {
      kind: 'drawer_update',
      summary: `${existed ? 'Replaced' : 'Added'} drawer "${args.drawer.name}"`,
    });
  } catch (e) { console.debug('[skill-builder] log append (drawer_update) failed:', e.message); }

  return `Skill "${manifest.name}" (${skillId}) drawer ${existed ? 'updated' : 'added'} and hot-reloaded.`
    + ' OE does not need a restart; connected browsers refresh the drawer automatically.';
}

async function handleDeleteDrawer(args, userId) {
  const skillId = String(args?.id || '').trim();
  if (!skillId) return 'id is required.';
  const resolved = await _resolveOwnedSkill(skillId, userId, args?.owner_id);
  if (typeof resolved === 'string') return resolved;
  const { manifest, ownerId } = resolved;
  const expectedVersion = typeof args?.expected_version === 'string'
    ? args.expected_version.trim()
    : '';
  if (!expectedVersion) {
    return 'expected_version is required before deleting a drawer. Call skill_read_drawer first and pass its version.';
  }
  const result = await removeDrawerForSkill(ownerId, skillId, {
    requireExisting: true,
    expectedVersion,
  });
  if (result.error) return result.error;

  try {
    await modifyProfile(ownerId, profile => {
      if (profile.pluginPrefs) delete profile.pluginPrefs[result.pluginId];
      if (Array.isArray(profile.allowedFeatures)) {
        profile.allowedFeatures = profile.allowedFeatures.filter(id => id !== result.pluginId);
      }
    });
  } catch (e) {
    console.warn('[skill-builder] drawer preference cleanup failed:', e.message);
  }

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(ownerId, skillId, {
      kind: 'drawer_delete',
      summary: `Deleted drawer "${manifest.name}" without deleting the skill`,
    });
  } catch (e) { console.debug('[skill-builder] log append (drawer_delete) failed:', e.message); }

  return `Skill "${manifest.name}" (${skillId}) drawer deleted and unloaded.`
    + ' The skill, its tools, and its saved data were left intact. OE does not need a restart.';
}

// ── skill_rollback ────────────────────────────────────────────────────────────
//
// List or restore a previous version of a skill's code or manifest, backed by
// the `.history/` snapshots lib/skill-history.mjs writes on every accepted
// skill_update_code / skill_patch_code / skill_update_tool_def /
// skill_update_manifest call. No `version` → list; a `version` → restore
// (snapshotting the CURRENT state first so the rollback itself is undoable),
// then re-run the same post-write checks the update tools use.
async function handleRollback(args, userId) {
  const { skill: skillIdRaw, target, version } = args || {};
  if (!skillIdRaw?.trim()) return 'skill is required.';
  if (target !== 'code' && target !== 'manifest') return 'target must be "code" or "manifest".';
  const skillId = skillIdRaw.trim();

  const resolved = await _resolveOwnedSkill(skillId, userId);
  if (typeof resolved === 'string') return resolved;
  const { manifest, ownerId } = resolved;

  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const fileType = target === 'code' ? 'execute.mjs' : 'manifest.json';
  const filePath = path.join(skillDir, fileType);
  if (!existsSync(filePath)) return `Skill "${skillId}" has no ${fileType} on disk.`;

  const { listHistorySnapshots, readHistorySnapshot, snapshotToHistory } = await import('../../lib/skill-history.mjs');

  // No version → list.
  if (version === undefined || version === null || version === '') {
    const list = listHistorySnapshots(skillDir, fileType);
    if (!list.length) {
      return `No history snapshots yet for "${skillId}"'s ${fileType}. Snapshots are written automatically starting with the next skill_update_code / skill_patch_code / skill_update_tool_def / skill_update_manifest call on this skill.`;
    }
    const lines = list.map(s => `${s.index}. ${s.ts} (${s.size}b) — ${s.preview}`);
    return `${fileType} history for "${skillId}" (newest first). Call skill_rollback({skill:"${skillId}", target:"${target}", version:<index or timestamp>}) to restore one:\n${lines.join('\n')}`;
  }

  const snap = readHistorySnapshot(skillDir, fileType, version);
  if (snap === null) {
    return `No history snapshots yet for "${skillId}"'s ${fileType}.`;
  }
  if (snap === undefined) {
    const list = listHistorySnapshots(skillDir, fileType);
    return `No snapshot matching version "${version}". Available: ${list.map(s => `${s.index} (${s.ts})`).join(', ')}.`;
  }

  const currentContent = readFileSync(filePath, 'utf8');
  if (currentContent === snap.content) {
    return `Skill "${skillId}"'s ${fileType} already matches snapshot #${snap.index} (${snap.ts}) — nothing to change.`;
  }

  // Snapshot the CURRENT (pre-rollback) state first — same discipline as
  // every other write in this file — so the rollback itself is undoable.
  try {
    snapshotToHistory(skillDir, fileType, currentContent);
  } catch (e) {
    return `Could not snapshot the current state before rolling back — aborted so nothing was lost: ${e.message}`;
  }

  const backupPath = filePath + '.bak';
  writeFileSync(backupPath, currentContent);

  if (target === 'code') {
    const { clearExecutorCache } = await import('../../roles.mjs');
    let onDiskManifest = manifest;
    try { onDiskManifest = JSON.parse(readFileSync(path.join(skillDir, 'manifest.json'), 'utf8')); }
    catch { /* fall back to the in-memory manifest from roles */ }

    // Same pre-write gates skill_update_code runs, against the restored code.
    const gates = await runPreWriteGates(skillDir, onDiskManifest, snap.content, {
      opName: `Rollback of "${skillId}" (code → snapshot #${snap.index}, ${snap.ts})`, skillId,
    });
    if (gates.block) {
      rmSync(backupPath, { force: true });
      return gates.block;
    }

    writeFileSync(filePath, snap.content);

    // Same post-write smoke discipline as skill_update_code — revert on failure.
    const { runSkillSmoke, formatSmokeReport } = await import('../../lib/skill-smoke.mjs');
    const report = await runSkillSmoke(skillDir, onDiskManifest, { userId });
    if (report.setupError) {
      writeFileSync(filePath, currentContent);
      rmSync(backupPath, { force: true });
      return `Rollback target failed to load — reverted, nothing changed:\n\n${report.setupError}`;
    }
    if (!report.ok) {
      writeFileSync(filePath, currentContent);
      rmSync(backupPath, { force: true });
      return `Smoke-test failures on the rollback target — reverted, nothing changed. The older code may be stale relative to the CURRENT manifest:\n\n${formatSmokeReport(report)}`;
    }
    rmSync(backupPath, { force: true });
    clearExecutorCache(skillId, ownerId);

    // Manifest-sync advisory (non-blocking): rolling back code can leave the
    // unchanged current manifest describing behavior the restored code no
    // longer has — same "keep the manifest in sync" rule as a manual patch.
    let syncNote = '';
    try {
      const { validateManifestCode, formatManifestDiagnostics } = await import('../../lib/manifest-validator.mjs');
      const r = validateManifestCode(onDiskManifest, snap.content);
      if (!r.ok || r.diagnostics.length) {
        syncNote = `\n\nManifest-sync check — the manifest may now be stale relative to the restored code:\n${formatManifestDiagnostics(r.diagnostics)}\nIf behavior actually changed, follow up with skill_update_tool_def / skill_update_manifest.`;
      }
    } catch { /* advisory only, never blocks */ }

    try {
      const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
      appendEntry(ownerId, skillId, { kind: 'rollback', summary: `code rolled back to snapshot #${snap.index} (${snap.ts})` });
    } catch (e) { console.debug('[skill-builder] log append (rollback) failed:', e.message); }

    const smokeNotes = report.results.some(r2 => r2.outcome !== 'pass') ? `\n\nSmoke notes:\n${formatSmokeReport(report)}` : '';
    return `Skill "${manifest.name}" (${skillId}) code rolled back to snapshot #${snap.index} (${snap.ts}, "${snap.preview}") and hot-reloaded. The version that was live is itself snapshotted, so this is undoable.${smokeNotes}${syncNote}`;
  }

  // target === 'manifest'
  let restoredManifest;
  try { restoredManifest = JSON.parse(snap.content); }
  catch (e) {
    rmSync(backupPath, { force: true });
    return `Snapshot #${snap.index} is not valid JSON — refusing to restore it: ${e.message}`;
  }

  const { addRoleManifest, clearExecutorCache } = await import('../../roles.mjs');
  writeFileSync(filePath, snap.content);
  try {
    addRoleManifest(restoredManifest, ownerId);
    clearExecutorCache(skillId, ownerId);
  } catch (e) {
    writeFileSync(filePath, currentContent);
    rmSync(backupPath, { force: true });
    return `Manifest rollback failed to register — reverted, nothing changed: ${e.message}`;
  }
  rmSync(backupPath, { force: true });

  // Manifest-sync advisory against the CURRENT (unchanged) code.
  let syncNote = '';
  try {
    const code = readFileSync(path.join(skillDir, 'execute.mjs'), 'utf8');
    const { validateManifestCode, formatManifestDiagnostics } = await import('../../lib/manifest-validator.mjs');
    const r = validateManifestCode(restoredManifest, code);
    if (!r.ok || r.diagnostics.length) {
      syncNote = `\n\nManifest-sync check — the restored manifest may not match the current code:\n${formatManifestDiagnostics(r.diagnostics)}`;
    }
  } catch { /* advisory only, never blocks */ }

  if (restoredManifest.intent_examples?.length || manifest.intent_examples?.length) {
    try {
      const { invalidateIntentEmbeddings, loadIntentEmbeddings } = await import('../../lib/specialist-embed-router.mjs');
      invalidateIntentEmbeddings();
      loadIntentEmbeddings().catch(() => {});
    } catch { /* best-effort */ }
  }

  try {
    const { appendEntry } = await import('../../lib/skill-improvement-log.mjs');
    appendEntry(ownerId, skillId, { kind: 'rollback', summary: `manifest rolled back to snapshot #${snap.index} (${snap.ts})` });
  } catch (e) { console.debug('[skill-builder] log append (rollback) failed:', e.message); }

  return `Skill "${manifest.name}" (${skillId}) manifest rolled back to snapshot #${snap.index} (${snap.ts}, "${snap.preview}") and re-registered live. The version that was live is itself snapshotted, so this is undoable.${syncNote}`;
}

// ── skill_try_tool ────────────────────────────────────────────────────────────
//
// Dry-run exactly ONE tool of a skill with the author's REAL args, through the
// exact same execution path production uses: the bwrap jail + ctx broker (see
// lib/skill-subprocess.mjs runCustomSkillSandboxed — the same function
// roles.mjs's production dispatcher calls) for sandboxed skills, or the
// in-process executor for a skill created with sandbox:false. Deliberately a
// REAL execution — not a simulation — so a working call here means it will
// actually work in production with those inputs.
async function handleTryTool(args, userId) {
  const { skill: skillIdRaw, tool: toolNameRaw, args: rawToolArgs, allowDestructive } = args || {};
  if (!skillIdRaw?.trim()) return 'skill is required.';
  if (!toolNameRaw?.trim()) return 'tool is required.';
  const skillId = skillIdRaw.trim();
  const toolName = toolNameRaw.trim();
  const toolArgs = (rawToolArgs && typeof rawToolArgs === 'object' && !Array.isArray(rawToolArgs)) ? rawToolArgs : {};

  const resolved = await _resolveOwnedSkill(skillId, userId);
  if (typeof resolved === 'string') return resolved;
  const { manifest, ownerId } = resolved;

  const skillDir = path.join(userSkillsDir(ownerId), skillId);
  const execPath = path.join(skillDir, 'execute.mjs');
  if (!existsSync(execPath)) return `Skill "${skillId}" has no execute.mjs on disk.`;

  let onDiskManifest = manifest;
  try { onDiskManifest = JSON.parse(readFileSync(path.join(skillDir, 'manifest.json'), 'utf8')); }
  catch { /* fall back to the in-memory manifest from roles */ }

  const toolDef = (onDiskManifest.tools || []).find(t => t?.function?.name === toolName);
  if (!toolDef) {
    const known = (onDiskManifest.tools || []).map(t => t?.function?.name).filter(Boolean).join(', ');
    return `Tool "${toolName}" not found on skill "${skillId}". Available tools: ${known || '(none)'}.`;
  }
  if (toolDef.destructive === true && allowDestructive !== true) {
    return `⛔ "${toolName}" is marked destructive:true in the manifest — refusing to run it with real args unless allowDestructive:true is explicitly passed. This is a REAL execution against real side effects, not a simulation. Confirm with the user, then re-call with allowDestructive:true.`;
  }

  const { isSandboxedSkill, executeRoleTool } = await import('../../roles.mjs');
  const isolated = isSandboxedSkill(skillId, ownerId);
  const startedAt = Date.now();

  if (isolated) {
    // Identical call to what roles.mjs's production dispatcher makes for a
    // sandboxed custom skill (runCustomSkillValue) — same jail, same
    // ctx-broker allowlist, same net policy read straight off the manifest.
    const { runCustomSkillSandboxed } = await import('../../lib/skill-subprocess.mjs');
    const net = onDiskManifest?.sandbox?.network === true;
    let r;
    try {
      r = await runCustomSkillSandboxed({ userId: ownerId, agentId: null, skillId, toolName, args: toolArgs, net });
    } catch (e) {
      return `Tool "${toolName}" threw after ${Date.now() - startedAt}ms: ${e.message}`;
    }
    const durationMs = Date.now() - startedAt;
    const consoleText = String(r.stderr || '').trim();
    const consoleBlock = consoleText
      ? `\n\nCaptured console/stderr output (also written to this skill's runtime.log — skill_read_logs level:'console'):\n${consoleText.slice(0, 4000)}${consoleText.length > 4000 ? '\n…[truncated]' : ''}`
      : '\n\n(no console output captured)';
    if (!r.ok) return `Tool "${toolName}" FAILED after ${durationMs}ms (sandboxed):\n${r.error}${consoleBlock}`;
    const resultText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
    return `Tool "${toolName}" ran in ${durationMs}ms (real sandboxed execution). Result:\n${resultText}${consoleBlock}`;
  }

  // Trusted (sandbox:false) skill — same in-process path production uses.
  // Console output from a trusted skill already prints straight into the
  // main server process (app.log), so there's nothing extra to capture here.
  try {
    const result = await executeRoleTool(toolName, toolArgs, ownerId, null);
    const durationMs = Date.now() - startedAt;
    const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return `Tool "${toolName}" ran in ${durationMs}ms (real in-process execution, untrusted-sandbox opted out). Result:\n${resultText}\n\n(console output from a trusted skill goes to the main app.log, not captured here — sandboxed skills capture it automatically.)`;
  } catch (e) {
    return `Tool "${toolName}" THREW after ${Date.now() - startedAt}ms: ${e.message}`;
  }
}

async function handleDelete(args, userId) {
  const { id: skillId } = args;
  if (!skillId?.trim()) return 'id is required.';

  const { getRoleManifest, listAllRoles, removeRoleManifest, clearExecutorCache } = await import('../../roles.mjs');

  let manifest = getRoleManifest(skillId, userId);
  if (manifest && !manifest.custom) {
    return 'Only user-created skills can be deleted.';
  }
  if (!manifest && isPrivileged(userId)) {
    manifest = listAllRoles().find(m => m.id === skillId && m.custom) ?? null;
  }
  if (!manifest) return `Skill "${skillId}" not found.`;

  const ownerId  = manifest.createdBy;
  const skillDir = path.join(userSkillsDir(ownerId), skillId);

  rmSync(skillDir, { recursive: true, force: true });

  // Skills persist state next to the user dir (e.g. <skillId>-config.json) which
  // outlives the skill dir, orphaning JSON files on delete. Remove the well-known
  // patterns. EXACT names only (never a `<skillId>-*` glob) so a sibling skill
  // whose id shares this prefix — e.g. "<skillId>-music" — is never clobbered.
  const removedState = [];
  try {
    const ownerDir = path.dirname(userSkillsDir(ownerId));
    const exactNames = new Set([`${skillId}.json`, `${skillId}-config.json`, `${skillId}-state.json`]);
    for (const ent of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (exactNames.has(ent.name) || ent.name.startsWith(`${skillId}.json.nuked-bak`)) {
        rmSync(path.join(ownerDir, ent.name), { force: true });
        removedState.push(ent.name);
      }
    }
  } catch (e) { console.warn('[skill-builder] state-file cleanup skipped:', e.message); }

  removeRoleManifest(skillId, ownerId);
  clearExecutorCache(skillId, ownerId);

  // Remove the paired drawer plugin (if any). Safe no-op when no drawer exists.
  const drawerRemoval = await removeDrawerForSkill(ownerId, skillId);
  if (drawerRemoval.error) {
    console.warn('[skill-builder] paired drawer cleanup failed:', drawerRemoval.error);
  }

  // Drop the LanceDB skill-trigger rows for this skill — the JSON triggers
  // file went with the skill dir above, but the embedded mirror persists
  // unless we delete it explicitly. Fire-and-forget; trigger leftovers can
  // never invoke a deleted skill (the tool name is gone) but they'd waste
  // prompt space if surfaced. Lazy import — keeps skill-builder usable on
  // installs that don't have cortex.
  try {
    const { dropSkillTriggers } = await import('../../lib/skill-triggers.mjs');
    await dropSkillTriggers(ownerId, skillId);
  } catch (e) {
    console.debug('[skill-builder] trigger drop skipped:', e.message);
  }

  // Clean up the owner's profile (may be a different user when an admin is deleting).
  await modifyProfile(ownerId, user => {
    user.skills = (user.skills ?? []).filter(s => s !== skillId);
    if (user.skillAssignments) delete user.skillAssignments[skillId];
    if (user.pluginPrefs) delete user.pluginPrefs[drawerPluginIdFor(ownerId, skillId)];
    if (Array.isArray(user.allowedFeatures)) {
      user.allowedFeatures = user.allowedFeatures.filter(
        id => id !== drawerPluginIdFor(ownerId, skillId),
      );
    }
  });

  // Rebuild the embed-router intent index so the deleted skill's example
  // phrases stop scoring against future prompts.
  if (manifest.intent_examples?.length) {
    try {
      const { invalidateIntentEmbeddings, loadIntentEmbeddings } = await import('../../lib/specialist-embed-router.mjs');
      invalidateIntentEmbeddings();
      loadIntentEmbeddings().catch(e => console.warn('[skill-builder] reload intent embeddings failed:', e.message));
    } catch (e) { console.warn('[skill-builder] intent embedding refresh failed:', e.message); }
  }

  // Alias cascade-delete: handled by skill-alias-framework via the manifest's
  // cascade_on_tools entry on skill_delete. No explicit call needed here.

  // Purge the skill's LEARNED state — standing role rules + skill overrides +
  // learned dispatch utterances (by skillId), and tool-plan recipes + pinned
  // default args + tool-failure history (by the manifest's tool names). Free-form
  // memory facts aren't skill-tagged, so they're deliberately left untouched.
  let purgeSummary = '';
  try {
    const { purgeSkillState, summarizePurge } = await import('../../lib/skill-teardown.mjs');
    const toolNames = (manifest.tools || []).map(t => t.function?.name).filter(Boolean);
    purgeSummary = summarizePurge(await purgeSkillState(ownerId, { skillId, toolNames }));
  } catch (e) { console.warn('[skill-builder] learned-state teardown skipped:', e.message); }

  return `Skill "${manifest.name}" (${skillId}) deleted and unloaded.`
    + (removedState.length ? ` Removed state files: ${removedState.join(', ')}.` : '')
    + (purgeSummary ? ` Cleared learned state: ${purgeSummary}.` : '');
}

async function handleList(userId) {
  const { listRoles } = await import('../../roles.mjs');
  const { readLog } = await import('../../lib/skill-improvement-log.mjs');
  const mySkills = listRoles(userId).filter(m => m.custom === true && m.createdBy === userId);
  if (!mySkills.length) return 'No custom skills yet. Use skill_create to build one.';
  return mySkills.map(m => {
    const n = (m.tools ?? []).length;
    const log = readLog(userId, m.id);
    const latest = log.length ? log[log.length - 1] : null;
    const historyHint = latest
      ? `\n    ↳ last change (${latest.kind}): ${latest.summary}`
      : '';
    return `• ${m.icon ?? '🔧'} **${m.name}** (${m.id}) — ${m.description} [${n} tool${n !== 1 ? 's' : ''}]${historyHint}`;
  }).join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

// ── Draft handlers ──────────────────────────────────────────────────────────
//
// Each turn the LLM uses these to grow/shape the draft instead of going
// straight to skill_create. The user sees a polished, structured draft
// state across the conversation; the LLM has a single artifact to consult
// and patch. Building is gated to explicit user intent — calling
// skill_create when a draft is open returns an error pointing at the
// draftId to build (or to discard) first.

function renderDraftSummary(draft) {
  const s = draft.spec;
  const lines = [];
  lines.push(`### ${s.name || '(unnamed skill)'} — draft ${draft.draftId}`);
  if (s.description) lines.push(`*${s.description}*`);
  lines.push('');

  if (s.tools?.length) {
    lines.push(`**Tools** (${s.tools.length}):`);
    for (const t of s.tools) {
      const status = t.status === 'proposed' ? '◯' : t.status === 'rejected' ? '✗' : '✓';
      lines.push(`- ${status} \`${t.name}\` — ${t.purpose || '(no purpose set)'}`);
    }
    lines.push('');
  }

  if (s.collection) {
    lines.push(`**Collection mode** — single watcher with per-item ${s.collection.itemNoun || 'items'}; default cadence ${s.collection.defaultCadenceSec || 3600}s, default delivery ${s.collection.defaultDeliver || 'agent'}.`);
    lines.push('');
  } else if (s.watcher) {
    lines.push(`**Background watcher** — cadence ${s.watcher.cadence || 'hourly'}, delivery ${s.watcher.deliver || 'agent'}.`);
    lines.push('');
  }

  if (s.sources?.length) {
    lines.push(`**Sources**: ${s.sources.map(src => `${src.name}${src.status === 'validated' ? ' ✓' : src.status === 'rejected' ? ' ✗' : ''}`).join(', ')}.`);
    lines.push('');
  }

  if (s.credentials?.length) {
    lines.push(`**Credentials needed**:`);
    for (const c of s.credentials) lines.push(`- \`${c.id}\` — ${c.label || c.id}${c.note ? ` (${c.note})` : ''}`);
    lines.push('');
  }

  if (s.aliasCatalog) {
    lines.push(`**User-named catalog** — entity kind \`${s.aliasCatalog.entity_kind}\` so the user can refer to ${s.aliasCatalog.noun_plural || 'them'} by name.`);
    lines.push('');
  }

  const keep = Array.isArray(s.selected_plan_keep) ? s.selected_plan_keep : s.selectedPlanKeep;
  if (Array.isArray(keep) && keep.length) {
    lines.push(`**Protected terminal tools**: ${keep.map(t => `\`${t}\``).join(', ')}`);
  }
  if (s.dataStorage) lines.push(`**Stores data at**: \`${s.dataStorage}\``);
  if (s.assignTo)   lines.push(`**Will be owned by**: \`${s.assignTo}\``);
  lines.push('');

  if (s.sampleDialogs?.length) {
    lines.push(`**Sample dialogs** (${s.sampleDialogs.length}):`);
    for (const d of s.sampleDialogs.slice(0, 3)) lines.push(`- "${d}"`);
    lines.push('');
  }

  const openQs = (s.openQuestions || []).filter(q => !q.answered);
  if (openQs.length) {
    lines.push(`**Open questions** (${openQs.length}):`);
    for (const q of openQs) lines.push(`- ${q.q}${q.suggestedDefault ? ` _(default: ${q.suggestedDefault})_` : ''}`);
    lines.push('');
  } else if (s.tools?.length) {
    lines.push(`*No open questions. Say "build it" to ship.*`);
  }

  if (s.rejectedCapabilities?.length) {
    lines.push(`<sub>declined: ${s.rejectedCapabilities.join(', ')}</sub>`);
  }
  return lines.join('\n');
}

async function handleDraftStart(args, userId) {
  const { name, description, id: hintId } = args || {};
  if (!name?.trim()) return 'name is required (the human-readable name for the skill).';
  if (!description?.trim()) return 'description is required (one short sentence describing what the skill does).';
  const draftId = newDraftId();
  const skillId = (hintId && hintId.trim()) || shortSkillId(name);
  const now = Date.now();
  const draft = {
    schema: DRAFT_SCHEMA_VERSION,
    draftId,
    userId,
    createdAt: now,
    updatedAt: now,
    spec: {
      id: skillId,
      name: name.trim(),
      description: description.trim(),
      tools: [],
      openQuestions: [],
      rejectedCapabilities: [],
      // Everything below is added lazily by skill_draft_update calls as
      // the conversation reveals the right shape.
    },
    capabilitiesConsulted: false,
  };
  saveDraft(draft);
  // First read includes the capability menu so the LLM can advise from
  // turn one. Subsequent skill_draft_show calls don't re-include it (the
  // LLM can re-read CAPABILITIES.md via skill_read_blueprint if needed).
  try { draft._capabilities = readFileSync(CAPABILITIES, 'utf8'); } catch { /* missing capabilities file is non-fatal */ }
  return `Draft \`${draftId}\` created for skill \`${skillId}\`.

${renderDraftSummary(draft)}

---

# Capability menu (consult before next reply)

${draft._capabilities || '(CAPABILITIES.md missing — using built-in knowledge)'}

---

Talk to the user. Cross-reference their ask against the menu above. Surface 1-3 matched capabilities as concrete choices. Use \`skill_draft_update\` to grow the draft. Do NOT call \`skill_create\` until the user explicitly says "build it".`;
}

async function handleDraftShow(args, userId) {
  const { draftId } = args || {};
  if (!draftId) {
    const drafts = listDrafts(userId);
    if (!drafts.length) return 'No drafts in progress.';
    return `${drafts.length} draft(s) in progress:\n` + drafts.map(d => `- \`${d.draftId}\` → \`${d.spec.id}\` (${d.spec.name}) — ${(d.spec.tools || []).length} tool(s), updated ${new Date(d.updatedAt).toLocaleString()}`).join('\n');
  }
  const draft = loadDraft(userId, draftId);
  if (!draft) return `No draft with id \`${draftId}\`.`;
  return renderDraftSummary(draft);
}

async function handleDraftUpdate(args, userId) {
  const { draftId, patch } = args || {};
  if (!draftId) return 'draftId is required.';
  if (!patch || typeof patch !== 'object') return 'patch is required (object of fields to merge into the draft spec).';
  const draft = loadDraft(userId, draftId);
  if (!draft) return `No draft with id \`${draftId}\`.`;

  // Reserved top-level fields the LLM doesn't get to overwrite — they're
  // framework state, not skill spec. Everything else is opaque to the
  // framework: the LLM grows the spec however it wants and the build step
  // collapses it into a skill_create call.
  const RESERVED = new Set(['draftId', 'userId', 'createdAt', 'updatedAt', 'schema']);
  for (const k of Object.keys(patch)) {
    if (RESERVED.has(k)) continue;
    // Array fields with semantic merge: tools (add/update by name),
    // openQuestions (add new, mark answered), credentials (add by id),
    // sources (add by name), rejectedCapabilities (de-dupe). Everything
    // else is a straight overwrite — the LLM passes a whole replacement
    // when it wants to change a scalar (description, dataStorage, …).
    if (k === 'tools' && Array.isArray(patch.tools)) {
      const existing = new Map((draft.spec.tools || []).map(t => [t.name, t]));
      for (const t of patch.tools) {
        if (!t?.name) continue;
        existing.set(t.name, { ...existing.get(t.name), ...t });
      }
      draft.spec.tools = [...existing.values()];
    } else if (k === 'openQuestions' && Array.isArray(patch.openQuestions)) {
      const byQ = new Map((draft.spec.openQuestions || []).map(q => [q.q, q]));
      for (const q of patch.openQuestions) {
        if (!q?.q) continue;
        byQ.set(q.q, { ...byQ.get(q.q), ...q });
      }
      draft.spec.openQuestions = [...byQ.values()];
    } else if (k === 'credentials' && Array.isArray(patch.credentials)) {
      const byId = new Map((draft.spec.credentials || []).map(c => [c.id, c]));
      for (const c of patch.credentials) {
        if (!c?.id) continue;
        byId.set(c.id, { ...byId.get(c.id), ...c });
      }
      draft.spec.credentials = [...byId.values()];
    } else if (k === 'sources' && Array.isArray(patch.sources)) {
      const byName = new Map((draft.spec.sources || []).map(s => [s.name, s]));
      for (const s of patch.sources) {
        if (!s?.name) continue;
        byName.set(s.name, { ...byName.get(s.name), ...s });
      }
      draft.spec.sources = [...byName.values()];
    } else if (k === 'rejectedCapabilities' && Array.isArray(patch.rejectedCapabilities)) {
      const set = new Set([...(draft.spec.rejectedCapabilities || []), ...patch.rejectedCapabilities]);
      draft.spec.rejectedCapabilities = [...set];
    } else {
      draft.spec[k] = patch[k];
    }
  }
  draft.updatedAt = Date.now();
  saveDraft(draft);
  return `Updated. Current state:\n\n${renderDraftSummary(draft)}`;
}

async function handleDraftBuild(args, userId) {
  const { draftId } = args || {};
  if (!draftId) return 'draftId is required.';
  const draft = loadDraft(userId, draftId);
  if (!draft) return `No draft with id \`${draftId}\`.`;
  const s = draft.spec;

  // Minimum coherence checks. The LLM is supposed to gate "ready to
  // build?" on these but defense-in-depth is cheap. Bail with a clear
  // pointer at what to fix; the LLM can do another skill_draft_update
  // and retry.
  if (!s.id) return `Draft has no id. Run \`skill_draft_update({draftId:'${draftId}', patch:{id:'<slug>'}})\` first.`;
  if (!s.name) return `Draft has no name.`;
  if (!s.description) return `Draft has no description.`;
  if (!s.tools?.length) return `Draft has zero tools. A skill needs at least one tool the agent can call.`;
  if (!s.code) return `Draft has no \`code\` field. You need to write the executeSkillTool implementation and skill_draft_update it onto the draft before building. (The capability spec is just the brief; code is the deliverable.)`;
  if (!s.assignTo) return `Draft has no assignTo. Set it to the agent id that should own this skill ('coordinator' for general helpers, or a specialist agent id).`;
  if (!s.systemPromptAddition) return `Draft has no systemPromptAddition. Every skill MUST include one — it teaches the owning agent how to operate the skill (kickoff tool, workflow rules, state location). Read the OWNING-AGENT GUIDANCE section of the blueprint.`;

  // Hand off to skill_create with the draft fully materialised. Use the
  // from_draft marker so handleCreate doesn't refuse on the "draft is
  // still open for this id" guard below.
  const createArgs = {
    id: s.id,
    name: s.name,
    description: s.description,
    icon: s.icon,
    tools: s.tools.filter(t => t.status !== 'rejected').map(t => t.toolDef).filter(Boolean),
    code: s.code,
    drawer: s.drawer,
    watchers: s.watchers,
    intent_examples: s.intentExamples,
    preferenceOpportunities: s.preferenceOpportunities,
    selected_plan_keep: Array.isArray(s.selected_plan_keep) ? s.selected_plan_keep : s.selectedPlanKeep,
    coordinator_scope: s.coordinatorScope,
    voice_device: s.voiceDevice === true || s.voice_device === true,
    assign_to: s.assignTo,
    from_draft: draftId,
  };
  const result = await handleCreate(createArgs, userId);

  // Only delete the draft on a clean success. handleCreate returns a structured
  // { ok:true, message } object on success and a plain error string on any
  // failure — branch on that, never on the prose (a skill named "…rejected"
  // would otherwise be misreported and orphan the draft).
  if (result && typeof result === 'object' && result.ok) {
    deleteDraft(userId, draftId);
    return `${result.message}\n\n_Draft \`${draftId}\` finalised and removed._`;
  }
  const errText = typeof result === 'string' ? result : (result?.message ?? String(result));
  return `Build attempt returned a problem — draft \`${draftId}\` kept so you can patch and retry:\n\n${errText}`;
}

async function handleDraftDiscard(args, userId) {
  const { draftId } = args || {};
  if (!draftId) return 'draftId is required.';
  const ok = deleteDraft(userId, draftId);
  return ok ? `Discarded draft \`${draftId}\`.` : `No draft with id \`${draftId}\`.`;
}

async function handleDraftList(args, userId) {
  return handleDraftShow({}, userId);
}

export async function executeSkillTool(name, args, userId, agentId) {
  // Skill code is import()'ed by the validator at create/update time, which
  // runs any top-level code in the OE server process with full FS / secret /
  // network privilege. Until validation is sandboxed (worker thread or static
  // analysis), restrict authorship to owner/admin so a prompt-injected child
  // or guest account can't write code-execution into the install.
  // skill_draft_build collapses a draft into a skill_create (code-execution at
  // validate time); skill_update_manifest injects systemPromptAddition / grants
  // sandbox+network. Both reach skill creation / prompt injection, so they are
  // gated alongside the direct code-authoring tools. draft start/update/show/
  // discard stay open — they only mutate an in-progress spec, no code runs.
  const CODE_AUTHORING = new Set([
    'skill_create', 'skill_update_code', 'skill_patch_code',
    'skill_update_tool_def', 'skill_update_manifest',
    'skill_update_drawer', 'skill_delete_drawer',
    'skill_draft_build', 'skill_delete', 'skill_rollback', 'skill_try_tool',
  ]);
  if (CODE_AUTHORING.has(name) && !isPrivileged(userId)) {
    return 'Permission denied: skill authoring (create/update/patch/delete/rollback/try) is restricted to admin/owner accounts.';
  }

  try {
    if (name === 'skill_read_blueprint')    return handleReadBlueprint();
    if (name === 'skill_create')            { const r = await handleCreate(args, userId); return typeof r === 'string' ? r : r.message; }
    if (name === 'skill_update_code')       return await handleUpdateCode(args, userId);
    if (name === 'skill_read_code')         return await handleReadCode(args, userId);
    if (name === 'skill_patch_code')        return await handlePatchCode(args, userId);
    if (name === 'skill_update_tool_def')   return await handleUpdateToolDef(args, userId);
    if (name === 'skill_update_manifest')   return await handleUpdateManifest(args, userId);
    if (name === 'skill_read_drawer')       return await handleReadDrawer(args, userId);
    if (name === 'skill_update_drawer')     return await handleUpdateDrawer(args, userId);
    if (name === 'skill_delete_drawer')     return await handleDeleteDrawer(args, userId);
    if (name === 'skill_rollback')          return await handleRollback(args, userId);
    if (name === 'skill_try_tool')          return await handleTryTool(args, userId);
    if (name === 'skill_delete')            return await handleDelete(args, userId);
    if (name === 'skill_list')              return await handleList(userId);
    if (name === 'skill_draft_start')       return await handleDraftStart(args, userId);
    if (name === 'skill_draft_show')        return await handleDraftShow(args, userId);
    if (name === 'skill_draft_update')      return await handleDraftUpdate(args, userId);
    if (name === 'skill_draft_build')       return await handleDraftBuild(args, userId);
    if (name === 'skill_draft_discard')     return await handleDraftDiscard(args, userId);
    if (name === 'skill_draft_list')        return await handleDraftList(args, userId);
    if (name === 'skill_read_logs')         return await handleReadLogs(args, userId);
    return null;
  } catch (e) {
    console.error(`[skill-builder] ${name}:`, e.message);
    return `Skill builder error: ${e.message}`;
  }
}

async function handleReadLogs(args, userId) {
  const skillId = String(args?.skillId || '').trim();
  if (!skillId) return 'skillId is required';
  // Strip any legacy "usr_" prefix the model might still infer from older
  // examples, so the read works whether or not the call accidentally uses
  // the obsolete naming.
  const cleanId = skillId.replace(/^usr_/, '');
  const { readSkillLog } = await import('../../lib/skill-logger.mjs');
  const opts = { userId, skillId: cleanId };
  if (Number.isFinite(Number(args.tail)))   opts.tail = Number(args.tail);
  if (args.level)                            opts.level = String(args.level);
  if (args.since !== undefined)              opts.since = args.since;
  if (args.q)                                opts.q = String(args.q);
  const { entries, totalBytes } = await readSkillLog(opts);
  if (!entries.length) {
    return `No log entries for ${cleanId}${args.q ? ` matching "${args.q}"` : ''}. The skill may not be using ctx.log.* (in which case console.log/warn/error fell through to OE's main app.log instead). Suggest updating its execute.mjs to use ctx.log for next-time diagnostics.`;
  }
  const lines = entries.map(e => {
    const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : '--:--:--';
    const meta = e.meta ? ' ' + JSON.stringify(e.meta) : '';
    return `${ts} [${(e.level || 'info').toUpperCase()}] ${e.msg}${meta}`;
  });
  return `Skill ${cleanId} runtime log (${entries.length} entries, file=${totalBytes}b):\n${lines.join('\n')}`;
}

export default executeSkillTool;

/**
 * Catalog source for the alias framework. Returns the list of skills this
 * user can reference, with id + name + description for the resolver.
 * Filters mirror the visibility rules in roles.listAllRoles + custom-skill
 * scoping (only the creator sees their own custom skills).
 */
export async function listAliasEntries(userId) {
  try {
    const { listAllRoles } = await import('../../roles.mjs');
    const all = listAllRoles();
    return all
      .filter(m => !m.custom || m.createdBy === userId)
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description || '',
        custom: !!m.custom,
      }));
  } catch (e) {
    console.warn('[skill-builder] listAliasEntries failed:', e.message);
    return [];
  }
}
