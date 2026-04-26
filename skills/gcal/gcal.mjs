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
    case 'update':    await cmdUpdate(rest); break;
    case 'delete':    await cmdDelete(rest); break;
    case 'quickadd':  await cmdQuickAdd(rest); break;
    case 'calendars': await cmdCalendars(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: list, get, create, update, delete, quickadd, calendars');
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
