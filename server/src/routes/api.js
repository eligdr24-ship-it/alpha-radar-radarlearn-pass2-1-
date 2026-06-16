import express from 'express';
import { narratives } from '../data/coins.js';
import { runScan, getDashboard } from '../services/scanner.js';
import { sendTelegramAlert } from '../services/telegram.js';
import * as store from '../db/store.js';

const router = express.Router();
const has = (k) => Boolean(process.env[k] && String(process.env[k]).trim());

async function integrationsStatus() {
  const [snap, run] = await Promise.all([store.getLatestSnapshot(), store.getLastScanRun()]);
  return {
    marketData: snap?.source || 'none',
    dexScreener: run?.integrations?.dex || 'unknown',
    geckoTerminal: run?.integrations?.gecko || 'unknown',
    macro: run?.integrations?.macro || 'unknown',
    telegram: has('TELEGRAM_BOT_TOKEN') && has('TELEGRAM_CHAT_ID') ? 'configured' : 'not-configured',
    coinglass: has('COINGLASS_API_KEY') ? 'configured' : 'not-configured',
    coinMarketCap: has('COINMARKETCAP_API_KEY') ? 'configured' : 'not-configured',
    xTwitter: has('X_BEARER_TOKEN') ? 'configured' : 'not-configured',
    etherscan: has('ETHERSCAN_API_KEY') ? 'configured' : 'not-configured',
    solscan: has('SOLSCAN_API_KEY') ? 'configured' : 'not-configured',
  };
}

router.get('/health', async (req, res) => res.json({
  ok: true, app: 'Alpha Radar', version: '1.2.0',
  storeDriver: store.activeDriver(),
  liveMarketData: process.env.LIVE_MARKET_DATA !== 'false',
  scan: await store.getMeta(),
}));

router.get('/dashboard', async (req, res) => {
  const mode = req.query.mode || 'day';
  let dash = await getDashboard(mode);
  if (!dash.ready) { await runScan('on-demand'); dash = await getDashboard(mode); }
  const integrations = await integrationsStatus();

  // Data-source transparency: per-coin label + overall status (never silent).
  const ageSeconds = dash.updatedAt ? Math.round((Date.now() - new Date(dash.updatedAt).getTime()) / 1000) : null;
  const staleAfter = Math.max(600, 3 * 60 * Number(process.env.SCAN_INTERVAL_MINUTES || 2));
  const stale = ageSeconds != null && ageSeconds > staleAfter;
  const labeled = dash.opportunities.map((o) => ({ ...o, dataSource: sourceLabel(o.source, stale) }));
  // Prioritize asymmetric setups: show those meeting the mode's minimum RR.
  // If too few qualify, relax to the best-by-AlphaScore and flag it (honest).
  const qualified = labeled.filter((o) => o.meetsRR);
  const relaxed = qualified.length < 3;
  const opportunities = relaxed ? labeled : qualified;
  const minRR = labeled[0]?.minRR ?? null;
  const rrFilter = { mode, minRR, qualified: qualified.length, total: labeled.length, relaxed,
    note: relaxed ? `Only ${qualified.length} setup(s) meet the ${minRR}R minimum for ${mode}; showing best available by Alpha Score.` : null };
  const top = opportunities[0];
  const isLive = /coingecko|binance/.test(dash.dataSource || '') && !stale;
  const dataStatus = {
    live: isLive, stale, source: dash.dataSource || 'none',
    label: sourceLabel(dash.dataSource, stale),
    ageSeconds, lastScanStatus: dash.lastRun?.status || 'none',
    errors: dash.lastRun?.errors || [],
    note: isLive ? null : stale
      ? 'Showing the last cached scan — the scanner may be asleep (free tier) or live APIs failed. Prices may be out of date.'
      : 'Live market APIs are unavailable; prices below are MOCK placeholders, not real market data.',
  };

  res.json({
    version: '1.2.0', dataSource: dash.dataSource, dataStatus, integrations,
    emerging: dash.emerging, universe: dash.universe, rrFilter, analytics: dash.analytics, marketRegime: dash.marketRegime,
    updatedAt: dash.updatedAt || new Date().toISOString(),
    macro: dash.macro, narratives: dash.narratives || narratives, opportunities, lastRun: dash.lastRun,
    alerts: [
      { type: 'Scan', title: `Data: ${dataStatus.label}`, text: dataStatus.note || `${dash.universe?.size ?? 0} coins, rescored across scalp/day/swing.`, age: ageSeconds != null ? `${ageSeconds}s ago` : 'now' },
      top ? { type: 'Opportunity', title: `Top ${top.direction}: ${top.symbol}${top.elite ? ' 🚀 ELITE' : ''}`, text: `Alpha ${top.alphaScore} | RR ${top.display.rr} | Conviction ${top.conviction}/100`, age: 'now' } : null,
      { type: 'Telegram', title: 'Telegram Alerts', text: integrations.telegram === 'configured' ? 'Configured and ready.' : 'Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to activate.', age: 'config' },
    ].filter(Boolean),
  });
});

// Standalone RR analytics (live RR by mode/class + win-rate by RR bucket).
router.get('/analytics/rr', async (req, res) => {
  const dash = await getDashboard(req.query.mode || 'day');
  res.json({ rr: dash.analytics?.rr || { byMode: [], byClass: [] }, winRateByRR: dash.analytics?.winRateByRR || [] });
});

// Real price series for a coin chart — asset_history candles preferred,
// snapshot_coins as fallback (and the only source for sub-hour timeframes).
router.get('/chart/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  const tf = req.query.tf || '1h';
  const CANDLE = { '1h': 120, '4h': 120, '1d': 150 };           // tf -> candle count
  const SNAP_LOOKBACK = { '5m': 6 * 3600e3, '15m': 18 * 3600e3, '30m': 36 * 3600e3 };
  let series = [], source = 'none';
  if (store.activeDriver() === 'postgres') {
    if (CANDLE[tf]) {
      try {
        const c = await store.getCandles(sym, tf, CANDLE[tf]);
        if (c.length) { series = c.map((x) => ({ t: x.ts, price: Number(x.close) })); source = 'asset_history'; }
      } catch { /* fall through */ }
    }
    if (!series.length) {
      const lookback = SNAP_LOOKBACK[tf] || 24 * 3600e3;
      try {
        const path = await store.getPricePath(sym, new Date(Date.now() - lookback).toISOString(), new Date().toISOString());
        if (path.length) { series = path.map((p) => ({ t: p.at, price: p.price })); source = 'snapshots'; }
      } catch { /* none */ }
    }
  }
  res.json({ symbol: sym, tf, source, series });
});

// Trade Replay — full prediction-vs-reality detail for one tracked setup (read-only).
router.get('/trade/:setupId', async (req, res) => {
  if (store.activeDriver() !== 'postgres') return res.json({ available: false, note: 'Trade replay needs PostgreSQL + Radar Learn history.' });
  const data = await store.getSetup(req.params.setupId);
  if (!data || !data.setup) return res.status(404).json({ available: false, error: 'Setup not found' });
  const s = data.setup;
  const created = +new Date(s.created_at);
  const lastOutcome = (data.outcomes || []).reduce((m, o) => Math.max(m, +new Date(o.resolved_at || 0)), 0);
  const toMs = Math.max(lastOutcome, created + 24 * 3600e3, Date.now() - 1);
  const fromISO = new Date(created - 2 * 3600e3).toISOString();
  const toISO = new Date(Math.min(toMs, Date.now())).toISOString();
  let path = [];
  try { path = await store.getPricePath(s.symbol, fromISO, toISO); } catch { path = []; }

  // Derive hit timestamps from the snapshot price path (display-time only).
  const isLong = s.direction === 'LONG';
  const lo = Math.min(s.buy_zone_low, s.buy_zone_high), hi = Math.max(s.buy_zone_low, s.buy_zone_high);
  const firstAt = (pred) => { for (const p of path) if (pred(p.price)) return p.at; return null; };
  const upHit = (lvl) => firstAt((px) => px >= lvl), dnHit = (lvl) => firstAt((px) => px <= lvl);
  const timeline = {
    signalAt: s.created_at,
    entryAt: s.entry_filled_at || firstAt((px) => px >= lo && px <= hi),
    target1At: s.target1 != null ? (isLong ? upHit(s.target1) : dnHit(s.target1)) : null,
    target2At: s.target2 != null ? (isLong ? upHit(s.target2) : dnHit(s.target2)) : null,
    stretchAt: s.stretch_target != null ? (isLong ? upHit(s.stretch_target) : dnHit(s.stretch_target)) : null,
    invalidationAt: s.invalidation != null ? (isLong ? dnHit(s.invalidation) : upHit(s.invalidation)) : null,
    resolvedAt: s.resolved_at,
  };

  // System learning — similar resolved setups.
  let similar = [];
  try { similar = await store.learnSimilar(req.params.setupId, 30); } catch { similar = []; }
  const wins = similar.filter((x) => ['target1', 'target2', 'stretch'].includes(x.final_label)).length;
  let avgRet = { avg: null, n: 0 }, avgRr = { avg: null, n: 0 };
  try { avgRet = await store.avgReturnForSetups(similar.map((x) => x.setup_id), '24h'); } catch { /* ignore */ }
  try { avgRr = await store.avgRrForSetups(similar.map((x) => x.setup_id)); } catch { /* ignore */ }
  const learning = {
    n: similar.length,
    winRate: similar.length ? Math.round((wins / similar.length) * 100) : null,
    avgReturn: avgRet.avg,
    avgRr: avgRr.avg,
    items: similar.slice(0, 8),
  };

  res.json({ available: true, setup: s, signal_values: data.signal_values || [], outcomes: data.outcomes || [], vector: data.vector || null, path, timeline, learning });
});

// System Performance — how Radar Learn's own calls are doing, by horizon.
router.get('/performance', async (req, res) => {
  const horizon = req.query.horizon || 'all';
  if (store.activeDriver() !== 'postgres') {
    return res.json({ enabled: false, horizon, note: 'Waiting for resolved outcomes. Radar Learn needs more live history.', performance: null });
  }
  try {
    const performance = await store.getPerformance({ horizon });
    res.json({ enabled: true, horizon, performance });
  } catch (e) {
    res.json({ enabled: true, horizon, error: e.message, performance: null });
  }
});

// System status — scanner / database / API / backfill / Radar Learn.
router.get('/system/status', async (req, res) => {
  const driver = store.activeDriver();
  const isPg = driver === 'postgres';
  const [lastRun, integrations] = await Promise.all([store.getLastScanRun(), integrationsStatus()]);
  const cronEnabled = process.env.DISABLE_CRON !== 'true';
  const intervalMinutes = Math.min(5, Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES || 2)));
  let learn = { enabled: false, note: 'Requires PostgreSQL' };
  let backfill = { enabled: false, note: 'Requires PostgreSQL' };
  let coverage = [];
  if (isPg) {
    try { learn = { enabled: true, ...(await store.getRadarLearnStats()) }; } catch (e) { learn = { enabled: true, error: e.message }; }
    try { backfill = { enabled: true, ...(await store.getBackfillStats()) }; } catch (e) { backfill = { enabled: true, error: e.message }; }
    try { coverage = await store.getCoverageOverview(); } catch { coverage = []; }
  }
  const liveData = /coingecko|binance/.test(lastRun?.source || '');
  res.json({
    timestamp: new Date().toISOString(),
    scanner: {
      ok: lastRun?.status?.startsWith('ok') || false, cronEnabled, intervalMinutes,
      lastScanAt: lastRun?.startedAt || null, lastScanStatus: lastRun?.status || 'none',
      source: lastRun?.source || 'none', universeSize: lastRun?.kept ?? null,
      durationMs: lastRun?.durationMs ?? null, errors: lastRun?.errors || [],
    },
    database: { ok: isPg, driver, note: isPg ? 'Connected — persistence + learning active' : 'In-memory (no DATABASE_URL) — data resets on restart' },
    api: { ok: liveData, liveData, integrations },
    backfill: { ...backfill, coverage },
    radarLearn: learn,
  });
});

// Human-readable data-source label per coin / overall.
function sourceLabel(source, stale) {
  if (stale) return 'STALE: Cached';
  if (/coingecko/.test(source || '')) return 'LIVE: CoinGecko';
  if (/binance/.test(source || '')) return 'LIVE: Binance';
  if (/mock/.test(source || '')) return 'FALLBACK: Mock';
  return 'UNKNOWN';
}

router.get('/coin/:symbol', async (req, res) => {
  const mode = req.query.mode || 'day';
  const dash = await getDashboard(mode);
  const item = dash.opportunities.find((c) => c.symbol.toLowerCase() === req.params.symbol.toLowerCase());
  if (!item) return res.status(404).json({ error: 'Coin not found in current universe' });
  res.json({ ...item, reasoning: [
    `${item.direction === 'LONG' ? 'Bullish' : 'Bearish'} structure on ${mode} mode`,
    `Consensus ${item.consensus}/100, freshness ${item.signals.freshness}/100`,
    `Data source: ${dash.dataSource}`, 'Targets from volatility, structure and risk model',
  ] });
});

// --- Scan controls + history ---
router.post('/scan/run', async (req, res) => { const run = await runScan('api'); res.json({ ok: run.status !== 'error', run }); });
router.get('/scan/status', async (req, res) => res.json({ meta: await store.getMeta(), lastRun: await store.getLastScanRun() }));
router.get('/scan/runs', async (req, res) => res.json({ runs: await store.getScanRuns(Number(req.query.limit) || 20) }));
router.get('/universe', async (req, res) => {
  const u = await store.getUniverse();
  if (!u) return res.status(404).json({ error: 'Universe not built yet' });
  res.json(u);
});
router.get('/source-status', async (req, res) => res.json({ statuses: await store.getSourceStatus(Number(req.query.limit) || 50) }));
router.get('/alerts/events', async (req, res) => res.json({ events: await store.getAlertEvents(Number(req.query.limit) || 50) }));

router.post('/alerts/test-telegram', async (req, res) => {
  const message = req.body?.message || 'Alpha Radar test alert: Telegram integration connected.';
  const result = await sendTelegramAlert(message);
  await store.addAlertEvent({ at: new Date().toISOString(), type: 'telegram-test', title: 'Telegram test alert',
    body: message, channel: 'telegram', delivered: Boolean(result.ok), payload: result });
  res.json(result);
});

router.get('/sources', async (req, res) => res.json({
  version: '1.2.0', liveReady: true,
  connectedNow: ['CoinGecko markets', 'Binance fallback', 'DEX Screener', 'GeckoTerminal', 'Fear & Greed'],
  configuredByEnv: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'COINGLASS_API_KEY', 'COINMARKETCAP_API_KEY', 'X_BEARER_TOKEN', 'TWELVEDATA_API_KEY', 'POLYGON_API_KEY', 'FRED_API_KEY', 'ETHERSCAN_API_KEY', 'SOLSCAN_API_KEY'],
  integrations: await integrationsStatus(),
}));
router.get('/integrations', async (req, res) => res.json({ version: '1.2.0', integrations: await integrationsStatus() }));

// --- Radar Learn (read-only) ---
router.get('/setups', async (req, res) => res.json({ setups: await store.listSetups({ status: req.query.status, mode: req.query.mode, limit: Number(req.query.limit) || 50 }) }));
router.get('/setups/:id', async (req, res) => {
  const s = await store.getSetup(req.params.id);
  if (!s) return res.status(404).json({ error: 'Setup not found' });
  res.json(s);
});
router.get('/learn/success-rate', async (req, res) => res.json({ horizonRates: await store.learnSuccessRate({ type: req.query.type, mode: req.query.mode, history_class: req.query.class }) }));
router.get('/learn/signal-edge', async (req, res) => res.json({ edges: await store.learnSignalEdge({ horizon: req.query.horizon || '24h' }) }));
router.get('/learn/similar/:id', async (req, res) => res.json({ similar: await store.learnSimilar(req.params.id, Number(req.query.k) || 10) }));
router.get('/learn/coverage', async (req, res) => res.json({ coverage: await store.getCoverageOverview() }));

// --- Deep history coverage (read-only) ---
router.get('/assets/:symbol/coverage', async (req, res) => {
  const [profile, sources] = await Promise.all([store.getAssetProfile(req.params.symbol), store.getAssetSources(req.params.symbol)]);
  if (!profile && !sources.length) return res.status(404).json({ error: 'No backfilled history for this asset' });
  res.json({ profile, sources });
});
router.get('/assets/:symbol/history', async (req, res) => {
  const tf = req.query.timeframe || '1d';
  const candles = req.query.from && req.query.to
    ? await store.getCandlesRange(req.params.symbol, tf, req.query.from, req.query.to)
    : await store.getCandles(req.params.symbol, tf, Number(req.query.limit) || 600);
  res.json({ asset: req.params.symbol, timeframe: tf, candles });
});
router.get('/emerging', async (req, res) => {
  const snap = await store.getLatestSnapshot();
  res.json({ version: '1.2.0', source: ['dexscreener', 'geckoterminal'], emerging: snap?.emerging || [] });
});

export default router;
