// Radar Learn — outcome resolver. Pure computeOutcome() is unit-tested;
// resolveAll() walks active setups and labels elapsed horizons from stored
// price history. Postgres only.
import * as store from '../db/store.js';
import { ENTRY_WINDOW_MS } from './radarLearn.js';

export const HORIZONS = [['5m', 5 * 60e3], ['15m', 15 * 60e3], ['30m', 30 * 60e3], ['1h', 3600e3], ['4h', 4 * 3600e3], ['24h', 24 * 3600e3], ['7d', 7 * 24 * 3600e3], ['30d', 30 * 24 * 3600e3]];
const LABEL_RANK = { fail: 0, invalidated: 0, target1: 1, target2: 2, stretch: 3 };

// PURE: label one horizon for a setup given its in-window price path.
// pricePath: [{ at, price }] ordered ascending.
export function computeOutcome(setup, pricePath, horizonKey) {
  const prices = pricePath.map((p) => Number(p.price)).filter(Number.isFinite);
  if (!prices.length) {
    return { horizon: horizonKey, samples: 0, data_complete: false, success_label: 'fail',
      hit_target1: false, hit_target2: false, hit_stretch: false, hit_invalidation: false,
      max_favorable_excursion: null, max_adverse_excursion: null, final_return: null, price_at_horizon: null };
  }
  const entry = setup.entry_price;
  const isLong = setup.direction === 'LONG' || setup.direction === 'long';
  const endP = prices[prices.length - 1];
  const maxP = Math.max(...prices), minP = Math.min(...prices);

  const mfe = isLong ? (maxP - entry) / entry : (entry - minP) / entry;
  const mae = isLong ? (entry - minP) / entry : (maxP - entry) / entry;
  const final = isLong ? (endP - entry) / entry : (entry - endP) / entry;

  // first-hit index per level (time order) to resolve target-before-invalidation
  const firstHit = (test) => { for (let i = 0; i < prices.length; i++) if (test(prices[i])) return i; return Infinity; };
  const t1 = firstHit((p) => (isLong ? p >= setup.target1 : p <= setup.target1));
  const t2 = firstHit((p) => (isLong ? p >= setup.target2 : p <= setup.target2));
  const st = firstHit((p) => (isLong ? p >= setup.stretch_target : p <= setup.stretch_target));
  const inv = firstHit((p) => (isLong ? p <= setup.invalidation : p >= setup.invalidation));

  let label = 'fail';
  if (st < inv) label = 'stretch';
  else if (t2 < inv) label = 'target2';
  else if (t1 < inv) label = 'target1';
  else if (inv < Infinity) label = 'invalidated';

  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return {
    horizon: horizonKey, samples: prices.length, data_complete: prices.length >= 2,
    hit_target1: t1 < Infinity, hit_target2: t2 < Infinity, hit_stretch: st < Infinity, hit_invalidation: inv < Infinity,
    success_label: label,
    max_favorable_excursion: r4(mfe), max_adverse_excursion: r4(mae), final_return: r4(final), price_at_horizon: endP,
  };
}

function bestLabel(labels) {
  return labels.reduce((best, l) => (LABEL_RANK[l] > LABEL_RANK[best] ? l : best), 'fail');
}

// ORCHESTRATOR — Postgres only.
export async function resolveAll() {
  if (store.activeDriver() !== 'postgres') return { skipped: true, reason: 'not-postgres' };
  const setups = await store.getResolvableSetups();
  const now = Date.now();
  let resolved = 0, expired = 0, labeled = 0;

  for (const s of setups) {
    const created = +new Date(s.created_at);
    const priorOutcomes = await store.getOutcomes(s.setup_id);
    const existing = new Set(priorOutcomes.map((o) => o.horizon));
    const allLabels = priorOutcomes.map((o) => o.success_label);   // labels across ALL prior horizons
    let invalidated = false, did30d = false;

    for (const [hk, hms] of HORIZONS) {
      if (created + hms > now) continue;          // horizon not elapsed yet
      if (existing.has(hk)) continue;             // already labeled
      const path = await store.getPricePath(s.symbol, s.created_at, new Date(created + hms).toISOString());
      const oc = computeOutcome(s, path, hk);
      await store.upsertOutcome({ setup_id: s.setup_id, ...oc });
      labeled++;
      allLabels.push(oc.success_label);
      if (oc.hit_invalidation) invalidated = true;
      if (hk === '30d') did30d = true;
    }

    // entry-fill tracking
    if (!s.entry_filled) {
      const path = await store.getPricePath(s.symbol, s.created_at, new Date(now).toISOString());
      const lo = Math.min(s.buy_zone_low, s.buy_zone_high), hi = Math.max(s.buy_zone_low, s.buy_zone_high);
      const filled = path.some((p) => p.price >= lo && p.price <= hi);
      if (filled) await store.updateSetup(s.setup_id, { entry_filled: true, entry_filled_at: new Date().toISOString() });
      else if (now - created > (ENTRY_WINDOW_MS[s.mode] || 6 * 3600e3)) {
        await store.markSetupResolved(s.setup_id, 'expired', 'entry-timeout', 'fail');
        try { await store.classifyAndStoreFailure(s.setup_id); } catch { /* ignore */ }
        expired++; continue;
      }
    }

    // final_label = best outcome reached across EVERY horizon (a target hit before
    // invalidation within any window is a win, even if a later horizon failed).
    const finalLabel = bestLabel(allLabels.length ? allLabels : ['fail']);
    if (invalidated) { await store.markSetupResolved(s.setup_id, 'resolved', 'invalidation', finalLabel); resolved++; }
    else if (did30d) { await store.markSetupResolved(s.setup_id, 'resolved', 'horizon-complete', finalLabel); resolved++; }
    // classify WHY it failed (losses/expired only; method self-skips wins) — display-only
    if (invalidated || did30d) { try { await store.classifyAndStoreFailure(s.setup_id); } catch { /* ignore */ } }
  }
  // refresh Pattern Library stats for newly-resolved setups (additive; never blocks resolution)
  if (resolved > 0) { try { await store.recomputePatterns(); } catch { /* ignore */ } }
  return { setups: setups.length, labeled, resolved, expired };
}

// One-off data fix: recompute setups.final_label from ALL stored outcomes
// (corrects rows resolved before the cross-run aggregation fix). Read-mostly.
export async function recomputeFinalLabels() {
  if (store.activeDriver() !== 'postgres') return { skipped: true, reason: 'not-postgres' };
  const setups = await store.listSetups({ status: 'resolved', limit: 100000 });
  let fixed = 0;
  for (const s of setups) {
    const ocs = await store.getOutcomes(s.setup_id);
    if (!ocs.length) continue;
    const fl = bestLabel(ocs.map((o) => o.success_label));
    if (fl !== s.final_label) { await store.updateSetup(s.setup_id, { final_label: fl }); fixed++; }
  }
  return { setups: setups.length, fixed };
}
