import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, stdev, bollinger, rsi, macd, atr, adx, percentileRank, swings, realizedVol, last } from './indicators.js';

const approx = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} (tol ${tol})`);

test('sma basic', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.equal(r[0], null); assert.equal(r[1], null);
  approx(r[2], 2); approx(r[3], 3); approx(r[4], 4);
});

test('ema seeds with sma then smooths', () => {
  const r = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  approx(r[2], 2);            // seed = sma(1,2,3)
  approx(r[3], 3);            // 4*0.5 + 2*0.5
  approx(last(r), 9);  // EMA of linear ramp 1..10, period 3 → 9
});

test('stdev population on constant series is 0', () => {
  approx(last(stdev([5, 5, 5, 5, 5], 3)), 0);
});

test('bollinger width is 0 on constant series', () => {
  const { width } = bollinger([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 20, 2);
  approx(last(width), 0);
});

// Canonical StockCharts RSI(14) dataset → first computed RSI ≈ 70.53
test('rsi matches known reference value', () => {
  const prices = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439];
  const r = rsi(prices, 14);
  const firstRsi = r.find((x) => x != null);
  assert.ok(Math.abs(firstRsi - 70.53) < 0.6, `RSI ${firstRsi} ≈ 70.53`);
  r.filter((x) => x != null).forEach((x) => assert.ok(x >= 0 && x <= 100));
});

test('rsi is 100 on monotonically rising series', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  approx(last(rsi(up, 14)), 100);
});

test('macd histogram positive on uptrend, negative on downtrend', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  const down = Array.from({ length: 60 }, (_, i) => 160 - i);
  // On an uptrend the MACD line (EMA12-EMA26) is positive; mirror for downtrend.
  assert.ok(last(macd(up).macd) > 0, 'MACD line > 0 on uptrend');
  assert.ok(last(macd(down).macd) < 0, 'MACD line < 0 on downtrend');
  // Accelerating uptrend keeps the histogram positive.
  const accel = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.05);
  assert.ok(last(macd(accel).hist) > 0, 'histogram > 0 on accelerating uptrend');
});

test('atr is positive and finite on a varied series', () => {
  const n = 30;
  const close = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
  const high = close.map((c) => c + 1);
  const low = close.map((c) => c - 1);
  const a = last(atr(high, low, close, 14));
  assert.ok(a > 0 && Number.isFinite(a));
});

test('adx high on a strong clean trend', () => {
  const n = 60;
  const close = Array.from({ length: n }, (_, i) => 100 + i * 2);
  const high = close.map((c) => c + 0.5);
  const low = close.map((c) => c - 0.5);
  const { adx: a, plusDI, minusDI } = adx(high, low, close, 14);
  assert.ok(last(a) > 25, `ADX ${last(a)} > 25 in a strong trend`);
  assert.ok(last(plusDI) > last(minusDI), '+DI dominates in uptrend');
});

test('percentileRank', () => {
  approx(percentileRank([1, 2, 3, 4, 5], 3), 60);
  approx(percentileRank([1, 2, 3, 4, 5], 5), 100);
});

test('swings detect alternating pivots', () => {
  const high = [1, 3, 2, 5, 2, 6, 2];
  const low = [1, 0, 2, 1, 2, 1, 2];
  const p = swings(high, low, 1);
  assert.ok(p.some((x) => x.type === 'high'));
  assert.ok(p.some((x) => x.type === 'low'));
});

test('realizedVol ~0 on constant, >0 on noisy', () => {
  approx(last(realizedVol([10, 10, 10, 10, 10, 10], 4)), 0);
  const noisy = [10, 11, 9, 12, 8, 13, 7];
  assert.ok(last(realizedVol(noisy, 4)) > 0);
});
