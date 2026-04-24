// ── Expense drawer ────────────────────────────────────────────────────────────
const EXP_CATEGORIES = ['Food & Dining','Transportation','Shopping','Utilities','Entertainment','Healthcare','Housing','Travel','Subscriptions','Education','Business','Taxes & Fees','Transfers','Other'];

let _expBooks = [];
let _expSelectedBookId = ''; // '' = all, else book ID

function showExpView(view) {
  ['dashboard','transactions','reports','import','group'].forEach(v => {
    document.getElementById('expView-' + v)?.classList.toggle('active', v === view);
    document.getElementById('expNav-' + v)?.classList.toggle('active', v === view);
  });
  if (view === 'dashboard')    loadExpDashboard();
  if (view === 'transactions') loadExpTxns();
  if (view === 'reports')      loadExpOverview();
  if (view === 'import')       renderImportBookPicker();
  if (view === 'group')        loadExpGroup();
}

function renderImportBookPicker() {
  const picker = document.getElementById('expImportBookPicker');
  const sel = document.getElementById('expImportBookSelect');
  if (!picker || !sel) return;
  if (!_expBooks.length) { picker.style.display = 'none'; return; }
  picker.style.display = 'block';
  sel.innerHTML = '<option value="">General (no book)</option>';
  for (const b of _expBooks) {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = `📒 ${b.name}`;
    sel.appendChild(o);
  }
  // Pre-select the sidebar book if one is chosen
  if (_expSelectedBookId && _expBooks.some(b => b.id === _expSelectedBookId)) {
    sel.value = _expSelectedBookId;
  }
}

function _expBookParam() {
  return _expSelectedBookId ? `bookId=${encodeURIComponent(_expSelectedBookId)}&` : 'bookId=none&';
}

async function loadExpBooks() {
  try {
    _expBooks = await fetch('/api/expense-books').then(r => r.json());
  } catch { _expBooks = []; }
  const sel = document.getElementById('expBookSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  for (const b of _expBooks) {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = `📒 ${b.name}${b.isOwner ? '' : ' (shared)'}`;
    sel.appendChild(o);
  }
  // Restore or auto-select first book
  if (_expBooks.some(b => b.id === prev)) { sel.value = prev; _expSelectedBookId = prev; }
  else if (_expBooks.length) { sel.value = _expBooks[0].id; _expSelectedBookId = _expBooks[0].id; }
  else { _expSelectedBookId = ''; }
  const manageBtn = document.getElementById('expBookManageBtn');
  if (manageBtn) manageBtn.style.display = _expSelectedBookId && _expBooks.find(b => b.id === _expSelectedBookId)?.isOwner !== false ? '' : 'none';
}

function expBookChanged() {
  _expSelectedBookId = document.getElementById('expBookSelect')?.value || '';
  const manageBtn = document.getElementById('expBookManageBtn');
  if (manageBtn) manageBtn.style.display = _expSelectedBookId ? '' : 'none';
  // Reload current view with new book filter
  const activeView = document.querySelector('.exp-view.active');
  if (activeView) {
    const viewId = activeView.id.replace('expView-', '');
    showExpView(viewId);
  }
}

function expShowCreateBook() {
  const el = document.getElementById('expBookOverlayContent');
  el.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:12px">Create Expense Book</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Create a separate portfolio to track expenses independently (e.g. Household, Business).</div>
    <input id="expNewBookName" placeholder="Book name (e.g. Household)" style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px;margin-bottom:10px">
    <button onclick="expCreateBook()" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600;width:100%">Create</button>`;
  document.getElementById('expBookOverlay').style.display = 'flex';
  setTimeout(() => document.getElementById('expNewBookName')?.focus(), 100);
}

async function expCreateBook() {
  const name = document.getElementById('expNewBookName')?.value?.trim();
  if (!name) { showToast('Enter a name'); return; }
  try {
    const r = await fetch('/api/expense-books', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    showToast(`Book "${name}" created`);
    await loadExpBooks();
    // Auto-select the new book
    _expSelectedBookId = data.id;
    document.getElementById('expBookSelect').value = data.id;
    expBookChanged();
    expCloseBookOverlay();
  } catch(e) { showToast(e.message); }
}

function expShowManageBook() {
  const book = _expBooks.find(b => b.id === _expSelectedBookId);
  if (!book) return;
  const isOwner = book.isOwner;
  const membersHtml = (book.sharedMembers ?? []).map(m =>
    `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span>${escHtml(m.emoji || '🧑')}</span>
      <span style="flex:1;font-size:13px">${escHtml(m.name)}</span>
      ${isOwner ? `<button onclick="expBookRemoveShare('${escHtml(m.id)}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px">✕</button>` : ''}
    </div>`
  ).join('') || '<div style="font-size:12px;color:var(--muted);padding:6px 0">Not shared with anyone yet.</div>';

  const el = document.getElementById('expBookOverlayContent');
  el.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:4px">📒 ${escHtml(book.name)}</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:12px">${isOwner ? 'You own this book' : 'Shared with you'}</div>
    ${isOwner ? `
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--muted)">Rename</label>
        <div style="display:flex;gap:6px;margin-top:4px">
          <input id="expBookRename" value="${escHtml(book.name)}" style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <button onclick="expRenameBook()" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer">Save</button>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--muted)">Shared with</label>
        <div style="margin-top:4px">${membersHtml}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <select id="expBookShareSel" style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px"></select>
          <button onclick="expBookAddShare()" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer">Share</button>
        </div>
      </div>
      <button onclick="expDeleteBook()" style="background:none;border:1px solid #e05c5c;color:#e05c5c;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;width:100%">Delete Book</button>
    ` : ''}`;
  document.getElementById('expBookOverlay').style.display = 'flex';

  // Populate share dropdown
  if (isOwner) {
    fetch('/api/users').then(r => r.json()).then(users => {
      const shared = new Set(book.sharedWith ?? []);
      shared.add(book.ownerId);
      const available = users.filter(u => !shared.has(u.id));
      const sel = document.getElementById('expBookShareSel');
      if (sel) {
        sel.innerHTML = available.length
          ? available.map(u => `<option value="${escHtml(u.id)}">${escHtml(u.emoji || '🧑')} ${escHtml(u.name)}</option>`).join('')
          : '<option value="">No users available</option>';
        sel.disabled = !available.length;
      }
    }).catch(() => {});
  }
}

async function expRenameBook() {
  const name = document.getElementById('expBookRename')?.value?.trim();
  if (!name) return;
  try {
    await fetch(`/api/expense-books/${_expSelectedBookId}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    showToast('Book renamed');
    await loadExpBooks();
    expCloseBookOverlay();
  } catch(e) { showToast(e.message); }
}

async function expBookAddShare() {
  const uid = document.getElementById('expBookShareSel')?.value;
  if (!uid) return;
  const book = _expBooks.find(b => b.id === _expSelectedBookId);
  if (!book) return;
  const newShared = [...(book.sharedWith ?? []), uid];
  try {
    await fetch(`/api/expense-books/${_expSelectedBookId}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sharedWith: newShared }) });
    showToast('User added');
    await loadExpBooks();
    expShowManageBook();
  } catch(e) { showToast(e.message); }
}

async function expBookRemoveShare(uid) {
  const book = _expBooks.find(b => b.id === _expSelectedBookId);
  if (!book) return;
  const newShared = (book.sharedWith ?? []).filter(id => id !== uid);
  try {
    await fetch(`/api/expense-books/${_expSelectedBookId}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sharedWith: newShared }) });
    showToast('User removed');
    await loadExpBooks();
    expShowManageBook();
  } catch(e) { showToast(e.message); }
}

function expDeleteBook() {
  const book = _expBooks.find(b => b.id === _expSelectedBookId);
  if (!book) return;
  const otherBooks = _expBooks.filter(b => b.id !== _expSelectedBookId);
  const moveOptions = otherBooks.length
    ? `<option value="">— don't move —</option>` + otherBooks.map(b => `<option value="${escHtml(b.id)}">📒 ${escHtml(b.name)}</option>`).join('')
    : '';
  const el = document.getElementById('expBookOverlayContent');
  el.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:8px;color:#e05c5c">Delete "${escHtml(book.name)}"?</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">This cannot be undone.</div>
    ${otherBooks.length ? `
    <div style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Move transactions to</label>
      <select id="expMoveToBook" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:13px">${moveOptions}</select>
    </div>` : ''}
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:16px;cursor:pointer">
      <input type="checkbox" id="expDeleteTxnsCheck" style="width:14px;height:14px" ${otherBooks.length ? '' : 'checked'} onchange="expDeleteBookToggle(this)">
      Delete all transactions in this book
    </label>
    <div style="display:flex;gap:8px">
      <button onclick="expCloseBookOverlay();expShowManageBook()" style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px;font-size:12px;cursor:pointer">Cancel</button>
      <button onclick="expConfirmDeleteBook()" style="flex:1;background:#e05c5c;border:none;color:#fff;border-radius:8px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">Delete</button>
    </div>`;
}

function expDeleteBookToggle(cb) {
  const sel = document.getElementById('expMoveToBook');
  if (sel) sel.disabled = cb.checked;
}

async function expConfirmDeleteBook() {
  const book = _expBooks.find(b => b.id === _expSelectedBookId);
  if (!book) return;
  const deleteTransactions = document.getElementById('expDeleteTxnsCheck')?.checked ?? false;
  const moveToBookId = !deleteTransactions ? (document.getElementById('expMoveToBook')?.value || '') : '';
  const params = new URLSearchParams();
  if (deleteTransactions) params.set('deleteTransactions', 'true');
  else if (moveToBookId)  params.set('moveToBookId', moveToBookId);
  try {
    const r = await fetch(`/api/expense-books/${_expSelectedBookId}?${params}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    const suffix = deleteTransactions ? ' and its transactions' : moveToBookId ? ` (transactions moved to "${_expBooks.find(b=>b.id===moveToBookId)?.name}")` : '';
    showToast(`Book "${book.name}" deleted${suffix}`);
    _expSelectedBookId = '';
    expCloseBookOverlay();
    await loadExpBooks();
    showExpView('dashboard');
  } catch(e) { showToast(e.message); }
}

function expCloseBookOverlay() {
  document.getElementById('expBookOverlay').style.display = 'none';
}

function openExpensesDrawer() {
  const catSel = document.getElementById('expFilterCat');
  if (catSel && catSel.options.length <= 1) {
    EXP_CATEGORIES.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });
  }
  loadExpBooks();
  showExpView('dashboard');
}

const EXP_CAT_COLORS = [
  '#4a9eff','#f59e0b','#10b981','#ef4444','#8b5cf6',
  '#ec4899','#06b6d4','#84cc16','#f97316','#6366f1',
  '#14b8a6','#e11d48','#a3e635','#fb923c','#a78bfa',
];
let _expChart     = null;
let _expChartData = null; // { byMonth, allTxns }
let _expChartPeriod = 'ytd';

async function loadExpDashboard() {
  if (!_expSelectedBookId) {
    document.getElementById('expKpiMonth').textContent  = '—';
    document.getElementById('expKpiYear').textContent   = '—';
    document.getElementById('expKpiCount').textContent  = '—';
    document.getElementById('expKpiTopCat').textContent = '—';
    document.getElementById('expDashRecent').innerHTML  = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:32px">Create an expense book to get started.</td></tr>';
    if (_expChart) { _expChart.destroy(); _expChart = null; }
    return;
  }
  const now    = new Date();
  const y      = now.getFullYear();
  const m      = String(now.getMonth() + 1).padStart(2, '0');
  const today  = now.toISOString().slice(0, 10);
  try {
    const bp = _expBookParam();
    const [monthTxns, allTxns, yearData] = await Promise.all([
      fetch(`/api/expenses/transactions?${bp}dateFrom=${y}-${m}-01&dateTo=${today}&limit=500`).then(r => r.json()),
      fetch(`/api/expenses/transactions?${bp}limit=500`).then(r => r.json()),
      fetch(`/api/expenses/summary?${bp}year=${y}`).then(r => r.json()),
    ]);
    const monthTotal = monthTxns.reduce((s, t) => s + t.amount, 0);
    const yearTotal  = Object.values(yearData.byMonth ?? {}).reduce((s, mo) => s + mo.total, 0);
    const catTotals  = {};
    for (const t of allTxns) catTotals[t.category] = (catTotals[t.category] ?? 0) + t.amount;
    const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
    document.getElementById('expKpiMonth').textContent  = `$${monthTotal.toFixed(2)}`;
    document.getElementById('expKpiYear').textContent   = `$${yearTotal.toFixed(2)}`;
    document.getElementById('expKpiCount').textContent  = allTxns.length;
    document.getElementById('expKpiTopCat').textContent = topCat;
    const recent = allTxns.slice(0, 15);
    document.getElementById('expDashRecent').innerHTML = recent.length
      ? recent.map(t => `<tr>
          <td class="exp-td-date">${escHtml(t.date)}</td>
          <td class="exp-td-merchant">${escHtml(t.merchant || '')}</td>
          <td><span class="exp-cat-badge">${escHtml(t.category || 'Other')}</span></td>
          <td class="exp-td-amt">$${parseFloat(t.amount).toFixed(2)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px">No transactions yet.</td></tr>';

    _expChartData = { byMonth: yearData.byMonth ?? {}, allTxns, year: y, curMonth: m };
    _expChartPeriod = 'ytd';
    renderExpChartPeriods();
    renderExpChart();
  } catch(e) {
    document.getElementById('expDashRecent').innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:16px">${escHtml(e.message)}</td></tr>`;
  }
}

function renderExpChartPeriods() {
  if (!_expChartData) return;
  const { byMonth, year, curMonth } = _expChartData;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const months = Object.keys(byMonth).sort();
  const el = document.getElementById('expChartPeriods');
  if (!el) return;
  let btns = `<button class="exp-period-btn${_expChartPeriod === 'ytd' ? ' active' : ''}" onclick="setExpChartPeriod('ytd')">YTD</button>`;
  for (const mo of months) {
    const [, mm] = mo.split('-');
    const label = monthNames[parseInt(mm) - 1];
    btns += `<button class="exp-period-btn${_expChartPeriod === mo ? ' active' : ''}" onclick="setExpChartPeriod('${mo}')">${label}</button>`;
  }
  el.innerHTML = btns;
}

function setExpChartPeriod(period) {
  _expChartPeriod = period;
  renderExpChartPeriods();
  renderExpChart();
}

function renderExpChart() {
  if (!_expChartData) return;
  const { byMonth, allTxns, year, curMonth } = _expChartData;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Build category totals for selected period
  const cats = {};
  if (_expChartPeriod === 'ytd') {
    for (const [mo, data] of Object.entries(byMonth)) {
      if (mo <= `${year}-${curMonth}`) {
        for (const [cat, amt] of Object.entries(data.categories ?? {})) {
          cats[cat] = (cats[cat] ?? 0) + amt;
        }
      }
    }
  } else {
    const data = byMonth[_expChartPeriod];
    if (data) for (const [cat, amt] of Object.entries(data.categories ?? {})) cats[cat] = amt;
  }

  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const total  = sorted.reduce((s, [, v]) => s + v, 0);
  const labels = sorted.map(([k]) => k);
  const values = sorted.map(([, v]) => v);
  const bgColors = labels.map((_, i) => EXP_CAT_COLORS[i % EXP_CAT_COLORS.length]);

  // Period label for center
  const periodLabel = _expChartPeriod === 'ytd'
    ? `${year} YTD`
    : (() => { const [, mm] = _expChartPeriod.split('-'); return `${monthNames[parseInt(mm)-1]} ${year}`; })();

  document.getElementById('expChartCenterLabel').textContent = periodLabel;
  document.getElementById('expChartCenterVal').textContent   = total > 0 ? `$${total.toFixed(0)}` : '—';

  const canvas = document.getElementById('expCatChart');
  if (!canvas) return;

  if (_expChart) { _expChart.destroy(); _expChart = null; }

  if (!sorted.length) {
    document.getElementById('expChartLegend').innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:16px">No data for this period.</div>';
    return;
  }

  _expChart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderColor: '#242424', borderWidth: 2, hoverOffset: 8 }] },
    options: {
      cutout: '62%',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return ` $${ctx.parsed.toFixed(2)} (${pct}%)`;
            },
          },
        },
      },
      onHover: (evt, elements) => {
        canvas.style.cursor = elements.length ? 'pointer' : 'default';
      },
    },
  });

  // Legend
  document.getElementById('expChartLegend').innerHTML = sorted.map(([cat, amt], i) => {
    const pct = total > 0 ? ((amt / total) * 100).toFixed(1) : 0;
    return `<div class="exp-legend-item" onclick="expChartHighlight(${i})" onmouseenter="expChartHighlight(${i})" onmouseleave="expChartHighlight(-1)">
      <div class="exp-legend-dot" style="background:${bgColors[i]}"></div>
      <span class="exp-legend-name">${escHtml(cat)}</span>
      <span class="exp-legend-amt">$${amt.toFixed(0)}</span>
      <span class="exp-legend-pct">${pct}%</span>
    </div>`;
  }).join('');
}

function expChartHighlight(idx) {
  if (!_expChart) return;
  if (idx < 0) {
    _expChart.data.datasets[0].hoverOffset = 8;
    _expChart.update('none');
    return;
  }
  // Trigger active state on the hovered segment
  _expChart.setDatasetVisibility(0, true);
  _expChart.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], { x: 0, y: 0 });
  _expChart.update('none');
}

let _expTimeChart = null;
function renderExpTimeChart(labels, values) {
  const canvas = document.getElementById('expTimeChart');
  if (!canvas) return;
  if (_expTimeChart) { _expTimeChart.destroy(); _expTimeChart = null; }
  if (!labels.length) return;
  _expTimeChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Spending',
        data: values,
        backgroundColor: 'rgba(33,150,243,0.6)',
        borderColor: 'rgba(33,150,243,1)',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` $${ctx.parsed.y.toFixed(2)}` } },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => '$' + v, color: 'var(--muted)', font: { size: 10 } },
          grid: { color: 'rgba(128,128,128,0.15)' },
        },
        x: {
          ticks: { color: 'var(--muted)', font: { size: 10 } },
          grid: { display: false },
        },
      },
    },
  });
}

function expDragOver(e) { e.preventDefault(); document.getElementById('expDropZone').classList.add('exp-drop-active'); }
function expDragLeave()  { document.getElementById('expDropZone').classList.remove('exp-drop-active'); }
function expDrop(e)      { e.preventDefault(); expDragLeave(); const f = e.dataTransfer.files[0]; if (f) expHandleFile(f); }

async function expHandleFile(file) {
  if (!file) return;
  const status = document.getElementById('expUploadStatus');
  const newTxns = document.getElementById('expNewTxns');
  status.style.display = 'block';
  status.style.background = 'var(--bg3)';
  status.innerHTML = `⏳ Processing <strong>${escHtml(file.name)}</strong>…`;
  newTxns.style.display = 'none';
  try {
    const form = new FormData();
    form.append('file', file);
    const importBookId = document.getElementById('expImportBookSelect')?.value || _expSelectedBookId || '';
    const uploadUrl = importBookId ? `/api/expenses/upload?bookId=${encodeURIComponent(importBookId)}` : '/api/expenses/upload';
    const res = await fetch(uploadUrl, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    status.style.background = 'rgba(46,160,67,.15)';
    const bookName = importBookId ? (_expBooks.find(b => b.id === importBookId)?.name ?? 'book') : null;
    const bookLabel = bookName ? ` → <strong>📒 ${escHtml(bookName)}</strong>` : '';
    status.innerHTML = `${icon('check-circle', 14)} Extracted <strong>${data.extracted}</strong> transaction${data.extracted !== 1 ? 's' : ''} from ${escHtml(file.name)}${bookLabel}`;
    if (data.transactions?.length) {
      document.getElementById('expNewTxnsList').innerHTML = data.transactions.map(t =>
        `<tr><td class="exp-td-date">${escHtml(t.date)}</td><td class="exp-td-merchant">${escHtml(t.merchant||'')}</td><td><span class="exp-cat-badge">${escHtml(t.category||'Other')}</span></td><td class="exp-td-amt">$${parseFloat(t.amount).toFixed(2)}</td></tr>`
      ).join('');
      newTxns.style.display = 'block';
    }
  } catch(e) {
    status.style.background = 'rgba(244,67,54,.15)';
    status.innerHTML = `❌ ${escHtml(e.message)}`;
  }
}

function expTxnHtml(t, editable = false) {
  const uploader = t.uploaderName ? ` <span style="font-size:10px;color:var(--muted)">${escHtml(t.uploaderEmoji||'🧑')} ${escHtml(t.uploaderName)}</span>` : '';
  const desc = t.description && t.description !== t.merchant ? escHtml(t.description) : '';
  return `<tr data-id="${escHtml(t.id)}">
    <td class="exp-td-date">${escHtml(t.date)}</td>
    <td class="exp-td-merchant">${escHtml(t.merchant || '')}${uploader}</td>
    <td class="exp-td-desc">${desc}</td>
    <td><span class="exp-cat-badge" onclick="expEditCat('${escHtml(t.id)}',this)">${escHtml(t.category || 'Other')}</span></td>
    <td class="exp-td-amt">$${parseFloat(t.amount).toFixed(2)}</td>
    <td class="exp-td-act">${editable ? `<button onclick="expDeleteTxn('${escHtml(t.id)}',this)" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;padding:2px 6px" title="Delete">✕</button>` : ''}</td>
  </tr>`;
}

async function expEditCat(id, el) {
  const cur = el.textContent;
  const sel = document.createElement('select');
  sel.style.cssText = 'font-size:11px;border-radius:10px;padding:2px 6px;background:var(--bg);border:1px solid var(--border);color:var(--text)';
  EXP_CATEGORIES.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; if (c === cur) o.selected = true; sel.appendChild(o); });
  el.replaceWith(sel);
  sel.focus();
  sel.onchange = async () => {
    const newCat = sel.value;
    const badge = document.createElement('span');
    badge.className = 'exp-cat-badge'; badge.textContent = newCat;
    badge.onclick = () => expEditCat(id, badge);
    sel.replaceWith(badge);
    await fetch(`/api/expenses/transactions/${id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ category: newCat }) });
  };
  sel.onblur = () => { if (document.contains(sel)) { const b = document.createElement('span'); b.className='exp-cat-badge'; b.textContent=cur; b.onclick=()=>expEditCat(id,b); sel.replaceWith(b); } };
}

async function expDeleteTxn(id, btn) {
  if (!confirm('Delete this transaction?')) return;
  await fetch(`/api/expenses/transactions/${id}`, { method: 'DELETE' });
  btn.closest('tr').remove();
  loadExpTxns();
}

async function loadExpTxns() {
  const tbody   = document.getElementById('expTxnList');
  const emptyEl = document.getElementById('expTxnEmpty');
  const totalEl = document.getElementById('expTxnTotal');
  if (!tbody) return;
  if (!_expSelectedBookId) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Select or create an expense book to view transactions.</td></tr>';
    if (emptyEl) emptyEl.style.display = 'none';
    if (totalEl) totalEl.textContent = '';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);font-size:13px;padding:16px;text-align:center">Loading…</td></tr>';
  const month  = document.getElementById('expFilterMonth')?.value;
  const cat    = document.getElementById('expFilterCat')?.value;
  const search = document.getElementById('expSearch')?.value?.trim().toLowerCase();
  let url = `/api/expenses/transactions?${_expBookParam()}limit=500&`;
  if (month) url += `dateFrom=${month}-01&dateTo=${month}-31&`;
  if (cat)   url += `category=${encodeURIComponent(cat)}&`;
  try {
    let txns = await fetch(url).then(r => r.json());
    if (search) txns = txns.filter(t => (t.merchant || '').toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search));
    if (emptyEl) emptyEl.style.display = txns.length ? 'none' : 'block';
    if (!txns.length) { tbody.innerHTML = ''; totalEl.textContent = ''; return; }
    const total = txns.reduce((s, t) => s + t.amount, 0);
    totalEl.textContent = `$${total.toFixed(2)} · ${txns.length} transactions`;
    tbody.innerHTML = txns.map(t => expTxnHtml(t, true)).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);font-size:13px;padding:16px;text-align:center">Failed to load transactions.</td></tr>';
    totalEl.textContent = '';
  }
}

function expOverviewYearChanged() {
  const yearSel   = document.getElementById('expOverviewYear');
  const periodSel = document.getElementById('expOverviewPeriod');
  if (!yearSel || !periodSel) return;
  const year    = parseInt(yearSel.value);
  const curYear = new Date().getFullYear();
  const curMonth= new Date().getMonth() + 1; // 1-indexed
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const prev = periodSel.value;
  periodSel.innerHTML = '';
  const add = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; periodSel.appendChild(o); };
  add('full', 'Full Year');
  if (year === curYear) add('ytd', 'Year to Date');
  const lastMonth = year === curYear ? curMonth : 12;
  for (let m = 1; m <= lastMonth; m++) add(String(m).padStart(2,'0'), monthNames[m-1]);
  // Restore previous selection if still valid, else default
  if ([...periodSel.options].some(o => o.value === prev)) periodSel.value = prev;
  else periodSel.value = year === curYear ? 'ytd' : 'full';
  loadExpOverview();
}

async function loadExpOverview() {
  const el = document.getElementById('expOverviewTable');
  const totalEl = document.getElementById('expOverviewTotal');
  if (!el) return;
  if (!_expSelectedBookId) {
    el.innerHTML = '<tr><td colspan="3" style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Select or create an expense book to view reports.</td></tr>';
    if (totalEl) totalEl.textContent = '';
    return;
  }
  el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px">Loading…</div>';

  const yearSel   = document.getElementById('expOverviewYear');
  const periodSel = document.getElementById('expOverviewPeriod');

  // First load: populate year dropdown from actual transaction data
  if (!yearSel?.options.length) {
    try {
      const years = await fetch(`/api/expenses/years?${_expBookParam()}`).then(r => r.json());
      const curYear = new Date().getFullYear();
      const all = years.length ? years : [String(curYear)];
      // Ensure current year is always present
      if (!all.includes(String(curYear))) all.unshift(String(curYear));
      all.forEach(y => { const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o); });
    } catch {
      const y = new Date().getFullYear();
      const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o);
    }
    expOverviewYearChanged(); // populates period and triggers load
    return;
  }

  const year   = parseInt(yearSel.value);
  const period = periodSel?.value || 'full';
  const now    = new Date();
  const curYear  = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-indexed

  try {
    const data = await fetch(`/api/expenses/summary?${_expBookParam()}year=${year}`).then(r => r.json());
    let months = Object.keys(data.byMonth).sort();

    if (period === 'ytd') {
      const cutoff = `${year}-${String(curMonth).padStart(2,'0')}`;
      months = months.filter(m => m <= cutoff);
    } else if (period !== 'full') {
      // Specific month selected (e.g. "03")
      months = months.filter(m => m === `${year}-${period}`);
    }

    if (!months.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:16px;text-align:center">No expenses recorded for this period yet.</div>';
      totalEl.textContent = ''; return;
    }

    const cats      = [...new Set(months.flatMap(m => Object.keys(data.byMonth[m].categories)))].sort();
    const colTotals = months.map(m => data.byMonth[m].total);
    const grandTotal= colTotals.reduce((s,v) => s+v, 0);
    const maxTotal  = Math.max(...colTotals, 1);
    const fmt       = v => v > 0 ? `$${v.toFixed(0)}` : '—';
    const monthLabels = months.map(m => { const [,mo] = m.split('-'); return new Date(2000, parseInt(mo)-1).toLocaleString('default',{month:'short'}); });

    let html = `<table class="exp-overview-table"><thead><tr><th>Category</th>${monthLabels.map(l=>`<th>${l}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;

    // Monthly totals row with mini progress bars
    html += `<tr style="font-weight:700;border-bottom:2px solid var(--border)"><td>Total</td>`;
    for (const v of colTotals) {
      const pct = Math.round((v / maxTotal) * 100);
      html += `<td><div style="font-size:12px">$${v.toFixed(0)}</div><div style="margin-top:3px;height:4px;border-radius:2px;background:var(--bg3);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px"></div></div></td>`;
    }
    html += `<td>$${grandTotal.toFixed(0)}</td></tr>`;

    // Category rows
    for (const cat of cats) {
      const row      = months.map(m => data.byMonth[m].categories[cat] || 0);
      const rowTotal = row.reduce((s,v) => s+v, 0);
      html += `<tr><td>${escHtml(cat)}</td>${row.map(v=>`<td>${fmt(v)}</td>`).join('')}<td>${fmt(rowTotal)}</td></tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;

    const periodLabel = period === 'ytd' ? `YTD ${year}` : period === 'full' ? String(year) : `${monthLabels[0]} ${year}`;
    totalEl.textContent = `$${grandTotal.toFixed(2)} — ${periodLabel}`;

    // Render spending over time bar chart
    renderExpTimeChart(monthLabels, colTotals);
  } catch {
    el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:16px;text-align:center">No expenses recorded yet — upload a receipt or statement to get started.</div>';
    totalEl.textContent = '';
  }
}

// ── Expense group management ──────────────────────────────────────────────────
let _expGroupData = null; // cached group for current user

async function loadExpGroup() {
  const infoEl   = document.getElementById('expGroupInfo');
  const createEl = document.getElementById('expGroupCreatePanel');
  const manageEl = document.getElementById('expGroupManagePanel');
  if (!infoEl) return;
  infoEl.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">Loading…</div>';
  createEl.style.display = 'none';
  manageEl.style.display = 'none';

  try {
    const groups = await fetch('/api/expense-groups').then(r => r.json());
    const myGroup = groups.find(g => g.memberIds.includes(getCurrentUserId()));
    _expGroupData = myGroup ?? null;
    const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';

    if (myGroup) {
      // Show group members
      const membersHtml = myGroup.members.map(m => `
        <div class="exp-member-row">
          <span style="font-size:20px">${escHtml(m.emoji || '🧑')}</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${escHtml(m.name)}</div>
            <div style="font-size:11px;color:var(--muted)">${escHtml(m.role)}</div>
          </div>
          ${isPriv && myGroup.members.length > 1 ? `<button onclick="expGroupRemoveMember('${escHtml(m.id)}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px" title="Remove">✕</button>` : ''}
        </div>`).join('');
      infoEl.innerHTML = `
        <div style="font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Shared Group</div>
        <div style="font-size:16px;font-weight:700">${escHtml(myGroup.name)}</div>
        <div style="font-size:12px;color:var(--muted)">Expenses are shared between all members below. Each member can view, categorize, and delete any transaction in the group.</div>
        <div style="display:flex;flex-direction:column;gap:6px">${membersHtml}</div>`;

      if (isPriv) {
        // Populate add-member dropdown with users not already in any group
        const allUsers = await fetch('/api/users').then(r => r.json());
        const available = allUsers.filter(u => !myGroup.memberIds.includes(u.id));
        const addSel = document.getElementById('expGroupAddSel');
        if (addSel) {
          addSel.innerHTML = available.length
            ? available.map(u => `<option value="${escHtml(u.id)}">${escHtml(u.emoji || '🧑')} ${escHtml(u.name)}</option>`).join('')
            : '<option value="">No available users</option>';
          addSel.disabled = !available.length;
        }
        manageEl.style.display = 'flex';
      }
    } else {
      infoEl.innerHTML = `
        <div style="font-size:13px;color:var(--muted);text-align:center;padding:8px">No shared expense group yet.</div>
        ${isPriv ? '<div style="font-size:12px;color:var(--muted);text-align:center">Create a group below to share expenses with household members.</div>' : '<div style="font-size:12px;color:var(--muted);text-align:center">Ask an admin to create a shared expense group and add you to it.</div>'}`;

      if (isPriv) {
        // Populate member picker with all users
        const allUsers = await fetch('/api/users').then(r => r.json());
        const picker = document.getElementById('expGroupMemberPicker');
        if (picker) {
          picker.innerHTML = allUsers.map(u => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" value="${escHtml(u.id)}" ${u.id === getCurrentUserId() ? 'checked disabled' : ''}>
              ${escHtml(u.emoji || '🧑')} ${escHtml(u.name)}
            </label>`).join('');
        }
        createEl.style.display = 'flex';
      }
    }
  } catch(e) {
    infoEl.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:16px;text-align:center">Error: ${escHtml(e.message)}</div>`;
  }
}

async function expCreateGroup() {
  const name = document.getElementById('expGroupName')?.value?.trim();
  if (!name) { showToast('Enter a group name'); return; }
  const checkboxes = document.querySelectorAll('#expGroupMemberPicker input[type=checkbox]');
  const memberIds = [...checkboxes].filter(c => c.checked).map(c => c.value);
  if (memberIds.length < 2) { showToast('Select at least 2 members'); return; }
  try {
    const r = await fetch('/api/expense-groups', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, memberIds }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    showToast(`Group "${name}" created`);
    loadExpGroup();
  } catch(e) { showToast(e.message); }
}

async function expGroupAddMember() {
  if (!_expGroupData) return;
  const sel = document.getElementById('expGroupAddSel');
  const uid = sel?.value;
  if (!uid) return;
  const newMembers = [..._expGroupData.memberIds, uid];
  try {
    const r = await fetch(`/api/expense-groups/${_expGroupData.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ memberIds: newMembers }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    showToast('Member added');
    loadExpGroup();
  } catch(e) { showToast(e.message); }
}

async function expGroupRemoveMember(userId) {
  if (!_expGroupData) return;
  if (!confirm('Remove this member from the group?')) return;
  const newMembers = _expGroupData.memberIds.filter(id => id !== userId);
  try {
    const r = await fetch(`/api/expense-groups/${_expGroupData.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ memberIds: newMembers }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    showToast('Member removed');
    loadExpGroup();
  } catch(e) { showToast(e.message); }
}

async function expGroupDelete() {
  if (!_expGroupData) return;
  if (!confirm(`Disband group "${_expGroupData.name}"? Members will no longer share expenses.`)) return;
  try {
    const r = await fetch(`/api/expense-groups/${_expGroupData.id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Failed');
    showToast('Group disbanded');
    _expGroupData = null;
    loadExpGroup();
  } catch(e) { showToast(e.message); }
}

