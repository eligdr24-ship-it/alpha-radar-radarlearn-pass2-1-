// Turns raw stored snapshot points into ordered series + synthetic bars, and
// classifies how much history exists (warmup tier). Pure functions.

const HOUR = 3600e3, DAY = 24 * HOUR;
export const BAR_MS = { scalp: 5 * 60e3, day: HOUR, swing: 4 * HOUR };
export const tierRank = { T0: 0, T1: 1, T2: 2, T3: 3 };

// points: [{ at, price, volume24hUsd, liquidityUsd, change24h }]
export function buildSeries(points) {
  const sorted = [...points].sort((a, b) => +new Date(a.at) - +new Date(b.at));
  return {
    at: sorted.map((p) => +new Date(p.at)),
    price: sorted.map((p) => Number(p.price)),
    volume: sorted.map((p) => Number(p.volume24hUsd)),
    liquidity: sorted.map((p) => Number(p.liquidityUsd)),
    change24h: sorted.map((p) => Number(p.change24h)),
    n: sorted.length,
    spanMs: sorted.length ? +new Date(sorted[sorted.length - 1].at) - +new Date(sorted[0].at) : 0,
  };
}

// Resample the price series into fixed-width buckets → synthetic OHLCV bars.
export function synthBars(series, barMs) {
  const buckets = new Map();
  for (let i = 0; i < series.n; i++) {
    const key = Math.floor(series.at[i] / barMs);
    const px = series.price[i];
    const b = buckets.get(key);
    if (!b) buckets.set(key, { key, open: px, high: px, low: px, close: px, volume: series.volume[i], count: 1, at: series.at[i] });
    else { b.high = Math.max(b.high, px); b.low = Math.min(b.low, px); b.close = px; b.volume = series.volume[i]; b.count++; b.at = series.at[i]; }
  }
  const bars = [...buckets.values()].sort((a, b) => a.key - b.key);
  return {
    open: bars.map((b) => b.open), high: bars.map((b) => b.high), low: bars.map((b) => b.low),
    close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
    count: bars.map((b) => b.count), at: bars.map((b) => b.at), n: bars.length,
  };
}

export function historyTier(series) {
  const span = series.spanMs;
  let tier = 'T0';
  if (span >= 30 * DAY) tier = 'T3';
  else if (span >= 7 * DAY) tier = 'T2';
  else if (span >= DAY) tier = 'T1';
  return { tier, rank: tierRank[tier], spanMs: span, spanHours: +(span / HOUR).toFixed(1), points: series.n };
}
