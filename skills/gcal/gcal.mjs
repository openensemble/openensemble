#!/usr/bin/env node
/**
 * Google Calendar CLI — thin wrapper around Calendar REST API.
 * Usage:
 *   node gcal.mjs list [calendarId] [maxResults] [timeMin] [timeMax]
 *   node gcal.mjs get <eventId> [calendarId]
 *   node gcal.mjs create <json>
 *   node gcal.mjs update <eventId> <json> [calendarId]
 *   node gcal.mjs delete <eventId> [calendarId]
 *   node gcal.mjs quickadd <text> [calendarId]
 *   node gcal.mjs calendars
 */

import { getAccessToken as getGoogleAccessToken } from '../../lib/google-auth.mjs';

const BASE_URL   = 'https://www.googleapis.com/calendar/v3';

const _uid = process.env.OE_USER_ID;

async function getAccessToken() {
  return getGoogleAccessToken('gcal', _uid);
}

async function calFetch(endpoint, opts = {}) {
  const token = await getAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Calendar API error ${res.status}: ${err}`);
    process.exit(1);
  }
  if (res.status === 204) return {};
  return res.json();
}

// Non-fatal variant for the batch path: never process.exit on error — return the
// status + parsed body so the caller can retry rate-limits and tally per-event
// failures instead of aborting the whole batch on the first hiccup.
async function calFetchSafe(endpoint, opts = {}) {
  const token = await getAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
  } catch (e) {
    return { ok: false, status: 0, data: null, errText: e.message };
  }
  if (res.status === 204) return { ok: true, status: 204, data: {}, errText: '' };
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data, errText: res.ok ? '' : text };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDatetime(dt) {
  if (!dt) return '(no time)';
  if (dt.date) {
    // All-day events: date-only string like "2026-03-28" — parse as local to avoid UTC shift
    // End dates are exclusive in the API, so subtract one day for display
    const [year, month, day] = dt.date.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    if (dt._isEnd) d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  const d = new Date(dt.dateTime);
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtEvent(e, idx) {
  const lines = [];
  if (idx !== undefined) lines.push(`${idx}. [${e.id}] ${e.summary || '(no title)'}`);
  else lines.push(`[${e.id}] ${e.summary || '(no title)'}`);
  lines.push(`   Start:    ${fmtDatetime(e.start)}`);
  lines.push(`   End:      ${fmtDatetime(e.end ? { ...e.end, _isEnd: true } : e.end)}`);
  if (e.location) lines.push(`   Location: ${e.location}`);
  if (e.description) lines.push(`   Desc:     ${e.description.slice(0, 200)}`);
  if (e.attendees?.length) {
    const atts = e.attendees.map(a => `${a.displayName || a.email} (${a.responseStatus})`).join(', ');
    lines.push(`   Guests:   ${atts}`);
  }
  if (e.hangoutLink) lines.push(`   Meet:     ${e.hangoutLink}`);
  if (e.htmlLink) lines.push(`   Link:     ${e.htmlLink}`);
  return lines.join('\n');
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function cmdList(args) {
  const calId     = args[0] || 'primary';
  const max       = parseInt(args[1]) || 10;
  const timeMin   = args[2] || new Date().toISOString();
  const timeMax   = args[3] || '';
  let qs = `/calendars/${encodeURIComponent(calId)}/events?maxResults=${max}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}`;
  if (timeMax) qs += `&timeMax=${encodeURIComponent(timeMax)}`;
  const data = await calFetch(qs);
  if (!data.items?.length) { console.log('No upcoming events found.'); return; }
  for (const [i, e] of data.items.entries()) console.log(fmtEvent(e, i + 1) + '\n');
}

async function cmdGet(args) {
  const eventId = args[0];
  const calId   = args[1] || 'primary';
  if (!eventId) { console.error('Usage: gcal.mjs get <eventId> [calendarId]'); process.exit(1); }
  const e = await calFetch(`/calendars/${encodeURIComponent(calId)}/events/${eventId}`);
  console.log(fmtEvent(e));
}

async function cmdCreate(args) {
  const json  = args.join(' ');
  const calId = 'primary';
  let body;
  try { body = JSON.parse(json); } catch { console.error('Invalid JSON for event body'); process.exit(1); }
  const calIdOverride = body._calendarId;
  delete body._calendarId;
  const targetCal = calIdOverride || calId;
  const e = await calFetch(`/calendars/${encodeURIComponent(targetCal)}/events`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  console.log(`Event created: ${e.id}`);
  console.log(fmtEvent(e));
}

// Bulk create: one tool call → many events, looped server-side with a small
// concurrency pool, exponential backoff on rate limits, and an optional one-shot
// dedupe pre-scan. This replaces the pathological pattern of the model firing 50+
// gcal_list + gcal_create calls (one per event) through the LLM loop.
async function cmdCreateBatch(args) {
  const json = args.join(' ');
  let payload;
  try { payload = JSON.parse(json); } catch { console.error('Invalid JSON for batch create'); process.exit(1); }
  const calId        = payload.calendarId || 'primary';
  const skipExisting = payload.skipExisting !== false;        // default ON
  const requested    = Number(payload.requested) || (Array.isArray(payload.events) ? payload.events.length : 0);
  const events       = Array.isArray(payload.events) ? payload.events : [];
  if (!events.length) { console.log('No valid events to create.'); return; }

  // Day-granularity identity key — "same title, same calendar day". Robust across
  // the timed/all-day and timezone-offset mismatches that make exact start-time
  // matching unreliable, and good enough to stop the common double-add.
  const keyOf = (summary, startStr) => `${String(summary || '').trim().toLowerCase()}||${String(startStr || '').slice(0, 10)}`;
  const bodyStart = b => b.start?.dateTime || b.start?.date || '';

  // Drop exact-duplicate INPUT events up front (model occasionally repeats one).
  const seen = new Set();
  const uniqueEvents = [];
  for (const b of events) {
    const k = keyOf(b.summary, bodyStart(b));
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueEvents.push(b);
  }

  // Optional one-shot dedupe pre-scan: list the spanning window ONCE and skip any
  // event already on the calendar. Best-effort — if the list fails we just create.
  let existingKeys = new Set();
  if (skipExisting) {
    try {
      const toIso = v => (v && v.length <= 10) ? `${v}T00:00:00Z` : v;
      const starts = uniqueEvents.map(bodyStart).filter(Boolean).sort();
      const ends   = uniqueEvents.map(b => b.end?.dateTime || b.end?.date || '').filter(Boolean).sort();
      const timeMin = toIso(starts[0]);
      const timeMax = toIso(ends[ends.length - 1] || starts[starts.length - 1]);
      let pageToken = '';
      do {
        let qs = `/calendars/${encodeURIComponent(calId)}/events?maxResults=2500&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
        if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
        const r = await calFetchSafe(qs);
        if (!r.ok) break;
        for (const e of (r.data?.items || [])) existingKeys.add(keyOf(e.summary, e.start?.dateTime || e.start?.date));
        pageToken = r.data?.nextPageToken || '';
      } while (pageToken);
    } catch { existingKeys = new Set(); }
  }

  const results = { created: [], skipped: [], failed: [] };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CONCURRENCY = 5;

  async function createOne(body) {
    const k = keyOf(body.summary, bodyStart(body));
    if (skipExisting && existingKeys.has(k)) { results.skipped.push(body.summary || '(no title)'); return; }
    const targetCal = body._calendarId || calId;
    const clean = { ...body }; delete clean._calendarId;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await calFetchSafe(`/calendars/${encodeURIComponent(targetCal)}/events`, { method: 'POST', body: JSON.stringify(clean) });
      if (r.ok) {
        results.created.push({ id: r.data?.id, summary: r.data?.summary || body.summary });
        existingKeys.add(k);          // guard against a duplicate later in the same batch
        return;
      }
      const retryable = r.status === 429 || r.status === 500 || r.status === 503 ||
        (r.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(r.errText || ''));
      if (retryable && attempt < 5) { await sleep(Math.min(8000, 300 * 2 ** attempt) + Math.floor(Math.random() * 250)); continue; }
      results.failed.push({ summary: body.summary || '(no title)', reason: r.data?.error?.message || `HTTP ${r.status}` });
      return;
    }
  }

  for (let i = 0; i < uniqueEvents.length; i += CONCURRENCY) {
    await Promise.all(uniqueEvents.slice(i, i + CONCURRENCY).map(createOne));
  }

  const dropped = Math.max(0, requested - (results.created.length + results.skipped.length + results.failed.length + (uniqueEvents.length < events.length ? events.length - uniqueEvents.length : 0)));
  const lines = [`Batch create on '${calId}': ${results.created.length} created, ${results.skipped.length} already on calendar (skipped), ${results.failed.length} failed.`];
  if (results.created.length) lines.push('Created:\n' + results.created.map(c => `  ✓ ${c.summary}${c.id ? ` [${c.id}]` : ''}`).join('\n'));
  if (results.skipped.length) lines.push('Skipped (already existed):\n' + results.skipped.map(s => `  – ${s}`).join('\n'));
  if (results.failed.length)  lines.push('Failed:\n' + results.failed.map(f => `  ⚠ ${f.summary}: ${f.reason}`).join('\n'));
  if (dropped > 0) lines.push(`Note: ${dropped} input event(s) were malformed (missing summary/start/end) and not attempted.`);
  console.log(lines.join('\n'));
}

async function cmdUpdate(args) {
  const eventId = args[0];
  const json    = args.slice(1).join(' ');
  if (!eventId || !json) { console.error('Usage: gcal.mjs update <eventId> <json>'); process.exit(1); }
  let body;
  try { body = JSON.parse(json); } catch { console.error('Invalid JSON for event body'); process.exit(1); }
  const calId = body._calendarId || 'primary';
  delete body._calendarId;
  const e = await calFetch(`/calendars/${encodeURIComponent(calId)}/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
  console.log(`Event updated: ${e.id}`);
  console.log(fmtEvent(e));
}

async function cmdDelete(args) {
  const eventId = args[0];
  const calId   = args[1] || 'primary';
  if (!eventId) { console.error('Usage: gcal.mjs delete <eventId> [calendarId]'); process.exit(1); }
  await calFetch(`/calendars/${encodeURIComponent(calId)}/events/${eventId}`, { method: 'DELETE' });
  console.log(`Event ${eventId} deleted.`);
}

async function cmdQuickAdd(args) {
  const calId = args[args.length - 1]?.includes('@') || args[args.length - 1] === 'primary'
    ? args.pop() : 'primary';
  const text = args.join(' ');
  if (!text) { console.error('Usage: gcal.mjs quickadd <text> [calendarId]'); process.exit(1); }
  const e = await calFetch(`/calendars/${encodeURIComponent(calId)}/events/quickAdd?text=${encodeURIComponent(text)}`, {
    method: 'POST'
  });
  console.log(`Event created: ${e.id}`);
  console.log(fmtEvent(e));
}

async function cmdCalendars() {
  const data = await calFetch('/users/me/calendarList');
  for (const c of data.items || []) {
    console.log(`[${c.id}] ${c.summary}${c.primary ? ' (primary)' : ''} — ${c.accessRole}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'list':      await cmdList(rest); break;
    case 'get':       await cmdGet(rest); break;
    case 'create':    await cmdCreate(rest); break;
    case 'createbatch': await cmdCreateBatch(rest); break;
    case 'update':    await cmdUpdate(rest); break;
    case 'delete':    await cmdDelete(rest); break;
    case 'quickadd':  await cmdQuickAdd(rest); break;
    case 'calendars': await cmdCalendars(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: list, get, create, createbatch, update, delete, quickadd, calendars');
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
