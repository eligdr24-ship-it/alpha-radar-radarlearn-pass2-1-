// Resumable, idempotent deep-history backfill orchestrator.
// Fetchers are injectable for testing; defaults hit the real source modules.
import * as store from '../db/store.js';
import { computeProvenance, depthScore, minSampleMet, classifyHistory, pickBestSource } from './provenance.js';
import { backfillBinance } from './sources/binanceKlines.js';
import { backfillCoinGecko } from './sources/coingeckoHistory.js';
import { backfillMacro } from './sources/macroHistory.js';
import { backfillDex } from './sources/dexHistory.js';

const DAY = 86400e3;
const cfgNum = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
export const HIST_INTRADAY_DAYS = () => cfgNum('HIST_INTRADAY_DAYS', 720);

// Default fetchers: each returns { candles, notes }.
export function defaultFetchers() {
  return {
    binance: ({ asset, timeframe, sinceMs }) => backfillBinance({ symbol: asset, timeframe, sinceMs }).then((candles) => ({ candles, notes: 'binance' })),
    coingecko: ({ asset }) => backfillCoinGecko({ symbol: asset }),
    macro: ({ asset }) => backfillMacro({ asset }),
    dex: ({ asset, network, pool }) => backfillDex({ network, pool }),
  };
}

async function ingest(asset, source, timeframe, fetched) {
  const { candles, notes } = fetched || {};
  if (!candles || !candles.length) return null;
  await store.upsertCandles(asset, source, timeframe, candles);
  const tsAll = await store.getCandleTimestamps(asset, source, timeframe);
  const prov = computeProvenance(tsAll.map((ts) => ({ ts })), timeframe);
  await store.upsertAssetSource({ asset, source, timeframe, ...prov, notes });
  return { prov, count: candles.length };
}

// Backfill one asset across sources (priority) + recompute its profile.
// Each source is isolated: a Binance 451 must NOT prevent the CoinGecko fallback.
export async function backfillAsset(symbol, { fetchers = defaultFetchers(), isMacro = false } = {}) {
  if (store.activeDriver() !== 'postgres') return { skipped: true };
  const asset = symbol;
  const provs = [];
  const errors = [];
  let candles = 0;
  const add = (source, tf, r) => { if (r) { candles += r.count; provs.push({ ...r.prov, source, timeframe: tf }); } };
  const run = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${label} → ${e.message}`); } };

  if (isMacro) {
    await run('stooq:1d', async () => {
      const since = await store.getLatestCandleTs(asset, 'stooq', '1d');
      add('stooq', '1d', await ingest(asset, 'stooq', '1d', await fetchers.macro({ asset, sinceMs: since ? +new Date(since) + 1 : 0 })));
    });
  } else {
    // Priority 1: Binance daily + intraday (resilient).
    await run('binance:1d', async () => {
      const since = await store.getLatestCandleTs(asset, 'binance', '1d');
      add('binance', '1d', await ingest(asset, 'binance', '1d', await fetchers.binance({ asset, timeframe: '1d', sinceMs: since ? +new Date(since) + 1 : 0 })));
    });
    for (const tf of ['4h', '1h']) {
      await run(`binance:${tf}`, async () => {
        const last = await store.getLatestCandleTs(asset, 'binance', tf);
        const sinceMs = last ? +new Date(last) + 1 : Date.now() - HIST_INTRADAY_DAYS() * DAY;
        const r = await ingest(asset, 'binance', tf, await fetchers.binance({ asset, timeframe: tf, sinceMs }));
        if (r) candles += r.count;
      });
    }
    // Priority 2: CoinGecko daily — fallback / cross-check (always attempted, even if Binance failed).
    await run('coingecko:1d', async () => {
      const since = await store.getLatestCandleTs(asset, 'coingecko', '1d');
      add('coingecko', '1d', await ingest(asset, 'coingecko', '1d', await fetchers.coingecko({ asset, sinceMs: since ? +new Date(since) + 1 : 0 })));
    });
  }

  // Recompute profile from best (deepest, cleanest) daily source.
  const best = pickBestSource(provs.filter((p) => p.timeframe === '1d'));
  let profile = null;
  if (best) {
    const depth = depthScore(best.data_coverage_days, best.source_quality);
    const minMet = minSampleMet(best.data_coverage_days, best.source_quality);
    const isDexOnly = best.source === 'geckoterminal';
    const history_class = classifyHistory({ coverage_days: best.data_coverage_days, depth_score: depth, min_sample_met: minMet, isDexOnly });
    await store.upsertAssetProfile({
      asset, best_source: best.source, best_timeframe: '1d', first_available_date: best.first_available_date,
      coverage_days: best.data_coverage_days, source_quality: best.source_quality, depth_score: depth, history_class, min_sample_met: minMet,
    });
    profile = { best_source: best.source, coverage_days: best.data_coverage_days, depth_score: depth, history_class };
  }
  return { asset, candles, sources: [...new Set(provs.map((p) => p.source))], errors, ...(profile || { profile: null }) };
}

const MACRO_ASSETS = ['MACRO:GOLD', 'MACRO:SPX', 'MACRO:NDX', 'MACRO:VIX', 'MACRO:DXY'];

export async function runBackfill({ symbols = [], includeMacro = true, fetchers = defaultFetchers() } = {}) {
  if (store.activeDriver() !== 'postgres') return { skipped: true, reason: 'not-postgres' };
  const results = [];
  let totalCandles = 0;
  const doOne = async (sym, isMacro) => {
    try { const r = await backfillAsset(sym, { fetchers, isMacro }); totalCandles += r.candles || 0; results.push(r); }
    catch (e) { results.push({ asset: sym, candles: 0, errors: [e.message] }); }
  };
  for (const sym of symbols) await doOne(sym, false);
  if (includeMacro) for (const m of MACRO_ASSETS) await doOne(m, true);
  return { count: results.length, totalCandles, results };
}
