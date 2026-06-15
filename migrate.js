// Aggregation per §0.6. Combines the 5 signals into long/short scores,
// confidence, conviction and an explainable top-3 "why". Pure.
import { buildSeries, synthBars, historyTier, BAR_MS, tierRank } from './history.js';
import { ALL_SIGNALS } from './signals.js';
import { clamp } from './indicators.js';
import { CONFIDENCE_CEILING } from '../services/provenance.js';

export const WEIGHTS = {
  scalp:  { volatility: 0.10, volume: 0.30, trend: 0.15, momentum: 0.25, breakout: 0.20 },
  day:    { volatility: 0.15, volume: 0.20, trend: 0.25, momentum: 0.25, breakout: 0.15 },
  swing:  { volatility: 0.20, volume: 0.15, trend: 0.30, momentum: 0.20, breakout: 0.15 },
};

const round = (x) => Math.round(x);

// 3rd arg: either raw snapshot points (array, Pass-1 back-compat) OR an input
// object { bars?, series?, points?, depthMeta?, sourceKind? } from historyProvider.
export function scoreCoinV2(coin, mode = 'day', historyOrInput = []) {
  let series, bars, depthMeta = null, sourceKind = 'snapshots';
  if (Array.isArray(historyOrInput)) {
    series = buildSeries(historyOrInput);
    bars = synthBars(series, BAR_MS[mode] || BAR_MS.day);
  } else {
    series = historyOrInput.series || buildSeries(historyOrInput.points || []);
    bars = historyOrInput.bars || synthBars(series, BAR_MS[mode] || BAR_MS.day);
    depthMeta = historyOrInput.depthMeta || null;
    sourceKind = historyOrInput.sourceKind || 'snapshots';
  }
  const tier = historyTier(series);
  const ctx = { mode, change24h: coin.change24h, liquidity: coin.liquidityUsd, price: coin.price, tier: tier.tier };

  const W = WEIGHTS[mode] || WEIGHTS.day;
  const sig = {};
  for (const key of Object.keys(W)) sig[key] = ALL_SIGNALS[key](bars, series, ctx);

  let longRaw = 0, shortRaw = 0, confSum = 0, wSum = 0;
  for (const key of Object.keys(W)) {
    const s = sig[key], w = W[key];
    longRaw += w * s.long * s.confidence;
    shortRaw += w * s.short * s.confidence;
    confSum += w * s.confidence; wSum += w;
  }

  const longScore = clamp(50 + 100 * (longRaw - shortRaw));
  const shortScore = clamp(50 + 100 * (shortRaw - longRaw));
  const direction = longScore >= shortScore ? 'LONG' : 'SHORT';
  const score = Math.max(longScore, shortScore);

  // agreement: weighted share of signals favouring the chosen direction
  let agreeW = 0;
  for (const key of Object.keys(W)) {
    const s = sig[key];
    const favours = direction === 'LONG' ? s.long > s.short : s.short > s.long;
    if (favours) agreeW += W[key];
  }
  const agreement = wSum ? agreeW / wSum : 0;
  const liquidityFactor = sig.breakout?.detail?.liquidityFactor ?? 0.5;
  const avgConf = wSum ? confSum / wSum : 0;
  let confidence = clamp(avgConf * (0.6 + 0.4 * agreement) * (0.5 + 0.5 * liquidityFactor), 0, 1) * 100;
  // Depth-aware confidence: deeper, cleaner history → higher; capped per class.
  const history_class = depthMeta?.history_class || 'unknown';
  const depth_score = depthMeta?.depth_score ?? null;
  if (depthMeta) {
    const ceiling = (CONFIDENCE_CEILING[history_class] ?? 1) * 100;
    const depthFactor = 0.4 + 0.6 * ((depth_score || 0) / 100);
    confidence = Math.min(confidence * depthFactor, ceiling);
  }

  // signals object for the dashboard bars (0-100 each) + freshness
  const freshness = round(clamp(0.5 * sig.volume.score + 0.5 * sig.volatility.score));
  const signals = {
    volatility: sig.volatility.score, volume: sig.volume.score, trend: sig.trend.score,
    momentum: sig.momentum.score, breakout: sig.breakout.score, freshness,
  };
  const consensus = round(clamp((sig.volatility.score + sig.volume.score + sig.trend.score + sig.momentum.score + sig.breakout.score) / 5));
  const conviction = round(clamp(0.45 * score + 0.25 * confidence + 0.20 * agreement * 100 + 0.10 * freshness));

  // risk: base on type, worsened by thin liquidity / low confidence
  let risk = coin.type === 'meme' ? 'High' : coin.type === 'major' ? 'Low' : 'Medium';
  if (liquidityFactor < 0.3 || confidence < 35) risk = 'High';

  // explainability: top-3 signals by directional contribution
  const contributions = Object.keys(W).map((key) => {
    const s = sig[key];
    return { key, why: s.why, contribution: W[key] * (s.long - s.short) * s.confidence, detail: s.detail };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const why = contributions.slice(0, 3).map((c) => c.why);

  return {
    ...coin,
    engine: 'v2', historyTier: tier.tier, historySpanHours: tier.spanHours, warming: tier.rank < tierRank.T1,
    history_class, depth_score, dataSourceKind: sourceKind,
    signals, signalDetail: sig,
    longScore: round(longScore), shortScore: round(shortScore), direction, score: round(score),
    confidence: round(confidence), consensus, risk, conviction, agreement: Math.round(agreement * 100),
    why,
  };
}
