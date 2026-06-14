import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySetupType, decidePromotion, buildFeatureVector, RL_CFG } from './radarLearn.js';
import { computeOutcome } from './outcomeResolver.js';

const cfg = RL_CFG();
const baseOp = (over = {}) => ({
  symbol: 'TST', direction: 'LONG', conviction: 50, price: 100, score: 60, confidence: 60, risk: 'Medium', type: 'alt',
  targets: { buyZone: [98, 102], target1: 110, target2: 120, stretchTarget: 140, invalidation: 90 },
  signalDetail: {}, historyTier: 'T2', engine: 'v2', ...over,
});

// ---- promotion triggers ----
test('emerge: no active, high conviction, price in zone → create/emerge', () => {
  const d = decidePromotion(baseOp({ conviction: 70, price: 100 }), { cfg, active: null, prev: null, rank: 9 });
  assert.equal(d.action, 'create'); assert.equal(d.reason, 'emerge');
});

test('no event: low conviction, not in zone, low rank → none', () => {
  const d = decidePromotion(baseOp({ conviction: 50, price: 130 }), { cfg, active: null, prev: { conviction: 50, rank: 9, buyZoneValid: false }, rank: 9 });
  assert.equal(d.action, 'none');
});

test('entered-top: rank climbs into top N → create', () => {
  const d = decidePromotion(baseOp({ conviction: 50, price: 130 }), { cfg, active: null, prev: { conviction: 50, rank: 8, buyZoneValid: false }, rank: 3 });
  assert.equal(d.action, 'create'); assert.equal(d.reason, 'entered-top-list');
});

test('buy-zone-valid: price enters zone when it was outside → create', () => {
  const d = decidePromotion(baseOp({ conviction: 50, price: 100 }), { cfg, active: null, prev: { conviction: 50, rank: 9, buyZoneValid: false }, rank: 9 });
  assert.equal(d.action, 'create'); assert.equal(d.reason, 'buy-zone-valid');
});

test('major-score-jump: +12 conviction with no active → create', () => {
  const d = decidePromotion(baseOp({ conviction: 70, price: 130 }), { cfg, active: null, prev: { conviction: 55, rank: 9, buyZoneValid: false }, rank: 9 });
  assert.equal(d.action, 'create'); assert.equal(d.reason, 'major-score-jump');
});

test('direction-change supersedes the active setup', () => {
  const active = { direction: 'LONG', setup_type: 'range-fade', entry_filled: true };
  const d = decidePromotion(baseOp({ direction: 'SHORT' }), { cfg, active, prev: { conviction: 50, rank: 2 }, rank: 2 });
  assert.equal(d.action, 'supersede-create'); assert.equal(d.reason, 'direction-change');
});

test('setup-type-change supersedes', () => {
  const active = { direction: 'LONG', setup_type: 'range-fade', entry_filled: true };
  const op = baseOp({ price: 130, signalDetail: { breakout: { detail: { posInRange: 0.99, rvol: 2 } } } }); // → breakout
  const d = decidePromotion(op, { cfg, active, prev: { conviction: 50, rank: 2 }, rank: 2 });
  assert.equal(d.action, 'supersede-create'); assert.equal(d.reason, 'setup-type-change');
});

test('conviction band cross updates the active setup', () => {
  const active = { direction: 'LONG', setup_type: 'range-fade', entry_filled: true };
  const d = decidePromotion(baseOp({ conviction: 78, price: 130 }), { cfg, active, prev: { conviction: 70, rank: 2, buyZoneValid: false }, rank: 2 });
  assert.equal(d.action, 'update'); assert.equal(d.reason, 'conviction-band-cross');
});

test('fill-entry when active untriggered and price enters zone', () => {
  const active = { direction: 'LONG', setup_type: 'range-fade', entry_filled: false };
  const d = decidePromotion(baseOp({ conviction: 60, price: 100 }), { cfg, active, prev: { conviction: 60, rank: 2 }, rank: 2 });
  assert.equal(d.action, 'fill-entry');
});

test('classifySetupType maps signals to types', () => {
  assert.equal(classifySetupType({ breakout: { detail: { posInRange: 0.99, rvol: 2 } } }, 'LONG'), 'breakout');
  assert.equal(classifySetupType({ breakout: { detail: { reclaim: 1 } } }), 'sweep-reclaim');
  assert.equal(classifySetupType({ trend: { detail: { emaAlign: 1, reversalScore: 10 } } }), 'trend-continuation');
  assert.equal(classifySetupType({}), 'range-fade');
});

test('feature vector is 14 normalized dims with an l2 norm', () => {
  const v = buildFeatureVector(baseOp({ conviction: 80, confidence: 70 }));
  assert.equal(v.dims, 14); assert.equal(v.vector.length, 14);
  v.vector.forEach((x) => assert.ok(x >= 0 && x <= 1));
  assert.ok(v.l2norm > 0);
});

// ---- resolver math ----
const setup = (over = {}) => ({ entry_price: 100, direction: 'LONG', target1: 110, target2: 120, stretch_target: 140, invalidation: 90, ...over });
const path = (...prices) => prices.map((p, i) => ({ at: new Date(i * 1000).toISOString(), price: p }));

test('LONG reaching target2: hits + MFE/MAE/return + label', () => {
  const o = computeOutcome(setup(), path(100, 105, 112, 118, 122, 121), '24h');
  assert.equal(o.hit_target1, true); assert.equal(o.hit_target2, true); assert.equal(o.hit_stretch, false);
  assert.equal(o.hit_invalidation, false); assert.equal(o.success_label, 'target2');
  assert.equal(o.max_favorable_excursion, 0.22); assert.equal(o.max_adverse_excursion, 0);
  assert.equal(o.final_return, 0.21);
});

test('LONG target1 before invalidation → label target1', () => {
  const o = computeOutcome(setup({ target1: 105 }), path(100, 106, 88), '24h');
  assert.equal(o.success_label, 'target1'); assert.equal(o.hit_target1, true); assert.equal(o.hit_invalidation, true);
});

test('LONG invalidation before any target → invalidated', () => {
  const o = computeOutcome(setup(), path(100, 98, 89, 111), '24h');
  assert.equal(o.success_label, 'invalidated'); assert.equal(o.hit_invalidation, true);
});

test('SHORT reaching target1', () => {
  const o = computeOutcome(setup({ direction: 'SHORT', target1: 90, target2: 80, stretch_target: 70, invalidation: 110 }), path(100, 95, 88, 82), '24h');
  assert.equal(o.success_label, 'target1'); assert.equal(o.hit_target1, true);
  assert.equal(o.max_favorable_excursion, 0.18); assert.equal(o.final_return, 0.18);
});

test('empty price path → fail, incomplete', () => {
  const o = computeOutcome(setup(), [], '1h');
  assert.equal(o.samples, 0); assert.equal(o.data_complete, false); assert.equal(o.success_label, 'fail');
});
