/**
 * Policy boundary for Home Assistant -> OpenEnsemble events.
 *
 * HA may request only execution of an already-saved OE routine, identified by
 * that routine's existing webhook capability token. Event data can never
 * supply an agent prompt, tool name, user identity, or action list.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  executeRoutineOutOfBand,
  findRoutineByWebhookToken,
  resolveRoutineDeviceId,
} from './routines.mjs';
import { listDevices } from './voice-devices.mjs';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const ALLOWED_KEYS = new Set([
  'v', 'action', 'routine_id', 'webhook_token',
]);
const ROUTINE_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const TOKEN_RE = /^[a-f0-9]{16,64}$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 6;
const GLOBAL_RATE_MAX = 60;
const LOOP_STREAK_MAX = 20;
const LOOP_QUIET_RESET_MS = 12 * 60 * 60_000;
const CIRCUIT_PATH = path.join(USERS_DIR, '_system', 'ha-event-circuits.json');

const inFlight = new Set();
const recentRuns = new Map();
let recentArrivals = [];

function loadCircuitState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CIRCUIT_PATH, 'utf8'));
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      return new Map();
    }
    const out = new Map();
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof key !== 'string' || key.length > 512 || !value || typeof value !== 'object') continue;
      const streak = Number.isInteger(value.streak) && value.streak >= 0 ? value.streak : 0;
      const lastRun = Number.isFinite(value.lastRun) ? value.lastRun : 0;
      out.set(key, {
        streak,
        lastRun,
        open: value.open === true,
        openedAt: Number.isFinite(value.openedAt) ? value.openedAt : null,
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

const circuitState = loadCircuitState();

function persistCircuitState() {
  try {
    fs.mkdirSync(path.dirname(CIRCUIT_PATH), { recursive: true });
    atomicWriteSync(CIRCUIT_PATH, JSON.stringify({
      version: 1,
      entries: Object.fromEntries(circuitState),
    }, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn(`[ha-event] circuit state write failed: ${e.message}`);
    return false;
  }
}

function capabilityKey(userId, routineId, token) {
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 24);
  return `${userId}:${routineId}:${digest}`;
}

function reject(reason, contextId = null) {
  return { ok: false, status: 'rejected', reason, context_id: contextId };
}

function reserveRoutineRun(key, now = Date.now()) {
  const recent = (recentRuns.get(key) || []).filter(ts => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    recentRuns.set(key, recent);
    return 'rate_limited';
  }

  const prior = circuitState.get(key) || {
    streak: 0, lastRun: 0, open: false, openedAt: null,
  };
  if (prior.open) return 'circuit_open';
  const quiet = prior.lastRun > 0
    && now >= prior.lastRun
    && now - prior.lastRun >= LOOP_QUIET_RESET_MS;
  const streak = quiet ? 0 : prior.streak;
  if (streak >= LOOP_STREAK_MAX) {
    circuitState.set(key, { ...prior, streak, open: true, openedAt: now });
    persistCircuitState();
    return 'circuit_open';
  }

  recent.push(now);
  recentRuns.set(key, recent);
  circuitState.set(key, {
    streak: streak + 1,
    lastRun: now,
    open: false,
    openedAt: null,
  });
  if (!persistCircuitState()) return 'safety_state_unavailable';
  return null;
}

function takeGlobalArrivalSlot(now = Date.now()) {
  recentArrivals = recentArrivals.filter(ts => now - ts < RATE_WINDOW_MS);
  if (recentArrivals.length >= GLOBAL_RATE_MAX) return false;
  recentArrivals.push(now);
  return true;
}

export async function handleHomeAssistantOpenEnsembleEvent(event) {
  const contextId = typeof event?.context?.id === 'string' ? event.context.id : null;
  const data = event?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return reject('invalid_envelope', contextId);
  }
  if (Object.keys(data).some(key => !ALLOWED_KEYS.has(key))) {
    return reject('unsupported_fields', contextId);
  }
  if (data.v !== 1 || data.action !== 'run_routine') {
    return reject('unsupported_action', contextId);
  }
  if (typeof data.routine_id !== 'string' || !ROUTINE_ID_RE.test(data.routine_id)) {
    return reject('invalid_routine_id', contextId);
  }
  if (typeof data.webhook_token !== 'string' || !TOKEN_RE.test(data.webhook_token)) {
    return reject('invalid_capability', contextId);
  }
  // Reserve an ingress slot before the synchronous token lookup. This bounds
  // filesystem work from a noisy or misconfigured HA event producer.
  if (!takeGlobalArrivalSlot()) return reject('event_rate_limited', contextId);

  const hit = findRoutineByWebhookToken(data.webhook_token);
  if (!hit || hit.routine?.id !== data.routine_id) {
    return reject('invalid_capability', contextId);
  }
  const { userId, routine } = hit;
  const ownedDevices = new Set(listDevices(userId).map(device => device.id));
  if (routine.device_id && !ownedDevices.has(routine.device_id)) {
    return reject('bound_device_unavailable', contextId);
  }

  // HA can select only the saved routine. Its saved device binding is part of
  // that capability; event data cannot redirect speech/audio to another room.
  const deviceId = resolveRoutineDeviceId(routine, null);
  // The capability-token digest makes token regeneration the explicit reset
  // for a latched loop circuit without ever persisting the bearer itself.
  const key = capabilityKey(userId, routine.id, data.webhook_token);
  if (inFlight.has(key)) return reject('already_running', contextId);
  const rateRejection = reserveRoutineRun(key);
  if (rateRejection) return reject(rateRejection, contextId);

  inFlight.add(key);
  try {
    const result = await executeRoutineOutOfBand(routine, {
      userId,
      deviceId,
    });
    const errors = [...(result.errors || [])];
    if (result.followupPrompt) {
      errors.push({
        type: 'run_prompt',
        message: 'run_prompt actions are not supported for Home Assistant event triggers',
      });
    }
    const deferred = Array.isArray(result.ambient) && result.ambient.length > 0;
    const status = errors.length ? 'partial' : (deferred ? 'dispatched' : 'completed');
    console.log(`[ha-event] routine ${routine.id} ${status} (errors=${errors.length})`);
    return {
      ok: true,
      status,
      routine_id: routine.id,
      device_id: result.deviceId || null,
      context_id: contextId,
      errors,
    };
  } catch (e) {
    console.warn(`[ha-event] routine ${routine.id} failed: ${e.message}`);
    return {
      ok: false,
      status: 'failed',
      routine_id: routine.id,
      context_id: contextId,
      reason: 'execution_failed',
    };
  } finally {
    inFlight.delete(key);
  }
}
