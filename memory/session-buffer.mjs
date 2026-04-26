/**
 * Session buffer — per-agent in-memory conversation buffer.
 *
 * User messages are triaged (trivial greetings skipped) and written to the
 * episodes table. Idle buffers (>30min inactive) get LLM-summarized into a
 * single elevated-stability episode and cleared.
 */

import {
  assertId, queuedWrite, generateCombined,
} from './shared.mjs';
import {
  getTable, rememberFast, queueEnrich,
} from './lance.mjs';

// ── In-memory state ──────────────────────────────────────────────────────────
const _sessionBuffers = {};
const _sessionLastActivity = {}; // bufKey → { ts: timestamp ms, userId, agentId }
const _sessionSummarized = new Set(); // bufKeys already summarized this idle cycle

const IDLE_THRESHOLD_MS = 30 * 60_000; // 30 minutes
const SUMMARY_CHECK_INTERVAL_MS = 5 * 60_000; // check every 5 minutes

// Cortex summary head was trained on bare `<conv>` per training/train.py
// format_record('summary'). Empty instruction → generateCombined sends just
// the conversation, matching the trained format.

async function summarizeIdleSessions() {
  const now = Date.now();
  for (const [bufKey, meta] of Object.entries(_sessionLastActivity)) {
    if (now - meta.ts < IDLE_THRESHOLD_MS) continue;
    if (_sessionSummarized.has(bufKey)) continue;
    const buf = _sessionBuffers[bufKey];
    if (!buf || buf.length < 4) { _sessionSummarized.add(bufKey); continue; } // need meaningful exchange

    const { userId, agentId } = meta;

    // Build conversation text from buffer
    const convText = buf
      .map(m => `${m.role}: ${m.text.slice(0, 300)}`)
      .join('\n')
      .slice(0, 2000);

    _sessionSummarized.add(bufKey);

    // Generate summary via local LLM (non-blocking)
    generateCombined('', convText, { caller: 'summary', userId, agentId }).then(async summary => {
      if (!summary || summary.length < 20) return;
      const record = await rememberFast({
        agentId, type: 'episodes', text: `[Session summary] ${summary}`,
        source: 'summary', confidence: 1.0,
        metadata: { session_id: new Date(meta.ts).toISOString().slice(0, 10), is_summary: true },
        userId,
      }).catch(() => null);
      if (record) {
        // Give summaries elevated stability (slower decay) — they represent digested knowledge
        const tableName = `${agentId}_episodes`;
        queuedWrite(tableName, async () => {
          const table = await getTable(tableName, userId);
          await table.update({
            where: `id = '${assertId(record.id)}'`,
            values: { stability: 360, salience_composite: 0.75 },
          }).catch(e => console.debug('[cortex] Summary stability update error:', e.message));
        });
      }
      // Clear the buffer after summarizing
      _sessionBuffers[bufKey] = [];
      console.log(`[cortex] Summarized idle session for ${agentId} (${userId})`);
    }).catch(e => console.debug('[cortex] Session summary failed:', e.message));
  }
}

// Start the idle session checker
setInterval(summarizeIdleSessions, SUMMARY_CHECK_INTERVAL_MS).unref?.();

// ── Daily episode dedup cache ────────────────────────────────────────────────
// Prevents the same query from being stored multiple times in one day.
const _dailyEpisodeCache = new Map();

function normalizeForDedup(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function alreadyStoredToday(userId, agentId, text) {
  const key = `${userId}_${agentId}`;
  const today = new Date().toISOString().slice(0, 10);
  const entry = _dailyEpisodeCache.get(key);
  if (!entry || entry.date !== today) return false;
  return entry.texts.has(normalizeForDedup(text));
}

function markStoredToday(userId, agentId, text) {
  const key = `${userId}_${agentId}`;
  const today = new Date().toISOString().slice(0, 10);
  const entry = _dailyEpisodeCache.get(key);
  if (!entry || entry.date !== today) {
    _dailyEpisodeCache.set(key, { date: today, texts: new Set([normalizeForDedup(text)]) });
  } else {
    entry.texts.add(normalizeForDedup(text));
  }
}

function cleanTextForMemory(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')  // strip <think> blocks
    .replace(/<\|.*?\|>/g, '')                   // strip special tokens
    .replace(/^\s*(<\/think>|<think>)\s*/gim, '') // stray tags
    .trim();
}

// Patterns that indicate a message isn't worth storing as an episode:
// - Meta/recall responses ("yes here's what I recall", "Got it! I've noted...")
// - Agent action confirmations, scheduling echoes
const SKIP_EPISODE_RE = /^(got it[!,]?\s*(i('ve)?|i have)|yes[!,]?\s*here('s| is)|i('ve)? noted|i('ve)? made a note|i('ve)? stored|based on (our|your|this) conv|i apologize|i don't have the ability|unfortunately,? i|one-time task .{1,60} scheduled|daily task .{1,60} scheduled)|(delete|trash|move|archive|label|mark|flag|unsubscribe|reply to|forward|send)(\s+\d+|\s+all|\s+these|\s+the|\s+those|\s+my)?\s+(email|message|mail|thread|inbox)|\b(email|message|mail)s?\s+from\s+\S+/i;

// ── Episode triage — lightweight heuristic to skip trivial messages ──────────
const TRIVIAL_RE = /^(what('s| is) the (time|date|weather)|how('s| is) (it going|the weather)|hey|hi|hello|sup|yo|good (morning|afternoon|evening)|thanks|thank you|ok|okay|cool|nice|lol|haha|hmm|ah|oh|wow|brb|gtg|bye|see ya|later|nvm|never ?mind)[\s?!.]*$/i;
const SUBSTANCE_RE = /\b(i('m| am)|my (name|job|wife|husband|partner|kid|child|dog|cat|birthday|address|company|team|project|goal|plan)|i (like|prefer|hate|love|want|need|started|quit|moved|live|work|decided|think|believe|feel)|we (should|decided|agreed|plan|need|will)|because|important|remember|don't forget|fyi|update|changed|new|deadline|meeting|launch|release|budget|schedule|goal|strategy)\b/i;

function triageEpisode(text) {
  if (TRIVIAL_RE.test(text)) return 'skip';
  if (SUBSTANCE_RE.test(text)) return 'store';
  if (text.length > 60) return 'store';
  if (text.length < 20) return 'skip';
  return 'store'; // default: store when uncertain
}

export function addToSessionBuffer(agentId, role, text, userId = 'default') {
  const clean = cleanTextForMemory(text);
  if (!clean || clean.length < 8) return;

  const bufKey = `${userId}_${agentId}`;
  if (!_sessionBuffers[bufKey]) _sessionBuffers[bufKey] = [];
  const ts = new Date().toISOString();
  _sessionBuffers[bufKey].push({ role, text: clean, timestamp: ts });
  _sessionLastActivity[bufKey] = { ts: Date.now(), userId, agentId };
  _sessionSummarized.delete(bufKey); // reset idle flag on new activity

  // Only store user messages as episodes — they capture intent/topic naturally.
  // Assistant responses are too verbose and don't aid recall ("what did we discuss?").
  if (role !== 'user') {
    if (_sessionBuffers[bufKey].length > 12) _sessionBuffers[bufKey] = _sessionBuffers[bufKey].slice(-4);
    return;
  }

  // Skip messages that are noise even from the user side
  if (SKIP_EPISODE_RE.test(clean)) {
    if (_sessionBuffers[bufKey].length > 12) _sessionBuffers[bufKey] = _sessionBuffers[bufKey].slice(-4);
    return;
  }

  // Heuristic triage — skip trivial/phatic messages that don't carry useful information
  if (triageEpisode(clean) === 'skip') {
    if (_sessionBuffers[bufKey].length > 12) _sessionBuffers[bufKey] = _sessionBuffers[bufKey].slice(-4);
    return;
  }

  // Skip if this exact query was already stored today (prevents spam from repeated queries)
  if (alreadyStoredToday(userId, agentId, clean)) return;
  markStoredToday(userId, agentId, clean);

  // Write to LanceDB in background — non-blocking
  rememberFast({
    agentId, type: 'episodes', text: clean, source: 'session', confidence: 1.0,
    metadata: { role, session_id: ts.slice(0, 10) }, userId,
  }).then(record => {
    queueEnrich(record, `${agentId}_episodes`, userId);
  }).catch(e => console.warn('[cortex] Episode write failed:', e.message));

  if (_sessionBuffers[bufKey].length > 12) {
    _sessionBuffers[bufKey] = _sessionBuffers[bufKey].slice(-4);
  }
}
