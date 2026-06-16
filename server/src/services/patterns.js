// Pattern Library (v5.1) — pure, dependency-free helpers.
// No DB, no scoring changes. Safe to unit test in isolation.

export const LABEL_RANK = { fail: 0, invalidated: 0, target1: 1, target2: 2, stretch: 3 };
const SHORT = { mode: 'mode', direction: 'dir', history_class: 'hist', setup_type: 'type', market_regime: 'regime', narrative: 'narr' };
const LEVELS = [
  { level: 0, use: ['mode', 'direction'] },
  { level: 1, use: ['mode', 'direction', 'history_class'] },
  { level: 2, use: ['mode', 'direction', 'history_class', 'setup_type'] },
  { level: 3, use: ['mode', 'direction', 'history_class', 'setup_type', 'market_regime'] },
  { level: 4, use: ['mode', 'direction', 'history_class', 'setup_type', 'market_regime', 'narrative'] },
];
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
const norm = (v) => (v == null || v === '' ? null : String(v));

export function patternName(dims) {
  const p = [];
  if (dims.mode) p.push(cap(dims.mode));
  if (dims.direction) p.push(cap(String(dims.direction).toLowerCase()));
  if (dims.history_class) p.push(cap(dims.history_class) + '-hist');
  if (dims.setup_type) p.push(cap(dims.setup_type));
  if (dims.market_regime) p.push(String(dims.market_regime).replace(/_/g, ' '));
  if (dims.narrative) p.push(dims.narrative);
  return p.join(' · ');
}

// Hierarchical pattern keys L0..L4. Always returns L0 (mode+direction are mandatory);
// deeper levels only while their dimension is present. Each entry's parent is the prior one.
export function patternKeysFor(setup) {
  const out = [];
  for (const L of LEVELS) {
    const dims = {};
    let ok = true;
    for (const k of L.use) { const v = norm(setup[k]); if (v == null) { ok = false; break; } dims[k] = v; }
    if (!ok) break;
    const key = `L${L.level}|` + L.use.map((k) => `${SHORT[k]}=${dims[k]}`).join('|');
    out.push({ level: L.level, key, name: patternName(dims), dims });
  }
  return out;
}

// Wilson score interval lower bound (default 95%, z=1.96).
export function wilsonLowerBound(wins, n, z = 1.96) {
  if (!n || n <= 0) return 0;
  const p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / denom));
}

// Empirical-Bayes shrinkage of a rate toward a prior (parent pattern rate).
export function shrink(rate, n, priorRate, k = 10) {
  const prior = priorRate == null ? 0.5 : priorRate;
  if (!n || n <= 0) return prior;
  return (n * rate + k * prior) / (n + k);
}

// Per-setup result from its outcomes (ordering-correct via success_label).
export function setupResult(outcomes) {
  const ocs = outcomes || [];
  const bestRank = ocs.reduce((m, o) => Math.max(m, LABEL_RANK[o.success_label] ?? 0), 0);
  const resolved = ocs.length > 0;
  const best = ocs.slice().sort((a, b) => (LABEL_RANK[b.success_label] ?? 0) - (LABEL_RANK[a.success_label] ?? 0))[0] || null;
  return {
    resolved,
    win: bestRank >= 1,
    loss: resolved && bestRank < 1,
    bestRank,
    reachedT1: bestRank >= 1, reachedT2: bestRank >= 2, reachedStretch: bestRank >= 3,
    hitInv: ocs.some((o) => o.hit_invalidation),
    finalReturn: best && best.final_return != null ? Number(best.final_return) : null,
    maxAdverse: best && best.max_adverse_excursion != null ? Number(best.max_adverse_excursion) : null,
  };
}

// Reward:risk from setup levels (entry / target1 / invalidation).
export function rrOf(s) {
  if (!s) return null;
  const reward = Math.abs((s.target1 ?? 0) - (s.entry_price ?? 0));
  const risk = Math.abs((s.entry_price ?? 0) - (s.invalidation ?? 0));
  if (!risk) return null;
  return reward / risk;
}

export function classifyTrend(rollingLb, allTimeLb, rollingN, { delta = 0.05, minN = 8 } = {}) {
  if (rollingLb == null || allTimeLb == null || (rollingN || 0) < minN) return 'stable';
  if (rollingLb - allTimeLb >= delta) return 'improving';
  if (rollingLb - allTimeLb <= -delta) return 'declining';
  return 'stable';
}

// Display-only recommended confidence nudge from a shrunk win rate (NOT applied in v5.1).
export function recommendedConfAdj(shrunkRate, baseline = 0.5, capPts = 8) {
  if (shrunkRate == null) return 0;
  const adj = (shrunkRate - baseline) * 2 * capPts; // ±cap at 0/1
  return Math.round(Math.max(-capPts, Math.min(capPts, adj)));
}

// Composite Pattern Strength 0..100 from: Wilson win rate, sample size, trend,
// stability (low invalidation), avg return, drawdown. All sub-scores in 0..1.
export function patternStrength({ win_rate_lb, sample_size, trend, invalidation_rate, avg_return, avg_drawdown } = {}) {
  const winS = clamp01(win_rate_lb ?? 0);
  const sampleS = clamp01((sample_size ?? 0) / ((sample_size ?? 0) + 20)); // saturating
  const trendS = trend === 'improving' ? 1 : trend === 'declining' ? 0 : 0.5;
  const stabilityS = clamp01(1 - (invalidation_rate ?? 0));
  const returnS = sigmoid((avg_return ?? 0) / 0.05); // +5% ~ strong
  const drawdownS = clamp01(1 - Math.min(1, Math.abs(avg_drawdown ?? 0) / 0.15)); // -15% MAE ~ worst
  const score = 0.40 * winS + 0.20 * sampleS + 0.15 * returnS + 0.10 * trendS + 0.10 * stabilityS + 0.05 * drawdownS;
  return Math.round(clamp01(score) * 100);
}

// Regime memory: from per-regime tallies pick best/worst by Wilson LB (min sample).
export function regimeMemory(regimeTallies, { minN = 4 } = {}) {
  const breakdown = {};
  let best = null, worst = null;
  for (const [regime, t] of Object.entries(regimeTallies || {})) {
    const n = t.n || 0, wins = t.wins || 0;
    const win_rate = n ? wins / n : null;
    const win_rate_lb = wilsonLowerBound(wins, n);
    breakdown[regime] = { n, wins, win_rate, win_rate_lb };
    if (n < minN) continue;
    if (!best || win_rate_lb > best.win_rate_lb) best = { regime, win_rate, win_rate_lb, n };
    if (!worst || win_rate_lb < worst.win_rate_lb) worst = { regime, win_rate, win_rate_lb, n };
  }
  if (best && worst && best.regime === worst.regime) worst = null; // only one qualifying regime
  return { breakdown, best, worst };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
