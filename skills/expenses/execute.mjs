/**
 * Expense tracking skill executor.
 * Handles all expense_* tool calls.
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { withLock, isPrivileged, getExpBooksForUser, loadExpBooks, modifyExpBooks } from '../../routes/_helpers.mjs';

import { fileURLToPath } from 'url';

const BASE_DIR     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_PATH      = path.join(BASE_DIR, 'expenses/transactions.json');
const UPLOADS_DIR  = path.join(BASE_DIR, 'expenses/uploads');

// ── AI extraction ─────────────────────────────────────────────────────────────
export const EXPENSE_SYSTEM_MSG = `You are an expense extraction engine. Extract purchases and charges from the provided document and return ONLY a valid JSON array. No reasoning, no explanation, no markdown — output the raw JSON array and nothing else.

IMPORTANT: Skip any payments, credits, refunds, or balance payments (these appear as negative amounts like -$500.00, or are labeled "payment", "auto-pay", "credit", "refund"). Only include actual purchases and charges.

Each item must have:
- date: "YYYY-MM-DD"
- amount: number (positive USD, charges only)
- merchant: string
- description: string
- category: one of [Food & Dining, Transportation, Shopping, Utilities, Entertainment, Healthcare, Housing, Travel, Subscriptions, Education, Business, Taxes & Fees, Transfers, Other]
- subcategory: string

Return [] if no transactions found. Output ONLY the JSON array.`;

/**
 * Extract transactions from a document using the configured vision provider.
 * @param {object} cfg  - Loaded config object
 * @param {object} opts
 * @param {boolean} opts.isImage       - true if the file is an image
 * @param {string}  opts.mimeType      - MIME type string
 * @param {string|null} opts.base64    - Base64-encoded file data (for images)
 * @param {string}  opts.extractedText - Plain text extracted from the file (for PDFs/CSVs)
 * @returns {Promise<object[]>} Raw extracted transaction objects (unfiltered)
 */
export async function extractTransactions(cfg, { isImage, mimeType, base64, extractedText }) {
  const visionProvider = cfg.visionProvider ?? (cfg.anthropicApiKey ? 'anthropic' : 'ollama');
  const visionModel    = cfg.visionModel    ?? (visionProvider === 'anthropic' ? 'claude-sonnet-4-6' : visionProvider === 'lmstudio' ? 'local-model' : 'llava:latest');
  const ollamaUrl      = cfg.cortex?.ollamaUrl   ?? 'http://localhost:11434';
  const lmstudioUrl    = cfg.cortex?.lmstudioUrl ?? 'http://127.0.0.1:1234';
  let rawJson = '[]';

  if (visionProvider === 'anthropic') {
    const apiKey = cfg.anthropicApiKey;
    if (!apiKey) throw new Error('Anthropic API key not configured');
    const userContent = isImage && base64
      ? [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }, { type: 'text', text: 'Extract all transactions from this receipt/invoice/statement.' }]
      : `Extract all transactions from this document:\n\n${extractedText}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: visionModel, max_tokens: 4096, system: EXPENSE_SYSTEM_MSG, messages: [{ role: 'user', content: userContent }] }),
    });
    if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${await r.text()}`);
    rawJson = (await r.json()).content?.[0]?.text ?? '[]';

  } else if (visionProvider === 'ollama') {
    const userMsg = isImage && base64
      ? { role: 'user', content: 'Extract all transactions from this receipt/invoice/statement. ' + EXPENSE_SYSTEM_MSG, images: [base64] }
      : { role: 'user', content: `Extract all transactions from this document:\n\n${extractedText}\n\n${EXPENSE_SYSTEM_MSG}` };
    const r = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: visionModel, stream: false, messages: [userMsg] }),
    });
    if (!r.ok) throw new Error(`Ollama error ${r.status}`);
    rawJson = (await r.json()).message?.content ?? '[]';

  } else if (visionProvider === 'lmstudio') {
    const userContent = isImage && base64
      ? [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }, { type: 'text', text: 'Extract all transactions from this receipt/invoice/statement. ' + EXPENSE_SYSTEM_MSG }]
      : `Extract all transactions from this document:\n\n${extractedText}\n\n${EXPENSE_SYSTEM_MSG}`;
    const r = await fetch(`${lmstudioUrl}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: visionModel, max_tokens: 4096, messages: [{ role: 'system', content: EXPENSE_SYSTEM_MSG }, { role: 'user', content: userContent }] }),
    });
    if (!r.ok) throw new Error(`LM Studio error ${r.status}`);
    rawJson = (await r.json()).choices?.[0]?.message?.content ?? '[]';

  } else {
    throw new Error(`Unknown visionProvider: ${visionProvider}`);
  }

  rawJson = rawJson.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  rawJson = rawJson.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
  let extracted = [];
  try {
    const m = rawJson.match(/\[\s*\{[\s\S]*\}\s*\]/);
    extracted = JSON.parse(m ? m[0] : '[]');
    if (!Array.isArray(extracted)) extracted = [];
  } catch {
    try { extracted = JSON.parse(rawJson.match(/\[[\s\S]*\]/)?.[0] ?? '[]'); } catch (e2) { console.warn('[expenses] JSON extraction fallback failed:', e2.message); }
  }
  // Validate required fields and normalize values
  return extracted.filter(t => {
    if (!t.merchant && !t.description) return false;
    const amt = parseFloat(t.amount);
    if (!amt || amt <= 0 || !isFinite(amt)) return false;
    // Validate date format (YYYY-MM-DD); default to today if missing/invalid
    if (!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || isNaN(Date.parse(t.date))) {
      t.date = new Date().toISOString().slice(0, 10);
    }
    t.amount = amt;
    t.merchant = t.merchant || t.description || 'Unknown';
    t.category = t.category || 'Other';
    return true;
  });
}

// ── Categories ────────────────────────────────────────────────────────────────
export const CATEGORIES = {
  'Food & Dining':    ['Restaurants', 'Groceries', 'Coffee & Drinks', 'Fast Food', 'Delivery'],
  'Transportation':   ['Gas', 'Parking', 'Rideshare', 'Public Transit', 'Car Maintenance'],
  'Shopping':         ['Clothing', 'Electronics', 'Home & Garden', 'Amazon', 'General'],
  'Utilities':        ['Electric', 'Water', 'Gas/Heating', 'Internet', 'Phone'],
  'Entertainment':    ['Streaming', 'Movies', 'Games', 'Events', 'Hobbies'],
  'Healthcare':       ['Doctor', 'Pharmacy', 'Dental', 'Vision', 'Insurance'],
  'Housing':          ['Rent', 'Mortgage', 'Repairs', 'HOA', 'Supplies'],
  'Travel':           ['Flights', 'Hotels', 'Car Rental', 'Vacation'],
  'Subscriptions':    ['Software', 'Memberships', 'News', 'Fitness'],
  'Education':        ['Tuition', 'Books', 'Courses', 'Supplies'],
  'Business':         ['Office Supplies', 'Software', 'Advertising', 'Services'],
  'Taxes & Fees':     ['Federal Tax', 'State Tax', 'Bank Fees', 'Late Fees'],
  'Transfers':        ['Bank Transfer', 'Payment', 'Refund'],
  'Other':            ['Miscellaneous'],
};

// ── Storage helpers ───────────────────────────────────────────────────────────
function loadTransactions() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { console.warn('[expenses] Failed to load transactions DB:', e.message); }
  return [];
}

function saveTransactions(list) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2));
}

const modifyTransactions = fn => withLock(DB_PATH, () => {
  const data = loadTransactions();
  const result = fn(data);
  saveTransactions(data);
  return result;
});

function newId() {
  return 'txn_' + randomBytes(6).toString('hex');
}

// ── Tools ─────────────────────────────────────────────────────────────────────
function resolvePeriodDates(period) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const y     = now.getFullYear();
  const m     = String(now.getMonth() + 1).padStart(2, '0');
  if (period === 'this_month') return { dateFrom: `${y}-${m}-01`, dateTo: today };
  if (period === 'last_month') {
    const d = new Date(y, now.getMonth() - 1, 1);
    const ly = d.getFullYear(), lm = String(d.getMonth() + 1).padStart(2, '0');
    const last = new Date(ly, d.getMonth() + 1, 0).getDate();
    return { dateFrom: `${ly}-${lm}-01`, dateTo: `${ly}-${lm}-${last}` };
  }
  if (period === 'this_year')  return { dateFrom: `${y}-01-01`, dateTo: today };
  if (period === 'last_7_days') {
    const from = new Date(now); from.setDate(from.getDate() - 7);
    return { dateFrom: from.toISOString().slice(0, 10), dateTo: today };
  }
  return {};
}

function expenseList({ userId, bookId, dateFrom, dateTo, category, merchant, period, limit = 50 }) {
  if (!bookId) return 'bookId is required. Call expense_books first to see available books.';
  // period shortcuts: this_month, last_month, this_year, last_7_days
  if (period) {
    const resolved = resolvePeriodDates(period);
    dateFrom = dateFrom ?? resolved.dateFrom;
    dateTo   = dateTo   ?? resolved.dateTo;
  }
  let txns = loadTransactions();
  if (userId) txns = txns.filter(t => t.userId === userId);
  txns = txns.filter(t => t.bookId === bookId);
  if (dateFrom) txns = txns.filter(t => t.date >= dateFrom);
  if (dateTo)   txns = txns.filter(t => t.date <= dateTo);
  if (category) txns = txns.filter(t => t.category === category);
  if (merchant) { const m = merchant.toLowerCase(); txns = txns.filter(t => (t.merchant || '').toLowerCase().includes(m)); }
  txns = txns.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  const rangeNote = dateFrom ? ` (${dateFrom} to ${dateTo ?? 'today'})` : '';
  const bookNote = bookId && bookId !== 'none' ? ` [book:${bookId}]` : '';
  if (!txns.length) return `No transactions found${rangeNote}${bookNote}.`;
  const total = txns.reduce((s, t) => s + t.amount, 0);
  const lines = txns.map(t =>
    `txn_id:${t.id} | ${t.date} | $${t.amount.toFixed(2)} | ${t.merchant || ''} | ${t.category}`
  );
  return `Found ${txns.length} transaction(s)${rangeNote}${bookNote} — Total: $${total.toFixed(2)}\n\n` + lines.join('\n');
}

function expenseSummary({ userId, bookId, period, year, month, byCategory }) {
  if (!bookId) return 'bookId is required. Call expense_books first to see available books.';
  // If period is a shortcut (not a grouping period), resolve to date range
  const shortcutPeriods = ['this_month', 'last_month', 'this_year', 'last_7_days'];
  let dateFrom, dateTo, groupPeriod = period;
  if (shortcutPeriods.includes(period)) {
    ({ dateFrom, dateTo } = resolvePeriodDates(period));
    groupPeriod = period.includes('month') ? 'monthly' : 'yearly';
  }

  let txns = loadTransactions().filter(t => t.userId === userId && t.bookId === bookId);
  if (dateFrom) txns = txns.filter(t => t.date >= dateFrom);
  if (dateTo)   txns = txns.filter(t => t.date <= dateTo);
  if (year)  txns = txns.filter(t => t.date.startsWith(String(year)));
  if (month) {
    const y = year ?? new Date().getFullYear();
    txns = txns.filter(t => t.date.startsWith(String(y)) && parseInt(t.date.slice(5, 7)) === month);
  }

  const groups = {};
  for (const t of txns) {
    let key;
    if (groupPeriod === 'daily')        key = t.date;
    else if (groupPeriod === 'monthly') key = t.date.slice(0, 7);
    else                                key = t.date.slice(0, 4);

    if (!groups[key]) groups[key] = { total: 0, categories: {} };
    groups[key].total += t.amount;
    if (byCategory) {
      const cat = t.category || 'Other';
      groups[key].categories[cat] = (groups[key].categories[cat] ?? 0) + t.amount;
    }
  }

  const keys = Object.keys(groups).sort();
  if (!keys.length) return 'No transactions found for that period.';

  let out = `Spending summary (${period}):\n\n`;
  for (const k of keys) {
    out += `${k}: $${groups[k].total.toFixed(2)}\n`;
    if (byCategory) {
      const cats = Object.entries(groups[k].categories).sort((a, b) => b[1] - a[1]);
      for (const [cat, amt] of cats) out += `   ${cat}: $${amt.toFixed(2)}\n`;
    }
  }
  const grandTotal = txns.reduce((s, t) => s + t.amount, 0);
  out += `\nGrand total: $${grandTotal.toFixed(2)}`;
  return out;
}

async function expenseAdd({ userId, bookId, date, amount, currency = 'USD', merchant, description, category }) {
  if (!bookId) return 'bookId is required. Call expense_books to see available books, then specify one.';
  const txn = {
    id: newId(), userId, bookId, date, amount: parseFloat(amount), currency,
    merchant, description: description ?? merchant, category, source: 'manual',
    createdAt: new Date().toISOString(),
  };
  await modifyTransactions(list => { list.push(txn); });
  const bookLabel = bookId ? ` → book:${bookId}` : '';
  const text = `Added: ${txn.id} — ${date} $${parseFloat(amount).toFixed(2)} at ${merchant} [${category}]${bookLabel}`;
  return {
    text,
    _notify: {
      event: 'expense_added',
      message: `${merchant} — $${parseFloat(amount).toFixed(2)} [${category}]`,
      data: { count: 1, total: parseFloat(amount), merchant, category },
    },
  };
}

async function expenseUpdate({ id, ...changes }) {
  return modifyTransactions(list => {
    const idx = list.findIndex(t => t.id === id);
    if (idx === -1) return `Transaction ${id} not found.`;
    list[idx] = { ...list[idx], ...changes };
    return `Updated ${id}: ${JSON.stringify(changes)}`;
  });
}

async function expenseDelete({ id }) {
  return modifyTransactions(list => {
    const idx = list.findIndex(t => t.id === id);
    if (idx === -1) return `Transaction ${id} not found.`;
    list.splice(idx, 1);
    return `Deleted transaction ${id}.`;
  });
}

async function expenseDeleteBatch({ ids }) {
  if (!Array.isArray(ids) || !ids.length) return 'No IDs provided.';
  return modifyTransactions(list => {
    const idSet = new Set(ids);
    const before = list.length;
    const toRemove = list.filter(t => idSet.has(t.id));
    list.splice(0, list.length, ...list.filter(t => !idSet.has(t.id)));
    const removed = before - list.length;
    const notFound = ids.filter(id => !toRemove.find(t => t.id === id));
    return `Deleted ${removed} transaction(s).` + (notFound.length ? ` Not found: ${notFound.join(', ')}` : '');
  });
}

async function expenseDeleteAll({ userId }) {
  return modifyTransactions(list => {
    const before = list.length;
    if (userId) {
      list.splice(0, list.length, ...list.filter(t => t.userId !== userId));
    } else {
      list.splice(0, list.length);
    }
    const removed = before - list.length;
    return `Deleted all ${removed} transaction(s).`;
  });
}

async function expenseAddBatch({ userId, bookId, transactions }) {
  if (!bookId) return 'bookId is required. Call expense_books to see available books, then specify one.';
  if (!Array.isArray(transactions) || !transactions.length) return 'No transactions provided.';
  let added;
  await modifyTransactions(list => {
    added = transactions.map(t => ({
      id: newId(), userId, bookId, date: t.date, amount: parseFloat(t.amount), currency: 'USD',
      merchant: t.merchant, description: t.description ?? t.merchant,
      category: t.category, subcategory: t.subcategory ?? '',
      source: 'statement', createdAt: new Date().toISOString(),
    }));
    for (const txn of added) list.push(txn);
  });
  const total = added.reduce((s, t) => s + t.amount, 0);
  const text = `Saved ${added.length} transaction(s). Total: $${total.toFixed(2)}`;
  return {
    text,
    _notify: {
      event: 'expenses_added',
      message: `added ${added.length} transaction(s) — $${total.toFixed(2)} total`,
      data: { count: added.length, total },
    },
  };
}

function expenseBooks({ userId }) {
  const books = getExpBooksForUser(userId);
  if (!books.length) return 'No expense books found. The user can create one (e.g. "Household", "Business") to organize expenses into separate portfolios.';
  const lines = books.map(b => {
    const shared = (b.sharedWith ?? []).length ? ` (shared with ${b.sharedWith.length} user(s))` : '';
    const owner = b.ownerId === userId ? ' [owner]' : ' [shared with you]';
    return `ID:${b.id}  "${b.name}"${owner}${shared}`;
  });
  return `Expense books for this user:\n\n${lines.join('\n')}\n\nUse a bookId when adding or querying transactions to target a specific book.`;
}

async function expenseCreateBook({ userId, name }) {
  if (!name?.trim()) return 'Book name is required.';
  const book = await modifyExpBooks(books => {
    const b = { id: 'book_' + randomBytes(4).toString('hex'), name: name.trim(), ownerId: userId, sharedWith: [], createdAt: new Date().toISOString() };
    books.push(b);
    return b;
  });
  return `Created expense book "${book.name}" (ID: ${book.id}). Use bookId:"${book.id}" when adding transactions to this book.`;
}

async function expenseDeleteBook({ userId, bookId, deleteTransactions = false, moveToBookId = null }) {
  if (!bookId) return 'bookId is required.';
  let bookName;
  const result = await modifyExpBooks(books => {
    const idx = books.findIndex(b => b.id === bookId);
    if (idx === -1) return 'notfound';
    if (books[idx].ownerId !== userId) return 'forbidden';
    bookName = books[idx].name;
    books.splice(idx, 1);
    return 'ok';
  });
  if (result === 'notfound') return `Book ${bookId} not found.`;
  if (result === 'forbidden') return `You don't own book ${bookId}.`;
  await modifyTransactions(list => {
    if (deleteTransactions) {
      list.splice(0, list.length, ...list.filter(t => t.bookId !== bookId));
    } else if (moveToBookId) {
      for (const t of list) { if (t.bookId === bookId) t.bookId = moveToBookId; }
    } else {
      for (const t of list) { if (t.bookId === bookId) delete t.bookId; }
    }
  });
  if (deleteTransactions) return `Deleted expense book "${bookName}" and all its transactions.`;
  if (moveToBookId)       return `Deleted expense book "${bookName}". Transactions moved to book ${moveToBookId}.`;
  return `Deleted expense book "${bookName}". Its transactions have been unlinked.`;
}

async function expenseShareBook({ bookId, shareWithUserIds }) {
  if (!bookId) return 'bookId is required.';
  if (!Array.isArray(shareWithUserIds)) return 'shareWithUserIds must be an array.';
  const updated = await modifyExpBooks(books => {
    const idx = books.findIndex(b => b.id === bookId);
    if (idx === -1) return null;
    books[idx].sharedWith = [...new Set([...(books[idx].sharedWith ?? []), ...shareWithUserIds])];
    return books[idx];
  });
  if (!updated) return `Book ${bookId} not found.`;
  return `Book "${updated.name}" is now shared with ${updated.sharedWith.length} user(s).`;
}

function expenseCategories() {
  const lines = Object.entries(CATEGORIES).map(([cat, subs]) =>
    `${cat}: ${subs.join(', ')}`
  );
  return 'Available expense categories:\n\n' + lines.join('\n');
}

// ── Pending delete confirmation ────────────────────────────────────────────────
// Keyed by userId — stores { name, args } waiting for "CONFIRM DELETION"
const _pendingDeletes = new Map();

export function getPendingDelete(userId) { return _pendingDeletes.get(userId) ?? null; }
export function clearPendingDelete(userId) { _pendingDeletes.delete(userId); }

export async function executePendingDelete(userId) {
  const pending = _pendingDeletes.get(userId);
  if (!pending) return 'No pending delete operation.';
  _pendingDeletes.delete(userId);
  switch (pending.name) {
    case 'expense_delete':       return expenseDelete(pending.args);
    case 'expense_delete_batch': return expenseDeleteBatch(pending.args);
    case 'expense_delete_all':   return expenseDeleteAll(pending.args);
    default:                     return 'Unknown pending operation.';
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
export async function executeSkillTool(name, args, userId) {
  const deleteOps = ['expense_delete', 'expense_delete_batch', 'expense_delete_all'];
  if (deleteOps.includes(name)) {
    if (!isPrivileged(userId)) {
      return 'Permission denied. Only admins and owners can delete transactions.';
    }

    // Stage-time existence check so hallucinated IDs fail fast
    // instead of wasting the user's CONFIRM DELETION round-trip.
    const txns = loadTransactions();

    if (name === 'expense_delete') {
      if (!args.id || !txns.some(t => t.id === args.id)) {
        return `Transaction ${args.id} not found. Call expense_list first to get the correct transaction ID.`;
      }
    } else if (name === 'expense_delete_batch') {
      if (!Array.isArray(args.ids) || !args.ids.length) return 'No IDs provided.';
      const ids = new Set(txns.map(t => t.id));
      const missing = args.ids.filter(id => !ids.has(id));
      if (missing.length) {
        return `Transaction(s) not found: ${missing.join(', ')}. Call expense_list first to get correct IDs.`;
      }
    } else { // expense_delete_all
      const scoped = args.userId ? txns.filter(t => t.userId === args.userId) : txns;
      if (!scoped.length) return 'No transactions to delete.';
    }

    // Stage the delete and require explicit confirmation from the user
    _pendingDeletes.set(userId, { name, args });
    const desc = name === 'expense_delete_all'
      ? 'ALL transactions'
      : name === 'expense_delete_batch'
        ? `${args.ids.length} transaction(s)`
        : `transaction ${args.id}`;
    return `⚠️ You are about to delete ${desc}. This cannot be undone. Type **CONFIRM DELETION** in the chat to proceed, or say anything else to cancel.`;
  }
  switch (name) {
    case 'expense_list':         return expenseList(args);
    case 'expense_summary':      return expenseSummary(args);
    case 'expense_add':          return expenseAdd(args);
    case 'expense_update':       return expenseUpdate(args);
    case 'expense_add_batch':    return expenseAddBatch(args);
    case 'expense_categories':   return expenseCategories();
    case 'expense_books':        return expenseBooks(args);
    case 'expense_create_book':  return expenseCreateBook(args);
    case 'expense_delete_book':  return expenseDeleteBook(args);
    case 'expense_share_book':   return expenseShareBook(args);
    default:                     return null;
  }
}

export default executeSkillTool;
