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
  const opportunities = dash.opportunities.map((o) => ({ ...o, dataSource: sourceLabel(o.source, stale) }));
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
    emerging: dash.emerging, universe: dash.universe,
    updatedAt: dash.updatedAt || new Date().toISOString(),
    macro: dash.macro, narratives: dash.narratives || narratives, opportunities, lastRun: dash.lastRun,
    alerts: [
      { type: 'Scan', title: `Data: ${dataStatus.label}`, text: dataStatus.note || `${dash.universe?.size ?? 0} coins, rescored across scalp/day/swing.`, age: ageSeconds != null ? `${ageSeconds}s ago` : 'now' },
      top ? { type: 'Opportunity', title: `Top ${top.direction}: ${top.symbol}`, text: `Conviction ${top.conviction}/100 | Zone ${top.display.buyZone} | Target ${top.display.target1}`, age: 'now' } : null,
      { type: 'Telegram', title: 'Telegram Alerts', text: integrations.telegram === 'configured' ? 'Configured and ready.' : 'Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to activate.', age: 'config' },
    ].filter(Boolean),
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
