// Scan pipeline (now async/store-driver agnostic).
import { buildUniverse } from './universe.js';
import { applyFilters } from './filters.js';
import { scoreCoin, makeTargets, formatPrice } from '../engines/scoring.js';
import { scoreCoinV2 } from '../engines/scoringV2.js';
import { getScoringInput } from '../engines/historyProvider.js';
import { buildSeries, historyTier, tierRank } from '../engines/history.js';
import { getDexScreenerTrending, getGeckoTerminalTrending, getMacroAssets } from './externalApis.js';
import { evaluatePromotions, classifySetupType } from './radarLearn.js';
import { categoryOf, CATEGORIES, UNIVERSE_LABEL, ROBINHOOD_ONLY, isRobinhood } from '../config/robinhoodUniverse.js';
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

const MIN_RR = { scalp: 1.5, day: 2.5, swing: 3.0 };
const ELITE_RR = 5.0;

function decorate(scored, mode) {
  const targets = makeTargets(scored, mode);
  const dir = scored.direction, price = scored.price;
  // % move from current price to each level (profit + for targets, loss − for stop).
  const mv = (to) => (dir === 'LONG' ? ((to - price) / price) * 100 : ((price - to) / price) * 100);
  const fp = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
  const t1 = mv(targets.target1), t2 = mv(targets.target2), st = mv(targets.stretchTarget), risk = mv(targets.invalidation);
  const rr = risk < 0 ? Math.abs(t1 / risk) : 0;

  // Alpha Score — composite ranking. RR is a major factor (30%).
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const rrNorm = clamp((rr / ELITE_RR) * 100, 0, 100);
  const freshness = scored.signals?.freshness ?? 0;
  const consensus = scored.consensus ?? 0;
  const alphaScore = Math.round(
    0.28 * (scored.conviction || 0) + 0.18 * (scored.confidence || 0) +
    0.30 * rrNorm + 0.12 * freshness + 0.12 * consensus
  );
  const elite = rr >= ELITE_RR;
  const meetsRR = rr >= (MIN_RR[mode] ?? 1.5);

  return {
    ...scored, targets, alphaScore, elite, meetsRR, minRR: MIN_RR[mode] ?? 1.5,
    setupType: classifySetupType(scored.signalDetail, scored.direction), narrative: scored.sector || 'Crypto',
    trade: { toTarget1: +t1.toFixed(2), toTarget2: +t2.toFixed(2), toStretch: +st.toFixed(2), toInvalidation: +risk.toFixed(2), rr: +rr.toFixed(2) },
    display: {
      price: formatPrice(scored.price),
      buyZone: `${formatPrice(targets.buyZone[0])} - ${formatPrice(targets.buyZone[1])}`,
      target1: formatPrice(targets.target1), target2: formatPrice(targets.target2),
      stretch: formatPrice(targets.stretchTarget), invalidation: formatPrice(targets.invalidation),
      target1Move: fp(t1), target2Move: fp(t2), stretchMove: fp(st), riskMove: fp(risk),
      rr: `${rr.toFixed(1)}R`, alphaScore, elite,
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
      byMode[mode] = scored.sort((a, b) => b.alphaScore - a.alphaScore || b.conviction - a.conviction);
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

// Forward-looking RR analytics from the current scan (live, no outcomes needed).
function computeRRAnalytics(byMode) {
  if (!byMode) return { byMode: [], byClass: [] };
  const modeRows = [], classMap = new Map();
  for (const m of Object.keys(byMode)) {
    const ops = byMode[m] || [];
    if (!ops.length) continue;
    const avg = ops.reduce((s, o) => s + (o.trade?.rr || 0), 0) / ops.length;
    modeRows.push({ mode: m, avgRR: +avg.toFixed(2), count: ops.length, elite: ops.filter((o) => o.elite).length, meetsMin: ops.filter((o) => o.meetsRR).length });
    for (const o of ops) {
      const c = o.history_class || 'unknown';
      const e = classMap.get(c) || { history_class: c, sum: 0, n: 0, elite: 0 };
      e.sum += o.trade?.rr || 0; e.n += 1; if (o.elite) e.elite += 1;
      classMap.set(c, e);
    }
  }
  const byClass = [...classMap.values()].map((e) => ({ history_class: e.history_class, avgRR: +(e.sum / e.n).toFixed(2), count: e.n, elite: e.elite }));
  return { byMode: modeRows, byClass };
}

export async function getDashboard(mode = 'day') {
  const [opp, snap, universe, lastRun] = await Promise.all([
    store.getOpportunities(), store.getLatestSnapshot(), store.getUniverse(), store.getLastScanRun(),
  ]);
  let opportunities = opp?.byMode?.[mode] || opp?.byMode?.day || [];
  const stats = computeStats(opportunities);
  const narratives = deriveNarratives(opportunities);
  const rrAnalytics = computeRRAnalytics(opp?.byMode);

  // Real 24h win-rate + win-rate-by-RR-bucket from Radar Learn (Postgres).
  let winRate24h = null, winRate24hWins = null, winRate24hTotal = null, winRateByRR = [], matchByType = {}, setupMap = {};
  if (store.activeDriver() === 'postgres') {
    try {
      const rows = await store.learnSuccessRate({ mode });
      const h = rows.find((r) => r.horizon === '24h');
      if (h && Number(h.n) > 0) { winRate24h = Math.round(Number(h.win_rate) * 100); winRate24hTotal = Number(h.n); winRate24hWins = Math.round(Number(h.win_rate) * Number(h.n)); }
    } catch { /* leave null */ }
    try { winRateByRR = await store.learnRRBuckets({ mode }); } catch { winRateByRR = []; }
    try {
      const rows = await store.learnWinRateByType({ mode });
      const m = {}; for (const r of rows) if (Number(r.n) >= 3) m[r.setup_type] = Math.round(Number(r.win_rate) * 100);
      matchByType = m;
    } catch { /* leave empty */ }
    try {
      const active = await store.listSetups({ status: 'active', limit: 300 });
      for (const a of active) setupMap[`${a.symbol}|${a.mode}`] = a.setup_id;
    } catch { /* leave empty */ }
  }

  const temp = snap?.macro?.marketTemperature ?? 50;
  const marketRegime = temp >= 65 ? 'risk-on' : temp <= 40 ? 'risk-off' : 'neutral';
  opportunities = opportunities.map((o) => ({ ...o, category: categoryOf(o.symbol), historicalMatch: matchByType[o.setupType] ?? null, marketRegime, setupId: setupMap[`${o.symbol}|${mode}`] || null }));

  const categoryCounts = {};
  for (const o of opportunities) { const c = o.category || 'Other'; categoryCounts[c] = (categoryCounts[c] || 0) + 1; }
  const categories = CATEGORIES.filter((c) => categoryCounts[c]).map((c) => ({ category: c, count: categoryCounts[c] }));

  const macro = snap?.macro
    ? { ...snap.macro, totalOpportunities: stats.totalOpportunities, avgConfidence: stats.avgConfidence, winRate24h, winRate24hWins, winRate24hTotal, statsLive: true }
    : null;

  return {
    ready: Boolean(opp), mode, opportunities,
    dataSource: snap?.source || 'none', updatedAt: opp?.at || null,
    macro, narratives, emerging: (snap?.emerging || []).filter((e) => !ROBINHOOD_ONLY || isRobinhood(e.symbol)),
    marketRegime,
    universeLabel: UNIVERSE_LABEL, robinhoodOnly: ROBINHOOD_ONLY, categories,
    analytics: { rr: rrAnalytics, winRateByRR },
    universe: universe ? { size: universe.coins.length, source: universe.source, filter: universe.filter, label: universe.label } : null,
    lastRun,
  };
}
