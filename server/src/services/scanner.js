// Scan pipeline (now async/store-driver agnostic).
import { buildUniverse } from './universe.js';
import { applyFilters } from './filters.js';
import { scoreCoin, makeTargets, formatPrice } from '../engines/scoring.js';
import { scoreCoinV2 } from '../engines/scoringV2.js';
import { getScoringInput } from '../engines/historyProvider.js';
import { buildSeries, historyTier, tierRank } from '../engines/history.js';
import { getDexScreenerTrending, getGeckoTerminalTrending, getMacroAssets } from './externalApis.js';
import { evaluatePromotions } from './radarLearn.js';
import * as store from '../db/store.js';

const MODES = ['scalp', 'day', 'swing'];
const HISTORY_WINDOW_MS = 31 * 24 * 3600e3;
let isScanning = false;

// Engine selection: historical v2 when the asset has deep backfilled history
// (long/medium class) OR >= 24h (T1) of live snapshots; otherwise legacy v1.
// Both paths emit a `why` array so the dashboard contract is uniform.
function scoreWithHistory(coin, mode, input, profile) {
  const tier = historyTier(input.series || buildSeries([]));
  const deep = profile && (profile.history_class === 'long' || profile.history_class === 'medium');
  if (!deep && tier.rank < tierRank.T1) {
    const v1 = scoreCoin(coin, mode);
    return {
      ...v1, engine: 'v1-fallback', historyTier: tier.tier, warming: true,
      history_class: profile?.history_class || 'new', depth_score: profile?.depth_score ?? null,
      why: [
        `Warming up (${tier.spanHours}h history) — baseline heuristic until 24h of data accumulates`,
        `${v1.direction} bias from 24h move ${(coin.change24h || 0).toFixed(1)}%`,
        `Risk ${v1.risk}, consensus ${v1.consensus}/100`,
      ],
    };
  }
  return scoreCoinV2(coin, mode, input);
}

function decorate(scored, mode) {
  const targets = makeTargets(scored, mode);
  return {
    ...scored, targets,
    display: {
      price: formatPrice(scored.price),
      buyZone: `${formatPrice(targets.buyZone[0])} - ${formatPrice(targets.buyZone[1])}`,
      target1: formatPrice(targets.target1), target2: formatPrice(targets.target2),
      stretch: formatPrice(targets.stretchTarget), invalidation: formatPrice(targets.invalidation),
    },
  };
}

async function getEmerging() {
  try {
    const [dex, gecko] = await Promise.all([getDexScreenerTrending(), getGeckoTerminalTrending()]);
    const merged = [...dex, ...gecko]
      .filter((x, i, a) => a.findIndex((y) => `${y.chain}:${y.symbol}` === `${x.chain}:${x.symbol}`) === i)
      .sort((a, b) => b.volume24h - a.volume24h).slice(0, 12)
      .map((x) => ({
        ...x,
        earlyScore: Math.min(99, Math.round(45 + Math.log10(Math.max(x.volume24h, 1)) * 8 + Math.max(Math.min(x.change24h, 200), -50) * 0.12)),
        rugRisk: x.liquidityUsd < 50000 ? 88 : x.liquidityUsd < 250000 ? 64 : x.liquidityUsd < 1e6 ? 42 : 24,
      }));
    return { emerging: merged, dexLive: dex.length > 0, geckoLive: gecko.length > 0 };
  } catch { return { emerging: [], dexLive: false, geckoLive: false }; }
}

function buildSourceStatus(runId, at, built, dexLive, geckoLive, macro) {
  const marketOk = built.source !== 'mock-fallback';
  return [
    { runId, at, source: 'market', status: marketOk ? 'live' : 'fallback', detail: { source: built.source, errors: built.errors } },
    { runId, at, source: 'dexscreener', status: dexLive ? 'live' : 'fallback', detail: {} },
    { runId, at, source: 'geckoterminal', status: geckoLive ? 'live' : 'fallback', detail: {} },
    { runId, at, source: 'macro', status: macro?.macroSource || 'unknown', detail: { configured: macro?.configured } },
  ];
}

export async function runScan(trigger = 'manual') {
  if (isScanning) return { skipped: true, reason: 'scan-already-running' };
  isScanning = true;
  const runId = `run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const built = await buildUniverse();
    const { kept, rejected, reasonCounts, cfg } = applyFilters(built.coins);

    await store.setUniverse({ runId, builtAt: startedAt, source: built.source, filter: cfg,
      counts: { raw: built.coins.length, kept: kept.length, rejected: rejected.length }, coins: kept });

    const [{ emerging, dexLive, geckoLive }, macro] = await Promise.all([getEmerging(), getMacroAssets()]);
    await store.addSnapshot({ runId, at: startedAt, source: built.source, coins: kept, macro, emerging });

    // Load snapshot history + deep-history profiles for all kept symbols.
    const symbols = kept.map((c) => c.symbol);
    let histories = {}, profiles = {};
    try { histories = await store.getCoinHistories(symbols, new Date(Date.now() - HISTORY_WINDOW_MS).toISOString()); }
    catch (e) { console.error('[scan] history load failed:', e.message); }
    try { profiles = await store.getAssetProfiles(symbols); } catch { profiles = {}; }

    const byMode = {};
    for (const mode of MODES) {
      const scored = [];
      for (const c of kept) {
        const input = await getScoringInput(c.symbol, mode, histories[c.symbol] || [], profiles[c.symbol] || null);
        scored.push(decorate(scoreWithHistory(c, mode, input, profiles[c.symbol] || null), mode));
      }
      byMode[mode] = scored.sort((a, b) => b.conviction - a.conviction);
    }
    await store.setOpportunities({ runId, at: startedAt, source: built.source, byMode });

    // Radar Learn: promote meaningful setups (Postgres only; no-op otherwise).
    try {
      const promo = await evaluatePromotions({ byMode, macro, narratives: null, source: built.source, runId, at: startedAt });
      if (!promo.skipped && (promo.created || promo.superseded)) {
        console.log(`[radar-learn] +${promo.created} setups, ~${promo.updated} updated, ${promo.superseded} superseded, ${promo.filled} entries`);
      }
    } catch (e) { console.error('[radar-learn] promotion failed:', e.message); }

    // Priority 4: persist per-source status/errors
    await store.addSourceStatus(buildSourceStatus(runId, startedAt, built, dexLive, geckoLive, macro));

    const run = await store.addScanRun({
      id: runId, trigger, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      source: built.source, universeRaw: built.coins.length, kept: kept.length, rejected: rejected.length,
      reasonCounts, errors: built.errors,
      integrations: { dex: dexLive ? 'live' : 'fallback', gecko: geckoLive ? 'live' : 'fallback', macro: macro.macroSource },
      status: built.source === 'mock-fallback' ? 'ok-mock' : 'ok',
    });

    // Priority 5: persist an alert event for the top setup
    const top = byMode.day[0];
    if (top) {
      await store.addAlertEvent({
        at: startedAt, type: 'opportunity', channel: 'scan',
        title: `Top ${top.direction}: ${top.symbol}`,
        body: `Conviction ${top.conviction}/100 | zone ${top.display.buyZone} | T1 ${top.display.target1}`,
        payload: { symbol: top.symbol, direction: top.direction, conviction: top.conviction, source: built.source },
      });
    }

    console.log(`[scan] ${run.status} via ${run.source} | kept ${run.kept}/${run.universeRaw} in ${run.durationMs}ms (${trigger})`);
    return run;
  } catch (err) {
    const run = await store.addScanRun({ id: runId, trigger, startedAt, finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0, status: 'error', errors: [err.message] });
    console.error('[scan] ERROR (keeping previous data):', err.message);
    return run;
  } finally {
    isScanning = false;
  }
}

function computeStats(ops) {
  if (!ops.length) return { totalOpportunities: 0, avgConfidence: 0 };
  const conf = ops.reduce((s, o) => s + (o.confidence || 0), 0) / ops.length;
  return { totalOpportunities: ops.length, avgConfidence: Math.round(conf) };
}

// Live narrative strength/momentum derived from the scored universe by sector.
function deriveNarratives(ops) {
  if (!ops.length) return null;
  const bySector = new Map();
  for (const o of ops) {
    const s = o.sector || 'Other';
    const e = bySector.get(s) || { narrative: s, conv: 0, mom: 0, n: 0 };
    e.conv += o.conviction || 0; e.mom += o.change24h || 0; e.n += 1;
    bySector.set(s, e);
  }
  return [...bySector.values()]
    .map((e) => ({ narrative: e.narrative, strength: Math.round(e.conv / e.n), momentum: Math.round(e.mom / e.n) }))
    .sort((a, b) => b.strength - a.strength).slice(0, 6);
}

export async function getDashboard(mode = 'day') {
  const [opp, snap, universe, lastRun] = await Promise.all([
    store.getOpportunities(), store.getLatestSnapshot(), store.getUniverse(), store.getLastScanRun(),
  ]);
  const opportunities = opp?.byMode?.[mode] || opp?.byMode?.day || [];
  const stats = computeStats(opportunities);
  const narratives = deriveNarratives(opportunities);

  // Real 24h win-rate from Radar Learn outcomes (Postgres). Null until outcomes
  // accrue — the UI shows "—" rather than a fabricated number.
  let winRate24h = null;
  if (store.activeDriver() === 'postgres') {
    try {
      const rows = await store.learnSuccessRate({ mode });
      const h = rows.find((r) => r.horizon === '24h');
      if (h && Number(h.n) > 0) winRate24h = Math.round(Number(h.win_rate) * 100);
    } catch { /* leave null */ }
  }

  const macro = snap?.macro
    ? { ...snap.macro, totalOpportunities: stats.totalOpportunities, avgConfidence: stats.avgConfidence, winRate24h, statsLive: true }
    : null;

  return {
    ready: Boolean(opp), mode, opportunities,
    dataSource: snap?.source || 'none', updatedAt: opp?.at || null,
    macro, narratives, emerging: snap?.emerging || [],
    universe: universe ? { size: universe.coins.length, source: universe.source, filter: universe.filter } : null,
    lastRun,
  };
}
