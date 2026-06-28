import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(SKILL_DIR, '../..');
const GCAL_CLI = path.join(SKILL_DIR, 'gcal.mjs');


function buildCmdArgs(name, args) {
  switch (name) {
    case 'gcal_list': {
      const calId  = args.calendarId || 'primary';
      const max    = args.maxResults || 10;
      const tMin   = args.timeMin || new Date().toISOString();
      const tMax   = args.timeMax || '';
      return tMax
        ? ['list', calId, String(max), tMin, tMax]
        : ['list', calId, String(max), tMin];
    }
    case 'gcal_get':
      return args.eventId
        ? ['get', args.eventId, ...(args.calendarId ? [args.calendarId] : [])]
        : null;
    case 'gcal_create': {
      const body = buildEventBody(args);
      if (args.calendarId) body._calendarId = args.calendarId;
      return ['create', JSON.stringify(body)];
    }
    case 'gcal_create_batch': {
      const events = Array.isArray(args.events) ? args.events : [];
      // Build each Google event body up front; drop malformed ones (the CLI
      // reports the dropped count via `requested`). One CLI invocation creates
      // them all, with server-side throttle/retry/dedupe. Always route to the
      // CLI (even with 0 valid bodies) so the tool returns a clear "no valid
      // events" message rather than masquerading as an unknown tool.
      const bodies = events.map(buildEventBodySafe).filter(Boolean);
      const out = {
        calendarId: args.calendarId || 'primary',
        skipExisting: args.skipExisting !== false,   // default true
        requested: events.length,
        events: bodies,
      };
      return ['createbatch', JSON.stringify(out)];
    }
    case 'gcal_update': {
      if (!args.eventId) return null;
      const patch = buildEventPatch(args);
      if (args.calendarId) patch._calendarId = args.calendarId;
      return ['update', args.eventId, JSON.stringify(patch)];
    }
    case 'gcal_delete':
      return args.eventId
        ? ['delete', args.eventId, ...(args.calendarId ? [args.calendarId] : [])]
        : null;
    case 'gcal_quick_add': {
      if (!args.text) return null;
      const parts = ['quickadd', args.text];
      if (args.calendarId) parts.push(args.calendarId);
      return parts;
    }
    case 'gcal_list_calendars':
      return ['calendars'];
    default:
      return null;
  }
}

function buildEventBody(args) {
  const isAllDay = args.allDay || (!args.start?.includes('T'));
  const body = { summary: args.summary };
  if (isAllDay) {
    body.start = { date: args.start.slice(0, 10) };
    body.end   = { date: args.end.slice(0, 10) };
  } else {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    body.start = { dateTime: args.start, timeZone: tz };
    body.end   = { dateTime: args.end,   timeZone: tz };
  }
  if (args.description) body.description = args.description;
  if (args.location)    body.location    = args.location;
  if (args.attendees?.length) {
    body.attendees = args.attendees.map(email => ({ email }));
  }
  return body;
}

// Guarded body builder for the batch path: a malformed event (missing
// summary/start/end) returns null instead of throwing, so one bad item can't
// sink the whole batch. Used by gcal_create_batch.
function buildEventBodySafe(ev) {
  if (!ev || !ev.summary || !ev.start || !ev.end) return null;
  try { return buildEventBody(ev); } catch { return null; }
}

function buildEventPatch(args) {
  const patch = {};
  if (args.summary)     patch.summary     = args.summary;
  if (args.description) patch.description = args.description;
  if (args.location)    patch.location    = args.location;
  if (args.start) {
    const isAllDay = !args.start.includes('T');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    patch.start = isAllDay ? { date: args.start.slice(0, 10) } : { dateTime: args.start, timeZone: tz };
  }
  if (args.end) {
    const isAllDay = !args.end.includes('T');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    patch.end = isAllDay ? { date: args.end.slice(0, 10) } : { dateTime: args.end, timeZone: tz };
  }
  return patch;
}

export async function onEnable(userId) {
  const tokenPath = userId
    ? path.join(BASE_DIR, 'users', userId, 'gcal-token.json')
    : path.join(BASE_DIR, 'gcal-token.json');
  if (existsSync(tokenPath)) return; // already authorized
  const authScript = path.join(SKILL_DIR, 'gcal-auth.mjs');
  spawn('node', [authScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  }).unref();
}

export default async function execute(name, args, userId) {
  const cmdArgs = buildCmdArgs(name, args);
  if (!cmdArgs) return `Unknown or invalid gcal tool: ${name}`;
  return new Promise((resolve) => {
    const proc = spawn('node', [GCAL_CLI, ...cmdArgs], { env: { ...process.env, OE_USER_ID: userId } });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', () => resolve((out || err || 'done').trim()));
    proc.on('error', e => resolve(`Error running gcal CLI: ${e.message}`));
  });
}
