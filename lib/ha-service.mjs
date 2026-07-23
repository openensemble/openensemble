/**
 * Home Assistant service-call confirmation.
 *
 * Writes continue over the established REST client. Confirmation uses the
 * persistent event stream when available and bounded REST polling otherwise.
 * A command that HA accepted but whose device has not reported back is
 * explicitly "pending", never misreported as a failed state transition.
 */

import { haRequest } from './ha-client.mjs';
import {
  getCachedHaState,
  isHaWebSocketReady,
  listCachedHaStates,
  prepareHaStateWait,
} from './ha-websocket.mjs';

const DEFAULT_CONFIRM_TIMEOUT_MS = 6_000;
const DEFAULT_POLL_INTERVAL_MS = 400;
const POLL_REQUEST_TIMEOUT_MS = 1_500;
const HA_TARGET_KEYS = new Set([
  'entity_id', 'device_id', 'area_id', 'floor_id', 'label_id', 'target',
]);
const HA_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,63}$/;
const HA_ENTITY_ID_RE = /^[a-z][a-z0-9_]{0,63}\.[a-z0-9_]{1,255}$/;

function numberNear(actual, expected, tolerance = 0.01) {
  const a = Number(actual);
  const b = Number(expected);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

/**
 * Return a deterministic postcondition only for services whose resulting
 * entity state is well defined. Scenes, scripts, automation triggers, and
 * other edge-triggered services deliberately return null.
 */
export function buildHaServiceExpectation({ domain, service, entityId, data = {}, beforeState = null }) {
  const serviceDomain = String(domain || '').toLowerCase();
  const serviceName = String(service || '').toLowerCase();
  const entityDomain = String(entityId || '').split('.', 1)[0].toLowerCase();

  if (serviceDomain === 'climate' && serviceName === 'set_hvac_mode' && typeof data.hvac_mode === 'string') {
    const expected = data.hvac_mode;
    return { label: expected, matches: state => state?.state === expected };
  }
  if (serviceDomain === 'climate' && serviceName === 'set_temperature' && data.temperature != null) {
    const expected = data.temperature;
    return {
      label: `${expected}°`,
      matches: state => numberNear(state?.attributes?.temperature, expected, 0.11),
    };
  }
  if (serviceDomain === 'climate' && serviceName === 'set_fan_mode' && typeof data.fan_mode === 'string') {
    const expected = data.fan_mode;
    return { label: expected, matches: state => state?.attributes?.fan_mode === expected };
  }
  if (entityDomain === 'fan' && serviceName === 'set_percentage' && data.percentage != null) {
    const expected = data.percentage;
    return {
      label: `${expected}%`,
      matches: state => numberNear(state?.attributes?.percentage, expected, 0.5),
    };
  }
  if (entityDomain === 'media_player' && serviceName === 'volume_set' && data.volume_level != null) {
    const expected = data.volume_level;
    return {
      label: `${Math.round(Number(expected) * 100)}%`,
      matches: state => numberNear(state?.attributes?.volume_level, expected, 0.011),
    };
  }
  if (entityDomain === 'light' && serviceName === 'turn_on') {
    if (data.brightness_pct != null) {
      const expected = Math.round(Number(data.brightness_pct) / 100 * 255);
      return {
        label: `${data.brightness_pct}%`,
        matches: state => state?.state === 'on'
          && numberNear(state?.attributes?.brightness, expected, 3),
      };
    }
    if (data.brightness != null) {
      const expected = Number(data.brightness);
      return {
        label: `${Math.round(expected / 255 * 100)}%`,
        matches: state => state?.state === 'on'
          && numberNear(state?.attributes?.brightness, expected, 2),
      };
    }
  }

  if (serviceName === 'turn_off' && !['scene', 'script', 'automation'].includes(entityDomain)) {
    return { label: 'off', matches: state => state?.state === 'off' };
  }
  if (serviceName === 'turn_on' && !['scene', 'script', 'automation'].includes(entityDomain)) {
    if (entityDomain === 'climate') {
      return {
        label: 'on',
        matches: state => !!state && !['off', 'unknown', 'unavailable'].includes(state.state),
      };
    }
    return { label: 'on', matches: state => state?.state === 'on' };
  }
  if (serviceName === 'lock') {
    return { label: 'locked', matches: state => state?.state === 'locked' };
  }
  if (serviceName === 'unlock') {
    return { label: 'unlocked', matches: state => state?.state === 'unlocked' };
  }
  if (serviceName === 'open_cover') {
    return { label: 'open', matches: state => ['open', 'opening'].includes(state?.state) };
  }
  if (serviceName === 'close_cover') {
    return { label: 'closed', matches: state => ['closed', 'closing'].includes(state?.state) };
  }
  if (serviceName === 'toggle' && ['on', 'off'].includes(beforeState?.state)) {
    const expected = beforeState.state === 'on' ? 'off' : 'on';
    return { label: expected, matches: state => state?.state === expected };
  }

  return null;
}

function changedStateFromResponse(response, entityId) {
  const states = Array.isArray(response)
    ? response
    : (Array.isArray(response?.changed_states) ? response.changed_states : []);
  return states.find(state => state?.entity_id === entityId) || null;
}

/**
 * The tool has one separately validated entity_id. Do not let arbitrary
 * service data add or replace HA target selectors, otherwise OE could actuate
 * one entity while waiting on and reporting another.
 */
export function sanitizeHaServiceData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !HA_TARGET_KEYS.has(key)),
  );
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function pollForState(haCfg, entityId, expectation, deadline) {
  let latest = null;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    const state = await haRequest(
      haCfg,
      `/states/${encodeURIComponent(entityId)}`,
      'GET',
      null,
      { timeoutMs: Math.min(POLL_REQUEST_TIMEOUT_MS, remaining) },
    );
    if (!state?.__err) {
      latest = state;
      try {
        if (expectation.matches(state)) return { matched: true, state };
      } catch {}
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { matched: false, state: latest };
}

export async function callHaServiceAndConfirm({
  haCfg,
  domain,
  service,
  entityId,
  data = {},
  confirmationTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
}) {
  if (!HA_IDENTIFIER_RE.test(String(domain || ''))
      || !HA_IDENTIFIER_RE.test(String(service || ''))
      || !HA_ENTITY_ID_RE.test(String(entityId || ''))) {
    return {
      accepted: false,
      confirmed: false,
      pending: false,
      error: 'Invalid Home Assistant domain, service, or entity_id',
      state: null,
    };
  }
  const safeData = sanitizeHaServiceData(data);
  // A retained cache is useful for reconnect resync, but it is not a reliable
  // precondition for toggle while disconnected.
  const beforeState = isHaWebSocketReady() ? getCachedHaState(entityId) : null;
  const expectation = buildHaServiceExpectation({
    domain, service, entityId, data: safeData, beforeState,
  });
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, confirmationTimeoutMs);
  const waiter = expectation
    ? prepareHaStateWait(entityId, expectation.matches, { timeoutMs: confirmationTimeoutMs })
    : null;

  const body = { ...safeData, entity_id: entityId };
  const response = await haRequest(haCfg, `/services/${domain}/${service}`, 'POST', body);
  if (response?.__err) {
    waiter?.cancel();
    return {
      accepted: false,
      confirmed: false,
      pending: false,
      error: response.__err,
      state: beforeState,
    };
  }

  if (!expectation) {
    waiter?.cancel();
    return {
      accepted: true,
      confirmed: null,
      pending: false,
      response,
      state: changedStateFromResponse(response, entityId),
    };
  }

  const responseState = changedStateFromResponse(response, entityId);
  if (responseState) {
    try {
      if (expectation.matches(responseState)) {
        waiter?.cancel();
        return {
          accepted: true, confirmed: true, pending: false,
          response, state: responseState, source: 'service_response',
        };
      }
    } catch {}
  }

  let latest = responseState || getCachedHaState(entityId) || beforeState;
  if (waiter) {
    const eventState = await waiter.promise;
    if (eventState) {
      return {
        accepted: true, confirmed: true, pending: false,
        response, state: eventState, source: 'websocket',
      };
    }
  }

  // A disconnect resolves the prepared waiter early, leaving the remainder
  // of the same deadline for polling. If the socket stayed connected but no
  // event arrived, do one final GET even when the deadline has just elapsed.
  if (Date.now() < deadline) {
    const polled = await pollForState(haCfg, entityId, expectation, deadline);
    latest = polled.state || latest;
    if (polled.matched) {
      return {
        accepted: true, confirmed: true, pending: false,
        response, state: polled.state, source: 'poll',
      };
    }
  } else {
    const finalState = await haRequest(
      haCfg,
      `/states/${encodeURIComponent(entityId)}`,
      'GET',
      null,
      { timeoutMs: POLL_REQUEST_TIMEOUT_MS },
    );
    if (!finalState?.__err) {
      latest = finalState;
      try {
        if (expectation.matches(finalState)) {
          return {
            accepted: true, confirmed: true, pending: false,
            response, state: finalState, source: 'final_read',
          };
        }
      } catch {}
    }
  }

  return {
    accepted: true,
    confirmed: false,
    pending: true,
    response,
    state: latest,
    expected: expectation.label,
  };
}

export async function readHaState(haCfg, entityId) {
  if (isHaWebSocketReady()) {
    const cached = getCachedHaState(entityId);
    if (cached) return cached;
  }
  return haRequest(haCfg, `/states/${encodeURIComponent(entityId)}`);
}

export async function listHaStates(haCfg) {
  if (isHaWebSocketReady()) return listCachedHaStates();
  return haRequest(haCfg, '/states');
}
