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
  const { candles, notes } = fetched;
  if (!candles || !candles.length) return null;
  await store.upsertCandles(asset, source, timeframe, candles);
  const tsAll = await store.getCandleTimestamps(asset, source, timeframe);
  const prov = computeProvenance(tsAll.map((ts) => ({ ts })), timeframe);
  await store.upsertAssetSource({ asset, source, timeframe, ...prov, notes });
  return prov;
}

// Backfill one asset across sources (priority) + recompute its profile.
export async function backfillAsset(symbol, { fetchers = defaultFetchers(), isMacro = false } = {}) {
  if (store.activeDriver() !== 'postgres') return { skipped: true };
  const asset = symbol;
  const provs = [];

  if (isMacro) {
    const since = await store.getLatestCandleTs(asset, 'stooq', '1d');
    const p = await ingest(asset, 'stooq', '1d', await fetchers.macro({ asset, sinceMs: since ? +new Date(since) + 1 : 0 }));
    if (p) provs.push({ ...p, source: 'stooq', timeframe: '1d' });
  } else {
    // Priority 1: Binance daily (full history) + intraday (recent window)
    const bDailySince = await store.getLatestCandleTs(asset, 'binance', '1d');
    const pBin = await ingest(asset, 'binance', '1d', await fetchers.binance({ asset, timeframe: '1d', sinceMs: bDailySince ? +new Date(bDailySince) + 1 : 0 }));
    if (pBin) provs.push({ ...pBin, source: 'binance', timeframe: '1d' });

    for (const tf of ['4h', '1h']) {
      const last = await store.getLatestCandleTs(asset, 'binance', tf);
      const sinceMs = last ? +new Date(last) + 1 : Date.now() - HIST_INTRADAY_DAYS() * DAY;
      await ingest(asset, 'binance', tf, await fetchers.binance({ asset, timeframe: tf, sinceMs }));
    }

    // Priority 2: CoinGecko daily (fallback / cross-check)
    const cgSince = await store.getLatestCandleTs(asset, 'coingecko', '1d');
    const pCg = await ingest(asset, 'coingecko', '1d', await fetchers.coingecko({ asset, sinceMs: cgSince ? +new Date(cgSince) + 1 : 0 }));
    if (pCg) provs.push({ ...pCg, source: 'coingecko', timeframe: '1d' });
  }

  // Recompute profile from best (deepest, cleanest) daily source
  const dailyProvs = provs.filter((p) => p.timeframe === '1d');
  const best = pickBestSource(dailyProvs);
  if (best) {
    const depth = depthScore(best.data_coverage_days, best.source_quality);
    const minMet = minSampleMet(best.data_coverage_days, best.source_quality);
    const isDexOnly = best.source === 'geckoterminal';
    const history_class = classifyHistory({ coverage_days: best.data_coverage_days, depth_score: depth, min_sample_met: minMet, isDexOnly });
    await store.upsertAssetProfile({
      asset, best_source: best.source, best_timeframe: '1d', first_available_date: best.first_available_date,
      coverage_days: best.data_coverage_days, source_quality: best.source_quality, depth_score: depth, history_class, min_sample_met: minMet,
    });
    return { asset, best_source: best.source, coverage_days: best.data_coverage_days, depth_score: depth, history_class };
  }
  return { asset, profile: null };
}

const MACRO_ASSETS = ['MACRO:GOLD', 'MACRO:SPX', 'MACRO:NDX', 'MACRO:VIX', 'MACRO:DXY'];

export async function runBackfill({ symbols = [], includeMacro = true, fetchers = defaultFetchers() } = {}) {
  if (store.activeDriver() !== 'postgres') return { skipped: true, reason: 'not-postgres' };
  const results = [];
  for (const sym of symbols) {
    try { results.push(await backfillAsset(sym, { fetchers })); }
    catch (e) { results.push({ asset: sym, error: e.message }); }
  }
  if (includeMacro) for (const m of MACRO_ASSETS) {
    try { results.push(await backfillAsset(m, { fetchers, isMacro: true })); }
    catch (e) { results.push({ asset: m, error: e.message }); }
  }
  return { count: results.length, results };
}
