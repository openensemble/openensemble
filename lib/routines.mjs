/**
 * Per-user voice routines: trigger phrase → ordered action list.
 *
 * Alexa-parity routines for voice devices. "Hey Sydney, goodnight" matches
 * the routine's trigger and executes a sequence of actions — turn off HA
 * scenes, start a looped ambient sound on the originating device, optionally
 * speak a confirmation — without round-tripping through the LLM.
 *
 * Schema: users/<userId>/routines.json
 *   {
 *     "version":    <bumped on every save>,
 *     "updated_at": <epoch ms>,
 *     "routines": [{
 *       "id":      "<slug>",
 *       "trigger": "<primary phrase>",
 *       "aliases": ["<phrase>", ...],
 *       "actions": [
 *         { "type":"ha_scene",     "scene_id":"scene.goodnight" },
 *         { "type":"ha_call",      "domain":"light", "service":"turn_off",
 *                                  "data":{"entity_id":"light.kitchen"} },
 *         { "type":"play_ambient", "file":"thunderstorm.mp3",
 *                                  "loop":true, "volume":60 },
 *         { "type":"tts_say",      "text":"Sleep well." }
 *       ]
 *     }]
 *   }
 *
 * Match rules (classifyRoutineIntent):
 *   - Lowercased, "hey sydney" prefix stripped, trailing punctuation/please
 *     stripped, whitespace collapsed.
 *   - Strict equality match against the normalized trigger OR any alias.
 *   - First routine to match wins; ambiguity (two routines, same phrase) is
 *     a user-error caught at save time, not runtime.
 *
 * Ambient files live alongside this in users/<userId>/ambient/*.mp3 — managed
 * by the helpers below so the same code path handles upload, list, delete,
 * and the play_ambient action dispatch.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';

// ── On-disk store ────────────────────────────────────────────────────────────

const ROUTINES_FILE = 'routines.json';
const AMBIENT_DIR = 'ambient';
const EMPTY = Object.freeze({ version: 0, updated_at: 0, routines: [] });

function routinesPath(userId) {
  return path.join(USERS_DIR, userId, ROUTINES_FILE);
}

export function ambientDir(userId) {
  return path.join(USERS_DIR, userId, AMBIENT_DIR);
}

export function ambientFilePath(userId, file) {
  // Defensive: reject anything that could escape the ambient dir. Filenames
  // come from REST routes where the client supplies the name; without this
  // a slash or .. would let a routine reference arbitrary files on disk.
  const safe = String(file || '').replace(/[\\/]/g, '').trim();
  if (!safe || safe.startsWith('.') || safe.length > 128) return null;
  return path.join(ambientDir(userId), safe);
}

export function loadRoutines(userId) {
  const p = routinesPath(userId);
  if (!fs.existsSync(p)) return { ...EMPTY };
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: Number.isInteger(obj.version) ? obj.version : 0,
      updated_at: Number.isInteger(obj.updated_at) ? obj.updated_at : 0,
      routines: Array.isArray(obj.routines) ? obj.routines : [],
    };
  } catch (e) {
    console.warn(`[routines] read failed for ${userId}: ${e.message}`);
    return { ...EMPTY };
  }
}

// Validate + persist a routines list. Drops malformed entries silently —
// callers that want strict failure should validate before calling.
export function saveRoutines(userId, routines) {
  const cleanList = [];
  const seenIds = new Set();
  const seenTriggers = new Set();
  for (const r of (Array.isArray(routines) ? routines : [])) {
    const clean = cleanRoutine(r);
    if (!clean) continue;
    if (seenIds.has(clean.id)) continue;            // duplicate id → drop
    const normTrigger = normalizePhrase(clean.trigger);
    if (seenTriggers.has(normTrigger)) continue;    // duplicate trigger → drop
    seenIds.add(clean.id);
    seenTriggers.add(normTrigger);
    for (const a of clean.aliases) seenTriggers.add(normalizePhrase(a));
    cleanList.push(clean);
  }
  const prev = loadRoutines(userId);
  const next = {
    version: prev.version + 1,
    updated_at: Date.now(),
    routines: cleanList,
  };
  const p = routinesPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(next, null, 2));
  return next;
}

function cleanRoutine(r) {
  if (!r || typeof r !== 'object') return null;
  const id = typeof r.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(r.id) ? r.id.toLowerCase() : null;
  const trigger = typeof r.trigger === 'string' ? r.trigger.trim().slice(0, 128) : '';
  if (!id || !trigger) return null;
  const aliases = Array.isArray(r.aliases)
    ? r.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, 128)).slice(0, 16)
    : [];
  const actions = Array.isArray(r.actions) ? r.actions.map(cleanAction).filter(Boolean).slice(0, 32) : [];
  if (!actions.length) return null;  // routine with no actions = pointless
  return { id, trigger, aliases, actions };
}

const ALLOWED_ACTION_TYPES = new Set(['ha_scene', 'ha_call', 'play_ambient', 'tts_say']);

function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  const type = typeof a.type === 'string' ? a.type : '';
  if (!ALLOWED_ACTION_TYPES.has(type)) return null;
  switch (type) {
    case 'ha_scene': {
      // Despite the name, this action covers scenes, scripts, AND groups
      // (and any HA entity if needed) because the UI dropdown lists all of
      // them. Kept named "ha_scene" for back-compat with already-saved
      // routines. Verb is meaningful for groups (turn on/off/toggle) and
      // ignored for scenes/scripts (always turn_on).
      const scene_id = typeof a.scene_id === 'string' ? a.scene_id.trim() : '';
      if (!/^[a-z_]{1,32}\.[a-z0-9_]{1,64}$/i.test(scene_id)) return null;
      const verb = typeof a.verb === 'string' && /^(turn_on|turn_off|toggle)$/.test(a.verb) ? a.verb : 'turn_on';
      return { type, scene_id, verb };
    }
    case 'ha_call': {
      const domain = typeof a.domain === 'string' ? a.domain.trim().toLowerCase() : '';
      const service = typeof a.service === 'string' ? a.service.trim().toLowerCase() : '';
      if (!/^[a-z_]{1,32}$/.test(domain) || !/^[a-z_]{1,48}$/.test(service)) return null;
      const data = a.data && typeof a.data === 'object' ? a.data : {};
      // Cap the data payload size — we forward this to HA verbatim.
      try {
        if (JSON.stringify(data).length > 2048) return null;
      } catch { return null; }
      return { type, domain, service, data };
    }
    case 'play_ambient': {
      const file = typeof a.file === 'string' ? a.file.trim().slice(0, 128) : '';
      if (!file) return null;
      const loop = a.loop !== false;  // default true; explicit false disables
      const volRaw = Number(a.volume);
      const volume = Number.isFinite(volRaw) ? Math.max(0, Math.min(100, Math.round(volRaw))) : null;
      return { type, file, loop, ...(volume != null ? { volume } : {}) };
    }
    case 'tts_say': {
      const text = typeof a.text === 'string' ? a.text.trim().slice(0, 512) : '';
      if (!text) return null;
      return { type, text };
    }
  }
  return null;
}

// ── Matcher ──────────────────────────────────────────────────────────────────

// Normalize a phrase for fast-path comparison. Strips leading wake words,
// trailing politeness, punctuation, and collapses whitespace.
export function normalizePhrase(s) {
  let t = String(s ?? '').toLowerCase();
  t = t.replace(/[‘’']/g, '');
  t = t.replace(/[.,!?]+$/g, '');
  // Strip leading "hey <name>," / "ok <name>," / bare "<name>," wake forms.
  // We don't know which wake-word the user has bound, so we accept any one or
  // two leading words followed by a comma — this is a heuristic, and a strict
  // routine-trigger match still has to follow. Worst case: a perfectly bare
  // trigger like "what's the weather" doesn't get pre-stripped, which is fine.
  t = t.replace(/^(hey|ok|hi|hello)\s+\w+[,!.]?\s*/, '');
  t = t.replace(/^\w+,\s*/, '');
  t = t.replace(/^please\s+/, '');
  t = t.replace(/\s+please$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Strip all whitespace so "good night" and "goodnight" compare equal —
// STT routinely splits compound words and we don't want the user to maintain
// both spellings as aliases. Used as a secondary comparison key alongside
// the whitespace-preserved normalized form.
function squashWhitespace(s) {
  return s.replace(/\s+/g, '');
}

/**
 * Match the user's utterance against the configured routines for `userId`.
 * Returns the routine record on a strict equality hit, or null.
 *
 * Strict equality means: "goodnight" matches the trigger "goodnight" but
 * "goodnight kitchen" does NOT — that would fall through to HA fast-path or
 * the LLM. This is deliberate: fast-paths must be high-precision.
 *
 * Whitespace is collapsed AND a no-whitespace variant is also compared so
 * "good night" and "goodnight" both match the same trigger.
 */
export function classifyRoutineIntent(text, userId) {
  if (typeof text !== 'string' || !userId) return null;
  const t = normalizePhrase(text);
  if (!t) return null;
  const tSquashed = squashWhitespace(t);
  const { routines } = loadRoutines(userId);
  for (const r of routines) {
    if (phraseMatches(r.trigger, t, tSquashed)) return r;
    for (const a of r.aliases) {
      if (phraseMatches(a, t, tSquashed)) return r;
    }
  }
  return null;
}

function phraseMatches(candidate, t, tSquashed) {
  const c = normalizePhrase(candidate);
  if (c === t) return true;
  if (squashWhitespace(c) === tSquashed) return true;
  return false;
}

// ── Ambient file management ──────────────────────────────────────────────────

const MAX_AMBIENT_BYTES = 15 * 1024 * 1024;

/**
 * List the user's uploaded ambient MP3s with basic metadata. Duration is
 * lazy — read with ffprobe on first use and cached in-memory so a directory
 * listing doesn't fork dozens of ffprobes on every drawer open.
 */
export function listAmbientFiles(userId) {
  const dir = ambientDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.mp3$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({
        name,
        size: st.size,
        updated_at: st.mtimeMs,
        duration_s: _durationCache.get(full) ?? null,
      });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const _durationCache = new Map();

export async function probeAmbientDuration(userId, file) {
  const full = ambientFilePath(userId, file);
  if (!full || !fs.existsSync(full)) return null;
  if (_durationCache.has(full)) return _durationCache.get(full);
  try {
    const { spawn } = await import('child_process');
    const result = await new Promise((resolve) => {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
                                   '-of', 'default=noprint_wrappers=1:nokey=1', full]);
      let out = '';
      p.stdout.on('data', c => { out += c.toString(); });
      p.on('error', () => resolve(null));
      p.on('close', () => resolve(parseFloat(out.trim()) || null));
    });
    if (result != null) _durationCache.set(full, result);
    return result;
  } catch { return null; }
}

/**
 * Persist an uploaded MP3 to users/<userId>/ambient/<file>. Caller has
 * already validated content (cap, mime). Returns the on-disk path.
 */
export function saveAmbientFile(userId, file, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('saveAmbientFile: buffer required');
  if (buffer.length > MAX_AMBIENT_BYTES) {
    throw new Error(`File too large (>${MAX_AMBIENT_BYTES} bytes)`);
  }
  const full = ambientFilePath(userId, file);
  if (!full) throw new Error('Invalid filename');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  _durationCache.delete(full);  // size may have changed; force re-probe
  return full;
}

export function deleteAmbientFile(userId, file) {
  const full = ambientFilePath(userId, file);
  if (!full) return false;
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  _durationCache.delete(full);
  return true;
}

// ── Executor ─────────────────────────────────────────────────────────────────

/**
 * Run a routine's actions. Errors in any single action are logged and the
 * loop continues — Alexa-style "do your best" semantics so a misconfigured
 * HA entity doesn't block the ambient sound from starting.
 *
 * Returns { text, errors } where text is the concatenated spoken reply
 * (empty string if nothing to say) and errors is a list of action failures
 * the caller can surface to the user via a follow-up sentence.
 *
 * ctx: { userId, deviceId } — deviceId is the device that heard the trigger;
 *      ambient + tts_say target it. ha_* actions are user-scoped (no device).
 */
export async function executeRoutine(routine, ctx) {
  const { userId, deviceId } = ctx || {};
  const says = [];
  const errors = [];
  for (const action of routine.actions) {
    try {
      const result = await dispatchAction(action, { userId, deviceId });
      if (result?.say) says.push(result.say);
    } catch (e) {
      console.warn(`[routines] action ${action.type} failed in routine ${routine.id}: ${e.message}`);
      errors.push({ type: action.type, message: e.message });
    }
  }
  let text = says.join(' ').trim();
  if (errors.length && !text) text = 'Some parts of that routine didn\'t complete.';
  return { text, errors };
}

async function dispatchAction(action, ctx) {
  switch (action.type) {
    case 'ha_scene':
      return runHaScene(action);
    case 'ha_call':
      return runHaCall(action);
    case 'play_ambient':
      return runPlayAmbient(action, ctx);
    case 'tts_say':
      return { say: action.text };
  }
  throw new Error(`Unknown action type: ${action.type}`);
}

async function runHaScene(action) {
  const { getHaConfig, haRequest } = await import('./ha-client.mjs');
  const cfg = getHaConfig();
  if (!cfg) throw new Error('Home Assistant is not configured');
  const entityDomain = action.scene_id.split('.', 1)[0];
  // Service routing:
  //   scene.*  → scene.turn_on  (scenes only support activation)
  //   script.* → script.turn_on (scripts only support starting)
  //   anything else (group.*, light.*, switch.*, …) → homeassistant.<verb>
  //     which is HA's generic on/off/toggle that fans out to whatever the
  //     target entity wraps. This is what lets a group entity work cleanly
  //     for ANY type of grouped device without per-domain dispatch logic.
  let serviceDomain, service;
  if (entityDomain === 'scene' || entityDomain === 'script') {
    serviceDomain = entityDomain;
    service = 'turn_on';
  } else {
    serviceDomain = 'homeassistant';
    service = action.verb || 'turn_on';
  }
  const res = await haRequest(cfg, `/services/${serviceDomain}/${service}`, 'POST',
                              { entity_id: action.scene_id });
  if (res?.__err) throw new Error(res.__err);

  // Build a short spoken confirmation — mirrors the single-entity HA
  // fast-path. Try the HA cache for the entity's friendly name; fall back
  // to deriving one from the entity_id ("light.kitchen_group" → "Kitchen
  // group") if the cache doesn't know the entity yet.
  let friendly;
  try {
    const idx = await (await import('./ha-cache.mjs')).ensureCache();
    if (idx) {
      for (const v of idx.values()) {
        if (v.entity_id === action.scene_id) { friendly = v.friendly_name; break; }
      }
    }
  } catch { /* best-effort */ }
  if (!friendly) {
    const tail = action.scene_id.split('.', 2)[1] || action.scene_id;
    friendly = tail.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  }
  let say;
  if (entityDomain === 'scene' || entityDomain === 'script') {
    say = `${friendly}.`;
  } else if (service === 'turn_on')  say = `${friendly} on.`;
  else if (service === 'turn_off') say = `${friendly} off.`;
  else if (service === 'toggle')   say = `${friendly} toggled.`;
  else                              say = `Done.`;
  return { say };
}

async function runHaCall(action) {
  const { getHaConfig, haRequest } = await import('./ha-client.mjs');
  const cfg = getHaConfig();
  if (!cfg) throw new Error('Home Assistant is not configured');
  const res = await haRequest(cfg, `/services/${action.domain}/${action.service}`, 'POST', action.data);
  if (res?.__err) throw new Error(res.__err);
  return null;
}

async function runPlayAmbient(action, { userId, deviceId }) {
  if (!deviceId) throw new Error('play_ambient requires a device');
  const { playAmbientOnDevice } = await import('./ambient-playback.mjs');
  await playAmbientOnDevice({ userId, deviceId, file: action.file,
                              loop: action.loop !== false, volume: action.volume });
  return null;
}
