// ── Markets ───────────────────────────────────────────────────────────────────

const DEFAULT_CRYPTO = ['BTC','ETH','SOL'];
const DEFAULT_STOCKS  = ['AAPL','TSLA','NVDA'];

function getMarketWatchlist() {
  try {
    const s = localStorage.getItem('mkt_watchlist');
    if (s) return JSON.parse(s);
  } catch {}
  return { crypto: [...DEFAULT_CRYPTO], stocks: [...DEFAULT_STOCKS] };
}
function saveMarketWatchlist(wl) {
  localStorage.setItem('mkt_watchlist', JSON.stringify(wl));
}

function marketRowHtml(name, sym, price, chgStr, chgCls, delFn) {
  return `<div class="market-row">
    <div style="flex:1;min-width:0">
      <div class="market-name">${escHtml(name)}</div>
      ${sym && sym !== name ? `<div class="market-sym">${escHtml(sym)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div class="market-price">${price}</div>
      ${chgStr ? `<div class="market-change ${chgCls}">${chgStr}</div>` : ''}
    </div>
    <button class="market-del" onclick="${delFn}" title="Remove">✕</button>
  </div>`;
}

async function loadMarkets() {
  const body = $('marketsBody');
  const wl = getMarketWatchlist();
  body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Loading…</div>';

  // Fetch crypto
  let cryptoData = null;
  if (wl.crypto.length) {
    const syms = wl.crypto.map(s => s.toUpperCase()).join(',');
    try {
      const r = await fetch(`/api/markets/crypto?syms=${syms}`);
      const json = await r.json();
      cryptoData = json?.RAW ?? null;
    } catch {}
  }

  let html = '';

  // Crypto section
  if (wl.crypto.length) {
    html += '<div class="markets-section-label">Crypto</div>';
    for (const sym of wl.crypto) {
      const d = cryptoData?.[sym.toUpperCase()]?.USD;
      const priceVal = d?.PRICE;
      const price = priceVal != null ? '$' + priceVal.toLocaleString(undefined, { maximumFractionDigits: priceVal >= 1 ? 2 : 6 }) : '—';
      const chg = d?.CHANGEPCT24HOUR;
      const chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '';
      const chgCls = chg != null ? (chg >= 0 ? 'up' : 'down') : '';
      html += marketRowHtml(sym.toUpperCase(), '', price, chgStr, chgCls, `removeMarket('crypto','${escHtml(sym)}')`);
    }
  }

  // Stocks section
  if (wl.stocks.length) {
    html += '<div class="markets-section-label">Stocks</div>';
    // Fetch all stocks in parallel
    const stockResults = await Promise.all(wl.stocks.map(async ticker => {
      try {
        const r = await fetch(`/api/markets/stock/${ticker}`);
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return { ticker, price: '—', chgStr: '', chgCls: '' };
        const price = '$' + (meta.regularMarketPrice ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
        const chgPct = meta.regularMarketChangePercent;
        return {
          ticker,
          price,
          chgStr: chgPct != null ? (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%' : '',
          chgCls: chgPct != null ? (chgPct >= 0 ? 'up' : 'down') : '',
        };
      } catch { return { ticker, price: '—', chgStr: '', chgCls: '' }; }
    }));
    for (const s of stockResults) {
      html += marketRowHtml(s.ticker, '', s.price, s.chgStr, s.chgCls, `removeMarket('stocks','${escHtml(s.ticker)}')`);
    }
  }

  html += `
    <datalist id="mktCryptoList">
      <option value="BTC"><option value="ETH"><option value="SOL"><option value="BNB">
      <option value="XRP"><option value="ADA"><option value="DOGE"><option value="AVAX">
      <option value="MATIC"><option value="LINK"><option value="LTC"><option value="DOT">
      <option value="SHIB"><option value="UNI"><option value="ATOM"><option value="NEAR">
      <option value="APT"><option value="OP"><option value="ARB"><option value="SUI">
    </datalist>
    <datalist id="mktStockList">
      <option value="AAPL"><option value="TSLA"><option value="NVDA"><option value="MSFT">
      <option value="AMZN"><option value="GOOGL"><option value="META"><option value="NFLX">
      <option value="AMD"><option value="INTC"><option value="COIN"><option value="HOOD">
      <option value="PLTR"><option value="SOFI"><option value="SPY"><option value="QQQ">
      <option value="MSTR"><option value="SMCI"><option value="RIVN"><option value="LCID">
    </datalist>
    <div class="markets-add-row">
      <input class="markets-add-input" id="mktAddInput" placeholder="e.g. BTC" list="mktCryptoList" onkeydown="if(event.key==='Enter')addMarket()">
      <select class="markets-add-select" id="mktAddType" onchange="updateMktSuggestions()">
        <option value="crypto">Crypto</option>
        <option value="stocks">Stock</option>
      </select>
      <button class="markets-add-btn" onclick="addMarket()">Add</button>
    </div>
    <button class="btn-refresh-markets" onclick="loadMarkets()">↻ Refresh</button>`;
  body.innerHTML = html;

  if (cryptoData && layoutMode === 'B') updateStatusBarCrypto(cryptoData);
}

function updateMktSuggestions() {
  const input = $('mktAddInput');
  const type  = $('mktAddType').value;
  input.setAttribute('list', type === 'crypto' ? 'mktCryptoList' : 'mktStockList');
  input.placeholder = type === 'crypto' ? 'e.g. BTC, ETH, SOL' : 'e.g. AAPL, NVDA, TSLA';
  input.value = '';
  input.focus();
}

function addMarket() {
  const input = $('mktAddInput');
  const type  = $('mktAddType').value;
  const val   = input.value.trim().toUpperCase();
  if (!val) return;
  const wl = getMarketWatchlist();
  if (type === 'crypto' && !wl.crypto.includes(val)) wl.crypto.push(val);
  if (type === 'stocks' && !wl.stocks.includes(val)) wl.stocks.push(val);
  saveMarketWatchlist(wl);
  loadMarkets();
}

function removeMarket(type, sym) {
  const wl = getMarketWatchlist();
  wl[type] = wl[type].filter(s => s !== sym);
  saveMarketWatchlist(wl);
  loadMarkets();
}

// ── Status bar ────────────────────────────────────────────────────────────────
let statusBarInterval = null;

function updateStatusBarCrypto(data) {
  // data is RAW format from CryptoCompare: { BTC: { USD: { PRICE, CHANGEPCT24HOUR } } }
  if (data?.BTC?.USD) {
    const d = data.BTC.USD;
    $('sbBtcPrice').textContent = '$' + d.PRICE.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const chg = d.CHANGEPCT24HOUR;
    $('sbBtcChange').textContent = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '';
    $('sbBtcChange').className = 'sb-change ' + (chg >= 0 ? 'up' : 'down');
  }
  if (data?.ETH?.USD) {
    const d = data.ETH.USD;
    $('sbEthPrice').textContent = '$' + d.PRICE.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const chg = d.CHANGEPCT24HOUR;
    $('sbEthChange').textContent = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '';
    $('sbEthChange').className = 'sb-change ' + (chg >= 0 ? 'up' : 'down');
    $('sbEthChange').className = 'sb-change ' + (chg >= 0 ? 'up' : 'down');
  }
}

async function updateStatusBar() {
  // Time
  const now = new Date();
  $('sbTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Crypto
  try {
    const r = await fetch('/api/markets/crypto?syms=BTC,ETH');
    const json = await r.json();
    updateStatusBarCrypto(json?.RAW ?? null);
  } catch {}

  // Email + messages count from dashboard
  try {
    const r = await fetch('/api/dashboard');
    const data = await r.json();
    $('sbEmailCount').textContent = data.emailUnread != null ? data.emailUnread : '—';
    // Update inbox strip badge
    const badge = $('inboxBadge');
    if (badge) {
      if (data.emailUnread > 0) {
        badge.textContent = data.emailUnread > 99 ? '99+' : data.emailUnread;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
    // Update notes/messages badge
    if (typeof setNotesBadge === 'function') setNotesBadge(data.messagesUnread ?? 0);
  } catch { $('sbEmailCount').textContent = '—'; }
}

function startStatusBar() {
  if (statusBarInterval) return;
  updateStatusBar();
  statusBarInterval = setInterval(updateStatusBar, 300000);
  // Also just update the clock every second
  if (!window._clockInterval) {
    window._clockInterval = setInterval(() => {
      $('sbTime').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, 1000);
  }
}

