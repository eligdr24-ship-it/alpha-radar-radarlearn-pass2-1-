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

export async function getMacroAssets() {
  // Live macro quotes require a finance API key. The app exposes env-ready fields and safe fallback values.
  const fearGreed = await getFearGreed();
  return {
    ...fallbackMacro,
    fearGreed,
    macroSource: enabled('TWELVEDATA_API_KEY') || enabled('POLYGON_API_KEY') ? 'configured-live-ready' : 'mock-macro-with-live-fear-greed',
    configured: {
      twelveData: enabled('TWELVEDATA_API_KEY'),
      polygon: enabled('POLYGON_API_KEY'),
      fred: enabled('FRED_API_KEY')
    }
  };
}
