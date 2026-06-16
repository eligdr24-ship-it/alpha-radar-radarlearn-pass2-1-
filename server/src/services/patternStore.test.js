import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import * as store from '../db/store.js';

async function freshStore() {
  const db = newDb(); const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await store.initStore({ pool });
  return pool;
}

// helper: insert a setup + its outcome directly, then assign patterns
async function seedSetup(pool, { id, mode = 'swing', dir = 'LONG', hist = 'long', type = 'breakout', regime = 'risk_on', narr = 'L1', status = 'resolved', label = 'target1', ret = 0.1, entry = 100, t1 = 110, inv = 95, resolvedAt = new Date().toISOString(), inv_hit = false, mae = -0.04 }) {
  await pool.query(
    `INSERT INTO setups (setup_id,symbol,mode,direction,history_class,setup_type,market_regime,narrative,entry_price,target1,invalidation,status,final_label,resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, 'BTC', mode, dir, hist, type, regime, narr, entry, t1, inv, status, label, resolvedAt]);
  if (status === 'resolved') {
    await pool.query(
      `INSERT INTO outcomes (setup_id,horizon,success_label,hit_target1,hit_target2,hit_stretch,hit_invalidation,final_return,max_adverse_excursion,resolved_at)
       VALUES ($1,'24h',$2,$3,$4,false,$5,$6,$7,$8)`,
      [id, label, label !== 'fail' && label !== 'invalidated', label === 'target2' || label === 'stretch', inv_hit, ret, mae, resolvedAt]);
  }
  await store.assignPatterns({ setup_id: id, mode, direction: dir, history_class: hist, setup_type: type, market_regime: regime, narrative: narr });
}

test('migration 004 creates pattern tables', async () => {
  const pool = await freshStore();
  for (const t of ['patterns', 'pattern_members', 'pattern_performance']) {
    const r = await pool.query(`SELECT count(*) AS n FROM ${t}`);
    assert.equal(Number(r.rows[0].n), 0);
  }
});

test('assignPatterns stamps a setup into L0..L4 with parent links', async () => {
  const pool = await freshStore();
  await seedSetup(pool, { id: 's1' });
  const pats = (await pool.query(`SELECT level, parent_pattern_id FROM patterns ORDER BY level`)).rows;
  assert.equal(pats.length, 5);
  assert.equal(pats[0].parent_pattern_id, null);          // L0 has no parent
  assert.notEqual(pats[1].parent_pattern_id, null);       // L1 -> L0
  const mem = (await pool.query(`SELECT count(*) AS n FROM pattern_members WHERE setup_id='s1'`)).rows[0];
  assert.equal(Number(mem.n), 5);
});

test('recompute computes Wilson LB, shrinkage, strength, and regime memory', async () => {
  const pool = await freshStore();
  // L2 pattern "swing long long-hist breakout" spans regimes; mostly wins in risk_on, losses in risk_off
  for (let i = 0; i < 12; i++) await seedSetup(pool, { id: `on${i}`, regime: 'risk_on', label: i < 9 ? 'target1' : 'fail', ret: i < 9 ? 0.1 : -0.05, inv_hit: i >= 9 });
  for (let i = 0; i < 10; i++) await seedSetup(pool, { id: `off${i}`, regime: 'risk_off', label: i < 4 ? 'target1' : 'fail', ret: i < 4 ? 0.08 : -0.06, inv_hit: i >= 4 });
  await store.recomputePatterns();

  const rows = await store.getPatterns({ window: 'all_time' });
  const l2 = rows.find((p) => p.level === 2);
  assert.ok(l2, 'L2 pattern present');
  assert.equal(l2.sample_size, 22);
  assert.equal(l2.wins, 13);
  assert.ok(l2.win_rate_lb > 0 && l2.win_rate_lb < l2.win_rate, 'Wilson LB below point estimate');
  assert.ok(l2.shrunk_win_rate != null);
  assert.ok(l2.strength >= 0 && l2.strength <= 100);
  // regime memory: risk_on should beat risk_off
  assert.equal(l2.best_regime, 'risk_on');
  assert.equal(l2.worst_regime, 'risk_off');
  assert.ok(l2.best_regime_win_rate > l2.worst_regime_win_rate);
});

test('matchSetup returns cohort stats that EXCLUDE the current setup', async () => {
  const pool = await freshStore();
  // 10 resolved peers (8 wins) + the current open setup in the same L2 pattern
  for (let i = 0; i < 10; i++) await seedSetup(pool, { id: `peer${i}`, label: i < 8 ? 'target1' : 'fail', ret: i < 8 ? 0.12 : -0.05, inv_hit: i >= 8 });
  await seedSetup(pool, { id: 'cur', status: 'active' });   // current, unresolved
  await store.recomputePatterns();

  const m = await store.matchSetup('cur');
  assert.equal(m.available, true);
  assert.equal(m.n, 10, 'cohort = 10 resolved peers, current excluded');
  assert.ok(Math.abs(m.win_rate - 0.8) < 1e-9);
  assert.ok(m.win_rate_lb < 0.8);
  assert.ok(m.target1_rate > 0);
  // adding the current setup must not have been counted
  assert.ok(m.n === 10);
});

test('incremental recompute by setupId refreshes only that setup\'s patterns + ancestors', async () => {
  const pool = await freshStore();
  await seedSetup(pool, { id: 'a', label: 'target1', ret: 0.1 });
  await store.recomputePatterns({ setupId: 'a' });
  const rows = await store.getPatterns({ window: 'all_time' });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.sample_size >= 1));
});

test('backfillPatterns assigns membership for setups created before the library', async () => {
  const pool = await freshStore();
  // insert resolved setups DIRECTLY (no assignPatterns), simulating pre-library data
  for (let i = 0; i < 6; i++) {
    const id = `old${i}`, label = i < 4 ? 'target1' : 'fail', ret = i < 4 ? 0.1 : -0.05;
    await pool.query(
      `INSERT INTO setups (setup_id,symbol,mode,direction,history_class,setup_type,market_regime,narrative,entry_price,target1,invalidation,status,final_label,resolved_at)
       VALUES ($1,'BTC','day','LONG','long','pullback','risk_on','L1',100,110,95,'resolved',$2,now())`, [id, label]);
    await pool.query(
      `INSERT INTO outcomes (setup_id,horizon,success_label,hit_target1,hit_target2,hit_stretch,hit_invalidation,final_return,max_adverse_excursion,resolved_at)
       VALUES ($1,'24h',$2,$3,false,false,$4,$5,-0.03,now())`, [id, label, label === 'target1', label === 'fail', ret]);
  }
  // no patterns yet
  assert.equal((await store.getPatterns({ window: 'all_time' })).length, 0);
  const r = await store.backfillPatterns();
  assert.equal(r.setups, 6);
  assert.equal(r.assigned, 6);
  await store.recomputePatterns();
  const rows = await store.getPatterns({ window: 'all_time' });
  assert.ok(rows.length >= 1, 'patterns now exist');
  const l0 = rows.find((p) => p.level === 0);
  assert.equal(l0.sample_size, 6);
  assert.equal(l0.wins, 4);
  // idempotent: re-running does not duplicate members
  await store.backfillPatterns();
  const after = await store.getPatterns({ window: 'all_time' });
  const l0b = after.find((p) => p.level === 0);
  assert.equal(l0b.sample_size, 6, 're-run did not double-count');
});
