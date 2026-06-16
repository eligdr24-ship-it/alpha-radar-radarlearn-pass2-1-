// Macro history. Default free source: Stooq CSV (long history, no key).
// FRED optional when FRED_API_KEY is set. Returns daily candles.
import { fetchJson } from '../../lib/http.js';

// Stooq tickers for the macro set
export const STOOQ = { 'MACRO:GOLD': 'xauusd', 'MACRO:SPX': '^spx', 'MACRO:NDX': '^ndq', 'MACRO:VIX': '^vix', 'MACRO:DXY': '^dxy' };

export function parseStooqCsv(csv) {
  if (typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  // Stooq sometimes returns a plain-text error (e.g. "Exceeded the daily hits limit")
  // instead of CSV. Bail unless the header looks like an OHLC header.
  if (!/date/i.test(lines[0]) || !/close/i.test(lines[0])) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, open, high, low, close, volume] = lines[i].split(',');
    if (!date || close === undefined || close === 'N/D') continue;
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) continue;          // skip unparseable dates (no crash)
    const c = Number(close);
    if (!Number.isFinite(c)) continue;
    out.push({ ts: d.toISOString(), open: +open || null, high: +high || null, low: +low || null, close: c, volume: +volume || 0 });
  }
  return out;
}

export async function backfillMacro({ asset, fetchImpl }) {
  const ticker = STOOQ[asset];
  if (!ticker) return { candles: [], notes: 'no-macro-ticker' };
  const fetcher = fetchImpl || (async () => {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker)}&i=d`;
    const res = await fetch(url);
    return parseStooqCsv(await res.text());
  });
  return { candles: await fetcher(), notes: 'stooq' };
}
