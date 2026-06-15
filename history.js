// Binance klines fetcher with backward-to-earliest pagination.
// Pure parseKlines() is tested; backfillBinance() paginates (injectable fetch).
import { fetchJson } from '../../lib/http.js';
import { createLimiter } from '../../lib/limiter.js';

const limiter = createLimiter({ minGapMs: 500, maxConcurrent: 2 });
const INTERVAL = { '1d': '1d', '4h': '4h', '1h': '1h' };

export function parseKlines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((k) => ({
    ts: new Date(k[0]).toISOString(),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[7] ?? k[5]),
  })).filter((c) => Number.isFinite(c.close));
}

// Paginate forward from `sinceMs` (0 = listing) to now, 1000 candles/page.
export async function backfillBinance({ symbol, timeframe = '1d', sinceMs = 0, fetchImpl, maxPages = 200 }) {
  const interval = INTERVAL[timeframe] || '1d';
  const pair = `${symbol.toUpperCase()}USDT`;
  const fetchPage = fetchImpl || (async (startTime) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${startTime}&limit=1000`;
    return parseKlines(await fetchJson(url, { limiter, retries: 2, timeoutMs: 12000 }));
  });

  const all = [];
  let startTime = sinceMs;
  for (let page = 0; page < maxPages; page++) {
    const candles = await fetchPage(startTime);
    if (!candles.length) break;
    all.push(...candles);
    const lastTs = +new Date(candles[candles.length - 1].ts);
    if (candles.length < 1000 || lastTs >= Date.now() - (TF_MS(timeframe))) break; // caught up
    startTime = lastTs + 1;
  }
  // de-dupe by ts (idempotent stitching)
  const seen = new Set();
  return all.filter((c) => (seen.has(c.ts) ? false : seen.add(c.ts)));
}

function TF_MS(tf) { return { '1d': 86400e3, '4h': 4 * 3600e3, '1h': 3600e3 }[tf] || 86400e3; }
