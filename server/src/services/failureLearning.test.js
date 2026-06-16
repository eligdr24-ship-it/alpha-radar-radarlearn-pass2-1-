import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, rollupFailureReasons, REASON_LABELS, FAILURE_REASONS, CLASSIFIER_VERSION } from './failureLearning.js';

const LONG = { status: 'resolved', direction: 'LONG', entry_price: 100, target1: 110, invalidation: 95, market_regime: 'risk_on', entry_filled_at: '2024-01-01T00:00:00Z' };
const lossR = (over = {}) => ({ resolved: true, win: false, loss: true, hitInv: false, reachedT1: false, reachedT2: false, maxFavorable: null, maxAdverse: -0.04, ...over });

function primary(ev) { return classifyFailure(ev)?.primary_reason; }

test('wins and open setups get no failure reason', () => {
  assert.equal(classifyFailure({ setup: LONG, result: { resolved: true, win: true, loss: false } }), null);
  assert.equal(classifyFailure({ setup: { ...LONG, status: 'active' }, result: { resolved: false, win: false, loss: false } }), null);
});

test('failed_to_enter_zone', () => {
  assert.equal(primary({ setup: { ...LONG, status: 'expired', entry_filled_at: null }, result: { resolved: false, loss: false } }), 'failed_to_enter_zone');
});

test('hit_invalidation (clean stop-out)', () => {
  assert.equal(primary({ setup: LONG, result: lossR({ hitInv: true }) }), 'hit_invalidation');
});

test('failed_to_reach_target (timed out flat)', () => {
  assert.equal(primary({ setup: LONG, result: lossR({ hitInv: false, reachedT1: false }) }), 'failed_to_reach_target');
});

test('market_regime_changed', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), regimeAtResolve: 'risk_off' }), 'market_regime_changed');
});

test('volume_faded', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), volPre: 1000, volPost: 100 }), 'volume_faded');
});

test('btc_reversed', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), btcReturn: -0.10 }), 'btc_reversed');
});

test('macro_risk_off', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), macroRiskOff: true }), 'macro_risk_off');
});

test('liquidity_weakness', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), liquidityUsd: 100000 }), 'liquidity_weakness');
});

test('liquidity_trap (favorable then dumped on thin book)', () => {
  assert.equal(primary({ setup: LONG, result: lossR({ hitInv: true, maxFavorable: 0.06 }), liquidityUsd: 100000 }), 'liquidity_trap');
});

test('narrative_reversal', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), narrativeReturn: -0.10 }), 'narrative_reversal');
});

test('signal_too_early (stopped out, target reached afterwards)', () => {
  const pricePath = [{ price: 100 }, { price: 94 }, { price: 112 }]; // inv@1, t1@2
  assert.equal(primary({ setup: LONG, result: lossR({ hitInv: true }), pricePath }), 'signal_too_early');
});

test('signal_too_late (move already extended pre-signal)', () => {
  assert.equal(primary({ setup: LONG, result: lossR(), preSignalRunupFrac: 0.8 }), 'signal_too_late');
});

test('unknown (expired-but-entered with no evidence)', () => {
  assert.equal(primary({ setup: { ...LONG, status: 'expired' }, result: { resolved: false, loss: false, hitInv: false, reachedT1: false } }), 'unknown');
});

test('secondary reasons + evidence + classifier version are populated', () => {
  const pricePath = [{ price: 100 }, { price: 94 }, { price: 112 }];
  const out = classifyFailure({ setup: LONG, result: lossR({ hitInv: true }), pricePath });
  assert.equal(out.primary_reason, 'signal_too_early');
  assert.ok(out.secondary_reasons.some((s) => s.reason === 'hit_invalidation'), 'literal mechanic recorded as secondary');
  assert.equal(out.classifier_version, CLASSIFIER_VERSION);
  assert.ok(out.evidence.signal_too_early && out.evidence.signal_too_early.t1Idx === 2);
});

test('every reason has a human label', () => {
  for (const r of FAILURE_REASONS) assert.ok(REASON_LABELS[r], `label for ${r}`);
});

test('rollupFailureReasons aggregates and ranks by count + share', () => {
  const r = rollupFailureReasons(['hit_invalidation', 'hit_invalidation', 'btc_reversed', null, 'volume_faded']);
  assert.equal(r[0].reason, 'hit_invalidation');
  assert.equal(r[0].count, 2);
  assert.ok(Math.abs(r[0].share - 0.5) < 1e-9); // 2 of 4 non-null
});
