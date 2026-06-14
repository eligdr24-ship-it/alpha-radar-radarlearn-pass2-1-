// CoinGecko full-history (days=max). Daily close + volume (OHLC partial — CG free
// OHLC is ≤365d, so we mark notes='ohlc_partial').
import { fetchJson } from '../../lib/http.js';
import { createLimiter } from '../../lib/limiter.js';
const limiter = createLimiter({ minGapMs: 1500, maxConcurrent: 1 });

// Small built-in symbol→id map for majors; extend or pass id explicitly.
export const CG_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', LINK: 'chainlink', SUI: 'sui', DOGE: 'dogecoin', WIF: 'dogwifcoin', SEI: 'sei-network', JUP: 'jupiter-exchange-solana', PEPE: 'pepe' };

export function parseMarketChart(data) {
  if (!data || !Array.isArray(data.prices)) return [];
  const vol = new Map((data.total_volumes || []).map(([t, v]) => [t, v]));
  return data.prices.map(([t, price]) => ({
    ts: new Date(t).toISOString(), open: null, high: null, low: null, close: Number(price), volume: Number(vol.get(t) ?? 0),
  })).filter((c) => Number.isFinite(c.close));
}

export async function backfillCoinGecko({ symbol, id, fetchImpl }) {
  const coinId = id || CG_IDS[symbol.toUpperCase()];
  if (!coinId) return { candles: [], notes: 'no-coingecko-id' };
  const fetcher = fetchImpl || (async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=max&interval=daily`;
    return parseMarketChart(await fetchJson(url, { limiter, retries: 2, timeoutMs: 15000 }));
  });
  return { candles: await fetcher(), notes: 'ohlc_partial' };
}
