import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patternKeysFor, wilsonLowerBound, shrink, setupResult, rrOf, classifyTrend, patternStrength, regimeMemory, recommendedConfAdj } from './patterns.js';

test('patternKeysFor builds nested L0..L4 with all dims present', () => {
  const ks = patternKeysFor({ mode: 'swing', direction: 'LONG', history_class: 'long', setup_type: 'breakout', market_regime: 'risk_on', narrative: 'L1' });
  assert.equal(ks.length, 5);
  assert.deepEqual(ks.map((k) => k.level), [0, 1, 2, 3, 4]);
  assert.equal(ks[0].key, 'L0|mode=swing|dir=LONG');
  assert.equal(ks[4].key, 'L4|mode=swing|dir=LONG|hist=long|type=breakout|regime=risk_on|narr=L1');
  assert.match(ks[2].name, /Swing · Long · Long-hist · Breakout/);
});

test('patternKeysFor stops when a dimension is missing', () => {
  const ks = patternKeysFor({ mode: 'day', direction: 'SHORT', history_class: 'new' }); // no setup_type
  assert.deepEqual(ks.map((k) => k.level), [0, 1]); // L2+ cannot form
});

test('wilsonLowerBound is conservative and ordered', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  const lb6 = wilsonLowerBound(3, 6);   // 50% of 6
  const lb60 = wilsonLowerBound(30, 60); // 50% of 60
  assert.ok(lb6 < 0.5 && lb60 < 0.5);
  assert.ok(lb60 > lb6, 'larger sample -> tighter (higher) lower bound at same rate');
  assert.ok(wilsonLowerBound(0, 6) >= 0 && wilsonLowerBound(0, 6) < 0.3, '0/6 is not a hard 0 panic');
});

test('shrink pulls small samples toward the prior', () => {
  assert.equal(shrink(0, 0, 0.5), 0.5);                 // no data -> prior
  const s = shrink(0, 6, 0.5, 10);                       // 0/6 with k=10 -> ~0.31, not 0
  assert.ok(s > 0.28 && s < 0.34);
  const big = shrink(0.9, 200, 0.5, 10);                 // large sample barely shrinks
  assert.ok(big > 0.87);
});

test('setupResult derives highest target ordering-correctly', () => {
  const r = setupResult([{ success_label: 'target1' }, { success_label: 'target2', final_return: 0.2 }]);
  assert.equal(r.win, true); assert.equal(r.reachedT2, true); assert.equal(r.bestRank, 2);
  const stopped = setupResult([{ success_label: 'invalidated', hit_target2: true, hit_invalidation: true }]);
  assert.equal(stopped.win, false); assert.equal(stopped.reachedT2, false); assert.equal(stopped.hitInv, true);
});

test('rrOf computes reward:risk', () => {
  assert.equal(rrOf({ entry_price: 100, target1: 110, invalidation: 95 }), 2);
  assert.equal(rrOf({ entry_price: 100, target1: 110, invalidation: 100 }), null); // zero risk
});

test('classifyTrend needs sample + delta', () => {
  assert.equal(classifyTrend(0.7, 0.6, 20), 'improving');
  assert.equal(classifyTrend(0.5, 0.6, 20), 'declining');
  assert.equal(classifyTrend(0.7, 0.6, 3), 'stable'); // too few rolling samples
});

test('patternStrength is bounded 0..100 and rewards win+sample', () => {
  const strong = patternStrength({ win_rate_lb: 0.7, sample_size: 80, trend: 'improving', invalidation_rate: 0.1, avg_return: 0.06, avg_drawdown: 0.03 });
  const weak = patternStrength({ win_rate_lb: 0.1, sample_size: 5, trend: 'declining', invalidation_rate: 0.6, avg_return: -0.05, avg_drawdown: 0.2 });
  assert.ok(strong >= 0 && strong <= 100 && weak >= 0 && weak <= 100);
  assert.ok(strong > weak + 30);
});

test('regimeMemory picks best/worst by Wilson LB with min sample', () => {
  const rm = regimeMemory({ risk_on: { n: 20, wins: 15 }, risk_off: { n: 18, wins: 7 }, neutral: { n: 2, wins: 2 } });
  assert.equal(rm.best.regime, 'risk_on');
  assert.equal(rm.worst.regime, 'risk_off');
  assert.ok(!('neutral' === rm.best?.regime)); // n=2 below minN, not chosen
});

test('recommendedConfAdj is bounded and signed', () => {
  assert.equal(recommendedConfAdj(0.5), 0);
  assert.ok(recommendedConfAdj(1) <= 8 && recommendedConfAdj(0) >= -8);
});
