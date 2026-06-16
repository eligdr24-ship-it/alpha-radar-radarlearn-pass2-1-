// Radar Learn — event-driven setup promotion. Pure decision logic is exported
// and unit-tested; evaluatePromotions() is the DB-touching orchestrator
// (Postgres only — no-ops on the memory driver).
import * as store from '../db/store.js';

const MODE_TF = { scalp: '5m', day: '1h', swing: '4h' };
export const COOLDOWN_MS = { scalp: 30 * 60e3, day: 4 * 3600e3, swing: 24 * 3600e3 };
export const ENTRY_WINDOW_MS = { scalp: 3600e3, day: 6 * 3600e3, swing: 24 * 3600e3 };
const MAX_HORIZON_MS = 30 * 24 * 3600e3;
const cfgNum = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
export const RL_CFG = () => ({
  emerge: cfgNum('RL_EMERGE_CONVICTION', 65),
  topN: cfgNum('RL_TOP_N', 5),
  jump: cfgNum('RL_JUMP_DELTA', 12),
  bands: [65, 75, 85],
});

// in-memory prev-scan state for jump/rank/band detection (rebuildable)
const lastByKey = new Map();
export function _resetState() { lastByKey.clear(); }

// setup_type from the dominant signal at decision time
export function classifySetupType(signalDetail = {}, direction = 'LONG') {
  const b = signalDetail.breakout?.detail || {};
  const t = signalDetail.trend?.detail || {};
  const m = signalDetail.momentum?.detail || {};
  const v = signalDetail.volatility?.detail || {};
  if (b.reclaim && b.reclaim !== 0) return 'sweep-reclaim';
  if (b.posInRange != null && b.rvol > 1.3 && (b.posInRange > 0.98 || b.posInRange < 0.02)) {
    return direction === 'LONG' ? 'breakout' : 'breakdown';
  }
  if (m.adx >= 25 || m.macdHist != null) {
    if (Math.abs((t.stretchPct ?? 0)) > 6 && (t.reversalScore ?? 0) >= 60) return 'mean-reversion';
    return 'momentum-thrust';
  }
  if (t.reversalScore != null && t.reversalScore >= 60) return 'mean-reversion';
  if ((v.compression ?? 0) > 70) return 'squeeze-expansion';
  if (Math.abs(t.emaAlign ?? 0) >= 1) return 'trend-continuation';
  return 'range-fade';
}

// ~14-dim normalized feature vector (decision-time) for kNN similarity
export function buildFeatureVector(op) {
  const sd = op.signalDetail || {};
  const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
  const sat = (x) => Math.max(0, Math.min(1, x));
  const tanh01 = (x) => (Math.tanh(x) + 1) / 2;
  const vol = sd.volatility?.detail || {}, volm = sd.volume?.detail || {}, tr = sd.trend?.detail || {},
    mo = sd.momentum?.detail || {}, br = sd.breakout?.detail || {};
  const names = ['dir', 'volRegime', 'compression', 'rvol', 'volumeZ', 'emaAlign', 'structure', 'stretch', 'rsi', 'adx', 'macdSign', 'posInRange', 'conviction', 'confidence'];
  const vector = [
    op.direction === 'LONG' ? 1 : 0,
    sat(num(vol.volRegimePct) / 100),
    sat(num(vol.compression) / 100),
    sat((Math.log2(Math.max(num(volm.rvol, 1), 0.01)) + 3) / 6),
    tanh01(num(volm.z) / 3),
    sat((num(tr.emaAlign) + 1) / 2),
    sat((num(tr.structure) + 1) / 2),
    tanh01(num(tr.stretchPct) / 10),
    sat(num(mo.rsi, 50) / 100),
    sat(num(mo.adx) / 100),
    sat((Math.sign(num(mo.macdHist)) + 1) / 2),
    sat(num(br.posInRange, 0.5)),
    sat(num(op.conviction) / 100),
    sat(num(op.confidence) / 100),
  ];
  const l2norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
  return { vector, feature_names: names, dims: vector.length, l2norm };
}

// decision-time market context
export function deriveContext(macro, narratives, coin, source) {
  const temp = macro?.marketTemperature ?? 50;
  const market_regime = temp >= 65 ? 'risk-on' : temp <= 40 ? 'risk-off' : 'neutral';
  return {
    market_regime,
    narrative: coin.sector || 'Crypto',
    macro_state: { marketTemperature: macro?.marketTemperature, fearGreed: macro?.fearGreed, btcDominance: macro?.btcDominance },
    asset_class: coin.type || 'alt',
    exchange_source: coin.source || source || 'unknown',
  };
}

const bandOf = (c, bands) => bands.filter((b) => c >= b).length;
const inZone = (price, lo, hi) => price >= Math.min(lo, hi) && price <= Math.max(lo, hi);

// PURE: decide what to do for one (symbol,mode) given current op + prior state.
// returns { action: 'create'|'update'|'supersede-create'|'fill-entry'|'none', reason, setupType, buyZoneValid }
export function decidePromotion(op, ctx) {
  const cfg = ctx.cfg;
  const setupType = classifySetupType(op.signalDetail, op.direction);
  const zone = op.targets?.buyZone || [op.targets?.buyZone?.[0]];
  const buyZoneValid = Array.isArray(zone) && zone.length >= 2 ? inZone(op.price, zone[0], zone[1]) : false;
  const { active, prev, rank } = ctx;

  if (active) {
    if (active.direction !== op.direction) return { action: 'supersede-create', reason: 'direction-change', setupType, buyZoneValid };
    if (active.setup_type !== setupType) return { action: 'supersede-create', reason: 'setup-type-change', setupType, buyZoneValid };
    const bandUp = prev && bandOf(op.conviction, cfg.bands) > bandOf(prev.conviction, cfg.bands);
    const jump = prev && op.conviction - prev.conviction >= cfg.jump;
    if (!active.entry_filled && buyZoneValid) return { action: 'fill-entry', reason: 'buy-zone-valid', setupType, buyZoneValid };
    if (bandUp) return { action: 'update', reason: 'conviction-band-cross', setupType, buyZoneValid };
    if (jump) return { action: 'update', reason: 'major-score-jump', setupType, buyZoneValid };
    return { action: 'none', reason: 'no-event', setupType, buyZoneValid };
  }

  // no active setup → can a new one emerge?
  if (op.conviction >= cfg.emerge && buyZoneValid) return { action: 'create', reason: 'emerge', setupType, buyZoneValid };
  const enteredTop = rank != null && rank <= cfg.topN && (!prev || prev.rank == null || prev.rank > cfg.topN);
  if (enteredTop) return { action: 'create', reason: 'entered-top-list', setupType, buyZoneValid };
  const zoneBecameValid = buyZoneValid && prev && prev.buyZoneValid === false;
  if (zoneBecameValid) return { action: 'create', reason: 'buy-zone-valid', setupType, buyZoneValid };
  const jump = prev && op.conviction - prev.conviction >= cfg.jump && op.conviction >= cfg.emerge - 10;
  if (jump) return { action: 'create', reason: 'major-score-jump', setupType, buyZoneValid };
  return { action: 'none', reason: 'no-event', setupType, buyZoneValid };
}

function mkSetup(op, mode, decision, context, runId, at) {
  const tNow = +new Date(at);
  const liq = op.signalDetail?.breakout?.detail?.liquidityFactor ?? 0.5;
  const baseRisk = { meme: 60, emerging: 55, alt: 40, 'large-alt': 35, major: 25 }[op.type] ?? 45;
  const risk_score = Math.round(Math.max(0, Math.min(100, baseRisk + (1 - liq) * 30 + (100 - op.confidence) * 0.15)));
  return {
    setup_id: `set_${tNow}_${Math.random().toString(36).slice(2, 8)}`,
    setup_key: `${op.symbol}|${mode}`, symbol: op.symbol, mode, direction: op.direction,
    setup_type: decision.setupType, entry_price: op.price,
    buy_zone_low: op.targets.buyZone[0], buy_zone_high: op.targets.buyZone[1],
    target1: op.targets.target1, target2: op.targets.target2, stretch_target: op.targets.stretchTarget,
    invalidation: op.targets.invalidation,
    opportunity_score: op.score, confidence_score: op.confidence, risk_score, risk_label: op.risk,
    conviction_score: op.conviction, status: 'active', promotion_reason: decision.reason,
    entry_filled: decision.buyZoneValid, entry_filled_at: decision.buyZoneValid ? at : null,
    ...context, history_class: op.history_class || 'unknown', depth_score: op.depth_score ?? null,
    history_tier: op.historyTier, engine: op.engine, run_id: runId,
    created_at: at, updated_at: at, expires_at: new Date(tNow + MAX_HORIZON_MS).toISOString(),
  };
}

// ORCHESTRATOR — Postgres only.
export async function evaluatePromotions({ byMode, macro, narratives, source, runId, at }) {
  if (store.activeDriver() !== 'postgres') return { skipped: true, reason: 'not-postgres' };
  // Never learn on mock prices — only promote setups from live market data.
  if (!source || /mock/.test(source)) return { skipped: true, reason: 'mock-data' };
  const cfg = RL_CFG();
  let created = 0, updated = 0, superseded = 0, filled = 0;

  for (const mode of Object.keys(byMode)) {
    const ops = byMode[mode];
    for (let rank = 0; rank < ops.length; rank++) {
      const op = ops[rank];
      const key = `${op.symbol}|${mode}`;
      const active = await store.getActiveSetup(op.symbol, mode);
      const prev = lastByKey.get(key) || null;
      const decision = decidePromotion(op, { cfg, active, prev, rank: rank + 1 });

      if (decision.action === 'create' || decision.action === 'supersede-create') {
        // cooldown: skip a fresh create shortly after a prior setup resolved
        const lastSetup = await store.getLastSetup(op.symbol, mode);
        const cooling = lastSetup && lastSetup.resolved_at &&
          (+new Date(at) - +new Date(lastSetup.resolved_at)) < (COOLDOWN_MS[mode] || 0) &&
          decision.reason !== 'direction-change';
        if (decision.action === 'supersede-create' && active) { await store.supersedeSetup(active.setup_id, decision.reason); superseded++; }
        if (!cooling) {
          const context = deriveContext(macro, narratives, op, source);
          const setup = mkSetup(op, mode, decision, context, runId, at);
          await store.createSetup(setup);
          await store.recordSignalValues(setup.setup_id, signalRows(op, mode));
          const vec = buildFeatureVector(op);
          await store.saveSetupVector(setup.setup_id, { ...vec, history_class: op.history_class || 'unknown', mode });
          try { await store.assignPatterns(setup); } catch { /* pattern library is additive; never block scan */ }
          created++;
        }
      } else if (decision.action === 'update' && active) {
        await store.updateSetup(active.setup_id, { conviction_score: op.conviction, opportunity_score: op.score, confidence_score: op.confidence, promotion_reason: decision.reason, updated_at: at });
        updated++;
      } else if (decision.action === 'fill-entry' && active) {
        await store.updateSetup(active.setup_id, { entry_filled: true, entry_filled_at: at, updated_at: at });
        filled++;
      }
      lastByKey.set(key, { conviction: op.conviction, direction: op.direction, setupType: decision.setupType, rank: rank + 1, buyZoneValid: decision.buyZoneValid });
    }
  }
  return { created, updated, superseded, filled };
}

function signalRows(op, mode) {
  const tf = MODE_TF[mode];
  const sd = op.signalDetail || {};
  const primary = { volatility: 'volRegimePct', volume: 'rvol', trend: 'stretchPct', momentum: 'rsi', breakout: 'posInRange' };
  return Object.keys(sd).map((name) => {
    const s = sd[name];
    return {
      signal_name: name, numeric_value: Number(s.detail?.[primary[name]] ?? s.score) || 0,
      normalized_score: s.score, timeframe: tf,
      direction_contribution: (s.long || 0) - (s.short || 0), confidence_contribution: s.confidence ?? 0,
      detail: s.detail || {},
    };
  });
}
