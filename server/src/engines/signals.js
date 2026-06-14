// The five historical signals. Each returns the §0.4 contract:
// { key, score 0-100, long 0-1, short 0-1, confidence 0-1, status, why, detail }
import {
  ema, rsi, macd, adx, bollinger, realizedVol, percentileRank, swings, last, clamp,
} from './indicators.js';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const fmtP = (n) => (n < 0.01 ? n.toExponential(2) : n < 10 ? n.toFixed(3) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

// confidence = base-by-tier × data-sufficiency
function tierConf(ctx, haveBars, needBars, byTier = { T0: 0.25, T1: 0.6, T2: 0.82, T3: 0.95 }) {
  const base = byTier[ctx.tier] ?? 0.5;
  const suff = Math.min(1, haveBars / needBars);
  return clamp(base * (0.5 + 0.5 * suff), 0, 1) / 1;
}
const mk = (key, score, long, short, confidence, status, why, detail) =>
  ({ key, score: Math.round(clamp(score)), long, short, confidence: r2(confidence), status, why, detail });
const neutral = (key, why, conf = 0.25) => mk(key, 50, 0, 0, conf, 'insufficient', why, {});

// 1. Volatility Window
export function volatilitySignal(bars, series, ctx) {
  if (bars.n < 15) return neutral('volatility', 'Warming up — not enough bars for volatility');
  const rv = realizedVol(bars.close, Math.min(14, bars.n - 1));
  const bb = bollinger(bars.close, Math.min(20, bars.n), 2);
  const curRV = last(rv), curBBW = last(bb.width);
  const rvPct = percentileRank(rv, curRV) ?? 50;
  const bbwPct = percentileRank(bb.width, curBBW) ?? 50;
  const compression = 100 - bbwPct;
  const dir = Math.sign(ctx.change24h || 0);
  let long = 0, short = 0;
  const squeeze = compression > 70;
  if (squeeze) { if (dir > 0) long += 0.15; else if (dir < 0) short += 0.15; }
  if (rvPct > 90) { if (dir > 0) short += 0.15; else if (dir < 0) long += 0.15; } // blow-off fade
  const why = squeeze
    ? `Volatility compressed — Bollinger width in the ${Math.round(bbwPct)}th percentile → coiled for a breakout`
    : rvPct > 90 ? `Volatility extreme (${Math.round(rvPct)}th pct) → elevated reversal/blow-off risk`
      : `Volatility mid-range (${Math.round(rvPct)}th pct of recent history)`;
  return mk('volatility', rvPct, long, short, tierConf(ctx, bars.n, 20), ctx.tier === 'T0' ? 'partial' : 'ok', why,
    { realizedVolPct: r2(curRV), volRegimePct: r1(rvPct), bbWidthPct: r1(bbwPct), compression: r1(compression) });
}

// 2. Volume Acceleration
export function volumeSignal(bars, series, ctx) {
  const vols = series.volume.filter(Number.isFinite);
  if (vols.length < 5) return neutral('volume', 'Warming up — not enough volume history');
  const cur = vols[vols.length - 1];
  const base = mean(vols.slice(0, -1));
  const rvol = base > 0 ? cur / base : 1;
  const mu = mean(vols), sd = std(vols);
  const z = sd > 0 ? (cur - mu) / sd : 0;
  const relVolScore = clamp(50 + 25 * Math.log2(Math.max(rvol, 0.01)));
  const dir = Math.sign(ctx.change24h || 0);
  const strength = (relVolScore - 50) / 50;
  let long = 0, short = 0;
  if (dir > 0) long += Math.max(0, strength);
  else if (dir < 0) short += Math.max(0, strength);
  const why = `Volume ${r1(rvol)}× its average (z=${r1(z)}) while price ${dir >= 0 ? 'rose' : 'fell'} ${Math.abs(ctx.change24h || 0).toFixed(1)}% → ${dir >= 0 ? 'buyers' : 'sellers'} in control`;
  return mk('volume', relVolScore, long, short, tierConf(ctx, vols.length, 30), ctx.tier === 'T0' ? 'partial' : 'ok', why,
    { rvol: r2(rvol), z: r2(z), relVolScore: Math.round(relVolScore) });
}

// 3. Trend vs Mean Reversion
export function trendSignal(bars, series, ctx) {
  if (bars.n < 12) return neutral('trend', 'Warming up — not enough bars for trend');
  const price = last(bars.close);
  const E9 = last(ema(bars.close, 9));
  const E21 = last(ema(bars.close, Math.min(21, bars.n - 1)));
  const E50 = last(ema(bars.close, Math.min(50, bars.n - 1)));
  let align = 0;
  if (E9 && E21 && E50) {
    if (E9 > E21 && E21 > E50 && price > E9) align = 1;
    else if (E9 < E21 && E21 < E50 && price < E9) align = -1;
    else align = E9 > E21 ? 0.5 : -0.5;
  } else if (E9 && E21) align = E9 > E21 ? 0.5 : -0.5;
  const piv = swings(bars.high, bars.low, 2);
  const highs = piv.filter((p) => p.type === 'high').slice(-3).map((p) => p.price);
  const lows = piv.filter((p) => p.type === 'low').slice(-3).map((p) => p.price);
  let structure = 0;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1] > highs[0], hl = lows[lows.length - 1] > lows[0];
    const lh = highs[highs.length - 1] < highs[0], ll = lows[lows.length - 1] < lows[0];
    structure = hh && hl ? 1 : lh && ll ? -1 : 0;
  }
  const stretch = E21 ? (price - E21) / E21 : 0;
  const RSI = last(rsi(bars.close, 14)) ?? 50;
  const overbought = RSI > 70, oversold = RSI < 30, stretched = Math.abs(stretch) > 0.06;
  const reversal = clamp((overbought || oversold ? 40 : 0) + (stretched ? 40 : 0) + 20 * Math.min(Math.abs(stretch) / 0.1, 1));
  const trendScore = clamp(50 + 25 * align + 25 * structure);
  const dirStrength = (trendScore - 50) / 50;
  const rf = reversal / 100;
  let long = 0, short = 0;
  if (dirStrength > 0) { long += dirStrength * (1 - 0.6 * rf); if (overbought) short += 0.3 * rf; }
  else if (dirStrength < 0) { short += -dirStrength * (1 - 0.6 * rf); if (oversold) long += 0.3 * rf; }
  const why = `${align > 0 ? 'Bullish' : align < 0 ? 'Bearish' : 'Mixed'} EMA alignment, ${structure > 0 ? 'higher highs/lows' : structure < 0 ? 'lower highs/lows' : 'no clear structure'}; price ${r1(stretch * 100)}% vs EMA21, RSI ${Math.round(RSI)}${overbought ? ' (overbought)' : oversold ? ' (oversold)' : ''}`;
  const conf = tierConf(ctx, bars.n, 50) * (bars.n >= 50 ? 1 : 0.85);
  return mk('trend', trendScore, long, short, conf, bars.n >= 50 ? 'ok' : 'partial', why,
    { emaAlign: align, structure, stretchPct: r2(stretch * 100), rsi: Math.round(RSI), reversalScore: Math.round(reversal) });
}

// 4. Momentum Confirmation
export function momentumSignal(bars, series, ctx) {
  if (bars.n < 15) return neutral('momentum', 'Warming up — not enough bars for momentum');
  const RSI = last(rsi(bars.close, 14)) ?? 50;
  const m = macd(bars.close);
  const hist = last(m.hist);
  const histPrev = m.hist[m.hist.length - 2];
  const { adx: aArr, plusDI, minusDI } = adx(bars.high, bars.low, bars.close, 14);
  const ADX = last(aArr) ?? 0, pdi = last(plusDI) ?? 0, mdi = last(minusDI) ?? 0;
  const ret = (k) => (bars.n > k ? last(bars.close) / bars.close[bars.n - 1 - k] - 1 : 0);
  const windows = [1, 4, 12].map(ret);
  const lastW = windows[windows.length - 1];
  const agree = lastW === 0 ? 0.5 : windows.filter((r) => Math.sign(r) === Math.sign(lastW)).length / windows.length;
  const rsiComp = (RSI - 50) / 50;
  const macdSign = hist == null ? 0 : Math.sign(hist);
  const diComp = pdi + mdi > 0 ? (pdi - mdi) / (pdi + mdi) : 0;
  const adxStrength = clamp(ADX, 0, 50) / 50;
  const dir = 0.4 * rsiComp + 0.3 * macdSign + 0.3 * diComp;
  const momentumScore = clamp(50 + 50 * dir);
  const mag = ((momentumScore - 50) / 50) * (0.5 + 0.5 * adxStrength) * (0.5 + 0.5 * agree);
  let long = 0, short = 0;
  if (mag > 0) long += mag; else short += -mag;
  const bullCross = histPrev != null && hist != null && histPrev <= 0 && hist > 0;
  const bearCross = histPrev != null && hist != null && histPrev >= 0 && hist < 0;
  if (bullCross) long += 0.15; if (bearCross) short += 0.15;
  const why = `RSI ${Math.round(RSI)}, MACD histogram ${hist > 0 ? 'positive' : 'negative'}${bullCross ? ' (bull cross)' : bearCross ? ' (bear cross)' : ''}, ADX ${Math.round(ADX)} ${pdi >= mdi ? '(+DI)' : '(−DI)'} → momentum ${momentumScore >= 50 ? 'up' : 'down'}`;
  const conf = tierConf(ctx, bars.n, 35) * (bars.n >= 35 ? 1 : 0.75);
  return mk('momentum', momentumScore, long, short, conf, bars.n >= 35 ? 'ok' : 'partial', why,
    { rsi: Math.round(RSI), macdHist: hist == null ? null : r2(hist), adx: Math.round(ADX), plusDI: Math.round(pdi), minusDI: Math.round(mdi), windowAgreement: r2(agree) });
}

// 5. Liquidity / Breakout Context
export function breakoutSignal(bars, series, ctx) {
  if (bars.n < 10) return neutral('breakout', 'Warming up — not enough bars for range/breakout');
  const lb = Math.min(bars.n - 1, 48);
  const priorHigh = Math.max(...bars.high.slice(-lb - 1, -1));
  const priorLow = Math.min(...bars.low.slice(-lb - 1, -1));
  const price = last(bars.close);
  const posInRange = priorHigh > priorLow ? clamp((price - priorLow) / (priorHigh - priorLow), 0, 1) : 0.5;
  const upBreak = price > priorHigh, downBreak = price < priorLow;
  const vols = series.volume.filter(Number.isFinite);
  const rvol = vols.length > 5 ? vols[vols.length - 1] / mean(vols.slice(0, -1)) : 1;
  const confirmed = rvol > 1.3;
  const piv = swings(bars.high, bars.low, 2);
  const sLows = piv.filter((p) => p.type === 'low').map((p) => p.price);
  const sHighs = piv.filter((p) => p.type === 'high').map((p) => p.price);
  let reclaim = 0;
  if (sLows.length) { const lvl = sLows[sLows.length - 1]; if (last(bars.low) < lvl && price > lvl) reclaim = 1; }
  if (sHighs.length) { const lvl = sHighs[sHighs.length - 1]; if (last(bars.high) > lvl && price < lvl) reclaim = -1; }
  let breakoutScore = 50 + (posInRange - 0.5) * 40;
  let long = 0, short = 0;
  if (upBreak) { breakoutScore = confirmed ? 90 : 75; long += confirmed ? 0.6 : 0.35; }
  else if (downBreak) { breakoutScore = confirmed ? 10 : 25; short += confirmed ? 0.6 : 0.35; }
  else { if (posInRange > 0.85) short += 0.12; if (posInRange < 0.15) long += 0.12; }
  if (reclaim > 0) { long += 0.4; breakoutScore = Math.max(breakoutScore, 80); }
  if (reclaim < 0) { short += 0.4; breakoutScore = Math.min(breakoutScore, 20); }
  const liq = ctx.liquidity || 0;
  const liquidityFactor = clamp((Math.log10(Math.max(liq, 1)) - 4) / 3, 0, 1); // ~$10k→0 … ~$10M→1
  const why = upBreak ? `Broke range high $${fmtP(priorHigh)}${confirmed ? ` on ${r1(rvol)}× volume` : ''} → breakout long`
    : downBreak ? `Broke range low $${fmtP(priorLow)}${confirmed ? ` on ${r1(rvol)}× volume` : ''} → breakdown short`
      : reclaim > 0 ? `Swept $${fmtP(sLows[sLows.length - 1])} and reclaimed → bullish reversal`
        : reclaim < 0 ? `Swept $${fmtP(sHighs[sHighs.length - 1])} and rejected → bearish reversal`
          : `In range — ${Math.round(posInRange * 100)}% from low to high`;
  const conf = tierConf(ctx, bars.n, 24) * (0.4 + 0.6 * liquidityFactor);
  return mk('breakout', breakoutScore, long, short, conf, ctx.tier === 'T0' ? 'partial' : 'ok', why,
    { rangeHigh: r2(priorHigh), rangeLow: r2(priorLow), posInRange: r2(posInRange), rvol: r2(rvol), reclaim, liquidityFactor: r2(liquidityFactor) });
}

export const ALL_SIGNALS = { volatility: volatilitySignal, volume: volumeSignal, trend: trendSignal, momentum: momentumSignal, breakout: breakoutSignal };
