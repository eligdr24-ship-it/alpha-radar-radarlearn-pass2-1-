import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCoinV2 } from './scoringV2.js';

const HOUR = 3600e3;
// Build a 30-day hourly snapshot history from a price function.
function series(priceFn, volFn = () => 5e6, n = 24 * 30) {
  const t0 = Date.now() - n * HOUR;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const price = priceFn(i);
    const prev24 = i >= 24 ? priceFn(i - 24) : price;
    pts.push({
      at: new Date(t0 + i * HOUR).toISOString(),
      price, volume24hUsd: volFn(i), liquidityUsd: 5_000_000,
      change24h: ((price - prev24) / prev24) * 100,
    });
  }
  return pts;
}
const coin = (over = {}) => ({ symbol: 'TST', name: 'Test', price: 100, change24h: 0, type: 'alt', sector: 'Crypto', liquidityUsd: 5e6, ...over });

test('clean uptrend → LONG with bullish trend & momentum + 3 whys', () => {
  const hist = series((i) => 100 * (1 + 0.0015 * i), (i) => 4e6 + i * 4000, 24 * 31); // >30d → T3
  const cur = hist[hist.length - 1];
  const r = scoreCoinV2(coin({ price: cur.price, change24h: cur.change24h }), 'day', hist);
  assert.equal(r.direction, 'LONG');
  assert.ok(r.signals.trend > 55, `trend ${r.signals.trend} > 55`);
  assert.ok(r.signals.momentum > 55, `momentum ${r.signals.momentum} > 55`);
  assert.equal(r.engine, 'v2');
  assert.equal(r.historyTier, 'T3');
  assert.equal(r.why.length, 3);
  r.why.forEach((w) => assert.ok(typeof w === 'string' && w.length > 0));
});

test('clean downtrend → SHORT', () => {
  const hist = series((i) => 200 * (1 - 0.0012 * i));
  const cur = hist[hist.length - 1];
  const r = scoreCoinV2(coin({ price: cur.price, change24h: cur.change24h }), 'day', hist);
  assert.equal(r.direction, 'SHORT');
  assert.ok(r.signals.trend < 45, `trend ${r.signals.trend} < 45`);
});

test('range then breakout on rising volume → breakout signal pushes long', () => {
  const hist = series(
    (i) => (i < 600 ? 100 + Math.sin(i / 5) * 1.5 : 100 + (i - 600) * 0.4),  // flat then up-break
    (i) => (i < 600 ? 3e6 : 9e6),                                            // volume expands on break
  );
  const cur = hist[hist.length - 1];
  const r = scoreCoinV2(coin({ price: cur.price, change24h: cur.change24h }), 'day', hist);
  assert.ok(r.signalDetail.breakout.long > 0, 'breakout contributes long');
  assert.equal(r.direction, 'LONG');
});

test('all five signals present, scores in 0-100, confidence 0-100', () => {
  const hist = series((i) => 100 + Math.sin(i / 10) * 5);
  const cur = hist[hist.length - 1];
  const r = scoreCoinV2(coin({ price: cur.price, change24h: cur.change24h }), 'swing', hist);
  for (const k of ['volatility', 'volume', 'trend', 'momentum', 'breakout', 'freshness']) {
    assert.ok(r.signals[k] >= 0 && r.signals[k] <= 100, `${k}=${r.signals[k]}`);
  }
  assert.ok(r.confidence >= 0 && r.confidence <= 100);
  assert.ok(r.conviction >= 0 && r.conviction <= 100);
});

test('short history → warming flag set, still returns a valid object', () => {
  const hist = series((i) => 100 + i, () => 5e6, 8); // 8 hours only
  const r = scoreCoinV2(coin(), 'day', hist);
  assert.equal(r.warming, true);
  assert.equal(r.historyTier, 'T0');
  assert.ok(r.confidence < 40, `low confidence while warming (${r.confidence})`);
  assert.equal(r.why.length, 3);
});

test('thin liquidity downgrades risk to High', () => {
  const hist = series((i) => 100 + i * 0.1, () => 2e6);
  const r = scoreCoinV2(coin({ liquidityUsd: 20_000 }), 'day', hist);
  assert.equal(r.risk, 'High');
});
