// Postgres driver. Created when DATABASE_URL is set. Accepts an injected pool
// (used by tests with pg-mem); otherwise builds a real pg Pool.
import pg from 'pg';
import { runMigrations } from './migrate.js';

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
