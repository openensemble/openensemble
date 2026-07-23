/**
 * Persistent Home Assistant WebSocket client.
 *
 * REST remains the write path, while this connection supplies live entity
 * state, command-only HA APIs (area registry), and read-after-write
 * confirmation. The connection is process-wide because Home Assistant itself
 * is configured once per OE install.
 */

import WebSocket from 'ws';
import { getHaConfig } from './ha-client.mjs';

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const CUSTOM_EVENT_TYPE = 'openensemble_event';
const CUSTOM_EVENT_DEDUPE_MS = 5 * 60_000;
const CUSTOM_EVENT_MAX_BYTES = 4 * 1024;
const CUSTOM_EVENT_DEDUPE_MAX = 2_048;

function websocketUrl(httpUrl) {
  const target = new URL(String(httpUrl || '').replace(/\/+$/, '') + '/api/websocket');
  if (target.protocol === 'http:') target.protocol = 'ws:';
  else if (target.protocol === 'https:') target.protocol = 'wss:';
  else throw new Error('Home Assistant URL must use http or https');
  return target.toString();
}

export class HomeAssistantWebSocketBridge {
  constructor({
    configProvider = getHaConfig,
    WebSocketImpl = WebSocket,
    onOpenEnsembleEvent = null,
    reconnectJitter = () => Math.floor(Math.random() * 250),
  } = {}) {
    this.configProvider = configProvider;
    this.WebSocketImpl = WebSocketImpl;
    this.onOpenEnsembleEvent = onOpenEnsembleEvent;
    this.reconnectJitter = reconnectJitter;

    this.started = false;
    this.ready = false;
    this.authenticated = false;
    this.authBlocked = false;
    this.generation = 0;
    this.socket = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    this.nextCommandId = 1;
    this.pendingCommands = new Map();
    this.stateCache = new Map();
    this.stateVersions = new Map();
    this.stateSequence = 0;
    this.stateWaiters = new Map();
    this.seenCustomEvents = new Map();
    this.lastCustomEventSweepAt = 0;
    this.runtime = {
      state: 'stopped',
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
      customEventsAuthorized: null,
      customEventsError: null,
    };
  }

  setOpenEnsembleEventHandler(handler) {
    this.onOpenEnsembleEvent = typeof handler === 'function' ? handler : null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.authBlocked = false;
    this._connect();
  }

  stop() {
    if (!this.started && this.runtime.state === 'stopped') return;
    this.started = false;
    this.ready = false;
    this.authenticated = false;
    this.authBlocked = false;
    this.generation++;
    this._clearTimers();
    this._rejectPendingCommands(new Error('Home Assistant WebSocket stopped'));
    this._finishAllStateWaiters(null);
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try { ws.close(1000, 'OpenEnsemble stopping'); } catch {}
    }
    this.runtime.state = 'stopped';
  }

  reconfigure() {
    this.authBlocked = false;
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    this.ready = false;
    this.authenticated = false;
    this.generation++;
    this._clearTimers();
    this._rejectPendingCommands(new Error('Home Assistant configuration changed'));
    this._finishAllStateWaiters(null);
    this.stateCache.clear();
    this.stateVersions.clear();
    this.stateSequence = 0;
    this.seenCustomEvents.clear();
    this.runtime.customEventsAuthorized = null;
    this.runtime.customEventsError = null;
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try { ws.close(1000, 'Home Assistant configuration changed'); } catch {}
    }
    if (this.started) this._connect();
  }

  status() {
    return {
      state: this.runtime.state,
      ready: this.ready,
      lastConnectedAt: this.runtime.lastConnectedAt,
      lastEventAt: this.runtime.lastEventAt,
      lastError: this.runtime.lastError,
      customEventsAuthorized: this.runtime.customEventsAuthorized,
      customEventsError: this.runtime.customEventsError,
    };
  }

  getState(entityId) {
    return this.stateCache.get(String(entityId || '')) || null;
  }

  listStates() {
    return [...this.stateCache.values()];
  }

  async command(type, payload = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (!this.ready) throw new Error('Home Assistant event stream is not connected');
    return this._sendCommand(type, payload, timeoutMs);
  }

  /**
   * Register before issuing a REST service call so an unusually fast HA state
   * event cannot land in the gap between the POST response and waiter setup.
   */
  prepareStateWait(entityId, predicate, { timeoutMs = 6_000 } = {}) {
    const id = String(entityId || '');
    if (!id || typeof predicate !== 'function' || !this.ready) return null;

    let settled = false;
    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = this.stateWaiters.get(id);
      if (set) {
        set.delete(waiter);
        if (!set.size) this.stateWaiters.delete(id);
      }
      resolvePromise(state || null);
    };
    const waiter = { predicate, finish };
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    timer.unref?.();

    if (!this.stateWaiters.has(id)) this.stateWaiters.set(id, new Set());
    this.stateWaiters.get(id).add(waiter);

    const current = this.getState(id);
    if (current) {
      try { if (predicate(current)) queueMicrotask(() => finish(current)); }
      catch { queueMicrotask(() => finish(null)); }
    }
    return { promise, cancel: () => finish(null) };
  }

  _connect() {
    if (!this.started || this.authBlocked) return;
    const cfg = this.configProvider();
    if (!cfg) {
      this.runtime.state = 'disabled';
      this.runtime.lastError = null;
      this.runtime.customEventsAuthorized = null;
      this.runtime.customEventsError = null;
      return;
    }

    let url;
    try { url = websocketUrl(cfg.url); }
    catch (e) {
      this.runtime.state = 'error';
      this.runtime.lastError = e.message;
      this._scheduleReconnect(this.generation);
      return;
    }

    const generation = ++this.generation;
    this.ready = false;
    this.authenticated = false;
    this.runtime.state = this.runtime.lastConnectedAt ? 'reconnecting' : 'connecting';
    this.runtime.lastError = null;
    this.runtime.customEventsAuthorized = null;
    this.runtime.customEventsError = null;

    let ws;
    try {
      ws = new this.WebSocketImpl(url, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: MAX_PAYLOAD_BYTES,
        rejectUnauthorized: !cfg.allowSelfSigned,
        // Never follow a WebSocket redirect: the HA long-lived token is sent
        // only after the peer says auth_required, so following a redirect
        // would let another origin impersonate that peer and collect it.
        followRedirects: false,
      });
    } catch (e) {
      this.runtime.lastError = e.message;
      this._scheduleReconnect(generation);
      return;
    }
    this.socket = ws;

    this.connectTimer = setTimeout(() => {
      if (generation !== this.generation || this.ready) return;
      this.runtime.lastError = 'WebSocket authentication timed out';
      try { ws.terminate(); } catch {}
    }, CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();

    ws.on('open', () => {
      if (generation !== this.generation) return;
      this.runtime.state = 'authenticating';
    });

    ws.on('message', (raw) => {
      if (generation !== this.generation) return;
      this._handleMessage(raw, cfg, generation);
    });

    ws.on('error', (error) => {
      if (generation !== this.generation) return;
      this.runtime.lastError = error?.message || 'WebSocket error';
      try { ws.terminate(); } catch {}
    });

    ws.on('close', () => {
      if (generation !== this.generation) return;
      this.ready = false;
      this.authenticated = false;
      this.socket = null;
      this._clearConnectionTimers();
      this._rejectPendingCommands(new Error('Home Assistant WebSocket disconnected'));
      this._finishAllStateWaiters(null);
      if (this.authBlocked) {
        this.runtime.state = 'auth_invalid';
        return;
      }
      if (this.started) {
        this.runtime.state = 'reconnecting';
        this._scheduleReconnect(generation);
      }
    });
  }

  _handleMessage(raw, cfg, generation) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === 'auth_required') {
      try {
        this.socket?.send(JSON.stringify({ type: 'auth', access_token: cfg.token }));
      } catch (e) {
        this.runtime.lastError = e.message;
        try { this.socket?.terminate(); } catch {}
      }
      return;
    }

    if (msg.type === 'auth_invalid') {
      this.authBlocked = true;
      this.runtime.state = 'auth_invalid';
      this.runtime.lastError = 'Home Assistant rejected the access token';
      try { this.socket?.close(4001, 'Authentication failed'); } catch {}
      return;
    }

    if (msg.type === 'auth_ok') {
      this.authenticated = true;
      this.runtime.state = 'subscribing';
      this._initializeConnection(generation).catch((e) => {
        if (generation !== this.generation) return;
        this.runtime.lastError = e.message;
        try { this.socket?.terminate(); } catch {}
      });
      return;
    }

    if (msg.type === 'result' || msg.type === 'pong') {
      const pending = this.pendingCommands.get(msg.id);
      if (!pending) return;
      this.pendingCommands.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.type === 'pong' || msg.success !== false) {
        pending.resolve(msg.type === 'pong' ? null : msg.result);
      } else {
        pending.reject(new Error(msg.error?.message || msg.error?.code || 'Home Assistant command failed'));
      }
      return;
    }

    if (msg.type !== 'event' || !msg.event) return;
    this.runtime.lastEventAt = new Date().toISOString();
    const event = msg.event;
    if (event.event_type === 'state_changed') {
      const entityId = event.data?.entity_id;
      const next = event.data?.new_state;
      this._applyState(entityId, next);
      return;
    }
    if (event.event_type === CUSTOM_EVENT_TYPE) this._queueCustomEvent(event);
  }

  async _initializeConnection(generation) {
    // Use a local receive sequence, not HA/OE wall clocks, to protect live
    // events that arrive while get_states is in flight.
    const syncStartedSequence = this.stateSequence;
    await this._sendCommand('subscribe_events', { event_type: 'state_changed' });
    try {
      await this._sendCommand('subscribe_events', { event_type: CUSTOM_EVENT_TYPE });
      this.runtime.customEventsAuthorized = true;
      this.runtime.customEventsError = null;
    } catch (e) {
      // Some HA roles may read states but lack permission to subscribe to an
      // arbitrary custom event. Live state confirmation must remain usable.
      this.runtime.customEventsAuthorized = false;
      this.runtime.customEventsError = e.message;
      console.warn(`[ha-ws] custom OE events unavailable: ${e.message}`);
    }
    const states = await this._sendCommand('get_states');
    if (generation !== this.generation) return;
    if (Array.isArray(states)) {
      const snapshotIds = new Set();
      for (const state of states) {
        if (typeof state?.entity_id === 'string') snapshotIds.add(state.entity_id);
        const id = state?.entity_id;
        // A subscribed state_changed event received after sync began is newer
        // than this snapshot for ordering purposes, regardless of clock skew.
        if ((this.stateVersions.get(id) || 0) > syncStartedSequence) continue;
        this._applyState(id, state);
      }
      // get_states is authoritative for entities removed while OE was
      // disconnected. Preserve anything observed through a newer live event
      // during this sync window.
      for (const id of [...this.stateCache.keys()]) {
        if (!snapshotIds.has(id) && (this.stateVersions.get(id) || 0) <= syncStartedSequence) {
          this.stateCache.delete(id);
          this.stateVersions.set(id, ++this.stateSequence);
        }
      }
    }
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.ready = true;
    this.runtime.state = 'connected';
    this.runtime.lastConnectedAt = new Date().toISOString();
    this.runtime.lastError = null;
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    this._startHeartbeat(generation);
    console.log(`[ha-ws] connected; tracking ${this.stateCache.size} entities`);
  }

  _sendCommand(type, payload = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!this.authenticated || !this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error('Home Assistant WebSocket is not authenticated'));
    }
    const id = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Home Assistant WebSocket command timed out: ${type}`));
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.pendingCommands.set(id, { resolve, reject, timer, type });
      try {
        this.socket.send(JSON.stringify({ id, type, ...payload }));
      } catch (e) {
        clearTimeout(timer);
        this.pendingCommands.delete(id);
        reject(e);
      }
    });
  }

  _applyState(entityId, state) {
    const id = typeof entityId === 'string' ? entityId : state?.entity_id;
    if (!id) return;
    this.stateVersions.set(id, ++this.stateSequence);
    if (state) this.stateCache.set(id, state);
    else this.stateCache.delete(id);

    if (!state) return;
    const waiters = this.stateWaiters.get(id);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      try {
        if (waiter.predicate(state)) waiter.finish(state);
      } catch {
        waiter.finish(null);
      }
    }
  }

  _queueCustomEvent(event) {
    let dataBytes;
    try { dataBytes = Buffer.byteLength(JSON.stringify(event.data ?? null), 'utf8'); }
    catch { return; }
    if (dataBytes > CUSTOM_EVENT_MAX_BYTES) {
      console.warn(`[ha-ws] ignored oversized ${CUSTOM_EVENT_TYPE} payload (${dataBytes} bytes)`);
      return;
    }

    const contextId = typeof event.context?.id === 'string' ? event.context.id : null;
    const now = Date.now();
    if (now - this.lastCustomEventSweepAt >= 30_000
        || this.seenCustomEvents.size >= CUSTOM_EVENT_DEDUPE_MAX) {
      for (const [id, seenAt] of this.seenCustomEvents) {
        if (now - seenAt <= CUSTOM_EVENT_DEDUPE_MS) break;
        this.seenCustomEvents.delete(id);
      }
      this.lastCustomEventSweepAt = now;
    }
    if (contextId && this.seenCustomEvents.has(contextId)) return;
    if (contextId) {
      this.seenCustomEvents.set(contextId, now);
      while (this.seenCustomEvents.size > CUSTOM_EVENT_DEDUPE_MAX) {
        this.seenCustomEvents.delete(this.seenCustomEvents.keys().next().value);
      }
    }
    if (!this.onOpenEnsembleEvent) return;
    // Invoke immediately. The policy handler reserves its in-flight/rate slot
    // synchronously before its first await, so a recursive or burst duplicate
    // is rejected instead of accumulating in an uncancellable promise queue.
    try {
      Promise.resolve(this.onOpenEnsembleEvent(event))
        .catch((e) => console.warn(`[ha-ws] openensemble_event handler failed: ${e.message}`));
    } catch (e) {
      console.warn(`[ha-ws] openensemble_event handler failed: ${e.message}`);
    }
  }

  _startHeartbeat(generation) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (generation !== this.generation || !this.ready) return;
      this._sendCommand('ping', {}, HEARTBEAT_TIMEOUT_MS).catch((e) => {
        if (generation !== this.generation) return;
        this.runtime.lastError = e.message;
        try { this.socket?.terminate(); } catch {}
      });
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  _scheduleReconnect(generation) {
    if (!this.started || this.authBlocked || this.reconnectTimer) return;
    if (generation !== this.generation) return;
    const delay = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs) + this.reconnectJitter();
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started && !this.authBlocked) this._connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _rejectPendingCommands(error) {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  _finishAllStateWaiters(state) {
    for (const waiters of this.stateWaiters.values()) {
      for (const waiter of [...waiters]) waiter.finish(state);
    }
    this.stateWaiters.clear();
  }

  _clearConnectionTimers() {
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    this.connectTimer = null;
    this.heartbeatTimer = null;
  }

  _clearTimers() {
    this._clearConnectionTimers();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

const singleton = new HomeAssistantWebSocketBridge();

export function startHaWebSocketBridge({ onOpenEnsembleEvent } = {}) {
  if (onOpenEnsembleEvent) singleton.setOpenEnsembleEventHandler(onOpenEnsembleEvent);
  singleton.start();
}

export function stopHaWebSocketBridge() {
  singleton.stop();
}

export function reconfigureHaWebSocketBridge() {
  singleton.reconfigure();
}

export function getHaWebSocketStatus() {
  return singleton.status();
}

export function isHaWebSocketReady() {
  return singleton.ready;
}

export function getCachedHaState(entityId) {
  return singleton.getState(entityId);
}

export function listCachedHaStates() {
  return singleton.listStates();
}

export function prepareHaStateWait(entityId, predicate, options) {
  return singleton.prepareStateWait(entityId, predicate, options);
}

export function sendHaWebSocketCommand(type, payload, options) {
  return singleton.command(type, payload, options);
}
