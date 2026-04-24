/**
 * Markets plugin — Crypto (CryptoCompare with CoinGecko fallback) and Stock (Yahoo Finance) proxies
 * Handles GET /api/markets/crypto and GET /api/markets/stock/:ticker
 */

// Symbol → CoinGecko ID map (covers the datalist suggestions in markets.js + a few extras)
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2',
  MATIC: 'matic-network', LINK: 'chainlink', LTC: 'litecoin', DOT: 'polkadot',
  SHIB: 'shiba-inu', UNI: 'uniswap', ATOM: 'cosmos', NEAR: 'near',
  APT: 'aptos', OP: 'optimism', ARB: 'arbitrum', SUI: 'sui',
  TRX: 'tron', TON: 'the-open-network', BCH: 'bitcoin-cash', XLM: 'stellar',
  ETC: 'ethereum-classic', FIL: 'filecoin', HBAR: 'hedera-hashgraph', ICP: 'internet-computer',
  PEPE: 'pepe', WIF: 'dogwifcoin', BONK: 'bonk',
};

async function fetchCoinGecko(symList) {
  const pairs = symList.map(s => [s.toUpperCase(), COINGECKO_IDS[s.toUpperCase()] ?? s.toLowerCase()]);
  const ids = pairs.map(p => p[1]).join(',');
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await r.json();
  // Transform to CryptoCompare RAW shape: { RAW: { SYM: { USD: { PRICE, CHANGEPCT24HOUR } } } }
  const RAW = {};
  for (const [sym, id] of pairs) {
    const d = data?.[id];
    if (d && typeof d.usd === 'number') {
      RAW[sym] = { USD: { PRICE: d.usd, CHANGEPCT24HOUR: d.usd_24h_change ?? 0 } };
    }
  }
  return { RAW };
}

export async function handleRequest(req, res) {
  if (req.method !== 'GET') return false;

  if (req.url.startsWith('/api/markets/crypto')) {
    const symsParam = new URL(req.url, 'http://x').searchParams.get('syms') ?? '';
    const symList = symsParam.split(',').map(s => s.trim()).filter(Boolean);
    try {
      // Try CryptoCompare first
      const r = await fetch(
        `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${symsParam}&tsyms=USD`,
        { signal: AbortSignal.timeout(8000) }
      );
      const data = await r.json();
      // Detect rate-limit / error responses (no RAW field, or Response: "Error")
      if (data?.RAW && Object.keys(data.RAW).length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return true;
      }
      // Fall through to CoinGecko
      throw new Error(data?.Message || 'CryptoCompare returned no RAW data');
    } catch (e) {
      // Fallback: CoinGecko
      try {
        const data = await fetchCoinGecko(symList);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e2) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `CryptoCompare: ${e.message}; CoinGecko: ${e2.message}` }));
      }
    }
    return true;
  }

  if (req.url.startsWith('/api/markets/stock/')) {
    const ticker = req.url.split('/api/markets/stock/')[1]?.split('?')[0];
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  return false;
}
