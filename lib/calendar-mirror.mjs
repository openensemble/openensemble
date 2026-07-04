// @ts-check
/**
 * lib/calendar-mirror.mjs
 *
 * Local Google Calendar mirror — the read-side cache that kills the 54–95s
 * "what's on my calendar" voice turns (measured: ~3.5s of gcal API calls,
 * the rest LLM reasoning across 7 redundant tool calls).
 *
 * One JSON file per user (users/<id>/calendar-mirror.json) holding every
 * visible calendar's concrete event instances over a rolling window of
 * −1 day … +35 days. Kilobytes, not megabytes: events are pruned to the
 * fields the fast-path templates and calendar_snapshot need.
 *
 * Freshness model (staleness is the hard constraint — a morning snapshot
 * must never answer an afternoon question after events changed):
 *   1. 5-min timer (startCalendarMirrorLoop) does incremental sync-token
 *      pulls — usually empty, ~200-400ms.
 *   2. Check-on-ask (getFreshMirror): if the mirror is older than maxAgeMs
 *      (default 2 min), ONE sync-token pull before answering.
 *   3. Any sync failure → getFreshMirror returns null and callers fall
 *      through to the live LLM+gcal path. Never answer from stale data
 *      silently; never hard-fail the turn.
 *
 * Sync tokens remember the ORIGINAL request's time window, so the window
 * can't slide via incremental pulls alone — a full re-pull re-anchors it
 * once per (server-local) day, and whenever Google expires a token (410).
 *
 * Google's push channels are deliberately NOT the baseline (self-hosted
 * installs are LAN-only); they can be layered on later as "sync now" pings
 * into this same module.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR, CFG_PATH } from './paths.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { getAccessToken, resolveTokenPath } from './google-auth.mjs';
import { log } from '../logger.mjs';

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const WINDOW_PAST_DAYS = 1;
const WINDOW_FUTURE_DAYS = 35;
const DEFAULT_MAX_AGE_MS = 2 * 60_000;   // check-on-ask threshold
const DEFAULT_REFRESH_MIN = 5;           // timer cadence
const FETCH_TIMEOUT_MS = 8_000;          // per-request; a voice turn is waiting

// ── State ─────────────────────────────────────────────────────────────────────
/** mtime-keyed parse cache — reads sit on the wake→dispatch hot path. */
const _cache = new Map();      // userId -> { mtimeMs, mirror }
/** In-flight sync dedupe — timer tick and check-on-ask share one pull. */
const _inflight = new Map();   // userId -> Promise<mirror|null>
let _timer = null;

export function mirrorPath(userId) {
  return path.join(USERS_DIR, userId, 'calendar-mirror.json');
}

/** True when the user has completed gcal OAuth (token file exists). */
export function hasGcalCreds(userId) {
  try { return !!resolveTokenPath('gcal', userId); } catch { return false; }
}

/**
 * Read the mirror file without any freshness guarantee. Returns null when
 * missing/corrupt. Use getFreshMirror() for anything user-facing.
 */
export function readMirror(userId) {
  const p = mirrorPath(userId);
  let mtimeMs;
  try { mtimeMs = fs.statSync(p).mtimeMs; }
  catch { _cache.delete(userId); return null; }
  const hit = _cache.get(userId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.mirror;
  try {
    const mirror = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cache.set(userId, { mtimeMs, mirror });
    return mirror;
  } catch { return null; }
}

function writeMirror(userId, mirror) {
  const p = mirrorPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(mirror));
  try { _cache.set(userId, { mtimeMs: fs.statSync(p).mtimeMs, mirror }); } catch {}
}

// ── Google API plumbing ───────────────────────────────────────────────────────
async function apiGet(token, endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data };
}

// ── Event shaping (pure — unit-tested) ────────────────────────────────────────
/**
 * Prune a Google event to mirror shape. start/end keep Google's own object
 * shape ({date} for all-day, {dateTime, timeZone} for timed) because events
 * store their OWN tz (field example: KST baseball game) and renderers must
 * convert to the user's local time.
 */
export function pruneEvent(e, calId) {
  const out = { calId, id: e.id, summary: e.summary || '(no title)', start: e.start, end: e.end };
  if (e.location) out.location = e.location;
  return out;
}

/** Sort key: instant of event start (all-day parses as local midnight). */
export function eventStartMs(ev) {
  const s = ev?.start;
  if (!s) return Number.MAX_SAFE_INTEGER;
  if (s.dateTime) return Date.parse(s.dateTime);
  if (s.date) {
    const [y, m, d] = s.date.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  return Number.MAX_SAFE_INTEGER;
}

function sortEvents(events) {
  return events.sort((a, b) => eventStartMs(a) - eventStartMs(b));
}

/**
 * Apply one incremental page of changes for a calendar to the event list.
 * Cancelled items are removed; anything else is upserted by (calId, id).
 * Pure — returns a new array.
 */
export function applyChanges(events, calId, items) {
  const changed = new Map();
  for (const it of items || []) if (it?.id) changed.set(it.id, it);
  const next = events.filter(ev => !(ev.calId === calId && changed.has(ev.id)));
  for (const it of changed.values()) {
    if (it.status === 'cancelled') continue;
    next.push(pruneEvent(it, calId));
  }
  return next;
}

// ── Sync ──────────────────────────────────────────────────────────────────────
function localDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD, server-local
}

function windowBounds(now = new Date()) {
  const timeMin = new Date(now.getTime() - WINDOW_PAST_DAYS * 86_400_000);
  const timeMax = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 86_400_000);
  return { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), anchoredOn: localDateStr(now) };
}

async function listCalendars(token) {
  const calendars = [];
  let pageToken = '';
  do {
    const r = await apiGet(token, `/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    if (!r.ok) throw new Error(`calendarList HTTP ${r.status}`);
    for (const c of r.data?.items || []) {
      if (c.deleted || c.selected === false) continue; // mirror only what the user shows in Google's UI
      calendars.push({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, accessRole: c.accessRole });
    }
    pageToken = r.data?.nextPageToken || '';
  } while (pageToken);
  return calendars;
}

/** Full window pull for one calendar. Returns {events, syncToken}. */
async function fullPullCalendar(token, calId, window) {
  const events = [];
  let syncToken = null;
  let pageToken = '';
  do {
    let qs = `/calendars/${encodeURIComponent(calId)}/events?singleEvents=true&maxResults=2500`
      + `&timeMin=${encodeURIComponent(window.timeMin)}&timeMax=${encodeURIComponent(window.timeMax)}`;
    if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
    const r = await apiGet(token, qs);
    if (!r.ok) throw new Error(`events.list(${calId}) HTTP ${r.status}`);
    for (const e of r.data?.items || []) {
      if (e.status === 'cancelled') continue;
      events.push(pruneEvent(e, calId));
    }
    pageToken = r.data?.nextPageToken || '';
    if (!pageToken) syncToken = r.data?.nextSyncToken || null;
  } while (pageToken);
  return { events, syncToken };
}

/**
 * Incremental pull for one calendar. Returns {items, nextSyncToken} or
 * {gone: true} when Google expired the token (HTTP 410) — caller re-pulls.
 */
async function incrementalPullCalendar(token, calId, syncToken) {
  const items = [];
  let nextSyncToken = null;
  let pageToken = '';
  do {
    let qs = `/calendars/${encodeURIComponent(calId)}/events?singleEvents=true&maxResults=2500`
      + `&syncToken=${encodeURIComponent(syncToken)}`;
    if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
    const r = await apiGet(token, qs);
    if (r.status === 410) return { gone: true };
    if (!r.ok) throw new Error(`events.list(${calId}) sync HTTP ${r.status}`);
    items.push(...(r.data?.items || []));
    pageToken = r.data?.nextPageToken || '';
    if (!pageToken) nextSyncToken = r.data?.nextSyncToken || null;
  } while (pageToken);
  return { items, nextSyncToken };
}

async function fullSync(userId, token) {
  const window = windowBounds();
  const calendars = {};
  let events = [];
  let pulled = 0;
  for (const cal of await listCalendars(token)) {
    try {
      const { events: evs, syncToken } = await fullPullCalendar(token, cal.id, window);
      calendars[cal.id] = { name: cal.name, primary: cal.primary, accessRole: cal.accessRole, syncToken };
      events = events.concat(evs);
      pulled++;
    } catch (e) {
      // freeBusyReader-only shares 403 on events.list — mirror the rest.
      log.warn('calendar-mirror', 'calendar pull failed, skipping', { userId, calId: cal.id, error: e.message });
    }
  }
  if (!pulled) throw new Error('no calendars could be pulled');
  const mirror = { fetchedAt: Date.now(), window, calendars, events: sortEvents(events) };
  writeMirror(userId, mirror);
  log.info('calendar-mirror', 'full sync', { userId, calendars: pulled, events: events.length });
  return mirror;
}

async function incrementalSync(userId, token, mirror) {
  let events = mirror.events;
  let changed = 0;
  for (const [calId, cal] of Object.entries(mirror.calendars)) {
    if (!cal.syncToken) continue;
    const r = await incrementalPullCalendar(token, calId, cal.syncToken);
    if (r.gone) {
      // Token expired — re-pull just this calendar over the existing window.
      const { events: evs, syncToken } = await fullPullCalendar(token, calId, mirror.window);
      events = events.filter(ev => ev.calId !== calId).concat(evs);
      cal.syncToken = syncToken;
      changed += evs.length;
      continue;
    }
    if (r.items.length) {
      events = applyChanges(events, calId, r.items);
      changed += r.items.length;
    }
    if (r.nextSyncToken) cal.syncToken = r.nextSyncToken;
  }
  const next = { ...mirror, fetchedAt: Date.now(), events: sortEvents(events) };
  writeMirror(userId, next);
  if (changed) log.info('calendar-mirror', 'incremental sync', { userId, changed });
  return next;
}

/**
 * Sync the user's mirror now. Incremental when possible; full pull on first
 * run, daily window re-anchor, or {force: true}. Concurrent callers (timer
 * tick + check-on-ask) share one in-flight pull. Throws on failure.
 */
export async function syncMirror(userId, { force = false } = {}) {
  const existing = _inflight.get(userId);
  if (existing) return existing;
  const p = (async () => {
    const token = await getAccessToken('gcal', userId);
    const mirror = readMirror(userId);
    const needsFull = force
      || !mirror?.calendars
      || !mirror?.window
      || mirror.window.anchoredOn !== localDateStr();
    return needsFull ? fullSync(userId, token) : incrementalSync(userId, token, mirror);
  })();
  _inflight.set(userId, p);
  try { return await p; }
  finally { _inflight.delete(userId); }
}

/**
 * Never-stale read: returns the mirror, syncing first when it's older than
 * maxAgeMs. Returns null when the user has no gcal creds OR the sync fails —
 * callers must fall through to the live gcal path, never answer stale.
 */
export async function getFreshMirror(userId, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!hasGcalCreds(userId)) return null;
  const mirror = readMirror(userId);
  if (mirror?.fetchedAt && Date.now() - mirror.fetchedAt <= maxAgeMs) return mirror;
  try {
    return await syncMirror(userId);
  } catch (e) {
    log.warn('calendar-mirror', 'check-on-ask sync failed', { userId, error: e.message });
    return null;
  }
}

// ── Refresh loop ──────────────────────────────────────────────────────────────
function refreshMs() {
  let raw;
  // Direct config read (not routes/_helpers loadConfig) to avoid a lib←routes cycle.
  try { raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).calendarMirrorRefreshMin; }
  catch { raw = undefined; }
  if (raw === 0 || raw === false) return null; // disabled
  return (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_MIN) * 60_000;
}

async function _tick() {
  let dirs = [];
  try { dirs = fs.readdirSync(USERS_DIR).filter(d => d.startsWith('user_')); } catch { return; }
  for (const userId of dirs) {
    if (!hasGcalCreds(userId)) continue;
    try { await syncMirror(userId); }
    catch (e) { log.warn('calendar-mirror', 'timer sync failed', { userId, error: e.message }); }
  }
}

export function startCalendarMirrorLoop() {
  if (_timer) return;
  const ms = refreshMs();
  if (ms === null) { console.log('[calendar-mirror] disabled via calendarMirrorRefreshMin'); return; }
  _timer = setInterval(() => { _tick().catch(e => console.warn('[calendar-mirror] tick failed:', e.message)); }, ms);
  if (_timer.unref) _timer.unref();
  // Prime shortly after boot so the first ask doesn't pay the full-pull cost.
  const prime = setTimeout(() => { _tick().catch(e => console.warn('[calendar-mirror] prime failed:', e.message)); }, 5_000);
  if (prime.unref) prime.unref();
  console.log(`[calendar-mirror] refresh loop started (every ${ms / 60_000} min)`);
}

export function stopCalendarMirrorLoop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
