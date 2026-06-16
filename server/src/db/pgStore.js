// Postgres driver. Created when DATABASE_URL is set. Accepts an injected pool
// (used by tests with pg-mem); otherwise builds a real pg Pool.
import pg from 'pg';
import { runMigrations } from './migrate.js';
import { patternKeysFor, wilsonLowerBound, shrink, setupResult, rrOf, classifyTrend, recommendedConfAdj, patternStrength, regimeMemory } from '../services/patterns.js';
import { classifyFailure, rollupFailureReasons } from '../services/failureLearning.js';

const J = (v) => (v == null ? null : JSON.stringify(v));

export async function createPgStore({ connectionString, pool: injected, ssl } = {}) {
  const pool = injected || new pg.Pool({
    connectionString,
    ssl: ssl ?? (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined),
    max: Number(process.env.PG_POOL_MAX || 5),
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
  });
  const q = (text, params) => pool.query(text, params);

  // Verify connectivity + apply migrations before returning the driver.
  await q('SELECT 1');
  const mig = await runMigrations(pool);
  if (mig.applied.length) console.log(`[store:pg] applied migrations: ${mig.applied.join(', ')}`);

  return {
    driverName: 'postgres',
    async init() { /* connection + migrations already done */ },

    // Priority 1
    async setUniverse(u) {
      await q(
        `INSERT INTO scan_universe(run_id, built_at, source, filter, counts, coins)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [u.runId || null, u.builtAt, u.source, J(u.filter), J(u.counts), J(u.coins)]
      );
    },
    async getUniverse() {
      const r = await q('SELECT built_at, source, filter, counts, coins FROM scan_universe ORDER BY id DESC LIMIT 1');
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return { builtAt: x.built_at, source: x.source, filter: x.filter, counts: x.counts, coins: x.coins || [] };
    },

    // Priority 2
    async addSnapshot(s) {
      const snapshotId = `snap_${Date.now()}`;
      await q(
        `INSERT INTO market_snapshots(snapshot_id, run_id, at, source, macro, emerging)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [snapshotId, s.runId || null, s.at, s.source, J(s.macro), J(s.emerging)]
      );
      const coins = s.coins || [];
      if (coins.length) {
        // one multi-row parameterized insert
        const cols = 11;
        const values = [];
        const params = [];
        coins.forEach((c, i) => {
          const o = i * cols;
          values.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11})`);
          params.push(snapshotId, s.at, c.symbol, c.name, c.price, c.change24h, c.marketCapUsd, c.volume24hUsd, c.liquidityUsd, c.type, c.sector);
        });
        await q(
          `INSERT INTO snapshot_coins(snapshot_id, at, symbol, name, price, change24h, market_cap_usd, volume24h_usd, liquidity_usd, type, sector)
           VALUES ${values.join(',')}`,
          params
        );
      }
      return { id: snapshotId, ...s };
    },
    async getLatestSnapshot() {
      const r = await q('SELECT snapshot_id, at, source, macro, emerging FROM market_snapshots ORDER BY created_at DESC LIMIT 1');
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return { id: x.snapshot_id, at: x.at, source: x.source, macro: x.macro, emerging: x.emerging || [] };
    },
    async getSnapshots(limit = 20) {
      const r = await q('SELECT snapshot_id, at, source FROM market_snapshots ORDER BY created_at DESC LIMIT $1', [limit]);
      return r.rows.map((x) => ({ id: x.snapshot_id, at: x.at, source: x.source }));
    },

    // Priority 3
    async setOpportunities(o) {
      const runId = o.runId || `run_${Date.now()}`;
      const rows = [];
      const params = [];
      let n = 0;
      for (const mode of Object.keys(o.byMode || {})) {
        o.byMode[mode].forEach((op, idx) => {
          const b = n * 14;
          rows.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14})`);
          params.push(runId, o.at, o.source, mode, idx + 1, op.symbol, op.direction, op.conviction, op.confidence, op.consensus, op.signals?.freshness ?? null, op.risk, op.score, J(op));
          n++;
        });
      }
      if (!rows.length) return;
      await q(
        `INSERT INTO opportunities(run_id, at, source, mode, rank, symbol, direction, conviction, confidence, consensus, freshness, risk, score, payload)
         VALUES ${rows.join(',')}`,
        params
      );
    },
    async getOpportunities() {
      const latest = await q('SELECT run_id, at, source FROM opportunities ORDER BY at DESC LIMIT 1');
      if (!latest.rows.length) return null;
      const { run_id, at, source } = latest.rows[0];
      const r = await q('SELECT mode, payload FROM opportunities WHERE run_id=$1 ORDER BY mode, rank', [run_id]);
      const byMode = { scalp: [], day: [], swing: [] };
      for (const row of r.rows) (byMode[row.mode] ||= []).push(row.payload);
      return { at, source, byMode };
    },

    // scan runs
    async addScanRun(r) {
      const runId = r.id || `run_${Date.now()}`;
      await q(
        `INSERT INTO scan_runs(run_id, trigger, started_at, finished_at, duration_ms, source, universe_raw, kept, rejected, reason_counts, errors, integrations, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (run_id) DO NOTHING`,
        [runId, r.trigger, r.startedAt, r.finishedAt, r.durationMs, r.source, r.universeRaw, r.kept, r.rejected, J(r.reasonCounts), J(r.errors), J(r.integrations), r.status]
      );
      return { id: runId, ...r };
    },
    async getScanRuns(limit = 20) {
      const r = await q('SELECT * FROM scan_runs ORDER BY created_at DESC LIMIT $1', [limit]);
      return r.rows.map(mapRun);
    },
    async getLastScanRun() {
      const r = await q('SELECT * FROM scan_runs ORDER BY created_at DESC LIMIT 1');
      return r.rows.length ? mapRun(r.rows[0]) : null;
    },

    // Priority 4
    async addSourceStatus(rows) {
      if (!rows.length) return;
      const vals = [];
      const params = [];
      rows.forEach((s, i) => {
        const b = i * 5;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`);
        params.push(s.runId || null, s.at, s.source, s.status, J(s.detail));
      });
      await q(`INSERT INTO source_status(run_id, at, source, status, detail) VALUES ${vals.join(',')}`, params);
    },
    async getSourceStatus(limit = 50) {
      const r = await q('SELECT run_id, at, source, status, detail FROM source_status ORDER BY id DESC LIMIT $1', [limit]);
      return r.rows.map((x) => ({ runId: x.run_id, at: x.at, source: x.source, status: x.status, detail: x.detail }));
    },

    // Priority 5
    async addAlertEvent(e) {
      const r = await q(
        `INSERT INTO alert_events(at, type, title, body, payload, channel, delivered)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [e.at || new Date().toISOString(), e.type, e.title, e.body, J(e.payload), e.channel || null, e.delivered ?? false]
      );
      return { id: r.rows[0].id, ...e };
    },
    async getAlertEvents(limit = 50) {
      const r = await q('SELECT id, at, type, title, body, payload, channel, delivered FROM alert_events ORDER BY id DESC LIMIT $1', [limit]);
      return r.rows.map((x) => ({ id: x.id, at: x.at, type: x.type, title: x.title, body: x.body, payload: x.payload, channel: x.channel, delivered: x.delivered }));
    },

    // ---- Radar Learn (Pass 1) ----
    async createSetup(s) {
      const cols = ['setup_id','setup_key','symbol','mode','direction','setup_type','entry_price','buy_zone_low','buy_zone_high','target1','target2','stretch_target','invalidation','opportunity_score','confidence_score','risk_score','risk_label','conviction_score','status','promotion_reason','final_label','entry_filled','entry_filled_at','market_regime','narrative','macro_state','asset_class','exchange_source','history_class','depth_score','history_tier','engine','run_id','created_at','updated_at','expires_at'];
      const vals = cols.map((c) => (c === 'macro_state' ? J(s[c]) : (s[c] ?? null)));
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      await q(`INSERT INTO setups(${cols.join(',')}) VALUES (${ph})`, vals);
      return s;
    },
    async updateSetup(setupId, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const set = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
      await q(`UPDATE setups SET ${set} WHERE setup_id=$${keys.length + 1}`, [...keys.map((k) => fields[k]), setupId]);
    },
    async supersedeSetup(setupId, reason) {
      await q(`UPDATE setups SET status='superseded', resolution_reason=$1, resolved_at=now(), updated_at=now() WHERE setup_id=$2`, [reason, setupId]);
    },
    async markSetupResolved(setupId, status, reason, finalLabel) {
      await q(`UPDATE setups SET status=$1, resolution_reason=$2, final_label=$3, resolved_at=now(), updated_at=now() WHERE setup_id=$4`, [status, reason, finalLabel, setupId]);
    },
    async getActiveSetup(symbol, mode) {
      const r = await q(`SELECT * FROM setups WHERE symbol=$1 AND mode=$2 AND status='active' ORDER BY created_at DESC LIMIT 1`, [symbol, mode]);
      return r.rows[0] || null;
    },
    async getLastSetup(symbol, mode) {
      const r = await q(`SELECT * FROM setups WHERE symbol=$1 AND mode=$2 ORDER BY created_at DESC LIMIT 1`, [symbol, mode]);
      return r.rows[0] || null;
    },
    async getResolvableSetups() {
      const r = await q(`SELECT * FROM setups WHERE status='active'`);
      return r.rows;
    },
    async listSetups({ status, mode, limit = 50 } = {}) {
      const where = [], params = [];
      if (status) { params.push(status); where.push(`status=$${params.length}`); }
      if (mode) { params.push(mode); where.push(`mode=$${params.length}`); }
      params.push(limit);
      const r = await q(`SELECT * FROM setups ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return r.rows;
    },
    async getSetup(setupId) {
      const s = await q(`SELECT * FROM setups WHERE setup_id=$1`, [setupId]);
      if (!s.rows.length) return null;
      const [sv, oc, v] = await Promise.all([
        q(`SELECT * FROM signal_values WHERE setup_id=$1`, [setupId]),
        q(`SELECT * FROM outcomes WHERE setup_id=$1 ORDER BY horizon`, [setupId]),
        q(`SELECT * FROM setup_vectors WHERE setup_id=$1`, [setupId]),
      ]);
      return { setup: s.rows[0], signal_values: sv.rows, outcomes: oc.rows, vector: v.rows[0] || null };
    },
    async recordSignalValues(setupId, rows) {
      if (!rows.length) return;
      const cols = 7, vals = [], params = [];
      rows.forEach((r, i) => {
        const o = i * cols;
        vals.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7})`);
        params.push(setupId, r.signal_name, r.numeric_value, r.normalized_score, r.timeframe, r.direction_contribution, r.confidence_contribution);
      });
      await q(`INSERT INTO signal_values(setup_id, signal_name, numeric_value, normalized_score, timeframe, direction_contribution, confidence_contribution) VALUES ${vals.join(',')}`, params);
    },
    async saveSetupVector(setupId, v) {
      await q(`INSERT INTO setup_vectors(setup_id, vector, feature_names, dims, l2norm, history_class, mode) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (setup_id) DO NOTHING`,
        [setupId, v.vector, v.feature_names, v.dims, v.l2norm, v.history_class, v.mode]);
    },
    async getPricePath(symbol, fromISO, toISO) {
      const r = await q(`SELECT at, price FROM snapshot_coins WHERE symbol=$1 AND at>=$2 AND at<=$3 ORDER BY at`, [symbol, fromISO, toISO]);
      return r.rows.map((x) => ({ at: x.at, price: Number(x.price) }));
    },
    async upsertOutcome(o) {
      await q(`INSERT INTO outcomes(setup_id, horizon, hit_target1, hit_target2, hit_stretch, hit_invalidation, success_label, max_favorable_excursion, max_adverse_excursion, final_return, price_at_horizon, samples, data_complete)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (setup_id, horizon) DO NOTHING`,
        [o.setup_id, o.horizon, o.hit_target1, o.hit_target2, o.hit_stretch, o.hit_invalidation, o.success_label, o.max_favorable_excursion, o.max_adverse_excursion, o.final_return, o.price_at_horizon, o.samples, o.data_complete]);
    },
    async getOutcomes(setupId) {
      const r = await q(`SELECT * FROM outcomes WHERE setup_id=$1`, [setupId]);
      return r.rows;
    },
    async learnSuccessRate({ type, mode, history_class } = {}) {
      const params = [type || null, mode || null, history_class || null];
      const r = await q(`SELECT o.horizon, s.history_class,
          AVG(CASE WHEN o.hit_target1 AND NOT o.hit_invalidation THEN 1.0 ELSE 0.0 END) AS win_rate,
          AVG(o.final_return) AS avg_return, COUNT(*) AS n
        FROM setups s JOIN outcomes o ON o.setup_id=s.setup_id
        WHERE ($1::text IS NULL OR s.setup_type=$1) AND ($2::text IS NULL OR s.mode=$2) AND ($3::text IS NULL OR s.history_class=$3)
        GROUP BY o.horizon, s.history_class`, params);
      return r.rows;
    },
    async learnSignalEdge({ horizon = '24h' } = {}) {
      const r = await q(`SELECT sv.signal_name, sv.normalized_score,
          (CASE WHEN o.hit_target1 AND NOT o.hit_invalidation THEN 1.0 ELSE 0.0 END) AS win, o.final_return
        FROM signal_values sv JOIN outcomes o ON o.setup_id=sv.setup_id AND o.horizon=$1`, [horizon]);
      const agg = new Map(); // signal|bucket -> {wins, retSum, n}
      for (const x of r.rows) {
        const bucket = Math.floor(Number(x.normalized_score) / 10) * 10;
        const key = `${x.signal_name}|${bucket}`;
        const a = agg.get(key) || { signal_name: x.signal_name, bucket, wins: 0, retSum: 0, n: 0 };
        a.wins += Number(x.win); a.retSum += Number(x.final_return) || 0; a.n += 1;
        agg.set(key, a);
      }
      return [...agg.values()]
        .map((a) => ({ signal_name: a.signal_name, bucket: a.bucket, win_rate: a.n ? a.wins / a.n : 0, avg_return: a.n ? a.retSum / a.n : 0, n: a.n }))
        .sort((a, b) => a.signal_name.localeCompare(b.signal_name) || a.bucket - b.bucket);
    },
    async learnSimilar(setupId, k = 10) {
      const tv = await q(`SELECT vector, l2norm, mode, history_class FROM setup_vectors WHERE setup_id=$1`, [setupId]);
      if (!tv.rows.length) return [];
      const t = tv.rows[0];
      const cand = await q(`SELECT v.setup_id, v.vector, v.l2norm, s.symbol, s.setup_type, s.direction, s.final_label
        FROM setup_vectors v JOIN setups s USING (setup_id)
        WHERE v.mode=$1 AND v.history_class=$2 AND v.setup_id<>$3 AND s.status='resolved'`, [t.mode, t.history_class, setupId]);
      const cos = (a, an, b, bn) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * (b[i] ?? 0); return an && bn ? d / (an * bn) : 0; };
      return cand.rows
        .map((c) => ({ setup_id: c.setup_id, symbol: c.symbol, setup_type: c.setup_type, direction: c.direction, final_label: c.final_label, similarity: cos(t.vector, t.l2norm, c.vector, c.l2norm) }))
        .sort((a, b) => b.similarity - a.similarity).slice(0, k);
    },
    async getCoinHistories(symbols, sinceISO) {
      if (!symbols.length) return {};
      const ph = symbols.map((_, i) => `$${i + 1}`).join(',');
      const params = [...symbols];
      let sinceClause = '';
      if (sinceISO) { params.push(sinceISO); sinceClause = `AND at >= $${params.length}`; }
      const r = await q(`SELECT symbol, at, price, volume24h_usd, liquidity_usd, change24h FROM snapshot_coins WHERE symbol IN (${ph}) ${sinceClause} ORDER BY symbol, at`, params);
      const out = {};
      for (const x of r.rows) (out[x.symbol] ||= []).push({ at: x.at, price: x.price, volume24hUsd: x.volume24h_usd, liquidityUsd: x.liquidity_usd, change24h: x.change24h });
      return out;
    },
    // ---- Deep history (Pass 2) ----
    async upsertCandles(asset, source, timeframe, candles) {
      if (!candles.length) return 0;
      const cols = 9;
      const CHUNK = 500;
      let inserted = 0;
      for (let off = 0; off < candles.length; off += CHUNK) {
        const slice = candles.slice(off, off + CHUNK);
        const vals = [], params = [];
        slice.forEach((c, i) => {
          const o = i * cols;
          vals.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9})`);
          params.push(asset, source, timeframe, c.ts, c.open, c.high, c.low, c.close, c.volume);
        });
        await q(`INSERT INTO asset_history(asset,source,timeframe,ts,open,high,low,close,volume) VALUES ${vals.join(',')} ON CONFLICT (asset,source,timeframe,ts) DO NOTHING`, params);
        inserted += slice.length;
      }
      return inserted;
    },
    async getCandleTimestamps(asset, source, timeframe) {
      const r = await q(`SELECT ts FROM asset_history WHERE asset=$1 AND source=$2 AND timeframe=$3 ORDER BY ts`, [asset, source, timeframe]);
      return r.rows.map((x) => x.ts);
    },
    async getLatestCandleTs(asset, source, timeframe) {
      const r = await q(`SELECT max(ts) AS m FROM asset_history WHERE asset=$1 AND source=$2 AND timeframe=$3`, [asset, source, timeframe]);
      return r.rows[0]?.m || null;
    },
    async getCandles(asset, timeframe, limit = 600) {
      const r = await q(`SELECT ts, open, high, low, close, volume FROM asset_history WHERE asset=$1 AND timeframe=$2 ORDER BY ts DESC LIMIT $3`, [asset, timeframe, limit]);
      return r.rows.map((x) => ({ ts: x.ts, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume })).reverse();
    },
    async getCandlesRange(asset, timeframe, fromISO, toISO) {
      const r = await q(`SELECT ts, open, high, low, close, volume FROM asset_history WHERE asset=$1 AND timeframe=$2 AND ts>=$3 AND ts<=$4 ORDER BY ts`, [asset, timeframe, fromISO, toISO]);
      return r.rows;
    },
    async upsertAssetSource(row) {
      await q(`DELETE FROM asset_sources WHERE asset=$1 AND source=$2 AND timeframe=$3`, [row.asset, row.source, row.timeframe]);
      await q(`INSERT INTO asset_sources(asset,source,timeframe,first_available_date,last_available_date,data_coverage_days,expected_points,actual_points,missing_pct,gap_count,has_gaps,source_quality,status,last_backfilled_at,notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14)`,
        [row.asset, row.source, row.timeframe, row.first_available_date, row.last_available_date, row.data_coverage_days, row.expected_points, row.actual_points, row.missing_pct, row.gap_count, row.has_gaps, row.source_quality, row.status, row.notes || null]);
    },
    async getAssetSources(asset) {
      const r = await q(`SELECT * FROM asset_sources WHERE asset=$1`, [asset]);
      return r.rows;
    },
    async upsertAssetProfile(p) {
      await q(`INSERT INTO asset_profile(asset,best_source,best_timeframe,first_available_date,coverage_days,source_quality,depth_score,history_class,min_sample_met,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
               ON CONFLICT (asset) DO UPDATE SET best_source=$2,best_timeframe=$3,first_available_date=$4,coverage_days=$5,source_quality=$6,depth_score=$7,history_class=$8,min_sample_met=$9,updated_at=now()`,
        [p.asset, p.best_source, p.best_timeframe, p.first_available_date, p.coverage_days, p.source_quality, p.depth_score, p.history_class, p.min_sample_met]);
    },
    async getAssetProfile(asset) {
      const r = await q(`SELECT * FROM asset_profile WHERE asset=$1`, [asset]);
      return r.rows[0] || null;
    },
    async getAssetProfiles(symbols) {
      if (!symbols.length) return {};
      const ph = symbols.map((_, i) => `$${i + 1}`).join(',');
      const r = await q(`SELECT * FROM asset_profile WHERE asset IN (${ph})`, symbols);
      const out = {};
      for (const x of r.rows) out[x.asset] = x;
      return out;
    },
    async learnRRBuckets({ mode } = {}) {
      const r = await q(`SELECT s.entry_price, s.target1, s.invalidation,
          (CASE WHEN o.hit_target1 AND NOT o.hit_invalidation THEN 1.0 ELSE 0.0 END) AS win, o.final_return
        FROM setups s JOIN outcomes o ON o.setup_id=s.setup_id AND o.horizon='24h'
        WHERE ($1::text IS NULL OR s.mode=$1)`, [mode || null]);
      const buckets = [
        { label: '<1.5', lo: 0, hi: 1.5 }, { label: '1.5–2.5', lo: 1.5, hi: 2.5 },
        { label: '2.5–3.5', lo: 2.5, hi: 3.5 }, { label: '3.5–5', lo: 3.5, hi: 5 },
        { label: '5+', lo: 5, hi: Infinity },
      ].map((b) => ({ ...b, wins: 0, retSum: 0, n: 0 }));
      for (const x of r.rows) {
        const entry = Number(x.entry_price), t1 = Number(x.target1), inv = Number(x.invalidation);
        const reward = Math.abs(t1 - entry), riskD = Math.abs(entry - inv);
        if (!riskD) continue;
        const rr = reward / riskD;
        const b = buckets.find((bk) => rr >= bk.lo && rr < bk.hi);
        if (!b) continue;
        b.wins += Number(x.win); b.retSum += Number(x.final_return) || 0; b.n += 1;
      }
      return buckets.map((b) => ({ bucket: b.label, win_rate: b.n ? +(b.wins / b.n).toFixed(3) : null, avg_return: b.n ? +(b.retSum / b.n).toFixed(4) : null, n: b.n }));
    },
    async avgReturnForSetups(ids, horizon = '24h') {
      if (!ids || !ids.length) return { avg: null, n: 0 };
      const ph = ids.map((_, i) => `$${i + 2}`).join(',');
      const r = await q(`SELECT avg(final_return) AS a, count(*) AS n FROM outcomes WHERE horizon = $1 AND setup_id IN (${ph})`, [horizon, ...ids]);
      return { avg: r.rows[0].a == null ? null : Number(r.rows[0].a), n: Number(r.rows[0].n) };
    },
    async avgRrForSetups(ids) {
      if (!ids || !ids.length) return { avg: null, n: 0 };
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const reward = `(CASE WHEN target1 - entry_price >= 0 THEN target1 - entry_price ELSE entry_price - target1 END)`;
      const risk = `(CASE WHEN entry_price - invalidation >= 0 THEN entry_price - invalidation ELSE invalidation - entry_price END)`;
      const r = await q(`SELECT avg(CASE WHEN ${risk} <= 0 THEN NULL ELSE ${reward} / ${risk} END) AS a, count(*) AS n FROM setups WHERE setup_id IN (${ph})`, ids);
      return { avg: r.rows[0].a == null ? null : Number(r.rows[0].a), n: Number(r.rows[0].n) };
    },

    // ---- Pattern Library (v5.1) ----
    // Stamp a setup into its L0..L4 patterns (creating patterns as needed). Additive.
    async assignPatterns(setup) {
      const keys = patternKeysFor(setup);
      let parentId = null;
      for (const k of keys) {
        const found = await q(`SELECT pattern_id FROM patterns WHERE pattern_key=$1`, [k.key]);
        let pid = found.rows[0]?.pattern_id;
        if (!pid) {
          const ins = await q(
            `INSERT INTO patterns(pattern_key, pattern_name, level, parent_pattern_id, mode, direction, history_class, setup_type, market_regime, narrative, conditions)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (pattern_key) DO UPDATE SET updated_at=now() RETURNING pattern_id`,
            [k.key, k.name, k.level, parentId, k.dims.mode ?? null, k.dims.direction ?? null, k.dims.history_class ?? null,
             k.dims.setup_type ?? null, k.dims.market_regime ?? null, k.dims.narrative ?? null, JSON.stringify(k.dims)]);
          pid = ins.rows[0].pattern_id;
        }
        await q(`INSERT INTO pattern_members(pattern_id, setup_id, level) VALUES ($1,$2,$3) ON CONFLICT (pattern_id, setup_id) DO NOTHING`, [pid, setup.setup_id, k.level]);
        parentId = pid;
      }
      return keys.length;
    },

    // ---- Failure Learning (v5.2) ----
    // Classify WHY a losing/expired setup failed and store one row per setup. Idempotent.
    async classifyAndStoreFailure(setupId) {
      const sres = await q(`SELECT * FROM setups WHERE setup_id=$1`, [setupId]);
      const setup = sres.rows[0];
      if (!setup) return null;
      const outcomes = (await q(`SELECT * FROM outcomes WHERE setup_id=$1`, [setupId])).rows;
      const result = setupResult(outcomes);
      const isExpired = setup.status === 'expired';
      if (!isExpired && !(setup.status === 'resolved' && result.loss)) return null; // wins/open: skip
      const from = setup.created_at, to = setup.resolved_at || new Date().toISOString();
      let pricePath = [];
      try { pricePath = await this.getPricePath(setup.symbol, from, to); } catch { /* ignore */ }
      let btcReturn = null;
      try { const bp = await this.getPricePath('BTC', from, to); if (bp.length >= 2 && bp[0].price) btcReturn = (bp[bp.length - 1].price - bp[0].price) / bp[0].price; } catch { /* ignore */ }
      let volPre = null, volPost = null, liquidityUsd = null, volume24hUsd = null;
      try {
        const since = new Date(+new Date(from) - 6 * 3600e3).toISOString();
        const hist = (await this.getCoinHistories([setup.symbol], since))[setup.symbol] || [];
        const sigT = +new Date(from);
        const pre = hist.filter((h) => +new Date(h.at) < sigT).map((h) => h.volume24hUsd).filter((v) => v != null);
        const post = hist.filter((h) => +new Date(h.at) >= sigT).map((h) => h.volume24hUsd).filter((v) => v != null);
        volPre = pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : null;
        volPost = post.length ? post.reduce((a, b) => a + b, 0) / post.length : null;
        let nearest = null, nd = Infinity;
        for (const h of hist) { const d = Math.abs(+new Date(h.at) - sigT); if (d < nd) { nd = d; nearest = h; } }
        liquidityUsd = nearest?.liquidityUsd ?? null; volume24hUsd = nearest?.volume24hUsd ?? null;
      } catch { /* ignore */ }
      // pre-signal run-up: how much of entry->T1 was already covered before the signal
      let preSignalRunupFrac = null;
      try {
        const preStart = new Date(+new Date(from) - 12 * 3600e3).toISOString();
        const pre = await this.getPricePath(setup.symbol, preStart, from);
        if (pre.length >= 2 && setup.entry_price && setup.target1) {
          const p0 = pre[0].price, t1Move = setup.target1 - setup.entry_price;
          if (t1Move !== 0) preSignalRunupFrac = (setup.entry_price - p0) / t1Move; // long: positive run-up; sign handles short via t1Move sign
        }
      } catch { /* ignore */ }
      // macro risk-off + regime-at-resolve from VIX / DXY over the trade window
      let macroRiskOff = null, regimeAtResolve = null, macroEvidence = {};
      try {
        const vix = await this.getCandlesRange('MACRO:VIX', '1d', from, to);
        const dxy = await this.getCandlesRange('MACRO:DXY', '1d', from, to);
        const chg = (rows) => (rows.length >= 2 && rows[0].close ? (rows[rows.length - 1].close - rows[0].close) / rows[0].close : null);
        const vixChg = chg(vix), dxyChg = chg(dxy);
        if (vixChg != null || dxyChg != null) {
          macroEvidence = { vixChg, dxyChg };
          macroRiskOff = (vixChg != null && vixChg >= 0.10) || (dxyChg != null && dxyChg >= 0.02);
          regimeAtResolve = macroRiskOff ? 'risk_off' : ((vixChg != null && vixChg <= -0.10) ? 'risk_on' : 'neutral');
        }
      } catch { /* ignore */ }
      // narrative basket: avg realized return of OTHER setups with the same narrative resolved nearby
      let narrativeReturn = null;
      try {
        if (setup.narrative) {
          const lo = new Date(+new Date(to) - 3 * 86400e3).toISOString();
          const hi = new Date(+new Date(to) + 3 * 86400e3).toISOString();
          const r = await q(`SELECT avg(o.final_return) AS a, count(*) AS n
            FROM setups s JOIN outcomes o ON o.setup_id=s.setup_id AND o.horizon='24h'
            WHERE s.narrative=$1 AND s.setup_id<>$2 AND s.status='resolved' AND s.resolved_at BETWEEN $3 AND $4`,
            [setup.narrative, setupId, lo, hi]);
          if (Number(r.rows[0].n) >= 3 && r.rows[0].a != null) narrativeReturn = Number(r.rows[0].a);
        }
      } catch { /* ignore */ }
      const cls = classifyFailure({ setup, result, pricePath, btcReturn, volPre, volPost, liquidityUsd, volume24hUsd, preSignalRunupFrac, macroRiskOff, regimeAtResolve, macroEvidence, narrativeReturn });
      if (!cls) return null;
      await q(`INSERT INTO failure_reasons(setup_id, primary_reason, secondary_reasons, evidence, confidence, classifier_version)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (setup_id) DO UPDATE SET primary_reason=$2, secondary_reasons=$3, evidence=$4, confidence=$5, classifier_version=$6, classified_at=now()`,
        [setupId, cls.primary_reason, JSON.stringify(cls.secondary_reasons), JSON.stringify(cls.evidence), cls.confidence, cls.classifier_version]);
      return cls;
    },
    async getFailureReason(setupId) {
      const r = await q(`SELECT * FROM failure_reasons WHERE setup_id=$1`, [setupId]);
      return r.rows[0] || null;
    },
    async backfillFailures({ limit = 100000 } = {}) {
      const r = await q(`SELECT setup_id FROM setups WHERE status IN ('resolved','expired') ORDER BY resolved_at DESC NULLS LAST LIMIT $1`, [limit]);
      let classified = 0;
      for (const row of r.rows) { try { const c = await this.classifyAndStoreFailure(row.setup_id); if (c) classified++; } catch { /* skip */ } }
      return { scanned: r.rows.length, classified };
    },
    async getFailureBreakdown() {
      const r = await q(`SELECT primary_reason, count(*) AS n FROM failure_reasons GROUP BY primary_reason ORDER BY count(*) DESC`);
      const total = r.rows.reduce((s, x) => s + Number(x.n), 0);
      return { total, reasons: r.rows.map((x) => ({ reason: x.primary_reason, count: Number(x.n), share: total ? Number(x.n) / total : 0 })) };
    },

    // One-time/idempotent: assign patterns for setups that predate the Pattern Library
    // (membership is only auto-created for setups made after deploy). Safe to re-run.
    async backfillPatterns({ limit = 100000 } = {}) {
      const setups = await this.listSetups({ limit });
      let assigned = 0;
      for (const s of setups) { try { await this.assignPatterns(s); assigned++; } catch { /* skip malformed row */ } }
      return { setups: setups.length, assigned };
    },

    // Recompute pattern_performance. Pass {setupId} to limit to that setup's patterns
    // (+ ancestors); otherwise recompute all. Pure aggregation in JS for pg-mem portability.
    async recomputePatterns({ setupId = null, minSample = 12 } = {}) {
      // 1) target pattern ids
      let pats;
      if (setupId) {
        const mine = await q(`SELECT pattern_id FROM pattern_members WHERE setup_id=$1`, [setupId]);
        let frontier = mine.rows.map((r) => r.pattern_id);
        if (!frontier.length) return { patterns: 0 };
        // walk up parents iteratively (pg-mem-safe; no recursive CTE) so priors are fresh
        const seen = new Map();
        while (frontier.length) {
          const ph = frontier.map((_, i) => `$${i + 1}`).join(',');
          const rows = (await q(`SELECT pattern_id, parent_pattern_id, level FROM patterns WHERE pattern_id IN (${ph})`, frontier)).rows;
          const next = [];
          for (const r of rows) { if (!seen.has(r.pattern_id)) { seen.set(r.pattern_id, r); if (r.parent_pattern_id != null) next.push(r.parent_pattern_id); } }
          frontier = [...new Set(next)];
        }
        pats = [...seen.values()];
      } else {
        pats = (await q(`SELECT pattern_id, parent_pattern_id, level FROM patterns`)).rows;
      }
      if (!pats.length) return { patterns: 0 };
      pats.sort((a, b) => a.level - b.level); // L0 first so parents computed before children
      const ids = pats.map((p) => p.pattern_id);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');

      // 2) load members + their setups + outcomes for the target patterns
      const mem = (await q(`SELECT pattern_id, setup_id FROM pattern_members WHERE pattern_id IN (${ph})`, ids)).rows;
      const setupIds = [...new Set(mem.map((m) => m.setup_id))];
      const setupsById = new Map();
      const ocsBySetup = new Map();
      if (setupIds.length) {
        const sph = setupIds.map((_, i) => `$${i + 1}`).join(',');
        for (const s of (await q(`SELECT setup_id, status, market_regime, entry_price, target1, invalidation, resolved_at FROM setups WHERE setup_id IN (${sph})`, setupIds)).rows) setupsById.set(s.setup_id, s);
        for (const o of (await q(`SELECT setup_id, success_label, hit_target1, hit_target2, hit_stretch, hit_invalidation, final_return, max_adverse_excursion FROM outcomes WHERE setup_id IN (${sph})`, setupIds)).rows) {
          if (!ocsBySetup.has(o.setup_id)) ocsBySetup.set(o.setup_id, []);
          ocsBySetup.get(o.setup_id).push(o);
        }
      }
      const membersByPattern = new Map();
      for (const m of mem) { if (!membersByPattern.has(m.pattern_id)) membersByPattern.set(m.pattern_id, []); membersByPattern.get(m.pattern_id).push(m.setup_id); }

      const frBySetup = new Map();               // failure-reason rollup (v5.2)
      if (setupIds.length) {
        const sph = setupIds.map((_, i) => `$${i + 1}`).join(',');
        for (const f of (await q(`SELECT setup_id, primary_reason FROM failure_reasons WHERE setup_id IN (${sph})`, setupIds)).rows) frBySetup.set(f.setup_id, f.primary_reason);
      }

      const cutoff = Date.now() - 90 * 86400e3;
      const shrunkRateById = new Map();          // for child priors within this pass
      const parentOf = new Map(pats.map((p) => [String(p.pattern_id), p.parent_pattern_id]));
      const globalPrior = 0.5;

      // 3) aggregate per pattern, per window
      for (const p of pats) {
        const memberIds = membersByPattern.get(p.pattern_id) || [];
        const compute = (filterRolling) => {
          let n = 0, wins = 0, losses = 0, open = 0, t1 = 0, t2 = 0, str = 0, inv = 0, retSum = 0, retN = 0, rrSum = 0, rrN = 0, ddSum = 0, ddN = 0;
          let first = null, last = null;
          const regime = {};
          const failPrimaries = [];
          for (const sid of memberIds) {
            const s = setupsById.get(sid); if (!s) continue;
            const ocs = ocsBySetup.get(sid) || [];
            const r = setupResult(ocs);
            if (!r.resolved) { open++; continue; }
            const rt = s.resolved_at ? +new Date(s.resolved_at) : null;
            if (filterRolling && rt != null && rt < cutoff) continue;
            n++;
            if (r.win) wins++; else { losses++; failPrimaries.push(frBySetup.get(sid) || 'unknown'); }
            if (r.reachedT1) t1++; if (r.reachedT2) t2++; if (r.reachedStretch) str++; if (r.hitInv) inv++;
            if (r.finalReturn != null) { retSum += r.finalReturn; retN++; }
            const rr = rrOf(s); if (rr != null) { rrSum += rr; rrN++; }
            if (r.maxAdverse != null) { ddSum += r.maxAdverse; ddN++; }
            if (rt != null) { if (first == null || rt < first) first = rt; if (last == null || rt > last) last = rt; }
            const rg = s.market_regime || 'unknown';
            regime[rg] = regime[rg] || { n: 0, wins: 0 };
            regime[rg].n++; if (r.win) regime[rg].wins++;
          }
          const win_rate = n ? wins / n : null;
          const win_rate_lb = n ? wilsonLowerBound(wins, n) : null;
          return { n, wins, losses, open, t1, t2, str, inv, win_rate, win_rate_lb,
            avg_return: retN ? retSum / retN : null, avg_rr: rrN ? rrSum / rrN : null, avg_drawdown: ddN ? ddSum / ddN : null,
            regime, first, last, top_failure_reasons: rollupFailureReasons(failPrimaries) };
        };
        const all = compute(false);
        const roll = compute(true);

        // shrinkage toward parent's shrunk rate (this pass), else stored, else global
        let prior = globalPrior;
        const par = parentOf.get(String(p.pattern_id));
        if (par != null && shrunkRateById.has(par)) prior = shrunkRateById.get(par);
        else if (par != null) {
          const ps = await q(`SELECT shrunk_win_rate FROM pattern_performance WHERE pattern_id=$1 AND time_window='all_time'`, [par]);
          if (ps.rows[0]?.shrunk_win_rate != null) prior = Number(ps.rows[0].shrunk_win_rate);
        }
        const shrunk = all.win_rate != null ? shrink(all.win_rate, all.n, prior) : prior;
        shrunkRateById.set(p.pattern_id, shrunk);

        const trend = classifyTrend(roll.win_rate_lb, all.win_rate_lb, roll.n);
        const rm = regimeMemory(all.regime);
        const strength = patternStrength({ win_rate_lb: all.win_rate_lb ?? 0, sample_size: all.n,
          trend, invalidation_rate: all.n ? all.inv / all.n : 0, avg_return: all.avg_return ?? 0, avg_drawdown: all.avg_drawdown ?? 0 });

        for (const [win, agg] of [['all_time', all], ['rolling_90d', roll]]) {
          const isAll = win === 'all_time';
          await q(
            `INSERT INTO pattern_performance(pattern_id, time_window, sample_size, wins, losses, open, win_rate, win_rate_lb, shrunk_win_rate,
               avg_return, avg_rr, avg_drawdown, target1_rate, target2_rate, stretch_rate, invalidation_rate, failure_rate,
               trend, strength, regime_breakdown, best_regime, best_regime_win_rate, worst_regime, worst_regime_win_rate,
               recommended_conf_adj, activated, first_seen, last_seen, top_failure_reasons, computed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,now())
             ON CONFLICT (pattern_id, time_window) DO UPDATE SET
               sample_size=$3, wins=$4, losses=$5, open=$6, win_rate=$7, win_rate_lb=$8, shrunk_win_rate=$9,
               avg_return=$10, avg_rr=$11, avg_drawdown=$12, target1_rate=$13, target2_rate=$14, stretch_rate=$15,
               invalidation_rate=$16, failure_rate=$17, trend=$18, strength=$19, regime_breakdown=$20,
               best_regime=$21, best_regime_win_rate=$22, worst_regime=$23, worst_regime_win_rate=$24,
               recommended_conf_adj=$25, activated=$26, first_seen=$27, last_seen=$28, top_failure_reasons=$29, computed_at=now()`,
            [p.pattern_id, win, agg.n, agg.wins, agg.losses, agg.open, agg.win_rate, agg.win_rate_lb, isAll ? shrunk : null,
             agg.avg_return, agg.avg_rr, agg.avg_drawdown,
             agg.n ? agg.t1 / agg.n : null, agg.n ? agg.t2 / agg.n : null, agg.n ? agg.str / agg.n : null,
             agg.n ? agg.inv / agg.n : null, agg.n ? agg.losses / agg.n : null,
             isAll ? trend : null, isAll ? strength : null, JSON.stringify(rm.breakdown),
             rm.best?.regime ?? null, rm.best?.win_rate ?? null, rm.worst?.regime ?? null, rm.worst?.win_rate ?? null,
             isAll ? recommendedConfAdj(shrunk) : null, agg.n >= minSample,
             agg.first ? new Date(agg.first).toISOString() : null, agg.last ? new Date(agg.last).toISOString() : null,
             JSON.stringify(agg.top_failure_reasons || [])]);
        }
      }
      return { patterns: pats.length };
    },

    async getPatterns({ window = 'all_time', limit = 200 } = {}) {
      const r = await q(
        `SELECT p.pattern_id, p.pattern_name, p.level, p.mode, p.direction, p.history_class, p.setup_type, p.market_regime, p.narrative,
                pp.sample_size, pp.wins, pp.losses, pp.win_rate, pp.win_rate_lb, pp.shrunk_win_rate, pp.avg_return, pp.avg_rr,
                pp.invalidation_rate, pp.trend, pp.strength, pp.best_regime, pp.best_regime_win_rate, pp.worst_regime, pp.worst_regime_win_rate,
                pp.recommended_conf_adj, pp.activated, pp.last_seen, pp.top_failure_reasons
         FROM pattern_performance pp JOIN patterns p USING (pattern_id)
         WHERE pp.time_window=$1 AND pp.sample_size > 0
         ORDER BY pp.strength DESC NULLS LAST
         LIMIT $2`, [window, limit]);
      return r.rows.map((x) => ({ ...x,
        sample_size: Number(x.sample_size), wins: Number(x.wins), losses: Number(x.losses),
        win_rate: x.win_rate == null ? null : Number(x.win_rate), win_rate_lb: x.win_rate_lb == null ? null : Number(x.win_rate_lb),
        shrunk_win_rate: x.shrunk_win_rate == null ? null : Number(x.shrunk_win_rate),
        avg_return: x.avg_return == null ? null : Number(x.avg_return), avg_rr: x.avg_rr == null ? null : Number(x.avg_rr),
        invalidation_rate: x.invalidation_rate == null ? null : Number(x.invalidation_rate),
        strength: x.strength == null ? null : Number(x.strength),
        best_regime_win_rate: x.best_regime_win_rate == null ? null : Number(x.best_regime_win_rate),
        worst_regime_win_rate: x.worst_regime_win_rate == null ? null : Number(x.worst_regime_win_rate),
        recommended_conf_adj: x.recommended_conf_adj == null ? null : Number(x.recommended_conf_adj),
        top_failure_reasons: typeof x.top_failure_reasons === 'string' ? JSON.parse(x.top_failure_reasons || '[]') : (x.top_failure_reasons || []) }));
    },

    async getPatternDetail(patternId) {
      const p = await q(`SELECT * FROM patterns WHERE pattern_id=$1`, [patternId]);
      if (!p.rows.length) return null;
      const perf = await q(`SELECT * FROM pattern_performance WHERE pattern_id=$1`, [patternId]);
      const byWin = {};
      for (const row of perf.rows) byWin[row.time_window] = row;
      return { pattern: p.rows[0], performance: byWin };
    },

    // §2 Similar Setup Matching object — cohort = most-specific activated pattern
    // (fallback down the ladder), stats over RESOLVED members EXCLUDING the current setup.
    async matchSetup(setupId, { minMatchN = 8 } = {}) {
      const mem = (await q(`SELECT pm.pattern_id, p.level, p.pattern_name FROM pattern_members pm JOIN patterns p USING (pattern_id) WHERE pm.setup_id=$1 ORDER BY p.level DESC`, [setupId])).rows;
      if (!mem.length) return { available: false, note: 'No pattern membership yet.' };
      let chosen = null;
      for (const m of mem) { // most specific first; pick first with enough resolved peers
        const cnt = await q(`SELECT count(*) AS n FROM pattern_members pm JOIN setups s USING (setup_id)
          WHERE pm.pattern_id=$1 AND s.setup_id<>$2 AND s.status='resolved'`, [m.pattern_id, setupId]);
        const n = Number(cnt.rows[0].n);
        if (n >= minMatchN) { chosen = { ...m, n }; break; }
        if (!chosen) chosen = { ...m, n }; // coarsest fallback (L0) if nothing meets the bar
      }
      const fellBack = chosen.level < mem[0].level;
      // resolved cohort (exclude current)
      const cohort = (await q(`SELECT s.setup_id FROM pattern_members pm JOIN setups s USING (setup_id)
        WHERE pm.pattern_id=$1 AND s.setup_id<>$2 AND s.status='resolved'`, [chosen.pattern_id, setupId])).rows.map((r) => r.setup_id);
      let n = 0, wins = 0, t1 = 0, t2 = 0, inv = 0, retSum = 0, retN = 0;
      if (cohort.length) {
        const ph = cohort.map((_, i) => `$${i + 1}`).join(',');
        const ocs = (await q(`SELECT setup_id, success_label, hit_target1, hit_target2, hit_invalidation, final_return FROM outcomes WHERE setup_id IN (${ph})`, cohort)).rows;
        const by = new Map();
        for (const o of ocs) { if (!by.has(o.setup_id)) by.set(o.setup_id, []); by.get(o.setup_id).push(o); }
        for (const sid of cohort) {
          const r = setupResult(by.get(sid) || []);
          if (!r.resolved) continue;
          n++; if (r.win) wins++; if (r.reachedT1) t1++; if (r.reachedT2) t2++; if (r.hitInv) inv++;
          if (r.finalReturn != null) { retSum += r.finalReturn; retN++; }
        }
      }
      const avgRr = await this.avgRrForSetups(cohort);
      // vector top-N closest (existing kNN), independent of the current setup
      const closest = (await this.learnSimilar(setupId, 6)).map((c) => ({ setup_id: c.setup_id, symbol: c.symbol, similarity: c.similarity, final_label: c.final_label }));
      return {
        available: true,
        pattern_id: chosen.pattern_id, pattern_name: chosen.pattern_name, level: chosen.level, fellBack,
        n, win_rate: n ? wins / n : null, win_rate_lb: n ? wilsonLowerBound(wins, n) : null,
        avg_return: retN ? retSum / retN : null, avg_rr: avgRr.avg,
        target1_rate: n ? t1 / n : null, target2_rate: n ? t2 / n : null, invalidation_rate: n ? inv / n : null,
        closest,
      };
    },

    async getPerformance({ horizon } = {}) {
      const hf = horizon && horizon !== 'all';
      const P = hf ? [horizon] : [];
      const run = (sql) => q(sql, P);
      const win = `(CASE WHEN o.success_label IN ('target1','target2','stretch') THEN 1.0 ELSE 0.0 END)`;
      const reward = `(CASE WHEN s.target1 - s.entry_price >= 0 THEN s.target1 - s.entry_price ELSE s.entry_price - s.target1 END)`;
      const risk = `(CASE WHEN s.entry_price - s.invalidation >= 0 THEN s.entry_price - s.invalidation ELSE s.invalidation - s.entry_price END)`;
      const rr = `(CASE WHEN ${risk} <= 0 THEN NULL ELSE ${reward} / ${risk} END)`;
      const base = `FROM outcomes o JOIN setups s ON s.setup_id = o.setup_id WHERE o.success_label IS NOT NULL${hf ? ' AND o.horizon = $1' : ''}`;
      const agg = `count(*) AS n, avg(${win}) AS win_rate, avg(o.final_return) AS avg_return, avg(${rr}) AS avg_rr,
        avg(CASE WHEN o.hit_target1 THEN 1.0 ELSE 0 END) AS t1, avg(CASE WHEN o.hit_target2 THEN 1.0 ELSE 0 END) AS t2,
        avg(CASE WHEN o.hit_stretch THEN 1.0 ELSE 0 END) AS st, avg(CASE WHEN o.hit_invalidation THEN 1.0 ELSE 0 END) AS inv`;
      const numAgg = (r) => ({ k: r.k, n: Number(r.n), win_rate: r.win_rate == null ? null : Number(r.win_rate), avg_return: r.avg_return == null ? null : Number(r.avg_return), avg_rr: r.avg_rr == null ? null : Number(r.avg_rr), t1: r.t1 == null ? null : Number(r.t1), t2: r.t2 == null ? null : Number(r.t2), st: r.st == null ? null : Number(r.st), inv: r.inv == null ? null : Number(r.inv) });
      const grp = async (sql) => (await run(sql)).rows.map(numAgg);

      const overall = numAgg({ k: 'all', ...(await run(`SELECT ${agg} ${base}`)).rows[0] });
      const byMode = await grp(`SELECT s.mode AS k, ${agg} ${base} GROUP BY s.mode`);
      // cross-horizon comparison ignores the horizon filter
      const byHorizon = (await q(`SELECT o.horizon AS k, ${agg} FROM outcomes o JOIN setups s ON s.setup_id = o.setup_id WHERE o.success_label IS NOT NULL GROUP BY o.horizon`)).rows.map(numAgg);
      const coins = (await grp(`SELECT s.symbol AS k, ${agg} ${base} GROUP BY s.symbol`)).filter((c) => c.n >= 2);
      const longSetups = await grp(`SELECT s.setup_type AS k, ${agg} ${base} AND s.direction = 'LONG' GROUP BY s.setup_type`);
      const shortSetups = await grp(`SELECT s.setup_type AS k, ${agg} ${base} AND s.direction = 'SHORT' GROUP BY s.setup_type`);
      const narratives = await grp(`SELECT s.narrative AS k, ${agg} ${base} GROUP BY s.narrative`);
      const regimes = await grp(`SELECT s.market_regime AS k, ${agg} ${base} GROUP BY s.market_regime`);
      const recent = async (cond) => (await run(`SELECT s.setup_id, s.symbol, s.direction, s.mode, o.horizon, o.final_return, o.success_label, o.resolved_at ${base} AND o.success_label IN (${cond}) ORDER BY o.resolved_at DESC LIMIT 8`)).rows
        .map((r) => ({ setup_id: r.setup_id, symbol: r.symbol, direction: r.direction, mode: r.mode, horizon: r.horizon, final_return: r.final_return == null ? null : Number(r.final_return), success_label: r.success_label, resolved_at: r.resolved_at }));
      const recentWins = await recent(`'target1','target2','stretch'`);
      const recentLosses = await recent(`'fail','invalidated'`);

      // Why setups lost — derive reason buckets from outcome flags.
      const lr = (await run(`SELECT
          count(*) AS total,
          sum(CASE WHEN o.hit_invalidation THEN 1 ELSE 0 END) AS below_inval,
          sum(CASE WHEN o.success_label = 'fail' AND NOT o.hit_invalidation AND NOT o.hit_target1 THEN 1 ELSE 0 END) AS failed_t1
        ${base} AND o.success_label IN ('fail','invalidated')`)).rows[0] || {};
      const total = Number(lr.total || 0), belowInval = Number(lr.below_inval || 0), failedT1 = Number(lr.failed_t1 || 0);
      const lossReasons = { total, belowInvalidation: belowInval, failedTarget1: failedT1, other: Math.max(0, total - belowInval - failedT1) };

      // A representative losing setup with full decision-time detail + what happened.
      const ex = (await run(`SELECT s.symbol, s.direction, s.mode, s.entry_price, s.buy_zone_low, s.buy_zone_high,
          s.target1, s.target2, s.stretch_target, s.invalidation, s.market_regime, s.narrative,
          o.success_label, o.final_return, o.price_at_horizon, o.max_adverse_excursion, o.max_favorable_excursion, o.hit_invalidation, o.horizon, o.resolved_at
        ${base} AND o.success_label IN ('fail','invalidated') ORDER BY o.resolved_at DESC LIMIT 1`)).rows[0] || null;
      const exampleLoss = ex ? {
        symbol: ex.symbol, direction: ex.direction, mode: ex.mode,
        entryPrice: ex.entry_price, buyZoneLow: ex.buy_zone_low, buyZoneHigh: ex.buy_zone_high,
        target1: ex.target1, target2: ex.target2, stretchTarget: ex.stretch_target, invalidation: ex.invalidation,
        marketRegime: ex.market_regime, narrative: ex.narrative,
        successLabel: ex.success_label, finalReturn: ex.final_return == null ? null : Number(ex.final_return),
        priceAtHorizon: ex.price_at_horizon, maxAdverse: ex.max_adverse_excursion == null ? null : Number(ex.max_adverse_excursion),
        maxFavorable: ex.max_favorable_excursion == null ? null : Number(ex.max_favorable_excursion),
        hitInvalidation: ex.hit_invalidation, horizon: ex.horizon, resolvedAt: ex.resolved_at,
      } : null;

      return { horizon: horizon || 'all', overall, byMode, byHorizon, coins, longSetups, shortSetups, narratives, regimes, recentWins, recentLosses, lossReasons, exampleLoss };
    },
    async learnWinRateByType({ mode } = {}) {
      const r = await q(
        `SELECT s.setup_type AS setup_type,
                (CASE WHEN o.success_label IN ('target1','target2','stretch') THEN 1.0 ELSE 0.0 END) AS win
         FROM setups s JOIN outcomes o ON o.setup_id = s.setup_id AND o.horizon = '24h'
         WHERE ($1::text IS NULL OR s.mode = $1)`, [mode || null]);
      const m = new Map();
      for (const x of r.rows) { const e = m.get(x.setup_type) || { setup_type: x.setup_type, wins: 0, n: 0 }; e.wins += Number(x.win); e.n += 1; m.set(x.setup_type, e); }
      return [...m.values()].map((e) => ({ setup_type: e.setup_type, win_rate: e.n ? e.wins / e.n : 0, n: e.n }));
    },
    async getRadarLearnStats() {
      const [a, act, oc, ls, lo] = await Promise.all([
        q(`SELECT count(*) AS n FROM setups`), q(`SELECT count(*) AS n FROM setups WHERE status='active'`),
        q(`SELECT count(*) AS n FROM outcomes`), q(`SELECT max(created_at) AS m FROM setups`), q(`SELECT max(resolved_at) AS m FROM outcomes`),
      ]);
      return { setups: Number(a.rows[0].n), activeSetups: Number(act.rows[0].n), outcomes: Number(oc.rows[0].n), lastSetupAt: ls.rows[0].m, lastOutcomeAt: lo.rows[0].m };
    },
    async getBackfillStats() {
      const [ap, lb, cls, cc] = await Promise.all([
        q(`SELECT count(*) AS n, max(updated_at) AS m FROM asset_profile`),
        q(`SELECT max(last_backfilled_at) AS m FROM asset_sources`),
        q(`SELECT history_class, count(*) AS n FROM asset_profile GROUP BY history_class`),
        q(`SELECT count(*) AS n FROM asset_history`),
      ]);
      return { assets: Number(ap.rows[0].n), lastProfileAt: ap.rows[0].m, lastBackfillAt: lb.rows[0].m, candles: Number(cc.rows[0].n), classes: cls.rows.map((r) => ({ history_class: r.history_class, n: Number(r.n) })) };
    },
    async getCoverageOverview() {
      const r = await q(`SELECT history_class, COUNT(*) AS n, AVG(depth_score) AS avg_depth, AVG(coverage_days) AS avg_days FROM asset_profile GROUP BY history_class`);
      return r.rows.map((x) => ({ history_class: x.history_class, n: Number(x.n), avg_depth: Math.round(Number(x.avg_depth) || 0), avg_coverage_days: Math.round(Number(x.avg_days) || 0) }));
    },
    async getMeta() {
      const [snaps, runs, events, last, uni] = await Promise.all([
        q('SELECT count(*)::int AS c FROM market_snapshots'),
        q('SELECT count(*)::int AS c FROM scan_runs'),
        q('SELECT count(*)::int AS c FROM alert_events'),
        q('SELECT finished_at, status FROM scan_runs ORDER BY created_at DESC LIMIT 1'),
        q('SELECT coins FROM scan_universe ORDER BY id DESC LIMIT 1'),
      ]);
      return {
        driver: 'postgres',
        universeSize: uni.rows[0]?.coins?.length || 0,
        snapshots: snaps.rows[0].c, scanRuns: runs.rows[0].c, alertEvents: events.rows[0].c,
        lastScanAt: last.rows[0]?.finished_at || null, lastScanStatus: last.rows[0]?.status || 'none',
      };
    },
    async close() { if (!injected) await pool.end(); },
  };
}

function mapRun(x) {
  return {
    id: x.run_id, trigger: x.trigger, startedAt: x.started_at, finishedAt: x.finished_at,
    durationMs: x.duration_ms, source: x.source, universeRaw: x.universe_raw,
    kept: x.kept, rejected: x.rejected, reasonCounts: x.reason_counts, errors: x.errors,
    integrations: x.integrations, status: x.status,
  };
}
