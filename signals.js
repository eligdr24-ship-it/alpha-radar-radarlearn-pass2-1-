// GeckoTerminal pool OHLCV — best-effort, limited history for DEX-only tokens.
import { fetchJson } from '../../lib/http.js';

export function parseGeckoOhlcv(data) {
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  // [timestamp(s), open, high, low, close, volume]
  return list.map((r) => ({
    ts: new Date(r[0] * 1000).toISOString(), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  })).filter((c) => Number.isFinite(c.close));
}

export async function backfillDex({ network, pool, timeframe = 'day', fetchImpl }) {
  if (!network || !pool) return { candles: [], notes: 'no-pool' };
  const fetcher = fetchImpl || (async () => {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/${timeframe}?limit=1000`;
    return parseGeckoOhlcv(await fetchJson(url, { retries: 1, timeoutMs: 12000 }));
  });
  return { candles: await fetcher(), notes: 'geckoterminal' };
}
