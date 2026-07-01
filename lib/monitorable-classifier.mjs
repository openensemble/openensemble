// @ts-check
/**
 * Monitorable-intent classifier — embedding-based judge that fires when a
 * user message looks like a question about external state that changes
 * over time ("any new uploads from MrBeast?", "what's on sale at Publix?",
 * "is X back in stock?"). On a hit, chat.mjs injects a one-line system note
 * telling the LLM to ask the user — after answering — whether they'd like
 * the source monitored automatically. If they accept on the next turn,
 * the LLM picks the right tool (`proposeMonitor` for an existing skill,
 * `skill_create` for a brand-new one) and wires it up.
 *
 * Why embeddings vs. an LLM call: the cortex embedder is already loaded
 * for embed-router; classifying one user message costs ~5-10ms vs. a
 * full LLM round-trip. The seed phrasings below are intentionally short
 * and varied — the goal is to recognize the *shape* of a monitorable
 * query, not enumerate every possible source.
 *
 * The classifier itself is stateless. Callers can use recordMonitorableHit
 * to apply a per-user cooldown/evidence ledger so OE does not nag on every
 * matching turn and repeated monitorable questions can graduate into a
 * proposal bubble.
 */

import fs from 'fs';
import path from 'path';
import { log } from '../logger.mjs';
import { USERS_DIR } from './paths.mjs';
import { extractMonitorableSource } from './monitorable-source.mjs';

// Canonical phrasings of "monitor this external state for me" intent.
// Mix sources (channel, store, person, feed, price, stock, account) and
// question forms (any new …, is there a …, did … happen, what's the latest …).
const MONITORABLE_SEEDS = [
  'any new uploads from this channel',
  'are there new videos on that youtube channel',
  'did mrbeast post a new video',
  'what is on sale at publix this week',
  "what's on sale at the grocery store",
  'are there new bogos at publix',
  'check the weekly ad at kroger',
  'any new posts on this blog',
  'is there a new episode of the podcast',
  'did that author release a new book',
  'is there a new release from this artist',
  "what's the latest from this newsletter",
  'is the item back in stock',
  'is this product available now',
  'what is the current price of bitcoin',
  'has the price dropped on the item',
  'any new emails from my boss',
  'did i get a new message from amazon',
  'is there a new comment on my post',
  'did the github repo have new commits today',
  'has the build status changed',
  'any new listings on zillow in my area',
  'are there new jobs posted matching my profile',
  'what is the weather forecast tomorrow morning',
  'did the score change in the game',
];

// Anti-examples — short imperatives / one-shot queries / fast-path verbs we
// don't want to false-positive on. Used as a negative pool: classify against
// the closest-match seed only if the closest *anti*-example is farther.
const ANTI_SEEDS = [
  'play music',
  'pause the music',
  'turn on the lights',
  'set a timer for 5 minutes',
  'what time is it',
  'send an email to john',
  'delete this email',
  'reply to that message',
  'summarize this article',
  'translate this sentence',
  'how do you spell mississippi',
  'tell me a joke',
  'open the kitchen lights',
  'add eggs to my shopping list',
  'create a new task',
  'cancel my reminder',
  // In-flight-work / delegation status checks. These look superficially like
  // "did the status change?" but the user is asking about a task THEY just
  // handed off, not an external source to monitor over time. Setting up a
  // recurring watch for "is gina still working on it?" is nonsense.
  'is the agent still working on it',
  'are you still working on that',
  'is gina still working on it',
  'is it done yet',
  'are you finished yet',
  'did the task finish',
  'is the background task still running',
  "what's the status of my task",
  'how long until it is done',
];

const SCORE_THRESHOLD = 0.46;          // tuned for built-in nomic-embed
const ANTI_MARGIN     = 0.03;          // monitorable hit must beat the best anti by this much
const OFFER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PROPOSAL_AFTER_HITS = 2;
const MAX_OFFER_TOPICS = 200;                         // cap the per-user ledger so it can't grow without bound
const OFFER_TOPIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // age out topics not seen in 30d (live proposals are kept)

let _seedVecs = null;       // [{text, vec}]
let _antiVecs = null;
let _initInflight = null;

async function ensureSeeds() {
  if (_seedVecs && _antiVecs) return;
  if (_initInflight) { await _initInflight; return; }
  _initInflight = (async () => {
    try {
      const { embed } = await import('../memory/embedding.mjs');
      const [seeds, antis] = await Promise.all([
        Promise.all(MONITORABLE_SEEDS.map(async t => ({ text: t, vec: await embed(t) }))),
        Promise.all(ANTI_SEEDS.map(async t => ({ text: t, vec: await embed(t) }))),
      ]);
      _seedVecs = seeds.filter(s => s.vec?.length);
      _antiVecs = antis.filter(s => s.vec?.length);
      log.info('monitorable-classifier', 'seeds embedded', { seeds: _seedVecs.length, antis: _antiVecs.length });
    } catch (e) {
      log.warn('monitorable-classifier', 'seed embed failed', { err: e.message });
      _seedVecs = [];
      _antiVecs = [];
    } finally {
      _initInflight = null;
    }
  })();
  await _initInflight;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

function bestMatch(vec, pool) {
  let best = { score: -Infinity, text: null };
  for (const s of pool) {
    const score = cosine(vec, s.vec);
    if (score > best.score) best = { score, text: s.text };
  }
  return best;
}

function offersPath(userId) {
  return path.join(USERS_DIR, userId, 'monitorable-offers.json');
}

function readOffers(userId) {
  try {
    const data = JSON.parse(fs.readFileSync(offersPath(userId), 'utf8'));
    return data && typeof data === 'object' ? data : { topics: {} };
  } catch {
    return { topics: {} };
  }
}

function pruneTopics(data) {
  const topics = data?.topics;
  if (!topics || typeof topics !== 'object') return;
  const now = Date.now();
  let entries = Object.entries(topics);
  // Drop topics not seen within the TTL, but keep any with a live proposal —
  // those are still actively suppressing re-asks.
  entries = entries.filter(([, r]) => r?.proposalId || (now - Number(r?.lastSeenAt || 0)) < OFFER_TOPIC_TTL_MS);
  // Cap to the most-recently-seen topics so the file stays bounded.
  if (entries.length > MAX_OFFER_TOPICS) {
    entries.sort((a, b) => Number(b[1]?.lastSeenAt || 0) - Number(a[1]?.lastSeenAt || 0));
    entries = entries.slice(0, MAX_OFFER_TOPICS);
  }
  data.topics = Object.fromEntries(entries);
}

let _offerWriteSeq = 0;
function writeOffers(userId, data) {
  pruneTopics(data);
  const p = offersPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write via temp-file + rename: a torn read of a half-written file
  // would otherwise parse-fail and silently reset the whole ledger
  // (un-suppressing every offer). Readers see either the old or new file. The
  // temp name is unique per write (pid + a monotonic seq) so two concurrent
  // writers in this process don't clobber each other's temp before rename.
  const tmp = `${p}.tmp-${process.pid}-${++_offerWriteSeq}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * @param {string} userText
 * @returns {Promise<{monitorable: boolean, score: number, matched: string|null, antiScore?: number, antiMatched?: string|null}>}
 */
export async function classifyMonitorable(userText) {
  if (typeof userText !== 'string' || userText.trim().length < 4) {
    return { monitorable: false, score: 0, matched: null };
  }
  await ensureSeeds();
  if (!_seedVecs?.length) return { monitorable: false, score: 0, matched: null };

  let vec;
  try {
    const { embed } = await import('../memory/embedding.mjs');
    vec = await embed(userText);
  } catch (e) {
    log.warn('monitorable-classifier', 'embed user text failed', { err: e.message });
    return { monitorable: false, score: 0, matched: null };
  }

  const pos = bestMatch(vec, _seedVecs);
  const neg = bestMatch(vec, _antiVecs);

  const monitorable = pos.score >= SCORE_THRESHOLD && (pos.score - neg.score) >= ANTI_MARGIN;
  return {
    monitorable,
    score: pos.score,
    matched: pos.text,
    antiScore: neg.score,
    antiMatched: neg.text,
  };
}

/**
 * The system-prompt addition injected when the classifier hits. Kept here
 * (not in chat.mjs) so the wording lives next to the classifier — easier
 * to tune as a unit.
 *
 * @param {{matched: string|null}} hit
 */
export function buildMonitorableSystemNote(hit) {
  const example = hit?.matched ? ` (e.g. similar to: "${hit.matched}")` : '';
  return `\n\n## Monitorable intent detected\nThe user's question looks like they're asking about an external source that changes over time${example}. AFTER you answer their actual question, add ONE short follow-up sentence offering to set up automatic monitoring — phrase it naturally for the medium (voice = spoken, chat = brief). Examples: "Want me to keep an eye on that and ping you when there's something new?" or "I can check this every week and let you know when it changes — should I?". If the user accepts on the next turn, use \`proposeMonitor\` if a relevant skill already exposes a watch tool, or call \`skill_create\` to build a new monitored skill that follows the four-piece pattern (fetcher, cadence, pref-aware filter, deliver='agent'). DO NOT auto-create the monitor without the user's explicit yes.`;
}

/**
 * Persist a monitorable hit and decide whether this turn should ask, suppress,
 * or emit a proposal. The proposal still requires explicit user acceptance.
 *
 * @param {{userId:string, agentId:string, userText:string, hit:any}} opts
 * @returns {Promise<{action:'ask'|'proposal'|'suppress', count:number, proposalId?:string|null, topicKey:string, reason?:string}>}
 */
export async function recordMonitorableHit({ userId, agentId, userText, hit }) {
  if (!userId || !agentId || !userText || !hit?.monitorable) {
    return { action: 'suppress', count: 0, topicKey: '' };
  }
  const source = extractMonitorableSource(userText);
  if (!source.ok) {
    return { action: 'suppress', count: 0, topicKey: '', reason: source.reason || 'no-source' };
  }
  const key = source.key;
  if (!key) return { action: 'suppress', count: 0, topicKey: '' };

  const data = readOffers(userId);
  if (!data.topics || typeof data.topics !== 'object') data.topics = {};
  const now = Date.now();
  const rec = data.topics[key] || { count: 0, firstSeenAt: now, lastSeenAt: 0, lastAskedAt: 0, proposalId: null };
  rec.count = Number(rec.count || 0) + 1;
  rec.lastSeenAt = now;
  rec.lastText = String(userText).slice(0, 500);
  rec.matched = hit.matched || rec.matched || null;
  rec.sourceLabel = source.label;
  rec.sourceKind = source.kind;
  data.topics[key] = rec;

  if (rec.proposalId) {
    writeOffers(userId, data);
    return { action: 'suppress', count: rec.count, proposalId: rec.proposalId, topicKey: key };
  }

  if (rec.count >= PROPOSAL_AFTER_HITS) {
    try {
      const { proposeMonitorableWatch } = await import('./proposals.mjs');
      const proposal = await proposeMonitorableWatch({
        userId,
        agentId,
        message: userText,
        matched: hit.matched,
        source,
        evidenceCount: rec.count,
      });
      if (proposal?.id) {
        rec.proposalId = proposal.id;
        writeOffers(userId, data);
        return { action: 'proposal', count: rec.count, proposalId: proposal.id, topicKey: key };
      }
    } catch (e) {
      log.warn('monitorable-classifier', 'proposal escalation failed', { err: e.message });
    }
  }

  const shouldAsk = !rec.lastAskedAt || now - rec.lastAskedAt > OFFER_COOLDOWN_MS;
  if (shouldAsk) rec.lastAskedAt = now;
  writeOffers(userId, data);
  return { action: shouldAsk ? 'ask' : 'suppress', count: rec.count, topicKey: key };
}
