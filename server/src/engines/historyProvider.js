// Picks the best available bar series for scoring: real candles (deep, real OHLC)
// for long/medium assets → synthetic bars from snapshots → warmup. Returns
// prebuilt bars + series + depth metadata for scoreCoinV2.
import * as store from '../db/store.js';
import { buildSeries, synthBars, BAR_MS } from './history.js';

const TF_BY_MODE = { scalp: '1h', day: '1h', swing: '4h' };
const MIN_CANDLE_BARS = 30;

function candlesToBars(c) {
  return {
    open: c.map((x) => Number(x.open ?? x.close)), high: c.map((x) => Number(x.high ?? x.close)),
    low: c.map((x) => Number(x.low ?? x.close)), close: c.map((x) => Number(x.close)),
    volume: c.map((x) => Number(x.volume ?? 0)), count: c.map(() => 1), at: c.map((x) => +new Date(x.ts)), n: c.length,
  };
}
function candlesToSeries(c) {
  const at = c.map((x) => +new Date(x.ts));
  return {
    at, price: c.map((x) => Number(x.close)), volume: c.map((x) => Number(x.volume ?? 0)),
    liquidity: c.map((x) => Number(x.volume ?? 0)), change24h: c.map(() => 0),
    n: c.length, spanMs: c.length ? at[at.length - 1] - at[0] : 0,
  };
}

// Returns { bars, series, depthMeta, sourceKind } for (symbol, mode).
export async function getScoringInput(symbol, mode, snapshotPoints = [], profile = null) {
  const useCandles = profile && (profile.history_class === 'long' || profile.history_class === 'medium');
  if (useCandles) {
    const tf = TF_BY_MODE[mode] || '1h';
    let candles = [];
    try { candles = await store.getCandles(symbol, tf, 700); } catch { candles = []; }
    if (candles.length >= MIN_CANDLE_BARS) {
      return {
        bars: candlesToBars(candles), series: candlesToSeries(candles),
        depthMeta: { depth_score: profile.depth_score, history_class: profile.history_class },
        sourceKind: `candles:${tf}`,
      };
    }
  }
  const series = buildSeries(snapshotPoints);
  return {
    bars: synthBars(series, BAR_MS[mode] || BAR_MS.day), series,
    depthMeta: profile ? { depth_score: profile.depth_score, history_class: profile.history_class } : null,
    sourceKind: 'snapshots',
  };
}
