import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import * as store from '../db/store.js';
import { ROBINHOOD_SYMBOLS } from '../config/robinhoodUniverse.js';

async function freshStore() {
  const db = newDb(); const { Pool } = db.adapters.createPg();
  const pool = new Pool(); await store.initStore({ pool });
  return pool;
}
async function seed(pool, id, symbol) {
  await pool.query(`INSERT INTO setups (setup_id,symbol,mode,direction,history_class,setup_type,market_regime,narrative,entry_price,target1,invalidation,status,final_label,resolved_at)
    VALUES ($1,$2,'day','LONG','long','breakout','risk_on','L1',100,110,95,'resolved','invalidated',now())`, [id, symbol]);
  await pool.query(`INSERT INTO outcomes (setup_id,horizon,success_label,hit_invalidation,final_return,resolved_at) VALUES ($1,'24h','invalidated',true,-0.05,now())`, [id]);
  await pool.query(`INSERT INTO snapshot_coins (snapshot_id,symbol,price,at) VALUES ('r1',$1,100,now())`, [symbol]);
  await store.assignPatterns({ setup_id: id, mode: 'day', direction: 'LONG', history_class: 'long', setup_type: 'breakout', market_regime: 'risk_on', narrative: 'L1' });
}

test('purgeNonRobinhood removes non-listed coins, keeps Robinhood coins', async () => {
  const pool = await freshStore();
  await seed(pool, 'rh1', 'BTC');     // Robinhood
  await seed(pool, 'rh2', 'SOL');     // Robinhood
  await seed(pool, 'x1', 'WIF');      // not listed
  await seed(pool, 'x2', 'SEI');      // not listed
  // macro deep-history should survive
  await pool.query(`INSERT INTO asset_history (asset,source,timeframe,ts,close) VALUES ('MACRO:VIX','stooq','1d',now(),15)`);
  await pool.query(`INSERT INTO asset_history (asset,source,timeframe,ts,close) VALUES ('WIF','binance','1d',now(),2)`);

  const r = await store.purgeNonRobinhood(ROBINHOOD_SYMBOLS);
  assert.equal(r.removedSetups, 2);
  const left = (await pool.query(`SELECT symbol FROM setups ORDER BY symbol`)).rows.map((x) => x.symbol);
  assert.deepEqual(left, ['BTC', 'SOL']);
  // outcomes for purged setups gone
  assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM outcomes WHERE setup_id IN ('x1','x2')`)).rows[0].n), 0);
  // snapshot rows for non-RH gone, RH kept
  const snaps = (await pool.query(`SELECT DISTINCT symbol FROM snapshot_coins ORDER BY symbol`)).rows.map((x) => x.symbol);
  assert.deepEqual(snaps, ['BTC', 'SOL']);
  // macro survives, non-RH asset history removed
  const assets = (await pool.query(`SELECT DISTINCT asset FROM asset_history ORDER BY asset`)).rows.map((x) => x.asset);
  assert.ok(assets.includes('MACRO:VIX'));
  assert.ok(!assets.includes('WIF'));
});
