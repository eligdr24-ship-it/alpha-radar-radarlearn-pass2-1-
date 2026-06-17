// Step 1: Build the dynamic scan universe from live sources, with fallbacks.
// Strategy: CoinGecko top-by-marketcap (1 batched call) -> Binance 24h tickers
// -> mock. Output is normalized so the scoring engine works unchanged.
import { fetchJson } from '../lib/http.js';
import { createLimiter } from '../lib/limiter.js';
import { coins as mockCoins } from '../data/coins.js';
import { applyRobinhoodUniverse, ROBINHOOD_ONLY, UNIVERSE_LABEL } from '../config/robinhoodUniverse.js';

const cgLimiter = createLimiter({ minGapMs: 1500, maxConcurrent: 1 }); // CoinGecko free tier is strict
const bnLimiter = createLimiter({ minGapMs: 500, maxConcurrent: 2 });

const UNIVERSE_SIZE = Math.min(Number(process.env.UNIVERSE_SIZE || 100), 250);

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'USDE', 'BUSD', 'USDD', 'PYUSD']);
const MAJORS = new Set(['BTC', 'ETH']);
const MEMES = new Set(['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'BRETT', 'POPCAT', 'MEW', 'TURBO']);
const SECTORS = { SOL: 'Solana L1', JUP: 'Solana Ecosystem', JTO: 'Solana Ecosystem', LINK: 'Oracle', SUI: 'Layer 1', SEI: 'Layer 1', AVAX: 'Layer 1' };

function classify(symbol, marketCapUsd, change24h) {
  if (MAJORS.has(symbol)) return 'major';
  if (MEMES.has(symbol)) return 'meme';
  if ((marketCapUsd && marketCapUsd < 3e8) || Math.abs(change24h || 0) > 18) return 'emerging';
  if (marketCapUsd && marketCapUsd > 5e9) return 'large-alt';
  return 'alt';
}
const sectorFor = (s) => SECTORS[s] || 'Crypto';

function normalize({ symbol, name, price, change24h, marketCapUsd, volume24hUsd, liquidityUsd, source }) {
  const sym = String(symbol).toUpperCase();
  return {
    symbol: sym,
    name: name || sym,
    price: Number(price) || 0,
    change24h: Number(change24h) || 0,
    marketCapUsd: Number(marketCapUsd) || 0,
    volume24hUsd: Number(volume24hUsd) || 0,
    liquidityUsd: Number(liquidityUsd ?? volume24hUsd) || 0, // CEX proxy: depth ~ volume
    type: classify(sym, Number(marketCapUsd) || 0, Number(change24h) || 0),
    sector: sectorFor(sym),
    source,
    updatedAt: Date.now(),
  };
}

async function fromCoinGecko() {
  // Public CoinGecko throttles datacenter IPs; a free "demo" key lifts that.
  const base = process.env.COINGECKO_BASE_URL || (process.env.COINGECKO_API_KEY ? 'https://api.coingecko.com' : 'https://api.coingecko.com');
  const url = `${base}/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${UNIVERSE_SIZE}&page=1&sparkline=false&price_change_percentage=24h`;
  const headers = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
  const data = await fetchJson(url, { limiter: cgLimiter, retries: 2, timeoutMs: 12000, headers });
  if (!Array.isArray(data)) throw new Error('coingecko: bad payload');
  return data.map((c) => normalize({
    symbol: c.symbol, name: c.name, price: c.current_price,
    change24h: c.price_change_percentage_24h, marketCapUsd: c.market_cap,
    volume24hUsd: c.total_volume, source: 'coingecko',
  }));
}

async function fromBinance() {
  // api.binance.com returns HTTP 451 from US/datacenter IPs (e.g. Render). The
  // public market-data host data-api.binance.vision is not geo-blocked.
  const base = process.env.BINANCE_BASE_URL || 'https://data-api.binance.vision';
  const data = await fetchJson(`${base}/api/v3/ticker/24hr`, { limiter: bnLimiter, retries: 1, timeoutMs: 12000 });
  if (!Array.isArray(data)) throw new Error('binance: bad payload');
  return data
    .filter((t) => t.symbol.endsWith('USDT') && Number(t.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, UNIVERSE_SIZE)
    .map((t) => normalize({
      symbol: t.symbol.replace('USDT', ''), name: t.symbol.replace('USDT', ''),
      price: t.lastPrice, change24h: t.priceChangePercent,
      marketCapUsd: 0, volume24hUsd: t.quoteVolume, source: 'binance',
    }));
}

function fromMock() {
  return mockCoins.map((c) => normalize({
    symbol: c.symbol, name: c.name, price: c.price, change24h: c.change24h,
    // parse the human strings in mock data back into numbers for filtering
    marketCapUsd: parseHuman(c.marketCap), volume24hUsd: parseHuman(c.volume24h),
    source: 'mock',
  }));
}
function parseHuman(s) {
  if (!s) return 0;
  const m = String(s).replace('$', '').match(/([\d.]+)\s*([TBMK]?)/i);
  if (!m) return 0;
  const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

// CoinGecko free tier caps at 10k calls/month, so we refresh its market-cap
// snapshot only periodically and let Binance (no monthly cap) carry every scan.
let cgCache = null; // { at, coins }
const CG_REFRESH_MS = Math.max(60e3, Number(process.env.COINGECKO_REFRESH_MS || 15 * 60e3));

// Assign a market-cap rank (1 = largest) used by the Universe selector.
function rankCoins(coins) {
  [...coins].sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0)).forEach((c, i) => { c.marketCapRank = i + 1; });
  return coins;
}

// Returns { source, coins, errors:[] } — never throws.
export async function buildUniverse() {
  const errors = [];

  // Refresh the CoinGecko snapshot at most once per CG_REFRESH_MS (used for
  // market-cap enrichment + as a fallback). Reuses the cache otherwise.
  if (!cgCache || Date.now() - cgCache.at > CG_REFRESH_MS) {
    try { const c = await fromCoinGecko(); if (c.length) cgCache = { at: Date.now(), coins: c }; }
    catch (err) { errors.push(`coingecko: ${err.message}`); }
  }
  const cg = cgCache?.coins || null;

  // Primary: Binance live prices every scan, enriched with CoinGecko market caps
  // (so type classification / market-cap filters still work).
  try {
    let coins = await fromBinance();
    if (coins.length) {
      if (cg) {
        const m = new Map(cg.map((c) => [c.symbol, c]));
        coins = coins.map((c) => {
          const g = m.get(c.symbol);
          if (!g) return c;
          const marketCapUsd = g.marketCapUsd || c.marketCapUsd;
          return { ...c, name: g.name || c.name, marketCapUsd, type: classify(c.symbol, marketCapUsd, c.change24h), sector: g.sector || c.sector };
        });
      }
      return { source: 'binance-live', coins: rankCoins(applyRobinhoodUniverse(coins)), errors, filter: ROBINHOOD_ONLY ? 'robinhood' : 'full', label: UNIVERSE_LABEL };
    }
  } catch (err) { errors.push(`binance: ${err.message}`); }

  // Fallback: CoinGecko snapshot (possibly cached) if Binance is unavailable.
  if (cg) return { source: 'coingecko-live', coins: rankCoins(applyRobinhoodUniverse(cg)), errors, filter: ROBINHOOD_ONLY ? 'robinhood' : 'full', label: UNIVERSE_LABEL };
  return { source: 'mock-fallback', coins: rankCoins(applyRobinhoodUniverse(fromMock())), errors, filter: ROBINHOOD_ONLY ? 'robinhood' : 'full', label: UNIVERSE_LABEL };
}
