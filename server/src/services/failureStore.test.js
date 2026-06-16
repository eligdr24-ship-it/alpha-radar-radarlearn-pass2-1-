import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import * as store from '../db/store.js';

async function freshStore() {
  const db = newDb(); const { Pool } = db.adapters.createPg();
  const pool = new Pool(); await store.initStore({ pool });
  return pool;
}
async function seedLoss(pool, id, { hitInv = true, label = 'invalidated', narrative = 'L1' } = {}) {
  await pool.query(
    `INSERT INTO setups (setup_id,symbol,mode,direction,history_class,setup_type,market_regime,narrative,entry_price,target1,invalidation,status,final_label,entry_filled_at,resolved_at)
     VALUES ($1,'BTC','day','LONG','long','breakout','risk_on',$4,100,110,95,'resolved',$2,now(),now())`, [id, label, hitInv, narrative]);
  await pool.query(
    `INSERT INTO outcomes (setup_id,horizon,success_label,hit_target1,hit_target2,hit_stretch,hit_invalidation,final_return,max_favorable_excursion,max_adverse_excursion,resolved_at)
     VALUES ($1,'24h',$2,false,false,false,$3,-0.05,0.01,-0.06,now())`, [id, label, hitInv]);
  await store.assignPatterns({ setup_id: id, mode: 'day', direction: 'LONG', history_class: 'long', setup_type: 'breakout', market_regime: 'risk_on', narrative });
}

test('classifyAndStoreFailure stores a reason for a loss; wins are skipped', async () => {
  const pool = await freshStore();
  await seedLoss(pool, 'loss1');
  const cls = await store.classifyAndStoreFailure('loss1');
  assert.equal(cls.primary_reason, 'hit_invalidation');     // no BTC/vol/macro data in pg-mem -> clean stop-out
  const row = await store.getFailureReason('loss1');
  assert.equal(row.primary_reason, 'hit_invalidation');
  assert.ok(row.classifier_version);
  // a win gets no row
  await pool.query(`INSERT INTO setups (setup_id,symbol,mode,direction,status,final_label) VALUES ('win1','BTC','day','LONG','resolved','target1')`);
  await pool.query(`INSERT INTO outcomes (setup_id,horizon,success_label,hit_target1,hit_invalidation,final_return,resolved_at) VALUES ('win1','24h','target1',true,false,0.1,now())`);
  assert.equal(await store.classifyAndStoreFailure('win1'), null);
  assert.equal(await store.getFailureReason('win1'), null);
});

test('failure reasons roll up into pattern_performance.top_failure_reasons', async () => {
  const pool = await freshStore();
  for (let i = 0; i < 5; i++) await seedLoss(pool, `l${i}`, { narrative: `N${i}` }); // distinct narratives -> clean stop-outs
  for (const id of ['l0', 'l1', 'l2', 'l3', 'l4']) await store.classifyAndStoreFailure(id);
  await store.recomputePatterns();
  const rows = await store.getPatterns({ window: 'all_time' });
  const l0 = rows.find((p) => p.level === 0);
  assert.ok(Array.isArray(l0.top_failure_reasons) && l0.top_failure_reasons.length >= 1);
  assert.equal(l0.top_failure_reasons[0].reason, 'hit_invalidation');
  assert.equal(l0.top_failure_reasons[0].count, 5);
});

test('getFailureBreakdown aggregates globally', async () => {
  const pool = await freshStore();
  await seedLoss(pool, 'a'); await seedLoss(pool, 'b');
  await store.classifyAndStoreFailure('a'); await store.classifyAndStoreFailure('b');
  const b = await store.getFailureBreakdown();
  assert.equal(b.total, 2);
  assert.equal(b.reasons[0].reason, 'hit_invalidation');
  assert.ok(Math.abs(b.reasons[0].share - 1) < 1e-9);
});

test('backfillFailures classifies historical losses idempotently', async () => {
  const pool = await freshStore();
  await seedLoss(pool, 'h1'); await seedLoss(pool, 'h2');
  const r = await store.backfillFailures();
  assert.equal(r.classified, 2);
  // re-run: still 2 stored rows (upsert, no dup)
  await store.backfillFailures();
  assert.equal((await store.getFailureBreakdown()).total, 2);
});
