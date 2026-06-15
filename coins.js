import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKlines, backfillBinance } from './binanceKlines.js';
import { parseStooqCsv } from './macroHistory.js';
import { parseMarketChart } from './coingeckoHistory.js';

test('parseKlines maps Binance rows', () => {
  const raw = [[1700000000000, '10', '12', '9', '11', '100', 1700003599999, '5000']];
  const c = parseKlines(raw)[0];
  assert.equal(c.open, 10); assert.equal(c.high, 12); assert.equal(c.low, 9); assert.equal(c.close, 11); assert.equal(c.volume, 5000);
});

test('backfillBinance stitches pages and de-dupes', async () => {
  const DAY = 86400e3; const base = Date.now() - 1600 * DAY;
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) return Array.from({ length: 1000 }, (_, i) => ({ ts: new Date(base + i * DAY).toISOString(), close: i }));
    if (call === 2) return Array.from({ length: 500 }, (_, i) => ({ ts: new Date(base + (1000 + i) * DAY).toISOString(), close: 1000 + i }));
    return [];
  };
  const out = await backfillBinance({ symbol: 'BTC', timeframe: '1d', sinceMs: 0, fetchImpl });
  assert.equal(out.length, 1500);
  assert.equal(new Set(out.map((c) => c.ts)).size, 1500); // unique
});

test('parseStooqCsv parses CSV rows', () => {
  const csv = 'Date,Open,High,Low,Close,Volume\n2024-01-01,10,11,9,10.5,1000\n2024-01-02,10.5,12,10,11.5,2000';
  const c = parseStooqCsv(csv);
  assert.equal(c.length, 2); assert.equal(c[1].close, 11.5); assert.equal(c[0].high, 11);
});

test('parseMarketChart maps CoinGecko close-only candles', () => {
  const data = { prices: [[1700000000000, 42000], [1700086400000, 43000]], total_volumes: [[1700000000000, 1e9], [1700086400000, 2e9]] };
  const c = parseMarketChart(data);
  assert.equal(c.length, 2); assert.equal(c[0].close, 42000); assert.equal(c[0].open, null); assert.equal(c[1].volume, 2e9);
});
