import { macro as fallbackMacro } from '../data/coins.js';

const timeoutMsDefault = 10000;

export async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || timeoutMsDefault;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function enabled(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim() !== '');
}

export async function getDexScreenerTrending() {
  try {
    const data = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=solana%20meme');
    const pairs = Array.isArray(data?.pairs) ? data.pairs.slice(0, 12) : [];
    return pairs.map((p) => ({
      symbol: p.baseToken?.symbol || 'DEX',
      name: p.baseToken?.name || 'Emerging token',
      chain: p.chainId || 'unknown',
      priceUsd: Number(p.priceUsd || 0),
      volume24h: Number(p.volume?.h24 || 0),
      liquidityUsd: Number(p.liquidity?.usd || 0),
      change24h: Number(p.priceChange?.h24 || 0),
      source: 'dexscreener'
    })).filter(x => x.volume24h > 0);
  } catch (err) {
    return [];
  }
}

export async function getGeckoTerminalTrending() {
  try {
    const data = await fetchJson('https://api.geckoterminal.com/api/v2/networks/trending_pools');
    const rows = data?.data || [];
    return rows.slice(0, 12).map((row) => ({
      symbol: row.attributes?.name?.split(' / ')?.[0] || 'POOL',
      name: row.attributes?.name || 'Trending pool',
      chain: row.relationships?.network?.data?.id || 'multi-chain',
      priceUsd: Number(row.attributes?.base_token_price_usd || 0),
      volume24h: Number(row.attributes?.volume_usd?.h24 || 0),
      liquidityUsd: Number(row.attributes?.reserve_in_usd || 0),
      change24h: Number(row.attributes?.price_change_percentage?.h24 || 0),
      source: 'geckoterminal'
    })).filter(x => x.volume24h > 0);
  } catch (err) {
    return [];
  }
}

export async function getFearGreed() {
  try {
    const data = await fetchJson('https://api.alternative.me/fng/?limit=1');
    return Number(data?.data?.[0]?.value || fallbackMacro.fearGreed);
  } catch {
    return fallbackMacro.fearGreed;
  }
}

export async function getCoinGlassLite() {
  if (!enabled('COINGLASS_API_KEY')) return { enabled: false, source: 'not-configured' };
  try {
    // CoinGlass endpoints vary by plan. This connector is intentionally isolated so one URL can be changed without touching scoring.
    const base = process.env.COINGLASS_BASE_URL || 'https://open-api-v4.coinglass.com';
    const data = await fetchJson(`${base}/api/futures/openInterest/ohlc-history?exchange=Binance&symbol=BTCUSDT&interval=1h&limit=24`, {
      headers: { 'CG-API-KEY': process.env.COINGLASS_API_KEY }
    });
    return { enabled: true, source: 'coinglass', sample: data?.data || data };
  } catch (err) {
    return { enabled: true, source: 'coinglass-error', error: err.message };
  }
}

export async function getRedditLite() {
  // Public JSON endpoint works for lightweight MVP sentiment. OAuth can be added later for production limits.
  try {
    const subs = ['CryptoCurrency', 'Bitcoin', 'solana', 'CryptoMoonShots'];
    const results = [];
    for (const sub of subs) {
      const data = await fetchJson(`https://www.reddit.com/r/${sub}/hot.json?limit=10`, { timeoutMs: 8000 });
      const posts = data?.data?.children || [];
      const score = posts.reduce((sum, p) => sum + Number(p.data?.score || 0), 0);
      results.push({ source: `r/${sub}`, posts: posts.length, engagement: score });
    }
    return { enabled: true, source: 'reddit-public-json', communities: results };
  } catch (err) {
    return { enabled: false, source: 'reddit-error', error: err.message };
  }
}

// Live macro quotes from Stooq (free, no key, CSV). Per-asset fallback to mock
// so a single bad ticker never blanks the board. Daily open→close % change.
const MACRO_TICKERS = [
  { label: 'Gold', t: 'xauusd' },
  { label: 'VIX', t: '^vix' },
  { label: 'DXY', t: '^dxy' },
  { label: 'NASDAQ', t: '^ndq' },
];

export function parseStooqQuotes(csv) {
  if (typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const sym = (p[0] || '').toUpperCase(), open = Number(p[3]), close = Number(p[6]);
    if (!sym || p[6] === 'N/D' || !Number.isFinite(close)) continue;
    const change = Number.isFinite(open) && open ? Number((((close - open) / open) * 100).toFixed(2)) : 0;
    out.push({ symbol: sym, value: close, change });
  }
  return out;
}

async function getLiveMacro() {
  const base = process.env.MACRO_QUOTE_URL || 'https://stooq.com/q/l/';
  const syms = MACRO_TICKERS.map((m) => m.t).join('+');
  const url = `${base}?s=${encodeURIComponent(syms)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const rows = parseStooqQuotes(await res.text());
  const bySym = new Map(rows.map((r) => [r.symbol, r]));
  const round = (n) => (n >= 1000 ? Math.round(n) : Math.round(n * 100) / 100);
  const assets = MACRO_TICKERS.map((m) => {
    const r = bySym.get(m.t.toUpperCase());
    const fb = fallbackMacro.assets.find((a) => a.label === m.label) || { label: m.label, bias: 'neutral' };
    return r ? { label: m.label, value: round(r.value), change: r.change, bias: fb.bias, live: true } : { ...fb, live: false };
  });
  return { assets, liveCount: assets.filter((a) => a.live).length };
}

export async function getMacroAssets() {
  const fearGreed = await getFearGreed();
  let assets = fallbackMacro.assets.map((a) => ({ ...a, live: false }));
  let macroSource = 'mock';
  try {
    const live = await getLiveMacro();
    if (live.liveCount > 0) {
      assets = live.assets;
      macroSource = live.liveCount === assets.length ? 'live:stooq' : `partial:stooq(${live.liveCount}/${assets.length})`;
    }
  } catch { /* keep clearly-labeled mock */ }
  const marketTemperature = fearGreed != null ? fearGreed : fallbackMacro.marketTemperature;
  return {
    ...fallbackMacro, assets, fearGreed, marketTemperature, macroSource,
    macroLive: macroSource.startsWith('live'),
    configured: { twelveData: enabled('TWELVEDATA_API_KEY'), polygon: enabled('POLYGON_API_KEY'), fred: enabled('FRED_API_KEY') },
  };
}
