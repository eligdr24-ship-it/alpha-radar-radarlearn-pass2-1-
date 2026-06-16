import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import * as store from '../db/store.js';
import { resolveAll, computeOutcome } from './outcomeResolver.js';

function freshStore() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return store.initStore({ pool: new Pool() }).then(() => new Pool());
}

test('computeOutcome: target hit before invalidation within window = win', () => {
  const setup = { direction: 'LONG', entry_price: 100, target1: 110, target2: 120, stretch_target: 130, invalidation: 95 };
  const path = [{ at: 't0', price: 100 }, { at: 't1', price: 111 }, { at: 't2', price: 108 }];
  const oc = computeOutcome(setup, path, '4h');
  assert.equal(oc.success_label, 'target1');
  assert.equal(oc.hit_target1, true);
});

test('computeOutcome: invalidation before target within window = loss', () => {
  const setup = { direction: 'LONG', entry_price: 100, target1: 110, target2: 120, stretch_target: 130, invalidation: 95 };
  const path = [{ at: 't0', price: 100 }, { at: 't1', price: 94 }, { at: 't2', price: 112 }];
  const oc = computeOutcome(setup, path, '4h');
  assert.equal(oc.success_label, 'invalidated');
});

// The JTO bug: 4h hit target1 in an earlier run; a later run resolves the setup
// on a 24h invalidation. final_label must remain the best outcome (target1 = WIN),
// not the latest run's label (invalidated = LOSS).
test('resolveAll: final_label aggregates the best outcome across all horizons', async () => {
  const pool = await freshStore();
  const created = new Date(Date.now() - 25 * 3600e3).toISOString(); // 25h ago → 4h & 24h elapsed
  await pool.query(`INSERT INTO setups (setup_id,setup_key,symbol,mode,direction,setup_type,entry_price,buy_zone_low,buy_zone_high,target1,target2,stretch_target,invalidation,status,entry_filled,created_at)
    VALUES ('jto1','JTO|day','JTO','day','LONG','breakout',100,99,101,110,120,130,95,'active',true,'${created}')`);
  // 4h outcome already stored as a WIN from a prior run
  await pool.query(`INSERT INTO outcomes (setup_id,horizon,hit_target1,success_label,final_return,resolved_at)
    VALUES ('jto1','4h',true,'target1',0.21,'${new Date(Date.now() - 20 * 3600e3).toISOString()}')`);
  // price path: short windows never reach T1; price clearly breaks below
  // invalidation (95) several hours before the 24h mark.
  const pts = [[-25, 100], [-24, 100.5], [-23, 101], [-8, 98], [-6, 96], [-5, 94], [-4, 93]];
  for (const [h, px] of pts) await pool.query(`INSERT INTO snapshot_coins (symbol,at,price) VALUES ('JTO','${new Date(Date.now() + h * 3600e3).toISOString()}',${px})`);

  const res = await resolveAll();
  assert.ok(res.labeled >= 1, 'should label new horizons');
  const after = await store.getSetup('jto1');
  assert.equal(after.setup.status, 'resolved', 'setup resolves on 24h invalidation');
  assert.equal(after.setup.final_label, 'target1', 'final_label must remain the best outcome (WIN), not the later loss');
});
