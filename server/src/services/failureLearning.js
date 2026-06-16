// Failure Learning (v5.2) — pure, deterministic, rule-based classifier.
// No DB, no scoring/ranking changes. Display-only analytics. The caller supplies
// pre-fetched evidence so this stays fully unit-testable. Only LOSSES / EXPIRED
// setups receive a reason (wins and still-open setups return null).

export const CLASSIFIER_VERSION = 'fl-1';

export const FAILURE_REASONS = [
  'failed_to_enter_zone', 'hit_invalidation', 'failed_to_reach_target',
  'market_regime_changed', 'volume_faded', 'btc_reversed', 'macro_risk_off',
  'liquidity_weakness', 'liquidity_trap', 'narrative_reversal',
  'signal_too_early', 'signal_too_late', 'unknown',
];

export const REASON_LABELS = {
  failed_to_enter_zone: 'Never entered the buy/sell zone',
  hit_invalidation: 'Hit stop / invalidation',
  failed_to_reach_target: 'Timed out without reaching a target',
  market_regime_changed: 'Market regime flipped against the trade',
  volume_faded: 'Volume faded after entry',
  btc_reversed: 'BTC reversed against the trade',
  macro_risk_off: 'Macro turned risk-off (VIX / DXY up)',
  liquidity_weakness: 'Thin liquidity at signal',
  liquidity_trap: 'Liquidity trap — lured favorable, then dumped',
  narrative_reversal: 'Narrative / sector reversed',
  signal_too_early: 'Stopped out early — target reached afterwards',
  signal_too_late: 'Signal too late — move was already extended',
  unknown: 'Cause unclear',
};

// Strength ordering: the most *informative* specific cause wins primary; literal
// mechanics (hit_invalidation) stay low so they surface as a secondary unless
// nothing more specific fired.
const STRENGTH = {
  failed_to_enter_zone: 0.95,
  liquidity_trap: 0.90,
  signal_too_early: 0.85,
  market_regime_changed: 0.80,
  macro_risk_off: 0.78,
  narrative_reversal: 0.75,
  signal_too_late: 0.70,
  btc_reversed: 0.68,
  volume_faded: 0.60,
  liquidity_weakness: 0.55,
  hit_invalidation: 0.52,
  failed_to_reach_target: 0.50,
  unknown: 0.30,
};

function firstCrossIdx(path, level, side) {
  if (level == null || !Array.isArray(path)) return -1;
  for (let i = 0; i < path.length; i++) {
    if (side === 'up' && path[i].price >= level) return i;
    if (side === 'down' && path[i].price <= level) return i;
  }
  return -1;
}

// ev = {
//   setup{status,entry_filled_at,direction,entry_price,target1,invalidation,market_regime},
//   result(=patterns.setupResult), pricePath, btcReturn, volPre, volPost,
//   liquidityUsd, volume24hUsd, regimeAtResolve, macroRiskOff, narrativeReturn, preSignalRunupFrac
// }
export function classifyFailure(ev) {
  const e = ev || {};
  const { setup, result } = e;
  if (!setup) return null;
  const isExpired = setup.status === 'expired';
  const isLoss = !!(result && result.loss);
  if (!isExpired && !isLoss) return null;
  const isLong = setup.direction === 'LONG';
  const fired = [];
  const add = (reason, detail = {}) => fired.push({ reason, strength: STRENGTH[reason], detail });

  // 1. never entered (exclusive expired case)
  if (isExpired && !setup.entry_filled_at) add('failed_to_enter_zone');

  // 2. literal stop-out
  if (result && result.hitInv) add('hit_invalidation');

  // 3. liquidity trap: moved favorably toward target, then stopped out on a thin book
  if (result && result.hitInv && setup.entry_price && setup.target1) {
    const t1Move = Math.abs(setup.target1 - setup.entry_price) / setup.entry_price;
    const mfeFrac = t1Move > 0 && result.maxFavorable != null ? Math.abs(result.maxFavorable) / t1Move : null;
    const thin = (e.liquidityUsd != null && e.liquidityUsd > 0 && e.liquidityUsd < 250000)
      || (e.volume24hUsd != null && e.volume24hUsd > 0 && e.volume24hUsd < 1000000);
    if (mfeFrac != null && mfeFrac >= 0.5 && thin) add('liquidity_trap', { mfeFrac, liquidityUsd: e.liquidityUsd ?? null });
  }

  // 4. stopped out, but target reached LATER in the path -> premature exit
  if (result && result.hitInv && Array.isArray(e.pricePath) && e.pricePath.length > 2) {
    const invIdx = firstCrossIdx(e.pricePath, setup.invalidation, isLong ? 'down' : 'up');
    const t1Idx = firstCrossIdx(e.pricePath, setup.target1, isLong ? 'up' : 'down');
    if (invIdx >= 0 && t1Idx > invIdx) add('signal_too_early', { invIdx, t1Idx });
  }

  // 5. regime flipped unfavorably between signal and resolution
  if (e.regimeAtResolve && setup.market_regime && e.regimeAtResolve !== setup.market_regime) {
    const adverse = (isLong && e.regimeAtResolve === 'risk_off') || (!isLong && e.regimeAtResolve === 'risk_on');
    if (adverse) add('market_regime_changed', { from: setup.market_regime, to: e.regimeAtResolve });
  }

  // 6. macro turned risk-off during the trade
  if (e.macroRiskOff === true) add('macro_risk_off', e.macroEvidence || {});

  // 7. narrative/sector basket moved against the trade
  if (e.narrativeReturn != null) {
    const against = isLong ? e.narrativeReturn <= -0.03 : e.narrativeReturn >= 0.03;
    if (against) add('narrative_reversal', { narrativeReturn: e.narrativeReturn });
  }

  // 8. signal too late: price already covered most of entry->T1 before the signal
  if (e.preSignalRunupFrac != null && e.preSignalRunupFrac >= 0.6) add('signal_too_late', { preSignalRunupFrac: e.preSignalRunupFrac });

  // 9. BTC reversed against the trade
  if (e.btcReturn != null) {
    const against = isLong ? e.btcReturn <= -0.03 : e.btcReturn >= 0.03;
    if (against) add('btc_reversed', { btcReturn: e.btcReturn });
  }

  // 10. volume faded after entry
  if (e.volPre != null && e.volPre > 0 && e.volPost != null && e.volPost < 0.6 * e.volPre) add('volume_faded', { volPre: e.volPre, volPost: e.volPost });

  // 11. thin liquidity at signal (general weakness, distinct from trap)
  if ((e.liquidityUsd != null && e.liquidityUsd > 0 && e.liquidityUsd < 250000)
    || (e.volume24hUsd != null && e.volume24hUsd > 0 && e.volume24hUsd < 1000000)) {
    if (!fired.some((f) => f.reason === 'liquidity_trap')) add('liquidity_weakness', { liquidityUsd: e.liquidityUsd ?? null, volume24hUsd: e.volume24hUsd ?? null });
  }

  // 12. resolved flat: no target, no stop
  if (isLoss && result && !result.hitInv && !result.reachedT1) add('failed_to_reach_target');

  if (!fired.length) add('unknown');
  fired.sort((a, b) => b.strength - a.strength || FAILURE_REASONS.indexOf(a.reason) - FAILURE_REASONS.indexOf(b.reason));
  const primary = fired[0];
  return {
    primary_reason: primary.reason,
    secondary_reasons: fired.slice(1).map((f) => ({ reason: f.reason, strength: f.strength })),
    evidence: Object.assign({}, ...fired.map((f) => ({ [f.reason]: f.detail }))),
    confidence: primary.strength,
    classifier_version: CLASSIFIER_VERSION,
  };
}

// Aggregate primary reasons -> top-N {reason, count, share}.
export function rollupFailureReasons(primaries) {
  const c = {}; let n = 0;
  for (const r of primaries) { if (!r) continue; c[r] = (c[r] || 0) + 1; n++; }
  return Object.entries(c)
    .map(([reason, count]) => ({ reason, count, share: n ? count / n : 0 }))
    .sort((a, b) => b.count - a.count).slice(0, 3);
}
