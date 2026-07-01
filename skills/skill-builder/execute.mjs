import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, unlinkSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import { randomBytes } from 'crypto';
import { SKILLS_DIR, USERS_DIR, userSkillsDir } from '../../lib/paths.mjs';
import { PLUGINS_DIR, registerDrawerManifest, unregisterDrawerManifest } from '../../plugins.mjs';

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
  const shortUser = userId.replace(/^user_/, '');
  return `usr_${shortUser}_${skillId}`;
}

function safeDomSuffix(s) { return s.replace(/[^a-zA-Z0-9]/g, '_'); }
function drawerDomIdFor(pluginId) { return 'drawer_' + safeDomSuffix(pluginId); }
function drawerBtnIdFor(pluginId) { return 'sbtn_'   + safeDomSuffix(pluginId); }

// Build and persist a drawer plugin. Returns null on success, or an error string.
async function createDrawerForSkill(pluginId, skillName, skillIcon, userId, skillId, drawer) {
  if (!drawer || typeof drawer !== 'object') return null;
  const { name, icon, lucideIcon, html, initJs, serverCode } = drawer;
  if (!html?.trim()) return 'drawer.html is required when a drawer is provided.';

  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  if (existsSync(pluginDir)) {
    return `Plugin directory "${pluginId}" already exists — refusing to overwrite.`;
  }

  const manifest = {
    id:                 pluginId,
    name:               (name ?? skillName).trim(),
    icon:               (icon ?? skillIcon ?? '🔧').trim(),
    lucideIcon:         typeof lucideIcon === 'string' && lucideIcon.trim() ? lucideIcon.trim() : undefined,
    description:        `Drawer for skill ${skillName}`,
    version:            '1.0.0',
    drawer:             true,
    drawerId:           drawerDomIdFor(pluginId),
    btnId:              drawerBtnIdFor(pluginId),
    enabled_by_default: true,
    custom:             true,
    createdBy:          userId,
    createdAt:          new Date().toISOString(),
    skillId,
    html,
    initJs:             initJs ?? '',
  };
  if (!manifest.lucideIcon) delete manifest.lucideIcon;

  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (serverCode?.trim()) {
    if (!serverCode.includes('handleRequest')) {
      rmSync(pluginDir, { recursive: true, force: true });
      return 'drawer.serverCode must export async function handleRequest(req, res, cfg).';
    }
    writeFileSync(path.join(pluginDir, 'server.mjs'), serverCode);

    // Sanity-import the server module so we catch syntax errors early.
    try {
      const url = pathToFileURL(path.join(pluginDir, 'server.mjs')).href + `?validate=${Date.now()}`;
      const mod = await import(url);
      if (typeof mod.handleRequest !== 'function') {
        rmSync(pluginDir, { recursive: true, force: true });
        return 'drawer.serverCode must export a function named handleRequest.';
      }
    } catch (e) {
      rmSync(pluginDir, { recursive: true, force: true });
      return `drawer.serverCode failed to load: ${e.message}`;
    }
  }

  registerDrawerManifest(manifest);
  return null;
}

function removeDrawerForSkill(userId, skillId) {
  const pluginId  = drawerPluginIdFor(userId, skillId);
  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
  unregisterDrawerManifest(pluginId);
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

async function handleCreate(args, userId) {
  const { id: rawId, name, description, icon, tools, code, drawer, watchers, intent_examples, localIntents, coordinator_scope, voice_device, assign_to, skip_lsp, skip_validator, skip_smoke, from_draft, sandbox, allow_network } = args;

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
  // See SKILL_BLUEPRINT's "localIntents" section.
  {
    const cleaned = cleanLocalIntents(localIntents, newNames);
    if (cleaned) manifest.localIntents = cleaned;
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
    const report = await runSkillSmoke(skillDir, manifest);
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
  try {
    const { setRoleAssignment } = await import('../../roles.mjs');
    let targetAgentId = assign_to.trim();
    if (targetAgentId.toLowerCase() === 'coordinator') {
      const { getUserCoordinatorAgentId } = await import('../../routes/_helpers.mjs');
      const resolved = getUserCoordinatorAgentId(userId);
      if (resolved) targetAgentId = resolved;
    }
    setRoleAssignment(skillId, targetAgentId, userId);
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
      await modifyProfile(userId, user => {
        user.skills = (user.skills ?? []).filter(s => s !== skillId);
      });
      return `Drawer creation failed — skill creation rolled back:\n\n${drawerErr}`;
    }
    drawerNote = ` A sidebar drawer was also installed — reload the page to see it.`;
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
  return `Skill "${manifest.name}" (${skillId}) created and loaded. Tools available in your next message: ${newNames.join(', ')}.${manifest.intent_examples?.length ? ` Tool-router classifier picked up ${manifest.intent_examples.length} intent example(s).` : ''} The skill persists across server restarts.${drawerNote}${sandboxLine}${warningTail}`;
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
  writeFileSync(backupPath, readFileSync(execPath));
  writeFileSync(execPath, code);

  // Post-write smoke against the on-disk manifest. On any failure we
  // restore from backup before returning the error.
  let smokeWarnings = '';
  {
    const { runSkillSmoke, formatSmokeReport } = await import('../../lib/skill-smoke.mjs');
    const report = await runSkillSmoke(skillDir, onDiskManifest);
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
    const report = await runSkillSmoke(skillDir, onDiskManifest);
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
// description. Modeled on handleUpdateToolDef — atomic write + re-register so
// the change is live without a server restart.
async function handleUpdateManifest(args, userId) {
  const { id, voice_device, systemPromptAddition, intent_examples, localIntents, coordinator_scope, description, sandbox, allow_network } = args;
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
  const manifestPath = path.join(userSkillsDir(ownerId), skillId, 'manifest.json');
  if (!existsSync(manifestPath)) return `Skill "${skillId}" has no manifest.json on disk.`;

  let disk;
  try { disk = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { return `Could not parse manifest.json: ${e.message}`; }

  const changed = [];
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
  if (Array.isArray(localIntents)) {
    const toolNames = (disk.tools ?? []).map(t => t.function?.name).filter(Boolean);
    disk.localIntents = cleanLocalIntents(localIntents, toolNames) ?? [];
    if (!disk.localIntents.length) delete disk.localIntents;
    changed.push(`localIntents(${disk.localIntents?.length ?? 0})`);
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
  if (!changed.length) {
    return 'No fields applied. Provide at least one of: voice_device, systemPromptAddition, intent_examples, localIntents, coordinator_scope, description, sandbox, allow_network.';
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

  return `Skill "${manifest.name}" (${skillId}) manifest updated: ${changed.join(', ')}. Live on the next turn — for voice_device, the next voice turn re-reads the allowlist.`;
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
  removeDrawerForSkill(ownerId, skillId);

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
    coordinator_scope: s.coordinatorScope,
    voice_device: s.voiceDevice === true || s.voice_device === true,
    assign_to: s.assignTo,
    from_draft: draftId,
  };
  const result = await handleCreate(createArgs, userId);

  // Only delete the draft on a clean success — handleCreate returns a
  // sentence-style message; "successfully" / "created" in the response
  // signals the write landed. On failure the draft persists so the LLM
  // can patch and retry without re-collecting the user's decisions.
  if (typeof result === 'string' && /created|added|registered/i.test(result) && !/error|failed|rejected/i.test(result)) {
    deleteDraft(userId, draftId);
    return `${result}\n\n_Draft \`${draftId}\` finalised and removed._`;
  }
  return `Build attempt returned a problem — draft \`${draftId}\` kept so you can patch and retry:\n\n${result}`;
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
  const CODE_AUTHORING = new Set(['skill_create', 'skill_update_code', 'skill_patch_code', 'skill_update_tool_def', 'skill_delete']);
  if (CODE_AUTHORING.has(name) && !isPrivileged(userId)) {
    return 'Permission denied: skill authoring (create/update/patch/delete) is restricted to admin/owner accounts.';
  }

  try {
    if (name === 'skill_read_blueprint')    return handleReadBlueprint();
    if (name === 'skill_create')            return await handleCreate(args, userId);
    if (name === 'skill_update_code')       return await handleUpdateCode(args, userId);
    if (name === 'skill_read_code')         return await handleReadCode(args, userId);
    if (name === 'skill_patch_code')        return await handlePatchCode(args, userId);
    if (name === 'skill_update_tool_def')   return await handleUpdateToolDef(args, userId);
    if (name === 'skill_update_manifest')   return await handleUpdateManifest(args, userId);
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
