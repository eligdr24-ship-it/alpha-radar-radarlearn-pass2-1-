import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import * as store from '../db/store.js';
import { runBackfill } from './historyBackfill.js';

async function freshStore() {
  const db = newDb(); const { Pool } = db.adapters.createPg();
  await store.initStore({ pool: new Pool() });
}
const dailyCandles = (n) => Array.from({ length: n }, (_, i) => ({ ts: new Date(Date.now() - (n - i) * 86400e3).toISOString(), open: null, high: null, low: null, close: 100 + i, volume: 1 }));

test('backfill: Binance 451 does not abort — CoinGecko fallback still stores candles', async () => {
  await freshStore();
  const fetchers = {
    binance: async () => { throw new Error('binance(data-api.binance.vision) BTCUSDT 1d: HTTP 451'); },
    coingecko: async () => ({ candles: dailyCandles(400), notes: 'ohlc_partial' }),
    macro: async () => { throw new Error('stooq blocked'); },
    dex: async () => ({ candles: [], notes: 'dex' }),
  };
  const r = await runBackfill({ symbols: ['BTC'], includeMacro: false, fetchers });
  const btc = r.results.find((x) => x.asset === 'BTC');
  assert.equal(btc.best_source, 'coingecko');
  assert.ok(btc.candles >= 400);
  assert.ok(r.totalCandles >= 400);
  assert.ok(btc.errors.some((e) => /451/.test(e)), 'records the binance 451 error');
});

test('backfill: every source failing yields totalCandles=0 (caller must fail)', async () => {
  await freshStore();
  const boom = async () => { throw new Error('blocked'); };
  const r = await runBackfill({ symbols: ['BTC'], includeMacro: true, fetchers: { binance: boom, coingecko: boom, macro: boom, dex: boom } });
  assert.equal(r.totalCandles, 0);
  assert.ok(r.results.every((x) => (x.candles || 0) === 0));
});
