// @ts-check
/**
 * Email-label learning store — Tier A of the local email organizer.
 *
 * Captures every (sender → label) decision applied via email_batch_label —
 * whether the cloud LLM did it on a "sort my emails" command or the user did it
 * by hand — so the local tier can eventually label known senders WITHOUT a cloud
 * call. The email analogue of lib/learned-intents.mjs: automatic capture now, a
 * lightweight promotion gate later.
 *
 * KEYING. A naive root-domain key collapses on free providers (every gmail.com
 * address would share one bucket), so we key on two levels and use the SUBJECT to
 * disambiguate:
 *   1. full sender ADDRESS  (scmurray1@gmail.com)  — always recorded.
 *   2. root DOMAIN          (homedepot.com)        — only for NON-free providers.
 *   3. SUBJECT tokens per label — break ties when a key maps to >1 label.
 *
 * TWO kinds of knowledge live per key:
 *   - observed `labels` — single-label majority counts from what was applied.
 *   - `pins` — explicit user CORRECTIONS. A pin is authoritative, can carry a
 *     SET of labels (e.g. ["Promotions","Travel"]), a keepInbox flag ("label it
 *     but leave it in the inbox"), and an optional subject condition.
 *
 * Storage: users/<userId>/email-label-memory.json. Gated by cfg.localTier.emailLabels.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { loadConfig } from '../routes/_helpers.mjs';

// Gmail-internal labels we never learn as a destination. INBOX is special: in a
// correction it means "keep in inbox" (a keepInbox flag), not a destination.
const SYSTEM_LABELS = new Set([
  'INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
  'YELLOW_STAR',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com',
  'zoho.com', 'fastmail.com', 'hey.com', 'yandex.com', 'qq.com', '163.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are',
  'your', 'you', 'my', 'me', 'we', 'our', 'it', 'its', 'this', 'that', 'with', 'from',
  'new', 'now', 'get', 'got', 'has', 'have', 're', 'fwd', 'fw', 'update', 'updates',
  'here', 'just', 'out', 'up', 'off', 'all', 'more', 'about', 'into',
]);

export const TRUST_THRESHOLD = 2;
const MAX_SUBJ_TOKENS = 40;

export function emailLabelsEnabled() {
  try { return loadConfig()?.localTier?.emailLabels === true; }
  catch { return false; }
}

function storePath(userId) { return path.join(USERS_DIR, userId, 'email-label-memory.json'); }

function migrateLegacy(store) {
  // v1 stored `senders` keyed on root domain only (incl. free providers — the
  // gmail.com blanket bug). Carry forward corporate-domain buckets; drop free ones.
  if (store.keys || !store.senders) return store;
  const keys = {};
  for (const [dom, r] of Object.entries(store.senders)) {
    if (FREE_PROVIDERS.has(dom)) continue;
    const labels = {};
    for (const [label, count] of Object.entries(r.labels || {})) labels[label] = { count, subj: {} };
    keys[dom] = { kind: 'domain', labels, pins: [], total: r.total || 0, top: r.top || null, lastSeen: r.lastSeen || null };
  }
  return { keys, applied: store.applied || 0, updatedAt: store.updatedAt || null, schema: 3 };
}

function loadStore(userId) {
  try {
    const p = storePath(userId);
    if (!existsSync(p)) return { keys: {}, applied: 0, updatedAt: null, schema: 3 };
    const s = migrateLegacy(JSON.parse(readFileSync(p, 'utf8')));
    s.keys = s.keys || {};
    return s;
  } catch { return { keys: {}, applied: 0, updatedAt: null, schema: 3 }; }
}

function saveStore(userId, store) {
  const p = storePath(userId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2));
}

export function senderAddress(fromHeader) {
  if (!fromHeader) return null;
  const m = String(fromHeader).match(/<([^>]+)>/) || String(fromHeader).match(/([^\s"]+@[^\s">]+)/);
  const email = (m ? m[1] : '').toLowerCase().trim().replace(/[.>]+$/, '');
  return email.includes('@') ? email : null;
}

export function senderDomain(fromHeader) {
  const email = senderAddress(fromHeader);
  if (!email) return null;
  const host = email.slice(email.lastIndexOf('@') + 1);
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host || null;
  return parts.slice(-2).join('.');
}

function keysFor(fromHeader) {
  const out = [];
  const addr = senderAddress(fromHeader);
  if (addr) out.push({ key: addr, kind: 'address' });
  const dom = senderDomain(fromHeader);
  if (dom && !FREE_PROVIDERS.has(dom)) out.push({ key: dom, kind: 'domain' });
  return out;
}

function tokenizeSubject(subject) {
  if (!subject) return [];
  const toks = String(subject).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ');
  const seen = new Set(); const out = [];
  for (const t of toks) {
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function recomputeTop(rec) {
  rec.total = Object.values(rec.labels).reduce((s, l) => s + l.count, 0);
  rec.top = Object.entries(rec.labels).sort((a, b) => b[1].count - a[1].count)[0]?.[0] ?? null;
}

/**
 * Record labelings just applied (observed counts; single label per item).
 * @param {string} userId
 * @param {Array<{from:string, subject?:string, label:string}>} items
 */
export function recordLabelings(userId, items) {
  if (!userId || !Array.isArray(items) || !items.length) return { recorded: 0, keys: 0 };
  const store = loadStore(userId);
  let recorded = 0;
  for (const it of items) {
    const label = (it.label || '').trim();
    if (!label || SYSTEM_LABELS.has(label.toUpperCase())) continue;
    const targets = keysFor(it.from);
    if (!targets.length) continue;
    const subjToks = tokenizeSubject(it.subject);
    for (const { key, kind } of targets) {
      const rec = store.keys[key] || { kind, labels: {}, pins: [], total: 0, top: null, lastSeen: null };
      const li = rec.labels[label] || { count: 0, subj: {} };
      li.count += 1;
      for (const t of subjToks) {
        if (Object.keys(li.subj).length >= MAX_SUBJ_TOKENS && !(t in li.subj)) continue;
        li.subj[t] = (li.subj[t] || 0) + 1;
      }
      rec.labels[label] = li;
      rec.pins = rec.pins || [];
      rec.lastSeen = new Date().toISOString();
      recomputeTop(rec);
      store.keys[key] = rec;
    }
    recorded++;
  }
  if (recorded) {
    store.applied = (store.applied || 0) + recorded;
    store.updatedAt = new Date().toISOString();
    saveStore(userId, store);
  }
  return { recorded, keys: Object.keys(store.keys).length };
}

/**
 * Record an explicit user CORRECTION — authoritative, multi-label, optional
 * keep-inbox and subject condition. "Mail from X (about Y) should be labeled
 * A and B (and stay in the inbox)."
 * @param {string} userId
 * @param {{sender:string, labels:string[], keepInbox?:boolean, subjectContains?:string[]}} c
 */
export function recordCorrection(userId, c) {
  const sender = (c?.sender || '').trim();
  let labels = Array.isArray(c?.labels) ? c.labels.slice() : (c?.labels ? [c.labels] : []);
  labels = labels.map(l => String(l || '').trim()).filter(Boolean);
  if (!userId || !sender || !labels.length) return { ok: false, error: 'sender and at least one label are required' };

  // "Inbox" in the label set means keep-in-inbox, not a destination label.
  let keepInbox = c?.keepInbox === true;
  const dest = [];
  for (const l of labels) {
    if (l.toUpperCase() === 'INBOX' || l.toLowerCase() === 'inbox') { keepInbox = true; continue; }
    if (SYSTEM_LABELS.has(l.toUpperCase())) continue; // ignore other system labels
    dest.push(l);
  }
  if (!dest.length) return { ok: false, error: 'need at least one real (non-system) label' };

  let key, kind;
  if (sender.includes('@')) { key = senderAddress(`<${sender}>`) || sender.toLowerCase(); kind = 'address'; }
  else { key = sender.toLowerCase().replace(/^@/, ''); kind = 'domain'; }

  const store = loadStore(userId);
  const rec = store.keys[key] || { kind, labels: {}, pins: [], total: 0, top: null, lastSeen: null };
  rec.pins = rec.pins || [];
  const subjReq = (c.subjectContains || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  const cond = subjReq.length ? Array.from(new Set(subjReq)) : null;
  const pin = { labels: dest, keepInbox, subjRequired: cond, ts: new Date().toISOString() };
  // Replace an existing pin with the same subject-condition signature.
  rec.pins = rec.pins.filter(p => JSON.stringify(p.subjRequired || null) !== JSON.stringify(cond));
  rec.pins.push(pin);
  rec.lastSeen = new Date().toISOString();
  store.keys[key] = rec;
  store.corrections = (store.corrections || 0) + 1;
  store.updatedAt = new Date().toISOString();
  saveStore(userId, store);
  return { ok: true, key, kind, labels: dest, keepInbox, conditional: cond };
}

// The first pin whose subject condition is satisfied (unconditional pins match
// any subject).
function applicablePin(rec, subjToks) {
  for (const pin of rec.pins || []) {
    if (!pin.subjRequired || !pin.subjRequired.length || pin.subjRequired.some(k => subjToks.includes(k))) return pin;
  }
  return null;
}

// Best single observed label for a key, subject overlap breaking ties.
function pickObserved(rec, subjToks) {
  const entries = Object.entries(rec.labels);
  if (!entries.length) return null;
  if (entries.length === 1) { const [label, info] = entries[0]; return { label, count: info.count, via: 'sender' }; }
  let best = null;
  for (const [label, info] of entries) {
    const overlap = subjToks.reduce((s, t) => s + (info.subj?.[t] || 0), 0);
    const score = overlap * 100 + info.count;
    if (!best || score > best.score) best = { label, count: info.count, score, overlap };
  }
  return { label: best.label, count: best.count, via: best.overlap > 0 ? 'sender+subject' : 'sender' };
}

/**
 * Suggest a label SET for an email from learned history (Tier A).
 * Precedence: address pin → domain pin → trusted observed (address→domain) →
 * untrusted observed. Pins carry multiple labels + keepInbox.
 * @returns {{labels:string[], keepInbox:boolean, trusted:boolean, confidence:number, source:string, count?:number, total?:number}|null}
 */
export function suggestLabels(userId, fromHeader, subject) {
  const store = loadStore(userId);
  const addr = senderAddress(fromHeader);
  const dom = senderDomain(fromHeader);
  const subjToks = tokenizeSubject(subject);
  const cands = [];
  for (const [key, kind] of [[addr, 'address'], [(dom && !FREE_PROVIDERS.has(dom)) ? dom : null, 'domain']]) {
    if (!key) continue;
    const rec = store.keys?.[key];
    if (!rec) continue;
    const pin = applicablePin(rec, subjToks);
    if (pin) {
      cands.push({ rank: kind === 'address' ? 0 : 1, labels: pin.labels, keepInbox: !!pin.keepInbox, trusted: true, confidence: 1, source: `${kind}:pinned` });
    }
    const obs = pickObserved(rec, subjToks);
    if (obs) {
      const confidence = rec.total ? obs.count / rec.total : 0;
      const trusted = obs.count >= TRUST_THRESHOLD && confidence >= 0.6;
      cands.push({ rank: (kind === 'address' ? 2 : 3) + (trusted ? 0 : 10), labels: [obs.label], keepInbox: false, trusted, confidence, count: obs.count, total: rec.total, source: `${kind}:${obs.via}` });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.rank - b.rank);
  return cands[0];
}

// Back-compat single-label helper.
export function suggestLabel(userId, fromHeader, subject) {
  const s = suggestLabels(userId, fromHeader, subject);
  return s ? { label: s.labels[0], confidence: s.confidence, trusted: s.trusted, source: s.source, count: s.count, total: s.total } : null;
}

/** Human-readable summary of what's been learned. */
export function summary(userId, { limit = 100 } = {}) {
  const store = loadStore(userId);
  const keys = store.keys || {};
  const mappings = Object.entries(keys)
    .map(([key, r]) => {
      const top = r.top;
      const info = r.labels[top] || {};
      const count = info.count ?? 0;
      const pins = (r.pins || []).map(p => ({ labels: p.labels, keepInbox: !!p.keepInbox, conditional: p.subjRequired || null }));
      return {
        key, kind: r.kind,
        label: top, count, total: r.total,
        multi: Object.keys(r.labels).length > 1,
        pins,
        trusted: pins.length > 0 || count >= TRUST_THRESHOLD,
      };
    })
    .sort((a, b) => (b.pins.length - a.pins.length) || (b.total - a.total))
    .slice(0, limit);
  return {
    totalApplied: store.applied || 0,
    corrections: store.corrections || 0,
    distinctKeys: Object.keys(keys).length,
    trusted: mappings.filter(m => m.trusted).length,
    mappings,
  };
}
