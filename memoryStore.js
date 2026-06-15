// Pure, side-effect-free technical indicators.
// Convention: each rolling function returns an array aligned to the input
// length, left-padded with `null` until enough data exists. Use last() to read
// the most recent value. Everything here is unit-tested in indicators.test.js.

export const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
export const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // seed with SMA of first `period`
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing (RMA) — used by ATR, RSI, ADX.
function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j];
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period); // population stdev
  }
  return out;
}

export function logReturns(prices) {
  const out = [null];
  for (let i = 1; i < prices.length; i++) {
    out.push(prices[i - 1] > 0 ? Math.log(prices[i] / prices[i - 1]) : 0);
  }
  return out;
}

// Realized volatility = stdev of log returns over `period`, as a fraction.
export function realizedVol(prices, period) {
  const r = logReturns(prices).map((x) => (x == null ? 0 : x));
  const sd = stdev(r.slice(1), period); // drop the leading null
  const out = new Array(prices.length).fill(null);
  for (let i = 0; i < sd.length; i++) out[i + 1] = sd[i];
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const upper = [], lower = [], width = [];
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null || sd[i] == null) { upper[i] = lower[i] = width[i] = null; continue; }
    upper[i] = mid[i] + mult * sd[i];
    lower[i] = mid[i] - mult * sd[i];
    width[i] = mid[i] !== 0 ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { mid, upper, lower, width };
}

export function trueRange(high, low, close) {
  const out = [high[0] - low[0]];
  for (let i = 1; i < close.length; i++) {
    out.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  return out;
}

// ATR via Wilder smoothing ("ATR-style").
export function atr(high, low, close, period = 14) {
  return rma(trueRange(high, low, close), period);
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  const gains = [], losses = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  for (let i = 0; i < avgGain.length; i++) {
    if (avgGain[i] == null) continue;
    const rs = avgLoss[i] === 0 ? Infinity : avgGain[i] / avgLoss[i];
    out[i + 1] = avgLoss[i] === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalP = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const macdLine = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const compact = macdLine.filter((x) => x != null);
  const sig = ema(compact, signalP);
  // re-align signal to original indices
  const signalLine = new Array(values.length).fill(null);
  let offset = macdLine.findIndex((x) => x != null);
  for (let i = 0; i < sig.length; i++) signalLine[offset + i] = sig[i];
  const hist = values.map((_, i) => (macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null));
  return { macd: macdLine, signal: signalLine, hist };
}

export function adx(high, low, close, period = 14) {
  const len = close.length;
  const tr = trueRange(high, low, close);
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < len; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const atrR = rma(tr, period);
  const plusR = rma(plusDM, period);
  const minusR = rma(minusDM, period);
  const plusDI = [], minusDI = [], dx = [];
  for (let i = 0; i < len; i++) {
    if (atrR[i] == null || atrR[i] === 0) { plusDI[i] = minusDI[i] = dx[i] = null; continue; }
    plusDI[i] = 100 * (plusR[i] / atrR[i]);
    minusDI[i] = 100 * (minusR[i] / atrR[i]);
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(plusDI[i] - minusDI[i]) / sum;
  }
  const dxCompact = dx.filter((x) => x != null);
  const adxC = rma(dxCompact, period);
  const adxLine = new Array(len).fill(null);
  const off = dx.findIndex((x) => x != null);
  for (let i = 0; i < adxC.length; i++) adxLine[off + i] = adxC[i];
  return { adx: adxLine, plusDI, minusDI };
}

// Percentile rank of `value` within `arr` (0..100).
export function percentileRank(arr, value) {
  const xs = arr.filter(isNum);
  if (!xs.length) return null;
  const below = xs.filter((x) => x <= value).length;
  return (below / xs.length) * 100;
}

// Swing pivots: a pivot high at i if high[i] is the max of [i-k, i+k]; mirror for lows.
export function swings(high, low, k = 2) {
  const pivots = [];
  for (let i = k; i < high.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (high[j] >= high[i]) isHigh = false;
      if (low[j] <= low[i]) isLow = false;
    }
    if (isHigh) pivots.push({ index: i, type: 'high', price: high[i] });
    if (isLow) pivots.push({ index: i, type: 'low', price: low[i] });
  }
  return pivots;
}

// Sign of the slope of the last `period` values (for EMA direction).
export function slopeSign(values, lookback = 3) {
  const xs = values.filter(isNum);
  if (xs.length < lookback + 1) return 0;
  const a = xs[xs.length - 1 - lookback], b = xs[xs.length - 1];
  return Math.sign(b - a);
}
